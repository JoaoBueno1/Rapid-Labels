const fetch = require('node-fetch');
require('dotenv').config();
const XLSX = require('xlsx');
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY;
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY };

(async () => {
  const r = await fetch(
    URL + '/rest/v1/pick_anomaly_orders?select=order_number,order_date,fulfilled_date,customer,total_picks,correct_picks,anomaly_picks,fg_count,picks,order_status&anomaly_picks=gt.0&fulfilled_date=gte.2026-03-20&order=fulfilled_date.asc&limit=500',
    { headers: h }
  );
  const orders = await r.json();

  const rows = [];
  for (const o of orders) {
    const picks = o.picks || [];
    const anomalyPicks = picks.filter(p => p.status === 'anomaly');
    for (const p of anomalyPicks) {
      rows.push({
        'Order': o.order_number,
        'Date': o.order_date || '',
        'Fulfilled': o.fulfilled_date || '',
        'Customer': o.customer || '',
        'SKU': p.sku || '',
        'Qty': p.qty || '',
        'Picked Bin': p.bin || '',
        'Expected Bin': p.expectedBin || '',
        'Error Type': p.errorType || '',
        'Anomalies': o.anomaly_picks,
        'Total Picks': o.total_picks,
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths
  ws['!cols'] = [
    { wch: 12 }, // Order
    { wch: 12 }, // Date
    { wch: 12 }, // Fulfilled
    { wch: 30 }, // Customer
    { wch: 18 }, // SKU
    { wch: 6 },  // Qty
    { wch: 16 }, // Picked Bin
    { wch: 16 }, // Expected Bin
    { wch: 15 }, // Error Type
    { wch: 10 }, // Anomalies
    { wch: 10 }, // Total Picks
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Pick Anomalies');
  const outFile = 'pick-anomalies-report.xlsx';
  XLSX.writeFile(wb, outFile);
  console.log('Saved: ' + outFile + ' (' + rows.length + ' rows)');
})();
