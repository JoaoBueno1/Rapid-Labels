/**
 * wms-spike/assembly-build.js — THE ESSENTIAL TEST: can we build a kit/assembly
 * (finished good) via the Cin7 API, picking the components from chosen bins, so a
 * BOM line on a sales order becomes fulfillable?
 *
 * Builds R1021-SC-TRI x5 (= R1021-WH-TRI + TRIM-R1021-SC) consuming components
 * from explicit bins, then COMPLETED. Reversible: void the build (FG-xxxxx) to undo.
 * WRITES real stock. Run: node features/wms-spike/assembly-build.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const L = console.log;

const FG = { ProductID: '95d04fc8-12bd-44ed-9b20-b93ac5f45c87', ProductCode: 'R1021-SC-TRI', Quantity: 5, Location: 'Main Warehouse' };
const COMPONENTS = [
  { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', ProductCode: 'R1021-WH-TRI', Quantity: 5, BinID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', Bin: 'MA-A-07-L7-P2' },
  { ProductID: '5d585630-f430-46eb-832f-1f7e5a7f1ad3', ProductCode: 'TRIM-R1021-SC', Quantity: 5, BinID: '810dd3a6-6c4c-4a39-97e1-a841598e060b', Bin: 'MA-B-11-L1-P2' },
];

(async () => {
  // 1) create the build (DRAFT) — see what Cin7 auto-populates
  L('━━━ CREATE build (POST /finishedGoods) ━━━');
  const today = new Date().toISOString().slice(0, 10);
  const create = await call('POST', 'finishedGoods', {
    ProductID: FG.ProductID, ProductCode: FG.ProductCode,
    Location: FG.Location, LocationID: '907821e3-c06b-4bf1-a8af-888bc3a2031f',
    Quantity: FG.Quantity, Status: 'DRAFT',
    WIPAccount: '635', Account: '635', WIPDate: today,
  });
  L('  HTTP ' + create.status + '  ' + (typeof create.j === 'string' ? create.j.slice(0, 400) : JSON.stringify(create.j).slice(0, 500)));
  if (create.status >= 400) { L('  → create rejected; see error above.'); return; }
  const task = create.j.TaskID || (create.j.FinishedGoods && create.j.FinishedGoods[0] && create.j.FinishedGoods[0].TaskID);
  L('  TaskID: ' + task + '  AssemblyNumber: ' + (create.j.AssemblyNumber || ''));
  const d = (await call('GET', 'finishedGoods?TaskID=' + task)).j;
  L('  Status: ' + d.Status + '  | OrderLines(recipe): ' + ((d.OrderLines || []).length) + '  | PickLines(components): ' + ((d.PickLines || []).length));
  (d.OrderLines || []).forEach(l => L('    recipe: ' + l.ProductCode + ' x' + l.Quantity));
  (d.PickLines || []).forEach(l => L('    component: ' + l.ProductCode + ' x' + l.Quantity + ' bin ' + (l.Bin || '(none)')));

  // 2) set the component source bins onto the PickLines, then COMPLETE the build
  L('\n━━━ COMPLETE build (pick components from chosen bins) ━━━');
  const byId = {}; COMPONENTS.forEach(c => { byId[c.ProductID] = c; });
  const pickLines = ((d.PickLines || []).length ? d.PickLines : COMPONENTS).map(l => {
    const c = byId[l.ProductID] || {};
    return Object.assign({}, l, { ProductID: l.ProductID || c.ProductID, ProductCode: l.ProductCode || c.ProductCode, Quantity: l.Quantity || c.Quantity, BinID: c.BinID || l.BinID || null, Bin: c.Bin || l.Bin || null });
  });
  const body = {
    TaskID: task, ProductID: FG.ProductID, ProductCode: FG.ProductCode,
    Location: FG.Location, LocationID: '907821e3-c06b-4bf1-a8af-888bc3a2031f',
    Quantity: FG.Quantity, WIPAccount: '635', Account: '635', WIPDate: today, CompletionDate: today,
    OrderLines: d.OrderLines || [], PickLines: pickLines, Status: 'COMPLETED',
  };
  let done = await call('PUT', 'finishedGoods', body);
  if (done.status === 405) done = await call('POST', 'finishedGoods', body);
  L('  PUT/POST complete → HTTP ' + done.status + '  ' + (typeof done.j === 'string' ? done.j.slice(0, 400) : JSON.stringify(done.j).slice(0, 400)));
  const fin = (await call('GET', 'finishedGoods?TaskID=' + task)).j;
  L('  Build ' + (fin.AssemblyNumber || '') + ' Status: ' + fin.Status);
  (fin.PickLines || []).forEach(l => L('    consumed: ' + l.ProductCode + ' x' + l.Quantity + ' from bin ' + (l.Bin || '(none)')));

  // 3) did SC-TRI get stock?
  const av = await call('GET', 'ref/productavailability?Sku=R1021-SC-TRI&Limit=20');
  const rows = ((av.j && av.j.ProductAvailabilityList) || []).filter(x => x.Location === 'Main Warehouse');
  const tot = rows.reduce((s, x) => s + Number(x.Available || 0), 0);
  L('\n  R1021-SC-TRI available now: ' + tot + (tot > 0 ? '  ✓ ASSEMBLY PRODUCED STOCK — SO line now pickable' : '  (not yet reflected)'));
  L('\n(To undo: void ' + (fin.AssemblyNumber || 'the build') + ' in Cin7 — components return.)');
})().catch(e => console.error('FATAL', e.message));
