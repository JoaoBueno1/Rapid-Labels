-- ═══════════════════════════════════════════════════════════════════
-- SALES MIRROR — canonical sales/lines/transfers for analytics
-- Date: 2026-06-17
-- "Save everything now, turn it on later": every field Cin7 gives becomes a
-- column so future sales/salesrep/invoice/product analytics just query — no
-- re-backfill. Header fields fill from saleList (cheap, all 269k); detail-only
-- fields (sales_rep, location_name, totals, lines) fill from the sale detail
-- for the recent shipped set + every webhook going forward.
--
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- ───────────────────────────────────────────────────────────────────
-- 1) SALES ORDERS — the canonical sale (header + key detail fields)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.sales_orders (
  order_number       TEXT PRIMARY KEY,
  sale_id            TEXT,
  -- customer
  customer           TEXT,
  customer_id        TEXT,
  customer_reference TEXT,
  contact            TEXT,          -- detail
  email              TEXT,          -- detail
  phone              TEXT,          -- detail
  sales_rep          TEXT,          -- detail ⭐
  -- dates
  order_date         DATE,
  ship_date          DATE,          -- detail (Ship.Lines ShipmentDate)
  invoice_date       DATE,
  invoice_due_date   DATE,
  ship_by            DATE,
  -- money
  order_amount       NUMERIC,       -- detail (order total)
  invoice_amount     NUMERIC,
  paid_amount        NUMERIC,
  cogs_amount        NUMERIC,       -- detail
  tax_amount         NUMERIC,
  base_currency      TEXT,
  currency_rate      NUMERIC,       -- detail
  -- statuses
  status             TEXT,          -- overall (COMPLETED, INVOICED, …)
  order_status       TEXT,
  fulfilment_status  TEXT,
  shipping_status    TEXT,
  picking_status     TEXT,
  packing_status     TEXT,
  invoice_status     TEXT,
  payment_status     TEXT,
  quote_status       TEXT,
  -- references / logistics
  invoice_number     TEXT,
  credit_note_number TEXT,
  location_id        TEXT,
  location_name      TEXT,          -- detail
  source_channel     TEXT,
  type               TEXT,
  service_only       BOOLEAN,       -- detail
  carrier            TEXT,          -- detail
  tracking_numbers   TEXT,
  -- ship-to (geo analytics) — detail
  ship_suburb        TEXT,
  ship_state         TEXT,
  ship_postcode      TEXT,
  ship_country       TEXT,
  -- bookkeeping
  cin7_updated       TIMESTAMPTZ,   -- Cin7 LastModified / Updated
  header_synced_at   TIMESTAMPTZ,
  detail_synced_at   TIMESTAMPTZ,   -- null until we've fetched the detail
  source             TEXT DEFAULT 'backfill'
);
-- add any missing columns if the table predates this script
ALTER TABLE cin7_mirror.sales_orders ADD COLUMN IF NOT EXISTS sales_rep TEXT;
ALTER TABLE cin7_mirror.sales_orders ADD COLUMN IF NOT EXISTS detail_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_so_customer    ON cin7_mirror.sales_orders (customer);
CREATE INDEX IF NOT EXISTS idx_so_rep         ON cin7_mirror.sales_orders (sales_rep);
CREATE INDEX IF NOT EXISTS idx_so_order_date  ON cin7_mirror.sales_orders (order_date);
CREATE INDEX IF NOT EXISTS idx_so_ship_date   ON cin7_mirror.sales_orders (ship_date);
CREATE INDEX IF NOT EXISTS idx_so_invoice_st  ON cin7_mirror.sales_orders (invoice_status);
CREATE INDEX IF NOT EXISTS idx_so_ship_st     ON cin7_mirror.sales_orders (shipping_status);
CREATE INDEX IF NOT EXISTS idx_so_location    ON cin7_mirror.sales_orders (location_id);
CREATE INDEX IF NOT EXISTS idx_so_detail_null ON cin7_mirror.sales_orders (detail_synced_at) WHERE detail_synced_at IS NULL;

-- ───────────────────────────────────────────────────────────────────
-- 2) SALE LINES — line items for product-level sales analytics (detail)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.sale_lines (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number TEXT NOT NULL,
  sale_id      TEXT,
  line_no      INT,
  sku          TEXT,
  product_id   TEXT,
  product_name TEXT,
  quantity     NUMERIC,
  price        NUMERIC,
  discount     NUMERIC,
  tax          NUMERIC,
  total        NUMERIC,
  synced_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (order_number, line_no)
);
CREATE INDEX IF NOT EXISTS idx_sl_order ON cin7_mirror.sale_lines (order_number);
CREATE INDEX IF NOT EXISTS idx_sl_sku   ON cin7_mirror.sale_lines (sku);

-- ───────────────────────────────────────────────────────────────────
-- 3) STOCK TRANSFERS — transfer mirror (backfill + poll; no Cin7 webhook)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_transfers (
  task_id         TEXT PRIMARY KEY,
  number          TEXT,
  from_location   TEXT,
  to_location     TEXT,
  status          TEXT,            -- DRAFT | IN TRANSIT | COMPLETED | VOIDED
  reference       TEXT,
  departure_date  DATE,
  completion_date DATE,
  required_by     DATE,
  line_count      INT,
  total_qty       NUMERIC,
  cin7_updated    TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ DEFAULT now(),
  source          TEXT DEFAULT 'backfill'
);
CREATE INDEX IF NOT EXISTS idx_st_status   ON cin7_mirror.stock_transfers (status);
CREATE INDEX IF NOT EXISTS idx_st_dates     ON cin7_mirror.stock_transfers (completion_date);

-- ───────────────────────────────────────────────────────────────────
-- 4) BACKFILL CHECKPOINT — resume a multi-hour backfill safely
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.backfill_state (
  job           TEXT PRIMARY KEY,  -- 'sales_headers' | 'sales_detail' | 'transfers'
  last_page     INT DEFAULT 0,
  last_cursor   TEXT,              -- e.g. last OrderDate / UpdatedSince processed
  done          BOOLEAN DEFAULT false,
  total_target  INT,
  processed     INT DEFAULT 0,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  notes         TEXT
);

-- ───────────────────────────────────────────────────────────────────
-- 5) RLS + GRANTS (read for dashboards; service role writes)
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE cin7_mirror.sales_orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.sale_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.backfill_state  ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_orders','sale_lines','stock_transfers','backfill_state'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON cin7_mirror.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON cin7_mirror.%I FOR SELECT USING (true)', t, t);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA cin7_mirror TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA cin7_mirror TO anon, authenticated;

-- verification
SELECT table_name, (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema='cin7_mirror' AND c.table_name=t.table_name) AS columns
FROM (VALUES ('sales_orders'),('sale_lines'),('stock_transfers'),('backfill_state')) AS t(table_name);
