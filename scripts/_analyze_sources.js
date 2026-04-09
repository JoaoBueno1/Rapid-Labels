#!/usr/bin/env node
/**
 * Cross-reference analysis: 3 data sources for carton & pallet quantities
 * Source A: Manual Spreadsheet (scripts/Stock qty carton e pallets)
 * Source B: Supabase (restock_setup + pallet_capacity_rules)
 * Source C: Cin7 API (CartonQuantity field per product)
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

(async () => {
  console.log('='.repeat(60));
  console.log('  CARTON & PALLET — 3-SOURCE ANALYSIS');
  console.log('='.repeat(60));

  // ========================================
  // SOURCE A: Spreadsheet
  // ========================================
  const raw = fs.readFileSync('scripts/Stock qty carton e pallets', 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  console.log('\n[A] SPREADSHEET — raw lines:', lines.length);

  const sheet = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4) continue;
    const [code5dc, sku, palletStr, cartonStr, len, wid, hei, cbm] = cols;
    if (!sku || sku === 'PRODUCT CODE') continue;
    const pallet = parseInt(palletStr) || 0;
    const carton = parseInt(cartonStr) || 0;
    sheet.set(sku.trim(), {
      code5dc: (code5dc || '').trim(),
      pallet, carton,
      len: parseFloat(len) || 0,
      wid: parseFloat(wid) || 0,
      hei: parseFloat(hei) || 0,
      cbm: parseFloat(cbm) || 0
    });
  }

  let sheetWithCtn = 0, sheetWithPallet = 0, sheetWithDims = 0;
  for (const [, v] of sheet) {
    if (v.carton > 0) sheetWithCtn++;
    if (v.pallet > 0) sheetWithPallet++;
    if (v.len > 0) sheetWithDims++;
  }
  console.log('  Unique SKUs:', sheet.size);
  console.log('  With Carton Qty > 0:', sheetWithCtn, `(${(sheetWithCtn/sheet.size*100).toFixed(1)}%)`);
  console.log('  With Pallet Qty > 0:', sheetWithPallet, `(${(sheetWithPallet/sheet.size*100).toFixed(1)}%)`);
  console.log('  With Dimensions > 0:', sheetWithDims, `(${(sheetWithDims/sheet.size*100).toFixed(1)}%)`);

  // ========================================
  // SOURCE B: Supabase
  // ========================================
  // B1: pallet_capacity_rules
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

  // B2: restock_setup
  let rs = [];
  from = 0;
  while (true) {
    const { data } = await sb.from('restock_setup').select('sku,qty_per_ctn,qty_per_pallet').range(from, from + 999);
    rs = rs.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  const rsMap = new Map();
  rs.forEach(r => rsMap.set(r.sku, { ctn: r.qty_per_ctn || 0, pallet: r.qty_per_pallet || 0 }));
  const rsCtnCount = rs.filter(r => r.qty_per_ctn > 0).length;
  const rsPalletCount = rs.filter(r => r.qty_per_pallet > 0).length;

  console.log('\n[B] SUPABASE');
  console.log('  pallet_capacity_rules:', pcrMap.size, 'rows (all with qty_pallet > 0)');
  console.log('  restock_setup:', rsMap.size, 'rows');
  console.log('    with qty_per_ctn > 0:', rsCtnCount);
  console.log('    with qty_per_pallet > 0:', rsPalletCount);

  // ========================================
  // SOURCE C: Cin7 API (fetch ALL pages)
  // ========================================
  console.log('\n[C] CIN7 API — fetching all products...');
  const cin7Map = new Map();
  let page = 1;
  let totalFetched = 0;
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
        status: pr.Status
      });
    });
    totalFetched += res.Products.length;
    process.stdout.write(`  Page ${page}: ${totalFetched} products...  \r`);
    if (res.Products.length < 500) break;
    page++;
    await sleep(2600);
  }
  console.log(`  Total products loaded: ${cin7Map.size}                `);
  
  let cin7Active = 0, cin7WithCtn = 0, cin7WithDims = 0;
  for (const [, v] of cin7Map) {
    if (v.status === 'Active') cin7Active++;
    if (v.carton > 0) cin7WithCtn++;
    if (v.cartonL > 0) cin7WithDims++;
  }
  console.log(`  Active: ${cin7Active}`);
  console.log(`  With CartonQuantity > 0: ${cin7WithCtn} (${(cin7WithCtn/cin7Map.size*100).toFixed(1)}%)`);
  console.log(`  With Carton Dimensions > 0: ${cin7WithDims}`);

  // ========================================
  // CROSS-REFERENCE ANALYSIS
  // ========================================
  console.log('\n' + '='.repeat(60));
  console.log('  CROSS-REFERENCE ANALYSIS');
  console.log('='.repeat(60));

  // --- CARTON: Sheet vs Cin7 ---
  let ctn_both_agree = 0, ctn_both_differ = 0;
  let ctn_only_sheet = 0, ctn_only_cin7 = 0;
  let ctn_sheet_no_cin7 = 0;  // SKU in sheet but not in cin7 at all
  let ctn_diffs = [];

  for (const [sku, sv] of sheet) {
    const c7 = cin7Map.get(sku);
    if (!c7) {
      if (sv.carton > 0) ctn_sheet_no_cin7++;
      continue;
    }
    if (sv.carton > 0 && c7.carton > 0) {
      if (sv.carton === c7.carton) ctn_both_agree++;
      else { ctn_both_differ++; ctn_diffs.push({ sku, sheet: sv.carton, cin7: c7.carton }); }
    } else if (sv.carton > 0 && c7.carton === 0) {
      ctn_only_sheet++;
    } else if (sv.carton === 0 && c7.carton > 0) {
      ctn_only_cin7++;
    }
  }

  // Cin7 products NOT in spreadsheet
  let cin7_not_in_sheet = 0, cin7_ctn_not_in_sheet = 0;
  for (const [sku, cv] of cin7Map) {
    if (!sheet.has(sku)) {
      cin7_not_in_sheet++;
      if (cv.carton > 0) cin7_ctn_not_in_sheet++;
    }
  }

  console.log('\n--- CARTON QTY: Spreadsheet vs Cin7 API ---');
  console.log(`SKUs in both sources: ${sheet.size - ctn_sheet_no_cin7}`);
  console.log(`SKUs in sheet but NOT in Cin7: ${ctn_sheet_no_cin7}`);
  console.log(`SKUs in Cin7 but NOT in sheet: ${cin7_not_in_sheet} (${cin7_ctn_not_in_sheet} with carton > 0)`);
  console.log(`Both have carton & AGREE: ${ctn_both_agree}`);
  console.log(`Both have carton & DIFFER: ${ctn_both_differ}`);
  console.log(`Carton only in sheet (cin7=0): ${ctn_only_sheet}`);
  console.log(`Carton only in cin7 (sheet=0): ${ctn_only_cin7}`);

  if (ctn_diffs.length > 0) {
    console.log('\nTop carton differences (first 20):');
    ctn_diffs.sort((a, b) => Math.abs(b.cin7 - b.sheet) - Math.abs(a.cin7 - a.sheet));
    ctn_diffs.slice(0, 20).forEach(d => {
      const diff = d.cin7 - d.sheet;
      console.log(`  ${d.sku.padEnd(30)} sheet: ${String(d.sheet).padStart(5)}  cin7: ${String(d.cin7).padStart(5)}  diff: ${diff > 0 ? '+' : ''}${diff}`);
    });
  }

  // --- PALLET: Sheet vs pallet_capacity_rules ---
  let plt_both_agree = 0, plt_both_differ = 0;
  let plt_only_sheet = 0, plt_only_pcr = 0;
  let plt_sheet_no_pcr = 0;
  let plt_diffs = [];

  for (const [sku, sv] of sheet) {
    const pcr_v = pcrMap.get(sku);
    if (!pcr_v) {
      if (sv.pallet > 0) plt_sheet_no_pcr++;
      continue;
    }
    if (sv.pallet > 0 && pcr_v.pallet > 0) {
      if (sv.pallet === pcr_v.pallet) plt_both_agree++;
      else { plt_both_differ++; plt_diffs.push({ sku, sheet: sv.pallet, supabase: pcr_v.pallet }); }
    } else if (sv.pallet > 0 && pcr_v.pallet === 0) {
      plt_only_sheet++;
    } else if (sv.pallet === 0 && pcr_v.pallet > 0) {
      plt_only_pcr++;
    }
  }

  // PCR products NOT in spreadsheet
  let pcr_not_in_sheet = 0;
  for (const [sku] of pcrMap) {
    if (!sheet.has(sku)) pcr_not_in_sheet++;
  }

  console.log('\n--- PALLET QTY: Spreadsheet vs Supabase (pallet_capacity_rules) ---');
  console.log(`SKUs in both sources: ${sheet.size - plt_sheet_no_pcr - [...sheet].filter(([s,v]) => v.pallet === 0 && !pcrMap.has(s)).length}`);
  console.log(`SKUs in sheet but NOT in PCR: ${plt_sheet_no_pcr} (with pallet > 0)`);
  console.log(`SKUs in PCR but NOT in sheet: ${pcr_not_in_sheet}`);
  console.log(`Both have pallet & AGREE: ${plt_both_agree}`);
  console.log(`Both have pallet & DIFFER: ${plt_both_differ}`);
  console.log(`Pallet only in sheet (pcr=0): ${plt_only_sheet}`);
  console.log(`Pallet only in pcr (sheet=0): ${plt_only_pcr}`);

  if (plt_diffs.length > 0) {
    console.log('\nTop pallet differences (first 20):');
    plt_diffs.sort((a, b) => Math.abs(b.supabase - b.sheet) - Math.abs(a.supabase - a.sheet));
    plt_diffs.slice(0, 20).forEach(d => {
      const diff = d.supabase - d.sheet;
      console.log(`  ${d.sku.padEnd(30)} sheet: ${String(d.sheet).padStart(6)}  supabase: ${String(d.supabase).padStart(6)}  diff: ${diff > 0 ? '+' : ''}${diff}`);
    });
  }

  // --- DIMENSIONS: Sheet vs Cin7 ---
  let dim_both_have = 0, dim_only_sheet = 0, dim_only_cin7 = 0;
  for (const [sku, sv] of sheet) {
    const c7 = cin7Map.get(sku);
    if (!c7) continue;
    const sheetHas = sv.len > 0;
    const cin7Has = c7.cartonL > 0;
    if (sheetHas && cin7Has) dim_both_have++;
    else if (sheetHas && !cin7Has) dim_only_sheet++;
    else if (!sheetHas && cin7Has) dim_only_cin7++;
  }
  console.log('\n--- DIMENSIONS: Spreadsheet vs Cin7 (carton L/W/H) ---');
  console.log(`Both have dimensions: ${dim_both_have}`);
  console.log(`Only in sheet: ${dim_only_sheet}`);
  console.log(`Only in cin7: ${dim_only_cin7}`);

  // ========================================
  // SUMMARY & COVERAGE
  // ========================================
  console.log('\n' + '='.repeat(60));
  console.log('  COVERAGE SUMMARY');
  console.log('='.repeat(60));

  // All unique SKUs across all sources
  const allSkus = new Set([...sheet.keys(), ...cin7Map.keys(), ...pcrMap.keys(), ...rsMap.keys()]);
  console.log('\nTotal unique SKUs across all sources:', allSkus.size);

  // Carton coverage
  let anyCarton = 0;
  for (const sku of allSkus) {
    const sv = sheet.get(sku);
    const c7 = cin7Map.get(sku);
    const rs_v = rsMap.get(sku);
    if ((sv && sv.carton > 0) || (c7 && c7.carton > 0) || (rs_v && rs_v.ctn > 0)) anyCarton++;
  }
  console.log('SKUs with carton data from ANY source:', anyCarton);

  // Pallet coverage
  let anyPallet = 0;
  for (const sku of allSkus) {
    const sv = sheet.get(sku);
    const pcr_v = pcrMap.get(sku);
    const rs_v = rsMap.get(sku);
    if ((sv && sv.pallet > 0) || (pcr_v && pcr_v.pallet > 0) || (rs_v && rs_v.pallet > 0)) anyPallet++;
  }
  console.log('SKUs with pallet data from ANY source:', anyPallet);

  console.log('\n--- By source ---');
  console.log(`  Spreadsheet carton: ${sheetWithCtn}/${sheet.size}`);
  console.log(`  Cin7 API carton:    ${cin7WithCtn}/${cin7Map.size}`);
  console.log(`  restock_setup ctn:  ${rsCtnCount}/${rsMap.size}`);
  console.log(`  Spreadsheet pallet: ${sheetWithPallet}/${sheet.size}`);
  console.log(`  PCR pallet:         ${pcrMap.size}/${pcrMap.size}`);
  console.log(`  restock_setup plt:  ${rsPalletCount}/${rsMap.size}`);

  console.log('\nDone.');
  process.exit(0);
})();
