-- =====================================================================
-- CONTAINER BUILDER — DATABASE SCHEMA
-- File: features/container-builder/migrations/001_create_container_plans.sql
-- Run in Supabase SQL Editor
-- Idempotent (uses IF NOT EXISTS). Adds only — never drops.
-- =====================================================================

-- 1. CONTAINER PLANS (plan header)
CREATE TABLE IF NOT EXISTS cin7_mirror.container_plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    created_by      TEXT,                                  -- free-text name from localStorage
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source_type     TEXT NOT NULL CHECK (source_type IN ('po', 'adhoc', 'replenishment')),
    source_ref      TEXT,                                  -- Cin7 PO number, if applicable
    container_type  TEXT NOT NULL CHECK (container_type IN ('20ft', '40ft', '40HC')),
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'confirmed', 'loaded', 'archived')),
    solver_version  TEXT,                                  -- bumped in packer.js when algorithm changes
    result_json     JSONB,                                 -- last solve result cached here
    notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_cb_plans_status     ON cin7_mirror.container_plans (status);
CREATE INDEX IF NOT EXISTS idx_cb_plans_created_by ON cin7_mirror.container_plans (created_by);
CREATE INDEX IF NOT EXISTS idx_cb_plans_updated    ON cin7_mirror.container_plans (updated_at DESC);

-- 2. CONTAINER PLAN LINES (frozen dimensions at plan time)
CREATE TABLE IF NOT EXISTS cin7_mirror.container_plan_lines (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id           UUID NOT NULL REFERENCES cin7_mirror.container_plans(id) ON DELETE CASCADE,
    sku               TEXT NOT NULL,
    qty_cartons       INTEGER NOT NULL CHECK (qty_cartons >= 0),
    -- Snapshot dimensions at plan creation time — re-solves must use these,
    -- not live master, so the plan stays reproducible if Cin7 master changes.
    carton_l_cm       NUMERIC(10,2) NOT NULL,
    carton_w_cm       NUMERIC(10,2) NOT NULL,
    carton_h_cm       NUMERIC(10,2) NOT NULL,
    carton_kg         NUMERIC(10,3) NOT NULL,
    units_per_carton  INTEGER DEFAULT 1,
    line_order        INTEGER NOT NULL DEFAULT 0           -- stable ordering within the plan
);

CREATE INDEX IF NOT EXISTS idx_cb_lines_plan_id ON cin7_mirror.container_plan_lines (plan_id);
CREATE INDEX IF NOT EXISTS idx_cb_lines_sku     ON cin7_mirror.container_plan_lines (sku);

-- 3. RLS — match cin7_mirror convention (permissive, no auth in app)
ALTER TABLE cin7_mirror.container_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.container_plan_lines  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read container_plans"       ON cin7_mirror.container_plans;
DROP POLICY IF EXISTS "Allow write container_plans"      ON cin7_mirror.container_plans;
DROP POLICY IF EXISTS "Allow read container_plan_lines"  ON cin7_mirror.container_plan_lines;
DROP POLICY IF EXISTS "Allow write container_plan_lines" ON cin7_mirror.container_plan_lines;

CREATE POLICY "Allow read container_plans"       ON cin7_mirror.container_plans       FOR SELECT USING (true);
CREATE POLICY "Allow write container_plans"      ON cin7_mirror.container_plans       FOR ALL    USING (true) WITH CHECK (true);
CREATE POLICY "Allow read container_plan_lines"  ON cin7_mirror.container_plan_lines  FOR SELECT USING (true);
CREATE POLICY "Allow write container_plan_lines" ON cin7_mirror.container_plan_lines  FOR ALL    USING (true) WITH CHECK (true);

-- 4. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON cin7_mirror.container_plans      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON cin7_mirror.container_plan_lines TO anon, authenticated;
GRANT ALL ON cin7_mirror.container_plans      TO service_role;
GRANT ALL ON cin7_mirror.container_plan_lines TO service_role;

-- 5. Trigger: auto-update updated_at on edits
CREATE OR REPLACE FUNCTION cin7_mirror.touch_container_plans_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_container_plans ON cin7_mirror.container_plans;
CREATE TRIGGER trg_touch_container_plans
  BEFORE UPDATE ON cin7_mirror.container_plans
  FOR EACH ROW EXECUTE FUNCTION cin7_mirror.touch_container_plans_updated_at();

-- 6. Verify
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'cin7_mirror'
  AND table_name IN ('container_plans', 'container_plan_lines')
ORDER BY table_name, ordinal_position;
