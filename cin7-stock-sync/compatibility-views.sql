-- ============================================================
-- Cin7 Mirror — Compatibility Views
-- Purpose: Expose cin7_mirror data in the EXACT same shape
--          as the existing tables each page reads from.
--          This allows future migration to be a simple
--          config change (point page to new view) with
--          ZERO code changes in the page JS.
--
-- IMPORTANT: These views are READ-ONLY and live entirely
--            inside the cin7_mirror schema.
--            They do NOT modify, replace, or touch any
--            existing production tables.
--
-- Created: 2026-02-19
-- ============================================================

-- ============================================================
-- 1. RESTOCK PAGE compatibility
--    restock.js reads from: restock_report (sku, product, location, on_hand)
--    This view maps cin7_mirror.stock_snapshot → same shape
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_restock_report AS
SELECT
    ss.sku::TEXT                   AS sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    ss.location_name              AS location,
    ss.on_hand::NUMERIC           AS on_hand,
    ss.synced_at                  AS updated_at
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku;

COMMENT ON VIEW cin7_mirror.v_restock_report IS
  'Compatibility view: matches public.restock_report shape (sku, product, location, on_hand, updated_at). For Restock + Stock Anomalies pages.';


-- ============================================================
-- 2. RESTOCK VIEW compatibility
--    restock.js reads from: restock_view (sku, product, stock_locator, on_hand, pickface_space, restock_qty)
--    restock_view is currently a DB view that aggregates restock_report + restock_setup.
--    This cin7_mirror version provides sku/product/stock_locator/on_hand from the mirror,
--    leaving pickface_space and restock_qty to come from restock_setup (which stays as-is).
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_restock_view AS
SELECT
    ss.sku::TEXT                            AS sku,
    COALESCE(p.name, ss.product_name, '')   AS product,
    COALESCE(p.stock_locator, ss.bin, '')    AS stock_locator,
    SUM(ss.on_hand)::NUMERIC                AS on_hand,
    -- pickface_space and restock_qty come from restock_setup (not synced from Cin7)
    -- They will be JOINed by the page or by a wrapper view
    NULL::NUMERIC                            AS pickface_space,
    NULL::NUMERIC                            AS restock_qty
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
-- Only Main Warehouse pickface rows (bins starting with MA-)
WHERE ss.location_name = 'Main Warehouse'
  AND ss.bin != ''
GROUP BY ss.sku, p.name, ss.product_name, p.stock_locator, ss.bin;

COMMENT ON VIEW cin7_mirror.v_restock_view IS
  'Compatibility view: matches public.restock_view shape. Groups Main Warehouse bin-level stock by SKU. pickface_space/restock_qty are NULL (come from restock_setup).';


-- ============================================================
-- 3. REPLENISHMENT PAGE compatibility
--    replenishment-branch.js reads: stock_snapshot_lines (product, warehouse_code, qty_available)
--    linked to a stock_snapshots parent (id, created_at, source, original_filename, row_count)
-- ============================================================

-- 3a. Virtual "snapshot" row so replenishment page can find one
CREATE OR REPLACE VIEW cin7_mirror.v_stock_snapshots AS
SELECT
    '00000000-0000-0000-0000-000000000001'::UUID AS id,
    MAX(sr.started_at)                           AS created_at,
    'cin7_mirror_sync'                           AS source,
    'cin7_mirror.stock_snapshot'                  AS original_filename,
    (SELECT COUNT(*) FROM cin7_mirror.stock_snapshot) AS row_count
FROM cin7_mirror.sync_runs sr
WHERE sr.status = 'success';

COMMENT ON VIEW cin7_mirror.v_stock_snapshots IS
  'Compatibility view: matches public.stock_snapshots shape. Returns a single virtual snapshot row representing the latest successful sync.';

-- 3b. Stock lines in the format replenishment expects
CREATE OR REPLACE VIEW cin7_mirror.v_stock_snapshot_lines AS
SELECT
    '00000000-0000-0000-0000-000000000001'::UUID AS snapshot_id,
    COALESCE(p.name, ss.product_name, ss.sku)    AS product,
    ss.location_name                             AS warehouse_code,
    ss.available::NUMERIC                        AS qty_available
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku;

COMMENT ON VIEW cin7_mirror.v_stock_snapshot_lines IS
  'Compatibility view: matches public.stock_snapshot_lines shape (snapshot_id, product, warehouse_code, qty_available). For Replenishment page.';


