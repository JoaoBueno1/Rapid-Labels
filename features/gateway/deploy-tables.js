#!/usr/bin/env node
/**
 * Deploy Gateway tables to Supabase
 * Reads gateway-tables.sql and executes each statement via REST API
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const headers = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

async function tryExecSql(sql) {
  // Try _exec_sql RPC
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/_exec_sql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sql }),
  });
  return r;
}

async function createExecFn() {
  // Create the _exec_sql helper function via individual REST calls
  // First check if it exists
  const check = await tryExecSql('SELECT 1');
  if (check.ok || check.status === 200 || check.status === 204) {
    console.log('✅ _exec_sql function exists');
    return true;
  }

  // Try creating it via the SQL endpoint
  console.log('⚠️  _exec_sql not found. Trying to create individual tables via REST...');
  return false;
}

async function createTablesViaRest() {
  console.log('📋 Creating tables via REST API (individual CREATE TABLE calls)...');
  
  // Create gateway_shelves
  console.log('  Creating gateway_shelves...');
  const r1 = await fetch(`${SUPABASE_URL}/rest/v1/gateway_shelves`, {
    method: 'GET',
    headers: { ...headers, 'Prefer': '' },
  });
  if (r1.ok) {
    console.log('  ✅ gateway_shelves already exists');
  } else {
    console.log(`  ⚠️  gateway_shelves: ${r1.status} — table needs to be created manually`);
  }

  // Create gateway_allocations
  const r2 = await fetch(`${SUPABASE_URL}/rest/v1/gateway_allocations`, {
    method: 'GET',
    headers: { ...headers, 'Prefer': '' },
  });
  if (r2.ok) {
    console.log('  ✅ gateway_allocations already exists');
  } else {
    console.log(`  ⚠️  gateway_allocations: ${r2.status} — table needs to be created manually`);
  }

  // Create gateway_movement_history
  const r3 = await fetch(`${SUPABASE_URL}/rest/v1/gateway_movement_history`, {
    method: 'GET',
    headers: { ...headers, 'Prefer': '' },
  });
  if (r3.ok) {
    console.log('  ✅ gateway_movement_history already exists');
  } else {
    console.log(`  ⚠️  gateway_movement_history: ${r3.status} — table needs to be created manually`);
  }
}

async function main() {
  console.log('🚀 Gateway Tables Deployment\n');
  
  const hasFn = await createExecFn();
  
  if (hasFn) {
    // Execute the full SQL file
    const sql = fs.readFileSync(path.join(__dirname, 'gateway-tables.sql'), 'utf-8');
    const r = await tryExecSql(sql);
    if (r.ok || r.status === 204) {
      console.log('✅ All gateway tables created successfully!');
    } else {
      const txt = await r.text();
      console.log(`❌ Error: ${r.status} ${txt}`);
    }
  } else {
    await createTablesViaRest();
    console.log('\n' + '='.repeat(60));
    console.log('📌 MANUAL STEP REQUIRED:');
    console.log('   Go to Supabase Dashboard → SQL Editor');
    console.log('   Paste and run: features/gateway/gateway-tables.sql');
    console.log('='.repeat(60));
    
    // Print the SQL for easy copy
    const sql = fs.readFileSync(path.join(__dirname, 'gateway-tables.sql'), 'utf-8');
    console.log('\n--- SQL to run ---\n');
    console.log(sql);
  }
}

main().catch(e => console.error('Fatal:', e));
