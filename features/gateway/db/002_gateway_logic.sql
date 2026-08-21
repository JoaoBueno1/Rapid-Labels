-- ============================================================================
-- Gateway Inventory — triggers, FIFO engine, transactional RPCs, views
-- File: features/gateway/db/002_gateway_logic.sql
-- Apply: Supabase Dashboard -> SQL Editor (paste whole file). Idempotent.
-- Requires: 001_gateway_inventory.sql
--
-- Everything that touches more than one row lives here rather than in Node.
-- PostgREST has no transaction: two REST calls cannot be made atomic from the
-- outside, and the old engine proved the cost — it wrote the ERP first, then
-- patched the shelf map in a loop of independent calls inside empty catch
-- blocks, and returned success unconditionally. A plpgsql function is a
-- transaction and can take row locks, so allocation, posting and cancellation
-- are single calls that either fully happen or fully do not.
-- ============================================================================

-- ── generic updated_at ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gateway_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_gw_lots_touch      ON public.gateway_lots;
CREATE TRIGGER trg_gw_lots_touch      BEFORE UPDATE ON public.gateway_lots
  FOR EACH ROW EXECUTE FUNCTION public.gateway_touch_updated_at();
DROP TRIGGER IF EXISTS trg_gw_tr_touch        ON public.gateway_transfers;
CREATE TRIGGER trg_gw_tr_touch        BEFORE UPDATE ON public.gateway_transfers
  FOR EACH ROW EXECUTE FUNCTION public.gateway_touch_updated_at();
DROP TRIGGER IF EXISTS trg_gw_alloc_touch     ON public.gateway_transfer_allocations;
CREATE TRIGGER trg_gw_alloc_touch     BEFORE UPDATE ON public.gateway_transfer_allocations
  FOR EACH ROW EXECUTE FUNCTION public.gateway_touch_updated_at();
DROP TRIGGER IF EXISTS trg_gw_shelves_touch   ON public.gateway_shelves;
CREATE TRIGGER trg_gw_shelves_touch   BEFORE UPDATE ON public.gateway_shelves
  FOR EACH ROW EXECUTE FUNCTION public.gateway_touch_updated_at();

-- ── the ledger is append-only ──────────────────────────────────────────────
-- A wrong movement is corrected by posting a corrective movement, never by
-- editing history until the balance looks right.
--
-- The one exception is undoing an import. A batch that was only ever a bad
-- read of a spreadsheet has no history worth protecting, and a half-imported
-- ledger must not be left in place. That escape hatch is a transaction-local
-- GUC set only by gateway_rollback_import, so it cannot be left switched on:
-- SET LOCAL dies with the transaction whether it commits or not.
CREATE OR REPLACE FUNCTION public.gateway_movements_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('gateway.purge_import', true), '') = 'on'
     AND OLD.import_batch_id IS NOT NULL THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'gateway_movements is append-only (attempted %). Post a corrective movement instead.', TG_OP
    USING ERRCODE = 'check_violation';
END $fn$;

DROP TRIGGER IF EXISTS trg_gw_mv_no_update ON public.gateway_movements;
CREATE TRIGGER trg_gw_mv_no_update BEFORE UPDATE OR DELETE ON public.gateway_movements
  FOR EACH ROW EXECUTE FUNCTION public.gateway_movements_immutable();

-- ── a movement moves the lot it points at ──────────────────────────────────
-- BEFORE INSERT so qty_before/qty_after are stamped from the locked row, and
-- the lot UPDATE takes the row lock that serialises concurrent posters.
CREATE OR REPLACE FUNCTION public.gateway_movement_apply()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  v_before   NUMERIC(14,3);
  v_after    NUMERIC(14,3);
  v_received NUMERIC(14,3);
  v_sku      TEXT;
BEGIN
  SELECT qty_remaining, qty_received, sku
    INTO v_before, v_received, v_sku
    FROM public.gateway_lots WHERE id = NEW.lot_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway lot % does not exist', NEW.lot_id USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_after := v_before + NEW.qty;

  IF v_after < 0 THEN
    RAISE EXCEPTION
      'movement of % would take lot % (%) below zero: remaining is %',
      NEW.qty, NEW.lot_id, v_sku, v_before USING ERRCODE = 'check_violation';
  END IF;

  -- Going back ABOVE the original receipt is refused on purpose. A lot is one
  -- physical arrival; stock that was never part of it belongs to a new lot
  -- (source_type 'found' or 'correction') so its own date survives.
  IF v_after > v_received THEN
    RAISE EXCEPTION
      'movement of % would take lot % (%) to %, above its received qty of %. Record a new lot instead.',
      NEW.qty, NEW.lot_id, v_sku, v_after, v_received USING ERRCODE = 'check_violation';
  END IF;

  NEW.qty_before := v_before;
  NEW.qty_after  := v_after;
  IF NEW.sku IS NULL THEN NEW.sku := v_sku; END IF;

  UPDATE public.gateway_lots
     SET qty_remaining = v_after,
         status = CASE WHEN v_after = 0 AND status = 'open' THEN 'depleted'
                       WHEN v_after > 0 AND status = 'depleted' THEN 'open'
                       ELSE status END
   WHERE id = NEW.lot_id;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_gw_mv_apply ON public.gateway_movements;
