-- =====================================================================
-- Stock Planning · 003 · VIEWS DE FATOS
-- ---------------------------------------------------------------------
-- Estas views entregam FATOS agregados. A cascata semanal NÃO mora aqui:
-- ela é uma função pura em lib/planning-engine.js, para ser testável sem
-- banco. Aqui só se responde "quanto, de que SKU, em que semana".
-- =====================================================================

-- ---------------------------------------------------------------------
-- A correção do bug mais caro do Excel.
--
-- Lá, PICK DATE precisa cair exatamente no domingo, senão o SUMIFS não
-- casa e a demanda some sem erro nenhum: 32 draws e 8 POs hoje. Aqui,
-- qualquer data cai na semana dela.
-- ---------------------------------------------------------------------
-- Recriadas do zero: as colunas de saída mudam quando se passa a casar por sku_key.
DROP VIEW IF EXISTS rapid_inv.v_sp_draw_integrity;
DROP VIEW IF EXISTS rapid_inv.v_sp_planning_skus;
DROP VIEW IF EXISTS rapid_inv.v_sp_lines;
DROP VIEW IF EXISTS rapid_inv.v_sp_draw_demand;
DROP VIEW IF EXISTS rapid_inv.v_sp_draw_detail;
DROP VIEW IF EXISTS rapid_inv.v_sp_undated_demand;
DROP VIEW IF EXISTS rapid_inv.v_sp_incoming;
DROP VIEW IF EXISTS rapid_inv.v_sp_incoming_detail;
DROP VIEW IF EXISTS rapid_inv.v_sp_soh;
DROP VIEW IF EXISTS rapid_inv.v_sp_commitment;
DROP VIEW IF EXISTS rapid_inv.v_sp_branch;
DROP VIEW IF EXISTS rapid_inv.v_sp_weeks;

CREATE OR REPLACE FUNCTION rapid_inv.week_ending(d DATE)
RETURNS DATE LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT d + ((7 - EXTRACT(ISODOW FROM d)::INT) % 7);
$$;

COMMENT ON FUNCTION rapid_inv.week_ending(DATE) IS
  'Domingo que encerra a semana da data. Espelha a linha "Week Ended Date" do workbook.';

-- ---------------------------------------------------------------------
-- CALENDÁRIO — week_calendar.week_start guarda domingos, que no Excel são
-- os "Week Ended". Aqui o campo se chama week_ending, que é como se lê.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_weeks AS
SELECT
  wc.week_start                              AS week_ending,
  wc.week_index,
  wc.year,
  to_char(wc.week_start,'DD Mon')            AS label_short,
  to_char(wc.week_start,'DD Mon YYYY')       AS label,
  'W' || to_char(wc.week_start,'IW')         AS week_no,
  COALESCE(sf.factor, 1)::NUMERIC            AS factor,
  sf.reason                                  AS factor_reason,
  (wc.week_start = ps.reporting_week)        AS is_reporting,
  (wc.week_start <  ps.reporting_week)       AS is_past
FROM rapid_inv.week_calendar wc
CROSS JOIN rapid_inv.planning_state ps
LEFT JOIN rapid_inv.seasonal_factors sf ON sf.week_ending = wc.week_start;

-- ---------------------------------------------------------------------
-- LINHAS — o que a grade Projects mostra. days_held é calculado aqui
-- porque CURRENT_DATE não é IMMUTABLE e não cabe em coluna GENERATED.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_lines AS
SELECT
  l.id,
  l.project_id,
  l.line_no,
  p.sales_order,
  p.order_date,
  p.customer,
  p.reference,
  p.rep,
  p.status                                   AS project_status,
  p.finish_date                              AS project_finish_date,
  p.warehouse_code,
  COALESCE(p.warehouse_note, l.warehouse)    AS warehouse_note,
  l.sku,
  l.sku_key,
  l.qty,
  l.type,
  l.unit_price,
  l.po_ref,
  l.po_due_date,
  l.qty_held,
  l.date_packed,
  l.qty_inv,
  l.qty_to_pick,
  l.required_text,
  l.comments,
  l.status                                   AS line_status,
  CASE WHEN l.date_packed IS NOT NULL
       THEN (CURRENT_DATE - l.date_packed) ELSE 0 END        AS days_held,
  COALESCE(d.draw_count, 0)                                  AS draw_count,
  COALESCE(d.draw_qty, 0)                                    AS draw_qty,
  COALESCE(d.draw_qty_dated, 0)                              AS draw_qty_dated,
  COALESCE(d.draw_qty_undated, 0)                            AS draw_qty_undated,
  d.first_planned_date,
  (COALESCE(d.draw_qty,0) > l.qty_to_pick)                   AS over_planned,
  (l.qty_to_pick > 0 AND COALESCE(d.draw_qty,0) < l.qty_to_pick) AS under_planned,
  l.updated_at,
  l.updated_by
