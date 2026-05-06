/**
 * Container Builder — Backend Engine
 *
 * WMS module that plans optimal 3D loading of shipping containers
 * (20ft / 40ft / 40HC) from Cin7 master data.
 *
 * Architecture:
 *   - Reads dimensions from cin7_mirror.products (synced periodically by
 *     cin7-stock-sync/sync-service.js — see mapProductRow).
 *   - Persists plans to cin7_mirror.container_plans + container_plan_lines.
 *   - Cin7 PO lookups go live via /purchaseList with a 5-min in-memory cache
 *     (no Redis — the master data cache is the cin7_mirror schema itself).
 *   - All write endpoints require an x-cb-user header carrying free-text
 *     identity from localStorage.containerBuilderUser. There is no auth in
 *     this repo; this is a guardrail, not security.
 *
 * Conventions:
 *   - cin7Get/cin7Post are intentionally duplicated from
 *     pick-anomalies-engine.js. Matches the established per-engine client
 *     pattern in this repo — do not refactor into a shared module.
 *   - All responses use the { success, data?, error? } envelope.
 *
 * Registered from server.js via:
 *   require('./features/container-builder/container-builder-engine')(app, supabaseBackend);
 */

const fetch = require('node-fetch');
const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { SOLVER_VERSION, CONTAINERS, packAll } = require('./packer');

// ─── Cin7 Config ────────────────────────────────────────────────────
const CIN7 = {
  baseUrl:   'https://inventory.dearsystems.com/ExternalApi/v2',
  accountId: process.env.CIN7_ACCOUNT_ID || '',
  apiKey:    process.env.CIN7_API_KEY    || '',
};

// ─── Caches ─────────────────────────────────────────────────────────
const POS_CACHE      = new Map();         // 'open' → { fetchedAt, data }
const POS_CACHE_TTL  = 5 * 60 * 1000;     // 5 min
const PRODUCT_CACHE  = new Map();         // sku → { fetchedAt, data }
const PRODUCT_TTL    = 5 * 60 * 1000;

const SOLVE_TIMEOUT_MS = 10_000;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Cin7 helpers (duplicated from pick-anomalies-engine.js by convention) ───
async function cin7Get(endpoint) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type':            'application/json',
      'api-auth-accountid':      CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    timeout: 20000,
  });
  if (res.status === 429) {
    console.warn('⚠️  [container-builder] Cin7 rate limit (429), waiting 25s...');
    await delay(25000);
    return cin7Get(endpoint);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status}: ${res.statusText} (${endpoint})`);
  return res.json();
}

async function cin7Post(endpoint, body) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':            'application/json',
      'api-auth-accountid':      CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    body:    JSON.stringify(body),
    timeout: 20000,
  });
  if (res.status === 429) {
    console.warn('⚠️  [container-builder] Cin7 rate limit (429), waiting 25s...');
    await delay(25000);
    return cin7Post(endpoint, body);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Cin7 POST ${res.status}: ${txt} (${endpoint})`);
  }
  return res.json();
}

// ─── Response helpers ───────────────────────────────────────────────
function ok(res, data) {
  return res.json({ success: true, data });
}
function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}
function getUser(req) {
  const u = (req.headers['x-cb-user'] || '').toString().trim();
  return u || null;
}
function requireUser(req, res) {
  const u = getUser(req);
  if (!u) {
    fail(res, 400, 'Missing x-cb-user header (set localStorage.containerBuilderUser)');
    return null;
  }
  return u;
}

// ─── Supabase paginated fetch (Supabase caps at 1000 per request) ───
async function fetchAllProducts(supabaseBackend) {
  const PAGE = 1000;
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await supabaseBackend
      .schema('cin7_mirror')
      .from('products')
      .select('sku, name, category, barcode, carton_length, carton_width, carton_height, carton_quantity, carton_inner_quantity, weight, weight_units, dimensions_units, attribute1, synced_at')
      .eq('status', 'Active')
      .order('sku', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE) break;
    if (offset > 50000) break;
  }
  return all;
}

