#!/usr/bin/env node
/**
 * Order Pipeline Sync — Cin7 → Supabase
 * 
 * Syncs Sales Orders and Stock Transfers from Cin7 API
 * into cin7_mirror.order_pipeline table.
 * 
 * Usage:
 *   node order-pipeline-sync.js              # Sync active orders (ORDERING/PICKING/PICKED/BACKORDERED) + open transfers
 *   node order-pipeline-sync.js --full       # Full sync: all orders created since March 2026
 *   node order-pipeline-sync.js --dry-run    # Show what would sync without writing
 *   node order-pipeline-sync.js --verbose    # Detailed logging
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// Load .env from project root
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// ============================================================
// CONFIG
// ============================================================

const CONFIG = {
  cin7: {
    accountId: process.env.CIN7_ACCOUNT_ID || '',
    apiKey: process.env.CIN7_API_KEY || '',
    baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
    pageSize: 500,
    maxRetries: 3,
    timeoutMs: 30000,
    throttleMs: 3500,
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    batchSize: 200,
  },
  // Sales Order statuses considered "open" for warehouse
  // ORDERING excluded — internal stage before authorization
  activeSaleStatuses: ['PICKING', 'PICKED', 'PACKING', 'BACKORDERED', 'ORDERED'],
  // Statuses that mean the order left the warehouse (keep 7 days for stats)
  completedStatuses: ['COMPLETED', 'VOIDED', 'CLOSED'],
  // Stock Transfer statuses considered open
  activeTransferStatuses: ['ORDERED', 'IN TRANSIT'],
  // Only sync orders created since this date
  sinceDate: '2026-03-01',
  // Known warehouse location IDs → names (for SO from_location)
  locationMap: {
    '907821e3-c06b-4bf1-a8af-888bc3a2031f': 'Main Warehouse',
    '2d84ecb5-69a0-467a-bd2c-7f84ebb5be92': 'Cairns',
    'a124b68b-afe1-41ec-9f1a-a9b33aca9b17': 'Brisbane',
    'f63dbc3c-c231-4c52-86cc-cc5275b2be72': 'Sydney',
    '12c1f2e6-1b8a-41e7-930a-e16b84131553': 'Sunshine Coast Warehouse',
    'e25742d4-bb13-4469-9128-3845daba98e8': 'Project Warehouse',
    'df40b7a5-5b68-476f-8fb6-37fd53b3f46d': 'Melbourne',
    '1096df99-f6b2-44e1-8550-bcc7fc6c7f98': 'Hobart',
    '28d235a5-c612-43b5-a737-5e2c922eea1d': 'Gold Coast',
    '4382b5c2-bb80-475d-a02e-18a73abee862': 'Gold Coast',
    'ed7ffa65-6d00-41de-9526-c27fcb2e3feb': 'Coffs Harbour',
    'f199081c-c20f-4af0-804f-b4696d881624': 'Coffs Harbour',
    'e4803ce0-384d-4c43-bffb-2f072793cc4e': 'Hobart',
    '1c74f86f-6170-4a9f-b253-3290a3a990c0': 'Gateway',
  },
};

// ============================================================
// CLI FLAGS
// ============================================================

const args = process.argv.slice(2);
const FLAGS = {
  full: args.includes('--full'),
  dryRun: args.includes('--dry-run'),
  verbose: args.includes('--verbose'),
};

// ============================================================
// LOGGING
// ============================================================

const log = (level, msg, data = {}) => {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'debug' && !FLAGS.verbose) return;
  else console.log(JSON.stringify(entry));
};

// ============================================================
// CIN7 API HTTP CLIENT
// ============================================================

const https = require('https');

let lastCallTime = 0;
let callCount = 0;

async function cin7Get(endpoint, params = {}) {
  // Throttle
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < CONFIG.cin7.throttleMs) {
    await new Promise(r => setTimeout(r, CONFIG.cin7.throttleMs - elapsed));
  }

  const qs = new URLSearchParams(params).toString();
  const urlPath = `/ExternalApi/v2/${endpoint}${qs ? '?' + qs : ''}`;

  let lastError;
  for (let attempt = 1; attempt <= CONFIG.cin7.maxRetries; attempt++) {
    try {
      const data = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'inventory.dearsystems.com',
          path: urlPath,
          headers: {
            'api-auth-accountid': CONFIG.cin7.accountId,
            'api-auth-applicationkey': CONFIG.cin7.apiKey,
          },
          timeout: CONFIG.cin7.timeoutMs,
        };
        const req = https.get(opts, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            lastCallTime = Date.now();
            callCount++;
            if (res.statusCode === 429) {
              reject(new Error('RATE_LIMITED'));
              return;
            }
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
              return;
            }
            try { resolve(JSON.parse(body)); }
            catch (e) { reject(new Error('Invalid JSON: ' + body.substring(0, 100))); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      });
      return data;
    } catch (err) {
      lastError = err;
      if (err.message === 'RATE_LIMITED') {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
        log('warn', `Rate limited, backing off ${backoff}ms`, { attempt });
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      if (attempt < CONFIG.cin7.maxRetries) {
        const backoff = 2000 * attempt;
        log('warn', `Retry ${attempt}/${CONFIG.cin7.maxRetries}: ${err.message}`, { endpoint });
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastError;
}

/**
 * Paginate through a Cin7 list endpoint
 */
