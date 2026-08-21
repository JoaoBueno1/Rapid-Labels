-- ============================================================================
-- Gateway Inventory — historical import + reconciliation RPCs
-- File: features/gateway/db/003_gateway_import.sql
-- Apply: Supabase Dashboard -> SQL Editor (paste whole file). Idempotent.
-- Requires: 001_gateway_inventory.sql, 002_gateway_logic.sql
--
-- The whole workbook migration is ONE call. 771 separate PostgREST inserts
-- could half-succeed and leave an inventory that never existed; a single
-- plpgsql call either lands the lot ledger completely or leaves nothing.
-- ============================================================================

-- Import one parsed row set from 'MAIN Stock Movement'.
--
-- Each element of p_rows is:
--   { row_ref, sku, five_dc, product_name, shelf_id, shelf_text, pallet_number,
--     received_on (nullable), qty_received, source_reference, cin7_task_id,
--     mode: 'reconstruct' | 'opening',
--     outs: [ { occurred_at, qty, reference } ] }
--
-- mode 'reconstruct' replays the receipt and every recorded withdrawal, so the
-- remaining balance is derived. mode 'opening' is used where the source row is
-- too damaged to replay (unparseable First Qty, or withdrawals summing to more
-- than was ever received) — it books what is physically there now as an
-- opening balance and the caller records an issue saying so. Nothing is
-- guessed either way.
DROP FUNCTION IF EXISTS public.gateway_import_lot_ledger(BIGINT, JSONB, TEXT);
CREATE FUNCTION public.gateway_import_lot_ledger(
  p_batch_id BIGINT, p_rows JSONB, p_user TEXT DEFAULT 'excel_migration')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE
  r          JSONB;
  o          JSONB;
  v_lot      BIGINT;
  v_lots     INT := 0;
  v_moves    INT := 0;
  v_outs     INT := 0;
  v_shelf    TEXT;
  v_when     TIMESTAMPTZ;
  v_slot     INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.gateway_import_batches WHERE id = p_batch_id) THEN
    RAISE EXCEPTION 'import batch % does not exist', p_batch_id USING ERRCODE = 'no_data_found';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    -- Only bind shelf_id when the code really is in the shelf map. An unknown
    -- code keeps its verbatim text rather than being dropped or invented.
    SELECT id INTO v_shelf FROM public.gateway_shelves
     WHERE id = upper(btrim(COALESCE(r->>'shelf_id','')));

    v_lot := public.gateway_create_lot(jsonb_build_object(
      'sku',              r->>'sku',
      'five_dc',          r->>'five_dc',
      'product_name',     r->>'product_name',
      'received_on',      r->>'received_on',
      'qty_received',     r->>'qty_received',
      'source_type',      CASE WHEN r->>'mode' = 'opening' THEN 'opening_balance'
                               WHEN (r->>'received_on') IS NULL THEN 'opening_balance'
                               ELSE 'transfer_in' END,
      'source_reference', r->>'source_reference',
      'cin7_task_id',     r->>'cin7_task_id',
      'shelf_id',         v_shelf,
      'shelf_text',       COALESCE(r->>'shelf_text', r->>'shelf_id'),
      'pallet_number',    r->>'pallet_number',
      'date_confidence',  COALESCE(r->>'date_confidence','exact'),
      'source_system',    'excel_migration',
      'import_batch_id',  p_batch_id::TEXT,
      'import_row_ref',   r->>'row_ref',
      'notes',            r->>'notes',
      'created_by',       p_user,
      'idempotency_key',  'imp:' || p_batch_id || ':' || (r->>'row_ref') || ':receipt'));

    v_lots  := v_lots + 1;
    v_moves := v_moves + 1;

    v_slot := 0;
    FOR o IN SELECT * FROM jsonb_array_elements(COALESCE(r->'outs','[]'::JSONB))
    LOOP
      v_slot := v_slot + 1;
      CONTINUE WHEN (o->>'qty') IS NULL OR (o->>'qty')::NUMERIC <= 0;

      -- A withdrawal with no usable date still happened. Date it to the
      -- receipt so the ledger stays ordered, and mark it in metadata rather
      -- than inventing a plausible-looking day.
      v_when := COALESCE(
        NULLIF(o->>'occurred_at','')::TIMESTAMPTZ,
        (COALESCE(NULLIF(r->>'received_on','')::DATE, CURRENT_DATE)::TIMESTAMP
           AT TIME ZONE 'Australia/Brisbane'));

      INSERT INTO public.gateway_movements (
        lot_id, sku, movement_type, qty, occurred_at, shelf_id,
        source_system, source_reference, import_batch_id, reason,
        idempotency_key, created_by, metadata)
      VALUES (
        v_lot, upper(r->>'sku'), 'TRANSFER_OUT', -((o->>'qty')::NUMERIC), v_when, v_shelf,
        'excel_migration', NULLIF(o->>'reference',''), p_batch_id,
        'Migrated from MAIN Stock Movement',
        'imp:' || p_batch_id || ':' || (r->>'row_ref') || ':out' || v_slot, p_user,
        jsonb_build_object('slot', v_slot,
                           'date_known', (NULLIF(o->>'occurred_at','') IS NOT NULL)));

      v_moves := v_moves + 1;
      v_outs  := v_outs + 1;
    END LOOP;
  END LOOP;

  UPDATE public.gateway_import_batches
     SET lots_created = lots_created + v_lots,
         movements_created = movements_created + v_moves
   WHERE id = p_batch_id;

  RETURN jsonb_build_object('lots', v_lots, 'movements', v_moves, 'withdrawals', v_outs);
