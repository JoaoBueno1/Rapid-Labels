#!/usr/bin/env node
/**
 * Cin7 Finished Goods (Assembly) → movement ledger (cin7_mirror.stock_movements).
 * Closes a blind spot: when a SKU is CONSUMED as a component in an assembly/kit
 * build, stock leaves its bin with NO sales ship + NO Cin7 webhook → we never
 * saw it. This polls finishedGoodsList (recent COMPLETED builds), fetches each
 * detail, and ledgers every PickLine (component consumed: −qty from its bin) as
 * movement_type 'assembly_consume', plus the produced FG (+qty) as
 * 'assembly_produce'. Reference = AssemblyNumber (FG-…).
 *
 * Modes:
 *   (default)        recurring — builds modified in the last ASSEMBLY_SINCE_DAYS
 *   --dry            fetch + parse + print, write nothing
 *   --task=FG-25822  verify a single assembly (search by number), print movements
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *      ASSEMBLY_SINCE_DAYS (default 3), ASSEMBLY_THROTTLE_MS (default 2500)
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.ASSEMBLY_THROTTLE_MS || '2500', 10);
const SINCE_DAYS = parseInt(process.env.ASSEMBLY_SINCE_DAYS || '3', 10);
const DRY = process.argv.includes('--dry');
const TASK = (process.argv.find(a => a.startsWith('--task=')) || '').split('=')[1] || null;
const CAP = parseInt((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
if (!ACC || !CK || (!DRY && !process.env.SUPABASE_SERVICE_KEY)) { console.error('Missing creds'); process.exit(1); }
const cm = (DRY && !process.env.SUPABASE_SERVICE_KEY) ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).schema('cin7_mirror');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '') ? 0 : Number(v);
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
    const back = 5000 * Math.pow(2, _retry);
    console.warn(`  Cin7 ${res.status} — backoff ${back / 1000}s`); await sleep(back); return cin7(path, _retry + 1);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status} ${path.split('?')[0]}`);
  const b = await res.text();
  return b ? JSON.parse(b) : {};
}

const splitBin = loc => (loc && loc.includes(':')) ? loc.split(':').slice(1).join(':').trim() : (loc || null);

// Turn one assembly detail into ledger movements: components OUT + FG IN.
function assemblyMovements(det) {
  const ref = det.AssemblyNumber, date = d(det.CompletionDate || det.WIPDate), loc = det.Location;
  const out = [];
  for (const pl of (det.PickLines || [])) {
    const q = num(pl.Quantity);
    if (!pl.ProductCode || !q) continue;
    out.push({
      detected_at: (date ? date + 'T00:00:00Z' : new Date().toISOString()),
      sku: pl.ProductCode, product_name: pl.Name || null,
      movement_type: 'assembly_consume', reference_number: ref, reference_type: 'Assembly',
      cin7_task_id: det.TaskID, from_location: loc, from_bin: pl.Bin || null,
      to_location: null, to_bin: null, quantity: -Math.abs(q),
      is_internal: true, is_external: false, is_anomaly: false, source: 'assembly-sync',
      raw_data: { assembly: ref, status: det.Status, role: 'component' },
    });
  }
  if (det.ProductCode && num(det.Quantity)) {
    out.push({
      detected_at: (date ? date + 'T00:00:00Z' : new Date().toISOString()),
      sku: det.ProductCode, product_name: det.ProductName || null,
      movement_type: 'assembly_produce', reference_number: ref, reference_type: 'Assembly',
      cin7_task_id: det.TaskID, from_location: null, from_bin: null,
      to_location: loc, to_bin: splitBin(det.Bin) || det.Bin || null, quantity: Math.abs(num(det.Quantity)),
      is_internal: true, is_external: false, is_anomaly: false, source: 'assembly-sync',
      raw_data: { assembly: ref, status: det.Status, role: 'finished_good' },
    });
  }
  return out;
}

async function fetchDetail(taskId) { return cin7(`finishedGoods?TaskID=${taskId}`); }

(async () => {
  let headers = [];
  if (TASK) {
    const list = await cin7(`finishedGoodsList?Search=${encodeURIComponent(TASK)}&Page=1&Limit=20`);
    headers = (list.FinishedGoods || []).filter(h => h.AssemblyNumber === TASK);
    if (!headers.length) { console.error(`FG ${TASK} não encontrado via Search`); process.exit(1); }
  } else {
    // recurring: finishedGoodsList is OLDEST-first → walk from the last page
    // back, collecting recent COMPLETED builds until a page is entirely older.
    const since = new Date(Date.now() - SINCE_DAYS * 86400000).toISOString().split('T')[0];
    const LIMIT = 500;
    const meta = await cin7('finishedGoodsList?Page=1&Limit=1');
    const lastPage = Math.max(1, Math.ceil((meta.Total || 0) / LIMIT));
    for (let page = lastPage; page >= 1; page--) {
      const list = await cin7(`finishedGoodsList?Page=${page}&Limit=${LIMIT}`);
      const fg = list.FinishedGoods || [];
      if (!fg.length) continue;
      headers.push(...fg.filter(h => h.Status === 'COMPLETED' && (!h.Date || d(h.Date) >= since)));
      if (fg.every(h => { const dt = d(h.Date); return dt && dt < since; })) break;
    }
    console.log(`🏭 ${headers.length} assemblies COMPLETED since ${since}`);
  }
  if (CAP > 0) headers = headers.slice(0, CAP);

  let written = 0;
  for (const h of headers) {
    const det = await fetchDetail(h.TaskID);
    const mv = assemblyMovements(det);
    if (TASK || DRY) {
      console.log(`\n  ${det.AssemblyNumber} (${det.Status}) builds ${det.ProductCode} ×${det.Quantity} @ ${det.Location}`);
      for (const m of mv) console.log(`     ${m.movement_type} ${m.sku} ${m.quantity > 0 ? '+' : ''}${m.quantity} bin=${m.from_bin || m.to_bin || '-'}`);
      continue;
    }
    // idempotent per assembly: replace its prior rows (re-run never duplicates)
    await cm.from('stock_movements').delete().eq('cin7_task_id', det.TaskID).eq('source', 'assembly-sync');
    if (mv.length) { const { error } = await cm.from('stock_movements').insert(mv); if (error) throw new Error('insert: ' + error.message); }
    written += mv.length;
  }
  if (DRY || TASK) { console.log('\nDRY/verify — nada gravado.'); process.exit(0); }
  console.log(`✅ ${written} assembly movements ledgered (${headers.length} builds).`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
