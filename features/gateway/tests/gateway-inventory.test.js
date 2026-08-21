/**
 * Gateway inventory — integration tests against the real database.
 *
 * These exercise the plpgsql, not a JavaScript copy of it. A second
 * implementation of FIFO in the test would only prove the two copies agree,
 * and the copy that matters is the one the warehouse runs.
 *
 * Everything is created inside SKUs prefixed ZZ-GWTEST-.
 *
 *   node --test features/gateway/tests/gateway-inventory.test.js
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_KEY. Skips itself, loudly, if the
 * schema has not been deployed yet.
 *
 * PREFER the offline suite (`npm run test:gateway`, PGlite) for routine work —
 * it proves the same logic against real Postgres without touching production.
 *
 * TEARDOWN LEAVES RESIDUE, BY DESIGN. This test writes real rows to exercise
 * the deployed functions, and it cannot fully clean up over REST: any
 * post/adjust/reverse creates a gateway_movements row with no import_batch_id,
 * the append-only trigger refuses to DELETE it, and its foreign keys then
 * block deleting the lot and transfer behind it. Undoing that needs the
 * trigger switched off for one transaction, which only a privileged session
 * can do. So after running this against a live database, clean up with
 * features/gateway/tests/cleanup_test_data.sql in the Supabase SQL Editor.
 * The best-effort teardown below removes what REST can.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing — cannot run.');
  process.exit(1);
}
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const PREFIX = 'ZZ-GWTEST-';
const USER = 'integration-test';
let batchId = null;
const madeTransfers = [];

// ─── helpers ───────────────────────────────────────────────────────────
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { pg: error });
  return data;
}
/** Assert the call fails, and give back the message so the reason can be checked. */
async function rejects(fn, args) {
  const { error } = await sb.rpc(fn, args);
  assert.ok(error, `${fn} should have been refused`);
  return error.message;
}

async function newLot({ sku, qty, on, shelf = null, pallet = null, ref = null }) {
  return rpc('gateway_create_lot', {
    p: {
      sku, qty_received: qty, received_on: on,
      source_type: on ? 'transfer_in' : 'opening_balance',
      source_reference: ref, shelf_id: shelf, pallet_number: pallet,
      import_batch_id: String(batchId), import_row_ref: `test:${sku}:${on || 'undated'}:${Math.random()}`,
      created_by: USER,
    },
  });
}

async function newTransfer(direction = 'gateway_to_main') {
  const no = await rpc('gateway_next_transfer_no');
  const { data, error } = await sb.from('gateway_transfers')
    .insert({ transfer_no: no, direction, created_by: USER, updated_by: USER })
    .select().single();
  if (error) throw new Error(error.message);
  madeTransfers.push(data.id);
  return data;
}

