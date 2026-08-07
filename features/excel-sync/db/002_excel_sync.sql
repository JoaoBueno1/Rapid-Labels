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
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS excel_sync;

-- ───────────────────────────────────────────────────────────────────
-- 1) DATASETS — one row per build. Keeps the last N builds so the monitor can
--    say "ran, but nothing changed" (checksum equal), which is the difference
--    between healthy and quietly stuck.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.datasets (
  slug        TEXT PRIMARY KEY,          -- 'stock-level' | 'monthly-sales'
  title       TEXT NOT NULL,
  grain       TEXT NOT NULL,             -- 'sku x location'
  period      TEXT,                      -- '2026-08-01..2026-08-31' or NULL
  built_at    TIMESTAMPTZ DEFAULT now(),
  row_count   INT,
  group_count INT,
  checksum    TEXT,                      -- unchanged since last build?
  columns     JSONB DEFAULT '[]'::jsonb, -- ordered [{header, field}] — the contract
  meta        JSONB DEFAULT '{}'::jsonb, -- coverage, source rows, call counts
  source_ok   BOOLEAN DEFAULT TRUE       -- false = gates blocked this build
);

-- ───────────────────────────────────────────────────────────────────
-- 2) DATASET ROWS — long format (one row per sku x location).
--    Metrics live in JSONB so both datasets share one table and adding a
--    metric never needs a migration.
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
CREATE INDEX IF NOT EXISTS idx_xs_rows_sku      ON excel_sync.dataset_rows (dataset, sku);

-- ───────────────────────────────────────────────────────────────────
-- 3) REPLACE ONE DATASET ATOMICALLY.
--    Delete-then-insert inside a single statement-level transaction so a reader
--    never sees a half-written dataset — several workbooks may pull at once.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION excel_sync.replace_dataset(
  p_slug TEXT, p_title TEXT, p_grain TEXT, p_period TEXT,
  p_columns JSONB, p_meta JSONB, p_checksum TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = excel_sync, public
AS $$
DECLARE n INT;
BEGIN
  INSERT INTO excel_sync.datasets (slug,title,grain,period,built_at,columns,meta,checksum,row_count,group_count,source_ok)
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
-- 4) WIDE VIEW — what a workbook actually wants: SKU down, warehouse across.
--    Kept as a function so the caller picks the dataset and the metric.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION excel_sync.pivot(p_dataset TEXT, p_metric TEXT)
RETURNS TABLE (sku TEXT, location TEXT, value NUMERIC)
LANGUAGE sql STABLE
SET search_path = excel_sync, public
AS $$
  SELECT r.sku, r.location, (r.metrics ->> p_metric)::NUMERIC
    FROM excel_sync.dataset_rows r
   WHERE r.dataset = p_dataset AND r.metrics ? p_metric
   ORDER BY lower(r.sku), r.location;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 5) RLS + GRANTS
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

GRANT USAGE ON SCHEMA excel_sync TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA excel_sync TO anon, authenticated;
GRANT ALL    ON ALL TABLES IN SCHEMA excel_sync TO service_role;
GRANT EXECUTE ON FUNCTION excel_sync.replace_dataset(TEXT,TEXT,TEXT,TEXT,JSONB,JSONB,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION excel_sync.pivot(TEXT,TEXT) TO anon, authenticated, service_role;

SELECT 'excel_sync ready' AS status;
