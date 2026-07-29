/**
 * outbox.js — the exactly-once write ledger. THE core discipline of this WMS.
 *
 * Cin7 has NO idempotency key and an AUTHORISED fulfilment cannot be undone, so a
 * naive timeout-retry double-moves real stock. This module makes every Cin7 write
 * safe:
 *
 *   1. enqueue(op)   → persist the intent with a DETERMINISTIC op_key (unique).
 *                      Re-enqueuing the same intent is a no-op (returns existing row).
 *   2. execute(...)  → flip pending→sent BEFORE the HTTP call. On a prior 'sent'
 *                      (ambiguous) op, RECONCILE via verify() against live Cin7 before
 *                      ever re-sending. Confirm only on verified success.
 *   3. journal(...)  → append the resulting movements to wms.movements (append-only),
 *                      guarded so a reconcile never double-journals.
 *
 * All state lives in wms.* via the service-role Supabase client (schema 'wms').
 */
'use strict';

const crypto = require('crypto');

function wms(sb) { return sb.schema('wms'); }

// Deterministic op_key: same intent → same key → the UNIQUE(op_key) constraint dedups.
function opKey(...parts) {
  const raw = parts.map((p) => (typeof p === 'object' ? JSON.stringify(p) : String(p))).join('|');
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

// 1) record the intent (idempotent).
async function enqueue(sb, { op_key, op_type, target, method = 'POST', cin7_task_id = null, payload, created_by }) {
  const row = { op_key, op_type, target, method, cin7_task_id, payload, created_by, status: 'pending' };
  const { data, error } = await wms(sb).from('outbox')
    .upsert(row, { onConflict: 'op_key', ignoreDuplicates: true })
    .select().maybeSingle();
  if (error && !/duplicate/i.test(error.message)) throw new Error(`outbox.enqueue: ${error.message}`);
  if (data) return data;
  // upsert ignored the duplicate → fetch the existing intent
  const { data: existing } = await wms(sb).from('outbox').select('*').eq('op_key', op_key).maybeSingle();
  return existing;
}

async function load(sb, op_key) {
  const { data } = await wms(sb).from('outbox').select('*').eq('op_key', op_key).maybeSingle();
  return data;
}
async function patch(sb, op_key, fields) {
  await wms(sb).from('outbox').update(fields).eq('op_key', op_key);
}

/**
 * execute — the write-once gate.
 *   doWrite: async () => ({ cin7_ref, cin7_task_id?, response })   // the actual Cin7 call
 *   verify:  async () => boolean | { done, cin7_ref, response }    // did it already land? (reconcile)
 *   movements: [] | () => []   // journal entries to append on success
 * Returns { status:'confirmed'|'failed', alreadyDone, cin7_ref, response }.
 */
async function execute(sb, op_key, { doWrite, verify, movements, actor }) {
  let row = await load(sb, op_key);
  if (!row) throw new Error(`outbox.execute: unknown op_key ${op_key} (enqueue first)`);

  if (row.status === 'confirmed' || row.status === 'reconciled') {
    return { status: 'confirmed', alreadyDone: true, cin7_ref: row.cin7_ref, response: row.response };
  }

  // Ambiguous prior attempt: reconcile against live Cin7 BEFORE any re-send.
  if (row.status === 'sent' && typeof verify === 'function') {
    const v = await verify();
    const done = v === true || (v && v.done);
    if (done) {
      const cin7_ref = (v && v.cin7_ref) || row.cin7_ref;
      const response = (v && v.response) || row.response;
      await patch(sb, op_key, { status: 'reconciled', cin7_ref, response, confirmed_at: new Date().toISOString() });
      await journalIfAbsent(sb, op_key, movements, actor);
      return { status: 'confirmed', alreadyDone: true, cin7_ref, response };
    }
    // not landed → safe to (re)send below
  }

  // Atomic claim: only ONE worker may flip this op into 'sent' from the exact status
  // we loaded. A concurrent double-submit with the same op_key (double-tap, client
  // timeout-retry mid-flight, a second device) loses the race here and bails instead
  // of issuing a second Cin7 write. Single-worker behaviour is unchanged.
  const { data: claimed } = await wms(sb).from('outbox')
    .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: (row.attempts || 0) + 1 })
    .eq('op_key', op_key).eq('status', row.status).select('op_key');
  if (!claimed || !claimed.length) {
    const fresh = await load(sb, op_key);
    if (fresh && (fresh.status === 'confirmed' || fresh.status === 'reconciled')) {
      return { status: 'confirmed', alreadyDone: true, cin7_ref: fresh.cin7_ref, response: fresh.response };
    }
    throw new Error(`outbox.execute: op ${op_key} is being processed concurrently (status=${fresh && fresh.status}); not re-sending`);
  }
  try {
    const out = await doWrite();
    await patch(sb, op_key, {
      status: 'confirmed', confirmed_at: new Date().toISOString(),
      cin7_ref: out.cin7_ref || null, cin7_task_id: out.cin7_task_id || row.cin7_task_id || null,
      response: out.response || null, http_status: 200, last_error: null,
    });
    await journalIfAbsent(sb, op_key, movements, actor);
    return { status: 'confirmed', alreadyDone: false, cin7_ref: out.cin7_ref, response: out.response };
  } catch (e) {
    await patch(sb, op_key, { status: 'failed', last_error: String(e.message || e) });
    throw e;
  }
}

// Append to the immutable journal, but only once per op_key.
async function journalIfAbsent(sb, op_key, movements, actor) {
  let rows = typeof movements === 'function' ? movements() : movements;
  if (!rows || !rows.length) return;
  const { data: existing } = await wms(sb).from('movements').select('id').eq('op_key', op_key).limit(1);
  if (existing && existing.length) return; // already journaled (reconcile path)
  rows = rows.map((m) => Object.assign({ op_key, actor: m.actor || actor || 'system' }, m));
  const { error } = await wms(sb).from('movements').insert(rows);
  if (error) throw new Error(`outbox.journal: ${error.message}`);
}

module.exports = { opKey, enqueue, execute, load, patch };
