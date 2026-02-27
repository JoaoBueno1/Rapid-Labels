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

async function loadAllData() {
  // Load snapshot
  const { data: snapshots, error: snapError } = await supabase
    .from('stock_snapshots')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);
  
  if (snapError) {
    console.error('Error loading snapshot:', snapError);
    throw snapError;
  }
  
  if (!snapshots || snapshots.length === 0) {
    console.error('No snapshots found!');
    throw new Error('No snapshots');
  }
  
  const snapshot = snapshots[0];
  console.log('Snapshot:', snapshot.id.slice(0,8));
  
  // Load all stock with pagination
  let stockData = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('stock_snapshot_lines')
      .select('product, warehouse_code, qty_available')
      .eq('snapshot_id', snapshot.id)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    stockData = stockData.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('Stock loaded:', stockData.length);
  
  // Index stock
  const stockIndex = {};
  for (const row of stockData) {
    const key = `${row.product}:${row.warehouse_code}`;
    stockIndex[key] = row;
  }
  
  // Load all AVG with pagination
  let avgData = [];
  from = 0;
  while (true) {
    const { data } = await supabase
      .from('branch_avg_monthly_sales')
      .select('*')
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    avgData = avgData.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log('AVG loaded:', avgData.length);
  
  // Index AVG
  const avgIndex = {};
  for (const row of avgData) {
    avgIndex[row.product] = row;
  }
  
  return { stockIndex, avgIndex };
}

function testBranch(branchCode, branchInfo, stockIndex, avgIndex) {
  const avgField = branchInfo.avgField;
  let toSend = 0;
  let totalUnits = 0;
  let blocked = 0;
  let zeroAvg = 0;
  
  for (const product of Object.keys(avgIndex)) {
    const avgRow = avgIndex[product];
    const avgMonthBranch = avgRow[avgField] || 0;
    
    if (avgMonthBranch <= 0) {
      zeroAvg++;
      continue;
    }
    
    const branchKey = `${product}:${branchCode}`;
    const mainKey = `${product}:MAIN`;
    const branchStock = stockIndex[branchKey];
    const mainStock = stockIndex[mainKey];
    
    const branchAvailable = branchStock?.qty_available || 0;
    const mainAvailable = mainStock?.qty_available || 0;
    const avgMonthMain = avgRow.avg_mth_main || 0;
    
    const avgWeekBranch = avgMonthBranch / WEEKS_IN_MONTH;
    const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
    
    const targetQty = Math.ceil(avgWeekBranch * BRANCH_TARGET_WEEKS);
    const needQty = Math.max(0, targetQty - branchAvailable);
    const mainMinQty = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
    const canSendQty = Math.max(0, mainAvailable - mainMinQty);
    const suggestedQty = Math.min(needQty, canSendQty);
    
    if (suggestedQty > 0) {
      toSend++;
      totalUnits += suggestedQty;
    } else if (needQty > 0) {
      blocked++;
    }
  }
  
  return { toSend, totalUnits, blocked, zeroAvg };
}

async function main() {
  console.log('=== DEBUG ALL BRANCHES ===\n');
  
  const { stockIndex, avgIndex } = await loadAllData();
  
  console.log('\n=== RESULTADOS POR BRANCH ===\n');
  console.log('Branch          | Products | Units  | Blocked | Zero AVG');
  console.log('----------------|----------|--------|---------|----------');
  
  for (const [code, info] of Object.entries(BRANCHES)) {
    const result = testBranch(code, info, stockIndex, avgIndex);
    const name = info.name.padEnd(15);
    const products = String(result.toSend).padStart(8);
    const units = String(result.totalUnits).padStart(6);
    const blocked = String(result.blocked).padStart(7);
    const zeroAvg = String(result.zeroAvg).padStart(8);
    console.log(`${name} |${products} |${units} |${blocked} |${zeroAvg}`);
  }
  
  console.log('\n✅ Done!');
}

main().catch(console.error);
