/**
 * wms-spike/complete-fg.js — complete draft build FG-26930 (R1021-SC-TRI x5) via
 * the finishedGoods SUB-endpoints (same shape as /sale/fulfilment/pick):
 *   /finishedGoods/order  → the recipe (OrderLines)
 *   /finishedGoods/pick   → components consumed from chosen bins + COMPLETE
 * Reversible: void FG-26930 in Cin7. Run: node features/wms-spike/complete-fg.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const write = async (p, b) => { let r = await call('PUT', p, b); if (r.status === 405) r = await call('POST', p, b); return r; };
const L = console.log;

const TASK = 'f97603a3-b04c-47f7-96a0-b514605bc902';   // FG-26930
const QTY = 5;
const WH = { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', ProductCode: 'R1021-WH-TRI', BinID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', Bin: 'MA-A-07-L7-P2' };
const TR = { ProductID: '5d585630-f430-46eb-832f-1f7e5a7f1ad3', ProductCode: 'TRIM-R1021-SC', BinID: '810dd3a6-6c4c-4a39-97e1-a841598e060b', Bin: 'MA-B-11-L1-P2' };

(async () => {
  const today = new Date().toISOString().slice(0, 10);

  // 1) set the RECIPE (OrderLines) — per-unit quantities
  L('━━━ STEP 1 · /finishedGoods/order (recipe) ━━━');
  const order = await write('finishedGoods/order', { TaskID: TASK, Status: 'AUTHORISED', OrderLines: [
    { ProductID: WH.ProductID, ProductCode: WH.ProductCode, Quantity: 1 },
    { ProductID: TR.ProductID, ProductCode: TR.ProductCode, Quantity: 1 },
  ] });
  L('  HTTP ' + order.status + '  ' + (typeof order.j === 'string' ? order.j.slice(0, 300) : JSON.stringify(order.j).slice(0, 300)));
  const oc = (await call('GET', 'finishedGoods/order?TaskID=' + TASK)).j;
  L('  order.Status: ' + (oc && oc.Status) + '  OrderLines: ' + ((oc && oc.OrderLines) || []).length);

  // 2) PICK the components from explicit bins + COMPLETE
  L('\n━━━ STEP 2 · /finishedGoods/pick (components from bins + COMPLETE) ━━━');
  const pick = await write('finishedGoods/pick', {
    TaskID: TASK, Status: 'COMPLETED',
    WIPAccount: '635', Account: '635', WIPDate: today, CompletionDate: today,
    PickLines: [
      { ProductID: WH.ProductID, ProductCode: WH.ProductCode, Quantity: QTY, BinID: WH.BinID, Bin: WH.Bin, BatchSN: null },
      { ProductID: TR.ProductID, ProductCode: TR.ProductCode, Quantity: QTY, BinID: TR.BinID, Bin: TR.Bin, BatchSN: null },
    ],
  });
  L('  HTTP ' + pick.status + '  ' + (typeof pick.j === 'string' ? pick.j.slice(0, 400) : JSON.stringify(pick.j).slice(0, 400)));

  // 3) confirm build + SC-TRI stock
  const d = (await call('GET', 'finishedGoods?TaskID=' + TASK)).j;
  L('\n  Build ' + (d.AssemblyNumber || '') + ' Status: ' + d.Status + '  produces ' + d.ProductCode + ' x' + d.Quantity);
  (d.PickLines || []).forEach(l => L('    consumed: ' + l.ProductCode + ' x' + l.Quantity + ' from bin ' + (l.Bin || '(none)')));
  const av = await call('GET', 'ref/productavailability?Sku=R1021-SC-TRI&Limit=20');
  const rows = ((av.j && av.j.ProductAvailabilityList) || []).filter(x => x.Location === 'Main Warehouse');
  const tot = rows.reduce((s, x) => s + Number(x.Available || 0), 0);
  L('\n  R1021-SC-TRI available now: ' + tot + (tot > 0 ? '  ✓ ASSEMBLY PRODUCED STOCK — SO line now pickable' : '  (not yet)'));
  rows.forEach(x => L('    bin ' + (x.Bin || '(none)') + '  OnHand ' + x.OnHand + '  Avail ' + x.Available));
})().catch(e => console.error('FATAL', e.message));
