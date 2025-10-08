// Feature flag local to this page
window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

const state = {
  filters: { from: '', to: '', warehouse: '', movementType: '', status: '', sku: '', reason: '', picker: '' },
  pagination: { offset: 0, limit: 20, page: 1, totalPages: 1 },
  tableOnlyErrors: true,
};

function qs(id){ return document.getElementById(id); }
function on(el, evt, handler){ if (el) el.addEventListener(evt, handler); }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

// Normalize a location by stripping trailing position suffix like -P1 or -P2
function normPos(code){
  const s = String(code||'').trim();
  return s.replace(/-P\d+$/i, '');
}

function setKpis(data){
  const safe = (n, d=1)=> (Number.isFinite(n)? n : 0).toFixed(d);
  const a = qs('kpiCorrectValue'); if (a) a.textContent = `${safe(data.correctOrdersPct)}%`;
  const b = qs('kpiErrorsValue'); if (b) b.textContent = `${safe(data.ordersWithErrorsPct)}%`;
  const c = qs('kpiOskValue'); if (c) c.textContent = `${Number.isFinite(data.skusOutOfStockLocator)? data.skusOutOfStockLocator : 0}`;
  const t = qs('kpiTotalOrdersValue'); if (t) t.textContent = `${Number.isFinite(data.totalOrders)? data.totalOrders : 0}`;
  const e = qs('kpiOrdersErrValue'); if (e) e.textContent = `${Number.isFinite(data.ordersWithErrorsCount)? data.ordersWithErrorsCount : 0}`;
}

let chartWeekly, chartPicker;

