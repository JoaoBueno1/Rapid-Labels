/**
 * wms-spike/pick-pack-v2.js — corrected spike using the REAL sub-endpoints:
 *   /sale/fulfilment        (container: create, keyed by SaleID)
 *   /sale/fulfilment/pick   (the pick, keyed by TaskID)   ← this was the missing piece
 *   /sale/fulfilment/pack   (the pack, keyed by TaskID)
 * Target: SO-280073 (Simple Sale, both lines fully in stock). WRITES to prod.
 * Run: node features/wms-spike/pick-pack-v2.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const SALE_ID = '6b3d45a5-94c2-4ebb-a328-9ed05812e8d6';   // SO-280073
const call = async (m, p, b) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); const isHtml = /^<!DOCTYPE|^<html/i.test(t.trim()); let j; try { j = JSON.parse(t) } catch (e) { j = isHtml ? '(HTML 404)' : t } return { status: r.status, j }; };
const L = console.log;

const PICK_LINES = [
  { ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02', SKU: 'R1021-WH-TRI', Quantity: 12,
    Location: 'Main Warehouse: MA-A-07-L7-P2', LocationID: 'd28dc21e-4957-4db8-971c-4d9e39eadedd', BatchSN: null },
  { ProductID: '0d9a7ea8-9ae9-4069-880c-710e8a0c24f7', SKU: 'R1031-WH-TRI', Quantity: 2,
    Location: 'Main Warehouse: MA-A-03-L8-P1', LocationID: '8a96e488-b6a3-4e17-9d51-7fa7e5053e33', BatchSN: null },
];

// try PUT, fall back to POST on 405
const write = async (path, body) => { let r = await call('PUT', path, body); if (r.status === 405) { L('    (PUT 405 → retry POST)'); r = await call('POST', path, body); } return r; };

(async () => {
  // 1) ensure a fulfilment exists, get its TaskID
  let f = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments) || [];
  let task = (f.find(x => (x.Pick && x.Pick.Status) === 'DRAFT') || f[0] || {}).TaskID;
  if (!task) { const c = await call('POST', 'sale/fulfilment', { SaleID: SALE_ID }); task = (((c.j || {}).Fulfilments || [])[0] || {}).TaskID; }
  L('TaskID:', task);

  // 2) THE PICK — /sale/fulfilment/pick keyed by TaskID
  L('\n━━━ PICK via /sale/fulfilment/pick ━━━');
  const pick = await write('sale/fulfilment/pick', { TaskID: task, Status: 'AUTHORISED', Lines: PICK_LINES });
  L('  HTTP ' + pick.status + '  ' + (typeof pick.j === 'string' ? pick.j.slice(0, 300) : JSON.stringify(pick.j).slice(0, 300)));
  const pk = await call('GET', 'sale/fulfilment/pick?TaskID=' + task);
  L('  Pick.Status: ' + (pk.j && pk.j.Status) + '  lines: ' + ((pk.j && pk.j.Lines) || []).length);
  ((pk.j && pk.j.Lines) || []).forEach(l => L('    ✓ ' + l.SKU + ' x' + l.Quantity + ' @ ' + (l.Location || l.Bin)));

  // 3) is the pack available now?
  const pkTpl = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
  L('\n━━━ PACK template ━━━');
  L('  Pack.Status: ' + (pkTpl.j && pkTpl.j.Status) + '  lines: ' + ((pkTpl.j && pkTpl.j.Lines) || []).length);
  const packAvail = pkTpl.j && pkTpl.j.Status && pkTpl.j.Status !== 'NOT AVAILABLE';

  // 4) THE PACK — one carton with dimensions
  if (packAvail) {
    const box = { Box: 'Box 1', Name: 'Box 1', Length: 40, Width: 30, Height: 25, Weight: 5, DimensionUnit: 'cm', WeightUnit: 'kg' };
    const packLines = ((pkTpl.j && pkTpl.j.Lines) || PICK_LINES).map(l => Object.assign({}, l, { Box: 'Box 1' }));
    const pack = await write('sale/fulfilment/pack', { TaskID: task, Status: 'AUTHORISED', Lines: packLines, Boxes: [box] });
    L('\n━━━ PACK commit ━━━');
    L('  HTTP ' + pack.status + '  ' + (typeof pack.j === 'string' ? pack.j.slice(0, 300) : JSON.stringify(pack.j).slice(0, 300)));
    const pc = await call('GET', 'sale/fulfilment/pack?TaskID=' + task);
    L('  Pack.Status: ' + (pc.j && pc.j.Status) + '  boxes: ' + ((pc.j && pc.j.Boxes) || []).length);
  } else {
    L('\n━━━ PACK skipped (Pack ' + (pkTpl.j && pkTpl.j.Status) + ') ━━━');
  }

  // 5) final sale state — did picking/packing actually register?
  const s = (await call('GET', 'sale?ID=' + SALE_ID)).j || {};
  L('\n━━━ SALE STATE ━━━');
  L('  Status: ' + s.Status + '  | Picking: ' + s.CombinedPickingStatus + '  | Packing: ' + s.CombinedPackingStatus + '  | Shipping: ' + s.CombinedShippingStatus);
  L('  (stopped before ship/invoice — void SO-280073 to undo)');
})().catch(e => console.error('FATAL', e.message));
