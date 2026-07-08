/*
 * Pick Productivity — operator picking analytics from the Cin7
 * InventoryWarehouseDetails report (via /api/scanner-activity) cross-referenced
 * with pick anomalies (Supabase). Scanner-picked SALES orders only.
 *
 * An "error" = a SKU picked from a stock shelf that is not the product's
 * pickface. Staging picks (DOCK/RETURNS/PRODUCTION/SAMPLES/GA), transfers,
 * manual (non-scanner) picks and FG are all excluded from the analysis.
 * Classic script (globals for inline handlers).
 */
'use strict';

const PP = { data: { scanned: {}, days: [] }, anomalies: [], errRows: [], stagingRows: [], from: null, to: null, op: 'all', errPage: 1, chartDay: null, chartTrend: null, chartOp: null, import: null };
const PER_PAGE = 20;
const CHART_INK = '#334155', CHART_RED = '#b91c1c';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const nf = n => Math.round(n || 0).toLocaleString();
const fmtTime = m => { m = Math.round(m || 0); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const isStaging = bin => { const b = String(bin || '').toUpperCase(); return /RETURNS|DOCK|PRODUCTION|SAMPLES|OFFICE/.test(b) || b === 'MA-GA' || b === 'GA'; };

// Shelf locations manually reviewed as NOT real errors (valid alternate pick spots).
// Matched against the picked-from bin. Append new confirmed ones here.
const NON_ERROR_BINS = new Set([
  'MA-A-05-L3', 'MA-F-15-L1', 'MA-A-09-L2', 'MA-B-12-L2', 'MA-B-02-L1', 'MA-A-04-L1', 'MA-A-08-L4',
  'MA-C-15-L3', 'MA-A-10-L3', 'MA-H-04-L2', 'MA-G-01-L2', 'MA-A-06-L2', 'MA-A-05-L4',
]);
const isNonError = bin => NON_ERROR_BINS.has(String(bin || '').toUpperCase().trim());

// ─── Load ───
async function ppLoad() {
  try { const r = await fetch('/api/scanner-activity'); PP.data = await r.json(); }
  catch (e) { PP.data = { scanned: {}, days: [] }; }
  await ppFetchAnomalies();
  ppBuildErrRows();
  ppSetRange(7);          // focus on the last 7 days by default
  ppFillOperators();
  PP.errPage = 1;
  ppRender();
}
function ppSetRange(n) {
  const days = ppAllDays(); if (!days.length) return;
  const to = days[days.length - 1];
  let from = days[0];
  if (n > 0) { const d = new Date(to + 'T00:00:00'); d.setDate(d.getDate() - (n - 1)); from = d.toISOString().slice(0, 10); if (from < days[0]) from = days[0]; }
  $('ppFrom').value = from; $('ppTo').value = to; PP.from = from; PP.to = to;
}
function ppQuickRange(n) { ppSetRange(n); PP.errPage = 1; ppRender(); }
function ppAllDays() {
  const s = new Set();
  Object.values(PP.data.scanned || {}).forEach(v => { if (v && v.date) s.add(v.date); });
  return [...s].sort();
}
function ppAllOps() {
  const s = new Set();
  Object.values(PP.data.scanned || {}).forEach(v => { if (v && v.op) s.add(v.op); });
  return [...s].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
function ppFillOperators() {
  const sel = $('ppOp'); if (!sel) return;
  const cur = sel.value || 'all';
  sel.innerHTML = '<option value="all">All operators</option>' + ppAllOps().map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  PP.op = sel.value;
}
async function ppFetchAnomalies() {
  PP.anomalies = [];
  try {
    if (window.supabaseReady) await window.supabaseReady;
    const sb = window.supabase; if (!sb || typeof sb.from !== 'function') return;
    const days = ppAllDays(); if (!days.length) return;
    const lo = days[0];
    const hd = new Date(days[days.length - 1] + 'T00:00:00'); hd.setDate(hd.getDate() + 3);
    const hi = hd.toISOString().slice(0, 10);
    let rows = [], from = 0;
    for (;;) {
      const r = await sb.from('pick_anomaly_orders').select('order_number,entity_type,picks,fulfilled_date')
        .eq('entity_type', 'sale').gt('anomaly_picks', 0).gte('fulfilled_date', lo).lte('fulfilled_date', hi).range(from, from + 999);
      if (r.error) break;
      rows.push(...(r.data || []));
      if (!r.data || r.data.length < 1000) break;
      from += 1000;
    }
    PP.anomalies = rows;
  } catch (e) { PP.anomalies = []; }
}
// SALES anomalies. A real error = picked from a stock shelf (not staging).
//  - errRows   : order is in the scanner report → attributed to an operator
//  - manualRows: order NOT in the report → picked manually, no operator
function ppBuildErrRows() {
  const scan = PP.data.scanned || {};
  PP.errRows = []; PP.manualRows = []; PP.stagingRows = [];
  (PP.anomalies || []).forEach(a => {
    const sc = scan[a.order_number];
    const date = sc ? sc.date : (a.fulfilled_date ? String(a.fulfilled_date).slice(0, 10) : '');
    (a.picks || []).forEach(p => {
      if (p.status !== 'anomaly') return;
      const row = { order: a.order_number, op: sc ? sc.op : '', date, sku: p.sku || '', qty: p.qty, from: p.bin || '', pickface: p.expectedBin || '', manual: !sc };
      if (isStaging(p.bin) || isNonError(p.bin)) PP.stagingRows.push(row); // staging / reviewed non-error — not counted
      else if (sc) PP.errRows.push(row);                              // scanner-picked, attributed
      else PP.manualRows.push(row);                                   // manual pick, no operator
    });
  });
}

// ─── Aggregate (respects date range + operator) ───
function ppInRange(date) { return date && (!PP.from || date >= PP.from) && (!PP.to || date <= PP.to) && (PP.op === 'all' || true); }
function ppScope() {
  const { from, to, op } = PP;
  return Object.entries(PP.data.scanned || {}).map(([so, v]) => ({ so, op: v.op || '?', date: v.date || '', skus: +v.skus || 0, min: +v.min || 0 }))
    .filter(r => r.date && (!from || r.date >= from) && (!to || r.date <= to) && (op === 'all' || r.op === op));
}
function ppScopeErr(list) {
  const { from, to, op } = PP;
  return (list || PP.errRows).filter(e => e.date && (!from || e.date >= from) && (!to || e.date <= to) && (op === 'all' || e.op === op));
}
function ppAggregate() {
  const rows = ppScope(), err = ppScopeErr();
  // manual (non-scanner) errors: date-scoped only; irrelevant when focused on one operator
  const { from, to, op } = PP;
  const manualErr = (op === 'all')
    ? (PP.manualRows || []).filter(e => e.date && (!from || e.date >= from) && (!to || e.date <= to))
    : [];
  const byOp = {}, byDay = {}, opSet = new Set();
  const mkDay = d => (byDay[d] ??= { orders: 0, skus: 0, min: 0, ops: new Set(), errSet: new Set(), errManualSet: new Set() });
  let orders = 0, skus = 0, min = 0;
  for (const r of rows) {
    orders++; skus += r.skus; min += r.min; opSet.add(r.op);
    (byOp[r.op] ??= { orders: 0, skus: 0, min: 0, errSet: new Set() }); byOp[r.op].orders++; byOp[r.op].skus += r.skus; byOp[r.op].min += r.min;
    const d = mkDay(r.date); d.orders++; d.skus += r.skus; d.min += r.min; d.ops.add(r.op);
  }
  const errScanned = new Set();
  for (const e of err) { errScanned.add(e.order); if (byOp[e.op]) byOp[e.op].errSet.add(e.order); mkDay(e.date).errSet.add(e.order); }
  const errManual = new Set();
  for (const e of manualErr) { errManual.add(e.order); mkDay(e.date).errManualSet.add(e.order); }
  Object.values(byOp).forEach(v => v.errOrders = v.errSet.size);
  Object.values(byDay).forEach(v => { v.errScanned = v.errSet.size; v.errManual = v.errManualSet.size; v.errOrders = v.errScanned + v.errManual; });
  return { rows, err, byOp, byDay, totals: { orders, skus, min, operators: opSet.size, errScanned: errScanned.size, errManual: errManual.size, errOrders: errScanned.size + errManual.size } };
}

// ─── Render ───
function ppRender() {
  const hasData = Object.keys(PP.data.scanned || {}).length > 0;
  $('ppContent').style.display = hasData ? '' : 'none';
  $('ppEmpty').style.display = hasData ? 'none' : 'block';
  const days = ppAllDays();
  $('ppSub').textContent = hasData ? `${days.length} day(s) imported · ${fmtD(days[0])} to ${fmtD(days[days.length - 1])}` : 'No data imported yet — use Import report';
  if (!hasData) return;
  const a = ppAggregate();
  const roster = PP.op === 'all';
  $('ppOpCard').style.display = roster ? '' : 'none';            // focus on one operator hides the roster
  $('ppOpChartCard').style.display = roster ? '' : 'none';
  ppRenderKpis(a); ppRenderCharts(a); ppRenderOpTable(a); ppRenderDayTable(a); ppRenderErrTable();
}
function ppRenderKpis(a) {
  const t = a.totals, hrs = t.min / 60, rate = t.orders ? (t.errScanned / t.orders * 100) : 0;
  const tiles = [
    ['Orders picked', nf(t.orders), ''],
    ['SKUs picked', nf(t.skus), ''],
    ['Time tracked', fmtTime(t.min), ''],
    ['SKUs / hour', hrs ? nf(t.skus / hrs) : '0', ''],
    ['Operators', PP.op === 'all' ? nf(t.operators) : '1', ''],
    ['Errors (total)', nf(t.errOrders), ''],
    ['Scanned err rate', rate.toFixed(1), '%'],
  ];
  $('ppKpis').innerHTML = tiles.map(([l, v, u]) =>
    `<div class="pp-kpi"><div class="pp-kpi-label">${l}</div><div class="pp-kpi-value">${v}${u ? `<span class="pp-kpi-unit">${u}</span>` : ''}</div></div>`).join('');
}
function ppRenderCharts(a) {
  if (!window.Chart) { setTimeout(() => ppRenderCharts(a), 300); return; }
  const days = Object.keys(a.byDay).sort();
  const labels = days.map(d => fmtD(d).slice(0, 5));
  const orders = days.map(d => a.byDay[d].orders);
  const picks = days.map(d => a.byDay[d].skus);
  const errs = days.map(d => a.byDay[d].errOrders || 0);
  const errS = days.map(d => a.byDay[d].errScanned || 0);
  const errM = days.map(d => a.byDay[d].errManual || 0);
  // combined: orders (bars, left axis) + total errors (line, right axis); tooltip splits scanned vs manual
  if (PP.chartDay) PP.chartDay.destroy();
  PP.chartDay = new Chart($('ppChartDay').getContext('2d'), {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Orders', data: orders, backgroundColor: CHART_INK, borderRadius: 2, maxBarThickness: 30, yAxisID: 'y', order: 2 },
        { type: 'line', label: 'Errors', data: errs, borderColor: CHART_RED, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, pointBackgroundColor: CHART_RED, tension: .25, yAxisID: 'y1', order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#1a1a1a', padding: 8,
          callbacks: {
            label: c => c.dataset.label === 'Errors' ? `Errors: ${nf(c.parsed.y)}` : `Orders: ${nf(c.parsed.y)}`,
            afterBody: items => { const i = items[0].dataIndex; return [`Scanned errors: ${errS[i]}`, `Manual errors: ${errM[i]}`, `Picks: ${nf(picks[i])}`]; },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#6b6b6b', maxRotation: 0, autoSkip: true } },
        y: { position: 'left', beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#6b6b6b' }, title: { display: true, text: 'Orders', color: '#6b6b6b', font: { size: 10 } } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { font: { size: 10 }, color: CHART_RED, precision: 0, stepSize: 1 }, title: { display: true, text: 'Errors', color: CHART_RED, font: { size: 10 } } },
      },
    },
  });
  // horizontal by-operator: orders only, ranked, with the count at each bar end
  if (PP.chartOp) { PP.chartOp.destroy(); PP.chartOp = null; }
  if (PP.op === 'all' && $('ppChartOp')) {
    const ops = Object.entries(a.byOp).sort((x, y) => y[1].orders - x[1].orders);
    PP.chartOp = new Chart($('ppChartOp').getContext('2d'), {
      type: 'bar',
      data: { labels: ops.map(o => o[0]), datasets: [{ label: 'Orders', data: ops.map(o => o[1].orders), backgroundColor: CHART_INK, borderRadius: 2, maxBarThickness: 18 }] },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        layout: { padding: { right: 44 } },   // room for the value labels
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#1a1a1a', padding: 8, callbacks: { label: c => `Orders: ${nf(c.parsed.x)}` } },
        },
        scales: {
          x: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { font: { size: 10 }, color: '#6b6b6b' } },
          y: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#6b6b6b' } },
        },
      },
      plugins: [{
        id: 'opValues',
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0), d = chart.data.datasets[0].data;
          ctx.save();
          ctx.font = '600 10px "IBM Plex Mono", monospace'; ctx.fillStyle = '#1a1a1a';
          ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
          meta.data.forEach((bar, i) => { if (d[i] != null) ctx.fillText(nf(d[i]), bar.x + 5, bar.y); });
          ctx.restore();
        },
      }],
    });
  }
}
function ppRenderOpTable(a) {
  const rows = Object.entries(a.byOp).sort((x, y) => y[1].orders - x[1].orders).map(([op, v]) => {
    const hrs = v.min / 60, er = v.orders ? (v.errOrders / v.orders * 100) : 0;
    return `<tr class="pp-op-row" onclick="ppFocusOp('${esc(op).replace(/'/g, '')}')">
      <td class="op">${esc(op)}</td><td class="r num">${nf(v.orders)}</td><td class="r num">${nf(v.skus)}</td>
      <td class="r num">${fmtTime(v.min)}</td><td class="r num">${hrs ? nf(v.skus / hrs) : '—'}</td>
      <td class="r num">${v.orders ? (v.min / v.orders).toFixed(1) : '—'}</td>
      <td class="r num">${v.errOrders || 0}</td><td class="r num">${v.orders ? er.toFixed(1) + '%' : '—'}</td>
    </tr>`;
  }).join('');
  $('ppOpBody').innerHTML = rows || '<tr><td colspan="8" class="pp-empty">No operators in range</td></tr>';
}
function ppRenderDayTable(a) {
  const rows = Object.keys(a.byDay).sort().reverse().map(d => {
    const v = a.byDay[d], hrs = v.min / 60, er = v.orders ? (v.errScanned / v.orders * 100) : 0;
    return `<tr><td>${fmtD(d)}</td><td class="r num">${nf(v.orders)}</td><td class="r num">${nf(v.skus)}</td><td class="r num">${fmtTime(v.min)}</td><td class="r num">${hrs ? nf(v.skus / hrs) : '—'}</td><td class="r num">${v.ops.size}</td><td class="r num">${v.errOrders || 0} (${er.toFixed(0)}%)</td></tr>`;
  }).join('');
  $('ppDayBody').innerHTML = rows || '<tr><td colspan="7" class="pp-empty">No days in range</td></tr>';
}
function ppRenderErrTable() {
  const q = ($('ppErrSearch') && $('ppErrSearch').value || '').toLowerCase();
  const scanned = ppScopeErr();
  const manual = ppScopeErr(PP.manualRows);
  let rows = scanned.concat(manual);
  if (q) rows = rows.filter(e => `${e.order} ${e.sku} ${e.from} ${e.pickface} ${e.op} ${e.manual ? 'manual' : ''}`.toLowerCase().includes(q));
  rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  const staged = ppScopeErr(PP.stagingRows).length;
  if ($('ppErrCount')) $('ppErrCount').textContent = `(${rows.length} · ${scanned.length} scanned, ${manual.length} manual${staged ? ` · ${staged} excluded` : ''})`;
  const total = rows.length, pages = Math.max(1, Math.ceil(total / PER_PAGE));
  if (PP.errPage > pages) PP.errPage = pages;
  const slice = rows.slice((PP.errPage - 1) * PER_PAGE, PP.errPage * PER_PAGE);
  $('ppErrBody').innerHTML = slice.map(e => `<tr>
    <td>${fmtD(e.date)}</td>
    <td class="op">${esc(e.order)}</td>
    <td>${e.manual ? '<span style="color:#a39c8c">manual</span>' : (esc(e.op) || '—')}</td>
    <td>${esc(e.sku)}</td>
    <td class="r num">${e.qty != null ? esc(e.qty) : ''}</td>
    <td>${esc(e.from)}</td>
    <td>${esc(e.pickface)}</td>
  </tr>`).join('') || '<tr><td colspan="7" class="pp-empty">No errors in range</td></tr>';
  ppRenderPager(total, pages);
}
function ppRenderPager(total, pages) {
  const el = $('ppPager'); if (!el) return;
  if (total <= PER_PAGE) { el.innerHTML = ''; return; }
  const lo = (PP.errPage - 1) * PER_PAGE + 1, hi = Math.min(PP.errPage * PER_PAGE, total);
  el.innerHTML = `<span class="pp-pg-info">${lo}–${hi} of ${total}</span>
    <button class="pp-pg-btn" ${PP.errPage <= 1 ? 'disabled' : ''} onclick="ppErrPage(-1)">‹ Prev</button>
    <span class="pp-pg-info" style="margin:0">Page ${PP.errPage} / ${pages}</span>
    <button class="pp-pg-btn" ${PP.errPage >= pages ? 'disabled' : ''} onclick="ppErrPage(1)">Next ›</button>`;
}
function ppErrPage(d) { PP.errPage += d; ppRenderErrTable(); }
function ppErrSearchChanged() { PP.errPage = 1; ppRenderErrTable(); }

