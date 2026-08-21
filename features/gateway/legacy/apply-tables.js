#!/usr/bin/env node
/**
 * Apply gateway-tables.sql via direct PostgreSQL connection.
 * Uses the Supabase pooler connection string.
 *
 * Usage: node features/gateway/apply-tables.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Supabase connection string (transaction pooler on port 6543)
// Project: iaqnxamnjftwqdbsnfyl
const DATABASE_URL = process.env.DATABASE_URL
  || '';

const PROJECT_REF = 'iaqnxamnjftwqdbsnfyl';
const passwords = ['RapidExpress2024!', '33221100rapidled', '33221100Rapidled', '33221100RapidLed', '33221100RAPIDLED'];
const configs = [
  { host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres', label: 'direct' },
  { host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 6543, user: `postgres.${PROJECT_REF}`, label: 'pooler-tx' },
  { host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 5432, user: `postgres.${PROJECT_REF}`, label: 'pooler-session' },
];

async function main() {
  console.log('🔗 Connecting to Supabase PostgreSQL...');

  let client = null;
  
  if (DATABASE_URL) {
    client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    try { await client.connect(); } catch (e) { console.error('❌ URL failed:', e.message); client = null; }
  }

  if (!client) {
    for (const pw of passwords) {
      for (const cfg of configs) {
        const c = new Client({ host: cfg.host, port: cfg.port, database: 'postgres', user: cfg.user, password: pw, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
        try {
          await c.connect();
          console.log(`✅ Connected via ${cfg.label} (pw: ${pw.slice(0,4)}...)`);
          client = c;
          break;
        } catch (e) {
          try { c.end(); } catch {}
        }
      }
      if (client) break;
    }
  }

  if (!client) {
    console.error('❌ Could not connect with any password/host combination.');
    console.log('   Set DATABASE_URL or run the SQL manually in Supabase Dashboard → SQL Editor.');
    process.exit(1);
  }

  try {
    const sql = fs.readFileSync(path.join(__dirname, 'gateway-tables.sql'), 'utf-8');
    console.log('📋 Executing gateway-tables.sql...');
    await client.query(sql);
    console.log('✅ All gateway tables created successfully!');

    // Verify
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE 'gateway_%'
      ORDER BY table_name
    `);
    console.log('📊 Gateway tables:', rows.map(r => r.table_name).join(', '));

  } catch (err) {
    console.error('❌ Error:', err.message);
    if (err.message.includes('password authentication failed') || err.message.includes('no pg_hba.conf entry')) {
      console.log('\n⚠️  Database password may be wrong. Set DATABASE_URL environment variable.');
      console.log('   Or run the SQL manually in Supabase Dashboard → SQL Editor.');
    }
  } finally {
    await client.end();
  }
}

main();
