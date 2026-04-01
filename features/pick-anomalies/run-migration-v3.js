/**
 * Run pick_anomaly V3 migration (cancellation detection columns)
 * Uses Supabase REST column detection + creation via RPC workaround
 */
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const HEADERS = {
  'apikey': SB_KEY,
  'Authorization': `Bearer ${SB_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function checkColumn(table, column) {
  // Try to select the column - if it fails, column doesn't exist
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=${column}&limit=1`, { headers: HEADERS });
  return r.ok;
}

async function tryAddColumn(table, column, defaultValue) {
  // Try to PATCH a non-existent row with the column - if column doesn't exist it will fail
  // Then try to POST a dummy that includes the column to trigger creation
  // Actually, the simplest approach: try to read it, if fails, we know it's missing
  const exists = await checkColumn(table, column);
  if (exists) {
    console.log(`  ✅ ${table}.${column} — already exists`);
    return true;
  }
  console.log(`  ❌ ${table}.${column} — MISSING (needs manual creation)`);
  return false;
}

async function main() {
  console.log('=== Pick Anomalies V3 Migration Check ===\n');

  const checks = [
    ['pick_anomaly_orders', 'is_cancelled'],
    ['pick_anomaly_orders', 'cancelled_at'],
    ['pick_anomaly_orders', 'has_correction_conflict'],
    ['pick_anomaly_corrections', 'is_reversed'],
    ['pick_anomaly_corrections', 'reversed_at'],
    ['pick_anomaly_corrections', 'reversal_transfer_id'],
    ['pick_anomaly_corrections', 'reversal_transfer_ref'],
  ];

  let allExist = true;
  for (const [table, col] of checks) {
    const ok = await tryAddColumn(table, col);
    if (!ok) allExist = false;
  }

  if (allExist) {
    console.log('\n✅ All V3 columns exist! Migration already applied.');
  } else {
    console.log('\n⚠️  Some columns are missing. Please run this SQL in Supabase SQL Editor:\n');
    console.log(`--- Copy/paste into https://supabase.com/dashboard → SQL Editor ---\n`);
    console.log(`ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN DEFAULT FALSE;`);
    console.log(`ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;`);
    console.log(`ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS has_correction_conflict BOOLEAN DEFAULT FALSE;`);
    console.log(`ALTER TABLE public.pick_anomaly_corrections ADD COLUMN IF NOT EXISTS is_reversed BOOLEAN DEFAULT FALSE;`);
    console.log(`ALTER TABLE public.pick_anomaly_corrections ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;`);
    console.log(`ALTER TABLE public.pick_anomaly_corrections ADD COLUMN IF NOT EXISTS reversal_transfer_id TEXT;`);
    console.log(`ALTER TABLE public.pick_anomaly_corrections ADD COLUMN IF NOT EXISTS reversal_transfer_ref TEXT;`);
    console.log(`CREATE INDEX IF NOT EXISTS idx_pao_cancelled ON public.pick_anomaly_orders(is_cancelled) WHERE is_cancelled = true;`);
    console.log(`CREATE INDEX IF NOT EXISTS idx_pao_conflict ON public.pick_anomaly_orders(has_correction_conflict) WHERE has_correction_conflict = true;`);
  }
}

main().catch(e => console.error(e));
