-- ═══════════════════════════════════════════════════════════════════
-- ops — one catalogue of every sync, and one log of every run.
-- Feeds the Sync Monitor page (Cin7 → our system, and our system → Excel).
-- Idempotent: safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS ops;

-- ───────────────────────────────────────────────────────────────────
-- 1) REGISTRY — what syncs exist, on what schedule, feeding what.
--
-- Declarative on purpose. cin7_mirror.sync_runs only ever knew 3 sync types
-- while 15 workflows exist, so a page built on run logs alone would show 3 of
-- 15 and look complete. Here health comes from the FRESHNESS OF THE TARGET
-- TABLE, so every sync is covered from day one with no workflow changes.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.sync_registry (
  slug            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,          -- 'cin7_to_system' | 'system_to_excel'
  title           TEXT NOT NULL,
  what_it_does    TEXT NOT NULL,          -- plain English, shown on the card
  source          TEXT,                   -- 'Cin7 /ref/productavailability'
  target          TEXT,                   -- 'cin7_mirror.stock_snapshot'
  feeds           TEXT[]  DEFAULT '{}',   -- pages/features that depend on it
  cron_utc        TEXT,                   -- drives "next run" (parsed in the UI)
  sla_minutes     INT,                    -- older than this = late
  freshness_table TEXT,                   -- schema-qualified; NULL = run-log only
  freshness_col   TEXT,
  workflow_file   TEXT,                   -- .github/workflows/<file>
  enabled         BOOLEAN DEFAULT TRUE,
  sort_order      INT     DEFAULT 100,
  runbook_url     TEXT,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ───────────────────────────────────────────────────────────────────
-- 2) RUN LOG — every execution of any sync, Cin7 or Excel.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.sync_runs (
  run_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running',  -- running|success|failed|blocked|skipped
  rows_read    INT,
  rows_written INT,
  duration_ms  INT,
  trigger      TEXT,                              -- cron|manual|webhook
  run_url      TEXT,                              -- GitHub Actions run
  error        TEXT,
  stats        JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_ops_runs_slug ON ops.sync_runs (slug, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_runs_started ON ops.sync_runs (started_at DESC);

-- ───────────────────────────────────────────────────────────────────
-- 3) HEALTH — one call powers the whole page.
--
-- Reads each registry row's freshness_table/col through dynamic SQL. Wrapped in
-- an exception handler on purpose: a table that gets renamed later degrades that
-- one card to 'unknown' instead of breaking the page for everything else.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.sync_health()
RETURNS TABLE (
  slug TEXT, kind TEXT, title TEXT, what_it_does TEXT, source TEXT, target TEXT,
  feeds TEXT[], cron_utc TEXT, sla_minutes INT, workflow_file TEXT,
  enabled BOOLEAN, sort_order INT, runbook_url TEXT,
  data_at TIMESTAMPTZ, age_minutes NUMERIC, status TEXT,
  last_run_at TIMESTAMPTZ, last_run_status TEXT, last_run_ms INT,
  last_run_url TEXT, last_error TEXT, rows_written INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ops, public, cin7_mirror
AS $$
DECLARE
  r         RECORD;
  v_at      TIMESTAMPTZ;
  v_age     NUMERIC;
  v_status  TEXT;
  v_run     RECORD;
BEGIN
  FOR r IN SELECT * FROM ops.sync_registry ORDER BY sort_order, slug LOOP
    v_at := NULL;
    IF r.freshness_table IS NOT NULL AND r.freshness_col IS NOT NULL THEN
      BEGIN
        EXECUTE format('SELECT max(%I) FROM %s', r.freshness_col, r.freshness_table)
          INTO v_at;
      EXCEPTION WHEN OTHERS THEN
        v_at := NULL;                       -- table/column gone → 'unknown'
      END;
    END IF;

    SELECT * INTO v_run FROM ops.sync_runs sr
     WHERE sr.slug = r.slug ORDER BY sr.started_at DESC LIMIT 1;

    -- A run log, when present, is the better signal than table freshness:
    -- a job can succeed and legitimately write nothing.
    IF v_at IS NULL AND v_run.started_at IS NOT NULL THEN
      v_at := COALESCE(v_run.ended_at, v_run.started_at);
    END IF;

    v_age := CASE WHEN v_at IS NULL THEN NULL
                  ELSE EXTRACT(EPOCH FROM (now() - v_at)) / 60.0 END;

    v_status := CASE
      WHEN NOT r.enabled                                   THEN 'disabled'
      WHEN v_run.status IN ('failed', 'blocked')           THEN v_run.status
      WHEN v_at IS NULL                                    THEN 'unknown'
      WHEN r.sla_minutes IS NULL                           THEN 'healthy'
      WHEN v_age <= r.sla_minutes                          THEN 'healthy'
      WHEN v_age <= r.sla_minutes * 2                      THEN 'late'
      ELSE 'stale' END;

    slug := r.slug; kind := r.kind; title := r.title; what_it_does := r.what_it_does;
    source := r.source; target := r.target; feeds := r.feeds; cron_utc := r.cron_utc;
    sla_minutes := r.sla_minutes; workflow_file := r.workflow_file;
    enabled := r.enabled; sort_order := r.sort_order; runbook_url := r.runbook_url;
    data_at := v_at; age_minutes := v_age; status := v_status;
    last_run_at := v_run.started_at; last_run_status := v_run.status;
    last_run_ms := v_run.duration_ms; last_run_url := v_run.run_url;
    last_error := v_run.error; rows_written := v_run.rows_written;
    RETURN NEXT;
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- 4) SEED — the 15 Cin7 workflows. Excel rows are upserted by the engine
--    (`python -m engine register`) so git stays the source of truth for those.
-- ───────────────────────────────────────────────────────────────────
INSERT INTO ops.sync_registry
  (slug, kind, title, what_it_does, source, target, feeds, cron_utc, sla_minutes,
   freshness_table, freshness_col, workflow_file, sort_order)
VALUES
 ('cin7-stock','cin7_to_system','Cin7 Stock Levels',
  'Full bin-level stock snapshot — the only source of stock levels.',
  'Cin7 /ref/productavailability','cin7_mirror.stock_snapshot',
  ARRAY['Replenishment','Re-Stock V2','Cyclic Count','Excel: stock-level'],
  '0 * * * *',180,'cin7_mirror.stock_snapshot','synced_at','cin7-sync.yml',10),

 ('cin7-availability','cin7_to_system','Cin7 Availability',
  'SKU x location rollup behind the chase list "Have stock" and backorder detection.',
  'Cin7 /ref/productavailability','cin7_mirror.stock_availability',
  ARRAY['Open Orders chase'],'30 */4 * * *',480,
  'cin7_mirror.stock_availability','synced_at','cin7-availability-sync.yml',20),

 ('cin7-daily','cin7_to_system','Cin7 Daily Maintenance',
  'Product and location master data — names, weights and dimensions for freight.',
  'Cin7 /product, /ref/location','cin7_mirror.products + locations',
  ARRAY['Labels','Search','Replenishment','Excel: stock-level'],
  '15 16 * * *',2880,'cin7_mirror.products','synced_at','cin7-daily.yml',30),

 ('cin7-sales-sync','cin7_to_system','Cin7 Sales Headers',
  'New and modified order headers — Cin7 has no order-created webhook.',
  'Cin7 /saleList?UpdatedSince','cin7_mirror.sales_orders',
  ARRAY['Open Orders','Excel: monthly-sales'],'10 */2 * * *',240,
  'cin7_mirror.sales_orders','header_synced_at','cin7-sales-sync.yml',40),

 ('cin7-sales-detail-month','cin7_to_system','Cin7 Sales Detail (month)',
  'Every order in the month, any status, refetched when Cin7 changes it — the feed for the monthly sales Excel.',
  'Cin7 /sale?ID','cin7_mirror.sale_lines + sales_orders',
  ARRAY['Excel: monthly-sales'],'0 19 * * 0-4',1560,
  'cin7_mirror.sale_lines','synced_at','cin7-sales-detail-month.yml',45),

 ('cin7-open-detail','cin7_to_system','Cin7 Open Detail',
  'Rep, location and lines for open unshipped orders, for the chase view.',
  'Cin7 /sale?ID','cin7_mirror.sale_lines',
  ARRAY['Open Orders chase'],'5 */6 * * *',900,
  'cin7_mirror.sales_orders','detail_synced_at','cin7-open-detail-sync.yml',50),

 ('cin7-sales-reconcile','cin7_to_system','Cin7 Sales Reconcile',
  'Backstop that un-sticks phantom-open orders; status is webhook-real-time.',
  'Cin7 /saleList','cin7_mirror.sales_orders.status',
  ARRAY['Open Orders'],'40 15 * * *',2880,NULL,NULL,'cin7-sales-reconcile.yml',60),

 ('cin7-transfers-sync','cin7_to_system','Cin7 Transfers',
  'Stock transfer headers — Cin7 has no transfer webhook.',
  'Cin7 /stockTransferList','cin7_mirror.stock_transfers',
  ARRAY['Branch Transfers'],'45 */2 * * *',240,
  'cin7_mirror.stock_transfers','synced_at','cin7-transfers-sync.yml',70),

 ('cin7-transfers-reconcile','cin7_to_system','Cin7 Transfers Reconcile',
  'Closes phantom transfers left open in the mirror.',
  'Cin7 /stockTransferList','cin7_mirror.stock_transfers',
  ARRAY['Branch Transfers'],'20 3 * * *',2880,NULL,NULL,'cin7-transfers-reconcile.yml',80),

 ('cin7-movements','cin7_to_system','Cin7 Movements',
  'Transfer, adjustment, purchase and assembly movements for the audit ledger.',
  'Cin7 task endpoints','cin7_mirror.stock_movements',
  ARRAY['Movements audit','Pick Anomalies'],'50 */6 * * *',900,
  'cin7_mirror.stock_movements','detected_at','cin7-movements-sync.yml',90),

 ('cin7-webhook-drain','cin7_to_system','Cin7 Webhook Drain',
  'Backstop that processes any webhook event the real-time path dropped.',
  'cin7_mirror.webhook_events','processed events',
  ARRAY['Pick Anomalies','Movements'],'25 */2 * * *',240,
  'cin7_mirror.webhook_events','processed_at','cin7-webhook-drain.yml',100),

 ('cin7-webhook-watchdog','cin7_to_system','Cin7 Webhook Watchdog',
  'Reactivates webhooks Cin7 auto-disabled — guards the whole real-time path.',
  'Cin7 /webhooks','cin7_mirror.webhook_health_log',
  ARRAY['Everything real-time'],'20 6,18 * * *',1440,
  'cin7_mirror.webhook_health_log','checked_at','cin7-webhook-watchdog.yml',110),

 ('order-pipeline-sync','cin7_to_system','Order Pipeline',
  'Warehouse pick/pack/ship board.',
  'Cin7 /saleList','cin7_mirror.order_pipeline',
  ARRAY['Warehouse dashboard'],'35 * * * *',180,
  'cin7_mirror.order_pipeline','synced_at','order-pipeline-sync.yml',120),

 ('pick-anomalies-sync','cin7_to_system','Pick Anomalies',
  'Batch backstop; ship-time anomaly analysis is webhook-real-time.',
  'Cin7 /sale?ID','public.pick_anomaly_orders',
  ARRAY['Pick Anomalies'],'30 3,15 * * *',900,
  'public.pick_anomaly_orders','analyzed_at','pick-anomalies-sync.yml',130),

 ('wms-reconcile','cin7_to_system','WMS Reconcile',
  'Reconciles WMS movements against Cin7. Cron intentionally disabled until WMS is live.',
  'WMS outbox','wms.movements',ARRAY['WMS'],NULL,NULL,NULL,NULL,'wms-reconcile.yml',140)
ON CONFLICT (slug) DO UPDATE SET
  kind=EXCLUDED.kind, title=EXCLUDED.title, what_it_does=EXCLUDED.what_it_does,
  source=EXCLUDED.source, target=EXCLUDED.target, feeds=EXCLUDED.feeds,
  cron_utc=EXCLUDED.cron_utc, sla_minutes=EXCLUDED.sla_minutes,
  freshness_table=EXCLUDED.freshness_table, freshness_col=EXCLUDED.freshness_col,
  workflow_file=EXCLUDED.workflow_file, sort_order=EXCLUDED.sort_order,
  updated_at=now();

UPDATE ops.sync_registry SET enabled = FALSE WHERE slug = 'wms-reconcile';

-- ───────────────────────────────────────────────────────────────────
-- 5) RLS + GRANTS — the page reads with the anon key; jobs write with service.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE ops.sync_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.sync_runs     ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['sync_registry','sync_runs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON ops.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON ops.%I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON ops.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON ops.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA ops TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA ops TO anon, authenticated;
GRANT ALL    ON ALL TABLES IN SCHEMA ops TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO service_role;
GRANT EXECUTE ON FUNCTION ops.sync_health() TO anon, authenticated, service_role;

SELECT slug, kind, cron_utc, sla_minutes FROM ops.sync_registry ORDER BY sort_order;
