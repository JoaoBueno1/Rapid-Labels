const fetch = require('node-fetch');

async function test() {
  const accountId = '3bda282b-60f0-40dc-9199-21959e247cd5';
  const apiKey = '55c70204-619a-5286-ae1d-593493533cb9';
  const headers = {
    'api-auth-accountid': accountId,
    'api-auth-applicationkey': apiKey,
    'Content-Type': 'application/json',
  };

  // Test 1: v2 endpoint
  console.log('--- Test 1: v2/ref/location ---');
  const r1 = await fetch('https://inventory.dearsystems.com/ExternalApi/v2/ref/location?Page=1&Limit=5', { headers });
  console.log('Status:', r1.status, r1.statusText);
  const t1 = await r1.text();
  console.log('Response:', t1.substring(0, 300));

  // Test 2: without v2
  console.log('\n--- Test 2: ExternalApi/ref/location ---');
  const r2 = await fetch('https://inventory.dearsystems.com/ExternalApi/ref/location?Page=1&Limit=5', { headers });
  console.log('Status:', r2.status, r2.statusText);
  const t2 = await r2.text();
  console.log('Response:', t2.substring(0, 300));

  // Test 3: product availability (stock)
  console.log('\n--- Test 3: v2/ref/productavailability ---');
  const r3 = await fetch('https://inventory.dearsystems.com/ExternalApi/v2/ref/productavailability?Page=1&Limit=5', { headers });
  console.log('Status:', r3.status, r3.statusText);
  const t3 = await r3.text();
  console.log('Response:', t3.substring(0, 300));

  // Test 4: product list
  console.log('\n--- Test 4: v2/product ---');
  const r4 = await fetch('https://inventory.dearsystems.com/ExternalApi/v2/product?Page=1&Limit=5', { headers });
  console.log('Status:', r4.status, r4.statusText);
  const t4 = await r4.text();
  console.log('Response:', t4.substring(0, 300));
}

test().catch(console.error);
