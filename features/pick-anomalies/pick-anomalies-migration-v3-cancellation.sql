-- ═══════════════════════════════════════════════
-- Pick Anomalies Monitor — V3 Migration (Cancellation Detection)
-- Run this in Supabase SQL Editor (safe to re-run)
-- ═══════════════════════════════════════════════

-- 1. Add cancellation tracking columns to pick_anomaly_orders
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN DEFAULT FALSE;

ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- has_correction_conflict = true when order had corrections AND was later cancelled
-- This means the stock transfer may have duplicated stock movement
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS has_correction_conflict BOOLEAN DEFAULT FALSE;

-- 2. Add reversal tracking to corrections table
ALTER TABLE public.pick_anomaly_corrections
  ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.pick_anomaly_corrections
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

ALTER TABLE public.pick_anomaly_corrections
  ADD COLUMN IF NOT EXISTS reversal_transfer_id TEXT;

ALTER TABLE public.pick_anomaly_corrections
  ADD COLUMN IF NOT EXISTS reversal_transfer_ref TEXT;

-- 3. Index for fast cancelled order lookup
CREATE INDEX IF NOT EXISTS idx_pao_cancelled ON public.pick_anomaly_orders(is_cancelled) WHERE is_cancelled = true;

-- 4. Index for correction conflicts
CREATE INDEX IF NOT EXISTS idx_pao_conflict ON public.pick_anomaly_orders(has_correction_conflict) WHERE has_correction_conflict = true;

-- Done! The cancellation detection system will now:
-- 1. During sync, detect orders that moved to VOID/CANCELLED status
-- 2. Flag orders with is_cancelled=true
-- 3. If corrections exist, set has_correction_conflict=true
-- 4. UI shows "Cancelled — Reversal needed" badge
-- 5. Operator can one-click reverse corrections (creates inverse stock transfer)
