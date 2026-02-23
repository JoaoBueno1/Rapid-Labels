-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  CIN7 MIRROR — DEPLOY COMPLETO                                 ║
-- ║  Cola TUDO isso no Supabase SQL Editor e clica "Run"           ║
-- ║                                                                 ║
-- ║  O que cria:                                                    ║
-- ║    Schema  : cin7_mirror                                        ║
-- ║    Tabelas : locations, products, stock_snapshot, sync_runs,    ║
-- ║              webhook_events, webhook_processing_log,            ║
-- ║              stock_movements, stock_snapshot_prev,              ║
-- ║              movement_alerts, alert_rules                       ║
-- ║    Views   : 17 views (dashboards, compatibilidade, audits)    ║
-- ║    RLS     : Read para todos, write para service_role           ║
-- ║    RPC     : truncate_stock_snapshot()                          ║
-- ╚══════════════════════════════════════════════════════════════════╝

-- ============================================================
-- 0. EXTENSÃO NECESSÁRIA (pg_trgm para busca fuzzy)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- 0. SCHEMA ISOLADO
-- ============================================================
CREATE SCHEMA IF NOT EXISTS cin7_mirror;
GRANT USAGE ON SCHEMA cin7_mirror TO anon, authenticated;


-- ============================================================
-- PARTE 1: TABELAS BASE (Locations, Products, Stock, Sync)
-- ============================================================

