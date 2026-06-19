-- ═══════════════════════════════════════════════════════════════════
-- MOVEMENT TRACKING — track EVERY stock movement, not just sales ships.
-- Date: 2026-06-18
--
-- cin7_mirror.stock_movements is the unified ledger. Until now only sales ships
-- landed there (webhook). The new poll syncs add: assembly (component consume +
-- FG produce), purchase receipts, stock transfers (incl. to other warehouses),
-- and stock adjustments. This view splits them into two buckets so the UI can
-- keep the fast "pick action" view (sales/assembly = a pick from a bin) apart
-- from the "other movements" audit tab (purchase/transfer/adjustment).
--
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

-- Dedup guard for the poll syncs (re-running a task replaces its rows, never
-- duplicates). Partial-safe: only poll-sourced rows carry a cin7_task_id+source.
CREATE INDEX IF NOT EXISTS idx_movements_task_source
  ON cin7_mirror.stock_movements (cin7_task_id, source);
CREATE INDEX IF NOT EXISTS idx_movements_sku_detected
  ON cin7_mirror.stock_movements (sku, detected_at DESC);

-- Categorised view: quick_action (a pick from a bin → can be a pick anomaly)
-- vs other (receipts/transfers/adjustments → audit trail, no pickface concept).
CREATE OR REPLACE VIEW cin7_mirror.movement_log AS
SELECT
  m.id, m.detected_at, m.sku, m.product_name, m.movement_type,
  m.reference_number, m.reference_type, m.cin7_task_id,
  m.from_location, m.from_bin, m.to_location, m.to_bin,
  m.quantity, m.is_internal, m.is_external, m.is_anomaly,
  m.customer_name, m.member_email, m.source,
  CASE
    WHEN m.movement_type IN ('sales_ship','sales_pick','assembly_consume','assembly_produce')
      THEN 'quick_action'
    ELSE 'other'
  END AS category,
  CASE m.movement_type
    WHEN 'sales_ship'       THEN 'Sale / Ship'
    WHEN 'sales_pick'       THEN 'Sale / Pick'
    WHEN 'assembly_consume' THEN 'Assembly — component out'
    WHEN 'assembly_produce' THEN 'Assembly — finished good in'
    WHEN 'purchase_receive' THEN 'Purchase receipt'
    WHEN 'stock_transfer'   THEN 'Transfer (location)'
    WHEN 'bin_transfer'     THEN 'Transfer (bin)'
    WHEN 'stock_adjustment' THEN 'Adjustment'
    ELSE m.movement_type
  END AS type_label
FROM cin7_mirror.stock_movements m;
