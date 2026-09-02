-- ============================================================================
-- 031 — A média medida passa a usar o índice de data.
--
-- ── O QUE ESTAVA CARO, E POR QUÊ ───────────────────────────────────────────
--
-- A 029 filtrava por `week_ending`, que é uma COLUNA CALCULADA
-- (`order_date + (7 - isodow)`). O planejador não consegue casar isso com o
-- índice `ix_sales_demand_date (order_date)` que a 018 criou, então toda
-- chamada varria as 170.672 linhas de venda para achar 13 semanas.
--
-- Medido, com o mesmo resultado nos dois lados (2.368 SKUs, 34.552 un/semana):
--
--   filtro por week_ending (029)      550 ms
--   filtro por order_date  (031)      290 ms
--
-- E isso rodava DUAS vezes por requisição — a contagem e a página —, o que pôs
-- ~1,2 s no /planning que a tela sentiu como demora ao abrir.
--
-- ── AS DUAS MUDANÇAS ───────────────────────────────────────────────────────
--
-- 1) O RECORTE VEM EM DOIS PASSOS. Primeiro `order_date` entre limites soltos,
--    que o índice resolve; depois o `week_ending` exato sobre o resultado já
--    pequeno. A folga de 7 dias no limite inferior existe porque a semana
--    termina no domingo: uma venda de segunda pertence a uma semana que só
--    fecha seis dias depois, e cortar em cima da data perderia essa venda.
--
-- 2) `NOT IN (subconsulta)` VIRA `NOT EXISTS`. Além de mais rápido, `NOT IN` é
--    inseguro com NULL: um único order_key nulo na lista de projetos faria a
--    condição inteira devolver desconhecido e a média sair ZERO para todos os
--    SKUs — em silêncio, e a compra da empresa atrás dela.
--
-- A view v_sp_sales_week continua existindo e não muda: ela é a leitura geral
-- da venda semanal, e é dela que o escopo por filial lê. Quem ficou rápido é a
-- função, que é o caminho quente.
-- ============================================================================

CREATE OR REPLACE FUNCTION rapid_inv.f_sp_wk_avg(p_weeks int DEFAULT 13)
RETURNS TABLE (sku_key text, wk_avg numeric, weeks_with_sale int, last_sale_week date)
LANGUAGE sql STABLE
AS $$
  WITH b AS (
    SELECT (SELECT ps.reporting_week FROM rapid_inv.planning_state ps WHERE ps.id = 1) AS anchor,
           greatest(p_weeks, 1)                                                        AS wks
  ),
  -- Passo 1: o recorte que o indice de order_date resolve. Os -7 e o <= anchor
  -- sao folga deliberada; o corte exato vem no passo 2.
  w AS (
    SELECT d.sku_key,
           (d.order_date + (7 - extract(isodow FROM d.order_date))::int)::date AS week_ending,
           sum(d.qty_signed)::numeric                                          AS qty
      FROM cin7_mirror.v_rp_demand d
     CROSS JOIN b
     WHERE d.order_date >  b.anchor - (b.wks * 7) - 7
       AND d.order_date <= b.anchor
       AND d.sku_key IS NOT NULL
       -- Estimativa, rascunho e pedido anulado nao sao demanda. CREDITED entra,
       -- negativo, porque devolucao E informacao de demanda.
       AND d.demanda_classe IN ('consumada', 'aberta', 'devolucao')
       -- NOT EXISTS e nao NOT IN: com NOT IN, um order_key nulo zeraria a media
       -- de TODOS os SKUs sem levantar erro nenhum.
       AND NOT EXISTS (SELECT 1 FROM rapid_inv.v_sp_project_orders po
                        WHERE po.order_key = upper(btrim(d.order_number)))
     GROUP BY 1, 2
  )
  -- Passo 2: o corte exato da janela, ja sobre o conjunto pequeno.
  SELECT w.sku_key,
         round(sum(w.qty)::numeric / b.wks, 2)                       AS wk_avg,
         count(DISTINCT w.week_ending) FILTER (WHERE w.qty > 0)::int AS weeks_with_sale,
         max(w.week_ending) FILTER (WHERE w.qty > 0)                 AS last_sale_week
    FROM w
   CROSS JOIN b
   WHERE w.week_ending >  b.anchor - (b.wks * 7)
     AND w.week_ending <= b.anchor - 7
   GROUP BY w.sku_key, b.wks;
$$;

COMMENT ON FUNCTION rapid_inv.f_sp_wk_avg(int) IS
  'Media semanal MEDIDA da venda normal, na janela pedida. Recorta por order_date (indexavel) e so depois pela semana exata. Denominador = a janela inteira.';

DO $$ BEGIN RAISE NOTICE '031: f_sp_wk_avg agora usa o indice de order_date'; END $$;
