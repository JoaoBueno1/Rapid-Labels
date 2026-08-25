-- ============================================================
-- order_stage_events — per-stage transition log (Phase 2)
-- ============================================================
-- WHY: cin7_mirror.order_pipeline stores only order_date (a DATE, no time) and a
-- sync-time completed_at, so there is no way to know WHEN an order entered picking /
-- packing / shipped. This table captures each transition at the moment it happens, so the
-- board/lists can show the real time (AM/PM) per stage and compute true time-in-stage and
-- cycle time. One row per (order, stage) = the FIRST time it entered that stage.
--
-- APPLY: paste this whole file into the Supabase SQL Editor (Labels project).
--        The Labels DB is separate from the TMS — it is NOT applied via apply_sql.py.
-- ============================================================

CREATE TABLE IF NOT EXISTS cin7_mirror.order_stage_events (
    id            BIGSERIAL PRIMARY KEY,
    order_id      TEXT NOT NULL,                 -- SaleID / TaskID (matches order_pipeline.id)
    order_number  TEXT,                          -- e.g. SO-278946 / TR-49712
    order_type    TEXT,                          -- 'SO' | 'TR'
    warehouse     TEXT,                          -- from_location at the time
    stage         TEXT NOT NULL,                 -- ordered|backordered|picking|picked|packing|packed|shipped|completed
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),  -- real transition time
    source        TEXT NOT NULL DEFAULT 'webhook',     -- 'webhook' (real-time) | 'sync' (hourly backfill, coarse)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- First entry into a stage wins; a later webhook/sync for the same stage is a no-op.
    CONSTRAINT order_stage_events_uq UNIQUE (order_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_ose_order    ON cin7_mirror.order_stage_events (order_id);
CREATE INDEX IF NOT EXISTS idx_ose_at       ON cin7_mirror.order_stage_events (at DESC);
CREATE INDEX IF NOT EXISTS idx_ose_wh_stage ON cin7_mirror.order_stage_events (warehouse, stage);

-- RLS: read for the dashboard (anon), write for the sync/webhook workers (service role).
ALTER TABLE cin7_mirror.order_stage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read order_stage_events" ON cin7_mirror.order_stage_events;
CREATE POLICY "read order_stage_events"  ON cin7_mirror.order_stage_events FOR SELECT USING (true);

DROP POLICY IF EXISTS "write order_stage_events" ON cin7_mirror.order_stage_events;
CREATE POLICY "write order_stage_events" ON cin7_mirror.order_stage_events FOR ALL USING (true) WITH CHECK (true);

-- Expose to PostgREST (matches how order_pipeline / sync_runs are reachable).
GRANT SELECT ON cin7_mirror.order_stage_events TO anon, authenticated;
GRANT ALL    ON cin7_mirror.order_stage_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE cin7_mirror.order_stage_events_id_seq TO service_role;

-- ============================================================
-- After applying: the capture writes here from two sources —
--   1) WEBHOOK (real-time, accurate): the Cin7 webhook worker upserts a row on
--      Sale/PickAuthorised → 'picked', Sale/PackAuthorised → 'packed',
--      Sale/ShipmentAuthorised → 'shipped' (ON CONFLICT DO NOTHING).
--   2) SYNC (hourly backfill, coarse): order-pipeline-sync stamps a 'sync' event with
--      at = sync time when it first sees an order in a stage it has no event for yet, so
--      history isn't blank for orders that predate the webhook wiring.
-- Time-in-stage(X) = at(next stage) − at(X). Cycle time = at('shipped') − at(first stage).
-- ============================================================
