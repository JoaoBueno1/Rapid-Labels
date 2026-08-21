-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 — what delivery needs on top of the datasets.
--
-- Three tables, each one paying for a specific way this can go wrong:
--
--   graph_token     the delegated refresh token. Azure AD ROTATES it on every
--                   use, so a headless nightly run must write the new one back
--                   somewhere durable or it locks itself out after one run.
--
--                   An earlier version of this comment said app-only needs none
--                   of this and is therefore the destination. That is WRONG, and
--                   verified so on 2026-08-13: the Graph workbook API does not
--                   accept application permissions at all —
--                     PATCH /workbook/.../range   Application: Not supported.
--                     POST  /workbook/createSession  Application: Not supported.
--                   Delegated is not the bridge, it is the only road. This table
--                   is permanent, not temporary.
--
--   tab_snapshots   values AND formulas of a tab, captured before we ever write
--                   to it. A PATCH of values over a formula replaces it with a
--                   number, silently and permanently. This is the undo.
--
--   binding_state   how far the last write reached. When tomorrow's dataset is
--                   shorter than today's, the tail rows of yesterday survive
--                   unless we clear them — stale data indistinguishable from
--                   fresh. Guessing usedRange would sweep cells that are not
--                   ours, so we remember our own extent instead.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 1) GRAPH TOKEN — one row, id = 'default'.
--
-- SECURITY: this is a bearer credential for a human account. Anyone holding it
-- can read and write every file that user can. It is service_role only: no RLS
-- policy grants anon or authenticated anything, and the accessor functions are
-- revoked from both. Do not add a read policy "for the dashboard".
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.graph_token (
  id              TEXT PRIMARY KEY DEFAULT 'default',
  refresh_token   TEXT NOT NULL,
  account         TEXT,                    -- who signed in, for the audit trail
  scopes          TEXT,
  obtained_at     TIMESTAMPTZ DEFAULT now(),
  rotated_at      TIMESTAMPTZ DEFAULT now(),
  rotations       INT DEFAULT 0,
  last_error      TEXT
);

-- ───────────────────────────────────────────────────────────────────
-- 2) TAB SNAPSHOTS — the undo. Keep every one; they are small next to the point
--    of having them, and the one you deleted is the one you needed.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.tab_snapshots (
  snapshot_id  BIGSERIAL PRIMARY KEY,
  binding      TEXT NOT NULL,
  workbook     TEXT NOT NULL,
  sheet        TEXT NOT NULL,
  address      TEXT,                       -- usedRange at capture time
  taken_at     TIMESTAMPTZ DEFAULT now(),
  reason       TEXT,                       -- 'pre-first-write' | 'layout-changed' | 'manual'
  formula_cells INT DEFAULT 0,             -- how many formulas were in there
  values       JSONB,
  formulas     JSONB
);
CREATE INDEX IF NOT EXISTS idx_xs_snap_binding ON excel_sync.tab_snapshots (binding, taken_at DESC);

-- ───────────────────────────────────────────────────────────────────
-- 3) BINDING STATE — our own last extent, plus a layout fingerprint so a tab
--    someone restructured gets re-snapshotted instead of blindly overwritten.
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS excel_sync.binding_state (
  binding        TEXT PRIMARY KEY,
  last_written_at TIMESTAMPTZ,
  last_address   TEXT,                     -- 'B3:F2935'
  last_rows      INT,
  last_cols      INT,
  last_checksum  TEXT,                     -- dataset checksum that produced it
  layout_hash    TEXT,                     -- header row as we last saw it
  drive_id       TEXT,                     -- cached so we skip two lookups a night
  item_id        TEXT,
  writes         INT DEFAULT 0,
  last_status    TEXT,
  last_error     TEXT
);

