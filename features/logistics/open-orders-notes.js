// Open Orders "tratativas" layer — server routes for cin7_mirror.chase_notes.
//
// This is OUR system's follow-up log (contacted / resolved / free note), stored in
// our Supabase only. NOTHING is ever written back to Cin7 — the Open Orders page
// just monitors. Writes go through the server with the service key (browser anon
// writes are the wrong trust boundary for a shared team log), mirroring the pattern
// the pick-anomalies engine already uses.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('⚠️  Open Orders notes: SUPABASE_URL / key missing — /api/open-orders routes disabled');
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

  console.log('✅ Open Orders notes routes registered (/api/open-orders/*)');
}

module.exports = { registerOpenOrdersRoutes, getNotes, upsertNote };
