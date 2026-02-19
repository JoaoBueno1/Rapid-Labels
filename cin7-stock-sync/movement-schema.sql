-- ============================================================
-- Cin7 Mirror — Stock Movements & Alerts Schema
-- Purpose: Track ALL stock movements with full audit trail,
--          generate alerts for specific movement types,
--          enable per-product movement history.
--
-- Tables:
--   cin7_mirror.stock_movements       — Every detected movement
--   cin7_mirror.stock_snapshots_prev  — Previous snapshot for delta detection
--   cin7_mirror.movement_alerts       — Triggered alerts
--   cin7_mirror.alert_rules           — Configurable alert rules
--
-- Created: 2026-02-19
-- ============================================================

CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- ============================================================
-- 1. STOCK MOVEMENTS — Full audit log
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_movements (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Product info
    sku             TEXT NOT NULL,
    product_name    TEXT,

    -- Movement classification
    movement_type   TEXT NOT NULL,
    -- Types:
    --   'sales_pick'          — SO pick allocated/shipped stock
    --   'sales_ship'          — SO shipped (stock left the building)
    --   'stock_transfer'      — Transfer between locations/bins
    --   'bin_transfer'        — Internal bin-to-bin in same location
    --   'purchase_receive'    — PO received stock
    --   'stock_adjustment'    — Manual adjustment (count, correction)
    --   'assembly'            — Finished goods / assembly
    --   'disassembly'         — Disassembly
    --   'stock_take'          — Stock take / cycle count
    --   'snapshot_delta'      — Detected from snapshot comparison (source unknown)
    --   'write_off'           — Write-off / disposal
    --   'other'               — Unknown / other

    -- Transaction reference
    reference_number TEXT,              -- SO-12345, PO-67890, TRF-111, ADJ-222
    reference_type   TEXT,              -- SalesOrder, PurchaseOrder, StockTransfer, StockAdjustment, Assembly
    cin7_task_id     TEXT,              -- Cin7 internal task/transaction ID

    -- Who
    sales_rep        TEXT,              -- Sales rep name (from SO)
    member_email     TEXT,              -- User email who performed action
    customer_name    TEXT,              -- Customer (for SO)

    -- Location/Bin movement
    from_location    TEXT,              -- Source warehouse/location name
    from_bin         TEXT,              -- Source bin
    to_location      TEXT,              -- Destination warehouse/location name
    to_bin           TEXT,              -- Destination bin

    -- Quantities
    quantity         DECIMAL(12,4) NOT NULL DEFAULT 0,  -- Positive = stock in, Negative = stock out
    quantity_before  DECIMAL(12,4),           -- on_hand before movement
    quantity_after   DECIMAL(12,4),           -- on_hand after movement

    -- Classification flags
    is_internal      BOOLEAN DEFAULT false,  -- true = bin-to-bin within same location (ignorable)
    is_external      BOOLEAN DEFAULT false,  -- true = cross-location or customer-facing
    is_anomaly       BOOLEAN DEFAULT false,  -- true = unexpected (non-pickbay pick, etc.)

    -- Source of detection
    source           TEXT NOT NULL DEFAULT 'webhook',
    -- Sources: 'webhook', 'snapshot_delta', 'manual', 'api_poll'

    -- Webhook reference
    webhook_event_id BIGINT,            -- FK to cin7_mirror.webhook_events

    -- Raw data for forensic analysis
    raw_data         JSONB DEFAULT '{}',

    -- Product context (cached for display without joins)
    stock_locator    TEXT,              -- Product's designated pickface
    product_category TEXT
);

-- Performance indexes
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

-- Full-text search on product name
CREATE INDEX IF NOT EXISTS idx_movements_product_gin ON cin7_mirror.stock_movements USING gin (product_name gin_trgm_ops);


-- ============================================================
-- 2. PREVIOUS SNAPSHOT — For delta detection between syncs
-- ============================================================
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


