// Secure & optimized Express server for Rapid Label (no layout changes)
require('dotenv').config(); // Load environment variables first
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8383;
const PRINTER_HOST = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100', 10);

// Supabase setup for backend endpoints
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
let supabaseBackend = null;

if (SUPABASE_SERVICE_KEY) {
  supabaseBackend = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('✅ Supabase backend client initialized');
} else {
  console.warn('⚠️  SUPABASE_SERVICE_KEY not set - audit endpoints will not work');
}

// Basic security headers (CSP kept permissive for current external CDNs)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net", "'unsafe-inline'", "'unsafe-eval'"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      "style-src-elem": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'blob:', 'https://iaqnxamnjftwqdbsnfyl.supabase.co'],
      "connect-src": ["'self'", "https://iaqnxamnjftwqdbsnfyl.supabase.co", "wss://iaqnxamnjftwqdbsnfyl.supabase.co", "https://psczzrhmolxifgzgzswh.supabase.co", "wss://psczzrhmolxifgzgzswh.supabase.co", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com", "http://127.0.0.1:5050", "http://localhost:5050"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": []
    }
  }
}));

// Compression for static assets
app.use(compression());

// Rate limit (protect from abuse – generous for internal use)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 800 });
app.use(limiter);

// CORS - Allow all origins for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// JSON body parsing (2MB for stocktake MAP uploads)
app.use(express.json({ limit: '8mb' })); // 8mb: scanner-report grand-dump imports can be large