function renderCharts(d){
  const ctxW = document.getElementById('chartWeekly');
  if (chartWeekly) chartWeekly.destroy();
  if (ctxW && d.dailyErrorsPct){
    // Visual-only: resample daily series into 7-day steps (non-overlapping) with average
    const daily = d.dailyErrorsPct;
    const weekly = (()=>{
      const labels = [];
      const values = [];
      for (let i=0; i<daily.labels.length; i+=7){
        const lab = daily.labels[i];
        const windowVals = daily.data.slice(i, i+7).filter(v=> Number.isFinite(v));
        const avg = windowVals.length ? (windowVals.reduce((a,b)=>a+b,0) / windowVals.length) : 0;
        labels.push(lab);
        values.push(Math.round(avg*10)/10);
      }
      return { labels, data: values };
    })();
    chartWeekly = new Chart(ctxW, {
      type: 'line',
      data: { labels: weekly.labels, datasets: [{ label: '% Errors (weekly avg)', data: weekly.data, borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,0.2)' }] },
      options: { responsive:true, maintainAspectRatio:false, layout:{ padding: {top: 8, right: 8, bottom: 8, left: 8} }, plugins:{ legend:{ position:'top', labels:{ boxWidth: 12 } } } }
    });
    // Update title to reflect weekly visual step
    const titleEl = document.getElementById('chartWeeklyTitle');
    if (titleEl){ titleEl.textContent = 'Weekly % Orders with Errors (7-day step)'; }
  }

  const ctxP = document.getElementById('chartPicker');
  if (chartPicker) chartPicker.destroy();
  if (ctxP && d.errorsByType){ chartPicker = new Chart(ctxP, {
    type: 'bar',
    data: { labels: d.errorsByType.labels, datasets: [{ label: 'Errors by Type', data: d.errorsByType.data, backgroundColor: '#3b82f6' }] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ autoSkip:true, maxRotation: 0 } }, y:{ beginAtZero:true } } }
  }); }

  // Lists for Top Locations and Top SKUs with errors
  const listLoc = document.getElementById('listTopLocations');
  if (listLoc){
    const items = d.topLocationsWithErrors.map((e,i)=> `<li><span class="label">${i+1}. ${escapeHtml(e.label)}</span><span class="count">${e.count}</span></li>`).join('');
    listLoc.innerHTML = items ? `<ul class="top-list">${items}</ul>` : '<div class="muted">No data</div>';
  }
  const listSku = document.getElementById('listTopSkus');
  if (listSku){
    const items = d.topSkusWithErrors.map((e,i)=> `<li><span class="label">${i+1}. ${escapeHtml(e.label)}</span><span class="count">${e.count}</span></li>`).join('');
    listSku.innerHTML = items ? `<ul class="top-list">${items}</ul>` : '<div class="muted">No data</div>';
  }

  // Compute Trend (28d) KPI using dailyErrorsPct if available
  try{
    const arrowEl = document.getElementById('kpiTrendArrow');
    const deltaEl = document.getElementById('kpiTrendDelta');
    const cardEl = document.getElementById('kpi-trend');
    const sparkEl = document.getElementById('kpiTrendSpark');
    if (arrowEl && deltaEl && cardEl){
      const labels = (d.dailyErrorsPct && Array.isArray(d.dailyErrorsPct.labels)) ? d.dailyErrorsPct.labels : [];
      const vals = (d.dailyErrorsPct && Array.isArray(d.dailyErrorsPct.data)) ? d.dailyErrorsPct.data : [];
      // Build recent series (last 56 days), aligned by the end
      const n = labels.length;
      const take = Math.min(56, n);
      const endIdx = n;
      const startIdx = Math.max(0, n - take);
      const recent = vals.slice(startIdx, endIdx).filter(v=> Number.isFinite(v)); // ErrorRate% per day
      // Low volume check: require at least 50 orders in each period
      // Approximate with count of days having data; if exact daily order counts are needed, integrate counts in dataset
      const half = Math.floor(recent.length / 2);
      const curArr = recent.slice(-28);
      const prevArr = recent.slice(-56, -28);
      const hasEnough = (curArr.length >= 20) && (prevArr.length >= 20); // proxy for volume; stricter would use actual order counts
      if (!hasEnough){
        deltaEl.textContent = '—';
        arrowEl.textContent = '≈';
        cardEl.classList.remove('green','red'); cardEl.classList.add('gray');
        if (sparkEl) sparkEl.innerHTML = '';
      } else {
        const avg = (arr)=> arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
        const curErr = avg(curArr);
        const prevErr = avg(prevArr);
        const curQI = 100 - curErr;
        const prevQI = 100 - prevErr;
        const delta = curQI - prevQI;
        const shown = (delta >= 0 ? '+' : '') + (Math.round(delta*100)/100).toFixed(2);
        deltaEl.textContent = shown;
        // status
        cardEl.classList.remove('green','red','gray');
        if (delta > 0.30){ arrowEl.textContent = '↑'; cardEl.classList.add('green'); }
        else if (delta < -0.30){ arrowEl.textContent = '↓'; cardEl.classList.add('red'); }
        else { arrowEl.textContent = '≈'; cardEl.classList.add('gray'); }
        // Optional sparkline for last 28 days QI
        if (sparkEl){
          const qi = curArr.map(v=> 100 - v);
          const w = 80, h = 24;
          const min = Math.min(...qi), max = Math.max(...qi);
          const range = (max - min) || 1;
          const step = qi.length > 1 ? (w / (qi.length - 1)) : w;
          const pts = qi.map((v,i)=>{
            const x = Math.round(i * step);
            const y = Math.round(h - ((v - min) / range) * h);
            return `${x},${y}`;
          }).join(' ');
          sparkEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="1" points="${pts}"/></svg>`;
        }
      }
    }
  } catch(_){ }
}

async function load(){
  // Warm-up: fetch and cache all required rows once to avoid multiple full scans
  try { await fetchWarehouseRowsAll(); } catch(err){ console.warn('Warm-up load rows error', err); }
  try {
    await updateCoverageBadges();
  } catch(err){ console.error('Coverage badges update error', err); }
  try {
    const kpis = await getWarehouseKpis(state.filters);
    setKpis(kpis);
  } catch(err){ console.error('KPIs load error', err); }
  try {
    const charts = await getWarehouseCharts(state.filters);
    renderCharts(charts);
  } catch(err){ console.error('Charts load error', err); }
  try {
    await loadTable();
  } catch(err){ console.error('Table load error', err); }
}

// Coverage badges (overall report min/max independent of business filters)
async function updateCoverageBadges(){
  const sb = await ensureSb();
  const minQ = sb.from('warehouse_movements').select('report_date').order('report_date', { ascending: true }).limit(1);
  const maxQ = sb.from('warehouse_movements').select('report_date').order('report_date', { ascending: false }).limit(1);
  const [{ data: minD, error: e1 }, { data: maxD, error: e2 }] = await Promise.all([minQ, maxQ]);
  if (e1 || e2){ console.warn('updateCoverageBadges error', e1||e2); return; }
  const minStr = minD && minD[0] ? toISO(minD[0].report_date) : '—';
  const maxStr = maxD && maxD[0] ? toISO(maxD[0].report_date) : '—';
  const rangeBadge = document.getElementById('wmRangeBadge');
  const lastBadge = document.getElementById('wmLastReportBadge');
  if (rangeBadge) rangeBadge.textContent = `Range: ${minStr} → ${maxStr}`;
  if (lastBadge) lastBadge.textContent = `Last report: ${maxStr}`;
}

async function loadTable(){
  const res = await getWarehouseErrorsTable({ ...state.filters }, state.pagination, state.tableOnlyErrors);
  const tbody = document.querySelector('#errorsTable tbody');
  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  res.items.forEach(r=>{
    const tr = document.createElement('tr');
    if (r.isError) tr.classList.add('error-row');
    tr.innerHTML = `<td>${r.order}</td><td>${r.customer}</td><td>${r.date}</td><td>${r.sku||'-'}</td><td>${r.usedLocation}</td><td>${r.correctLocator}</td><td>${r.qtyOut}</td>`;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);
  // update pagination label
  const lbl = document.getElementById('wmTablePageLabel');
  if (lbl) lbl.textContent = `Page ${state.pagination.page} / ${state.pagination.totalPages}`;
}

function bind(){
  // Disable KPI click actions completely
  ['kpi-correct','kpi-errors','kpi-osk','kpi-total-orders','kpi-orders-err'].forEach((id)=>{
    const el = document.getElementById(id);
    if (el) el.style.cursor = 'default';
  });
  // Filters are not present on this page version; guard bindings if they exist
  const applyBtn = document.getElementById('applyFilters');
  if (applyBtn){
    on(applyBtn, 'click', ()=>{
      const v = (id)=> (document.getElementById(id)?.value || '').trim();
      state.filters = {
        from: v('fromDate'),
        to: v('toDate'),
        warehouse: v('warehouse'),
        movementType: v('movementType'),
        status: v('status'),
        sku: v('sku'),
        reason: v('reason'),
        picker: v('picker'),
      };
      load();
    });
  }
  const clearBtn = document.getElementById('clearFilters');
  if (clearBtn){
    on(clearBtn, 'click', ()=>{
      ['fromDate','toDate','warehouse','movementType','status','sku','reason','picker'].forEach(id=>{
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === 'SELECT') el.value = '';
        else el.value = '';
      });
      state.filters = { from:'', to:'', warehouse:'', movementType:'', status:'', sku:'', reason:'', picker:'' };
      load();
    });
  }
  const prev = document.getElementById('wmPrevPage');
  const next = document.getElementById('wmNextPage');
  on(prev, 'click', async ()=>{
    if (state.pagination.page > 1){
      state.pagination.page -= 1;
      state.pagination.offset = (state.pagination.page - 1) * state.pagination.limit;
      await loadTable();
    }
  });
  on(next, 'click', async ()=>{
    if (state.pagination.page < state.pagination.totalPages){
      state.pagination.page += 1;
      state.pagination.offset = (state.pagination.page - 1) * state.pagination.limit;
      await loadTable();
    }
  });
  // Table-only filter: show only errors
  const onlyErr = document.getElementById('wmOnlyErrors');
  if (onlyErr){
    onlyErr.checked = !!state.tableOnlyErrors;
    on(onlyErr, 'change', async (e)=>{
      state.tableOnlyErrors = !!e.target.checked;
      state.pagination.page = 1;
      state.pagination.offset = 0;
      await loadTable();
    });
  }

}

window.addEventListener('DOMContentLoaded', ()=>{ bind(); load(); });

// ---- Data adapters (Supabase) ----
async function ensureSb(){
  try { await (window.supabaseReady || Promise.resolve()); } catch(_) {}
  const sb = (window.supabaseSearch && window.supabaseSearch.client) || window.supabase;
  if (!sb) throw new Error('Supabase client not available');
  return sb;
}

function toISO(d){
  if (!d) return '';
  if (typeof d === 'string'){
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const x = new Date(d);
  if (isNaN(x)) return '';
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth()+1).padStart(2,'0');
  const day = String(x.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function getWarehouseKpis(filters){
  const rows = await fetchWarehouseRowsAll();
  try { console.debug('[WM][KPIs] rows (cached)=', rows.length); } catch(_){ }
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const normKey = (s)=> String(s||'').toLowerCase().replace(/\s|\-|_/g,'');
  const EXCLUDE_LOC = new Set(['MA-DOCK','MA-GA']);
  // Normalize and apply base filters
  const base = rows.filter(r=> Number(r.qty_out||0) > 0)
    .map(r=> ({
      date: toISO(r.report_date),
      bin: norm(r.bin),
      stock_locator: norm(r.stock_locator),
      sku: norm(r.sku),
      reference: String(r.reference||'').trim(),
      refKey: normKey(r.reference_type),
      qty_out: Number(r.qty_out||0),
    }))
    .filter(r=> r.stock_locator !== '' && !EXCLUDE_LOC.has(r.stock_locator) && !r.stock_locator.includes('BOM') && r.refKey !== 'billofmaterial' && r.refKey !== 'stocktransfer');
  // Agrupar como na tabela: (date, reference, sku) -> used bins set (normalized), correct locator (normalized), qtyOut
  const byTxSku = new Map();
  for (const r of base){
    const key = `${r.date||''}::${r.reference||''}::${r.sku||''}`;
    const usedBinNorm = normPos(String(r.bin||'').trim());
    const correctNorm = normPos(String(r.stock_locator||'').trim());
    const g = byTxSku.get(key) || { date: r.date, reference: r.reference, sku: r.sku, used: new Set(), correct: correctNorm, qtyOut: 0 };
    if (usedBinNorm) g.used.add(usedBinNorm);
    g.qtyOut += r.qty_out;
    // keep last correct locator (normalized) if varies
    g.correct = correctNorm || g.correct;
    byTxSku.set(key, g);
  }
  // Derivar por pedido (date,reference)
  const perOrder = new Map();
  for (const g of byTxSku.values()){
  const okUsed = Array.from(g.used);
  const isErr = okUsed.length > 0 && !okUsed.includes((g.correct||'').trim());
    // Avoid collapsing when reference is missing: fallback to per-SKU pseudo order
    const refKey = (g.reference && g.reference.trim()) ? g.reference.trim() : `REF_MISSING__${g.sku||''}`;
    const key = `${g.date||''}::${refKey}`;
    const acc = perOrder.get(key) || { hasOut: false, hasErr: false };
    acc.hasOut = acc.hasOut || g.qtyOut > 0;
    acc.hasErr = acc.hasErr || isErr;
    perOrder.set(key, acc);
  }
  // Debug: log KPI coverage
  try { console.debug('[WM][KPIs] perOrder=', perOrder.size); } catch(_){}
  const values = Array.from(perOrder.values());
  const denom = values.filter(v=> v.hasOut).length; // total orders
  const numErr = values.filter(v=> v.hasErr).length; // orders with errors
  const pctErrors = denom > 0 ? (numErr/denom)*100 : 0;
  const skusWithErrors = new Set(Array.from(byTxSku.values()).filter(g=> (Array.from(g.used).length>0 && !Array.from(g.used).includes((g.correct||'').trim()))).map(g=> g.sku)).size;
  return {
    correctOrdersPct: Math.max(0, Math.min(100, 100 - pctErrors)),
    ordersWithErrorsPct: Math.max(0, Math.min(100, pctErrors)),
    skusOutOfStockLocator: skusWithErrors,
    totalOrders: denom,
    ordersWithErrorsCount: numErr,
  };
}

async function getWarehouseCharts(filters){
  const rowsAll = await fetchWarehouseRowsAll();
  try { console.debug('[WM][Charts] rows (cached)=', rowsAll.length); } catch(_){ }
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const EXCLUDE_LOC = new Set(['MA-DOCK','MA-GA']);
  // Already normalized by fetchWarehouseRowsAll; apply final filters
  const rowsAllFiltered = (rowsAll||[]).filter(r=> r.qty_out > 0 && r.stock_locator !== '' && !EXCLUDE_LOC.has(r.stock_locator) && !r.stock_locator.includes('BOM') && r.refKey !== 'billofmaterial' && r.refKey !== 'stocktransfer');
  // Full-period: use all rows
  const rows = rowsAllFiltered;
  const isErr = (r)=> {
    const binN = normPos(r.bin||'');
    const locN = normPos(r.stock_locator||'');
    return (r.bin === '' || binN !== locN);
  };
  if (!rows.length){
    const titleEl = document.getElementById('chartWeeklyTitle');
    if (titleEl){ titleEl.textContent = 'Daily % Orders with Errors'; }
    return { dailyErrorsPct: { labels: [], data: [] }, errorsByType: { labels: [], data: [] }, topLocationsWithErrors: [], topSkusWithErrors: [] };
  }
  // Compute groups like the table: (date, reference, sku)
  const byTxSku = new Map();
  for (const r of rows){
    const key = `${r.report_date||''}::${r.reference||''}::${r.sku||''}`;
    const usedBinNorm = normPos(String(r.bin||'').trim());
    const correctNorm = normPos(String(r.stock_locator||'').trim());
    const g = byTxSku.get(key) || { date: r.report_date, reference: r.reference, sku: r.sku, used: new Set(), correct: correctNorm };
    if (usedBinNorm) g.used.add(usedBinNorm);
    g.correct = correctNorm || g.correct;
    byTxSku.set(key, g);
  }
  // Per-order rollup
  const perOrder = new Map();
  for (const g of byTxSku.values()){
  const used = Array.from(g.used);
  const isErrGroup = used.length > 0 && !used.includes((g.correct||'').trim());
    // Avoid collapsing when reference is missing: fallback to per-SKU pseudo order
    const refKey = (g.reference && g.reference.trim()) ? g.reference.trim() : `REF_MISSING__${g.sku||''}`;
    const key = `${g.date||''}::${refKey}`;
    const o = perOrder.get(key) || { date: g.date, hasOut:true, hasErr:false };
    o.hasErr = o.hasErr || isErrGroup;
    perOrder.set(key, o);
  }
  try { console.debug('[WM][Charts] perOrder=', perOrder.size); } catch(_){}
  const orderList = Array.from(perOrder.values()).sort((a,b)=> a.date.localeCompare(b.date));
  // Determine full date range from dataset (cached full coverage)
  const minStrEff = rowsAll[0]?.report_date || orderList[0]?.date || rows[0]?.report_date;
  const maxStrEff = rowsAll[rowsAll.length - 1]?.report_date || orderList[orderList.length - 1]?.date || rows[rows.length - 1]?.report_date;
  const startRange = new Date(minStrEff + 'T00:00:00Z');
  const endRange = new Date(maxStrEff + 'T00:00:00Z');
  startRange.setUTCHours(0,0,0,0);
  endRange.setUTCHours(0,0,0,0);
  const labels = [];
  const buckets = new Map(); // key: YYYY-MM-DD
  for (let dt = new Date(startRange); dt <= endRange; dt = new Date(dt.getTime() + 86400000)){
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth()+1).padStart(2,'0');
    const d = String(dt.getUTCDate()).padStart(2,'0');
    const key = `${y}-${m}-${d}`;
    labels.push(key);
    buckets.set(key, { out:0, err:0 });
  }
  for (const o of orderList){
    const key = o.date; // already ISO yyyy-mm-dd
    const e = buckets.get(key);
    if (!e) continue;
    e.out += 1;
    if (o.hasErr) e.err += 1;
  }
  const dayLabels = labels;
  const dayData = dayLabels.map(k=>{
    const e = buckets.get(k) || { out:0, err:0 };
    return e.out ? Math.round((e.err/e.out)*1000)/10 : 0;
  });
  const titleEl = document.getElementById('chartWeeklyTitle');
  if (titleEl){ titleEl.textContent = 'Daily % Orders with Errors'; }
  // Do not update global badges here; they reflect overall report coverage
  // Errors by Reference Type (comparative)
  const typeErrMap = new Map();
  for (const r of rows){ if (isErr(r)){ const k = r.reference_type || '(none)'; typeErrMap.set(k, (typeErrMap.get(k)||0) + 1); } }
  const typeEntries = Array.from(typeErrMap.entries()).sort((a,b)=> b[1]-a[1]).slice(0,12);
  // Top locations with errors (list)
  const locErrMap = new Map();
  for (const r of rows){ if (isErr(r)){ const key = [r.stock_locator, r.bin].filter(Boolean).join(' / '); locErrMap.set(key, (locErrMap.get(key)||0) + 1); } }
  const topLocList = Array.from(locErrMap.entries()).sort((a,b)=> b[1]-a[1]).slice(0,10).map(([label,count])=>({ label, count }));
  // Top SKUs with errors list (unchanged, list only)
  const skuCountErr = new Map();
  for (const r of rows){ if (isErr(r)){ const k = r.sku || '(none)'; skuCountErr.set(k, (skuCountErr.get(k)||0) + 1); } }
  const skuList = Array.from(skuCountErr.entries()).sort((a,b)=> b[1]-a[1]).slice(0,10).map(([label,count])=>({ label, count }));
  return { dailyErrorsPct: { labels: dayLabels, data: dayData }, errorsByType: { labels: typeEntries.map(e=>e[0]), data: typeEntries.map(e=>e[1]) }, topLocationsWithErrors: topLocList, topSkusWithErrors: skuList };
}

function emptyCharts(){
  return {
    dailyErrorsPct: { labels: [], data: [] },
    errorsByType: { labels: [], data: [] },
    topLocationsWithErrors: [],
    topSkusWithErrors: [],
  };
}

// isoWeek helper removed as charts are now daily across full period

async function getWarehouseErrorsTable(params, pagination, onlyErrors){
  const limit = pagination?.limit || 20;
  const page = pagination?.page || 1;
  const pageStart = (page - 1) * limit;
  const rows = await fetchWarehouseRowsAll();

  // normalize + filter dataset
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const normKey = (s)=> String(s||'').toLowerCase().replace(/\s|\-|_/g,'');
  const EXCLUDE_LOC = new Set(['MA-DOCK','MA-GA']);
  const filteredAll = rows.map(r=> ({
    report_date: r.report_date,
    reference: r.reference,
    reference_type: r.reference_type,
    stock_locator: norm(r.stock_locator),
    bin: norm(r.bin),
    quantity_out: r.qty_out,
    sku: r.sku,
    refKey: normKey(r.reference_type),
  })).filter(r=> r.stock_locator !== '' && !EXCLUDE_LOC.has(r.stock_locator) && !r.stock_locator.includes('BOM') && r.refKey !== 'billofmaterial' && r.refKey !== 'stocktransfer');
  // Effective period for table
  let effFrom = params?.from || '';
  let effTo = params?.to || '';
  if ((state.period === 'week' || state.period === 'month') && (!effFrom || !effTo)){
    const dates = filteredAll.map(r=> toISO(r.report_date)).filter(Boolean).sort();
    const maxStr = dates[dates.length-1];
    if (maxStr){
      const maxD = new Date(maxStr + 'T00:00:00Z');
      if (state.period === 'week'){
        const x = new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth(), maxD.getUTCDate()));
        const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() - (day - 1)); x.setUTCHours(0,0,0,0);
        effFrom = toISO(x); effTo = maxStr;
      } else {
        const x = new Date(Date.UTC(maxD.getUTCFullYear(), maxD.getUTCMonth(), 1)); x.setUTCHours(0,0,0,0);
        effFrom = toISO(x); effTo = maxStr;
      }
    }
  }
  const filtered = filteredAll.filter(r=> {
    const d = toISO(r.report_date);
    if (!effFrom && !effTo) return true;
    if (effFrom && d < effFrom) return false;
    if (effTo && d > effTo) return false;
    return true;
  });

  // Group by transaction+sku to avoid mixing different correct locators
  const byTxSku = new Map();
  for (const r of filtered){
    const date = toISO(r.report_date);
    const key = `${date}::${r.reference||''}::${r.sku||''}`;
    const correct = String(r.stock_locator||'').trim();
    const correctNorm = normPos(correct);
    const usedBin = String(r.bin||'').trim();
    const usedNorm = normPos(usedBin);
    const g = byTxSku.get(key) || { date, reference: r.reference||'-', type: r.reference_type||'-', sku: r.sku||'', usedRaw: new Set(), usedNorm: new Set(), correct, correctNorm, qtyOut: 0 };
    // always collect used bin if present to include correct rows too
    if (usedBin){ g.usedRaw.add(usedBin); }
    if (usedNorm){ g.usedNorm.add(usedNorm); }
    g.qtyOut += Number(r.quantity_out||0);
    byTxSku.set(key, g);
  }

  const allItemsRaw = Array.from(byTxSku.values())
    .sort((a,b)=> b.date.localeCompare(a.date))
    .map(x=>({
      order: x.reference,
      customer: x.type, // renamed to Type in header
      date: x.date,
      sku: x.sku,
      usedLocation: Array.from(x.usedRaw||[]).join(', ') || '-',
      correctLocator: x.correct || '-',
      qtyOut: x.qtyOut,
      isError: (Array.from(x.usedNorm||[]).length > 0) && !Array.from(x.usedNorm||[]).includes((x.correctNorm||'').trim())
    }));
  const allItems = onlyErrors ? allItemsRaw.filter(r=> r.isError) : allItemsRaw;
  const total = allItems.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paged = allItems.slice(pageStart, pageStart + limit);
  state.pagination.totalPages = totalPages;
  return { items: paged, totalPages };
}

// ---- Shared rows cache for warehouse_movements ----
let __wm_rows_cache = null;
async function fetchWarehouseRowsAll(){
  if (Array.isArray(__wm_rows_cache) && __wm_rows_cache.length) return __wm_rows_cache;
  const sb = await ensureSb();
  const pageSize = 1000;
  let fromIdx = 0;
  const rowsRaw = [];
  while (true){
    const { data, error } = await sb
      .from('warehouse_movements')
      .select('report_date, quantity_out, reference_type, stock_locator, bin, sku, reference')
      .order('report_date', { ascending: true })
      .range(fromIdx, fromIdx + pageSize - 1);
    if (error){ console.warn('fetchWarehouseRowsAll error', error); break; }
    const batch = data || [];
    rowsRaw.push(...batch);
    if (batch.length < pageSize) break;
    fromIdx += batch.length;
    if (rowsRaw.length > 200000) break; // safety cap
  }
  // Normalize once
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const normKey = (s)=> String(s||'').toLowerCase().replace(/\s|\-|_/g,'');
  __wm_rows_cache = (rowsRaw||[]).map(r=>({
    report_date: toISO(r.report_date),
    qty_out: Number(r.quantity_out||0),
    reference_type: String(r.reference_type||'').trim(),
    stock_locator: norm(r.stock_locator),
    bin: norm(r.bin),
    sku: String(r.sku||'').trim(),
    reference: String(r.reference||'').trim(),
    refKey: normKey(r.reference_type),
  }));
  try { console.debug('[WM] cache ready, rows=', __wm_rows_cache.length); } catch(_){ }
  return __wm_rows_cache;
}
