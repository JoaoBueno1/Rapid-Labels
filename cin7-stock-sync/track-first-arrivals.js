#!/usr/bin/env node
/**
 * track-first-arrivals.js — log the FIRST time each SKU appears WITH STOCK at
 * Main Warehouse, for a future "New Products (arrived this month)" view.
 *
 * ZERO extra Cin7 calls: it reads the cin7_mirror.stock_snapshot that the
 * hourly stock sync ALREADY pulls, and writes new SKUs into
 * cin7_mirror.product_first_arrival (see migrations/product_first_arrival.sql).
 *
 * Forward-only + idempotent:
 *   - FIRST run (table empty) → seed every in-stock SKU as is_baseline=true
 *     with first_arrival_date=NULL (they pre-date tracking, NOT "arrived today").
 *   - Later runs → any SKU newly in stock gets first_arrival_date = today (AEST).
 * So "arrived this month" = is_baseline=false AND first_arrival_date >= month start.
 *
 * Usage: node cin7-stock-sync/track-first-arrivals.js [--dry]
 * Needs: SUPABASE_URL, SUPABASE_SERVICE_KEY (no Cin7 creds).
 */
'use strict';
const fs = require('fs'), path = require('path');

function loadEnv() {
  const out = { ...process.env }, p = path.join(__dirname, '..', '.env');
  if (fs.existsSync(p)) for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}
const E = loadEnv();
const U = (E.SUPABASE_URL || '').replace(/\/$/, '');
const K = E.SUPABASE_SERVICE_KEY || E.SUPABASE_ANON_KEY;
const DRY = process.argv.includes('--dry');
const LOCATION = 'Main Warehouse';
if (!U || !K) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(2); }

const H = (extra) => Object.assign(
  { apikey: K, Authorization: `Bearer ${K}`, 'Accept-Profile': 'cin7_mirror', 'Content-Profile': 'cin7_mirror' },
  extra || {});

async function getAll(query) {
  const rows = [], page = 1000;
  for (let off = 0; ; off += page) {
    const sep = query.includes('?') ? '&' : '?';
    const r = await fetch(`${U}/rest/v1/${query}${sep}limit=${page}&offset=${off}`, { headers: H() });
    if (!r.ok) { const err = new Error(`GET ${query} → ${r.status}`); err.status = r.status; err.body = await r.text(); throw err; }
    const b = await r.json(); rows.push(...b);
    if (b.length < page) break;
  }
  return rows;
}

(async () => {
  // 0) the table must exist (apply migrations/product_first_arrival.sql first).
  //    Skip gracefully (not red) until it does, so the cron stays clean.
  let known;
  try {
    known = new Set((await getAll('product_first_arrival?select=sku')).map((r) => r.sku));
  } catch (e) {
    if (e.status === 404 || /relation .* does not exist|PGRST205|42P01/.test(e.body || '')) {
      console.log('[first-arrivals] product_first_arrival table not created yet — apply migrations/product_first_arrival.sql. Skipping.');
      return;
    }
    throw e;
  }

  // 1) SKUs currently in stock at Main Warehouse (from the snapshot the stock sync just wrote)
  const snap = await getAll(`stock_snapshot?select=sku,on_hand&location_name=eq.${encodeURIComponent(LOCATION)}&on_hand=gt.0`);
  const inStock = new Map();
  for (const r of snap) {
    const q = parseFloat(r.on_hand) || 0;
    if (q > 0 && r.sku && (!inStock.has(r.sku) || q > inStock.get(r.sku))) inStock.set(r.sku, q);
  }

  const fresh = [...inStock.keys()].filter((s) => !known.has(s));
  const baseline = known.size === 0;              // first ever run → seed existing, don't claim "arrived today"
  const today = new Date(Date.now() + 10 * 3600e3).toISOString().slice(0, 10); // Brisbane (UTC+10) date

  console.log(`[first-arrivals] in-stock@Main=${inStock.size} known=${known.size} new=${fresh.length} mode=${baseline ? 'BASELINE-SEED' : 'track'}`);
  if (!fresh.length) { console.log('[first-arrivals] nothing new'); return; }

  const rowsOut = fresh.map((s) => ({
    sku: s, on_hand_at_arrival: inStock.get(s), location: LOCATION,
    is_baseline: baseline, first_arrival_date: baseline ? null : today,
  }));

  if (DRY) { console.log(`[first-arrivals] DRY — would insert ${rowsOut.length}; sample:`, rowsOut.slice(0, 5)); return; }

  for (let i = 0; i < rowsOut.length; i += 500) {
    const batch = rowsOut.slice(i, i + 500);
    const r = await fetch(`${U}/rest/v1/product_first_arrival`, {
      method: 'POST',
      headers: H({ 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' }),
      body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`INSERT → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  console.log(`[first-arrivals] logged ${rowsOut.length} ${baseline ? 'baseline' : 'NEW first-arrival'} SKUs`);
})().catch((e) => { console.error('[first-arrivals] FATAL', e.message); process.exit(1); });
