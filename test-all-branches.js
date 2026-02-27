const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');

const BRANCHES = {
  SYD: { name: 'Sydney', avgField: 'avg_mth_sydney' },
  MEL: { name: 'Melbourne', avgField: 'avg_mth_melbourne' },
  BNE: { name: 'Brisbane', avgField: 'avg_mth_brisbane' },
  CNS: { name: 'Cairns', avgField: 'avg_mth_cairns' },
  CFS: { name: 'Coffs Harbour', avgField: 'avg_mth_coffs_harbour' },
  HBA: { name: 'Hobart', avgField: 'avg_mth_hobart' },
  SCS: { name: 'Sunshine Coast', avgField: 'avg_mth_sunshine_coast' }
};

const WEEKS_IN_MONTH = 4.345;
const BRANCH_TARGET_WEEKS = 5;
const MAIN_MIN_WEEKS = 8;

async function loadData() {
  const { data: snaps } = await supabase.from('stock_snapshots').select('*').order('created_at', { ascending: false }).limit(1);
  const snapshot = snaps[0];
  
  // Load stock with pagination
  let stockData = [];
  let from = 0;
  while (true) {
    const { data } = await supabase.from('stock_snapshot_lines').select('product, warehouse_code, qty_available').eq('snapshot_id', snapshot.id).range(from, from + 999);
    if (!data || data.length === 0) break;
    stockData = stockData.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  
  const stockIndex = {};
  for (const row of stockData) {
    stockIndex[`${row.product}:${row.warehouse_code}`] = row.qty_available;
  }
  
  // Load AVG with pagination
  let avgData = [];
  from = 0;
  while (true) {
    const { data } = await supabase.from('branch_avg_monthly_sales').select('*').range(from, from + 999);
    if (!data || data.length === 0) break;
    avgData = avgData.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  
  return { stockIndex, avgData, snapshot };
}

async function testAllBranches() {
  console.log('=== TESTE COMPLETO DE TODAS AS BRANCHES ===\n');
  
  const { stockIndex, avgData, snapshot } = await loadData();
  console.log('Snapshot:', snapshot.id.slice(0, 8));
  console.log('Stock entries:', Object.keys(stockIndex).length);
  console.log('AVG products:', avgData.length);
  
  // Check RQC specifically
  console.log('\n=== RQC Stock Check ===');
  const rqcCodes = ['SYD', 'MEL', 'BNE', 'CNS', 'CFS', 'HBA', 'SCS', 'MAIN'];
  for (const code of rqcCodes) {
    const stock = stockIndex[`RQC:${code}`] || 0;
    console.log(`  RQC ${code.padEnd(4)}: ${stock}`);
  }
  
  console.log('\n=== Branch Results ===\n');
  console.log('Branch          | Products | Units  | Critical | Conflicts');
  console.log('----------------|----------|--------|----------|----------');
  
  for (const [code, info] of Object.entries(BRANCHES)) {
    const avgField = info.avgField;
    let toSend = 0;
    let totalUnits = 0;
    let critical = 0;
    let conflicts = 0;
    
    // First pass: calculate all branch needs for conflict detection
    const allNeeds = {};
    for (const avgRow of avgData) {
      const product = avgRow.product;
      if (product.toLowerCase().includes('carton')) continue;
      
      const mainStock = stockIndex[`${product}:MAIN`] || 0;
      const avgMainMonth = avgRow.avg_mth_main || 0;
      const mainMin = Math.ceil((avgMainMonth / WEEKS_IN_MONTH) * MAIN_MIN_WEEKS);
      const canSend = Math.max(0, mainStock - mainMin);
      
      let totalNeed = 0;
      let branchCount = 0;
      
      for (const [bCode, bInfo] of Object.entries(BRANCHES)) {
        const bAvg = avgRow[bInfo.avgField] || 0;
        if (bAvg <= 0) continue;
        
        const bStock = stockIndex[`${product}:${bCode}`] || 0;
        const target = Math.ceil((bAvg / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS);
        const need = Math.max(0, target - bStock);
        
        if (need > 0) {
          totalNeed += need;
          branchCount++;
        }
      }
      
      if (totalNeed > canSend && canSend > 0 && branchCount > 1) {
        allNeeds[product] = true;
      }
    }
    
    // Second pass: calculate this branch
    for (const avgRow of avgData) {
      const product = avgRow.product;
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgMonth = avgRow[avgField] || 0;
      if (avgMonth <= 0) continue;
      
      const branchStock = stockIndex[`${product}:${code}`] || 0;
      const mainStock = stockIndex[`${product}:MAIN`] || 0;
      const avgMainMonth = avgRow.avg_mth_main || 0;
      
      const avgWeek = avgMonth / WEEKS_IN_MONTH;
      const avgWeekMain = avgMainMonth / WEEKS_IN_MONTH;
      
      const coverDays = avgWeek > 0 ? Math.round((branchStock / avgWeek) * 7) : 999;
      const target = Math.ceil(avgWeek * BRANCH_TARGET_WEEKS);
      const need = Math.max(0, target - branchStock);
      const mainMin = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSend = Math.max(0, mainStock - mainMin);
      const suggested = Math.min(need, canSend);
      
      if (suggested > 0) {
        toSend++;
        totalUnits += suggested;
        if (coverDays < 7) critical++;
        if (allNeeds[product]) conflicts++;
      }
    }
    
    const name = info.name.padEnd(15);
    console.log(`${name} | ${String(toSend).padStart(8)} | ${String(totalUnits).padStart(6)} | ${String(critical).padStart(8)} | ${String(conflicts).padStart(9)}`);
  }
  
  // Test RQC for each branch
  console.log('\n=== RQC Test per Branch ===');
  const rqcAvg = avgData.find(a => a.product === 'RQC');
  
  if (rqcAvg) {
    console.log('\nRQC AVG data:');
    console.log('  Main:', rqcAvg.avg_mth_main);
    console.log('  Sydney:', rqcAvg.avg_mth_sydney);
    console.log('  Melbourne:', rqcAvg.avg_mth_melbourne);
    console.log('  Brisbane:', rqcAvg.avg_mth_brisbane);
    console.log('  Cairns:', rqcAvg.avg_mth_cairns);
    console.log('  Coffs Harbour:', rqcAvg.avg_mth_coffs_harbour);
    console.log('  Hobart:', rqcAvg.avg_mth_hobart);
    console.log('  Sunshine Coast:', rqcAvg.avg_mth_sunshine_coast);
    
    console.log('\nRQC Calculation per branch:');
    console.log('Branch          | Stock  | AVG    | Target | Need  | Main Min | Can Send | Suggested');
    console.log('----------------|--------|--------|--------|-------|----------|----------|----------');
    
    const mainStock = stockIndex['RQC:MAIN'] || 0;
    const avgMainWeek = (rqcAvg.avg_mth_main || 0) / WEEKS_IN_MONTH;
    const mainMin = Math.ceil(avgMainWeek * MAIN_MIN_WEEKS);
    const canSendTotal = Math.max(0, mainStock - mainMin);
    
    for (const [code, info] of Object.entries(BRANCHES)) {
      const branchStock = stockIndex[`RQC:${code}`] || 0;
      const avgMonth = rqcAvg[info.avgField] || 0;
      const avgWeek = avgMonth / WEEKS_IN_MONTH;
      const target = Math.ceil(avgWeek * BRANCH_TARGET_WEEKS);
      const need = Math.max(0, target - branchStock);
      const suggested = Math.min(need, canSendTotal);
      
      const name = info.name.padEnd(15);
      console.log(`${name} | ${String(branchStock).padStart(6)} | ${String(Math.round(avgMonth)).padStart(6)} | ${String(target).padStart(6)} | ${String(need).padStart(5)} | ${String(mainMin).padStart(8)} | ${String(canSendTotal).padStart(8)} | ${String(suggested).padStart(9)}`);
    }
    
    console.log(`\nMAIN Stock: ${mainStock}, Main Min: ${mainMin}, Can Send: ${canSendTotal}`);
  } else {
    console.log('RQC not found in AVG data!');
  }
}

testAllBranches().catch(console.error);
