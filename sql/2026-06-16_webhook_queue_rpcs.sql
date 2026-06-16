-- ═══════════════════════════════════════════════════════════════════
-- WEBHOOK QUEUE — single-flight drain (lease) + atomic claim
-- Date: 2026-06-16
-- Fixes the Cin7 403 "burst throttle": instead of many concurrent /process
-- invocations hammering Cin7, a LEASE makes only ONE drainer run at a time,
-- processing sequentially (throttled). A CLAIM with FOR UPDATE SKIP LOCKED +
-- a 2-minute visibility timeout prevents double-processing and recovers
-- events orphaned by a crashed run.
--
-- Idempotent: safe to paste into the Supabase SQL editor and re-run.
-- ═══════════════════════════════════════════════════════════════════

-- ── single-flight lease (one row) ──
CREATE TABLE IF NOT EXISTS cin7_mirror.drain_lease (
  id           int PRIMARY KEY DEFAULT 1,
  leased_until timestamptz,
  CONSTRAINT drain_lease_single CHECK (id = 1)
);
INSERT INTO cin7_mirror.drain_lease (id, leased_until)
VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;

-- Acquire the drain lease. Returns true only if no live lease exists.
CREATE OR REPLACE FUNCTION cin7_mirror.acquire_drain_lease(p_seconds int DEFAULT 90)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE cnt int;
BEGIN
  UPDATE cin7_mirror.drain_lease
  SET leased_until = now() + (p_seconds || ' seconds')::interval
  WHERE id = 1 AND (leased_until IS NULL OR leased_until < now());
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt > 0;
END $$;

-- Release the lease early (so the next run can start immediately).
CREATE OR REPLACE FUNCTION cin7_mirror.release_drain_lease()
RETURNS void LANGUAGE sql AS $$
  UPDATE cin7_mirror.drain_lease SET leased_until = now() WHERE id = 1;
$$;

-- ── atomic claim: grab a due batch, mark processing, hide for 2 min ──
CREATE OR REPLACE FUNCTION cin7_mirror.claim_webhook_events(p_batch int DEFAULT 10)
RETURNS SETOF cin7_mirror.webhook_events LANGUAGE sql AS $$
  UPDATE cin7_mirror.webhook_events e
  SET status = 'processing',
      next_attempt_at = now() + interval '2 minutes'   -- visibility timeout
  WHERE e.id IN (
    SELECT id FROM cin7_mirror.webhook_events
    WHERE status IN ('pending', 'failed', 'processing')   -- 'processing' = re-claim orphaned
      AND next_attempt_at <= now()
      AND attempts < 6
    ORDER BY received_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  )
  RETURNING e.*;
$$;

-- ── grants (service role runs the drainer; bypasses RLS but needs EXECUTE) ──
GRANT EXECUTE ON FUNCTION cin7_mirror.acquire_drain_lease(int) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION cin7_mirror.release_drain_lease()    TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION cin7_mirror.claim_webhook_events(int) TO service_role, authenticated;

-- ask PostgREST to pick up the new functions
NOTIFY pgrst, 'reload schema';
