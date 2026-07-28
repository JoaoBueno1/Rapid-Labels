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

  console.log('✅ Open Orders routes registered (/api/open-orders/*)');
}

module.exports = { registerOpenOrdersRoutes, getNotes, upsertNote };
