#!/usr/bin/env node
/**
 * Cin7 → Supabase backfill — sales_orders / sale_lines (+ pick-anomalies).
 * Checkpointed (cin7_mirror.backfill_state) and gentle (shared 60/min cap).
 *
 * Modes:
 *   headers  — paginate saleList?CreatedSince (1000/page), upsert HEADER fields
 *              for ALL orders since BACKFILL_SINCE. Cheap (~1 call / 1000 orders).
 *   detail   — for sales_orders still missing detail in the recent window, fetch
 *              sale?ID=, fill sales_rep / location / ship_date / sale_lines, and
 *              run the pick-anomaly analysis (reusing the fetched detail).
 *
 * Safe: throttle (default 4s = 15/min → leaves 45/min for syncs+webhooks),
 * 403/429 backoff, resumes from checkpoint, marks attempted rows so it never
 * loops on a bad order. Stop with Ctrl-C anytime; re-run to continue.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *      BACKFILL_SINCE          (default 2025-08-01T00:00:00Z)
 *      BACKFILL_THROTTLE_MS    (default 4000 = 15/min)
 *      BACKFILL_DETAIL_DAYS    (default 14 — window for the detail pass)
 *      BACKFILL_PICK_ANOMALIES (default 1 — also feed pick_anomaly_orders)
 *
 * Usage:  node cin7-stock-sync/backfill-sales.js headers
 *         node cin7-stock-sync/backfill-sales.js detail
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SINCE = process.env.BACKFILL_SINCE || '2025-08-01T00:00:00Z';
const THROTTLE = parseInt(process.env.BACKFILL_THROTTLE_MS || '4000', 10);
const DETAIL_DAYS = parseInt(process.env.BACKFILL_DETAIL_DAYS || '14', 10);
const RUN_PA = (process.env.BACKFILL_PICK_ANOMALIES || '1') === '1';
const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';

if (!process.env.SUPABASE_SERVICE_KEY || !ACC || !CK) {
  console.error('Missing SUPABASE_SERVICE_KEY / CIN7 credentials'); process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cm = sb.schema('cin7_mirror');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = v => v ? String(v).split('T')[0] : null;
const num = v => (v == null || v === '') ? null : Number(v);
let lastCall = 0;

async function cin7(path, _retry = 0) {
  const wait = Math.max(0, THROTTLE - (Date.now() - lastCall));
  if (wait) await sleep(wait);
  lastCall = Date.now();
  let res;
  try { res = await fetch(`${BASE}/${path}`, { headers: { 'api-auth-accountid': ACC, 'api-auth-applicationkey': CK, 'Accept': 'application/json' } }); }
  catch (e) { if (_retry < 6) { await sleep(5000); return cin7(path, _retry + 1); } throw e; }
  if ((res.status === 429 || res.status === 403) && _retry < 6) {
    const back = 5000 * Math.pow(2, _retry) + Math.floor(Math.random() * 2000);
    console.warn(`  Cin7 ${res.status} (throttle) — backoff ${Math.round(back / 1000)}s [${_retry + 1}/6]`);
    await sleep(back); return cin7(path, _retry + 1);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status} ${path.split('?')[0]}`);
  return res.json();
}

async function getCp(job) {
  const { data } = await cm.from('backfill_state').select('*').eq('job', job).single();
  return data || { job, last_page: 0, processed: 0 };
}
async function saveCp(job, patch) {
  await cm.from('backfill_state').upsert({ job, updated_at: new Date().toISOString(), ...patch }, { onConflict: 'job' });
}

function mapHeader(s) {
  return {
    order_number: s.OrderNumber, sale_id: s.SaleID,
    customer: s.Customer, customer_id: s.CustomerID, customer_reference: s.CustomerReference,
    order_date: d(s.OrderDate), invoice_date: d(s.InvoiceDate), invoice_due_date: d(s.InvoiceDueDate), ship_by: d(s.ShipBy),
    invoice_amount: num(s.InvoiceAmount), paid_amount: num(s.PaidAmount), base_currency: s.BaseCurrency,
    status: s.Status, order_status: s.OrderStatus, fulfilment_status: s.FulFilmentStatus,
    shipping_status: s.CombinedShippingStatus, picking_status: s.CombinedPickingStatus, packing_status: s.CombinedPackingStatus,
    invoice_status: s.CombinedInvoiceStatus, payment_status: s.CombinedPaymentStatus, quote_status: s.QuoteStatus,
    invoice_number: s.InvoiceNumber, credit_note_number: s.CreditNoteNumber,
    location_id: s.OrderLocationID, source_channel: s.SourceChannel, type: s.Type,
    tracking_numbers: s.CombinedTrackingNumbers, cin7_updated: s.Updated,
    header_synced_at: new Date().toISOString(), source: 'backfill',
  };
}

function mapDetail(det) {
  const addr = det.ShippingAddress || {};
  const order = det.Order || {};
  let shipDate = null;
  for (const f of (det.Fulfilments || det.Fulfillments || [])) {
    if (f.Ship && f.Ship.Lines && f.Ship.Lines[0] && f.Ship.Lines[0].ShipmentDate) { shipDate = f.Ship.Lines[0].ShipmentDate; break; }
  }
  return {
    sales_rep: det.SalesRepresentative || null, location_name: det.Location || null,
    contact: det.Contact || null, email: det.Email || null, phone: det.Phone || null,
    ship_date: d(shipDate), order_amount: num(order.Total), tax_amount: num(order.Tax),
    cogs_amount: num(det.COGSAmount), currency_rate: num(det.CurrencyRate),
    carrier: det.Carrier || null, service_only: !!det.ServiceOnly,
    ship_suburb: addr.City || null, ship_state: addr.State || null, ship_postcode: addr.Postcode || null, ship_country: addr.Country || null,
    detail_synced_at: new Date().toISOString(),
  };
}

async function upsertChunked(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await cm.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

async function runHeaders() {
  const job = 'sales_headers';
  const cp = await getCp(job);
  let page = (cp.last_page || 0) + 1, total = cp.processed || 0;
  console.log(`📥 Headers since ${SINCE} — resuming at page ${page} (already ${total})`);
  while (true) {
    const data = await cin7(`saleList?CreatedSince=${encodeURIComponent(SINCE)}&Page=${page}&Limit=1000`);
    const sales = data.SaleList || [];
    if (!sales.length) break;
    await upsertChunked('sales_orders', sales.map(mapHeader).filter(r => r.order_number), 'order_number');
    total += sales.length;
    await saveCp(job, { last_page: page, processed: total, total_target: data.Total });
    console.log(`  page ${page}: +${sales.length}  (${total}/${data.Total})`);
    if (sales.length < 1000) break;
    page++;
  }
  await saveCp(job, { done: true });
  console.log(`✅ Headers done — ${total} orders in sales_orders.`);
}

async function runDetail() {
  const job = 'sales_detail';
  const cp = await getCp(job);
  let processed = cp.processed || 0, enriched = 0;
  const since = new Date(Date.now() - DETAIL_DAYS * 86400000).toISOString();
  const pa = RUN_PA ? require('../features/pick-anomalies/pick-anomalies-engine') : null;
  console.log(`📦 Detail — SHIPPED orders modified since ${since.split('T')[0]} (window ${DETAIL_DAYS}d) missing detail`);
  while (true) {
    const { data: orders, error } = await cm.from('sales_orders')
      .select('order_number, sale_id')
      .is('detail_synced_at', null).eq('shipping_status', 'SHIPPED')
      .gte('cin7_updated', since)
      .not('status', 'in', '(VOIDED,CANCELLED,CREDITED)')
      .order('cin7_updated', { ascending: false }).limit(40);
    if (error) throw new Error('query: ' + error.message);
    if (!orders || !orders.length) break;
    for (const o of orders) {
      let det;
      try { det = await cin7(`sale?ID=${o.sale_id}`); }
      catch (e) {
        console.warn(`  ✗ ${o.order_number}: ${e.message} — marking attempted`);
        await cm.from('sales_orders').update({ detail_synced_at: new Date().toISOString() }).eq('order_number', o.order_number);
        processed++; continue;
      }
      await cm.from('sales_orders').update(mapDetail(det)).eq('order_number', o.order_number);
      const lines = (det.Order?.Lines || []).map((ln, i) => ({
        order_number: o.order_number, sale_id: o.sale_id, line_no: i,
        sku: ln.SKU, product_id: ln.ProductID, product_name: ln.Name,
        quantity: num(ln.Quantity), price: num(ln.Price), discount: num(ln.Discount), tax: num(ln.Tax), total: num(ln.Total),
      })).filter(l => l.sku);
      if (lines.length) await upsertChunked('sale_lines', lines, 'order_number,line_no');
      if (pa) { try { await pa.analyzeOrderRealtime(o.sale_id, o.order_number, det, 'backfill'); } catch (e) { /* best-effort */ } }
      processed++; enriched++;
      if (enriched % 20 === 0) { await saveCp(job, { processed }); console.log(`  … ${enriched} enriched (this run)`); }
    }
  }
  await saveCp(job, { processed, done: true });
  console.log(`✅ Detail done — ${enriched} orders enriched this run (${processed} total attempts).`);
}

