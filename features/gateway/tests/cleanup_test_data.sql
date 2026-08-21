-- ============================================================================
-- Remove the integration test's residue (features/gateway/tests/gateway-inventory.test.js)
-- Apply: Supabase Dashboard -> SQL Editor. Scoped to the 'ZZ-GWTEST-' prefix.
--
-- NO explicit BEGIN/COMMIT. The Supabase SQL Editor wraps the script in its own
-- transaction; an explicit COMMIT here closes that early and the editor then
-- rolls the rest back, so the deletes appear to run (a mid-script SELECT shows
-- zeros) but never persist. Letting the editor own the transaction fixes it.
--
-- The live test writes real rows to exercise the deployed functions, and its
-- teardown cannot fully clean up: gateway_movements is append-only, so its
-- DELETE trigger refuses REST deletes, and the movements' foreign keys then
-- block deleting the lots and transfers behind them. Undoing that needs the
-- trigger switched off briefly — which only a privileged session can do.
--
-- Everything here is filtered to SKUs that begin 'ZZ-GWTEST-'. It cannot touch
-- real Gateway inventory, which never uses that prefix.
-- ============================================================================

ALTER TABLE public.gateway_movements DISABLE TRIGGER trg_gw_mv_no_update;

-- children first, so no foreign key blocks a parent
DELETE FROM public.gateway_movements WHERE sku LIKE 'ZZ-GWTEST-%';

DELETE FROM public.gateway_transfer_allocations a
 WHERE EXISTS (SELECT 1 FROM public.gateway_lots l
                WHERE l.sku LIKE 'ZZ-GWTEST-%'
                  AND (l.id = a.lot_id OR l.id = a.recommended_lot_id));

DELETE FROM public.gateway_transfer_lines WHERE sku LIKE 'ZZ-GWTEST-%';

DELETE FROM public.gateway_lots WHERE sku LIKE 'ZZ-GWTEST-%';

-- test transfers are the ones now left with nothing attached. A real transfer
-- that carries lines, allocations or movements is untouched.
DELETE FROM public.gateway_transfers t
 WHERE NOT EXISTS (SELECT 1 FROM public.gateway_transfer_lines l       WHERE l.transfer_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM public.gateway_transfer_allocations x WHERE x.transfer_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM public.gateway_movements m            WHERE m.transfer_id = t.id);

DELETE FROM public.gateway_import_batches WHERE source_file = 'integration-test';

ALTER TABLE public.gateway_movements ENABLE TRIGGER trg_gw_mv_no_update;

-- proof it is clean — every count must be 0
SELECT
  (SELECT count(*) FROM public.gateway_lots          WHERE sku LIKE 'ZZ-GWTEST-%') AS lots,
  (SELECT count(*) FROM public.gateway_movements     WHERE sku LIKE 'ZZ-GWTEST-%') AS movements,
  (SELECT count(*) FROM public.gateway_import_batches WHERE source_file = 'integration-test') AS batches,
  (SELECT count(*) FROM public.gateway_transfers)    AS transfers_total;
