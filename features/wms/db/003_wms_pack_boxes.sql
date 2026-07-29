-- 003_wms_pack_boxes.sql — persist the packed carton dims as a first-class column so
-- the TMS booking handoff (and any future server-to-server booking) can read them,
-- instead of them living only in the browser + outbox.payload JSON.
--
-- Additive, nullable. Safe to run on the live wms schema. Run in the Rapid-Labels
-- Supabase SQL Editor (separate Labels project, not the TMS DB). Until it is run, the
-- POST /api/wms/pack/boxes save is a best-effort no-op (persisted:false) and the
-- deep-link still works from the browser's carton data.

ALTER TABLE wms.parcels
  ADD COLUMN IF NOT EXISTS boxes JSONB;
