/**
 * wms-transfers.js — bin↔bin and warehouse↔warehouse stock transfers.
 *
 * Uses the ONE Cin7 write proven in production (stockTransfer: POST DRAFT then
 * PUT COMPLETED). Sessions are pausable in our DB so a huge warehouse-to-warehouse
 * TR can be built line-by-line and committed once. Commit is exactly-once via the
 * outbox, with a crash-safe checkpoint: the DRAFT TaskID is persisted the instant
 * Cin7 returns it, so a failure between DRAFT and COMPLETE RESUMES the same draft
 * instead of creating a duplicate transfer.
 */
'use strict';

const cin7 = require('./cin7-wms-client');
const outbox = require('./outbox');

function wms(sb) { return sb.schema('wms'); }

// Resolve a warehouse name OR a bin code to its Cin7 location GUID.
async function resolveLocationId(sb, nameOrBin) {
  if (!nameOrBin) return null;
  const own = await wms(sb).from('bins').select('cin7_location_id').eq('bin_code', nameOrBin).maybeSingle();
  if (own.data && own.data.cin7_location_id) return own.data.cin7_location_id;
  const mir = await sb.schema('cin7_mirror').from('locations').select('id').eq('name', nameOrBin).maybeSingle();
  return (mir.data && mir.data.id) || null;
}

async function stageTransfer(sb, { kind, fromLocation, toLocation }, user) {
  const { data } = await wms(sb).from('transfers').insert({
    kind: kind || 'bin', from_location: fromLocation, to_location: toLocation,
    status: 'draft', created_by: user,
  }).select().single();
  return data;
}

async function resolveProductId(sb, sku, productId) {
  if (productId) return { productId, sku };
  const { data } = await sb.schema('cin7_mirror').from('products').select('id,sku').eq('sku', sku).maybeSingle();
  if (!data) throw new Error(`SKU ${sku} not found in Cin7 catalogue`);
  return { productId: data.id, sku: data.sku };
}
async function addLine(sb, transferId, { sku, productId, qty, fromBin, toBin }) {
  const resolved = await resolveProductId(sb, sku, productId);
  productId = resolved.productId; sku = resolved.sku;
  const fromBinId = fromBin ? await resolveLocationId(sb, fromBin) : null;
  const toBinId = toBin ? await resolveLocationId(sb, toBin) : null;
  const { data } = await wms(sb).from('transfer_lines').insert({
    transfer_id: transferId, sku, product_id: productId, qty,
    from_bin: fromBin, from_bin_id: fromBinId, to_bin: toBin, to_bin_id: toBinId,
  }).select().single();
  await wms(sb).from('transfers').update({ status: 'in_progress', updated_at: new Date().toISOString() }).eq('id', transferId);
  return data;
}
async function scanLine(sb, lineId, { qty }) {
  await wms(sb).from('transfer_lines').update({ qty, scanned: true, updated_at: new Date().toISOString() }).eq('id', lineId);
  return { ok: true };
}
async function removeLine(sb, lineId) { await wms(sb).from('transfer_lines').delete().eq('id', lineId); return { ok: true }; }

async function getTransferState(sb, id) {
  const { data: t } = await wms(sb).from('transfers').select('*').eq('id', id).maybeSingle();
  if (!t) return null;
  const { data: lines } = await wms(sb).from('transfer_lines').select('*').eq('transfer_id', id).order('id');
  return { transfer: t, lines: lines || [] };
}

