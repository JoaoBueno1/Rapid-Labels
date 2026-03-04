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
    throttleMs: 2500,
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
  const rows = unique.map(o => ({
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
    from_location: null,
    to_location: null,
    reference: o.CustomerReference || null,
    line_count: null, // not available from list endpoint
    total_qty: null,
    updated_at: o.Updated || null,
    synced_at: nowIso,
    // Track when order completed (for daily stats) — only set on first completion
    ...(isCompleted(o.Status) ? { completed_at: nowIso } : {}),
  }));

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
    .select('id, status')
    .eq('type', 'SO')
    .not('status', 'in', `(${completedStatuses.join(',')})`);

  let soMarked = 0;
  if (!soErr && cachedSo) {
    const disappeared = cachedSo.filter(r => !freshSoIds.has(r.id));
    if (disappeared.length > 0) {
      log('info', `🔍 Detected ${disappeared.length} SO completed since last sync`);
      const ids = disappeared.map(r => r.id);
      const { error } = await sb
        .from('order_pipeline')
        .update({ status: 'COMPLETED', completed_at: nowIso, synced_at: nowIso })
        .in('id', ids);
      if (error) log('warn', 'Failed to mark SO completed', { error: error.message });
      else soMarked = ids.length;
    }
  }

  // Find TR in cache that are still marked active but weren't in the fresh fetch
  const { data: cachedTr, error: trErr } = await sb
    .from('order_pipeline')
    .select('id, status')
    .eq('type', 'TR')
    .not('status', 'in', `(${completedStatuses.join(',')})`);

  let trMarked = 0;
  if (!trErr && cachedTr) {
    const disappeared = cachedTr.filter(r => !freshTrIds.has(r.id));
    if (disappeared.length > 0) {
      log('info', `🔍 Detected ${disappeared.length} TR completed since last sync`);
      const ids = disappeared.map(r => r.id);
      const { error } = await sb
        .from('order_pipeline')
        .update({ status: 'COMPLETED', completed_at: nowIso, synced_at: nowIso })
        .in('id', ids);
      if (error) log('warn', 'Failed to mark TR completed', { error: error.message });
      else trMarked = ids.length;
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
  log('info', '═══ Order Pipeline Sync Started ═══', {
    mode: FLAGS.full ? 'FULL' : 'INCREMENTAL',
    dryRun: FLAGS.dryRun,
    sinceDate: CONFIG.sinceDate,
  });

  // Validate config
  if (!CONFIG.cin7.accountId || !CONFIG.cin7.apiKey) {
    log('error', 'Missing CIN7_ACCOUNT_ID or CIN7_API_KEY');
    process.exit(1);
  }

  const sb = getSupabaseClient();

  try {
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

  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    log('error', 'Sync failed', { error: err.message, apiCalls: callCount, durationSec: duration });
    process.exit(1);
  }
}

main();