async function cin7GetAll(endpoint, params = {}, listKey) {
  const allItems = [];
  let page = 1;
  let total = null;

  while (true) {
    const result = await cin7Get(endpoint, { ...params, Page: page, Limit: CONFIG.cin7.pageSize });
    if (total === null) total = result.Total || 0;

    const items = result[listKey] || [];
    allItems.push(...items);

    log('debug', `${endpoint} page ${page}: ${items.length} items (${allItems.length}/${total})`);

    if (items.length < CONFIG.cin7.pageSize || allItems.length >= total) break;
    page++;
  }

  return { items: allItems, total };
}

// ============================================================
// SUPABASE CLIENT
// ============================================================

function getSupabaseClient() {
  if (!CONFIG.supabase.url || !CONFIG.supabase.serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  }
  return createClient(CONFIG.supabase.url, CONFIG.supabase.serviceKey, {
    db: { schema: 'cin7_mirror' },
  });
}

// ============================================================
// FULFILMENT STATUS HELPERS (Advanced Sales)
// ============================================================

/**
 * Derive warehouse dashboard status from a single fulfilment's sub-statuses.
 * In Dear Systems, each fulfilment step goes NOT AVAILABLE → (active) → AUTHORISED.
 * AUTHORISED means that step is signed off / complete.
 */
function deriveFulfilmentStatus(f, soStatus) {
  // Fulfilled = everything done (picked + packed + shipped)
  if (f.FulFilmentStatus === 'FULFILLED') return 'COMPLETED';

  // Check from latest stage backwards
  const ship = f.Ship?.Status || '';
  const pack = f.Pack?.Status || '';
  const pick = f.Pick?.Status || '';

  // Ship authorized = shipped
  if (ship === 'AUTHORISED') return 'COMPLETED';
  // Pack authorized but not shipped = packed / ready to ship
  if (pack === 'AUTHORISED') return 'PACKING';
  // Pick authorized but not packed = picked
  if (pick === 'AUTHORISED') return 'PICKED';

  // Pick not available = waiting for stock / authorization
  if (pick === 'NOT AVAILABLE') return 'ORDERED';

  // Any other pick state (NOT AUTHORISED, etc.) = in picking phase
  // Use SO-level status if it gives us more info
  if (['PICKING', 'PICKED', 'PACKING'].includes(soStatus)) return soStatus;

  return 'PICKING';
}

/** Map fulfilment Pick sub-status to our dashboard vocabulary */
function deriveFulfilmentPickStatus(f) {
  const s = f.Pick?.Status || '';
  if (s === 'AUTHORISED') return 'PICKED';
  if (s === 'NOT AVAILABLE' || s === 'NOT AUTHORISED') return 'NOT PICKED';
  return 'PICKING'; // in progress
}

/** Map fulfilment Pack sub-status to our dashboard vocabulary */
function deriveFulfilmentPackStatus(f) {
  const s = f.Pack?.Status || '';
  if (s === 'AUTHORISED') return 'PACKED';
  if (s === 'NOT AVAILABLE' || s === 'NOT AUTHORISED') return 'NOT PACKED';
  return 'PACKING';
}

// ============================================================
// SYNC: SALES ORDERS
// ============================================================

