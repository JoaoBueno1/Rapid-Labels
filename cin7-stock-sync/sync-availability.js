#!/usr/bin/env node
/**
 * Cin7 Product Availability → Supabase mirror (cin7_mirror.stock_availability).
 * Pulls GET /ref/productavailability (per SKU + location + bin: OnHand /
 * Allocated / Available / OnOrder / InTransit) and AGGREGATES to (sku, location)
 * — the "Have stock" + backorder signal the chase email needs. Full snapshot:
 * upserts every (sku, location) with this run's synced_at, then deletes rows
 * left behind (sku that fell off). Cheap (~15 list calls for ~14k rows).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *      AVAIL_THROTTLE_MS (default 2500)
 * Usage: node cin7-stock-sync/sync-availability.js          (writes)
 *        node cin7-stock-sync/sync-availability.js --dry     (fetch+aggregate, print only)
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.AVAIL_THROTTLE_MS || '2500', 10);
const DRY = process.argv.includes('--dry');
if (!ACC || !CK || (!DRY && !process.env.SUPABASE_SERVICE_KEY)) { console.error('Missing creds'); process.exit(1); }
const sb = DRY ? null : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cm = sb ? sb.schema('cin7_mirror') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = v => (v ? String(v).split('T')[0] : null);
const num = v => (v == null || v === '') ? 0 : Number(v);
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
    console.warn(`  Cin7 ${res.status} — backoff ${back / 1000}s`); await sleep(back); return cin7(path, _retry + 1);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status}`);
  return res.json();
}

(async () => {
  const runAt = new Date().toISOString();
  const agg = new Map(); // key: sku\x00location
  let page = 1, rows = 0;
  while (page <= 40) {
    const data = await cin7(`ref/productavailability?Page=${page}&Limit=1000`);
    const list = data.ProductAvailabilityList || [];
    if (!list.length) break;
    for (const a of list) {
      const sku = a.SKU, loc = a.Location;
      if (!sku || !loc) continue;
      const k = sku + '\x00' + loc;
      let r = agg.get(k);
      if (!r) { r = { sku, location: loc, on_hand: 0, allocated: 0, available: 0, on_order: 0, in_transit: 0, next_delivery: null }; agg.set(k, r); }
      r.on_hand += num(a.OnHand); r.allocated += num(a.Allocated); r.available += num(a.Available);
      r.on_order += num(a.OnOrder); r.in_transit += num(a.InTransit);
      const nd = d(a.NextDeliveryDate); if (nd && (!r.next_delivery || nd < r.next_delivery)) r.next_delivery = nd;
    }
    rows += list.length;
    if (page % 3 === 0) console.log(`  page ${page}: ${rows}/${data.Total} rows, ${agg.size} (sku,loc) so far`);
    if (list.length < 1000) break;
    page++;
  }
  const out = [...agg.values()].map(r => ({ ...r, synced_at: runAt }));
  console.log(`📦 ${rows} raw rows → ${out.length} (sku,location) aggregated.`);

  if (DRY) {
    const sample = out.filter(r => r.location === 'Main Warehouse').slice(0, 5);
    console.log('  amostra Main Warehouse:', JSON.stringify(sample, null, 0).slice(0, 600));
    const short = out.filter(r => r.available < 0).length;
    console.log(`  (sku,loc) com Available<0 (B/O): ${short}`);
    console.log('  DRY RUN — nada gravado.');
    process.exit(0);
  }

  for (let i = 0; i < out.length; i += 500) {
    const { error } = await cm.from('stock_availability').upsert(out.slice(i, i + 500), { onConflict: 'sku,location' });
    if (error) throw new Error('upsert: ' + error.message);
  }
  // drop rows that vanished from this snapshot
  const { error: delErr } = await cm.from('stock_availability').delete().lt('synced_at', runAt);
  if (delErr) console.warn('  ⚠️ stale cleanup:', delErr.message);
  console.log(`✅ stock_availability refreshed — ${out.length} (sku,location) rows.`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
