/**
 * Pick Anomalies — Backend Engine (v3 — Ship-Only Capture)
 * 
 * Architecture:
 *   - All analysis results are saved to Supabase (pick_anomaly_orders table)
 *   - Auto-sync: on page load, backend fetches new orders since last sync date
 *   - Frontend loads history from Supabase via /api/pick-anomalies/history
 *   - Corrections (Stock Transfers) are tracked in pick_anomaly_corrections
 *   - No manual date picker needed — system auto-continues from last sync
 *
 * SHIP-ONLY CAPTURE:
 *   - Only orders with CombinedShippingStatus=SHIPPED are captured
 *   - This is the moment Cin7 deducts stock from bins — the correct time to compare picks
 *   - Orders at other stages (NOT SHIPPED, PARTIALLY SHIPPED, INVOICED-only) are ignored
 *   - Once an order is captured at SHIP, it is NEVER re-analyzed or overwritten
 *
 * IMMUTABLE analyzed_at:
 *   - Sync uses INSERT with ignore-duplicates (sbInsertIfNew)
 *   - If order_number already exists in Supabase, the row is completely untouched
 *   - This prevents analyzed_at from changing when orders are invoiced days later
 *   - Dedup check is MANDATORY — sync aborts if Supabase dedup query fails
 *
 * DATE HANDLING (UpdatedSince → ShipmentDate gate):
 *   - Cin7 saleList `UpdatedSince` filters by LastModifiedOn (NOT OrderDate)
 *   - Rolling 7-day lookback ensures we catch late-shipped orders
 *   - Rolling 30-day FLOOR_DATE on OrderDate is a SOFT pre-filter (avoids fetching very old orders)
 *   - SCANNER_CUTOFF_DATE (2026-03-26): hard floor — no orders before scanner implementation
 *   - HARD GATE on fulfilled_date (ShipmentDate): after fetching sale detail, orders with
 *     ShipmentDate before cutoff or > 45 days old are REJECTED before analysis
 *   - This 2-layer approach ensures:
 *     a) saleList pre-filter is generous (30 days) so late-shipped orders aren't missed
 *     b) fulfilled_date hard gate is strict — only the actual ship date matters
 *   - existingNumbers dedup + ignore-duplicates = double protection against re-analysis
 *
 * OPTIMIZATIONS:
 *   - Rate-limited: 2.5s between Cin7 calls (~24/min, safe margin)
 *   - Supabase stock_locator fetched in batch
 *   - Cap of 200 orders per sync run
 *   - 2-layer date filtering: soft (OrderDate 30d) + hard (ShipmentDate gate)
 */

const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ─── Cin7 Config (set via .env or environment variables) ───
const CIN7 = {
  baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
  accountId: process.env.CIN7_ACCOUNT_ID || '',
  apiKey:    process.env.CIN7_API_KEY     || '',
};

// ─── Supabase Config ───
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// Use service key (GitHub Actions) with fallback to anon key (local dev)
const SUPABASE_ANON = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

const RATE_DELAY = 2500;   // 2.5s between Cin7 calls — safe margin, matches sync-service
const MAX_ORDERS_PER_RUN = 200;
const MW_LOCATION_ID = '907821e3-c06b-4bf1-a8af-888bc3a2031f';

// ─── Scanner Cutoff Date ───
// The barcode scanner was implemented on 2026-03-26.
// Orders before this date had no bin-level tracking, so pick anomaly
// analysis is meaningless for them. This is a hard floor that overrides
// the rolling FLOOR_DATE window.
const SCANNER_CUTOFF_DATE = '2026-03-26';

// ─── In-memory caches ───
let binCache = null;
let binCacheTime = 0;
const BIN_CACHE_TTL = 3600000;
let syncInProgress = false;

// ─── Helpers ───
const delay = (ms) => new Promise(r => setTimeout(r, ms));
let apiCallCount = 0;

async function cin7Get(endpoint) {
  apiCallCount++;
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    timeout: 20000,
  });
  if (res.status === 429) {
    console.warn('⚠️ Cin7 rate limit hit, waiting 25s...');
    await delay(25000);
    return cin7Get(endpoint);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status}: ${res.statusText} (${endpoint})`);
  return res.json();
}

async function cin7Post(endpoint, body) {
  apiCallCount++;
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    body: JSON.stringify(body),
    timeout: 20000,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Cin7 POST ${res.status}: ${txt} (${endpoint})`);
  }
  return res.json();
}

async function cin7Put(endpoint, body) {
  apiCallCount++;
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    body: JSON.stringify(body),
    timeout: 20000,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Cin7 PUT ${res.status}: ${txt} (${endpoint})`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════
// SUPABASE HELPERS
// ═══════════════════════════════════════════════════

const SB_HEADERS = {
  'apikey': SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

async function sbGet(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, { headers: { ...SB_HEADERS, 'Prefer': '' } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${table}: ${res.status} ${txt}`);
  }
  return res.json();
}

/**
 * Paginated Supabase GET — fetches ALL rows even when > 1000.
 * Supabase REST API defaults to max 1000 rows per request.
 * This function paginates with Range headers to get everything.
 */
async function sbGetAll(table, query = '') {
  const PAGE_SIZE = 1000;
  let allRows = [];
  let offset = 0;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
    const res = await fetch(url, {
      headers: {
        ...SB_HEADERS,
        'Prefer': 'count=exact',
        'Range': `${offset}-${offset + PAGE_SIZE - 1}`,
      },
    });
    if (res.status === 416) break; // Range Not Satisfiable = no more rows
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Supabase GET ${table}: ${res.status} ${txt}`);
    }
    const rows = await res.json();
    if (!rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < PAGE_SIZE) break; // Last page
    offset += PAGE_SIZE;
  }

  return allRows;
}

async function sbPost(table, body, conflictColumn) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (conflictColumn) url += `?on_conflict=${conflictColumn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase POST ${table}: ${res.status} ${txt}`);
  }
  return res.json();
}

/**
 * INSERT-only: inserts a new row but does NOTHING if the row already exists
 * (based on conflictColumn). Unlike sbPost, this will NEVER overwrite
 * existing data — especially analyzed_at, picks, etc.
 * Used exclusively by auto-sync to ensure orders are recorded only once.
 */
async function sbInsertIfNew(table, body, conflictColumn) {
  let url = `${SUPABASE_URL}/rest/v1/${table}`;
  if (conflictColumn) url += `?on_conflict=${conflictColumn}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase INSERT ${table}: ${res.status} ${txt}`);
  }
}

async function sbPatch(table, query, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${table}: ${res.status} ${txt}`);
  }
}

/**
 * Fetch stock_locator for a batch of SKUs from Supabase cin7_mirror.products
 */
async function fetchLocators(skus) {
  if (!skus.length) return new Map();
  const batchSize = 80;
  const result = new Map();
  for (let i = 0; i < skus.length; i += batchSize) {
    const batch = skus.slice(i, i + batchSize);
    const inList = batch.map(s => `"${s}"`).join(',');
    const url = `${SUPABASE_URL}/rest/v1/products?select=sku,stock_locator,name,category&sku=in.(${encodeURIComponent(inList.replace(/"/g, '"'))})`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'Accept-Profile': 'cin7_mirror',
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) { console.warn(`Supabase locator fetch failed: ${res.status}`); continue; }
    const rows = await res.json();
    for (const r of rows) {
      if (r.sku) result.set(r.sku, { locator: r.stock_locator, name: r.name, category: r.category });
    }
  }
  return result;
}

/**
 * Fetch stock snapshot data from cin7_mirror.stock_snapshot for given SKU+bin pairs.
 * Returns a Map of "sku|bin" → { on_hand, allocated, available }
 */
async function fetchStockForBins(skuBinPairs) {
  if (!skuBinPairs.length) return new Map();
  const skus = [...new Set(skuBinPairs.map(p => p.sku).filter(Boolean))];
  const bins = [...new Set(skuBinPairs.map(p => p.bin).filter(Boolean))];
  if (!skus.length || !bins.length) return new Map();
  const result = new Map();
  const batchSize = 80;
  for (let i = 0; i < skus.length; i += batchSize) {
    const skuBatch = skus.slice(i, i + batchSize);
    const skuIn = skuBatch.map(s => `"${s}"`).join(',');
    const binIn = bins.map(b => `"${b}"`).join(',');
    const url = `${SUPABASE_URL}/rest/v1/stock_snapshot?select=sku,bin,on_hand,allocated,available&sku=in.(${encodeURIComponent(skuIn)})&bin=in.(${encodeURIComponent(binIn)})`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON,
        'Authorization': `Bearer ${SUPABASE_ANON}`,
        'Accept-Profile': 'cin7_mirror',
      },
    });
    if (!res.ok) { console.warn(`⚠️ Stock snapshot fetch failed: ${res.status}`); continue; }
    const rows = await res.json();
    for (const r of rows) {
      result.set(`${r.sku}|${r.bin}`, {
        on_hand: parseFloat(r.on_hand) || 0,
        allocated: parseFloat(r.allocated) || 0,
        available: parseFloat(r.available) || 0,
      });
    }
  }
  return result;
}

/**
 * Classify anomaly confidence: 'suspect' (likely false positive) or 'confirmed' (likely real error).
 * Also returns a human-readable note explaining the classification.
 * @param {Object} pick - The pick object with sku, bin, expectedBin, errorType
 * @param {Map} stockMap - Map of "sku|bin" → { on_hand, ... } from stock_snapshot
 * @returns {{ confidence: string, note: string }}
 */
