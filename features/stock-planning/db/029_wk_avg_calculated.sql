-- ============================================================================
-- 029 — O Wk/Avg deixa de ser digitado e passa a ser MEDIDO.
--
-- ── O FATO QUE OBRIGOU A MUDANÇA ───────────────────────────────────────────
--
-- O README dizia que o Wk/Avg é "julgamento do planejador — 837 blocos
-- conferidos, zero fórmulas". O banco diz outra coisa:
--
--   wk_avg_source  = 'EXCEL_IMPORT' em 1.951 de 1.951 SKUs
--   updated_at     = 2026-08-25 em TODOS eles (a data do import, uma só)
--   wk_avg = 0/NULL em 609 SKUs
--
-- Ninguém encostou no campo desde que ele entrou. E medido contra a venda real
-- (v_sp_wkavg_drift), dos 1.226 SKUs onde dá para comparar:
--
--   394  em linha com a venda
--   449  "comprando para um número que a venda não sustenta"
--   274  "comprando cobertura para demanda que não chega"
--    56  vendendo sem previsão nenhuma — invisíveis para a grade
--    53  acabam antes do que a grade diz
--
-- Erro absoluto médio nos 832 errados: 9,4 unidades/semana, 92%.
--
-- Um parâmetro que comanda a compra da empresa inteira, errado em 68% das
-- linhas onde dá para medir, não é julgamento — é um número velho.
--
-- ── O QUE MUDA ─────────────────────────────────────────────────────────────
--
-- O padrão passa a ser CALCULADO: venda real das últimas 13 semanas, dividida
-- por 13. O digitado não é jogado fora — vira `wk_avg_override`, coluna que já
-- existia em sku_settings e estava com ZERO linhas preenchidas. Quem quiser
-- fixar um número continua podendo, e a grade mostra que aquela linha está
-- sobrescrita em vez de fingir que o número saiu da venda.
--
-- ── TRÊS DECISÕES, E OS PORQUÊS ────────────────────────────────────────────
--
-- 1) A FONTE é cin7_mirror.v_sales_demand_line, a MESMA que o escopo por filial
--    já usa. Era essa divergência que punha dois números na mesma célula da
--    tela: o da esquerda vinha da venda medida, o da direita do Excel. Uma
--    fonte só, e os dois deixam de poder discordar.
--
-- 2) VENDA DE PROJETO SAI DA CONTA. O motor já subtrai o draw de projeto na
--    cascata (planning-engine.js). Deixar a venda de projeto dentro da média
--    faria a mesma obrigação ser descontada duas vezes — uma na média semanal,
--    outra no draw. É a mesma exclusão que v_sp_actual_weekly já fazia.
--
-- 3) O DENOMINADOR é a janela inteira (13), não "as semanas em que vendeu".
--    Um SKU que vendeu 130 numa semana e nada nas outras doze tem demanda de
--    10/semana, não de 130. Quantas semanas de fato tiveram venda viaja à
--    parte, em `weeks_with_sale`, para a tela poder dizer "vendeu em 2 de 13"
--    quando a média esconde um pico.
--
-- CREATE OR REPLACE VIEW não renomeia nem reordena coluna — só anexa no fim.
-- Por isso as 33 colunas de hoje voltam na ordem exata e o que é novo entra
-- depois delas.
-- ============================================================================

-- ── Os pedidos que são de projeto ──────────────────────────────────────────
-- Sai daqui e não de um NOT EXISTS repetido em cada view: a regra do 'SO-' é
-- sutil (a aba de projetos grava sem o prefixo) e uma segunda cópia dela seria
-- uma cópia para envelhecer sozinha.
CREATE OR REPLACE VIEW rapid_inv.v_sp_project_orders AS
SELECT DISTINCT upper(btrim(p.sales_order))                     AS order_key
  FROM rapid_inv.projects p
 WHERE p.sales_order IS NOT NULL AND btrim(p.sales_order) <> ''
UNION
SELECT DISTINCT upper(btrim(replace(p.sales_order, 'SO-', '')))
  FROM rapid_inv.projects p
 WHERE p.sales_order IS NOT NULL AND btrim(p.sales_order) <> '';

COMMENT ON VIEW rapid_inv.v_sp_project_orders IS
  'Numeros de pedido que pertencem a um projeto, com e sem o prefixo SO-. Quem consome a venda normal exclui estes.';

