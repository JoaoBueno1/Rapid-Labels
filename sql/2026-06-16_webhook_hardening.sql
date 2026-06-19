-- ═══════════════════════════════════════════════════════════════════
-- CIN7 REAL-TIME MONITORING — full schema (Rapid-Labels)
-- Date: 2026-06-16
--
-- Paste straight into the Supabase SQL editor and run. IDEMPOTENT &
-- ADDITIVE: every statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- guarded policies, so it is safe to run repeatedly and NEVER drops or
-- rewrites existing data. Sets up everything the webhook pipeline may
-- need (queue, transaction ledger, alerts, watchdog, dashboard views),
-- even parts we won't use on day one.
-- ═══════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- ───────────────────────────────────────────────────────────────────
-- 1) WEBHOOK EVENTS — idempotent queue (one row per event received)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  topic         TEXT NOT NULL DEFAULT 'unknown',
  event_id      TEXT,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','processed','failed')),
  error_message TEXT,
  affected_skus TEXT[],
  metadata      JSONB DEFAULT '{}'
);

-- hardening columns (added only if missing — e.g. table already existed)
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS event_type      TEXT;
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS order_number    TEXT;
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS sale_id         TEXT;
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS source          TEXT NOT NULL DEFAULT 'webhook';
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS attempts        INT NOT NULL DEFAULT 0;
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE cin7_mirror.webhook_events ADD COLUMN IF NOT EXISTS dedup_key       TEXT;

-- idempotency: identical Cin7 retries share one dedup_key (md5 of payload)
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_events_dedup
  ON cin7_mirror.webhook_events (dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON cin7_mirror.webhook_events (status) WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_webhook_events_queue
  ON cin7_mirror.webhook_events (next_attempt_at) WHERE status IN ('pending','failed');
CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON cin7_mirror.webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_event_type
  ON cin7_mirror.webhook_events (event_type);
CREATE INDEX IF NOT EXISTS idx_webhook_events_order
  ON cin7_mirror.webhook_events (order_number);
CREATE INDEX IF NOT EXISTS idx_webhook_events_skus
  ON cin7_mirror.webhook_events USING GIN (affected_skus);

-- ───────────────────────────────────────────────────────────────────
-- 2) PROCESSING LOG + WATCHDOG HEALTH LOG
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_processing_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  events_found     INT DEFAULT 0,
  events_processed INT DEFAULT 0,
  events_failed    INT DEFAULT 0,
  skus_updated     INT DEFAULT 0,
  api_calls_made   INT DEFAULT 0,
  duration_ms      INT,
  errors           JSONB DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_health_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  webhook_type TEXT,
  webhook_id   TEXT,
  was_active   BOOLEAN,
  reactivated  BOOLEAN DEFAULT false,
  notes        TEXT
);

-- ───────────────────────────────────────────────────────────────────
-- 3) STOCK MOVEMENTS — the transaction ledger (sale ship / transfer /
--    adjustment / purchase receive). Fields match movement-processor.js.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_movements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sku              TEXT,
  product_name     TEXT,
  movement_type    TEXT,          -- sales_ship | sales_pick | stock_transfer | bin_transfer | stock_adjustment | purchase_receive
  reference_number TEXT,
  reference_type   TEXT,          -- SalesOrder | StockTransfer | StockAdjustment | PurchaseOrder
  cin7_task_id     TEXT,
  sales_rep        TEXT,
  member_email     TEXT,
  customer_name    TEXT,
  from_location    TEXT,
  from_bin         TEXT,
  to_location      TEXT,
  to_bin           TEXT,
  quantity         NUMERIC,       -- negative = stock out, positive = stock in
  quantity_after   NUMERIC,       -- on-hand after movement (when known)
  is_internal      BOOLEAN DEFAULT false,
  is_external      BOOLEAN DEFAULT false,
  is_anomaly       BOOLEAN DEFAULT false,
  stock_locator    TEXT,
  product_category TEXT,
  webhook_event_id BIGINT,
  source           TEXT DEFAULT 'webhook',
  raw_data         JSONB DEFAULT '{}'
);
-- add any missing columns if the table predates this script
ALTER TABLE cin7_mirror.stock_movements ADD COLUMN IF NOT EXISTS quantity_after   NUMERIC;
ALTER TABLE cin7_mirror.stock_movements ADD COLUMN IF NOT EXISTS webhook_event_id BIGINT;
ALTER TABLE cin7_mirror.stock_movements ADD COLUMN IF NOT EXISTS source           TEXT DEFAULT 'webhook';

