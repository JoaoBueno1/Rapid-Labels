/**
 * wms-engine.js — domain logic. Turns a Cin7 sale into a Wave, manages line
 * claims + scans in our DB (draft, fully editable), and commits pick / build /
 * pack to Cin7 through the outbox (exactly-once, write-after-confirm).
 *
 * Nothing here writes to Cin7 directly — every mutation goes via lib/outbox.js.
 */
'use strict';

const cin7 = require('./cin7-wms-client');
const outbox = require('./outbox');
const transfers = require('./wms-transfers');

function wms(sb) { return sb.schema('wms'); }
const PRODUCTION_BIN = process.env.WMS_PRODUCTION_BIN || 'MA-PRODUCTION';
const MAIN_WH_ID = process.env.WMS_MAIN_WAREHOUSE_ID || '907821e3-c06b-4bf1-a8af-888bc3a2031f';
const MAIN_WH_NAME = 'Main Warehouse';

// "Main Warehouse: MA-A-07-L7-P2" is the pick-line Location format Cin7 wants.
function locString(binCode) { return binCode ? `${MAIN_WH_NAME}: ${binCode}` : MAIN_WH_NAME; }

// Resolve a scanned bin code to its Cin7 LocationID GUID (bins are child locations).
async function resolveBinId(sb, binCode) {
  if (!binCode) return MAIN_WH_ID; // no-bin items pick from the warehouse root
  const own = await wms(sb).from('bins').select('cin7_location_id').eq('bin_code', binCode).maybeSingle();
  if (own.data && own.data.cin7_location_id) return own.data.cin7_location_id;
  const mir = await sb.schema('cin7_mirror').from('locations').select('id').eq('name', binCode).maybeSingle();
  return (mir.data && mir.data.id) || null;
}

// ── Ingest a sale → Wave (draft, zero Cin7 writes) ──────────────────────────
async function buildWave(sb, orderNumber, user) {
  const existing = await wms(sb).from('waves').select('*').eq('order_number', orderNumber).maybeSingle();
  if (existing.data) return getWave(sb, existing.data.id);

  const head = await cin7.findSaleByNumber(orderNumber);
  if (!head) throw new Error(`Sale ${orderNumber} not found in Cin7`);
  const sale = await cin7.getSale(head.SaleID);
  if (!sale) throw new Error(`Sale ${orderNumber} detail unavailable`);
  if (!/advanced/i.test(sale.Type || '')) {
    throw new Error(`${orderNumber} is a ${sale.Type}. Only Advanced Sales support the pack step — set it to Advanced in Cin7.`);
  }
  const lines = (sale.Order && sale.Order.Lines) || [];

  // detect assembled lines (cache per product)
  const asmCache = {};
  const detail = [];
  for (const l of lines) {
    if (asmCache[l.ProductID] === undefined) asmCache[l.ProductID] = await cin7.isAssembled(l.ProductID);
    detail.push({ line: l, isAssembly: asmCache[l.ProductID] });
  }
  const hasAssembly = detail.some((d) => d.isAssembly);

  const { data: wave } = await wms(sb).from('waves').insert({
    sale_id: head.SaleID, order_number: orderNumber, sale_type: sale.Type,
    customer: sale.Customer, ship_to: sale.ShippingAddress || {},
    status: 'draft', has_assembly: hasAssembly, created_by: user,
  }).select().single();

  // one assembly parcel (BOM lines) + one pick parcel (the rest)
  const mkParcel = async (kind) => (await wms(sb).from('parcels').insert({ wave_id: wave.id, kind, status: 'draft' }).select().single()).data;
  const asmParcel = hasAssembly ? await mkParcel('assembly') : null;
  const pickParcel = await mkParcel('pick');

  const plines = [];
  detail.forEach((d, i) => {
    const parcel = d.isAssembly ? asmParcel : pickParcel;
    plines.push({
      parcel_id: parcel.id, sale_line_ref: `${orderNumber}#${i}`,
      sku: d.line.SKU, product_id: d.line.ProductID, name: d.line.Name,
      is_assembly: d.isAssembly, qty_ordered: d.line.Quantity, status: 'draft',
    });
  });
  if (plines.length) await wms(sb).from('parcel_lines').insert(plines);
  return getWave(sb, wave.id);
}

