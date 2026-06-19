-- ═══════════════════════════════════════════════════════════════════
-- FG ANOMALY PICKS — surface assembly-in-a-sale (FG) anomalies in the
-- Anomalies / Pending filters, not just the sale's own pick anomalies.
-- Date: 2026-06-19
--
-- A sale can ship correctly on its own picks yet have an anomaly inside its
-- LINKED assembly (FG) components. anomaly_picks only counts the sale's picks,
-- so those orders were hidden from the Anomalies/Pending filters (only visible
-- under the FG filter). fg_anomaly_picks counts the FG component anomalies so
-- the filters match anomaly_picks>0 OR fg_anomaly_picks>0.
--
-- Idempotent — safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS fg_anomaly_picks INTEGER DEFAULT 0;

-- Backfill from the existing fg_orders JSON (component status='anomaly').
UPDATE public.pick_anomaly_orders po
SET fg_anomaly_picks = (
  SELECT count(*)::int
  FROM jsonb_array_elements(COALESCE(po.fg_orders::jsonb, '[]'::jsonb)) AS fg,
       jsonb_array_elements(COALESCE(fg->'components', '[]'::jsonb)) AS c
  WHERE c->>'status' = 'anomaly'
)
WHERE COALESCE(fg_count, 0) > 0;