// Static caching headers — short cache for JS/CSS (feature files change frequently)
app.use((req, res, next) => {
  if (/\.(js|css)$/i.test(req.url)) {
    res.setHeader('Cache-Control', 'no-cache'); // always revalidate JS/CSS
  } else if (/\.(svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(req.url)) {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days for images/fonts
  } else if (req.url === '/' || /\.html$/i.test(req.url)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Scanner activity (Cin7 InventoryWarehouseDetails ingest) — SO → operator map ──
// Same-origin (staff tool, same trust as the rest of the app). The data file is
// gitignored (employee names). Returns an empty map until a report is ingested via
// cin7-stock-sync/ingest-scanner-report.js. Used to tag pick anomalies scanner vs manual.
app.get('/api/scanner-activity', async (req, res) => {
  try {
    if (supabaseBackend) {                 // durable store (service_role bypasses RLS)
      try {
        let rows = [], from = 0;
        for (;;) {
          const { data, error } = await supabaseBackend.from('scanner_activity')
            .select('order_number,op,scan_date,skus,minutes').range(from, from + 999);
          if (error) throw error;
          rows.push(...(data || []));
          if (!data || data.length < 1000) break;
          from += 1000;
        }
        const scanned = {}, days = new Set();
        for (const r of rows) {
          scanned[r.order_number] = { op: r.op, date: r.scan_date, skus: Number(r.skus) || 0, min: Number(r.minutes) || 0 };
          if (r.scan_date) days.add(r.scan_date);
        }
        return res.json({ count: rows.length, days: [...days].sort(), scanned });
      } catch (_) { /* table not migrated yet / transient — degrade to file/empty below */ }
    }
    // dev fallback: local gitignored file when no service key is configured
    const fs = require('fs');
    const p = path.join(__dirname, 'data', 'scanner_activity.json');
    if (!fs.existsSync(p)) return res.json({ count: 0, days: [], scanned: {} });
    res.type('application/json').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import a parsed scanner report ({ scanned:{SO:{op,date}}, days:[] }) — merges by SO.
// The xlsx/csv is parsed client-side; this just persists the map (gitignored file).
app.post('/api/scanner-activity/import', async (req, res) => {
  try {
    const incoming = req.body && req.body.scanned;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'no "scanned" map in body' });
    if (supabaseBackend) {                 // durable store: upsert by SO (no double-count on re-import)
      const now = new Date().toISOString();
      const rows = Object.entries(incoming).filter(([so]) => so).map(([so, v]) => ({
        order_number: so, op: v.op || null, scan_date: v.date || null,
        skus: Number(v.skus) || 0, minutes: Number(v.min) || 0, updated_at: now,
      }));
      let imported = 0;
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabaseBackend.from('scanner_activity').upsert(rows.slice(i, i + 500), { onConflict: 'order_number' });
        if (error) throw new Error(error.message || 'scanner_activity write failed — is the migration applied?');
        imported += Math.min(500, rows.length - i);
      }
      const { count } = await supabaseBackend.from('scanner_activity').select('*', { count: 'exact', head: true });
      return res.json({ success: true, imported, total: count ?? imported });
    }
    // dev fallback: local gitignored file when no service key is configured
    const fs = require('fs');
    const dir = path.join(__dirname, 'data'), p = path.join(dir, 'scanner_activity.json');
    fs.mkdirSync(dir, { recursive: true });
    let cur = { scanned: {}, days: [] };
    if (fs.existsSync(p)) { try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} }
    cur.scanned = cur.scanned || {};
    let imported = 0;
    for (const [so, v] of Object.entries(incoming)) { if (so) { cur.scanned[so] = v; imported++; } }
    const days = new Set(cur.days || []);
    (req.body.days || []).forEach(d => days.add(d));
    cur.days = [...days].sort();
    cur.count = Object.keys(cur.scanned).length;
    cur.generated_at = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(p, JSON.stringify(cur));
    res.json({ success: true, imported, total: cur.count, days: cur.days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cin7 customers (Returns autocomplete) — cached {id, name, code, email, rep} ──
// Pulled from Cin7 /customer (~9.8k), cached in memory for 1h. Same-origin.
const _cin7H = () => ({ 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' });
let _custCache = { at: 0, list: [] };
async function getCustomers() {
  if (_custCache.list.length && Date.now() - _custCache.at < 3600000) return _custCache.list;
  if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) throw new Error('Cin7 not configured');
  const H = _cin7H(), list = [];
  for (let page = 1; page <= 15; page++) {
    const r = await fetch(`https://inventory.dearsystems.com/ExternalApi/v2/customer?Page=${page}&Limit=1000`, { headers: H });
    if (!r.ok) break;
    const rows = (await r.json()).CustomerList || [];
    for (const c of rows) {
      const contacts = Array.isArray(c.Contacts) ? c.Contacts : [];
      const primary = contacts.find(ct => ct.Default) || contacts.find(ct => ct.Email) || contacts[0];
      list.push({
        id: c.ID, name: (c.Name || '').trim(), code: c.AdditionalAttribute1 || '',
        email: (primary && primary.Email) || '', rep: c.SalesRepresentative || '',
        contact: (primary && primary.Name) || '',   // primary contact person
      });
    }
    if (rows.length < 1000) break;
  }
  if (list.length) _custCache = { at: Date.now(), list };
  return list;
}
app.get('/api/customers', async (req, res) => {
  try { const list = await getCustomers(); res.json({ count: list.length, customers: list, cached: _custCache.at > 0 }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cin7 sale lookup (Returns: scan a sales order to pre-fill lines) ──
// GET /api/sale?q=SO-00123 → { found, order_number, sale_id, customer_name,
//   customer_code, customer_email, rep, customer_reference, lines:[{sku,name,qty,price}] }
app.get('/api/sale', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });
    if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) return res.status(500).json({ error: 'Cin7 not configured' });
    const H = _cin7H();
    // 1) find the sale by order number (exact match preferred)
    const sl = await fetch(`https://inventory.dearsystems.com/ExternalApi/v2/saleList?Page=1&Limit=20&Search=${encodeURIComponent(q)}`, { headers: H });
    if (!sl.ok) return res.status(502).json({ error: 'Cin7 saleList ' + sl.status });
    const rows = (await sl.json()).SaleList || [];
    const norm = s => String(s || '').trim().toLowerCase();
    const hit = rows.find(r => norm(r.OrderNumber) === norm(q)) || rows.find(r => norm(r.InvoiceNumber) === norm(q)) || rows.find(r => norm(r.OrderNumber).includes(norm(q))) || rows[0];
    if (!hit) return res.json({ found: false });
    // 2) full sale for the order lines + customer detail
    const s = await fetch(`https://inventory.dearsystems.com/ExternalApi/v2/sale?ID=${encodeURIComponent(hit.SaleID)}`, { headers: H });
    if (!s.ok) return res.status(502).json({ error: 'Cin7 sale ' + s.status });
    const sale = await s.json();
    const lines = ((sale.Order && sale.Order.Lines) || []).map(l => ({
      sku: l.SKU || '', name: l.Name || '', qty: Number(l.Quantity) || 0, price: l.Price != null ? Number(l.Price) : null,
    })).filter(l => l.sku);
    // map Cin7 customer UUID → our C#### code (best-effort via cache)
    let code = '';
    try { const cust = (await getCustomers()).find(c => c.id === sale.CustomerID); if (cust) code = cust.code; } catch (_) {}
    res.json({
      found: true,
      order_number: hit.OrderNumber || q,
      sale_id: hit.SaleID,
      customer_name: sale.Customer || hit.Customer || '',
      customer_code: code,
      contact_name: sale.Contact || '',
      customer_email: sale.Email || '',
      rep: sale.SalesRepresentative || '',
      invoice_number: hit.InvoiceNumber || ((sale.Invoices || [])[0] || {}).InvoiceNumber || '',
      customer_reference: sale.CustomerReference || hit.CustomerReference || '',
      lines,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cin7 Webhook & Stock Audit routes ──
try {
  const registerWebhookRoutes = require('./cin7-stock-sync/webhook-receiver');
  registerWebhookRoutes(app, supabaseBackend);
  console.log('✅ Cin7 webhook/audit routes registered');
} catch (e) {
  console.warn('⚠️  Could not register webhook routes:', e.message);
}

// ── Pick Anomalies routes ──
try {
  const { registerPickAnomalyRoutes } = require('./features/pick-anomalies/pick-anomalies-engine');
  registerPickAnomalyRoutes(app);
} catch (e) {
  console.warn('⚠️  Could not register pick anomaly routes:', e.message);
}

// ── Order Pipeline Sync (on-demand + scheduled) ──
let pipelineSyncRunning = false;
async function _runPipelineSync(source = 'manual') {
  if (pipelineSyncRunning) return { skipped: true, reason: 'already running' };
  pipelineSyncRunning = true;
  try {
    const { runPipelineSync } = require('./order-pipeline-sync');
    const result = await runPipelineSync();
    console.log(`✅ Pipeline sync (${source}) done: ${result.salesOrders} SO, ${result.transfers} TR in ${result.durationSec}s`);
    return result;
  } catch (err) {
    console.error(`❌ Pipeline sync (${source}) error:`, err.message);
    throw err;
  } finally {
    pipelineSyncRunning = false;
  }
}

app.post('/api/pipeline-sync', async (req, res) => {
  try {
    const result = await _runPipelineSync('api');
    if (result.skipped) return res.json({ success: false, error: result.reason });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Auto-sync pipeline every hour (backup for GH Actions cron)
const PIPELINE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
setTimeout(() => {
  _runPipelineSync('scheduled-initial').catch(() => {});
  setInterval(() => {
    _runPipelineSync('scheduled').catch(() => {});
  }, PIPELINE_INTERVAL_MS);
}, 30_000); // Wait 30s after server start before first sync

// ── Gateway Transfer routes ──
try {
  const { registerGatewayRoutes } = require('./features/gateway/gateway-engine');
  registerGatewayRoutes(app);
} catch (e) {
  console.warn('⚠️  Could not register gateway routes:', e.message);
}

// ── MW Stocktake Audit routes ──
try {
  const { registerStocktakeRoutes } = require('./features/gateway/stocktake-engine');
  registerStocktakeRoutes(app);
} catch (e) {
  console.warn('⚠️  Could not register stocktake routes:', e.message);
}

// ── Container Builder routes ──
try {
  require('./features/container-builder/container-builder-engine')(app, supabaseBackend);
} catch (e) {
  console.warn('⚠️  Could not register Container Builder routes:', e.message);
}

// ── Container Check routes (QC de recebimento / inbound) ──
try {
  require('./features/container-check/container-check-engine')(app, supabaseBackend);
} catch (e) {
  console.warn('⚠️  Could not register Container Check routes:', e.message);
}

// ── Replenishment: Pending TR Lines (fetches line details from Cin7 API) ──
(function registerPendingTRRoutes() {
  const https = require('https');
  const CIN7_ACCOUNT_ID = process.env.CIN7_ACCOUNT_ID || '';
  const CIN7_API_KEY    = process.env.CIN7_API_KEY || '';

  // Map branch codes to Cin7 location names (lowercase for matching)
  const BRANCH_LOCATION_MAP = {
    SYD: ['sydney', 'sydney warehouse'],
    MEL: ['melbourne', 'melbourne warehouse'],
    BNE: ['brisbane', 'brisbane warehouse'],
    CNS: ['cairns', 'cairns warehouse'],
    CFS: ['coffs harbour', 'coffs harbour warehouse'],
    HBA: ['hobart', 'hobart warehouse'],
    SCS: ['sunshine coast', 'sunshine coast warehouse'],
  };

  // In-memory cache of pending-TR results, keyed by branch code.
  // Cin7 only exposes transfer LINE detail via a throttled live API call
  // (3.5s between TRs), so a cold page load is slow — and the branch page used
  // to abort after 4s and silently proceed with NO in-transit data, which made
  // it recommend re-sending stock already on the way (double-send). Caching the
  // result makes repeat loads — and the overview / all-branches pages that fan
  // out across all 7 branches — instant and reliable. ?fresh=1 forces a refetch
  // (the branch "Refresh" button uses it). TTL is well under the 1h sync cadence.
  const PENDING_TR_CACHE = new Map(); // code -> { ts, payload }
  const PENDING_TR_TTL_MS = 5 * 60 * 1000; // 5 min

  function cin7GetTR(taskId) {
    return new Promise((resolve, reject) => {
      const qs = `TaskID=${encodeURIComponent(taskId)}`;
      const opts = {
        hostname: 'inventory.dearsystems.com',
        path: `/ExternalApi/v2/stockTransfer?${qs}`,
        headers: {
          'api-auth-accountid': CIN7_ACCOUNT_ID,
          'api-auth-applicationkey': CIN7_API_KEY,
        },
        timeout: 30000,
      };
      const req = https.get(opts, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Bad JSON from Cin7')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  // GET /api/replenishment/pending-transfers/:branchCode
  app.get('/api/replenishment/pending-transfers/:branchCode', async (req, res) => {
    try {
      const branchCode = (req.params.branchCode || '').toUpperCase();
      const branchNames = BRANCH_LOCATION_MAP[branchCode];
      if (!branchNames) return res.status(400).json({ error: 'Invalid branch code' });
      if (!supabaseBackend) return res.status(500).json({ error: 'Supabase not configured' });

      // Serve from cache when fresh (unless ?fresh=1 forces a refetch).
      const force = req.query.fresh === '1';
      const cachedEntry = PENDING_TR_CACHE.get(branchCode);
      if (!force && cachedEntry && (Date.now() - cachedEntry.ts) < PENDING_TR_TTL_MS) {
        return res.json(Object.assign({}, cachedEntry.payload, {
          cached: true, cached_age_ms: Date.now() - cachedEntry.ts
        }));
      }

      // 1) Find active TRs from Main → this branch
      const { data: trs, error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('order_pipeline')
        .select('id, number, status, to_location, from_location')
        .eq('type', 'TR')
        .in('status', ['ORDERED', 'IN TRANSIT']);

      if (error) throw error;

      // Filter: from = Main Warehouse, to = this branch
      const mainNames = ['main warehouse', 'gateway', 'gateway warehouse'];
      const branchTRs = (trs || []).filter(tr => {
        const from = (tr.from_location || '').toLowerCase().trim();
        const to   = (tr.to_location || '').toLowerCase().trim();
        return mainNames.includes(from) && branchNames.includes(to);
      });

      if (branchTRs.length === 0) {
        const emptyPayload = { transfers: [], products: {} };
        PENDING_TR_CACHE.set(branchCode, { ts: Date.now(), payload: emptyPayload });
        return res.json(emptyPayload);
      }

      // 2) For each TR, fetch line items from Cin7 API (with 3.5s throttle)
      const transfers = [];
      const productMap = {}; // { sku: { pending_qty, transfers: ['TR-XXXXX = QTY'] } }

      for (const tr of branchTRs) {
        try {
          const detail = await cin7GetTR(tr.id);
          const lines = detail?.Lines || detail?.Line || [];
          const trInfo = { number: tr.number, status: tr.status, lines: [] };

          for (const line of lines) {
            const sku = line.SKU || line.ProductCode || '';
            const qty = line.TransferQuantity || line.Quantity || 0;
            if (!sku || qty <= 0) continue;

            trInfo.lines.push({ sku, qty, name: line.ProductName || line.Name || '' });

            if (!productMap[sku]) productMap[sku] = { pending_qty: 0, transfers: [] };
            productMap[sku].pending_qty += qty;
            productMap[sku].transfers.push(`${tr.number} = ${qty}`);
          }

          transfers.push(trInfo);
          // Throttle between API calls
          if (branchTRs.indexOf(tr) < branchTRs.length - 1) {
            await new Promise(r => setTimeout(r, 3500));
          }
        } catch (err) {
          console.error(`Failed to fetch TR ${tr.number} (${tr.id}):`, err.message);
          transfers.push({ number: tr.number, status: tr.status, lines: [], error: err.message });
        }
      }

      const payload = { transfers, products: productMap };
      PENDING_TR_CACHE.set(branchCode, { ts: Date.now(), payload });
      res.json(payload);
    } catch (err) {
      console.error('Pending TR error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('✅ Pending TR lines endpoint registered');
})();

// ── Order detail: live Cin7 fetch for the pipeline modal expansion ──
//    GET /api/sale/:number → normalized { header, lines } straight from Cin7,
//    so active orders (whose lines aren't mirrored yet) can show their items.
(function registerSaleDetailRoute() {
  const https = require('https');
  const ACC = process.env.CIN7_ACCOUNT_ID || '';
  const CK  = process.env.CIN7_API_KEY || '';
  const num = v => (v == null || v === '') ? null : Number(v);

  function cin7Req(apiPath) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: 'inventory.dearsystems.com',
        path: `/ExternalApi/v2/${apiPath}`,
        headers: { 'api-auth-accountid': ACC, 'api-auth-applicationkey': CK, 'Accept': 'application/json' },
        timeout: 30000,
      };
      const r = https.get(opts, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`Cin7 HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from Cin7')); }
        });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
    });
  }

  // In-memory cache (TTL) so reopening an order is instant and avoids repeat Cin7 calls
  const _cache = new Map(); // key -> { data, exp }
  const TTL_MS = 10 * 60 * 1000;
  function cacheGet(k) { const v = _cache.get(k); if (v && v.exp > Date.now()) return v.data; if (v) _cache.delete(k); return null; }
  function cacheSet(k, data) {
    _cache.set(k, { data, exp: Date.now() + TTL_MS });
    if (_cache.size > 500) { const first = _cache.keys().next().value; _cache.delete(first); }
  }

  // Fetch a sale detail. Prefers the known SaleID (= order_pipeline.id) → ONE call.
  async function cin7GetSale(orderNumber, saleId) {
    if (saleId) {
      try { const d = await cin7Req(`sale?ID=${encodeURIComponent(saleId)}`); if (d && d.ID) return d; } catch (e) {}
    }
    // Fallback: search by number → SaleID → detail (two calls)
    const orig  = String(orderNumber || '').trim().toUpperCase();
    const clean = orig.replace(/^SO-/, '');
    const list = await cin7Req(`saleList?Search=${encodeURIComponent(clean)}&Page=1&Limit=10`);
    const sales = list.SaleList || [];
    if (!sales.length) return null;
    let sid = sales[0].SaleID;
    for (const s of sales) {
      const on = String(s.OrderNumber || '').toUpperCase();
      if (on === orig || on === clean) { sid = s.SaleID; break; }
    }
    if (!sid) return null;
    return await cin7Req(`sale?ID=${encodeURIComponent(sid)}`);
  }

  function normalizeSale(det) {
    const order = det.Order || {};
    const addr = det.ShippingAddress || {};
    const lines = (order.Lines || det.Lines || []).map((ln, i) => ({
      line_no: i, sku: ln.SKU || '', product_name: ln.Name || '',
      quantity: num(ln.Quantity), price: num(ln.Price), total: num(ln.Total),
      backorder_quantity: num(ln.BackorderQuantity),
    })).filter(l => l.sku);
    return {
      success: true, source: 'cin7-live',
      header: {
        order_number: det.OrderNumber || null, customer: det.Customer || null,
        sales_rep: det.SalesRepresentative || null, contact: det.Contact || null, phone: det.Phone || null,
        location: det.Location || null,
        pick_status: det.CombinedPickingStatus || null, pack_status: det.CombinedPackingStatus || null,
        ship_status: det.CombinedShippingStatus || null, invoice_status: det.CombinedInvoiceStatus || null,
        carrier: det.Carrier || null, order_total: num(order.Total), order_tax: num(order.Tax),
        ship_to: [addr.City, addr.State, addr.Postcode].filter(Boolean).join(', ') || null,
      },
      lines,
    };
  }

  app.get('/api/sale/:number', async (req, res) => {
    try {
      if (!ACC || !CK) return res.status(500).json({ success: false, error: 'Cin7 not configured' });
      const saleId = (req.query.id || '').trim() || null;
      const key = 'sale:' + (saleId || req.params.number);
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, source: 'cache' });
      const det = await cin7GetSale(req.params.number, saleId);
      if (!det || !det.ID) return res.status(404).json({ success: false, error: 'Order not found' });
      const out = normalizeSale(det);
      cacheSet(key, out);
      res.json(out);
    } catch (err) {
      console.error('Sale detail error:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // Transfer (TR) detail — stockTransfer?TaskID=<order_pipeline.id>
  app.get('/api/transfer/:id', async (req, res) => {
    try {
      if (!ACC || !CK) return res.status(500).json({ success: false, error: 'Cin7 not configured' });
      const id = req.params.id;
      const key = 'tr:' + id;
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, source: 'cache' });
      const det = await cin7Req(`stockTransfer?TaskID=${encodeURIComponent(id)}`);
      const rawLines = det.Lines || det.Line || [];
      const lines = rawLines.map((ln, i) => ({
        line_no: i, sku: ln.SKU || ln.ProductCode || '', product_name: ln.ProductName || ln.Name || '',
        quantity: num(ln.TransferQuantity != null ? ln.TransferQuantity : ln.Quantity),
        backorder_quantity: null, total: null,
      })).filter(l => l.sku);
      const out = {
        success: true, source: 'cin7-live',
        header: {
          order_number: det.TaskID || id, location: det.FromLocation || null,
          ship_to: null, ship_status: det.Status || null, // from→to already shown from pipeline row
        },
        lines,
      };
      cacheSet(key, out);
      res.json(out);
    } catch (err) {
      console.error('Transfer detail error:', err.message);
      res.status(502).json({ success: false, error: err.message });
    }
  });

  console.log('✅ Sale/Transfer detail endpoints registered (/api/sale/:number, /api/transfer/:id)');
})();

// Only listen on port when running locally (not on Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Rapid Label server running at http://localhost:${PORT}`);
  });
}

// ZPL print endpoint: POST /api/print-zpl { zpl: string, host?: string, port?: number }
app.post('/api/print-zpl', async (req, res) => {
  try {
    const { zpl, host, port } = req.body || {};
    if (!zpl || typeof zpl !== 'string' || !zpl.includes('^XA') || !zpl.includes('^XZ')) {
      return res.status(400).json({ success: false, error: 'Invalid ZPL payload (must include ^XA/^XZ)' });
    }
    const targetHost = host || PRINTER_HOST;
    const targetPort = Number.isFinite(port) ? port : PRINTER_PORT;

    const socket = new net.Socket();
    socket.setTimeout(7000);

    await new Promise((resolve, reject) => {
      socket.connect(targetPort, targetHost, () => {
        try {
          socket.write(zpl, 'utf8', () => {
            // Give printer a moment then end
            setTimeout(() => { try { socket.end(); } catch (e) {} }, 50);
          });
        } catch (e) {
          reject(e);
        }
      });
      socket.on('timeout', () => reject(new Error('Printer connection timeout')));
      socket.on('error', (err) => reject(err));
      socket.on('close', () => resolve());
    });

    return res.json({ success: true, host: targetHost, port: targetPort });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================
// CYCLIC COUNT AUDIT ENDPOINTS
// ============================================

/**
 * Trigger a new weekly audit run
 * POST /api/audit/run-weekly
 * Body: { periodStart?: 'YYYY-MM-DD', periodEnd?: 'YYYY-MM-DD' }
 */
app.post('/api/audit/run-weekly', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured. Set SUPABASE_SERVICE_KEY env var.' 
      });
    }

    // Import sync functions (dynamic to avoid requiring at startup)
    const {
      runWeeklyStockAudit,
      generateStockAnalysisForRun
    } = require('./cin7-sync-service');

    // Calculate week dates if not provided
    let { periodStart, periodEnd } = req.body || {};
    
    if (!periodStart || !periodEnd) {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      
      periodStart = monday.toISOString().split('T')[0];
      periodEnd = sunday.toISOString().split('T')[0];
    }

    console.log(`🔄 Running audit for ${periodStart} to ${periodEnd}...`);

    // Run audit
    const run = await runWeeklyStockAudit(periodStart, periodEnd, supabaseBackend);
    
    // Generate analysis
    const analysisResult = await generateStockAnalysisForRun(run.id, supabaseBackend);

    return res.json({ 
      success: true, 
      run_id: run.id,
      period_start: periodStart,
      period_end: periodEnd,
      analysis_records: analysisResult.generated
    });

  } catch (error) {
    console.error('❌ Error running audit:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get latest audit run info
 * GET /api/audit/latest
 */
app.get('/api/audit/latest', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { data: latestRun, error } = await supabaseBackend
      .from('audit_runs')
      .select('*')
      .order('period_end_date', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.json({ success: true, run: null });
      }
      throw error;
    }

    return res.json({ success: true, run: latestRun });

  } catch (error) {
    console.error('❌ Error getting latest audit:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get audit statistics
 * GET /api/audit/stats/:runId
 */
app.get('/api/audit/stats/:runId', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { runId } = req.params;

    const { data: analysis, error } = await supabaseBackend
      .from('audit_stock_analysis')
      .select('anomaly_level')
      .eq('run_id', runId);

    if (error) throw error;

    const stats = {
      total: analysis.length,
      ok: analysis.filter(a => a.anomaly_level === 'ok').length,
      warning: analysis.filter(a => a.anomaly_level === 'warning').length,
      critical: analysis.filter(a => a.anomaly_level === 'critical').length
    };

    return res.json({ success: true, stats });

  } catch (error) {
    console.error('❌ Error getting audit stats:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * NEW: Cyclic Count Sync endpoint
 * POST /api/cyclic-sync
 */
app.post('/api/cyclic-sync', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    console.log('🔄 Cyclic Count sync triggered...');

    // Import sync utilities
    const { performFullSync } = require('./sync-utils');
    
    // Perform manual sync
    const result = await performFullSync(supabaseBackend, false);
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get Cyclic Count Sync Status
 * GET /api/cyclic-sync-status
 */
app.get('/api/cyclic-sync-status', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { getSyncStatus } = require('./sync-utils');
    const status = await getSyncStatus(supabaseBackend);
    
    res.json({
      success: true,
      status
    });
    
  } catch (error) {
    console.error('❌ Error getting sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Manual sync endpoint - syncs only products in audit_products list
 * Limited to 3 requests per day per client (enforced client-side via localStorage)
 * POST /api/sync-audit-data
 */
app.post('/api/sync-audit-data', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    console.log('🔄 Manual sync triggered for audit products...');

    // Get list of products in audit_products
    const { data: auditProducts, error: prodError } = await supabaseBackend
      .from('audit_products')
      .select('sku, dear_product_id')
      .eq('is_active', true);

    if (prodError) throw prodError;

    const skuList = auditProducts.map(p => p.sku);
    console.log(`📦 Syncing ${skuList.length} products from audit list`);

    // Calculate week dates for sales orders
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    
    const periodStart = weekAgo.toISOString().split('T')[0];
    const periodEnd = today.toISOString().split('T')[0];

    // Run audit with filtered products
    const {
      runWeeklyStockAudit,
      generateStockAnalysisForRun
    } = require('./cin7-sync-service');

    const run = await runWeeklyStockAudit(periodStart, periodEnd, supabaseBackend);
    await generateStockAnalysisForRun(run.id, supabaseBackend);

    console.log(`✅ Sync completed - Run ID: ${run.id}`);

    return res.json({
      success: true,
      productsCount: auditProducts.length,
      runId: run.id,
      periodStart,
      periodEnd
    });

  } catch (error) {
    console.error('❌ Sync error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Fetch single product from DEAR API by SKU
 * POST /api/fetch-product
 * Body: { sku: string }
 */
app.post('/api/fetch-product', async (req, res) => {
  try {
    const { sku } = req.body;
    
    if (!sku) {
      return res.status(400).json({ success: false, error: 'SKU required' });
    }

    // Use DEAR API to fetch product
    const { callCin7Api } = require('./cin7-sync-service');
    
    const productData = await callCin7Api(`/product?sku=${encodeURIComponent(sku)}`);
    
    if (!productData || productData.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found in DEAR' });
    }

    const product = Array.isArray(productData) ? productData[0] : productData;

    return res.json({
      success: true,
      id: product.ID,
      sku: product.SKU,
      name: product.Name,
      category: product.Category
    });

  } catch (error) {
    console.error('❌ Error fetching product:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Export for Vercel serverless
module.exports = app;
