// Open Orders monitor — a focused board of what's OPEN right now:
//  · Sales Orders still being fulfilled (order_status AUTHORISED, not yet shipped)
//  · Stock Transfers in flight (IN TRANSIT / ORDERED; DRAFT optional)
//
// Reads cin7_mirror.sales_orders + stock_transfers CLIENT-SIDE with the anon key,
// exactly like invoicing-monitor.js — the tables are auto-synced from Cin7 hourly,
// so this page makes ZERO Cin7 API calls (no rate-limit risk).

const OO = {
  tab: 'so',
  filters: { warehouse: 'All', rep: '', stage: '', search: '', minAge: 2, includeDrafts: false },
  so: [], tr: [], loaded: false,
  pageSo: 1, pageBo: 1, pageTr: 1, pageSize: 50
};

const SO_STAGES = ['To pick', 'Picking', 'Picked', 'Packing', 'Shipping'];
// Business cutoff (operator): orders before this are stale/abandoned — not of interest.
const MIN_ORDER_DATE = '2025-08-01';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function daysSince(d) { if (!d) return null; const t = new Date(d); if (isNaN(t)) return null; return Math.floor((Date.now() - t.getTime()) / 86400000); }
function fmtDate(d) { if (!d) return '—'; const t = new Date(d); return isNaN(t) ? '—' : t.toISOString().slice(0, 10); }

async function ensureClient() {
  try { await (window.supabaseReady || Promise.resolve()); } catch (_) {}
  const sb = (window.supabaseSearch && window.supabaseSearch.client) || window.supabase;
  if (!sb) throw new Error('Supabase client not available');
  return sb;
}

// Fulfilment stage from Cin7's per-step statuses (mirrors the chase_list stage idea).
function soStage(r) {
  const up = s => String(s || '').toUpperCase();
  const ship = up(r.shipping_status), pack = up(r.packing_status), pick = up(r.picking_status);
  if (ship === 'SHIPPING' || ship === 'PARTIALLY SHIPPED') return 'Shipping';
  if (pack === 'PACKING' || pack === 'PACKED' || pack === 'PARTIALLY PACKED') return 'Packing';
  if (pick === 'PICKED') return 'Picked';
  if (pick === 'PICKING' || pick === 'PARTIALLY PICKED') return 'Picking';
  return 'To pick';
}

async function fetchSO(sb) {
  const fields = 'order_number,customer,sales_rep,location_name,order_status,status,shipping_status,picking_status,packing_status,order_date';
  const out = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await sb.schema('cin7_mirror').from('sales_orders').select(fields)
      .eq('order_status', 'AUTHORISED')
      .neq('shipping_status', 'SHIPPED')
      .not('status', 'in', '(VOIDED,CANCELLED,CREDITED,DRAFT)')
      .gte('order_date', MIN_ORDER_DATE)
      .order('order_date', { ascending: true })
      .range(from, from + size - 1);
    if (error) { console.error('[open-orders] SO error', error); break; }
    (data || []).forEach(r => out.push({
      order: r.order_number, customer: r.customer || '—', rep: r.sales_rep || '—',
      warehouse: r.location_name || '—', stage: soStage(r), status: r.status || '—',
      orderDate: r.order_date, age: daysSince(r.order_date)
    }));
    if (!data || data.length < size) break;
    from += data.length; if (from > 200000) break;
  }
  return out;
}

