/**
 * Container Check — Backend Engine (QC de recebimento / inbound)
 *
 * Substitui o Container Report.xlsx. Cada registro = 1 SKU recebido de um
 * container, com status das etiquetas (OCL/ICL/Bar), fotos e notas.
 *
 * Fluxo: novo registro → red (se Wrong/Missing) ou pending → "Need Review" →
 * o revisor confirma tratado → green (+ reviewed_by/at) → fica no histórico.
 *
 * Architecture:
 *   - Persiste em cin7_mirror.container_checks (1 tabela).
 *   - Auditoria em cin7_mirror.container_check_log (best-effort — se a tabela
 *     não existir ainda, o CRUD continua funcionando sem log).
 *   - As FOTOS não passam por aqui: o navegador sobe direto pro bucket
 *     'container-check' do Supabase Storage. O POST/PUT só guarda as URLs.
 *   - Autocomplete lê de cin7_mirror.products (não bloqueia digitação livre).
 *   - Writes exigem header x-cc-user (guard-rail, não auth).
 *
 * Respostas no envelope { success, data?, error? }.
 * Registered from server.js via:
 *   require('./features/container-check/container-check-engine')(app, supabaseBackend);
 */

const SCHEMA = 'cin7_mirror';
const TABLE  = 'container_checks';
const LOG    = 'container_check_log';

const LABEL_VALUES  = ['OK', 'Wrong', 'Missing', 'N/A'];
// 3 statuses: red = problem not yet reviewed · pending = clean, awaiting review ·
// green = reviewed/confirmed. (orange retired — the DB CHECK still allows it for
// any legacy rows, but nothing sets it anymore.)
const STATUS_VALUES = ['green', 'red', 'pending'];

// ─── Response helpers ───────────────────────────────────────────────
function ok(res, data)            { return res.json({ success: true, data }); }
function fail(res, status, error) { return res.status(status).json({ success: false, error }); }
function getUser(req) {
  const u = (req.headers['x-cc-user'] || '').toString().trim();
  return u || null;
}
function requireUser(req, res) {
  const u = getUser(req);
  if (!u) { fail(res, 400, 'Missing x-cc-user header (set localStorage.containerCheckUser)'); return null; }
  return u;
}

// ─── Field sanitisers ───────────────────────────────────────────────
function cleanLabel(v) {
  const s = (v == null ? '' : String(v)).trim();
  return LABEL_VALUES.includes(s) ? s : null;
}
function cleanStatus(v, fallback) {
  const s = (v == null ? '' : String(v)).trim().toLowerCase();
  return STATUS_VALUES.includes(s) ? s : fallback;
}
function cleanPhotos(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter(p => p && typeof p.url === 'string' && p.url)
    .slice(0, 4)
    .map(p => ({ url: String(p.url), label: p.label ? String(p.label).slice(0, 60) : '' }));
}
function txt(v, max = 2000) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function photoUrlSet(arr) {
  return new Set((Array.isArray(arr) ? arr : []).map(p => p && p.url).filter(Boolean));
}

// An item "has an issue" if any of the three labels is Wrong/Missing.
function hasIssue(r) {
  return ['ocl', 'icl', 'bar'].some(k => r[k] === 'Wrong' || r[k] === 'Missing');
}

function buildSummary(items) {
  const by_status = { green: 0, red: 0, orange: 0, pending: 0 };
  const blank = () => ({ OK: 0, Wrong: 0, Missing: 0, 'N/A': 0, blank: 0 });
  const by_label = { ocl: blank(), icl: blank(), bar: blank() };
  let issues = 0;
  for (const r of items) {
    if (by_status[r.status] != null) by_status[r.status]++;
    if (hasIssue(r)) issues++;
    for (const k of ['ocl', 'icl', 'bar']) {
      const v = r[k];
      if (v && by_label[k][v] != null) by_label[k][v]++;
      else by_label[k].blank++;
    }
  }
  const total = items.length;
  return { total, ok: total - issues, issues, issue_rate: total ? issues / total : 0, by_status, by_label };
}

