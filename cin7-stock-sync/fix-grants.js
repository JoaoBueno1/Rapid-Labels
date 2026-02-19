const { Client } = require('pg');
const PROJECT_REF = 'iaqnxamnjftwqdbsnfyl';

async function fixGrants() {
  const client = new Client({
    host: `aws-0-ap-southeast-2.pooler.supabase.com`,
    port: 5432,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
    password: 'Rapidled4209',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  console.log('Connected');

  const sql = `
    -- Grant ALL on tables to service_role (for sync writes)
    GRANT ALL ON ALL TABLES IN SCHEMA cin7_mirror TO service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA cin7_mirror TO service_role;
    GRANT USAGE ON SCHEMA cin7_mirror TO service_role;
    
    -- Grant ALL on tables to postgres (owner)
    GRANT ALL ON ALL TABLES IN SCHEMA cin7_mirror TO postgres;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA cin7_mirror TO postgres;
    
    -- Future tables too
    ALTER DEFAULT PRIVILEGES IN SCHEMA cin7_mirror GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA cin7_mirror GRANT ALL ON SEQUENCES TO service_role;
    
    -- Also grant INSERT/UPDATE/DELETE to anon/authenticated for movement_alerts (acknowledge)
    GRANT INSERT, UPDATE, DELETE ON cin7_mirror.movement_alerts TO anon, authenticated;
    
    -- Verify: delete duplicate alert_rules (from multiple SQL Editor runs)
    DELETE FROM cin7_mirror.alert_rules WHERE id NOT IN (
      SELECT MIN(id) FROM cin7_mirror.alert_rules GROUP BY rule_type
    );
  `;

  await client.query(sql);
  console.log('Grants applied');

  // Verify
  const r = await client.query("SELECT COUNT(*) as c FROM cin7_mirror.alert_rules");
  console.log('Alert rules:', r.rows[0].c);

  await client.end();
  console.log('Done');
}

fixGrants().catch(console.error);
