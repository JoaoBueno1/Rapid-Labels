const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const sb = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || ''
);

async function fetchAll(schema, table, select, filters, orderBy) {
  let all = [];
  let from = 0;
  const ps = 1000;
  while (true) {
    let q = sb.schema(schema).from(table).select(select).range(from, from + ps - 1);
    if (orderBy) q = q.order(orderBy);
    if (filters) q = filters(q);
    const { data, error } = await q;
    if (error) { console.error('Error:', error); return all; }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < ps) break;
    from += ps;
  }
  return all;
}

async function main() {
  console.log('Step 1: Fetching ALL products from cin7_mirror...');
  const allProducts = await fetchAll('cin7_mirror', 'products', 'attribute1, sku, stock_locator, status', null, 'attribute1');
  console.log('  Total products:', allProducts.length);

  console.log('Step 2: Fetching stock_snapshot (on_hand > 0)...');
  const stockData = await fetchAll('cin7_mirror', 'stock_snapshot', 'sku, on_hand, bin, location_name', q => q.gt('on_hand', 0), null);
  console.log('  Stock rows with on_hand > 0:', stockData.length);

  // Build stock map: sku -> best MA- bin
  const stockMap = new Map();
  stockData.forEach(d => {
    const key = d.sku.toUpperCase();
    const isMainBin = d.bin && d.bin.startsWith('MA-');
    const existing = stockMap.get(key);
    if (!existing || (isMainBin && (!existing.bin || !existing.bin.startsWith('MA-'))) || (isMainBin && d.on_hand > existing.on_hand)) {
      stockMap.set(key, { on_hand: d.on_hand, bin: d.bin || '', location: d.location_name });
    }
  });
  console.log('  Unique SKUs with stock:', stockMap.size);

  // === BUILD FINAL LIST ===
  const merged = new Map();

  // Group 1: Products with real stock_locator (not 0, not null, not empty) and no Carton
  let group1 = 0;
  allProducts.forEach(p => {
    if (!p.sku || p.sku.toUpperCase().includes('CARTON')) return;
    const loc = (p.stock_locator || '').trim();
    if (loc && loc !== '0') {
      const key = p.sku.toUpperCase();
      if (!merged.has(key)) {
        merged.set(key, {
          fiveDC: (p.attribute1 || '').toString().trim(),
          sku: p.sku,
          locator: loc
        });
        group1++;
      }
    }
  });
  console.log('\nGroup 1 (has stock_locator in cin7):', group1);

  // Group 2: Products with 5DC, NO stock_locator, but HAVE stock with MA- bin
  let group2 = 0;
  allProducts.forEach(p => {
    if (!p.sku || p.sku.toUpperCase().includes('CARTON')) return;
    const loc = (p.stock_locator || '').trim();
    const fiveDC = (p.attribute1 || '').toString().trim();
    if ((!loc || loc === '0') && fiveDC && fiveDC !== '0') {
      const key = p.sku.toUpperCase();
      if (!merged.has(key)) {
        const stock = stockMap.get(key);
        if (stock && stock.on_hand > 0 && stock.bin && stock.bin.startsWith('MA-')) {
          merged.set(key, {
            fiveDC: fiveDC,
            sku: p.sku,
            locator: stock.bin
          });
          group2++;
        }
      }
    }
  });
  console.log('Group 2 (no locator, has 5DC + MA- bin from stock):', group2);

  // Group 3: Products with 5DC, NO stock_locator, have stock but non-MA bin (e.g. GC, SC, Main)
  let group3 = 0;
  allProducts.forEach(p => {
    if (!p.sku || p.sku.toUpperCase().includes('CARTON')) return;
    const loc = (p.stock_locator || '').trim();
    const fiveDC = (p.attribute1 || '').toString().trim();
    if ((!loc || loc === '0') && fiveDC && fiveDC !== '0') {
      const key = p.sku.toUpperCase();
      if (!merged.has(key)) {
        const stock = stockMap.get(key);
        if (stock && stock.on_hand > 0) {
          // Use bin if available, otherwise use location_name
          const binLabel = stock.bin || stock.location || '';
          merged.set(key, {
            fiveDC: fiveDC,
            sku: p.sku,
            locator: binLabel
          });
          group3++;
        }
      }
    }
  });
  console.log('Group 3 (no locator, has 5DC + non-MA stock):', group3);

  // Sort by 5DC numeric, then SKU
  const sorted = [...merged.values()].sort((a, b) => {
    const aNum = parseInt(a.fiveDC) || 999999;
    const bNum = parseInt(b.fiveDC) || 999999;
    if (aNum !== bNum) return aNum - bNum;
    return a.sku.localeCompare(b.sku);
  });

  // Stats
  const with5DC = sorted.filter(r => r.fiveDC && r.fiveDC !== '0' && r.fiveDC !== '').length;
  const without5DC = sorted.length - with5DC;

  console.log('\n=== FINAL EXPORT ===');
  console.log('Total unique products:', sorted.length);
  console.log('With 5DC:', with5DC);
  console.log('Without 5DC:', without5DC);

  // Write TSV
  const lines = ['5DC\tSKU\tStock Locator'];
  sorted.forEach(r => lines.push(r.fiveDC + '\t' + r.sku + '\t' + r.locator));
  fs.writeFileSync('stock_locators_export.tsv', lines.join('\n'), 'utf8');

  console.log('\nFile written: stock_locators_export.tsv');
  console.log('First 5:');
  lines.slice(1, 6).forEach(l => console.log('  ' + l));
  console.log('Last 5:');
  lines.slice(-5).forEach(l => console.log('  ' + l));

  // Show Group 2 samples
  const g2items = sorted.filter(r => {
    const stock = stockMap.get(r.sku.toUpperCase());
    return stock && stock.bin === r.locator;
  });
  console.log('\n=== GROUP 2 SAMPLES (locator from stock_snapshot bin) ===');
  g2items.slice(0, 20).forEach(r => console.log('  5DC:', r.fiveDC, '| SKU:', r.sku, '| Bin:', r.locator));
}

main().catch(e => console.error(e));
