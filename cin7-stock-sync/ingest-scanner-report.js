/**
 * Ingest Cin7 "InventoryWarehouseDetails" scanner reports (CSV) → a local JSON
 * map of { SO -> { op, date, min } } used to tag pick anomalies as
 * scanner-vs-manual and attribute the operator.
 *
 * Kept OUT of git (see .gitignore) — contains employee names. In production the
 * same shape belongs in a cin7_mirror table with anon-read (see migration in
 * cin7-stock-sync/migrations/warehouse_pick_activity.sql).
 *
 * Usage:  node cin7-stock-sync/ingest-scanner-report.js <dir-with-report-csvs>
 * Each CSV must be a Cin7 InventoryWarehouseDetails export (rows:
 *   User,Location,Task,Date,Sale order #,Orders picked,SKUs picked,Time tracked)
 * The report's own "From:/To:" date drives which rows are ingested.
 */
const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, '..', 'data', 'scanner_activity.json');
const shortUser = u => u.replace('@rapidled.com.au', '').replace('project.scanner', 'scanner');

// dd-Mon-yyyy -> yyyy-mm-dd
const MON = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
function iso(d) { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(d); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null; }

function ingestFile(file, scanned, days) {
  const csv = fs.readFileSync(file, 'utf8');
  const lines = csv.split(/\r?\n/);
  const fromLabel = (lines.find(l => l.startsWith('From:')) || '').match(/From:\s*(\d{2}-[A-Za-z]{3}-\d{4})/);
  const reportDate = fromLabel ? iso(fromLabel[1]) : '';   // fallback if a row has no date
  let n = 0, fdays = new Set();
  for (const ln of lines) {
    if (!/Main Warehouse,Picking,/.test(ln)) continue;     // multi-day: match any Picking row
    const u = ln.match(/^([^,]+@rapidled\.com\.au)/);
    const so = ln.match(/,(SO-\d+),/);
    const dl = ln.match(/,(\d{2}-[A-Za-z]{3}-\d{4}),/);     // this row's own Date column
    const tm = ln.match(/([\d.]+)m\s*$/);
    const sk = ln.match(/,SO-\d+,[^,]*,("?[\d.,]+"?),[\d.]+m\s*$/); // SKUs picked column
    if (!u || !so) continue;
    const date = dl ? iso(dl[1]) : reportDate;
    if (date) { days.add(date); fdays.add(date); }
    const op = shortUser(u[1]);
    const skus = sk ? parseFloat(sk[1].replace(/[",]/g, '')) : 0;
    const min = tm ? parseFloat(tm[1]) : 0;
    // Same SO can appear on several rows (re-picks / split sessions / same op logged twice).
    // Aggregate instead of last-wins so SKUs + time are not lost.
    const cur = scanned[so[1]];
    if (cur) { cur.skus += skus; cur.min += min; if (!cur.date && date) cur.date = date; }
    else scanned[so[1]] = { op, date, skus, min };
    n++;
  }
  console.log(`  ${path.basename(file)}  → ${n} picks across ${fdays.size} day(s)`);
}

function main() {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error('Usage: node ingest-scanner-report.js <dir-with-report-csvs>'); process.exit(1); }
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  const scanned = {}, days = new Set();
  for (const f of files) ingestFile(path.join(dir, f), scanned, days);
  // Canonicalise operator casing: antonc / AntonC must be ONE operator, not two.
  // Prefer the casing that carries an uppercase letter (nicer display).
  const canon = {};
  const score = o => (/^[A-Z]/.test(o) ? 2 : 0) + (/[A-Z]/.test(o) ? 1 : 0); // prefer Proper-case
  for (const so in scanned) {
    const op = scanned[so].op, lo = op.toLowerCase();
    if (!canon[lo] || score(op) > score(canon[lo])) canon[lo] = op;
  }
  for (const so in scanned) scanned[so].op = canon[scanned[so].op.toLowerCase()];
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  const payload = { generated_at: new Date().toISOString().slice(0, 10), source: 'InventoryWarehouseDetails',
    days: [...days].sort(), count: Object.keys(scanned).length, scanned };
  fs.writeFileSync(DEST, JSON.stringify(payload));
  console.log(`\n✓ ${payload.count} scanned orders across ${payload.days.length} days → ${DEST}`);
}
main();
