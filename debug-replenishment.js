const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');

const WEEKS_IN_MONTH = 4.345;
const BRANCH_TARGET_WEEKS = 5;
const MAIN_MIN_WEEKS = 8;

async function loadAllStock(snapshotId) {
  let allData = [];
  let from = 0;
  const batchSize = 1000;
  
  while (true) {
    const { data, error } = await supabase
      .from('stock_snapshot_lines')
      .select('product, warehouse_code, qty_available')
      .eq('snapshot_id', snapshotId)
      .range(from, from + batchSize - 1);
    
    if (error) throw error;
    if (!data || data.length === 0) break;
    
    allData = allData.concat(data);
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return allData;
}

async function main() {
  console.log('=== DEBUG REPLENISHMENT ===\n');
  
  const { data: snapshots } = await supabase
    .from('stock_snapshots')
    .select('id')
    .order('created_at', { ascending: false })
    .limit(1);
  
  const snapshotId = snapshots[0].id;
  console.log('Loading stock for snapshot:', snapshotId.substring(0, 8));
  
  const stockData = await loadAllStock(snapshotId);
  console.log('Total stock loaded:', stockData.length);
  
  const { data: avgData } = await supabase
    .from('branch_avg_monthly_sales')
    .select('product, avg_mth_sydney, avg_mth_main')
    .gt('avg_mth_sydney', 0);
  
  console.log('AVG Sydney > 0:', avgData.length);
  
  // Index stock by product:warehouse
  const stockIndex = {};
  for (const row of stockData) {
    stockIndex[row.product + ':' + row.warehouse_code] = row.qty_available;
  }
  
  let canSendCount = 0;
  let needButCantCount = 0;
  let totalUnits = 0;
  const toSend = [];
  const blocked = [];
  
  for (const avg of avgData) {
    const product = avg.product;
    const branchStock = stockIndex[product + ':SYD'] || 0;
    const mainStock = stockIndex[product + ':MAIN'] || 0;
    
    const avgWeekSyd = avg.avg_mth_sydney / WEEKS_IN_MONTH;
    const avgWeekMain = avg.avg_mth_main / WEEKS_IN_MONTH;
    
    const target = Math.ceil(avgWeekSyd * BRANCH_TARGET_WEEKS);
    const need = Math.max(0, target - branchStock);
    const mainMin = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
    const canSend = Math.max(0, mainStock - mainMin);
    const suggested = Math.min(need, canSend);
    
    if (suggested > 0) {
      canSendCount++;
      totalUnits += suggested;
      toSend.push({ product, branchStock, mainStock, target, need, mainMin, canSend, suggested });
    } else if (need > 0) {
      needButCantCount++;
      if (blocked.length < 5) {
        blocked.push({ product, branchStock, mainStock, need, mainMin, canSend, reason: mainStock <= 0 ? 'no main stock' : 'main min > available' });
      }
    }
  }
  
  console.log('\n=== RESULTADOS ===');
  console.log('Produtos a ENVIAR (suggested > 0):', canSendCount);
  console.log('Total unidades:', totalUnits);
  console.log('Produtos BLOQUEADOS (need > 0, cant send):', needButCantCount);
  
  console.log('\n=== PRODUTOS A ENVIAR (primeiros 10) ===');
  console.table(toSend.slice(0, 10));
  
  console.log('\n=== BLOQUEADOS (exemplos) ===');
  console.table(blocked);
}

main().catch(console.error);
