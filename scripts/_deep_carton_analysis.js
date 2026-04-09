#!/usr/bin/env node
/**
 * Deep analysis of carton differences: find patterns.
 * Are the differences systematic? (e.g., per-meter vs per-reel, inner vs outer)
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
  // Load spreadsheet
  const raw = fs.readFileSync('scripts/Stock qty carton e pallets', 'utf-8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const sheet = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length < 4) continue;
    const [code5dc, sku, palletStr, cartonStr] = cols;
    if (!sku || sku === 'PRODUCT CODE') continue;
    sheet.set(sku.trim(), { carton: parseInt(cartonStr) || 0, pallet: parseInt(palletStr) || 0 });
  }

  // Load Cin7
  console.log('Loading Cin7...');
  const cin7Map = new Map();
  let page = 1;
  while (true) {
    const res = await cin7Get('/product?Page=' + page + '&Limit=500&IncludeDeprecated=false');
    if (!res.Products || res.Products.length === 0) break;
    res.Products.forEach(pr => {
      cin7Map.set(pr.SKU, {
        carton: pr.CartonQuantity || 0,
        inner: pr.CartonInnerQuantity || 0,
        name: pr.Name || '',
        category: pr.Category || ''
      });
    });
    if (res.Products.length < 500) break;
    page++;
    await sleep(2600);
  }
  console.log(`Cin7: ${cin7Map.size} loaded\n`);

  // Find the 164 diffs
  const diffs = [];
  for (const [sku, sv] of sheet) {
    const c7 = cin7Map.get(sku);
    if (!c7) continue;
    if (sv.carton > 0 && c7.carton > 0 && sv.carton !== c7.carton) {
      diffs.push({ sku, sheet: sv.carton, cin7: c7.carton, inner: c7.inner, name: c7.name, category: c7.category });
    }
  }

  console.log(`Total carton differences: ${diffs.length}\n`);

  // Pattern 1: Is sheet = cin7 * some_multiplier? (e.g., per-5m vs per-1m)
  console.log('=== PATTERN ANALYSIS: sheet/cin7 ratios ===');
  const ratios = {};
  for (const d of diffs) {
    const r = (d.sheet / d.cin7).toFixed(2);
    const rInv = (d.cin7 / d.sheet).toFixed(2);
    ratios[r] = (ratios[r] || 0) + 1;
  }
  // Show top ratios
  const sorted = Object.entries(ratios).sort((a, b) => b[1] - a[1]);
  console.log('Top sheet/cin7 ratios:');
  sorted.slice(0, 15).forEach(([r, c]) => console.log(`  Ratio ${r}: ${c} items`));

  // Pattern 2: Is CartonInnerQuantity involved?
  const innerMatch = diffs.filter(d => d.inner > 0 && (d.sheet === d.inner || d.cin7 === d.inner));
  console.log(`\n=== CartonInnerQuantity match ===`);
  console.log(`Diffs where inner matches sheet or cin7: ${innerMatch.length}`);
  if (innerMatch.length > 0) {
    innerMatch.slice(0, 10).forEach(d => {
      console.log(`  ${d.sku.padEnd(30)} sheet:${d.sheet} cin7:${d.cin7} inner:${d.inner}`);
    });
  }

  // Pattern 3: Strip lights (R23xx with meter suffixes)
  const stripDiffs = diffs.filter(d => /^R23\d{2}/.test(d.sku));
  console.log(`\n=== Strip light products (R23xx) ===`);
  console.log(`Strip lights with diff: ${stripDiffs.length}/${diffs.length} (${(stripDiffs.length/diffs.length*100).toFixed(0)}%)`);
  
  // Group by base SKU to see if it's a meter-length issue
  const baseGroups = {};
  for (const d of stripDiffs) {
    const base = d.sku.replace(/-\d+(-V\d+)?$/, '');
    if (!baseGroups[base]) baseGroups[base] = [];
    baseGroups[base].push(d);
  }
  console.log(`Unique base strip SKUs: ${Object.keys(baseGroups).length}`);
  
  // Show some groups
  let shown = 0;
  for (const [base, items] of Object.entries(baseGroups)) {
    if (items.length > 1 && shown < 5) {
      console.log(`\n  ${base}:`);
      items.forEach(d => {
        const meterMatch = d.sku.match(/-(\d+)(-V\d+)?$/);
        const meters = meterMatch ? meterMatch[1] + 'm' : '?';
        console.log(`    ${d.sku.padEnd(30)} ${meters.padEnd(5)} sheet:${String(d.sheet).padStart(5)} cin7:${String(d.cin7).padStart(5)} ratio:${(d.sheet/d.cin7).toFixed(2)}`);
      });
      shown++;
    }
  }

  // Pattern 4: Category breakdown
  console.log(`\n=== CATEGORY BREAKDOWN of differences ===`);
  const cats = {};
  diffs.forEach(d => { cats[d.category || '(none)'] = (cats[d.category || '(none)'] || 0) + 1; });
  Object.entries(cats).sort((a,b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  // Pattern 5: Who is bigger?
  const sheetBigger = diffs.filter(d => d.sheet > d.cin7).length;
  const cin7Bigger = diffs.filter(d => d.cin7 > d.sheet).length;
  console.log(`\n=== DIRECTION ===`);
  console.log(`Sheet > Cin7: ${sheetBigger} (${(sheetBigger/diffs.length*100).toFixed(0)}%)`);
  console.log(`Cin7 > Sheet: ${cin7Bigger} (${(cin7Bigger/diffs.length*100).toFixed(0)}%)`);

  // Pattern 6: Check if many sheet values are close to cin7*5 or cin7*10 (multi-pack issue)
  console.log(`\n=== MULTIPLIER ANALYSIS ===`);
  for (const mult of [2, 3, 5, 10, 15, 20, 50]) {
    const near = diffs.filter(d => {
      return Math.abs(d.sheet - d.cin7 * mult) <= 2 || Math.abs(d.cin7 - d.sheet * mult) <= 2;
    });
    if (near.length > 0) {
      console.log(`Near ${mult}x: ${near.length} items`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
})();
