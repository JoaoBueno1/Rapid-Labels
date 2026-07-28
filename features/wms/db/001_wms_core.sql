-- ============================================================================
-- Rapid WMS — owned state layer.  Schema: wms.*  (isolated from cin7_mirror.* / public.*)
--
-- This is the source of truth for WORK-IN-PROGRESS (drafts, claims, reservations)
-- and an append-only journal of everything we committed to Cin7. Cin7 remains the
-- source of truth for total on-hand. Idempotent: safe to run and re-run.
--
-- Design rules baked in here:
--   * Nothing reaches Cin7 except through wms.outbox (one op_key per intent).
--   * wms.movements is append-only (no UPDATE/DELETE) — the auditable record.
--   * Multi-warehouse shaped from day one (warehouse_id on bins + pickface).
--   * We are the sole concurrency authority (wms.line_claims, wms.reservations).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS wms;

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wms.bin_type    AS ENUM ('pickface','bulk','staging','qa','damaged','production','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE wms.parcel_kind AS ENUM ('pick','assembly','pack');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE wms.work_status AS ENUM ('draft','in_progress','staged','committed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE wms.outbox_status AS ENUM ('pending','sent','confirmed','failed','reconciled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 1. Owned bin / pickface registry (multi-warehouse) ──────────────────────
-- Consolidates the 3 fragmented Cin7 pickface sources into one owned map, and
-- lets a NEW warehouse get bins as data entry (Cin7 models bins only in Main).
CREATE TABLE IF NOT EXISTS wms.bins (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id      TEXT NOT NULL,               -- Cin7 root location GUID (e.g. Main = 907821e3…)
  warehouse_name    TEXT NOT NULL,
  bin_code          TEXT NOT NULL,               -- e.g. MA-A-07-L7-P2
  cin7_location_id  TEXT,                         -- the bin's own GUID (Cin7 models bins as child locations)
  bin_type          wms.bin_type NOT NULL DEFAULT 'unknown',
  pick_zone         TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  synced_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, bin_code)
);
CREATE INDEX IF NOT EXISTS ix_wms_bins_code ON wms.bins (bin_code);
CREATE INDEX IF NOT EXISTS ix_wms_bins_zone ON wms.bins (warehouse_id, pick_zone) WHERE active;

-- Owned pickface / home-bin map: (warehouse, sku) -> ranked home bins.
CREATE TABLE IF NOT EXISTS wms.pickface (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id  TEXT NOT NULL,
  sku           TEXT NOT NULL,
  bin_code      TEXT NOT NULL,
  rank          INT  NOT NULL DEFAULT 1,          -- 1 = primary pickface, 2+ = overflow/reserve
  source        TEXT,                              -- stock_locator | restock_setup | manual | cin7
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, sku, bin_code)
);
CREATE INDEX IF NOT EXISTS ix_wms_pickface_sku ON wms.pickface (warehouse_id, sku, rank);

-- ── 2. Waves — a sale turned into executable work ───────────────────────────
CREATE TABLE IF NOT EXISTS wms.waves (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id        TEXT NOT NULL,                    -- Cin7 SaleID (GUID)
  order_number   TEXT NOT NULL,                    -- SO-#####
  sale_type      TEXT,                             -- 'Advanced Sale' (required for pack)
  customer       TEXT,
  ship_to        JSONB DEFAULT '{}'::jsonb,
  status         wms.work_status NOT NULL DEFAULT 'draft',
  has_assembly   BOOLEAN NOT NULL DEFAULT false,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sale_id)
);
CREATE INDEX IF NOT EXISTS ix_wms_waves_status ON wms.waves (status, created_at);