-- ============================================================
-- 4. CYCLIC COUNT PAGE compatibility
--    cyclic-count.js reads: core_availability_snap (SKU, Location, Available)
--    Note: column names are UPPERCASE in the original table
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_core_availability AS
SELECT
    ss.sku            AS "SKU",
    ss.location_name  AS "Location",
    ss.available      AS "Available"
FROM cin7_mirror.stock_snapshot ss;

COMMENT ON VIEW cin7_mirror.v_core_availability IS
  'Compatibility view: matches public.core_availability_snap shape ("SKU", "Location", "Available"). For Cyclic Count page.';


-- ============================================================
-- 5. PRODUCTS TABLE compatibility
--    app.js searchProduct reads: Products (SKU, Code, barcode1..barcode6)
--    cin7_mirror.products has: sku, name, barcode (single)
--    This provides a compatible shape, mapping name→Code and barcode→barcode1
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_products AS
SELECT
    p.sku                       AS "SKU",
    p.name                      AS "Code",
    COALESCE(p.barcode, '')     AS barcode1,
    ''                          AS barcode2,
    ''                          AS barcode3,
    ''                          AS barcode4,
    ''                          AS barcode5,
    ''                          AS barcode6,
    -- Extra fields available from cin7_mirror (not in original Products table)
    p.name                      AS product_name,
    p.category                  AS category,
    p.brand                     AS brand,
    p.status                    AS product_status,
    p.stock_locator             AS stock_locator,
    p.minimum_before_reorder    AS minimum_before_reorder,
    p.reorder_quantity          AS reorder_quantity,
    p.average_cost              AS average_cost,
    p.weight                    AS weight,
    p.uom                       AS unit_of_measure
FROM cin7_mirror.products p;

COMMENT ON VIEW cin7_mirror.v_products IS
  'Compatibility view: matches public.Products shape (SKU, Code, barcode1-6). Extra columns from Cin7 appended for future use.';


-- ============================================================
-- 6. LOCATIONS TABLE compatibility
--    supabase-config.js searchLocation reads: Locations (code, created_at)
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_locations AS
SELECT
    l.name          AS code,
    l.synced_at     AS created_at,
    -- Extra fields from cin7_mirror
    l.id            AS cin7_id,
    l.is_default    AS is_default,
    l.is_deprecated AS is_deprecated,
    l.bin_count     AS bin_count
FROM cin7_mirror.locations l
WHERE l.is_deprecated = false;

COMMENT ON VIEW cin7_mirror.v_locations IS
  'Compatibility view: matches public.Locations shape (code, created_at). Only active locations.';


-- ============================================================
-- 7. STOCK BY SKU SUMMARY (useful for multiple pages)
--    Provides total stock across all locations for a given SKU
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_stock_summary AS
SELECT
    ss.sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    SUM(ss.on_hand)::NUMERIC             AS total_on_hand,
    SUM(ss.allocated)::NUMERIC           AS total_allocated,
    SUM(ss.available)::NUMERIC           AS total_available,
    SUM(ss.on_order)::NUMERIC            AS total_on_order,
    SUM(ss.in_transit)::NUMERIC          AS total_in_transit,
    COUNT(DISTINCT ss.location_name)     AS location_count,
    MAX(ss.synced_at)                    AS last_synced
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
GROUP BY ss.sku, p.name, ss.product_name;

COMMENT ON VIEW cin7_mirror.v_stock_summary IS
  'Aggregated stock totals per SKU across all locations. Useful for dashboard widgets, anomaly detection, etc.';


-- ============================================================
-- 8. MAIN WAREHOUSE BINS (for restock bin-level detail)
--    Shows stock per bin within Main Warehouse
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_main_warehouse_bins AS
SELECT
    ss.sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    ss.bin                                AS stock_locator,
    ss.on_hand::NUMERIC                   AS on_hand,
    ss.available::NUMERIC                 AS available,
    ss.allocated::NUMERIC                 AS allocated,
    ss.synced_at
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
WHERE ss.location_name = 'Main Warehouse'
  AND ss.bin != ''
ORDER BY ss.bin, ss.sku;

COMMENT ON VIEW cin7_mirror.v_main_warehouse_bins IS
  'Main Warehouse bin-level stock detail. For restock pickface analysis.';


-- ============================================================
-- RLS: Allow read access to all new views
-- (Views inherit from base table RLS, but explicit grants ensure access)
-- ============================================================
GRANT SELECT ON cin7_mirror.v_restock_report TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_restock_view TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_snapshots TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_snapshot_lines TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_core_availability TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_products TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_locations TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_summary TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_main_warehouse_bins TO anon, authenticated;

-- Grant usage on the schema itself
GRANT USAGE ON SCHEMA cin7_mirror TO anon, authenticated;
