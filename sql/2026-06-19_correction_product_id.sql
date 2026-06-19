-- ═══════════════════════════════════════════════════════════════════
-- CORRECTION product_id — make cancellation-conflict reversals work (H1).
-- Date: 2026-06-19
--
-- createCorrectionTransfer never persisted product_id, so reverseCorrection
-- POSTed a Cin7 transfer line with ProductID=null → the reversal could never
-- move stock. Persist product_id so the reversal (and any audit) has the
-- Cin7 ProductID. Existing rows backfill from cin7_mirror.products by SKU
-- where resolvable; the engine now also refuses to POST a null product line.
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.pick_anomaly_corrections ADD COLUMN IF NOT EXISTS product_id TEXT;

-- Best-effort backfill for existing corrections from the product mirror.
UPDATE public.pick_anomaly_corrections c
SET product_id = p.id
FROM cin7_mirror.products p
WHERE c.product_id IS NULL
  AND p.sku = c.sku;
