-- ============================================================================
-- 011 — O passado realizado, semana a semana
--
-- A grade só sabia olhar para frente. O planejador pedia o retrovisor: "eu
-- digitei 42/semana, quanto de fato saiu nas últimas seis?".
--
-- O que ESTA migração entrega é o realizado — venda, recebimento e consumo de
-- projeto. O estoque de fechamento do passado NÃO está aqui de propósito: ele
-- depende de reconstruir a movimentação para trás, e reconstruir sem medir o
-- erro contra um snapshot real seria inventar número com cara de dado. As três
-- datas de snapshot que existem no banco (21/11/2025, 08/01/2026 e 26/08/2026)
-- são o gabarito desse back-test, e ele vem depois do backfill de 1 ano.
--
-- Três armadilhas deste projeto que as views abaixo evitam de propósito:
--   1. sku_key = upper(btrim(sku)). A aba PO's do Excel usa maiúsculas e as
--      outras minúsculas; o SUMIFS do Excel é case-insensitive e o "=" do SQL
--      não é. Isso já custou 312 unidades de estoque a chegar.
--   2. Semana termina no DOMINGO, igual à grade. d + (7 - isodow) devolve o
--      domingo da própria semana.
--   3. Entrada é SÓ purchase_receive. bin_transfer e stock_transfer são
--      movimento interno: contá-los inflaria a entrada com estoque que a
--      empresa já tinha.
-- ============================================================================

-- ── Venda realizada ─────────────────────────────────────────────────────────
-- Fonte medida: 60 semanas (2024-07-28 → 2026-08-23), das quais 20 densas
-- (>300 SKUs). O backfill de 1 ano é o que torna a cauda utilizável.
CREATE OR REPLACE VIEW rapid_inv.v_sp_hist_sales AS
SELECT upper(btrim(l.sku))                                              AS sku_key,
       (o.order_date + (7 - extract(isodow FROM o.order_date))::int)::date AS week_ending,
       sum(l.quantity)::numeric                                         AS qty
  FROM cin7_mirror.sale_lines  l
  JOIN cin7_mirror.sales_orders o ON o.order_number = l.order_number
 WHERE o.order_date IS NOT NULL
   AND o.order_date < date_trunc('week', current_date)::date
   AND l.sku IS NOT NULL
 GROUP BY 1, 2;

-- ── Recebimento realizado ───────────────────────────────────────────────────
-- Só purchase_receive. Medido: 1.485 linhas, 651 SKUs, e começa em 18/06/2026
-- — bem mais raso que a venda. A tela precisa dizer isso em vez de mostrar
-- zero, senão "não recebemos nada" e "não sabemos" viram o mesmo número.
CREATE OR REPLACE VIEW rapid_inv.v_sp_hist_receipts AS
SELECT upper(btrim(m.sku))                                                   AS sku_key,
       (m.detected_at::date + (7 - extract(isodow FROM m.detected_at::date))::int)::date AS week_ending,
       sum(m.quantity)::numeric                                              AS qty
  FROM cin7_mirror.stock_movements m
 WHERE m.movement_type = 'purchase_receive'
   AND m.quantity > 0
   AND m.sku IS NOT NULL
   AND m.detected_at::date < date_trunc('week', current_date)::date
 GROUP BY 1, 2;

-- ── Consumo de projeto realizado ────────────────────────────────────────────
-- finish_date é quando a linha de projeto foi de fato encerrada. Diferente de
-- project_draws, que é o PLANEJADO — uma auditoria anterior leu a tabela errada
-- e concluiu que o passado de projeto era zero.
CREATE OR REPLACE VIEW rapid_inv.v_sp_hist_projects AS
SELECT pl.sku_key,
       (pl.finish_date + (7 - extract(isodow FROM pl.finish_date))::int)::date AS week_ending,
       sum(pl.qty)::numeric                                                    AS qty
  FROM rapid_inv.project_lines pl
 WHERE pl.finish_date IS NOT NULL
   AND pl.finish_date < date_trunc('week', current_date)::date
   AND pl.sku_key IS NOT NULL
 GROUP BY 1, 2;

-- ── A união, que é o que a grade consome ────────────────────────────────────
CREATE OR REPLACE VIEW rapid_inv.v_sp_history_week AS
SELECT COALESCE(s.sku_key, r.sku_key, p.sku_key)          AS sku_key,
       COALESCE(s.week_ending, r.week_ending, p.week_ending) AS week_ending,
       COALESCE(s.qty, 0)                                 AS sold_qty,
       COALESCE(r.qty, 0)                                 AS recv_qty,
       COALESCE(p.qty, 0)                                 AS proj_qty,
       -- Vazio não é zero. Estes três dizem se a FONTE tinha algo a dizer
       -- naquela semana, para a tela distinguir "não vendeu" de "não sabemos".
       (s.qty IS NOT NULL) AS has_sales,
       (r.qty IS NOT NULL) AS has_recv,
       (p.qty IS NOT NULL) AS has_proj
  FROM            rapid_inv.v_sp_hist_sales    s
  FULL OUTER JOIN rapid_inv.v_sp_hist_receipts r
              ON r.sku_key = s.sku_key AND r.week_ending = s.week_ending
  FULL OUTER JOIN rapid_inv.v_sp_hist_projects p
              ON p.sku_key = COALESCE(s.sku_key, r.sku_key)
             AND p.week_ending = COALESCE(s.week_ending, r.week_ending);

-- ── Até onde cada fonte alcança ─────────────────────────────────────────────
-- A tela lê isto para desenhar a fronteira do que sabe. Sem ela, uma coluna
-- vazia de fevereiro pareceria uma semana sem venda em vez de uma semana sem
-- dado — e num controle de estoque essa confusão vira decisão de compra errada.
CREATE OR REPLACE VIEW rapid_inv.v_sp_history_coverage AS
SELECT 'sales'::text AS source, min(week_ending) AS first_week, max(week_ending) AS last_week,
       count(DISTINCT week_ending) AS weeks, count(DISTINCT sku_key) AS skus,
       count(DISTINCT week_ending) FILTER (WHERE week_ending >= current_date - interval '26 weeks') AS weeks_recent
  FROM rapid_inv.v_sp_hist_sales
UNION ALL
SELECT 'receipts', min(week_ending), max(week_ending),
       count(DISTINCT week_ending), count(DISTINCT sku_key),
       count(DISTINCT week_ending) FILTER (WHERE week_ending >= current_date - interval '26 weeks')
  FROM rapid_inv.v_sp_hist_receipts
UNION ALL
SELECT 'projects', min(week_ending), max(week_ending),
       count(DISTINCT week_ending), count(DISTINCT sku_key),
       count(DISTINCT week_ending) FILTER (WHERE week_ending >= current_date - interval '26 weeks')
  FROM rapid_inv.v_sp_hist_projects;

GRANT SELECT ON rapid_inv.v_sp_hist_sales,
                rapid_inv.v_sp_hist_receipts,
                rapid_inv.v_sp_hist_projects,
                rapid_inv.v_sp_history_week,
                rapid_inv.v_sp_history_coverage
   TO anon, authenticated, service_role;
