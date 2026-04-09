#!/usr/bin/env node
/**
 * MERGE SCRIPT — Carton & Pallet data into Supabase
 *
 * Actions:
 *  1. Write qty_per_ctn to restock_setup for ALL carton data:
 *     - 1675 agree (sheet value = cin7 value)
 *     - 164 diffs → use SPREADSHEET value
 *     - 246 only-in-sheet → use spreadsheet value
 *     - 21 only-in-cin7 → use cin7 value
 *     - 835 cin7-not-in-sheet → use cin7 value
 *  2. Write 224 new pallet rows to pallet_capacity_rules
 *  3. Generate MANUAL_ADJUSTMENTS.txt — clean list for user to fix in Cin7/spreadsheet
 *
 * NO changes to Cin7 API.
 */
require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ACCT = process.env.CIN7_ACCOUNT_ID;
const KEY  = process.env.CIN7_API_KEY;

function cin7Get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'inventory.dearsystems.com',
      path: '/ExternalApi/v2' + path,
      method: 'GET',
      headers: { 'api-auth-accountid': ACCT, 'api-auth-applicationkey': KEY }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve(d) } });
    });
    req.on('error', reject); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pad(s, n) { return String(s).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }

(async () => {
  console.log('=== MERGE: Loading all 3 sources ===\n');

  // ── Load spreadsheet ──
  const raw = fs.readFileSync('scripts/Stock qty carton e pallets', 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const sheet = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4) continue;
    const [code5dc, sku, palletStr, cartonStr, len, wid, hei, cbm] = cols;
    if (!sku || sku === 'PRODUCT CODE') continue;
    sheet.set(sku.trim(), {
      code5dc: (code5dc || '').trim(),
      pallet: parseInt(palletStr) || 0,
      carton: parseInt(cartonStr) || 0,
    });
  }
  console.log(`Spreadsheet: ${sheet.size} SKUs`);

  // ── Load pallet_capacity_rules ──
  let pcr = [];
  let from = 0;
  while (true) {
    const { data } = await sb.from('pallet_capacity_rules').select('sku,product,qty_pallet').range(from, from + 999);
    pcr = pcr.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const pcrMap = new Map();
  pcr.forEach(r => pcrMap.set(r.product, { code5dc: r.sku, pallet: r.qty_pallet }));
  console.log(`Supabase PCR: ${pcrMap.size} rows`);

  // ── Load restock_setup products ──
  let rs = [];
  from = 0;
  while (true) {
    const { data } = await sb.from('restock_setup').select('sku,product').range(from, from + 999);
    rs = rs.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const rsProducts = new Set(rs.map(r => r.product));
  console.log(`Supabase restock_setup: ${rsProducts.size} products`);

  // ── Load Cin7 ──
  console.log('Cin7 API: loading...');
  const cin7Map = new Map();
  let page = 1;
  while (true) {
    const res = await cin7Get('/product?Page=' + page + '&Limit=500&IncludeDeprecated=false');
    if (!res.Products || res.Products.length === 0) break;
    res.Products.forEach(pr => {
      cin7Map.set(pr.SKU, {
        carton: pr.CartonQuantity || 0,
        name: pr.Name || ''
      });
    });
    process.stdout.write(`  Page ${page}: ${cin7Map.size}...\r`);
    if (res.Products.length < 500) break;
    page++;
    await sleep(2600);
  }
  console.log(`Cin7 API: ${cin7Map.size} products       `);

  // ══════════════════════════════════════════════════════════════
  // CLASSIFY ALL CARTON DATA
  // ══════════════════════════════════════════════════════════════
  const cartonUpdates = [];  // { sku, qty_per_ctn, source }
  const docLines = [];       // for MANUAL_ADJUSTMENTS.txt

  // Category A: SKUs in both sheet and cin7
  const ctnDiffs = [];
  const ctnOnlySheet = [];
  const ctnOnlyCin7 = [];
  let ctnAgree = 0;

  for (const [sku, sv] of sheet) {
    const c7 = cin7Map.get(sku);
    if (!c7) continue; // handled below
    if (sv.carton > 0 && c7.carton > 0) {
      if (sv.carton === c7.carton) {
        ctnAgree++;
        cartonUpdates.push({ sku, qty: sv.carton, source: 'agree' });
      } else {
        ctnDiffs.push({ sku, sheet: sv.carton, cin7: c7.carton, name: c7.name });
        cartonUpdates.push({ sku, qty: sv.carton, source: 'diff-use-sheet' });
      }
    } else if (sv.carton > 0 && c7.carton === 0) {
      ctnOnlySheet.push({ sku, sheet: sv.carton, name: c7.name });
      cartonUpdates.push({ sku, qty: sv.carton, source: 'only-sheet' });
    } else if (sv.carton === 0 && c7.carton > 0) {
      ctnOnlyCin7.push({ sku, cin7: c7.carton, name: c7.name });
      cartonUpdates.push({ sku, qty: c7.carton, source: 'only-cin7' });
    }
  }

  // Category B: Cin7 products NOT in spreadsheet at all
  const ctnNotInSheet = [];
  for (const [sku, cv] of cin7Map) {
    if (!sheet.has(sku) && cv.carton > 0) {
      ctnNotInSheet.push({ sku, cin7: cv.carton, name: cv.name });
      cartonUpdates.push({ sku, qty: cv.carton, source: 'cin7-only' });
    }
  }

  console.log(`\nCarton classification:`);
  console.log(`  Agree: ${ctnAgree}`);
  console.log(`  Differ (use sheet): ${ctnDiffs.length}`);
  console.log(`  Only sheet: ${ctnOnlySheet.length}`);
  console.log(`  Only Cin7 (sku in sheet): ${ctnOnlyCin7.length}`);
  console.log(`  Cin7 not in sheet: ${ctnNotInSheet.length}`);
  console.log(`  TOTAL carton updates: ${cartonUpdates.length}`);

  // ══════════════════════════════════════════════════════════════
  // CLASSIFY PALLET DATA
  // ══════════════════════════════════════════════════════════════
  const pltDiffs = [];
  const pltNewFromSheet = [];

  for (const [sku, sv] of sheet) {
    const pcr_v = pcrMap.get(sku);
    if (!pcr_v) {
      if (sv.pallet > 0) {
        pltNewFromSheet.push({ sku, pallet: sv.pallet, code5dc: sv.code5dc });
      }
      continue;
    }
    if (sv.pallet > 0 && pcr_v.pallet > 0 && sv.pallet !== pcr_v.pallet) {
      pltDiffs.push({ sku, sheet: sv.pallet, system: pcr_v.pallet });
    }
  }

  console.log(`\nPallet classification:`);
  console.log(`  Differ (keep system): ${pltDiffs.length}`);
  console.log(`  New from sheet: ${pltNewFromSheet.length}`);

  // ══════════════════════════════════════════════════════════════
  // STEP 1: UPDATE restock_setup.qty_per_ctn
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== STEP 1: Updating restock_setup.qty_per_ctn ===');

  // Only update SKUs that exist in restock_setup (match on product column)
  const updatable = cartonUpdates.filter(u => rsProducts.has(u.sku));
  const notInRs = cartonUpdates.filter(u => !rsProducts.has(u.sku));
  console.log(`  SKUs in restock_setup: ${updatable.length}`);
  console.log(`  SKUs NOT in restock_setup (skipped): ${notInRs.length}`);

  // Batch upsert in chunks of 100
  let updated = 0, errors = 0;
  for (let i = 0; i < updatable.length; i += 100) {
    const batch = updatable.slice(i, i + 100);
    const rows = batch.map(u => ({ sku: u.sku, qty_per_ctn: u.qty }));

    // Use individual updates matching on 'product' column
    for (const row of rows) {
      const { error } = await sb
        .from('restock_setup')
        .update({ qty_per_ctn: row.qty_per_ctn })
        .eq('product', row.sku);
      if (error) {
        if (errors < 5) console.log(`    Error ${row.sku}: ${error.message}`);
        errors++;
      } else {
        updated++;
      }
    }
    process.stdout.write(`  Updated ${updated}/${updatable.length}...\r`);
  }
  console.log(`  ✅ Updated qty_per_ctn: ${updated} rows (${errors} errors)       `);

  // ══════════════════════════════════════════════════════════════
  // STEP 2: UPDATE restock_setup.qty_per_pallet from PCR (77 diffs = keep system)
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== STEP 2: Syncing pallet data to restock_setup.qty_per_pallet ===');

  // Merge ALL pallet_capacity_rules into restock_setup.qty_per_pallet
  let pltUpdated = 0, pltErrors = 0;
  const allPalletUpdates = [];

  // From existing PCR
  for (const [sku, pv] of pcrMap) {
    if (rsProducts.has(sku)) {
      allPalletUpdates.push({ sku, qty: pv.pallet });
    }
  }

  // From new sheet entries (will also be added to PCR)
  for (const item of pltNewFromSheet) {
    if (rsProducts.has(item.sku)) {
      allPalletUpdates.push({ sku: item.sku, qty: item.pallet });
    }
  }

  for (const row of allPalletUpdates) {
    const { error } = await sb
      .from('restock_setup')
      .update({ qty_per_pallet: row.qty })
      .eq('product', row.sku);
    if (error) {
      if (pltErrors < 5) console.log(`    Error ${row.sku}: ${error.message}`);
      pltErrors++;
    } else {
      pltUpdated++;
    }
  }
  console.log(`  ✅ Updated qty_per_pallet: ${pltUpdated} rows (${pltErrors} errors)`);

  // ══════════════════════════════════════════════════════════════
  // STEP 3: INSERT new pallets into pallet_capacity_rules (skip existing)
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== STEP 3: Adding new pallet rows to pallet_capacity_rules ===');

  // Re-load current PCR to avoid duplicates
  const currentPcr = new Set();
  let pf = 0;
  while (true) {
    const { data } = await sb.from('pallet_capacity_rules').select('product').range(pf, pf + 999);
    (data || []).forEach(r => currentPcr.add(r.product));
    if (!data || data.length < 1000) break;
    pf += 1000;
  }

  const toInsert = pltNewFromSheet.filter(item => !currentPcr.has(item.sku));
  console.log(`  Already in PCR: ${pltNewFromSheet.length - toInsert.length}, to insert: ${toInsert.length}`);

  let pcrInserted = 0, pcrErrors = 0;
  for (let i = 0; i < toInsert.length; i += 50) {
    const batch = toInsert.slice(i, i + 50).map(item => ({
      product: item.sku,
      sku: item.code5dc,
      qty_pallet: item.pallet
    }));

    const { error } = await sb.from('pallet_capacity_rules').insert(batch);
    if (error) {
      if (pcrErrors < 3) console.log(`    Error: ${error.message}`);
      pcrErrors++;
      for (const row of batch) {
        const { error: e2 } = await sb.from('pallet_capacity_rules').insert(row);
        if (!e2) pcrInserted++;
      }
    } else {
      pcrInserted += batch.length;
    }
    process.stdout.write(`  Inserted ${pcrInserted}/${toInsert.length}...\r`);
  }
  console.log(`  ✅ Added to pallet_capacity_rules: ${pcrInserted} new rows       `);

  // ══════════════════════════════════════════════════════════════
  // STEP 4: Generate MANUAL_ADJUSTMENTS.txt
  // ══════════════════════════════════════════════════════════════
  console.log('\n=== STEP 4: Generating MANUAL_ADJUSTMENTS.txt ===');

  const doc = [];
  const addLine = (s = '') => doc.push(s);

  addLine('╔══════════════════════════════════════════════════════════════════════╗');
  addLine('║         MANUAL ADJUSTMENTS NEEDED — ' + new Date().toISOString().slice(0, 10) + '                      ║');
  addLine('║  Review and fix these items in Cin7 and/or Spreadsheet            ║');
  addLine('╚══════════════════════════════════════════════════════════════════════╝');

  // ── LIST 1: Carton diffs → Fix in Cin7 (use spreadsheet value) ──
  addLine('');
  addLine('━'.repeat(70));
  addLine('  LIST 1: CARTON DIFFERENCES — Fix in Cin7');
  addLine('  These have different values. Spreadsheet was used in our system.');
  addLine('  → Update Cin7 CartonQuantity to match the CORRECT column.');
  addLine('━'.repeat(70));
  addLine('');
  addLine(pad('SKU', 35) + rpad('OURS', 7) + rpad('CIN7', 7) + '  PRODUCT');
  addLine('─'.repeat(90));
  ctnDiffs.sort((a, b) => Math.abs(b.sheet - b.cin7) - Math.abs(a.sheet - a.cin7));
  for (const d of ctnDiffs) {
    addLine(pad(d.sku, 35) + rpad(d.sheet, 7) + rpad(d.cin7, 7) + '  ' + (d.name || '').slice(0, 40));
  }
  addLine(`\nTotal: ${ctnDiffs.length} items`);

  // ── LIST 2: Carton only in spreadsheet → Add to Cin7 ──
  addLine('');
  addLine('━'.repeat(70));
  addLine('  LIST 2: CARTON ONLY IN SPREADSHEET — Add to Cin7');
  addLine('  These exist in Cin7 but CartonQuantity = 0.');
  addLine('  → Set CartonQuantity in Cin7 to the value shown.');
  addLine('━'.repeat(70));
  addLine('');
  addLine(pad('SKU', 35) + rpad('QTY', 7) + '  PRODUCT');
  addLine('─'.repeat(80));
  ctnOnlySheet.sort((a, b) => b.sheet - a.sheet);
  for (const d of ctnOnlySheet) {
    addLine(pad(d.sku, 35) + rpad(d.sheet, 7) + '  ' + (d.name || '').slice(0, 40));
  }
  addLine(`\nTotal: ${ctnOnlySheet.length} items`);

  // ── LIST 3: Carton only in Cin7 → Add to spreadsheet ──
  addLine('');
  addLine('━'.repeat(70));
  addLine('  LIST 3: CARTON ONLY IN CIN7 — Add to Spreadsheet');
  addLine('  Spreadsheet has carton = 0 for these. Cin7 has a value.');
  addLine('  → Update spreadsheet Carton Qty to the value shown.');
  addLine('━'.repeat(70));
  addLine('');
  addLine(pad('SKU', 35) + rpad('QTY', 7) + '  PRODUCT');
  addLine('─'.repeat(80));
  ctnOnlyCin7.sort((a, b) => b.cin7 - a.cin7);
  for (const d of ctnOnlyCin7) {
    addLine(pad(d.sku, 35) + rpad(d.cin7, 7) + '  ' + (d.name || '').slice(0, 40));
  }
  addLine(`\nTotal: ${ctnOnlyCin7.length} items`);

  // ── LIST 4: Cin7 products not in spreadsheet → Add to spreadsheet ──
  addLine('');
  addLine('━'.repeat(70));
  addLine('  LIST 4: CIN7 PRODUCTS NOT IN SPREADSHEET — Add to Spreadsheet');
  addLine('  These products have CartonQuantity in Cin7 but are missing');
  addLine('  entirely from the spreadsheet.');
  addLine('  → Add new rows to spreadsheet with these SKUs and quantities.');
  addLine('━'.repeat(70));
  addLine('');
  addLine(pad('SKU', 35) + rpad('QTY', 7) + '  PRODUCT');
  addLine('─'.repeat(80));
  ctnNotInSheet.sort((a, b) => b.cin7 - a.cin7);
  for (const d of ctnNotInSheet) {
    addLine(pad(d.sku, 35) + rpad(d.cin7, 7) + '  ' + (d.name || '').slice(0, 40));
  }
  addLine(`\nTotal: ${ctnNotInSheet.length} items`);

  // ── LIST 5: Pallet diffs → Fix in spreadsheet (system kept) ──
  addLine('');
  addLine('━'.repeat(70));
  addLine('  LIST 5: PALLET DIFFERENCES — Fix in Spreadsheet');
  addLine('  System value was kept. Update spreadsheet to match.');
  addLine('  → Change spreadsheet Pallet Qty to SYSTEM value.');
  addLine('━'.repeat(70));
  addLine('');
  addLine(pad('SKU', 35) + rpad('SYSTEM', 8) + rpad('SHEET', 8) + '  (sheet is wrong)');
  addLine('─'.repeat(70));
  pltDiffs.sort((a, b) => Math.abs(b.system - b.sheet) - Math.abs(a.system - a.sheet));
  for (const d of pltDiffs) {
    addLine(pad(d.sku, 35) + rpad(d.system, 8) + rpad(d.sheet, 8));
  }
  addLine(`\nTotal: ${pltDiffs.length} items`);

  // ── SUMMARY ──
  addLine('');
  addLine('═'.repeat(70));
  addLine('  SUMMARY — What you need to do');
  addLine('═'.repeat(70));
  addLine(`  LIST 1: ${ctnDiffs.length} items — Fix CartonQuantity in Cin7 (values differ)`);
  addLine(`  LIST 2: ${ctnOnlySheet.length} items — Add CartonQuantity to Cin7 (currently 0)`);
  addLine(`  LIST 3: ${ctnOnlyCin7.length} items — Add Carton Qty to Spreadsheet`);
  addLine(`  LIST 4: ${ctnNotInSheet.length} items — Add rows to Spreadsheet (missing)`);
  addLine(`  LIST 5: ${pltDiffs.length} items — Fix Pallet Qty in Spreadsheet`);
  addLine(`  ─────────────────────────────────────────`);
  addLine(`  TOTAL items to review: ${ctnDiffs.length + ctnOnlySheet.length + ctnOnlyCin7.length + ctnNotInSheet.length + pltDiffs.length}`);
  addLine('');
  addLine('  ✅ Already done by system:');
  addLine(`    • ${updated} restock_setup rows updated with qty_per_ctn`);
  addLine(`    • ${pltUpdated} restock_setup rows updated with qty_per_pallet`);
  addLine(`    • ${pcrInserted} new rows added to pallet_capacity_rules`);

  fs.writeFileSync('scripts/MANUAL_ADJUSTMENTS.txt', doc.join('\n'), 'utf-8');
  console.log('✅ Saved: scripts/MANUAL_ADJUSTMENTS.txt');

  console.log('\n=== ALL DONE ===');
  console.log(`  Carton → restock_setup: ${updated} updated`);
  console.log(`  Pallet → restock_setup: ${pltUpdated} updated`);
  console.log(`  Pallet → pallet_capacity_rules: ${pcrInserted} new rows`);
  console.log(`  Manual doc: scripts/MANUAL_ADJUSTMENTS.txt`);

  process.exit(0);
})();
