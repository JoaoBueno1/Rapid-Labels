#!/usr/bin/env node
/**
 * Cin7 Stock Sync Service → Supabase Mirror
 * 
 * Periodically fetches inventory data from Cin7 Core API
 * and upserts it into Supabase under the cin7_mirror schema.
 * 
 * Usage:
 *   node cin7-stock-sync/sync-service.js                       # Full sync (stock + products + locations)
 *   node cin7-stock-sync/sync-service.js --stock-only           # Stock snapshot only
 *   node cin7-stock-sync/sync-service.js --products-only        # Products catalog only
 *   node cin7-stock-sync/sync-service.js --locations-only       # Locations only
 *   node cin7-stock-sync/sync-service.js --dry-run              # Log what would happen, don't write
 *   node cin7-stock-sync/sync-service.js --schedule             # Run on cron schedule (2h/4h staggered intervals)
 *   node cin7-stock-sync/sync-service.js --verbose              # Detailed logging
 * 
 * See ARCHITECTURE.md for design decisions and data flow.
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const path = require('path');

// Load .env from project root
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  cin7: {
    accountId: process.env.CIN7_ACCOUNT_ID || '',
    apiKey: process.env.CIN7_API_KEY || '',
    baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
    pageSize: 1000,        // Max allowed by Cin7
    maxRetries: 3,
    timeoutMs: 30000,      // 30s per request
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    // Service role key — required for writing to cin7_mirror schema
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    batchSize: 500,        // Rows per Supabase upsert call
  },
  throttle: {
    callsPerMinute: 24,    // Conservative: 60000/2500 = 24 calls/min
    delayMs: 2500,         // 2.5s between calls — matches Rapid-Express-Web pace
  },
  schedule: {
    stockIntervalMin: 120,      // 2 hours
    productsDaily: '0 3 * * *', // Daily at 3 AM
    locationsDaily: '0 4 * * *', // Daily at 4 AM
  },
};

// ============================================================
// CLI ARGUMENT PARSING
// ============================================================

const args = process.argv.slice(2);
const FLAGS = {
  dryRun: args.includes('--dry-run'),
  stockOnly: args.includes('--stock-only'),
  productsOnly: args.includes('--products-only'),
  locationsOnly: args.includes('--locations-only'),
  schedule: args.includes('--schedule'),
  verbose: args.includes('--verbose'),
};

// Determine sync type
function getSyncType() {
  if (FLAGS.stockOnly) return 'stock_only';
  if (FLAGS.productsOnly) return 'products_only';
  if (FLAGS.locationsOnly) return 'locations_only';
  return 'full';
}

// ============================================================
// LOGGING
// ============================================================

function log(level, message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else if (level === 'debug' && !FLAGS.verbose) {
    return; // skip debug unless verbose
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ============================================================
// CIN7 API CLIENT
// ============================================================

class Cin7ApiClient {
  constructor(config) {
    this.config = config;
    this.callCount = 0;
    this.lastCallTime = 0;
  }

  /**
   * Throttle: wait until enough time has passed since last call
   */
  async _throttle() {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    const delay = CONFIG.throttle.delayMs;
    if (elapsed < delay) {
      const wait = delay - elapsed;
      log('debug', `Throttling ${wait}ms before next API call`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  /**
   * Make a single API request with retry logic
   */
  async _request(endpoint, params = {}) {
    await this._throttle();

    const url = new URL(`${this.config.baseUrl}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });

    let lastError;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        log('debug', `API call [${attempt}/${this.config.maxRetries}]`, { url: url.toString() });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'api-auth-accountid': this.config.accountId,
            'api-auth-applicationkey': this.config.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        this.lastCallTime = Date.now();
        this.callCount++;

        // Handle rate limiting
        if (response.status === 429) {
          const backoff = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
          log('warn', `Rate limited (429). Backing off ${Math.round(backoff)}ms`, { attempt });
          // Trip circuit breaker on any 429 — protects Rapid-Express-Web
          if (typeof tripCircuitBreaker === 'function') tripCircuitBreaker('API returned 429');
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        // Handle server errors
        if (response.status === 503) {
          const backoff = Math.min(2000 * Math.pow(2, attempt) + Math.random() * 1000, 60000);
          log('warn', `Server error (503). Backing off ${Math.round(backoff)}ms`, { attempt });
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data;

      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') {
          log('warn', `Request timeout after ${this.config.timeoutMs}ms`, { attempt, endpoint });
        } else {
          log('warn', `Request failed: ${err.message}`, { attempt, endpoint });
        }
        if (attempt < this.config.maxRetries) {
          const backoff = 2000 * Math.pow(2, attempt) + Math.random() * 1000;
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }

    throw new Error(`Failed after ${this.config.maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Paginate through an endpoint, collecting all rows
   */
  async _paginateAll(endpoint, params = {}, rowsKey = null) {
    const allRows = [];
    let page = 1;
    let total = null;

    while (true) {
      const data = await this._request(endpoint, {
        ...params,
        Page: page,
        Limit: this.config.pageSize,
      });

      // Detect rows array — some endpoints use different keys
      let rows;
      if (rowsKey && data[rowsKey]) {
        rows = data[rowsKey];
      } else if (data.Products) {
        rows = data.Products;
      } else if (data.ProductAvailabilityList) {
        rows = data.ProductAvailabilityList;
      } else if (data.LocationList) {
        rows = data.LocationList;
      } else {
        // Fallback: find first array property
        const arrayKey = Object.keys(data).find(k => Array.isArray(data[k]));
        rows = arrayKey ? data[arrayKey] : [];
      }

      if (total === null) {
        total = data.Total || 0;
        log('info', `Paginating ${endpoint}`, { total, pages: Math.ceil(total / this.config.pageSize) });
      }

      allRows.push(...rows);
      log('debug', `Page ${page}: got ${rows.length} rows (total so far: ${allRows.length}/${total})`);

      if (allRows.length >= total || rows.length === 0) break;
      page++;
    }

    log('info', `Fetched all ${allRows.length} rows from ${endpoint}`, { pages: page, apiCalls: page });
    return { rows: allRows, total, pages: page };
  }

  /**
   * Fetch all ProductAvailability rows (stock snapshot)
   */
  async fetchStockAvailability(locationFilter = null) {
    const params = {};
    if (locationFilter) params.Location = locationFilter;
    return this._paginateAll('ref/productavailability', params, 'ProductAvailabilityList');
  }

  /**
   * Fetch all Products
   */
  async fetchProducts(includeDeprecated = false) {
    const params = {};
    if (includeDeprecated) params.IncludeDeprecated = 'true';
    return this._paginateAll('product', params, 'Products');
  }

  /**
   * Fetch all Locations
   */
  async fetchLocations() {
    return this._paginateAll('ref/location', {}, 'LocationList');
  }
}

// ============================================================
// SUPABASE WRITER
// ============================================================

class SupabaseWriter {
  constructor(config) {
    this.client = createClient(config.url, config.serviceKey, {
      db: { schema: 'cin7_mirror' },
      auth: { persistSession: false },
    });
    this.batchSize = config.batchSize;
  }

  /**
   * Upsert rows in batches to a table
   */
  async upsertBatch(table, rows, conflictColumns) {
    if (rows.length === 0) {
      log('info', `No rows to upsert for ${table}`);
      return { inserted: 0, errors: [] };
    }

    let totalInserted = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += this.batchSize) {
      const batch = rows.slice(i, i + this.batchSize);
      const batchNum = Math.floor(i / this.batchSize) + 1;
      const totalBatches = Math.ceil(rows.length / this.batchSize);

      try {
        const { data, error } = await this.client
          .from(table)
          .upsert(batch, {
            onConflict: conflictColumns,
            ignoreDuplicates: false,
          });

        if (error) {
          log('error', `Upsert error on ${table} batch ${batchNum}/${totalBatches}`, {
            error: error.message,
            code: error.code,
            details: error.details,
          });
          errors.push({ batch: batchNum, error: error.message });
        } else {
          totalInserted += batch.length;
          log('debug', `Upserted ${table} batch ${batchNum}/${totalBatches} (${batch.length} rows)`);
        }
      } catch (err) {
        log('error', `Exception during upsert on ${table}`, { error: err.message });
        errors.push({ batch: batchNum, error: err.message });
      }
    }

    log('info', `Upserted ${totalInserted}/${rows.length} rows to ${table}`, {
      errors: errors.length,
    });

    return { inserted: totalInserted, errors };
  }

  /**
   * Create a sync run record (start)
   */
  async startSyncRun(syncType, config = {}) {
    const { data, error } = await this.client
      .from('sync_runs')
      .insert({
        sync_type: syncType,
        status: 'running',
        config: config,
      })
      .select('run_id')
      .single();

    if (error) {
      log('error', 'Failed to create sync_run record', { error: error.message });
      return null;
    }

    return data.run_id;
  }

  /**
   * Update a sync run record (end)
   */
  async endSyncRun(runId, status, metrics = {}) {
    const { error } = await this.client
      .from('sync_runs')
      .update({
        status,
        ended_at: new Date().toISOString(),
        ...metrics,
      })
      .eq('run_id', runId);

    if (error) {
      log('error', 'Failed to update sync_run record', { error: error.message });
    }
  }

  /**
   * Clear old stock snapshot data before full replace.
   * Uses TRUNCATE via RPC for speed + no row-count limits.
   * Falls back to batched delete if RPC unavailable.
   */
  async clearStockSnapshot() {
    // Try TRUNCATE via RPC first (fastest, no row limits)
    const { error: rpcError } = await this.client.rpc('truncate_stock_snapshot');
    if (!rpcError) {
      log('info', 'Cleared stock_snapshot via TRUNCATE RPC');
      return true;
    }

    // Fallback: batched delete (Supabase limits affected rows per request)
    log('info', 'TRUNCATE RPC not available, using batched delete...');
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await this.client
        .from('stock_snapshot')
        .delete()
        .neq('sku', '___never_match___')  // match all
        .select('sku')
        .limit(5000);                       // delete in chunks

      if (error) {
        log('error', 'Failed to clear stock_snapshot', { error: error.message, deleted: totalDeleted });
        return false;
      }

      const deleted = data ? data.length : 0;
      totalDeleted += deleted;
      hasMore = deleted >= 5000; // if we got a full batch, there may be more
      log('debug', `Deleted batch: ${deleted} rows (total: ${totalDeleted})`);
    }

    log('info', `Cleared stock_snapshot table: ${totalDeleted} rows deleted`);
    return true;
  }
}

// ============================================================
// DATA MAPPERS
// ============================================================

/**
 * Map Cin7 ProductAvailability row → cin7_mirror.stock_snapshot row
 */
function mapStockRow(raw) {
  return {
    id: raw.ID || null,
    sku: raw.SKU,
    product_name: raw.Name || null,
    barcode: raw.Barcode || null,
    location_name: raw.Location || 'Unknown',
    bin: raw.Bin || '',
    batch: raw.Batch || '',
    expiry_date: raw.ExpiryDate || null,
    on_hand: parseFloat(raw.OnHand) || 0,
    allocated: parseFloat(raw.Allocated) || 0,
    available: parseFloat(raw.Available) || 0,
    on_order: parseFloat(raw.OnOrder) || 0,
    stock_on_hand: parseFloat(raw.StockOnHand) || 0,
    in_transit: parseFloat(raw.InTransit) || 0,
    next_delivery_date: raw.NextDeliveryDate || null,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Map Cin7 Product row → cin7_mirror.products row
 */
function mapProductRow(raw) {
  return {
    id: raw.ID,
    sku: raw.SKU,
    name: raw.Name || '',
    barcode: raw.Barcode || null,
    category: raw.Category || null,
    brand: raw.Brand || null,
    type: raw.Type || null,
    status: raw.Status || 'Active',
    uom: raw.UOM || 'Item',
    costing_method: raw.CostingMethod || null,
    weight: parseFloat(raw.Weight) || 0,
    weight_units: raw.WeightUnits || 'g',
    default_location: raw.DefaultLocation || null,
    minimum_before_reorder: parseFloat(raw.MinimumBeforeReorder) || 0,
    reorder_quantity: parseFloat(raw.ReorderQuantity) || 0,
    average_cost: parseFloat(raw.AverageCost) || 0,
    stock_locator: raw.StockLocator || null,
    pick_zones: raw.PickZones || null,
    sellable: raw.Status !== 'Deprecated',
    last_modified_on: raw.LastModifiedOn || null,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Map Cin7 Location row → cin7_mirror.locations row
 */
function mapLocationRow(raw) {
  return {
    id: raw.ID,
    name: raw.Name || '',
    is_default: raw.IsDefault || false,
    is_deprecated: raw.Deprecated || raw.IsDeprecated || false,
    parent_id: raw.ParentID || null,
    address_line1: raw.AddressLine1 || null,
    address_city: raw.AddressLine2 || null, // Cin7 sometimes uses Line2 for city
    address_state: raw.State || null,
    address_postcode: raw.PostCode || null,
    address_country: raw.Country || null,
    bin_count: raw.Bins ? raw.Bins.length : 0,
    synced_at: new Date().toISOString(),
  };
}

// ============================================================
// SYNC ORCHESTRATOR
// ============================================================

class SyncOrchestrator {
  constructor() {
    this.cin7 = new Cin7ApiClient(CONFIG.cin7);
    this.supabase = new SupabaseWriter(CONFIG.supabase);
    this.dryRun = FLAGS.dryRun;
  }

  /**
   * Run a full sync: stock + products + locations
   */
  async runFullSync() {
    return this._runSync('full', async (metrics) => {
      // 1. Locations (fewest calls, reference data)
      const locResult = await this._syncLocations(metrics);

      // 2. Products (metadata)
      const prodResult = await this._syncProducts(metrics);

      // 3. Stock snapshot (main data)
      const stockResult = await this._syncStock(metrics);

      return { locResult, prodResult, stockResult };
    });
  }

  /**
   * Run stock-only sync
   */
  async runStockSync() {
    return this._runSync('stock_only', async (metrics) => {
      return this._syncStock(metrics);
    });
  }

  /**
   * Run products-only sync
   */
  async runProductsSync() {
    return this._runSync('products_only', async (metrics) => {
      return this._syncProducts(metrics);
    });
  }

  /**
   * Run locations-only sync
   */
  async runLocationsSync() {
    return this._runSync('locations_only', async (metrics) => {
      return this._syncLocations(metrics);
    });
  }

  /**
   * Generic sync runner with audit logging
   */
  async _runSync(syncType, syncFn) {
    const startTime = Date.now();
    log('info', `=== Starting ${syncType} sync ===`, { dryRun: this.dryRun });

    // Create sync run record
    let runId = null;
    if (!this.dryRun) {
      runId = await this.supabase.startSyncRun(syncType, {
        dryRun: this.dryRun,
        throttle: CONFIG.throttle,
        pageSize: CONFIG.cin7.pageSize,
      });
    }

    const metrics = {
      total_api_calls: 0,
      total_pages: 0,
      products_synced: 0,
      stock_rows_synced: 0,
      locations_synced: 0,
      retries: 0,
      rate_limited: false,
      errors: [],
    };

    try {
      await syncFn(metrics);

      const duration = Date.now() - startTime;
      metrics.duration_ms = duration;
      metrics.avg_call_ms = metrics.total_api_calls > 0
        ? Math.round(duration / metrics.total_api_calls)
        : 0;

      log('info', `=== ${syncType} sync completed ===`, {
        duration: `${(duration / 1000).toFixed(1)}s`,
        apiCalls: this.cin7.callCount,
        ...metrics,
      });

      // Update sync run record
      if (runId) {
        await this.supabase.endSyncRun(runId, 'success', metrics);
      }

      return { success: true, metrics };

    } catch (err) {
      const duration = Date.now() - startTime;
      metrics.duration_ms = duration;
      metrics.errors.push({ message: err.message, stack: err.stack });

      log('error', `=== ${syncType} sync FAILED ===`, {
        error: err.message,
        duration: `${(duration / 1000).toFixed(1)}s`,
        apiCalls: this.cin7.callCount,
      });

      // Update sync run record
      if (runId) {
        await this.supabase.endSyncRun(runId, 'failed', metrics);
      }

      return { success: false, error: err.message, metrics };
    }
  }

  /**
   * Sync stock availability data
   */
  async _syncStock(metrics) {
    log('info', 'Syncing stock availability...');

    // Fetch all availability data from Cin7
    const { rows, total, pages } = await this.cin7.fetchStockAvailability();
    metrics.total_api_calls += pages;
    metrics.total_pages += pages;

    // Map to our schema
    const mapped = rows.map(mapStockRow);
    log('info', `Mapped ${mapped.length} stock rows`, {
      total,
      uniqueSkus: new Set(mapped.map(r => r.sku)).size,
      locations: new Set(mapped.map(r => r.location_name)).size,
    });

    if (this.dryRun) {
      log('info', '[DRY RUN] Would upsert stock_snapshot', {
        rows: mapped.length,
        sample: mapped.slice(0, 3),
      });
      metrics.stock_rows_synced = mapped.length;
      return;
    }

    // Strategy: DELETE + INSERT for full snapshot (ensures removed items are cleared)
    // This is safer than UPSERT because ProductAvailability omits zero-qty items
    const cleared = await this.supabase.clearStockSnapshot();
    if (!cleared) {
      throw new Error('Failed to clear stock_snapshot before insert');
    }

    // Insert all rows in batches
    // Conflict columns must match the full PK: sku + location_name + bin + batch
    const { inserted, errors } = await this.supabase.upsertBatch(
      'stock_snapshot',
      mapped,
      'sku,location_name,bin,batch'
    );

    metrics.stock_rows_synced = inserted;
    if (errors.length > 0) {
      metrics.errors.push(...errors.map(e => ({ phase: 'stock_upsert', ...e })));
    }

    log('info', `Stock sync complete: ${inserted} rows written`);
  }

  /**
   * Sync products catalog
   */
  async _syncProducts(metrics) {
    log('info', 'Syncing products catalog...');

    const { rows, total, pages } = await this.cin7.fetchProducts(true); // include deprecated
    metrics.total_api_calls += pages;
    metrics.total_pages += pages;

    const mapped = rows.map(mapProductRow);
    log('info', `Mapped ${mapped.length} products`, {
      total,
      active: mapped.filter(p => p.status === 'Active').length,
      deprecated: mapped.filter(p => p.status === 'Deprecated').length,
    });

    if (this.dryRun) {
      log('info', '[DRY RUN] Would upsert products', {
        rows: mapped.length,
        sample: mapped.slice(0, 3),
      });
      metrics.products_synced = mapped.length;
      return;
    }

    const { inserted, errors } = await this.supabase.upsertBatch(
      'products',
      mapped,
      'sku'
    );

    metrics.products_synced = inserted;
    if (errors.length > 0) {
      metrics.errors.push(...errors.map(e => ({ phase: 'products_upsert', ...e })));
    }

    log('info', `Products sync complete: ${inserted} rows written`);
  }

  /**
   * Sync locations reference data
   */
  async _syncLocations(metrics) {
    log('info', 'Syncing locations...');

    const { rows, total, pages } = await this.cin7.fetchLocations();
    metrics.total_api_calls += pages;
    metrics.total_pages += pages;

    const mapped = rows.map(mapLocationRow);
    log('info', `Mapped ${mapped.length} locations`, {
      total,
      active: mapped.filter(l => !l.is_deprecated).length,
      deprecated: mapped.filter(l => l.is_deprecated).length,
    });

    if (this.dryRun) {
      log('info', '[DRY RUN] Would upsert locations', {
        rows: mapped.length,
        sample: mapped.slice(0, 3),
      });
      metrics.locations_synced = mapped.length;
      return;
    }

    const { inserted, errors } = await this.supabase.upsertBatch(
      'locations',
      mapped,
      'name'
    );

    metrics.locations_synced = inserted;
    if (errors.length > 0) {
      metrics.errors.push(...errors.map(e => ({ phase: 'locations_upsert', ...e })));
    }

    log('info', `Locations sync complete: ${inserted} rows written`);
  }
}

// ============================================================
// SCHEDULER (optional — cron-based recurring syncs)
// ============================================================

// ============================================================
// SYNC MUTEX & CIRCUIT BREAKER
// ============================================================

let _syncLock = false;
let _syncLockOwner = '';
let _circuitBreakerUntil = 0;
const CIRCUIT_BREAKER_DURATION = 5 * 60 * 1000; // 5 minutes

async function acquireSyncLock(name, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (_syncLock) {
    if (Date.now() > deadline) {
      log('warn', `${name}: timed out waiting for sync lock (held by ${_syncLockOwner})`);
      return false;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  // Check circuit breaker
  if (Date.now() < _circuitBreakerUntil) {
    const remaining = Math.round((_circuitBreakerUntil - Date.now()) / 1000);
    log('warn', `${name}: circuit breaker active, ${remaining}s remaining — skipping`);
    return false;
  }
  _syncLock = true;
  _syncLockOwner = name;
  return true;
}

function releaseSyncLock() {
  _syncLock = false;
  _syncLockOwner = '';
}

function tripCircuitBreaker(reason) {
  _circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_DURATION;
  log('error', `🔴 CIRCUIT BREAKER TRIPPED — all syncs paused for ${CIRCUIT_BREAKER_DURATION / 1000}s`, { reason });
}

async function runScheduler() {
  const cron = require('node-cron');

  log('info', '🛡️ Starting SAFE sync scheduler (staggered, mutex, circuit breaker)', {
    stockInterval: `${CONFIG.schedule.stockIntervalMin} min`,
    productsSchedule: CONFIG.schedule.productsDaily,
    locationsSchedule: CONFIG.schedule.locationsDaily,
    rateDelay: `${CONFIG.throttle.delayMs}ms`,
  });

  const orchestrator = new SyncOrchestrator();

  // Initial full sync on startup
  log('info', 'Running initial full sync...');
  await orchestrator.runFullSync();

  // ── Stock snapshot: every 2 hours at :00 ──
  cron.schedule('0 */2 * * *', async () => {
    if (!await acquireSyncLock('stock_sync')) return;
    try {
      log('info', '⏰ Scheduled stock sync triggered');
      await orchestrator.runStockSync();
    } catch (err) {
      log('error', 'Scheduled stock sync failed', { error: err.message });
      if (err.message.includes('429')) tripCircuitBreaker('stock_sync 429');
    } finally {
      releaseSyncLock();
    }
  });

  // ── Products: daily at 3 AM ──
  cron.schedule(CONFIG.schedule.productsDaily, async () => {
    if (!await acquireSyncLock('products_sync')) return;
    try {
      log('info', '⏰ Scheduled daily products sync triggered');
      await orchestrator.runProductsSync();
    } catch (err) {
      log('error', 'Scheduled products sync failed', { error: err.message });
      if (err.message.includes('429')) tripCircuitBreaker('products_sync 429');
    } finally {
      releaseSyncLock();
    }
  });

  // ── Locations: daily at 4 AM ──
  cron.schedule(CONFIG.schedule.locationsDaily, async () => {
    if (!await acquireSyncLock('locations_sync')) return;
    try {
      log('info', '⏰ Scheduled daily locations sync triggered');
      await orchestrator.runLocationsSync();
    } catch (err) {
      log('error', 'Scheduled locations sync failed', { error: err.message });
      if (err.message.includes('429')) tripCircuitBreaker('locations_sync 429');
    } finally {
      releaseSyncLock();
    }
  });

  // ── Full rebuild at 2 AM daily ──
  cron.schedule('0 2 * * *', async () => {
    if (!await acquireSyncLock('full_rebuild')) return;
    try {
      log('info', '⏰ Scheduled daily full rebuild');
      await orchestrator.runFullSync();
    } catch (err) {
      log('error', 'Scheduled full rebuild failed', { error: err.message });
      if (err.message.includes('429')) tripCircuitBreaker('full_rebuild 429');
    } finally {
      releaseSyncLock();
    }
  });

  // ── Pick Anomalies: every 2 hours at :30 (offset from stock) ──
  try {
    const { syncNewOrders } = require('../features/pick-anomalies/pick-anomalies-engine');
    cron.schedule('30 */2 * * *', async () => {
      if (!await acquireSyncLock('pick_anomalies')) return;
      try {
        log('info', '⏰ Scheduled pick anomalies sync triggered');
        const result = await syncNewOrders();
        log('info', 'Pick anomalies sync completed', {
          success: result.success,
          newOrders: result.newOrders || 0,
          anomalies: result.anomaliesFound || 0,
        });
      } catch (err) {
        log('error', 'Scheduled pick anomalies sync failed', { error: err.message });
        if (err.message.includes('429')) tripCircuitBreaker('pick_anomalies 429');
      } finally {
        releaseSyncLock();
      }
    });
    log('info', '✅ Pick anomalies auto-sync enabled (every 2h at :30)');
  } catch (err) {
    log('warn', '⚠️ Pick anomalies engine not available for scheduling', { error: err.message });
  }

  log('info', '🛡️ Scheduler running with safety features:');
  log('info', '   Stock:          every 2h at :00');
  log('info', '   Full Rebuild:   daily at 2:00 AM');
  log('info', '   Products:       daily at 3:00 AM');
  log('info', '   Locations:      daily at 4:00 AM');
  log('info', '   Pick Anomalies: every 2h at :30');
  log('info', '   Rate Delay:     2.5s between API calls');
  log('info', '   Mutex:          only 1 sync at a time');
  log('info', '   Circuit Breaker: 5min pause on any 429');
  log('info', 'Press Ctrl+C to stop.');
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  log('info', 'Cin7 Stock Sync Service starting', {
    syncType: getSyncType(),
    dryRun: FLAGS.dryRun,
    schedule: FLAGS.schedule,
    verbose: FLAGS.verbose,
  });

  // Scheduler mode
  if (FLAGS.schedule) {
    await runScheduler();
    return; // scheduler keeps running
  }

  // One-shot sync
  const orchestrator = new SyncOrchestrator();
  let result;

  switch (getSyncType()) {
    case 'stock_only':
      result = await orchestrator.runStockSync();
      break;
    case 'products_only':
      result = await orchestrator.runProductsSync();
      break;
    case 'locations_only':
      result = await orchestrator.runLocationsSync();
      break;
    case 'full':
    default:
      result = await orchestrator.runFullSync();
      break;
  }

  if (result.success) {
    log('info', 'Sync completed successfully', result.metrics);
    process.exit(0);
  } else {
    log('error', 'Sync failed', { error: result.error, metrics: result.metrics });
    process.exit(1);
  }
}

// Run
main().catch(err => {
  log('error', 'Unhandled error', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Export for testing
module.exports = { SyncOrchestrator, Cin7ApiClient, SupabaseWriter, CONFIG };
