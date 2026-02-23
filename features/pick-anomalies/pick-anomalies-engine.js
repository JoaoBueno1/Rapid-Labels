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
 * OPTIMIZATIONS:
 *   - Rate-limited: 1.2s between Cin7 calls (~50/min, well under 60/min limit)
 *   - Supabase stock_locator fetched in batch
 *   - Cap of 50 orders per sync run
 *   - Only recent orders (last 90 days) are processed
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
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

const RATE_DELAY = 1200;
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
    const rows = await sbGet('pick_anomaly_sync', 'select=last_synced_date,last_synced_at,total_orders&id=eq.1');
    if (rows.length) return rows[0];
    return null;
  } catch (err) {
    console.warn('⚠️ Could not fetch sync metadata:', err.message);
    return null;
  }
}

async function updateSyncMeta(lastDate, totalOrders) {
  try {
    await sbPatch('pick_anomaly_sync', 'id=eq.1', {
      last_synced_date: lastDate,
      last_synced_at: new Date().toISOString(),
      total_orders: totalOrders,
    });
  } catch (err) {
    console.warn('⚠️ Could not update sync metadata:', err.message);
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

    // dateFrom = day after last sync, dateTo = today
    const fromDate = new Date(lastDate);
    fromDate.setDate(fromDate.getDate() + 1);
    const dateFrom = fromDate.toISOString().split('T')[0];
    const dateTo = today;

    if (dateFrom > dateTo) {
      console.log('📋 Already synced up to today, checking for updates on last day...');
      // Re-check today for any new fulfilled orders
      return await _analyzeAndSave(today, today, syncMeta);
    }

    console.log(`🔄 Syncing new orders: ${dateFrom} → ${dateTo} (last sync: ${lastDate})`);
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

  const FLOOR_DATE = '2026-02-20';
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

  if (newOrders.length > MAX_ORDERS_PER_RUN) {
    console.log(`⚠️ Capping at ${MAX_ORDERS_PER_RUN} orders`);
    newOrders.length = MAX_ORDERS_PER_RUN;
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

    const orderResult = {
      sale_id: order.SaleID,
      order_number: order.OrderNumber,
      order_date: order.OrderDate ? order.OrderDate.split('T')[0] : null,
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
    } catch (err) {
      console.warn(`⚠️ Failed to save ${order.OrderNumber} to Supabase:`, err.message);
    }

    console.log(`  [${i + 1}/${newOrders.length}] ${order.OrderNumber}: ${correctCount}✅ ${anomalyCount}⚠️ ${fgOrders.length}🔧`);
  }

  // Update sync metadata
  const totalInDb = (syncMeta?.total_orders || 0) + results.length;
  await updateSyncMeta(dateTo, totalInDb);

  const lastSyncedAt = new Date().toISOString();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';
  console.log(`✅ Sync complete: ${results.length} new orders saved, ${apiCallCount} API calls, ${elapsed}`);

  return {
    success: true,
    newOrders: results.length,
    skippedExisting: existingNumbers.size,
    apiCalls: apiCallCount,
    elapsed,
    syncedUpTo: dateTo,
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

  // Build audit comment for the line (visible inside Cin7 transfer)
  const lineComment = [
    `Pick Anomaly Correction — Created by API`,
    `Order: ${orderNumber || 'N/A'}`,
    `SKU: ${sku} × ${qty}`,
    `Wrong Bin (picked from): ${expectedBin}`,
    `Correct Bin (destination): ${pickedBin}`,
    `Correction Date: ${todayStr}`,
    `Pick ID: ${pickId || 'N/A'}`,
  ].join(' | ');

  // Reference field (header level, searchable in Cin7)
  const reference = `PA-${orderNumber || 'UNKNOWN'}-${todayStr}`;

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

  console.log(`📦 Created ${transferStatus} transfer: ${sku} ×${qty} FROM ${expectedBin} → TO ${pickedBin} | Ref: ${reference}`);
  return { ...result, transferId, transferRef, transferStatus, reference, comment: lineComment };
}

/**
 * Mark an order as reviewed (all picks verified by operator)
 */
async function markOrderReviewed(orderNumber) {
  try {
    await sbPatch('pick_anomaly_orders', `order_number=eq.${orderNumber}`, {
      reviewed: true,
      reviewed_at: new Date().toISOString(),
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
   * POST /api/pick-anomalies/review
   * Mark an order as reviewed
   */
  app.post('/api/pick-anomalies/review', async (req, res) => {
    try {
      const { orderNumber } = req.body;
      if (!orderNumber) return res.status(400).json({ success: false, error: 'orderNumber required' });
      await markOrderReviewed(orderNumber);
      res.json({ success: true, orderNumber });
    } catch (err) {
      console.error('❌ Review error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registerPickAnomalyRoutes, syncNewOrders, loadHistory, createCorrectionTransfer, markOrderReviewed };
