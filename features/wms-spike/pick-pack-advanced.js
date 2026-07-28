/**
 * wms-spike/pick-pack-advanced.js — test the PACK step on the ADVANCED sale
 * SO-280071. Picks ONLY the in-stock line (R1021-WH-TRI x3); leaves the assembly
 * line (R1021-SC-TRI, 0 stock) as a partial fulfilment. Then commits the pack
 * (1 carton). Stops before ship. WRITES to prod. Run: node features/wms-spike/pick-pack-advanced.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const SALE_ID = '3a855378-d20a-4d0a-8ac4-4b16543e8240';   // SO-280071 (Advanced)
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const write = async (path, body) => { let r = await call('PUT', path, body); if (r.status === 405) r = await call('POST', path, body); return r; };
const L = console.log;

const PICK_LINE = { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', SKU: 'R1021-WH-TRI', Quantity: 3,
  Location: 'Main Warehouse: MA-A-07-L7-P2', LocationID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', BatchSN: null };

(async () => {
  // reuse a draft fulfilment (several exist from earlier probing) or make one
  let f = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments) || [];
  let task = (f.find(x => (x.Pick && x.Pick.Status) === 'DRAFT') || f[0] || {}).TaskID;
  if (!task) { const c = await call('POST', 'sale/fulfilment', { SaleID: SALE_ID }); task = (((c.j || {}).Fulfilments || [])[0] || {}).TaskID; }
  L('TaskID:', task, '(' + f.length + ' fulfilments on the sale)');

  // PICK just the in-stock line
  L('\n━━━ PICK (partial: R1021-WH-TRI x3 only) ━━━');
  const pick = await write('sale/fulfilment/pick', { TaskID: task, Status: 'AUTHORISED', Lines: [PICK_LINE] });
  L('  HTTP ' + pick.status + '  ' + (typeof pick.j === 'string' ? pick.j.slice(0, 240) : JSON.stringify(pick.j).slice(0, 240)));
  const pk = await call('GET', 'sale/fulfilment/pick?TaskID=' + task);
  L('  Pick.Status: ' + (pk.j && pk.j.Status) + '  lines: ' + ((pk.j && pk.j.Lines) || []).length);

  // PACK
  const tpl = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
  L('\n━━━ PACK template ━━━  Status: ' + (tpl.j && tpl.j.Status) + '  lines: ' + ((tpl.j && tpl.j.Lines) || []).length);
  ((tpl.j && tpl.j.Lines) || []).forEach(l => L('    · ' + l.SKU + ' x' + l.Quantity));
  if (tpl.j && tpl.j.Status && tpl.j.Status !== 'NOT AVAILABLE') {
    const box = { Box: 'Box 1', Name: 'Box 1', Length: 30, Width: 20, Height: 15, Weight: 2, DimensionUnit: 'cm', WeightUnit: 'kg' };
    const lines = ((tpl.j.Lines) || [{ ProductID: PICK_LINE.ProductID, SKU: PICK_LINE.SKU, Quantity: 3 }]).map(l => Object.assign({}, l, { Box: 'Box 1' }));
    const pack = await write('sale/fulfilment/pack', { TaskID: task, Status: 'AUTHORISED', Lines: lines, Boxes: [box] });
    L('\n━━━ PACK commit ━━━  HTTP ' + pack.status + '  ' + (typeof pack.j === 'string' ? pack.j.slice(0, 240) : JSON.stringify(pack.j).slice(0, 400)));
    const pc = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
    L('  Pack.Status: ' + (pc.j && pc.j.Status) + '  boxes: ' + ((pc.j && pc.j.Boxes) || []).length);
    ((pc.j && pc.j.Boxes) || []).forEach(b => L('    ▢ ' + (b.Name || b.Box) + '  ' + b.Length + 'x' + b.Width + 'x' + b.Height + ' ' + (b.DimensionUnit || '') + '  ' + b.Weight + (b.WeightUnit || '')));
  } else {
    L('  PACK not available.');
  }

  const s = (await call('GET', 'sale?ID=' + SALE_ID)).j || {};
  L('\n━━━ SALE STATE ━━━  ' + s.Status + ' | Picking: ' + s.CombinedPickingStatus + ' | Packing: ' + s.CombinedPackingStatus + ' | Shipping: ' + s.CombinedShippingStatus);
})().catch(e => console.error('FATAL', e.message));
