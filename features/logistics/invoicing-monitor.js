// Feature flag local to this page
window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

// Local state and cache
const state = { filters: { from:'', to:'', status:'', customer:'', terms:'', rep:'', location: 'All', search: '' }, pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, bucket: 'All', includeInvoiced: false, dataRange: { start: null, end: null, reportStart: null, reportEnd: null, lastReport: null } };
const cache = { rows: [], rowsAll: [] };
let __inv_rows_cache = null; // session cache for raw rows
const HIDDEN_KEY = 'invmon_hidden_orders';
function getHiddenSet(){
  try{ const raw = localStorage.getItem(HIDDEN_KEY); if (!raw) return new Set(); const arr = JSON.parse(raw); return new Set(Array.isArray(arr)?arr:[]); } catch(_) { return new Set(); }
}
function addHidden(orderNo){
  if (!orderNo) return;
  const set = getHiddenSet();
  set.add(String(orderNo));
  try{ localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(set))); } catch(_) {}
}
function isHidden(orderNo){
  if (!orderNo) return false;
  return getHiddenSet().has(String(orderNo));
}
function resetHidden(){
  try{ localStorage.removeItem(HIDDEN_KEY); } catch(_) {}
}

// Utilities
function isEmptyToken(v){
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  if (!s) return true;
  return ['-', '—', 'n/a', 'na', 'null', 'undefined', '0'].includes(s);
}
function parseISODate(d){
  if (!d) return null;
  if (d instanceof Date && !isNaN(d)) return d;
  const s = String(d).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (['-', '—', 'n/a', 'na', 'null', 'undefined', '0'].includes(low)) return null;
  // Excel serial number
  if (/^\d{4,6}$/.test(s)) {
    const base = new Date(Date.UTC(1899, 11, 30));
    const dt = new Date(base.getTime() + Number(s) * 86400000);
    return (isNaN(dt) || dt.getUTCFullYear() < 1900) ? null : dt;
  }
  // dd/mm/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m){
    const dd = Number(m[1]);
    const mm = Number(m[2]) - 1;
    const yyRaw = Number(m[3]);
    const yy = yyRaw < 100 ? (2000 + yyRaw) : yyRaw;
    const dt = new Date(yy, mm, dd);
    return (isNaN(dt) || dt.getUTCFullYear() < 1900) ? null : dt;
  }
  // ISO
  const dt = new Date(s);
  if (isNaN(dt)) return null;
  return dt.getUTCFullYear() < 1900 ? null : dt;
}
function fmtDate(d){
  if (!d) return '';
  const iso = new Date(d);
  if (isNaN(iso)) return '';
  return iso.toISOString().split('T')[0];
}
function diffDays(a, b){
  const d1 = new Date(a); const d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return 0;
  return Math.floor((d1 - d2) / 86400000);
}

function setKpis(k){
  const safe = (v)=> (v==null || (typeof v === 'number' && isNaN(v))) ? '—' : String(v);
  const d1Card = document.getElementById('kpiD1Card'); if (d1Card) d1Card.textContent = safe(k.d1);
  // Mirror counts into the card inside the chart section
  const d2Card = document.getElementById('kpiD2Card'); if (d2Card) d2Card.textContent = safe(k.d2);
  const d3Card = document.getElementById('kpiD3Card'); if (d3Card) d3Card.textContent = safe(k.d3);
  const d4Card = document.getElementById('kpiD4Card'); if (d4Card) d4Card.textContent = safe(k.d4);
  const wkCard = document.getElementById('kpiWeekCard'); if (wkCard) { wkCard.textContent = safe(k.gt1week); wkCard.style.color = '#ef4444'; }
}