// ════════════════════════════════════════════════════════════════════
// REGISTER ROUTES
// ════════════════════════════════════════════════════════════════════
module.exports = function registerContainerCheckRoutes(app, supabaseBackend) {
  if (!supabaseBackend) {
    console.warn('⚠️  Container Check: Supabase backend not configured — endpoints will return 503');
  }
  const db    = () => supabaseBackend.schema(SCHEMA).from(TABLE);
  const logTb = () => supabaseBackend.schema(SCHEMA).from(LOG);

  // Apply the shared filters (from/to/status/q) to a query builder.
  function applyFilters(q, query) {
    if (query.from)   q = q.gte('check_date', query.from);
    if (query.to)     q = q.lte('check_date', query.to);
    if (query.status && STATUS_VALUES.includes(query.status)) q = q.eq('status', query.status);
    const term = (query.q || '').toString().trim();
    if (term) q = q.ilike('rapid_code', `%${term}%`);
    return q;
  }

  // Best-effort audit log — never throws, never blocks the main op.
  // If the log table doesn't exist yet (migration 003 not applied), silently no-op.
  async function writeLog(record_id, rapid_code, action, actor, details) {
    try {
      const { error } = await logTb().insert({ record_id, rapid_code: rapid_code || null, action, actor: actor || null, details: details || {} });
      if (error && error.code !== '42P01') console.warn('[container-check/log]', error.message);
    } catch (e) { /* table missing or transient — ignore */ }
  }

  // ─── GET /records — paginated list + summary over the FULL filter ─
  // Query: ?from &to &status &q &page &pageSize
  app.get('/api/container-check/records', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const query = req.query || {};
      const page     = Math.max(1, parseInt(query.page, 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || 50));
      const offset   = (page - 1) * pageSize;

      // Summary over ALL matching rows (only 4 tiny cols; paginate past the 1000 cap).
      const summaryRows = [];
      for (let off = 0; off < 50000; off += 1000) {
        const { data, error } = await applyFilters(db().select('status,ocl,icl,bar'), query).range(off, off + 999);
        if (error) throw error;
        if (!data || !data.length) break;
        summaryRows.push(...data);
        if (data.length < 1000) break;
      }
      const total   = summaryRows.length;
      const summary = buildSummary(summaryRows);

      // The page of full rows.
      const { data: items, error: ie } = await applyFilters(db().select('*'), query)
        .order('check_date', { ascending: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (ie) throw ie;

      return ok(res, { items: items || [], summary, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) });
    } catch (err) {
      console.error('[container-check/records]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── GET /review — fila Need Review (não revisados: pending + red) ─
  app.get('/api/container-check/review', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const { data, error } = await db().select('*').in('status', ['pending', 'red'])
        .order('check_date', { ascending: true }).order('created_at', { ascending: true }).limit(2000);
      if (error) throw error;
      return ok(res, { items: data || [], count: (data || []).length });
    } catch (err) {
      console.error('[container-check/review]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── GET /products — autocomplete (cin7_mirror.products) ─────────
  // Não bloqueia: só sugere. Query: ?q=R1091
  app.get('/api/container-check/products', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const raw = (req.query.q || '').toString().trim();
      const term = raw.replace(/[^a-zA-Z0-9 _-]/g, '');   // safe for the .or() filter
      if (term.length < 2) return ok(res, { items: [] });
      const { data, error } = await supabaseBackend.schema(SCHEMA).from('products')
        .select('sku,name,barcode,attribute1')
        .or(`sku.ilike.*${term}*,name.ilike.*${term}*,barcode.ilike.*${term}*`)
        .limit(20);
      if (error) throw error;
      const items = (data || []).map(p => ({ sku: p.sku, name: p.name || '', barcode: p.barcode || '', five_dc: p.attribute1 || '' }))
        .sort((a, b) => {
          const t = term.toLowerCase();
          const ax = (a.sku || '').toLowerCase().startsWith(t) ? 0 : 1;
          const bx = (b.sku || '').toLowerCase().startsWith(t) ? 0 : 1;
          return ax !== bx ? ax - bx : (a.sku || '').localeCompare(b.sku || '');
        });
      return ok(res, { items });
    } catch (err) {
      console.error('[container-check/products]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── GET /records/:id/log — histórico de um registro ─────────────
  app.get('/api/container-check/records/:id/log', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const { data, error } = await logTb().select('*').eq('record_id', req.params.id)
        .order('created_at', { ascending: false }).limit(200);
      if (error) {
        if (error.code === '42P01') return ok(res, { items: [], note: 'log table not created yet (run migration 003)' });
        throw error;
      }
      return ok(res, { items: data || [] });
    } catch (err) {
      console.error('[container-check/records/log]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── POST /records — cria (sempre entra como pending) ────────────
  app.post('/api/container-check/records', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const b = req.body || {};
      const rapid_code = txt(b.rapid_code, 120);
      if (!rapid_code) return fail(res, 400, 'rapid_code is required');

      const photos = cleanPhotos(b.photos);
      const row = {
        check_date:      b.check_date || undefined,
        five_dc:         txt(b.five_dc, 60),
        rapid_code,
        qty:             b.qty === '' || b.qty == null ? null : Number(b.qty),
        po:              txt(b.po, 60),
        ocl:             cleanLabel(b.ocl),
        icl:             cleanLabel(b.icl),
        bar:             cleanLabel(b.bar),
        photos,
        inventory_notes: txt(b.inventory_notes),
        reviewer_notes:  txt(b.reviewer_notes),
        // red if a label is Wrong/Missing (problem to treat), else pending
        // (clean, awaiting review). Green only happens later, via review.
        status:          hasIssue({ ocl: cleanLabel(b.ocl), icl: cleanLabel(b.icl), bar: cleanLabel(b.bar) }) ? 'red' : 'pending',
        created_by:      user,
      };
      if (row.qty != null && !Number.isFinite(row.qty)) row.qty = null;

      const { data, error } = await db().insert(row).select('id').single();
      if (error) throw error;
      await writeLog(data.id, rapid_code, 'created', user, {
        ocl: row.ocl, icl: row.icl, bar: row.bar, qty: row.qty, po: row.po, photos: photos.length,
      });
      return ok(res, { id: data.id });
    } catch (err) {
      console.error('[container-check/records/create]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── PUT /records/:id — edita / revisa ───────────────────────────
  app.put('/api/container-check/records/:id', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const id = req.params.id;
      const b = req.body || {};

      const { data: before, error: be } = await db().select('*').eq('id', id).single();
      if (be) { if (be.code === 'PGRST116') return fail(res, 404, 'Record not found'); throw be; }

      const patch = {};
      if (b.check_date !== undefined)      patch.check_date      = b.check_date || null;
      if (b.five_dc !== undefined)         patch.five_dc         = txt(b.five_dc, 60);
      if (b.rapid_code !== undefined) {
        const rc = txt(b.rapid_code, 120);
        if (!rc) return fail(res, 400, 'rapid_code cannot be empty');
        patch.rapid_code = rc;
      }
      if (b.qty !== undefined)             patch.qty             = (b.qty === '' || b.qty == null) ? null : (Number.isFinite(Number(b.qty)) ? Number(b.qty) : null);
      if (b.po !== undefined)              patch.po              = txt(b.po, 60);
      if (b.ocl !== undefined)             patch.ocl             = cleanLabel(b.ocl);
      if (b.icl !== undefined)             patch.icl             = cleanLabel(b.icl);
      if (b.bar !== undefined)             patch.bar             = cleanLabel(b.bar);
      if (b.photos !== undefined)          patch.photos          = cleanPhotos(b.photos);
      if (b.inventory_notes !== undefined) patch.inventory_notes = txt(b.inventory_notes);
      if (b.reviewer_notes !== undefined)  patch.reviewer_notes  = txt(b.reviewer_notes);
      if (b.status !== undefined)          patch.status          = cleanStatus(b.status, before.status || 'pending');

      if (Object.keys(patch).length === 0) return fail(res, 400, 'nothing to update');
      patch.updated_at = new Date().toISOString();

      const { error: ue } = await db().update(patch).eq('id', id);
      if (ue) throw ue;

      // Review stamp (best-effort — reviewed_by/at exist only after migration 003)
      const statusChanged = patch.status !== undefined && patch.status !== before.status;
      if (statusChanged) {
        const stamp = (patch.status === 'pending')
          ? { reviewed_by: null, reviewed_at: null }
          : { reviewed_by: user, reviewed_at: new Date().toISOString() };
        try { await db().update(stamp).eq('id', id); } catch (e) { /* cols missing — ignore */ }
      }

      // Audit log
      const changed = Object.keys(patch).filter(k => k !== 'updated_at');
      let photos_added = 0, photos_removed = 0;
      if (patch.photos !== undefined) {
        const oldS = photoUrlSet(before.photos), newS = photoUrlSet(patch.photos);
        for (const u of newS) if (!oldS.has(u)) photos_added++;
        for (const u of oldS) if (!newS.has(u)) photos_removed++;
      }
      const action = statusChanged && patch.status !== 'pending' ? 'reviewed' : 'updated';
      await writeLog(id, patch.rapid_code || before.rapid_code, action, user, {
        changed, photos_added, photos_removed,
        from_status: statusChanged ? before.status : undefined,
        to_status:   statusChanged ? patch.status  : undefined,
      });

      return ok(res, { id });
    } catch (err) {
      console.error('[container-check/records/update]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─── DELETE /records/:id — apaga (log sobrevive) ─────────────────
  app.delete('/api/container-check/records/:id', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const id = req.params.id;
      const { data: before } = await db().select('rapid_code,photos,status').eq('id', id).single();
      const { error } = await db().delete().eq('id', id);
      if (error) throw error;
      await writeLog(id, before && before.rapid_code, 'deleted', user, {
        status: before && before.status, photos: before && Array.isArray(before.photos) ? before.photos.length : 0,
      });
      return ok(res, { id, deleted: true });
    } catch (err) {
      console.error('[container-check/records/delete]', err);
      return fail(res, 500, err.message);
    }
  });

  console.log('✅ Container Check routes registered (records, review, products, log, create, update, delete)');
};
