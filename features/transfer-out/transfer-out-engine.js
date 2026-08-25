/*
 * Transfer Out — server routes. The Cin7 API key stays server-side (the browser never
 * sees it). Isolated feature engine; registered from server.js with one line.
 *
 *   GET /api/transfer-out/detail/:taskId  → the TR's lines (works for ORDERED transfers
 *        too — those keep their items under Order.Lines, not Lines).
 *   GET /api/transfer-out/search?q=TR-123 → live Cin7 lookup, for when a just-created
 *        transfer hasn't reached the mirror/webhook yet.
 *   GET /api/transfer-out/product-notes?skus=A,B → each SKU's Cin7 InternalNote (the kit
 *        recipe: "Extrusion x 1 / End caps x 2"), cached 6h.
 */
const CIN7_BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';

module.exports = function registerTransferOutRoutes(app) {
  const ACC = process.env.CIN7_ACCOUNT_ID, CK = process.env.CIN7_API_KEY;
  const num = v => (v == null || v === '') ? 0 : Number(v);

  async function cin7(path, _r = 0) {
    let res;
    try {
      res = await fetch(`${CIN7_BASE}/${path}`, {
        headers: { 'api-auth-accountid': ACC, 'api-auth-applicationkey': CK, 'Accept': 'application/json' },
      });
    } catch (e) { if (_r < 4) { await new Promise(r => setTimeout(r, 2000)); return cin7(path, _r + 1); } throw e; }
    if ((res.status === 429 || res.status === 503) && _r < 5) {
      await new Promise(r => setTimeout(r, 2000 * (_r + 1))); return cin7(path, _r + 1);
    }
    if (!res.ok) throw new Error(`Cin7 ${res.status}`);
    return res.json();
  }

  const d = v => (v ? String(v).split('T')[0] : null);

  // ── TR detail: the lines to pick ──
  app.get('/api/transfer-out/detail/:id', async (req, res) => {
    try {
      if (!ACC || !CK) return res.status(500).json({ success: false, error: 'Cin7 not configured' });
      const det = await cin7(`stockTransfer?TaskID=${encodeURIComponent(req.params.id)}`);
      // ORDERED transfers carry items under Order.Lines; dispatched ones under Lines.
      const raw = (det.Lines && det.Lines.length) ? det.Lines : ((det.Order && det.Order.Lines) || []);
      const lines = raw.map(ln => ({
        sku: ln.SKU || ln.ProductCode || '',
        product_name: ln.ProductName || ln.Name || '',
        qty: num(ln.TransferQuantity != null ? ln.TransferQuantity : ln.Quantity),
      })).filter(l => l.sku);
      res.json({
        success: true,
        header: {
          number: det.Number || null, task_id: det.TaskID || req.params.id,
          from: det.FromLocation || null, to: det.ToLocation || null,
          status: det.Status || null,
          date: d(det.OrderDate || det.CreatedDate || det.DepartureDate || det.LastModifiedOn) || null,
        },
        lines,
      });
    } catch (err) {
      console.error('Transfer-out detail error:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // ── product internal notes: the kit components that ride along with a line ──
  // Cin7 does NOT expose the BOM template over the API (BillOfMaterialsProducts comes
  // back empty even with IncludeBOM=true), so the InternalNote the team writes on the
  // product IS the picking recipe. It already rides in the normal /product payload.
  // Cached per SKU so re-opening a 70-line transfer doesn't re-ask Cin7 every time.
  const _noteCache = new Map();               // SKU(upper) -> { at, note }
  const NOTE_TTL = 6 * 60 * 60 * 1000;        // 6h — an internal note changes rarely

  async function fetchNote(sku) {
    const key = String(sku).toUpperCase();
    const hit = _noteCache.get(key);
    if (hit && Date.now() - hit.at < NOTE_TTL) return hit.note;
    let note = '';
    try {
      // Sku= is a prefix/contains search, so pull a window and match exactly.
      const j = await cin7(`product?Sku=${encodeURIComponent(sku)}&Page=1&Limit=50`);
      const exact = (j.Products || []).find(p => String(p.SKU).toUpperCase() === key);
      note = exact ? String(exact.InternalNote || '').trim() : '';
    } catch (err) {
      return '';   // a missing note must never break the pick sheet — and never poison the cache
    }
    _noteCache.set(key, { at: Date.now(), note });
    return note;
  }

  app.get('/api/transfer-out/product-notes', async (req, res) => {
    try {
      if (!ACC || !CK) return res.status(500).json({ success: false, error: 'Cin7 not configured' });
      const skus = [...new Set(String(req.query.skus || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 200);
      const queue = skus.slice();
      const notes = {};
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length) {
          const sku = queue.shift();
          const note = await fetchNote(sku);
          if (note) notes[sku] = note;
        }
      }));
      res.json({ success: true, notes });
    } catch (err) {
      console.error('Transfer-out product-notes error:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // ── live search (webhook-delay fallback) ──
  app.get('/api/transfer-out/search', async (req, res) => {
    try {
      if (!ACC || !CK) return res.status(500).json({ success: false, error: 'Cin7 not configured' });
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ success: true, results: [] });
      const j = await cin7(`stockTransferList?Page=1&Limit=50&Search=${encodeURIComponent(q)}`);
      const results = (j.StockTransferList || []).map(t => ({
        id: t.TaskID, number: t.Number,
        from_location: t.FromLocation, to_location: t.ToLocation,
        status: t.Status, order_date: d(t.OrderDate || t.CreatedDate), reference: t.Reference,
      }));
      res.json({ success: true, results });
    } catch (err) {
      console.error('Transfer-out search error:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  console.log('✅ Transfer Out routes registered (/api/transfer-out/*)');
};