async function syncSalesOrders(sb) {
  log('info', '── Syncing Sales Orders ──');

  let allOrders = [];

  if (FLAGS.full) {
    // Full sync: get all active-status orders created since March
    for (const status of CONFIG.activeSaleStatuses) {
      log('info', `Fetching SO status=${status} (CreatedSince ${CONFIG.sinceDate})...`);
      const { items, total } = await cin7GetAll('saleList', {
        Status: status,
        CreatedSince: CONFIG.sinceDate,
      }, 'SaleList');
      log('info', `  ${status}: ${items.length} of ${total}`);
      allOrders.push(...items);
    }

    // Also fetch recently completed to update cached rows
    log('info', 'Fetching recently completed orders...');
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    for (const status of ['COMPLETED', 'VOIDED', 'INVOICED', 'SHIPPING']) {
      try {
        const { items } = await cin7GetAll('saleList', {
          Status: status,
          UpdatedSince: oneHourAgo,
          CreatedSince: CONFIG.sinceDate,
        }, 'SaleList');
        if (items.length > 0) {
          log('info', `  ${status} (recently updated): ${items.length}`);
          allOrders.push(...items);
        }
      } catch (e) {
        log('debug', `  ${status}: skipped (${e.message})`);
      }
    }
  } else {
    // Incremental: only active statuses
    for (const status of CONFIG.activeSaleStatuses) {
      log('info', `Fetching SO status=${status} (CreatedSince ${CONFIG.sinceDate})...`);
      const { items, total } = await cin7GetAll('saleList', {
        Status: status,
        CreatedSince: CONFIG.sinceDate,
      }, 'SaleList');
      log('info', `  ${status}: ${items.length} of ${total}`);
      allOrders.push(...items);
    }
  }

  // Deduplicate by SaleID
  const seen = new Set();
  const unique = [];
  for (const o of allOrders) {
    if (!seen.has(o.SaleID)) {
      seen.add(o.SaleID);
      unique.push(o);
    }
  }

  log('info', `Total unique SO to upsert: ${unique.length}`);

  // Map to our schema
  const nowIso = new Date().toISOString();
  const isCompleted = (s) => CONFIG.completedStatuses.includes(s) || s === 'INVOICED';

  // ── Separate Simple vs Advanced Sales ──
  const simpleSales = unique.filter(o => o.Type !== 'Advanced Sale');
  const advancedSales = unique.filter(o => o.Type === 'Advanced Sale');
  log('info', `  Simple: ${simpleSales.length}, Advanced: ${advancedSales.length}`);

  // Map Simple Sales (always 1 fulfilment)
  const rows = simpleSales.map(o => ({
    id: o.SaleID,
    type: 'SO',
    number: o.OrderNumber,
    status: o.Status,
    order_date: o.OrderDate ? o.OrderDate.split('T')[0] : null,
    customer: o.Customer || null,
    pick_status: o.CombinedPickingStatus || null,
    pack_status: o.CombinedPackingStatus || null,
    ship_status: o.CombinedShippingStatus || null,
    invoice_status: o.CombinedInvoiceStatus || null,
    from_location: CONFIG.locationMap[o.OrderLocationID] || null,
    to_location: null,
    reference: o.CustomerReference || null,
    line_count: null,
    total_qty: null,
    updated_at: o.Updated || null,
    synced_at: nowIso,
    fulfilment_number: 1,
    ...(isCompleted(o.Status) ? { completed_at: nowIso } : {}),
  }));

  // ── Advanced Sales: fetch detail and create per-fulfilment rows ──
  for (const o of advancedSales) {
    try {
      const detail = await cin7Get('sale', { ID: o.SaleID });
      const fulfilments = detail.Fulfilments || [];

      if (fulfilments.length <= 1) {
        // Single fulfilment — treat like Simple Sale
        rows.push({
          id: o.SaleID,
          type: 'SO',
          number: o.OrderNumber,
          status: o.Status,
          order_date: o.OrderDate ? o.OrderDate.split('T')[0] : null,
          customer: o.Customer || null,
          pick_status: o.CombinedPickingStatus || null,
          pack_status: o.CombinedPackingStatus || null,
          ship_status: o.CombinedShippingStatus || null,
          invoice_status: o.CombinedInvoiceStatus || null,
          from_location: CONFIG.locationMap[o.OrderLocationID] || null,
          to_location: null,
          reference: o.CustomerReference || null,
          line_count: null,
          total_qty: null,
          updated_at: o.Updated || null,
          synced_at: nowIso,
          fulfilment_number: 1,
          ...(isCompleted(o.Status) ? { completed_at: nowIso } : {}),
        });
        continue;
      }

      // Multiple fulfilments — create one row per active fulfilment
      log('info', `  🔀 ${o.OrderNumber}: ${fulfilments.length} fulfilments`);
      for (const f of fulfilments) {
        const fNum = f.FulfillmentNumber || 1;
        if (f.FulFilmentStatus === 'VOIDED') continue; // skip voided

        // Derive per-fulfilment status from Pick/Pack/Ship authorization
        const fStatus = deriveFulfilmentStatus(f, o.Status);
        const fCompleted = fStatus === 'COMPLETED' || f.FulFilmentStatus === 'FULFILLED';

        rows.push({
          id: fNum === 1 ? o.SaleID : `${o.SaleID}_F${fNum}`,
          type: 'SO',
          number: o.OrderNumber,
          status: fCompleted ? 'COMPLETED' : fStatus,
          order_date: o.OrderDate ? o.OrderDate.split('T')[0] : null,
          customer: o.Customer || null,
          pick_status: deriveFulfilmentPickStatus(f),
          pack_status: deriveFulfilmentPackStatus(f),
          ship_status: f.Ship?.Status || null,
          invoice_status: null,
          from_location: CONFIG.locationMap[o.OrderLocationID] || null,
          to_location: null,
          reference: o.CustomerReference || null,
          line_count: f.Pick?.Lines?.length || null,
          total_qty: null,
          updated_at: o.Updated || null,
          synced_at: nowIso,
          fulfilment_number: fNum,
          ...(fCompleted ? { completed_at: o.Updated || nowIso } : {}),
        });
      }
    } catch (err) {
      // If detail fetch fails, fall back to single row from list data
      log('warn', `Failed to fetch detail for ${o.OrderNumber}: ${err.message}`);
      rows.push({
        id: o.SaleID,
        type: 'SO',
        number: o.OrderNumber,
        status: o.Status,
        order_date: o.OrderDate ? o.OrderDate.split('T')[0] : null,
        customer: o.Customer || null,
        pick_status: o.CombinedPickingStatus || null,
        pack_status: o.CombinedPackingStatus || null,
        ship_status: o.CombinedShippingStatus || null,
        invoice_status: o.CombinedInvoiceStatus || null,
        from_location: CONFIG.locationMap[o.OrderLocationID] || null,
        to_location: null,
        reference: o.CustomerReference || null,
        line_count: null,
        total_qty: null,
        updated_at: o.Updated || null,
        synced_at: nowIso,
        fulfilment_number: 1,
        ...(isCompleted(o.Status) ? { completed_at: nowIso } : {}),
      });
    }
  }

  // Collect all synced IDs for completion detection
  const freshIds = new Set(rows.map(r => r.id));

  if (FLAGS.dryRun) {
    log('info', '[DRY RUN] Would upsert ' + rows.length + ' sales orders');
    rows.slice(0, 5).forEach(r => log('info', `  ${r.number} | ${r.status} | ${r.customer?.substring(0, 30)}`));
    return { count: rows.length, ids: freshIds };
  }

  // Upsert in batches
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CONFIG.supabase.batchSize) {
    const batch = rows.slice(i, i + CONFIG.supabase.batchSize);
    const { error } = await sb
      .from('order_pipeline')
      .upsert(batch, { onConflict: 'id' });
    if (error) {
      log('error', 'Failed to upsert SO batch', { error: error.message, offset: i });
      throw error;
    }
    upserted += batch.length;
    log('debug', `Upserted SO batch ${i}-${i + batch.length}`);
  }

  log('info', `✅ Upserted ${upserted} sales orders`);
  return { count: upserted, ids: freshIds };
}

