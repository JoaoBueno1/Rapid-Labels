#!/usr/bin/env node
/**
 * Quick script to check cin7_mirror table state
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  console.log('Testing Supabase connection...');
  const { data, error } = await sb.from('Products').select('SKU').limit(1);
  if (error) { console.error('Connection failed:', error.message); process.exit(1); }
  console.log('✅ Supabase connected');

  const tables = ['products', 'stock_snapshot', 'locations', 'sync_runs', 'stock_movements', 'movement_alerts', 'alert_rules', 'webhook_events', 'stock_snapshot_prev'];

  for (const t of tables) {
    const { data: d, error: e } = await sb.schema('cin7_mirror').from(t).select('*', { count: 'exact', head: true });
    if (e) {
      console.log(`  ❌ cin7_mirror.${t}: ${e.message}`);
    } else {
      console.log(`  ✅ cin7_mirror.${t}: exists (would need count via different method)`);
    }
  }
}

run().catch(e => console.error(e));