END $fn$;

-- Undo one import completely. The migration is the one place a hard delete is
-- right: nothing downstream can depend on rows that were only ever a bad read
-- of a spreadsheet, and a half-imported ledger must not be left in place.
DROP FUNCTION IF EXISTS public.gateway_rollback_import(BIGINT, TEXT);
CREATE FUNCTION public.gateway_rollback_import(p_batch_id BIGINT, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_lots INT; v_moves INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.gateway_transfer_allocations a
      JOIN public.gateway_lots l ON l.id = a.lot_id
     WHERE l.import_batch_id = p_batch_id AND a.state <> 'released')
  THEN
    RAISE EXCEPTION
      'batch % has lots allocated to a transfer — cancel those transfers first', p_batch_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The append-only trigger refuses DELETE unless this is set, and SET LOCAL
  -- dies with the transaction, so the ledger cannot be left unprotected.
  PERFORM set_config('gateway.purge_import', 'on', true);

  -- Released allocations still point at these lots. The guard above only
  -- proves none of them is live, not that none of them exists, so they have
  -- to go before the lots or the foreign key blocks the delete.
  DELETE FROM public.gateway_transfer_allocations a
   USING public.gateway_lots l
   WHERE a.lot_id = l.id AND l.import_batch_id = p_batch_id;

  DELETE FROM public.gateway_movements WHERE import_batch_id = p_batch_id;
  GET DIAGNOSTICS v_moves = ROW_COUNT;
  DELETE FROM public.gateway_lots WHERE import_batch_id = p_batch_id;
  GET DIAGNOSTICS v_lots = ROW_COUNT;

  UPDATE public.gateway_import_batches
     SET status = 'rolled_back', finished_at = now(),
         lots_created = 0, movements_created = 0
   WHERE id = p_batch_id;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('import', p_batch_id::TEXT, 'rolled_back',
          jsonb_build_object('lots_deleted', v_lots, 'movements_deleted', v_moves), p_user);

  RETURN jsonb_build_object('lots_deleted', v_lots, 'movements_deleted', v_moves);
END $fn$;

