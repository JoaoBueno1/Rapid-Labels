/**
 * One-time (idempotent) populate: push data/scanner_activity.json into the
 * durable public.scanner_activity table via the service_role key.
 *
 *   node cin7-stock-sync/populate-scanner-activity.js
 *
 * Safe to re-run — upserts by order_number. Run the migration first
 * (cin7-stock-sync/migrations/scanner_activity.sql) in the SQL Editor.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env'); process.exit(1); }
const sb = createClient(url, key);

(async () => {
  const p = path.join(__dirname, '..', 'data', 'scanner_activity.json');
  if (!fs.existsSync(p)) { console.error('No data/scanner_activity.json to import'); process.exit(1); }
  const { scanned } = JSON.parse(fs.readFileSync(p, 'utf8'));
  const now = new Date().toISOString();
  const rows = Object.entries(scanned).filter(([so]) => so).map(([so, v]) => ({
    order_number: so, op: v.op || null, scan_date: v.date || null,
    skus: Number(v.skus) || 0, minutes: Number(v.min) || 0, updated_at: now,
  }));
  console.log(`upserting ${rows.length} rows...`);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('scanner_activity').upsert(rows.slice(i, i + 500), { onConflict: 'order_number' });
    if (error) { console.error('\nERROR:', error.message); process.exit(1); }
    process.stdout.write(`\r${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  const { count } = await sb.from('scanner_activity').select('*', { count: 'exact', head: true });
  console.log(`\n✓ done — table now has ${count} rows`);
})();