-- ── 3. Parcels — a slice of a wave (one kind of work, one operator, one Cin7 task)
CREATE TABLE IF NOT EXISTS wms.parcels (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wave_id        BIGINT NOT NULL REFERENCES wms.waves(id) ON DELETE CASCADE,
  kind           wms.parcel_kind NOT NULL,
  status         wms.work_status NOT NULL DEFAULT 'draft',
  assigned_to    TEXT,                             -- operator who owns this slice
  cin7_task_id   TEXT,                             -- the Cin7 fulfilment/assembly TaskID (set at commit)
  cin7_ref       TEXT,                             -- FulfillmentNumber / AssemblyNumber
  outbox_op_key  TEXT,                             -- link to the write that committed it
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_parcels_wave ON wms.parcels (wave_id, kind, status);

-- ── 4. Parcel lines — what to pick/build, and what's been scanned ───────────
CREATE TABLE IF NOT EXISTS wms.parcel_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id       BIGINT NOT NULL REFERENCES wms.parcels(id) ON DELETE CASCADE,
  sale_line_ref   TEXT,                            -- stable reference to the Cin7 order line
  sku             TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  name            TEXT,
  is_assembly     BOOLEAN NOT NULL DEFAULT false,
  qty_ordered     NUMERIC(12,3) NOT NULL,
  qty_scanned     NUMERIC(12,3) NOT NULL DEFAULT 0,
  from_bin        TEXT,                            -- chosen source bin (operator scan)
  from_bin_id     TEXT,                            -- its Cin7 LocationID GUID
  box             TEXT,                            -- pack: which carton
  status          wms.work_status NOT NULL DEFAULT 'draft',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_plines_parcel ON wms.parcel_lines (parcel_id);
CREATE INDEX IF NOT EXISTS ix_wms_plines_sku ON wms.parcel_lines (sku);

-- ── 5. Line claims — the concurrency authority Cin7 doesn't provide ─────────
-- One operator owns a given sale line at a time; prevents two users double-picking.
CREATE TABLE IF NOT EXISTS wms.line_claims (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wave_id        BIGINT NOT NULL REFERENCES wms.waves(id) ON DELETE CASCADE,
  sale_line_ref  TEXT NOT NULL,
  claimed_by     TEXT NOT NULL,
  claimed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ,
  UNIQUE (wave_id, sale_line_ref)                  -- an active claim is unique per line
);

-- ── 6. Reservations — soft allocation so two operators never grab the last unit
CREATE TABLE IF NOT EXISTS wms.reservations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku             TEXT NOT NULL,
  warehouse_id    TEXT NOT NULL,
  bin_code        TEXT,
  qty             NUMERIC(12,3) NOT NULL,
  wave_id         BIGINT REFERENCES wms.waves(id) ON DELETE CASCADE,
  parcel_line_id  BIGINT REFERENCES wms.parcel_lines(id) ON DELETE CASCADE,
  reason          TEXT,                            -- 'pick' | 'assembly_output' | 'assembly_component'
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_wms_resv_sku ON wms.reservations (sku, warehouse_id) WHERE active;

-- ── 7. Scans — audit of every physical scan (before any Cin7 write) ─────────
CREATE TABLE IF NOT EXISTS wms.scans (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_line_id  BIGINT REFERENCES wms.parcel_lines(id) ON DELETE CASCADE,
  scan_type       TEXT NOT NULL,                   -- 'bin' | 'product' | 'qty' | 'carton'
  raw_value       TEXT,                            -- exactly what came off the scanner
  resolved_sku    TEXT,
  resolved_bin    TEXT,
  qty             NUMERIC(12,3),
  scanned_by      TEXT,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_scans_line ON wms.scans (parcel_line_id, scanned_at);

-- ── 8. Assembly builds (our record; adopt-or-create the Cin7 build) ─────────
CREATE TABLE IF NOT EXISTS wms.builds (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wave_id              BIGINT REFERENCES wms.waves(id) ON DELETE CASCADE,
  fg_sku               TEXT NOT NULL,
  fg_product_id        TEXT NOT NULL,
  qty                  NUMERIC(12,3) NOT NULL,
  warehouse_id         TEXT NOT NULL,
  cin7_task_id         TEXT,                        -- adopted or created
  cin7_assembly_number TEXT,                        -- FG-#####
  adopted              BOOLEAN NOT NULL DEFAULT false, -- true = we adopted Cin7's auto-created build
  putaway_bin          TEXT,                        -- FG born binless; where we put it (or null = feeds sale)
  status               wms.work_status NOT NULL DEFAULT 'draft',
  outbox_op_key        TEXT,
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_builds_wave ON wms.builds (wave_id, status);

CREATE TABLE IF NOT EXISTS wms.build_components (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  build_id      BIGINT NOT NULL REFERENCES wms.builds(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  qty           NUMERIC(12,3) NOT NULL,
  from_bin      TEXT,                               -- operator-chosen source bin
  from_bin_id   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 9. THE OUTBOX — the exactly-once idempotency ledger ─────────────────────
-- Every Cin7 write is enqueued here FIRST (status 'pending') with a unique op_key.
-- The sender flips 'pending'->'sent' before the HTTP call and 'sent'->'confirmed'
-- after a verified success. A timeout leaves it 'sent'; the reconciler checks Cin7
-- + cin7_mirror.stock_movements before EVER retrying, so stock cannot double-move.
CREATE TABLE IF NOT EXISTS wms.outbox (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  op_key        TEXT NOT NULL,                      -- client-generated, deterministic per intent
  op_type       TEXT NOT NULL,                      -- 'sale_pick'|'sale_pack'|'fg_order'|'fg_pick'|'fg_create'|'transfer'
  target        TEXT NOT NULL,                      -- 'sale/fulfilment/pick' etc (the endpoint)
  method        TEXT NOT NULL DEFAULT 'POST',
  cin7_task_id  TEXT,                               -- the fulfilment/build this write targets
  payload       JSONB NOT NULL,
  status        wms.outbox_status NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  cin7_ref      TEXT,                               -- returned assembly/fulfilment number
  http_status   INT,
  last_error    TEXT,
  response      JSONB,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  confirmed_at  TIMESTAMPTZ,
  UNIQUE (op_key)                                    -- the idempotency guarantee
);
CREATE INDEX IF NOT EXISTS ix_wms_outbox_status ON wms.outbox (status, created_at);
CREATE INDEX IF NOT EXISTS ix_wms_outbox_task ON wms.outbox (cin7_task_id);

-- ── 10. Movement journal — append-only, auditable record of every commit ────
CREATE TABLE IF NOT EXISTS wms.movements (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  op_key         TEXT NOT NULL,                     -- links back to the outbox write
  movement_type  TEXT NOT NULL,                     -- 'pick'|'pack'|'assembly_consume'|'assembly_produce'|'putaway'|'transfer'
  sku            TEXT NOT NULL,
  product_id     TEXT,
  qty            NUMERIC(12,3) NOT NULL,
  from_bin       TEXT,
  to_bin         TEXT,
  warehouse_id   TEXT,
  cin7_ref       TEXT,                              -- SO-##### / FG-#####
  wave_id        BIGINT,
  actor          TEXT NOT NULL,                     -- the operator (Cin7 never gives us this)
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_moves_sku ON wms.movements (sku, occurred_at);
CREATE INDEX IF NOT EXISTS ix_wms_moves_ref ON wms.movements (cin7_ref);
CREATE INDEX IF NOT EXISTS ix_wms_moves_opkey ON wms.movements (op_key);

-- Append-only: block UPDATE/DELETE so the journal is trustworthy.
CREATE OR REPLACE FUNCTION wms.no_mutate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'wms.movements is append-only'; END $$;
DROP TRIGGER IF EXISTS trg_wms_moves_immutable ON wms.movements;
CREATE TRIGGER trg_wms_moves_immutable
  BEFORE UPDATE OR DELETE ON wms.movements
  FOR EACH ROW EXECUTE FUNCTION wms.no_mutate();

-- ── 11. Transfers — bin↔bin and warehouse↔warehouse ─────────────────────────
CREATE TABLE IF NOT EXISTS wms.transfers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           TEXT NOT NULL DEFAULT 'bin',        -- 'bin' | 'warehouse'
  from_location  TEXT,
  to_location    TEXT,
  status         wms.work_status NOT NULL DEFAULT 'draft',
  cin7_task_id   TEXT,
  cin7_ref       TEXT,
  outbox_op_key  TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wms.transfer_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id   BIGINT NOT NULL REFERENCES wms.transfers(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  product_id    TEXT NOT NULL,
  qty           NUMERIC(12,3) NOT NULL,
  from_bin      TEXT, from_bin_id TEXT,
  to_bin        TEXT, to_bin_id TEXT,
  scanned       BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_wms_tlines_transfer ON wms.transfer_lines (transfer_id);

-- ── grants (service_role bypasses RLS; anon read via views later if needed) ──
GRANT USAGE ON SCHEMA wms TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA wms TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA wms TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT ALL ON SEQUENCES TO service_role;
