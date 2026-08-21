-- ============================================================================
-- Gateway Inventory — durable foundation (lots, movements, transfers, FIFO)
-- File: features/gateway/db/001_gateway_inventory.sql
-- Apply: Supabase Dashboard -> SQL Editor (paste whole file). Idempotent.
--
-- NOT apply_sql.py: that script splits naively on ';' and cannot carry a
-- $$ ... $$ function body. Everything transactional here lives in plpgsql
-- because PostgREST cannot open a transaction — an RPC call IS the
-- transaction boundary, and it is the only place row locks can be taken.
--
-- Why this exists
-- ---------------
-- Gateway is a top-level Cin7 LOCATION (cin7_mirror.locations name='Gateway',
-- parent_id IS NULL, bin_count=0). Cin7 therefore knows a per-SKU total and
-- NOTHING about which shelf or pallet a unit sits on, nor when it arrived.
-- That layer has only ever existed in a spreadsheet. This schema owns it.
--
-- Design rules baked in:
--   * A balance is never typed in. It is the sum of an append-only ledger.
--   * gateway_movements is append-only — UPDATE/DELETE are refused by trigger.
--   * Reservations ARE allocations. There is no second reservation concept
--     that can drift out of sync with the transfer that caused it.
--   * Every multi-step operation is an RPC, so it is atomic and lock-ordered.
--   * Cin7 stays the source of truth for the per-SKU TOTAL. We never silently
--     rewrite local history to agree with it — disagreement is a first-class
--     record (gateway_recon_issues), not a correction.
--   * received_on may be NULL ONLY for migrated opening balances, so "unknown
--     date" can never be created going forward.
-- ============================================================================

-- ── settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.gateway_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

INSERT INTO public.gateway_settings (key, value, description) VALUES
  ('fifo_unknown_policy', 'oldest',
   'Where undated (migrated) stock sits in the FIFO queue: oldest | newest. Default oldest — undated stock only exists because it was already in Gateway at migration, so it IS old, and draining it first retires the ambiguity.'),
  ('age_warn_days',  '60',  'Lot age in days that raises a FIFO warning.'),
  ('age_alert_days', '120', 'Lot age in days that raises a FIFO alert.'),
  ('erp_transfer_write_enabled', 'false',
   'Master switch for creating stock transfers in Cin7 from this module. MUST stay false — Gateway/Main transfers are raised by hand in Cin7 for now.'),
  ('allow_negative_lots', 'false', 'Reserved for a future admin path. The CHECK constraint is hard regardless.')
ON CONFLICT (key) DO NOTHING;

