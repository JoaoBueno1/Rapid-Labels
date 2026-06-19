#!/usr/bin/env node
/**
 * Cin7 "other" stock movements → ledger (cin7_mirror.stock_movements).
 * Polls the transaction types that have NO usable webhook and that the chase /
 * pick-anomalies UI shows in the "Movements" (audit) tab — separate from the
 * quick-action sales/assembly view:
 *   transfer   — stockTransferList + detail → SKU moved FROM→TO location
 *   adjustment — stockAdjustmentList + detail → SKU +/- at a bin
 *   purchase   — purchaseList + detail → SKU received into a bin
 * Each task is idempotent: its prior rows (same cin7_task_id + source) are
 * deleted then re-inserted, so re-runs never duplicate.
 *
 * Modes:  --type=transfer|adjustment|purchase|all   (default all)
 *         --dry        fetch + parse + print, write nothing
 *         --days=N     window (default MOVE_SINCE_DAYS or 3)
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY, MOVE_THROTTLE_MS
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.MOVE_THROTTLE_MS || '2800', 10);
const DRY = process.argv.includes('--dry');
const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const TYPE = arg('type') || 'all';
const DAYS = parseInt(arg('days') || process.env.MOVE_SINCE_DAYS || '3', 10);
if (!ACC || !CK || (!DRY && !process.env.SUPABASE_SERVICE_KEY)) { console.error('Missing creds'); process.exit(1); }
const cm = (DRY && !process.env.SUPABASE_SERVICE_KEY) ? null
  : createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY).schema('cin7_mirror');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => (v == null || v === '') ? 0 : Number(v);
const d = v => (v ? String(v).split('T')[0] : null);
const ts = v => (v ? (d(v) + 'T00:00:00Z') : new Date().toISOString());
const binOf = loc => (loc && loc.includes(':')) ? loc.split(':').slice(1).join(':').trim() : null;
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

const base = (extra) => ({
  reference_type: extra.reference_type, source: 'movements-sync',
  is_anomaly: false, ...extra,
});

// ── TRANSFER: SKU leaves FromLocation, arrives ToLocation. Cin7 embeds the bin
//    in the location string ("Main Warehouse: MA-H-10-L1") → split into wh + bin.
//    Same wh, different bin = bin_transfer (internal); different wh = transfer
//    to another warehouse (e.g. Main → Brisbane). ──
const whOf = loc => (loc ? loc.split(':')[0].trim() : null);
function transferMovements(det) {
  const ref = det.Number, date = det.CompletionDate || det.DepartureDate;
  const fromWh = whOf(det.FromLocation), toWh = whOf(det.ToLocation);
  const fromBin = binOf(det.FromLocation), toBin = binOf(det.ToLocation);
  const internal = fromWh && toWh && fromWh === toWh;
  const mt = internal ? 'bin_transfer' : 'stock_transfer';
  const out = [];
  for (const ln of (det.Lines || [])) {
    const q = num(ln.TransferQuantity || ln.Quantity);
    if (!ln.SKU || !q) continue;
    out.push(base({ detected_at: ts(date), sku: ln.SKU, product_name: ln.ProductName, movement_type: mt,
      reference_number: ref, reference_type: 'StockTransfer', cin7_task_id: det.TaskID,
      from_location: fromWh, from_bin: ln.FromBin || fromBin, to_location: null, to_bin: null,
      quantity: -Math.abs(q), is_internal: internal, is_external: !internal, raw_data: { role: 'out', status: det.Status } }));
    out.push(base({ detected_at: ts(date), sku: ln.SKU, product_name: ln.ProductName, movement_type: mt,
      reference_number: ref, reference_type: 'StockTransfer', cin7_task_id: det.TaskID,
      from_location: null, from_bin: null, to_location: toWh, to_bin: ln.ToBin || toBin,
      quantity: Math.abs(q), is_internal: internal, is_external: !internal, raw_data: { role: 'in', status: det.Status } }));
  }
  return out;
}

// ── ADJUSTMENT: net stock change = NewStockLines (after) − ExistingStockLines
//    (before), per SKU+location. A pure add → only New (+); a removal/stocktake
//    down → New<Existing (−). ──
function adjustmentMovements(det) {
  const ref = det.StocktakeNumber || det.Reference || det.TaskID, date = det.EffectiveDate;
  const agg = new Map();
  const acc = (lines, field) => {
    for (const l of (lines || [])) {
      if (!l.SKU) continue;
      const k = l.SKU + '|' + (l.Location || det.Location || '');
      const r = agg.get(k) || { sku: l.SKU, name: l.ProductName, loc: l.Location || det.Location, neu: 0, exist: 0 };
      r[field] += num(l.Quantity); agg.set(k, r);
    }
  };
  acc(det.NewStockLines, 'neu');
  acc(det.ExistingStockLines, 'exist');
  const out = [];
  for (const r of agg.values()) {
    const delta = r.neu - r.exist;
    if (!delta) continue;
    const wh = r.loc ? r.loc.split(':')[0].trim() : null, bin = binOf(r.loc);
    out.push(base({ detected_at: ts(date), sku: r.sku, product_name: r.name,
      movement_type: 'stock_adjustment', reference_number: ref, reference_type: 'StockAdjustment', cin7_task_id: det.TaskID,
      from_location: delta < 0 ? wh : null, from_bin: delta < 0 ? bin : null, to_location: delta > 0 ? wh : null, to_bin: delta > 0 ? bin : null,
      quantity: delta, is_internal: false, is_external: false, raw_data: { reason: det.Comment || null, status: det.Status } }));
  }
  return out;
}

// ── PURCHASE: SKU received into a bin. StockReceived is a single object
//    { Status, Lines:[...] } (not an array). ──
function purchaseMovements(det) {
  const ref = det.OrderNumber || det.Number, supplier = det.Supplier || det.SupplierName;
  const lines = (det.StockReceived && det.StockReceived.Lines) || [];
  const date = det.LastUpdatedDate || det.OrderDate;
  const out = [];
  for (const l of lines) {
    const q = num(l.Quantity);
    if (!l.SKU || !q) continue;
    out.push(base({ detected_at: ts(date), sku: l.SKU, product_name: l.Name || l.ProductName,
      movement_type: 'purchase_receive', reference_number: ref, reference_type: 'PurchaseOrder', cin7_task_id: det.ID || det.TaskID,
      customer_name: supplier, from_location: 'SUPPLIER', from_bin: null,
      to_location: whOf(l.Location) || l.Location || det.Location || null, to_bin: l.Bin || binOf(l.Location) || null,
      quantity: Math.abs(q), is_internal: false, is_external: true, raw_data: { supplier, status: det.Status } }));
  }
  return out;
}

const CFG = {
  // transfer list = newest-first (read forward); adjustment/purchase = oldest-first (read backward).
  transfer:   { list: 'stockTransferList',   listKey: 'StockTransferList',   idKey: 'TaskID', dateKey: 'LastModifiedOn',  detail: id => `stockTransfer?TaskID=${id}`,   parse: transferMovements,  reverse: false },
  adjustment: { list: 'stockAdjustmentList', listKey: 'StockAdjustmentList', idKey: 'TaskID', dateKey: 'EffectiveDate',    detail: id => `stockAdjustment?TaskID=${id}`, parse: adjustmentMovements, reverse: true },
  purchase:   { list: 'purchaseList',        listKey: 'PurchaseList',        idKey: 'ID',     dateKey: 'LastUpdatedDate',  detail: id => `purchase?ID=${id}`,            parse: purchaseMovements,  reverse: true },
};

async function runType(t) {
  const c = CFG[t];
  const since = new Date(Date.now() - DAYS * 86400000).toISOString().split('T')[0];
  const LIMIT = 500;
  const meta = await cin7(`${c.list}?Page=1&Limit=1`);
  const listTotal = meta.Total || 0;
  const lastPage = Math.max(1, Math.ceil(listTotal / LIMIT));
  // oldest-first lists → walk from the last page back; newest-first → from page 1.
  const order = c.reverse
    ? Array.from({ length: lastPage }, (_, i) => lastPage - i)
    : Array.from({ length: Math.min(lastPage, 40) }, (_, i) => i + 1);
  let headers = [];
  for (const page of order) {
    const data = await cin7(`${c.list}?Page=${page}&Limit=${LIMIT}`);
    const list = data[c.listKey] || [];
    if (!list.length) continue;
    headers.push(...list.filter(h => { const dt = d(h[c.dateKey]); return !dt || dt >= since; }));
    // stop once an entire page is older than the window (we've passed the recent block)
    if (list.length && list.every(h => { const dt = d(h[c.dateKey]); return dt && dt < since; })) break;
  }
  const cap = parseInt(arg('limit') || '0', 10);
  if (cap > 0) headers = headers.slice(0, cap);
  console.log(`\n[${t}] ${headers.length} tasks modified since ${since}${cap ? ` (capped ${cap})` : ''}`);
  let total = 0;
  for (const h of headers) {
    const det = await cin7(c.detail(h[c.idKey]));
    const mv = c.parse(det);
    if (DRY) { mv.slice(0, 4).forEach(m => console.log(`   ${m.movement_type} ${m.sku} ${m.quantity > 0 ? '+' : ''}${m.quantity} ${m.from_location || ''}->${m.to_location || ''} bin=${m.from_bin || m.to_bin || '-'} ref=${m.reference_number}`)); }
    else if (mv.length) {
      await cm.from('stock_movements').delete().eq('cin7_task_id', h[c.idKey]).eq('source', 'movements-sync');
      for (let i = 0; i < mv.length; i += 500) { const { error } = await cm.from('stock_movements').insert(mv.slice(i, i + 500)); if (error) throw new Error(`${t} insert: ${error.message}`); }
    }
    total += mv.length;
  }
  console.log(`[${t}] ${total} movimentos ${DRY ? '(dry)' : 'ledgered'}.`);
}

(async () => {
  const types = TYPE === 'all' ? ['transfer', 'adjustment', 'purchase'] : [TYPE];
  for (const t of types) { if (!CFG[t]) { console.error('tipo invalido:', t); process.exit(1); } await runType(t); }
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
