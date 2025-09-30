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

function setKpis(data){
  const safe = (n, d=1)=> (Number.isFinite(n)? n : 0).toFixed(d);
  const a = qs('kpiCorrectValue'); if (a) a.textContent = `${safe(data.correctOrdersPct)}%`;
  const b = qs('kpiErrorsValue'); if (b) b.textContent = `${safe(data.ordersWithErrorsPct)}%`;
  const c = qs('kpiOskValue'); if (c) c.textContent = `${Number.isFinite(data.skusOutOfStockLocator)? data.skusOutOfStockLocator : 0}`;
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
}

async function load(){
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
  ['kpi-correct','kpi-errors','kpi-osk'].forEach((id)=>{
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
  // Pagination controls
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
    // sync default state
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
  const sb = await ensureSb();
  const pageSize = 1000; // Supabase max per request
  let fromIdx = 0;
  const rows = [];
  while (true){
    const { data, error } = await sb
      .from('warehouse_movements')
      .select('report_date, quantity_out, sku, stock_locator, bin, reference, reference_type')
      .order('report_date', { ascending: true })
      .range(fromIdx, fromIdx + pageSize - 1);
    if (error){ console.warn('getWarehouseKpis error', error); break; }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    fromIdx += pageSize;
    if (rows.length > 200000) break; // safety cap
  }
  try { console.debug('[WM][KPIs] loaded rows=', rows.length); } catch(_){}
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const normKey = (s)=> String(s||'').toLowerCase().replace(/\s|\-|_/g,'');
  const EXCLUDE_LOC = new Set(['MA-DOCK','MA-GA']);
  // Normalize and apply base filters
  const base = rows.filter(r=> Number(r.quantity_out||0) > 0)
    .map(r=> ({
      date: toISO(r.report_date),
      bin: norm(r.bin),
      stock_locator: norm(r.stock_locator),
      sku: norm(r.sku),
      reference: String(r.reference||'').trim(),
      refKey: normKey(r.reference_type),
      qty_out: Number(r.quantity_out||0),
    }))
    .filter(r=> r.stock_locator !== '' && !EXCLUDE_LOC.has(r.stock_locator) && !r.stock_locator.includes('BOM') && r.refKey !== 'billofmaterial' && r.refKey !== 'stocktransfer');
  // Agrupar como na tabela: (date, reference, sku) -> used bins set, correct locator, qtyOut
  const byTxSku = new Map();
  for (const r of base){
    const key = `${r.date||''}::${r.reference||''}::${r.sku||''}`;
    const usedBin = String(r.bin||'').trim();
    const g = byTxSku.get(key) || { date: r.date, reference: r.reference, sku: r.sku, used: new Set(), correct: r.stock_locator, qtyOut: 0 };
    if (usedBin) g.used.add(usedBin);
    g.qtyOut += r.qty_out;
    // keep last correct locator if varies
    g.correct = r.stock_locator || g.correct;
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
  const denom = values.filter(v=> v.hasOut).length || 1;
  const numErr = values.filter(v=> v.hasErr).length;
  const pctErrors = (numErr/denom)*100;
  const skusWithErrors = new Set(Array.from(byTxSku.values()).filter(g=> (Array.from(g.used).length>0 && !Array.from(g.used).includes((g.correct||'').trim()))).map(g=> g.sku)).size;
  return {
    correctOrdersPct: Math.max(0, Math.min(100, 100 - pctErrors)),
    ordersWithErrorsPct: Math.max(0, Math.min(100, pctErrors)),
    skusOutOfStockLocator: skusWithErrors,
  };
}

async function getWarehouseCharts(filters){
  const sb = await ensureSb();
  // Determine full coverage range directly from DB (independent of other filters)
  let minDateStr = null, maxDateStr = null;
  try {
    const minQ = sb.from('warehouse_movements').select('report_date').order('report_date', { ascending: true }).limit(1);
    const maxQ = sb.from('warehouse_movements').select('report_date').order('report_date', { ascending: false }).limit(1);
    const [{ data: minD }, { data: maxD }] = await Promise.all([minQ, maxQ]);
    minDateStr = minD && minD[0] ? toISO(minD[0].report_date) : null;
    maxDateStr = maxD && maxD[0] ? toISO(maxD[0].report_date) : null;
  } catch(err){ console.warn('getWarehouseCharts range fetch error', err); }
  const pageSize = 1000; // Supabase max per request
  let fromIdx = 0;
  const rowsRaw = [];
  while (true){
    const { data, error } = await sb
      .from('warehouse_movements')
      .select('report_date, quantity_out, reference_type, stock_locator, bin, sku, reference')
      .order('report_date', { ascending: true })
      .range(fromIdx, fromIdx + pageSize - 1);
    if (error){ console.warn('getWarehouseCharts error', error); break; }
    const batch = data || [];
    rowsRaw.push(...batch);
    if (batch.length < pageSize) break;
    fromIdx += pageSize;
    if (rowsRaw.length > 200000) break; // safety cap
  }
  try { console.debug('[WM][Charts] loaded rows=', rowsRaw.length); } catch(_){}
  const norm = (s)=> String(s||'').trim().toUpperCase();
  const normKey = (s)=> String(s||'').toLowerCase().replace(/\s|\-|_/g,'');
  const EXCLUDE_LOC = new Set(['MA-DOCK','MA-GA']);
  const rowsAll = (rowsRaw||[]).map(r=>({
    report_date: toISO(r.report_date),
    qty_out: Number(r.quantity_out||0),
    reference_type: String(r.reference_type||'').trim(),
    stock_locator: norm(r.stock_locator),
    bin: norm(r.bin),
    sku: String(r.sku||'').trim(),
    reference: String(r.reference||'').trim(),
    refKey: normKey(r.reference_type),
  })).filter(r=> r.qty_out > 0 && r.stock_locator !== '' && !EXCLUDE_LOC.has(r.stock_locator) && !r.stock_locator.includes('BOM') && r.refKey !== 'billofmaterial' && r.refKey !== 'stocktransfer');
  // Full-period: use all rows
  const rows = rowsAll;
  const isErr = (r)=> (r.bin === '' || r.bin !== r.stock_locator);
  if (!rows.length){
    const titleEl = document.getElementById('chartWeeklyTitle');
    if (titleEl){ titleEl.textContent = 'Daily % Orders with Errors'; }
    return { dailyErrorsPct: { labels: [], data: [] }, errorsByType: { labels: [], data: [] }, topLocationsWithErrors: [], topSkusWithErrors: [] };
  }
  // Compute groups like the table: (date, reference, sku)
  const byTxSku = new Map();
  for (const r of rows){
    const key = `${r.report_date||''}::${r.reference||''}::${r.sku||''}`;
    const usedBin = String(r.bin||'').trim();
    const g = byTxSku.get(key) || { date: r.report_date, reference: r.reference, sku: r.sku, used: new Set(), correct: r.stock_locator };
    if (usedBin) g.used.add(usedBin);
    g.correct = r.stock_locator || g.correct;
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
  // Determine full date range prioritizing DB min/max; fallback to dataset if needed
  const minStrEff = minDateStr || rowsAll[0]?.report_date || orderList[0]?.date || rows[0]?.report_date;
  const maxStrEff = maxDateStr || rowsAll[rowsAll.length - 1]?.report_date || orderList[orderList.length - 1]?.date || rows[rows.length - 1]?.report_date;
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
  const sb = await ensureSb();
  const limit = pagination?.limit || 20;
  const page = pagination?.page || 1;
  const pageStart = (page - 1) * limit;
  // Fetch movements in pages and aggregate errors client-side for correct pagination
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  while (true){
    const { data, error } = await sb
      .from('warehouse_movements')
      .select('report_date, reference, reference_type, stock_locator, bin, quantity_out, sku')
      .gt('quantity_out', 0)
      .order('report_date', { ascending:false })
      .range(from, from + pageSize - 1);
    if (error){ console.warn('getWarehouseErrorsTable error', error); break; }
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += batch.length;
    if (rows.length > 20000) break; // safety cap
  }

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
    quantity_out: r.quantity_out,
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
    const usedBin = String(r.bin||'').trim();
    const g = byTxSku.get(key) || { date, reference: r.reference||'-', type: r.reference_type||'-', sku: r.sku||'', used: new Set(), correct, qtyOut: 0 };
    // always collect used bin if present to include correct rows too
    if (usedBin){ g.used.add(usedBin); }
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
      usedLocation: Array.from(x.used).join(', ') || '-',
      correctLocator: x.correct || '-',
      qtyOut: x.qtyOut,
      isError: (Array.from(x.used).length > 0) && !Array.from(x.used).includes((x.correct||'').trim())
    }));
  const allItems = onlyErrors ? allItemsRaw.filter(r=> r.isError) : allItemsRaw;
  const total = allItems.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const paged = allItems.slice(pageStart, pageStart + limit);
  state.pagination.totalPages = totalPages;
  return { items: paged, totalPages };
}
