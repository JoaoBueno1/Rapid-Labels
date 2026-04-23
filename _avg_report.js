#!/usr/bin/env node
// _avg_report.js — Generates AVG report for all branches
// One sheet per branch + Main sheet
// Main stock = Main Warehouse + Gateway combined
// Products with no AVG for a branch are excluded from that sheet
// Saves to Desktop as Excel file

const https = require('https');
const XLSX = require('xlsx');
const path = require('path');
require('dotenv').config();

const KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_HOST = 'iaqnxamnjftwqdbsnfyl.supabase.co';

const BRANCHES = [
  { col: 'avg_mth_main',           label: 'Main',           stockLocations: ['Main Warehouse', 'Gateway'] },
  { col: 'avg_mth_sydney',         label: 'Sydney',         stockLocations: ['Sydney', 'Sydney Warehouse'] },
  { col: 'avg_mth_melbourne',      label: 'Melbourne',      stockLocations: ['Melbourne', 'Melbourne Warehouse'] },
  { col: 'avg_mth_brisbane',       label: 'Brisbane',       stockLocations: ['Brisbane', 'Brisbane Warehouse'] },
  { col: 'avg_mth_cairns',         label: 'Cairns',         stockLocations: ['Cairns', 'Cairns Warehouse'] },
  { col: 'avg_mth_coffs_harbour',  label: 'Coffs Harbour',  stockLocations: ['Coffs Harbour', 'Coffs Harbour Warehouse'] },
  { col: 'avg_mth_hobart',         label: 'Hobart',         stockLocations: ['Hobart', 'Hobart Warehouse'] },
  { col: 'avg_mth_sunshine_coast', label: 'Sunshine Coast', stockLocations: ['Sunshine Coast', 'Sunshine Coast Warehouse'] },
];

function supaGet(tablePath, schema) {
  return new Promise((resolve, reject) => {
    const headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
    };
    if (schema) headers['Accept-Profile'] = schema;

    const fetchAll = async () => {
      let all = [];
      let offset = 0;
      const limit = 1000;
      while (true) {
        const sep = tablePath.includes('?') ? '&' : '?';
        const p = `/rest/v1/${tablePath}${sep}offset=${offset}&limit=${limit}`;
        const rows = await new Promise((res, rej) => {
          https.get({ hostname: SUPABASE_HOST, path: p, headers }, (resp) => {
            let body = '';
            resp.on('data', c => body += c);
            resp.on('end', () => {
              if (resp.statusCode >= 400) rej(new Error(`HTTP ${resp.statusCode}: ${body.substring(0, 300)}`));
              else res(JSON.parse(body || '[]'));
            });
          }).on('error', rej);
        });
        all = all.concat(rows);
        if (rows.length < limit) break;
        offset += limit;
      }
      return all;
    };
    fetchAll().then(resolve).catch(reject);
  });
}

