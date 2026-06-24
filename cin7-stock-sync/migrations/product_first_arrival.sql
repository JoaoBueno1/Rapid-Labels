-- ═══════════════════════════════════════════════════════════════════
-- product_first_arrival — log the FIRST time each SKU shows stock at Main
-- Warehouse, so a future "New Products (arrived this month)" dashboard can
-- list genuinely-new arrivals (not restocks, not catalog edits).
--
-- WHY this and not products.created_at: the mirror has no creation date, and
-- "never sold" is unreliable (sale_lines is partial). The clean signal is the
-- first time a SKU appears WITH STOCK — i.e. it physically arrived.
--
-- ZERO extra Cin7 calls: populated by cin7-stock-sync/track-first-arrivals.js,
-- which reads the stock_snapshot the hourly stock sync ALREADY pulls.
--
-- Forward-only by design: the FIRST run seeds every currently-in-stock SKU as
-- is_baseline=true (first_arrival_date NULL — they pre-date tracking, so they
-- are NOT "arrived today"). Every SKU that appears in stock AFTER that gets a
-- real first_arrival_date. So "new this month" = is_baseline=false AND
-- first_arrival_date >= <month start>.
--
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cin7_mirror.product_first_arrival (
  sku                TEXT PRIMARY KEY,
  first_arrival_date DATE,                               -- NULL for baseline (pre-tracking) SKUs
  is_baseline        BOOLEAN NOT NULL DEFAULT false,
  on_hand_at_arrival NUMERIC,
  location           TEXT DEFAULT 'Main Warehouse',
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast "new arrivals since date D" lookups (excludes the baseline seed).
CREATE INDEX IF NOT EXISTS idx_pfa_first_arrival
  ON cin7_mirror.product_first_arrival (first_arrival_date)
  WHERE is_baseline = false;
