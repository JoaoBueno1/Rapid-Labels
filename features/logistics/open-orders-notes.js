// Open Orders "tratativas" layer — server routes for cin7_mirror.chase_notes.
//
// This is OUR system's follow-up log (contacted / resolved / free note), stored in
// our Supabase only. NOTHING is ever written back to Cin7 — the Open Orders page
// just monitors. Writes go through the server with the service key (browser anon
// writes are the wrong trust boundary for a shared team log), mirroring the pattern
// the pick-anomalies engine already uses.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

// Cin7 (for on-demand transfer line items — transfers are header-only in the mirror)
const CIN7_BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const CIN7_ACC = process.env.CIN7_ACCOUNT_ID || '';
const CIN7_KEY = process.env.CIN7_API_KEY || '';
const _trCache = new Map();               // taskId -> { at, payload }
const TR_TTL = 10 * 60 * 1000;            // 10 min — a packing list rarely changes mid-transit

// One live Cin7 detail call per expanded transfer (user-triggered, cached). The
// mirror stores transfers header-only, so line items aren't there to read.
async function fetchTransferLines(taskId) {
  const cached = _trCache.get(taskId);
  if (cached && Date.now() - cached.at < TR_TTL) return cached.payload;
  const r = await fetch(`${CIN7_BASE}/stockTransfer?TaskID=${encodeURIComponent(taskId)}`, {
    headers: { 'api-auth-accountid': CIN7_ACC, 'api-auth-applicationkey': CIN7_KEY, 'Accept': 'application/json' }
  });
  if (!r.ok) throw new Error(`Cin7 ${r.status}`);
  const j = await r.json();
  const payload = {
    meta: { status: j.Status || null, number: j.Number || null, from: j.FromLocation || null, to: j.ToLocation || null, completion: j.CompletionDate || null, reference: j.Reference || null },
    lines: (j.Lines || []).map(l => ({ sku: l.SKU, name: l.ProductName, qty: l.TransferQuantity, onHand: l.QuantityOnHand, available: l.QuantityAvailable }))
  };
  _trCache.set(taskId, { at: Date.now(), payload });
  return payload;
}

// Products whose stock_locator marks them as an assembly / made-to-order item
// (the company's convention in Cin7 — regular stock carries a bin like MA-A-01).
const ASSEMBLY_LOCATORS = new Set(['BOM', 'PRODUCTION']);
const _bomCache = new Map();
const BOM_TTL = 60 * 60 * 1000;   // 1h — a BOM rarely changes