function classifyAnomalyConfidence(pick, stockMap) {
  const et = pick.errorType;

  // Pallet-only: always suspect — same location, just different pallet numbering
  if (et === 'pallet_only') {
    return { confidence: 'suspect', note: 'Adjacent pallet — same slot, different pallet number' };
  }

  // Special location: always suspect — DOCK, RETURNS, SAMPLES, etc.
  if (et === 'special_loc') {
    return { confidence: 'suspect', note: `Special location — "${pick.bin}" is not a standard MA- bin` };
  }

  // Check if the picked bin has stock for this SKU (overflow evidence)
  const key = `${pick.sku}|${pick.bin}`;
  const stock = stockMap ? stockMap.get(key) : null;
  if (stock && stock.on_hand > 0) {
    return { confidence: 'suspect', note: `Overflow: bin "${pick.bin}" has ${stock.on_hand} units of this SKU in stock` };
  }

  // Same column without overflow evidence → still likely vertical overflow
  if (et === 'same_column') {
    return { confidence: 'suspect', note: 'Likely vertical overflow — same column, different level' };
  }

  // same_section or different_area without overflow → likely real anomaly
  if (et === 'same_section') {
    return { confidence: 'confirmed', note: 'Different column in same section — no overflow evidence' };
  }

  return { confidence: 'confirmed', note: 'Different area — incorrect pick location' };
}

/**
 * Add anomaly confidence classification to all anomaly picks in an order.
 * Modifies the picks array in place.
 */
async function addAnomalyConfidence(picks, fgOrders) {
  // Collect all anomaly sku+bin pairs
  const skuBinPairs = [];
  for (const p of picks) {
    if (p.status === 'anomaly' && p.sku && p.bin) skuBinPairs.push({ sku: p.sku, bin: p.bin });
  }
  for (const fg of (fgOrders || [])) {
    for (const c of (fg.components || [])) {
      if (c.status === 'anomaly' && c.sku && c.bin) skuBinPairs.push({ sku: c.sku, bin: c.bin });
    }
  }
  if (!skuBinPairs.length) return;

  const stockMap = await fetchStockForBins(skuBinPairs);

  for (const p of picks) {
    if (p.status === 'anomaly') {
      const { confidence, note } = classifyAnomalyConfidence(p, stockMap);
      p.anomalyConfidence = confidence;
      p.anomalyNote = note;
    } else {
      delete p.anomalyConfidence;
      delete p.anomalyNote;
    }
  }
  for (const fg of (fgOrders || [])) {
    for (const c of (fg.components || [])) {
      if (c.status === 'anomaly') {
        const { confidence, note } = classifyAnomalyConfidence(c, stockMap);
        c.anomalyConfidence = confidence;
        c.anomalyNote = note;
      } else {
        delete c.anomalyConfidence;
        delete c.anomalyNote;
      }
    }
  }
}

async function getBinCache() {
  if (binCache && Date.now() - binCacheTime < BIN_CACHE_TTL) return binCache;
  console.log('📍 Building bin LocationID cache...');
  binCache = new Map();
  let page = 1;
  while (true) {
    await delay(RATE_DELAY);
    const data = await cin7Get(`ref/location?Page=${page}&Limit=100&Name=${encodeURIComponent('Main Warehouse')}`);
    const locs = data.LocationList || [];
    for (const loc of locs) {
      if (loc.Bins) {
        for (const bin of loc.Bins) binCache.set(bin.Name, bin.ID);
      }
    }
    if (locs.length < 100) break;
    page++;
  }
  binCacheTime = Date.now();
  console.log(`📍 Cached ${binCache.size} bin LocationIDs`);
  return binCache;
}

function extractBin(location) {
  if (!location) return null;
  if (!location.includes(': ')) return null;
  return location.split(': ')[1].trim();
}

function classifyError(pickedBin, expectedBin) {
  if (!pickedBin || !expectedBin) return 'unknown';
  const parse = (bin) => {
    const m = bin.match(/^MA-([A-Z])-(\d+)-L(\d+)(?:-P(\d+))?$/i);
    if (!m) return null;
    return { area: m[1], col: m[2], level: m[3], pallet: m[4] || null };
  };
  const p = parse(pickedBin);
  const e = parse(expectedBin);
  if (!p || !e) return 'special_loc';
  if (p.area === e.area && p.col === e.col && p.level === e.level && p.pallet !== e.pallet) return 'pallet_only';
  if (p.area === e.area && p.col === e.col) return 'same_column';
  if (p.area === e.area) return 'same_section';
  return 'different_area';
}

// ═══════════════════════════════════════════════════
// SYNC METADATA
// ═══════════════════════════════════════════════════

async function getLastSyncDate() {
  try {
    const rows = await sbGet('pick_anomaly_sync', 'select=*&id=eq.1');
    if (rows.length) return rows[0];
    return null;
  } catch (err) {
    console.warn('⚠️ Could not fetch sync metadata:', err.message);
    return null;
  }
}

