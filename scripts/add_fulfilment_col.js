#!/usr/bin/env node
const { Client } = require('pg');

const connStr = 'postgresql://postgres.iaqnxamnjftwqdbsnfyl:33221100rapidled@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

(async () => {
  const c = new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log('Connected');

  await c.query('ALTER TABLE cin7_mirror.order_pipeline ADD COLUMN IF NOT EXISTS fulfilment_number INT DEFAULT 1');
  console.log('Column fulfilment_number added');

  const r = await c.query(
    "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_schema='cin7_mirror' AND table_name='order_pipeline' AND column_name='fulfilment_number'"
  );
  console.log('Verified:', r.rows);

  await c.end();
})();