-- 1.1 LOCATIONS — Warehouse/location reference data
CREATE TABLE IF NOT EXISTS cin7_mirror.locations (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL,
    is_default      BOOLEAN DEFAULT false,
    is_deprecated   BOOLEAN DEFAULT false,
    parent_id       UUID,
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

-- 1.2 PRODUCTS — Product catalog/metadata
CREATE TABLE IF NOT EXISTS cin7_mirror.products (
    id              UUID PRIMARY KEY,
    sku             TEXT NOT NULL,
    name            TEXT NOT NULL,
    barcode         TEXT,
    category        TEXT,
    brand           TEXT,
    type            TEXT,
    status          TEXT DEFAULT 'Active',
    uom             TEXT DEFAULT 'Item',
    costing_method  TEXT,
    weight          DECIMAL(12,4) DEFAULT 0,
    weight_units    TEXT DEFAULT 'g',
    default_location TEXT,
    minimum_before_reorder DECIMAL(12,4) DEFAULT 0,
    reorder_quantity DECIMAL(12,4) DEFAULT 0,
    average_cost    DECIMAL(12,4) DEFAULT 0,
    stock_locator   TEXT,
    pick_zones      TEXT,
    sellable        BOOLEAN DEFAULT true,
    last_modified_on TIMESTAMPTZ,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_product_sku UNIQUE (sku)
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON cin7_mirror.products (sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON cin7_mirror.products (barcode) WHERE barcode IS NOT NULL AND barcode != '';
CREATE INDEX IF NOT EXISTS idx_products_category ON cin7_mirror.products (category);
CREATE INDEX IF NOT EXISTS idx_products_status ON cin7_mirror.products (status);
CREATE INDEX IF NOT EXISTS idx_products_name_gin ON cin7_mirror.products USING gin (name gin_trgm_ops);

-- 1.3 STOCK SNAPSHOT — Current stock levels per SKU per location
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_snapshot (
    id              UUID,
    sku             TEXT NOT NULL,
    product_name    TEXT,
    barcode         TEXT,
    location_name   TEXT NOT NULL,
    bin             TEXT NOT NULL DEFAULT '',
    batch           TEXT NOT NULL DEFAULT '',
    expiry_date     DATE,
    on_hand         DECIMAL(12,4) DEFAULT 0,
    allocated       DECIMAL(12,4) DEFAULT 0,
    available       DECIMAL(12,4) DEFAULT 0,
    on_order        DECIMAL(12,4) DEFAULT 0,
    stock_on_hand   DECIMAL(12,4) DEFAULT 0,
    in_transit      DECIMAL(12,4) DEFAULT 0,
    next_delivery_date DATE,
    synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (sku, location_name, bin, batch)
);

CREATE INDEX IF NOT EXISTS idx_stock_sku ON cin7_mirror.stock_snapshot (sku);
CREATE INDEX IF NOT EXISTS idx_stock_location ON cin7_mirror.stock_snapshot (location_name);
CREATE INDEX IF NOT EXISTS idx_stock_sku_location ON cin7_mirror.stock_snapshot (sku, location_name);
CREATE INDEX IF NOT EXISTS idx_stock_barcode ON cin7_mirror.stock_snapshot (barcode) WHERE barcode IS NOT NULL AND barcode != '';
CREATE INDEX IF NOT EXISTS idx_stock_low ON cin7_mirror.stock_snapshot (available) WHERE available <= 0;
CREATE INDEX IF NOT EXISTS idx_stock_synced ON cin7_mirror.stock_snapshot (synced_at);

-- 1.4 SYNC RUNS — Audit log for every sync execution
CREATE TABLE IF NOT EXISTS cin7_mirror.sync_runs (
    run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',
    sync_type       TEXT NOT NULL,
    total_api_calls INTEGER DEFAULT 0,
    total_pages     INTEGER DEFAULT 0,
    products_synced INTEGER DEFAULT 0,
    stock_rows_synced INTEGER DEFAULT 0,
    locations_synced INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    avg_call_ms     INTEGER,
    errors          JSONB DEFAULT '[]'::jsonb,
    retries         INTEGER DEFAULT 0,
    rate_limited    BOOLEAN DEFAULT false,
    config          JSONB DEFAULT '{}'::jsonb,
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_status ON cin7_mirror.sync_runs (status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON cin7_mirror.sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_type ON cin7_mirror.sync_runs (sync_type);


-- ============================================================
-- PARTE 2: WEBHOOK EVENTS
-- ============================================================

-- 2.1 WEBHOOK EVENTS — Incoming webhook capture
CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_events (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at  TIMESTAMPTZ,
    topic         TEXT NOT NULL,
    event_id      TEXT,
    payload       JSONB NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','processed','failed')),
    error_message TEXT,
    affected_skus TEXT[],
    metadata      JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON cin7_mirror.webhook_events (status) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON cin7_mirror.webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_topic ON cin7_mirror.webhook_events (topic);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id ON cin7_mirror.webhook_events (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_skus ON cin7_mirror.webhook_events USING GIN (affected_skus);

-- 2.2 WEBHOOK PROCESSING LOG — Batch processing runs
CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_processing_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    events_found    INT DEFAULT 0,
    events_processed INT DEFAULT 0,
    events_failed   INT DEFAULT 0,
    skus_updated    INT DEFAULT 0,
    api_calls_made  INT DEFAULT 0,
    duration_ms     INT,
    errors          JSONB DEFAULT '[]'
);


-- ============================================================
-- PARTE 3: STOCK MOVEMENTS & ALERTS (Audit System)
-- ============================================================

-- 3.1 STOCK MOVEMENTS — Full audit log of every stock change
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_movements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sku             TEXT NOT NULL,
    product_name    TEXT,
    movement_type   TEXT NOT NULL,
    reference_number TEXT,
    reference_type   TEXT,
    cin7_task_id     TEXT,
    sales_rep        TEXT,
    member_email     TEXT,
    customer_name    TEXT,
    from_location    TEXT,
    from_bin         TEXT,
    to_location      TEXT,
    to_bin           TEXT,
    quantity         DECIMAL(12,4) NOT NULL DEFAULT 0,
    quantity_before  DECIMAL(12,4),
    quantity_after   DECIMAL(12,4),
    is_internal      BOOLEAN DEFAULT false,
    is_external      BOOLEAN DEFAULT false,
    is_anomaly       BOOLEAN DEFAULT false,
    source           TEXT NOT NULL DEFAULT 'webhook',
    webhook_event_id BIGINT,
    raw_data         JSONB DEFAULT '{}',
    stock_locator    TEXT,
    product_category TEXT
);

CREATE INDEX IF NOT EXISTS idx_movements_sku ON cin7_mirror.stock_movements (sku);
CREATE INDEX IF NOT EXISTS idx_movements_detected ON cin7_mirror.stock_movements (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_type ON cin7_mirror.stock_movements (movement_type);
CREATE INDEX IF NOT EXISTS idx_movements_ref ON cin7_mirror.stock_movements (reference_number) WHERE reference_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_ref_type ON cin7_mirror.stock_movements (reference_type) WHERE reference_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_from_loc ON cin7_mirror.stock_movements (from_location) WHERE from_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_to_loc ON cin7_mirror.stock_movements (to_location) WHERE to_location IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_movements_external ON cin7_mirror.stock_movements (is_external) WHERE is_external = true;
CREATE INDEX IF NOT EXISTS idx_movements_anomaly ON cin7_mirror.stock_movements (is_anomaly) WHERE is_anomaly = true;
CREATE INDEX IF NOT EXISTS idx_movements_sku_detected ON cin7_mirror.stock_movements (sku, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_movements_product_gin ON cin7_mirror.stock_movements USING gin (product_name gin_trgm_ops);

-- 3.2 PREVIOUS SNAPSHOT — For delta detection between syncs
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_snapshot_prev (
    sku             TEXT NOT NULL,
    product_name    TEXT,
    location_name   TEXT NOT NULL,
    bin             TEXT NOT NULL DEFAULT '',
    batch           TEXT NOT NULL DEFAULT '',
    on_hand         DECIMAL(12,4) DEFAULT 0,
    allocated       DECIMAL(12,4) DEFAULT 0,
    available       DECIMAL(12,4) DEFAULT 0,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (sku, location_name, bin, batch)
);

CREATE INDEX IF NOT EXISTS idx_prev_sku ON cin7_mirror.stock_snapshot_prev (sku);
CREATE INDEX IF NOT EXISTS idx_prev_location ON cin7_mirror.stock_snapshot_prev (location_name);

-- 3.3 MOVEMENT ALERTS — Triggered notifications
CREATE TABLE IF NOT EXISTS cin7_mirror.movement_alerts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    alert_type      TEXT NOT NULL,
    severity         TEXT NOT NULL DEFAULT 'info',
    title            TEXT NOT NULL,
    description      TEXT,
    movement_id      BIGINT REFERENCES cin7_mirror.stock_movements(id),
    sku              TEXT,
    product_name     TEXT,
    reference_number TEXT,
    movement_type    TEXT,
    from_location    TEXT,
    to_location      TEXT,
    quantity         DECIMAL(12,4),
    member_email     TEXT,
    sales_rep        TEXT,
    metadata         JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON cin7_mirror.movement_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON cin7_mirror.movement_alerts (acknowledged_at) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_type ON cin7_mirror.movement_alerts (alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON cin7_mirror.movement_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_alerts_sku ON cin7_mirror.movement_alerts (sku) WHERE sku IS NOT NULL;

-- 3.4 ALERT RULES — Configurable thresholds
CREATE TABLE IF NOT EXISTS cin7_mirror.alert_rules (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    is_active       BOOLEAN DEFAULT true,
    rule_type       TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'warning',
    description     TEXT,
    config          JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);


-- ============================================================
-- PARTE 4: VIEWS — Dashboards & Helpers
-- ============================================================

-- 4.1 Stock summary by warehouse
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

-- 4.2 Low stock items
CREATE OR REPLACE VIEW cin7_mirror.low_stock_items AS
SELECT
    s.sku, s.product_name, s.location_name,
    s.on_hand, s.allocated, s.available, s.on_order, s.in_transit,
    s.next_delivery_date, p.category, p.minimum_before_reorder, s.synced_at
FROM cin7_mirror.stock_snapshot s
LEFT JOIN cin7_mirror.products p ON s.sku = p.sku
WHERE s.available <= 0
ORDER BY s.available ASC;

-- 4.3 Data freshness check
CREATE OR REPLACE VIEW cin7_mirror.data_freshness AS
SELECT
    'stock_snapshot' as table_name, COUNT(*) as total_rows,
    MAX(synced_at) as latest_sync, MIN(synced_at) as oldest_sync,
    NOW() - MAX(synced_at) as staleness
FROM cin7_mirror.stock_snapshot
UNION ALL
SELECT 'products', COUNT(*), MAX(synced_at), MIN(synced_at), NOW() - MAX(synced_at)
FROM cin7_mirror.products
UNION ALL
SELECT 'locations', COUNT(*), MAX(synced_at), MIN(synced_at), NOW() - MAX(synced_at)
FROM cin7_mirror.locations;

-- 4.4 Pending webhooks summary
CREATE OR REPLACE VIEW cin7_mirror.v_pending_webhooks AS
SELECT
    topic,
    COUNT(*) AS pending_count,
    MIN(received_at) AS oldest_pending,
    MAX(received_at) AS newest_pending,
    array_agg(DISTINCT unnested_sku) FILTER (WHERE unnested_sku IS NOT NULL) AS all_affected_skus
FROM cin7_mirror.webhook_events,
     LATERAL unnest(COALESCE(affected_skus, ARRAY[]::text[])) AS unnested_sku
WHERE status = 'pending'
GROUP BY topic
ORDER BY oldest_pending;

-- 4.5 Recent movements (last 24h)
CREATE OR REPLACE VIEW cin7_mirror.v_recent_movements AS
SELECT
    sku, product_name, movement_type,
    COUNT(*) AS movement_count,
    SUM(quantity) AS net_quantity,
    SUM(ABS(quantity)) AS total_volume,
    MIN(detected_at) AS first_movement,
    MAX(detected_at) AS last_movement,
    array_agg(DISTINCT reference_number) FILTER (WHERE reference_number IS NOT NULL) AS references
FROM cin7_mirror.stock_movements
WHERE detected_at > now() - INTERVAL '24 hours'
GROUP BY sku, product_name, movement_type
ORDER BY MAX(detected_at) DESC;

-- 4.6 Unacknowledged alerts summary
CREATE OR REPLACE VIEW cin7_mirror.v_alert_summary AS
SELECT
    alert_type, severity,
    COUNT(*) AS alert_count,
    MIN(created_at) AS oldest_alert,
    MAX(created_at) AS newest_alert
FROM cin7_mirror.movement_alerts
WHERE acknowledged_at IS NULL
GROUP BY alert_type, severity
ORDER BY
    CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    alert_count DESC;

-- 4.7 Product movement summary (all time)
CREATE OR REPLACE VIEW cin7_mirror.v_product_movement_summary AS
SELECT
    sku, product_name,
    COUNT(*) AS total_movements,
    COUNT(*) FILTER (WHERE movement_type = 'sales_pick' OR movement_type = 'sales_ship') AS sales_movements,
    COUNT(*) FILTER (WHERE movement_type = 'stock_transfer') AS transfer_movements,
    COUNT(*) FILTER (WHERE movement_type = 'purchase_receive') AS receive_movements,
    COUNT(*) FILTER (WHERE movement_type = 'stock_adjustment') AS adjustment_movements,
    COUNT(*) FILTER (WHERE is_anomaly = true) AS anomaly_count,
    SUM(quantity) FILTER (WHERE quantity > 0) AS total_in,
    SUM(ABS(quantity)) FILTER (WHERE quantity < 0) AS total_out,
    MIN(detected_at) AS first_seen,
    MAX(detected_at) AS last_seen
FROM cin7_mirror.stock_movements
GROUP BY sku, product_name;


-- ============================================================
-- PARTE 5: COMPATIBILITY VIEWS (para páginas existentes)
-- ============================================================

-- 5.1 Restock report shape
CREATE OR REPLACE VIEW cin7_mirror.v_restock_report AS
SELECT
    ss.sku::TEXT AS sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    ss.location_name AS location,
    ss.on_hand::NUMERIC AS on_hand,
    ss.synced_at AS updated_at
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku;

-- 5.2 Restock view shape (Main Warehouse bins)
CREATE OR REPLACE VIEW cin7_mirror.v_restock_view AS
SELECT
    ss.sku::TEXT AS sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    COALESCE(p.stock_locator, ss.bin, '') AS stock_locator,
    SUM(ss.on_hand)::NUMERIC AS on_hand,
    NULL::NUMERIC AS pickface_space,
    NULL::NUMERIC AS restock_qty
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
WHERE ss.location_name = 'Main Warehouse' AND ss.bin != ''
GROUP BY ss.sku, p.name, ss.product_name, p.stock_locator, ss.bin;

-- 5.3 Virtual snapshot row (for replenishment page)
CREATE OR REPLACE VIEW cin7_mirror.v_stock_snapshots AS
SELECT
    '00000000-0000-0000-0000-000000000001'::UUID AS id,
    MAX(sr.started_at) AS created_at,
    'cin7_mirror_sync' AS source,
    'cin7_mirror.stock_snapshot' AS original_filename,
    (SELECT COUNT(*) FROM cin7_mirror.stock_snapshot) AS row_count
FROM cin7_mirror.sync_runs sr
WHERE sr.status = 'success';

-- 5.4 Stock lines (for replenishment page)
CREATE OR REPLACE VIEW cin7_mirror.v_stock_snapshot_lines AS
SELECT
    '00000000-0000-0000-0000-000000000001'::UUID AS snapshot_id,
    COALESCE(p.name, ss.product_name, ss.sku) AS product,
    ss.location_name AS warehouse_code,
    ss.available::NUMERIC AS qty_available
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku;

-- 5.5 Core availability (for cyclic count page)
CREATE OR REPLACE VIEW cin7_mirror.v_core_availability AS
SELECT
    ss.sku AS "SKU",
    ss.location_name AS "Location",
    ss.available AS "Available"
FROM cin7_mirror.stock_snapshot ss;

-- 5.6 Products compatibility (for app.js search)
CREATE OR REPLACE VIEW cin7_mirror.v_products AS
SELECT
    p.sku AS "SKU",
    p.name AS "Code",
    COALESCE(p.barcode, '') AS barcode1,
    '' AS barcode2, '' AS barcode3, '' AS barcode4,
    '' AS barcode5, '' AS barcode6,
    p.name AS product_name,
    p.category, p.brand,
    p.status AS product_status,
    p.stock_locator,
    p.minimum_before_reorder,
    p.reorder_quantity,
    p.average_cost,
    p.weight,
    p.uom AS unit_of_measure
FROM cin7_mirror.products p;

-- 5.7 Locations compatibility
CREATE OR REPLACE VIEW cin7_mirror.v_locations AS
SELECT
    l.name AS code,
    l.synced_at AS created_at,
    l.id AS cin7_id,
    l.is_default,
    l.is_deprecated,
    l.bin_count
FROM cin7_mirror.locations l
WHERE l.is_deprecated = false;

-- 5.8 Stock summary per SKU
CREATE OR REPLACE VIEW cin7_mirror.v_stock_summary AS
SELECT
    ss.sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    SUM(ss.on_hand)::NUMERIC AS total_on_hand,
    SUM(ss.allocated)::NUMERIC AS total_allocated,
    SUM(ss.available)::NUMERIC AS total_available,
    SUM(ss.on_order)::NUMERIC AS total_on_order,
    SUM(ss.in_transit)::NUMERIC AS total_in_transit,
    COUNT(DISTINCT ss.location_name) AS location_count,
    MAX(ss.synced_at) AS last_synced
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
GROUP BY ss.sku, p.name, ss.product_name;

-- 5.9 Main warehouse bins detail
CREATE OR REPLACE VIEW cin7_mirror.v_main_warehouse_bins AS
SELECT
    ss.sku,
    COALESCE(p.name, ss.product_name, '') AS product,
    ss.bin AS stock_locator,
    ss.on_hand::NUMERIC AS on_hand,
    ss.available::NUMERIC AS available,
    ss.allocated::NUMERIC AS allocated,
    ss.synced_at
FROM cin7_mirror.stock_snapshot ss
LEFT JOIN cin7_mirror.products p ON p.sku = ss.sku
WHERE ss.location_name = 'Main Warehouse' AND ss.bin != ''
ORDER BY ss.bin, ss.sku;


-- ============================================================
-- PARTE 6: RLS — Row Level Security
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE cin7_mirror.stock_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.webhook_processing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.stock_snapshot_prev ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.movement_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.alert_rules ENABLE ROW LEVEL SECURITY;

-- Read policies (everyone can read) — DROP first to make idempotent
DROP POLICY IF EXISTS "Allow read stock_snapshot" ON cin7_mirror.stock_snapshot;
DROP POLICY IF EXISTS "Allow read products" ON cin7_mirror.products;
DROP POLICY IF EXISTS "Allow read locations" ON cin7_mirror.locations;
DROP POLICY IF EXISTS "Allow read sync_runs" ON cin7_mirror.sync_runs;
DROP POLICY IF EXISTS "webhook_events_read" ON cin7_mirror.webhook_events;
DROP POLICY IF EXISTS "webhook_processing_log_read" ON cin7_mirror.webhook_processing_log;
DROP POLICY IF EXISTS "movements_read" ON cin7_mirror.stock_movements;
DROP POLICY IF EXISTS "prev_read" ON cin7_mirror.stock_snapshot_prev;
DROP POLICY IF EXISTS "alerts_read" ON cin7_mirror.movement_alerts;
DROP POLICY IF EXISTS "rules_read" ON cin7_mirror.alert_rules;

CREATE POLICY "Allow read stock_snapshot" ON cin7_mirror.stock_snapshot FOR SELECT USING (true);
CREATE POLICY "Allow read products" ON cin7_mirror.products FOR SELECT USING (true);
CREATE POLICY "Allow read locations" ON cin7_mirror.locations FOR SELECT USING (true);
CREATE POLICY "Allow read sync_runs" ON cin7_mirror.sync_runs FOR SELECT USING (true);
CREATE POLICY "webhook_events_read" ON cin7_mirror.webhook_events FOR SELECT USING (true);
CREATE POLICY "webhook_processing_log_read" ON cin7_mirror.webhook_processing_log FOR SELECT USING (true);
CREATE POLICY "movements_read" ON cin7_mirror.stock_movements FOR SELECT USING (true);
CREATE POLICY "prev_read" ON cin7_mirror.stock_snapshot_prev FOR SELECT USING (true);
CREATE POLICY "alerts_read" ON cin7_mirror.movement_alerts FOR SELECT USING (true);
CREATE POLICY "rules_read" ON cin7_mirror.alert_rules FOR SELECT USING (true);

-- Write policies — DROP first to make idempotent
DROP POLICY IF EXISTS "Allow write stock_snapshot" ON cin7_mirror.stock_snapshot;
DROP POLICY IF EXISTS "Allow write products" ON cin7_mirror.products;
DROP POLICY IF EXISTS "Allow write locations" ON cin7_mirror.locations;
DROP POLICY IF EXISTS "Allow write sync_runs" ON cin7_mirror.sync_runs;
DROP POLICY IF EXISTS "movements_write" ON cin7_mirror.stock_movements;
DROP POLICY IF EXISTS "prev_write" ON cin7_mirror.stock_snapshot_prev;
DROP POLICY IF EXISTS "alerts_write" ON cin7_mirror.movement_alerts;
DROP POLICY IF EXISTS "rules_write" ON cin7_mirror.alert_rules;

CREATE POLICY "Allow write stock_snapshot" ON cin7_mirror.stock_snapshot FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow write products" ON cin7_mirror.products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow write locations" ON cin7_mirror.locations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow write sync_runs" ON cin7_mirror.sync_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "movements_write" ON cin7_mirror.stock_movements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "prev_write" ON cin7_mirror.stock_snapshot_prev FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "alerts_write" ON cin7_mirror.movement_alerts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rules_write" ON cin7_mirror.alert_rules FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- PARTE 7: GRANTS — Permissões de acesso
-- ============================================================

-- Tables: read for anon/authenticated
GRANT SELECT ON cin7_mirror.stock_snapshot TO anon, authenticated;
GRANT SELECT ON cin7_mirror.products TO anon, authenticated;
GRANT SELECT ON cin7_mirror.locations TO anon, authenticated;
GRANT SELECT ON cin7_mirror.sync_runs TO anon, authenticated;
GRANT SELECT ON cin7_mirror.webhook_events TO anon, authenticated;
GRANT SELECT ON cin7_mirror.webhook_processing_log TO anon, authenticated;
GRANT SELECT ON cin7_mirror.stock_movements TO anon, authenticated;
GRANT SELECT ON cin7_mirror.stock_snapshot_prev TO anon, authenticated;
GRANT SELECT, UPDATE ON cin7_mirror.movement_alerts TO anon, authenticated;
GRANT SELECT ON cin7_mirror.alert_rules TO anon, authenticated;

-- Views: read for anon/authenticated
GRANT SELECT ON cin7_mirror.stock_by_warehouse TO anon, authenticated;
GRANT SELECT ON cin7_mirror.low_stock_items TO anon, authenticated;
GRANT SELECT ON cin7_mirror.data_freshness TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_pending_webhooks TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_recent_movements TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_alert_summary TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_product_movement_summary TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_restock_report TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_restock_view TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_snapshots TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_snapshot_lines TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_core_availability TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_products TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_locations TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_stock_summary TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_main_warehouse_bins TO anon, authenticated;


-- ============================================================
-- PARTE 8: RPC FUNCTIONS
-- ============================================================

-- Fast TRUNCATE for stock_snapshot (bypasses row-limit on DELETE)
CREATE OR REPLACE FUNCTION cin7_mirror.truncate_stock_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  TRUNCATE cin7_mirror.stock_snapshot;
END;
$$;

GRANT EXECUTE ON FUNCTION cin7_mirror.truncate_stock_snapshot() TO service_role;


-- ============================================================
-- PARTE 9: SEED DATA — Default alert rules
-- ============================================================
INSERT INTO cin7_mirror.alert_rules (rule_type, severity, description, config) VALUES
    ('non_pickbay_pick', 'warning', 'Sales order picked from non-pickface bin', '{"enabled": true}'),
    ('external_transfer', 'warning', 'Stock transferred to external location', '{"locations": ["Project Warehouse", "Sydney Warehouse", "Melbourne Warehouse", "Brisbane Warehouse", "Cairns Warehouse", "Coffs Harbour Warehouse", "Hobart Warehouse", "Sunshine Coast Warehouse"]}'),
    ('large_quantity', 'info', 'Unusually large quantity movement', '{"min_quantity": 500}'),
    ('stock_negative', 'critical', 'Stock went negative in any location', '{"enabled": true}'),
    ('low_stock_after_move', 'warning', 'Stock fell below min threshold after movement', '{"enabled": true}')
ON CONFLICT DO NOTHING;


-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  FEITO! Schema cin7_mirror criado com sucesso.                  ║
-- ║                                                                  ║
-- ║  PRÓXIMO PASSO:                                                  ║
-- ║  Vai em Settings → API → Schema Settings e adiciona             ║
-- ║  "cin7_mirror" na lista de Exposed Schemas.                     ║
-- ║  Isso permite que o JS client acesse via .schema('cin7_mirror') ║
-- ╚══════════════════════════════════════════════════════════════════╝
