/**
 * wms-spike/pick-pack-final.js — full flow on SO-280071 after FG-26930 produced
 * the SC-TRI stock. Reset the locked pick on fulfilment #2 to DRAFT, authorise BOTH
 * lines (WH-TRI + assembled SC-TRI) so the pick is COMPLETE, then PACK, then check
 * the packing slip. Stops before ship. Run: node features/wms-spike/pick-pack-final.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const SALE_ID = '3a855378-d20a-4d0a-8ac4-4b16543e8240';
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const write = async (p, b) => { let r = await call('PUT', p, b); if (r.status === 405) r = await call('POST', p, b); return r; };
const L = console.log;

const LINES = [
  { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', SKU: 'R1021-WH-TRI', Quantity: 3, Location: 'Main Warehouse: MA-A-07-L7-P2', LocationID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', BatchSN: null },
  { ProductID: '95d04fc8-12bd-44ed-9b20-b93ac5f45c87', SKU: 'R1021-SC-TRI', Quantity: 5, Location: 'Main Warehouse', LocationID: '907821e3-c06b-4bf1-a8af-888bc3a2031f', BatchSN: null },
];

(async () => {
  const f = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments) || [];
  const task = (f.find(x => (x.Pick && x.Pick.Status) === 'AUTHORISED') || f[0] || {}).TaskID;
  L('TaskID: ' + task + '  (' + f.length + ' fulfilments)');

  // 1) reset the pick to DRAFT (un-authorise so we can change the lines)
  L('\n━━━ reset pick to DRAFT ━━━');
  const reset = await write('sale/fulfilment/pick', { TaskID: task, Status: 'DRAFT', Lines: LINES });
  L('  HTTP ' + reset.status + '  ' + (typeof reset.j === 'string' ? reset.j.slice(0, 200) : JSON.stringify(reset.j).slice(0, 200)));
  const rk = await call('GET', 'sale/fulfilment/pick?TaskID=' + task);
  L('  pick now: ' + (rk.j && rk.j.Status) + '  lines: ' + ((rk.j && rk.j.Lines) || []).length);

  // 2) authorise BOTH lines
  L('\n━━━ authorise pick — both lines ━━━');
  const pick = await write('sale/fulfilment/pick', { TaskID: task, Status: 'AUTHORISED', Lines: LINES });
  L('  HTTP ' + pick.status + '  ' + (typeof pick.j === 'string' ? pick.j.slice(0, 300) : JSON.stringify(pick.j).slice(0, 200)));
  const pk = await call('GET', 'sale/fulfilment/pick?TaskID=' + task);
  L('  Pick.Status: ' + (pk.j && pk.j.Status) + '  lines: ' + ((pk.j && pk.j.Lines) || []).length);
  ((pk.j && pk.j.Lines) || []).forEach(l => L('    ✓ ' + l.SKU + ' x' + l.Quantity + ' @ ' + (l.Location || l.Bin)));

  // 3) PACK
  const tpl = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
  L('\n━━━ PACK template ━━━  Status: ' + (tpl.j && tpl.j.Status) + '  lines: ' + ((tpl.j && tpl.j.Lines) || []).length);
  if (tpl.j && tpl.j.Status && tpl.j.Status !== 'NOT AVAILABLE') {
    const box = { Box: 'Box 1', Name: 'Box 1', Length: 40, Width: 30, Height: 25, Weight: 6, DimensionUnit: 'cm', WeightUnit: 'kg' };
    const lines = ((tpl.j.Lines) || LINES).map(l => Object.assign({}, l, { Box: 'Box 1' }));
    const pack = await write('sale/fulfilment/pack', { TaskID: task, Status: 'AUTHORISED', Lines: lines, Boxes: [box] });
    L('  PACK commit → HTTP ' + pack.status + '  ' + (typeof pack.j === 'string' ? pack.j.slice(0, 300) : JSON.stringify(pack.j).slice(0, 400)));
    const pc = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
    L('  Pack.Status: ' + (pc.j && pc.j.Status) + '  boxes: ' + ((pc.j && pc.j.Boxes) || []).length + '  lines: ' + ((pc.j && pc.j.Lines) || []).length);
    ((pc.j && pc.j.Boxes) || []).forEach(b => L('    ▢ ' + (b.Name || b.Box) + '  ' + b.Length + 'x' + b.Width + 'x' + b.Height + ' ' + (b.DimensionUnit || '') + '  ' + b.Weight + (b.WeightUnit || '')));
  } else { L('  PACK still NOT AVAILABLE.'); }

  // 4) PACKING SLIP at pack stage
  L('\n━━━ PACKING SLIP (after pack) — does the API return one? ━━━');
  for (const ep of ['sale/packingslip?SaleID=' + SALE_ID, 'sale/document?SaleID=' + SALE_ID, 'sale/attachment?SaleID=' + SALE_ID]) {
    const d = await call('GET', ep);
    L('  ' + (typeof d.j !== 'string' ? 'DATA' : '404 ') + '  GET /' + ep.split('?')[0]);
  }

  const s = (await call('GET', 'sale?ID=' + SALE_ID)).j || {};
  L('\n━━━ SALE STATE ━━━  ' + s.Status + ' | Picking: ' + s.CombinedPickingStatus + ' | Packing: ' + s.CombinedPackingStatus + ' | Shipping: ' + s.CombinedShippingStatus);
})().catch(e => console.error('FATAL', e.message));