async function addLine(transferId, sku, qty) {
  const { data, error } = await sb.from('gateway_transfer_lines')
    .insert({ transfer_id: transferId, sku, qty_requested: qty }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

const getLot = async id =>
  (await sb.from('gateway_lots').select('*').eq('id', id).single()).data;
const fifo = async sku => rpc('gateway_fifo_queue', { p_sku: sku });

let deployed = true;

test.before(async () => {
  const probe = await sb.from('gateway_lots').select('id').limit(1);
  if (probe.error && probe.error.code === '42P01') {
    deployed = false;
    console.error('\n  Gateway schema is not deployed. Apply features/gateway/db/*.sql ' +
                  'in the Supabase SQL Editor first.\n');
    return;
  }
  const { data, error } = await sb.from('gateway_import_batches').insert({
    source_file: 'integration-test', source_sheet: 'none',
    content_hash: `test-${Date.now()}-${Math.random()}`, kind: 'manual',
    status: 'running', created_by: USER,
  }).select().single();
  if (error) throw new Error(error.message);
  batchId = data.id;
});

test.after(async () => {
  if (!deployed || !batchId) return;
  for (const id of madeTransfers) {
    await rpc('gateway_cancel_transfer', { p_transfer_id: id, p_reason: 'test teardown', p_user: USER })
      .catch(() => {});                       // already completed or cancelled
    await sb.from('gateway_transfers').delete().eq('id', id);
  }
  // Completed transfers leave 'consumed' allocations, which the cascade above
  // removes; rollback then clears the movements and lots.
  await rpc('gateway_rollback_import', { p_batch_id: batchId, p_user: USER });
  await sb.from('gateway_import_batches').delete().eq('id', batchId);
  const leftovers = await sb.from('gateway_lots').select('id').like('sku', `${PREFIX}%`);
  assert.equal((leftovers.data || []).length, 0, 'teardown left test lots behind');
});

const T = (name, fn) => test(name, async t => {
  if (!deployed) return t.skip('schema not deployed');
  await fn(t);
});

// ═══════════════════════════════════════════════════════════════════════
T('a receipt creates a lot and the movement that explains it', async () => {
  const sku = `${PREFIX}SINGLE`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01', shelf: null });
  const l = await getLot(lot);

  assert.equal(Number(l.qty_received), 100);
  assert.equal(Number(l.qty_remaining), 100);
  assert.equal(Number(l.qty_reserved), 0);
  assert.equal(l.status, 'open');

  const { data: mv } = await sb.from('gateway_movements').select('*').eq('lot_id', lot);
  assert.equal(mv.length, 1, 'exactly one movement');
  assert.equal(mv[0].movement_type, 'RECEIPT');
  assert.equal(Number(mv[0].qty_before), 0);
  assert.equal(Number(mv[0].qty_after), 100);
});

T('single lot: receive 100, send 30, 70 left', async () => {
  const sku = `${PREFIX}ONE-LOT`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 30);

  const alloc = await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });
  assert.equal(Number(alloc.allocated), 30);
  assert.equal(Number(alloc.shortfall), 0);

  await rpc('gateway_post_transfer', { p_transfer_id: tr.id, p_picked: null, p_occurred_at: null, p_user: USER });

  const l = await getLot(lot);
  assert.equal(Number(l.qty_remaining), 70);
  assert.equal(Number(l.qty_reserved), 0, 'a consumed allocation reserves nothing');
});

T('multiple lots: 100 on 1 Aug + 100 on 10 Aug, send 120 -> 100 then 20', async () => {
  const sku = `${PREFIX}MULTI`;
  const older = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const newer = await newLot({ sku, qty: 100, on: '2026-08-10' });

  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 120);
  const alloc = await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });
  assert.equal(Number(alloc.allocated), 120);
  assert.equal(Number(alloc.allocations), 2, 'should span two lots');

  const { data: as } = await sb.from('gateway_transfer_allocations')
    .select('lot_id,qty,fifo_rank').eq('line_id', line.id).order('fifo_rank');
  assert.equal(as[0].lot_id, older, 'the older lot must be drawn first');
  assert.equal(Number(as[0].qty), 100);
  assert.equal(as[1].lot_id, newer);
  assert.equal(Number(as[1].qty), 20);

  await rpc('gateway_post_transfer', { p_transfer_id: tr.id, p_picked: null, p_occurred_at: null, p_user: USER });
  assert.equal(Number((await getLot(older)).qty_remaining), 0);
  assert.equal((await getLot(older)).status, 'depleted');
  assert.equal(Number((await getLot(newer)).qty_remaining), 80);
});

T('undated stock is ranked oldest, ahead of a dated lot', async () => {
  const sku = `${PREFIX}UNDATED`;
  const undated = await newLot({ sku, qty: 40, on: null });
  await newLot({ sku, qty: 40, on: '2020-01-01' });

  const q = await fifo(sku);
  assert.equal(q[0].lot_id, undated,
    'undated stock only exists because migration found it already there, so it is the oldest');
  assert.equal(q[0].date_confidence, 'unknown');
  assert.equal(q[0].age_days, null, 'an unknown date has no age, rather than a made-up one');
});

T('a reservation is not available to a second transfer', async () => {
  const sku = `${PREFIX}RESERVE`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });

  const t1 = await newTransfer();
  const l1 = await addLine(t1.id, sku, 80);
  await rpc('gateway_allocate_line', { p_line_id: l1.id, p_qty: null, p_user: USER });

  assert.equal(Number((await getLot(lot)).qty_reserved), 80);
  assert.equal(Number((await fifo(sku))[0].qty_available), 20);

  const t2 = await newTransfer();
  const l2 = await addLine(t2.id, sku, 50);
  const a2 = await rpc('gateway_allocate_line', { p_line_id: l2.id, p_qty: null, p_user: USER });
  assert.equal(Number(a2.allocated), 20, 'only the unreserved 20 may be taken');
  assert.equal(Number(a2.shortfall), 30, 'and the shortfall is reported, not hidden');
});