async function cin7Get(path) {
  const r = await fetch(`${CIN7_BASE}/${path}`, { headers: { 'api-auth-accountid': CIN7_ACC, 'api-auth-applicationkey': CIN7_KEY, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`Cin7 ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : {};
}

// Components of an assembly product. Cin7 exposes no readable BOM template
// (product?ID BillOfMaterialsProducts comes back empty), so we read the PickLines
// consumed by the product's most recent COMPLETED build — that IS the recipe.
// finishedGoodsList is oldest-first, so we page to the newest. Cached 1h.
async function fetchBom(sku) {
  const key = sku.toUpperCase();
  const cached = _bomCache.get(key);
  if (cached && Date.now() - cached.at < BOM_TTL) return cached.payload;
  const first = await cin7Get(`finishedGoodsList?Search=${encodeURIComponent(sku)}&Page=1&Limit=100`);
  let builds = (first.FinishedGoods || []).filter(h => h.ProductCode === sku);
  const total = first.Total || builds.length;
  if (total > 100) {
    const lp = await cin7Get(`finishedGoodsList?Search=${encodeURIComponent(sku)}&Page=${Math.ceil(total / 100)}&Limit=100`);
    builds = builds.concat((lp.FinishedGoods || []).filter(h => h.ProductCode === sku));
  }
  const completed = builds.filter(h => h.Status === 'COMPLETED').sort((a, b) => String(a.Date || '').localeCompare(String(b.Date || '')));
  const latest = completed[completed.length - 1];
  let payload;
  if (!latest) {
    payload = { found: false, components: [] };
  } else {
    const det = await cin7Get(`finishedGoods?TaskID=${latest.TaskID}`);
    const producedQty = Number(det.Quantity) || 1;
    payload = {
      found: true, assembly: det.AssemblyNumber, builtOn: det.CompletionDate || latest.Date, producedQty,
      components: (det.PickLines || []).filter(p => p.ProductCode).map(p => ({
        sku: p.ProductCode, name: p.Name || null,
        qtyPerUnit: producedQty ? (Number(p.Quantity) || 0) / producedQty : (Number(p.Quantity) || 0)
      }))
    };
  }
  _bomCache.set(key, { at: Date.now(), payload });
  return payload;
}

function headers(extra = {}) {
  return Object.assign({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'cin7_mirror',   // read from the cin7_mirror schema
    'Content-Profile': 'cin7_mirror'   // write to it
  }, extra);
}

async function getNotes() {
  const url = `${SUPABASE_URL}/rest/v1/chase_notes?select=order_number,note,contacted_at,contacted_by,resolved,updated_at`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`chase_notes read ${r.status}: ${await r.text()}`);
  return r.json();
}

async function upsertNote(row) {
  const url = `${SUPABASE_URL}/rest/v1/chase_notes?on_conflict=order_number`;
  const r = await fetch(url, {
    method: 'POST',
    headers: headers({ 'Prefer': 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error(`chase_notes upsert ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── stock enrichment for expanded line items (locator + availability) ──
function inList(vals) { return '(' + vals.map(v => '"' + String(v).replace(/["\\]/g, '') + '"').join(',') + ')'; }

async function sbGet(pathAndQuery) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { headers: headers() });
  if (!r.ok) throw new Error(`${pathAndQuery.split('?')[0]} ${r.status}: ${await r.text()}`);
  return r.json();
}

// For a set of SKUs: product locator + assembly flag, and stock availability
// aggregated (total + per-warehouse) across ALL locations (mirror, service key).
async function lineStockMap(skus) {
  const uniq = [...new Set(skus.filter(Boolean).map(String))];
  const map = {};
  uniq.forEach(s => { map[s] = { sku: s, locator: null, isAssembly: false, availTotal: 0, onHandTotal: 0, byLoc: [] }; });
  for (let i = 0; i < uniq.length; i += 80) {
    const filt = encodeURIComponent(inList(uniq.slice(i, i + 80)));
    const prods = await sbGet(`products?select=sku,stock_locator&sku=in.${filt}`);
    prods.forEach(p => { const m = map[p.sku]; if (m) { m.locator = p.stock_locator || null; m.isAssembly = ASSEMBLY_LOCATORS.has(String(p.stock_locator || '').toUpperCase()); } });
    const avail = await sbGet(`stock_availability?select=sku,location,available,on_hand&sku=in.${filt}`);
    avail.forEach(a => {
      const m = map[a.sku]; if (!m) return;
      if (/faulty|ghost/i.test(a.location || '')) return;   // not sellable stock — skip
      m.availTotal += Number(a.available) || 0; m.onHandTotal += Number(a.on_hand) || 0;
      m.byLoc.push({ location: a.location, available: Number(a.available) || 0, on_hand: Number(a.on_hand) || 0 });
    });
  }
  Object.values(map).forEach(m => m.byLoc.sort((a, b) => b.available - a.available));
  return map;
}

function registerOpenOrdersRoutes(app) {
  // Line items for one transfer (on-demand, cached). Needs only Cin7 creds, so it
  // is registered BEFORE (and independently of) the Supabase guard — a Supabase-less
  // or partially-configured deploy still serves the expand-row lookup.
  app.get('/api/open-orders/transfer-lines', async (req, res) => {
    try {
      const taskId = String(req.query.taskId || '').trim();
      if (!taskId) return res.status(400).json({ success: false, error: 'taskId required' });
      if (!CIN7_ACC || !CIN7_KEY) return res.status(503).json({ success: false, error: 'Cin7 credentials not configured' });
      res.json(Object.assign({ success: true }, await fetchTransferLines(taskId)));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Components of an assembly/BOM product (from its latest build). Cin7-only.
  app.get('/api/open-orders/bom', async (req, res) => {
    try {
      const sku = String(req.query.sku || '').trim();
      if (!sku) return res.status(400).json({ success: false, error: 'sku required' });
      if (!CIN7_ACC || !CIN7_KEY) return res.status(503).json({ success: false, error: 'Cin7 credentials not configured' });
      res.json(Object.assign({ success: true }, await fetchBom(sku)));
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('⚠️  Open Orders: SUPABASE_URL / key missing — notes routes disabled (transfer-lines still active)');
    console.log('✅ Open Orders transfer-lines route registered (Cin7 only)');
    return;
  }

  // All follow-up notes (the open set is small; the page indexes by order_number).
  app.get('/api/open-orders/notes', async (req, res) => {
    try { res.json({ success: true, notes: await getNotes() }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Upsert one order's follow-up (contacted / resolved / free note).
  app.post('/api/open-orders/note', async (req, res) => {
    try {
      const b = req.body || {};
      const order_number = String(b.order_number || '').trim();
      if (!order_number) return res.status(400).json({ success: false, error: 'order_number required' });
      const today = new Date().toISOString().slice(0, 10);
      const row = {
        order_number,
        note: b.note != null ? String(b.note).slice(0, 2000) : null,
        contacted_at: b.contacted ? (b.contacted_at || today) : (b.contacted_at || null),
        contacted_by: b.contacted_by != null ? String(b.contacted_by).slice(0, 120) : null,
        resolved: !!b.resolved,
        updated_at: new Date().toISOString()
      };
      const saved = await upsertNote(row);
      res.json({ success: true, note: Array.isArray(saved) ? saved[0] : saved });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Stock enrichment (locator + assembly flag + availability by warehouse) for a
  // batch of line SKUs — powers the expanded line items' Locator/Available columns.
  app.post('/api/open-orders/line-stock', async (req, res) => {
    try {
      const skus = Array.isArray(req.body && req.body.skus) ? req.body.skus : [];
      if (!skus.length) return res.json({ success: true, stock: {} });
      res.json({ success: true, stock: await lineStockMap(skus) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  console.log('✅ Open Orders routes registered (/api/open-orders/*)');
}

module.exports = { registerOpenOrdersRoutes, getNotes, upsertNote };