// Open-work board for the home: our in-progress orders (for resume / handoff) +
// Cin7 orders sitting NOT PICKED (new work to start). Drives the multi-user flow.
async function listOpenWork(sb, { limit = 30 } = {}) {
  const { data: waves } = await wms(sb).from('waves').select('id,order_number,customer,status,has_assembly,created_at')
    .neq('status', 'committed').order('created_at', { ascending: false }).limit(limit);
  const ids = (waves || []).map((w) => w.id);
  let parcels = [];
  if (ids.length) { const r = await wms(sb).from('parcels').select('wave_id,kind,status').in('wave_id', ids); parcels = r.data || []; }
  const byWave = {}; parcels.forEach((p) => { (byWave[p.wave_id] = byWave[p.wave_id] || []).push(p); });
  const inProgress = (waves || []).map((w) => ({ ...w, parcels: byWave[w.id] || [] }));

  const started = new Set((waves || []).map((w) => w.order_number));
  const { data: cin7 } = await sb.schema('cin7_mirror').from('sales_orders')
    .select('order_number,customer,picking_status,type,order_date')
    .eq('location_name', 'Main Warehouse').eq('picking_status', 'NOT PICKED')
    .order('order_date', { ascending: false }).limit(limit * 2);
  const toStart = (cin7 || []).filter((o) => !started.has(o.order_number) && /advanced/i.test(o.type || '')).slice(0, limit);
  return { inProgress, toStart };
}

// Resolve a scanned code to a product: real barcode → SKU → 5DC (human lookup).
// SKU (printed as CODE128 by label-sheets) is the authoritative scan key.
async function resolveScan(sb, code) {
  code = String(code || '').trim();
  if (!code) return null;
  const cm = sb.schema('cin7_mirror');
  const cols = 'id,sku,name,barcode,attribute1';
  let hit = (await cm.from('products').select(cols).eq('barcode', code).limit(1)).data;
  if (hit && hit[0]) return fmt(hit[0], 'barcode');
  hit = (await cm.from('products').select(cols).eq('sku', code).limit(1)).data;
  if (hit && hit[0]) return fmt(hit[0], 'sku');
  hit = (await cm.from('products').select(cols).eq('attribute1', code).limit(2)).data;
  if (hit && hit.length === 1) return fmt(hit[0], '5dc');       // 5DC is non-unique — only trust a single hit
  return null;
  function fmt(p, by) { return { sku: p.sku, productId: p.id, name: p.name, matchedBy: by, ambiguous: false }; }
}

async function getWave(sb, waveId) {
  const { data: wave } = await wms(sb).from('waves').select('*').eq('id', waveId).maybeSingle();
  if (!wave) return null;
  const { data: parcels } = await wms(sb).from('parcels').select('*').eq('wave_id', waveId).order('kind');
  const { data: lines } = await wms(sb).from('parcel_lines').select('*')
    .in('parcel_id', (parcels || []).map((p) => p.id));
  const { data: claims } = await wms(sb).from('line_claims').select('*').eq('wave_id', waveId).is('released_at', null);
  const byParcel = {};
  (lines || []).forEach((l) => { (byParcel[l.parcel_id] = byParcel[l.parcel_id] || []).push(l); });
  return {
    wave,
    parcels: (parcels || []).map((p) => ({ ...p, lines: byParcel[p.id] || [] })),
    claims: claims || [],
  };
}

// ── Concurrency: line claims (our authority, since Cin7 has none) ────────────
async function claimLine(sb, waveId, saleLineRef, user) {
  const { error } = await wms(sb).from('line_claims').insert({ wave_id: waveId, sale_line_ref: saleLineRef, claimed_by: user });
  if (error) {
    if (/duplicate/i.test(error.message)) {
      const { data } = await wms(sb).from('line_claims').select('claimed_by').eq('wave_id', waveId).eq('sale_line_ref', saleLineRef).is('released_at', null).maybeSingle();
      throw new Error(`Line already claimed by ${data ? data.claimed_by : 'another operator'}`);
    }
    throw new Error(error.message);
  }
  return { ok: true };
}
async function releaseLine(sb, waveId, saleLineRef) {
  await wms(sb).from('line_claims').update({ released_at: new Date().toISOString() }).eq('wave_id', waveId).eq('sale_line_ref', saleLineRef);
}