FROM rapid_inv.project_lines l
LEFT JOIN rapid_inv.projects p ON p.id = l.project_id
LEFT JOIN LATERAL (
  SELECT count(*)::INT                                                    AS draw_count,
         sum(dr.qty)                                                      AS draw_qty,
         sum(dr.qty) FILTER (WHERE dr.planned_date IS NOT NULL)           AS draw_qty_dated,
         sum(dr.qty) FILTER (WHERE dr.planned_date IS NULL)               AS draw_qty_undated,
         min(dr.planned_date)                                             AS first_planned_date
  FROM rapid_inv.project_draws dr
  WHERE dr.line_id = l.id AND dr.status IN ('PLANNED','PICKED','PACKED')
) d ON TRUE
WHERE NOT l.is_void;

-- ---------------------------------------------------------------------
-- DEMANDA DE PROJETO POR SEMANA — o SUMIFS(Project!J; Project!L; Project!F)
-- do Excel, sem a armadilha do domingo exato.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_draw_demand AS
SELECT
  l.sku_key                              AS sku,
  rapid_inv.week_ending(dr.planned_date) AS week_ending,
  sum(dr.qty)                            AS qty,
  count(*)::INT                          AS draw_count
FROM rapid_inv.project_draws dr
JOIN rapid_inv.project_lines l ON l.id = dr.line_id AND NOT l.is_void
JOIN rapid_inv.projects      p ON p.id = l.project_id
WHERE dr.planned_date IS NOT NULL
  AND dr.status IN ('PLANNED','PICKED','PACKED')
  AND p.status = 'ACTIVE'
GROUP BY 1, 2;

-- Detalhe para o drill-down "por que este número".
CREATE OR REPLACE VIEW rapid_inv.v_sp_draw_detail AS
SELECT
  l.sku_key        AS sku,
  l.sku            AS sku_display,
  rapid_inv.week_ending(dr.planned_date) AS week_ending,
  dr.id            AS draw_id,
  dr.qty,
  dr.planned_date,
  dr.seq,
  dr.note,
  l.id             AS line_id,
  p.id             AS project_id,
  p.sales_order,
  p.customer,
  p.reference
FROM rapid_inv.project_draws dr
JOIN rapid_inv.project_lines l ON l.id = dr.line_id AND NOT l.is_void
JOIN rapid_inv.projects      p ON p.id = l.project_id
WHERE dr.planned_date IS NOT NULL
  AND dr.status IN ('PLANNED','PICKED','PACKED')
  AND p.status = 'ACTIVE';

-- ---------------------------------------------------------------------
-- DEMANDA SEM DATA (TBA) — coluna própria, nunca jogada numa semana.
-- Hoje são 2.683 das 5.351 linhas do workbook. Metade.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_undated_demand AS
SELECT
  l.sku_key     AS sku,
  sum(dr.qty)   AS qty,
  count(*)::INT AS draw_count
FROM rapid_inv.project_draws dr
JOIN rapid_inv.project_lines l ON l.id = dr.line_id AND NOT l.is_void
JOIN rapid_inv.projects      p ON p.id = l.project_id
WHERE dr.planned_date IS NULL
  AND dr.status = 'PLANNED'
  AND p.status = 'ACTIVE'
GROUP BY 1;