// Commit the whole session as ONE Cin7 stock transfer (From/To at the header).
async function commitTransfer(sb, transferId, user) {
  const state = await getTransferState(sb, transferId);
  if (!state) throw new Error('transfer not found');
  const { transfer, lines } = state;
  const moved = lines.filter((l) => Number(l.qty) > 0);
  if (!moved.length) throw new Error('no lines to transfer');

  const fromId = await resolveLocationId(sb, transfer.from_location);
  const toId = await resolveLocationId(sb, transfer.to_location);
  if (!fromId) throw new Error(`from location "${transfer.from_location}" not found`);
  if (!toId) throw new Error(`to location "${transfer.to_location}" not found`);

  const reference = `WMS TR | ${transfer.from_location} → ${transfer.to_location}`;
  const cin7Lines = moved.map((l) => ({
    ProductID: l.product_id, TransferQuantity: Number(l.qty),
    Comments: `${l.sku} ×${l.qty}${l.from_bin ? '  from ' + l.from_bin : ''}${l.to_bin ? ' → ' + l.to_bin : ''}`,
  }));

  const key = outbox.opKey('transfer', transferId, fromId, toId, cin7Lines);
  await outbox.enqueue(sb, { op_key: key, op_type: 'transfer', target: 'stockTransfer', payload: { fromId, toId, cin7Lines }, created_by: user });

  const res = await outbox.execute(sb, key, {
    actor: user,
    doWrite: async () => {
      const row = await outbox.load(sb, key);
      let taskId = row.cin7_task_id;
      let number = row.cin7_ref;
      if (!taskId) {
        const draft = await cin7.createTransfer({ fromLocationId: fromId, toLocationId: toId, reference, lines: cin7Lines });
        taskId = draft.TaskID; number = draft.Number || number;
        await outbox.patch(sb, key, { cin7_task_id: taskId }); // crash-safe checkpoint before COMPLETE
      }
      const done = await cin7.completeTransfer({ taskId, fromLocationId: fromId, toLocationId: toId, reference, lines: cin7Lines });
      return { cin7_ref: (done && done.Number) || number || null, cin7_task_id: taskId, response: done };
    },
    verify: async () => {
      const row = await outbox.load(sb, key);
      if (!row.cin7_task_id) return { done: false };
      const t = await cin7.getTransfer(row.cin7_task_id);
      return { done: t && /COMPLETED/i.test(t.Status || ''), cin7_ref: t && t.Number };
    },
    movements: moved.flatMap((l) => ([
      { movement_type: 'transfer', sku: l.sku, product_id: l.product_id, qty: -Math.abs(Number(l.qty)), from_bin: l.from_bin || transfer.from_location, cin7_ref: reference },
      { movement_type: 'transfer', sku: l.sku, product_id: l.product_id, qty: Math.abs(Number(l.qty)), to_bin: l.to_bin || transfer.to_location, cin7_ref: reference },
    ])),
  });

  await wms(sb).from('transfers').update({ status: 'committed', cin7_task_id: res.response && res.response.TaskID, cin7_ref: res.cin7_ref, outbox_op_key: key, updated_at: new Date().toISOString() }).eq('id', transferId);
  return { ok: true, cin7_ref: res.cin7_ref, alreadyDone: res.alreadyDone };
}

// Generic putaway: move stock from a source location into a destination bin, via
// the proven stockTransfer + the exactly-once outbox (crash-safe DRAFT checkpoint).
// Used for the binless produced FG (from the warehouse root) and PO receiving
// putaway (from the receiving dock).
const PRODUCTION_BIN = process.env.WMS_PRODUCTION_BIN || 'MA-PRODUCTION';
const RECEIVING_BIN = process.env.WMS_RECEIVING_BIN || 'MA-DOCK';
async function putaway(sb, { sku, productId, qty, fromLocation, toBin, waveId, tag }, user) {
  const fromId = await resolveLocationId(sb, fromLocation || 'Main Warehouse');
  const toId = await resolveLocationId(sb, toBin);
  if (!toId) throw new Error(`putaway bin "${toBin}" not found`);
  const label = tag || 'PUTAWAY';
  const reference = `WMS ${label} | ${sku} → ${toBin}`;
  const lines = [{ ProductID: productId, TransferQuantity: Number(qty), Comments: `${sku} ×${qty} ${label.toLowerCase()} → ${toBin}` }];
  const key = outbox.opKey(label.toLowerCase(), sku, toBin, qty, waveId, fromLocation);
  await outbox.enqueue(sb, { op_key: key, op_type: 'transfer', target: 'stockTransfer', payload: { fromId, toId, lines }, created_by: user });
  const res = await outbox.execute(sb, key, {
    actor: user,
    doWrite: async () => {
      const row = await outbox.load(sb, key);
      let taskId = row.cin7_task_id;
      if (!taskId) { const d = await cin7.createTransfer({ fromLocationId: fromId, toLocationId: toId, reference, lines }); taskId = d.TaskID; await outbox.patch(sb, key, { cin7_task_id: taskId }); }
      const done = await cin7.completeTransfer({ taskId, fromLocationId: fromId, toLocationId: toId, reference, lines });
      return { cin7_ref: (done && done.Number) || null, cin7_task_id: taskId, response: done };
    },
    verify: async () => { const row = await outbox.load(sb, key); if (!row.cin7_task_id) return { done: false }; const t = await cin7.getTransfer(row.cin7_task_id); return { done: t && /COMPLETED/i.test(t.Status || '') }; },
    movements: [{ movement_type: 'putaway', sku, product_id: productId, qty: Number(qty), from_bin: fromLocation, to_bin: toBin, cin7_ref: reference, wave_id: waveId }],
  });
  return { ok: true, bin: toBin, cin7_ref: res.cin7_ref, alreadyDone: res.alreadyDone };
}
// The FG born binless → move it to the production bin.
async function putawayFG(sb, { fgSku, fgProductId, qty, toBin, waveId }, user) {
  return putaway(sb, { sku: fgSku, productId: fgProductId, qty, fromLocation: 'Main Warehouse', toBin: toBin || PRODUCTION_BIN, waveId, tag: 'PUTAWAY' }, user);
}

module.exports = { resolveLocationId, stageTransfer, addLine, scanLine, removeLine, getTransferState, commitTransfer, putaway, putawayFG, PRODUCTION_BIN, RECEIVING_BIN };