T('cancelling releases the stock without inventing a movement', async () => {
  const sku = `${PREFIX}CANCEL`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 80);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });
  assert.equal(Number((await getLot(lot)).qty_reserved), 80);

  const before = (await sb.from('gateway_movements').select('id').eq('lot_id', lot)).data.length;
  const r = await rpc('gateway_cancel_transfer',
    { p_transfer_id: tr.id, p_reason: 'load did not go', p_user: USER });

  assert.equal(Number(r.allocations_released), 1);
  const l = await getLot(lot);
  assert.equal(Number(l.qty_reserved), 0);
  assert.equal(Number(l.qty_remaining), 100, 'nothing physically moved');
  const after = (await sb.from('gateway_movements').select('id').eq('lot_id', lot)).data.length;
  assert.equal(after, before, 'a cancelled transfer must not write a stock movement');
});

T('a FIFO override is refused without a reason, and recorded with one', async () => {
  const sku = `${PREFIX}OVERRIDE`;
  const older = await newLot({ sku, qty: 50, on: '2026-07-01' });
  const newer = await newLot({ sku, qty: 50, on: '2026-08-15' });

  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 50);

  const msg = await rejects('gateway_allocate_override', {
    p_line_id: line.id, p_lot_id: newer, p_qty: 50, p_reason: '', p_user: USER });
  assert.match(msg, /reason/i);

  const r = await rpc('gateway_allocate_override', {
    p_line_id: line.id, p_lot_id: newer, p_qty: 50,
    p_reason: 'Older pallet blocked in by a container', p_user: USER });

  assert.equal(r.is_override, true);
  assert.equal(Number(r.recommended_lot_id), older, 'what FIFO wanted is stored beside what was taken');

  const { data: a } = await sb.from('gateway_transfer_allocations')
    .select('*').eq('id', r.allocation_id).single();
  assert.equal(a.lot_id, newer);
  assert.equal(a.is_fifo_override, true);
  assert.equal(a.override_by, USER);
  assert.ok(a.override_at);

  const { data: t } = await sb.from('gateway_transfers').select('fifo_compliant').eq('id', tr.id).single();
  assert.equal(t.fifo_compliant, false, 'the transfer is flagged as non-compliant');

  const { data: log } = await sb.from('gateway_audit_log')
    .select('*').eq('entity_type', 'allocation').eq('entity_id', String(r.allocation_id));
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'fifo_override');
  assert.equal(log[0].details.reason, 'Older pallet blocked in by a container');
});

T('an adjustment moves the balance and leaves a trail', async () => {
  const sku = `${PREFIX}ADJUST`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });

  const r = await rpc('gateway_adjust_lot', {
    p_lot_id: lot, p_delta: -5, p_reason_code: 'stocktake',
    p_reason: 'Counted 95 on the shelf', p_reference: null, p_user: USER });
  assert.equal(Number(r.new_qty), 95);
  assert.equal(Number((await getLot(lot)).qty_remaining), 95);

  const { data: mv } = await sb.from('gateway_movements')
    .select('*').eq('id', r.movement_id).single();
  assert.equal(mv.movement_type, 'STOCKTAKE_ADJUSTMENT');
  assert.equal(Number(mv.qty_before), 100);
  assert.equal(Number(mv.qty_after), 95);
  assert.equal(mv.created_by, USER);

  assert.match(await rejects('gateway_adjust_lot', {
    p_lot_id: lot, p_delta: -5, p_reason_code: 'stocktake', p_reason: '',
    p_reference: null, p_user: USER }), /reason/i);
});

T('the ledger cannot be edited or deleted', async () => {
  const sku = `${PREFIX}IMMUTABLE`;
  const lot = await newLot({ sku, qty: 10, on: '2026-08-01' });
  const { data: mv } = await sb.from('gateway_movements').select('id').eq('lot_id', lot).single();

  const up = await sb.from('gateway_movements').update({ qty: 999 }).eq('id', mv.id);
  assert.ok(up.error, 'UPDATE must be refused');
  assert.match(up.error.message, /append-only/i);

  const del = await sb.from('gateway_movements').delete().eq('id', mv.id);
  assert.ok(del.error, 'DELETE must be refused outside an import rollback');
  assert.match(del.error.message, /append-only/i);
});

