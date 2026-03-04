-- ═══════════════════════════════════════════════════════════════
-- ORDER PIPELINE — Warehouse tracking for Sales Orders & Transfers
-- Run this in Supabase SQL Editor (Dashboard → SQL → New Query)
-- ═══════════════════════════════════════════════════════════════

-- 1. Create table
CREATE TABLE IF NOT EXISTS cin7_mirror.order_pipeline (
  id              TEXT PRIMARY KEY,          -- SaleID (UUID) or TaskID (UUID)
  type            TEXT NOT NULL DEFAULT 'SO', -- 'SO' = Sales Order, 'TR' = Stock Transfer
  number          TEXT NOT NULL,              -- SO-248253 or TR-34725
  status          TEXT NOT NULL,              -- Cin7 status: ORDERING, PICKING, PICKED, etc.
  order_date      DATE,                       -- Order/creation date
  customer        TEXT,                       -- Customer name (SO) or "→ ToLocation" (TR)
  pick_status     TEXT,                       -- PICKING, PICKED, NOT PICKED, PARTIALLY PICKED
  pack_status     TEXT,                       -- PACKING, PACKED, NOT PACKED, PARTIALLY PACKED
  ship_status     TEXT,                       -- SHIPPING, SHIPPED, NOT SHIPPED, PARTIALLY SHIPPED
  invoice_status  TEXT,                       -- INVOICED, NOT INVOICED (SO only)
  from_location   TEXT,                       -- TR: source warehouse
  to_location     TEXT,                       -- TR: destination warehouse
  reference       TEXT,                       -- Customer ref (SO) or reference (TR)
  line_count      INT DEFAULT 0,             -- Number of line items
  total_qty       INT DEFAULT 0,             -- Sum of quantities
  updated_at      TIMESTAMPTZ,               -- Last modified in Cin7
  synced_at       TIMESTAMPTZ DEFAULT NOW(), -- When we last synced this row
  completed_at    TIMESTAMPTZ               -- When order was first seen as completed (for daily stats)
);

-- 2. Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_op_type        ON cin7_mirror.order_pipeline (type);
CREATE INDEX IF NOT EXISTS idx_op_status      ON cin7_mirror.order_pipeline (status);
CREATE INDEX IF NOT EXISTS idx_op_number      ON cin7_mirror.order_pipeline (number);
CREATE INDEX IF NOT EXISTS idx_op_order_date  ON cin7_mirror.order_pipeline (order_date DESC);
CREATE INDEX IF NOT EXISTS idx_op_customer    ON cin7_mirror.order_pipeline (customer);
CREATE INDEX IF NOT EXISTS idx_op_type_status ON cin7_mirror.order_pipeline (type, status);

-- 3. Enable RLS
ALTER TABLE cin7_mirror.order_pipeline ENABLE ROW LEVEL SECURITY;

-- 4. Allow read for anon (dashboard uses anon key)
DROP POLICY IF EXISTS "Allow read order_pipeline" ON cin7_mirror.order_pipeline;
CREATE POLICY "Allow read order_pipeline"
  ON cin7_mirror.order_pipeline
  FOR SELECT USING (true);

-- 5. Allow insert/update/delete for service role (sync script)
DROP POLICY IF EXISTS "Allow write order_pipeline service" ON cin7_mirror.order_pipeline;
CREATE POLICY "Allow write order_pipeline service"
  ON cin7_mirror.order_pipeline
  FOR ALL USING (true) WITH CHECK (true);

-- 6. Grant table-level permissions (required for PostgREST / anon access)
GRANT SELECT ON cin7_mirror.order_pipeline TO anon, authenticated;
GRANT ALL ON cin7_mirror.order_pipeline TO service_role;

-- 7. Sync metadata row in sync_runs (optional)
-- The sync script will log runs to cin7_mirror.sync_runs with sync_type = 'order_pipeline'

SELECT 'order_pipeline table created successfully' AS result;
