#!/usr/bin/env node
/**
 * Reconcile cin7_mirror.sales_orders against Cin7 truth — un-sticks PHANTOM
 * "open" sales orders (shipped/invoiced in Cin7 but frozen open in the mirror).
 *
 * Why this is needed: the live sales sync (backfill-sales.js `sync`, UpdatedSince
 * =3h) only catches orders MODIFIED in the last few hours. An order that shipped
 * during a sync gap — or before that cron existed — is never "updated" again, so
 * its mirror row keeps the old open status forever (observed: 191 open orders with
 * source='backfill', e.g. SO-270594 = SHIPPED+INVOICED in Cin7, PICKED/NOT SHIPPED
 * in the mirror). UpdatedSince can't reach them (they're not being updated), so we
 * actively re-poll the STALE open set: any order still "open" whose Cin7 timestamp
 * is older than STALE_DAYS is re-confirmed by Search and its status written back.
 * Status columns only — rep / location / lines / amounts set elsewhere are kept.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *      RECONCILE_SO_THROTTLE_MS (default 2000 = 30/min)
 *      RECONCILE_SO_CAP         (default 300 — max orders re-verified per run)
 *      RECONCILE_SO_STALE_DAYS  (default 2 — only re-check orders unchanged ≥ this)
 *      RECONCILE_SO_SINCE       (default 2025-08-01 — matches the page's cutoff)
 * Usage: node cin7-stock-sync/reconcile-sales.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const THROTTLE = parseInt(process.env.RECONCILE_SO_THROTTLE_MS || '2000', 10);
const CAP = parseInt(process.env.RECONCILE_SO_CAP || '300', 10);
const STALE_DAYS = parseInt(process.env.RECONCILE_SO_STALE_DAYS || '2', 10);
const SINCE = process.env.RECONCILE_SO_SINCE || '2025-08-01';
if (!process.env.SUPABASE_SERVICE_KEY || !ACC || !CK) { console.error('Missing SUPABASE_SERVICE_KEY / CIN7 creds'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const cm = sb.schema('cin7_mirror');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = v => (v ? String(v).split('T')[0] : null);
const num = v => (v == null || v === '') ? null : Number(v);
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

// Status-only header refresh from a saleList row (leaves rep/location/lines alone).
function mapStatus(s) {
  return {
    status: s.Status, order_status: s.OrderStatus, fulfilment_status: s.FulFilmentStatus,
    shipping_status: s.CombinedShippingStatus, picking_status: s.CombinedPickingStatus, packing_status: s.CombinedPackingStatus,
    invoice_status: s.CombinedInvoiceStatus, payment_status: s.CombinedPaymentStatus, quote_status: s.QuoteStatus,
    invoice_number: s.InvoiceNumber || null, credit_note_number: s.CreditNoteNumber || null,
    tracking_numbers: s.CombinedTrackingNumbers || null,
    invoice_amount: num(s.InvoiceAmount), paid_amount: num(s.PaidAmount),
    invoice_date: d(s.InvoiceDate), invoice_due_date: d(s.InvoiceDueDate),
    cin7_updated: s.Updated || null, header_synced_at: new Date().toISOString(), source: 'reconcile',
  };
}

async function confirm(orderNumber) {
  const data = await cin7(`saleList?Page=1&Limit=10&Search=${encodeURIComponent(orderNumber)}`);
  const list = data.SaleList || [];
  return list.find(s => s.OrderNumber === orderNumber) || null;
}

const isClosedNow = s => String(s.CombinedShippingStatus || '').toUpperCase() === 'SHIPPED'
  || ['VOIDED', 'CANCELLED', 'CREDITED', 'COMPLETED'].includes(String(s.Status || '').toUpperCase());

(async () => {
  const staleISO = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();
  console.log(`🔎 Reconcile sales — open orders unchanged since < ${staleISO.split('T')[0]} (stale ≥ ${STALE_DAYS}d), oldest first, cap ${CAP}`);
  const { data: openStale, error } = await cm.from('sales_orders')
    .select('order_number,shipping_status,status,cin7_updated,source')
    .eq('order_status', 'AUTHORISED')
    .neq('shipping_status', 'SHIPPED')
    .not('status', 'in', '(VOIDED,CANCELLED,CREDITED,DRAFT)')
    .gte('order_date', SINCE)
    .lt('cin7_updated', staleISO)
    // Rotate by WHEN WE LAST CHECKED (header_synced_at), not by cin7_updated: a
    // genuinely-open order (e.g. a long-lived backorder) keeps its old cin7_updated
    // forever, so ordering by it would re-pick the same backorders every run and
    // starve newer phantoms. header_synced_at is bumped on every reconcile, so
    // just-checked orders sink to the back and each run advances through the set.
    .order('header_synced_at', { ascending: true, nullsFirst: true })
    .limit(CAP);
  if (error) throw new Error('mirror read: ' + error.message);
  console.log(`   ${(openStale || []).length} stale-open orders to re-verify`);
  if (!(openStale || []).length) { console.log('✅ Nothing stale to reconcile.'); process.exit(0); }

  let checked = 0, closed = 0, still = 0, missing = 0;
  for (const o of openStale) {
    let hit;
    try { hit = await confirm(o.order_number); }
    catch (e) { console.warn(`  ✗ ${o.order_number}: confirm failed (${e.message})`); continue; }
    checked++;
    if (!hit) { missing++; console.warn(`  ? ${o.order_number}: not found in Search`); continue; }
    const { error: ue } = await cm.from('sales_orders').update(mapStatus(hit)).eq('order_number', o.order_number);
    if (ue) { console.warn(`  ✗ ${o.order_number}: update failed (${ue.message})`); continue; }
    if (isClosedNow(hit)) { closed++; if (closed <= 20) console.log(`   ✓ ${o.order_number} → ship=${hit.CombinedShippingStatus} status=${hit.Status} (was open)`); }
    else still++;
    if (checked % 25 === 0) console.log(`   … ${checked}/${openStale.length} checked (${closed} closed, ${still} still open)`);
  }
  console.log(`✅ Re-verified ${checked}: ${closed} now closed (shipped/completed/void), ${still} genuinely still open${missing ? `, ${missing} not found` : ''}.`);
  if ((openStale || []).length >= CAP) console.log(`   ⚠️ Hit CAP=${CAP} — re-run to continue.`);
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
