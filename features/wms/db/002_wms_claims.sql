-- 002_wms_claims.sql — order-level claim + lease for multi-operator picking.
--
-- Additive, nullable columns only. Safe to run on the live wms schema: nothing
-- in production reads these until WMS_CLAIMS_ENABLED=true (the claim/heartbeat/
-- release code paths are gated off by default). Run this in the Rapid-Labels
-- Supabase SQL Editor (this is the SEPARATE Labels project, not the TMS DB).
--
-- After running: set WMS_CLAIMS_ENABLED=true to turn enforcement on.

ALTER TABLE wms.waves
  ADD COLUMN IF NOT EXISTS claimed_by        TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at  TIMESTAMPTZ;

ALTER TABLE wms.transfers
  ADD COLUMN IF NOT EXISTS claimed_by        TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at  TIMESTAMPTZ;

-- Fast "is this held by a live lease?" lookups.
CREATE INDEX IF NOT EXISTS ix_wms_waves_lease     ON wms.waves     (lease_expires_at) WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_wms_transfers_lease ON wms.transfers (lease_expires_at) WHERE claimed_by IS NOT NULL;