let chartByRep;
function renderCharts(d){
  const byRep = d.uninvoicedByRep || { labels: [], data: [], fullLabels: [] };
  const ctx = document.getElementById('chartByRep');
  // Dynamic height so labels don't overlap
  if (ctx && ctx.parentNode){
    const h = Math.min(600, (byRep.labels.length * 28) + 60);
    ctx.parentNode.style.height = h + 'px';
    // Keep the Aging card at the same height for visual balance
    const aging = document.getElementById('agingCard');
    if (aging){ aging.style.height = h + 'px'; }
  }
  chartByRep && chartByRep.destroy();
  chartByRep = new Chart(ctx, {
    type: 'bar',
    data: { labels: byRep.labels, datasets: [{ label: 'Uninvoiced', data: byRep.data, backgroundColor: '#3b82f6' }] },
    options: {
      indexAxis: 'y',
      responsive:true,
      maintainAspectRatio:false,
      layout:{ padding: 8 },
      plugins:{
        legend:{ display:false },
        tooltip:{
          callbacks:{
            title: (items)=>{
              const idx = items && items[0] ? items[0].dataIndex : 0;
              const full = (byRep.fullLabels && byRep.fullLabels[idx]) || byRep.labels[idx] || '';
              return full;
            }
          }
        }
      },
      scales:{
        x:{ beginAtZero:true },
        y:{
          ticks:{
            autoSkip:false,
            callback: (val, idx)=>{
              const s = byRep.labels[idx] || '';
              return s.length > 18 ? (s.slice(0,17) + '…') : s;
            }
          }
        }
      }
    }
  });
}

async function ensureClient(){
  try { await (window.supabaseReady || Promise.resolve()); } catch(_) {}
  const sb = (window.supabaseSearch && window.supabaseSearch.client) || window.supabase;
  if (!sb) throw new Error('Supabase client not available');
  return sb;
}