T('stock cannot go negative, or above what arrived', async () => {
  const sku = `${PREFIX}BOUNDS`;
  const lot = await newLot({ sku, qty: 10, on: '2026-08-01' });

  assert.match(await rejects('gateway_adjust_lot', {
    p_lot_id: lot, p_delta: -20, p_reason_code: 'manual', p_reason: 'too much',
    p_reference: null, p_user: USER }), /below zero/i);

  // Putting back more than arrived would silently rewrite the pallet's own
  // history; the caller is told to record a new lot instead.
  assert.match(await rejects('gateway_adjust_lot', {
    p_lot_id: lot, p_delta: 5, p_reason_code: 'found', p_reason: 'extra carton',
    p_reference: null, p_user: USER }), /above its received qty|new lot/i);

  assert.equal(Number((await getLot(lot)).qty_remaining), 10, 'neither attempt changed anything');
});

T('over-allocating a single lot is refused', async () => {
  const sku = `${PREFIX}OVERALLOC`;
  const lot = await newLot({ sku, qty: 10, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 10);

  assert.match(await rejects('gateway_allocate_override', {
    p_line_id: line.id, p_lot_id: lot, p_qty: 25,
    p_reason: 'trying to take more than exists', p_user: USER }), /available/i);
});

T('a short pick moves only what was picked, and frees the rest', async () => {
  const sku = `${PREFIX}SHORT`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 60);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });

  const { data: a } = await sb.from('gateway_transfer_allocations')
    .select('id').eq('line_id', line.id).single();

  await rpc('gateway_post_transfer', {
    p_transfer_id: tr.id, p_picked: [{ allocation_id: a.id, qty: 45 }],
    p_occurred_at: null, p_user: USER });

  const l = await getLot(lot);
  assert.equal(Number(l.qty_remaining), 55, 'only the 45 actually picked left the shelf');
  assert.equal(Number(l.qty_reserved), 0);

  const { data: ln } = await sb.from('gateway_transfer_lines').select('*').eq('id', line.id).single();
  assert.equal(Number(ln.qty_requested), 60);
  assert.equal(Number(ln.qty_moved), 45, 'wanted and moved stay separate numbers');
});

T('posting twice does not move stock twice', async () => {
  const sku = `${PREFIX}IDEMPOTENT`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 40);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });

  await rpc('gateway_post_transfer', { p_transfer_id: tr.id, p_picked: null, p_occurred_at: null, p_user: USER });
  const again = await rpc('gateway_post_transfer', { p_transfer_id: tr.id, p_picked: null, p_occurred_at: null, p_user: USER });

  assert.equal(again.already_completed, true);
  assert.equal(Number(again.movements), 0);
  assert.equal(Number((await getLot(lot)).qty_remaining), 60, 'still 60, not 20');
});

T('stock returning from Main is a movement; a cancelled plan is not', async () => {
  const sku = `${PREFIX}REVERSE`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 30);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });
  const { data: a } = await sb.from('gateway_transfer_allocations').select('id').eq('line_id', line.id).single();
  await rpc('gateway_post_transfer', { p_transfer_id: tr.id, p_picked: null, p_occurred_at: null, p_user: USER });
  assert.equal(Number((await getLot(lot)).qty_remaining), 70);

  const r = await rpc('gateway_reverse_transfer_line', {
    p_allocation_id: a.id, p_qty: 10, p_reason: 'Main sent 10 back damaged', p_user: USER });

  assert.equal(Number(r.reversed), 10);
  assert.equal(Number((await getLot(lot)).qty_remaining), 80);
  const { data: mv } = await sb.from('gateway_movements').select('*').eq('id', r.movement_id).single();
  assert.equal(mv.movement_type, 'TRANSFER_OUT_REVERSAL');

  assert.match(await rejects('gateway_reverse_transfer_line', {
    p_allocation_id: a.id, p_qty: 999, p_reason: 'too much', p_user: USER }), /can reverse/i);
});

