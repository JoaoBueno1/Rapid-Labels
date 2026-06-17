#!/usr/bin/env node
/**
 * Cin7 Stock Transfers → Supabase mirror (cin7_mirror.stock_transfers).
 * Cin7 has NO transfer webhook, so this POLLS: it captures the OPEN transfers
 * (IN TRANSIT + DRAFT) plus the most-recently-modified ones (to catch status
 * changes / completions), and upserts by TaskID. Header-only (no detail fetch),
 * so it's cheap (~4 list calls). Run once now, then on a GitHub Actions cron.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 * Usage: node cin7-stock-sync/sync-transfers.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.TRANSFER_THROTTLE_MS || '2500', 10);
if (!process.env.SUPABASE_SERVICE_KEY || !ACC || !CK) { console.error('Missing creds'); process.exit(1); }
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
  if (!res.ok) throw new Error(`Cin7 ${res.status}`);
  return res.json();
}

function mapTransfer(t) {
  return {
    task_id: t.TaskID, number: t.Number,
    from_location: t.FromLocation || null, to_location: t.ToLocation || null,
    status: t.Status || null, reference: t.Reference || null,
    departure_date: d(t.DepartureDate), completion_date: d(t.CompletionDate),
    cin7_updated: t.LastModifiedOn || null, synced_at: new Date().toISOString(), source: 'poll',
  };
}

async function fetchAll(qs) {
  let page = 1, out = [];
  while (page <= 30) {
    const data = await cin7(`stockTransferList?Page=${page}&Limit=100&${qs}`);
    const list = data.StockTransferList || [];
    out.push(...list);
    if (list.length < 100) break;
    page++;
  }
  return out;
}

(async () => {
  const open = [...await fetchAll('Status=IN%20TRANSIT'), ...await fetchAll('Status=DRAFT')];
  // most-recently-modified (any status) → catches completions/changes since last poll
  const recent = (await cin7('stockTransferList?Page=1&Limit=200')).StockTransferList || [];
  const byId = new Map();
  for (const t of [...open, ...recent]) if (t.TaskID) byId.set(t.TaskID, t);
  const rows = [...byId.values()].map(mapTransfer);
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await cm.from('stock_transfers').upsert(rows.slice(i, i + 200), { onConflict: 'task_id' });
    if (error) throw new Error('upsert: ' + error.message);
  }
  console.log(`✅ ${rows.length} transfers upserted (${open.length} open, ${recent.length} recent).`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
