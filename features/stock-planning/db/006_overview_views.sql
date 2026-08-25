-- =====================================================================
-- Stock Planning · 006 · VIEWS DO OVERVIEW
-- ---------------------------------------------------------------------
-- Cinco análises que são padrão de mercado em planejamento de estoque.
-- Todo o SQL aqui foi rodado contra o banco vivo antes de virar view.
--
-- Ficaram DE FORA, e o motivo está medido:
--   · Desempenho de fornecedor (lead time realizado, OTIF) — po_lines tem
--     is_received = false nas 1.466 linhas, porque o workbook só carrega PO
--     aberta. Sem par promessa × chegada não há on-time. Nasce sozinha
--     quando o recebimento passar a marcar is_received.
--   · Giro / DIO — weekly_sales tem 932 linhas, TODAS da mesma semana. É
--     uma foto, não série. Giro precisa de estoque médio ao longo do tempo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- CUSTO UNITÁRIO EM AUD
-- cin7_mirror.products.average_cost cobre 1.791 dos 1.951 SKUs planejados.
-- Os 160 sem custo têm todos soh_available <= 0 — valem zero de qualquer
-- jeito, então a cobertura efetiva do valor de estoque é 100%.
-- O fallback pela última PO existe para SKU novo que ainda não tem custo médio.
-- ---------------------------------------------------------------------
-- Índice funcional: sem ele o casamento por SKU normalizado varre os 11.251
-- produtos uma vez POR SKU planejado. Custava 18,6 s. Aditivo e não altera
-- comportamento de nenhum outro módulo.
CREATE INDEX IF NOT EXISTS ix_cin7_products_skukey
  ON cin7_mirror.products (upper(btrim(sku)));

CREATE OR REPLACE VIEW rapid_inv.v_sp_sku_cost AS
WITH prod AS (
  SELECT DISTINCT ON (upper(btrim(sku))) upper(btrim(sku)) AS sku_key, average_cost
    FROM cin7_mirror.products
   WHERE average_cost > 0
   ORDER BY upper(btrim(sku)), synced_at DESC NULLS LAST
), last_po AS (
  SELECT DISTINCT ON (sku_key) sku_key, unit_cost_usd / NULLIF(fx_used, 0) AS cost
    FROM rapid_inv.po_lines
   WHERE unit_cost_usd > 0
   ORDER BY sku_key, po_date DESC
)
SELECT s.sku_key,
       COALESCE(prod.average_cost, last_po.cost, 0) AS unit_cost_aud
  FROM rapid_inv.sku_settings s
  LEFT JOIN prod    ON prod.sku_key    = s.sku_key
  LEFT JOIN last_po ON last_po.sku_key = s.sku_key
 WHERE s.is_planned;

CREATE OR REPLACE VIEW rapid_inv.v_sp_sku_value AS
SELECT v.sku, v.sku_key, v.supplier_code, v.wk_avg, v.mths_stock, v.soh_available,
       v.target_qty, v.target_cover_weeks, v.soh_nonpositive,
       COALESCE(c.unit_cost_aud, 0)                                              AS unit_cost_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(v.soh_available, 0)               AS stock_value_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(v.soh_available - COALESCE(v.target_qty, 0), 0) AS excess_value_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(COALESCE(v.target_qty, 0) - v.soh_available, 0) AS gap_value_aud
  FROM rapid_inv.v_sp_planning_skus v
  LEFT JOIN rapid_inv.v_sp_sku_cost c ON c.sku_key = v.sku_key;

-- ---------------------------------------------------------------------
-- 1. STOCK HEALTH — ABC × faixa de cobertura, com o dinheiro dentro.
-- ABC por Pareto do valor de estoque: 80% do valor = A, até 95% = B, resto C.
-- Classe A com pouca cobertura é ruptura cara; classe A com cobertura demais
-- é capital preso. É o cruzamento que transforma classificação em ação.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_abc AS
SELECT *,
       CASE WHEN stock_value_aud = 0 THEN 'D'
            WHEN cum <= 0.80 THEN 'A'
            WHEN cum <= 0.95 THEN 'B'
            ELSE 'C' END AS abc,
       CASE WHEN wk_avg IS NULL OR wk_avg = 0 THEN 'no demand set'
            WHEN mths_stock < 1  THEN '<1 mth'
            WHEN mths_stock < 6  THEN '1-6 mths'
            WHEN mths_stock < 12 THEN '6-12 mths'
            ELSE '12+ mths' END AS cover_band
  FROM (
    SELECT *, sum(stock_value_aud) OVER (ORDER BY stock_value_aud DESC, sku_key)
              / NULLIF(sum(stock_value_aud) OVER (), 0) AS cum
      FROM rapid_inv.v_sp_sku_value
  ) z;