async function fetchTR(sb) {
  const statuses = OO.filters.includeDrafts ? ['IN TRANSIT', 'ORDERED', 'DRAFT'] : ['IN TRANSIT', 'ORDERED'];
  const out = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await sb.schema('cin7_mirror').from('stock_transfers')
      .select('number,from_location,to_location,status,departure_date,total_qty,line_count,reference,cin7_updated')
      .in('status', statuses)
      .order('departure_date', { ascending: false, nullsFirst: false })
      .range(from, from + size - 1);
    if (error) { console.error('[open-orders] TR error', error); break; }
    (data || []).forEach(r => out.push({
      number: r.number, from: r.from_location || '—', to: r.to_location || '—', status: r.status,
      departure: r.departure_date, qty: r.total_qty, lines: r.line_count, reference: r.reference,
      age: daysSince(r.departure_date || r.cin7_updated)
    }));
    if (!data || data.length < size) break;
    from += data.length; if (from > 200000) break;
  }
  // active first (IN TRANSIT, ORDERED), then drafts; each oldest-first by age
  const rank = { 'IN TRANSIT': 0, 'ORDERED': 1, 'DRAFT': 2 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]) || ((b.age || 0) - (a.age || 0)));
  return out;
}

// ── filters ──
function isBackorder(r) { return String(r.status).toUpperCase() === 'BACKORDERED'; }
function soBaseFiltered() {
  const f = OO.filters, q = (f.search || '').trim().toLowerCase();
  return OO.so.filter(r => {
    if (f.warehouse !== 'All' && String(r.warehouse).toLowerCase() !== f.warehouse.toLowerCase()) return false;
    if (f.rep && String(r.rep).toLowerCase() !== f.rep.toLowerCase()) return false;
    if (f.stage && r.stage !== f.stage) return false;
    if (f.minAge > 0 && (r.age == null || r.age < f.minAge)) return false;
    if (q && !(String(r.order).toLowerCase().includes(q) || String(r.customer).toLowerCase().includes(q))) return false;
    return true;
  });
}
function activeSO() { return soBaseFiltered().filter(r => !isBackorder(r)); }
function backorderSO() { return soBaseFiltered().filter(isBackorder); }
function filteredTR() {
  // Age filter is a SO concept ("stuck orders"); transfers show all active regardless.
  const f = OO.filters, q = (f.search || '').trim().toLowerCase();
  return OO.tr.filter(r => {
    if (f.warehouse !== 'All') { const w = f.warehouse.toLowerCase(); if (String(r.from).toLowerCase() !== w && String(r.to).toLowerCase() !== w) return false; }
    if (q && !(String(r.number).toLowerCase().includes(q) || String(r.from).toLowerCase().includes(q) || String(r.to).toLowerCase().includes(q))) return false;
    return true;
  });
}

// ── render ──
function ageBadge(age) {
  if (age == null) return '<span class="oo-age">—</span>';
  const cls = age > 7 ? ' bad' : (age > 3 ? ' warn' : '');
  return `<span class="oo-age${cls}">${age}d</span>`;
}
function stageChip(stage) { return `<span class="oo-stage s-${stage.replace(/\s+/g, '').toLowerCase()}">${esc(stage)}</span>`; }

function renderPager(id, total, page, onGo) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = '';
  const ps = OO.pageSize, pages = Math.max(1, Math.ceil(total / ps));
  if (total <= ps) return;
  const mk = (label, disabled, go) => { const b = document.createElement('button'); b.textContent = label; b.disabled = disabled; if (!disabled) b.addEventListener('click', go); return b; };
  const start = (page - 1) * ps + 1, end = Math.min(total, page * ps);
  el.appendChild(mk('‹ Prev', page <= 1, () => onGo(page - 1)));
  const info = document.createElement('span'); info.className = 'oo-pageinfo'; info.textContent = `${start}–${end} of ${total}`;
  el.appendChild(info);
  el.appendChild(mk('Next ›', page >= pages, () => onGo(page + 1)));
}