function applyFilters(rows){
  const f = state.filters;
  // Bring back backordered: do not exclude it anymore; keep excluding credited/closed only
  const excludedStatuses = ['credited','closed'];
  return rows.filter(r=>{
    // Client-side removed rows shouldn't appear anywhere (table/KPIs/charts)
    if (isHidden(r.order_no)) return false;
    // Location filter: simple case-insensitive equality; no special handling
    const locFilter = f.location || 'All';
    if (locFilter !== 'All'){
      const locNorm = (r.location||'').trim().toLowerCase();
      const selNorm = String(locFilter).trim().toLowerCase();
      if (locNorm !== selNorm) return false;
    }
    // Exclude statuses per business rules (backorder allowed)
    const st = String(r.status||'').trim().toLowerCase();
    if (excludedStatuses.some(k => st.includes(k))) return false;
    // Search filter: order_no, customer, order_date (YYYY-MM-DD)
    const q = (f.search||'').trim().toLowerCase();
    if (q){
      const inOrder = String(r.order_no||'').toLowerCase().includes(q);
      const inCustomer = String(r.customer||'').toLowerCase().includes(q);
      const inDate = r.order_date ? String(fmtDate(r.order_date)).toLowerCase().includes(q) : false;
      if (!inOrder && !inCustomer && !inDate) return false;
    }
    return true;
  });
}
function computeKpisAndCharts(rows){
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate()-1);
  const lastWeekStart = new Date(); lastWeekStart.setDate(today.getDate()-6);
  // Non-invoiced: BOTH invoice_no and invoice_date are blank (invoice_status may be 'not available' or empty and should still appear)
  const isUninv = (r)=>{
    const noInvNo = isEmptyToken(r.invoice_no);
    const noInvDate = !r.invoice_date; // parseISODate already normalizes bad tokens to null
    return noInvNo && noInvDate;
  };
  // KPI counts: D+1..D+4 for non-invoiced only
  const nowStr = fmtDate(today);
  const daysSince = (d)=>{
    if (!d) return null;
    const base = new Date(fmtDate(d));
    const now = new Date(nowStr);
    return Math.floor((now - base)/86400000);
  };
  let d1=0,d2=0,d3=0,d4=0;
  rows.forEach(r=>{
    if (!r.order_date) return;
    if (!isUninv(r)) return;
    const dd = daysSince(r.order_date);
    if (dd === 1) d1++;
    else if (dd === 2) d2++;
    else if (dd === 3) d3++;
    else if (dd === 4) d4++;
  });

  // Same day invoiced % (D+0)
  // Same-day invoiced % no longer displayed; keep computed if needed later
  const sameDay = rows.filter(r=> r.invoice_date && r.order_date && fmtDate(r.invoice_date) === fmtDate(r.order_date));
  const invoiced = rows.filter(r=> r.invoice_date);
  const pctSameDay = invoiced.length ? (sameDay.length / invoiced.length) * 100 : 0;

  // Uninvoiced > 1 week
  const gt1week = rows.filter(r=>{
    if (!isUninv(r) || !r.order_date) return false;
    const dd = daysSince(r.order_date);
    return dd != null && dd > 7;
  }).length;

  // Average time to invoice (days)
  const diffs = rows.filter(r=> r.invoice_date && r.order_date).map(r=> Math.max(0, diffDays(new Date(r.invoice_date), new Date(r.order_date))));
  const avgTimeDays = diffs.length ? (diffs.reduce((a,b)=>a+b,0) / diffs.length) : 0;

  // Weekly trend chart removed; we only keep KPI numbers and the by-rep chart

  // Uninvoiced by rep (current filter)
  const byRepMap = new Map();
  rows.filter(r=> isUninv(r)).forEach(r=>{
    const dd = daysSince(r.order_date);
    if (dd == null || dd < 2) return; // keep alinhado: ignora D+0 e D+1
    const rep = (r.sales_rep || '—').trim();
    byRepMap.set(rep, (byRepMap.get(rep)||0)+1);
  });
  // Sort reps by count desc and improve readability; cap to top 30 to avoid huge charts
  const sorted = Array.from(byRepMap.entries()).sort((a,b)=> b[1]-a[1]);
  const capped = sorted.slice(0, 30);
  const labels = capped.map(e=> e[0]);
  const data = capped.map(e=> e[1]);

  return {
    kpis: { pctSameDay, d1, d2, d3, d4, gt1week, avgTimeDays },
    charts: { uninvoicedByRep: { labels, data, fullLabels: labels } }
  };
}

async function fetchRows(){
  if (Array.isArray(__inv_rows_cache) && __inv_rows_cache.length){
    try { console.debug('[INV] using cached rows=', __inv_rows_cache.length); } catch(_){ }
    return __inv_rows_cache;
  }
  const sb = await ensureClient();
  // Fetch entire range in pages to avoid truncation
  const fields = 'order_no, order_date, customer, invoice_no, invoice_date, invoice_status, sales_rep, status, location, total_total, report_date';
  // Use a conservative page size to respect PostgREST/Supabase limits and avoid skipping
  const pageSize = 1000;
  let from = 0;
  const all = [];
  while (true){
    let q = sb.from('invoicing_monitor')
      .select(fields)
      .order('report_date', { ascending: false })
      .order('order_date', { ascending: false })
      .range(from, from + pageSize - 1);
  // No date filter here: we fetch the entire table and compute the range locally
    const { data, error } = await q;
    if (error){ console.error('load invoicing data error (page):', error); break; }
    const batch = (data||[]).map(r=>({
      ...r,
      order_date: parseISODate(r.order_date),
      invoice_date: parseISODate(r.invoice_date),
      report_date: parseISODate(r.report_date),
    }));
    all.push(...batch);
    if (!data || data.length === 0) break; // no more rows
    // Advance by the actual number returned to avoid skipping when the server enforces a stricter cap
    from += data.length;
    // Safety: prevent runaway
    if (from > 1_000_000) break;
  }
  __inv_rows_cache = all;
  try { console.debug('[INV] cache ready, rows=', __inv_rows_cache.length); } catch(_){ }
  return __inv_rows_cache;
}

