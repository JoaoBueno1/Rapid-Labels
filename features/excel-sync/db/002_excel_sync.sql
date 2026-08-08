-- ═══════════════════════════════════════════════════════════════════
-- excel_sync — datasets materialised once, consumed by many workbooks.
--
-- The point of the split: several company spreadsheets want the same numbers
-- (stock availability, monthly sales) in different tabs, column subsets and
-- cadences. Rebuilding per workbook would be wasteful AND inconsistent — two
-- tabs refreshed minutes apart would disagree. So the engine builds a dataset
-- ONCE, stores it here, and every binding reads the same snapshot.
--
-- Adding a new spreadsheet is then a binding TOML in git + a registry row.
-- No new query, no new sync, no extra Cin7 call.
--
-- Everything the engine and the page touch is a function in `public`, so this
-- schema never needs adding to Settings → API → Exposed schemas. That removes a
-- manual UI step from the deploy and keeps the API surface to a few named
-- functions instead of raw table access.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS excel_sync;

-- ───────────────────────────────────────────────────────────────────
-- 1) DATASETS — one row per build. The checksum lets the monitor say "ran, but
--    nothing changed", which is the difference between healthy and stuck.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.datasets (
  slug        TEXT PRIMARY KEY,          -- 'stock-level' | 'monthly-sales'
  title       TEXT NOT NULL,
  grain       TEXT NOT NULL,             -- 'sku x location'
  period      TEXT,                      -- '2026-08-01..2026-08-31' or NULL
  built_at    TIMESTAMPTZ DEFAULT now(),
  row_count   INT,
  group_count INT,
  checksum    TEXT,
  columns     JSONB DEFAULT '[]'::jsonb, -- ordered [{header, field}] — the contract
  meta        JSONB DEFAULT '{}'::jsonb, -- coverage, source rows, call counts
  source_ok   BOOLEAN DEFAULT TRUE
);

-- ───────────────────────────────────────────────────────────────────
-- 2) DATASET ROWS — long format. Metrics in JSONB so both datasets share one
--    table and adding a metric never needs a migration.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.dataset_rows (
  dataset  TEXT NOT NULL REFERENCES excel_sync.datasets(slug) ON DELETE CASCADE,
  sku      TEXT NOT NULL,
  location TEXT NOT NULL,
  metrics  JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (dataset, sku, location)
);
CREATE INDEX IF NOT EXISTS idx_xs_rows_dataset  ON excel_sync.dataset_rows (dataset);
CREATE INDEX IF NOT EXISTS idx_xs_rows_location ON excel_sync.dataset_rows (dataset, location);

-- ───────────────────────────────────────────────────────────────────
-- 3) REPLACE ONE DATASET ATOMICALLY — a workbook pulling mid-build must never
--    see half a table, and several may pull at once.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION excel_sync.replace_dataset(
  p_slug TEXT, p_title TEXT, p_grain TEXT, p_period TEXT,
  p_columns JSONB, p_meta JSONB, p_checksum TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = excel_sync, public
AS $$
DECLARE n INT;
BEGIN
  INSERT INTO excel_sync.datasets
    (slug,title,grain,period,built_at,columns,meta,checksum,row_count,group_count,source_ok)
  VALUES (p_slug,p_title,p_grain,p_period,now(),p_columns,p_meta,p_checksum,
          jsonb_array_length(p_rows),
          (SELECT count(DISTINCT e->>'location') FROM jsonb_array_elements(p_rows) e), TRUE)
  ON CONFLICT (slug) DO UPDATE SET
    title=EXCLUDED.title, grain=EXCLUDED.grain, period=EXCLUDED.period,
    built_at=now(), columns=EXCLUDED.columns, meta=EXCLUDED.meta,
    checksum=EXCLUDED.checksum, row_count=EXCLUDED.row_count,
    group_count=EXCLUDED.group_count, source_ok=TRUE;

  DELETE FROM excel_sync.dataset_rows WHERE dataset = p_slug;
  INSERT INTO excel_sync.dataset_rows (dataset, sku, location, metrics)
  SELECT p_slug, e->>'sku', e->>'location', COALESCE(e->'metrics','{}'::jsonb)
    FROM jsonb_array_elements(p_rows) e;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- 4) PUBLIC API — the only entry points. `public` is already in the Data API,
--    so ops and excel_sync stay private.
-- ───────────────────────────────────────────────────────────────────