-- ── 1. shelves — extend the existing 447-row map, do not recreate it ────────
CREATE TABLE IF NOT EXISTS public.gateway_shelves (
  id           TEXT PRIMARY KEY,
  area         TEXT NOT NULL,
  shelf_number INT,
  shelf_type   TEXT NOT NULL DEFAULT 'stock',
  label        TEXT,
  active       BOOLEAN DEFAULT true,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
-- pick_sequence is what column B of the paper sheet always was: the order the
-- picker walks the racks, which is NOT the order the SKUs sort in.
ALTER TABLE public.gateway_shelves ADD COLUMN IF NOT EXISTS pick_sequence INT;
ALTER TABLE public.gateway_shelves ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS ix_gw_shelves_area ON public.gateway_shelves (area);
CREATE INDEX IF NOT EXISTS ix_gw_shelves_seq  ON public.gateway_shelves (pick_sequence) WHERE active;

-- ── 2. import batches — provenance + idempotency for every migrated row ─────
CREATE TABLE IF NOT EXISTS public.gateway_import_batches (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_file       TEXT NOT NULL,
  source_sheet      TEXT,
  content_hash      TEXT NOT NULL,          -- sha256 of the parsed payload
  kind              TEXT NOT NULL CHECK (kind IN ('lot_ledger','daily_tab','shelf_map','manual')),
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed','rolled_back')),
  rows_read         INT NOT NULL DEFAULT 0,
  lots_created      INT NOT NULL DEFAULT 0,
  movements_created INT NOT NULL DEFAULT 0,
  warnings          INT NOT NULL DEFAULT 0,
  errors            INT NOT NULL DEFAULT 0,
  report            JSONB NOT NULL DEFAULT '{}',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  created_by        TEXT,
  -- re-running the same file+sheet with unchanged content is a no-op, not a
  -- second copy of the inventory.
  UNIQUE (content_hash, kind)
);
CREATE INDEX IF NOT EXISTS ix_gw_batches_started ON public.gateway_import_batches (started_at DESC);

-- ── 3. import issues — every row we refused to guess about ─────────────────
CREATE TABLE IF NOT EXISTS public.gateway_import_issues (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    BIGINT NOT NULL REFERENCES public.gateway_import_batches(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  code        TEXT NOT NULL,
  sheet       TEXT,
  row_ref     TEXT,
  sku         TEXT,
  message     TEXT NOT NULL,
  raw         JSONB,
  resolved    BOOLEAN NOT NULL DEFAULT false,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gw_issues_batch ON public.gateway_import_issues (batch_id, severity);
CREATE INDEX IF NOT EXISTS ix_gw_issues_open  ON public.gateway_import_issues (resolved, severity) WHERE NOT resolved;

-- ── 4. lots — one physical arrival of one SKU into Gateway ─────────────────
CREATE TABLE IF NOT EXISTS public.gateway_lots (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku              TEXT NOT NULL,
  five_dc          TEXT,
  product_name     TEXT,

  received_on      DATE,                   -- business date the stock landed
  qty_received     NUMERIC(14,3) NOT NULL CHECK (qty_received > 0),
  qty_remaining    NUMERIC(14,3) NOT NULL CHECK (qty_remaining >= 0),
  qty_reserved     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
  uom              TEXT NOT NULL DEFAULT 'Item',

  source_type      TEXT NOT NULL CHECK (source_type IN
                     ('transfer_in','container','opening_balance','return','found','correction')),
  source_reference TEXT,                   -- TR-49562 / PO / container no.
  cin7_task_id     TEXT,                   -- -> cin7_mirror.stock_transfers.task_id

  shelf_id         TEXT REFERENCES public.gateway_shelves(id),
  shelf_text       TEXT,                   -- verbatim original ('FLOOR', 'Floor ?')
  pallet_number    TEXT,

  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','depleted','written_off')),
  date_confidence  TEXT NOT NULL DEFAULT 'exact'
                     CHECK (date_confidence IN ('exact','inferred','unknown')),

  source_system    TEXT NOT NULL DEFAULT 'app'
                     CHECK (source_system IN ('app','excel_migration','cin7','stocktake')),
  import_batch_id  BIGINT REFERENCES public.gateway_import_batches(id),
  import_row_ref   TEXT,
  notes            TEXT,

  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gw_lots_remaining_le_received CHECK (qty_remaining <= qty_received),
  CONSTRAINT gw_lots_reserved_le_remaining CHECK (qty_reserved  <= qty_remaining),
  -- an undated lot can only ever be something migration found already sitting
  -- in Gateway. The app must never be able to create one.
  CONSTRAINT gw_lots_date_required CHECK (received_on IS NOT NULL OR source_type = 'opening_balance'),
  CONSTRAINT gw_lots_confidence_agrees CHECK (
    (received_on IS NULL AND date_confidence = 'unknown') OR
    (received_on IS NOT NULL AND date_confidence <> 'unknown')),
  -- idempotent re-import: one source row can only ever produce one lot.
  CONSTRAINT gw_lots_import_unique UNIQUE (import_batch_id, import_row_ref)
);
CREATE INDEX IF NOT EXISTS ix_gw_lots_sku_open ON public.gateway_lots (sku, received_on NULLS FIRST)
  WHERE status = 'open' AND qty_remaining > 0;
CREATE INDEX IF NOT EXISTS ix_gw_lots_sku      ON public.gateway_lots (sku);
CREATE INDEX IF NOT EXISTS ix_gw_lots_shelf    ON public.gateway_lots (shelf_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_gw_lots_received ON public.gateway_lots (received_on);
CREATE INDEX IF NOT EXISTS ix_gw_lots_task     ON public.gateway_lots (cin7_task_id) WHERE cin7_task_id IS NOT NULL;

-- ── 5. transfers — the Gateway/Main movement, as a document ────────────────
CREATE SEQUENCE IF NOT EXISTS public.gateway_transfer_no_seq START 1;

CREATE TABLE IF NOT EXISTS public.gateway_transfers (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_no    TEXT NOT NULL UNIQUE,
  direction      TEXT NOT NULL CHECK (direction IN ('gateway_to_main','main_to_gateway')),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                   ('draft','ready_for_cin7','cin7_created','picking','dispatched','completed','cancelled')),

  planned_for    DATE,
  reference      TEXT,                     -- free operator reference
  cin7_reference TEXT,                     -- TR-49562, typed in AFTER a human raises it
  cin7_task_id   TEXT,
  cin7_linked_at TIMESTAMPTZ,
  cin7_linked_by TEXT,

  fifo_compliant BOOLEAN,                  -- NULL until allocated
  notes          TEXT,

  prepared_at    TIMESTAMPTZ, prepared_by   TEXT,
  picked_at      TIMESTAMPTZ, picked_by     TEXT,
  dispatched_at  TIMESTAMPTZ, dispatched_by TEXT,
  completed_at   TIMESTAMPTZ, completed_by  TEXT,
  cancelled_at   TIMESTAMPTZ, cancelled_by  TEXT, cancel_reason TEXT,

  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gw_tr_status ON public.gateway_transfers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_gw_tr_cin7   ON public.gateway_transfers (cin7_reference) WHERE cin7_reference IS NOT NULL;

-- ── 6. transfer lines — one per SKU ────────────────────────────────────────
-- requested / allocated / moved are deliberately three separate numbers. The
-- spreadsheet collapsed them into one, which is exactly why a short pick was
-- invisible: 'Sent' and 'Left' were filled on 1 of 28 sheets.
CREATE TABLE IF NOT EXISTS public.gateway_transfer_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id   BIGINT NOT NULL REFERENCES public.gateway_transfers(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  five_dc       TEXT,
  product_name  TEXT,
  qty_requested NUMERIC(14,3) NOT NULL CHECK (qty_requested > 0),
  qty_allocated NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (qty_allocated >= 0),
  qty_moved     NUMERIC(14,3),
  uom           TEXT NOT NULL DEFAULT 'Item',
  line_no       INT,
  source        TEXT CHECK (source IN ('manual','recommendation','import')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, sku)
);
CREATE INDEX IF NOT EXISTS ix_gw_trl_transfer ON public.gateway_transfer_lines (transfer_id);

-- ── 7. allocations — the FIFO decision AND the reservation, one record ─────
CREATE TABLE IF NOT EXISTS public.gateway_transfer_allocations (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id        BIGINT NOT NULL REFERENCES public.gateway_transfers(id) ON DELETE CASCADE,
  line_id            BIGINT NOT NULL REFERENCES public.gateway_transfer_lines(id) ON DELETE CASCADE,
  lot_id             BIGINT NOT NULL REFERENCES public.gateway_lots(id),
  qty                NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  qty_picked         NUMERIC(14,3),
  state              TEXT NOT NULL DEFAULT 'reserved'
                       CHECK (state IN ('reserved','picked','consumed','released')),

  fifo_rank          INT,                  -- 1 = oldest lot available at the time
  is_fifo_override   BOOLEAN NOT NULL DEFAULT false,
  recommended_lot_id BIGINT REFERENCES public.gateway_lots(id),
  override_reason    TEXT,
  override_by        TEXT,
  override_at        TIMESTAMPTZ,

  created_by         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gw_alloc_override_has_reason CHECK
    (NOT is_fifo_override OR override_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_gw_alloc_lot      ON public.gateway_transfer_allocations (lot_id)
  WHERE state IN ('reserved','picked');
CREATE INDEX IF NOT EXISTS ix_gw_alloc_transfer ON public.gateway_transfer_allocations (transfer_id);
CREATE INDEX IF NOT EXISTS ix_gw_alloc_line     ON public.gateway_transfer_allocations (line_id);

-- ── 8. movements — the append-only ledger that explains every balance ──────
CREATE TABLE IF NOT EXISTS public.gateway_movements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id           BIGINT NOT NULL REFERENCES public.gateway_lots(id),
  sku              TEXT NOT NULL,
  movement_type    TEXT NOT NULL CHECK (movement_type IN
                     ('RECEIPT','TRANSFER_OUT','TRANSFER_OUT_REVERSAL',
                      'ADJUSTMENT_IN','ADJUSTMENT_OUT','STOCKTAKE_ADJUSTMENT',
                      'WRITE_OFF','CORRECTION')),
  -- signed against the lot: + adds, - removes. The sign is the whole ledger.
  qty              NUMERIC(14,3) NOT NULL CHECK (qty <> 0),
  qty_before       NUMERIC(14,3),
  qty_after        NUMERIC(14,3),
  uom              TEXT NOT NULL DEFAULT 'Item',

  occurred_at      TIMESTAMPTZ NOT NULL,   -- when it happened in the warehouse
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when we learned of it

  transfer_id      BIGINT REFERENCES public.gateway_transfers(id),
  allocation_id    BIGINT REFERENCES public.gateway_transfer_allocations(id),
  shelf_id         TEXT,

  source_system    TEXT NOT NULL DEFAULT 'app'
                     CHECK (source_system IN ('app','excel_migration','cin7','stocktake')),
  source_reference TEXT,
  cin7_task_id     TEXT,
  reason_code      TEXT,
  reason           TEXT,
  import_batch_id  BIGINT REFERENCES public.gateway_import_batches(id),
  metadata         JSONB NOT NULL DEFAULT '{}',

  -- the single mechanism that makes every write path safe to retry
  idempotency_key  TEXT UNIQUE,

  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gw_mv_lot      ON public.gateway_movements (lot_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_gw_mv_sku      ON public.gateway_movements (sku, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ix_gw_mv_transfer ON public.gateway_movements (transfer_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_gw_mv_occurred ON public.gateway_movements (occurred_at DESC);

-- ── 9. reconciliation issues — where we and Cin7 disagree, and why ─────────
CREATE TABLE IF NOT EXISTS public.gateway_recon_issues (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku             TEXT NOT NULL UNIQUE,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  local_qty       NUMERIC(14,3) NOT NULL,
  cin7_qty        NUMERIC(14,3) NOT NULL,
  difference      NUMERIC(14,3) NOT NULL,
  cin7_synced_at  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','investigating','resolved','accepted')),
  cause_code      TEXT CHECK (cause_code IN
                    ('cin7_transfer_not_recorded','local_movement_not_in_cin7','stocktake',
                     'duplicate_movement','bad_opening_balance','timing','wrong_location','unknown')),
  resolution_note TEXT,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_gw_recon_status ON public.gateway_recon_issues (status, last_seen_at DESC);

-- ── 10. audit log — house style, mirrors public.pick_anomaly_logs ──────────
CREATE TABLE IF NOT EXISTS public.gateway_audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,               -- lot | transfer | allocation | recon | import | settings
  entity_id   TEXT,
  action      TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}',
  user_name   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gw_audit_entity ON public.gateway_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_gw_audit_time   ON public.gateway_audit_log (created_at DESC);