async function load(){
  // 1) Fetch all rows (paged) and then compute ranges locally
  const rows = await fetchRows();
  cache.rowsAll = rows;
  // Deduplicate by latest snapshot per order_no (based on report_date). If same report_date, prefer row with invoice info.
  const latest = new Map();
  for (const r of rows){
    const key = String(r.order_no||'').trim();
    if (!key) continue;
    const repTs = r.report_date ? new Date(fmtDate(r.report_date)).getTime() : -1;
    const cur = latest.get(key);
    if (!cur){ latest.set(key, r); continue; }
    const curTs = cur.report_date ? new Date(fmtDate(cur.report_date)).getTime() : -1;
    if (repTs > curTs){ latest.set(key, r); continue; }
    if (repTs === curTs){
      const curInvoiced = (!!cur.invoice_no && String(cur.invoice_no).trim()) || !!cur.invoice_date;
      const rInvoiced = (!!r.invoice_no && String(r.invoice_no).trim()) || !!r.invoice_date;
      if (rInvoiced && !curInvoiced){ latest.set(key, r); }
    }
  }
  cache.rows = Array.from(latest.values());
  // compute ranges from loaded rows
  const orderDates = cache.rowsAll.map(r=> r.order_date).filter(Boolean).map(d=> new Date(fmtDate(d)).getTime());
  const reportDates = cache.rowsAll.map(r=> r.report_date).filter(Boolean).map(d=> new Date(fmtDate(d)).getTime());
  if (orderDates.length){
    const minO = new Date(Math.min(...orderDates));
    const maxO = new Date(Math.max(...orderDates));
    state.dataRange.start = fmtDate(minO);
    state.dataRange.end = fmtDate(maxO);
  } else { state.dataRange.start = state.dataRange.end = null; }
  if (reportDates.length){
    const minR = new Date(Math.min(...reportDates));
    const maxR = new Date(Math.max(...reportDates));
    state.dataRange.reportStart = fmtDate(minR);
    state.dataRange.reportEnd = fmtDate(maxR);
    state.dataRange.lastReport = state.dataRange.reportEnd;
  } else { state.dataRange.reportStart = state.dataRange.reportEnd = state.dataRange.lastReport = null; }
  let filtered = applyFilters(rows);
  // Fallback: if nothing matches and location is too restrictive, switch to All automatically
  if (filtered.length === 0 && state.filters.location !== 'All'){
    state.filters.location = 'All';
    const locSel = document.getElementById('location');
    if (locSel) locSel.value = 'All';
    filtered = applyFilters(rows);
  }
  const { kpis, charts } = computeKpisAndCharts(filtered);
  setKpis(kpis);
  renderCharts(charts);
  // Populate Sales Rep options near the table
  try {
  const reps = Array.from(new Set((cache.rows||[]).map(r=> (r.sales_rep||'').trim()).filter(Boolean))).sort((a,b)=> a.localeCompare(b));
    const sel = document.getElementById('repTable');
    if (sel){
      const current = sel.value;
      sel.innerHTML = '<option value="">All Reps</option>' + reps.map(r=>`<option>${r.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</option>`).join('');
      // Keep selection consistent with state.filters.rep or previous selection
      const desired = state.filters.rep || current || '';
      sel.value = desired;
    }
  } catch(_) {}
  // Populate Location options dynamically from loaded rows and keep current selection (default to 'All')
  try{
    const locSel = document.getElementById('location');
    if (locSel){
      const fromRows = Array.from(new Set((cache.rows||[]).map(r=> String(r.location||'').trim()).filter(Boolean)));
      const locations = fromRows.sort((a,b)=> a.localeCompare(b));
      const desired = state.filters.location || 'All';
      const options = ['All', ...locations];
      locSel.innerHTML = options.map(opt=>`<option${opt===desired ? ' selected' : ''}>${opt.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</option>`).join('');
      // Make sure the select reflects state and state reflects selection
      locSel.value = desired;
      state.filters.location = desired;
    }
  } catch(_) {}
  await loadTable();

  // Update badges: Range (min→max order_date) and Last report (max report_date) based on loaded data
  try{
    const minDate = state.dataRange.start || '—';
    const maxDate = state.dataRange.end || '—';
    const lastRep = state.dataRange.lastReport || '—';
    const rangeBadge = document.getElementById('invRangeBadge');
    const lastBadge = document.getElementById('invLastReportBadge');
    if (rangeBadge) rangeBadge.textContent = `Range: ${minDate} → ${maxDate}`;
    if (lastBadge) lastBadge.textContent = `Last report: ${lastRep}`;
  } catch (e){ /* noop */ }
}

