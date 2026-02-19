const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://iaqnxamnjftwqdbsnfyl.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE');

const BRANCHES = {
  SYD: 'avg_mth_sydney',
  MEL: 'avg_mth_melbourne',
  BNE: 'avg_mth_brisbane',
  CNS: 'avg_mth_cairns',
  CFS: 'avg_mth_coffs_harbour',
  HBA: 'avg_mth_hobart',
  SCS: 'avg_mth_sunshine_coast'
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
  
  return { stockIndex, avgData };
}

async function analyzeAllocationConflicts() {
  console.log('=== ANÁLISE DE CONFLITOS DE ALOCAÇÃO ===\n');
  
  const { stockIndex, avgData } = await loadData();
  
  let totalProducts = 0;
  let productsWithNeed = 0;
  let productsWithConflict = 0;
  let conflictDetails = [];
  
  for (const avgRow of avgData) {
    const product = avgRow.product;
    
    // Skip carton products
    if (product.toLowerCase().includes('carton')) continue;
    
    totalProducts++;
    
    const mainStock = stockIndex[`${product}:MAIN`] || 0;
    const avgMainMonth = avgRow.avg_mth_main || 0;
    const mainMin = Math.ceil((avgMainMonth / WEEKS_IN_MONTH) * MAIN_MIN_WEEKS);
    const available = Math.max(0, mainStock - mainMin);
    
    // Calculate need for each branch
    let totalNeed = 0;
    const branchNeeds = {};
    
    for (const [code, avgField] of Object.entries(BRANCHES)) {
      const avgMonth = avgRow[avgField] || 0;
      if (avgMonth <= 0) continue;
      
      const branchStock = stockIndex[`${product}:${code}`] || 0;
      const target = Math.ceil((avgMonth / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS);
      const need = Math.max(0, target - branchStock);
      
      if (need > 0) {
        branchNeeds[code] = need;
        totalNeed += need;
      }
    }
    
    if (totalNeed > 0) {
      productsWithNeed++;
      
      // Check for conflict: total need > available
      if (totalNeed > available && available > 0) {
        productsWithConflict++;
        const shortage = totalNeed - available;
        const branchCount = Object.keys(branchNeeds).length;
        
        conflictDetails.push({
          product,
          mainStock,
          mainMin,
          available,
          totalNeed,
          shortage,
          branchCount,
          branches: Object.keys(branchNeeds).join(', ')
        });
      }
    }
  }
  
  console.log(`Total produtos (sem Carton): ${totalProducts}`);
  console.log(`Produtos com necessidade: ${productsWithNeed}`);
  console.log(`Produtos com CONFLITO: ${productsWithConflict} (${(productsWithConflict/productsWithNeed*100).toFixed(1)}%)`);
  
  console.log('\n=== TOP 20 CONFLITOS (maior shortage) ===\n');
  conflictDetails.sort((a, b) => b.shortage - a.shortage);
  console.table(conflictDetails.slice(0, 20).map(c => ({
    Product: c.product,
    'MAIN Stock': c.mainStock,
    'Available': c.available,
    'Total Need': c.totalNeed,
    'Shortage': c.shortage,
    'Branches': c.branchCount,
    'Who Needs': c.branches
  })));
  
  // Calculate total units in conflict
  const totalShortage = conflictDetails.reduce((sum, c) => sum + c.shortage, 0);
  const totalConflictNeed = conflictDetails.reduce((sum, c) => sum + c.totalNeed, 0);
  
  console.log('\n=== RESUMO ===');
  console.log(`Unidades em conflito (shortage total): ${totalShortage}`);
  console.log(`Unidades necessárias em conflito: ${totalConflictNeed}`);
  console.log(`% que pode ser atendido: ${((totalConflictNeed - totalShortage) / totalConflictNeed * 100).toFixed(1)}%`);
  
  // Simulate what happens with current vs fair share
  console.log('\n=== SIMULAÇÃO: ATUAL vs FAIR SHARE ===\n');
  
  // Current: first-come-first-served (SYD gets priority as example)
  const currentAllocation = { SYD: 0, MEL: 0, BNE: 0, CNS: 0, CFS: 0, HBA: 0, SCS: 0 };
  const fairShareAllocation = { SYD: 0, MEL: 0, BNE: 0, CNS: 0, CFS: 0, HBA: 0, SCS: 0 };
  
  for (const conflict of conflictDetails) {
    const product = conflict.product;
    const avgRow = avgData.find(a => a.product === product);
    let remainingStock = conflict.available;
    
    // Current: process in order (SYD, MEL, BNE...)
    for (const code of ['SYD', 'MEL', 'BNE', 'CNS', 'CFS', 'HBA', 'SCS']) {
      const avgField = BRANCHES[code];
      const avgMonth = avgRow[avgField] || 0;
      if (avgMonth <= 0) continue;
      
      const branchStock = stockIndex[`${product}:${code}`] || 0;
      const target = Math.ceil((avgMonth / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS);
      const need = Math.max(0, target - branchStock);
      
      const send = Math.min(need, remainingStock);
      currentAllocation[code] += send;
      remainingStock -= send;
    }
    
    // Fair Share: proportional
    let totalNeed = 0;
    const needs = {};
    for (const code of Object.keys(BRANCHES)) {
      const avgField = BRANCHES[code];
      const avgMonth = avgRow[avgField] || 0;
      if (avgMonth <= 0) continue;
      
      const branchStock = stockIndex[`${product}:${code}`] || 0;
      const target = Math.ceil((avgMonth / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS);
      const need = Math.max(0, target - branchStock);
      if (need > 0) {
        needs[code] = need;
        totalNeed += need;
      }
    }
    
    for (const [code, need] of Object.entries(needs)) {
      const share = (need / totalNeed) * conflict.available;
      fairShareAllocation[code] += Math.round(share);
    }
  }
  
  console.log('Unidades alocadas em produtos com conflito:');
  console.log('\nBranch     | Atual  | Fair Share | Diferença');
  console.log('-----------|--------|------------|----------');
  for (const code of ['SYD', 'MEL', 'BNE', 'CNS', 'CFS', 'HBA', 'SCS']) {
    const current = currentAllocation[code];
    const fair = fairShareAllocation[code];
    const diff = fair - current;
    const sign = diff >= 0 ? '+' : '';
    console.log(`${code.padEnd(10)} | ${String(current).padStart(6)} | ${String(fair).padStart(10)} | ${sign}${diff}`);
  }
}

analyzeAllocationConflicts().catch(console.error);