-- ───────────────────────────────────────────────────────────────────
-- 4) PUBLIC API — service_role only, every one of them.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.excel_graph_token_get()
RETURNS TABLE (refresh_token TEXT, account TEXT, rotations INT, rotated_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT t.refresh_token, t.account, t.rotations, t.rotated_at
        FROM excel_sync.graph_token t WHERE t.id = 'default'; $$;

CREATE OR REPLACE FUNCTION public.excel_graph_token_set(
  p_refresh_token TEXT, p_account TEXT DEFAULT NULL, p_scopes TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = excel_sync, public
AS $$ INSERT INTO excel_sync.graph_token (id, refresh_token, account, scopes)
      VALUES ('default', p_refresh_token, p_account, p_scopes)
      ON CONFLICT (id) DO UPDATE SET
        refresh_token = EXCLUDED.refresh_token,
        account       = COALESCE(EXCLUDED.account, excel_sync.graph_token.account),
        scopes        = COALESCE(EXCLUDED.scopes,  excel_sync.graph_token.scopes),
        rotated_at    = now(),
        rotations     = excel_sync.graph_token.rotations + 1,
        last_error    = NULL; $$;

CREATE OR REPLACE FUNCTION public.excel_snapshot_save(
  p_binding TEXT, p_workbook TEXT, p_sheet TEXT, p_address TEXT,
  p_reason TEXT, p_formula_cells INT, p_values JSONB, p_formulas JSONB
) RETURNS BIGINT
LANGUAGE sql SECURITY DEFINER SET search_path = excel_sync, public
AS $$ INSERT INTO excel_sync.tab_snapshots
        (binding, workbook, sheet, address, reason, formula_cells, values, formulas)
      VALUES (p_binding,p_workbook,p_sheet,p_address,p_reason,p_formula_cells,p_values,p_formulas)
      RETURNING snapshot_id; $$;

-- Has this binding ever been snapshotted? Cheap enough to ask every run, and it
-- is what decides whether the first write is allowed to proceed.
CREATE OR REPLACE FUNCTION public.excel_snapshot_count(p_binding TEXT)
RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT count(*)::INT FROM excel_sync.tab_snapshots WHERE binding = p_binding; $$;

CREATE OR REPLACE FUNCTION public.excel_binding_state_get(p_binding TEXT)
RETURNS TABLE (binding TEXT, last_written_at TIMESTAMPTZ, last_address TEXT,
               last_rows INT, last_cols INT, last_checksum TEXT, layout_hash TEXT,
               drive_id TEXT, item_id TEXT, writes INT, last_status TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = excel_sync, public
AS $$ SELECT s.binding,s.last_written_at,s.last_address,s.last_rows,s.last_cols,
             s.last_checksum,s.layout_hash,s.drive_id,s.item_id,s.writes,s.last_status
        FROM excel_sync.binding_state s WHERE s.binding = p_binding; $$;

CREATE OR REPLACE FUNCTION public.excel_binding_state_set(
  p_binding TEXT, p_address TEXT, p_rows INT, p_cols INT, p_checksum TEXT,
  p_layout_hash TEXT, p_drive_id TEXT, p_item_id TEXT,
  p_status TEXT, p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = excel_sync, public
AS $$ INSERT INTO excel_sync.binding_state
        (binding,last_written_at,last_address,last_rows,last_cols,last_checksum,
         layout_hash,drive_id,item_id,writes,last_status,last_error)
      VALUES (p_binding,now(),p_address,p_rows,p_cols,p_checksum,
              p_layout_hash,p_drive_id,p_item_id,1,p_status,p_error)
      ON CONFLICT (binding) DO UPDATE SET
        last_written_at = now(),
        last_address  = COALESCE(EXCLUDED.last_address, excel_sync.binding_state.last_address),
        last_rows     = COALESCE(EXCLUDED.last_rows,  excel_sync.binding_state.last_rows),
        last_cols     = COALESCE(EXCLUDED.last_cols,  excel_sync.binding_state.last_cols),
        last_checksum = EXCLUDED.last_checksum,
        layout_hash   = COALESCE(EXCLUDED.layout_hash, excel_sync.binding_state.layout_hash),
        drive_id      = COALESCE(EXCLUDED.drive_id, excel_sync.binding_state.drive_id),
        item_id       = COALESCE(EXCLUDED.item_id, excel_sync.binding_state.item_id),
        writes        = excel_sync.binding_state.writes + 1,
        last_status   = EXCLUDED.last_status,
        last_error    = EXCLUDED.last_error; $$;

-- ───────────────────────────────────────────────────────────────────
-- 5) RLS + GRANTS
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE excel_sync.graph_token   ENABLE ROW LEVEL SECURITY;
ALTER TABLE excel_sync.tab_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE excel_sync.binding_state ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['graph_token','tab_snapshots','binding_state'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON excel_sync.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON excel_sync.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;
-- Deliberately NO read policy for anon/authenticated on any of the three. The
-- token is a credential; the snapshots are the whole company's stock figures.

GRANT USAGE ON SCHEMA excel_sync TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA excel_sync TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA excel_sync TO service_role;

DO $$
DECLARE fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.excel_graph_token_get()',
    'public.excel_graph_token_set(TEXT,TEXT,TEXT)',
    'public.excel_snapshot_save(TEXT,TEXT,TEXT,TEXT,TEXT,INT,JSONB,JSONB)',
    'public.excel_snapshot_count(TEXT)',
    'public.excel_binding_state_get(TEXT)',
    'public.excel_binding_state_set(TEXT,TEXT,INT,INT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;

SELECT 'graph delivery ready' AS status,
       (SELECT count(*) FROM information_schema.tables
         WHERE table_schema='excel_sync') AS tables;
