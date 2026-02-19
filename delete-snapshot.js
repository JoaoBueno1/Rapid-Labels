const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://iaqnxamnjftwqdbsnfyl.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE');

async function deleteLatestSnapshot() {
  const { data: snaps } = await supabase.from('stock_snapshots').select('id').order('created_at', { ascending: false }).limit(1);
  if (!snaps || snaps.length === 0) { 
    console.log('No snapshot found'); 
    return; 
  }
  const id = snaps[0].id;
  console.log('Deleting snapshot:', id);
  await supabase.from('stock_snapshot_lines').delete().eq('snapshot_id', id);
  await supabase.from('stock_snapshots').delete().eq('id', id);
  console.log('Done! Ready for new upload.');
}

deleteLatestSnapshot().catch(console.error);
