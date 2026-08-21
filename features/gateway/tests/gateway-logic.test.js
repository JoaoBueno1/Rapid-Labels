/**
 * Gateway inventory — the inventory maths, tested against real Postgres.
 *
 * Runs the actual migration in PGlite, so what is under test is the plpgsql
 * that production will run, not a JavaScript restatement of it. No database
 * connection, no credentials, no cleanup: every test gets a fresh instance.
 *
 *   node --test features/gateway/tests/gateway-logic.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootDb, one, val, mustFail } = require('./sql-harness.js');

const USER = 'test';

// ─── shorthand ─────────────────────────────────────────────────────────
const newLot = (db, { sku, qty, on = null, shelf = null, pallet = null, ref = null }) =>
  val(db, `SELECT public.gateway_create_lot($1::jsonb)`, [JSON.stringify({
    sku, qty_received: qty, received_on: on,
    source_type: on ? 'transfer_in' : 'opening_balance',
    shelf_id: shelf, pallet_number: pallet, source_reference: ref, created_by: USER,
  })]);

async function newTransfer(db, direction = 'gateway_to_main') {
  const no = await val(db, `SELECT public.gateway_next_transfer_no()`);
  return val(db, `INSERT INTO public.gateway_transfers (transfer_no, direction, created_by)
                  VALUES ($1,$2,$3) RETURNING id`, [no, direction, USER]);
}
const addLine = (db, tr, sku, qty) =>
  val(db, `INSERT INTO public.gateway_transfer_lines (transfer_id, sku, qty_requested)
           VALUES ($1,$2,$3) RETURNING id`, [tr, sku, qty]);

const allocate = (db, line, qty = null) =>
  val(db, `SELECT public.gateway_allocate_line($1,$2,$3)`, [line, qty, USER]);
const post = (db, tr, picked = null, when = null) =>
  val(db, `SELECT public.gateway_post_transfer($1,$2::jsonb,$3::timestamptz,$4)`,
      [tr, picked ? JSON.stringify(picked) : null, when, USER]);
const lot = (db, id) => one(db, `SELECT * FROM public.gateway_lots WHERE id = $1`, [id]);
const fifo = async (db, sku) =>
  (await db.query(`SELECT * FROM public.gateway_fifo_queue($1)`, [sku])).rows;

const n = v => Number(v);

// ═══════════════════════════════════════════════════════════════════════
test('a receipt creates the lot and the movement that explains it', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const l = await lot(db, id);

  assert.equal(n(l.qty_received), 100);
  assert.equal(n(l.qty_remaining), 100);
  assert.equal(n(l.qty_reserved), 0);
  assert.equal(l.status, 'open');

  const mv = (await db.query(`SELECT * FROM public.gateway_movements WHERE lot_id=$1`, [id])).rows;
  assert.equal(mv.length, 1);
  assert.equal(mv[0].movement_type, 'RECEIPT');
  assert.equal(n(mv[0].qty_before), 0, 'the lot opens empty and the receipt fills it');
  assert.equal(n(mv[0].qty_after), 100);
});

test('single lot: receive 100, send 30, 70 remain', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 30);

  const a = await allocate(db, line);
  assert.equal(n(a.allocated), 30);
  assert.equal(n(a.shortfall), 0);

  await post(db, tr);
  const l = await lot(db, id);
  assert.equal(n(l.qty_remaining), 70);
  assert.equal(n(l.qty_reserved), 0);
});

test('multiple lots: 100 on 1 Aug + 100 on 10 Aug, send 120 -> 100 then 20', async () => {
  const db = await bootDb();
  const older = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const newer = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-10' });

  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 120);
  const a = await allocate(db, line);
  assert.equal(n(a.allocated), 120);
  assert.equal(n(a.allocations), 2);

  const rows = (await db.query(
    `SELECT lot_id, qty, fifo_rank FROM public.gateway_transfer_allocations
      WHERE line_id=$1 ORDER BY fifo_rank`, [line])).rows;
  assert.equal(n(rows[0].lot_id), n(older), 'oldest first');
  assert.equal(n(rows[0].qty), 100);
  assert.equal(n(rows[1].lot_id), n(newer));
  assert.equal(n(rows[1].qty), 20);

  await post(db, tr);
  assert.equal(n((await lot(db, older)).qty_remaining), 0);
  assert.equal((await lot(db, older)).status, 'depleted');
  assert.equal(n((await lot(db, newer)).qty_remaining), 80);
});

test('undated stock ranks ahead of a 2020 receipt', async () => {
  const db = await bootDb();
  const undated = await newLot(db, { sku: 'R3117', qty: 40, on: null });
  await newLot(db, { sku: 'R3117', qty: 40, on: '2020-01-01' });

  const q = await fifo(db, 'R3117');
  assert.equal(n(q[0].lot_id), n(undated),
    'undated stock only exists because migration found it already there');
  assert.equal(q[0].date_confidence, 'unknown');
  assert.equal(q[0].age_days, null, 'no invented age');
});

test('the unknown-date policy is configurable', async () => {
  const db = await bootDb();
  await db.query(`UPDATE public.gateway_settings SET value='newest' WHERE key='fifo_unknown_policy'`);
  const undated = await newLot(db, { sku: 'R3117', qty: 40, on: null });
  const dated = await newLot(db, { sku: 'R3117', qty: 40, on: '2020-01-01' });

  const q = await fifo(db, 'R3117');
  assert.equal(n(q[0].lot_id), n(dated), 'with policy=newest the dated lot leads');
  assert.equal(n(q[1].lot_id), n(undated));
});

test('a reservation is invisible to the next transfer', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });

  const t1 = await newTransfer(db);
  await allocate(db, await addLine(db, t1, 'R3117', 80));
  assert.equal(n((await lot(db, id)).qty_reserved), 80);
  assert.equal(n((await fifo(db, 'R3117'))[0].qty_available), 20);

  const t2 = await newTransfer(db);
  const a2 = await allocate(db, await addLine(db, t2, 'R3117', 50));
  assert.equal(n(a2.allocated), 20, 'only the free 20');
  assert.equal(n(a2.shortfall), 30, 'and the shortfall is reported');
});

test('cancelling releases stock and writes no movement', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  await allocate(db, await addLine(db, tr, 'R3117', 80));

  const before = n(await val(db, `SELECT count(*) FROM public.gateway_movements WHERE lot_id=$1`, [id]));
  const r = await val(db, `SELECT public.gateway_cancel_transfer($1,$2,$3)`,
    [tr, 'truck did not come', USER]);

  assert.equal(n(r.allocations_released), 1);
  const l = await lot(db, id);
  assert.equal(n(l.qty_reserved), 0);
  assert.equal(n(l.qty_remaining), 100, 'nothing physically moved');
  const after = n(await val(db, `SELECT count(*) FROM public.gateway_movements WHERE lot_id=$1`, [id]));
  assert.equal(after, before, 'a plan that never happened is not a stock movement');
});

test('a FIFO override needs a reason and is fully recorded', async () => {
  const db = await bootDb();
  const older = await newLot(db, { sku: 'R3117', qty: 50, on: '2026-07-01' });
  const newer = await newLot(db, { sku: 'R3117', qty: 50, on: '2026-08-15' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 50);

  const msg = await mustFail(db,
    `SELECT public.gateway_allocate_override($1,$2,$3,$4,$5)`, [line, newer, 50, '', USER]);
  assert.match(msg, /reason/i);

  const r = await val(db, `SELECT public.gateway_allocate_override($1,$2,$3,$4,$5)`,
    [line, newer, 50, 'Older pallet blocked in by a container', USER]);
  assert.equal(r.is_override, true);
  assert.equal(n(r.recommended_lot_id), n(older), 'what FIFO wanted is kept beside what was taken');

  const a = await one(db, `SELECT * FROM public.gateway_transfer_allocations WHERE id=$1`,
    [r.allocation_id]);
  assert.equal(n(a.lot_id), n(newer));
  assert.equal(a.is_fifo_override, true);
  assert.equal(a.override_by, USER);
  assert.ok(a.override_at);
  assert.equal(a.override_reason, 'Older pallet blocked in by a container');

  assert.equal((await one(db, `SELECT fifo_compliant FROM public.gateway_transfers WHERE id=$1`, [tr]))
    .fifo_compliant, false);

  const log = await one(db,
    `SELECT * FROM public.gateway_audit_log WHERE entity_type='allocation' AND entity_id=$1`,
    [String(r.allocation_id)]);
  assert.equal(log.action, 'fifo_override');
  assert.equal(log.details.reason, 'Older pallet blocked in by a container');
});

test('an adjustment moves the balance and leaves the before/after behind', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });

  const r = await val(db, `SELECT public.gateway_adjust_lot($1,$2,$3,$4,$5,$6)`,
    [id, -5, 'stocktake', 'Counted 95 on the shelf', null, USER]);
  assert.equal(n(r.new_qty), 95);
  assert.equal(n((await lot(db, id)).qty_remaining), 95);

  const mv = await one(db, `SELECT * FROM public.gateway_movements WHERE id=$1`, [r.movement_id]);
  assert.equal(mv.movement_type, 'STOCKTAKE_ADJUSTMENT');
  assert.equal(n(mv.qty_before), 100);
  assert.equal(n(mv.qty_after), 95);

  assert.match(await mustFail(db, `SELECT public.gateway_adjust_lot($1,$2,$3,$4,$5,$6)`,
    [id, -5, 'stocktake', '', null, USER]), /reason/i);
  assert.match(await mustFail(db, `SELECT public.gateway_adjust_lot($1,$2,$3,$4,$5,$6)`,
    [id, 0, 'stocktake', 'nothing', null, USER]), /zero/i);
});

test('the ledger refuses UPDATE and DELETE', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 10, on: '2026-08-01' });

  assert.match(await mustFail(db, `UPDATE public.gateway_movements SET qty=999 WHERE lot_id=$1`, [id]),
    /append-only/i);
  assert.match(await mustFail(db, `DELETE FROM public.gateway_movements WHERE lot_id=$1`, [id]),
    /append-only/i);
});

test('stock cannot go below zero or above what arrived', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 10, on: '2026-08-01' });

  assert.match(await mustFail(db, `SELECT public.gateway_adjust_lot($1,$2,$3,$4,$5,$6)`,
    [id, -20, 'manual', 'too much', null, USER]), /below zero/i);
  assert.match(await mustFail(db, `SELECT public.gateway_adjust_lot($1,$2,$3,$4,$5,$6)`,
    [id, 5, 'found', 'extra carton', null, USER]), /above its received qty|new lot/i);

  assert.equal(n((await lot(db, id)).qty_remaining), 10, 'neither attempt changed anything');
});

test('over-allocating one pallet is refused', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 10, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 10);

  assert.match(await mustFail(db, `SELECT public.gateway_allocate_override($1,$2,$3,$4,$5)`,
    [line, id, 25, 'trying to take more than exists', USER]), /available/i);
});

test('a short pick moves only what was picked and frees the rest', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 60);
  await allocate(db, line);
  const a = await val(db, `SELECT id FROM public.gateway_transfer_allocations WHERE line_id=$1`, [line]);

  await post(db, tr, [{ allocation_id: Number(a), qty: 45 }]);

  const l = await lot(db, id);
  assert.equal(n(l.qty_remaining), 55, 'only the 45 actually picked left');
  assert.equal(n(l.qty_reserved), 0);

  const ln = await one(db, `SELECT * FROM public.gateway_transfer_lines WHERE id=$1`, [line]);
  assert.equal(n(ln.qty_requested), 60);
  assert.equal(n(ln.qty_moved), 45, 'wanted and moved stay different numbers');
});

test('a pick larger than the reservation is refused', async () => {
  const db = await bootDb();
  await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 30);
  await allocate(db, line);
  const a = await val(db, `SELECT id FROM public.gateway_transfer_allocations WHERE line_id=$1`, [line]);

  assert.match(await mustFail(db,
    `SELECT public.gateway_post_transfer($1,$2::jsonb,NULL,$3)`,
    [tr, JSON.stringify([{ allocation_id: Number(a), qty: 80 }]), USER]), /only .* was reserved/i);
});

test('posting twice does not move stock twice', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  await allocate(db, await addLine(db, tr, 'R3117', 40));

  await post(db, tr);
  const again = await post(db, tr);
  assert.equal(again.already_completed, true);
  assert.equal(n(again.movements), 0);
  assert.equal(n((await lot(db, id)).qty_remaining), 60, 'still 60, not 20');
});

test('stock coming back from Main is a movement; a cancelled plan is not', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 30);
  await allocate(db, line);
  const a = Number(await val(db,
    `SELECT id FROM public.gateway_transfer_allocations WHERE line_id=$1`, [line]));
  await post(db, tr);
  assert.equal(n((await lot(db, id)).qty_remaining), 70);

  const r = await val(db, `SELECT public.gateway_reverse_transfer_line($1,$2,$3,$4)`,
    [a, 10, 'Main sent 10 back damaged', USER]);
  assert.equal(n(r.reversed), 10);
  assert.equal(n((await lot(db, id)).qty_remaining), 80);
  assert.equal((await one(db, `SELECT movement_type FROM public.gateway_movements WHERE id=$1`,
    [r.movement_id])).movement_type, 'TRANSFER_OUT_REVERSAL');

  assert.match(await mustFail(db, `SELECT public.gateway_reverse_transfer_line($1,$2,$3,$4)`,
    [a, 999, 'too much', USER]), /can reverse/i);
});

test('main_to_gateway creates the pallet, dated by the move', async () => {
  const db = await bootDb();
  const tr = await newTransfer(db, 'main_to_gateway');
  await addLine(db, tr, 'R3117', 250);

  const r = await post(db, tr, null, '2026-06-15T02:00:00Z');
  assert.equal(n(r.lots_created), 1);

  const l = await one(db, `SELECT * FROM public.gateway_lots WHERE sku='R3117'`);
  assert.equal(n(l.qty_remaining), 250);
  assert.equal(l.received_on.toISOString().slice(0, 10), '2026-06-15',
    'dated in Brisbane time from when it moved');
  assert.equal(l.source_type, 'transfer_in');
});

test('a June receipt migrated in August is still a June receipt', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 60, on: '2026-06-03' });
  const l = await lot(db, id);

  assert.equal(l.received_on.toISOString().slice(0, 10), '2026-06-03');
  assert.equal(l.date_confidence, 'exact');

  // Compare in Brisbane, not UTC. Midnight on 3 June in Brisbane IS
  // 2026-06-02T14:00Z, so .toISOString() would read a day early and the
  // "fix" would be to store the wrong instant. Same trap the excel-sync
  // Power Query notes describe.
  const mv = await one(db,
    `SELECT (occurred_at AT TIME ZONE 'Australia/Brisbane')::date AS occurred_bne,
            (recorded_at AT TIME ZONE 'Australia/Brisbane')::date AS recorded_bne
       FROM public.gateway_movements WHERE lot_id=$1`, [id]);
  assert.equal(mv.occurred_bne.toISOString().slice(0, 10), '2026-06-03',
    'occurred_at is midnight Brisbane on the business date');
  assert.notEqual(mv.recorded_bne.toISOString().slice(0, 10), '2026-06-03',
    'recorded_at is when we learned of it — genuinely a different clock');
});

test('the app cannot create an undated lot; migration can', async () => {
  const db = await bootDb();
  // source_type transfer_in with no date breaks gw_lots_date_required
  assert.match(await mustFail(db,
    `INSERT INTO public.gateway_lots (sku, qty_received, qty_remaining, source_type, date_confidence)
     VALUES ('R3117', 10, 10, 'transfer_in', 'unknown')`), /gw_lots_date_required|violates/i);

  const id = await newLot(db, { sku: 'R3117', qty: 10, on: null });
  assert.equal((await lot(db, id)).source_type, 'opening_balance');
});

test('SKU case is resolved to the spelling Cin7 uses', async () => {
  const db = await bootDb();
  // Cin7 holds '12v-IP20-030w'; people type '12V-IP20-030W'.
  assert.equal(await val(db, `SELECT public.gateway_resolve_sku('12V-IP20-030W')`), '12v-IP20-030w');
  assert.equal(await val(db, `SELECT public.gateway_resolve_sku('R6052-WH-TRI')`), 'R6052-WH-TRI');
  assert.equal(await val(db, `SELECT public.gateway_resolve_sku('  R3117 ')`), 'R3117');
  assert.equal(await val(db, `SELECT public.gateway_resolve_sku('NOT-IN-CIN7')`), 'NOT-IN-CIN7',
    'an unknown SKU is kept verbatim, not rejected');

  const id = await newLot(db, { sku: '12V-IP20-030W', qty: 5, on: '2026-08-01' });
  assert.equal((await lot(db, id)).sku, '12v-IP20-030w', 'stored with Cin7 spelling');
});

test('reconciliation reports the difference and changes nothing', async () => {
  const db = await bootDb();
  // Cin7 says 149; we book 200.
  const id = await newLot(db, { sku: 'R6052-WH-TRI', qty: 200, on: '2026-04-22' });

  const v = await one(db, `SELECT * FROM public.gateway_v_reconciliation WHERE sku='R6052-WH-TRI'`);
  assert.equal(n(v.local_qty), 200);
  assert.equal(n(v.cin7_qty), 149);
  assert.equal(n(v.difference), -51, 'Cin7 minus ours');
  assert.equal(v.state, 'mismatch');

  await val(db, `SELECT public.gateway_refresh_reconciliation($1,$2)`, [0, USER]);
  const issue = await one(db, `SELECT * FROM public.gateway_recon_issues WHERE sku='R6052-WH-TRI'`);
  assert.equal(issue.status, 'open');
  assert.equal(n(issue.difference), -51);

  assert.equal(n((await lot(db, id)).qty_remaining), 200,
    'reconciliation must never move stock to make the numbers agree');

  assert.match(await mustFail(db, `SELECT public.gateway_resolve_recon_issue($1,$2,$3,$4,$5)`,
    [issue.id, 'resolved', 'timing', '', USER]), /note/i);

  await val(db, `SELECT public.gateway_resolve_recon_issue($1,$2,$3,$4,$5)`,
    [issue.id, 'accepted', 'bad_opening_balance', 'Migrated balance was high', USER]);
  const after = await one(db, `SELECT * FROM public.gateway_recon_issues WHERE sku='R6052-WH-TRI'`);
  assert.equal(after.status, 'accepted');
  assert.equal(after.resolved_by, USER);
});

test('reconciliation sees both directions, and closes what clears', async () => {
  const db = await bootDb();
  await newLot(db, { sku: 'R2379-2m', qty: 40, on: '2026-08-01' });   // not in Cin7
  const v = await db.query(
    `SELECT sku, state FROM public.gateway_v_reconciliation ORDER BY sku`);
  const byState = Object.fromEntries(v.rows.map(r => [r.sku, r.state]));
  assert.equal(byState['R2379-2m'], 'local_only');
  assert.equal(byState['R3117'], 'cin7_only', 'stock Cin7 holds that has no lot must show up');

  await val(db, `SELECT public.gateway_refresh_reconciliation($1,$2)`, [0, USER]);
  // R2379-2m local-only, plus R3117 and R6052-WH-TRI which Cin7 holds and we
  // have not booked: three open questions, not two.
  assert.equal(n(await val(db,
    `SELECT count(*) FROM public.gateway_recon_issues WHERE status='open'`)), 3);

  // Book the missing Cin7 stock, then refresh: that issue should self-close.
  await newLot(db, { sku: 'R3117', qty: 720, on: '2026-08-05' });
  const r = await val(db, `SELECT public.gateway_refresh_reconciliation($1,$2)`, [0, USER]);
  assert.equal(n(r.auto_closed), 1);
  const closed = await one(db, `SELECT * FROM public.gateway_recon_issues WHERE sku='R3117'`);
  assert.equal(closed.status, 'resolved');
  assert.match(closed.resolution_note, /no longer present/i);
});

test('the same import cannot land twice', async () => {
  const db = await bootDb();
  const mk = () => db.query(
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('wb.xlsx','abc123','lot_ledger',$1)`, [USER]);
  await mk();
  assert.match(await mustFail(db,
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('wb.xlsx','abc123','lot_ledger','x')`), /duplicate key|unique/i);
});

test('the ledger importer replays a receipt and its withdrawals', async () => {
  const db = await bootDb();
  const batch = await val(db,
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('Gateway Driver Aug 26.xlsx','h1','lot_ledger',$1) RETURNING id`, [USER]);

  // Row 4 of the real sheet, booked the way the importer books it:
  // balance 199 anchored on CURRENTY QTY, receipt derived as 199 + 150.
  const r = await val(db, `SELECT public.gateway_import_lot_ledger($1,$2::jsonb,$3)`, [batch,
    JSON.stringify([{
      row_ref: 'MAIN Stock Movement!r4', sku: 'R6052-WH-TRI', five_dc: '30313',
      shelf_id: 'A1', shelf_text: 'A1', pallet_number: '201',
      received_on: '2026-04-22', qty_received: 349, source_reference: 'TR-38813',
      mode: 'reconstruct',
      outs: [{ occurred_at: '2026-07-24T00:00:00Z', qty: 50,  reference: 'TR-47130' },
             { occurred_at: '2026-08-20T00:00:00Z', qty: 100, reference: 'TR-49485' }],
    }]), USER]);

  assert.equal(n(r.lots), 1);
  assert.equal(n(r.movements), 3, 'the receipt plus two withdrawals');

  const l = await one(db, `SELECT * FROM public.gateway_lots WHERE import_batch_id=$1`, [batch]);
  assert.equal(n(l.qty_received), 349);
  assert.equal(n(l.qty_remaining), 199, 'lands on the balance the sheet claimed');
  assert.equal(l.received_on.toISOString().slice(0, 10), '2026-04-22');
  assert.equal(l.shelf_text, 'A1');
  assert.equal(l.source_system, 'excel_migration');
  assert.equal(l.shelf_id, 'A1');

  const mv = (await db.query(
    `SELECT * FROM public.gateway_movements WHERE lot_id=$1 ORDER BY occurred_at`, [l.id])).rows;
  assert.equal(mv[0].movement_type, 'RECEIPT');
  assert.equal(mv[1].source_reference, 'TR-47130');
  assert.equal(n(mv[2].qty), -100);
  assert.equal(n(mv[2].qty_after), 199);
});

test('an unknown shelf keeps its text rather than being invented or dropped', async () => {
  const db = await bootDb();
  const batch = await val(db,
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('wb','h2','lot_ledger',$1) RETURNING id`, [USER]);
  await val(db, `SELECT public.gateway_import_lot_ledger($1,$2::jsonb,$3)`, [batch,
    JSON.stringify([{ row_ref: 'r1', sku: 'R3117', shelf_id: 'FLOOR ?', shelf_text: 'FLOOR ?',
                      received_on: '2026-05-02', qty_received: 12, mode: 'reconstruct', outs: [] }]),
    USER]);

  const l = await one(db, `SELECT * FROM public.gateway_lots WHERE import_batch_id=$1`, [batch]);
  assert.equal(l.shelf_id, null, 'no foreign key to a shelf that does not exist');
  assert.equal(l.shelf_text, 'FLOOR ?', 'but the operator wrote something and it survives');
});

test('rolling an import back removes exactly what it created', async () => {
  const db = await bootDb();
  const batch = await val(db,
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('wb','h3','lot_ledger',$1) RETURNING id`, [USER]);
  await val(db, `SELECT public.gateway_import_lot_ledger($1,$2::jsonb,$3)`, [batch,
    JSON.stringify([{ row_ref: 'r1', sku: 'R3117', received_on: '2026-05-02',
                      qty_received: 80, mode: 'reconstruct',
                      outs: [{ occurred_at: '2026-06-01T00:00:00Z', qty: 30, reference: 'TR-2' }] }]),
    USER]);
  // an unrelated lot must survive the rollback
  const keep = await newLot(db, { sku: 'R3117', qty: 5, on: '2026-08-01' });

  const back = await val(db, `SELECT public.gateway_rollback_import($1,$2)`, [batch, USER]);
  assert.equal(n(back.lots_deleted), 1);
  assert.equal(n(back.movements_deleted), 2);

  assert.equal(n(await val(db,
    `SELECT count(*) FROM public.gateway_lots WHERE import_batch_id=$1`, [batch])), 0);
  assert.ok(await lot(db, keep), 'the hand-entered lot is untouched');
  assert.equal((await one(db,
    `SELECT status FROM public.gateway_import_batches WHERE id=$1`, [batch])).status, 'rolled_back');
});

test('rollback is blocked while stock is reserved, and the ledger stays locked after', async () => {
  const db = await bootDb();
  const batch = await val(db,
    `INSERT INTO public.gateway_import_batches (source_file, content_hash, kind, created_by)
     VALUES ('wb','h4','lot_ledger',$1) RETURNING id`, [USER]);
  await val(db, `SELECT public.gateway_import_lot_ledger($1,$2::jsonb,$3)`, [batch,
    JSON.stringify([{ row_ref: 'r1', sku: 'R3117', received_on: '2026-05-02',
                      qty_received: 40, mode: 'reconstruct', outs: [] }]), USER]);

  const tr = await newTransfer(db);
  await allocate(db, await addLine(db, tr, 'R3117', 40));
  assert.match(await mustFail(db, `SELECT public.gateway_rollback_import($1,$2)`, [batch, USER]),
    /allocated to a transfer/i);

  await val(db, `SELECT public.gateway_cancel_transfer($1,$2,$3)`, [tr, 'test', USER]);
  assert.equal(n((await val(db, `SELECT public.gateway_rollback_import($1,$2)`, [batch, USER]))
    .lots_deleted), 1);

  // The purge GUC is transaction-local, so the ledger must be protected again.
  const id = await newLot(db, { sku: 'R3117', qty: 10, on: '2026-08-01' });
  assert.match(await mustFail(db, `DELETE FROM public.gateway_movements WHERE lot_id=$1`, [id]),
    /append-only/i);
});

test('allocations freeze once the transfer leaves draft', async () => {
  const db = await bootDb();
  await newLot(db, { sku: 'R3117', qty: 50, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 20);
  await allocate(db, line);

  await db.query(`UPDATE public.gateway_transfers SET status='picking' WHERE id=$1`, [tr]);
  assert.match(await mustFail(db, `SELECT public.gateway_allocate_line($1,$2,$3)`, [line, 10, USER]),
    /draft or ready_for_cin7/i);
});

test('deleting a line frees the stock it was holding', async () => {
  const db = await bootDb();
  const id = await newLot(db, { sku: 'R3117', qty: 100, on: '2026-08-01' });
  const tr = await newTransfer(db);
  const line = await addLine(db, tr, 'R3117', 60);
  await allocate(db, line);
  assert.equal(n((await lot(db, id)).qty_reserved), 60);

  await db.query(`DELETE FROM public.gateway_transfer_lines WHERE id=$1`, [line]);
  assert.equal(n((await lot(db, id)).qty_reserved), 0, 'the cascade must release the reservation');
  assert.equal(n((await lot(db, id)).qty_remaining), 100);
});

test('the per-SKU view adds up the pallets', async () => {
  const db = await bootDb();
  await newLot(db, { sku: 'R3117', qty: 100, on: '2026-06-01', shelf: null });
  await newLot(db, { sku: 'R3117', qty: 50, on: '2026-08-01' });
  await newLot(db, { sku: 'R3117', qty: 25, on: null });

  const tr = await newTransfer(db);
  await allocate(db, await addLine(db, tr, 'R3117', 30));

  const b = await one(db, `SELECT * FROM public.gateway_v_sku_balance WHERE sku='R3117'`);
  assert.equal(n(b.qty_on_hand), 175);
  assert.equal(n(b.qty_reserved), 30);
  assert.equal(n(b.qty_available), 145);
  assert.equal(n(b.open_lots), 3);
  assert.equal(n(b.undated_lots), 1);
  assert.equal(b.oldest_received_on.toISOString().slice(0, 10), '2026-06-01');
});