-- write: publish a built dataset (engine, service_role only)
CREATE OR REPLACE FUNCTION public.excel_publish_dataset(
  p_slug TEXT, p_title TEXT, p_grain TEXT, p_period TEXT,
  p_columns JSONB, p_meta JSONB, p_checksum TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE sql SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT excel_sync.replace_dataset(p_slug,p_title,p_grain,p_period,
                                        p_columns,p_meta,p_checksum,p_rows); $$;

-- write: open a run row, return its id
CREATE OR REPLACE FUNCTION public.ops_run_start(
  p_slug TEXT, p_trigger TEXT DEFAULT NULL, p_run_url TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE sql SECURITY DEFINER SET search_path = ops, public
AS $$ INSERT INTO ops.sync_runs (slug, status, trigger, run_url)
      VALUES (p_slug, 'running', p_trigger, p_run_url) RETURNING run_id; $$;

-- write: close it. Always called, so a job that dies cannot leave a row stuck
-- on 'running' for the monitor to show as in-progress forever.
CREATE OR REPLACE FUNCTION public.ops_run_finish(
  p_run_id BIGINT, p_status TEXT, p_rows_written INT DEFAULT NULL,
  p_duration_ms INT DEFAULT NULL, p_error TEXT DEFAULT NULL,
  p_stats JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = ops, public
AS $$ UPDATE ops.sync_runs
         SET status = p_status, ended_at = now(), rows_written = p_rows_written,
             duration_ms = p_duration_ms, error = p_error, stats = p_stats
       WHERE run_id = p_run_id; $$;

-- write: mirror the binding TOMLs into the registry. Git stays the source of
-- truth; this table is just what the page reads.
CREATE OR REPLACE FUNCTION public.ops_register_bindings(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE n INT;
BEGIN
  INSERT INTO ops.sync_registry
    (slug,kind,title,what_it_does,source,target,feeds,cron_utc,sla_minutes,
     freshness_table,freshness_col,workflow_file,enabled,sort_order,updated_at)
  SELECT e->>'slug', e->>'kind', e->>'title', COALESCE(e->>'what_it_does',''),
         e->>'source', e->>'target',
         COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(e->'feeds') x), '{}'),
         e->>'cron_utc', NULLIF(e->>'sla_minutes','')::INT,
         e->>'freshness_table', e->>'freshness_col', e->>'workflow_file',
         COALESCE((e->>'enabled')::BOOLEAN, FALSE),
         COALESCE(NULLIF(e->>'sort_order','')::INT, 200), now()
    FROM jsonb_array_elements(p_rows) e
  ON CONFLICT (slug) DO UPDATE SET
    kind=EXCLUDED.kind, title=EXCLUDED.title, what_it_does=EXCLUDED.what_it_does,
    source=EXCLUDED.source, target=EXCLUDED.target, feeds=EXCLUDED.feeds,
    cron_utc=EXCLUDED.cron_utc, sla_minutes=EXCLUDED.sla_minutes,
    freshness_table=EXCLUDED.freshness_table, freshness_col=EXCLUDED.freshness_col,
    workflow_file=EXCLUDED.workflow_file, enabled=EXCLUDED.enabled,
    sort_order=EXCLUDED.sort_order, updated_at=now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- read: what a workbook or the monitor pulls
CREATE OR REPLACE FUNCTION public.excel_dataset_rows(p_dataset TEXT)
RETURNS TABLE (sku TEXT, location TEXT, metrics JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT r.sku, r.location, r.metrics
        FROM excel_sync.dataset_rows r
       WHERE r.dataset = p_dataset
       ORDER BY lower(r.sku), r.location; $$;

CREATE OR REPLACE FUNCTION public.excel_datasets()
RETURNS TABLE (slug TEXT, title TEXT, grain TEXT, period TEXT,
               built_at TIMESTAMPTZ, row_count INT, group_count INT,
               checksum TEXT, columns JSONB, meta JSONB, source_ok BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT d.slug,d.title,d.grain,d.period,d.built_at,d.row_count,
             d.group_count,d.checksum,d.columns,d.meta,d.source_ok
        FROM excel_sync.datasets d ORDER BY d.slug; $$;

-- ───────────────────────────────────────────────────────────────────
-- 5) RLS + GRANTS — writes are service_role only; reads open to the page.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE excel_sync.datasets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE excel_sync.dataset_rows ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['datasets','dataset_rows'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON excel_sync.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON excel_sync.%I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON excel_sync.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON excel_sync.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA excel_sync TO service_role;
GRANT ALL    ON ALL TABLES IN SCHEMA excel_sync TO service_role;

REVOKE ALL ON FUNCTION public.excel_publish_dataset(TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_run_start(TEXT,TEXT,TEXT)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_run_finish(BIGINT,TEXT,INT,INT,TEXT,JSONB)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ops_register_bindings(JSONB)                          FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.excel_publish_dataset(TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_run_start(TEXT,TEXT,TEXT)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_run_finish(BIGINT,TEXT,INT,INT,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_register_bindings(JSONB)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.excel_dataset_rows(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.excel_datasets()         TO anon, authenticated, service_role;

SELECT 'excel_sync ready' AS status,
       (SELECT count(*) FROM information_schema.tables WHERE table_schema='excel_sync') AS tables;