// ============================================================
// SYNC: STOCK TRANSFERS
// ============================================================

async function syncStockTransfers(sb) {
  log('info', '── Syncing Stock Transfers ──');

  let allTransfers = [];

  for (const status of CONFIG.activeTransferStatuses) {
    log('info', `Fetching TR status=${status}...`);
    const { items, total } = await cin7GetAll('stocktransferList', {
      Status: status,
    }, 'StockTransferList');
    log('info', `  ${status}: ${items.length} of ${total}`);
    allTransfers.push(...items);
  }

  // Skip completed transfers — warehouse team only needs active ones.
  // Cleanup will delete any that went COMPLETED since last sync.
  if (false && FLAGS.full) {
    log('info', 'Fetching recently completed transfers (page 1 only)...');
    const rawResp = await cin7Get('stocktransferList', {
      Status: 'COMPLETED',
      Limit: 500,
      Page: 1,
    });
    const completedItems = rawResp?.StockTransferList || [];
    // Only take those modified in last 48h
    const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
    const recent = completedItems.filter(t => t.LastModifiedOn && new Date(t.LastModifiedOn) > twoDaysAgo);
    log('info', `  COMPLETED (last 48h): ${recent.length} of ${completedItems.length} on page 1`);
    allTransfers.push(...recent);
  }

  // Deduplicate by TaskID
  const seen = new Set();
  const unique = [];
  for (const t of allTransfers) {
    if (!seen.has(t.TaskID)) {
      seen.add(t.TaskID);
      unique.push(t);
    }
  }

  log('info', `Total unique TR to upsert: ${unique.length}`);

  // Map to our schema
  const rows = unique.map(t => {
    // Extract base warehouse name (before the colon for bin location)
    const fromBase = t.FromLocation?.split(':')[0]?.trim() || t.FromLocation;
    const toBase = t.ToLocation?.split(':')[0]?.trim() || t.ToLocation;

    return {
      id: t.TaskID,
      type: 'TR',
      number: t.Number,
      status: t.Status,
      order_date: t.CompletionDate ? t.CompletionDate.split('T')[0]
                : t.DepartureDate ? t.DepartureDate.split('T')[0]
                : t.LastModifiedOn ? t.LastModifiedOn.split('T')[0]
                : null,
      customer: `→ ${toBase}`,
      pick_status: null,
      pack_status: null,
      ship_status: t.Status === 'IN TRANSIT' ? 'IN TRANSIT' : t.Status === 'COMPLETED' ? 'DELIVERED' : 'PENDING',
      invoice_status: null,
      from_location: fromBase,
      to_location: toBase,
      reference: t.Reference || null,
      line_count: null,
      total_qty: null,
      updated_at: t.LastModifiedOn || null,
      synced_at: new Date().toISOString(),
    };
  });

  // Collect all synced IDs for completion detection
  const freshIds = new Set(rows.map(r => r.id));

  if (FLAGS.dryRun) {
    log('info', '[DRY RUN] Would upsert ' + rows.length + ' stock transfers');
    rows.slice(0, 5).forEach(r => log('info', `  ${r.number} | ${r.status} | ${r.from_location} → ${r.to_location}`));
    return { count: rows.length, ids: freshIds };
  }

  // Upsert in batches
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CONFIG.supabase.batchSize) {
    const batch = rows.slice(i, i + CONFIG.supabase.batchSize);
    const { error } = await sb
      .from('order_pipeline')
      .upsert(batch, { onConflict: 'id' });
    if (error) {
      log('error', 'Failed to upsert TR batch', { error: error.message, offset: i });
      throw error;
    }
    upserted += batch.length;
  }

  log('info', `✅ Upserted ${upserted} stock transfers`);
  return { count: upserted, ids: freshIds };
}

