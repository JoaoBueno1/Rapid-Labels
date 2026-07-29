/**
 * reconciler.js — completes the exactly-once guarantee.
 *
 * A Cin7 write can time out AFTER it landed, leaving an outbox row stuck at
 * 'sent' (ambiguous) or 'failed'. This drainer inspects those rows against LIVE
 * Cin7 and, if the write actually took effect, marks the row reconciled and
 * writes the journal — so nothing is ever re-sent blindly and stock never
 * double-moves. Run on a short interval (e.g. every 60s) once the feature is live.
 *
 * It is READ-ONLY against Cin7 (GET only) and writes only wms.outbox/movements.
 */
'use strict';

const cin7 = require('./cin7-wms-client');

function wms(sb) { return sb.schema('wms'); }

// op_type → how to verify it landed, given the outbox row's cin7_task_id.
async function landed(row) {
  const t = row.cin7_task_id;
  if (!t) return { done: false };
  if (row.op_type === 'sale_pick') { const p = await cin7.getPick(t); return { done: p && p.Status === 'AUTHORISED' }; }
  if (row.op_type === 'sale_pack') { const p = await cin7.getPack(t); return { done: p && p.Status === 'AUTHORISED' }; }
  if (row.op_type === 'fg_build') { const b = await cin7.getBuild(t); return { done: b && b.Status === 'COMPLETED', cin7_ref: b && b.AssemblyNumber }; }
  if (row.op_type === 'transfer') { const x = await cin7.getTransfer(t); return { done: x && /COMPLETED/i.test(x.Status || ''), cin7_ref: x && x.Number }; }
  if (row.op_type === 'tr_dispatch') { const x = await cin7.getTransfer(t); return { done: x && /IN.?TRANSIT|COMPLETED/i.test(x.Status || ''), cin7_ref: x && x.Number }; }
  return { done: false };
}

async function reconcile(sb, { olderThanSec = 45, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - olderThanSec * 1000).toISOString();
  const { data: rows } = await wms(sb).from('outbox').select('*')
    .in('status', ['sent', 'failed'])
    .lt('sent_at', cutoff)
    .order('sent_at', { ascending: true })
    .limit(limit);
  const out = { checked: 0, reconciled: 0, still_open: 0 };
  for (const row of (rows || [])) {
    out.checked++;
    let v;
    try { v = await landed(row); } catch (e) { v = { done: false, error: String(e.message) }; }
    if (v.done) {
      await wms(sb).from('outbox').update({ status: 'reconciled', cin7_ref: v.cin7_ref || row.cin7_ref, confirmed_at: new Date().toISOString() }).eq('op_key', row.op_key);
      // journal if not already (movement rows are keyed by op_key)
      const { data: have } = await wms(sb).from('movements').select('id').eq('op_key', row.op_key).limit(1);
      if (!have || !have.length) {
        // best-effort: we can't reconstruct line detail here, so record a summary movement
        await wms(sb).from('movements').insert({
          op_key: row.op_key, movement_type: row.op_type, sku: '(reconciled)', qty: 0,
          cin7_ref: v.cin7_ref || row.cin7_ref, actor: 'reconciler',
        });
      }
      out.reconciled++;
    } else {
      out.still_open++;
    }
  }
  return out;
}

module.exports = { reconcile, landed };