CREATE TRIGGER trg_gw_mv_apply BEFORE INSERT ON public.gateway_movements
  FOR EACH ROW EXECUTE FUNCTION public.gateway_movement_apply();

-- ── an allocation reserves the lot it points at ────────────────────────────
-- qty_reserved is always recomputed from the allocation rows, never
-- incremented, so it cannot drift.
CREATE OR REPLACE FUNCTION public.gateway_sync_lot_reserved()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE v_lot BIGINT;
BEGIN
  FOR v_lot IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.lot_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.lot_id END]) AS t(x)
    WHERE x IS NOT NULL
  LOOP
    UPDATE public.gateway_lots l
       SET qty_reserved = COALESCE((
             SELECT SUM(a.qty) FROM public.gateway_transfer_allocations a
              WHERE a.lot_id = v_lot AND a.state IN ('reserved','picked')), 0)
     WHERE l.id = v_lot;
  END LOOP;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_gw_alloc_reserve ON public.gateway_transfer_allocations;
CREATE TRIGGER trg_gw_alloc_reserve AFTER INSERT OR UPDATE OR DELETE ON public.gateway_transfer_allocations
  FOR EACH ROW EXECUTE FUNCTION public.gateway_sync_lot_reserved();

-- ── keep line.qty_allocated in step with its allocations ───────────────────
CREATE OR REPLACE FUNCTION public.gateway_sync_line_allocated()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE v_line BIGINT;
BEGIN
  FOR v_line IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.line_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.line_id END]) AS t(x)
    WHERE x IS NOT NULL
  LOOP
    UPDATE public.gateway_transfer_lines tl
       SET qty_allocated = COALESCE((
             SELECT SUM(a.qty) FROM public.gateway_transfer_allocations a
              WHERE a.line_id = v_line AND a.state IN ('reserved','picked','consumed')), 0)
     WHERE tl.id = v_line;
  END LOOP;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_gw_alloc_line_sync ON public.gateway_transfer_allocations;
CREATE TRIGGER trg_gw_alloc_line_sync AFTER INSERT OR UPDATE OR DELETE ON public.gateway_transfer_allocations
  FOR EACH ROW EXECUTE FUNCTION public.gateway_sync_line_allocated();

-- ══════════════════════════════════════════════════════════════════════════
-- FIFO
-- ══════════════════════════════════════════════════════════════════════════