CREATE OR REPLACE VIEW rapid_inv.v_sp_stock_health AS
SELECT abc, cover_band, count(*)::int AS skus, round(sum(stock_value_aud)::NUMERIC, 0) AS value_aud
  FROM rapid_inv.v_sp_abc GROUP BY 1, 2;

CREATE OR REPLACE VIEW rapid_inv.v_sp_stock_totals AS
SELECT round(sum(stock_value_aud)::NUMERIC, 0)          AS total_stock_aud,
       round(sum(excess_value_aud)::NUMERIC, 0)         AS excess_aud,
       round(sum(gap_value_aud)::NUMERIC, 0)            AS buy_gap_aud,
       count(*) FILTER (WHERE soh_available <= 0)::INT  AS oos_skus,
       count(*)::INT                                    AS skus
  FROM rapid_inv.v_sp_sku_value;

CREATE OR REPLACE VIEW rapid_inv.v_sp_supplier_health AS
SELECT supplier_code,
       count(*)::INT                                  AS skus,
       round(sum(stock_value_aud)::NUMERIC, 0)        AS stock_value_aud,
       round(sum(excess_value_aud)::NUMERIC, 0)       AS excess_value_aud,
       round(sum(gap_value_aud)::NUMERIC, 0)          AS gap_to_target_aud,
       count(*) FILTER (WHERE wk_avg > 0 AND mths_stock > 12)::INT AS slow_skus,
       count(*) FILTER (WHERE mths_stock < 1)::INT    AS under_one_month,
       count(*) FILTER (WHERE soh_nonpositive)::INT   AS out_of_stock
  FROM rapid_inv.v_sp_sku_value
 WHERE supplier_code IS NOT NULL
 GROUP BY 1;

-- ---------------------------------------------------------------------
-- 3. INBOUND PIPELINE — tudo que está a caminho, por semana e por fornecedor.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_inbound_week AS
SELECT rapid_inv.week_ending(po.due_date)                     AS week_ending,
       count(*)::INT                                          AS po_lines,
       count(DISTINCT po.po_number)::INT                      AS pos,
       sum(po.qty)                                            AS units,
       round(sum(COALESCE(po.value_aud, po.qty * po.unit_cost_usd / NULLIF(po.fx_used, 0)))::NUMERIC, 0) AS value_aud,
       count(*) FILTER (WHERE po.due_date < CURRENT_DATE)::INT AS overdue_lines,
       count(*) FILTER (WHERE po.vessel IS NULL)::INT         AS no_vessel
  FROM rapid_inv.po_lines po
 WHERE po.due_date IS NOT NULL AND NOT COALESCE(po.is_received, false)
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_inbound_supplier AS
SELECT po.supplier_code,
       count(DISTINCT po.po_number)::INT                      AS pos,
       count(*)::INT                                          AS lines,
       sum(po.qty)                                            AS units,
       round(sum(COALESCE(po.value_aud, po.qty * po.unit_cost_usd / NULLIF(po.fx_used, 0)))::NUMERIC, 0) AS value_aud,
       min(po.due_date)                                       AS next_due,
       max(po.due_date)                                       AS last_due,
       count(*) FILTER (WHERE po.due_date < CURRENT_DATE)::INT AS overdue,
       count(*) FILTER (WHERE po.vessel IS NULL)::INT         AS no_vessel
  FROM rapid_inv.po_lines po
 WHERE po.due_date IS NOT NULL AND NOT COALESCE(po.is_received, false)
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_inbound_overdue AS
SELECT po.id, po.po_number, po.supplier_code, po.sku, po.qty, po.due_date,
       (CURRENT_DATE - po.due_date) AS days_late, po.vessel, po.require_status
  FROM rapid_inv.po_lines po
 WHERE NOT COALESCE(po.is_received, false) AND po.due_date < CURRENT_DATE;