function soRowHtml(r) {
  const warn = r.age != null && r.age > 3;
  return `<tr class="${warn ? 'warn' : ''}">` +
    `<td class="oo-mono">${esc(r.order)}</td>` +
    `<td>${esc(r.customer)}</td>` +
    `<td>${esc(r.rep)}</td>` +
    `<td>${esc(r.warehouse)}</td>` +
    `<td>${stageChip(r.stage)}</td>` +
    `<td>${esc(r.status)}</td>` +
    `<td class="num">${ageBadge(r.age)}</td>` +
    `<td>${fmtDate(r.orderDate)}</td></tr>`;
}
function renderSoTable(rows, tableId, pagerId, pageKey, empty) {
  const total = rows.length, ps = OO.pageSize;
  if (OO[pageKey] > Math.ceil(total / ps)) OO[pageKey] = 1;
  const paged = rows.slice((OO[pageKey] - 1) * ps, OO[pageKey] * ps);
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!total) { tbody.innerHTML = `<tr><td colspan="8" class="oo-empty">${empty}</td></tr>`; renderPager(pagerId, 0, 1, () => {}); return; }
  tbody.innerHTML = paged.map(soRowHtml).join('');
  renderPager(pagerId, total, OO[pageKey], p => { OO[pageKey] = p; renderSoTable(rows, tableId, pagerId, pageKey, empty); });
}
function renderSO() { renderSoTable(activeSO(), 'ooSoTable', 'ooSoPager', 'pageSo', 'No orders in active fulfilment match the filters.'); }
function renderBO() { renderSoTable(backorderSO(), 'ooBoTable', 'ooBoPager', 'pageBo', 'No backorders match the filters.'); }
function renderTR() {
  const rows = filteredTR();
  const total = rows.length, ps = OO.pageSize;
  if (OO.pageTr > Math.ceil(total / ps)) OO.pageTr = 1;
  const paged = rows.slice((OO.pageTr - 1) * ps, OO.pageTr * ps);
  const tbody = document.querySelector('#ooTrTable tbody');
  if (!total) { tbody.innerHTML = `<tr><td colspan="6" class="oo-empty">No open transfers match the filters.</td></tr>`; renderPager('ooTrPager', 0, 1, () => {}); return; }
  tbody.innerHTML = paged.map(r => {
    const st = r.status === 'IN TRANSIT' ? 'transit' : (r.status === 'ORDERED' ? 'ordered' : 'draft');
    return `<tr>` +
      `<td class="oo-mono">${esc(r.number)}</td>` +
      `<td>${esc(r.from)} <span class="oo-arrow">→</span> ${esc(r.to)}</td>` +
      `<td><span class="oo-trstatus ${st}">${esc(r.status)}</span></td>` +
      `<td>${fmtDate(r.departure)}</td>` +
      `<td class="num">${ageBadge(r.age)}</td>` +
      `<td>${r.qty != null ? esc(r.qty) : (r.lines != null ? esc(r.lines) + ' lines' : '—')}</td></tr>`;
  }).join('');
  renderPager('ooTrPager', total, OO.pageTr, p => { OO.pageTr = p; renderTR(); });
}

function renderKpis() {
  const act = activeSO(), bo = backorderSO(), tr = filteredTR();
  const oldest = act.reduce((m, r) => Math.max(m, r.age || 0), 0);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('ooKpiSo', act.length);
  set('ooKpiBo', bo.length);
  set('ooKpiTr', tr.length);
  set('ooKpiOldest', oldest ? oldest + 'd' : '—');
  const tallies = document.getElementById('ooCounts');
  if (tallies) tallies.textContent = `${OO.so.length} open orders · ${OO.tr.length} open transfers · since ${MIN_ORDER_DATE}`;
}

function renderAll() { renderKpis(); renderSO(); renderBO(); renderTR(); }

function switchTab(tab) {
  OO.tab = tab;
  [['ooTabSo', 'so'], ['ooTabBo', 'bo'], ['ooTabTr', 'tr']].forEach(([id, t]) => document.getElementById(id).classList.toggle('active', tab === t));
  document.getElementById('ooPanelSo').style.display = tab === 'so' ? '' : 'none';
  document.getElementById('ooPanelBo').style.display = tab === 'bo' ? '' : 'none';
  document.getElementById('ooPanelTr').style.display = tab === 'tr' ? '' : 'none';
  // warehouse/rep/stage/age filters apply to both SO tabs; transfers have their own row
  document.getElementById('ooSoFilters').style.display = (tab === 'so' || tab === 'bo') ? '' : 'none';
  document.getElementById('ooTrFilters').style.display = tab === 'tr' ? '' : 'none';
}

