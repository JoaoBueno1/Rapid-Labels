#!/usr/bin/env node
/**
 * Deploy SQL schemas to Supabase via the pg library
 * Usage: DATABASE_URL=... node deploy-schema.js
 * Or: node deploy-schema.js  (will try Supabase HTTP SQL endpoint)
 */
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function runSQL(sql, label) {
  console.log(`\n📋 Running: ${label}...`);
  
  // Try via Supabase HTTP SQL endpoint (available on newer instances)
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (resp.ok) {
    console.log(`  ✅ ${label} — done`);
    return true;
  }

  // If that doesn't work, try splitting into statements
  console.log(`  ⚠️  RPC endpoint not available (${resp.status}). Trying alternative...`);
  return false;
}

async function deployViaStatements() {
  // We'll create a temp function to execute SQL, then drop it
  const createExecFn = `
    CREATE OR REPLACE FUNCTION public._exec_sql(sql text)
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN EXECUTE sql; END; $$;
  `;

  // Try creating the helper function
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql: 'SELECT 1' }),
  });

  if (resp.status === 404) {
    console.log('\n⚠️  _exec_sql function not found. Need to create it first.');
    console.log('Please run this SQL in Supabase SQL Editor:\n');
    console.log(`CREATE OR REPLACE FUNCTION public._exec_sql(sql text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN EXECUTE sql; END; $$;

GRANT EXECUTE ON FUNCTION public._exec_sql TO service_role;`);
    console.log('\nThen run this script again.');
    return false;
  }

  return true;
}

async function execViaSql(sql) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_exec_sql`, {
    method: 'POST',
    headers: {
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SQL exec failed (${resp.status}): ${body}`);
  }
  return true;
}

async function main() {
  console.log('🚀 Deploying cin7_mirror schemas to Supabase...\n');

  // Check if _exec_sql function exists
  const hasExecFn = await deployViaStatements();
  if (!hasExecFn) return;

  // Read SQL files
  const sqlDir = path.join(__dirname, 'cin7-stock-sync');
  const files = [
    { file: 'schema.sql', label: 'Base schema (products, stock_snapshot, locations, sync_runs)' },
    { file: 'webhook-events.sql', label: 'Webhook events tables' },
    { file: 'movement-schema.sql', label: 'Movement tracking & alerts tables' },
    { file: 'compatibility-views.sql', label: 'Compatibility views' },
  ];

  for (const { file, label } of files) {
    const filePath = path.join(sqlDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`  ⏭️  ${file} — not found, skipping`);
      continue;
    }

    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await execViaSql(sql);
      console.log(`  ✅ ${label} — deployed`);
    } catch (e) {
      console.error(`  ❌ ${label} — ${e.message}`);
    }
  }

  console.log('\n✅ Schema deployment complete!');
}

main().catch(e => console.error('Fatal:', e));