// ── Scan a bin+product+qty into a draft line (before any Cin7 write) ─────────
async function recordScan(sb, parcelLineId, { binCode, qty, sku, raw }, user) {
  const binId = await resolveBinId(sb, binCode);
  await wms(sb).from('scans').insert({
    parcel_line_id: parcelLineId, scan_type: 'product', raw_value: raw || sku,
    resolved_sku: sku, resolved_bin: binCode, qty, scanned_by: user,
  });
  await wms(sb).from('parcel_lines').update({
    qty_scanned: qty, from_bin: binCode, from_bin_id: binId, status: 'in_progress', updated_at: new Date().toISOString(),
  }).eq('id', parcelLineId);
  return { binId };
}

// Suggest a source bin: pickface first, else the availability snapshot (overflow-aware).
async function suggestBins(sb, sku) {
  const pf = await wms(sb).from('pickface').select('bin_code,rank').eq('sku', sku).order('rank');
  const avail = await cin7.availability(sku);
  const bins = avail.filter((a) => a.Location === MAIN_WH_NAME && Number(a.Available) > 0)
    .map((a) => ({ bin: a.Bin || '', available: Number(a.Available), onHand: Number(a.OnHand) }));
  return { pickface: (pf.data || []).map((p) => p.bin_code), bins };
}

// ── COMMIT: pick (write-after-confirm, exactly-once) ────────────────────────
async function commitPick(sb, parcelId, user) {
  const { data: parcel } = await wms(sb).from('parcels').select('*').eq('id', parcelId).maybeSingle();
  if (!parcel) throw new Error('parcel not found');
  const { data: wave } = await wms(sb).from('waves').select('*').eq('id', parcel.wave_id).maybeSingle();
  const { data: lines } = await wms(sb).from('parcel_lines').select('*').eq('parcel_id', parcelId);
  const scanned = (lines || []).filter((l) => Number(l.qty_scanned) > 0);
  if (!scanned.length) throw new Error('nothing scanned to commit');

  // exactly ONE fulfilment for this parcel
  let taskId = parcel.cin7_task_id;
  if (!taskId) { taskId = await cin7.createFulfilment(wave.sale_id); await wms(sb).from('parcels').update({ cin7_task_id: taskId }).eq('id', parcelId); }

  const pickLines = scanned.map((l) => ({
    ProductID: l.product_id, SKU: l.sku, Quantity: Number(l.qty_scanned),
    Location: locString(l.from_bin), LocationID: l.from_bin_id, BatchSN: null,
  }));

  const key = outbox.opKey('sale_pick', wave.sale_id, parcelId, pickLines);
  await outbox.enqueue(sb, { op_key: key, op_type: 'sale_pick', target: 'sale/fulfilment/pick', cin7_task_id: taskId, payload: { taskId, pickLines }, created_by: user });

  const res = await outbox.execute(sb, key, {
    actor: user,
    doWrite: async () => { const r = await cin7.authorisePick(taskId, pickLines); return { cin7_ref: wave.order_number, cin7_task_id: taskId, response: r }; },
    verify: async () => { const p = await cin7.getPick(taskId); return { done: p && p.Status === 'AUTHORISED' }; },
    movements: scanned.map((l) => ({ movement_type: 'pick', sku: l.sku, product_id: l.product_id, qty: Number(l.qty_scanned), from_bin: l.from_bin, warehouse_id: MAIN_WH_ID, cin7_ref: wave.order_number, wave_id: wave.id })),
  });

  await wms(sb).from('parcels').update({ status: 'committed', outbox_op_key: key, updated_at: new Date().toISOString() }).eq('id', parcelId);
  await wms(sb).from('parcel_lines').update({ status: 'committed' }).eq('parcel_id', parcelId);
  return { ok: true, taskId, alreadyDone: res.alreadyDone };
}

