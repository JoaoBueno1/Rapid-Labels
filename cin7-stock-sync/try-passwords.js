const { Client } = require('pg');
const PROJECT_REF = 'iaqnxamnjftwqdbsnfyl';

const passwords = [
  '33221100rapidled',
  '33221100Rapidled',
  '33221100RapidLed',
  '33221100RapidLED',
  '33221100RAPIDLED',
  'Rapidled33221100',
  'rapidled33221100',
  '33221100',
];

const hosts = [
  { host: `db.${PROJECT_REF}.supabase.co`, port: 5432, user: 'postgres', label: 'direct' },
  { host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 6543, user: `postgres.${PROJECT_REF}`, label: 'pooler-tx' },
  { host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 5432, user: `postgres.${PROJECT_REF}`, label: 'pooler-session' },
];

async function tryAll() {
  for (const pw of passwords) {
    for (const h of hosts) {
      const c = new Client({
        host: h.host, port: h.port, database: 'postgres',
        user: h.user, password: pw,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 8000,
      });
      try {
        await c.connect();
        await c.query('SELECT 1');
        console.log(`✅ CONNECTED! password="${pw}" via ${h.label}`);
        await c.end();
        process.exit(0);
      } catch (e) {
        const msg = e.message.substring(0, 60);
        console.log(`❌ pw="${pw}" ${h.label}: ${msg}`);
        try { await c.end(); } catch(x) {}
      }
    }
  }
  console.log('\n❌ Nenhuma combinacao funcionou');
}
tryAll();