-- Refresh the open/closed reconciliation issues from the live view.
-- Deliberately does NOT touch stock. A difference is a question to answer, not
-- a number to overwrite: an issue that disappears is closed as 'resolved' with
-- a note saying it self-cleared, never by editing the ledger to agree.
DROP FUNCTION IF EXISTS public.gateway_refresh_reconciliation(NUMERIC, TEXT);
CREATE FUNCTION public.gateway_refresh_reconciliation(
  p_tolerance NUMERIC DEFAULT 0, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_open INT; v_closed INT;
BEGIN
  INSERT INTO public.gateway_recon_issues
    (sku, local_qty, cin7_qty, difference, cin7_synced_at, status)
  SELECT v.sku, v.local_qty, v.cin7_qty, v.difference, v.cin7_synced_at, 'open'
    FROM public.gateway_v_reconciliation v
   WHERE abs(v.difference) > p_tolerance
  ON CONFLICT (sku) DO UPDATE
     SET local_qty      = EXCLUDED.local_qty,
         cin7_qty       = EXCLUDED.cin7_qty,
         difference     = EXCLUDED.difference,
         cin7_synced_at = EXCLUDED.cin7_synced_at,
         last_seen_at   = now(),
         -- a resolved issue that comes back is genuinely open again
         status         = CASE WHEN public.gateway_recon_issues.status IN ('resolved','accepted')
                                AND public.gateway_recon_issues.difference IS DISTINCT FROM EXCLUDED.difference
                               THEN 'open' ELSE public.gateway_recon_issues.status END;
  GET DIAGNOSTICS v_open = ROW_COUNT;

  UPDATE public.gateway_recon_issues i
     SET status = 'resolved',
         resolved_at = COALESCE(i.resolved_at, now()),
         resolved_by = COALESCE(i.resolved_by, p_user),
         resolution_note = COALESCE(i.resolution_note, 'Difference no longer present at refresh'),
         last_seen_at = now()
   WHERE i.status IN ('open','investigating')
     AND NOT EXISTS (
       SELECT 1 FROM public.gateway_v_reconciliation v
        WHERE v.sku = i.sku AND abs(v.difference) > p_tolerance);
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  RETURN jsonb_build_object('upserted', v_open, 'auto_closed', v_closed);
END $fn$;

DROP FUNCTION IF EXISTS public.gateway_resolve_recon_issue(BIGINT, TEXT, TEXT, TEXT, TEXT);
CREATE FUNCTION public.gateway_resolve_recon_issue(
  p_issue_id BIGINT, p_status TEXT, p_cause TEXT, p_note TEXT, p_user TEXT DEFAULT 'system')
RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE v_sku TEXT;
BEGIN
  IF p_status NOT IN ('open','investigating','resolved','accepted') THEN
    RAISE EXCEPTION 'unknown status %', p_status USING ERRCODE = 'check_violation';
  END IF;
  IF p_status IN ('resolved','accepted') AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RAISE EXCEPTION 'closing a discrepancy needs a note' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.gateway_recon_issues
     SET status = p_status, cause_code = p_cause, resolution_note = p_note,
         resolved_by = CASE WHEN p_status IN ('resolved','accepted') THEN p_user ELSE NULL END,
         resolved_at = CASE WHEN p_status IN ('resolved','accepted') THEN now() ELSE NULL END
   WHERE id = p_issue_id
  RETURNING sku INTO v_sku;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'recon issue % not found', p_issue_id USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.gateway_audit_log (entity_type, entity_id, action, details, user_name)
  VALUES ('recon', p_issue_id::TEXT, 'status_' || p_status,
          jsonb_build_object('sku', v_sku, 'cause', p_cause, 'note', p_note), p_user);

  RETURN jsonb_build_object('id', p_issue_id, 'sku', v_sku, 'status', p_status);
END $fn$;

REVOKE ALL ON FUNCTION public.gateway_import_lot_ledger(BIGINT, JSONB, TEXT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_rollback_import(BIGINT, TEXT)                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_refresh_reconciliation(NUMERIC, TEXT)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gateway_resolve_recon_issue(BIGINT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
