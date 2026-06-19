-- ═══════════════════════════════════════════════════════════════════
-- CHASE AUTOMATION — automate the daily "Awaiting Fulfilment / Invoicing /
-- Backorders" chase email from live Cin7 data.
-- Date: 2026-06-18
--
-- Adds the 3 missing pieces the email needs that we didn't mirror yet:
--   • stock_availability — per SKU + warehouse OnHand/Allocated/Available
--     (the "Have stock" judgment + backorder detection).
--   • locations         — location_id → warehouse name (Main WH vs Other).
--   • chase_notes        — the ONLY manual layer: the "Outcome" follow-up log
--     (emailed/called/decision) the team fills in; Cin7 never has this.
-- Then chase_list VIEW joins everything and classifies each stuck order into
-- the email's sections, computing have_stock + the short SKUs automatically.
--
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- Capture the per-line backorder qty Cin7 already exposes (used as a cross-check
-- alongside the availability-derived shortfall).
ALTER TABLE cin7_mirror.sale_lines ADD COLUMN IF NOT EXISTS backorder_quantity NUMERIC;

-- ───────────────────────────────────────────────────────────────────
-- 1) STOCK AVAILABILITY — per SKU + location (aggregated across bins)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.stock_availability (
  sku               TEXT NOT NULL,
  location          TEXT NOT NULL,
  on_hand           NUMERIC,
  allocated         NUMERIC,
  available         NUMERIC,        -- ⭐ on_hand - allocated; <0 = short (B/O)
  on_order          NUMERIC,
  in_transit        NUMERIC,
  next_delivery     DATE,
  synced_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (sku, location)
);
CREATE INDEX IF NOT EXISTS idx_stock_avail_sku ON cin7_mirror.stock_availability (sku);

-- 2) LOCATIONS — reuse the EXISTING cin7_mirror.locations (id uuid → name),
--    already populated. No CREATE needed; the chase view joins it below.

-- ───────────────────────────────────────────────────────────────────
-- 3) CHASE NOTES — the manual "Outcome" layer (team-filled, not Cin7)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cin7_mirror.chase_notes (
  order_number  TEXT PRIMARY KEY,
  note          TEXT,             -- "Emailed 12/6", "Called — picks up Tue", …
  contacted_at  DATE,
  contacted_by  TEXT,
  resolved      BOOLEAN DEFAULT false,
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ───────────────────────────────────────────────────────────────────
-- 4) CHASE LIST — the automated email content (live)
-- ───────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS cin7_mirror.chase_list;
CREATE VIEW cin7_mirror.chase_list AS
WITH stuck AS (
  SELECT so.order_number, so.order_date, so.customer, so.sales_rep,
         so.location_id, so.picking_status, so.packing_status,
         so.shipping_status, so.invoice_status, so.status, so.order_status,
         COALESCE(l.name, so.location_name) AS wh_name
  FROM cin7_mirror.sales_orders so
  LEFT JOIN cin7_mirror.locations l ON l.id::text = so.location_id
  WHERE so.order_status = 'AUTHORISED'
    AND COALESCE(so.status,'') NOT IN ('VOIDED','CANCELLED','CREDITED','DRAFT')
    AND (
      so.shipping_status <> 'SHIPPED'
      OR (so.shipping_status = 'SHIPPED' AND COALESCE(so.invoice_status,'') <> 'INVOICED')
    )
),
line_stock AS (
  SELECT sl.order_number, sl.sku, sl.quantity,
         COALESCE(sa.available, 0) AS avail,
         sl.quantity - COALESCE(sa.available, 0) AS shortfall
  FROM cin7_mirror.sale_lines sl
  JOIN stuck s ON s.order_number = sl.order_number
  LEFT JOIN cin7_mirror.stock_availability sa
    ON sa.sku = sl.sku AND sa.location = s.wh_name
)
SELECT
  s.order_number, s.order_date, s.customer, s.sales_rep, s.wh_name,
  s.picking_status, s.packing_status, s.shipping_status, s.invoice_status,
  CASE
    WHEN s.shipping_status = 'SHIPPED' THEN 'C-Invoicing'
    WHEN s.wh_name = 'Main Warehouse'  THEN 'A-Fulfil-Main'
    ELSE 'B-Fulfil-Other'
  END AS section,
  CASE
    WHEN s.shipping_status = 'SHIPPED'   THEN 'Invoicing'
    WHEN s.packing_status  = 'PACKING'   THEN 'Packing'
    WHEN s.packing_status  = 'PACKED'    THEN 'Packed'
    WHEN s.picking_status  = 'PICKED'    THEN 'Picked'
    WHEN s.picking_status  = 'PICKING'   THEN 'Picking'
    ELSE 'Ordered'
  END AS stage,
  (SELECT bool_and(ls.avail >= ls.quantity)
     FROM line_stock ls WHERE ls.order_number = s.order_number) AS have_stock,
  (SELECT string_agg(ls.sku || ' (short ' || ls.shortfall::text || ')', ', ')
     FROM line_stock ls WHERE ls.order_number = s.order_number AND ls.shortfall > 0) AS short_skus,
  (SELECT count(*) FROM cin7_mirror.sale_lines sl WHERE sl.order_number = s.order_number) AS line_count,
  n.note AS outcome, n.contacted_at, n.contacted_by, n.resolved,
  (CURRENT_DATE - s.order_date) AS age_days
FROM stuck s
LEFT JOIN cin7_mirror.chase_notes n ON n.order_number = s.order_number
ORDER BY section, s.order_date;
