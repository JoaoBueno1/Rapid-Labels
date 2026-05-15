#!/usr/bin/env node
/**
 * import_avg_rep_sydney.js
 *
 * Reads "AVG Rep sydney.xlsx" from the user's Desktop and populates
 * branch_avg_monthly_sales.avg_rep_sydney for every SKU in the file.
 *
 * Expected sheet format (single sheet, headers in row 1):
 *   SKU | RAPID CODE | Avg mth sales | (anything else ignored)
 *
 * The script keys on RAPID CODE (matches what _import_avg_branches.js uses).
 *
 * Usage:
 *   node scripts/import_avg_rep_sydney.js [path-to-xlsx]
 *
 * If no path is given, looks at
 *   $USERPROFILE/OneDrive - RapidLED/Desktop/AVG Rep sydney.xlsx
 */
const https = require('https');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const HOST = 'iaqnxamnjftwqdbsnfyl.supabase.co';

const DEFAULT_PATH = path.join(
  process.env.USERPROFILE || require('os').homedir(),
  'OneDrive - RapidLED', 'Desktop', 'AVG Rep sydney.xlsx'
);

const FILE = process.argv[2] || DEFAULT_PATH;
const TARGET_COLUMN = 'avg_rep_sydney';

function avgValue(row) {
  const keys = [
    'Avg mth sales', 'Avg Montly Sales', 'AVG MTH SALE', 'Monthly',
    'Avg Monthly Sales', 'avg mth sales', 'avg monthly sales', 'Avg Sales Rep',
  ];
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '' && row[k] !== 'Average') {
      const v = Number(row[k]);
      if (!isNaN(v)) return v;
    }
  }
  return 0;
}

function supabaseRequest(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
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
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        } else {
          resolve(data ? JSON.parse(data) : []);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  console.log(`=== Importing ${TARGET_COLUMN} from xlsx ===\n`);
  if (!fs.existsSync(FILE)) {
    console.error(`File not found: ${FILE}`);
    process.exit(1);
  }
  console.log(`File: ${FILE}`);

  const wb = XLSX.readFile(FILE);
  console.log(`Sheets: ${wb.SheetNames.join(', ')}`);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  console.log(`Rows: ${rows.length}`);

  // Build { rapidCode: avg }
  const parsed = {};
  let withAvg = 0, zeroAvg = 0, blankCode = 0;
  for (const row of rows) {
    const code = (row['RAPID CODE'] || row['Rapid Code'] || row['rapid code'] || '').toString().trim();
    if (!code) { blankCode++; continue; }
    const avg = avgValue(row);
    parsed[code] = avg;
    if (avg > 0) withAvg++; else zeroAvg++;
  }
  console.log(`Parsed: ${withAvg} with AVG > 0, ${zeroAvg} with AVG = 0, ${blankCode} blank codes\n`);

  // Sample preview
  console.log('Sample (first 8 with AVG > 0):');
  const nonZero = Object.entries(parsed).filter(([, v]) => v > 0).slice(0, 8);
  for (const [code, avg] of nonZero) console.log(`  ${code.padEnd(25)} ${avg}`);

  // Upsert in batches
  const payload = Object.entries(parsed).map(([code, avg]) => ({
    product: code,
    [TARGET_COLUMN]: avg,
    updated_at: new Date().toISOString(),
  }));

  console.log(`\nUpserting ${payload.length} rows…`);
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    try {
      const res = await supabaseRequest('POST', 'branch_avg_monthly_sales', batch);
      total += res.length;
      process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}: +${res.length}\n`);
    } catch (err) {
      console.error(`  batch ${Math.floor(i / BATCH) + 1} FAILED:`, err.message);
    }
  }
  console.log(`\n✅ Total upserted: ${total}`);

  // Verify
  console.log('\nVerifying…');
  const verify = await supabaseRequest(
    'GET',
    `branch_avg_monthly_sales?select=product,${TARGET_COLUMN}&${TARGET_COLUMN}=gt.0&limit=5`
  );
  console.log(`Sample with ${TARGET_COLUMN} > 0 in DB:`);
  for (const r of verify) console.log(`  ${r.product.padEnd(25)} ${r[TARGET_COLUMN]}`);
})();
