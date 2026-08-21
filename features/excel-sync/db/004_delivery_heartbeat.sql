-- ═══════════════════════════════════════════════════════════════════
-- Delivery heartbeat — noticing that the machine stopped.
--
-- Every gate built so far runs ON the delivery machine, so every one of them
-- shares a blind spot: if that PC is off, asleep, logged out, or the scheduled
-- task was disabled, nothing runs and therefore nothing complains. The failure
-- looks exactly like a quiet night.
--
-- This is the piece that runs somewhere else. It answers one question — "has
-- each enabled binding reported a successful delivery recently?" — from rows
-- only the delivery machine can write, and is called from GitHub Actions so a
-- red job becomes an email in a real inbox.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 1) Let a binding register its own freshness rules.
--
-- ops_register_bindings never carried business_hours_only, so the column kept
-- its FALSE default and Monday 08:00 measured back to Friday 07:00 as 73 wall
-- clock hours — late by any threshold, every single Monday. An alarm that is
-- wrong every Monday is an alarm nobody reads by March.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ops_register_bindings(p_rows JSONB)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
DECLARE n INT;
BEGIN
  INSERT INTO ops.sync_registry
    (slug,kind,title,what_it_does,source,target,feeds,cron_utc,sla_minutes,
     freshness_table,freshness_col,workflow_file,enabled,sort_order,
     business_hours_only,updated_at)
  SELECT e->>'slug', e->>'kind', e->>'title', COALESCE(e->>'what_it_does',''),
         e->>'source', e->>'target',
         COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(e->'feeds') x), '{}'),
         e->>'cron_utc', NULLIF(e->>'sla_minutes','')::INT,
         e->>'freshness_table', e->>'freshness_col', e->>'workflow_file',
         COALESCE((e->>'enabled')::BOOLEAN, FALSE),
         COALESCE(NULLIF(e->>'sort_order','')::INT, 200),
         COALESCE((e->>'business_hours_only')::BOOLEAN, FALSE), now()
    FROM jsonb_array_elements(p_rows) e
  ON CONFLICT (slug) DO UPDATE SET
    kind=EXCLUDED.kind, title=EXCLUDED.title, what_it_does=EXCLUDED.what_it_does,
    source=EXCLUDED.source, target=EXCLUDED.target, feeds=EXCLUDED.feeds,
    cron_utc=EXCLUDED.cron_utc, sla_minutes=EXCLUDED.sla_minutes,
    freshness_table=EXCLUDED.freshness_table, freshness_col=EXCLUDED.freshness_col,
    workflow_file=EXCLUDED.workflow_file, enabled=EXCLUDED.enabled,
    sort_order=EXCLUDED.sort_order,
    business_hours_only=EXCLUDED.business_hours_only, updated_at=now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Repair the rows already registered, so this takes effect without waiting for
-- someone to remember to re-run `python -m engine register`.
UPDATE ops.sync_registry
   SET freshness_table = NULL,
       freshness_col   = NULL,
       business_hours_only = TRUE,
       updated_at = now()
 WHERE kind = 'system_to_excel'
   AND slug NOT LIKE 'excel-dataset-%';

-- ───────────────────────────────────────────────────────────────────
-- 2) The heartbeat itself.
--
-- Returns one row per binding that SHOULD have delivered and has not. An empty
-- result means healthy. Deliberately reports rather than raises: the caller
-- decides what a problem is worth, and a SQL function that throws is hard to
-- read from a workflow log.
--
-- p_max_business_minutes: how stale a successful delivery may be. Delivery is
-- daily, so 1440 is one full cycle; the default adds three hours of slack for a
-- late start, a long run, or a morning somebody had the workbook open.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.excel_delivery_heartbeat(
  p_max_business_minutes INT DEFAULT 1620
)
RETURNS TABLE (
  slug            TEXT,
  title           TEXT,
  problem         TEXT,
  last_ok         TIMESTAMPTZ,
  business_minutes NUMERIC,
  last_status     TEXT,
  last_error      TEXT,
  rows_written    INT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$
  WITH expected AS (
    -- Only bindings that are switched on. `excel-dataset-%` is excluded on
    -- purpose: those are built in the cloud, so their success says nothing
    -- about whether the delivery machine is alive — including them would let a
    -- healthy cloud mask a dead PC, which is the exact hole this closes.
    SELECT r.slug, r.title
      FROM ops.sync_registry r
     WHERE r.kind = 'system_to_excel'
       AND r.enabled
       AND r.slug NOT LIKE 'excel-dataset-%'
  ),
  last_run AS (
    SELECT DISTINCT ON (s.slug) s.slug, s.status, s.error, s.rows_written, s.ended_at
      FROM ops.sync_runs s
     WHERE s.ended_at IS NOT NULL
     ORDER BY s.slug, s.ended_at DESC
  ),
  last_good AS (
    SELECT s.slug, max(s.ended_at) AS last_ok
      FROM ops.sync_runs s
     WHERE s.status = 'success'
     GROUP BY s.slug
  )
  SELECT e.slug,
         e.title,
         CASE
           WHEN g.last_ok IS NULL THEN 'never delivered successfully'
           WHEN ops.business_minutes(g.last_ok, now()) > p_max_business_minutes
             THEN 'last success is too old'
           WHEN l.status IS DISTINCT FROM 'success'
             THEN 'last run ended ' || COALESCE(l.status, 'unknown')
           WHEN COALESCE(l.rows_written, 0) = 0
             THEN 'last run wrote 0 rows'
         END AS problem,
         g.last_ok,
         CASE WHEN g.last_ok IS NULL THEN NULL
              ELSE round(ops.business_minutes(g.last_ok, now())::NUMERIC, 0) END,
         l.status,
         left(COALESCE(l.error, ''), 300),
         l.rows_written
    FROM expected e
    LEFT JOIN last_good g ON g.slug = e.slug
    LEFT JOIN last_run  l ON l.slug = e.slug
   WHERE g.last_ok IS NULL
      OR ops.business_minutes(g.last_ok, now()) > p_max_business_minutes
      OR l.status IS DISTINCT FROM 'success'
      OR COALESCE(l.rows_written, 0) = 0
   ORDER BY e.slug;
$$;

-- How many bindings are switched on. The heartbeat caller compares this against
-- the number of binding files in git: an empty expected set makes the check
-- vacuously green, which is precisely the state the project is in today with
-- all 21 disabled. Silence has to be distinguishable from "nothing to say".
CREATE OR REPLACE FUNCTION public.excel_delivery_expected_count()
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ops, public
AS $$ SELECT count(*)::INT FROM ops.sync_registry
       WHERE kind = 'system_to_excel' AND enabled AND slug NOT LIKE 'excel-dataset-%'; $$;

-- ───────────────────────────────────────────────────────────────────
-- 3) GRANTS — read-only, and readable by the monitor page as well as the job.
-- ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.ops_register_bindings(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_register_bindings(JSONB) TO service_role;

GRANT EXECUTE ON FUNCTION public.excel_delivery_heartbeat(INT) TO service_role, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.excel_delivery_expected_count() TO service_role, anon, authenticated;

SELECT 'delivery heartbeat ready' AS status,
       (SELECT count(*) FROM ops.sync_registry
         WHERE kind='system_to_excel' AND slug NOT LIKE 'excel-dataset-%') AS bindings_registered,
       (SELECT public.excel_delivery_expected_count()) AS bindings_enabled;