-- ── A venda normal, semana a semana, por SKU e por filial ──────────────────
-- Uma view só serve a média da empresa E a média por filial. Era a falta disso
-- que fazia a tela mostrar dois números com duas origens na mesma célula.
--
-- A filial vem pelos DOIS caminhos que a 018 estabeleceu: o depósito da venda
-- e o rep que vendeu. Quem escolhe qual usar é quem consulta.
CREATE OR REPLACE VIEW rapid_inv.v_sp_sales_week AS
SELECT d.sku_key,
       (d.order_date + (7 - extract(isodow FROM d.order_date))::int)::date AS week_ending,
       w.code                                    AS location_branch,
       m.branch_code                             AS rep_branch,
       sum(d.qty_signed)::numeric                AS qty
  FROM cin7_mirror.v_sales_demand_line d
  LEFT JOIN rapid_inv.warehouses       w ON w.cin7_location_name = d.location_name
  LEFT JOIN rapid_inv.sales_rep_branch m ON m.sales_rep = d.sales_rep AND m.is_active
 WHERE d.order_date IS NOT NULL
   AND d.order_date < date_trunc('week', current_date)::date
   AND d.sku_key IS NOT NULL
   -- Estimativa, rascunho e pedido anulado não são demanda. CREDITED entra,
   -- negativo, porque devolução É informação de demanda.
   AND d.demanda_classe IN ('consumada', 'aberta', 'devolucao')
   AND upper(btrim(d.order_number)) NOT IN (SELECT order_key FROM rapid_inv.v_sp_project_orders)
 GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW rapid_inv.v_sp_sales_week IS
  'Venda NORMAL (ex-projeto) por SKU e semana, com as duas filiais possiveis. Base unica do Wk/Avg calculado, da empresa e por filial.';

-- ── A média calculada, para qualquer janela ────────────────────────────────
-- Função e não view porque a janela é escolha de quem olha: o filtro da tela
-- pede 4, 13, 26 ou 52 semanas e a mesma conta responde às quatro.
--
-- A âncora é a semana de reporte da grade, não CURRENT_DATE. Se as duas
-- divergissem, o número da coluna Wk/Avg e o da cascata semanal seriam
-- calculados sobre janelas diferentes na mesma tela.
CREATE OR REPLACE FUNCTION rapid_inv.f_sp_wk_avg(p_weeks int DEFAULT 13)
RETURNS TABLE (sku_key text, wk_avg numeric, weeks_with_sale int, last_sale_week date)
LANGUAGE sql STABLE
AS $$
  WITH b AS (
    SELECT (SELECT ps.reporting_week FROM rapid_inv.planning_state ps WHERE ps.id = 1) AS anchor,
           greatest(p_weeks, 1)                                                        AS wks
  )
  SELECT d.sku_key,
         round(sum(d.qty)::numeric / b.wks, 2)                       AS wk_avg,
         count(DISTINCT d.week_ending) FILTER (WHERE d.qty > 0)::int AS weeks_with_sale,
         max(d.week_ending) FILTER (WHERE d.qty > 0)                 AS last_sale_week
    FROM rapid_inv.v_sp_sales_week d
   CROSS JOIN b
   WHERE d.week_ending >  b.anchor - (b.wks * 7)
     AND d.week_ending <= b.anchor - 7
   GROUP BY d.sku_key, b.wks;
$$;

COMMENT ON FUNCTION rapid_inv.f_sp_wk_avg(int) IS
  'Media semanal MEDIDA da venda normal, na janela pedida. Denominador = a janela inteira, nao as semanas com venda.';

-- A janela padrão, materializada como view para que TODAS as telas — grade,
-- alertas, sugestão de compra, overview — leiam a mesma régua. Discordarem
-- entre si é o que faz o planejador parar de confiar nas duas.
CREATE OR REPLACE VIEW rapid_inv.v_sp_wk_avg_default AS
  SELECT * FROM rapid_inv.f_sp_wk_avg(13);

COMMENT ON VIEW rapid_inv.v_sp_wk_avg_default IS
  'A janela padrao de 13 semanas. Fonte unica do Wk/Avg para grade, alertas, buy e overview.';

GRANT SELECT ON rapid_inv.v_sp_project_orders,
                rapid_inv.v_sp_sales_week,
                rapid_inv.v_sp_wk_avg_default
   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION rapid_inv.f_sp_wk_avg(int) TO anon, authenticated, service_role;

