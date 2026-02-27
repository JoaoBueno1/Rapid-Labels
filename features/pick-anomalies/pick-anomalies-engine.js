/**
 * Pick Anomalies — Backend Engine (v2 — Persistent History)
 * 
 * Architecture:
 *   - All analysis results are saved to Supabase (pick_anomaly_orders table)
 *   - Auto-sync: on page load, backend fetches new orders since last sync date
 *   - Frontend loads history from Supabase via /api/pick-anomalies/history
 *   - Corrections (Stock Transfers) are tracked in pick_anomaly_corrections
 *   - No manual date picker needed — system auto-continues from last sync
 *
 * DATE HANDLING (UpdatedSince):
 *   - Cin7 saleList `UpdatedSince` filters by LastModifiedOn (NOT OrderDate)
 *   - This CORRECTLY catches late-fulfilled orders (e.g. order from Feb 24 fulfilled Mar 1)
 *   - We use dateFrom = lastSyncDate (NOT +1 day) to avoid gap on orders modified late in the day
 *   - existingNumbers dedup prevents double-processing on re-fetches
 *   - Rolling 45-day FLOOR_DATE on OrderDate filters out noise (old orders with credits/adjustments)
 *   - When 50-order cap is hit, last_synced_date is NOT advanced — remaining orders fetched next sync
 *
 * OPTIMIZATIONS:
 *   - Rate-limited: 2.5s between Cin7 calls (~24/min, safe margin)
 *   - Supabase stock_locator fetched in batch
 *   - Cap of 50 orders per sync run
 *   - Only orders with OrderDate within last 90 days are processed
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
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || '';

const RATE_DELAY = 2500;   // 2.5s between Cin7 calls — safe margin, matches sync-service
const MAX_ORDERS_PER_RUN = 50;
const MW_LOCATION_ID = '907821e3-c06b-4bf1-a8af-888bc3a2031f';

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

async function sbPost(table, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
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
  } else if (filter === 'corrected') {
    // We'll join corrections on the frontend side
    query += '&anomaly_picks=gt.0';
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
    // UpdatedSince=lastDate re-fetches the same day, but existingNumbers
    // dedup ensures we never double-process. This catches any orders
    // modified on lastDate AFTER the previous sync ran.
    const dateFrom = lastDate;
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
  let page = 1;

  // ── FLOOR_DATE: Rolling 45-day lookback ──
  // Orders with OrderDate older than 45 days are noise (credits, adjustments,
  // late payments that trigger LastModifiedOn changes in Cin7).
  // 45 days covers any reasonable pick-to-invoice delay while filtering out
  // old orders resurfacing due to credit notes or payment updates.
  const floorDate = new Date();
  floorDate.setDate(floorDate.getDate() - 45);
  const FLOOR_DATE = floorDate.toISOString().split('T')[0];
  const VALID_FULFILMENT = ['PACKED', 'DISPATCHED', 'FULFILLED', 'SHIPPED'];
  const VALID_ORDER_STATUS = ['INVOICED', 'COMPLETED'];

  while (true) {
    await delay(RATE_DELAY);
    const data = await cin7Get(
      `saleList?Location=${encodeURIComponent('Main Warehouse')}&UpdatedSince=${dateFrom}T00:00:00Z&UpdatedBefore=${dateTo}T23:59:59Z&Page=${page}&Limit=100`
    );
    const sales = data.SaleList || [];
    if (page === 1) console.log(`📋 Page 1: ${sales.length} sales...`);

    const filtered = sales.filter(s => {
      const ful = (s.FulFilmentStatus || '').toUpperCase();
      const ost = (s.OrderStatus || s.Status || '').toUpperCase();
      const isValidStatus = VALID_FULFILMENT.includes(ful) || VALID_ORDER_STATUS.includes(ost);
      const orderDate = (s.OrderDate || '').split('T')[0];
      const isRecent = orderDate >= FLOOR_DATE;
      return isValidStatus && isRecent;
    });
    orders.push(...filtered);
    if (sales.length < 100) break;
    page++;
  }

  console.log(`📋 Found ${orders.length} valid (Invoiced/Packed/Shipped) MW orders`);

  // Check which orders we already have in Supabase (skip duplicates)
  let existingNumbers = new Set();
  if (orders.length > 0) {
    try {
      const nums = orders.map(o => `"${o.OrderNumber}"`).join(',');
      const existing = await sbGet('pick_anomaly_orders',
        `select=order_number&order_number=in.(${encodeURIComponent(nums)})`
      );
      existingNumbers = new Set(existing.map(e => e.order_number));
    } catch { /* ignore */ }
  }

  const newOrders = orders.filter(o => !existingNumbers.has(o.OrderNumber));
  console.log(`📋 ${newOrders.length} new orders to process (${existingNumbers.size} already in history)`);

  let wasCapped = false;
  if (newOrders.length > MAX_ORDERS_PER_RUN) {
    console.log(`⚠️ Capping at ${MAX_ORDERS_PER_RUN} orders (${newOrders.length - MAX_ORDERS_PER_RUN} remaining for next sync)`);
    newOrders.length = MAX_ORDERS_PER_RUN;
    wasCapped = true;
  }

  // ── Step 2: Analyze each new order ──
  const results = [];

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

    // Save to Supabase immediately (upsert)
    try {
      await sbPost('pick_anomaly_orders', orderResult);
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

  // ── FIX: Only advance last_synced_date when ALL orders were processed ──
  // If capped at 50, keep the same dateFrom so next sync re-fetches remaining orders.
  // The existingNumbers dedup prevents double-processing of already-saved orders.
  const totalInDb = (syncMeta?.total_orders || 0) + results.length;
  const syncDate = wasCapped ? dateFrom : dateTo;
  await updateSyncMeta(syncDate, totalInDb, results.length);

  const lastSyncedAt = new Date().toISOString();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  if (wasCapped) {
    console.log(`✅ Sync complete (CAPPED): ${results.length} new orders saved, more remaining. Date NOT advanced (stays ${syncDate}). ${apiCallCount} API calls, ${elapsed}`);
  } else {
    console.log(`✅ Sync complete: ${results.length} new orders saved, synced to ${syncDate}. ${apiCallCount} API calls, ${elapsed}`);
  }

  return {
    success: true,
    newOrders: results.length,
    skippedExisting: existingNumbers.size,
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

  console.log('✅ Pick anomaly routes registered');

  /**
   * GET /api/pick-anomalies/stats
   * Aggregated KPI stats across ALL orders (not paginated).
   * Zero Cin7 API calls — Supabase only.
   */
  app.get('/api/pick-anomalies/stats', async (req, res) => {
    try {
      // Use Supabase REST API to aggregate across all orders
      const allOrders = await sbGet('pick_anomaly_orders',
        'select=total_picks,correct_picks,anomaly_picks,fg_count,reviewed'
      );

      let totalOrders = 0, totalPicks = 0, totalCorrect = 0, totalAnomalies = 0, totalFg = 0, totalReviewed = 0;
      for (const o of allOrders) {
        totalOrders++;
        totalPicks    += o.total_picks    || 0;
        totalCorrect  += o.correct_picks  || 0;
        totalAnomalies += o.anomaly_picks || 0;
        totalFg       += o.fg_count       || 0;
        if (o.reviewed) totalReviewed++;
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