T('main_to_gateway posts new stock in, dated by the move', async () => {
  const sku = `${PREFIX}INBOUND`;
  const tr = await newTransfer('main_to_gateway');
  const line = await addLine(tr.id, sku, 250);

  const r = await rpc('gateway_post_transfer', {
    p_transfer_id: tr.id, p_picked: null,
    p_occurred_at: '2026-06-15T02:00:00Z', p_user: USER });
  assert.equal(Number(r.lots_created), 1);

  const { data: lots } = await sb.from('gateway_lots').select('*').eq('sku', sku);
  assert.equal(lots.length, 1);
  assert.equal(Number(lots[0].qty_remaining), 250);
  assert.equal(lots[0].received_on, '2026-06-15', 'dated in Brisbane time, from when it moved');
  // adopt it so teardown removes it
  await sb.from('gateway_lots').update({ import_batch_id: batchId }).eq('id', lots[0].id);
  await sb.from('gateway_movements').update({ import_batch_id: batchId }).eq('lot_id', lots[0].id)
    .then(() => {}, () => {});
});

T('a June receipt migrated in August stays a June receipt', async () => {
  const sku = `${PREFIX}HISTORICAL`;
  const lot = await newLot({ sku, qty: 60, on: '2026-06-03' });
  const l = await getLot(lot);

  assert.equal(l.received_on, '2026-06-03', 'the business date survives the migration date');
  assert.equal(l.date_confidence, 'exact');
  assert.ok(new Date(l.created_at) > new Date('2026-06-04'), 'recorded_at is now, received_on is June');

  const { data: mv } = await sb.from('gateway_movements').select('*').eq('lot_id', lot).single();
  assert.notEqual(mv.occurred_at.slice(0, 10), mv.recorded_at.slice(0, 10),
    'occurred_at and recorded_at are genuinely different clocks');
});

T('SKU case is resolved to the spelling Cin7 uses', async () => {
  // Cin7 holds '12v-IP20-030w'; people type '12V-IP20-030W'. Upper-casing on
  // the way in would leave the lot unable to join the product mirror and the
  // reconciliation screen would invent a discrepancy.
  const { data: probe } = await sb.schema('cin7_mirror').from('products')
    .select('sku').ilike('sku', '12V-IP20-030W').limit(1);
  if (!probe || !probe.length) return;               // product retired; nothing to assert

  const resolved = await rpc('gateway_resolve_sku', { p_sku: '12V-IP20-030W' });
  assert.equal(resolved, probe[0].sku);
  assert.notEqual(resolved, '12V-IP20-030W'.toUpperCase() === resolved ? resolved : '__x',
    'resolution should return Cin7 spelling');

  const unknown = await rpc('gateway_resolve_sku', { p_sku: `${PREFIX}NOT-IN-CIN7` });
  assert.equal(unknown, `${PREFIX}NOT-IN-CIN7`, 'an unknown SKU is kept verbatim, not rejected');
});

T('reconciliation reports a difference without changing anything', async () => {
  const sku = `${PREFIX}RECON`;
  const lot = await newLot({ sku, qty: 100, on: '2026-08-01' });

  const { data: v } = await sb.from('gateway_v_reconciliation').select('*').eq('sku', sku).single();
  assert.equal(Number(v.local_qty), 100);
  assert.equal(Number(v.cin7_qty), 0, 'a test SKU is not in Cin7');
  assert.equal(Number(v.difference), -100);
  assert.equal(v.state, 'local_only');

  await rpc('gateway_refresh_reconciliation', { p_tolerance: 0, p_user: USER });
  const { data: issue } = await sb.from('gateway_recon_issues').select('*').eq('sku', sku).single();
  assert.equal(issue.status, 'open');
  assert.equal(Number(issue.difference), -100);

  assert.equal(Number((await getLot(lot)).qty_remaining), 100,
    'reconciliation must never adjust stock to make the numbers agree');

  assert.match(await rejects('gateway_resolve_recon_issue', {
    p_issue_id: issue.id, p_status: 'resolved', p_cause: 'timing', p_note: '', p_user: USER }),
    /note/i);

  await rpc('gateway_resolve_recon_issue', {
    p_issue_id: issue.id, p_status: 'accepted', p_cause: 'bad_opening_balance',
    p_note: 'Test row', p_user: USER });
  const { data: after } = await sb.from('gateway_recon_issues').select('*').eq('sku', sku).single();
  assert.equal(after.status, 'accepted');
  assert.equal(after.resolved_by, USER);

  await sb.from('gateway_recon_issues').delete().eq('sku', sku);
});

