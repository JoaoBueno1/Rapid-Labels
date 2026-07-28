/**
 * wms-spike/pick-pack-test.js — THROWAWAY Phase-0 write spike. Isolated: touches
 * no existing file, imports nothing from the app. Safe to delete after.
 *
 * Purpose: on the disposable sample order SO-280071 (Advanced Sale, AUTHORISED),
 * prove empirically whether the Cin7 Core API lets us:
 *   1. commit a PICK with an EXPLICIT source bin per line   ← the crux of "own the pick"
 *   2. commit a PACK (cartons + dimensions)
 *   3. and whether a packing slip comes back — or if we must print our own.
 *
 * It WRITES to production Cin7 (deducts/allocates real stock on the sample order).
 * The order is disposable — void/delete it in Cin7 afterwards. Reads .env for
 * CIN7_ACCOUNT_ID / CIN7_API_KEY.
 *
 * Run:  node features/wms-spike/pick-pack-test.js
 */
require('dotenv').config();

const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = {
  'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
  'api-auth-applicationkey': process.env.CIN7_API_KEY,
  'Content-Type': 'application/json',
};

// ── The sample order + the one line that has pickable stock ──
const SALE_ID = '3a855378-d20a-4d0a-8ac4-4b16543e8240';   // SO-280071
const TASK_ID = '5e68ea99-3828-40cb-a248-8ba7ab107c85';   // draft fulfilment already created
const PICK_LINE = {
  ProductID: '9455b08f-6b98-4bc1-bc9d-d7fa5e19aa02',      // R1021-WH-TRI
  SKU: 'R1021-WH-TRI',
  Name: '8w Dimmable Downlight Integral Driver IP54 90mm Cut Out, Tri (3000K Warm White-4000K Cool White-5700K Daylight) White',
  Quantity: 3,
  Location: 'Main Warehouse',        // warehouse name (request wants Location + Bin SEPARATE)
  Bin: 'MA-A-07-L7-P2',              // the bulk bin that HAS stock (1170)
  BatchSN: null,
};
// R1021-SC-TRI is left out on purpose — it has 0 stock (tests partial/backorder).