// cin7_mirror.products.carton_length / width / height are stored in the unit
// declared by `dimensions_units` (default 'cm' per the schema). We trust that
// here. If a SKU is misconfigured (stored in mm by mistake), the value will be
// large (e.g. 2500 instead of 25) and the /solve endpoint catches it at the
// >300cm sanity check — which surfaces the bad data instead of hiding it.
function asCm(v) {
  return Number(v) || 0;
}

// ════════════════════════════════════════════════════════════════════
// REGISTER ROUTES
// ════════════════════════════════════════════════════════════════════
module.exports = function registerContainerBuilderRoutes(app, supabaseBackend) {
  if (!supabaseBackend) {
    console.warn('⚠️  Container Builder: Supabase backend not configured — endpoints will return 503');
  }

  // ─────────────────────────────────────────────────────────────────
  // GET /audit — Dimension coverage report (LIVE in PR 1)
  // ─────────────────────────────────────────────────────────────────
  app.get('/api/container-builder/products/audit', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const data = await fetchAllProducts(supabaseBackend);

      const isComplete = (p) => p.carton_length > 0 && p.carton_width > 0 && p.carton_height > 0;
      const total      = data.length;
      const complete   = data.filter(isComplete).length;

      const missingByField = {
        carton_length:   data.filter(p => !(p.carton_length   > 0)).length,
        carton_width:    data.filter(p => !(p.carton_width    > 0)).length,
        carton_height:   data.filter(p => !(p.carton_height   > 0)).length,
        carton_quantity: data.filter(p => !(p.carton_quantity > 0)).length,
        weight:          data.filter(p => !(p.weight          > 0)).length,
        category:        data.filter(p => !p.category).length,
      };

      const sampleMissing = data
        .filter(p => !isComplete(p))
        .slice(0, 50)
        .map(p => ({
          sku:      p.sku,
          name:     p.name,
          category: p.category,
          missing:  [
            !(p.carton_length   > 0) && 'L',
            !(p.carton_width    > 0) && 'W',
            !(p.carton_height   > 0) && 'H',
            !(p.carton_quantity > 0) && 'qty',
            !(p.weight          > 0) && 'kg',
          ].filter(Boolean),
        }));

      const byCategoryMap = {};
      for (const p of data) {
        const cat = p.category || '(uncategorized)';
        if (!byCategoryMap[cat]) byCategoryMap[cat] = { total: 0, complete: 0 };
        byCategoryMap[cat].total++;
        if (isComplete(p)) byCategoryMap[cat].complete++;
      }
      const byCategory = Object.entries(byCategoryMap)
        .map(([category, v]) => ({
          category, total: v.total, complete: v.complete,
          pct: v.total ? Math.round((1000 * v.complete) / v.total) / 10 : 0,
        }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 30);

      const lastSynced = data.map(p => p.synced_at).filter(Boolean).sort().pop() || null;

      return ok(res, {
        total_active:        total,
        complete_dims:       complete,
        pct_complete:        total ? Math.round((1000 * complete) / total) / 10 : 0,
        missing_by_field:    missingByField,
        sample_missing:      sampleMissing,
        by_category:         byCategory,
        last_product_synced: lastSynced,
      });
    } catch (err) {
      console.error('[container-builder/audit]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /products — searchable list of plannable SKUs (PR 3)
  // Query: ?search=...&plannableOnly=true&limit=200
  // ─────────────────────────────────────────────────────────────────
  app.get('/api/container-builder/products', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');

      const search        = (req.query.search || '').toString().trim().toLowerCase();
      const plannableOnly = req.query.plannableOnly === 'true';
      const limit         = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);

      const all = await fetchAllProducts(supabaseBackend);

      let rows = all.map(p => ({
        sku:                  p.sku,
        name:                 p.name,
        category:             p.category,
        barcode:              p.barcode,
        attribute1:           p.attribute1,           // 5DC code
        carton_l_cm:          asCm(p.carton_length),
        carton_w_cm:          asCm(p.carton_width),
        carton_h_cm:          asCm(p.carton_height),
        carton_kg:            Number(p.weight) || 0,
        units_per_carton:     Math.max(1, Math.floor(Number(p.carton_quantity) || 1)),
        weight_units:         p.weight_units,
        dimensions_units:     p.dimensions_units,
        plannable:            p.carton_length > 0 && p.carton_width > 0 && p.carton_height > 0,
      }));

      if (plannableOnly) rows = rows.filter(r => r.plannable);

      if (search) {
        rows = rows.filter(r =>
          (r.sku || '').toLowerCase().includes(search) ||
          (r.name || '').toLowerCase().includes(search) ||
          (r.attribute1 || '').toLowerCase().includes(search) ||
          (r.barcode || '').toLowerCase().includes(search)
        );
        rows.sort((a, b) => {
          const aExact = a.sku.toLowerCase() === search ? 0 : 1;
          const bExact = b.sku.toLowerCase() === search ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          return a.sku.localeCompare(b.sku);
        });
      }

      return ok(res, {
        total:    rows.length,
        returned: Math.min(rows.length, limit),
        items:    rows.slice(0, limit),
      });
    } catch (err) {
      console.error('[container-builder/products]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /solve — run packer (stateless) (PR 3)
  // Body: { containerType: '20ft'|'40ft'|'40HC', cartons: [{sku,L,W,H,kg,qty}, ...] }
  // ─────────────────────────────────────────────────────────────────
  app.post('/api/container-builder/solve', async (req, res) => {
    try {
      const { containerType, cartons } = req.body || {};
      if (!CONTAINERS[containerType]) return fail(res, 400, `Unknown containerType: ${containerType}`);
      if (!Array.isArray(cartons) || cartons.length === 0) return fail(res, 400, 'cartons must be a non-empty array');

      // Sanity-check: any dim >300cm is probably wrong units
      for (const c of cartons) {
        if (c.L > 300 || c.W > 300 || c.H > 300) {
          return fail(res, 400, `Carton ${c.sku || '(unknown)'} has dim >300cm — check units (cm/mm/m)`);
        }
      }

      const dims = CONTAINERS[containerType];
      const t0 = Date.now();
      let result, partial = false, warning = null;
      try {
        result = await Promise.race([
          Promise.resolve(packAll(cartons, dims)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SOLVER_TIMEOUT')), SOLVE_TIMEOUT_MS)),
        ]);
      } catch (e) {
        if (e.message === 'SOLVER_TIMEOUT') {
          partial = true;
          warning = `Solver exceeded ${SOLVE_TIMEOUT_MS}ms — partial result returned`;
          result = packAll(cartons, dims);   // run anyway; in practice should still finish
        } else throw e;
      }
      const ms = Date.now() - t0;

      return res.json({
        success:        true,
        data:           result,
        solverVersion:  SOLVER_VERSION,
        containerDims:  dims,
        runtimeMs:      ms,
        partial,
        warning,
      });
    } catch (err) {
      console.error('[container-builder/solve]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /pos — list open Cin7 POs (PR 7)
  // 5-min in-memory cache. Use ?fresh=true to bypass.
  // ─────────────────────────────────────────────────────────────────
  app.get('/api/container-builder/pos', async (req, res) => {
    try {
      const fresh = req.query.fresh === 'true';
      const now   = Date.now();
      const cached = POS_CACHE.get('open');
      if (!fresh && cached && (now - cached.fetchedAt) < POS_CACHE_TTL) {
        return ok(res, { ...cached.data, cache: 'hit' });
      }

      // Cin7 /purchaseList — Page 1, Limit 100. Status filter not supported on
      // /purchaseList directly; we filter client-side on the response.
      const data = await cin7Get('purchaseList?Page=1&Limit=100');
      const list = data.PurchaseList || data.Purchases || data.Items || [];
      const items = list
        .filter(p => {
          const s = (p.Status || '').toUpperCase();
          return s === 'ORDERED' || s === 'AUTHORISED' || s === 'NOT AVAILABLE' || s.includes('ORDER');
        })
        .map(p => ({
          id:          p.ID || p.OrderID,
          orderNumber: p.OrderNumber,
          supplier:    p.Supplier || p.SupplierName,
          orderDate:   p.OrderDate,
          status:      p.Status,
          total:       p.Total,
        }));

      const payload = { items, count: items.length, fetchedAt: new Date(now).toISOString() };
      POS_CACHE.set('open', { fetchedAt: now, data: payload });
      return ok(res, { ...payload, cache: 'miss' });
    } catch (err) {
      console.error('[container-builder/pos]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // GET /pos/:poNum/lines — PO lines as carton list (PR 7)
  // ─────────────────────────────────────────────────────────────────
  app.get('/api/container-builder/pos/:poNum/lines', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const poNum = req.params.poNum;
      if (!poNum) return fail(res, 400, 'poNum is required');

      // First, look up the PO ID via the cached list (or fetch)
      let cached = POS_CACHE.get('open');
      if (!cached) {
        const data = await cin7Get('purchaseList?Page=1&Limit=100');
        const list = data.PurchaseList || data.Purchases || data.Items || [];
        cached = { fetchedAt: Date.now(), data: { items: list.map(p => ({ id: p.ID, orderNumber: p.OrderNumber, supplier: p.Supplier })) } };
        POS_CACHE.set('open', cached);
      }
      const po = cached.data.items.find(p => (p.orderNumber || '').toUpperCase() === poNum.toUpperCase());
      if (!po) return fail(res, 404, `PO ${poNum} not in open list (refresh /pos?fresh=true if needed)`);

      const detail = await cin7Get(`purchase?ID=${encodeURIComponent(po.id)}`);
      const orderLines = detail.Order?.Lines || detail.OrderLines || detail.Lines || [];

      // Look up dims from cin7_mirror.products in one shot
      const skus = [...new Set(orderLines.map(l => l.SKU || l.ProductCode).filter(Boolean))];
      let dimsBySku = {};
      if (skus.length > 0) {
        const { data: prods, error } = await supabaseBackend
          .schema('cin7_mirror')
          .from('products')
          .select('sku, name, carton_length, carton_width, carton_height, carton_quantity, weight')
          .in('sku', skus);
        if (error) throw error;
        for (const p of prods || []) dimsBySku[p.sku] = p;
      }

      // Convert PO line units → cartons (ceiling division)
      const cartons = orderLines.map((l, idx) => {
        const sku  = l.SKU || l.ProductCode || '';
        const qty  = Number(l.Quantity) || 0;
        const dim  = dimsBySku[sku] || {};
        const upc  = Math.max(1, Math.floor(Number(dim.carton_quantity) || 1));
        const qCar = Math.ceil(qty / upc);
        return {
          line_order:       idx,
          sku,
          name:             dim.name || l.Name || '',
          units:            qty,
          units_per_carton: upc,
          qty_cartons:      qCar,
          carton_l_cm:      asCm(dim.carton_length),
          carton_w_cm:      asCm(dim.carton_width),
          carton_h_cm:      asCm(dim.carton_height),
          carton_kg:        Number(dim.weight) || 0,
          plannable:        dim.carton_length > 0 && dim.carton_width > 0 && dim.carton_height > 0,
        };
      });

      return ok(res, {
        po: {
          id:          po.id,
          orderNumber: po.orderNumber,
          supplier:    po.supplier,
        },
        cartons,
        count_lines:       cartons.length,
        count_plannable:   cartons.filter(c => c.plannable).length,
        count_unplannable: cartons.filter(c => !c.plannable).length,
      });
    } catch (err) {
      console.error('[container-builder/pos/lines]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // PLANS — CRUD (PR 8)
  // ─────────────────────────────────────────────────────────────────

  // GET /plans  — list (filter by status, created_by)
  app.get('/api/container-builder/plans', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      let q = supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .select('id, name, created_by, created_at, updated_at, source_type, source_ref, container_type, status, solver_version, notes')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (req.query.status)     q = q.eq('status', req.query.status);
      if (req.query.created_by) q = q.eq('created_by', req.query.created_by);
      const { data, error } = await q;
      if (error) throw error;
      return ok(res, { items: data || [], count: (data || []).length });
    } catch (err) {
      console.error('[container-builder/plans/list]', err);
      return fail(res, 500, err.message);
    }
  });

  // POST /plans  — create
  app.post('/api/container-builder/plans', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const { name, source_type, source_ref, container_type, lines, result_json, notes } = req.body || {};
      if (!name || !name.trim()) return fail(res, 400, 'name is required');
      if (!['po', 'adhoc', 'replenishment'].includes(source_type)) return fail(res, 400, 'invalid source_type');
      if (!CONTAINERS[container_type]) return fail(res, 400, 'invalid container_type');
      if (!Array.isArray(lines)) return fail(res, 400, 'lines must be an array');

      const { data: plan, error: pe } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .insert({
          name:           name.trim(),
          created_by:     user,
          source_type,
          source_ref:     source_ref || null,
          container_type,
          status:         'draft',
          solver_version: SOLVER_VERSION,
          result_json:    result_json || null,
          notes:          notes || null,
        })
        .select('id')
        .single();
      if (pe) throw pe;

      if (lines.length > 0) {
        const lineRows = lines.map((l, idx) => ({
          plan_id:          plan.id,
          sku:              l.sku,
          qty_cartons:      Math.max(0, Math.floor(Number(l.qty_cartons) || 0)),
          carton_l_cm:      Number(l.carton_l_cm) || 0,
          carton_w_cm:      Number(l.carton_w_cm) || 0,
          carton_h_cm:      Number(l.carton_h_cm) || 0,
          carton_kg:        Number(l.carton_kg) || 0,
          units_per_carton: Math.max(1, Math.floor(Number(l.units_per_carton) || 1)),
          line_order:       idx,
        }));
        const { error: le } = await supabaseBackend
          .schema('cin7_mirror')
          .from('container_plan_lines')
          .insert(lineRows);
        if (le) throw le;
      }

      return ok(res, { id: plan.id });
    } catch (err) {
      console.error('[container-builder/plans/create]', err);
      return fail(res, 500, err.message);
    }
  });

  // GET /plans/:id — detail with lines
  app.get('/api/container-builder/plans/:id', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const id = req.params.id;
      const { data: plan, error: pe } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .select('*')
        .eq('id', id)
        .single();
      if (pe) {
        if (pe.code === 'PGRST116') return fail(res, 404, 'Plan not found');
        throw pe;
      }
      const { data: lines, error: le } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plan_lines')
        .select('*')
        .eq('plan_id', id)
        .order('line_order', { ascending: true });
      if (le) throw le;
      return ok(res, { ...plan, lines: lines || [] });
    } catch (err) {
      console.error('[container-builder/plans/get]', err);
      return fail(res, 500, err.message);
    }
  });

  // PUT /plans/:id — update (rejected if confirmed/loaded)
  app.put('/api/container-builder/plans/:id', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const id = req.params.id;

      const { data: existing, error: ge } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .select('status')
        .eq('id', id)
        .single();
      if (ge) {
        if (ge.code === 'PGRST116') return fail(res, 404, 'Plan not found');
        throw ge;
      }
      if (existing.status === 'confirmed' || existing.status === 'loaded' || existing.status === 'archived') {
        return fail(res, 409, `Plan is ${existing.status} — reopen to edit`);
      }

      const { name, container_type, lines, result_json, notes } = req.body || {};
      const patch = {};
      if (name !== undefined)           patch.name = String(name).trim();
      if (container_type !== undefined) {
        if (!CONTAINERS[container_type]) return fail(res, 400, 'invalid container_type');
        patch.container_type = container_type;
      }
      if (result_json !== undefined)    patch.result_json    = result_json;
      if (notes !== undefined)          patch.notes          = notes;
      patch.solver_version = SOLVER_VERSION;

      const { error: ue } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .update(patch)
        .eq('id', id);
      if (ue) throw ue;

      if (Array.isArray(lines)) {
        // Replace all lines (simplest semantics; small N)
        const { error: de } = await supabaseBackend
          .schema('cin7_mirror')
          .from('container_plan_lines')
          .delete()
          .eq('plan_id', id);
        if (de) throw de;

        if (lines.length > 0) {
          const lineRows = lines.map((l, idx) => ({
            plan_id:          id,
            sku:              l.sku,
            qty_cartons:      Math.max(0, Math.floor(Number(l.qty_cartons) || 0)),
            carton_l_cm:      Number(l.carton_l_cm) || 0,
            carton_w_cm:      Number(l.carton_w_cm) || 0,
            carton_h_cm:      Number(l.carton_h_cm) || 0,
            carton_kg:        Number(l.carton_kg) || 0,
            units_per_carton: Math.max(1, Math.floor(Number(l.units_per_carton) || 1)),
            line_order:       idx,
          }));
          const { error: ie } = await supabaseBackend
            .schema('cin7_mirror')
            .from('container_plan_lines')
            .insert(lineRows);
          if (ie) throw ie;
        }
      }

      return ok(res, { id });
    } catch (err) {
      console.error('[container-builder/plans/update]', err);
      return fail(res, 500, err.message);
    }
  });

  // DELETE /plans/:id — archive (status → 'archived'; we don't hard-delete)
  app.delete('/api/container-builder/plans/:id', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const { error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .update({ status: 'archived' })
        .eq('id', req.params.id);
      if (error) throw error;
      return ok(res, { id: req.params.id, status: 'archived' });
    } catch (err) {
      console.error('[container-builder/plans/delete]', err);
      return fail(res, 500, err.message);
    }
  });

  // POST /plans/:id/confirm  — lock for warehouse handoff
  app.post('/api/container-builder/plans/:id/confirm', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const { error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .update({ status: 'confirmed' })
        .eq('id', req.params.id);
      if (error) throw error;
      return ok(res, { status: 'confirmed' });
    } catch (err) {
      console.error('[container-builder/plans/confirm]', err);
      return fail(res, 500, err.message);
    }
  });

  // POST /plans/:id/reopen  — back to draft
  app.post('/api/container-builder/plans/:id/reopen', async (req, res) => {
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const user = requireUser(req, res); if (!user) return;
      const { error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .update({ status: 'draft' })
        .eq('id', req.params.id);
      if (error) throw error;
      return ok(res, { status: 'draft' });
    } catch (err) {
      console.error('[container-builder/plans/reopen]', err);
      return fail(res, 500, err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // POST /plans/:id/export/pdf — render PDF via puppeteer (PR 9)
  // Body: { vizPngBase64?: 'data:image/png;...' }
  // ─────────────────────────────────────────────────────────────────
  app.post('/api/container-builder/plans/:id/export/pdf', async (req, res) => {
    let browser;
    try {
      if (!supabaseBackend) return fail(res, 503, 'Supabase backend not configured');
      const id = req.params.id;
      const { vizPngBase64 } = req.body || {};

      const { data: plan, error: pe } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plans')
        .select('*')
        .eq('id', id)
        .single();
      if (pe) {
        if (pe.code === 'PGRST116') return fail(res, 404, 'Plan not found');
        throw pe;
      }
      const { data: lines, error: le } = await supabaseBackend
        .schema('cin7_mirror')
        .from('container_plan_lines')
        .select('*')
        .eq('plan_id', id)
        .order('line_order', { ascending: true });
      if (le) throw le;

      // Lazy require puppeteer (devDependency — may not be present in slim deploys)
      let puppeteer;
      try { puppeteer = require('puppeteer'); }
      catch { return fail(res, 503, 'puppeteer not installed in this environment'); }

      const tplPath = path.resolve(__dirname, 'pdf-template.html');
      let html = fs.readFileSync(tplPath, 'utf8');

      const dims = CONTAINERS[plan.container_type] || { L: 0, W: 0, H: 0, maxKg: 0 };
      const totalCartons = (lines || []).reduce((s, l) => s + (l.qty_cartons || 0), 0);
      const totalKg      = (lines || []).reduce((s, l) => s + (l.qty_cartons || 0) * (Number(l.carton_kg) || 0), 0);
      const result       = plan.result_json || {};
      const c0           = (result.containers || [])[0] || null;
      const cv           = dims.L * dims.W * dims.H;
      const usedV        = c0 ? c0.items.reduce((s, it) => s + it.l*it.w*it.h, 0) : 0;
      const utilPct      = (cv && c0) ? ((usedV / cv) * 100) : 0;

      const linesHtml = (lines || []).map((l, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(l.sku)}</td>
          <td style="text-align:right">${l.qty_cartons}</td>
          <td style="text-align:right">${(l.carton_l_cm).toFixed(1)}×${(l.carton_w_cm).toFixed(1)}×${(l.carton_h_cm).toFixed(1)}</td>
          <td style="text-align:right">${Number(l.carton_kg).toFixed(2)}</td>
          <td style="text-align:right">${(l.qty_cartons * Number(l.carton_kg)).toFixed(1)}</td>
        </tr>`).join('');

      html = html
        .replace(/{{PLAN_NAME}}/g,      escapeHtml(plan.name || ''))
        .replace(/{{CONTAINER_TYPE}}/g, escapeHtml(plan.container_type || ''))
        .replace(/{{STATUS}}/g,         escapeHtml(plan.status || ''))
        .replace(/{{CREATED_BY}}/g,     escapeHtml(plan.created_by || '—'))
        .replace(/{{CREATED_AT}}/g,     escapeHtml(new Date(plan.created_at).toLocaleString('en-AU')))
        .replace(/{{SOURCE}}/g,         escapeHtml(plan.source_ref ? `${plan.source_type.toUpperCase()} ${plan.source_ref}` : plan.source_type))
        .replace(/{{TOTAL_CARTONS}}/g,  String(totalCartons))
        .replace(/{{TOTAL_KG}}/g,       totalKg.toFixed(0))
        .replace(/{{UTIL_PCT}}/g,       utilPct.toFixed(1))
        .replace(/{{CONTAINER_DIMS}}/g, `${(dims.L/100).toFixed(2)} × ${(dims.W/100).toFixed(2)} × ${(dims.H/100).toFixed(2)} m`)
        .replace(/{{VIZ_IMG}}/g,        vizPngBase64 ? `<img src="${vizPngBase64}" alt="3D view" />` : '<div class="placeholder">No 3D snapshot provided</div>')
        .replace(/{{LINES}}/g,          linesHtml)
        .replace(/{{NOTES}}/g,          escapeHtml(plan.notes || ''))
        .replace(/{{GENERATED_AT}}/g,   new Date().toLocaleString('en-AU'));

      browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } });
      await browser.close();
      browser = null;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="container-plan-${id}.pdf"`);
      return res.end(pdf);
    } catch (err) {
      if (browser) try { await browser.close(); } catch {}
      console.error('[container-builder/plans/export/pdf]', err);
      return fail(res, 500, err.message);
    }
  });

  console.log('✅ Container Builder routes registered (audit, products, solve, pos, plans, pdf — all live)');
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
