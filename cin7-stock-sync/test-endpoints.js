const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const URL = process.env.SUPABASE_URL || '';

async function test() {
  const endpoints = ['/pg/query', '/sql', '/query', '/rest/v1/rpc/exec_sql', '/rest/v1/rpc/_exec_sql'];
  for (const ep of endpoints) {
    try {
      const r = await fetch(URL + ep, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + SERVICE_KEY,
          'Content-Type': 'application/json',
          'apikey': SERVICE_KEY,
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({ query: 'SELECT 1 as test' })
      });
      const txt = await r.text();
      console.log(ep + ': ' + r.status + ' ' + txt.substring(0, 200));
    } catch(e) {
      console.log(ep + ': ERR ' + e.message.substring(0, 80));
    }
  }
}
test();