T('the same import cannot be applied twice', async () => {
  const hash = `dup-${Date.now()}`;
  const first = await sb.from('gateway_import_batches').insert({
    source_file: 'dup-test', content_hash: hash, kind: 'lot_ledger', created_by: USER,
  }).select().single();
  assert.ok(!first.error);

  const second = await sb.from('gateway_import_batches').insert({
    source_file: 'dup-test', content_hash: hash, kind: 'lot_ledger', created_by: USER,
  });
  assert.ok(second.error, 'the same content and kind must be refused');
  assert.equal(second.error.code, '23505');

  await sb.from('gateway_import_batches').delete().eq('id', first.data.id);
});

T('rolling an import back removes exactly what it created', async () => {
  const { data: b } = await sb.from('gateway_import_batches').insert({
    source_file: 'rollback-test', content_hash: `rb-${Date.now()}`, kind: 'lot_ledger',
    created_by: USER,
  }).select().single();

  const rows = [{
    row_ref: 'rb!r1', sku: `${PREFIX}ROLLBACK`, qty_received: 80,
    received_on: '2026-05-02', source_reference: 'TR-00001', mode: 'reconstruct',
    outs: [{ occurred_at: '2026-06-01T00:00:00Z', qty: 30, reference: 'TR-00002' }],
  }];
  const res = await rpc('gateway_import_lot_ledger',
    { p_batch_id: b.id, p_rows: rows, p_user: USER });
  assert.equal(Number(res.lots), 1);
  assert.equal(Number(res.movements), 2, 'the receipt plus the withdrawal');

  const { data: lot } = await sb.from('gateway_lots').select('*').eq('sku', `${PREFIX}ROLLBACK`).single();
  assert.equal(Number(lot.qty_received), 80);
  assert.equal(Number(lot.qty_remaining), 50, '80 in, 30 out');

  const back = await rpc('gateway_rollback_import', { p_batch_id: b.id, p_user: USER });
  assert.equal(Number(back.lots_deleted), 1);
  assert.equal(Number(back.movements_deleted), 2);

  const { data: gone } = await sb.from('gateway_lots').select('id').eq('sku', `${PREFIX}ROLLBACK`);
  assert.equal(gone.length, 0);
  await sb.from('gateway_import_batches').delete().eq('id', b.id);
});

T('reserved stock blocks a rollback until the transfer is cancelled', async () => {
  const { data: b } = await sb.from('gateway_import_batches').insert({
    source_file: 'guard-test', content_hash: `gd-${Date.now()}`, kind: 'lot_ledger', created_by: USER,
  }).select().single();

  await rpc('gateway_import_lot_ledger', {
    p_batch_id: b.id,
    p_rows: [{ row_ref: 'gd!r1', sku: `${PREFIX}GUARD`, qty_received: 40,
               received_on: '2026-05-02', mode: 'reconstruct', outs: [] }],
    p_user: USER });

  const tr = await newTransfer();
  const line = await addLine(tr.id, `${PREFIX}GUARD`, 40);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });

  assert.match(await rejects('gateway_rollback_import', { p_batch_id: b.id, p_user: USER }),
    /allocated to a transfer/i);

  await rpc('gateway_cancel_transfer', { p_transfer_id: tr.id, p_reason: 'test', p_user: USER });
  const ok = await rpc('gateway_rollback_import', { p_batch_id: b.id, p_user: USER });
  assert.equal(Number(ok.lots_deleted), 1);
  await sb.from('gateway_import_batches').delete().eq('id', b.id);
});

T('allocations cannot be changed once the transfer has left draft', async () => {
  const sku = `${PREFIX}FROZEN`;
  await newLot({ sku, qty: 50, on: '2026-08-01' });
  const tr = await newTransfer();
  const line = await addLine(tr.id, sku, 20);
  await rpc('gateway_allocate_line', { p_line_id: line.id, p_qty: null, p_user: USER });

  await sb.from('gateway_transfers').update({ status: 'picking' }).eq('id', tr.id);
  assert.match(await rejects('gateway_allocate_line',
    { p_line_id: line.id, p_qty: 10, p_user: USER }), /draft or ready_for_cin7/i);

  await sb.from('gateway_transfers').update({ status: 'draft' }).eq('id', tr.id);
});
