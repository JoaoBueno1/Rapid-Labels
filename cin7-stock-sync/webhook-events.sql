-- ═══════════════════════════════════════════════════════════════════
-- WEBHOOK EVENTS TABLE — cin7_mirror schema
-- Purpose: Capture incoming webhooks from Cin7 Core for near-live
--          stock updates. Each row = one webhook event received.
--
-- Future flow:
--   1. Cin7 fires webhook → POST /api/cin7/webhook
--   2. server.js validates & inserts into cin7_mirror.webhook_events
--   3. server.js (or a cron) processes pending events:
--      a. Fetches latest data from Cin7 API for the affected SKU(s)
--      b. Upserts into cin7_mirror.stock_snapshot / products
--      c. Marks event as processed
--   4. Restock V2 page auto-refreshes or uses Supabase Realtime
--      to show the update within seconds.
--
-- Cin7 Core webhook topics that can trigger stock updates:
--   • sale/order/create
--   • sale/order/update
--   • purchase/order/update
--   • stock/adjustment/create
--   • stock/transfer/create
-- ═══════════════════════════════════════════════════════════════════

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- Webhook events table
CREATE TABLE IF NOT EXISTS cin7_mirror.webhook_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,                          -- null = pending
  topic         TEXT NOT NULL,                         -- e.g. 'sale/order/update'
  event_id      TEXT,                                  -- Cin7 event ID (for dedup)
  payload       JSONB NOT NULL DEFAULT '{}',           -- raw webhook body
  status        TEXT NOT NULL DEFAULT 'pending'        -- pending | processing | processed | failed
                CHECK (status IN ('pending','processing','processed','failed')),
  error_message TEXT,                                  -- error details if failed
  affected_skus TEXT[],                                -- extracted SKUs for targeted re-sync
  metadata      JSONB DEFAULT '{}'                     -- extra: ip, headers, processing time, etc.
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_webhook_events_status
  ON cin7_mirror.webhook_events (status)
  WHERE status IN ('pending','processing');

CREATE INDEX IF NOT EXISTS idx_webhook_events_received
  ON cin7_mirror.webhook_events (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_events_topic
  ON cin7_mirror.webhook_events (topic);

CREATE INDEX IF NOT EXISTS idx_webhook_events_event_id
  ON cin7_mirror.webhook_events (event_id)
  WHERE event_id IS NOT NULL;

-- GIN index on affected_skus for array containment queries
CREATE INDEX IF NOT EXISTS idx_webhook_events_skus
  ON cin7_mirror.webhook_events USING GIN (affected_skus);

-- ═══════════════════════════════════════════════════════════════════
-- WEBHOOK PROCESSING LOG — track batch processing runs
-- ═══════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════
-- RLS & GRANTS
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE cin7_mirror.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.webhook_processing_log ENABLE ROW LEVEL SECURITY;

-- Allow read from authenticated users (for monitoring dashboard)
CREATE POLICY "webhook_events_read" ON cin7_mirror.webhook_events
  FOR SELECT USING (true);

CREATE POLICY "webhook_processing_log_read" ON cin7_mirror.webhook_processing_log
  FOR SELECT USING (true);

-- Service role has full access (handled by Supabase automatically)

-- Grant read access to anon and authenticated
GRANT USAGE ON SCHEMA cin7_mirror TO anon, authenticated;
GRANT SELECT ON cin7_mirror.webhook_events TO anon, authenticated;
GRANT SELECT ON cin7_mirror.webhook_processing_log TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- HELPER VIEW: Pending events summary
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW cin7_mirror.v_pending_webhooks AS
SELECT
  topic,
  COUNT(*)                                    AS pending_count,
  MIN(received_at)                            AS oldest_pending,
  MAX(received_at)                            AS newest_pending,
  array_agg(DISTINCT unnested_sku) FILTER (WHERE unnested_sku IS NOT NULL) AS all_affected_skus
FROM cin7_mirror.webhook_events,
     LATERAL unnest(COALESCE(affected_skus, ARRAY[]::text[])) AS unnested_sku
WHERE status = 'pending'
GROUP BY topic
ORDER BY oldest_pending;

GRANT SELECT ON cin7_mirror.v_pending_webhooks TO anon, authenticated;