-- ============================================================
-- 3. MOVEMENT ALERTS — Triggered notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.movement_alerts (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,                          -- null = unread

    -- Alert info
    alert_type      TEXT NOT NULL,
    -- Types:
    --   'non_pickbay_pick'       — Sales pick from non-pickface location
    --   'external_transfer'      — Transfer to external location (Project WH, etc.)
    --   'large_quantity'         — Unusually large movement
    --   'stock_negative'         — Stock went negative
    --   'unexpected_location'    — Movement from/to unexpected location
    --   'high_value_movement'    — High-value product moved
    --   'after_hours'            — Movement outside business hours
    --   'low_stock_after_move'   — Stock fell below threshold after movement

    severity         TEXT NOT NULL DEFAULT 'info',
    -- Levels: 'info', 'warning', 'critical'

    title            TEXT NOT NULL,
    description      TEXT,

    -- Related movement
    movement_id      BIGINT REFERENCES cin7_mirror.stock_movements(id),

    -- Product context
    sku              TEXT,
    product_name     TEXT,

    -- Movement details (denormalized for fast display)
    reference_number TEXT,
    movement_type    TEXT,
    from_location    TEXT,
    to_location      TEXT,
    quantity         DECIMAL(12,4),
    member_email     TEXT,
    sales_rep        TEXT,

    -- Metadata
    metadata         JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON cin7_mirror.movement_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread ON cin7_mirror.movement_alerts (acknowledged_at) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_type ON cin7_mirror.movement_alerts (alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON cin7_mirror.movement_alerts (severity);
CREATE INDEX IF NOT EXISTS idx_alerts_sku ON cin7_mirror.movement_alerts (sku) WHERE sku IS NOT NULL;


-- ============================================================
-- 4. ALERT RULES — Configurable thresholds
-- ============================================================
CREATE TABLE IF NOT EXISTS cin7_mirror.alert_rules (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    is_active       BOOLEAN DEFAULT true,
    rule_type       TEXT NOT NULL,      -- matches alert_type values
    severity        TEXT NOT NULL DEFAULT 'warning',
    description     TEXT,
    config          JSONB DEFAULT '{}',
    -- Config examples:
    --   { "locations": ["Project Warehouse", "Sydney Warehouse"] }  — trigger on transfer TO these
    --   { "min_quantity": 100 }  — trigger when qty > 100
    --   { "excluded_bins": ["MA-GA-*"] }  — don't alert for these bins
    --   { "business_hours": { "start": "07:00", "end": "18:00" } }

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);


-- ============================================================
-- 5. HELPER VIEWS
-- ============================================================

-- Recent movements summary per product (last 24h)
CREATE OR REPLACE VIEW cin7_mirror.v_recent_movements AS
SELECT
    sku,
    product_name,
    movement_type,
    COUNT(*)                                AS movement_count,
    SUM(quantity)                            AS net_quantity,
    SUM(ABS(quantity))                       AS total_volume,
    MIN(detected_at)                        AS first_movement,
    MAX(detected_at)                        AS last_movement,
    array_agg(DISTINCT reference_number) FILTER (WHERE reference_number IS NOT NULL) AS references
FROM cin7_mirror.stock_movements
WHERE detected_at > now() - INTERVAL '24 hours'
GROUP BY sku, product_name, movement_type
ORDER BY MAX(detected_at) DESC;

-- Unacknowledged alerts count by type and severity
CREATE OR REPLACE VIEW cin7_mirror.v_alert_summary AS
SELECT
    alert_type,
    severity,
    COUNT(*)                                AS alert_count,
    MIN(created_at)                         AS oldest_alert,
    MAX(created_at)                         AS newest_alert
FROM cin7_mirror.movement_alerts
WHERE acknowledged_at IS NULL
GROUP BY alert_type, severity
ORDER BY
    CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
    alert_count DESC;

-- Product movement summary (all time, for product detail view)
CREATE OR REPLACE VIEW cin7_mirror.v_product_movement_summary AS
SELECT
    sku,
    product_name,
    COUNT(*)                                           AS total_movements,
    COUNT(*) FILTER (WHERE movement_type = 'sales_pick' OR movement_type = 'sales_ship')  AS sales_movements,
    COUNT(*) FILTER (WHERE movement_type = 'stock_transfer')  AS transfer_movements,
    COUNT(*) FILTER (WHERE movement_type = 'purchase_receive') AS receive_movements,
    COUNT(*) FILTER (WHERE movement_type = 'stock_adjustment') AS adjustment_movements,
    COUNT(*) FILTER (WHERE is_anomaly = true)          AS anomaly_count,
    SUM(quantity) FILTER (WHERE quantity > 0)           AS total_in,
    SUM(ABS(quantity)) FILTER (WHERE quantity < 0)      AS total_out,
    MIN(detected_at)                                   AS first_seen,
    MAX(detected_at)                                   AS last_seen
FROM cin7_mirror.stock_movements
GROUP BY sku, product_name;


-- ============================================================
-- 6. DEFAULT ALERT RULES
-- ============================================================
INSERT INTO cin7_mirror.alert_rules (rule_type, severity, description, config) VALUES
    ('non_pickbay_pick', 'warning', 'Sales order picked from non-pickface bin', '{"enabled": true}'),
    ('external_transfer', 'warning', 'Stock transferred to external location', '{"locations": ["Project Warehouse", "Sydney Warehouse", "Melbourne Warehouse", "Brisbane Warehouse", "Cairns Warehouse", "Coffs Harbour Warehouse", "Hobart Warehouse", "Sunshine Coast Warehouse"]}'),
    ('large_quantity', 'info', 'Unusually large quantity movement', '{"min_quantity": 500}'),
    ('stock_negative', 'critical', 'Stock went negative in any location', '{"enabled": true}'),
    ('low_stock_after_move', 'warning', 'Stock fell below min threshold after movement', '{"enabled": true}')
ON CONFLICT DO NOTHING;


-- ============================================================
-- 7. RLS & GRANTS
-- ============================================================
ALTER TABLE cin7_mirror.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.stock_snapshot_prev ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.movement_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.alert_rules ENABLE ROW LEVEL SECURITY;

-- Read policies
CREATE POLICY "movements_read" ON cin7_mirror.stock_movements FOR SELECT USING (true);
CREATE POLICY "prev_read" ON cin7_mirror.stock_snapshot_prev FOR SELECT USING (true);
CREATE POLICY "alerts_read" ON cin7_mirror.movement_alerts FOR SELECT USING (true);
CREATE POLICY "rules_read" ON cin7_mirror.alert_rules FOR SELECT USING (true);

-- Write policies (all operations for service_role, acknowledge for anon/authenticated)
CREATE POLICY "movements_write" ON cin7_mirror.stock_movements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "prev_write" ON cin7_mirror.stock_snapshot_prev FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "alerts_write" ON cin7_mirror.movement_alerts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "rules_write" ON cin7_mirror.alert_rules FOR ALL USING (true) WITH CHECK (true);

-- Grants
GRANT SELECT ON cin7_mirror.stock_movements TO anon, authenticated;
GRANT SELECT ON cin7_mirror.stock_snapshot_prev TO anon, authenticated;
GRANT SELECT, UPDATE ON cin7_mirror.movement_alerts TO anon, authenticated;
GRANT SELECT ON cin7_mirror.alert_rules TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_recent_movements TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_alert_summary TO anon, authenticated;
GRANT SELECT ON cin7_mirror.v_product_movement_summary TO anon, authenticated;
