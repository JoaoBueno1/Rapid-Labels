const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://iaqnxamnjftwqdbsnfyl.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE');

// Correct RQC data as provided by user
const RQC_CORRECT_DATA = {
  'CNS': 1030,   // Cairns
  'HBA': 1861,   // Hobart
  'MEL': 2894,   // Melbourne
  'SYD': 3939,   // Sydney
  'SCS': 4437,   // Sunshine Coast
  'CFS': 5241,   // Coffs Harbour
  'BNE': 5975    // Brisbane
};

async function fixRQCData() {
  console.log('=== FIXING RQC DATA ===\n');
  
  // Get latest snapshot
  const { data: snaps } = await supabase.from('stock_snapshots').select('*').order('created_at', { ascending: false }).limit(1);
  const snapshot = snaps[0];
  console.log('Snapshot:', snapshot.id.slice(0, 8));
  
  // Get current RQC data
  const { data: currentRQC } = await supabase
    .from('stock_snapshot_lines')
    .select('*')
    .eq('snapshot_id', snapshot.id)
    .eq('product', 'RQC');
  
  console.log('\nCurrent RQC data:');
  for (const row of currentRQC) {
    console.log(`  ${row.warehouse_code}: ${row.qty_available}`);
  }
  
  console.log('\nUpdating to correct values...');
  
  for (const [code, correctQty] of Object.entries(RQC_CORRECT_DATA)) {
    const row = currentRQC.find(r => r.warehouse_code === code);
    if (row) {
      const { error } = await supabase
        .from('stock_snapshot_lines')
        .update({ 
          qty_available: correctQty,
          qty_on_hand: correctQty  // Assuming on_hand = available for simplicity
        })
        .eq('id', row.id);
      
      if (error) {
        console.log(`  ERROR updating ${code}:`, error.message);
      } else {
        console.log(`  ✅ ${code}: ${row.qty_available} → ${correctQty}`);
      }
    } else {
      console.log(`  ⚠️ ${code}: not found in snapshot`);
    }
  }
  
  // Verify
  console.log('\nVerifying...');
  const { data: updatedRQC } = await supabase
    .from('stock_snapshot_lines')
    .select('warehouse_code, qty_available')
    .eq('snapshot_id', snapshot.id)
    .eq('product', 'RQC');
  
  console.log('\nUpdated RQC data:');
  for (const row of updatedRQC.sort((a,b) => a.warehouse_code.localeCompare(b.warehouse_code))) {
    const expected = RQC_CORRECT_DATA[row.warehouse_code];
    const status = expected === row.qty_available ? '✅' : '❌';
    console.log(`  ${status} ${row.warehouse_code}: ${row.qty_available}`);
  }
}

fixRQCData().catch(console.error);
