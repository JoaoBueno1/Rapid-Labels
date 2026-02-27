const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');

async function main() {
  const { data: snaps } = await supabase.from('stock_snapshots').select('*').order('created_at', { ascending: false }).limit(1);
  const snapshot = snaps[0];
  console.log('Snapshot:', snapshot.id.slice(0, 8), 'created:', snapshot.created_at);
  
  // Count ALL records with pagination
  let total = 0;
  let from = 0;
  const warehouseCounts = {};
  
  while (true) {
    const { data, error } = await supabase
      .from('stock_snapshot_lines')
      .select('warehouse_code')
      .eq('snapshot_id', snapshot.id)
      .range(from, from + 999);
    
    if (error) throw error;
    if (!data || data.length === 0) break;
    
    for (const row of data) {
      warehouseCounts[row.warehouse_code] = (warehouseCounts[row.warehouse_code] || 0) + 1;
    }
    
    total += data.length;
    if (data.length < 1000) break;
    from += 1000;
  }
  
  console.log('Total records:', total);
  console.log('By warehouse:');
  console.table(warehouseCounts);
}

main();
