#!/usr/bin/env node
/**
 * FAST ANALYSIS — BOM/Production vs Normal Orders (last month)
 * 
 * Strategy (fast — no per-order detail fetching for all):
 *   1. Get BOM/Production SKUs from cin7_mirror.products
 *   2. Get FinishedGoods list to count assembly-linked orders
 *   3. Get total order counts from Cin7 saleList
 *   4. Sample 100 orders for detailed line-item BOM analysis
 */
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const CIN7 = {
  baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
  accountId: process.env.CIN7_ACCOUNT_ID || '',
  apiKey:    process.env.CIN7_API_KEY || '',
};

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const RATE_DELAY = 2500;
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function cin7Get(endpoint) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Cin7 ${res.status}: ${res.statusText}`);
  return res.json();
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  📊 FAST ANALYSIS: BOM/Production vs Normal (Last 30 days)');
  console.log('═══════════════════════════════════════════════════════════');

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - 30);
  const dateFromStr = dateFrom.toISOString().split('T')[0];
  console.log(`  Period: ${dateFromStr} → today`);

  // ═══ STEP 1: Get BOM/Production SKUs from Supabase ═══
  console.log('\n📦 Step 1: BOM/Production product catalog...');
  const bomRes = await fetch(
    `${SUPABASE_URL}/rest/v1/products?select=sku,stock_locator,name,category&or=(stock_locator.eq.BOM,stock_locator.eq.Production)&limit=5000`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept-Profile': 'cin7_mirror',
      },
    }
  );
  const bomProducts = await bomRes.json();
  const bomSkuSet = new Set(bomProducts.map(p => p.sku));
  const bomCount = bomProducts.filter(p => p.stock_locator === 'BOM').length;
  const prodCount = bomProducts.filter(p => p.stock_locator === 'Production').length;

  // Get total product count
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/products?select=sku`, {
    method: 'HEAD',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Accept-Profile': 'cin7_mirror',
      'Prefer': 'count=exact',
    },
  });
  const range = countRes.headers.get('content-range');
  const totalProducts = range ? parseInt(range.split('/')[1]) : 0;

  console.log(`  Total products in catalog: ${totalProducts}`);
  console.log(`  BOM/Production SKUs:       ${bomProducts.length} (${((bomProducts.length / totalProducts) * 100).toFixed(1)}%)`);
  console.log(`    → BOM:        ${bomCount}`);
  console.log(`    → Production: ${prodCount}`);

  // Show sample
  console.log('\n  Sample BOM/Production products:');
  for (const p of bomProducts.slice(0, 8)) {
    console.log(`    [${p.stock_locator}] ${p.sku} — ${(p.name || 'N/A').substring(0, 60)}`);
  }
  if (bomProducts.length > 8) console.log(`    ... and ${bomProducts.length - 8} more`);

  // ═══ STEP 2: FinishedGoods / Assembly tasks ═══
  console.log('\n🔧 Step 2: Finished Goods / Assembly tasks (last 30 days)...');
  let totalFgTasks = 0;
  let fgLinkedOrders = new Set();
  let fgPage = 1;
  let fgStatuses = {};
  let fgProducts = {};

  while (true) {
    await delay(RATE_DELAY);
    const data = await cin7Get(`finishedGoodsList?UpdatedSince=${dateFromStr}&Page=${fgPage}&Limit=250`);
    const list = data.FinishedGoodsList || data.FinishedGoods || [];
    totalFgTasks += list.length;

    for (const fg of list) {
      fgStatuses[fg.Status] = (fgStatuses[fg.Status] || 0) + 1;
      if (fg.ProductCode) fgProducts[fg.ProductCode] = (fgProducts[fg.ProductCode] || 0) + 1;
      if (fg.Notes) {
        const m = fg.Notes.match(/SO-\d+/g);
        if (m) m.forEach(so => fgLinkedOrders.add(so));
      }
    }

    console.log(`  Page ${fgPage}: ${list.length} tasks (running total: ${totalFgTasks})`);
    if (list.length < 250) break;
    fgPage++;
  }

  console.log(`\n  Total FG/Assembly tasks:        ${totalFgTasks}`);
  console.log(`  Unique orders linked to FG:     ${fgLinkedOrders.size}`);
  console.log(`  Task status breakdown:`);
  for (const [status, count] of Object.entries(fgStatuses).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status}: ${count}`);
  }

  // Top FG products
  const topFgProds = Object.entries(fgProducts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topFgProds.length) {
    console.log(`  Top FG products assembled:`);
    for (const [code, cnt] of topFgProds) {
      console.log(`    ${cnt}x ${code}`);
    }
  }

  // ═══ STEP 3: Total order count ═══
  console.log('\n📋 Step 3: Total order counts (last 30 days)...');
  await delay(RATE_DELAY);
  const fulfilledData = await cin7Get(`saleList?UpdatedSince=${dateFromStr}&FulFilmentStatus=FULFILLED&Page=1&Limit=1`);
  const totalFulfilled = fulfilledData.Total || 0;

  await delay(RATE_DELAY);
  const invoicedData = await cin7Get(`saleList?UpdatedSince=${dateFromStr}&FulFilmentStatus=INVOICED&Page=1&Limit=1`);
  const totalInvoiced = invoicedData.Total || 0;

  console.log(`  FULFILLED orders (modified last 30d): ${totalFulfilled}`);
  console.log(`  INVOICED orders (modified last 30d):  ${totalInvoiced}`);
  console.log(`  Note: UpdatedSince uses LastModifiedOn, so includes old orders modified recently`);

  // ═══ STEP 4: Sample 100 orders for detailed analysis ═══
  const SAMPLE_SIZE = 100;
  console.log(`\n🔍 Step 4: Sampling ${SAMPLE_SIZE} recent orders for BOM line-item analysis...`);

  await delay(RATE_DELAY);
  const sampleData = await cin7Get(`saleList?UpdatedSince=${dateFromStr}&FulFilmentStatus=FULFILLED&Page=1&Limit=${SAMPLE_SIZE}`);
  const sampleList = sampleData.SaleList || [];

  let withBom = 0;
  let normalOnly = 0;
  let errors = 0;
  let totalLineItems = 0;
  let bomLineItems = 0;
  let normalLineItems = 0;
  const bomOrderExamples = [];

  for (let i = 0; i < sampleList.length; i++) {
    const order = sampleList[i];
    try {
      await delay(RATE_DELAY);
      const detail = await cin7Get(`sale?ID=${order.SaleID}`);
      const lines = detail.Lines || [];

      let hasBom = false;
      let orderBomCount = 0;
      let orderNormalCount = 0;

      for (const line of lines) {
        const sku = line.SKU || line.ProductCode;
        if (!sku) continue;
        totalLineItems++;
        if (bomSkuSet.has(sku)) {
          hasBom = true;
          orderBomCount++;
          bomLineItems++;
        } else {
          orderNormalCount++;
          normalLineItems++;
        }
      }

      if (hasBom) {
        withBom++;
        bomOrderExamples.push({
          order: order.OrderNumber,
          customer: order.Customer,
          bomCount: orderBomCount,
          normalCount: orderNormalCount,
        });
      } else {
        normalOnly++;
      }

      if ((i + 1) % 20 === 0 || i === sampleList.length - 1) {
        console.log(`  ${i + 1}/${sampleList.length} — ${withBom} with BOM, ${normalOnly} normal only`);
      }
    } catch (err) {
      errors++;
    }
  }

  // ═══ FINAL RESULTS ═══
  const sampleTotal = withBom + normalOnly;
  const bomPct = sampleTotal > 0 ? ((withBom / sampleTotal) * 100).toFixed(1) : '0';
  const normalPct = sampleTotal > 0 ? ((normalOnly / sampleTotal) * 100).toFixed(1) : '0';

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  📊 FINAL RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  ─── Product Catalog ───');
  console.log(`  Total products:              ${totalProducts}`);
  console.log(`  BOM products:                ${bomCount}`);
  console.log(`  Production products:         ${prodCount}`);
  console.log(`  BOM/Prod % of catalog:       ${totalProducts ? ((bomProducts.length / totalProducts) * 100).toFixed(1) : '?'}%`);
  console.log('');
  console.log('  ─── Order Volume (Last 30 Days) ───');
  console.log(`  Fulfilled orders:            ${totalFulfilled}`);
  console.log(`  Invoiced orders:             ${totalInvoiced}`);
  console.log(`  FG/Assembly tasks created:   ${totalFgTasks}`);
  console.log(`  Orders linked to FG tasks:   ${fgLinkedOrders.size}`);
  console.log('');
  console.log(`  ─── Sample Analysis (${sampleTotal} orders) ───`);
  console.log(`  Orders WITH BOM/Prod items:  ${withBom}  (${bomPct}%)`);
  console.log(`  Orders NORMAL items only:    ${normalOnly}  (${normalPct}%)`);
  console.log(`  Total line items scanned:    ${totalLineItems}`);
  console.log(`  BOM/Prod line items:         ${bomLineItems}`);
  console.log(`  Normal line items:           ${normalLineItems}`);
  console.log(`  Errors/skipped:              ${errors}`);

  // Extrapolation
  if (sampleTotal > 0 && totalFulfilled > 0) {
    const estBomOrders = Math.round(totalFulfilled * (withBom / sampleTotal));
    const estNormalOrders = totalFulfilled - estBomOrders;
    console.log('');
    console.log('  ─── Estimated Full Month (extrapolated) ───');
    console.log(`  Est. orders WITH BOM/Prod:   ~${estBomOrders}  (${bomPct}%)`);
    console.log(`  Est. orders NORMAL only:     ~${estNormalOrders}  (${normalPct}%)`);
  }

  // BOM order examples
  if (bomOrderExamples.length > 0) {
    console.log('');
    console.log('  ─── BOM Order Examples ───');
    for (const o of bomOrderExamples.slice(0, 15)) {
      console.log(`    ${o.order} | ${o.customer} | ${o.bomCount} BOM + ${o.normalCount} normal items`);
    }
  }

  // FG-linked orders
  if (fgLinkedOrders.size > 0) {
    console.log('');
    console.log('  ─── Orders with FG/Assembly Tasks ───');
    const fgList = [...fgLinkedOrders].slice(0, 20);
    console.log(`    ${fgList.join(', ')}`);
    if (fgLinkedOrders.size > 20) console.log(`    ... and ${fgLinkedOrders.size - 20} more`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ Analysis Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
