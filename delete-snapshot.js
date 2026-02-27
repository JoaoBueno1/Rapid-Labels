const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_ANON_KEY || '');

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
