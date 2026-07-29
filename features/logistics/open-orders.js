// Open Orders monitor — a focused board of what's OPEN right now:
//  · Sales Orders still being fulfilled (order_status AUTHORISED, not yet shipped)
//  · Stock Transfers in flight (IN TRANSIT / ORDERED; DRAFT optional)
//
// Reads cin7_mirror.sales_orders + stock_transfers CLIENT-SIDE with the anon key,
// exactly like invoicing-monitor.js — the tables are auto-synced from Cin7 hourly,
// so this page makes ZERO Cin7 API calls (no rate-limit risk).

const OO = {
  tab: 'so',
  filters: { warehouse: 'All', rep: '', stage: '', invoice: '', search: '', minAge: 2, includeDrafts: false },
  so: [], tr: [], notes: {}, loaded: false, _noteOrder: null,
  pageSo: 1, pageBo: 1, pageTr: 1, pageSize: 50,
  _soLines: {}, _trLines: {}, _stock: {}   // per-order / per-transfer / per-SKU caches (expand-row)
};

const SO_STAGES = ['To pick', 'Picking', 'Picked', 'Packing', 'Shipping'];
// Business cutoff (operator): orders before this are stale/abandoned — not of interest.
const MIN_ORDER_DATE = '2025-08-01';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function daysSince(d) { if (!d) return null; const t = new Date(d); if (isNaN(t)) return null; return Math.floor((Date.now() - t.getTime()) / 86400000); }
function fmtDate(d) { if (!d) return '—'; const t = new Date(d); if (isNaN(t)) return '—'; const p = n => String(n).padStart(2, '0'); return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`; }

// Only monitor the real warehouses: Main Warehouse + the city-named ones. Drop the
// junk/virtual locations Cin7 carries — Project warehouses, "Ghost:" write-off
// destinations, Faulty, and bug/empty "location" names.
function isRealWarehouse(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return false;
  return !/project|ghost|faulty|location/i.test(n);
}
// A location sometimes comes bin-qualified ("Main Warehouse: MA-A-04-L2") — that's
// a data bug for our purposes; collapse it to the base warehouse name.
function normWarehouse(name) { const n = String(name == null ? '' : name).trim(); return n.includes(':') ? n.split(':')[0].trim() : n; }

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
  const fields = 'order_number,customer,sales_rep,location_name,order_status,status,shipping_status,picking_status,packing_status,invoice_status,order_date';
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
      warehouse: normWarehouse(r.location_name) || '—', stage: soStage(r), status: r.status || '—',
      invoiceStatus: r.invoice_status || '', orderDate: r.order_date, age: daysSince(r.order_date),
      ship: r.shipping_status || '', pick: r.picking_status || '', pack: r.packing_status || ''
    }));
    if (!data || data.length < size) break;
    from += data.length; if (from > 200000) break;
  }
  return out.filter(r => isRealWarehouse(r.warehouse));
}

async function fetchTR(sb) {
  const statuses = OO.filters.includeDrafts ? ['IN TRANSIT', 'ORDERED', 'DRAFT'] : ['IN TRANSIT', 'ORDERED'];
  const out = []; let from = 0; const size = 1000;
  while (true) {
    const { data, error } = await sb.schema('cin7_mirror').from('stock_transfers')
      .select('task_id,number,from_location,to_location,status,departure_date,total_qty,line_count,reference,cin7_updated')
      .in('status', statuses)
      .order('departure_date', { ascending: false, nullsFirst: false })
      .range(from, from + size - 1);
    if (error) { console.error('[open-orders] TR error', error); break; }
    (data || []).forEach(r => out.push({
      taskId: r.task_id, number: r.number, from: normWarehouse(r.from_location) || '—', to: normWarehouse(r.to_location) || '—', status: r.status,
      departure: r.departure_date, qty: r.total_qty, lines: r.line_count, reference: r.reference,
      age: daysSince(r.departure_date || r.cin7_updated)
    }));
    if (!data || data.length < size) break;
    from += data.length; if (from > 200000) break;
  }
  // drop transfers touching a junk location (Ghost / Project / Faulty write-offs)
  const real = out.filter(r => isRealWarehouse(r.from) && isRealWarehouse(r.to));
  // active first (IN TRANSIT, ORDERED), then drafts; each oldest-first by age
  const rank = { 'IN TRANSIT': 0, 'ORDERED': 1, 'DRAFT': 2 };
  real.sort((a, b) => (rank[a.status] - rank[b.status]) || ((b.age || 0) - (a.age || 0)));
  return real;
}

// ── filters ──
function isBackorder(r) { return String(r.status).toUpperCase() === 'BACKORDERED'; }
function soBaseFiltered() {
  const f = OO.filters, q = (f.search || '').trim().toLowerCase();
  return OO.so.filter(r => {
    if (f.warehouse !== 'All' && String(r.warehouse).toLowerCase() !== f.warehouse.toLowerCase()) return false;
    if (f.rep && String(r.rep).toLowerCase() !== f.rep.toLowerCase()) return false;
    if (f.stage && r.stage !== f.stage) return false;
    if (f.invoice && invoiceKind(r.invoiceStatus) !== f.invoice) return false;
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
// Invoice status, simplified into buckets so "not invoiced" is obvious at a glance
// (Cin7 mixes NOT INVOICED / PARTIALLY INVOICED / PARTIALLY INVOICED / CREDITED / …).
function invoiceKind(s) {
  const u = String(s || '').toUpperCase();
  if (!u || u === 'NOT AVAILABLE') return 'na';
  if (u.includes('NOT')) return 'not';
  if (u.includes('PARTIAL')) return 'partial';
  if (u.includes('CREDIT')) return 'credited';
  if (u.includes('INVOICED')) return 'invoiced';
  return 'other';
}
function invoiceBadge(s) {
  const k = invoiceKind(s);
  const label = { not: 'Not invoiced', partial: 'Partial', invoiced: 'Invoiced', credited: 'Credited', na: '—', other: s };
  return `<span class="oo-inv ${k}">${esc(label[k] || s || '—')}</span>`;
}

// ── Cin7-style fulfilment strip: Sales order · Pick · Pack · Ship · Invoice ──
// green = done, orange = pending/partial, grey = not applicable. Replaces the
// Stage/Status/Invoiced text columns so you can read at a glance WHERE an order
// is stuck (e.g. picked + invoiced but not packed/shipped). Hover for the value.
const OO_SVG = 'viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const OO_ICONS = {
  order: `<svg ${OO_SVG}><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>`,
  pick: `<svg ${OO_SVG}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M9 14l2 2 4-4"></path></svg>`,
  pack: `<svg ${OO_SVG}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
  ship: `<svg ${OO_SVG}><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`,
  invoice: `<svg ${OO_SVG}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`
};
const FULFIL_STEPS = [['order', 'Sales order'], ['pick', 'Pick'], ['pack', 'Pack'], ['ship', 'Ship'], ['invoice', 'Invoice']];
function stepState(value) {
  const u = String(value || '').toUpperCase().trim();
  if (!u || u === 'NOT AVAILABLE') return 'na';
  if (/^NOT /.test(u) || u.includes('PARTIAL') || /(PICKING|PACKING|SHIPPING)/.test(u)) return 'pend';
  if (/(PICKED|PACKED|SHIPPED|INVOICED|FULFILLED|COMPLETED)$/.test(u)) return 'done';
  return 'pend';
}
function fulfilStrip(r) {
  const vals = { order: 'AUTHORISED', pick: r.pick, pack: r.pack, ship: r.ship, invoice: r.invoiceStatus };
  const cells = FULFIL_STEPS.map(([key, label]) => {
    const st = key === 'order' ? 'done' : stepState(vals[key]);
    const val = key === 'order' ? 'Authorised' : (vals[key] || '—');
    return `<span class="oo-ic ${st}" title="${esc(label)}: ${esc(val)}">${OO_ICONS[key]}</span>`;
  });
  return `<div class="oo-icons">${cells.join('')}</div>`;
}

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

function noteCell(order) {
  const n = OO.notes[order];
  let badge = '';
  if (n) {
    if (n.resolved) badge = '<span class="oo-note-badge done" title="Resolved">✓</span>';
    else if ((n.note && n.note.trim()) || n.contacted_at) badge = '<span class="oo-note-badge has" title="Has a follow-up note">📝</span>';
  }
  return `<td class="oo-actioncell">${badge}<button class="oo-notebtn" data-order="${esc(order)}" title="Add / edit follow-up">✎</button></td>`;
}
function soRowHtml(r) {
  const warn = r.age != null && r.age > 3;
  const n = OO.notes[r.order];
  return `<tr class="oo-clickable ${warn ? 'warn' : ''}${n && n.resolved ? ' resolved' : ''}" data-kind="so" data-key="${esc(r.order)}">` +
    `<td class="oo-mono"><span class="oo-caret">▸</span>${esc(r.order)}</td>` +
    `<td>${esc(r.customer)}</td>` +
    `<td>${esc(r.rep)}</td>` +
    `<td>${esc(r.warehouse)}</td>` +
    `<td class="oo-fulfil">${fulfilStrip(r)}</td>` +
    `<td>${invoiceBadge(r.invoiceStatus)}</td>` +
    `<td class="num">${ageBadge(r.age)}</td>` +
    `<td>${fmtDate(r.orderDate)}</td>` +
    noteCell(r.order) + `</tr>`;
}
function renderSoTable(rows, tableId, pagerId, pageKey, empty) {
  const total = rows.length, ps = OO.pageSize;
  if (OO[pageKey] > Math.ceil(total / ps)) OO[pageKey] = 1;
  const paged = rows.slice((OO[pageKey] - 1) * ps, OO[pageKey] * ps);
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!total) { tbody.innerHTML = `<tr><td colspan="9" class="oo-empty">${empty}</td></tr>`; renderPager(pagerId, 0, 1, () => {}); return; }
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
    return `<tr class="oo-clickable" data-kind="tr" data-key="${esc(r.number)}">` +
      `<td class="oo-mono"><span class="oo-caret">▸</span>${esc(r.number)}</td>` +
      `<td>${esc(r.from)} <span class="oo-arrow">→</span> ${esc(r.to)}</td>` +
      `<td><span class="oo-trstatus ${st}">${esc(r.status)}</span></td>` +
      `<td>${fmtDate(r.departure)}</td>` +
      `<td class="num">${ageBadge(r.age)}</td>` +
      `<td>${r.qty != null ? esc(r.qty) : (r.lines != null ? esc(r.lines) + ' lines' : '—')}</td></tr>`;
  }).join('');
  renderPager('ooTrPager', total, OO.pageTr, p => { OO.pageTr = p; renderTR(); });
}

// ── expand-row: line items + fulfilment breakdown ──
async function loadSoLines(order) {
  if (OO._soLines[order]) return OO._soLines[order];
  const sb = await ensureClient();
  const { data, error } = await sb.schema('cin7_mirror').from('sale_lines')
    .select('line_no,sku,product_name,quantity,price,total,backorder_quantity').eq('order_number', order).order('line_no');
  if (error) throw new Error(error.message);
  return (OO._soLines[order] = data || []);
}
async function loadTrLines(number, taskId) {
  if (OO._trLines[number]) return OO._trLines[number];
  if (!taskId) throw new Error('transfer id unavailable');
  const r = await fetch('/api/open-orders/transfer-lines?taskId=' + encodeURIComponent(taskId));
  if (!r.ok) throw new Error(r.status === 404 ? 'lookup endpoint unavailable (restart server)' : ('lookup failed — HTTP ' + r.status));
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.error || 'lookup failed');
  return (OO._trLines[number] = j);
}
// Batch stock enrichment (locator + assembly flag + availability by warehouse) for
// a set of line SKUs, via the server (service key) — cached per SKU across expands.
async function loadLineStock(skus) {
  const need = [...new Set(skus.filter(s => s && !OO._stock[s]))];
  if (need.length) {
    const r = await fetch('/api/open-orders/line-stock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skus: need }) });
    if (r.ok) { const j = await r.json().catch(() => ({})); if (j.success && j.stock) Object.assign(OO._stock, j.stock); }
    need.forEach(s => { if (!OO._stock[s]) OO._stock[s] = null; });   // remember a miss, don't re-fetch
  }
  const out = {}; skus.forEach(s => { out[s] = OO._stock[s] || null; }); return out;
}
// Available-across-all-warehouses cell with a per-warehouse tooltip.
function availCell(st) {
  if (!st) return '<span class="oo-av na" title="stock not found">—</span>';
  const total = st.availTotal;
  const locs = (st.byLoc || []).filter(l => l.on_hand !== 0 || l.available !== 0);
  const tip = locs.length
    ? locs.map(l => `${l.location}: ${l.available} avail${l.on_hand !== l.available ? ` (${l.on_hand} on hand)` : ''}`).join('\n')
    : 'no stock in any warehouse';
  return `<span class="oo-av ${total > 0 ? 'ok' : 'no'}" title="${esc(tip)}">${esc(total)}</span>`;
}
// Locator cell — assembly/BOM products get a clickable chip to reveal components.
function locatorCell(st, sku) {
  if (!st) return '<span class="oo-loc">—</span>';
  if (st.isAssembly) return `<button type="button" class="oo-asm" data-asm="${esc(sku)}" title="Assembly / made-to-order — click to see the components to build it">🔧 ${esc(st.locator || 'Assembly')}</button>`;
  const loc = (st.locator && st.locator !== '0') ? st.locator : '—';
  return `<span class="oo-loc">${esc(loc)}</span>`;
}
// one fulfilment sub-status pill (Pick / Pack / Ship / Invoice)
// Order matters: "NOT PACKED" / "NOT SHIPPED" end in PACKED/SHIPPED, so the
// negative + partial cases must be tested BEFORE the "done" suffix match.
function subStatus(label, value) {
  const v = String(value || '—'), u = v.toUpperCase();
  let cls;
  if (/^NOT /.test(u) || u === '—' || u === 'NOT AVAILABLE') cls = 'none';
  else if (u.includes('PARTIAL') || /(PICKING|PACKING|SHIPPING|ORDERED)/.test(u)) cls = 'part';
  else if (/(PICKED|PACKED|SHIPPED|INVOICED|FULFILLED|COMPLETED)$/.test(u)) cls = 'done';
  else cls = 'part';
  return `<span class="oo-sub ${cls}"><b>${esc(label)}</b> ${esc(v)}</span>`;
}
function linesTable(rows, cols, rowCls) {
  if (!rows.length) return '<div class="oo-detail-empty">No line items recorded.</div>';
  const head = cols.map(c => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('');
  const body = rows.map(r => `<tr class="${rowCls ? rowCls(r) : ''}">` + cols.map(c => `<td class="${c.cls || ''}">${c.fmt(r)}</td>`).join('') + '</tr>').join('');
  return `<table class="oo-detail-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
async function renderSoDetail(order) {
  const r = OO.so.find(x => x.order === order) || {};
  const strip = `<div class="oo-substrip">${subStatus('Pick', r.pick)}${subStatus('Pack', r.pack)}${subStatus('Ship', r.ship)}${subStatus('Invoice', r.invoiceStatus)}</div>`;
  const lines = await loadSoLines(order);
  const stock = await loadLineStock(lines.map(l => l.sku));
  const anyBo = lines.some(l => l.backorder_quantity > 0);
  const cols = [
    { h: 'SKU', cls: 'oo-mono', fmt: l => esc(l.sku || '—') },
    { h: 'Product', fmt: l => esc(l.product_name || '—') },
    { h: 'Locator', fmt: l => locatorCell(stock[l.sku], l.sku) },
    { h: 'Qty', cls: 'num', fmt: l => esc(l.quantity != null ? l.quantity : '—') },
    { h: 'Avail · all WH', cls: 'num', fmt: l => availCell(stock[l.sku]) },
    { h: 'Backorder', cls: 'num', fmt: l => (l.backorder_quantity > 0) ? `<span class="oo-bo">${esc(l.backorder_quantity)}</span>` : '<span class="oo-ok">✓</span>' },
    { h: 'Price', cls: 'num', fmt: l => l.price != null ? '$' + Number(l.price).toFixed(2) : '—' },
    { h: 'Total', cls: 'num', fmt: l => l.total != null ? '$' + Number(l.total).toFixed(2) : '—' }
  ];
  const hint = anyBo ? '<div class="oo-detail-note">⚠ Highlighted lines are on <b>backorder</b> (awaiting stock). 🔧 = assembly/made-to-order — click the locator to see the components to build it.</div>' : '';
  return strip + hint + linesTable(lines, cols, l => l.backorder_quantity > 0 ? 'oo-bo-row' : '');
}
// Assembly line → toggle a nested panel with the components to build it.
async function toggleAsm(btn) {
  const tr = btn.closest('tr'); if (!tr) return;
  const nxt = tr.nextElementSibling;
  if (nxt && nxt.classList.contains('oo-comprow')) { nxt.remove(); btn.classList.remove('open'); return; }
  btn.classList.add('open');
  const crow = document.createElement('tr'); crow.className = 'oo-comprow';
  crow.innerHTML = `<td colspan="${tr.children.length}"><div class="oo-comp"><div class="oo-detail-load">Loading components…</div></div></td>`;
  tr.after(crow);
  const box = crow.querySelector('.oo-comp');
  try { box.innerHTML = await renderComponents(btn.getAttribute('data-asm')); }
  catch (e) { box.innerHTML = `<div class="oo-detail-err">Could not load components: ${esc(e.message)}</div>`; }
}
async function renderComponents(sku) {
  const r = await fetch('/api/open-orders/bom?sku=' + encodeURIComponent(sku));
  if (!r.ok) throw new Error(r.status === 404 ? 'lookup endpoint unavailable (restart server)' : ('HTTP ' + r.status));
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error(j.error || 'lookup failed');
  if (!j.found || !j.components || !j.components.length) return '<div class="oo-detail-empty">No recent build found in Cin7 — components unknown.</div>';
  const stock = await loadLineStock(j.components.map(c => c.sku));
  const fmtQ = q => (q == null ? '—' : (q % 1 === 0 ? String(q) : Number(q).toFixed(2)));
  const cols = [
    { h: 'Component', cls: 'oo-mono', fmt: c => esc(c.sku) },
    { h: 'Name', fmt: c => esc(c.name || '—') },
    { h: 'Locator', fmt: c => locatorCell(stock[c.sku], c.sku) },
    { h: 'Qty / unit', cls: 'num', fmt: c => esc(fmtQ(c.qtyPerUnit)) },
    { h: 'Avail · all WH', cls: 'num', fmt: c => availCell(stock[c.sku]) }
  ];
  const head = `<div class="oo-comp-head">🔧 Components to build <b>${esc(sku)}</b>${j.builtOn ? ` · recipe from build ${esc(j.assembly || '')} (${fmtDate(j.builtOn)})` : ''}</div>`;
  return head + linesTable(j.components, cols, c => (stock[c.sku] && stock[c.sku].availTotal <= 0) ? 'oo-bo-row' : '');
}
async function renderTrDetail(number) {
  const r = OO.tr.find(x => x.number === number) || {};
  const j = await loadTrLines(number, r.taskId);
  const m = j.meta || {};
  const strip = `<div class="oo-substrip">${subStatus('Status', m.status)}` +
    (m.completion ? subStatus('Completed', fmtDate(m.completion)) : '') +
    (m.reference ? `<span class="oo-sub none"><b>Ref</b> ${esc(m.reference)}</span>` : '') + '</div>';
  const tbl = linesTable(j.lines || [], [
    { h: 'SKU', cls: 'oo-mono', fmt: l => esc(l.sku || '—') },
    { h: 'Product', fmt: l => esc(l.name || '—') },
    { h: 'Transfer Qty', cls: 'num', fmt: l => esc(l.qty != null ? l.qty : '—') },
    { h: 'On hand', cls: 'num', fmt: l => esc(l.onHand != null ? l.onHand : '—') },
    { h: 'Available', cls: 'num', fmt: l => esc(l.available != null ? l.available : '—') }
  ]);
  return strip + tbl;
}
async function toggleExpand(tr) {
  const nxt = tr.nextElementSibling;
  if (nxt && nxt.classList.contains('oo-detailrow')) { nxt.remove(); tr.classList.remove('oo-expanded'); return; }
  tr.classList.add('oo-expanded');
  const kind = tr.getAttribute('data-kind'), key = tr.getAttribute('data-key');
  const colspan = tr.children.length;
  const drow = document.createElement('tr');
  drow.className = 'oo-detailrow';
  drow.innerHTML = `<td colspan="${colspan}"><div class="oo-detail"><div class="oo-detail-load">Loading items…</div></div></td>`;
  tr.after(drow);
  const box = drow.querySelector('.oo-detail');
  try { box.innerHTML = kind === 'tr' ? await renderTrDetail(key) : await renderSoDetail(key); }
  catch (e) { box.innerHTML = `<div class="oo-detail-err">Could not load items: ${esc(e.message)}</div>`; }
  // assembly lines reveal their components automatically — no extra click needed
  if (kind === 'so') box.querySelectorAll('.oo-asm').forEach(btn => toggleAsm(btn));
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

// ── CSV export (the currently-filtered list — e.g. one sales rep to email them) ──
function invoiceLabel(s) {
  const k = invoiceKind(s);
  return ({ not: 'Not invoiced', partial: 'Partially invoiced', invoiced: 'Invoiced', credited: 'Credited', na: '', other: s })[k] || s || '';
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function downloadCsv(filename, header, rows) {
  const body = [header].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });   // BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportCsv() {
  const f = OO.filters;
  const dateTag = new Date().toISOString().slice(0, 10);
  const repTag = f.rep ? '_' + f.rep.replace(/[^a-z0-9]+/gi, '-') : '';
  if (OO.tab === 'tr') {
    const rows = filteredTR().map(r => [r.number, r.from, r.to, r.status, fmtDate(r.departure), r.age == null ? '' : r.age]);
    if (!rows.length) return alert('Nothing to export in the current filter.');
    downloadCsv(`open_transfers_${dateTag}.csv`, ['Transfer', 'From', 'To', 'Status', 'Departure', 'Days'], rows);
    return;
  }
  const data = OO.tab === 'bo' ? backorderSO() : activeSO();
  if (!data.length) return alert('Nothing to export in the current filter.');
  const rows = data.map(r => [r.order, r.customer, r.rep, r.warehouse, r.stage, invoiceLabel(r.invoiceStatus), fmtDate(r.orderDate), r.age == null ? '' : r.age]);
  const kind = OO.tab === 'bo' ? 'backorders' : 'open_orders';
  downloadCsv(`${kind}${repTag}_${dateTag}.csv`, ['Order', 'Customer', 'Sales Rep', 'Warehouse', 'Stage', 'Invoiced', 'Order Date', 'Days Open'], rows);
}

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

// ── follow-up notes ("tratativas") — read/write via our server (not Cin7) ──
async function fetchNotes() {
  try {
    const r = await fetch('/api/open-orders/notes');
    if (!r.ok) return {};
    const j = await r.json();
    const map = {};
    (j.notes || []).forEach(n => { map[n.order_number] = n; });
    return map;
  } catch (_) { return {}; }   // endpoint not up yet (needs a server restart/deploy) — page still works
}
function openNoteModal(order) {
  OO._noteOrder = order;
  const n = OO.notes[order] || {};
  document.getElementById('ooNoteOrder').textContent = order;
  document.getElementById('ooNoteText').value = n.note || '';
  document.getElementById('ooNoteBy').value = n.contacted_by || localStorage.getItem('oo_contacted_by') || '';
  document.getElementById('ooNoteContacted').checked = !!n.contacted_at;
  document.getElementById('ooNoteResolved').checked = !!n.resolved;
  document.getElementById('ooNoteModal').classList.add('open');
  document.getElementById('ooNoteText').focus();
}
function closeNoteModal() { document.getElementById('ooNoteModal').classList.remove('open'); OO._noteOrder = null; }
async function saveNote() {
  const order = OO._noteOrder; if (!order) return;
  const by = document.getElementById('ooNoteBy').value.trim();
  if (by) { try { localStorage.setItem('oo_contacted_by', by); } catch (_) {} }
  const body = {
    order_number: order,
    note: document.getElementById('ooNoteText').value.trim(),
    contacted: document.getElementById('ooNoteContacted').checked,
    contacted_by: by,
    resolved: document.getElementById('ooNoteResolved').checked
  };
  const btn = document.getElementById('ooNoteSave'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch('/api/open-orders/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'save failed');
    OO.notes[order] = j.note || body;
    closeNoteModal();
    renderAll();
  } catch (e) {
    alert('Could not save the follow-up: ' + e.message + '\n(The notes endpoint needs the server running the latest code.)');
  } finally { btn.disabled = false; btn.textContent = 'Save'; }
}

async function loadData() {
  const sb = await ensureClient();
  const [so, tr, notes] = await Promise.all([fetchSO(sb), fetchTR(sb), fetchNotes()]);
  OO.so = so; OO.tr = tr; OO.notes = notes || {}; OO.loaded = true;
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
  const invSel = document.getElementById('ooInvoice');
  if (invSel) invSel.addEventListener('change', () => { OO.filters.invoice = invSel.value || ''; reRender(); });
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
  const exportBtn = document.getElementById('ooExport');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
  // follow-up ("tratativa") modal — buttons are rendered into rows, so delegate
  document.addEventListener('click', e => {
    const b = e.target.closest('.oo-notebtn');
    if (b) { openNoteModal(b.getAttribute('data-order')); return; }
    const asm = e.target.closest('.oo-asm');
    if (asm) { toggleAsm(asm); return; }
    if (e.target === document.getElementById('ooNoteModal')) closeNoteModal();
    // expand/collapse a data row to show its line items (ignore clicks in the action cell)
    const row = e.target.closest('tr.oo-clickable');
    if (row && !e.target.closest('.oo-actioncell')) { toggleExpand(row); }
  });
  ['ooNoteCancel', 'ooNoteCancelX'].forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('click', closeNoteModal); });
  const saveBtn = document.getElementById('ooNoteSave'); if (saveBtn) saveBtn.addEventListener('click', saveNote);
}

function init() {
  bind();
  switchTab('so');
  const def = document.querySelector('.oo-agechip[data-age="2"]'); if (def) def.classList.add('active');   // default: open > 2 days
  loadData().catch(e => { console.error('[open-orders] load failed', e); const t = document.querySelector('#ooSoTable tbody'); if (t) t.innerHTML = `<tr><td colspan="9" class="oo-empty">Could not load data: ${esc(e.message)}</td></tr>`; });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
