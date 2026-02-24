/**
 * Run pick_anomaly migration V2 via Supabase REST API
 * Creates a temporary RPC function, runs migration, then drops it
 */
const fetch = require('node-fetch');

const SB_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MTk1NzkzNCwiZXhwIjoyMDY3NTMzOTM0fQ.GPwNGNkEylgLB_GNnEy3bfGkf08DftzTfFQCbbOpFF4';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

async function main() {
  // Step 1: Check current state
  console.log('=== Checking current state ===');
  
  const chk1 = await fetch(`${SB_URL}/rest/v1/pick_anomaly_orders?select=fulfilled_date&limit=1`, {
    headers: { 'apikey': ANON, 'Authorization': `Bearer ${ANON}` }
  });
  console.log('fulfilled_date column:', chk1.ok ? '✅ already exists' : '❌ missing');

  const chk2 = await fetch(`${SB_URL}/rest/v1/pick_anomaly_logs?select=id&limit=1`, {
    headers: { 'apikey': ANON, 'Authorization': `Bearer ${ANON}` }
  });
  console.log('pick_anomaly_logs table:', chk2.ok ? '✅ already exists' : '❌ missing');

  if (chk1.ok && chk2.ok) {
    console.log('\n✅ Migration already applied! Nothing to do.');
    return;
  }

  // Step 2: Try to create the exec_sql function via service role
  console.log('\n=== Creating exec_sql helper function ===');
  
  // Create the function via PostgREST RPC
  const createFnSql = `
    CREATE OR REPLACE FUNCTION public.exec_sql(sql text)
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      EXECUTE sql;
    END;
    $$;
  `;

  // We need to create this function. Let's try via the Supabase dashboard API
  // Actually, let's use a workaround: insert SQL via a table trigger or use the service role
  
  // Alternative approach: use Supabase's service_role to create tables via REST
  // The service_role can create tables by POSTing to them
  
  if (!chk2.ok) {
    console.log('\n=== Creating pick_anomaly_logs table via REST ===');
    // Try upsert with the service role — this won't work for DDL
    // Instead, let's just try to use the table and let the engine handle missing table gracefully
    console.log('⚠️  Cannot create table via REST API.');
    console.log('');
    console.log('Please run this SQL in Supabase SQL Editor (Dashboard > SQL Editor):');
    console.log('');
    console.log('--- COPY FROM HERE ---');
    console.log(`
ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS fulfilled_date DATE;
CREATE INDEX IF NOT EXISTS idx_pao_fulfilled_date ON public.pick_anomaly_orders(fulfilled_date DESC);

CREATE TABLE IF NOT EXISTS public.pick_anomaly_logs (
  id BIGSERIAL PRIMARY KEY,
  order_number TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  user_email TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pal_order ON public.pick_anomaly_logs(order_number);
CREATE INDEX IF NOT EXISTS idx_pal_created ON public.pick_anomaly_logs(created_at DESC);
ALTER TABLE public.pick_anomaly_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_read_pal ON public.pick_anomaly_logs FOR SELECT TO anon USING (true);
CREATE POLICY anon_write_pal ON public.pick_anomaly_logs FOR ALL TO anon USING (true) WITH CHECK (true);
    `.trim());
    console.log('--- END ---');
  }
  
  if (!chk1.ok) {
    console.log('\nfulfilled_date also needs to be added (included in the SQL above)');
  }
}

main().catch(err => console.error('ERROR:', err.message));
