#!/usr/bin/env node
// _import_avg_branches.js
// Reads "AVG por branch Excel.xlsx" from Downloads and updates
// branch_avg_monthly_sales in Supabase.
// - Uses RAPID CODE as the product key
// - Cleans out products with AVG = 0 per branch (sets to 0 in DB)
// - Each sheet = one branch

const https = require('https');
const XLSX = require('xlsx');
const path = require('path');
require('dotenv').config();

const KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_HOST = 'iaqnxamnjftwqdbsnfyl.supabase.co';

// Map sheet names → DB column names
const SHEET_MAP = {
  'sydney':    'avg_mth_sydney',
  'sunshine':  'avg_mth_sunshine_coast',
  'Melbourne': 'avg_mth_melbourne',
  'Hobart':    'avg_mth_hobart',
  'coffs':     'avg_mth_coffs_harbour',
  'cairns':    'avg_mth_cairns',
  'brisbane':  'avg_mth_brisbane',
};

// Each sheet has a different AVG column name — normalize
function getAvgValue(row) {
  // Try all possible column names
  const keys = [
    'Avg mth sales',
    'Avg Montly Sales',
    'AVG MTH SALE',
    'Monthly',
    'Avg Monthly Sales',
    'avg mth sales',
    'avg monthly sales',
  ];
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '' && row[k] !== 'Average') {
      const v = Number(row[k]);
      return isNaN(v) ? 0 : v;
    }
  }
  return 0;
}

function supabaseRequest(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SUPABASE_HOST,
      path: '/rest/v1/' + pathStr,
      method,
      headers: {
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST'
          ? 'resolution=merge-duplicates,return=representation'
          : 'return=representation'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        } else {
          resolve(JSON.parse(data || '[]'));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchAllPages(select) {
  return new Promise(async (resolve, reject) => {
    let all = [];
    let offset = 0;
    while (true) {
      try {
        const rows = await new Promise((res, rej) => {
          const p = `/rest/v1/branch_avg_monthly_sales?select=${select}&order=product&offset=${offset}&limit=1000`;
          https.get({ hostname: SUPABASE_HOST, path: p, headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY } }, (resp) => {
            let body = '';
            resp.on('data', c => body += c);
            resp.on('end', () => {
              if (resp.statusCode >= 400) rej(new Error(`HTTP ${resp.statusCode}: ${body.substring(0, 200)}`));
              else res(JSON.parse(body));
            });
          }).on('error', rej);
        });
        all = all.concat(rows);
        if (rows.length < 1000) break;
        offset += 1000;
      } catch (err) { reject(err); return; }
    }
    resolve(all);
  });
}

(async () => {
  console.log('=== Import AVG from Excel → Supabase ===\n');

  // 1. Read Excel
  const filePath = path.join(require('os').homedir(), 'Downloads', 'AVG por branch Excel.xlsx');
  const wb = XLSX.readFile(filePath);
  console.log('Sheets found:', wb.SheetNames.join(', '));
  console.log('');

  // 2. Parse each sheet → { rapidCode: avgValue }
  const branchData = {}; // { dbColumn: { rapidCode: avg } }

  for (const [sheetName, dbCol] of Object.entries(SHEET_MAP)) {
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      console.log(`⚠ Sheet "${sheetName}" not found — skipping`);
      continue;
    }
    const rows = XLSX.utils.sheet_to_json(ws);
    const parsed = {};
    let withAvg = 0;
    let withoutAvg = 0;

    for (const row of rows) {
      const rapidCode = (row['RAPID CODE'] || '').trim();
      if (!rapidCode) continue;

      const avg = getAvgValue(row);
      parsed[rapidCode] = avg;
      if (avg > 0) withAvg++;
      else withoutAvg++;
    }

    branchData[dbCol] = parsed;
    console.log(`Sheet "${sheetName}" → ${dbCol}: ${withAvg} with AVG, ${withoutAvg} with AVG=0 (will be cleaned)`);
  }

  // 3. Get current DB rows
  console.log('\nFetching current DB data...');
  const currentRows = await fetchAllPages('product');
  const existingProducts = new Set(currentRows.map(r => r.product));
  console.log(`Current DB: ${currentRows.length} products\n`);

  // 4. Upsert per branch — each branch separately to avoid column mismatch
  const now = new Date().toISOString();
  let grandTotal = 0;

  // Show preview first
  console.log('\n=== PREVIEW (sample products) ===');
  const sampleProducts = ['R1021-WH-TRI', 'R3206-TRI', 'RQC', 'RSS', 'R3540-TRI', 'R-GPO2-WH'];
  for (const p of sampleProducts) {
    const vals = Object.entries(branchData).map(([col, products]) => {
      const v = products[p];
      return v !== undefined ? `${col.replace('avg_mth_', '')}=${v}` : null;
    }).filter(Boolean).join(', ');
    if (vals) console.log(`  ${p}: ${vals}`);
  }

  // Stats per branch
  console.log('\n=== STATS PER BRANCH ===');
  for (const [dbCol, products] of Object.entries(branchData)) {
    const withAvg = Object.values(products).filter(v => v > 0).length;
    const totalAvg = Object.values(products).filter(v => v > 0).reduce((s, v) => s + v, 0);
    console.log(`  ${dbCol.padEnd(25)} ${withAvg} products, total: ${Math.round(totalAvg)}/mth`);
  }

  // 5. Upsert each branch column separately
  console.log('\n=== UPSERTING (one branch at a time) ===');
  const BATCH = 500;

  for (const [dbCol, products] of Object.entries(branchData)) {
    const payload = Object.entries(products).map(([product, avg]) => ({
      product,
      [dbCol]: avg,
      updated_at: now,
    }));

    let branchUpserted = 0;
    for (let i = 0; i < payload.length; i += BATCH) {
      const batch = payload.slice(i, i + BATCH);
      try {
        const result = await supabaseRequest('POST', 'branch_avg_monthly_sales', batch);
        branchUpserted += result.length;
      } catch (err) {
        console.error(`  ${dbCol} batch ${Math.floor(i/BATCH)+1} FAILED:`, err.message);
      }
    }
    console.log(`  ${dbCol.padEnd(25)} ${branchUpserted} rows upserted (${Object.values(products).filter(v => v > 0).length} with AVG > 0)`);
    grandTotal += branchUpserted;
  }
  console.log(`\nTotal upserted: ${grandTotal}`);

  // 9. Verify
  console.log('\n=== VERIFYING ===');
  const verifyRows = await fetchAllPages('product,avg_mth_sydney,avg_mth_melbourne,avg_mth_brisbane,avg_mth_cairns,avg_mth_coffs_harbour,avg_mth_hobart,avg_mth_sunshine_coast');
  
  for (const dbCol of Object.values(SHEET_MAP)) {
    const withAvg = verifyRows.filter(r => Number(r[dbCol]) > 0).length;
    const totalAvg = verifyRows.reduce((s, r) => s + (Number(r[dbCol]) || 0), 0);
    console.log(`  ${dbCol.padEnd(25)} ${withAvg} products, total: ${Math.round(totalAvg)}/mth`);
  }

  console.log('\n✅ Done! Branch AVG data updated from Excel.');
})();