// The component recipe for an assembled SKU. Cin7 hides it on the product, but
// it lives in a build's OrderLines — prefer the sale-linked build, else a past one.
async function getRecipe(sb, fgSku) {
  const linked = await cin7.findLinkedBuild(fgSku);
  if (linked) {
    const det = await cin7.getBuild(linked.TaskID);
    if (det && det.OrderLines && det.OrderLines.length) {
      return det.OrderLines.map((l) => ({ sku: l.ProductCode, product_id: l.ProductID, qty_per: Number(l.Quantity) || 1 }));
    }
  }
  const r = await cin7.recipeFromExistingBuild(fgSku);
  return (r || []).map((l) => ({ sku: l.ProductCode, product_id: l.ProductID, qty_per: Number(l.Quantity) || 1 }));
}

// ── Stage an assembly build from scanned components (draft, no Cin7 write) ──
async function stageBuild(sb, { waveId, fgSku, fgProductId, qty, warehouseId, putawayBin, components }, user) {
  const { data: build } = await wms(sb).from('builds').insert({
    wave_id: waveId || null, fg_sku: fgSku, fg_product_id: fgProductId, qty,
    warehouse_id: warehouseId || MAIN_WH_ID, putaway_bin: putawayBin || PRODUCTION_BIN,
    status: 'draft', created_by: user,
  }).select().single();
  const rows = [];
  for (const c of (components || [])) {
    const binId = c.from_bin_id || (await resolveBinId(sb, c.from_bin));
    rows.push({ build_id: build.id, sku: c.sku, product_id: c.product_id, qty: c.qty, from_bin: c.from_bin, from_bin_id: binId });
  }
  if (rows.length) await wms(sb).from('build_components').insert(rows);
  return build;
}

// ── COMMIT: assembly build (adopt-or-create, exactly-once) ──────────────────
// components: [{ sku, product_id, qty, from_bin, from_bin_id }]  (already scanned)
async function commitBuild(sb, buildId, user) {
  const { data: build } = await wms(sb).from('builds').select('*').eq('id', buildId).maybeSingle();
  if (!build) throw new Error('build not found');
  const { data: comps } = await wms(sb).from('build_components').select('*').eq('build_id', buildId);
  if (!comps || !comps.length) throw new Error('no components scanned');

  // Adopt the build Cin7 auto-created for this FG, else create one — never both.
  let taskId = build.cin7_task_id;
  let adopted = build.adopted;
  if (!taskId) {
    const linked = await cin7.findLinkedBuild(build.fg_sku);
    if (linked) { taskId = linked.TaskID; adopted = true; }
    else {
      const created = await cin7.createBuild({ productId: build.fg_product_id, productCode: build.fg_sku, location: MAIN_WH_NAME, locationId: build.warehouse_id || MAIN_WH_ID, quantity: Number(build.qty) });
      taskId = created.TaskID;
    }
    await wms(sb).from('builds').update({ cin7_task_id: taskId, adopted }).eq('id', buildId);
  }

  const recipe = comps.map((c) => ({ ProductID: c.product_id, ProductCode: c.sku, Quantity: 1 }));
  const pickLines = comps.map((c) => ({ ProductID: c.product_id, ProductCode: c.sku, Quantity: Number(c.qty), BinID: c.from_bin_id, Bin: c.from_bin, BatchSN: null }));

  const key = outbox.opKey('fg_build', build.wave_id, build.fg_sku, pickLines);
  await outbox.enqueue(sb, { op_key: key, op_type: 'fg_build', target: 'finishedGoods/pick', cin7_task_id: taskId, payload: { taskId, recipe, pickLines }, created_by: user });

  const res = await outbox.execute(sb, key, {
    actor: user,
    doWrite: async () => {
      await cin7.setBuildRecipe(taskId, recipe);           // recipe (OrderLines)
      const r = await cin7.completeBuild(taskId, pickLines); // consume components + COMPLETED
      const built = await cin7.getBuild(taskId);
      return { cin7_ref: (built && built.AssemblyNumber) || null, cin7_task_id: taskId, response: r };
    },
    verify: async () => { const b = await cin7.getBuild(taskId); return { done: b && b.Status === 'COMPLETED', cin7_ref: b && b.AssemblyNumber }; },
    movements: [
      ...comps.map((c) => ({ movement_type: 'assembly_consume', sku: c.sku, product_id: c.product_id, qty: -Math.abs(Number(c.qty)), from_bin: c.from_bin, warehouse_id: MAIN_WH_ID, wave_id: build.wave_id })),
      { movement_type: 'assembly_produce', sku: build.fg_sku, product_id: build.fg_product_id, qty: Number(build.qty), to_bin: build.putaway_bin || null, warehouse_id: MAIN_WH_ID, wave_id: build.wave_id },
    ],
  });

  await wms(sb).from('builds').update({ status: 'committed', outbox_op_key: key, cin7_assembly_number: res.cin7_ref, updated_at: new Date().toISOString() }).eq('id', buildId);

  // Simple, automatic putaway: the produced FG is born binless — move it to the
  // fixed production bin so it's findable/pickable. Best-effort (own exactly-once op).
  const putBin = build.putaway_bin || PRODUCTION_BIN;
  let putaway = null;
  try {
    putaway = await transfers.putawayFG(sb, { fgSku: build.fg_sku, fgProductId: build.fg_product_id, qty: Number(build.qty), toBin: putBin, waveId: build.wave_id }, user);
    await wms(sb).from('builds').update({ putaway_bin: putBin }).eq('id', buildId);
  } catch (e) { putaway = { ok: false, error: String(e.message) }; }

  return { ok: true, taskId, assemblyNumber: res.cin7_ref, adopted, alreadyDone: res.alreadyDone, putaway };
}

