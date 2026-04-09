#!/usr/bin/env node
/**
 * Reset all pick anomaly data — clears history for a fresh start.
 * Tables cleared:
 *   - pick_anomaly_orders (all orders)
 *   - pick_anomaly_corrections (all corrections)
 *   - pick_anomaly_logs (all action logs)
 *   - pick_anomaly_sync (reset to initial state)
 */
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function deleteAll(table) {
  // Supabase REST requires a filter — use id=gt.0 to match all rows
  const url = `${SUPABASE_URL}/rest/v1/${table}?id=gt.0`;
  const res = await fetch(url, { method: 'DELETE', headers });
  const data = await res.json().catch(() => []);
  const count = Array.isArray(data) ? data.length : 0;
  console.log(`  🗑️  ${table}: ${count} rows deleted`);
  return count;
}

async function resetSync() {
  const today = new Date().toISOString().split('T')[0];
  const url = `${SUPABASE_URL}/rest/v1/pick_anomaly_sync?id=eq.1`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      last_synced_date: today,
      last_synced_at: new Date().toISOString(),
      total_orders: 0,
      last_new_orders: 0,
    }),
  });
  if (res.ok) {
    console.log(`  🔄 pick_anomaly_sync: reset (last_synced_date = ${today})`);
  } else {
    console.error(`  ❌ Failed to reset pick_anomaly_sync: ${res.status}`);
  }
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  🧹 RESET PICK ANOMALIES DATA');
  console.log('═══════════════════════════════════════════');
  console.log('');

  // 1. Delete logs first (references order_number)
  await deleteAll('pick_anomaly_logs');

  // 2. Delete corrections
  await deleteAll('pick_anomaly_corrections');

  // 3. Delete all orders
  await deleteAll('pick_anomaly_orders');

  // 4. Reset sync metadata
  await resetSync();

  console.log('');
  console.log('✅ All pick anomaly data has been cleared!');
  console.log('   The system will start fresh on the next sync.');
  console.log('');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