async function loadTable(){
  const rows = applyFilters(cache.rows);
  // Non-invoiced helper for daysPending and highlight only
  const isUninv = (r)=>{
    const noNum = isEmptyToken(r.invoice_no);
    const noDate = !r.invoice_date; // parseISODate handles tokens
    return noNum && noDate;
  };
  // Base set: by default only non-invoiced; when toggled, include invoiced OK as well (no special invoice_status filtering)
  let base = rows.filter(r=> isUninv(r) || state.includeInvoiced);
  // Hide D+0 and D+1 from the table
  const nowStrTbl = fmtDate(new Date());
  const daysSinceTbl = (d)=>{
    if (!d) return null;
    const baseD = new Date(fmtDate(d));
    const nowD = new Date(nowStrTbl);
    return Math.floor((nowD - baseD)/86400000);
  };
  base = base.filter(r=>{
    const dd = daysSinceTbl(r.order_date);
    // For invoiced rows, only included when toggle is on; bucket filters apply only to non-invoiced
    if (!isUninv(r)) return !!state.includeInvoiced;
    if (dd == null) return false;
    if (state.bucket === 'All') return dd >= 1;
    if (state.bucket === 'D+1') return dd === 1;
    if (state.bucket === 'D+2') return dd === 2;
    if (state.bucket === 'D+3') return dd === 3;
    if (state.bucket === 'D+4') return dd === 4;
    if (state.bucket === '>1w') return dd > 7;
    return dd >= 1;
  });
  let items = base.map(r=>{
    const numKey = (()=>{ const m = String(r.order_no||'').match(/(\d+)/); return m ? parseInt(m[1],10) : -1; })();
    const nonInv = isUninv(r);
    const age = r.order_date ? diffDays(new Date(), new Date(r.order_date)) : 0;
    return {
      order: r.order_no,
      customer: r.customer,
      orderDate: fmtDate(r.order_date),
      invoiceDate: fmtDate(r.invoice_date),
      invoiceNo: (r.invoice_no && String(r.invoice_no).trim()) ? String(r.invoice_no).trim() : '—',
      invoiceStatus: (r.invoice_status && String(r.invoice_status).trim()) ? String(r.invoice_status).trim() : '—',
      daysPending: nonInv ? age : 'OK',
      _age: age,
      _nonInv: nonInv,
      rep: r.sales_rep||'—',
      status: r.status||'—',
      location: r.location || '—',
      total_total: r.total_total,
      _repKey: r.report_date ? fmtDate(r.report_date) : (fmtDate(r.order_date) || ''),
      _ordNumKey: numKey
    };
  });
  // Apply table Sales Rep filter if set
  if (state.filters.rep){
    const repNorm = state.filters.rep.trim().toLowerCase();
    items = items.filter(it => String(it.rep||'').toLowerCase() === repNorm);
  }
  // Note: No D+ chips anymore; table shows all non-invoiced per filters.
  // Sort by most recent Order Date (desc) as primary; then Report Date (desc); then Order number (desc)
  items.sort((a,b)=>{
    // Primary: order date desc
    const aOrd = a.orderDate || '';
    const bOrd = b.orderDate || '';
    if (aOrd !== bOrd) return bOrd.localeCompare(aOrd);
    // Secondary: report date desc
    const aRep = a._repKey || '';
    const bRep = b._repKey || '';
    if (aRep !== bRep) return bRep.localeCompare(aRep);
    // Tertiary: higher order number first
    const n = (b._ordNumKey||-1) - (a._ordNumKey||-1);
    if (n !== 0) return n;
    // Tertiary: lexicographical order id desc
    return String(b.order||'').localeCompare(String(a.order||''));
  });
  // Pagination calc: max 5 pages visible, 50 rows per page
  const pageSize = state.pagination.pageSize;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  state.pagination.total = total; state.pagination.totalPages = totalPages;
  if (state.pagination.page > totalPages) state.pagination.page = totalPages;
  const start = (state.pagination.page - 1) * pageSize;
  const end = start + pageSize;
  const paged = items.slice(start, end);

  const tbody = document.querySelector('#uninvoicedTable tbody');
  tbody.innerHTML = '';
  if (paged.length === 0){
    const tr = document.createElement('tr');
    const msg = 'No orders match the current filters.';
    tr.innerHTML = `<td colspan="12" style="text-align:center; color:#6b7280;">${msg}</td>`;
    tbody.appendChild(tr);
  } else {
    const formatMoney = (n)=> (n==null || isNaN(n)) ? '—' : new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:2}).format(n);
    paged.forEach(r=>{
      const tr = document.createElement('tr');
  // Highlight rule: non-invoiced com D+1 ou mais -> amarelo; invoiced ficam em branco
  const warn = r._nonInv && r._age >= 1;
      if (warn) tr.classList.add('warn');
      const safe = (s)=> String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
      const removeBtn = `<button class="chip" data-remove="${safe(r.order)}" title="Remove from view" aria-label="Remove ${safe(r.order)}">×</button>`;
      tr.innerHTML = `<td>${r.order}</td><td>${r.customer}</td><td>${r.orderDate}</td><td>${r.invoiceDate}</td><td>${r.invoiceNo}</td><td>${r.invoiceStatus}</td><td class="num">${r.daysPending}</td><td>${r.rep}</td><td>${r.status}</td><td>${r.location}</td><td class="num">${formatMoney(r.total_total)}</td><td>${removeBtn}</td>`;
      tbody.appendChild(tr);
    });
    // Wire remove buttons
    tbody.querySelectorAll('button[data-remove]').forEach(btn=>{
      btn.addEventListener('click', (e)=>{
        const order = btn.getAttribute('data-remove');
        const modal = document.getElementById('invRemoveModal');
        const span = document.getElementById('invRemoveOrder');
        const confirmBtn = document.getElementById('invRemoveConfirm');
        if (span) span.textContent = order;
        if (modal){
          modal.classList.add('open');
          if (confirmBtn){
            // Remove previous listeners by cloning
            const cloned = confirmBtn.cloneNode(true);
            confirmBtn.parentNode.replaceChild(cloned, confirmBtn);
            cloned.addEventListener('click', ()=>{
              addHidden(order);
              modal.classList.remove('open');
              // Reload KPIs/charts/table to reflect removal
              load();
            });
          }
        }
      });
    });
  }

  // Render pagination controls (windowed, unlimited total pages)
  const pag = document.getElementById('uninvoicedPagination');
  if (pag){
    const btn = (label, disabled, onClick, active=false)=>{
      const b = document.createElement('button');
      b.textContent = label;
      b.className = 'chip' + (active? ' active' : '');
      if (disabled){ b.classList.add('disabled'); b.disabled = true; }
      b.addEventListener('click', (e)=>{ e.preventDefault(); onClick && onClick(); });
      return b;
    };
    pag.innerHTML = '';
    const cur = state.pagination.page;
     const windowSize = 3; // show only Prev, X / Y, Next
  let startPage = Math.max(1, cur - Math.floor(windowSize/2));
  let endPage = startPage + windowSize - 1;
  if (endPage > totalPages){ endPage = totalPages; startPage = Math.max(1, endPage - windowSize + 1); }

      // Render pagination controls (arrows + X / Y only)
      pag.appendChild(btn('Prev', cur<=1, ()=>{ state.pagination.page = Math.max(1, cur-1); loadTable(); }));
      const lab = document.createElement('span');
      lab.textContent = ` ${cur} / ${totalPages} `;
      lab.style.padding = '6px 10px';
      lab.style.color = '#334155';
      pag.appendChild(lab);
      pag.appendChild(btn('Next', cur>=totalPages, ()=>{ state.pagination.page = Math.min(totalPages, cur+1); loadTable(); }));
  }
}