-- ============================================================================
-- A view de planejamento passa a ler a média medida.
--
-- `wk_avg` continua sendo A coluna que o resto do módulo consome — o que muda
-- é de onde ela vem: override digitado, senão a medida, senão zero.
-- DISCONTINUED continua zerando: o item aparece na tela, com bandeira, mas não
-- puxa compra.
--
-- As 33 colunas de hoje voltam na ordem exata (REPLACE não reordena) e as
-- cinco novas entram no fim.
-- ============================================================================
CREATE OR REPLACE VIEW rapid_inv.v_sp_planning_skus AS
WITH eff AS (
  SELECT s.sku_key,
         -- A média que vale. O override é decisão de alguém e ganha; a medida
         -- é o padrão; zero é o que sobra para quem não vendeu nada.
         CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 0::numeric
              WHEN s.wk_avg_override IS NOT NULL       THEN s.wk_avg_override
              ELSE COALESCE(c.wk_avg, 0)::numeric END          AS wk_eff,
         COALESCE(c.wk_avg, 0)::numeric                        AS wk_calc,
         COALESCE(c.weeks_with_sale, 0)                        AS wk_weeks,
         c.last_sale_week                                      AS wk_last,
         (s.wk_avg_override IS NOT NULL)                       AS wk_is_override
    FROM rapid_inv.sku_settings s
    LEFT JOIN rapid_inv.v_sp_wk_avg_default c ON c.sku_key = s.sku_key
)
SELECT
  s.sku,
  s.sku_key,
  s.supplier_code,
  s.legacy_code,
  e.wk_eff                                                          AS wk_avg,
  -- De onde saiu o número desta linha. A tela desenha isto; não é enfeite.
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 'DISCONTINUED'
       WHEN e.wk_is_override                    THEN 'OVERRIDE'
       WHEN e.wk_calc > 0                       THEN 'MEASURED_13W'
       ELSE 'NO_SALES' END                                          AS wk_avg_source,
  e.wk_eff * 52::numeric / 12::numeric                              AS mth_avg,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN s.target_cover_weeks ELSE 0 END AS target_cover_weeks,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN e.wk_eff * s.target_cover_weeks::numeric
       ELSE 0::numeric END                                          AS target_qty,
  s.comments,
  s.threshold_red,
  s.threshold_yel,
  COALESCE(soh.available, 0::numeric)                               AS soh_available,
  COALESCE(soh.qty_on_hand, 0::numeric)                             AS soh_on_hand,
  COALESCE(soh.on_order, 0::numeric)                                AS soh_on_order,
  COALESCE(cm.available, 0::numeric)                                AS project_orders,
  COALESCE(un.qty, 0::numeric)                                      AS undated_qty,
  COALESCE(br_main.available, 0::numeric)                           AS main_soh,
  COALESCE(br_gw.available, 0::numeric)                             AS gateway_soh,
  COALESCE(soh.available, 0::numeric) <= 0::numeric                 AS soh_nonpositive,
  CASE WHEN s.lifecycle_status <> 'DISCONTINUED' AND e.wk_eff > 0::numeric
       THEN (COALESCE(soh.available, 0::numeric) + COALESCE(cm.available, 0::numeric))
            / (e.wk_eff * 52::numeric / 12::numeric) END            AS mths_stock,
  CASE WHEN COALESCE(soh.available, 0::numeric) > 0::numeric AND e.wk_eff > 0::numeric
       THEN (COALESCE(soh.available, 0::numeric) + COALESCE(cm.available, 0::numeric))
            / (e.wk_eff * 52::numeric / 12::numeric) END            AS mths_stock_excel,
  s.lifecycle_status,
  s.superseded_by,
  s.superseded_by_key,
  s.lifecycle_note,
  s.cin7_status,
  -- `wk_avg_input` guarda o que o Excel trouxe. Continua aqui porque é a
  -- referência contra a qual o time confere a virada; deixou de ser a régua.
  s.wk_avg                                                          AS wk_avg_input,
  s.lifecycle_source,
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 'DISCONTINUED'
       WHEN s.lifecycle_status = 'RUN_OUT'      THEN 'RUN_OUT'
       WHEN NOT COALESCE(s.use_in_replenishment, true) THEN 'NO_BRANCH'
  END                                                               AS policy_flag,
  COALESCE(s.use_in_replenishment, true)                            AS use_in_replenishment,
  COALESCE(s.use_in_gateway, true)                                  AS use_in_gateway,
  s.policy_note,
  -- ── daqui para baixo é novo; anexado no fim porque REPLACE não reordena ──
  e.wk_calc                                                         AS wk_avg_calc,
  s.wk_avg_override                                                 AS wk_avg_override,
  e.wk_is_override                                                  AS wk_avg_is_override,
  e.wk_weeks                                                        AS wk_avg_weeks_with_sale,
  e.wk_last                                                         AS wk_avg_last_sale_week
FROM rapid_inv.sku_settings s
  JOIN      eff                            e       ON e.sku_key = s.sku_key
  LEFT JOIN rapid_inv.v_sp_soh             soh     ON soh.sku = s.sku_key
  LEFT JOIN rapid_inv.v_sp_commitment      cm      ON cm.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_undated_demand  un      ON un.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_branch          br_main ON br_main.sku = s.sku_key AND br_main.branch_code = 'MAIN'
  LEFT JOIN rapid_inv.v_sp_branch          br_gw   ON br_gw.sku   = s.sku_key AND br_gw.branch_code   = 'GATEWAY'
WHERE s.is_planned
  AND COALESCE(s.use_in_planning, true);

COMMENT ON VIEW rapid_inv.v_sp_planning_skus IS
  'SKUs do plano. wk_avg = override digitado, senao a venda MEDIDA de 13 semanas (ex-projeto). Respeita use_in_planning. DISCONTINUED permanece, sinalizado.';

DO $$ BEGIN RAISE NOTICE '029: Wk/Avg calculado (13 sem, ex-projeto); o digitado virou wk_avg_override'; END $$;
