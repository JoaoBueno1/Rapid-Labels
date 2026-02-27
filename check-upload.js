const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');

async function checkRQC() {
  const { data: snaps } = await supabase.from('stock_snapshots').select('*').order('created_at', { ascending: false }).limit(1);
  
  if (!snaps || snaps.length === 0) {
    console.log('No snapshot found!');
    return;
  }
  
  const snapshot = snaps[0];
  console.log('Snapshot:', snapshot.id.slice(0, 8), 'created:', snapshot.created_at);
  
  // Get RQC data
  const { data: rqc } = await supabase
    .from('stock_snapshot_lines')
    .select('warehouse_code, qty_available')
    .eq('snapshot_id', snapshot.id)
    .eq('product', 'RQC');
  
  console.log('\n=== RQC COMPARISON ===');
  console.log('Warehouse | Parsed | Expected | Status');
  console.log('----------|--------|----------|-------');
  
  const expected = {
    CNS: 1030,
    HBA: 1861,
    MEL: 2894,
    SYD: 3939,
    SCS: 4437,
    CFS: 5241,
    BNE: 5975
  };
  
  for (const row of rqc.sort((a,b) => a.warehouse_code.localeCompare(b.warehouse_code))) {
    const exp = expected[row.warehouse_code];
    const status = exp === undefined ? '-' : (exp === row.qty_available ? '✅' : '❌');
    console.log(`${row.warehouse_code.padEnd(9)} | ${String(row.qty_available).padStart(6)} | ${String(exp || 'N/A').padStart(8)} | ${status}`);
  }
  
  // Count total records per warehouse
  let allData = [];
  let from = 0;
  while (true) {
    const { data } = await supabase
      .from('stock_snapshot_lines')
      .select('warehouse_code')
      .eq('snapshot_id', snapshot.id)
      .range(from, from + 999);
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  
  const counts = {};
  for (const row of allData) {
    counts[row.warehouse_code] = (counts[row.warehouse_code] || 0) + 1;
  }
  
  console.log('\n=== RECORDS PER WAREHOUSE ===');
  console.table(counts);
  console.log('Total records:', allData.length);
}

checkRQC().catch(console.error);
