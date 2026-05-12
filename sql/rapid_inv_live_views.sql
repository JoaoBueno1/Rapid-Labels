-- =================================================================
--  RAPID INVENTORY SKU — LIVE VIEWS (2º bloco para copiar+colar)
-- -----------------------------------------------------------------
--  Conecta rapid_inv ao que JÁ ESTÁ VIVO no Supabase:
--    - cin7_mirror.products       (7.903 SKUs, sync 30 min)
--    - cin7_mirror.stock_snapshot (18.108 rows SOH, sync 2 h)
--    - cin7_mirror.order_pipeline (Sales Orders headers)
--    - public.branch_avg_monthly_sales (Wk/Avg via /4.33)
--
--  TUDO read-only. Não cria triggers em cin7_mirror, não escreve nada.
--  Se algo der errado: DROP VIEW desfaz instantaneamente.
--  Idempotente: pode rodar várias vezes.
-- =================================================================

-- 0. GARANTIR PERMISSÕES CROSS-SCHEMA (idempotente, só GRANT)
GRANT USAGE  ON SCHEMA cin7_mirror TO anon, authenticated;
GRANT SELECT ON cin7_mirror.products        TO anon, authenticated;
GRANT SELECT ON cin7_mirror.stock_snapshot  TO anon, authenticated;
GRANT SELECT ON cin7_mirror.locations       TO anon, authenticated;
GRANT SELECT ON cin7_mirror.order_pipeline  TO anon, authenticated;
GRANT SELECT ON public.branch_avg_monthly_sales TO anon, authenticated;

-- =================================================================
-- VIEW 1: v_skus_live  →  catálogo de 7.903 SKUs (ao vivo)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_skus_live AS
SELECT
  p.sku,
  p.name              AS description,
  p.barcode,
  p.category,
  p.brand             AS supplier_hint,
  p.uom,
  p.average_cost,
  p.stock_locator,
  p.sellable,
  p.status,
  p.last_modified_on,
  (p.status = 'Active') AS is_active,
  p.synced_at
FROM cin7_mirror.products p;

-- =================================================================
-- VIEW 2: v_soh_live  →  estoque ao vivo agregado por SKU/warehouse
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_soh_live AS
SELECT
  sku,
  location_name           AS warehouse,
  SUM(on_hand)            AS qty_on_hand,
  SUM(allocated)          AS allocated,
  SUM(available)          AS available,
  SUM(on_order)           AS on_order,
  SUM(in_transit)         AS in_transit,
  MAX(next_delivery_date) AS next_delivery_date,
  MAX(synced_at)          AS synced_at
FROM cin7_mirror.stock_snapshot
GROUP BY sku, location_name;

-- =================================================================
-- VIEW 3: v_soh_main  →  apenas Main Warehouse (atalho para v_analysis)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_soh_main AS
SELECT
  sku,
  qty_on_hand,
  allocated,
  available,
  on_order,
  synced_at
FROM rapid_inv.v_soh_live
WHERE warehouse = 'Main Warehouse';

-- =================================================================
-- VIEW 4: v_wk_avg_live  →  Wk/Avg automático (mensal / 4.33)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_wk_avg_live AS
SELECT
  product                                                              AS sku,
  ROUND( (COALESCE(avg_sales_main,    0) / 4.33)::numeric, 2 )         AS wk_avg_sales,
  ROUND( (COALESCE(avg_transfer_main, 0) / 4.33)::numeric, 2 )         AS wk_avg_transfer,
  ROUND( (COALESCE(avg_mth_main,      0) / 4.33)::numeric, 2 )         AS wk_avg_total,
  COALESCE(avg_mth_main,      0)                                       AS mth_avg_total,
  COALESCE(avg_sales_main,    0)                                       AS mth_avg_sales,
  COALESCE(avg_transfer_main, 0)                                       AS mth_avg_transfer,
  updated_at
FROM public.branch_avg_monthly_sales;

-- =================================================================
-- VIEW 5: v_open_sos  →  Sales Orders abertos do Cin7 (headers)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_open_sos AS
SELECT
  number              AS sales_order,
  customer,
  reference,
  status,
  pick_status,
  pack_status,
  ship_status,
  invoice_status,
  order_date,
  line_count,
  total_qty,
  updated_at,
  synced_at
FROM cin7_mirror.order_pipeline
WHERE type = 'SO'
  AND status NOT IN ('COMPLETED', 'VOIDED', 'CANCELLED');

-- =================================================================
-- VIEW 6: v_wk_avg  →  SUBSTITUI a view antiga; agora cai para live
--                       quando não há override em sku_settings nem
--                       em weekly_sales locais
-- -----------------------------------------------------------------
--  Mantém a MESMA assinatura da view original (sku, wk_avg) para
--  que CREATE OR REPLACE seja aceito pelo Postgres.
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_wk_avg AS
SELECT
  s.sku,
  COALESCE(
    -- Prioridade 1: override manual
    (SELECT wk_avg_override FROM rapid_inv.sku_settings ss WHERE ss.sku = s.sku),
    -- Prioridade 2: weekly_sales local (se houver import)
    (SELECT ROUND(AVG(qty)::numeric, 2)
       FROM rapid_inv.weekly_sales ws
       WHERE ws.sku = s.sku
         AND ws.week_start >= CURRENT_DATE - INTERVAL '13 weeks'),
    -- Prioridade 3: branch_avg_monthly_sales (live, divide por 4.33)
    (SELECT wk_avg_sales FROM rapid_inv.v_wk_avg_live wal WHERE wal.sku = s.sku),
    0
  )::NUMERIC AS wk_avg