CREATE INDEX IF NOT EXISTS idx_stock_movements_detected ON cin7_mirror.stock_movements (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_sku      ON cin7_mirror.stock_movements (sku);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref      ON cin7_mirror.stock_movements (reference_number);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type     ON cin7_mirror.stock_movements (movement_type);
CREATE INDEX IF NOT EXISTS idx_stock_movements_anomaly  ON cin7_mirror.stock_movements (is_anomaly) WHERE is_anomaly = true;

-- ───────────────────────────────────────────────────────────────────
-- 4) ALERT RULES + ALERTS
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.alert_rules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_type   TEXT NOT NULL,      -- non_pickbay_pick | external_transfer | large_quantity | stock_negative
  severity    TEXT DEFAULT 'warning',
  description TEXT,
  config      JSONB DEFAULT '{}',
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cin7_mirror.movement_alerts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_type       TEXT,
  severity         TEXT,
  title            TEXT,
  description      TEXT,
  movement_id      BIGINT,
  sku              TEXT,
  product_name     TEXT,
  reference_number TEXT,
  movement_type    TEXT,
  from_location    TEXT,
  to_location      TEXT,
  quantity         NUMERIC,
  member_email     TEXT,
  sales_rep        TEXT,
  acknowledged_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_movement_alerts_created ON cin7_mirror.movement_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_movement_alerts_unack
  ON cin7_mirror.movement_alerts (created_at DESC) WHERE acknowledged_at IS NULL;

-- default alert rules — only seeded if the table is currently empty
-- (matches the existing alert_rules schema: rule_type/severity/description/config)
INSERT INTO cin7_mirror.alert_rules (rule_type, severity, description, config, is_active)
SELECT v.rule_type, v.severity, v.description, v.config, v.is_active
FROM (VALUES
  ('non_pickbay_pick', 'warning',  'Pick from non-pickface',  '{}'::jsonb,                    true),
  ('large_quantity',   'warning',  'Large quantity movement', '{"min_quantity":500}'::jsonb,  true),
  ('stock_negative',   'critical', 'Negative stock',          '{}'::jsonb,                    true)
) AS v(rule_type, severity, description, config, is_active)
WHERE NOT EXISTS (SELECT 1 FROM cin7_mirror.alert_rules);

-- ───────────────────────────────────────────────────────────────────
-- 5) DASHBOARD VIEWS (live transaction feed + recent movements)
-- ───────────────────────────────────────────────────────────────────
-- v_recent_movements already exists (from movement-schema.sql) — left untouched.
-- Use DROP+CREATE (not CREATE OR REPLACE) so re-running can't hit column-rename limits.
DROP VIEW IF EXISTS cin7_mirror.v_transaction_feed;
CREATE VIEW cin7_mirror.v_transaction_feed AS
SELECT
  id, received_at, processed_at, event_type, order_number, sale_id,
  status, attempts, source,
  CASE WHEN processed_at IS NOT NULL
       THEN EXTRACT(EPOCH FROM (processed_at - received_at)) END AS processing_seconds
FROM cin7_mirror.webhook_events
ORDER BY received_at DESC;

-- ───────────────────────────────────────────────────────────────────
-- 6) RLS + GRANTS (read access for the dashboard; service role bypasses)
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE cin7_mirror.webhook_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.webhook_processing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.webhook_health_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.stock_movements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.alert_rules            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.movement_alerts        ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'webhook_events','webhook_processing_log','webhook_health_log',
    'stock_movements','alert_rules','movement_alerts'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON cin7_mirror.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON cin7_mirror.%I FOR SELECT USING (true)', t, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA cin7_mirror TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA cin7_mirror TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 7) VERIFICATION — should return the new objects with no errors
-- ───────────────────────────────────────────────────────────────────
SELECT 'tables' AS kind, table_name AS name
FROM information_schema.tables
WHERE table_schema = 'cin7_mirror'
  AND table_name IN ('webhook_events','webhook_processing_log','webhook_health_log',
                     'stock_movements','alert_rules','movement_alerts')
UNION ALL
SELECT 'webhook_events new col', column_name
FROM information_schema.columns
WHERE table_schema = 'cin7_mirror' AND table_name = 'webhook_events'
  AND column_name IN ('event_type','order_number','sale_id','source','attempts','next_attempt_at','dedup_key')
ORDER BY 1, 2;