// ─── Controls ───
function ppApplyRange() { PP.from = $('ppFrom').value || null; PP.to = $('ppTo').value || null; PP.errPage = 1; ppRender(); }
function ppFocusOp(op) { PP.op = op; PP.errPage = 1; if ($('ppOp')) $('ppOp').value = op; ppRender(); }
function ppToast(msg, kind) { const el = document.createElement('div'); el.className = 'pp-toast ' + (kind || ''); el.textContent = msg; $('ppToast').appendChild(el); setTimeout(() => el.remove(), 3500); }

// ─── Import (client-side parse → /api/scanner-activity/import) ───
function ensureXLSX() { return new Promise((res, rej) => { if (window.XLSX) return res(); const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = () => res(); s.onerror = () => rej(new Error('could not load xlsx library')); document.head.appendChild(s); }); }
function ppParseRows(aoa) {
  const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const toISO = (v) => {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    const s = String(v).trim();
    let m = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(s); if (m && MON[m[2]]) return `${m[3]}-${MON[m[2]]}-${m[1]}`;
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (/^\d{5}$/.test(s)) { const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return dt.toISOString().slice(0, 10); }
    return '';
  };
  let reportDate = '';
  for (let i = 0; i < Math.min(aoa.length, 12) && !reportDate; i++) {
    for (const c of (aoa[i] || [])) { if (/from:/i.test(String(c))) { const iso = toISO(String(c).replace(/.*from:\s*/i, '')); if (iso) { reportDate = iso; break; } } }
  }
  let start = 0, col = {};
  for (let i = 0; i < Math.min(aoa.length, 20); i++) {
    const cs = (aoa[i] || []).map(c => String(c == null ? '' : c).toLowerCase().trim());
    if (cs.some(c => c.includes('sale order')) && cs.some(c => c === 'user')) {
      start = i + 1;
      cs.forEach((c, idx) => { if (c === 'user') col.user = idx; else if (c === 'date') col.date = idx; else if (c.includes('sale order')) col.so = idx; else if (c.includes('sku')) col.sku = idx; else if (c.includes('time')) col.time = idx; });
      break;
    }
  }
  const scanned = {}, days = new Set(), ops = {};
  let totalSkus = 0, totalMin = 0;
  for (let i = start; i < aoa.length; i++) {
    const raw = aoa[i]; if (!Array.isArray(raw)) continue;
    const cells = raw.map(c => (c instanceof Date) ? c : String(c == null ? '' : c).trim());
    const email = (col.user != null ? String(cells[col.user] || '') : (cells.find(c => /@rapidled/i.test(String(c))) || ''));
    const soCell = (col.so != null ? String(cells[col.so] || '') : (cells.find(c => /^SO-\d+$/.test(String(c).trim())) || ''));
    if (!/@rapidled\.com\.au/i.test(String(email)) || !/^SO-\d+$/.test(String(soCell).trim())) continue;
    const so = String(soCell).trim();
    const rawDate = col.date != null ? cells[col.date] : cells.find(c => toISO(c));
    const date = toISO(rawDate) || reportDate;
    const op = String(email).replace(/@rapidled\.com\.au/i, '').replace('project.scanner', 'scanner');
    const skus = col.sku != null ? (parseFloat(String(cells[col.sku]).replace(/,/g, '')) || 0) : 0;
    const min = col.time != null ? (parseFloat(String(cells[col.time]).replace(/[^\d.]/g, '')) || 0) : 0;
    const cur = scanned[so];
    if (cur) { cur.skus += skus; cur.min += min; if (!cur.date && date) cur.date = date; }
    else scanned[so] = { op, date, skus, min };
    if (date) days.add(date);
  }
  // canonicalise operator case (antonc / AntonC -> one) — mirror the ingest script
  const score = o => (/^[A-Z]/.test(o) ? 2 : 0) + (/[A-Z]/.test(o) ? 1 : 0);
  const canon = {};
  for (const s in scanned) { const o = scanned[s].op, lo = o.toLowerCase(); if (!canon[lo] || score(o) > score(canon[lo])) canon[lo] = o; }
  for (const s in scanned) scanned[s].op = canon[scanned[s].op.toLowerCase()];
  // stats from the aggregated map
  for (const s in scanned) { const r = scanned[s]; (ops[r.op] ??= { orders: 0, skus: 0, min: 0 }); ops[r.op].orders++; ops[r.op].skus += r.skus; ops[r.op].min += r.min; totalSkus += r.skus; totalMin += r.min; }
  return { scanned, days: [...days].sort(), stats: { orders: Object.keys(scanned).length, ops, totalSkus, totalMin } };
}
function ppOpenImport() {
  PP.import = null;
  $('ppImportSummary').innerHTML = '';
  const d = $('ppDrop'); d.style.display = ''; d.style.borderColor = '#cbd5e1'; d.style.background = '';
  const b = $('ppImportConfirm'); b.disabled = true; b.style.opacity = '.5';
  $('ppImportModal').classList.add('active');
  ppWireDrop();
}
function ppCloseImport() { $('ppImportModal').classList.remove('active'); }
function ppWireDrop() {
  const d = $('ppDrop'); if (!d || d._w) return; d._w = true;
  ['dragover', 'dragenter'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.style.borderColor = '#1a1a1a'; d.style.background = '#f8f6f1'; }));
  ['dragleave', 'dragend'].forEach(ev => d.addEventListener(ev, e => { e.preventDefault(); d.style.borderColor = '#cbd5e1'; d.style.background = ''; }));
  d.addEventListener('drop', e => { e.preventDefault(); d.style.borderColor = '#cbd5e1'; d.style.background = ''; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ppHandleFile(f); });
}
async function ppImportFile(input) { const f = input && input.files && input.files[0]; if (input) input.value = ''; if (f) await ppHandleFile(f); }
async function ppHandleFile(file) {
  const sum = $('ppImportSummary');
  try {
    sum.innerHTML = '<div style="color:#6b6b6b;font-size:13px">Reading “' + esc(file.name) + '”…</div>';
    await ensureXLSX();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
    const parsed = ppParseRows(aoa);
    if (!parsed.stats.orders) { sum.innerHTML = '<div style="color:#DC2F02;font-size:13px">No picking rows found — is this the InventoryWarehouseDetails report?</div>'; return; }
    parsed.fileName = file.name;
    parsed.existingDays = (PP.data && PP.data.days) || [];
    PP.import = parsed;
    ppShowPreview(parsed);
  } catch (e) { sum.innerHTML = `<div style="color:#DC2F02;font-size:13px">Error: ${esc(e.message)}</div>`; }
}
function ppShowPreview(p) {
  const s = p.stats;
  const opRows = Object.entries(s.ops).sort((a, b) => b[1].orders - a[1].orders).map(([op, v]) =>
    `<tr><td>${esc(op)}</td><td class="r num">${v.orders}</td><td class="r num">${nf(v.skus)}</td><td class="r num">${v.min.toFixed(1)}m</td></tr>`).join('');
  const chips = (p.days.length ? p.days : ['(no date found)']).map(d => {
    const already = (p.existingDays || []).includes(d), nd = d.indexOf('no date') >= 0;
    return `<span class="pp-chip ${nd ? '' : (already ? 'upd' : 'new')}">${esc(fmtD(d))}${nd ? '' : (already ? ' · update' : ' · new')}</span>`;
  }).join('');
  const tile = (v, l) => `<div class="pp-tile"><div class="pp-tile-v">${v}</div><div class="pp-tile-l">${l}</div></div>`;
  $('ppImportSummary').innerHTML =
    `<div style="font-size:13px;color:#475569;margin-bottom:10px">${esc(p.fileName)}</div>` +
    `<div class="pp-tiles">${tile(nf(s.orders), 'picked orders')}${tile(Object.keys(s.ops).length, 'operators')}${tile(nf(s.totalSkus), 'SKUs')}${tile(fmtTime(s.totalMin), 'time')}</div>` +
    `<div style="font-size:12px;color:#6b6b6b;margin-bottom:4px">Day(s) this import will register:</div>` +
    `<div style="margin-bottom:14px;max-height:120px;overflow-y:auto">${chips}</div>` +
    `<table class="pp-table"><thead><tr><th>Operator</th><th class="r">Orders</th><th class="r">SKUs</th><th class="r">Time</th></tr></thead><tbody>${opRows}</tbody></table>`;
  $('ppDrop').style.display = 'none';
  const b = $('ppImportConfirm'); b.disabled = false; b.style.opacity = '1';
}
async function ppConfirmImport() {
  if (!PP.import) return;
  const b = $('ppImportConfirm'); b.disabled = true; const o = b.textContent; b.textContent = 'Importing…';
  try {
    const res = await fetch('/api/scanner-activity/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanned: PP.import.scanned, days: PP.import.days }) });
    const j = await res.json();
    if (!res.ok || !j.success) throw new Error(j.error || 'import failed');
    ppCloseImport();
    ppToast('Imported ' + j.imported + ' orders · ' + j.total + ' total', 'ok');
    await ppLoad();
  } catch (e) { ppToast('Import error: ' + e.message, 'err'); }
  finally { b.disabled = false; b.textContent = o; }
}

// ─── Init ───
$('ppFrom').addEventListener('change', ppApplyRange);
$('ppTo').addEventListener('change', ppApplyRange);
$('ppOp').addEventListener('change', () => { PP.op = $('ppOp').value; PP.errPage = 1; ppRender(); });
$('ppImport').addEventListener('click', ppOpenImport);
$('ppImportModal').addEventListener('click', e => { if (e.target === $('ppImportModal')) ppCloseImport(); });
ppLoad();