function fillSelect(id, values, allLabel) {
  const sel = document.getElementById(id); if (!sel) return;
  const cur = sel.value;
  const opts = [`<option value="">${allLabel}</option>`].concat(values.map(v => `<option>${esc(v)}</option>`));
  sel.innerHTML = opts.join('');
  if (cur) sel.value = cur;
}

function populateFilterOptions() {
  const warehouses = Array.from(new Set([].concat(
    OO.so.map(r => r.warehouse), OO.tr.map(r => r.from), OO.tr.map(r => r.to)
  ).filter(w => w && w !== '—'))).sort();
  const whSel = document.getElementById('ooWarehouse');
  if (whSel) { const cur = whSel.value || 'All'; whSel.innerHTML = ['All'].concat(warehouses).map(w => `<option>${esc(w)}</option>`).join(''); whSel.value = cur; }
  const reps = Array.from(new Set(OO.so.map(r => r.rep).filter(x => x && x !== '—'))).sort();
  fillSelect('ooRep', reps, 'All reps');
  fillSelect('ooStage', SO_STAGES, 'All stages');
}

async function loadData() {
  const sb = await ensureClient();
  const [so, tr] = await Promise.all([fetchSO(sb), fetchTR(sb)]);
  OO.so = so; OO.tr = tr; OO.loaded = true;
  populateFilterOptions();
  renderAll();
  const upd = document.getElementById('ooUpdated');
  if (upd) upd.textContent = 'Snapshot read ' + new Date().toLocaleTimeString();
}

function reRender() { OO.pageSo = 1; OO.pageBo = 1; OO.pageTr = 1; renderAll(); }

function bind() {
  document.getElementById('ooTabSo').addEventListener('click', () => switchTab('so'));
  document.getElementById('ooTabBo').addEventListener('click', () => switchTab('bo'));
  document.getElementById('ooTabTr').addEventListener('click', () => switchTab('tr'));
  const whSel = document.getElementById('ooWarehouse');
  if (whSel) whSel.addEventListener('change', () => { OO.filters.warehouse = whSel.value || 'All'; reRender(); });
  const repSel = document.getElementById('ooRep');
  if (repSel) repSel.addEventListener('change', () => { OO.filters.rep = repSel.value || ''; reRender(); });
  const stSel = document.getElementById('ooStage');
  if (stSel) stSel.addEventListener('change', () => { OO.filters.stage = stSel.value || ''; reRender(); });
  const searchEl = document.getElementById('ooSearch');
  if (searchEl) { let t; searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { OO.filters.search = searchEl.value || ''; reRender(); }, 180); }); }
  // age chips
  document.querySelectorAll('.oo-agechip').forEach(chip => {
    chip.addEventListener('click', () => {
      OO.filters.minAge = Number(chip.getAttribute('data-age')) || 0;
      document.querySelectorAll('.oo-agechip').forEach(c => c.classList.toggle('active', c === chip));
      reRender();
    });
  });
  const draftChk = document.getElementById('ooIncludeDrafts');
  if (draftChk) draftChk.addEventListener('change', async () => {
    OO.filters.includeDrafts = !!draftChk.checked;
    const sb = await ensureClient(); OO.tr = await fetchTR(sb); populateFilterOptions(); renderAll();
  });
  const refreshBtn = document.getElementById('ooRefresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadData());
}

function init() {
  bind();
  switchTab('so');
  const def = document.querySelector('.oo-agechip[data-age="2"]'); if (def) def.classList.add('active');   // default: open > 2 days
  loadData().catch(e => { console.error('[open-orders] load failed', e); const t = document.querySelector('#ooSoTable tbody'); if (t) t.innerHTML = `<tr><td colspan="7" class="oo-empty">Could not load data: ${esc(e.message)}</td></tr>`; });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