// ============================================================
// DETECT COMPLETED: Mark orders that disappeared from active
// ============================================================

async function detectCompleted(sb, freshSoIds, freshTrIds) {
  const nowIso = new Date().toISOString();
  const completedStatuses = [...CONFIG.completedStatuses, 'INVOICED'];

  // Find SO in cache that are still marked active but weren't in the fresh fetch
  const { data: cachedSo, error: soErr } = await sb
    .from('order_pipeline')
    .select('id, status, updated_at')
    .eq('type', 'SO')
    .not('status', 'in', `(${completedStatuses.join(',')})`);

  let soMarked = 0;
  if (!soErr && cachedSo) {
    const disappeared = cachedSo.filter(r => !freshSoIds.has(r.id));
    if (disappeared.length > 0) {
      log('info', `🔍 Detected ${disappeared.length} SO completed since last sync`);
      // Use updated_at from cached row as approximate completion time
      for (const row of disappeared) {
        const completedAt = row.updated_at || nowIso;
        const { error } = await sb
          .from('order_pipeline')
          .update({ status: 'COMPLETED', completed_at: completedAt, synced_at: nowIso })
          .eq('id', row.id);
        if (error) log('warn', 'Failed to mark SO completed', { id: row.id, error: error.message });
        else soMarked++;
      }
    }
  }

  // Find TR in cache that are still marked active but weren't in the fresh fetch
  const { data: cachedTr, error: trErr } = await sb
    .from('order_pipeline')
    .select('id, status, updated_at')
    .eq('type', 'TR')
    .not('status', 'in', `(${completedStatuses.join(',')})`);

  let trMarked = 0;
  if (!trErr && cachedTr) {
    const disappeared = cachedTr.filter(r => !freshTrIds.has(r.id));
    if (disappeared.length > 0) {
      log('info', `🔍 Detected ${disappeared.length} TR completed since last sync`);
      for (const row of disappeared) {
        const completedAt = row.updated_at || nowIso;
        const { error } = await sb
          .from('order_pipeline')
          .update({ status: 'COMPLETED', completed_at: completedAt, synced_at: nowIso })
          .eq('id', row.id);
        if (error) log('warn', 'Failed to mark TR completed', { id: row.id, error: error.message });
        else trMarked++;
      }
    }
  }

  if (soMarked + trMarked > 0) {
    log('info', `✅ Marked ${soMarked} SO + ${trMarked} TR as completed`);
  } else {
    log('info', '  No newly completed orders detected');
  }

  return soMarked + trMarked;
}