FROM rapid_inv.v_skus_live s;   -- usa skus ao vivo (cin7_mirror.products)

-- =================================================================
-- VIEW 7: v_analysis  →  SUBSTITUI a antiga; agora opera sobre
--                         dados vivos (Cin7 mirror) sem precisar import.
-- -----------------------------------------------------------------
--  IMPORTANTE: mantém EXATAMENTE a mesma assinatura de colunas da
--  view original (mesma ordem, mesmos nomes) para que CREATE OR
--  REPLACE funcione. Só muda as FONTES internas (live em vez de
--  tabelas locais vazias).
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_analysis AS
WITH soh AS (
  SELECT
    s.sku,
    -- Prioridade: rapid_inv.soh_snapshot (override) > v_soh_main (live Cin7)
    COALESCE(
      (SELECT available FROM rapid_inv.soh_snapshot
        WHERE sku = s.sku
        ORDER BY snapshot_date DESC LIMIT 1),
      (SELECT available FROM rapid_inv.v_soh_main WHERE sku = s.sku),
      0
    ) AS available
  FROM rapid_inv.v_skus_live s
),
draws AS (
  SELECT sku, SUM(qty_to_pick) AS project_orders
  FROM rapid_inv.project_lines
  WHERE finish_date IS NULL
  GROUP BY sku
)
SELECT
  s.sku,
  COALESCE(wa.wk_avg, 0)                                       AS wk_avg,
  ROUND(COALESCE(wa.wk_avg, 0) * 52.0/12.0, 2)                 AS mth_avg,
  COALESCE(soh.available, 0)                                   AS soh,
  -COALESCE(draws.project_orders, 0)                           AS project_orders,
  CASE WHEN COALESCE(wa.wk_avg, 0) > 0
       THEN ROUND(((COALESCE(soh.available,0) - COALESCE(draws.project_orders,0))
                  / (wa.wk_avg * 52.0/12.0))::numeric, 2)
       ELSE NULL
  END                                                          AS mths_stock,
  COALESCE(ss.comments, '')                                    AS comments,
  COALESCE(ss.threshold_red, 2.5)                              AS threshold_red,
  COALESCE(ss.threshold_yel, 4)                                AS threshold_yel
FROM rapid_inv.v_skus_live s
LEFT JOIN rapid_inv.v_wk_avg wa     ON wa.sku = s.sku
LEFT JOIN soh                       ON soh.sku = s.sku
LEFT JOIN draws                     ON draws.sku = s.sku
LEFT JOIN rapid_inv.sku_settings ss ON ss.sku = s.sku;

-- =================================================================
-- VIEW 8: v_dashboard_kpis  →  SUBSTITUI a antiga; agora puxa de
--                               dados vivos. As 2 últimas colunas
--                               (synced_at) são novas — adicionadas
--                               no FIM, compatível com CREATE OR REPLACE.
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_dashboard_kpis AS
SELECT
  (SELECT COUNT(*) FROM rapid_inv.v_open_sos)                                AS open_so_lines,
  (SELECT COUNT(*) FROM rapid_inv.po_lines WHERE is_received = false)        AS open_po_lines,
  (SELECT COALESCE(SUM(qty_held),0) FROM rapid_inv.project_lines
     WHERE finish_date IS NULL AND qty_held > 0)                             AS qty_pack_and_hold,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis
     WHERE mths_stock IS NOT NULL AND mths_stock < threshold_red)            AS skus_critical_red,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis
     WHERE mths_stock IS NOT NULL
       AND mths_stock >= threshold_red AND mths_stock < threshold_yel)       AS skus_warning_yellow,
  (SELECT COUNT(*) FROM rapid_inv.v_skus_live WHERE is_active = true)        AS total_active_skus,
  (SELECT COALESCE(SUM(value_aud),0) FROM rapid_inv.po_lines
     WHERE is_received = false)                                              AS po_pipeline_aud,
  -- ↓ novas colunas adicionadas no FIM
  (SELECT MAX(synced_at) FROM cin7_mirror.stock_snapshot)                    AS soh_last_synced_at,
  (SELECT MAX(synced_at) FROM cin7_mirror.products)                          AS skus_last_synced_at;

-- =================================================================
-- VERIFICAÇÃO FINAL
-- =================================================================
DO $$
DECLARE
  v_skus    INT;
  v_soh     INT;
  v_sos     INT;
  v_avg     INT;
BEGIN
  SELECT COUNT(*) INTO v_skus FROM rapid_inv.v_skus_live;
  SELECT COUNT(*) INTO v_soh  FROM rapid_inv.v_soh_live;
  SELECT COUNT(*) INTO v_sos  FROM rapid_inv.v_open_sos;
  SELECT COUNT(*) INTO v_avg  FROM rapid_inv.v_wk_avg_live;
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  RAPID INVENTORY SKU — Live views conectadas ✅';
  RAISE NOTICE '  SKUs vivos      : % (de cin7_mirror.products)',        v_skus;
  RAISE NOTICE '  Stock rows      : % (de cin7_mirror.stock_snapshot)',  v_soh;
  RAISE NOTICE '  Open SOs        : % (de cin7_mirror.order_pipeline)',  v_sos;
  RAISE NOTICE '  Wk/Avg SKUs     : % (de branch_avg_monthly_sales)',    v_avg;
  RAISE NOTICE '======================================================';
  RAISE NOTICE 'Recarregue o dashboard — KPIs vão sair de zero.';
  RAISE NOTICE '======================================================';
END $$;
