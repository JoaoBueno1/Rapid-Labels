-- ============================================================
-- Cin7 Stock Mirror — Supabase Schema
-- Isolated schema: cin7_mirror
-- Created: 2026-02-19
-- ============================================================

-- Create isolated schema
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- ============================================================
-- 1. LOCATIONS — Warehouse/location reference data
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.locations (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL,
    is_default      BOOLEAN DEFAULT false,
    is_deprecated   BOOLEAN DEFAULT false,
    parent_id       UUID,                       -- for bins (child of a location)
    address_line1   TEXT,
    address_city    TEXT,
    address_state   TEXT,
    address_postcode TEXT,
    address_country TEXT,
    bin_count       INTEGER DEFAULT 0,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_location_name UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_locations_name ON cin7_mirror.locations (name);
CREATE INDEX IF NOT EXISTS idx_locations_active ON cin7_mirror.locations (is_deprecated) WHERE is_deprecated = false;

-- ============================================================
-- 2. PRODUCTS — Product catalog/metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.products (
    id              UUID PRIMARY KEY,
    sku             TEXT NOT NULL,
    name            TEXT NOT NULL,
    barcode         TEXT,
    category        TEXT,
    brand           TEXT,
    type            TEXT,                       -- Stock, Service, etc.
    status          TEXT DEFAULT 'Active',      -- Active, Deprecated
    uom             TEXT DEFAULT 'Item',        -- Unit of Measure
    costing_method  TEXT,                       -- FIFO, FEFO, etc.
    weight          DECIMAL(12,4) DEFAULT 0,
    weight_units    TEXT DEFAULT 'g',
    default_location TEXT,
    minimum_before_reorder DECIMAL(12,4) DEFAULT 0,
    reorder_quantity DECIMAL(12,4) DEFAULT 0,
    average_cost    DECIMAL(12,4) DEFAULT 0,
    stock_locator   TEXT,
    pick_zones      TEXT,
    sellable        BOOLEAN DEFAULT true,
    last_modified_on TIMESTAMPTZ,              -- from Cin7
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT uq_product_sku UNIQUE (sku)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON cin7_mirror.products (sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON cin7_mirror.products (barcode) WHERE barcode IS NOT NULL AND barcode != '';
CREATE INDEX IF NOT EXISTS idx_products_category ON cin7_mirror.products (category);
CREATE INDEX IF NOT EXISTS idx_products_status ON cin7_mirror.products (status);
CREATE INDEX IF NOT EXISTS idx_products_name_gin ON cin7_mirror.products USING gin (name gin_trgm_ops);

-- ============================================================
-- 3. STOCK SNAPSHOT — Current stock levels per SKU per location
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_snapshot (
    id              UUID,                       -- Cin7's ProductAvailability ID
    sku             TEXT NOT NULL,
    product_name    TEXT,
    barcode         TEXT,
    location_name   TEXT NOT NULL,
    bin             TEXT NOT NULL DEFAULT '',
    batch           TEXT NOT NULL DEFAULT '',
    expiry_date     DATE,
    
    -- Quantity fields
    on_hand         DECIMAL(12,4) DEFAULT 0,    -- Physical stock in location
    allocated       DECIMAL(12,4) DEFAULT 0,    -- Reserved for orders
    available       DECIMAL(12,4) DEFAULT 0,    -- on_hand - allocated
    on_order        DECIMAL(12,4) DEFAULT 0,    -- Incoming from POs
    stock_on_hand   DECIMAL(12,4) DEFAULT 0,    -- Total across all locations
    in_transit      DECIMAL(12,4) DEFAULT 0,    -- In transfer between locations
    
    next_delivery_date DATE,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Composite PK: one row per SKU+Location+Bin+Batch combo
    PRIMARY KEY (sku, location_name, bin, batch)
);

-- Performance indexes for common queries
CREATE INDEX IF NOT EXISTS idx_stock_sku ON cin7_mirror.stock_snapshot (sku);
CREATE INDEX IF NOT EXISTS idx_stock_location ON cin7_mirror.stock_snapshot (location_name);
CREATE INDEX IF NOT EXISTS idx_stock_sku_location ON cin7_mirror.stock_snapshot (sku, location_name);
CREATE INDEX IF NOT EXISTS idx_stock_barcode ON cin7_mirror.stock_snapshot (barcode) WHERE barcode IS NOT NULL AND barcode != '';
CREATE INDEX IF NOT EXISTS idx_stock_low ON cin7_mirror.stock_snapshot (available) WHERE available <= 0;
CREATE INDEX IF NOT EXISTS idx_stock_synced ON cin7_mirror.stock_snapshot (synced_at);

-- ============================================================
-- 4. SYNC RUNS — Audit log for every sync execution
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.sync_runs (
    run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',  -- running, success, failed
    sync_type       TEXT NOT NULL,                    -- full, products_only, stock_only, locations_only
    
    -- Metrics
    total_api_calls INTEGER DEFAULT 0,
    total_pages     INTEGER DEFAULT 0,
    products_synced INTEGER DEFAULT 0,
    stock_rows_synced INTEGER DEFAULT 0,
    locations_synced INTEGER DEFAULT 0,
    
    -- Timing
    duration_ms     INTEGER,
    avg_call_ms     INTEGER,
    
    -- Errors
    errors          JSONB DEFAULT '[]'::jsonb,
    retries         INTEGER DEFAULT 0,
    rate_limited    BOOLEAN DEFAULT false,
    
    -- Config used
    config          JSONB DEFAULT '{}'::jsonb,
    
    -- Summary
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON cin7_mirror.sync_runs (status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON cin7_mirror.sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_type ON cin7_mirror.sync_runs (sync_type);

-- ============================================================
-- 5. HELPER VIEWS
-- ============================================================

-- View: Stock summary by warehouse (for dashboards)
CREATE OR REPLACE VIEW cin7_mirror.stock_by_warehouse AS
SELECT 
    location_name,
    COUNT(DISTINCT sku) as total_skus,
    SUM(on_hand) as total_on_hand,
    SUM(allocated) as total_allocated,
    SUM(available) as total_available,
    SUM(on_order) as total_on_order,
    SUM(in_transit) as total_in_transit,
    COUNT(*) FILTER (WHERE available <= 0 AND on_hand > 0) as out_of_stock_count,
    COUNT(*) FILTER (WHERE available < 0) as negative_stock_count,
    MAX(synced_at) as last_synced
FROM cin7_mirror.stock_snapshot
GROUP BY location_name
ORDER BY total_on_hand DESC;

-- View: Low stock items (available <= 0 but has on_hand or on_order)
CREATE OR REPLACE VIEW cin7_mirror.low_stock_items AS
SELECT 
    s.sku,
    s.product_name,
    s.location_name,
    s.on_hand,
    s.allocated,
    s.available,
    s.on_order,
    s.in_transit,
    s.next_delivery_date,
    p.category,
    p.minimum_before_reorder,
    s.synced_at
FROM cin7_mirror.stock_snapshot s
LEFT JOIN cin7_mirror.products p ON s.sku = p.sku
WHERE s.available <= 0
ORDER BY s.available ASC;

-- View: Data freshness check
CREATE OR REPLACE VIEW cin7_mirror.data_freshness AS
SELECT 
    'stock_snapshot' as table_name,
    COUNT(*) as total_rows,
    MAX(synced_at) as latest_sync,
    MIN(synced_at) as oldest_sync,
    NOW() - MAX(synced_at) as staleness
FROM cin7_mirror.stock_snapshot
UNION ALL
SELECT 
    'products',
    COUNT(*),
    MAX(synced_at),
    MIN(synced_at),
    NOW() - MAX(synced_at)
FROM cin7_mirror.products
UNION ALL
SELECT 
    'locations',
    COUNT(*),
    MAX(synced_at),
    MIN(synced_at),
    NOW() - MAX(synced_at)
FROM cin7_mirror.locations;

-- ============================================================
-- 6. ROW-LEVEL SECURITY (read-only for app)
-- ============================================================

-- Enable RLS
ALTER TABLE cin7_mirror.stock_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.sync_runs ENABLE ROW LEVEL SECURITY;

-- Allow read access for authenticated users (anon key / service_role can read)
CREATE POLICY "Allow read stock_snapshot" ON cin7_mirror.stock_snapshot
    FOR SELECT USING (true);

CREATE POLICY "Allow read products" ON cin7_mirror.products
    FOR SELECT USING (true);

CREATE POLICY "Allow read locations" ON cin7_mirror.locations
    FOR SELECT USING (true);

CREATE POLICY "Allow read sync_runs" ON cin7_mirror.sync_runs
    FOR SELECT USING (true);

-- Write access only for service_role (sync service uses service_role key)
CREATE POLICY "Allow write stock_snapshot" ON cin7_mirror.stock_snapshot
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow write products" ON cin7_mirror.products
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow write locations" ON cin7_mirror.locations
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow write sync_runs" ON cin7_mirror.sync_runs
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- NOTE: pg_trgm extension needed for GIN index on product name
-- Run this if not already enabled:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- ============================================================

-- ============================================================
-- 7. RPC FUNCTIONS (for operations that need to bypass row limits)
-- ============================================================

-- Fast TRUNCATE for stock_snapshot (bypasses Supabase row-limit on DELETE)
CREATE OR REPLACE FUNCTION cin7_mirror.truncate_stock_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  TRUNCATE cin7_mirror.stock_snapshot;
END;
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION cin7_mirror.truncate_stock_snapshot() TO service_role;
