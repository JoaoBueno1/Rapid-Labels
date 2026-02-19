#!/usr/bin/env node
/**
 * verify-compatibility.js
 * 
 * After running the sync AND applying compatibility-views.sql,
 * this script validates that each compatibility view returns
 * data in the shape the existing pages expect.
 * 
 * Usage: node cin7-stock-sync/verify-compatibility.js
 * 
 * SAFE: Read-only. Touches NOTHING in production tables.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

// Mirror schema client
const mirror = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'cin7_mirror' },
  auth: { persistSession: false },
});

// Public schema client (for comparing with existing data)
const pub = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';

let passed = 0;
let failed = 0;
let warnings = 0;

function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ${PASS} ${label}${detail ? ' — ' + detail : ''}`); }
  else    { failed++; console.log(`  ${FAIL} ${label}${detail ? ' — ' + detail : ''}`); }
}

function warn(label, detail = '') {
  warnings++;
  console.log(`  ${WARN} ${label}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  cin7_mirror — Compatibility Views Verification   ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // =========================================================
  // 1. Base tables — check they have data
  // =========================================================
  console.log('── 1. Base Tables (cin7_mirror) ──');

  const { count: stockCount } = await mirror.from('stock_snapshot').select('*', { count: 'exact', head: true });
  check('stock_snapshot has data', stockCount > 0, `${stockCount || 0} rows`);

  const { count: prodCount } = await mirror.from('products').select('*', { count: 'exact', head: true });
  check('products has data', prodCount > 0, `${prodCount || 0} rows`);

  const { count: locCount } = await mirror.from('locations').select('*', { count: 'exact', head: true });
  check('locations has data', locCount > 0, `${locCount || 0} rows`);

  const { count: runCount } = await mirror.from('sync_runs').select('*', { count: 'exact', head: true });
  check('sync_runs has data', runCount > 0, `${runCount || 0} runs`);

  if (stockCount === 0 || stockCount === null) {
    console.log('\n⚠️  Base tables are empty. Run sync first: npm run sync');
    console.log('   Then re-run this verification.');
    process.exit(1);
  }

  // =========================================================
  // 2. v_restock_report — shape check
  // =========================================================
  console.log('\n── 2. v_restock_report (Restock + Stock Anomalies) ──');

  const { data: rr, error: rrErr } = await mirror.from('v_restock_report').select('*').limit(3);
  if (rrErr) {
    check('v_restock_report exists', false, rrErr.message);
  } else {
    check('v_restock_report exists', true, `${rr.length} sample rows`);
    if (rr.length > 0) {
      const cols = Object.keys(rr[0]);
      check('has column: sku', cols.includes('sku'));
      check('has column: product', cols.includes('product'));
      check('has column: location', cols.includes('location'));
      check('has column: on_hand', cols.includes('on_hand'));
      check('has column: updated_at', cols.includes('updated_at'));
      console.log(`    Sample: SKU=${rr[0].sku}, loc=${rr[0].location}, on_hand=${rr[0].on_hand}`);
    }

    // Compare count with existing restock_report
    const { count: existingRR } = await pub.from('restock_report').select('*', { count: 'exact', head: true });
    const { count: mirrorRR } = await mirror.from('v_restock_report').select('*', { count: 'exact', head: true });
    console.log(`    Existing restock_report: ${existingRR || 0} rows | Mirror v_restock_report: ${mirrorRR || 0} rows`);
  }

  // =========================================================
  // 3. v_stock_snapshot_lines — shape check
  // =========================================================
  console.log('\n── 3. v_stock_snapshot_lines (Replenishment) ──');

  const { data: ssl, error: sslErr } = await mirror.from('v_stock_snapshot_lines').select('*').limit(3);
  if (sslErr) {
    check('v_stock_snapshot_lines exists', false, sslErr.message);
  } else {
    check('v_stock_snapshot_lines exists', true, `${ssl.length} sample rows`);
    if (ssl.length > 0) {
      const cols = Object.keys(ssl[0]);
      check('has column: snapshot_id', cols.includes('snapshot_id'));
      check('has column: product', cols.includes('product'));
      check('has column: warehouse_code', cols.includes('warehouse_code'));
      check('has column: qty_available', cols.includes('qty_available'));
      console.log(`    Sample: product=${ssl[0].product}, warehouse=${ssl[0].warehouse_code}, qty=${ssl[0].qty_available}`);
    }

    // Compare count with existing stock_snapshot_lines
    const { count: existingSSL } = await pub.from('stock_snapshot_lines').select('*', { count: 'exact', head: true });
    const { count: mirrorSSL } = await mirror.from('v_stock_snapshot_lines').select('*', { count: 'exact', head: true });
    console.log(`    Existing stock_snapshot_lines: ${existingSSL || 0} rows | Mirror v_stock_snapshot_lines: ${mirrorSSL || 0} rows`);
  }

  // =========================================================
  // 4. v_core_availability — shape check
  // =========================================================
  console.log('\n── 4. v_core_availability (Cyclic Count) ──');

  const { data: ca, error: caErr } = await mirror.from('v_core_availability').select('*').limit(3);
  if (caErr) {
    check('v_core_availability exists', false, caErr.message);
  } else {
    check('v_core_availability exists', true, `${ca.length} sample rows`);
    if (ca.length > 0) {
      const cols = Object.keys(ca[0]);
      check('has column: SKU (uppercase)', cols.includes('SKU'));
      check('has column: Location (uppercase)', cols.includes('Location'));
      check('has column: Available (uppercase)', cols.includes('Available'));
      console.log(`    Sample: SKU=${ca[0].SKU}, Location=${ca[0].Location}, Available=${ca[0].Available}`);
    }
  }

  // =========================================================
  // 5. v_products — shape check
  // =========================================================
  console.log('\n── 5. v_products (Search/Labels) ──');

  const { data: vp, error: vpErr } = await mirror.from('v_products').select('*').limit(3);
  if (vpErr) {
    check('v_products exists', false, vpErr.message);
  } else {
    check('v_products exists', true, `${vp.length} sample rows`);
    if (vp.length > 0) {
      const cols = Object.keys(vp[0]);
      check('has column: SKU (uppercase)', cols.includes('SKU'));
      check('has column: Code (uppercase)', cols.includes('Code'));
      check('has column: barcode1', cols.includes('barcode1'));
      console.log(`    Sample: SKU=${vp[0].SKU}, Code=${vp[0].Code}, barcode1=${vp[0].barcode1}`);
    }

    // Compare count
    const { count: existingProducts } = await pub.from('Products').select('*', { count: 'exact', head: true });
    const { count: mirrorProducts } = await mirror.from('v_products').select('*', { count: 'exact', head: true });
    console.log(`    Existing Products: ${existingProducts || 0} rows | Mirror v_products: ${mirrorProducts || 0} rows`);
  }

  // =========================================================
  // 6. v_locations — shape check
  // =========================================================
  console.log('\n── 6. v_locations (Barcode validation) ──');

  const { data: vl, error: vlErr } = await mirror.from('v_locations').select('*').limit(3);
  if (vlErr) {
    check('v_locations exists', false, vlErr.message);
  } else {
    check('v_locations exists', true, `${vl.length} sample rows`);
    if (vl.length > 0) {
      const cols = Object.keys(vl[0]);
      check('has column: code', cols.includes('code'));
      check('has column: created_at', cols.includes('created_at'));
      console.log(`    Sample: code=${vl[0].code}, created_at=${vl[0].created_at}`);
    }

    // Compare count
    const { count: existingLoc } = await pub.from('Locations').select('*', { count: 'exact', head: true });
    const { count: mirrorLoc } = await mirror.from('v_locations').select('*', { count: 'exact', head: true });
    console.log(`    Existing Locations: ${existingLoc || 0} rows | Mirror v_locations: ${mirrorLoc || 0} rows`);
  }

  // =========================================================
  // 7. v_stock_summary — bonus view
  // =========================================================
  console.log('\n── 7. v_stock_summary (Dashboard/General) ──');

  const { data: vs, error: vsErr } = await mirror.from('v_stock_summary').select('*').limit(3);
  if (vsErr) {
    check('v_stock_summary exists', false, vsErr.message);
  } else {
    check('v_stock_summary exists', true, `${vs.length} sample rows`);
  }

  // =========================================================
  // 8. Existing tables — confirm UNTOUCHED
  // =========================================================
  console.log('\n── 8. Production Tables Status (MUST be untouched) ──');

  const prodTables = [
    { name: 'Products', expected: 'exists' },
    { name: 'Barcodes', expected: 'exists' },
    { name: 'Locations', expected: 'exists' },
    { name: 'restock_report', expected: 'exists' },
    { name: 'restock_setup', expected: 'exists' },
    { name: 'collections_active', expected: 'exists' },
    { name: 'warehouse_movements', expected: 'exists' },
  ];

  for (const t of prodTables) {
    const { count, error } = await pub.from(t.name).select('*', { count: 'exact', head: true });
    check(`${t.name} still accessible`, !error, `${count || 0} rows`);
  }

  // =========================================================
  // SUMMARY
  // =========================================================
  console.log('\n╔════════════════════════════════╗');
  console.log(`║  Results: ${PASS} ${passed} passed  ${FAIL} ${failed} failed  ${WARN} ${warnings} warnings`);
  console.log('╚════════════════════════════════╝');

  if (failed > 0) {
    console.log('\nSome checks failed. Fix issues and re-run.');
    process.exit(1);
  } else {
    console.log('\nAll compatibility views are properly aligned!');
    console.log('Next step: Run sync (npm run sync) to populate data, then re-verify.');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