-- ---------------------------------------------------------------------
-- 4. DEMAND BOOK — a carteira de projetos vista como demanda.
-- Demanda datada é firme e entra no plano. Demanda sem data é risco: consome
-- estoque físico sem consumir posição no calendário. Por isso ficam separadas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_demand_week AS
SELECT rapid_inv.week_ending(dr.planned_date) AS week_ending,
       sum(dr.qty)               AS units,
       count(*)::INT             AS draws,
       count(DISTINCT p.id)::INT AS projects
  FROM rapid_inv.project_draws dr
  JOIN rapid_inv.project_lines l ON l.id = dr.line_id AND NOT l.is_void
  JOIN rapid_inv.projects      p ON p.id = l.project_id
 WHERE dr.planned_date IS NOT NULL
   AND dr.status IN ('PLANNED','PICKED','PACKED')
   AND p.status = 'ACTIVE'
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_tba_customer AS
SELECT COALESCE(p.customer, '(no customer)') AS customer,
       count(DISTINCT p.id)::INT             AS projects,
       count(*)::INT                         AS tba_draws,
       sum(dr.qty)                           AS tba_units,
       min(p.order_date)                     AS oldest_order,
       (CURRENT_DATE - min(p.order_date))    AS oldest_age_days
  FROM rapid_inv.project_draws dr
  JOIN rapid_inv.project_lines l ON l.id = dr.line_id AND NOT l.is_void
  JOIN rapid_inv.projects      p ON p.id = l.project_id
 WHERE dr.planned_date IS NULL AND dr.status = 'PLANNED' AND p.status = 'ACTIVE'
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_held_aging AS
SELECT CASE WHEN days_held > 180 THEN '180+ days'
            WHEN days_held >  90 THEN '91-180 days'
            WHEN days_held >  30 THEN '31-90 days'
            WHEN days_held >   0 THEN '1-30 days'
            ELSE                      'not packed' END AS age_band,
       CASE WHEN days_held > 180 THEN 4 WHEN days_held > 90 THEN 3
            WHEN days_held > 30 THEN 2 WHEN days_held > 0 THEN 1 ELSE 0 END AS band_order,
       count(*)::INT                 AS lines,
       sum(qty_held)                 AS units_held,
       count(DISTINCT customer)::INT AS customers
  FROM rapid_inv.v_sp_lines
 WHERE project_status = 'ACTIVE' AND qty_held > 0
 GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- 5. DEMAND SIGNAL — o Wk/Avg digitado × a venda real.
--
-- O Wk/Avg comanda toda a compra da empresa e é entrada manual: 837 blocos
-- conferidos no workbook, zero fórmulas. Nunca foi medido contra o realizado.
--
-- LIMITE DE DADO, medido: cin7_mirror.sale_lines só espelha bem a partir de
-- junho/2026. A janela honesta é de 9 semanas — dá para ver viés, não dá para
-- ver sazonalidade nem tendência anual. Os Sales Orders que já são projeto
-- ficam de fora, senão a mesma unidade seria contada duas vezes com os draws.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_actual_weekly AS
WITH win AS (
  SELECT rapid_inv.week_ending(CURRENT_DATE) - 63 AS d0,
         rapid_inv.week_ending(CURRENT_DATE) -  7 AS d1
)
SELECT upper(btrim(sl.sku)) AS sku_key, sum(sl.quantity) / 9.0 AS actual_wk
  FROM cin7_mirror.sale_lines sl
  JOIN cin7_mirror.sales_orders o ON o.order_number = sl.order_number
 CROSS JOIN win
 WHERE o.order_date BETWEEN win.d0 AND win.d1
   AND o.status IN ('COMPLETED','INVOICED','CLOSED')
   AND NOT EXISTS (SELECT 1 FROM rapid_inv.projects p
                    WHERE upper(btrim(p.sales_order)) IN (
                            upper(btrim(o.order_number)),
                            upper(btrim(replace(o.order_number, 'SO-', '')))))
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_demand_signal AS
SELECT v.sku, v.sku_key, v.supplier_code, v.wk_avg,
       round(COALESCE(a.actual_wk, 0)::NUMERIC, 2)              AS actual_wk,
       round((COALESCE(a.actual_wk, 0) - v.wk_avg)::NUMERIC, 2) AS bias_units,
       round((100.0 * (COALESCE(a.actual_wk, 0) - v.wk_avg) / NULLIF(v.wk_avg, 0))::NUMERIC, 0) AS bias_pct,
       round(v.mths_stock::NUMERIC, 1)                          AS mths_stock,
       round(v.stock_value_aud::NUMERIC, 0)                     AS stock_value_aud,
       CASE WHEN v.wk_avg > 0 AND COALESCE(a.actual_wk, 0) = 0     THEN 'forecast, no sales'
            WHEN COALESCE(v.wk_avg, 0) = 0 AND a.actual_wk > 0     THEN 'sales, no forecast'
            WHEN v.wk_avg > 0 AND a.actual_wk > v.wk_avg * 1.5     THEN 'under-forecast'
            WHEN v.wk_avg > 0 AND a.actual_wk < v.wk_avg * 0.5     THEN 'over-forecast'
            WHEN v.wk_avg > 0 AND a.actual_wk IS NOT NULL          THEN 'in line'
       END AS verdict
  FROM rapid_inv.v_sp_sku_value v
  LEFT JOIN rapid_inv.v_sp_actual_weekly a ON a.sku_key = v.sku_key;

DO $$ BEGIN RAISE NOTICE '006: views do overview prontas'; END $$;
