const https = require('https');
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

const targets = {
  'R1011': 115,
  'R1020': 120,
  'R1021-WH-TRI': 3500,
  'R1022': 115,
  'R1023': 70,
  'R1024': 50,
  'R1030-WH-TRI': 65,
  'R1031-WH-TRI': 1800,
};

const skus = Object.keys(targets);
const filter = skus.map(s => '"' + s + '"').join(',');
const url = `https://iaqnxamnjftwqdbsnfyl.supabase.co/rest/v1/branch_avg_monthly_sales?product=in.(${filter})&select=product,avg_mth_main`;

https.get(url, { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } }, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    const rows = JSON.parse(body);
    const db = {};
    for (const r of rows) db[r.product] = r.avg_mth_main || 0;

    console.log('SKU'.padEnd(20) + 'Teu Wk/Avg  DB avg/mth  Restock Wk  Diff vs Teu');
    console.log('-'.repeat(75));

    for (const sku of skus) {
      const tgt = targets[sku];
      const mth = db[sku] || 0;
      const wk = Math.round(mth / 4.33 * 10) / 10;
      const diff = tgt > 0 ? Math.round((wk / tgt - 1) * 100) : 0;
      console.log(
        sku.padEnd(20) +
        String(tgt).padStart(8) + '  ' +
        String(mth).padStart(9) + '  ' +
        String(wk).padStart(9) + '  ' +
        (diff > 0 ? '+' : '') + diff + '%'
      );
    }
  });
});
