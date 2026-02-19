const fetch = require('node-fetch');
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MTk1NzkzNCwiZXhwIjoyMDY3NTMzOTM0fQ.l6qjolSKgFG9H6zZvwJejzG9zsQFBQ9RtHN6S16TCR4';
const URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';

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
