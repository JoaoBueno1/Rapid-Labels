/**
 * wms-routes.js — Express API for the WMS PWA. Mounted under /api/wms/*.
 *
 * Wired live in server.js:  registerWmsRoutes(app, supabaseBackend);
 * Reachable in prod via the Vercel /api/* function (see vercel.json).
 *
 * Every write endpoint delegates to the engine, which delegates to the outbox, so
 * a double-submit or timeout-retry never double-moves stock.
 *
 * SAFETY: the 7 endpoints that move real Cin7 stock (receive, commit/pick,
 * finalize, commit/build, commit/pack, commit/transfer, tr-dispatch) are gated
 * behind W() and are OFF unless WMS_WRITE_ENABLED=true. Read/draft flows stay open
 * so the PWA + Pack Station can be opened and walked end-to-end with zero Cin7
 * footprint until a supervised live test deliberately flips the flag.
 */
'use strict';

const engine = require('../lib/wms-engine');
const transfers = require('../lib/wms-transfers');
const receiving = require('../lib/wms-receiving');
const sync = require('../lib/wms-sync');
const reconciler = require('../lib/reconciler');

function registerWmsRoutes(app, sb) {
  if (!sb) { console.warn('⚠️  WMS routes: no Supabase backend — skipping'); return; }
  const A = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: String(e.message || e) }));
  const user = (req) => (req.body && req.body.user) || req.header('X-WMS-User') || 'operator';

  // Live Cin7 writes are OFF by default. Flip WMS_WRITE_ENABLED=true only for a
  // supervised test — every endpoint that moves real stock is gated behind W().
  const writesOn = () => String(process.env.WMS_WRITE_ENABLED || '').toLowerCase() === 'true';
  const W = (fn) => A(async (req, res) => {
    if (!writesOn()) return res.status(403).json({ error: 'WMS live Cin7 writes are disabled. Set WMS_WRITE_ENABLED=true to enable.', wmsWriteDisabled: true });
    return fn(req, res);
  });

  // health
  app.get('/api/wms/health', (req, res) => res.json({ ok: true, feature: 'wms', ts: new Date().toISOString() }));

  // ── Waves ──
  // create/open a wave from a sale (idempotent — returns existing if present)
  app.post('/api/wms/wave', A(async (req, res) => {
    const { orderNumber } = req.body || {};
    if (!orderNumber) throw new Error('orderNumber required');
    res.json(await engine.buildWave(sb, orderNumber, user(req)));
  }));
  app.get('/api/wms/wave/:id', A(async (req, res) => {
    const w = await engine.getWave(sb, Number(req.params.id));
    if (!w) return res.status(404).json({ error: 'wave not found' });
    res.json(w);
  }));

  // open-work board (home): in-progress orders + Cin7 orders to start
  app.get('/api/wms/open', A(async (req, res) => res.json(await engine.listOpenWork(sb, {}))));
  // resolve a scanned code → product (barcode → SKU → 5DC)
  app.get('/api/wms/resolve/:code', A(async (req, res) => {
    const r = await engine.resolveScan(sb, req.params.code);
    if (!r) return res.status(404).json({ error: 'not found', code: req.params.code });
    res.json(r);
  }));

  // ── Receiving: read a PO, then putaway each line into a bin ──
  app.get('/api/wms/purchase/:number', A(async (req, res) => res.json(await receiving.getPurchaseLines(sb, req.params.number))));
  app.post('/api/wms/receive', W(async (req, res) => {
    const { sku, productId, qty, toBin, poNumber } = req.body || {};
    res.json(await receiving.receiveLine(sb, { sku, productId, qty: Number(qty), toBin, poNumber }, user(req)));
  }));

  // ── Concurrency: claim / release a line ──
  app.post('/api/wms/claim', A(async (req, res) => {
    const { waveId, saleLineRef } = req.body || {};
    res.json(await engine.claimLine(sb, Number(waveId), saleLineRef, user(req)));
  }));
  app.post('/api/wms/release', A(async (req, res) => {
    const { waveId, saleLineRef } = req.body || {};
    await engine.releaseLine(sb, Number(waveId), saleLineRef);
    res.json({ ok: true });
  }));

  // ── Scan a bin+product+qty into a draft line ──
  app.post('/api/wms/scan', A(async (req, res) => {
    const { parcelLineId, binCode, qty, sku, raw } = req.body || {};
    res.json(await engine.recordScan(sb, Number(parcelLineId), { binCode, qty: Number(qty), sku, raw }, user(req)));
  }));

  // ── Stock lookup + bin suggestion (PWA) ──
  app.get('/api/wms/suggest/:sku', A(async (req, res) => res.json(await engine.suggestBins(sb, req.params.sku))));
  app.get('/api/wms/lookup/:sku', A(async (req, res) => {
    const cin7 = require('../lib/cin7-wms-client');
    const rows = await cin7.availability(req.params.sku);
    res.json({ sku: req.params.sku, locations: rows.map((r) => ({ warehouse: r.Location, bin: r.Bin || '', onHand: Number(r.OnHand), available: Number(r.Available) })) });
  }));

  // ── Commit: pick ──
  app.post('/api/wms/commit/pick', W(async (req, res) => {
    const { parcelId } = req.body || {};
    res.json(await engine.commitPick(sb, Number(parcelId), user(req)));
  }));

  // ── New pick flow: unified list (normal lines + assembly components), component
  //    scan (draft), and finalize (build FGs + pick everything, one clean commit) ──
  app.get('/api/wms/pick-list/:waveId', A(async (req, res) => {
    const l = await engine.getPickList(sb, Number(req.params.waveId));
    if (!l) return res.status(404).json({ error: 'wave not found' });
    res.json(l);
  }));
  app.post('/api/wms/component-scan', A(async (req, res) => {
    const { buildComponentId, binCode, qty } = req.body || {};
    res.json(await engine.recordComponentScan(sb, Number(buildComponentId), { binCode, qty: Number(qty) }, user(req)));
  }));
  app.post('/api/wms/finalize', W(async (req, res) => {
    const { waveId } = req.body || {};
    res.json(await engine.finalize(sb, Number(waveId), user(req)));
  }));

  // ── Assembly: recipe, then stage a build from scanned components, then commit ──
  app.get('/api/wms/recipe/:sku', A(async (req, res) => res.json({ sku: req.params.sku, components: await engine.getRecipe(sb, req.params.sku) })));
  app.post('/api/wms/build', A(async (req, res) => {
    const { waveId, fgSku, fgProductId, qty, warehouseId, putawayBin, components } = req.body || {};
    res.json(await engine.stageBuild(sb, { waveId, fgSku, fgProductId, qty: Number(qty), warehouseId, putawayBin, components }, user(req)));
  }));
  app.post('/api/wms/commit/build', W(async (req, res) => {
    const { buildId } = req.body || {};
    res.json(await engine.commitBuild(sb, Number(buildId), user(req)));
  }));

  // ── Pack station (desktop): orders picked and waiting to pack ──
  // A pick parcel with a Cin7 fulfilment (picked) but no committed sale_pack op yet.
  app.get('/api/wms/pack/ready', A(async (req, res) => {
    const w = sb.schema('wms');
    const { data: parcels } = await w.from('parcels').select('id,wave_id,kind,status,cin7_task_id,cin7_ref')
      .eq('kind', 'pick').not('cin7_task_id', 'is', null).order('updated_at', { ascending: false }).limit(60);
    const list = parcels || [];
    if (!list.length) return res.json([]);
    const taskIds = list.map((p) => p.cin7_task_id);
    const { data: packed } = await w.from('outbox').select('cin7_task_id').eq('op_type', 'sale_pack').in('cin7_task_id', taskIds).in('status', ['sent', 'confirmed', 'reconciled']);
    const packedSet = new Set((packed || []).map((p) => p.cin7_task_id));
    const ready = list.filter((p) => !packedSet.has(p.cin7_task_id));
    if (!ready.length) return res.json([]);
    const waveIds = [...new Set(ready.map((p) => p.wave_id))];
    const { data: waves } = await w.from('waves').select('id,order_number,customer,ship_to,sale_id').in('id', waveIds);
    const wmap = {}; (waves || []).forEach((x) => { wmap[x.id] = x; });
    const { data: lines } = await w.from('parcel_lines').select('id,parcel_id,sku,name,qty_ordered,qty_scanned,box').in('parcel_id', ready.map((p) => p.id));
    const lmap = {}; (lines || []).forEach((l) => { (lmap[l.parcel_id] = lmap[l.parcel_id] || []).push(l); });
    res.json(ready.map((p) => ({ parcelId: p.id, waveId: p.wave_id, taskId: p.cin7_task_id, ref: p.cin7_ref, wave: wmap[p.wave_id] || {}, lines: lmap[p.id] || [] })));
  }));

  // Open ANY sales order for packing (typed/scanned SO). Builds/gets the wave — reads
  // the Cin7 sale, creates our DRAFT wave (no Cin7 write yet). Works whether or not the
  // order was picked in our WMS: `picked` tells the UI. Un-picked orders get picked +
  // packed together at authorise (for testing real orders before the pick flow is used).
  app.post('/api/wms/pack/open', A(async (req, res) => {
    const orderNumber = String((req.body || {}).orderNumber || '').trim();
    if (!orderNumber) throw new Error('orderNumber required');
    const w = await engine.buildWave(sb, orderNumber, user(req));
    const pick = (w.parcels || []).find(p => p.kind === 'pick');
    if (!pick) throw new Error('This order has no normal (pick) lines to pack.');
    res.json({
      parcelId: pick.id, taskId: pick.cin7_task_id || null, picked: !!pick.cin7_task_id,
      hasAssembly: !!w.wave.has_assembly,
      wave: { order_number: w.wave.order_number, customer: w.wave.customer, ship_to: w.wave.ship_to },
      lines: pick.lines
    });
  }));

  // assign a line to a carton (persists parcel_lines.box; commitPack reads it)
  app.post('/api/wms/pack/assign', A(async (req, res) => {
    const { parcelLineId, box } = req.body || {};
    await sb.schema('wms').from('parcel_lines').update({ box: box || null, updated_at: new Date().toISOString() }).eq('id', Number(parcelLineId));
    res.json({ ok: true });
  }));

  // ── Commit: pack ──
  app.post('/api/wms/commit/pack', W(async (req, res) => {
    const { parcelId, boxes } = req.body || {};
    res.json(await engine.commitPack(sb, Number(parcelId), boxes || [], user(req)));
  }));

  // ── Transfers (bin↔bin, warehouse↔warehouse) — pausable sessions ──
  app.post('/api/wms/transfer', A(async (req, res) => {
    const { kind, fromLocation, toLocation } = req.body || {};
    res.json(await transfers.stageTransfer(sb, { kind, fromLocation, toLocation }, user(req)));
  }));
  app.get('/api/wms/transfer/:id', A(async (req, res) => {
    const t = await transfers.getTransferState(sb, Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'transfer not found' });
    res.json(t);
  }));
  app.post('/api/wms/transfer/:id/line', A(async (req, res) => {
    const { sku, productId, qty, fromBin, toBin } = req.body || {};
    res.json(await transfers.addLine(sb, Number(req.params.id), { sku, productId, qty: Number(qty), fromBin, toBin }));
  }));
  app.post('/api/wms/transfer/line/:lineId/scan', A(async (req, res) => res.json(await transfers.scanLine(sb, Number(req.params.lineId), { qty: Number((req.body || {}).qty) }))));
  app.delete('/api/wms/transfer/line/:lineId', A(async (req, res) => res.json(await transfers.removeLine(sb, Number(req.params.lineId)))));
  app.post('/api/wms/commit/transfer', W(async (req, res) => res.json(await transfers.commitTransfer(sb, Number((req.body || {}).transferId), user(req)))));

  // ── TR pick: open an ordered TR, pick its lines, dispatch (ORDERED -> IN TRANSIT) ──
  app.post('/api/wms/tr/open', A(async (req, res) => {
    const number = String((req.body || {}).number || '').trim().toUpperCase();
    if (!number) throw new Error('TR number required');
    const id = await transfers.openTr(sb, number, user(req));
    res.json(await transfers.getTrPickList(sb, id));
  }));
  app.get('/api/wms/tr-pick-list/:id', A(async (req, res) => {
    const l = await transfers.getTrPickList(sb, Number(req.params.id));
    if (!l) return res.status(404).json({ error: 'transfer not found' });
    res.json(l);
  }));
  app.post('/api/wms/tr-scan', A(async (req, res) => {
    const { transferLineId, binCode, qty } = req.body || {};
    res.json(await transfers.recordTrScan(sb, Number(transferLineId), { binCode, qty: Number(qty) }, user(req)));
  }));
  app.post('/api/wms/tr-dispatch', W(async (req, res) => res.json(await transfers.dispatchTr(sb, Number((req.body || {}).transferId), user(req)))));

  // ── Maintenance: sync the owned bin/pickface registry + reconcile the outbox ──
  app.post('/api/wms/sync/bins', A(async (req, res) => res.json(await sync.syncBins(sb))));
  app.post('/api/wms/sync/pickface', A(async (req, res) => res.json(await sync.syncPickface(sb))));
  app.post('/api/wms/reconcile', A(async (req, res) => res.json(await reconciler.reconcile(sb, req.body || {}))));

  // ── Outbox / journal visibility (ops + audit) ──
  app.get('/api/wms/outbox', A(async (req, res) => {
    const { data } = await sb.schema('wms').from('outbox').select('op_key,op_type,status,cin7_ref,attempts,last_error,created_at').order('created_at', { ascending: false }).limit(100);
    res.json(data || []);
  }));
  app.get('/api/wms/movements', A(async (req, res) => {
    let q = sb.schema('wms').from('movements').select('*').order('occurred_at', { ascending: false }).limit(200);
    if (req.query.sku) q = q.eq('sku', req.query.sku);
    if (req.query.ref) q = q.eq('cin7_ref', req.query.ref);
    const { data } = await q;
    res.json(data || []);
  }));

  console.log('✅ WMS routes registered at /api/wms/* (feature isolated — not in nav)');
}

module.exports = { registerWmsRoutes };
