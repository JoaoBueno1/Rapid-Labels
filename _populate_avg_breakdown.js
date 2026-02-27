// _populate_avg_breakdown.js
// Populates avg_sales_main and avg_transfer_main in branch_avg_monthly_sales
// from the Cin7 export file ("manual import avg main")
//
// avg_sales_main    = (Sale + SaleMultiple outQty) / 6.53 months
// avg_transfer_main = max(0, StockTransfer Out - StockTransfer In) / 6.53 months
// avg_mth_main      = avg_sales_main + avg_transfer_main (total, unchanged)

const https = require('https');
const fs = require('fs');
require('dotenv').config();

const KEY = process.env.SUPABASE_ANON_KEY || '';
const URL_BASE = process.env.SUPABASE_URL || '';
const MONTHS = 6.53;

function round1(v) { return Math.round(v * 10) / 10; }

// Parse Cin7 export — separate Sales and Transfer components
function parseCin7() {
  const raw = fs.readFileSync('manual import avg main', 'utf-8');
  const lines = raw.split('\n');
  const data = {};

  for (let i = 6; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 5) continue;
    const sku = (parts[0] || '').trim();
    const refType = (parts[1] || '').trim();
    const qtyIn = parseFloat((parts[3] || '0').replace(/,/g, '')) || 0;
    const qtyOut = parseFloat((parts[4] || '0').replace(/,/g, '')) || 0;
    if (!sku) continue;

    if (!data[sku]) data[sku] = { saleOut: 0, xfrOut: 0, xfrIn: 0 };

    if (refType === 'Sale' || refType === 'SaleMultiple') {
      data[sku].saleOut += qtyOut;
    } else if (refType === 'StockTransfer') {
      data[sku].xfrOut += qtyOut;
      data[sku].xfrIn += qtyIn;
    }
  }

  const result = {};
  for (const [sku, d] of Object.entries(data)) {
    const avgSales = round1(d.saleOut / MONTHS);
    const xfrNet = Math.max(0, d.xfrOut - d.xfrIn);
    const avgTransfer = round1(xfrNet / MONTHS);
    const avgTotal = round1((d.saleOut + xfrNet) / MONTHS);
    if (avgTotal > 0) {
      result[sku] = { avgSales, avgTransfer, avgTotal };
    }
  }
  return result;
}

function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'iaqnxamnjftwqdbsnfyl.supabase.co',
      path: '/rest/v1/' + path,
      method,
      headers: {
        'apikey': KEY,
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation'
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

(async () => {
  console.log('=== Populate avg_sales_main + avg_transfer_main ===\n');
  
  const cin7 = parseCin7();
  const skus = Object.keys(cin7);
  console.log('Products parsed: ' + skus.length);
  
  // Show some examples
  console.log('\nTop 10 by transfer:');
  const byXfr = skus.slice().sort((a, b) => cin7[b].avgTransfer - cin7[a].avgTransfer).slice(0, 10);
  for (const s of byXfr) {
    const d = cin7[s];
    console.log(`  ${s}: sales=${d.avgSales}/mth  transfer=${d.avgTransfer}/mth  total=${d.avgTotal}/mth`);
  }

  // Upsert in batches of 500
  const now = new Date().toISOString();
  const payload = skus.map(sku => ({
    product: sku,
    avg_sales_main: cin7[sku].avgSales,
    avg_transfer_main: cin7[sku].avgTransfer,
    updated_at: now
  }));

  console.log('\nUpserting ' + payload.length + ' rows...');
  
  let success = 0;
  const BATCH = 500;
  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    try {
      await supabaseRequest('POST', 'branch_avg_monthly_sales', batch);
      success += batch.length;
      process.stdout.write(`  ${success}/${payload.length}\r`);
    } catch (e) {
      console.error(`\nBatch ${i}-${i + batch.length} failed: ${e.message}`);
    }
  }
  
  console.log(`\n✅ Done: ${success}/${payload.length} upserted`);
  
  // Verify a few
  console.log('\nVerification (sample):');
  const check = ['R1021-WH-TRI', 'R1031-WH-TRI', 'R1011', 'R1020', 'R3542-TRI'].filter(s => cin7[s]);
  for (const sku of check) {
    const d = cin7[sku];
    console.log(`  ${sku}: sales=${d.avgSales}  xfr=${d.avgTransfer}  total=${d.avgTotal}  (total matches avg_mth_main: ${d.avgTotal})`);
  }
})();
