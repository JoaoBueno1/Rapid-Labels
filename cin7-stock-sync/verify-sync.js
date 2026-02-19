#!/usr/bin/env node
/**
 * Cin7 Sync Verification Tool
 * 
 * Validates that the cin7_mirror data matches the live Cin7 API.
 * Runs a series of checks and reports pass/fail for each.
 * 
 * Usage:
 *   node cin7-stock-sync/verify-sync.js              # Run all checks
 *   node cin7-stock-sync/verify-sync.js --quick       # Quick check (row counts only)
 *   node cin7-stock-sync/verify-sync.js --sample 20   # Sample N random SKUs for comparison
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ============================================================
// CONFIG (same as sync-service.js)
// ============================================================

const CIN7_CONFIG = {
  accountId: '3bda282b-60f0-40dc-9199-21959e247cd5',
  apiKey: '55c70204-619a-5286-ae1d-593493533cb9',
  baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
};

const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcxOTE1NzkzNCwiZXhwIjoyMDM0NzMzOTM0fQ.BRHXp3ywILpNjslPDvZ51kC2PmQhxvEJOQd2KGLiB0g';

// ============================================================
// CLI
// ============================================================

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const sampleIdx = args.indexOf('--sample');
const SAMPLE_SIZE = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1], 10) || 20 : 20;

// ============================================================
// HELPERS
// ============================================================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'cin7_mirror' },
  auth: { persistSession: false },
});

async function cin7Get(endpoint, params = {}) {
  const url = new URL(`${CIN7_CONFIG.baseUrl}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  
  const res = await fetch(url.toString(), {
    headers: {
      'api-auth-accountid': CIN7_CONFIG.accountId,
      'api-auth-applicationkey': CIN7_CONFIG.apiKey,
    },
  });
  
  if (!res.ok) throw new Error(`Cin7 API ${res.status}: ${res.statusText}`);
  return res.json();
}

function pass(name, detail = '') {
  console.log(`  ✅ PASS: ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, detail = '') {
  console.log(`  ❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`);
}

function warn(name, detail = '') {
  console.log(`  ⚠️  WARN: ${name}${detail ? ' — ' + detail : ''}`);
}

function info(msg) {
  console.log(`  ℹ️  ${msg}`);
}

// ============================================================
// CHECKS
// ============================================================

async function checkRowCounts() {
  console.log('\n── Row Count Verification ──');

  // Get Cin7 totals (1 call each, Page=1 Limit=1)
  const [stockApi, productsApi] = await Promise.all([
    cin7Get('ref/productavailability', { Page: 1, Limit: 1 }),
    cin7Get('product', { Page: 1, Limit: 1 }),
  ]);

  const cin7StockTotal = stockApi.Total;
  const cin7ProductsTotal = productsApi.Total;

  // Get Supabase totals
  const { count: mirrorStock } = await supabase
    .from('stock_snapshot')
    .select('*', { count: 'exact', head: true });

  const { count: mirrorProducts } = await supabase
    .from('products')
    .select('*', { count: 'exact', head: true });

  const { count: mirrorLocations } = await supabase
    .from('locations')
    .select('*', { count: 'exact', head: true });

  info(`Cin7 ProductAvailability Total: ${cin7StockTotal}`);
  info(`Mirror stock_snapshot rows: ${mirrorStock}`);
  info(`Cin7 Products Total: ${cin7ProductsTotal}`);
  info(`Mirror products rows: ${mirrorProducts}`);
  info(`Mirror locations rows: ${mirrorLocations}`);

  // Stock count check (allow small variance due to timing)
  const stockDiff = Math.abs((mirrorStock || 0) - cin7StockTotal);
  const stockPct = cin7StockTotal > 0 ? (stockDiff / cin7StockTotal * 100).toFixed(2) : 0;
  
  if (stockDiff === 0) {
    pass('Stock row count', `exact match: ${cin7StockTotal}`);
  } else if (stockPct < 1) {
    warn('Stock row count', `diff: ${stockDiff} rows (${stockPct}%) — acceptable if sync was not just run`);
  } else {
    fail('Stock row count', `diff: ${stockDiff} rows (${stockPct}%) — exceeds 1% threshold`);
  }

  // Products count check
  const prodDiff = Math.abs((mirrorProducts || 0) - cin7ProductsTotal);
  if (prodDiff === 0) {
    pass('Products row count', `exact match: ${cin7ProductsTotal}`);
  } else if (prodDiff < cin7ProductsTotal * 0.01) {
    warn('Products row count', `diff: ${prodDiff} rows`);
  } else {
    fail('Products row count', `diff: ${prodDiff} rows`);
  }

  // Locations check (just verify it's not empty)
  if ((mirrorLocations || 0) > 0) {
    pass('Locations populated', `${mirrorLocations} locations`);
  } else {
    fail('Locations populated', 'No locations in mirror');
  }

  return { cin7StockTotal, cin7ProductsTotal, mirrorStock, mirrorProducts };
}

async function checkDataFreshness() {
  console.log('\n── Data Freshness ──');

  const { data } = await supabase.rpc('now'); // server time
  const serverNow = data ? new Date(data) : new Date();

  // Check latest sync timestamps
  const { data: stockLatest } = await supabase
    .from('stock_snapshot')
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .single();

  const { data: productsLatest } = await supabase
    .from('products')
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .single();

  if (stockLatest) {
    const age = (Date.now() - new Date(stockLatest.synced_at).getTime()) / 60000;
    if (age < 15) {
      pass('Stock freshness', `${age.toFixed(1)} min old`);
    } else if (age < 30) {
      warn('Stock freshness', `${age.toFixed(1)} min old (stale)`);
    } else {
      fail('Stock freshness', `${age.toFixed(1)} min old (very stale)`);
    }
  } else {
    fail('Stock freshness', 'No data in stock_snapshot');
  }

  if (productsLatest) {
    const age = (Date.now() - new Date(productsLatest.synced_at).getTime()) / 60000;
    if (age < 60) {
      pass('Products freshness', `${age.toFixed(1)} min old`);
    } else {
      warn('Products freshness', `${age.toFixed(1)} min old`);
    }
  } else {
    fail('Products freshness', 'No data in products');
  }
}

async function checkSyncRuns() {
  console.log('\n── Sync Run History ──');

  const { data: runs, error } = await supabase
    .from('sync_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(10);

  if (error || !runs || runs.length === 0) {
    warn('Sync runs', 'No sync runs recorded yet');
    return;
  }

  info(`Last ${runs.length} sync runs:`);
  runs.forEach(r => {
    const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '?';
    const status = r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : '🔄';
    console.log(`    ${status} ${r.sync_type.padEnd(15)} ${r.started_at}  dur: ${dur}  stock: ${r.stock_rows_synced || 0}  products: ${r.products_synced || 0}`);
  });

  // Check for consecutive failures
  const recentFails = runs.filter(r => r.status === 'failed');
  if (recentFails.length >= 3) {
    fail('Consecutive failures', `${recentFails.length} of last ${runs.length} runs failed`);
  } else if (recentFails.length > 0) {
    warn('Recent failures', `${recentFails.length} of last ${runs.length} runs failed`);
  } else {
    pass('Sync reliability', `All ${runs.length} recent runs succeeded`);
  }

  // Check average duration
  const successRuns = runs.filter(r => r.status === 'success' && r.duration_ms);
  if (successRuns.length > 0) {
    const avgDur = successRuns.reduce((s, r) => s + r.duration_ms, 0) / successRuns.length;
    if (avgDur < 120000) {
      pass('Sync duration', `avg ${(avgDur / 1000).toFixed(1)}s (< 2 min)`);
    } else if (avgDur < 300000) {
      warn('Sync duration', `avg ${(avgDur / 1000).toFixed(1)}s (slow but acceptable)`);
    } else {
      fail('Sync duration', `avg ${(avgDur / 1000).toFixed(1)}s (> 5 min threshold)`);
    }
  }
}

async function checkSampleSkus() {
  console.log(`\n── Sample SKU Comparison (${SAMPLE_SIZE} random) ──`);

  // Get a pool of SKUs to sample from (use count to know total, then random offset)
  const { count: totalStock } = await supabase
    .from('stock_snapshot')
    .select('*', { count: 'exact', head: true });

  // Pick random offset ranges to get diverse samples
  const offsets = [];
  for (let i = 0; i < Math.min(SAMPLE_SIZE, 5); i++) {
    offsets.push(Math.floor(Math.random() * (totalStock || 1000)));
  }

  let sampleRows = [];
  for (const offset of offsets) {
    const { data } = await supabase
      .from('stock_snapshot')
      .select('sku, location_name, on_hand, available, allocated')
      .range(offset, offset + Math.ceil(SAMPLE_SIZE / offsets.length) - 1);
    if (data) sampleRows.push(...data);
  }

  if (!sampleRows || sampleRows.length === 0) {
    fail('Sample check', 'No data in stock_snapshot to sample');
    return;
  }

  // Pick random samples
  const shuffled = sampleRows.sort(() => 0.5 - Math.random());
  const samples = shuffled.slice(0, Math.min(SAMPLE_SIZE, shuffled.length));

  let matchCount = 0;
  let mismatchCount = 0;
  const mismatches = [];

  for (const sample of samples) {
    // Fetch from Cin7 API (filtered by location)
    try {
      const apiData = await cin7Get('ref/productavailability', {
        Page: 1,
        Limit: 100,
        SKU: sample.sku,
      });

      // Wait 1.2s for throttle
      await new Promise(r => setTimeout(r, 1200));

      const rows = apiData.ProductAvailabilityList || [];
      const match = rows.find(r =>
        r.SKU === sample.sku && r.Location === sample.location_name
      );

      if (match) {
        const onHandMatch = Math.abs(parseFloat(match.OnHand) - sample.on_hand) < 0.01;
        const availableMatch = Math.abs(parseFloat(match.Available) - sample.available) < 0.01;

        if (onHandMatch && availableMatch) {
          matchCount++;
        } else {
          mismatchCount++;
          mismatches.push({
            sku: sample.sku,
            location: sample.location_name,
            mirror: { on_hand: sample.on_hand, available: sample.available },
            cin7: { on_hand: match.OnHand, available: match.Available },
          });
        }
      } else {
        // Not found in API — might have been zeroed out since last sync
        warn(`SKU ${sample.sku} @ ${sample.location_name}`, 'not found in live API (may have been zeroed)');
      }
    } catch (err) {
      warn(`SKU ${sample.sku}`, `API error: ${err.message}`);
    }
  }

  info(`Matched: ${matchCount}/${samples.length}`);
  if (mismatchCount > 0) {
    info(`Mismatched: ${mismatchCount}`);
    mismatches.forEach(m => {
      console.log(`    ⊘ ${m.sku} @ ${m.location}: mirror(oh=${m.mirror.on_hand}, av=${m.mirror.available}) vs cin7(oh=${m.cin7.on_hand}, av=${m.cin7.available})`);
    });
  }

  const accuracy = samples.length > 0 ? (matchCount / samples.length * 100).toFixed(1) : 0;
  if (accuracy >= 99) {
    pass('Sample accuracy', `${accuracy}% (${matchCount}/${samples.length})`);
  } else if (accuracy >= 95) {
    warn('Sample accuracy', `${accuracy}% — some drift expected between syncs`);
  } else {
    fail('Sample accuracy', `${accuracy}% — below 95% threshold`);
  }
}

async function checkNegativeStock() {
  console.log('\n── Edge Cases ──');

  const { data: negatives, count } = await supabase
    .from('stock_snapshot')
    .select('sku, location_name, available, on_hand', { count: 'exact' })
    .lt('available', 0)
    .limit(5);

  if (count > 0) {
    pass('Negative stock tracked', `${count} rows with negative Available (expected)`);
    negatives.forEach(r => {
      console.log(`    - ${r.sku} @ ${r.location_name}: available=${r.available}, on_hand=${r.on_hand}`);
    });
  } else {
    info('No negative stock rows found (may be normal)');
  }

  // Check for zero on_hand across all locations
  const { count: zeroCount } = await supabase
    .from('stock_snapshot')
    .select('*', { count: 'exact', head: true })
    .eq('on_hand', 0)
    .eq('available', 0);

  info(`Rows with zero on_hand AND zero available: ${zeroCount || 0}`);
}

async function checkWarehouseTotals() {
  console.log('\n── Warehouse Totals ──');

  const { data: warehouses } = await supabase
    .from('stock_snapshot')
    .select('location_name')
    .limit(10000);

  if (!warehouses || warehouses.length === 0) {
    warn('Warehouse totals', 'No stock data');
    return;
  }

  // Get unique locations
  const locations = [...new Set(warehouses.map(w => w.location_name))];
  info(`Total unique locations in mirror: ${locations.length}`);

  // Show top warehouses by row count
  const counts = {};
  warehouses.forEach(w => {
    counts[w.location_name] = (counts[w.location_name] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  sorted.forEach(([loc, cnt]) => {
    console.log(`    ${loc.padEnd(25)} ${cnt} rows`);
  });
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Cin7 Sync Mirror — Verification Tool   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Mode: ${QUICK ? 'Quick' : 'Full'}`);

  try {
    // Always run these
    await checkRowCounts();
    await checkDataFreshness();
    await checkSyncRuns();

    if (!QUICK) {
      await checkNegativeStock();
      await checkWarehouseTotals();
      await checkSampleSkus();
    }

    console.log('\n══════════════════════════════════════════');
    console.log('  Verification complete.');
    console.log('══════════════════════════════════════════\n');
  } catch (err) {
    console.error(`\n❌ Verification error: ${err.message}`);
    if (err.message.includes('relation') && err.message.includes('does not exist')) {
      console.error('\n  Hint: Have you run schema.sql to create the cin7_mirror tables?');
    }
    process.exit(1);
  }
}

main();
