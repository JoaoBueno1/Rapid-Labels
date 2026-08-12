-- 004_returns_putaway.sql — warehouse put-away confirmation step for Returns.
--
-- New flow: office "Complete" now sends a return to status 'to_putaway' (a warehouse
-- queue in Active) instead of straight to 'completed'/History. The warehouse then
-- physically shelves the goods and presses "Confirm put-away", which sets 'completed'
-- and stamps who/when here — then it moves to History.
--
-- Additive, nullable. Run in the Rapid-Labels Supabase SQL Editor. The app writes these
-- best-effort, so the flow already works before this runs (the put-away name/time just
-- won't be persisted until the columns exist). 'status' is a text column, so the new
-- 'to_putaway' value needs no schema change.

ALTER TABLE public.returns_active
  ADD COLUMN IF NOT EXISTS putaway_by TEXT,
  ADD COLUMN IF NOT EXISTS putaway_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS putaway_location TEXT;