function bind(){
  // (Removed D+ chips UI and logic)
  // No top date/status/customer/terms/rep filters anymore; only Location remains
  // Location select (default Main Warehouse)
  const locSel = document.getElementById('location');
  if (locSel){
    locSel.value = state.filters.location || 'All';
    locSel.addEventListener('change', ()=>{
      state.filters.location = locSel.value || 'All';
      state.pagination.page = 1;
      load();
    });
  }

  // Table Sales Rep dropdown (aligns with main rep filter)
  const repTable = document.getElementById('repTable');
  if (repTable){
    repTable.addEventListener('change', ()=>{
      const v = repTable.value || '';
      const repTop = document.getElementById('rep');
      if (repTop && repTop.value !== v) repTop.value = v;
      state.filters.rep = v;
      load();
    });
  }

  // (Removed period chips controls)

  // (Include invoiced toggle removed — we focus only on non-invoiced rows)
  // (Include excluded statuses toggle removed)
  const includeChk = document.getElementById('invIncludeInvoiced');
  if (includeChk){
    includeChk.checked = !!state.includeInvoiced;
    includeChk.addEventListener('change', ()=>{
      state.includeInvoiced = !!includeChk.checked;
      state.pagination.page = 1;
      loadTable();
    });
  }
  const resetBtn = document.getElementById('invResetHidden');
  if (resetBtn){
    resetBtn.addEventListener('click', ()=>{
      resetHidden();
      state.pagination.page = 1;
      load();
    });
  }
  const searchEl = document.getElementById('invSearch');
  if (searchEl){
    let t;
    searchEl.addEventListener('input', ()=>{
      clearTimeout(t);
      t = setTimeout(()=>{
        state.filters.search = searchEl.value || '';
        state.pagination.page = 1;
        loadTable();
      }, 200);
    });
  }
  // Aging chips bindings
  const bucketButtons = [
    { id: 'invBucketD1', val: 'D+1' },
    { id: 'invBucketD2', val: 'D+2' },
    { id: 'invBucketD3', val: 'D+3' },
    { id: 'invBucketD4', val: 'D+4' },
    { id: 'invBucketWk', val: '>1w' },
  ];
  const setActiveBucketUI = ()=>{
    bucketButtons.forEach(b=>{
      const el = document.getElementById(b.id);
      if (!el) return;
      if (state.bucket === b.val) el.classList.add('active');
      else el.classList.remove('active');
    });
  };
  bucketButtons.forEach(b=>{
    const el = document.getElementById(b.id);
    if (!el) return;
    el.addEventListener('click', ()=>{
      state.bucket = (state.bucket === b.val) ? 'All' : b.val; // toggle off to All
      state.pagination.page = 1;
      setActiveBucketUI();
      loadTable();
    });
  });
  setActiveBucketUI();
}

bind();
load();

// Expose a reload hook for modal to refresh dashboard after import
// (used by invoicing-monitor.html sendInvReport())
// eslint-disable-next-line no-undef
window.invMonReload = load;
