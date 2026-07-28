#!/usr/bin/env node
/**
 * Reconcile cin7_mirror.stock_transfers against Cin7 truth — closes PHANTOM
 * "open" transfers.
 *
 * Why this is needed: sync-transfers.js captures live changes by re-fetching the
 * currently-open (IN TRANSIT/DRAFT) set + the 200 most-recently-modified. A
 * transfer that COMPLETES and then ages out of that 200-window is never touched
 * again, so its mirror row stays 'IN TRANSIT' forever (observed: mirror had 232
 * IN TRANSIT vs 23 live in Cin7 — ~90% phantom). Cin7 ignores ModifiedSince on
 * stockTransferList, so we can't sweep by date; instead we reconcile the OPEN SET:
 *
 *   Cin7's IN TRANSIT + ORDERED lists are authoritative and cheap (a couple of
 *   list calls). Any mirror row still marked IN TRANSIT/ORDERED whose TaskID is
 *   NOT in those live sets has left transit → confirm its real status via
 *   Search (1 call) and write it back. DRAFT is left alone (drafts linger and the
 *   live count matches the mirror).
 *
 * Safety: if the authoritative fetch comes back empty (an API blip), we ABORT the
 * close pass rather than wrongly closing everything.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *      RECONCILE_TR_THROTTLE_MS (default 2000 = 30/min)
 *      RECONCILE_TR_CAP         (default 500 — max phantoms to confirm per run)
 * Usage: node cin7-stock-sync/reconcile-transfers.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.RECONCILE_TR_THROTTLE_MS || '2000', 10);
const CAP = parseInt(process.env.RECONCILE_TR_CAP || '500', 10);
if (!process.env.SUPABASE_SERVICE_KEY || !ACC || !CK) { console.error('Missing SUPABASE_SERVICE_KEY / CIN7 creds'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cm = sb.schema('cin7_mirror');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = v => (v ? String(v).split('T')[0] : null);
let lastCall = 0;

async function cin7(path, _retry = 0) {
  const wait = Math.max(0, THROTTLE - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
  let res;
  try { res = await fetch(`${BASE}/${path}`, { headers: { 'api-auth-accountid': ACC, 'api-auth-applicationkey': CK, 'Accept': 'application/json' } }); }
  catch (e) { if (_retry < 5) { await sleep(5000); return cin7(path, _retry + 1); } throw e; }
  if ((res.status === 429 || res.status === 403) && _retry < 5) {
    const back = 4000 * Math.pow(2, _retry);
    console.warn(`  Cin7 ${res.status} — backoff ${back / 1000}s`);
    await sleep(back); return cin7(path, _retry + 1);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status} ${path.split('?')[0]}`);
  return res.json();
}

// Full paged pull of one status (the live open sets are small — a page or two).
async function fetchStatus(status) {
  let page = 1, out = [];
  while (page <= 40) {
    const data = await cin7(`stockTransferList?Page=${page}&Limit=100&Status=${encodeURIComponent(status)}`);
    const list = data.StockTransferList || [];
    out.push(...list);
    if (list.length < 100) break;
    page++;
  }
  return out;
}

// Confirm one transfer's CURRENT status by number (Search is not status-filtered).
async function confirm(number) {
  const data = await cin7(`stockTransferList?Page=1&Limit=10&Search=${encodeURIComponent(number)}`);
  const list = data.StockTransferList || [];
  return list.find(t => t.Number === number) || null;
}

(async () => {
  console.log('🔎 Reconcile transfers — fetching live open sets from Cin7…');
  const inTransit = await fetchStatus('IN TRANSIT');
  const ordered = await fetchStatus('ORDERED');
  const liveOpen = new Set([...inTransit, ...ordered].map(t => t.TaskID));
  console.log(`   live: ${inTransit.length} IN TRANSIT + ${ordered.length} ORDERED = ${liveOpen.size} open TaskIDs`);

  // Safety: an empty authoritative fetch is almost certainly an API blip — do NOT
  // interpret it as "everything completed" and wipe the board.
  if (liveOpen.size === 0) { console.error('❌ Live open set is EMPTY — aborting to avoid mass false-closes.'); process.exit(1); }

  const { data: mirrorOpen, error } = await cm.from('stock_transfers')
    .select('task_id,number,status').in('status', ['IN TRANSIT', 'ORDERED']);
  if (error) throw new Error('mirror read: ' + error.message);
  const fellOff = (mirrorOpen || []).filter(r => !liveOpen.has(r.task_id));
  console.log(`   mirror open: ${(mirrorOpen || []).length} | phantom (left transit): ${fellOff.length}`);
  if (!fellOff.length) { console.log('✅ Nothing to reconcile — mirror already matches Cin7.'); process.exit(0); }

  let closed = 0, missing = 0; const byStatus = {};
  for (const r of fellOff.slice(0, CAP)) {
    let hit;
    try { hit = await confirm(r.number); }
    catch (e) { console.warn(`  ✗ ${r.number}: confirm failed (${e.message}) — skipping`); continue; }
    if (!hit) { missing++; console.warn(`  ? ${r.number}: not found in Search — leaving as-is`); continue; }
    const newStatus = hit.Status || 'COMPLETED';
    const { error: ue } = await cm.from('stock_transfers').update({
      status: newStatus,
      completion_date: d(hit.CompletionDate),
      departure_date: d(hit.DepartureDate) || undefined,
      cin7_updated: hit.LastModifiedOn || null,
      synced_at: new Date().toISOString(),
      source: 'reconcile',
    }).eq('task_id', r.task_id);
    if (ue) { console.warn(`  ✗ ${r.number}: update failed (${ue.message})`); continue; }
    byStatus[newStatus] = (byStatus[newStatus] || 0) + 1;
    closed++;
    if (closed % 25 === 0) console.log(`   … ${closed}/${fellOff.length} reconciled`);
  }
  console.log(`✅ Reconciled ${closed} phantom transfers ${JSON.stringify(byStatus)}${missing ? ` (${missing} not found)` : ''}.`);
  if (fellOff.length > CAP) console.log(`   ⚠️ ${fellOff.length - CAP} more remain (CAP=${CAP}) — re-run to finish.`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
