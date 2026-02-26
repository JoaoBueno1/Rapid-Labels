const https = require('https');
const fs = require('fs');
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';
const URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const MONTHS = 6.53;

function round1(v) { return Math.round(v * 10) / 10; }

// Parse Cin7 export — Sales + Transfer NET
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
    // FinishedGoods ignored (risk of double counting)
  }
  
  const result = {};
  for (const [sku, d] of Object.entries(data)) {
    const xfrNet = Math.max(0, d.xfrOut - d.xfrIn);
    const avgMth = round1((d.saleOut + xfrNet) / MONTHS);
    if (avgMth > 0) {
      result[sku] = avgMth;
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
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
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

function fetchPage(offset) {
  return new Promise((resolve, reject) => {
    const url = `https://iaqnxamnjftwqdbsnfyl.supabase.co/rest/v1/branch_avg_monthly_sales?select=product,avg_mth_main&order=product&offset=${offset}&limit=1000`;
    https.get(url, { headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Parsing Cin7 export (Sales + Transfer NET)...');
  const cin7 = parseCin7();
  const skus = Object.keys(cin7);
  console.log('Products with avg > 0: ' + skus.length);
  
  // Get current DB values for comparison
  console.log('Fetching current DB...');
  let dbAll = [];
  let offset = 0;
  while (true) {
    const rows = await fetchPage(offset);
    dbAll = dbAll.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  const dbMap = {};
  for (const r of dbAll) dbMap[r.product] = r.avg_mth_main || 0;
  console.log('Current DB rows: ' + dbAll.length);
  
  // Build upsert payload — only update avg_mth_main
  const now = new Date().toISOString();
  const payload = skus.map(sku => ({
    product: sku,
    avg_mth_main: cin7[sku],
    updated_at: now
  }));
  
  // Show preview of changes (top 20 by difference)
  const changes = skus.map(sku => ({
    sku,
    oldVal: dbMap[sku] || 0,
    newVal: cin7[sku],
    diff: cin7[sku] - (dbMap[sku] || 0)
  })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  
  console.log('\n=== TOP 20 MUDANCAS ===');
  console.log('SKU'.padEnd(25) + 'Old(SalesOnly)  New(S+XfrNet)  Diff');
  console.log('-'.repeat(75));
  for (const c of changes.slice(0, 20)) {
    console.log(
      c.sku.padEnd(25) + 
      String(c.oldVal).padStart(12) + '  ' +
      String(c.newVal).padStart(12) + '  ' +
      (c.diff > 0 ? '+' : '') + c.diff.toFixed(1)
    );
  }
  
  const newSkus = skus.filter(s => !dbMap[s]);
  const updatedSkus = skus.filter(s => dbMap[s] && Math.abs(cin7[s] - dbMap[s]) > 0.1);
  const unchangedSkus = skus.filter(s => dbMap[s] && Math.abs(cin7[s] - dbMap[s]) <= 0.1);
  
  console.log('\n=== RESUMO ===');
  console.log('Total a upsert: ' + payload.length);
  console.log('Novos (nao existiam no DB): ' + newSkus.length);
  console.log('Atualizados (valor muda): ' + updatedSkus.length);
  console.log('Sem mudanca (diff < 0.1): ' + unchangedSkus.length);
  
  // Upsert in batches of 500
  console.log('\nUpserting...');
  let totalUpserted = 0;
  const BATCH = 500;
  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    try {
      const result = await supabaseRequest('POST', 'branch_avg_monthly_sales', batch);
      totalUpserted += result.length;
      console.log(`  Batch ${Math.floor(i/BATCH)+1}: ${result.length} rows upserted`);
    } catch (err) {
      console.error(`  Batch ${Math.floor(i/BATCH)+1} FAILED:`, err.message);
    }
  }
  console.log('Total upserted: ' + totalUpserted);
  
  // Verify: re-fetch and compare
  console.log('\n=== VERIFICACAO ===');
  let verifyAll = [];
  offset = 0;
  while (true) {
    const rows = await fetchPage(offset);
    verifyAll = verifyAll.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  const verifyMap = {};
  for (const r of verifyAll) verifyMap[r.product] = r.avg_mth_main || 0;
  
  console.log('DB rows after update: ' + verifyAll.length);
  
  // Check key products
  const checkProducts = [
    'R1021-WH-TRI', 'RQC', 'R1031-WH-TRI', 'RSS', 'R1060-WH-TRI',
    'R-GPO2-WH', 'R1055-WH-TRI', 'R3206-TRI', 'R3540-TRI', 'R9991-WH',
    'R-SLGPO2-WH', 'R2384-AL-2M', 'R-PMB', 'R3570-TRI', 'R3580',
    'R0001-RF', 'R0003', 'RSSM', 'R3118', 'R-HMB'
  ];
  
  console.log('\nSKU'.padEnd(25) + 'Antes(Sales)  Agora(S+Xfr)  Esperado  OK?');
  console.log('-'.repeat(80));
  let allOk = true;
  for (const sku of checkProducts) {
    const before = dbMap[sku] || 0;
    const now = verifyMap[sku] || 0;
    const expected = cin7[sku] || 0;
    const ok = Math.abs(now - expected) < 0.2;
    if (!ok) allOk = false;
    console.log(
      sku.padEnd(25) + 
      String(before).padStart(11) + '  ' +
      String(now).padStart(11) + '  ' +
      String(expected).padStart(8) + '  ' +
      (ok ? 'OK' : 'FAIL')
    );
  }
  
  // Overall stats
  let totalOldSum = 0, totalNewSum = 0;
  for (const r of verifyAll) totalNewSum += (r.avg_mth_main || 0);
  for (const r of dbAll) totalOldSum += (r.avg_mth_main || 0);
  
  console.log('\nTotal avg mensal DB antes:  ' + Math.round(totalOldSum));
  console.log('Total avg mensal DB agora:  ' + Math.round(totalNewSum));
  console.log('Aumento: +' + Math.round(totalNewSum - totalOldSum) + ' (+' + Math.round((totalNewSum/totalOldSum-1)*100) + '%)');
  console.log('\nAll checks passed: ' + (allOk ? 'YES' : 'NO — CHECK FAILURES ABOVE'));
})();
