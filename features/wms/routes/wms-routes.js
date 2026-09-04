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

  // ── Order-level claim + lease (multi-operator picking). Gated server-side by
  //    WMS_CLAIMS_ENABLED; when off these are cheap no-ops so the flow is unchanged.
  //    kind: 'so' (a wave) | 'tr' (a transfer). No Cin7 write — our concurrency layer.
  const workTable = (k) => (k === 'tr' ? 'transfers' : k === 'so' ? 'waves' : null);
  app.post('/api/wms/claim-work', A(async (req, res) => {
    const { kind, id } = req.body || {}; const t = workTable(kind);
    if (!t) throw new Error('bad work kind'); res.json(await engine.claimWork(sb, t, Number(id), user(req)));
  }));
  app.post('/api/wms/heartbeat-work', A(async (req, res) => {
    const { kind, id } = req.body || {}; const t = workTable(kind);
    if (!t) throw new Error('bad work kind'); res.json(await engine.heartbeatWork(sb, t, Number(id), user(req)));
  }));
  app.post('/api/wms/release-work', A(async (req, res) => {
    const { kind, id } = req.body || {}; const t = workTable(kind);
    if (!t) throw new Error('bad work kind'); res.json(await engine.releaseWork(sb, t, Number(id), user(req)));
  }));

  // ── Scan a bin+product+qty into a draft line ──
  app.post('/api/wms/scan', A(async (req, res) => {
    const { parcelLineId, binCode, qty, sku, raw } = req.body || {};
    res.json(await engine.recordScan(sb, Number(parcelLineId), { binCode, qty: Number(qty), sku, raw }, user(req)));
  }));

  // ── Pick exception (shortage / damage / wrong-bin): log to the scan audit, no Cin7
  //    write, doesn't block the pick — a supervisor reviews wms.scans (scan_type='exception').
  app.post('/api/wms/exception', A(async (req, res) => {
    const { parcelLineId, kind, reason, sku, bin, qty, lineKind, lineId } = req.body || {};
    await sb.schema('wms').from('scans').insert({
      parcel_line_id: parcelLineId ? Number(parcelLineId) : null,
      scan_type: 'exception',
      raw_value: [kind || 'issue', reason, (lineKind && lineId) ? `[${lineKind}#${lineId}]` : ''].filter(Boolean).join(' — '),
      resolved_sku: sku || null, resolved_bin: bin || null,
      qty: (qty != null && qty !== '') ? Number(qty) : null, scanned_by: user(req),
    });
    res.json({ ok: true });
  }));

  // ── Stock lookup + bin suggestion (PWA) ──
  app.get('/api/wms/suggest/:sku', A(async (req, res) => res.json(await engine.suggestBins(sb, req.params.sku))));
  app.get('/api/wms/lookup/:sku', A(async (req, res) => res.json(await engine.stockLookup(sb, req.params.sku))));

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

  // persist the packed carton dims (for the TMS booking handoff). Best-effort: the
  // boxes column arrives with migration 003 — if it isn't there yet, report persisted:false
  // rather than error, so the Pack Station's fire-and-forget save never breaks packing.
  app.post('/api/wms/pack/boxes', A(async (req, res) => {
    const { parcelId, boxes } = req.body || {};
    const { error } = await sb.schema('wms').from('parcels')
      .update({ boxes: boxes || [], updated_at: new Date().toISOString() }).eq('id', Number(parcelId));
    res.json({ ok: true, persisted: !error });
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
  app.post('/api/wms/tr-dispatch', W(async (req, res) => res.json(await transfers.dispatchTr(sb, Number((req.body || {}).transferId), user(req), { override: !!(req.body || {}).override }))));

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

  // ══════════════════════════════════════════════════════════════════════
  // MOBILE EXTRAS — labels + container check capture
  // ══════════════════════════════════════════════════════════════════════

  /* Busca de produto para ETIQUETA.
     resolveScan (o /resolve/:code acima) devolve {sku, productId, name} e serve
     ao picking, mas a etiqueta precisa tambem do BARCODE e do 5DC (attribute1)
     — sem eles a etiqueta sai sem barras e sem o numero que o operador le.
     Por isso uma rota propria em vez de esticar aquela: quem pica e quem imprime
     querem coisas diferentes do mesmo produto.

     ATENCAO a inversao de nomes, que e a fonte mais provavel de etiqueta errada:
     o que a interface chama de "SKU" e products.attribute1 (o 5DC), e o que ela
     chama de "Code" e products.sku. */
  app.get('/api/wms/product-search', A(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const cm = sb.schema('cin7_mirror');
    const cols = 'sku,name,barcode,attribute1,type,status';
    const seen = new Set(), out = [];
    const push = (rows, how) => {
      for (const p of (rows || [])) {
        const k = String(p.sku || '').toUpperCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push({ code: p.sku, dc5: p.attribute1 || '', name: p.name || '',
                   barcode: p.barcode || '', matchedBy: how });
      }
    };
    // Exatos primeiro — quem escaneia um codigo de barras quer AQUELE item no
    // topo, nao o primeiro alfabetico de um ilike que tambem o contem.
    push((await cm.from('products').select(cols).eq('barcode', q).limit(5)).data, 'barcode');
    push((await cm.from('products').select(cols).eq('sku', q).limit(5)).data, 'code');
    push((await cm.from('products').select(cols).eq('attribute1', q).limit(10)).data, '5dc');
    if (out.length < 25) {
      const like = `%${q.replace(/[%,]/g, '')}%`;
      push((await cm.from('products').select(cols)
        .or(`sku.ilike.${like},name.ilike.${like},attribute1.ilike.${like}`)
        .limit(40)).data, 'partial');
    }
    res.json(out.slice(0, 25));
  }));

  /* Upload de foto do Container Check, pelo SERVIDOR.
     A tela de desktop sobe direto para o Storage com o supabase-js do navegador
     (features/container-check/container-check.js:768). Fazer o mesmo aqui
     obrigaria o PWA a carregar o supabase-js inteiro so por causa disto — peso
     que o fluxo de picking pagaria sem usar. O servidor ja tem a service key.

     Recebe um data URL porque o corpo ja e JSON em toda esta rota; multipart
     traria uma dependencia nova para resolver um problema que nao temos. O
     redimensionamento continua NO TELEFONE (canvas), entao o que sobe aqui ja
     vem pequeno — o limite abaixo e rede de seguranca, nao o caminho normal. */
  app.post('/api/wms/cc-photo', A(async (req, res) => {
    if (!sb) return res.status(503).json({ error: 'Supabase backend not configured' });
    const { dataUrl, code, date } = req.body || {};
    const m = /^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return res.status(400).json({ error: 'dataUrl must be a base64 jpeg or png' });
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty image' });
    if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'image over 4 MB — resize before sending' });
    const safe = String(code || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'item';
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
    const ext = m[1] === 'png' ? 'png' : 'jpg';
    // O mesmo formato de caminho da tela de desktop, para as duas origens
    // ficarem no mesmo bucket sem se distinguirem depois.
    const path = `${day}/${safe}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const up = await sb.storage.from('container-check')
      .upload(path, buf, { contentType: `image/${ext === 'jpg' ? 'jpeg' : 'png'}`, upsert: false });
    if (up.error) return res.status(502).json({ error: up.error.message });
    const { data } = sb.storage.from('container-check').getPublicUrl(path);
    res.json({ url: data.publicUrl });
  }));

  console.log('✅ WMS routes registered at /api/wms/* (feature isolated — not in nav)');
}

module.exports = { registerWmsRoutes };
