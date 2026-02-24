#!/usr/bin/env node
/**
 * One-time cleanup: delete pick_anomaly_orders older than 45 days
 * and their associated logs.
 */
const fetch = require('node-fetch');

const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function main() {
  // 45 days ago
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 45);
  const cutoffDate = cutoff.toISOString().split('T')[0];
  console.log(`Cutoff date: ${cutoffDate} (deleting orders with order_date < ${cutoffDate})`);

  // 1. Find old orders
  const r1 = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_anomaly_orders?select=order_number&order_date=lt.${cutoffDate}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const oldOrders = await r1.json();
  console.log(`Found ${oldOrders.length} orders to delete`);

  if (oldOrders.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  // 2. Delete their logs first
  const nums = oldOrders.map(o => `"${o.order_number}"`).join(',');
  const r2 = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_anomaly_logs?order_number=in.(${encodeURIComponent(nums)})`,
    { method: 'DELETE', headers }
  );
  const logsDeleted = await r2.json().catch(() => []);
  console.log(`Logs deleted: ${Array.isArray(logsDeleted) ? logsDeleted.length : r2.status}`);

  // 3. Delete orders
  const r3 = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_anomaly_orders?order_date=lt.${cutoffDate}`,
    { method: 'DELETE', headers }
  );
  const ordersDeleted = await r3.json().catch(() => []);
  console.log(`Orders deleted: ${Array.isArray(ordersDeleted) ? ordersDeleted.length : r3.status}`);

  // 4. Count remaining
  const r4 = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_anomaly_orders?select=id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' }, method: 'HEAD' }
  );
  console.log(`Remaining orders: ${r4.headers.get('content-range')}`);

  // 5. Update total_orders in sync table
  const range = r4.headers.get('content-range');
  const match = range && range.match(/\/(\d+)/);
  if (match) {
    const total = parseInt(match[1]);
    await fetch(
      `${SUPABASE_URL}/rest/v1/pick_anomaly_sync?id=eq.1`,
      { method: 'PATCH', headers, body: JSON.stringify({ total_orders: total }) }
    );
    console.log(`Updated sync total_orders to ${total}`);
  }

  console.log('Done!');
}

main().catch(console.error);
