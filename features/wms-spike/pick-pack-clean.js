/**
 * wms-spike/pick-pack-clean.js — the clean end-to-end on the Advanced sale
 * SO-280083 (0 fulfilments, 1 line in stock): create ONE fulfilment, pick in one
 * authorised shot, then PACK with a carton, then check the packing slip. Stops
 * before ship. Run: node features/wms-spike/pick-pack-clean.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const SALE_ID = '3cd6a552-c669-4a7b-adb8-7a5d4d79fcb2';   // SO-280083 (Advanced)
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const write = async (p, b) => { let r = await call('PUT', p, b); if (r.status === 405) r = await call('POST', p, b); return r; };
const L = console.log;

const PICK_LINE = { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', SKU: 'R1021-WH-TRI', Quantity: 4, Location: 'Main Warehouse: MA-A-07-L7-P2', LocationID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', BatchSN: null };

(async () => {
  // 1) exactly ONE fulfilment
  let f = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments) || [];
  let task = (f[0] || {}).TaskID;
  if (!task) { const c = await call('POST', 'sale/fulfilment', { SaleID: SALE_ID }); task = (((c.j || {}).Fulfilments || [])[0] || {}).TaskID; }
  L('TaskID: ' + task);

  // 2) PICK in one authorised shot
  L('\n━━━ PICK (R1021-WH-TRI x4 @ MA-A-07-L7-P2) ━━━');
  const pick = await write('sale/fulfilment/pick', { TaskID: task, Status: 'AUTHORISED', Lines: [PICK_LINE] });
  L('  HTTP ' + pick.status + '  ' + (typeof pick.j === 'string' ? pick.j.slice(0, 200) : ''));
  const pk = (await call('GET', 'sale/fulfilment/pick?TaskID=' + task)).j;
  L('  Pick.Status: ' + pk.Status + '  lines: ' + ((pk.Lines || []).length));

  // 3) PACK template → commit with a carton
  const tpl = (await call('GET', 'sale/fulfilment/pack?TaskID=' + task)).j;
  L('\n━━━ PACK template ━━━  Status: ' + tpl.Status + '  lines: ' + ((tpl.Lines || []).length));
  (tpl.Lines || []).forEach(l => L('    · ' + l.SKU + ' x' + l.Quantity));
  if (tpl.Status && tpl.Status !== 'NOT AVAILABLE') {
    const box = { Box: 'Box 1', Name: 'Box 1', Length: 30, Width: 20, Height: 15, Weight: 3, DimensionUnit: 'cm', WeightUnit: 'kg' };
    const lines = ((tpl.Lines) || [{ ProductID: PICK_LINE.ProductID, SKU: PICK_LINE.SKU, Quantity: 4 }]).map(l => Object.assign({}, l, { Box: 'Box 1' }));
    const pack = await write('sale/fulfilment/pack', { TaskID: task, Status: 'AUTHORISED', Lines: lines, Boxes: [box] });
    L('\n━━━ PACK commit ━━━  HTTP ' + pack.status + '  ' + (typeof pack.j === 'string' ? pack.j.slice(0, 250) : JSON.stringify(pack.j).slice(0, 400)));
    const pc = (await call('GET', 'sale/fulfilment/pack?TaskID=' + task)).j;
    L('  Pack.Status: ' + pc.Status + '  boxes: ' + ((pc.Boxes || []).length) + '  lines: ' + ((pc.Lines || []).length));
    (pc.Boxes || []).forEach(b => L('    ▢ ' + (b.Name || b.Box) + '  ' + b.Length + 'x' + b.Width + 'x' + b.Height + ' ' + (b.DimensionUnit || '') + '  ' + b.Weight + (b.WeightUnit || '')));
  } else { L('  PACK NOT AVAILABLE — unexpected on a clean Advanced sale.'); }

  // 4) PACKING SLIP — anything from the API at the pack stage?
  L('\n━━━ PACKING SLIP (after pack) ━━━');
  for (const ep of ['sale/packingslip?SaleID=' + SALE_ID, 'sale/document?SaleID=' + SALE_ID, 'sale/pickslip?SaleID=' + SALE_ID]) {
    const d = await call('GET', ep);
    L('  ' + (typeof d.j !== 'string' ? 'DATA' : '404 ') + '  GET /' + ep.split('?')[0]);
  }

  // 5) the data WE own to print our own slip
  const fin = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments || [])[0] || {};
  const sale = (await call('GET', 'sale?ID=' + SALE_ID)).j || {};
  L('\n━━━ DATA WE OWN for our own packing slip ━━━');
  L('  Order ' + 'SO-280083' + '  ship to: ' + ((sale.ShippingAddress && (sale.ShippingAddress.Line1 || sale.ShippingAddress.DisplayAddressLine1)) || '—'));
  L('  pack lines: ' + ((fin.Pack && fin.Pack.Lines) || []).length + '  boxes: ' + ((fin.Pack && fin.Pack.Boxes) || []).length);
  L('\n━━━ SALE STATE ━━━  ' + sale.Status + ' | Picking: ' + sale.CombinedPickingStatus + ' | Packing: ' + sale.CombinedPackingStatus + ' | Shipping: ' + sale.CombinedShippingStatus);
  L('  (stopped before ship — void SO-280083 to undo)');
})().catch(e => console.error('FATAL', e.message));