const call = async (method, path, body) => {
  const r = await fetch(`${BASE}/${path}`, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  const isHtml = /^<!DOCTYPE|^<html/i.test(txt.trim());
  let j; try { j = JSON.parse(txt); } catch (e) { j = isHtml ? '(HTML 404 page — endpoint does not exist)' : txt; }
  return { status: r.status, j };
};
const line = (s) => console.log(s);
const fulfil = (r) => ((r.j && r.j.Fulfilments) || [])[0] || {};

(async () => {
  if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) {
    line('✖ Missing CIN7_ACCOUNT_ID / CIN7_API_KEY in .env'); return;
  }

  // ── STEP 0 — clear any stuck empty DRAFT fulfilment ──
  // POST /sale/fulfilment CREATES a fulfilment; an empty one left un-authorised
  // makes Cin7 reject the next call with "There is non authorised Fulfilment in
  // this sale." So we delete it and then create the pick in ONE shot.
  line('\n━━━ STEP 0 · clear stuck draft fulfilment ━━━');
  const existing = ((((await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID)).j) || {}).Fulfilments) || [];
  for (const f of existing) {
    if (f.FulFilmentStatus === 'NOT FULFILLED' && (!f.Pick || !(f.Pick.Lines || []).length)) {
      const d = await call('DELETE', 'sale/fulfilment?SaleID=' + SALE_ID + '&TaskID=' + f.TaskID);
      line('  deleted draft ' + f.TaskID + ' → HTTP ' + d.status);
    }
  }

  // ── STEP 1 — create + authorise the pick in ONE POST (top-level Pick, no
  //             Fulfilments wrapper, complete line). Any pre-existing DRAFT
  //             triggers "non authorised Fulfilment", so this must be atomic. ──
  line('\n━━━ STEP 1 · PICK (explicit bin MA-A-07-L7-P2, qty 3) ━━━');
  const pickBody = { SaleID: SALE_ID, Pick: { Status: 'AUTHORISED', Lines: [PICK_LINE] } };
  const pick = await call('POST', 'sale/fulfilment', pickBody);
  line('  POST pick → HTTP ' + pick.status);
  if (pick.status >= 400) { line('  ERROR BODY: ' + JSON.stringify(pick.j).slice(0, 1200)); }
  const F1 = fulfil(await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID));
  line('  Pick.Status: ' + (F1.Pick && F1.Pick.Status) + '  (lines: ' + ((F1.Pick && F1.Pick.Lines) || []).length + ')');
  ((F1.Pick && F1.Pick.Lines) || []).forEach(l => line('    ✓ ' + l.SKU + ' x' + l.Quantity + ' @ ' + l.Location));
  line('  Pack.Status now: ' + (F1.Pack && F1.Pack.Status));

  // ── STEP 2 — re-read: what does Cin7 give us for the pack? ──
  line('\n━━━ STEP 2 · READ BACK — pack template Cin7 offers ━━━');
  const after = await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID);
  const AF = fulfil(after);
  const liveTaskId = AF.TaskID;   // the task id of the fulfilment we just created
  const packStatus = AF.Pack && AF.Pack.Status;
  const packLines = (AF.Pack && AF.Pack.Lines) || [];
  line('  Pack.Status: ' + packStatus + '  |  pack lines offered: ' + packLines.length + '  |  boxes: ' + ((AF.Pack && AF.Pack.Boxes) || []).length);
  packLines.forEach(l => line('    · ' + l.SKU + ' x' + l.Quantity + (l.Box ? ' (box ' + l.Box + ')' : '')));

  // ── STEP 3 — commit the pack (1 carton with dimensions) ──
  if (packStatus && packStatus !== 'NOT AVAILABLE') {
    line('\n━━━ STEP 3 · PACK (1 carton, 30x20x15cm, 2kg) ━━━');
    const boxName = 'Box 1';
    const packBody = {
      SaleID: SALE_ID,
      Fulfilments: [{
        TaskID: liveTaskId,
        Pack: {
          Status: 'AUTHORISED',
          Lines: (packLines.length ? packLines : [{ ProductID: PICK_LINE.ProductID, SKU: PICK_LINE.SKU, Quantity: 3 }])
                   .map(l => Object.assign({}, l, { Box: boxName, Quantity: l.Quantity || 3 })),
          Boxes: [{ Box: boxName, Name: boxName, Length: 30, Width: 20, Height: 15, Weight: 2, DimensionUnit: 'cm', WeightUnit: 'kg' }],
        },
      }],
    };
    const pack = await call('POST', 'sale/fulfilment', packBody);
    line('  HTTP ' + pack.status);
    if (typeof pack.j === 'string') { line('  ' + pack.j.slice(0, 900)); }
    else {
      const PF = fulfil(pack);
      line('  Pack.Status: ' + (PF.Pack && PF.Pack.Status) + '  |  boxes: ' + ((PF.Pack && PF.Pack.Boxes) || []).length);
      ((PF.Pack && PF.Pack.Boxes) || []).forEach(b => line('    ▢ ' + (b.Name || b.Box) + '  ' + b.Length + 'x' + b.Width + 'x' + b.Height + ' ' + (b.DimensionUnit || '') + '  ' + b.Weight + (b.WeightUnit || '')));
      line('  Ship.Status now: ' + (PF.Ship && PF.Ship.Status) + '  (we STOP here — no shipping)');
    }
  } else {
    line('\n━━━ STEP 3 · PACK skipped — Cin7 reports Pack ' + packStatus + ' ━━━');
  }

  // ── STEP 4 — packing-slip check: is there ANY document endpoint? ──
  line('\n━━━ STEP 4 · PACKING SLIP — does Cin7 expose one? ━━━');
  for (const ep of ['sale/packingslip?SaleID=' + SALE_ID, 'sale/pickslip?SaleID=' + SALE_ID, 'sale/document?SaleID=' + SALE_ID]) {
    const d = await call('GET', ep);
    const has = typeof d.j !== 'string';
    line('  ' + (has ? 'DATA' : '404 ') + '  GET /' + ep.split('?')[0]);
  }

  // ── STEP 5 — dump what WE would print our own slip from ──
  line('\n━━━ STEP 5 · DATA WE OWN to print our own packing slip ━━━');
  const fin = fulfil(await call('GET', 'sale/fulfilment?SaleID=' + SALE_ID));
  line('  Fulfilment ' + (fin.FulfillmentNumber || '') + ' — ' + fin.FulFilmentStatus);
  line('  PICK lines: ' + ((fin.Pick && fin.Pick.Lines) || []).length + '  ·  PACK lines: ' + ((fin.Pack && fin.Pack.Lines) || []).length + '  ·  BOXES: ' + ((fin.Pack && fin.Pack.Boxes) || []).length);
  line('\n(Void/delete SO-280071 in Cin7 when done — this deducted real stock on the sample order.)\n');
})().catch(e => console.error('FATAL', e.message));
