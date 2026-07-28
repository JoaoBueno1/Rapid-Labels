/**
 * wms-routes.js — Express API for the WMS PWA. Mounted under /api/wms/*.
 *
 * Wiring (NOT done yet — the feature is not live):
 *   const { registerWmsRoutes } = require('./features/wms/routes/wms-routes');
 *   registerWmsRoutes(app, supabaseBackend);
 * Until that line is added to server.js, none of this is reachable — the feature
 * is fully isolated on the dev branch as requested.
 *
 * Every write endpoint delegates to the engine, which delegates to the outbox, so
 * a double-submit or timeout-retry never double-moves stock.
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
  app.post('/api/wms/receive', A(async (req, res) => {
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
  app.post('/api/wms/commit/pick', A(async (req, res) => {
    const { parcelId } = req.body || {};
    res.json(await engine.commitPick(sb, Number(parcelId), user(req)));
  }));

  // ── Assembly: recipe, then stage a build from scanned components, then commit ──
  app.get('/api/wms/recipe/:sku', A(async (req, res) => res.json({ sku: req.params.sku, components: await engine.getRecipe(sb, req.params.sku) })));
  app.post('/api/wms/build', A(async (req, res) => {
    const { waveId, fgSku, fgProductId, qty, warehouseId, putawayBin, components } = req.body || {};
    res.json(await engine.stageBuild(sb, { waveId, fgSku, fgProductId, qty: Number(qty), warehouseId, putawayBin, components }, user(req)));
  }));
  app.post('/api/wms/commit/build', A(async (req, res) => {
    const { buildId } = req.body || {};
    res.json(await engine.commitBuild(sb, Number(buildId), user(req)));
  }));

  // ── Commit: pack ──
  app.post('/api/wms/commit/pack', A(async (req, res) => {
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
  app.post('/api/wms/commit/transfer', A(async (req, res) => res.json(await transfers.commitTransfer(sb, Number((req.body || {}).transferId), user(req)))));

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
