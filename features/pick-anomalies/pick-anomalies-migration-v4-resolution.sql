-- ═══════════════════════════════════════════════
-- Pick Anomalies Monitor — V4 Migration (Resolution: reason + author)
-- Run this in Supabase SQL Editor (Rapid-Labels project). Safe to re-run.
--
-- Adds a real RESOLUTION to a review: WHY the anomaly happened (reason) and
-- WHO reviewed it (author). `reviewed_by` already exists (V2) and now holds
-- the author (operator name picked from the selector).
-- ═══════════════════════════════════════════════

-- 1. Resolution reason CODE (categorised — for monitoring/aggregation)
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS review_reason TEXT;

-- 2. Optional free-text detail
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS review_note TEXT;

-- 3. Author = the operator responsible for / who approved the wrong pick.
-- (V2 was supposed to add this but it never landed in the live DB — add it here.)
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- 3. Index for reason breakdown queries
CREATE INDEX IF NOT EXISTS idx_pao_review_reason
  ON public.pick_anomaly_orders(review_reason)
  WHERE review_reason IS NOT NULL;

-- RLS: pick_anomaly_orders already has anon read/write policies (V1) and the
-- server uses the service key — no new policy needed for the added columns.

-- Done. After applying, the Pick Anomalies review flow will require an author
-- (operator) + a reason to mark an order reviewed, and store both.