-- ---------------------------------------------------------------------
-- ENTRADA DE ESTOQUE — SUMIFS(PO's!E; PO's!H = Due Date; PO's!D).
-- Vem do DUE DATE, não da data da PO nem do Finish Date.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_incoming AS
SELECT
  po.sku_key                         AS sku,
  rapid_inv.week_ending(po.due_date) AS week_ending,
  sum(po.qty)                        AS qty,
  count(*)::INT                      AS po_count
FROM rapid_inv.po_lines po
WHERE po.due_date IS NOT NULL AND NOT COALESCE(po.is_received, false)
GROUP BY 1, 2;

CREATE OR REPLACE VIEW rapid_inv.v_sp_incoming_detail AS
SELECT
  po.sku_key AS sku,
  po.sku     AS sku_display,
  rapid_inv.week_ending(po.due_date) AS week_ending,
  po.id, po.po_number, po.qty, po.due_date, po.supplier_code, po.vessel, po.require_status
FROM rapid_inv.po_lines po
WHERE po.due_date IS NOT NULL AND NOT COALESCE(po.is_received, false);

-- ---------------------------------------------------------------------
-- ESTOQUE ATUAL — empresa inteira. É a base do cálculo; filial é contexto.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh AS
SELECT sku_key AS sku,
       sum(qty_on_hand) AS qty_on_hand,
       sum(allocated)   AS allocated,
       sum(on_order)    AS on_order,
       sum(available)   AS available
FROM rapid_inv.soh_snapshot
WHERE is_current
GROUP BY sku_key;

CREATE OR REPLACE VIEW rapid_inv.v_sp_commitment AS
SELECT DISTINCT ON (sku_key) sku_key AS sku, qty_on_hand, allocated, on_order, available, snapshot_date
FROM rapid_inv.project_commitment
ORDER BY sku_key, snapshot_date DESC;

CREATE OR REPLACE VIEW rapid_inv.v_sp_branch AS
SELECT DISTINCT ON (branch_code, sku_key)
       branch_code, sku_key AS sku, qty_on_hand, allocated, on_order, available, snapshot_date
FROM rapid_inv.branch_soh
ORDER BY branch_code, sku_key, snapshot_date DESC;

-- ---------------------------------------------------------------------
-- A LISTA DE PLANEJAMENTO — equivale à aba Analysis (1.988 SKUs).
--
-- mths_stock_excel reproduz o Excel ao pé da letra, inclusive o defeito de
-- ficar NULO quando SOH <= 0 — é o que esconde 714 SKUs hoje. Serve para a
-- fase de paridade.
-- mths_stock é a nossa: calcula sempre que houver Wk/Avg, e soh_nonpositive
-- sinaliza o SKU em vez de escondê-lo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_planning_skus AS
SELECT
  s.sku,
  s.sku_key,
  s.supplier_code,
  s.legacy_code,
  s.wk_avg,
  s.wk_avg_source,
  (s.wk_avg * 52 / 12)                                     AS mth_avg,
  s.target_cover_weeks,
  (s.wk_avg * s.target_cover_weeks)                        AS target_qty,
  s.comments,
  s.threshold_red,
  s.threshold_yel,
  COALESCE(soh.available, 0)                               AS soh_available,
  COALESCE(soh.qty_on_hand, 0)                             AS soh_on_hand,
  COALESCE(soh.on_order, 0)                                AS soh_on_order,
  COALESCE(cm.available, 0)                                AS project_orders,
  COALESCE(un.qty, 0)                                      AS undated_qty,
  COALESCE(br_main.available, 0)                           AS main_soh,
  COALESCE(br_gw.available, 0)                             AS gateway_soh,
  (COALESCE(soh.available,0) <= 0)                         AS soh_nonpositive,
  CASE WHEN COALESCE(s.wk_avg,0) > 0
       THEN (COALESCE(soh.available,0) + COALESCE(cm.available,0)) / (s.wk_avg * 52 / 12)
  END                                                      AS mths_stock,
  CASE WHEN COALESCE(soh.available,0) > 0 AND COALESCE(s.wk_avg,0) > 0
       THEN (COALESCE(soh.available,0) + COALESCE(cm.available,0)) / (s.wk_avg * 52 / 12)
  END                                                      AS mths_stock_excel
FROM rapid_inv.sku_settings s
LEFT JOIN rapid_inv.v_sp_soh        soh ON soh.sku = s.sku_key
LEFT JOIN rapid_inv.v_sp_commitment cm  ON cm.sku  = s.sku_key
LEFT JOIN rapid_inv.v_sp_undated_demand un ON un.sku = s.sku_key
LEFT JOIN rapid_inv.v_sp_branch br_main ON br_main.sku = s.sku_key AND br_main.branch_code = 'MAIN'
LEFT JOIN rapid_inv.v_sp_branch br_gw   ON br_gw.sku   = s.sku_key AND br_gw.branch_code   = 'GATEWAY'
WHERE s.is_planned;

-- ---------------------------------------------------------------------
-- INTEGRIDADE DE DRAWS — avisa, nunca trava. A operação tem exceção legítima.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_draw_integrity AS
SELECT id AS line_id, project_id, sales_order, sku, qty_to_pick, draw_qty, draw_count,
       CASE WHEN over_planned  THEN 'OVER_PLANNED'
            WHEN under_planned THEN 'UNDER_PLANNED' END AS issue
FROM rapid_inv.v_sp_lines
WHERE over_planned OR under_planned;

DO $$ BEGIN RAISE NOTICE '003_views: fatos agregados prontos'; END $$;
