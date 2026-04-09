#!/usr/bin/env node
/**
 * Generate discrepancy report for carton & pallet quantities.
 *
 * Rules:
 *  - Cin7 API = master for CARTON data (auto-sync)
 *  - Supabase pallet_capacity_rules = master for PALLET data (system wins)
 *  - Spreadsheet discrepancies are flagged for manual review
 *
 * Outputs:
 *  1. scripts/DISCREPANCY_REPORT.txt  — full human-readable report
 *  2. scripts/Stock qty carton e pallets — CLEANED: only rows that are
 *     missing or differ vs system, for user to review and fix manually
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
  const out = [];
  const log = (s = '') => { out.push(s); console.log(s); };

  log('='.repeat(70));
  log('  DISCREPANCY REPORT — Carton & Pallet');
  log('  Generated: ' + new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  log('='.repeat(70));

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
      len: parseFloat(len) || 0,
      wid: parseFloat(wid) || 0,
      hei: parseFloat(hei) || 0,
      cbm: parseFloat(cbm) || 0,
    });
  }
  log(`\nSpreadsheet: ${sheet.size} SKUs loaded`);

  // ── Load Supabase pallet_capacity_rules ──
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
  log(`Supabase PCR: ${pcrMap.size} SKUs loaded`);

  // ── Load Cin7 API (all pages) ──
  log('Cin7 API: fetching all products...');
  const cin7Map = new Map();
  let page = 1;
  while (true) {
    const res = await cin7Get('/product?Page=' + page + '&Limit=500&IncludeDeprecated=false');
    if (!res.Products || res.Products.length === 0) break;
    res.Products.forEach(pr => {
      cin7Map.set(pr.SKU, {
        carton: pr.CartonQuantity || 0,
        inner: pr.CartonInnerQuantity || 0,
        cartonL: pr.CartonLength || 0,
        cartonW: pr.CartonWidth || 0,
        cartonH: pr.CartonHeight || 0,
        status: pr.Status,
        name: pr.Name || ''
      });
    });
    process.stdout.write(`  Page ${page}: ${cin7Map.size} products...\r`);
    if (res.Products.length < 500) break;
    page++;
    await sleep(2600);
  }
  log(`Cin7 API: ${cin7Map.size} products loaded`);

  // ══════════════════════════════════════════════════════════════════
  // SECTION 1: CARTON DISCREPANCIES (Spreadsheet vs Cin7)
  // ══════════════════════════════════════════════════════════════════
  log('\n' + '═'.repeat(70));
  log('  SECTION 1: CARTON QTY — Spreadsheet vs Cin7 API');
  log('  Rule: Cin7 is MASTER. Differences listed for review.');
  log('═'.repeat(70));

  const ctnDiffs = [];      // both have value but differ
  const ctnOnlySheet = [];  // sheet has carton, cin7 = 0
  const ctnOnlyCin7 = [];   // cin7 has carton, sheet = 0 (SKU exists in sheet)
  const ctnCin7NotInSheet = []; // cin7 has carton, SKU not in sheet at all
  let ctnAgree = 0;

  for (const [sku, sv] of sheet) {
    const c7 = cin7Map.get(sku);
    if (!c7) {
      // SKU not in Cin7 — skip (probably discontinued)
      continue;
    }
    if (sv.carton > 0 && c7.carton > 0) {
      if (sv.carton === c7.carton) ctnAgree++;
      else ctnDiffs.push({ sku, sheet: sv.carton, cin7: c7.carton, diff: c7.carton - sv.carton, name: c7.name });
    } else if (sv.carton > 0 && c7.carton === 0) {
      ctnOnlySheet.push({ sku, sheet: sv.carton, name: c7.name });
    } else if (sv.carton === 0 && c7.carton > 0) {
      ctnOnlyCin7.push({ sku, cin7: c7.carton, name: c7.name });
    }
  }

  // Cin7 products with carton that don't exist in sheet
  for (const [sku, cv] of cin7Map) {
    if (!sheet.has(sku) && cv.carton > 0) {
      ctnCin7NotInSheet.push({ sku, cin7: cv.carton, name: cv.name });
    }
  }

  log(`\nCarton values AGREE: ${ctnAgree}`);
  log(`Carton values DIFFER: ${ctnDiffs.length}`);
  log(`Carton only in spreadsheet (Cin7=0): ${ctnOnlySheet.length}`);
  log(`Carton only in Cin7 (sheet=0): ${ctnOnlyCin7.length}`);
  log(`Cin7 carton SKUs NOT in spreadsheet: ${ctnCin7NotInSheet.length}`);

  // Sort by abs diff
  ctnDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  log(`\n── 1A. ALL ${ctnDiffs.length} CARTON DIFFERENCES (sheet vs cin7) ──`);
  log(pad('SKU', 35) + rpad('SHEET', 7) + rpad('CIN7', 7) + rpad('DIFF', 8) + '  PRODUCT NAME');
  log('-'.repeat(100));
  for (const d of ctnDiffs) {
    const sign = d.diff > 0 ? '+' : '';
    log(pad(d.sku, 35) + rpad(d.sheet, 7) + rpad(d.cin7, 7) + rpad(sign + d.diff, 8) + '  ' + (d.name || '').slice(0, 40));
  }

  log(`\n── 1B. CARTON ONLY IN SPREADSHEET (Cin7 = 0) — ${ctnOnlySheet.length} items ──`);
  log('These exist in Cin7 but CartonQuantity=0. Sheet has a value.');
  log(pad('SKU', 35) + rpad('SHEET', 7) + '  PRODUCT NAME');
  log('-'.repeat(80));
  ctnOnlySheet.sort((a, b) => b.sheet - a.sheet);
  for (const d of ctnOnlySheet) {
    log(pad(d.sku, 35) + rpad(d.sheet, 7) + '  ' + (d.name || '').slice(0, 40));
  }

  log(`\n── 1C. CARTON ONLY IN CIN7 (sheet = 0) — ${ctnOnlyCin7.length} items ──`);
  log('SKU exists in spreadsheet but carton=0. Cin7 has a value.');
  log(pad('SKU', 35) + rpad('CIN7', 7) + '  PRODUCT NAME');
  log('-'.repeat(80));
  ctnOnlyCin7.sort((a, b) => b.cin7 - a.cin7);
  for (const d of ctnOnlyCin7) {
    log(pad(d.sku, 35) + rpad(d.cin7, 7) + '  ' + (d.name || '').slice(0, 40));
  }

  log(`\n── 1D. CIN7 CARTON SKUs NOT IN SPREADSHEET — ${ctnCin7NotInSheet.length} items ──`);
  log('Products with CartonQuantity>0 in Cin7 that are completely missing from spreadsheet.');
  log(pad('SKU', 35) + rpad('CIN7', 7) + '  PRODUCT NAME');
  log('-'.repeat(80));
  ctnCin7NotInSheet.sort((a, b) => b.cin7 - a.cin7);
  for (const d of ctnCin7NotInSheet) {
    log(pad(d.sku, 35) + rpad(d.cin7, 7) + '  ' + (d.name || '').slice(0, 40));
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 2: PALLET DISCREPANCIES (Spreadsheet vs System/PCR)
  // ══════════════════════════════════════════════════════════════════
  log('\n' + '═'.repeat(70));
  log('  SECTION 2: PALLET QTY — Spreadsheet vs System (pallet_capacity_rules)');
  log('  Rule: SYSTEM IS MASTER. Spreadsheet is considered wrong when different.');
  log('═'.repeat(70));

  const pltDiffs = [];
  const pltOnlySheet = [];   // sheet has pallet, system doesn't have SKU
  let pltAgree = 0;

  for (const [sku, sv] of sheet) {
    const pcr_v = pcrMap.get(sku);
    if (!pcr_v) {
      if (sv.pallet > 0) pltOnlySheet.push({ sku, sheet: sv.pallet, code5dc: sv.code5dc });
      continue;
    }
    if (sv.pallet > 0 && pcr_v.pallet > 0) {
      if (sv.pallet === pcr_v.pallet) pltAgree++;
      else pltDiffs.push({ sku, sheet: sv.pallet, system: pcr_v.pallet, diff: pcr_v.pallet - sv.pallet });
    }
  }

  log(`\nPallet values AGREE: ${pltAgree}`);
  log(`Pallet values DIFFER: ${pltDiffs.length} (system kept, spreadsheet considered wrong)`);
  log(`Pallet only in spreadsheet (not in system): ${pltOnlySheet.length}`);

  pltDiffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  log(`\n── 2A. ALL ${pltDiffs.length} PALLET DIFFERENCES ──`);
  log('⚠ SYSTEM VALUE IS KEPT. Spreadsheet value shown for your review.');
  log(pad('SKU', 35) + rpad('SHEET', 8) + rpad('SYSTEM', 8) + rpad('DIFF', 8) + '  ACTION');
  log('-'.repeat(90));
  for (const d of pltDiffs) {
    const sign = d.diff > 0 ? '+' : '';
    log(pad(d.sku, 35) + rpad(d.sheet, 8) + rpad(d.system, 8) + rpad(sign + d.diff, 8) + '  KEEP SYSTEM');
  }

  log(`\n── 2B. PALLET ONLY IN SPREADSHEET (not in system) — ${pltOnlySheet.length} items ──`);
  log('These SKUs have pallet values in the spreadsheet but no row in pallet_capacity_rules.');
  log('These could be ADDED to the system if you confirm they are correct.');
  log(pad('SKU', 35) + rpad('PALLET', 8));
  log('-'.repeat(50));
  pltOnlySheet.sort((a, b) => b.sheet - a.sheet);
  for (const d of pltOnlySheet) {
    log(pad(d.sku, 35) + rpad(d.sheet, 8));
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION 3: SUMMARY
  // ══════════════════════════════════════════════════════════════════
  log('\n' + '═'.repeat(70));
  log('  SECTION 3: ACTION SUMMARY');
  log('═'.repeat(70));
  log(`\nCARTON:`);
  log(`  ✅ ${ctnAgree} SKUs agree between spreadsheet and Cin7`);
  log(`  ⚠  ${ctnDiffs.length} SKUs differ — listed above for your review`);
  log(`  📋 ${ctnOnlySheet.length} SKUs have carton in sheet but Cin7=0`);
  log(`  📋 ${ctnOnlyCin7.length} SKUs have carton in Cin7 but sheet=0`);
  log(`  🆕 ${ctnCin7NotInSheet.length} Cin7 SKUs missing from spreadsheet entirely`);
  log(`\nPALLET:`);
  log(`  ✅ ${pltAgree} SKUs agree between spreadsheet and system`);
  log(`  ⚠  ${pltDiffs.length} SKUs differ — SYSTEM KEPT, listed for review`);
  log(`  🆕 ${pltOnlySheet.length} SKUs in sheet but not in system (potential additions)`);
  log(`\nNEXT STEPS:`);
  log(`  1. Review carton differences (Section 1A) — decide if Cin7 or spreadsheet is correct`);
  log(`  2. Review pallet differences (Section 2A) — system values are kept`);
  log(`  3. Decide: add the ${pltOnlySheet.length} new pallet SKUs to pallet_capacity_rules?`);
  log(`  4. Once confirmed, auto-sync Cin7 carton data → restock_setup.qty_per_ctn`);

  // ── Write report file ──
  fs.writeFileSync('scripts/DISCREPANCY_REPORT.txt', out.join('\n'), 'utf-8');
  log('\n✅ Report saved to: scripts/DISCREPANCY_REPORT.txt');

  process.exit(0);
})();
