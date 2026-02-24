/**
 * Run pick_anomaly migration V2 — adds fulfilled_date + pick_anomaly_logs table
 * Usage: node features/pick-anomalies/run-migration-v2.js
 */
const { Client } = require('pg');

const CONN = 'postgresql://postgres.iaqnxamnjftwqdbsnfyl:RapidExpress2024!@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres';

const stmts = [
  // fulfilled_date on orders
  `ALTER TABLE public.pick_anomaly_orders ADD COLUMN IF NOT EXISTS fulfilled_date DATE`,
  // Index for fulfilled_date
  `CREATE INDEX IF NOT EXISTS idx_pao_fulfilled_date ON public.pick_anomaly_orders(fulfilled_date DESC)`,
  // Logs table
  `CREATE TABLE IF NOT EXISTS public.pick_anomaly_logs (
    id BIGSERIAL PRIMARY KEY,
    order_number TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    user_email TEXT DEFAULT 'system',
    created_at TIMESTAMPTZ DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pal_order ON public.pick_anomaly_logs(order_number)`,
  `CREATE INDEX IF NOT EXISTS idx_pal_created ON public.pick_anomaly_logs(created_at DESC)`,
  // RLS
  `ALTER TABLE public.pick_anomaly_logs ENABLE ROW LEVEL SECURITY`,
  // Policies (using DO block to skip if exists)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_read_pal' AND tablename = 'pick_anomaly_logs') THEN
      CREATE POLICY anon_read_pal ON public.pick_anomaly_logs FOR SELECT TO anon USING (true);
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_write_pal' AND tablename = 'pick_anomaly_logs') THEN
      CREATE POLICY anon_write_pal ON public.pick_anomaly_logs FOR ALL TO anon USING (true) WITH CHECK (true);
    END IF;
  END $$`,
];

async function main() {
  const client = new Client({ connectionString: CONN, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected to PostgreSQL');

  for (let i = 0; i < stmts.length; i++) {
    const label = stmts[i].replace(/\s+/g, ' ').substring(0, 80);
    try {
      await client.query(stmts[i]);
      console.log(`[${i + 1}/${stmts.length}] OK: ${label}`);
    } catch (err) {
      console.log(`[${i + 1}/${stmts.length}] ERR: ${err.message}`);
    }
  }

  // Verify
  const r1 = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'pick_anomaly_orders' AND column_name = 'fulfilled_date'");
  console.log('\nfulfilled_date column:', r1.rows.length > 0 ? '✅ EXISTS' : '❌ MISSING');

  const r2 = await client.query("SELECT tablename FROM pg_tables WHERE tablename = 'pick_anomaly_logs'");
  console.log('pick_anomaly_logs table:', r2.rows.length > 0 ? '✅ EXISTS' : '❌ MISSING');

  const r3 = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'pick_anomaly_orders' ORDER BY ordinal_position");
  console.log('\npick_anomaly_orders columns:', r3.rows.map(r => r.column_name).join(', '));

  await client.end();
  console.log('\nDone!');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