(async () => {
  console.log('=== AVG Report Generator ===\n');

  // 1. Fetch branch_avg_monthly_sales
  console.log('Fetching branch_avg_monthly_sales...');
  const avgData = await supaGet('branch_avg_monthly_sales?select=*&order=product');
  console.log(`  → ${avgData.length} products with AVG data\n`);

  // 2. Fetch stock snapshot (all locations)
  console.log('Fetching cin7_mirror.stock_snapshot...');
  const stockData = await supaGet('stock_snapshot?select=sku,location_name,on_hand,available', 'cin7_mirror');
  console.log(`  → ${stockData.length} stock rows\n`);

  // 3. Aggregate stock by SKU + location
  // For Main: combine Main Warehouse + Gateway
  const stockBySku = {}; // { sku: { Main: qty, Sydney: qty, ... } }
  for (const row of stockData) {
    const sku = row.sku;
    const loc = (row.location_name || '').trim();
    const qty = row.available != null ? Number(row.available) : Number(row.on_hand) || 0;
    if (!sku || !loc) continue;

    if (!stockBySku[sku]) stockBySku[sku] = {};

    // Map location to branch
    for (const branch of BRANCHES) {
      const match = branch.stockLocations.some(l => l.toLowerCase() === loc.toLowerCase());
      if (match) {
        stockBySku[sku][branch.label] = (stockBySku[sku][branch.label] || 0) + qty;
        break;
      }
    }
  }

  // 4. Build AVG lookup
  const avgMap = {};
  for (const row of avgData) {
    avgMap[row.product] = row;
  }

  // 5. Create Excel workbook — one sheet per branch
  const wb = XLSX.utils.book_new();

  for (const branch of BRANCHES) {
    const rows = [];

    for (const row of avgData) {
      const avg = Number(row[branch.col]) || 0;
      if (avg <= 0) continue; // Skip products with no AVG for this branch

      const product = row.product;
      const stock = stockBySku[product] ? (stockBySku[product][branch.label] || 0) : 0;
      const mainStock = stockBySku[product] ? (stockBySku[product]['Main'] || 0) : 0;
      const coverageWeeks = avg > 0 ? Math.round((stock / (avg / 4.345)) * 10) / 10 : 0;

      const entry = {
        'Product': product,
        [`AVG/mth (${branch.label})`]: avg,
        [`Stock (${branch.label})`]: stock,
      };

      // For branches (not Main), also show Main+Gateway stock
      if (branch.label !== 'Main') {
        entry['Main+GW Stock'] = mainStock;
      }

      entry[`Coverage (weeks)`] = coverageWeeks;

      rows.push(entry);
    }

    // Sort by product
    rows.sort((a, b) => a.Product.localeCompare(b.Product));

    const ws = XLSX.utils.json_to_sheet(rows);

    // Set column widths
    ws['!cols'] = [
      { wch: 20 },  // Product
      { wch: 16 },  // AVG
      { wch: 16 },  // Stock
      { wch: 16 },  // Main+GW Stock (or coverage)
      { wch: 16 },  // Coverage
    ];

    XLSX.utils.book_append_sheet(wb, ws, branch.label);

    console.log(`Sheet "${branch.label}": ${rows.length} products with AVG > 0`);
  }

  // 6. Add Summary sheet — all products, all branches AVG side by side
  const summaryRows = [];
  for (const row of avgData) {
    const hasAnyAvg = BRANCHES.some(b => Number(row[b.col]) > 0);
    if (!hasAnyAvg) continue;

    const entry = { 'Product': row.product };
    for (const branch of BRANCHES) {
      entry[branch.label] = Number(row[branch.col]) || 0;
    }
    // Also show Main+GW combined stock
    const mainStock = stockBySku[row.product] ? (stockBySku[row.product]['Main'] || 0) : 0;
    entry['Main+GW Stock'] = mainStock;
    summaryRows.push(entry);
  }
  summaryRows.sort((a, b) => a.Product.localeCompare(b.Product));

  const summaryWs = XLSX.utils.json_to_sheet(summaryRows);
  summaryWs['!cols'] = [
    { wch: 20 },
    ...BRANCHES.map(() => ({ wch: 14 })),
    { wch: 14 },
  ];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');
  console.log(`Sheet "Summary": ${summaryRows.length} products with any AVG > 0`);

  // 7. Gateway sheet — show Gateway stock separately for visibility
  const gwRows = [];
  for (const row of stockData) {
    if ((row.location_name || '').toLowerCase() === 'gateway') {
      const sku = row.sku;
      const gwQty = row.available != null ? Number(row.available) : Number(row.on_hand) || 0;
      const mainOnlyQty = (() => {
        // Main Warehouse stock only (not including Gateway)
        let mw = 0;
        for (const s of stockData) {
          if (s.sku === sku && (s.location_name || '').toLowerCase() === 'main warehouse') {
            mw += s.available != null ? Number(s.available) : Number(s.on_hand) || 0;
          }
        }
        return mw;
      })();
      const avgMain = avgMap[sku] ? Number(avgMap[sku].avg_mth_main) || 0 : 0;

      gwRows.push({
        'Product': sku,
        'Gateway Stock': gwQty,
        'Main WH Stock': mainOnlyQty,
        'Combined (Main+GW)': mainOnlyQty + gwQty,
        'AVG Main/mth': avgMain,
      });
    }
  }
  gwRows.sort((a, b) => a.Product.localeCompare(b.Product));
  
  if (gwRows.length > 0) {
    const gwWs = XLSX.utils.json_to_sheet(gwRows);
    gwWs['!cols'] = [
      { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, gwWs, 'Gateway');
    console.log(`Sheet "Gateway": ${gwRows.length} products in Gateway`);
  }

  // 8. Save to Desktop (OneDrive Desktop on this machine)
  const desktopPath = path.join(require('os').homedir(), 'OneDrive - RapidLED', 'Desktop', 'AVG_Report_Branches.xlsx');
  XLSX.writeFile(wb, desktopPath);
  console.log(`\n✅ Report saved to: ${desktopPath}`);

  // 9. Quick stats
  console.log('\n=== Quick Stats ===');
  for (const branch of BRANCHES) {
    const productsWithAvg = avgData.filter(r => Number(r[branch.col]) > 0).length;
    const totalAvg = avgData.reduce((sum, r) => sum + (Number(r[branch.col]) || 0), 0);
    console.log(`  ${branch.label.padEnd(16)} ${productsWithAvg} products, total avg: ${Math.round(totalAvg)}/mth`);
  }
})();