async function updateSyncMeta(lastDate, totalOrders, lastNewOrders) {
  try {
    const patch = {
      last_synced_date: lastDate,
      last_synced_at: new Date().toISOString(),
      total_orders: totalOrders,
    };
    if (lastNewOrders !== undefined) patch.last_new_orders = lastNewOrders;
    try {
      await sbPatch('pick_anomaly_sync', 'id=eq.1', patch);
    } catch (patchErr) {
      // If last_new_orders column doesn't exist yet, retry without it
      if (patchErr.message && patchErr.message.includes('last_new_orders')) {
        delete patch.last_new_orders;
        await sbPatch('pick_anomaly_sync', 'id=eq.1', patch);
        console.warn('⚠️ last_new_orders column not found — run migration: ALTER TABLE public.pick_anomaly_sync ADD COLUMN last_new_orders INT DEFAULT 0;');
      } else {
        throw patchErr;
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not update sync metadata:', err.message);
  }
}

// ═══════════════════════════════════════════════════
// ACTION LOG — Tracks every user/system action per order
// ═══════════════════════════════════════════════════

async function logAction({ order_number, action, details, user_email }) {
  try {
    await sbPost('pick_anomaly_logs', {
      order_number,
      action,
      details: details || null,
      user_email: user_email || 'unknown',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Log table may not exist yet — don't crash, just warn
    console.warn('⚠️ Could not write action log:', err.message);
  }
}

async function getOrderLogs(orderNumber) {
  try {
    const logs = await sbGet('pick_anomaly_logs',
      `select=*&order_number=eq.${orderNumber}&order=created_at.desc&limit=50`
    );
    return logs;
  } catch (err) {
    console.warn('⚠️ Could not fetch logs:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════
// HISTORY (READ FROM SUPABASE)
// ═══════════════════════════════════════════════════

async function loadHistory({ search, filter, limit = 200, offset = 0 }) {
  let query = `select=*&order=order_date.desc,order_number.desc&limit=${limit}&offset=${offset}`;

  if (filter === 'anomaly') {
    query += '&anomaly_picks=gt.0';
  } else if (filter === 'correct') {
    query += '&anomaly_picks=eq.0&total_picks=gt.0';
  } else if (filter === 'fg') {
    query += '&fg_count=gt.0';
  } else if (filter === 'pending') {
    // Anomaly orders NOT yet reviewed
    query += '&anomaly_picks=gt.0&reviewed=is.false';
  } else if (filter === 'corrected') {
    // We'll join corrections on the frontend side
    query += '&anomaly_picks=gt.0';
  } else if (filter === 'cancelled') {
    // Orders that were cancelled after being processed
    query += '&is_cancelled=eq.true';
  }

  if (search) {
    // Search in order_number OR customer (case-insensitive)
    query += `&or=(order_number.ilike.*${search}*,customer.ilike.*${search}*)`;
  }

  const orders = await sbGet('pick_anomaly_orders', query);

  // Fetch corrections for these orders
  if (orders.length) {
    const orderNums = orders.map(o => `"${o.order_number}"`).join(',');
    const corrections = await sbGet('pick_anomaly_corrections',
      `select=*&order_number=in.(${encodeURIComponent(orderNums)})`
    );

    // Map corrections to orders
    const corrMap = new Map();
    for (const c of corrections) {
      if (!corrMap.has(c.order_number)) corrMap.set(c.order_number, []);
      corrMap.get(c.order_number).push(c);
    }

    for (const order of orders) {
      order.corrections = corrMap.get(order.order_number) || [];
    }
  }

  // Total count
  let totalQuery = 'select=id&order=id';
  if (filter === 'anomaly') totalQuery += '&anomaly_picks=gt.0';
  else if (filter === 'correct') totalQuery += '&anomaly_picks=eq.0&total_picks=gt.0';
  else if (filter === 'fg') totalQuery += '&fg_count=gt.0';
  else if (filter === 'pending') totalQuery += '&anomaly_picks=gt.0&reviewed=is.false';
  if (search) totalQuery += `&or=(order_number.ilike.*${search}*,customer.ilike.*${search}*)`;

  let totalCount = orders.length;
  try {
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/pick_anomaly_orders?${totalQuery}`, {
      headers: { ...SB_HEADERS, 'Prefer': 'count=exact' },
      method: 'HEAD',
    });
    const range = countRes.headers.get('content-range');
    if (range) {
      const m = range.match(/\/(\d+)/);
      if (m) totalCount = parseInt(m[1]);
    }
  } catch { /* ignore */ }

  return { orders, total: totalCount };
}

// ═══════════════════════════════════════════════════
// MAIN SYNC — Analyze & Save New Orders
// ═══════════════════════════════════════════════════

async function syncNewOrders() {
  if (syncInProgress) {
    return { success: false, error: 'Sync already in progress', syncing: true };
  }
  syncInProgress = true;
  const t0 = Date.now();
  apiCallCount = 0;

  try {
    // Get last sync date
    const syncMeta = await getLastSyncDate();
    const lastDate = syncMeta?.last_synced_date || '2026-02-20';
    const today = new Date().toISOString().split('T')[0];

    // ── FIX: Use lastDate directly (NOT +1 day) to avoid gap ──
    // ── Use a rolling 7-day lookback window ──
    // Instead of relying on last_synced_date (which could get stuck),
    // always look back 7 days. The existingNumbers dedup prevents
    // double-processing. This ensures we always catch recent orders.
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 7);
    const lookbackDate = lookback.toISOString().split('T')[0];
    // Use whichever is earlier: lastDate or 7-day lookback
    const dateFrom = lastDate < lookbackDate ? lookbackDate : lastDate;
    const dateTo = today;

    console.log(`🔄 Syncing orders: ${dateFrom} → ${dateTo} (last sync: ${syncMeta?.last_synced_at || 'never'})`);
    return await _analyzeAndSave(dateFrom, dateTo, syncMeta);
  } catch (err) {
    console.error('❌ Sync error:', err);
    return { success: false, error: err.message };
  } finally {
    syncInProgress = false;
  }
}

async function _analyzeAndSave(dateFrom, dateTo, syncMeta) {
  const t0 = Date.now();

  // ── Step 1: Fetch sale list ──
  console.log(`🔍 Analyzing picks ${dateFrom} → ${dateTo}...`);
  const orders = [];
  const cancelledFromCin7 = [];
  let page = 1;

  // ── FLOOR_DATE: Rolling 30-day SOFT pre-filter on OrderDate ──
  // This is a GENEROUS window to avoid fetching very old orders from saleList.
  // It is NOT the definitive filter — that role belongs to the fulfilled_date
  // hard gate (ShipmentDate check) applied after fetching sale detail.
  // 30 days covers even orders that take 3+ weeks from placement to ship.
  // Example: Order placed Mar 15, shipped Apr 8 → OrderDate is 26 days old
  //   → passes 30-day FLOOR_DATE → detail is fetched → ShipmentDate Apr 8 → accepted.
  // With the old 14-day window, this order would have been silently dropped.
  const floorDate = new Date();
  floorDate.setDate(floorDate.getDate() - 30);
  let FLOOR_DATE = floorDate.toISOString().split('T')[0];
  // Never go below scanner cutoff — pre-scanner orders have no bin data
  if (FLOOR_DATE < SCANNER_CUTOFF_DATE) FLOOR_DATE = SCANNER_CUTOFF_DATE;
  // ── STAGE GATE: Only process orders that have SHIPPED ──
  // Dear Systems saleList field mapping (verified via live data analysis):
  //   CombinedShippingStatus: SHIPPED   | PARTIALLY SHIPPED   | NOT SHIPPED   | NOT AVAILABLE
  //   FulFilmentStatus:       FULFILLED | PARTIALLY FULFILLED | NOT FULFILLED | NOT AVAILABLE
  //   CombinedPackingStatus:  PACKED    | PARTIALLY PACKED    | NOT PACKED    | NOT AVAILABLE
  //   OrderStatus:            FULFILLED | AUTHORISED | CLOSED | VOIDED | NOT AVAILABLE
  //
  // SHIPPED is the ONLY status we capture — this is when Cin7 deducts stock from bins.
  // Other statuses (including FULFILLED after invoicing) are completely ignored.
  // Invoiced orders still show CombinedShippingStatus=SHIPPED, but the dedup check
  // + ignore-duplicates INSERT ensures they're never re-analyzed.
  //
  // Statuses that indicate an order was cancelled/voided AFTER processing
  const CANCELLED_STATUSES = ['VOID', 'VOIDED', 'CANCELLED', 'CREDITED'];

  while (true) {
    await delay(RATE_DELAY);
    const data = await cin7Get(
      `saleList?Location=${encodeURIComponent('Main Warehouse')}&UpdatedSince=${dateFrom}T00:00:00Z&UpdatedBefore=${dateTo}T23:59:59Z&Page=${page}&Limit=100`
    );
    const sales = data.SaleList || [];
    if (page === 1) console.log(`📋 Page 1: ${sales.length} sales...`);

    // Separate: valid orders for analysis + cancelled orders for detection
    for (const s of sales) {
      const ful = (s.FulFilmentStatus || '').toUpperCase();
      const shipStatus = (s.CombinedShippingStatus || '').toUpperCase();
      const ost = (s.OrderStatus || s.Status || '').toUpperCase();
      const orderDate = (s.OrderDate || '').split('T')[0];
      const isRecent = orderDate >= FLOOR_DATE;
      if (!isRecent) continue;

      // Gate: ONLY CombinedShippingStatus=SHIPPED
      // We capture orders at the SHIP stage only — this is when Cin7 deducts stock.
      // FULFILLED is equivalent but we use SHIPPED as the single source of truth.
      // Invoiced-only or other statuses are completely ignored.
      const isValidStatus = shipStatus === 'SHIPPED';
      const isCancelled = CANCELLED_STATUSES.includes(ost) || ful === 'NOT AVAILABLE' && CANCELLED_STATUSES.includes(ost);

      if (isValidStatus) {
        orders.push(s);
      } else if (isCancelled) {
        cancelledFromCin7.push(s);
      }
    }
    if (sales.length < 100) break;
    page++;
  }

  console.log(`📋 Found ${orders.length} SHIPPED MW orders, ${cancelledFromCin7.length} cancelled`);

  // Check which orders we already have in Supabase (skip duplicates)
  let existingNumbers = new Set();
  if (orders.length > 0) {
    try {
      // Batch in groups of 100 to avoid URL length limits
      const allNums = orders.map(o => o.OrderNumber);
      for (let b = 0; b < allNums.length; b += 100) {
        const batch = allNums.slice(b, b + 100);
        const nums = batch.map(n => `"${n}"`).join(',');
        const existing = await sbGet('pick_anomaly_orders',
          `select=order_number&order_number=in.(${nums})`
        );
        for (const e of existing) existingNumbers.add(e.order_number);
      }
    } catch (err) {
      console.error('❌ Dedup check failed — aborting sync to prevent re-analysis:', err.message);
      return {
        success: false,
        error: 'Dedup check failed (aborting to protect analyzed_at): ' + err.message,
        newOrders: 0,
        skippedExisting: 0,
      };
    }
  }

  const newOrders = orders.filter(o => !existingNumbers.has(o.OrderNumber));

  // ── CRITICAL: Sort newest orders first ──
  // Cin7 saleList returns orders in arbitrary order. When capped at 200,
  // older modified orders would block newer ones from ever being processed.
  // By sorting newest-first, the page always shows the most recent data.
  newOrders.sort((a, b) => {
    const da = (a.OrderDate || '').split('T')[0];
    const db = (b.OrderDate || '').split('T')[0];
    return db.localeCompare(da); // descending: newest first
  });

  console.log(`📋 ${newOrders.length} new orders to process (${existingNumbers.size} already in history)`);

  let wasCapped = false;
  if (newOrders.length > MAX_ORDERS_PER_RUN) {
    console.log(`⚠️ Capping at ${MAX_ORDERS_PER_RUN} orders (${newOrders.length - MAX_ORDERS_PER_RUN} remaining for next sync)`);
    newOrders.length = MAX_ORDERS_PER_RUN;
    wasCapped = true;
  }

  // ── Step 2: Analyze each new order ──
  const results = [];
  let skippedPreCutoff = 0;   // fulfilled_date < SCANNER_CUTOFF_DATE
  let skippedStaleShip = 0;   // fulfilled_date > 45 days old

  for (let i = 0; i < newOrders.length; i++) {
    const order = newOrders[i];

    await delay(RATE_DELAY);
    let saleDetail;
    try {
      saleDetail = await cin7Get(`sale?ID=${order.SaleID}`);
    } catch (err) {
      console.warn(`⚠️ Failed to fetch ${order.OrderNumber}: ${err.message}`);
      continue;
    }

    const picks = [];
    const noBinSkus = [];
    let pickIdx = 0;

    for (const ful of (saleDetail.Fulfilments || saleDetail.Fulfillments || [])) {
      let lines = [];
      if (ful.Pick && ful.Pick.Lines) lines = ful.Pick.Lines;
      else if (Array.isArray(ful.Pick)) lines = ful.Pick;
      else if (Array.isArray(ful.Lines)) lines = ful.Lines;

      for (const line of lines) {
        if (!line || !line.SKU) continue;
        const bin = extractBin(line.Location);
        picks.push({
          id: `${order.OrderNumber}-${pickIdx++}`,
          sku: line.SKU || line.ProductCode,
          productId: line.ProductID,
          name: line.Name || line.ProductName,
          qty: line.Quantity,
          location: line.Location,
          locationId: line.LocationID,
          bin,
          hasBin: !!bin,
        });
        if (!bin) noBinSkus.push(line.SKU || line.ProductCode);
      }
    }

    if (!picks.length) continue;

    // Save the raw Cin7 order status for display
    const rawOrderStatus = saleDetail.FulFilmentStatus || saleDetail.OrderStatus || saleDetail.Status || order.FulFilmentStatus || order.OrderStatus || 'Unknown';

    // Batch fetch stock_locators
    const allSkus = [...new Set(picks.map(p => p.sku))];
    const locators = await fetchLocators(allSkus);

    // Compare each pick
    for (const pick of picks) {
      const info = locators.get(pick.sku);
      const expected = info?.locator || null;

      if (!pick.hasBin) {
        if (expected === 'BOM' || expected === 'Production') {
          pick.status = 'no_bin_assembly';
          pick.reason = expected.toLowerCase();
        } else if (expected && expected.startsWith('MA-')) {
          pick.status = 'no_bin_suspect';
          pick.expectedBin = expected;
        } else {
          pick.status = 'no_bin_ok';
        }
      } else if (!expected || expected === '0' || expected === 'BOM' || expected === 'Production' || !expected.startsWith('MA-')) {
        pick.status = 'correct';
        pick.expectedBin = expected;
      } else if (pick.bin === expected) {
        pick.status = 'correct';
        pick.expectedBin = expected;
      } else {
        pick.status = 'anomaly';
        pick.expectedBin = expected;
        pick.errorType = classifyError(pick.bin, expected);
      }
    }

    // FG search (only if assembly picks)
    const fgOrders = [];
    const hasAssemblyPicks = noBinSkus.length > 0 || picks.some(p => p.status === 'no_bin_assembly');

    if (hasAssemblyPicks) {
      try {
        await delay(RATE_DELAY);
        const fgSearch = await cin7Get(`finishedGoodsList?Search=${order.OrderNumber}&Limit=20`);
        const fgList = (fgSearch.FinishedGoodsList || fgSearch.FinishedGoods || []);

        for (const fg of fgList) {
          if (fg.Status === 'VOIDED') continue;
          if (fg.Notes && !fg.Notes.includes(order.OrderNumber)) continue;

          await delay(RATE_DELAY);
          let fgDetail;
          try {
            fgDetail = await cin7Get(`finishedGoods?TaskID=${fg.TaskID}`);
          } catch (err) {
            console.warn(`⚠️ Failed FG detail ${fg.TaskID}: ${err.message}`);
            continue;
          }

          const compSkus = (fgDetail.PickLines || []).map(pl => pl.ProductCode).filter(Boolean);
          const compLocators = await fetchLocators([...new Set(compSkus)]);

          const components = (fgDetail.PickLines || []).map(pl => {
            const compInfo = compLocators.get(pl.ProductCode);
            const compExpected = compInfo?.locator || null;
            const compBin = pl.Bin || null;
            const isCorrect = !compBin || !compExpected || !compExpected.startsWith('MA-') || compBin === compExpected;
            return {
              sku: pl.ProductCode, productId: pl.ProductID, qty: pl.Quantity,
              cost: pl.Cost, bin: compBin, binId: pl.BinID,
              expectedBin: compExpected,
              status: isCorrect ? 'correct' : 'anomaly',
              errorType: isCorrect ? null : classifyError(compBin, compExpected),
            };
          });

          let createdBy = null;
          if (fgDetail.Notes) {
            const m = fgDetail.Notes.match(/by\s+(\S+@\S+)/i);
            if (m) createdBy = m[1];
          }

          fgOrders.push({
            taskId: fg.TaskID,
            assemblyNumber: fgDetail.AssemblyNumber || fg.AssemblyNumber,
            productCode: fgDetail.ProductCode || fg.ProductCode,
            status: fgDetail.Status || fg.Status,
            completionDate: fgDetail.CompletionDate,
            quantity: fgDetail.Quantity,
            createdBy,
            components,
          });
        }
      } catch (err) {
        console.warn(`⚠️ FG search failed for ${order.OrderNumber}: ${err.message}`);
      }
    }

    const filteredPicks = picks.filter(p => p.status === 'correct' || p.status === 'anomaly');

    // Skip orders with 0 meaningful picks
    if (!filteredPicks.length) continue;

    // ── Anomaly confidence classification ──
    await addAnomalyConfidence(filteredPicks, fgOrders);

    const correctCount = filteredPicks.filter(p => p.status === 'correct').length;
    const anomalyCount = filteredPicks.filter(p => p.status === 'anomaly').length;

    // fulfilled_date = ShipmentDate from Ship.Lines[0] (actual fulfilment date)
    // invoice_date = InvoiceDate from Invoices[0]
    // These are the REAL dates, not LastModifiedOn
    let fulfilledDate = null;
    let invoiceDate = null;
    let shipmentDate = null;

    // Extract shipment date (when physically fulfilled/shipped)
    for (const ful of (saleDetail.Fulfilments || saleDetail.Fulfillments || [])) {
      if (ful.Ship && ful.Ship.Lines && ful.Ship.Lines[0] && ful.Ship.Lines[0].ShipmentDate) {
        shipmentDate = ful.Ship.Lines[0].ShipmentDate;
        break;
      }
    }

    // Extract invoice date
    if (saleDetail.Invoices && saleDetail.Invoices[0] && saleDetail.Invoices[0].InvoiceDate) {
      invoiceDate = saleDetail.Invoices[0].InvoiceDate;
    }

    // fulfilled_date = shipment date (when goods left the warehouse)
    fulfilledDate = shipmentDate || invoiceDate || null;

    // ── HARD GATE: fulfilled_date must be after scanner cutoff ──
    // This is the DEFINITIVE check. Unlike the OrderDate soft pre-filter,
    // this uses the ACTUAL ship date (when Cin7 decremented stock from bins).
    // Orders that pass the saleList pre-filter but have old ShipmentDates
    // (e.g., order modified for credit note) are caught here.
    const fulfilledDateStr = fulfilledDate ? fulfilledDate.split('T')[0] : null;
    if (fulfilledDateStr && fulfilledDateStr < SCANNER_CUTOFF_DATE) {
      console.log(`  ⏭️ Skip ${order.OrderNumber}: shipped ${fulfilledDateStr} < cutoff ${SCANNER_CUTOFF_DATE}`);
      skippedPreCutoff++;
      continue;
    }
    // Also reject if fulfilled_date is suspiciously old (> 45 days)
    // This catches phantom orders that somehow have SHIPPED status but ancient dates
    const maxAge = new Date();
    maxAge.setDate(maxAge.getDate() - 45);
    const MAX_SHIP_AGE = maxAge.toISOString().split('T')[0];
    if (fulfilledDateStr && fulfilledDateStr < MAX_SHIP_AGE) {
      console.log(`  ⏭️ Skip ${order.OrderNumber}: shipped ${fulfilledDateStr} > 45 days ago (stale)`);
      skippedStaleShip++;
      continue;
    }

    const orderResult = {
      sale_id: order.SaleID,
      order_number: order.OrderNumber,
      order_date: order.OrderDate ? order.OrderDate.split('T')[0] : null,
      fulfilled_date: fulfilledDate ? fulfilledDate.split('T')[0] : null,
      invoice_date: invoiceDate ? invoiceDate.split('T')[0] : null,
      customer: order.Customer,
      order_status: rawOrderStatus,
      total_picks: filteredPicks.length,
      correct_picks: correctCount,
      anomaly_picks: anomalyCount,
      fg_count: fgOrders.length,
      picks: filteredPicks,
      fg_orders: fgOrders,
      analyzed_at: new Date().toISOString(),
    };

    results.push(orderResult);

    // Save to Supabase (INSERT only — never overwrite existing orders)
    // Uses ignore-duplicates: if order_number already exists, row is untouched.
    // This guarantees analyzed_at is set ONCE on first sync and never changes.
    try {
      await sbInsertIfNew('pick_anomaly_orders', orderResult, 'order_number');
      // Log the sync action
      await logAction({
        order_number: order.OrderNumber,
        action: 'synced',
        details: `Analyzed: ${correctCount} correct, ${anomalyCount} anomalies, ${fgOrders.length} FG`,
        user_email: 'system@auto-sync',
      });
    } catch (err) {
      console.warn(`⚠️ Failed to save ${order.OrderNumber} to Supabase:`, err.message);
    }

    console.log(`  [${i + 1}/${newOrders.length}] ${order.OrderNumber}: ${correctCount}✅ ${anomalyCount}⚠️ ${fgOrders.length}🔧`);
  }

  // ── CANCELLATION DETECTION ──
  // Check if any orders from Cin7's cancelled list have corrections in our DB.
  // If yes → the corrective stock transfer we made is now WRONG (Cin7 reversed the original pick).
  // Flag them so the operator can reverse our correction.
  let cancelledWithCorrections = 0;
  if (cancelledFromCin7.length > 0) {
    const cancelledNums = cancelledFromCin7.map(o => o.OrderNumber);
    try {
      // Check which cancelled orders exist in our DB AND have corrections
      for (let b = 0; b < cancelledNums.length; b += 50) {
        const batch = cancelledNums.slice(b, b + 50);
        const nums = batch.map(n => `"${n}"`).join(',');

        // Find orders in our DB that match these cancelled order numbers
        const matchedOrders = await sbGet('pick_anomaly_orders',
          `select=order_number,is_cancelled&order_number=in.(${encodeURIComponent(nums)})`
        );

        for (const mo of matchedOrders) {
          if (mo.is_cancelled) continue; // Already flagged

          // Check if this order has corrections
          const corrections = await sbGet('pick_anomaly_corrections',
            `select=id,transfer_status&order_number=eq.${mo.order_number}&limit=1`
          );

          const cin7Order = cancelledFromCin7.find(o => o.OrderNumber === mo.order_number);
          const cancelStatus = cin7Order ? (cin7Order.FulFilmentStatus || cin7Order.OrderStatus || 'CANCELLED') : 'CANCELLED';

          await sbPatch('pick_anomaly_orders', `order_number=eq.${mo.order_number}`, {
            is_cancelled: true,
            cancelled_at: new Date().toISOString(),
            order_status: cancelStatus.toUpperCase(),
            has_correction_conflict: corrections.length > 0,
          });

          if (corrections.length > 0) {
            cancelledWithCorrections++;
            console.log(`⚠️ CANCELLED ORDER WITH CORRECTIONS: ${mo.order_number} — correction may need reversal!`);
            await logAction({
              order_number: mo.order_number,
              action: 'cancellation_detected',
              details: `Order cancelled (${cancelStatus}) AFTER correction was applied. Stock transfer may need reversal.`,
              user_email: 'system@auto-sync',
            });
          } else {
            console.log(`ℹ️ Cancelled order ${mo.order_number} (no corrections — safe)`);
            await logAction({
              order_number: mo.order_number,
              action: 'cancellation_detected',
              details: `Order cancelled (${cancelStatus}). No corrections applied — no action needed.`,
              user_email: 'system@auto-sync',
            });
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Cancellation check failed:', err.message);
    }
  }

  // ── Always advance last_synced_date to today ──
  // Since we now sort newest-first, the most recent orders are always processed.
  // Keeping dateFrom stuck caused the old behavior where the sync window grew
  // infinitely and the queue of modified-old-orders blocked new ones.
  // The dedup (existingNumbers) ensures no double-processing on re-fetches.
  const totalInDb = (syncMeta?.total_orders || 0) + results.length;
  const syncDate = dateTo; // Always advance to today
  await updateSyncMeta(syncDate, totalInDb, results.length);

  const lastSyncedAt = new Date().toISOString();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  if (wasCapped) {
    console.log(`✅ Sync complete (CAPPED): ${results.length} new orders saved. ${cancelledWithCorrections} cancelled w/corrections. ${skippedPreCutoff + skippedStaleShip} rejected by ship-date gate. ${apiCallCount} API calls, ${elapsed}`);
  } else {
    console.log(`✅ Sync complete: ${results.length} new orders saved, ${cancelledWithCorrections} cancelled w/corrections. ${skippedPreCutoff + skippedStaleShip} rejected by ship-date gate. synced to ${syncDate}. ${apiCallCount} API calls, ${elapsed}`);
  }

  return {
    success: true,
    newOrders: results.length,
    skippedExisting: existingNumbers.size,
    skippedPreCutoff,
    skippedStaleShip,
    cancelledDetected: cancelledFromCin7.length,
    cancelledWithCorrections,
    wasCapped,
    apiCalls: apiCallCount,
    elapsed,
    syncedUpTo: syncDate,
    lastSyncedAt,
    totalOrders: totalInDb,
  };
}

// ═══════════════════════════════════════════════════
// STOCK TRANSFER CREATION + CORRECTION TRACKING
// ═══════════════════════════════════════════════════

async function createCorrectionTransfer({ productId, sku, qty, expectedBin, pickedBin, orderNumber, pickId }) {
  const bins = await getBinCache();
  const fromBinId = bins.get(expectedBin);
  const toBinId = bins.get(pickedBin);

  if (!fromBinId) throw new Error(`Bin "${expectedBin}" not found in location cache`);
  if (!toBinId) throw new Error(`Bin "${pickedBin}" not found in location cache`);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0]; // 2026-02-23

  // Format date as human-readable (24 Feb 2026)
  const readableDate = now.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });

  // Build audit comment for the line (visible inside Cin7 transfer)
  const lineComment = [
    `Pick Anomaly Correction`,
    `Order: ${orderNumber || 'N/A'}`,
    `SKU: ${sku}  |  Qty: ${qty}`,
    `From: ${expectedBin}  →  To: ${pickedBin}`,
    `Date: ${readableDate}`,
  ].join('\n');

  // Reference field (header level, searchable in Cin7)
  // Format: PA | SO-12345 | 24 Feb 2026
  const reference = `PA | ${orderNumber || 'UNKNOWN'} | ${readableDate}`;

  // Step 1: Create transfer as DRAFT with Reference + Line Comments
  await delay(RATE_DELAY);
  const result = await cin7Post('stockTransfer', {
    Status: 'DRAFT',
    From: fromBinId,
    To: toBinId,
    Reference: reference,
    Lines: [{
      ProductID: productId,
      TransferQuantity: qty,
      Comments: lineComment,
    }],
  });

  const transferId = result?.TaskID || result?.ID || result?.StockTransferID || null;
  let transferRef = result?.Number || result?.Reference || null;
  let transferStatus = 'DRAFT';

  // Step 2: Complete the transfer (PUT requires full object + CompletionDate)
  if (transferId) {
    try {
      await delay(RATE_DELAY);
      const completed = await cin7Put('stockTransfer', {
        TaskID: transferId,
        From: fromBinId,
        To: toBinId,
        Status: 'COMPLETED',
        CompletionDate: todayStr,
        Reference: reference,
        CostDistributionType: 'Cost',
        SkipOrder: true,
        Lines: [{
          ProductID: productId,
          TransferQuantity: qty,
          Comments: lineComment,
        }],
      });
      transferStatus = 'COMPLETED';
      transferRef = completed?.Number || completed?.Reference || transferRef;
      console.log(`✅ Transfer ${transferId} completed successfully (${transferRef})`);
    } catch (err) {
      console.warn(`⚠️ Could not complete transfer ${transferId}: ${err.message}. Keeping as DRAFT.`);
    }
  }

  // Save correction to Supabase (full audit trail)
  const correctedAt = now.toISOString();
  if (orderNumber && pickId) {
    try {
      await sbPost('pick_anomaly_corrections', {
        order_number: orderNumber,
        pick_id: pickId,
        sku,
        from_bin: expectedBin,
        to_bin: pickedBin,
        qty,
        transfer_id: transferId ? String(transferId) : null,
        transfer_ref: transferRef,
        transfer_status: transferStatus,
        corrected_at: correctedAt,
      });
    } catch (err) {
      console.warn(`⚠️ Failed to save correction record:`, err.message);
    }
  }

  // Log the correction action
  await logAction({
    order_number: orderNumber,
    action: 'correction_created',
    details: `Transfer ${transferRef || transferId || 'N/A'} (${transferStatus}): ${sku} ×${qty} FROM ${expectedBin} → TO ${pickedBin}`,
    user_email: 'operator',  // Will be overridden by route if user info available
  });

  console.log(`📦 Created ${transferStatus} transfer: ${sku} ×${qty} FROM ${expectedBin} → TO ${pickedBin} | Ref: ${reference}`);
  return { ...result, transferId, transferRef, transferStatus, reference, comment: lineComment };
}

/**
 * Mark an order as reviewed (all picks verified by operator)
 */
async function markOrderReviewed(orderNumber, userEmail) {
  try {
    await sbPatch('pick_anomaly_orders', `order_number=eq.${orderNumber}`, {
      reviewed: true,
      reviewed_at: new Date().toISOString(),
    });
    await logAction({
      order_number: orderNumber,
      action: 'reviewed',
      details: 'Order marked as reviewed',
      user_email: userEmail || 'operator',
    });
    console.log(`✅ Order ${orderNumber} marked as reviewed`);
    return { success: true };
  } catch (err) {
    console.warn(`⚠️ Failed to mark ${orderNumber} as reviewed:`, err.message);
    throw err;
  }
}

/**
 * Reverse a correction transfer for a cancelled order.
 * Creates a NEW stock transfer in the OPPOSITE direction (pickedBin → expectedBin)
 * to undo the correction that was applied before the cancellation.
 */
async function reverseCorrection({ correctionId, productId, sku, qty, fromBin, toBin, orderNumber }) {
  // Reverse = swap from/to
  // Original correction: expectedBin → pickedBin (moving stock to where it was actually picked from)
  // Reversal: pickedBin → expectedBin (moving it back because the order was cancelled)
  const bins = await getBinCache();
  const fromBinId = bins.get(toBin);   // Original "to" becomes "from"
  const toBinId = bins.get(fromBin);   // Original "from" becomes "to"

  if (!fromBinId) throw new Error(`Bin "${toBin}" not found in location cache`);
  if (!toBinId) throw new Error(`Bin "${fromBin}" not found in location cache`);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const readableDate = now.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });

  const lineComment = [
    `REVERSAL — Pick Anomaly Correction`,
    `Order: ${orderNumber || 'N/A'} (CANCELLED)`,
    `SKU: ${sku}  |  Qty: ${qty}`,
    `Reversing: ${toBin} → ${fromBin}`,
    `Date: ${readableDate}`,
  ].join('\n');

  const reference = `PA-REV | ${orderNumber || 'UNKNOWN'} | ${readableDate}`;

  // Create + complete the reversal transfer
  await delay(RATE_DELAY);
  const result = await cin7Post('stockTransfer', {
    Status: 'DRAFT',
    From: fromBinId,
    To: toBinId,
    Reference: reference,
    Lines: [{
      ProductID: productId,
      TransferQuantity: qty,
      Comments: lineComment,
    }],
  });

  const transferId = result?.TaskID || result?.ID || result?.StockTransferID || null;
  let transferRef = result?.Number || result?.Reference || null;
  let transferStatus = 'DRAFT';

  if (transferId) {
    try {
      await delay(RATE_DELAY);
      const completed = await cin7Put('stockTransfer', {
        TaskID: transferId,
        From: fromBinId,
        To: toBinId,
        Status: 'COMPLETED',
        CompletionDate: todayStr,
        Reference: reference,
        CostDistributionType: 'Cost',
        SkipOrder: true,
        Lines: [{
          ProductID: productId,
          TransferQuantity: qty,
          Comments: lineComment,
        }],
      });
      transferStatus = 'COMPLETED';
      transferRef = completed?.Number || completed?.Reference || transferRef;
      console.log(`✅ Reversal transfer ${transferId} completed (${transferRef})`);
    } catch (err) {
      console.warn(`⚠️ Could not complete reversal transfer ${transferId}: ${err.message}. Keeping as DRAFT.`);
    }
  }

  // Mark the original correction as reversed
  if (correctionId) {
    try {
      await sbPatch('pick_anomaly_corrections', `id=eq.${correctionId}`, {
        is_reversed: true,
        reversed_at: now.toISOString(),
        reversal_transfer_id: transferId ? String(transferId) : null,
        reversal_transfer_ref: transferRef,
      });
    } catch (err) {
      console.warn(`⚠️ Failed to mark correction as reversed:`, err.message);
    }
  }

  await logAction({
    order_number: orderNumber,
    action: 'correction_reversed',
    details: `REVERSAL Transfer ${transferRef || transferId || 'N/A'} (${transferStatus}): ${sku} ×${qty} FROM ${toBin} → TO ${fromBin}`,
    user_email: 'operator',
  });

  console.log(`🔄 REVERSED correction: ${sku} ×${qty} FROM ${toBin} → TO ${fromBin} | Ref: ${reference}`);
  return { transferId, transferRef, transferStatus, reference };
}

// ═══════════════════════════════════════════════════
// EXPRESS ROUTE REGISTRATION
// ═══════════════════════════════════════════════════

function registerPickAnomalyRoutes(app) {

  /**
   * GET /api/pick-anomalies/history?search=&filter=&limit=200&offset=0
   * Loads persistent history from Supabase
   */
  app.get('/api/pick-anomalies/history', async (req, res) => {
    try {
      const { search, filter, limit, offset } = req.query;
      const result = await loadHistory({
        search: search || '',
        filter: filter || 'all',
        limit: parseInt(limit) || 200,
        offset: parseInt(offset) || 0,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ History load error:', err);
      // Detect missing table (42P01 = relation does not exist)
      if (err.message.includes('42P01') || err.message.includes('does not exist')) {
        return res.status(503).json({
          success: false,
          error: 'TABLES_NOT_CREATED',
          message: 'Pick Anomaly tables not yet created. Run the migration SQL in Supabase Dashboard.',
        });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/sync
   * Triggers a sync of new orders since last sync date
   */
  app.post('/api/pick-anomalies/sync', async (req, res) => {
    try {
      const result = await syncNewOrders();
      res.json(result);
    } catch (err) {
      console.error('❌ Sync error:', err);
      if (err.message.includes('42P01') || err.message.includes('does not exist')) {
        return res.status(503).json({
          success: false,
          error: 'TABLES_NOT_CREATED',
          message: 'Pick Anomaly tables not yet created. Run the migration SQL in Supabase Dashboard.',
        });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/pick-anomalies/sync-status
   * Returns current sync state
   */
  app.get('/api/pick-anomalies/sync-status', async (req, res) => {
    try {
      const meta = await getLastSyncDate();
      res.json({
        success: true,
        syncing: syncInProgress,
        lastSyncedDate: meta?.last_synced_date || null,
        lastSyncedAt: meta?.last_synced_at || null,
        totalOrders: meta?.total_orders || 0,
        lastNewOrders: meta?.last_new_orders || 0,
      });
    } catch (err) {
      res.json({ success: true, syncing: syncInProgress, lastSyncedDate: null, totalOrders: 0 });
    }
  });

  /**
   * GET /api/pick-anomalies/analyze (LEGACY — kept for compatibility)
   */
  app.get('/api/pick-anomalies/analyze', async (req, res) => {
    try {
      const { dateFrom, dateTo } = req.query;
      if (!dateFrom || !dateTo) {
        return res.status(400).json({ success: false, error: 'dateFrom and dateTo required' });
      }
      const d1 = new Date(dateFrom);
      const d2 = new Date(dateTo);
      const diffDays = (d2 - d1) / 86400000;
      if (diffDays > 7) return res.status(400).json({ success: false, error: 'Max 7 days' });
      if (diffDays < 0) return res.status(400).json({ success: false, error: 'Invalid range' });

      const result = await _analyzeAndSave(dateFrom, dateTo, await getLastSyncDate());
      // After saving, load fresh data from DB
      const history = await loadHistory({ search: '', filter: 'all', limit: 200, offset: 0 });
      res.json({ success: true, ...result, orders: history.orders });
    } catch (err) {
      console.error('❌ Analysis error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/create-transfer
   */
  app.post('/api/pick-anomalies/create-transfer', async (req, res) => {
    try {
      const { productId, sku, qty, expectedBin, pickedBin, fromBin, toBin, orderNumber, pickId } = req.body;
      const from = expectedBin || fromBin;
      const to = pickedBin || toBin;
      if (!sku || !qty || !from || !to) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
      }
      const result = await createCorrectionTransfer({
        productId, sku, qty,
        expectedBin: from, pickedBin: to,
        orderNumber, pickId,
      });
      res.json({ success: true, transfer: result, transferId: result.transferId });
    } catch (err) {
      console.error('❌ Stock transfer error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/batch-transfer
   */
  app.post('/api/pick-anomalies/batch-transfer', async (req, res) => {
    try {
      const { transfers, items } = req.body;
      const list = transfers || items;
      if (!Array.isArray(list) || !list.length) {
        return res.status(400).json({ success: false, error: 'transfers/items array required' });
      }
      const results = [];
      for (const t of list) {
        try {
          const result = await createCorrectionTransfer(t);
          results.push({ sku: t.sku, pickId: t.pickId, success: true, transfer: result });
        } catch (err) {
          results.push({ sku: t.sku, pickId: t.pickId, success: false, error: err.message });
        }
      }
      const ok = results.filter(r => r.success).length;
      res.json({ success: true, created: ok, failed: results.length - ok, results });
    } catch (err) {
      console.error('❌ Batch transfer error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/reverse-correction
   * Reverse a correction (create opposite stock transfer) for a cancelled order.
   * Body: { correctionId, productId, sku, qty, fromBin, toBin, orderNumber }
   */
  app.post('/api/pick-anomalies/reverse-correction', async (req, res) => {
    try {
      const { correctionId, productId, sku, qty, fromBin, toBin, orderNumber } = req.body;
      if (!sku || !qty || !fromBin || !toBin) {
        return res.status(400).json({ success: false, error: 'Missing required fields (sku, qty, fromBin, toBin)' });
      }
      const result = await reverseCorrection({ correctionId, productId, sku, qty, fromBin, toBin, orderNumber });
      res.json({ success: true, reversal: result });
    } catch (err) {
      console.error('❌ Reverse correction error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/pick-anomalies/cancelled
   * Get orders that were cancelled after corrections were applied.
   * These need operator attention to reverse the stock transfers.
   */
  app.get('/api/pick-anomalies/cancelled', async (req, res) => {
    try {
      const cancelled = await sbGet('pick_anomaly_orders',
        'select=*&is_cancelled=eq.true&order=cancelled_at.desc'
      );

      // Fetch corrections for these orders
      const withConflicts = cancelled.filter(o => o.has_correction_conflict);
      let corrections = [];
      if (withConflicts.length > 0) {
        const nums = withConflicts.map(o => `"${o.order_number}"`).join(',');
        corrections = await sbGet('pick_anomaly_corrections',
          `select=*&order_number=in.(${encodeURIComponent(nums)})`
        );
      }

      // Attach corrections to their orders
      for (const o of cancelled) {
        o._corrections = corrections.filter(c => c.order_number === o.order_number);
      }

      res.json({
        success: true,
        orders: cancelled,
        total: cancelled.length,
        needsReversal: withConflicts.length,
      });
    } catch (err) {
      console.error('❌ Cancelled orders error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('✅ Pick anomaly routes registered (incl. cancellation detection)');

  /**
   * GET /api/pick-anomalies/analytics
   * Deep analytics across ALL orders — trends, error types, repeat offenders, problem bins.
   * Zero Cin7 API calls — Supabase only.
   */
  app.get('/api/pick-anomalies/analytics', async (req, res) => {
    try {
      // sbGetAll paginates automatically (Supabase default limit = 1000 rows)
      const allOrders = await sbGetAll('pick_anomaly_orders',
        'select=order_number,order_date,total_picks,correct_picks,anomaly_picks,fg_count,reviewed,picks,fg_orders'
      );

      // ── Weekly trend ──
      const weekMap = {};
      // ── Error type breakdown ──
      const errorTypes = {};
      // ── Top anomaly SKUs ──
      const skuCounts = {};
      // ── Top problem bins (picked from wrong bin) ──
      const binCounts = {};
      // ── Repeat routes (FROM→TO) ──
      const routeMap = {};
      // ── Section heatmap ──
      const sectionAnomalies = {};

      let totalPicks = 0, totalAnomalies = 0, totalCorrect = 0;

      for (const o of allOrders) {
        totalPicks += o.total_picks || 0;
        totalAnomalies += o.anomaly_picks || 0;
        totalCorrect += o.correct_picks || 0;

        // Week bucket (ISO week)
        const d = new Date(o.order_date + 'T00:00:00');
        const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000);
        const weekNum = Math.ceil((dayOfYear + 1) / 7);
        const weekKey = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
        if (!weekMap[weekKey]) weekMap[weekKey] = { week: weekKey, orders: 0, picks: 0, anomalies: 0, correct: 0 };
        weekMap[weekKey].orders++;
        weekMap[weekKey].picks += o.total_picks || 0;
        weekMap[weekKey].anomalies += o.anomaly_picks || 0;
        weekMap[weekKey].correct += o.correct_picks || 0;

        // Analyze individual picks
        const picks = o.picks || [];
        for (const p of picks) {
          if (p.status !== 'anomaly') continue;
          const et = p.errorType || 'unknown';
          errorTypes[et] = (errorTypes[et] || 0) + 1;

          if (p.sku) skuCounts[p.sku] = (skuCounts[p.sku] || 0) + 1;
          if (p.bin) binCounts[p.bin] = (binCounts[p.bin] || 0) + 1;

          if (p.expectedBin && p.bin) {
            const routeKey = `${p.expectedBin}→${p.bin}`;
            if (!routeMap[routeKey]) routeMap[routeKey] = { from: p.expectedBin, to: p.bin, count: 0, skus: [] };
            routeMap[routeKey].count++;
            if (!routeMap[routeKey].skus.includes(p.sku)) routeMap[routeKey].skus.push(p.sku);
          }

          // Section heatmap (extract area letter)
          if (p.bin) {
            const m = p.bin.match(/^MA-([A-Z])/i);
            if (m) {
              const area = m[1].toUpperCase();
              sectionAnomalies[area] = (sectionAnomalies[area] || 0) + 1;
            }
          }
        }

        // FG components
        for (const fg of (o.fg_orders || [])) {
          for (const c of (fg.components || [])) {
            if (c.status !== 'anomaly') continue;
            const et = c.errorType || 'unknown';
            errorTypes[et] = (errorTypes[et] || 0) + 1;
            if (c.sku) skuCounts[c.sku] = (skuCounts[c.sku] || 0) + 1;
            if (c.bin) binCounts[c.bin] = (binCounts[c.bin] || 0) + 1;
          }
        }
      }

      // Sort and limit
      const topSkus = Object.entries(skuCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([sku, count]) => ({ sku, count }));
      const topBins = Object.entries(binCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([bin, count]) => ({ bin, count }));
      const repeatRoutes = Object.values(routeMap).filter(r => r.count >= 2).sort((a, b) => b.count - a.count).slice(0, 15);
      const weeklyTrend = Object.values(weekMap).sort((a, b) => a.week.localeCompare(b.week));

      // Anomaly rate
      const anomalyRate = totalPicks > 0 ? ((totalAnomalies / totalPicks) * 100) : 0;

      res.json({
        success: true,
        analytics: {
          summary: { totalOrders: allOrders.length, totalPicks, totalAnomalies, totalCorrect, anomalyRate: Math.round(anomalyRate * 10) / 10 },
          weeklyTrend,
          errorTypes: Object.entries(errorTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
          topSkus,
          topBins,
          repeatRoutes,
          sectionHeatmap: Object.entries(sectionAnomalies).sort((a, b) => b[1] - a[1]).map(([section, count]) => ({ section, count })),
        },
      });
    } catch (err) {
      console.error('Analytics error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/pick-anomalies/stats
   * Aggregated KPI stats across ALL orders (not paginated).
   * Zero Cin7 API calls — Supabase only.
   */
  app.get('/api/pick-anomalies/stats', async (req, res) => {
    try {
      // Use Supabase REST API to aggregate across all orders
      // sbGetAll paginates automatically (Supabase default limit = 1000 rows)
      const allOrders = await sbGetAll('pick_anomaly_orders',
        'select=total_picks,correct_picks,anomaly_picks,fg_count,reviewed'
      );

      let totalOrders = 0, totalPicks = 0, totalCorrect = 0, totalAnomalies = 0, totalFg = 0, totalReviewed = 0;
      let anomalyOrders = 0; // Orders that have anomalies (for reviewed KPI)
      let anomalyOrdersReviewed = 0; // Anomaly orders that have been reviewed
      for (const o of allOrders) {
        totalOrders++;
        totalPicks    += o.total_picks    || 0;
        totalCorrect  += o.correct_picks  || 0;
        totalAnomalies += o.anomaly_picks || 0;
        totalFg       += o.fg_count       || 0;
        if (o.reviewed) totalReviewed++;
        // Reviewed KPI: only count orders WITH anomalies
        if ((o.anomaly_picks || 0) > 0) {
          anomalyOrders++;
          if (o.reviewed) anomalyOrdersReviewed++;
        }
      }

      res.json({
        success: true,
        stats: {
          orders: totalOrders,
          picks: totalPicks,
          correct: totalCorrect,
          anomalies: totalAnomalies,
          fg: totalFg,
          reviewed: totalReviewed,
          anomalyOrders,
          anomalyOrdersReviewed,
        },
      });
    } catch (err) {
      console.error('Stats error:', err);
      // Return zeros instead of failing — KPIs are non-critical
      res.json({
        success: true,
        stats: { orders: 0, picks: 0, correct: 0, anomalies: 0, fg: 0, reviewed: 0 },
      });
    }
  });

  /**
   * GET /api/pick-anomalies/stock-check?skus=SKU1,SKU2&bins=BIN1,BIN2
   * Returns stock snapshot data for given SKU+bin combos from cin7_mirror.stock_snapshot
   */
  app.get('/api/pick-anomalies/stock-check', async (req, res) => {
    try {
      const { skus, bins } = req.query;
      if (!skus || !bins) return res.json({ success: true, stock: {}, syncedAt: null });

      const skuList = skus.split(',').map(s => s.trim()).filter(Boolean);
      const binList = bins.split(',').map(b => b.trim()).filter(Boolean);
      if (!skuList.length || !binList.length) return res.json({ success: true, stock: {}, syncedAt: null });

      // Query cin7_mirror.stock_snapshot for all matching SKU+bin combos
      const skuIn = skuList.map(s => `"${s}"`).join(',');
      const binIn = binList.map(b => `"${b}"`).join(',');
      const url = `${SUPABASE_URL}/rest/v1/stock_snapshot?select=sku,bin,on_hand,allocated,available,synced_at&sku=in.(${encodeURIComponent(skuIn)})&bin=in.(${encodeURIComponent(binIn)})`;
      const snapRes = await fetch(url, {
        headers: {
          'apikey': SUPABASE_ANON,
          'Authorization': `Bearer ${SUPABASE_ANON}`,
          'Accept-Profile': 'cin7_mirror',
          'Content-Type': 'application/json',
        },
      });

      if (!snapRes.ok) {
        console.warn('Stock check failed:', snapRes.status);
        return res.json({ success: true, stock: {}, syncedAt: null });
      }

      const rows = await snapRes.json();

      // Build lookup: { "SKU|BIN": { on_hand, allocated, available, synced_at } }
      const stock = {};
      let latestSync = null;
      for (const r of rows) {
        const key = `${r.sku}|${r.bin}`;
        stock[key] = {
          on_hand: parseFloat(r.on_hand) || 0,
          allocated: parseFloat(r.allocated) || 0,
          available: parseFloat(r.available) || 0,
          synced_at: r.synced_at,
        };
        if (!latestSync || r.synced_at > latestSync) latestSync = r.synced_at;
      }

      res.json({ success: true, stock, syncedAt: latestSync });
    } catch (err) {
      console.error('Stock check error:', err);
      res.json({ success: true, stock: {}, syncedAt: null });
    }
  });

  /**
   * GET /api/pick-anomalies/recent-transfers?sku=SKU&fromBin=BIN&toBin=BIN
   * Check if a transfer for this SKU+direction was created recently (48h)
   */
  app.get('/api/pick-anomalies/recent-transfers', async (req, res) => {
    try {
      const { sku, fromBin, toBin } = req.query;
      if (!sku) return res.json({ success: true, recent: [] });

      let query = `select=*&sku=eq.${encodeURIComponent(sku)}&order=corrected_at.desc&limit=5`;
      if (fromBin) query += `&from_bin=eq.${encodeURIComponent(fromBin)}`;
      if (toBin) query += `&to_bin=eq.${encodeURIComponent(toBin)}`;

      // Only transfers from the last 48h
      const cutoff = new Date(Date.now() - 48 * 3600000).toISOString();
      query += `&corrected_at=gte.${cutoff}`;

      const rows = await sbGet('pick_anomaly_corrections', query);
      res.json({ success: true, recent: rows });
    } catch (err) {
      console.error('Recent transfers check error:', err);
      res.json({ success: true, recent: [] });
    }
  });

  /**
   * POST /api/pick-anomalies/review
   * Mark an order as reviewed
   */
  app.post('/api/pick-anomalies/review', async (req, res) => {
    try {
      const { orderNumber, userEmail } = req.body;
      if (!orderNumber) return res.status(400).json({ success: false, error: 'orderNumber required' });
      await markOrderReviewed(orderNumber, userEmail);
      res.json({ success: true, orderNumber });
    } catch (err) {
      console.error('❌ Review error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/refresh-dates
   * One-time bulk refresh: update fulfilled_date for all orders missing it.
   * Fetches sale detail from Cin7 for each order, extracts ShipmentDate.
   */
  app.post('/api/pick-anomalies/refresh-dates', async (req, res) => {
    try {
      // Fetch orders missing fulfilled_date OR invoice_date
      const orders = await sbGet('pick_anomaly_orders',
        'select=order_number,sale_id,fulfilled_date,invoice_date&or=(fulfilled_date.is.null,invoice_date.is.null)&limit=200'
      );
      if (!orders.length) {
        return res.json({ success: true, updated: 0, message: 'All orders already have dates' });
      }

      console.log(`🔄 Refreshing dates for ${orders.length} orders...`);
      let updated = 0;
      let errors = 0;

      for (const order of orders) {
        try {
          await delay(RATE_DELAY);
          const detail = await cin7Get(`sale?ID=${order.sale_id}`);

          let shipDate = null;
          let invDate = null;

          // Extract ShipmentDate
          for (const ful of (detail.Fulfilments || detail.Fulfillments || [])) {
            if (ful.Ship && ful.Ship.Lines && ful.Ship.Lines[0] && ful.Ship.Lines[0].ShipmentDate) {
              shipDate = ful.Ship.Lines[0].ShipmentDate;
              break;
            }
          }

          // Extract InvoiceDate
          if (detail.Invoices && detail.Invoices[0] && detail.Invoices[0].InvoiceDate) {
            invDate = detail.Invoices[0].InvoiceDate;
          }

          const patch = {};
          if (!order.fulfilled_date && (shipDate || invDate)) {
            patch.fulfilled_date = (shipDate || invDate).split('T')[0];
          }
          if (!order.invoice_date && invDate) {
            patch.invoice_date = invDate.split('T')[0];
          }

          if (Object.keys(patch).length) {
            await sbPatch('pick_anomaly_orders', `order_number=eq.${order.order_number}`, patch);
            updated++;
            console.log(`  ✅ ${order.order_number}: ${JSON.stringify(patch)}`);
          } else {
            console.log(`  ⚠️ ${order.order_number}: no dates found in Cin7`);
          }
        } catch (err) {
          errors++;
          console.warn(`  ❌ ${order.order_number}: ${err.message}`);
        }
      }

      console.log(`🔄 Refresh complete: ${updated} updated, ${errors} errors`);
      res.json({ success: true, updated, errors, total: orders.length });
    } catch (err) {
      console.error('❌ Refresh dates error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/pick-anomalies/refresh-locators
   * Re-evaluate picks for existing orders using CURRENT stock_locator data from cin7_mirror.products.
   * Fixes false anomalies caused by stale locator data.
   * Body (optional): { orderNumbers: ["SO-XXXXX"] } — if omitted, refreshes ALL orders.
   */
  app.post('/api/pick-anomalies/refresh-locators', async (req, res) => {
    try {
      const { orderNumbers } = req.body || {};

      // Fetch orders to refresh
      let query = 'select=order_number,picks,fg_orders,total_picks,correct_picks,anomaly_picks,fg_count';
      if (orderNumbers && orderNumbers.length) {
        const nums = orderNumbers.map(n => `"${n}"`).join(',');
        query += `&order_number=in.(${encodeURIComponent(nums)})`;
      }
      const orders = await sbGetAll('pick_anomaly_orders', query);

      if (!orders.length) {
        return res.json({ success: true, refreshed: 0, message: 'No orders to refresh' });
      }

      console.log(`🔄 Refreshing locators for ${orders.length} orders...`);

      // Collect all unique SKUs across all orders
      const allSkus = new Set();
      for (const o of orders) {
        const picks = typeof o.picks === 'string' ? JSON.parse(o.picks) : (o.picks || []);
        for (const p of picks) if (p.sku) allSkus.add(p.sku);
        // FG components
        const fgOrders = typeof o.fg_orders === 'string' ? JSON.parse(o.fg_orders) : (o.fg_orders || []);
        for (const fg of fgOrders) {
          for (const c of (fg.components || [])) if (c.sku) allSkus.add(c.sku);
        }
      }

      // Batch fetch current locators
      const locators = await fetchLocators([...allSkus]);
      console.log(`📍 Fetched ${locators.size} locators for ${allSkus.size} SKUs`);

      let refreshed = 0;
      let changed = 0;
      let errors = 0;

      for (const order of orders) {
        try {
          const picks = typeof order.picks === 'string' ? JSON.parse(order.picks) : (order.picks || []);
          let orderChanged = false;

          // Re-evaluate each pick
          for (const pick of picks) {
            const info = locators.get(pick.sku);
            const newExpected = info?.locator || null;
            const oldExpected = pick.expectedBin || null;
            const oldStatus = pick.status;

            if (newExpected !== oldExpected) {
              pick.expectedBin = newExpected;

              // Re-classify the pick
              if (!pick.hasBin) {
                if (newExpected === 'BOM' || newExpected === 'Production') {
                  pick.status = 'no_bin_assembly';
                  pick.reason = newExpected.toLowerCase();
                  pick.errorType = null;
                } else if (newExpected && newExpected.startsWith('MA-')) {
                  pick.status = 'no_bin_suspect';
                  pick.errorType = null;
                } else {
                  pick.status = 'no_bin_ok';
                  pick.errorType = null;
                }
              } else if (!newExpected || newExpected === '0' || newExpected === 'BOM' || newExpected === 'Production' || !newExpected.startsWith('MA-')) {
                pick.status = 'correct';
                pick.errorType = null;
              } else if (pick.bin === newExpected) {
                pick.status = 'correct';
                pick.errorType = null;
              } else {
                pick.status = 'anomaly';
                pick.errorType = classifyError(pick.bin, newExpected);
              }

              if (oldStatus !== pick.status || oldExpected !== newExpected) {
                orderChanged = true;
              }
            }
          }

          // Re-evaluate FG components too
          const fgOrders = typeof order.fg_orders === 'string' ? JSON.parse(order.fg_orders) : (order.fg_orders || []);
          for (const fg of fgOrders) {
            for (const comp of (fg.components || [])) {
              const info = locators.get(comp.sku);
              const newExpected = info?.locator || null;
              if (newExpected !== comp.expectedBin) {
                comp.expectedBin = newExpected;
                const compBin = comp.bin || null;
                const isCorrect = !compBin || !newExpected || !newExpected.startsWith('MA-') || compBin === newExpected;
                comp.status = isCorrect ? 'correct' : 'anomaly';
                comp.errorType = isCorrect ? null : classifyError(compBin, newExpected);
                orderChanged = true;
              }
            }
          }

          if (orderChanged) {
            const filteredPicks = picks.filter(p => p.status === 'correct' || p.status === 'anomaly');
            const correctCount = filteredPicks.filter(p => p.status === 'correct').length;
            const anomalyCount = filteredPicks.filter(p => p.status === 'anomaly').length;

            await sbPatch('pick_anomaly_orders', `order_number=eq.${order.order_number}`, {
              picks,
              fg_orders: fgOrders,
              total_picks: filteredPicks.length,
              correct_picks: correctCount,
              anomaly_picks: anomalyCount,
            });

            await logAction({
              order_number: order.order_number,
              action: 'locators_refreshed',
              details: `Locators refreshed: ${correctCount}✅ ${anomalyCount}⚠️ (was ${order.correct_picks}✅ ${order.anomaly_picks}⚠️)`,
              user_email: 'system@locator-refresh',
            });

            changed++;
            console.log(`  ✅ ${order.order_number}: ${order.correct_picks}✅/${order.anomaly_picks}⚠️ → ${correctCount}✅/${anomalyCount}⚠️`);
          }

          refreshed++;
        } catch (err) {
          errors++;
          console.warn(`  ❌ ${order.order_number}: ${err.message}`);
        }
      }

      console.log(`🔄 Locator refresh complete: ${refreshed} checked, ${changed} changed, ${errors} errors`);

      // ── Phase 2: Anomaly confidence classification ──
      // Classify ALL orders (not just changed ones) so every anomaly gets suspect/confirmed badge
      console.log(`🧠 Classifying anomaly confidence for ${orders.length} orders...`);
      const allAnomalyPairs = [];
      for (const order of orders) {
        const picks = typeof order.picks === 'string' ? JSON.parse(order.picks) : (order.picks || []);
        for (const p of picks) {
          if (p.status === 'anomaly' && p.sku && p.bin) allAnomalyPairs.push({ sku: p.sku, bin: p.bin });
        }
        const fgOrd = typeof order.fg_orders === 'string' ? JSON.parse(order.fg_orders) : (order.fg_orders || []);
        for (const fg of fgOrd) {
          for (const c of (fg.components || [])) {
            if (c.status === 'anomaly' && c.sku && c.bin) allAnomalyPairs.push({ sku: c.sku, bin: c.bin });
          }
        }
      }

      let classifiedCount = 0;
      let suspectCount = 0;
      let confirmedCount = 0;

      if (allAnomalyPairs.length) {
        const stockMap = await fetchStockForBins(allAnomalyPairs);
        console.log(`📦 Fetched stock data for ${stockMap.size} SKU+bin combos`);

        for (const order of orders) {
          const picks = typeof order.picks === 'string' ? JSON.parse(order.picks) : (order.picks || []);
          const fgOrders = typeof order.fg_orders === 'string' ? JSON.parse(order.fg_orders) : (order.fg_orders || []);
          let needsSave = false;

          for (const p of picks) {
            if (p.status === 'anomaly') {
              const { confidence, note } = classifyAnomalyConfidence(p, stockMap);
              if (p.anomalyConfidence !== confidence || p.anomalyNote !== note) {
                p.anomalyConfidence = confidence;
                p.anomalyNote = note;
                needsSave = true;
              }
              classifiedCount++;
              if (confidence === 'suspect') suspectCount++;
              else confirmedCount++;
            } else {
              if (p.anomalyConfidence) { delete p.anomalyConfidence; delete p.anomalyNote; needsSave = true; }
            }
          }
          for (const fg of fgOrders) {
            for (const c of (fg.components || [])) {
              if (c.status === 'anomaly') {
                const { confidence, note } = classifyAnomalyConfidence(c, stockMap);
                if (c.anomalyConfidence !== confidence || c.anomalyNote !== note) {
                  c.anomalyConfidence = confidence;
                  c.anomalyNote = note;
                  needsSave = true;
                }
                classifiedCount++;
                if (confidence === 'suspect') suspectCount++;
                else confirmedCount++;
              } else {
                if (c.anomalyConfidence) { delete c.anomalyConfidence; delete c.anomalyNote; needsSave = true; }
              }
            }
          }

          if (needsSave) {
            try {
              await sbPatch('pick_anomaly_orders', `order_number=eq.${order.order_number}`, {
                picks,
                fg_orders: fgOrders,
              });
            } catch (err) {
              console.warn(`  ⚠️ Failed to save confidence for ${order.order_number}: ${err.message}`);
            }
          }
        }
      }

      console.log(`🧠 Confidence: ${classifiedCount} anomalies classified — ${suspectCount} suspect, ${confirmedCount} confirmed`);
      res.json({ success: true, refreshed, changed, errors, total: orders.length, confidence: { classified: classifiedCount, suspect: suspectCount, confirmed: confirmedCount } });
    } catch (err) {
      console.error('❌ Refresh locators error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/pick-anomalies/logs?orderNumber=SO-XXXXX
   * Fetch action logs for a specific order
   */
  app.get('/api/pick-anomalies/logs', async (req, res) => {
    try {
      const { orderNumber } = req.query;
      if (!orderNumber) return res.status(400).json({ success: false, error: 'orderNumber required' });
      const logs = await getOrderLogs(orderNumber);
      res.json({ success: true, logs });
    } catch (err) {
      console.error('❌ Logs fetch error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registerPickAnomalyRoutes, syncNewOrders, loadHistory, createCorrectionTransfer, markOrderReviewed, getOrderLogs, logAction };