-- Cin7 SKUs are mixed case and the case is NOT decorative: '12V-IP20-030W' is
-- typed by people, but Cin7 holds it as '12v-IP20-030w'. 276 of the first 1000
-- products carry lower-case letters. Upper-casing on the way in silently
-- breaks every join to cin7_mirror.products and makes reconciliation report a
-- phantom difference, so every SKU is resolved to Cin7's own spelling here.
-- An unknown SKU is kept verbatim rather than rejected — the warehouse can
-- hold something the mirror has not caught up with — and the reconciliation
-- view is what surfaces it.
CREATE OR REPLACE FUNCTION public.gateway_resolve_sku(p_sku TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $fn$
DECLARE v_sku TEXT; v_n INT;
BEGIN
  IF p_sku IS NULL OR btrim(p_sku) = '' THEN
    RAISE EXCEPTION 'sku is required' USING ERRCODE = 'check_violation';
  END IF;
  p_sku := btrim(p_sku);

  SELECT sku INTO v_sku FROM cin7_mirror.products WHERE sku = p_sku;
  IF FOUND THEN RETURN v_sku; END IF;

  SELECT count(*), min(sku) INTO v_n, v_sku
    FROM cin7_mirror.products WHERE lower(sku) = lower(p_sku);
  IF v_n = 1 THEN RETURN v_sku; END IF;

  RETURN p_sku;
END $fn$;


-- Undated lots exist only because migration found that stock already sitting
-- in Gateway, so they ARE old. Default policy ranks them first, which drains
-- the ambiguity instead of preserving it. Configurable in gateway_settings.
CREATE OR REPLACE FUNCTION public.gateway_fifo_sort_date(p_received DATE)
RETURNS DATE LANGUAGE sql STABLE AS $fn$
  SELECT COALESCE(
    p_received,
    CASE WHEN (SELECT value FROM public.gateway_settings WHERE key = 'fifo_unknown_policy') = 'newest'
         THEN DATE '9999-12-31' ELSE DATE '1900-01-01' END);
$fn$;

-- The queue a picker should work down for one SKU: oldest first, only what is
-- genuinely free (remaining minus anything another transfer already holds).
DROP FUNCTION IF EXISTS public.gateway_fifo_queue(TEXT);
CREATE FUNCTION public.gateway_fifo_queue(p_sku TEXT)
RETURNS TABLE (
  fifo_rank       INT,
  lot_id          BIGINT,
  received_on     DATE,
  date_confidence TEXT,
  age_days        INT,
  shelf_id        TEXT,
  shelf_text      TEXT,
  pallet_number   TEXT,
  qty_received    NUMERIC,
  qty_remaining   NUMERIC,
  qty_reserved    NUMERIC,
  qty_available   NUMERIC,
  source_reference TEXT
) LANGUAGE sql STABLE AS $fn$
  SELECT ROW_NUMBER() OVER (ORDER BY public.gateway_fifo_sort_date(l.received_on), l.id)::INT,
         l.id, l.received_on, l.date_confidence,
         CASE WHEN l.received_on IS NULL THEN NULL
              ELSE (CURRENT_DATE - l.received_on)::INT END,
         l.shelf_id, l.shelf_text, l.pallet_number,
         l.qty_received, l.qty_remaining, l.qty_reserved,
         (l.qty_remaining - l.qty_reserved),
         l.source_reference
    FROM public.gateway_lots l
   WHERE l.sku = public.gateway_resolve_sku(p_sku)
     AND l.status = 'open'
     AND (l.qty_remaining - l.qty_reserved) > 0
   ORDER BY public.gateway_fifo_sort_date(l.received_on), l.id;
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- Transactional operations
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.gateway_next_transfer_no()
RETURNS TEXT LANGUAGE sql VOLATILE AS $fn$
  SELECT 'GT-' || lpad(nextval('public.gateway_transfer_no_seq')::TEXT, 6, '0');
$fn$;

-- Record a receipt: creates the lot AND its opening RECEIPT movement together,
-- so a lot can never exist without the event that explains it.
DROP FUNCTION IF EXISTS public.gateway_create_lot(JSONB);
CREATE FUNCTION public.gateway_create_lot(p JSONB)
RETURNS BIGINT LANGUAGE plpgsql AS $fn$
DECLARE
  v_lot   BIGINT;
  v_qty   NUMERIC(14,3) := (p->>'qty_received')::NUMERIC;
  v_date  DATE          := NULLIF(p->>'received_on','')::DATE;
  v_src   TEXT          := COALESCE(p->>'source_type','transfer_in');
  v_conf  TEXT          := CASE WHEN NULLIF(p->>'received_on','') IS NULL THEN 'unknown'
                                ELSE COALESCE(NULLIF(p->>'date_confidence',''),'exact') END;
  v_user  TEXT          := COALESCE(p->>'created_by','system');
  v_sku   TEXT          := public.gateway_resolve_sku(p->>'sku');
BEGIN
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'qty_received must be greater than zero' USING ERRCODE = 'check_violation';
  END IF;

  -- The lot opens EMPTY and the RECEIPT movement fills it. That way the
  -- opening balance is itself a ledger entry rather than a number that
  -- happens to agree with one.
  INSERT INTO public.gateway_lots (
    sku, five_dc, product_name, received_on, qty_received, qty_remaining, uom,
    source_type, source_reference, cin7_task_id, shelf_id, shelf_text, pallet_number,
    date_confidence, source_system, import_batch_id, import_row_ref, notes, created_by, updated_by)
  VALUES (
    v_sku, p->>'five_dc', p->>'product_name', v_date, v_qty, 0,
    COALESCE(NULLIF(p->>'uom',''),'Item'),
    v_src, NULLIF(p->>'source_reference',''), NULLIF(p->>'cin7_task_id',''),
    NULLIF(p->>'shelf_id',''), NULLIF(p->>'shelf_text',''), NULLIF(p->>'pallet_number',''),
    v_conf, COALESCE(NULLIF(p->>'source_system',''),'app'),
    NULLIF(p->>'import_batch_id','')::BIGINT, NULLIF(p->>'import_row_ref',''),
    NULLIF(p->>'notes',''), v_user, v_user)
  RETURNING id INTO v_lot;

  INSERT INTO public.gateway_movements (
    lot_id, sku, movement_type, qty, uom, occurred_at, shelf_id,
    source_system, source_reference, cin7_task_id, reason, import_batch_id,
    idempotency_key, created_by, metadata)
  VALUES (
    v_lot, v_sku, 'RECEIPT', v_qty, COALESCE(NULLIF(p->>'uom',''),'Item'),
    COALESCE(NULLIF(p->>'occurred_at','')::TIMESTAMPTZ,
             (COALESCE(v_date, CURRENT_DATE)::TIMESTAMP AT TIME ZONE 'Australia/Brisbane')),
    NULLIF(p->>'shelf_id',''),
    COALESCE(NULLIF(p->>'source_system',''),'app'),
    NULLIF(p->>'source_reference',''), NULLIF(p->>'cin7_task_id',''),
    NULLIF(p->>'notes',''), NULLIF(p->>'import_batch_id','')::BIGINT,
    NULLIF(p->>'idempotency_key',''), v_user,
    COALESCE(p->'metadata','{}'::JSONB));

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('lot', v_lot::TEXT, 'lot_created',
          jsonb_build_object('sku', v_sku, 'qty', v_qty, 'received_on', v_date,
                             'source_type', v_src, 'reference', p->>'source_reference'), v_user);

  RETURN v_lot;
END $fn$;

-- FIFO-allocate one transfer line. Locks the candidate lots in FIFO order, so
-- two operators building transfers against the same SKU serialise instead of
-- both succeeding against the same units.
DROP FUNCTION IF EXISTS public.gateway_allocate_line(BIGINT, NUMERIC, TEXT);
CREATE FUNCTION public.gateway_allocate_line(
  p_line_id BIGINT, p_qty NUMERIC DEFAULT NULL, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE
  v_line     public.gateway_transfer_lines%ROWTYPE;
  v_target   NUMERIC(14,3);
  v_left     NUMERIC(14,3);
  v_rank     INT := 0;
  v_lot      RECORD;
  v_take     NUMERIC(14,3);
  v_made     INT := 0;
  v_status   TEXT;
BEGIN
  SELECT * INTO v_line FROM public.gateway_transfer_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer line % not found', p_line_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT status INTO v_status FROM public.gateway_transfers WHERE id = v_line.transfer_id FOR UPDATE;
  IF v_status NOT IN ('draft','ready_for_cin7') THEN
    RAISE EXCEPTION 'transfer is % — allocations can only change while draft or ready_for_cin7', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_target := COALESCE(p_qty, v_line.qty_requested - v_line.qty_allocated);
  IF v_target <= 0 THEN
    RETURN jsonb_build_object('allocated', 0, 'shortfall', 0, 'allocations', 0);
  END IF;
  v_left := v_target;

  FOR v_lot IN
    SELECT l.id, l.received_on, l.qty_remaining, l.qty_reserved
      FROM public.gateway_lots l
     WHERE l.sku = v_line.sku AND l.status = 'open'
       AND (l.qty_remaining - l.qty_reserved) > 0
     ORDER BY public.gateway_fifo_sort_date(l.received_on), l.id
     FOR UPDATE OF l
  LOOP
    EXIT WHEN v_left <= 0;
    v_rank := v_rank + 1;
    v_take := LEAST(v_left, v_lot.qty_remaining - v_lot.qty_reserved);
    CONTINUE WHEN v_take <= 0;

    INSERT INTO public.gateway_transfer_allocations
      (transfer_id, line_id, lot_id, qty, fifo_rank, created_by)
    VALUES (v_line.transfer_id, p_line_id, v_lot.id, v_take, v_rank, p_user);

    v_left := v_left - v_take;
    v_made := v_made + 1;
  END LOOP;

  PERFORM public.gateway_refresh_fifo_flag(v_line.transfer_id);

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('transfer', v_line.transfer_id::TEXT, 'line_allocated',
          jsonb_build_object('line_id', p_line_id, 'sku', v_line.sku,
                             'requested', v_target, 'allocated', v_target - v_left,
                             'shortfall', v_left, 'lots', v_made), p_user);

  RETURN jsonb_build_object(
    'allocated', v_target - v_left, 'shortfall', v_left, 'allocations', v_made);
END $fn$;

-- Deliberately take a lot other than the one FIFO chose. The recommendation is
-- stored alongside the choice so the override is answerable later.
DROP FUNCTION IF EXISTS public.gateway_allocate_override(BIGINT, BIGINT, NUMERIC, TEXT, TEXT);
CREATE FUNCTION public.gateway_allocate_override(
  p_line_id BIGINT, p_lot_id BIGINT, p_qty NUMERIC, p_reason TEXT, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE
  v_line      public.gateway_transfer_lines%ROWTYPE;
  v_avail     NUMERIC(14,3);
  v_lot_sku   TEXT;
  v_recommend BIGINT;
  v_status    TEXT;
  v_alloc     BIGINT;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a FIFO override needs a reason' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.gateway_transfer_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer line % not found', p_line_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT status INTO v_status FROM public.gateway_transfers WHERE id = v_line.transfer_id FOR UPDATE;
  IF v_status NOT IN ('draft','ready_for_cin7') THEN
    RAISE EXCEPTION 'transfer is % — allocations can only change while draft or ready_for_cin7', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sku, (qty_remaining - qty_reserved) INTO v_lot_sku, v_avail
    FROM public.gateway_lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot % not found', p_lot_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_lot_sku <> v_line.sku THEN
    RAISE EXCEPTION 'lot % holds % but the line is for %', p_lot_id, v_lot_sku, v_line.sku
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_qty > v_avail THEN
    RAISE EXCEPTION 'lot % has % available, cannot allocate %', p_lot_id, v_avail, p_qty
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT lot_id INTO v_recommend FROM public.gateway_fifo_queue(v_line.sku) WHERE fifo_rank = 1;

  INSERT INTO public.gateway_transfer_allocations
    (transfer_id, line_id, lot_id, qty, is_fifo_override, recommended_lot_id,
     override_reason, override_by, override_at, created_by)
  VALUES (v_line.transfer_id, p_line_id, p_lot_id, p_qty,
          (v_recommend IS DISTINCT FROM p_lot_id), v_recommend,
          p_reason, p_user, now(), p_user)
  RETURNING id INTO v_alloc;

  PERFORM public.gateway_refresh_fifo_flag(v_line.transfer_id);

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('allocation', v_alloc::TEXT, 'fifo_override',
          jsonb_build_object('line_id', p_line_id, 'sku', v_line.sku, 'qty', p_qty,
                             'chosen_lot', p_lot_id, 'recommended_lot', v_recommend,
                             'reason', p_reason), p_user);

  RETURN jsonb_build_object('allocation_id', v_alloc, 'allocated', p_qty,
                            'recommended_lot_id', v_recommend,
                            'is_override', (v_recommend IS DISTINCT FROM p_lot_id));
END $fn$;

CREATE OR REPLACE FUNCTION public.gateway_refresh_fifo_flag(p_transfer_id BIGINT)
RETURNS VOID LANGUAGE sql VOLATILE AS $fn$
  UPDATE public.gateway_transfers t
     SET fifo_compliant = NOT EXISTS (
           SELECT 1 FROM public.gateway_transfer_allocations a
            WHERE a.transfer_id = p_transfer_id
              AND a.is_fifo_override
              AND a.state <> 'released')
   WHERE t.id = p_transfer_id;
$fn$;

-- Release reservations without inventing a physical movement. A transfer that
-- was planned and never happened must free its stock and leave no trace of a
-- move that did not occur — that is a different thing from stock coming back.
DROP FUNCTION IF EXISTS public.gateway_cancel_transfer(BIGINT, TEXT, TEXT);
CREATE FUNCTION public.gateway_cancel_transfer(
  p_transfer_id BIGINT, p_reason TEXT, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_status TEXT; v_released INT;
BEGIN
  SELECT status INTO v_status FROM public.gateway_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer % not found', p_transfer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status IN ('completed','cancelled') THEN
    RAISE EXCEPTION 'transfer is already %', v_status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.gateway_transfer_allocations
     SET state = 'released'
   WHERE transfer_id = p_transfer_id AND state IN ('reserved','picked');
  GET DIAGNOSTICS v_released = ROW_COUNT;

  UPDATE public.gateway_transfers
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_user,
         cancel_reason = p_reason, updated_by = p_user
   WHERE id = p_transfer_id;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('transfer', p_transfer_id::TEXT, 'cancelled',
          jsonb_build_object('reason', p_reason, 'allocations_released', v_released,
                             'previous_status', v_status), p_user);

  RETURN jsonb_build_object('cancelled', true, 'allocations_released', v_released);
END $fn$;

-- Post the transfer: turn reservations into real movements. p_picked lets the
-- warehouse report a short pick per allocation ([{"allocation_id":1,"qty":8}]);
-- anything not picked is simply released rather than silently moved.
DROP FUNCTION IF EXISTS public.gateway_post_transfer(BIGINT, JSONB, TIMESTAMPTZ, TEXT);
CREATE FUNCTION public.gateway_post_transfer(
  p_transfer_id BIGINT,
  p_picked      JSONB DEFAULT NULL,
  p_occurred_at TIMESTAMPTZ DEFAULT NULL,
  p_user        TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE
  v_tr        public.gateway_transfers%ROWTYPE;
  v_when      TIMESTAMPTZ;
  v_alloc     RECORD;
  v_line      RECORD;
  v_qty       NUMERIC(14,3);
  v_moves     INT := 0;
  v_lots      INT := 0;
  v_new_lot   BIGINT;
BEGIN
  SELECT * INTO v_tr FROM public.gateway_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer % not found', p_transfer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_tr.status = 'completed' THEN
    -- idempotent: posting twice is a no-op, not a second stock movement
    RETURN jsonb_build_object('already_completed', true, 'movements', 0);
  END IF;
  IF v_tr.status = 'cancelled' THEN
    RAISE EXCEPTION 'transfer % is cancelled', p_transfer_id USING ERRCODE = 'check_violation';
  END IF;

  v_when := COALESCE(p_occurred_at, now());

  IF v_tr.direction = 'gateway_to_main' THEN
    FOR v_alloc IN
      SELECT a.id, a.lot_id, a.qty, a.line_id, l.sku, l.shelf_id, l.uom
        FROM public.gateway_transfer_allocations a
        JOIN public.gateway_lots l ON l.id = a.lot_id
       WHERE a.transfer_id = p_transfer_id AND a.state IN ('reserved','picked')
       -- Same lock order as gateway_allocate_line. Taking lot locks in a
       -- different order there and here is how two concurrent sessions
       -- deadlock, so both walk lots oldest-first.
       ORDER BY public.gateway_fifo_sort_date(l.received_on), a.lot_id
       FOR UPDATE OF a
    LOOP
      v_qty := COALESCE(
        (SELECT (e->>'qty')::NUMERIC FROM jsonb_array_elements(COALESCE(p_picked,'[]'::JSONB)) e
          WHERE (e->>'allocation_id')::BIGINT = v_alloc.id),
        v_alloc.qty);

      IF v_qty > v_alloc.qty THEN
        RAISE EXCEPTION 'allocation % picked % but only % was reserved', v_alloc.id, v_qty, v_alloc.qty
          USING ERRCODE = 'check_violation';
      END IF;

      -- Consume the allocation BEFORE writing the movement. The movement
      -- lowers qty_remaining, and while the allocation is still 'reserved'
      -- the lot would momentarily hold a reservation larger than its own
      -- balance, which gw_lots_reserved_le_remaining refuses. Releasing
      -- first means the two numbers never cross.
      UPDATE public.gateway_transfer_allocations
         SET state = 'consumed', qty_picked = v_qty WHERE id = v_alloc.id;

      IF v_qty > 0 THEN
        INSERT INTO public.gateway_movements (
          lot_id, sku, movement_type, qty, uom, occurred_at, transfer_id, allocation_id,
          shelf_id, source_system, source_reference, cin7_task_id, created_by, idempotency_key)
        VALUES (
          v_alloc.lot_id, v_alloc.sku, 'TRANSFER_OUT', -v_qty, v_alloc.uom, v_when,
          p_transfer_id, v_alloc.id, v_alloc.shelf_id, 'app',
          COALESCE(v_tr.cin7_reference, v_tr.transfer_no), v_tr.cin7_task_id, p_user,
          'gw:post:' || p_transfer_id || ':alloc:' || v_alloc.id);
        v_moves := v_moves + 1;
      END IF;
    END LOOP;

    UPDATE public.gateway_transfer_lines tl
       SET qty_moved = COALESCE((
             SELECT SUM(a.qty_picked) FROM public.gateway_transfer_allocations a
              WHERE a.line_id = tl.id AND a.state = 'consumed'), 0)
     WHERE tl.transfer_id = p_transfer_id;

  ELSE
    -- main_to_gateway: arriving stock BECOMES lots, dated by this posting.
    FOR v_line IN
      SELECT * FROM public.gateway_transfer_lines WHERE transfer_id = p_transfer_id
    LOOP
      v_qty := COALESCE(
        (SELECT (e->>'qty')::NUMERIC FROM jsonb_array_elements(COALESCE(p_picked,'[]'::JSONB)) e
          WHERE (e->>'line_id')::BIGINT = v_line.id),
        v_line.qty_requested);
      CONTINUE WHEN v_qty IS NULL OR v_qty <= 0;

      v_new_lot := public.gateway_create_lot(jsonb_build_object(
        'sku', v_line.sku, 'five_dc', v_line.five_dc, 'product_name', v_line.product_name,
        'received_on', (v_when AT TIME ZONE 'Australia/Brisbane')::DATE,
        'qty_received', v_qty, 'uom', v_line.uom,
        'source_type', 'transfer_in',
        'source_reference', COALESCE(v_tr.cin7_reference, v_tr.transfer_no),
        'cin7_task_id', v_tr.cin7_task_id,
        'occurred_at', v_when, 'created_by', p_user,
        'idempotency_key', 'gw:post:' || p_transfer_id || ':line:' || v_line.id));

      UPDATE public.gateway_transfer_lines SET qty_moved = v_qty WHERE id = v_line.id;
      v_lots  := v_lots + 1;
      v_moves := v_moves + 1;
    END LOOP;
  END IF;

  UPDATE public.gateway_transfers
     SET status = 'completed', completed_at = v_when, completed_by = p_user, updated_by = p_user
   WHERE id = p_transfer_id;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('transfer', p_transfer_id::TEXT, 'posted',
          jsonb_build_object('direction', v_tr.direction, 'movements', v_moves,
                             'lots_created', v_lots, 'occurred_at', v_when), p_user);

  RETURN jsonb_build_object('completed', true, 'movements', v_moves, 'lots_created', v_lots);
END $fn$;

-- Correct a lot without destroying what it used to say.
DROP FUNCTION IF EXISTS public.gateway_adjust_lot(BIGINT, NUMERIC, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.gateway_adjust_lot(
  p_lot_id BIGINT, p_delta NUMERIC, p_reason_code TEXT, p_reason TEXT,
  p_reference TEXT DEFAULT NULL, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_type TEXT; v_sku TEXT; v_after NUMERIC(14,3); v_id BIGINT;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'an adjustment of zero changes nothing' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'an adjustment needs a reason' USING ERRCODE = 'check_violation';
  END IF;

  v_type := CASE
    WHEN p_reason_code = 'stocktake' THEN 'STOCKTAKE_ADJUSTMENT'
    WHEN p_reason_code = 'write_off' THEN 'WRITE_OFF'
    WHEN p_delta > 0 THEN 'ADJUSTMENT_IN' ELSE 'ADJUSTMENT_OUT' END;

  SELECT sku INTO v_sku FROM public.gateway_lots WHERE id = p_lot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot % not found', p_lot_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.gateway_movements (
    lot_id, sku, movement_type, qty, occurred_at, source_system,
    source_reference, reason_code, reason, created_by)
  VALUES (p_lot_id, v_sku, v_type, p_delta, now(), 'app',
          p_reference, p_reason_code, p_reason, p_user)
  RETURNING id, qty_after INTO v_id, v_after;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('lot', p_lot_id::TEXT, 'adjusted',
          jsonb_build_object('delta', p_delta, 'reason_code', p_reason_code,
                             'reason', p_reason, 'new_qty', v_after, 'movement_id', v_id), p_user);

  RETURN jsonb_build_object('movement_id', v_id, 'new_qty', v_after);
END $fn$;

-- Stock physically coming BACK from Main into a lot it left. Distinct from
-- cancelling a transfer that never moved.
DROP FUNCTION IF EXISTS public.gateway_reverse_transfer_line(BIGINT, NUMERIC, TEXT, TEXT);
CREATE FUNCTION public.gateway_reverse_transfer_line(
  p_allocation_id BIGINT, p_qty NUMERIC, p_reason TEXT, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_a RECORD; v_moved NUMERIC(14,3); v_id BIGINT;
BEGIN
  SELECT a.*, l.sku, l.shelf_id INTO v_a
    FROM public.gateway_transfer_allocations a
    JOIN public.gateway_lots l ON l.id = a.lot_id
   WHERE a.id = p_allocation_id FOR UPDATE OF a;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation % not found', p_allocation_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_a.state <> 'consumed' THEN
    RAISE EXCEPTION 'allocation % is %, only a consumed allocation can be reversed', p_allocation_id, v_a.state
      USING ERRCODE = 'check_violation';
  END IF;

  v_moved := COALESCE(v_a.qty_picked, v_a.qty);
  IF p_qty <= 0 OR p_qty > v_moved THEN
    RAISE EXCEPTION 'can reverse between 0 and % units, got %', v_moved, p_qty
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.gateway_movements (
    lot_id, sku, movement_type, qty, occurred_at, transfer_id, allocation_id,
    shelf_id, source_system, reason_code, reason, created_by)
  VALUES (v_a.lot_id, v_a.sku, 'TRANSFER_OUT_REVERSAL', p_qty, now(),
          v_a.transfer_id, p_allocation_id, v_a.shelf_id, 'app',
          'return_to_gateway', p_reason, p_user)
  RETURNING id INTO v_id;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('allocation', p_allocation_id::TEXT, 'reversed',
          jsonb_build_object('qty', p_qty, 'reason', p_reason, 'movement_id', v_id), p_user);

  RETURN jsonb_build_object('movement_id', v_id, 'reversed', p_qty);
END $fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- Views
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.gateway_v_lots AS
SELECT l.id, l.sku, l.five_dc,
       COALESCE(l.product_name, p.name)          AS product_name,
       l.received_on, l.date_confidence,
       CASE WHEN l.received_on IS NULL THEN NULL ELSE (CURRENT_DATE - l.received_on)::INT END AS age_days,
       public.gateway_fifo_sort_date(l.received_on) AS fifo_sort_date,
       l.qty_received, l.qty_remaining, l.qty_reserved,
       (l.qty_remaining - l.qty_reserved)         AS qty_available,
       l.uom, l.source_type, l.source_reference, l.cin7_task_id,
       l.shelf_id, l.shelf_text, l.pallet_number,
       s.area AS shelf_area, s.pick_sequence,
       l.status, l.source_system, l.import_batch_id, l.notes,
       l.created_by, l.created_at, l.updated_at
  FROM public.gateway_lots l
  LEFT JOIN public.gateway_shelves s ON s.id = l.shelf_id
  LEFT JOIN cin7_mirror.products  p ON p.sku = l.sku;

CREATE OR REPLACE VIEW public.gateway_v_sku_balance AS
SELECT l.sku,
       max(l.five_dc)                                   AS five_dc,
       max(COALESCE(l.product_name, p.name))            AS product_name,
       count(*) FILTER (WHERE l.qty_remaining > 0)      AS open_lots,
       SUM(l.qty_remaining)                             AS qty_on_hand,
       SUM(l.qty_reserved)                              AS qty_reserved,
       SUM(l.qty_remaining - l.qty_reserved)            AS qty_available,
       min(l.received_on) FILTER (WHERE l.qty_remaining > 0)          AS oldest_received_on,
       max(l.received_on) FILTER (WHERE l.qty_remaining > 0)          AS newest_received_on,
       count(*) FILTER (WHERE l.qty_remaining > 0 AND l.received_on IS NULL) AS undated_lots,
       CASE WHEN min(l.received_on) FILTER (WHERE l.qty_remaining > 0) IS NULL THEN NULL
            ELSE (CURRENT_DATE - min(l.received_on) FILTER (WHERE l.qty_remaining > 0))::INT END AS oldest_age_days,
       string_agg(DISTINCT l.shelf_id, ', ' ORDER BY l.shelf_id)
         FILTER (WHERE l.qty_remaining > 0)             AS shelves
  FROM public.gateway_lots l
  LEFT JOIN cin7_mirror.products p ON p.sku = l.sku
 WHERE l.status <> 'written_off'
 GROUP BY l.sku;

-- Local ledger vs Cin7's Gateway total. A FULL OUTER JOIN because both
-- directions are real findings: stock we know about that Cin7 does not, and
-- stock Cin7 holds that never got a lot.
CREATE OR REPLACE VIEW public.gateway_v_reconciliation AS
WITH cin7 AS (
  SELECT s.sku,
         SUM(s.on_hand)   AS cin7_qty,
         max(s.synced_at) AS cin7_synced_at,
         max(s.product_name) AS cin7_product_name
    FROM cin7_mirror.stock_snapshot s
   WHERE s.location_name = 'Gateway'
   GROUP BY s.sku
)
SELECT COALESCE(b.sku, c.sku)                       AS sku,
       COALESCE(b.product_name, c.cin7_product_name) AS product_name,
       b.five_dc,
       COALESCE(b.qty_on_hand, 0)                   AS local_qty,
       COALESCE(c.cin7_qty, 0)                      AS cin7_qty,
       COALESCE(c.cin7_qty, 0) - COALESCE(b.qty_on_hand, 0) AS difference,
       b.open_lots, b.oldest_received_on, b.oldest_age_days, b.undated_lots, b.shelves,
       c.cin7_synced_at,
       CASE WHEN b.sku IS NULL              THEN 'cin7_only'
            WHEN c.sku IS NULL              THEN 'local_only'
            WHEN COALESCE(c.cin7_qty,0) = COALESCE(b.qty_on_hand,0) THEN 'match'
            ELSE 'mismatch' END              AS state,
       i.status     AS issue_status,
       i.cause_code AS issue_cause,
       i.id         AS issue_id
  FROM public.gateway_v_sku_balance b
  FULL OUTER JOIN cin7 c ON c.sku = b.sku
  LEFT JOIN public.gateway_recon_issues i ON i.sku = COALESCE(b.sku, c.sku);

CREATE OR REPLACE VIEW public.gateway_v_transfers AS
SELECT t.*,
       (SELECT count(*) FROM public.gateway_transfer_lines tl WHERE tl.transfer_id = t.id) AS line_count,
       (SELECT COALESCE(SUM(tl.qty_requested),0) FROM public.gateway_transfer_lines tl WHERE tl.transfer_id = t.id) AS qty_requested,
       (SELECT COALESCE(SUM(tl.qty_allocated),0) FROM public.gateway_transfer_lines tl WHERE tl.transfer_id = t.id) AS qty_allocated,
       (SELECT COALESCE(SUM(tl.qty_moved),0)     FROM public.gateway_transfer_lines tl WHERE tl.transfer_id = t.id) AS qty_moved,
       (SELECT count(*) FROM public.gateway_transfer_allocations a
         WHERE a.transfer_id = t.id AND a.is_fifo_override AND a.state <> 'released') AS override_count
  FROM public.gateway_transfers t;

-- ══════════════════════════════════════════════════════════════════════════
-- Security: anon reads dashboards, only service_role writes.
-- The previous module granted anon FOR ALL on every gateway table while the
-- anon key sits in a publicly-served file, so anyone who could load the page
-- could delete the shelf map with curl. Reads stay open because every other
-- page in this app reads browser-direct; writes go through the engine.
-- ══════════════════════════════════════════════════════════════════════════
DO $sec$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gateway_lots','gateway_movements','gateway_transfers','gateway_transfer_lines',
    'gateway_transfer_allocations','gateway_import_batches','gateway_import_issues',
    'gateway_recon_issues','gateway_audit_log','gateway_settings','gateway_shelves']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read',  t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_write', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon, authenticated USING (true)', t || '_read', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $sec$;

GRANT SELECT ON public.gateway_v_lots, public.gateway_v_sku_balance,
                public.gateway_v_reconciliation, public.gateway_v_transfers
  TO anon, authenticated, service_role;

GRANT USAGE, SELECT ON SEQUENCE public.gateway_transfer_no_seq TO service_role;

-- RPCs are service_role only: they move stock.
REVOKE ALL ON FUNCTION public.gateway_create_lot(JSONB)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_allocate_line(BIGINT, NUMERIC, TEXT)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_allocate_override(BIGINT, BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_cancel_transfer(BIGINT, TEXT, TEXT)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_post_transfer(BIGINT, JSONB, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_adjust_lot(BIGINT, NUMERIC, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_reverse_transfer_line(BIGINT, NUMERIC, TEXT, TEXT)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gateway_fifo_queue(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gateway_fifo_sort_date(DATE) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.gateway_resolve_sku(TEXT) TO anon, authenticated, service_role;
