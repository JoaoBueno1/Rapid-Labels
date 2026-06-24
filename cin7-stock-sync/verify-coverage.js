#!/usr/bin/env node
/**
 * verify-coverage.js — Daily Pick Anomalies coverage & integrity check.
 *
 * Answers, every morning, the question: "Is the Pick Anomalies page still
 * capturing EVERYTHING (every in-scope order, assembly/FG and movement) and
 * tracking the source bin correctly?" — and flags it the moment it stops.
 *
 * It is READ-ONLY: it only issues GET requests against Supabase (cin7_mirror +
 * public). It NEVER calls the Cin7 API (inventory.dearsystems.com) and never
 * writes anything. Safe to run as often as you like.
 *
 * The 7 checks (derived from the 2026-06-22 coverage audit):
 *   1. Sales capture gap (48h)   HIGH      — every SHIPPED Main-WH order is analysed
 *   2. Standalone assembly (48h) MEDIUM    — every actionable FG build is analysed
 *   3. Movement freshness        HIGH      — the ledger is alive (rows landing today)
 *   4. Webhook backlog/deadletter CRITICAL — sale/ship capture is 100% webhook-fed
 *   5. Snapshot freshness        MEDIUM    — the daily stock snapshot refreshed
 *   6. MW no-bin blind-spot      MEDIUM    — share of MW ships with no source bin
 *   7. Cron / Actions liveness   HIGH      — the 2h/6h sync jobs actually ran
 *
 * Usage:
 *   node cin7-stock-sync/verify-coverage.js            # human report, exit 1 on any FAIL
 *   node cin7-stock-sync/verify-coverage.js --json      # machine-readable JSON
 *   node cin7-stock-sync/verify-coverage.js --days=3    # widen the sales/assembly window
 *
 * Exit code: 0 if no FAIL (WARN is allowed), 1 if any check FAILs, 2 on a fatal error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Tunables — edit here, not in the checks.
// ─────────────────────────────────────────────────────────────────────────────
const CFG = {
  SCANNER_CUTOFF: '2026-03-26',   // engine hard floor — orders shipped before this are out of scope by design
  BRISBANE_OFFSET_H: 10,          // cin7 dates are Brisbane-local; timestamptz cols are real UTC
  SALES: { defaultDays: 4, failRate: 0.02 },   // 4d so the window always spans business days even after a weekend; FAIL if >2% of orders shipped before today are unanalysed
  ASSEMBLY: { defaultDays: 3 },
  MOVEMENT: { staleWarnH: 6, staleFailH: 18 }, // ledger MAX(detected_at) age
  WEBHOOK: { pendingAgeH: 0.5, lastShipWarnH: 6 },
  SNAPSHOT: { staleWarnH: 24, staleFailH: 36 },
  NOBIN: { rateWarn: 0.15 },                   // MW empty-bin rate; baseline ~8.8%
  CRON: { saleWarnH: 2.5, saleFailH: 5, movWarnH: 6.5, movFailH: 14 },
  LIST_CAP: 15,                                // how many example ids to print per check
};

// ─────────────────────────────────────────────────────────────────────────────
// Env + HTTP
// ─────────────────────────────────────────────────────────────────────────────
function loadEnv() {
  const out = { ...process.env };
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}
const ENV = loadEnv();
const U = (ENV.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = ENV.SUPABASE_SERVICE_KEY || ENV.SUPABASE_ANON_KEY || ENV.SUPABASE_KEY;
if (!U || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in env or .env'); process.exit(2); }

function headers(profile, extra) {
  const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  if (profile) h['Accept-Profile'] = profile;
  return Object.assign(h, extra || {});
}

// GET rows (paged so we never silently truncate at PostgREST's 1000-row default).
async function sb(query, profile) {
  const rows = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const sep = query.includes('?') ? '&' : '?';
    const url = `${U}/rest/v1/${query}${sep}limit=${page}&offset=${offset}`;
    const res = await fetch(url, { headers: headers(profile) });
    if (!res.ok) throw new Error(`GET ${query} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

// Exact row count via Content-Range (cheap — no body).
async function sbCount(query, profile) {
  const sep = query.includes('?') ? '&' : '?';
  const res = await fetch(`${U}/rest/v1/${query}${sep}limit=1`, {
    headers: headers(profile, { Prefer: 'count=exact', Range: '0-0' }),
  });
  if (!res.ok && res.status !== 206) throw new Error(`COUNT ${query} → ${res.status}`);
  const cr = res.headers.get('content-range');
  return cr && cr.includes('/') ? parseInt(cr.split('/')[1], 10) : 0;
}

const enc = encodeURIComponent;

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers
// ─────────────────────────────────────────────────────────────────────────────
const NOW = Date.now();
function briDate(minusDays = 0) {
  const d = new Date(NOW + CFG.BRISBANE_OFFSET_H * 3600e3 - minusDays * 86400e3);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (Brisbane calendar date)
}
function hoursAgoISO(h) { return new Date(NOW - h * 3600e3).toISOString(); }
function ageH(ts) { return ts ? (NOW - new Date(ts).getTime()) / 3600e3 : Infinity; }
function fmtAge(ts) { const h = ageH(ts); return isFinite(h) ? (h < 1 ? `${Math.round(h * 60)}min` : `${h.toFixed(1)}h`) : 'never'; }

// ─────────────────────────────────────────────────────────────────────────────
// Check result helper
// ─────────────────────────────────────────────────────────────────────────────
function R(name, severity) { return { name, severity, status: 'PASS', detail: '', lines: [] }; }

// ── 1. Sales capture gap (last N days) ──────────────────────────────────────
// A "miss" only counts if the order had a REAL MA- pick bin yet has no analysis
// row. Orders whose lines are all bin-less (assembly/BOM/Production) are skipped
// by the engine on purpose — counting them as misses (as an earlier pass did)
// inflates the leak. So we cross-reference the sales_ship ledger and split:
//   genuine  = missing AND has an MA- source bin  → real failure (FAIL)
//   binless  = missing AND ships exist but all bin-less → engine-skipped (OK)
//   noLedger = missing AND no sales_ship row at all → ambiguous (WARN, review)
async function checkSalesGap(days) {
  const r = R('Sales capture gap (last ' + days + 'd)', 'high');
  let shipFrom = briDate(days);
  if (shipFrom < CFG.SCANNER_CUTOFF) shipFrom = CFG.SCANNER_CUTOFF;
  const today = briDate(0);

  const shipped = await sb(
    `sales_orders?select=order_number,ship_date,customer&shipping_status=eq.SHIPPED` +
    `&location_name=eq.${enc('Main Warehouse')}&service_only=not.is.true&ship_date=gte.${shipFrom}`,
    'cin7_mirror');
  const analysed = new Set(
    (await sb(`pick_anomaly_orders?select=order_number&entity_type=eq.sale&fulfilled_date=gte.${briDate(days + 1)}`))
      .map((o) => o.order_number));
  const missing = shipped.filter((o) => !analysed.has(o.order_number));

  // cross-reference the sales_ship ledger to find which missing orders had a real bin
  const hasMa = {}, hasMv = {};
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100).map((o) => `"${o.order_number}"`).join(',');
    const mv = await sb(`stock_movements?select=reference_number,from_bin&movement_type=eq.sales_ship&reference_number=in.(${enc(batch)})`, 'cin7_mirror');
    for (const m of mv) { hasMv[m.reference_number] = true; if (/^MA-/i.test((m.from_bin || '').trim())) hasMa[m.reference_number] = true; }
  }
  const aged = (o) => o.ship_date && o.ship_date < today;
  const genuine = missing.filter((o) => hasMa[o.order_number]);
  const binless = missing.filter((o) => hasMv[o.order_number] && !hasMa[o.order_number]);
  const noLedger = missing.filter((o) => !hasMv[o.order_number]);
  const agedGenuine = genuine.filter(aged), agedNoLedger = noLedger.filter(aged);

  r.detail = `${shipped.length} MW SHIPPED since ${shipFrom} · not-in-page ${missing.length} → ` +
    `genuine MA-bin miss ${genuine.length} (aged ${agedGenuine.length}) · bin-less assembly/BOM (engine-skipped, OK) ${binless.length} · no-ledger ${noLedger.length}`;
  if (agedGenuine.length > 0) r.status = 'FAIL';
  else if (agedNoLedger.length > 0) r.status = 'WARN';
  r.lines = agedGenuine.slice(0, CFG.LIST_CAP).map((o) => `GENUINE MISS ${o.order_number} (MA-bin pick, ship ${o.ship_date}${o.customer ? ', ' + o.customer : ''})`);
  r.lines.push(...agedNoLedger.slice(0, 6).map((o) => `REVIEW ${o.order_number} (no sales_ship movement — bin-less or processing fail, ship ${o.ship_date})`));
  return r;
}

// ── 2. Standalone assembly capture (last N days) ────────────────────────────
async function checkAssemblyGap(days) {
  const r = R('Standalone assembly capture (last ' + days + 'd)', 'medium');
  const since = hoursAgoISO(days * 24);
  const produce = await sb(`stock_movements?select=reference_number,cin7_task_id&movement_type=eq.assembly_produce&detected_at=gte.${since}`, 'cin7_mirror');
  const consume = await sb(`stock_movements?select=reference_number,from_bin&movement_type=eq.assembly_consume&detected_at=gte.${since}`, 'cin7_mirror');

  // actionable = an FG whose components include at least one real MA- source bin
  const actionable = new Set();
  for (const c of consume) if (/^MA-/i.test(c.from_bin || '')) actionable.add(c.reference_number);

  // task id per FG (for the so_linked containment check)
  const taskByRef = {};
  const refs = new Set();
  for (const p of produce) { refs.add(p.reference_number); if (p.cin7_task_id) taskByRef[p.reference_number] = p.cin7_task_id; }

  const standalone = new Set((await sb(`pick_anomaly_orders?select=order_number&entity_type=eq.assembly`)).map((o) => o.order_number));

  const genuineMisses = [];
  let soLinked = 0, notActionable = 0;
  for (const ref of refs) {
    if (standalone.has(ref)) continue;                 // captured standalone
    if (!actionable.has(ref)) { notActionable++; continue; } // no MA- bin → nothing to flag (by design)
    const tid = taskByRef[ref];
    let linked = false;
    if (tid) {
      const hit = await sb(`pick_anomaly_orders?select=order_number&fg_orders=cs.${enc(JSON.stringify([{ taskId: tid }]))}&limit=1`);
      linked = hit.length > 0;
    }
    if (linked) soLinked++; else genuineMisses.push(ref);
  }

  r.detail = `${refs.size} FG builds · standalone ${[...refs].filter((x) => standalone.has(x)).length} · so-linked ${soLinked} · non-actionable ${notActionable} · genuine misses ${genuineMisses.length}`;
  if (genuineMisses.length > 0) r.status = 'WARN';
  r.lines = genuineMisses.slice(0, CFG.LIST_CAP).map((f) => `MISSED ${f} (has MA- consume bin, not standalone, not SO-linked)`);
  return r;
}

// ── 3. Movement freshness ───────────────────────────────────────────────────
// NB: detected_at is OVERLOADED — ingest time for webhook rows but the
// TRANSACTION date for poll-sync rows, which can be in the FUTURE (e.g. a
// transfer dated next week). Cap every freshness read at `now` so a future-
// dated transaction can't masquerade as "the latest activity".
async function checkMovementFreshness() {
  const r = R('Movement freshness (ledger alive)', 'high');
  const nowIso = hoursAgoISO(0);
  const max = (await sb(`stock_movements?select=detected_at&detected_at=lte.${nowIso}&order=detected_at.desc&limit=1`, 'cin7_mirror'))[0];
  const recent = await sb(`stock_movements?select=source,movement_type&detected_at=gte.${hoursAgoISO(24)}&detected_at=lte.${nowIso}`, 'cin7_mirror');
  const bySrc = {}, byType = {};
  for (const m of recent) { bySrc[m.source] = (bySrc[m.source] || 0) + 1; byType[m.movement_type] = (byType[m.movement_type] || 0) + 1; }
  const maxAge = ageH(max && max.detected_at);

  r.detail = `MAX detected_at ${fmtAge(max && max.detected_at)} ago · last 24h: ${recent.length} rows ` +
    `(${Object.entries(bySrc).map(([k, v]) => k + '=' + v).join(', ') || 'none'})`;
  if (recent.length === 0 || maxAge > CFG.MOVEMENT.staleFailH) r.status = 'FAIL';
  else if (maxAge > CFG.MOVEMENT.staleWarnH || (byType.sales_ship || 0) === 0) r.status = 'WARN';
  r.lines = [`by type: ${Object.entries(byType).map(([k, v]) => k + '=' + v).join(', ') || 'none'}`];
  if ((byType.sales_ship || 0) === 0) r.lines.push('⚠ no sales_ship in 24h (weekend? or webhook stalled — cross-check #4)');
  return r;
}

// ── 4. Webhook backlog / dead-letter ────────────────────────────────────────
async function checkWebhookBacklog() {
  const r = R('Webhook backlog / dead-letter', 'critical');
  const pendingOld = await sbCount(`webhook_events?status=eq.pending&received_at=lt.${hoursAgoISO(CFG.WEBHOOK.pendingAgeH)}`, 'cin7_mirror');
  const failed24 = await sbCount(`webhook_events?status=eq.failed&received_at=gte.${hoursAgoISO(24)}`, 'cin7_mirror');
  const lastShip = (await sb(`webhook_events?select=received_at&event_type=eq.${enc('Sale/ShipmentAuthorised')}&order=received_at.desc&limit=1`, 'cin7_mirror'))[0];

  r.detail = `pending>${CFG.WEBHOOK.pendingAgeH}h: ${pendingOld} · failed(24h): ${failed24} · last ShipmentAuthorised ${fmtAge(lastShip && lastShip.received_at)} ago`;
  if (pendingOld > 0 || failed24 > 0) r.status = 'FAIL';
  else if (ageH(lastShip && lastShip.received_at) > CFG.WEBHOOK.lastShipWarnH) r.status = 'WARN';
  if (pendingOld > 0) r.lines.push(`${pendingOld} events stuck pending >30min — drain/queue not flowing`);
  if (failed24 > 0) r.lines.push(`${failed24} events dead-lettered in 24h — their movements/analysis are LOST`);
  return r;
}

// ── 5. Snapshot freshness ───────────────────────────────────────────────────
async function checkSnapshotFreshness() {
  const r = R('Stock snapshot freshness', 'medium');
  const max = (await sb(`stock_snapshot?select=synced_at&order=synced_at.desc&limit=1`, 'cin7_mirror'))[0];
  const a = ageH(max && max.synced_at);
  r.detail = `MAX synced_at ${fmtAge(max && max.synced_at)} ago`;
  if (a > CFG.SNAPSHOT.staleFailH) r.status = 'FAIL';
  else if (a > CFG.SNAPSHOT.staleWarnH) r.status = 'WARN';
  return r;
}

// ── 6. MW no-bin blind-spot rate ────────────────────────────────────────────
async function checkNoBinRate() {
  const r = R('MW no-bin blind-spot (last 24h)', 'medium');
  const ships = await sb(`stock_movements?select=sku,from_bin&movement_type=eq.sales_ship&from_location=like.${enc('Main Warehouse*')}&detected_at=gte.${hoursAgoISO(24)}`, 'cin7_mirror');
  if (ships.length === 0) { r.detail = 'no MW sales_ship in last 24h (weekend?)'; r.status = 'WARN'; return r; }
  const empties = ships.filter((s) => !s.from_bin || s.from_bin.trim() === '');
  const rate = empties.length / ships.length;

  // of the empties, how many expect a real MA- pickface (the actionable blind spot)?
  const emptySkus = [...new Set(empties.map((s) => s.sku).filter(Boolean))];
  let maExpecting = 0;
  for (let i = 0; i < emptySkus.length; i += 60) {
    const batch = emptySkus.slice(i, i + 60).map((s) => `"${s}"`).join(',');
    const prods = await sb(`products?select=sku,stock_locator&sku=in.(${enc(batch)})`, 'cin7_mirror');
    const loc = {}; for (const p of prods) loc[p.sku] = p.stock_locator;
    for (const e of empties) if (/^MA-/i.test(loc[e.sku] || '')) maExpecting++;
  }
  r.detail = `${ships.length} MW ships · empty-bin ${empties.length} (${(rate * 100).toFixed(1)}%, baseline ~8.8%) · of those, ${maExpecting} expect a real MA- bin (no_bin_suspect — undetectable)`;
  if (rate > CFG.NOBIN.rateWarn) r.status = 'WARN';
  if (maExpecting > 0) r.lines.push(`${maExpecting} ships had NO scanned bin but the SKU lives in an MA- pickface — these can never be flagged as wrong-bin`);
  return r;
}

// ── 7. Cron / Actions liveness ──────────────────────────────────────────────
async function checkCronLiveness() {
  const r = R('Cron / Actions liveness', 'high');
  const nowIso = hoursAgoISO(0); // cap at now — poll-sync detected_at can be a future transaction date
  const sale = (await sb(`pick_anomaly_orders?select=analyzed_at&entity_type=eq.sale&order=analyzed_at.desc&limit=1`))[0];
  const mov = (await sb(`stock_movements?select=detected_at&source=eq.movements-sync&detected_at=lte.${nowIso}&order=detected_at.desc&limit=1`, 'cin7_mirror'))[0];
  const asm = (await sb(`stock_movements?select=detected_at&source=eq.assembly-sync&detected_at=lte.${nowIso}&order=detected_at.desc&limit=1`, 'cin7_mirror'))[0];
  const saleAge = ageH(sale && sale.analyzed_at), movAge = ageH(mov && mov.detected_at), asmAge = ageH(asm && asm.detected_at);

  r.detail = `pick-sync ${fmtAge(sale && sale.analyzed_at)} · movements-sync ${fmtAge(mov && mov.detected_at)} · assembly-sync ${fmtAge(asm && asm.detected_at)} ago`;
  if (saleAge > CFG.CRON.saleFailH || movAge > CFG.CRON.movFailH) r.status = 'FAIL';
  else if (saleAge > CFG.CRON.saleWarnH || movAge > CFG.CRON.movWarnH || asmAge > CFG.CRON.movWarnH) r.status = 'WARN';
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────
async function safe(fn, name, severity) {
  try { return await fn(); }
  catch (e) { const r = R(name, severity); r.status = 'FAIL'; r.detail = 'check errored: ' + e.message; return r; }
}

async function main() {
  const json = process.argv.includes('--json');
  const daysArg = (process.argv.find((a) => a.startsWith('--days=')) || '').split('=')[1];
  const sDays = daysArg ? parseInt(daysArg, 10) : CFG.SALES.defaultDays;
  const aDays = daysArg ? parseInt(daysArg, 10) : CFG.ASSEMBLY.defaultDays;

  const results = [
    await safe(() => checkSalesGap(sDays), 'Sales capture gap', 'high'),
    await safe(() => checkAssemblyGap(aDays), 'Standalone assembly capture', 'medium'),
    await safe(() => checkMovementFreshness(), 'Movement freshness', 'high'),
    await safe(() => checkWebhookBacklog(), 'Webhook backlog / dead-letter', 'critical'),
    await safe(() => checkSnapshotFreshness(), 'Stock snapshot freshness', 'medium'),
    await safe(() => checkNoBinRate(), 'MW no-bin blind-spot', 'medium'),
    await safe(() => checkCronLiveness(), 'Cron / Actions liveness', 'high'),
  ];

  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const r of results) counts[r.status]++;
  const overall = counts.FAIL ? 'FAIL' : counts.WARN ? 'WARN' : 'PASS';

  if (json) {
    console.log(JSON.stringify({ generated_at: new Date(NOW).toISOString(), overall, counts, results }, null, 2));
  } else {
    const sym = { PASS: '✅', WARN: '⚠️ ', FAIL: '❌' };
    console.log('');
    console.log(`╔════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  PICK ANOMALIES — COVERAGE CHECK   ${new Date(NOW + CFG.BRISBANE_OFFSET_H * 3600e3).toISOString().replace('T', ' ').slice(0, 16)} (Brisbane)  ║`);
    console.log(`╚════════════════════════════════════════════════════════════════════╝`);
    for (const r of results) {
      console.log(`\n${sym[r.status]} [${r.severity.toUpperCase()}] ${r.name}`);
      console.log(`     ${r.detail}`);
      for (const l of r.lines) console.log(`       • ${l}`);
    }
    console.log(`\n──────────────────────────────────────────────────────────────────────`);
    console.log(`  OVERALL: ${sym[overall]} ${overall}   (PASS ${counts.PASS} · WARN ${counts.WARN} · FAIL ${counts.FAIL})`);
    console.log(`──────────────────────────────────────────────────────────────────────\n`);
  }
  process.exit(counts.FAIL ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(2); });