// Recurring header sync: upsert headers for orders MODIFIED in the last few
// hours (new orders + invoice/status changes). Keeps sales_orders current for
// un-shipped orders too. Only header columns are written → detail (rep/lines/
// ship_date) set by the webhook/detail pass is preserved. Run on a 2h cron.
async function runSync() {
  const hours = parseInt(process.env.SYNC_HOURS || '3', 10);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  console.log(`🔄 Header sync — orders modified since ${since}`);
  let page = 1, total = 0;
  while (page <= 30) {
    const data = await cin7(`saleList?UpdatedSince=${encodeURIComponent(since)}&Page=${page}&Limit=1000`);
    const sales = data.SaleList || [];
    if (!sales.length) break;
    const rows = sales.map(mapHeader).filter(r => r.order_number).map(r => ({ ...r, source: 'sync' }));
    await upsertChunked('sales_orders', rows, 'order_number');
    total += sales.length;
    if (sales.length < 1000) break;
    page++;
  }
  console.log(`✅ Header sync done — ${total} orders upserted (modified ≤ ${hours}h ago).`);
}

const mode = process.argv[2];
(async () => {
  if (mode === 'headers') await runHeaders();
  else if (mode === 'detail') await runDetail();
  else if (mode === 'sync') await runSync();
  else { console.log('Usage: node cin7-stock-sync/backfill-sales.js headers|detail|sync'); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('❌ Backfill error:', e.message); process.exit(1); });