// ── COMMIT: pack (write-after-confirm) ──────────────────────────────────────
// boxes: [{ name, length, width, height, weight, lines:[{ parcel_line_id }] }]
async function commitPack(sb, parcelId, boxes, user) {
  const { data: parcel } = await wms(sb).from('parcels').select('*').eq('id', parcelId).maybeSingle();
  if (!parcel || !parcel.cin7_task_id) throw new Error('parcel not picked yet');
  const { data: wave } = await wms(sb).from('waves').select('*').eq('id', parcel.wave_id).maybeSingle();
  const { data: lines } = await wms(sb).from('parcel_lines').select('*').eq('parcel_id', parcelId);
  const taskId = parcel.cin7_task_id;

  const boxSpec = (boxes || []).map((b, i) => ({ Box: b.name || `Box ${i + 1}`, Name: b.name || `Box ${i + 1}`, Length: b.length, Width: b.width, Height: b.height, Weight: b.weight, DimensionUnit: 'cm', WeightUnit: 'kg' }));
  const defaultBox = boxSpec[0] ? boxSpec[0].Box : 'Box 1';
  const packLines = (lines || []).filter((l) => Number(l.qty_scanned) > 0).map((l) => ({
    ProductID: l.product_id, SKU: l.sku, Quantity: Number(l.qty_scanned),
    Location: locString(l.from_bin), LocationID: l.from_bin_id, Box: l.box || defaultBox,
  }));

  const key = outbox.opKey('sale_pack', wave.sale_id, parcelId, boxSpec);
  await outbox.enqueue(sb, { op_key: key, op_type: 'sale_pack', target: 'sale/fulfilment/pack', cin7_task_id: taskId, payload: { taskId, packLines, boxSpec }, created_by: user });

  const res = await outbox.execute(sb, key, {
    actor: user,
    doWrite: async () => { const r = await cin7.authorisePack(taskId, packLines, boxSpec, MAIN_WH_NAME); return { cin7_ref: wave.order_number, cin7_task_id: taskId, response: r }; },
    verify: async () => { const p = await cin7.getPack(taskId); return { done: p && p.Status === 'AUTHORISED' }; },
    movements: packLines.map((l) => ({ movement_type: 'pack', sku: l.SKU, qty: l.Quantity, cin7_ref: wave.order_number, warehouse_id: MAIN_WH_ID, wave_id: wave.id })),
  });
  // persist our own carton dims (Cin7 doesn't reliably keep them) for the TMS + our slip
  await wms(sb).from('parcels').update({ status: 'committed', updated_at: new Date().toISOString() }).eq('id', parcelId);
  return { ok: true, taskId, boxes: boxSpec, alreadyDone: res.alreadyDone };
}

module.exports = {
  MAIN_WH_ID, MAIN_WH_NAME, locString, resolveBinId,
  buildWave, getWave, listOpenWork, resolveScan, claimLine, releaseLine, recordScan, suggestBins, getRecipe,
  stageBuild, commitPick, commitBuild, commitPack,
};