// ============================================================
// CLEANUP: Remove completed orders from pipeline
// ============================================================

async function cleanupCompleted(sb) {
  if (FLAGS.dryRun) {
    log('info', '[DRY RUN] Would cleanup completed orders');
    return 0;
  }

  // Keep completed orders for 7 days (for daily stats chart), then delete
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  // Delete SO that are COMPLETED/VOIDED/CLOSED/INVOICED AND completed_at > 7 days
  const { data, error } = await sb
    .from('order_pipeline')
    .delete()
    .eq('type', 'SO')
    .in('status', [...CONFIG.completedStatuses, 'INVOICED'])
    .lt('completed_at', sevenDaysAgo)
    .select('id');

  const deleted = data?.length || 0;
  if (error) {
    log('warn', 'Cleanup error', { error: error.message });
  } else if (deleted > 0) {
    log('info', `🗑️  Cleaned up ${deleted} completed SO (>7d)`);
  }

  // Delete completed transfers (>7 days)
  const { data: trData, error: trErr } = await sb
    .from('order_pipeline')
    .delete()
    .eq('type', 'TR')
    .eq('status', 'COMPLETED')
    .lt('completed_at', sevenDaysAgo)
    .select('id');

  const trDeleted = trData?.length || 0;
  if (!trErr && trDeleted > 0) {
    log('info', `🗑️  Cleaned up ${trDeleted} completed TR (>7d)`);
  }

  return deleted + trDeleted;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const startTime = Date.now();
  callCount = 0; // Reset API call counter for each run
  log('info', '═══ Order Pipeline Sync Started ═══', {
    mode: FLAGS.full ? 'FULL' : 'INCREMENTAL',
    dryRun: FLAGS.dryRun,
    sinceDate: CONFIG.sinceDate,
  });

  // Validate config
  if (!CONFIG.cin7.accountId || !CONFIG.cin7.apiKey) {
    throw new Error('Missing CIN7_ACCOUNT_ID or CIN7_API_KEY');
  }

  const sb = getSupabaseClient();

  const soResult = await syncSalesOrders(sb);
  const trResult = await syncStockTransfers(sb);

  // Detect orders that left active status (now COMPLETED/INVOICED in Cin7)
  const completed = await detectCompleted(sb, soResult.ids, trResult.ids);

  const cleaned = await cleanupCompleted(sb);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', '═══ Order Pipeline Sync Complete ═══', {
    salesOrders: soResult.count,
    transfers: trResult.count,
    newlyCompleted: completed,
    cleaned,
    apiCalls: callCount,
    durationSec: duration,
  });

  return {
    salesOrders: soResult.count,
    transfers: trResult.count,
    newlyCompleted: completed,
    cleaned,
    apiCalls: callCount,
    durationSec: parseFloat(duration),
  };
}

// Export for use as a module (e.g. from server.js endpoint)
module.exports = { runPipelineSync: main };

// Run directly when executed as a script
if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    log('error', 'Sync failed', { error: err.message, apiCalls: callCount });
    process.exit(1);
  });
}
