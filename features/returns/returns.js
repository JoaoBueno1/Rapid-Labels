/*
 * Returns — Rapid LED. Warehouse ops return documents.
 * Client-side Supabase (anon). Customers from /api/customers (Cin7, cached).
 * Products from cin7_mirror. Flow: create -> (edit) -> action/treatment -> complete -> history.
 */
'use strict';

const RT = { customers: [], operators: [], _baseOperators: [], lines: [], tlines: [], tsnap: [], tmode: 'simple', sel: null, active: [], history: [], prodTarget: null, editId: null, actRow: null, activePage: 1, histPage: 1, so: null, soLoadedNumber: null, voidId: null };
const PAGE_SIZE = 25;
const REASONS = ['Faulty', 'Product Left Over / Change of Mind', 'Incorrect Item Supplied', 'Incorrect Item Ordered', 'Freight Damage', 'Other'];
const CONDITIONS = ['Resaleable', 'Not Resaleable', 'Faulty'];                                   // warehouse assessment (internal)
const RET_STATUSES = ['Accepted for Credit Assessment', 'Accepted for Warranty Assessment', 'Accepted under warranty & disposed', 'Return Not Accepted']; // printed on customer receipt
// Fixed warehouse list (management uses returns across all sites) — new-return selector + filters.
const WAREHOUSES = ['Sunshine Coast', 'Main Warehouse', 'Melbourne', 'Cairns', 'Coffs Harbour', 'Hobart', 'Sydney', 'Brisbane'];
// Pre-select the office disposition from stage-1 condition (fully editable — faulty/warranty can still be refused).
const DISPO_BY_CONDITION = { 'Resaleable': 'Accepted for Credit Assessment', 'Not Resaleable': 'Accepted for Credit Assessment', 'Faulty': 'Accepted for Warranty Assessment' };
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const fmtDT = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return fmtD(iso); return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(d).replace(/\b([ap])m\b/i, (_, p) => p.toUpperCase() + 'M'); };
const fmtT = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', hour: '2-digit', minute: '2-digit', hour12: true }).format(d).replace(/\b([ap])m\b/i, (_, p) => p.toUpperCase() + 'M'); };
const statusLabel = s => ({ pending: 'Pending', in_treatment: 'Processing', to_putaway: 'Ready to put away', completed: 'Completed', void: 'Voided' }[s] || s);

// ── Return type (Returns / Faulty / Mixed) from the warehouse's per-line condition ──
// Faulty = warranty path; Resaleable / Not Resaleable = Returns (credit); a mix = Mixed.
// Shown under the return number on every list so the office can split the queue at a
// glance: the faulty person and the returns person each grab their own, Mixed needs both.
const RT_TYPE_LABEL = { returns: 'Returns', faulty: 'Faulty', mixed: 'Mixed' };
function rtType(r) {
  const c = (r.returns_lines || []).map(l => String(l.condition || '').trim()).filter(Boolean);
  if (!c.length) return null;                        // not assessed yet
  const f = c.some(x => x === 'Faulty'), nf = c.some(x => x !== 'Faulty');
  return f && nf ? 'mixed' : f ? 'faulty' : 'returns';
}
// How it was processed. There is no stored mode — derived: Advanced when the lines carry
// more than one credit note or more than one processor (per-line handling); else Simple.
function rtMode(r) {
  const tl = r.returns_treatment_lines || [];
  if (!tl.length) return null;                       // not processed yet
  const cn = new Set(tl.map(l => String(l.credit_note || '').trim()).filter(Boolean));
  const by = new Set(tl.map(l => String(l.processed_by || '').trim()).filter(Boolean));
  return (cn.size > 1 || by.size > 1) ? 'advanced' : 'simple';
}
// Its own table cell (a column, right of Lines) — the type chip only.
function rtTypeCell(r) {
  const t = rtType(r);
  const type = t ? `<span class="rt-type ${t}">${RT_TYPE_LABEL[t]}</span>` : '<span class="rt-type-none">—</span>';
  return `<td class="rt-typecell">${type}</td>`;
}
// Processed mode (simple/advanced) — small, under the return number. Empty until processed.
function rtModeTag(r) {
  const m = rtMode(r);
  return m ? `<div class="rt-mode" title="Processed in ${m} mode">${m}</div>` : '';
}
const sb = () => window.supabase;
function toast(msg, kind) { const el = document.createElement('div'); el.className = 'rt-toast ' + (kind || ''); el.textContent = msg; $('rtToast').appendChild(el); setTimeout(() => el.remove(), 3500); }
function rtInvalid(id) { const el = $(id); if (!el) return; el.classList.add('rt-invalid'); try { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} el.addEventListener('input', function h() { el.classList.remove('rt-invalid'); el.removeEventListener('input', h); }); }
const sumVal = arr => (arr || []).reduce((s, l) => s + (Number(l.line_value) || 0), 0);
const rtCredit = r => sumVal(r.returns_treatment_lines);
const rtValue = r => { const c = rtCredit(r); return c || sumVal(r.returns_lines); }; // credit if treated, else intake total
function paginate(rows, page) { const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); const p = Math.min(Math.max(1, page), pages); return { slice: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE), p, pages, total: rows.length }; }
function pagerHtml(kind, pg) { if (pg.total <= PAGE_SIZE) return `<span class="rt-pager-info">${pg.total} row(s)</span>`; return `<button class="rt-btn rt-btn-sm" ${pg.p <= 1 ? 'disabled' : ''} onclick="rtGoPage('${kind}',-1)">‹ Prev</button><span class="rt-pager-info">Page ${pg.p} of ${pg.pages} · ${pg.total} total</span><button class="rt-btn rt-btn-sm" ${pg.p >= pg.pages ? 'disabled' : ''} onclick="rtGoPage('${kind}',1)">Next ›</button>`; }
function rtGoPage(kind, d) { if (kind === 'active') { RT.activePage += d; rtRenderActive(); } else { RT.histPage += d; rtRenderHistory(); } }

// ─── Init ───
// Close any open autocomplete on an outside click. Attached SYNCHRONOUSLY (not behind
// the async data load) so it always fires — even while customers/returns are loading.
document.addEventListener('click', e => {
  if (!e.target.closest('.rt-cust') && $('rtCustAc')) $('rtCustAc').classList.remove('show');
  if (!e.target.closest('.rt-oper') && $('rtOperatorAc')) $('rtOperatorAc').classList.remove('show');
  if (!e.target.closest('.rt-actby') && $('rtActByAc')) $('rtActByAc').classList.remove('show');
  if (!e.target.closest('.rt-putawayby') && $('rtPutawayByAc')) $('rtPutawayByAc').classList.remove('show');
  if (!e.target.closest('.rt-voidby') && $('rtVoidByAc')) $('rtVoidByAc').classList.remove('show');
  if (!e.target.closest('.rt-prod-cell') && !e.target.closest('.rt-dc5-cell') && !e.target.closest('#rtProdAc') && $('rtProdAc')) $('rtProdAc').style.display = 'none';
});

(async function init() {
  try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
  if (!sb()) { $('rtSub').textContent = 'Supabase not available'; return; }
  await Promise.all([loadCustomers(), loadOperators(), loadReturns()]);
})();

// operator autocomplete (shared by New-return operator + Action Treated-by)
function rtOperInput(inputId, acId) {
  const q = ($(inputId).value || '').trim().toLowerCase(); const ac = $(acId);
  let hits = RT.operators; if (q) hits = RT.operators.filter(o => o.toLowerCase().includes(q));
  hits = hits.slice(0, 12);
  ac.innerHTML = hits.map(o => `<div class="rt-ac-item" data-v="${esc(o)}" onclick="rtOperPick('${inputId}','${acId}',this.dataset.v)">${esc(o)}</div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match — you can type a new name</div>';
  ac.classList.add('show');
}
function rtOperPick(inputId, acId, name) { $(inputId).value = name; $(acId).classList.remove('show'); }

async function loadCustomers() { try { const r = await fetch('/api/customers'); RT.customers = (await r.json()).customers || []; } catch (_) {} }
async function loadOperators() {
  try {
    const r = await sb().from('collection_operators').select('*');
    RT._baseOperators = [...new Set((r.data || []).map(o => o.name || o.operator || o.operator_name).filter(Boolean))];
    rtRefreshOperatorPool();
  } catch (_) {}
}
// The name fields accept ANY typed name (new staff) AND autocomplete. As more people
// use it, every name already seen on a return (received/processed/put-away by) joins
// the suggestion pool — union of the collection_operators list + names seen in returns.
function rtRefreshOperatorPool() {
  const s = new Set(RT._baseOperators || []);
  (RT.history || []).forEach(r => [r.operator, r.treated_by, r.putaway_by, r.voided_by].forEach(n => { const t = String(n || '').trim(); if (t) s.add(t); }));
  RT.operators = [...s].sort((a, b) => a.localeCompare(b));
  const dl = $('rtOperators'); if (dl) dl.innerHTML = RT.operators.map(o => `<option value="${esc(o)}">`).join('');
}
async function loadReturns() {
  try {
    const r = await sb().from('returns_active').select('*, returns_lines(sku,product_name,qty,reason,condition,line_no,line_value), returns_treatment_lines(sku,qty,line_value,line_no,return_status,credit_note,processed_by,processed_at)').order('created_at', { ascending: false });
    const rows = r.data || [];
    RT.active = rows.filter(x => x.status !== 'completed' && x.status !== 'void');
    RT.history = rows;   // History now lists ALL returns — a searchable, filterable archive
    RT.activePage = 1; RT.histPage = 1;
    rtRefreshOperatorPool();   // grow the name suggestions with everyone seen on a return
    $('rtSub').textContent = `${RT.active.length} active · ${rows.length} total`;
    rtRenderActive(); rtRenderHistory();
  } catch (e) { toast('Could not load returns: ' + e.message, 'err'); }
}

function rtTab(t) {
  document.querySelectorAll('.rt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('rtActive').style.display = t === 'active' ? '' : 'none';
  $('rtHistory').style.display = t === 'history' ? '' : 'none';
}

// ─── Lists ───
function rtRenderActive() {
  const q = ($('rtSearch').value || '').toLowerCase();
  const wf = ($('rtWhFilter') && $('rtWhFilter').value) || '';
  let rows = RT.active;
  if (wf) rows = rows.filter(r => r.warehouse === wf);
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.customer_id || ''} ${r.origin_order || ''} ${r.operator || ''} ${r.warehouse || ''}`.toLowerCase().includes(q));
  $('rtActiveCount').textContent = `${rows.length} return(s)`;
  if ($('rtActivePager')) $('rtActivePager').innerHTML = '';
  // Active is split by stage so the warehouse and the office each see their own queue.
  // Two sections only: the office queue (Pending + In treatment, told apart by row
  // colour) and the warehouse queue (Ready to put away).
  const defs = [
    { key: 'office',  dot: 'pending',    sts: ['pending', 'in_treatment'], title: 'Awaiting office',   hint: 'Received — the office to process these' },
    { key: 'putaway', dot: 'to_putaway', sts: ['to_putaway'],              title: 'Ready to put away', hint: 'Office done — warehouse to shelve the goods and confirm' },
  ];
  const known = defs.flatMap(d => d.sts);
  const other = rows.filter(r => !known.includes(r.status));
  let html = defs.map(d => rtActiveSection(d, rows.filter(r => d.sts.includes(r.status)))).join('');
  if (other.length) html += rtActiveSection({ key: 'other', dot: '', sts: [], title: 'Other', hint: '' }, other);
  $('rtActiveBody').innerHTML = rows.length ? html : '<div class="rt-empty">No active returns. Click "+ New return" to create one.</div>';
}
function rtActHead(rec) {
  // Section-specific columns (kept lean so neither table needs a sideways scroll).
  return rec
    ? '<thead><tr><th>Return #</th><th>Date</th><th>Business</th><th>Warehouse</th><th>Received by</th><th>Processed by</th><th class="r">Lines</th><th>Type</th><th class="r">Actions</th></tr></thead>'
    : '<thead><tr><th>Return #</th><th>Date</th><th>Business</th><th>Warehouse</th><th>Received by</th><th class="r">Lines</th><th>Type</th><th>Status</th><th class="r">Actions</th></tr></thead>';
}
function rtActiveSection(d, list) {
  const rec = d.key === 'putaway';   // the put-away queue shows the record so far
  const cols = 9;
  const body = list.map(r => rtActiveRow(r, rec)).join('') || `<tr><td colspan="${cols}" class="rt-sec-empty">Nothing here right now.</td></tr>`;
  return `<div class="rt-sec-block">
    <div class="rt-sec-hd"><span class="rt-dot st-${d.dot || ''}"></span><span class="rt-sec-name">${esc(d.title)}</span><span class="rt-sec-count">${list.length}</span>${d.hint ? `<span class="rt-sec-hint">${esc(d.hint)}</span>` : ''}</div>
    <div class="rt-table-wrap"><table class="rt-table">${rtActHead(rec)}<tbody>${body}</tbody></table></div>
  </div>`;
}
function rtActiveRow(r, rec) {
  const isPut = r.status === 'to_putaway';
  const actions = isPut
    ? `<button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtConfirmPutaway('${r.id}')">Put away</button> <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>`
    : `${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm" onclick="rtEdit('${r.id}')">Edit</button> ` : ''}<button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button> <button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtAction('${r.id}')">${r.status === 'in_treatment' ? 'Continue' : 'Action'}</button>${r.status === 'pending' ? ` <button class="rt-btn rt-btn-sm rt-btn-danger" onclick="rtVoid('${r.id}')">Void</button>` : ''}`;
  const rcv = `<td>${esc(r.operator || '—')}${r.created_at ? `<div class="sub">${fmtT(r.created_at)}</div>` : ''}</td>`;
  const lines = `<td class="r num">${(r.returns_lines || []).length}</td>`;
  const act = `<td class="r rt-actions" onclick="event.stopPropagation()">${actions}</td>`;
  // Lean Active queue: Ready-to-put-away = Received by · Processed by; Awaiting office
  // = Received by · Status. Sales order / Invoice / Account live in the details, not here.
  const typeCell = rtTypeCell(r);   // Type column, right of Lines
  const mid = rec
    ? rcv
      + `<td>${r.treated_by ? `${esc(r.treated_by)}<div class="sub">${fmtDT(r.treated_at)}</div>` : '—'}</td>`
      + lines + typeCell + act
    : rcv + lines + typeCell
      + `<td class="rt-status ${r.status}">${statusLabel(r.status)}</td>` + act;
  return `<tr class="rt-row st-${r.status}" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong>${rtModeTag(r)}</td>
    <td>${fmtDT(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td>${esc(r.warehouse || '—')}</td>
    ${mid}
  </tr>`;
}
async function rtConfirmPutaway(id) {
  const r = RT.active.find(x => String(x.id) === String(id)); if (!r) return;
  RT.putawayId = id;
  const [ln, tl] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
  ]);
  const lines = ln.data || [], tlines = tl.data || [];
  $('rtPutawayTitle').innerHTML = `Put away — ${esc(r.return_no)} <span class="rt-step">① Created ▸ ② Processed ▸ <b>③ Put away</b></span>`;
  $('rtPutawayInfo').innerHTML = `
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Business</span><b>${esc(r.customer_name || '—')} ${r.customer_id ? '(' + esc(r.customer_id) + ')' : ''}</b></div>
      <div class="rt-kv"><span>Sales order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Received by</span><b>${esc(r.operator || '—')}${r.created_at ? ' · ' + fmtDT(r.created_at) : ''}</b></div>
      <div class="rt-kv"><span>Processed by</span><b>${r.treated_by ? esc(r.treated_by) + (r.treated_at ? ' · ' + fmtDT(r.treated_at) : '') : '—'}</b></div>
      <div class="rt-kv"><span>Credit note</span><b>${esc(r.treatment_ref || '—')}</b></div>
    </div>`;
  const src = tlines.length ? tlines : lines;
  $('rtPutLinesBody').innerHTML = src.map(l => {
    const disp = l.return_status || l.condition || l.reason || '—';
    return `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc((l.product_name || '').slice(0, 40))}</td><td class="r">${l.qty}</td><td>${esc(disp)}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="rt-sec-empty">No line detail.</td></tr>';
  $('rtPutawayBy').value = ''; $('rtPutawayLoc').value = '';
  $('rtPutawayModal').classList.add('active');
  setTimeout(() => $('rtPutawayBy').focus(), 60);
}
function rtPutawayClose() { $('rtPutawayModal').classList.remove('active'); }

// Folha "Ready to put away": tudo que está na fila to_putaway, para o warehouse
// pegar e finalizar a partir do papel. Colunas simples — RT number, 5DC (dc5), o
// SKU e a quantidade; sem descrição. Prefere as linhas de tratamento (o que foi
// processado); cai nas declaradas se não houver.
async function rtPrintPutaway() {
  const rows = (RT.active || []).filter(r => r.status === 'to_putaway');
  if (!rows.length) return toast('Nothing ready to put away', 'err');
  const ids = rows.map(r => r.id);
  let tl = [], ll = [];
  try {
    const [t, l] = await Promise.all([
      sb().from('returns_treatment_lines').select('*').in('return_id', ids),
      sb().from('returns_lines').select('*').in('return_id', ids),
    ]);
    tl = t.data || []; ll = l.data || [];
  } catch (e) { return toast('Could not load lines: ' + e.message, 'err'); }
  const byRet = arr => { const m = {}; arr.forEach(x => { (m[x.return_id] = m[x.return_id] || []).push(x); }); return m; };
  const tByR = byRet(tl), lByR = byRet(ll);
  const pr = [];
  rows.forEach(r => {
    const src = (tByR[r.id] && tByR[r.id].length) ? tByR[r.id] : (lByR[r.id] || []);
    src.slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0))
      .forEach(l => pr.push({ rt: r.return_no, dc5: l.dc5 || '', sku: l.sku || '', qty: l.qty }));
  });
  if (!pr.length) return toast('No line detail to print', 'err');
  const w = window.open('', '_blank', 'width=900,height=800');
  if (!w) return toast('The browser blocked the print window', 'err');
  const now = new Date();
  const body = pr.map(r => `<tr><td>${esc(r.rt)}</td><td>${esc(r.dc5)}</td><td><strong>${esc(r.sku)}</strong></td><td class="r">${esc(String(r.qty))}</td></tr>`).join('');
  w.document.write('<!doctype html><meta charset="utf-8"><title>Ready to put away — ' + esc(now.toLocaleDateString()) + '</title>'
    + '<style>body{font:13px/1.5 "IBM Plex Sans",system-ui,-apple-system,sans-serif;color:#1b2230;margin:24px}'
    + 'h1{font-size:18px;margin:0 0 2px}.sub{color:#5b6b86;font-size:12px;margin-bottom:14px}'
    + 'table{border-collapse:collapse;width:100%;font-size:13px}'
    + 'th{background:#f1f3f6;text-align:left;padding:7px 10px;border-bottom:1px solid #cfd6df;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#5b6b86}'
    + 'td{padding:6px 10px;border-bottom:1px solid #e6eaef}.r{text-align:right;font-variant-numeric:tabular-nums}'
    + 'tr:nth-child(even) td{background:#fafbfc}</style>'
    + '<h1>Ready to put away</h1>'
    + `<div class="sub">${rows.length} return(s) · ${pr.length} line(s) · printed ${esc(now.toLocaleString())}</div>`
    + '<table><thead><tr><th>RT number</th><th>5DC</th><th>Product code (SKU)</th><th class="r">Qty</th></tr></thead>'
    + `<tbody>${body}</tbody></table>`);
  w.document.close(); w.focus(); w.print();
}
async function rtDoPutaway() {
  const id = RT.putawayId; if (!id) return;
  const r = RT.active.find(x => String(x.id) === String(id));
  const by = ($('rtPutawayBy').value || '').trim();
  const loc = ($('rtPutawayLoc').value || '').trim();
  if (!by) { toast('Enter who put it away', 'err'); return rtInvalid('rtPutawayBy'); }
  const btn = $('rtPutawayBtn'); btn.disabled = true;
  try {
    // status first (works even before the 004 columns exist), then the best-effort put-away stamp
    const { error } = await sb().from('returns_active').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await sb().from('returns_active').update({ putaway_by: by, putaway_at: new Date().toISOString(), putaway_location: loc || null }).eq('id', id);
    toast(`${r ? r.return_no : 'Return'} put away — moved to History`, 'ok');
    rtPutawayClose(); await loadReturns();
  } catch (e) { toast('Put-away failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}
// Current History view after its filters (status / warehouse / search / show-voided),
// unpaginated. Shared by the table render and the CSV export so "what you see is what
// you export".
function rtHistoryFiltered() {
  const q = ($('rtHistSearch').value || '').toLowerCase();
  const sf = ($('rtHistStatus') && $('rtHistStatus').value) || '';
  const wf = ($('rtHistWh') && $('rtHistWh').value) || '';
  const showVoided = ($('rtShowVoided') && $('rtShowVoided').checked) || sf === 'void';
  let rows = RT.history;                          // History lists ALL returns, newest first
  if (sf) rows = rows.filter(r => r.status === sf);
  if (!showVoided) rows = rows.filter(r => r.status !== 'void');   // voided hidden unless "Show voided" (or the void filter)
  if (wf) rows = rows.filter(r => r.warehouse === wf);
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.treatment_ref || ''} ${r.operator || ''} ${r.treated_by || ''} ${r.putaway_by || ''} ${r.voided_by || ''} ${r.warehouse || ''}`.toLowerCase().includes(q));
  return rows;
}
function rtRenderHistory() {
  let rows = rtHistoryFiltered();
  $('rtHistCount').textContent = `${rows.length} return(s)`;
  const pg = paginate(rows, RT.histPage); rows = pg.slice; $('rtHistPager').innerHTML = pagerHtml('history', pg);
  $('rtHistBody').innerHTML = rows.map(r => `<tr class="rt-row st-${r.status} ${r.status === 'void' ? 'rt-row-void' : ''}" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong>${rtModeTag(r)}</td>
    <td>${fmtDT(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td>${esc(r.warehouse || '—')}</td>
    ${rtTypeCell(r)}
    <td class="rt-status ${r.status}">${statusLabel(r.status)}${r.status === 'void' ? `<div class="sub">${r.voided_by ? esc(r.voided_by) + ' · ' : ''}${fmtDT(r.voided_at || r.updated_at)}</div>` : ''}</td>
    <td>${r.operator ? `${esc(r.operator)}<div class="sub">${fmtT(r.created_at)}</div>` : '—'}</td>
    <td>${r.treated_by ? `${esc(r.treated_by)}<div class="sub">${fmtDT(r.treated_at)}</div>` : '—'}</td>
    <td>${r.putaway_by ? `${esc(r.putaway_by)}<div class="sub">${fmtDT(r.putaway_at)}${r.putaway_location ? ' · ' + esc(r.putaway_location) : ''}</div>` : '—'}</td>
    <td class="r rt-actions" onclick="event.stopPropagation()">
      <button class="rt-btn rt-btn-sm" onclick="rtView('${r.id}')">View</button>
      <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="10" class="rt-empty">No returns match.</td></tr>';
}
function rtHdr(id) { return RT.active.concat(RT.history).find(r => r.id === id); }

// ─── Create / Edit ───
function rtOpenNew() { rtOpenForm(null); }
async function rtEdit(id) { rtOpenForm(rtHdr(id)); }
async function rtOpenForm(row) {
  RT.editId = row ? row.id : null; RT.sel = null; RT.lines = []; RT.so = null; RT.soLoadedNumber = null;
  if ($('rtSoInput')) $('rtSoInput').value = '';
  if ($('rtScanInput')) $('rtScanInput').value = '';
  $('rtCustRef').value = row ? (row.customer_reference || '') : '';
  $('rtInvoice').value = row ? (row.invoice_number || '') : '';
  $('rtFormTitle').textContent = row ? `Edit return ${row.return_no}` : 'New return';
  $('rtSaveBtn').textContent = row ? 'Save changes' : 'Save & print';
  $('rtCustName').value = row ? (row.customer_name || '') : '';
  $('rtCustId').value = row ? (row.customer_id || '') : '';
  if (row) RT.sel = { name: row.customer_name, code: row.customer_id, email: row.customer_email };   // email kept silently (no form field)
  $('rtContact').value = row ? (row.contact_name || '') : '';
  $('rtRep').value = row ? (row.rep || '') : '';
  $('rtOrigin').value = row ? (row.origin_order || '') : '';
  $('rtOperator').value = row ? (row.operator || '') : '';
  if ($('rtNewWarehouse')) $('rtNewWarehouse').value = row ? (row.warehouse || '') : '';
  $('rtNotes').value = row ? (row.notes || '') : '';
  if (row) {
    const r = await sb().from('returns_lines').select('*').eq('return_id', row.id).order('line_no');
    RT.lines = (r.data || []).map(l => ({ sku: l.sku, name: l.product_name, dc5: l.dc5, qty: l.qty, reason: l.reason || '', condition: l.condition || '', return_status: l.return_status || '', unit: l.unit_value }));
  }
  if (!RT.lines.length) { RT.lines = [{ sku: '', name: '', dc5: '', qty: '', reason: '', condition: '', return_status: '', unit: 0 }]; }   // start with ONE line; user clicks "+ Add line" for more
  rtRenderLines();
  $('rtNewModal').classList.add('active');
  RT.newDirtyBase = rtNewFingerprint();   // baseline do dirty-check (× / ESC)
}
function rtNewFingerprint() {
  const v = id => (($(id) && $(id).value) || '');
  return JSON.stringify({
    f: [v('rtCustName'), v('rtCustId'), v('rtCustRef'), v('rtInvoice'), v('rtContact'), v('rtRep'), v('rtOrigin'), v('rtOperator'), (($('rtNewWarehouse') && $('rtNewWarehouse').value) || ''), v('rtNotes')],
    l: (RT.lines || []).map(l => [l.sku || '', l.dc5 || '', String(l.qty || ''), l.reason || '', l.condition || '']),
  });
}
function rtNewDirty() { return RT.newDirtyBase != null && rtNewFingerprint() !== RT.newDirtyBase; }
// × e ESC: se houve alteração não salva, confirma (em inglês) antes de descartar;
// sem alteração, fecha direto. Não fecha ao clicar fora — de propósito.
function rtCloseNew(force) {
  if (!force && rtNewDirty() && !confirm('You have unsaved changes. Discard them?')) return;
  RT.newDirtyBase = null;
  $('rtNewModal').classList.remove('active');
}

// ESC fecha o modal do topo (o confirm de descarte do Act fecha primeiro). Os
// modais com dados a salvar (New, Act) confirmam se houve alteração; os demais
// fecham direto. NÃO há fechamento por clique fora — de propósito.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const order = [
    ['rtDiscardModal', () => rtDiscardClose()],
    ['rtActModal', () => rtCloseAct()],
    ['rtNewModal', () => rtCloseNew()],
    ['rtCompleteModal', () => rtCompleteClose()],
    ['rtVoidModal', () => rtVoidClose()],
    ['rtSoModal', () => rtSoClose()],
    ['rtPutawayModal', () => rtPutawayClose()],
    ['rtViewModal', () => rtCloseView()],
  ];
  for (const [id, close] of order) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('active')) { e.preventDefault(); close(); return; }
  }
});

function rtCustInput() {
  const q = ($('rtCustName').value || '').trim().toLowerCase(); const ac = $('rtCustAc');
  if (q.length < 2) { ac.classList.remove('show'); return; }
  const hits = RT.customers.filter(c => c.name.toLowerCase().includes(q)).slice(0, 12);
  ac.innerHTML = hits.map(c => `<div class="rt-ac-item" onclick='rtPickCust(${JSON.stringify(c).replace(/'/g, "&#39;")})'>${esc(c.name)}${c.code ? `<span class="sub"> · ${esc(c.code)}</span>` : ''}</div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match in Cin7 — pick an existing business</div>';
  ac.classList.add('show'); RT.sel = null; $('rtCustId').value = '';
}
function rtPickCust(c) {
  RT.sel = c; $('rtCustName').value = c.name; $('rtCustId').value = c.code || '';
  if (c.rep) $('rtRep').value = c.rep;             // Cin7 sales rep (email kept on RT.sel, no form field)
  $('rtCustAc').classList.remove('show');          // contact name is typed by the user (varies per employee)
}

function rtAddLine(dup) { RT.lines.push(dup ? { ...dup } : { sku: '', name: '', dc5: '', qty: '', reason: '', condition: '', return_status: '', unit: 0 }); rtRenderLines(); }
function rtRemoveLine(i) { RT.lines.splice(i, 1); rtRenderLines(); }
function rtRenderLines() {
  $('rtLinesBody').innerHTML = RT.lines.map((l, i) => `<tr class="${l._invalid ? 'rt-row-bad' : ''}">
    <td class="rt-dc5-cell" style="position:relative">
      <input class="rt-input" placeholder="5DC" value="${esc(l.dc5 || '')}" oninput="rtDc5Input(${i}, this)" onfocus="rtDc5Input(${i}, this)" autocomplete="off" /></td>
    <td class="rt-prod-cell" style="position:relative">
      <input class="rt-input" placeholder="SKU / name" value="${esc(l.sku || '')}" oninput="rtProdInput(${i}, this)" onfocus="rtProdInput(${i}, this)" autocomplete="off" />
      ${l.name ? `<div class="rt-line-desc">${esc(l.name)}</div>` : ''}</td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="1" placeholder="0" value="${l.qty}" oninput="rtLineSet(${i},'qty',this.value)" /></td>
    <td><select class="rt-input" onchange="rtLineSet(${i},'reason',this.value)"><option value="">— reason —</option>${REASONS.map(r => `<option ${l.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td><select class="rt-input" onchange="rtLineSet(${i},'condition',this.value)"><option value="">— condition —</option>${CONDITIONS.map(r => `<option ${l.condition === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="r"><button class="rt-line-x" title="Duplicate" onclick="rtAddLine(RT.lines[${i}])">⧉</button><button class="rt-line-x" title="Remove" onclick="rtRemoveLine(${i})">×</button></td>
  </tr>`).join('');
}
function rtLineSet(i, k, v) { RT.lines[i][k] = v; }

let _prodTimer = null;
function rtProdInput(i, inp) {
  // capture free text so an unmatched product still saves (user typed it + a qty)
  const l = RT.lines[i]; if (l) { l.sku = inp.value.trim(); l.name = ''; l.dc5 = ''; }
  RT.prodTarget = { i, inp }; const q = (inp.value || '').trim(); const ac = $('rtProdAc');
  const rect = inp.getBoundingClientRect(); ac.style.left = rect.left + 'px'; ac.style.top = (rect.bottom + 2) + 'px'; ac.style.width = rect.width + 'px';
  if (q.length < 2) { ac.style.display = 'none'; return; }
  clearTimeout(_prodTimer);
  _prodTimer = setTimeout(async () => {
    try {
      const like = `%${q}%`;
      const r = await sb().schema('cin7_mirror').from('products').select('sku,name,attribute1,price_tier1').or(`sku.ilike.${like},name.ilike.${like},attribute1.ilike.${like}`).limit(8);
      ac.innerHTML = (r.data || []).filter(p => !rtIsCarton(p.sku)).map(p => `<div class="rt-ac-item" onclick='rtPickProd(${JSON.stringify(p).replace(/'/g, "&#39;")})'><strong>${esc(p.sku)}</strong>${p.attribute1 ? ` <span class="sub">5DC ${esc(p.attribute1)}</span>` : ''}<div class="sub">${esc((p.name || '').slice(0, 60))}</div></div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
      ac.style.display = 'block';
    } catch (e) { ac.style.display = 'none'; }
  }, 200);
}
function rtPickProd(p) {
  const t = RT.prodTarget; if (!t) return; const l = RT.lines[t.i];
  l.sku = p.sku; l.name = p.name || ''; l.dc5 = p.attribute1 || '';
  // no value at creation — the office types the credit value in stage 2 (discounts vary)
  $('rtProdAc').style.display = 'none'; rtRenderLines();
}
// find a product by typing its 5DC (attribute1) in the 5DC column
function rtDc5Input(i, inp) {
  const l = RT.lines[i]; if (l) l.dc5 = inp.value.trim();   // capture typed 5DC (free text ok)
  RT.prodTarget = { i, inp }; const q = (inp.value || '').trim(); const ac = $('rtProdAc');
  const rect = inp.getBoundingClientRect(); ac.style.left = rect.left + 'px'; ac.style.top = (rect.bottom + 2) + 'px'; ac.style.width = Math.max(rect.width, 240) + 'px';
  if (q.length < 2) { ac.style.display = 'none'; return; }
  clearTimeout(_prodTimer);
  _prodTimer = setTimeout(async () => {
    try {
      const r = await sb().schema('cin7_mirror').from('products').select('sku,name,attribute1,price_tier1').ilike('attribute1', `${q}%`).limit(8);
      ac.innerHTML = (r.data || []).filter(p => !rtIsCarton(p.sku)).map(p => `<div class="rt-ac-item" onclick='rtPickProd(${JSON.stringify(p).replace(/'/g, "&#39;")})'><strong>5DC ${esc(p.attribute1)}</strong> <span class="sub">${esc(p.sku)}</span><div class="sub">${esc((p.name || '').slice(0, 60))}</div></div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
      ac.style.display = 'block';
    } catch (e) { ac.style.display = 'none'; }
  }, 200);
}

async function rtSaveNew() {
  // business MUST be one selected from Cin7 (RT.sel) — free-typed names are rejected.
  // A business with no account code is still valid; we only require it was picked.
  const name = RT.sel ? (RT.sel.name || '').trim() : '';
  const contact = ($('rtContact').value || '').trim();
  const operator = ($('rtOperator').value || '').trim();
  const warehouse = (($('rtNewWarehouse') && $('rtNewWarehouse').value) || '').trim();
  RT.lines.forEach(l => l._invalid = false);
  const withSku = RT.lines.filter(l => l.sku);
  const lines = withSku.filter(l => (Number(l.qty) || 0) > 0 && l.reason && l.condition);
  if (!name) { toast('Pick the business from the list (Cin7)', 'err'); return rtInvalid('rtCustName'); }
  if (!contact) { toast('Enter the customer name (contact)', 'err'); return rtInvalid('rtContact'); }
  if (!operator) { toast('Enter who received it (Received by)', 'err'); return rtInvalid('rtOperator'); }
  if (!warehouse) { toast('Pick the warehouse', 'err'); return rtInvalid('rtNewWarehouse'); }
  if (!withSku.length) { toast('Add at least one product line', 'err'); return; }
  if (lines.length !== withSku.length) {
    withSku.forEach(l => { if (!((Number(l.qty) || 0) > 0) || !l.reason || !l.condition) l._invalid = true; });
    rtRenderLines();
    return toast('Every product line needs a quantity, a reason and a condition', 'err');
  }
  const btn = $('rtSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const hdr = {
      customer_name: name, customer_id: (RT.sel ? RT.sel.code : ($('rtCustId').value || '')) || null,
      contact_name: ($('rtContact').value || '').trim() || null,
      customer_email: (RT.sel && RT.sel.email) || null,
      rep: ($('rtRep').value || '').trim() || null,
      invoice_number: ($('rtInvoice').value || '').trim() || null,
      customer_reference: ($('rtCustRef').value || '').trim() || null,
      origin_order: ($('rtOrigin').value || '').trim() || null, operator, warehouse: warehouse || null, notes: ($('rtNotes').value || '').trim() || null,
    };
    let id, return_no, oldLineIds = [];
    if (RT.editId) {
      id = RT.editId; return_no = (rtHdr(RT.editId) || {}).return_no;
      const { error: eu } = await sb().from('returns_active').update({ ...hdr, updated_at: new Date().toISOString() }).eq('id', RT.editId);
      if (eu) throw eu;
      const { data: old } = await sb().from('returns_lines').select('id').eq('return_id', RT.editId);
      oldLineIds = (old || []).map(o => o.id);   // remove these only AFTER the new lines are safely inserted
    } else {
      const { data, error } = await sb().from('returns_active').insert({ ...hdr, status: 'pending' }).select('id,return_no').single();
      if (error) throw error; id = data.id; return_no = data.return_no;
    }
    const lineRows = lines.map((l, idx) => ({ return_id: id, line_no: idx + 1, sku: l.sku, product_name: l.name, dc5: l.dc5 || null, qty: Number(l.qty) || 0, reason: l.reason || null, condition: l.condition || null, unit_value: 0, line_value: 0 }));   // no monetary values on returns (by request)
    const { error: e2 } = await sb().from('returns_lines').insert(lineRows); if (e2) throw e2;
    if (oldLineIds.length) await sb().from('returns_lines').delete().in('id', oldLineIds);   // safe: new rows already in
    toast(`${return_no} ${RT.editId ? 'updated' : 'created'}`, 'ok');
    const wasNew = !RT.editId; rtCloseNew(true); await loadReturns();
    if (wasNew) rtPrint(id);
  } catch (e) { toast('Save failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}

// ─── Sales-order scan → pre-fill (one SO per return) ───
const rtNorm = s => String(s || '').trim().toLowerCase();
async function rtFindSo() {
  const q = ($('rtSoInput').value || '').trim();
  if (!q) return toast('Scan or type a sales order', 'err');
  if (RT.soLoadedNumber && rtNorm(RT.soLoadedNumber) !== rtNorm(q)) {
    return toast(`This return already uses ${RT.soLoadedNumber}. One return per sales order — save it and create a new return for ${q}.`, 'err');
  }
  const btn = $('rtSoBtn'); btn.disabled = true; const old = btn.textContent; btn.textContent = 'Finding…';
  try {
    const j = await (await fetch('/api/sale?q=' + encodeURIComponent(q))).json();
    if (!j.found) return toast(/^\d+$/.test(q) ? `Include the SO- or INV- prefix (e.g. SO-${q})` : `No sales order found for "${q}"`, 'err');
    RT.so = {
      number: j.order_number, customer: j.customer_name, code: j.customer_code, contact: j.contact_name, email: j.customer_email,
      rep: j.rep, invoice: j.invoice_number, reference: j.customer_reference,
      lines: (j.lines || []).map(l => ({ sku: l.sku, name: l.name, ordered: l.qty, price: l.price != null ? l.price : 0, rqty: '', reason: '', condition: '' })),
    };
    if (!RT.so.lines.length) return toast(`${j.order_number} has no order lines`, 'err');
    // enrich SO lines with 5DC (attribute1) from the mirror — the sale API only gives SKU
    try {
      const skus = [...new Set(RT.so.lines.map(l => l.sku).filter(Boolean))];
      if (skus.length) {
        const { data } = await sb().schema('cin7_mirror').from('products').select('sku,attribute1').in('sku', skus);
        const map = {}; (data || []).forEach(p => { map[(p.sku || '').toLowerCase()] = p.attribute1 || ''; });
        RT.so.lines.forEach(l => { l.dc5 = map[(l.sku || '').toLowerCase()] || ''; });
      }
    } catch (_) {}
    rtSoRender();
    $('rtSoModal').classList.add('active');
  } catch (e) { toast('Lookup failed: ' + e.message, 'err'); } finally { btn.disabled = false; btn.textContent = old; }
}
function rtSoRender() {
  const so = RT.so;
  $('rtSoTitle').textContent = 'Sales order ' + so.number;
  $('rtSoMeta').innerHTML = `<div class="rt-kv-grid">
    <div class="rt-kv"><span>Business</span><b>${esc(so.customer || '—')} ${so.code ? '(' + esc(so.code) + ')' : ''}</b></div>
    <div class="rt-kv"><span>Contact</span><b>${esc(so.contact || '—')}</b></div>
    <div class="rt-kv"><span>Invoice</span><b>${esc(so.invoice || '—')}</b></div>
    <div class="rt-kv"><span>Reference</span><b>${esc(so.reference || '—')}</b></div>
    <div class="rt-kv"><span>Email</span><b>${esc(so.email || '—')}</b></div>
    <div class="rt-kv"><span>Rep</span><b>${esc(so.rep || '—')}</b></div>
  </div>`;
  $('rtSoBody').innerHTML = so.lines.map((l, i) => `<tr>
    <td class="rt-dc5-cell">${esc(l.dc5 || '')}</td>
    <td><strong>${esc(l.sku)}</strong><div class="sub">${esc((l.name || '').slice(0, 40))}</div></td>
    <td class="r num">${l.ordered}</td>
    <td class="r"><input class="rt-input r" type="number" min="0" max="${l.ordered}" step="1" placeholder="0" value="${l.rqty}" oninput="rtSoSet(${i},'rqty',this.value)" /></td>
    <td><select class="rt-input" onchange="rtSoSet(${i},'reason',this.value)"><option value="">— reason —</option>${REASONS.map(r => `<option ${l.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td><select class="rt-input" onchange="rtSoSet(${i},'condition',this.value)"><option value="">— condition —</option>${CONDITIONS.map(r => `<option ${l.condition === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="r"><button class="rt-rm" title="Remove line" onclick="rtSoRemove(${i})">×</button></td>
  </tr>`).join('') || '<tr><td colspan="7" class="rt-empty">No items left — close and add manually.</td></tr>';
  rtSoUpdateBtn();
}
function rtSoUpdateBtn() {
  const n = RT.so.lines.length;
  const ok = n > 0 && RT.so.lines.every(l => (Number(l.rqty) || 0) > 0 && l.reason && l.condition);
  const btn = $('rtSoAdd'); btn.disabled = !ok;
  btn.textContent = ok ? `Add ${n} item(s) to return` : (n ? `Set qty + reason + condition on all ${n} line(s)` : 'No items');
}
function rtSoSet(i, k, v) {
  if (k === 'rqty') {                                  // cap at ordered qty — can't return more than was sold
    const max = RT.so.lines[i].ordered;
    let n = v === '' ? '' : Math.max(0, Number(v) || 0);
    if (n !== '' && n > max) { n = max; toast(`Max ${max} for ${RT.so.lines[i].sku} (ordered)`, 'err'); RT.so.lines[i].rqty = n; rtSoRender(); return; }
    RT.so.lines[i].rqty = n; rtSoUpdateBtn();
    return;
  }
  RT.so.lines[i][k] = v;
  if (k === 'reason' || k === 'condition') rtSoUpdateBtn();
}
function rtSoRemove(i) { RT.so.lines.splice(i, 1); rtSoRender(); }
function rtSoClose() { $('rtSoModal').classList.remove('active'); }
function rtSoConfirm() {
  const so = RT.so; const chosen = so.lines.filter(l => (Number(l.rqty) || 0) > 0 && l.reason && l.condition);
  if (!so.lines.length || chosen.length !== so.lines.length) return toast('Every line needs a qty, a reason and a condition (or remove it)', 'err');
  // fill business + order fields from the SO (contact name is typed by the user)
  if (so.customer) { $('rtCustName').value = so.customer; RT.sel = { name: so.customer, code: so.code, email: so.email, rep: so.rep }; }
  $('rtCustId').value = so.code || '';
  if (so.rep) $('rtRep').value = so.rep;
  if (so.invoice) $('rtInvoice').value = so.invoice;
  $('rtOrigin').value = so.number;
  if (so.reference) $('rtCustRef').value = so.reference;
  // append chosen lines (keep any real manual lines, drop blank placeholders)
  RT.lines = RT.lines.filter(l => l.sku).concat(chosen.map(l => ({ sku: l.sku, name: l.name, dc5: l.dc5 || '', qty: Number(l.rqty) || 0, reason: l.reason || '', condition: l.condition || '', unit: 0 })));
  RT.soLoadedNumber = so.number;
  rtRenderLines(); rtSoClose();
  toast(`Added ${chosen.length} item(s) from ${so.number}`, 'ok');
}

// ─── Manual scan → resolve to the UNIT (never the carton) → focused line ───
async function rtScanProduct() {
  const code = ($('rtScanInput').value || '').trim();
  if (!code) return;
  $('rtScanInput').value = '';
  try {
    const p = await rtScanResolve(code);
    if (!p) return toast(`No product found for "${code}"`, 'err');
    RT.lines.push({ sku: p.sku, name: p.name || '', dc5: p.attribute1 || '', qty: '', reason: '', condition: '', return_status: '', unit: 0 });
    rtRenderLines();
    const rows = $('rtLinesBody').querySelectorAll('tr');
    const last = rows[rows.length - 1];
    if (last) { const qi = last.querySelector('input[type=number]'); if (qi) { qi.focus(); qi.select(); } }
    toast('Added ' + p.sku, 'ok');
  } catch (e) { toast('Scan failed: ' + e.message, 'err'); }
}
const rtIsCarton = s => /-Carton\d+$/i.test(s || '');
async function rtScanResolve(code) {
  const c = code.replace(/,/g, '').trim();
  const sel = 'sku,name,attribute1,price_tier1,barcode';
  // 1) direct match on barcode / sku / 5DC
  let { data } = await sb().schema('cin7_mirror').from('products').select(sel).or(`barcode.eq.${c},sku.ilike.${c},attribute1.eq.${c}`).limit(10);
  data = data || [];
  const unit = data.find(p => !rtIsCarton(p.sku));
  if (unit) return unit;                                   // prefer the unit
  // 2) only a carton matched → derive base unit SKU (strip -Carton<n>)
  if (data[0]) {
    const base = data[0].sku.replace(/-Carton\d+$/i, '');
    const { data: u } = await sb().schema('cin7_mirror').from('products').select(sel).ilike('sku', base).limit(1);
    return (u && u[0]) ? u[0] : data[0];                   // fallback: carton if no unit exists
  }
  // 3) nothing by barcode — carton barcode = "1" + unit barcode (13→14 digits). Try stripping the lead "1".
  if (/^1\d{13}$/.test(c)) {
    const { data: b } = await sb().schema('cin7_mirror').from('products').select(sel).eq('barcode', c.slice(1)).limit(1);
    if (b && b[0]) return b[0];
  }
  return null;
}

function rtPrint(id) { window.open('returns_doc.html?id=' + encodeURIComponent(id) + '&v=20260717w', '_blank'); }

// ─── View (consult) ───
// One line of the per-line audit trail. Reads as a sentence on purpose — this is what
// gets shown when someone asks who put which credit note against which SKU.
function rtLogLine(e) {
  const d = e.detail || {};
  const what = {
    resolved:    () => `marked ready as <b>${esc(d.status || '—')}</b>${d.credit_note ? ' · credit note <b>' + esc(d.credit_note) + '</b>' : ''}`,
    reopened:    () => `reopened — missing ${esc((d.missing || []).join(' + ') || 'details')}`,
    credit_note: () => `credit note ${d.from ? '<b>' + esc(d.from) + '</b> → ' : 'set to '}<b>${esc(d.to || '—')}</b>`,
    status:      () => `status ${d.from ? '<b>' + esc(d.from) + '</b> → ' : 'set to '}<b>${esc(d.to || '—')}</b>`,
    split:       () => `split off ${esc(String(d.qty ?? ''))} unit(s)`,
  }[e.action];
  return `<div class="rt-linelog-item"><span class="rt-linelog-when">${fmtDT(e.at)}</span>`
    + `<span class="rt-linelog-sku">${esc(e.sku || '')}</span>`
    + `<span>${what ? what() : esc(e.action)} — <b>${esc(e.by_name || '')}</b></span></div>`;
}

async function rtView(id) {
  const r = rtHdr(id); if (!r) return;
  const [ln, tl, lg] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
    // .catch keeps the detail usable before 005 has been run — a missing log table
    // should hide one section, not blank the whole modal.
    sb().from('returns_line_log').select('*').eq('return_id', id).order('at', { ascending: false }).limit(60).then(x => x, () => ({ data: [] })),
  ]);
  const lines = ln.data || [], tlines = tl.data || [], logs = (lg && lg.data) || [];
  const rowsC = lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc(l.product_name || '')}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td><td>${esc(l.condition || '')}</td></tr>`).join('');
  const bySku = {}; lines.forEach(l => { if (!(l.sku in bySku)) bySku[l.sku] = l; });   // product/5DC for the treatment lines
  const md = rtMode(r);
  // Show the processing record whenever the return has been processed — including the
  // Ready-to-put-away queue (status to_putaway), which was previously left blank here.
  const hasTreat = tlines.length > 0 || ['completed', 'in_treatment', 'to_putaway'].includes(r.status);
  const treatBlock = hasTreat ? `
    <div class="rt-sec-title">Processing</div>
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Credit note #</span><b>${esc(r.treatment_ref || '—')}</b></div>
      <div class="rt-kv"><span>Mode</span><b>${md ? (md === 'advanced' ? 'Advanced (per-line)' : 'Simple') : '—'}</b></div>
      <div class="rt-kv"><span>Processed by</span><b>${esc(r.treated_by || '—')} ${r.treated_at ? '· ' + fmtDT(r.treated_at) : ''}</b></div>
      <div class="rt-kv"><span>Put away by</span><b>${r.putaway_by ? esc(r.putaway_by) + ' · ' + fmtDT(r.putaway_at) + (r.putaway_location ? ' · ' + esc(r.putaway_location) : '') : '—'}</b></div>
      ${r.treatment_notes ? `<div class="rt-kv" style="grid-column:1/-1"><span>Notes</span><b>${esc(r.treatment_notes)}</b></div>` : ''}
    </div>
    ${tlines.length ? `<div class="rt-sec-sub">Per-line disposition — who processed each line and its credit note</div>
    <table class="rt-table rt-treat" style="margin-top:6px"><thead><tr><th>5DC</th><th>SKU</th><th>Product</th><th class="r">Qty</th><th>Return status</th><th>Credit note</th><th>Processed by</th></tr></thead><tbody>${tlines.map(t => { const p = bySku[t.sku] || {}; return `<tr><td class="rt-dc5-cell">${esc(p.dc5 || '')}</td><td><strong>${esc(t.sku)}</strong></td><td>${esc((p.product_name || '').slice(0, 42))}</td><td class="r">${t.qty}</td><td>${esc(t.return_status || '—')}</td><td class="rt-cn-cell">${esc(t.credit_note || '—')}</td><td>${t.processed_by ? esc(t.processed_by) + (t.processed_at ? `<div class="sub">${fmtDT(t.processed_at)}</div>` : '') : '—'}</td></tr>`; }).join('')}</tbody></table>` : ''}
    ${logs.length ? `<div class="rt-sec-title" style="margin-top:12px">Line history</div><div class="rt-linelog">${logs.map(rtLogLine).join('')}</div>` : ''}
  ` : '';
  $('rtViewBody').innerHTML = `
    <div class="rt-view-head">
      <div><div class="rt-view-no">${esc(r.return_no)}</div><div class="rt-status ${r.status}" style="display:inline-block">${statusLabel(r.status)}</div></div>
      <div><button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm" onclick="rtCloseView();rtEdit('${r.id}')">Edit</button>` : ''}
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtCloseView();rtAction('${r.id}')">Action</button>` : ''}
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm rt-btn-danger" onclick="rtCloseView();rtVoid('${r.id}')">Void</button>` : ''}</div>
    </div>
    ${r.status === 'void' ? `<div class="rt-void-banner">⊘ Voided${r.voided_by ? ' by <b>' + esc(r.voided_by) + '</b>' : ''}${(r.voided_at || r.updated_at) ? ' · ' + fmtDT(r.voided_at || r.updated_at) : ''}${r.void_reason ? `<div class="sub">${esc(r.void_reason)}</div>` : ''}</div>` : ''}
    <div class="rt-sec-title">Creation</div>
    <div class="rt-kv-grid3">
      <div class="rt-kv"><span>Business</span><b>${esc(r.customer_name || '—')}</b></div>
      <div class="rt-kv"><span>Customer name</span><b>${esc(r.contact_name || '—')}</b></div>
      <div class="rt-kv"><span>Account</span><b>${esc(r.customer_id || '—')}</b></div>
      <div class="rt-kv"><span>Received by</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Warehouse</span><b>${esc(r.warehouse || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtDT(r.created_at)}</b></div>
      <div class="rt-kv"><span>Sales order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Invoice</span><b>${esc(r.invoice_number || '—')}</b></div>
      <div class="rt-kv"><span>Cust. ref</span><b>${esc(r.customer_reference || '—')}</b></div>
      <div class="rt-kv"><span>Email</span><b>${esc(r.customer_email || '—')}</b></div>
      <div class="rt-kv"><span>Rep</span><b>${esc(r.rep || '—')}</b></div>
      ${r.notes ? `<div class="rt-kv" style="grid-column:1/-1"><span>Notes</span><b>${esc(r.notes)}</b></div>` : ''}
    </div>
    <table class="rt-table" style="margin-top:8px"><thead><tr><th>5DC</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Reason</th><th>Condition</th></tr></thead><tbody>${rowsC}</tbody></table>
    ${treatBlock}`;
  $('rtViewModal').classList.add('active');
}
function rtCloseView() { $('rtViewModal').classList.remove('active'); }

// ─── Void (soft-cancel — never deletes; keeps the record for audit) ───
function rtVoid(id) {
  const r = rtHdr(id); if (!r) return;
  RT.voidId = id;
  $('rtVoidTitle').textContent = `Void ${r.return_no}`;
  ['rtVoidPass', 'rtVoidBy', 'rtVoidReason'].forEach(k => { if ($(k)) $(k).value = ''; });
  $('rtVoidModal').classList.add('active');
  setTimeout(() => { try { $('rtVoidPass').focus(); } catch (_) {} }, 50);
}
function rtVoidClose() { $('rtVoidModal').classList.remove('active'); }
async function rtVoidConfirm() {
  // Password authorises, name attributes. The password is shared across the team, so
  // it proves the action was permitted but says nothing about who performed it — and
  // "who voided this return" is exactly what gets asked later.
  const by = (($('rtVoidBy') && $('rtVoidBy').value) || '').trim();
  if (!by) { toast('Enter who is voiding it', 'err'); return rtInvalid('rtVoidBy'); }
  if ((($('rtVoidPass') && $('rtVoidPass').value) || '').trim() !== '4209') { toast('Wrong void password', 'err'); return rtInvalid('rtVoidPass'); }
  const btn = $('rtVoidBtn'); btn.disabled = true;
  try {
    const now = new Date().toISOString();
    const { error } = await sb().from('returns_active').update({
      status: 'void', updated_at: now,
      voided_by: by, voided_at: now,
      void_reason: (($('rtVoidReason') && $('rtVoidReason').value) || '').trim() || null,
    }).eq('id', RT.voidId);
    if (error) throw error;
    const no = (rtHdr(RT.voidId) || {}).return_no;
    toast(`${no || 'Return'} voided`, 'ok');
    rtVoidClose(); await loadReturns();
  } catch (e) { toast('Void failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}

// ─── Action / Treatment ───
async function rtAction(id) {
  const r = rtHdr(id); if (!r) return; RT.actRow = r;
  const [ln, tl] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
  ]);
  const lines = ln.data || [], tlines = tl.data || [];
  RT.stageLines = lines;
  // credit lines: existing treatment lines, or seed from stage-1. Value starts BLANK
  // on first treatment (lots of discounts → varies); shows the saved value on reopen.
  const fromT = tlines.length > 0;
  // Condition lives on returns_lines only, so a reopened return has to look it back up.
  // Matched by sku occurrence rather than line_no, which shifts as soon as a line is
  // split; a split child reuses its parent's, which is what it physically is.
  const condBySku = {};
  lines.forEach(l => { (condBySku[l.sku] = condBySku[l.sku] || []).push(l.condition || ''); });
  const seenC = {};
  const condFor = sku => {
    const arr = condBySku[sku] || [], n = (seenC[sku] = (seenC[sku] || 0) + 1);
    return arr[Math.min(n - 1, arr.length - 1)] || '';
  };
  // Pre-select the disposition from stage-1 condition (Resaleable→Credit, Faulty→Warranty).
  // First treatment only; on reopen keep the saved status. Always editable (can be refused).
  RT.tlines = (fromT ? tlines : lines).map((l, idx) => ({
    sku: l.sku, name: l.product_name, dc5: l.dc5 || '', qty: l.qty, reason: l.reason || '',
    return_status: l.return_status || (fromT ? '' : (DISPO_BY_CONDITION[l.condition] || '')),
    condition: fromT ? condFor(l.sku) : (l.condition || ''),
    credit_note: l.credit_note || '', processed_by: l.processed_by || '', processed_at: l.processed_at || null,
    moved: l.moved_to_location || '', _grp: 'g' + idx, _recv: Number(l.qty) || 0, _split: false, _sel: false }));
  // What was already resolved when this modal opened — the log only records real
  // changes, so reopening a return and pressing save must not invent history.
  RT.tsnap = RT.tlines.map(l => ({ sku: l.sku, return_status: l.return_status, credit_note: l.credit_note, processed_by: l.processed_by }));
  // Advanced when one box cannot honestly represent the lines: either the return is
  // part-finished, or its lines already carry different credit notes / different people.
  // Simple would overwrite their work the moment the next person typed a name.
  const distinctOf = k => new Set(RT.tlines.map(l => String(l[k] || '').trim()).filter(Boolean)).size;
  const mixed = distinctOf('credit_note') > 1 || distinctOf('processed_by') > 1;
  const partial = RT.tlines.some(rtLineResolved) && !RT.tlines.every(rtLineResolved);
  RT.tmode = (mixed || partial) ? 'advanced' : 'simple';
  // Two people finishing one return is now an expected flow, and the save REPLACES every
  // line — so a save built on a view opened before the other person's is a silent delete.
  // This is what the save checks against.
  RT.actStamp = r.updated_at || null;
  // In Advanced these two boxes are apply-tools, not the record — the lines are. Filling
  // them from the header would put the joined "24408; 24409" in a box whose job is to
  // write one value onto whatever is ticked. Blank also forces the second person to type
  // their own name, which is the point of the log.
  const advOpen = RT.tmode === 'advanced';
  $('rtActRef').value = advOpen ? '' : (r.treatment_ref || '');
  $('rtActBy').value = advOpen ? '' : (r.treated_by || '');
  $('rtActNotes').value = r.treatment_notes || '';
  $('rtActTitle').innerHTML = `Action — ${esc(r.return_no)} <span class="rt-step">① Created ▸ <b>② Processing</b></span>`;
  $('rtActStage1').innerHTML = `
    <div class="rt-kv-grid3">
      <div class="rt-kv"><span>Business</span><b>${esc(r.customer_name || '—')} ${r.customer_id ? '(' + esc(r.customer_id) + ')' : ''}</b></div>
      <div class="rt-kv"><span>Customer name</span><b>${esc(r.contact_name || '—')}</b></div>
      <div class="rt-kv"><span>Email</span><b>${esc(r.customer_email || '—')}</b></div>
      <div class="rt-kv"><span>Received by</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Warehouse</span><b>${esc(r.warehouse || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtDT(r.created_at)}</b></div>
      <div class="rt-kv"><span>Sales order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Invoice</span><b>${esc(r.invoice_number || '—')}</b></div>
      <div class="rt-kv"><span>Cust. ref</span><b>${esc(r.customer_reference || '—')}</b></div>
      <div class="rt-kv"><span>Rep</span><b>${esc(r.rep || '—')}</b></div>
    </div>
    <table class="rt-table" style="margin-top:6px"><thead><tr><th>5DC</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Reason</th><th>Condition</th></tr></thead>
    <tbody>${lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc((l.product_name || '').slice(0, 40))}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td><td>${esc(l.condition || '')}</td></tr>`).join('')}</tbody></table>`;
  rtSetMode(RT.tmode);   // renders, and sizes the columns to the mode
  RT.actDirtyBase = rtActFingerprint();   // baseline for the unsaved-changes guard
  $('rtActModal').classList.add('active');
}

// What "unsaved" means: only the values a save would actually write. Ticking a line,
// switching mode or re-rendering must never look like a change, or the guard cries wolf
// and people learn to click through it.
function rtActFingerprint() {
  return JSON.stringify({
    ref: ($('rtActRef').value || '').trim(),
    by: ($('rtActBy').value || '').trim(),
    notes: ($('rtActNotes').value || '').trim(),
    lines: RT.tlines.map(l => [l.sku, String(l.qty), l.return_status || '', l.credit_note || '', l.processed_by || '']),
  });
}
function rtActDirty() { return RT.actDirtyBase != null && rtActFingerprint() !== RT.actDirtyBase; }

// Cancel and × discarded a part-finished treatment without a word. Per-line credit notes
// are minutes of work; a stray click must not cost them silently.
function rtCloseAct(force) {
  if (!force && rtActDirty()) {
    const done = RT.tlines.filter(rtLineResolved).length, n = RT.tlines.length;
    $('rtDiscardMsg').innerHTML = `This return has changes that were never saved — <strong>${done} of ${n} line(s) ready</strong>.`
      + '<br />Use <strong>Save progress</strong> to keep them and leave the rest open for someone else.';
    $('rtDiscardModal').classList.add('active');
    return;
  }
  RT.actDirtyBase = null;
  $('rtActModal').classList.remove('active');
}
function rtDiscardClose() { $('rtDiscardModal').classList.remove('active'); }
function rtDiscardConfirm() { rtDiscardClose(); rtCloseAct(true); }
// A line is finished when it says what happened, and who decided. The credit note is
// only demanded where one actually gets raised — a refused return or a disposed warranty
// never produces one, and requiring it there would block the return forever.
const NEEDS_CREDIT_NOTE = 'Accepted for Credit Assessment';
function rtLineResolved(l) {
  if (!l.return_status || !String(l.processed_by || '').trim()) return false;
  if (l.return_status === NEEDS_CREDIT_NOTE && !String(l.credit_note || '').trim()) return false;
  return true;
}
function rtLineMissing(l) {
  const m = [];
  if (!l.return_status) m.push('status');
  if (l.return_status === NEEDS_CREDIT_NOTE && !String(l.credit_note || '').trim()) m.push('credit note');
  if (!String(l.processed_by || '').trim()) m.push('name');
  return m;
}

function rtSetMode(m) {
  RT.tmode = m;
  const adv = m === 'advanced';
  $('rtModeSimple').classList.toggle('is-on', !adv);
  $('rtModeAdv').classList.toggle('is-on', adv);
  document.querySelectorAll('#rtActModal .rt-advcol, #rtActModal .rt-selcol').forEach(el => { el.style.display = adv ? '' : 'none'; });
  $('rtApplyWrap').style.display = adv ? '' : 'none';
  const cnw = $('rtCreditNotesWrap'); if (cnw) cnw.style.display = adv ? '' : 'none';
  $('rtActRefLbl').innerHTML = adv ? 'Credit note # <span class="rt-hint" style="margin:0">(for selected)</span>' : 'Credit note #';
  $('rtActByLbl').innerHTML = adv ? 'Processed by <span class="rt-hint" style="margin:0">(for selected)</span>' : 'Processed by <span class="rt-req">*</span>';
  $('rtActRef').placeholder = adv ? 'e.g. 24408 — then Apply to selected' : 'e.g. 24408 — fills every line';
  $('rtActBy').placeholder = adv ? 'Type a name — then Apply to selected…' : 'Type a name — fills every line…';
  $('rtModeHint').textContent = adv
    ? 'Each line keeps its own credit note and name. Save progress and someone else can finish the rest.'
    : 'What you type above is written onto every line, as you type.';
  // Switching mode only shows and hides columns — it never writes. Cascading from here
  // meant clicking "Simple" replaced every per-line note and name with whatever the two
  // boxes happened to hold (usually blank), destroying the work with no undo.
  rtRenderTLines();
}

// Simple mode WRITES the header values onto every line rather than letting lines
// inherit them. Costs one assignment; buys a data model where every line states its
// own credit note and processor, so nothing downstream computes an effective value.
function rtCascade() {
  if (RT.tmode !== 'simple') return;
  const ref = ($('rtActRef').value || '').trim(), by = ($('rtActBy').value || '').trim();
  RT.tlines.forEach(l => { l.credit_note = ref; l.processed_by = by; });
  rtRenderTLines();
}
function rtApplySelected() {
  const sel = RT.tlines.filter(l => l._sel);
  if (!sel.length) return toast('Tick the lines to apply to first', 'err');
  const ref = ($('rtActRef').value || '').trim(), by = ($('rtActBy').value || '').trim();
  if (!ref && !by) return toast('Type a credit note or a name to apply', 'err');
  sel.forEach(l => { if (ref) l.credit_note = ref; if (by) l.processed_by = by; });
  rtRenderTLines();
  toast(`Applied to ${sel.length} line(s)`, 'ok');
}
function rtSelectAll(on) { RT.tlines.forEach(l => { l._sel = !!on; }); rtRenderTLines(); }
function rtTSelect(i, on) { RT.tlines[i]._sel = !!on; rtRenderTLines(); }

function rtRenderTLines() {
  const adv = RT.tmode === 'advanced';
  $('rtTLinesBody').innerHTML = RT.tlines.map((l, i) => {
    const grpN = RT.tlines.filter(x => x._grp === l._grp).length;   // >1 = this line was split
    const qtyEditable = grpN > 1;
    const done = rtLineResolved(l);
    // Only the positive flag. The "needs status + credit note + name" nag restated what
    // the empty fields already show, on every open line at once.
    const flagTxt = done ? 'ready' : '';
    return `<tr id="rtTRow${i}" class="${done ? 'rt-tl-done' : 'rt-tl-open'}">
    <td class="rt-selcol" style="${adv ? '' : 'display:none'}"><input type="checkbox" ${l._sel ? 'checked' : ''} onclick="rtTSelect(${i},this.checked)" /></td>
    <td class="rt-dc5-cell">${esc(l.dc5 || '')}</td>
    <td><strong>${esc(l.sku)}</strong><div class="sub">${esc((l.name || '').slice(0, 26))}${l.reason ? ' · ' + esc(l.reason) : ''}</div></td>
    <td class="rt-cond">${esc(l.condition || '—')}</td>
    <td><select class="rt-input" onchange="rtTSet(${i},'return_status',this.value)"><option value="">— status —</option>${RET_STATUSES.map(r => `<option ${l.return_status === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
        <div class="rt-tl-flag${done ? ' ok' : ''}" id="rtTFlag${i}" style="${flagTxt ? '' : 'display:none'}">${flagTxt}</div></td>
    <td class="rt-advcol" style="${adv ? '' : 'display:none'}"><input class="rt-input" value="${esc(l.credit_note || '')}" placeholder="${l.return_status === NEEDS_CREDIT_NOTE ? 'Required' : 'n/a'}" oninput="rtTSet(${i},'credit_note',this.value)" /></td>
    <td class="rt-advcol" style="${adv ? '' : 'display:none'}"><input class="rt-input" value="${esc(l.processed_by || '')}" placeholder="Name" oninput="rtTSet(${i},'processed_by',this.value)" />
        ${l.processed_at ? `<div class="sub">${fmtDT(l.processed_at)}</div>` : ''}</td>
    <td class="r">${qtyEditable ? `<input class="rt-input r" type="text" inputmode="numeric" value="${l.qty}" oninput="rtTSet(${i},'qty',this.value)" />` : `<span class="rt-frozen num">${l.qty}</span>`}</td>
    <td class="r"><button class="rt-line-x" title="Split for credit vs warranty" onclick="rtTSplit(${i})">⧉</button>${l._split ? `<button class="rt-line-x" title="Remove split" onclick="rtTRemove(${i})">×</button>` : ''}</td>
  </tr>`; }).join('');
  const done = RT.tlines.filter(rtLineResolved).length, n = RT.tlines.length;
  const el = $('rtLinesProgress');
  if (el) {
    el.textContent = n ? `${done} of ${n} line(s) ready${done < n ? ' — the rest can be finished later' : ''}` : '';
    el.className = 'rt-hint' + (n && done === n ? ' rt-hint-ok' : '');
  }
  const all = $('rtSelAll'); if (all) all.checked = n > 0 && RT.tlines.every(l => l._sel);
  rtUpdateCreditNotesView();
}
function rtTSet(i, k, v) {
  RT.tlines[i][k] = v;
  // A select can be re-rendered freely; the text inputs cannot — rebuilding the table
  // mid-word drops the caret. So patch just that row's flag, which is the only thing
  // that changed. Without this the row still read "needs credit note" after one was
  // typed, and only the counter above moved.
  if (k === 'return_status') rtRenderTLines(); else { rtRowFlag(i); rtUpdateProgress(); }
  if (k === 'credit_note') rtUpdateCreditNotesView();
}
function rtRowFlag(i) {
  const l = RT.tlines[i], row = $('rtTRow' + i), flag = $('rtTFlag' + i);
  if (!l || !row || !flag) return;
  const done = rtLineResolved(l);
  const txt = done ? 'ready' : '';
  row.className = done ? 'rt-tl-done' : 'rt-tl-open';
  flag.className = 'rt-tl-flag' + (done ? ' ok' : '');
  flag.textContent = txt;
  flag.style.display = txt ? '' : 'none';
}
function rtUpdateProgress() {
  const done = RT.tlines.filter(rtLineResolved).length, n = RT.tlines.length;
  const el = $('rtLinesProgress'); if (!el) return;
  el.textContent = n ? `${done} of ${n} line(s) ready${done < n ? ' — the rest can be finished later' : ''}` : '';
  el.className = 'rt-hint' + (n && done === n ? ' rt-hint-ok' : '');
}
// Read-only roll-up of the distinct credit notes across the lines — a return can carry
// several, and this shows all of them (chips) without opening each line.
function rtUpdateCreditNotesView() {
  const el = $('rtCreditNotesView'); if (!el) return;
  const notes = [...new Set(RT.tlines.map(l => String(l.credit_note || '').trim()).filter(Boolean))];
  el.classList.toggle('rt-cn-multi', notes.length > 1);
  el.innerHTML = notes.length
    ? notes.map(n => `<span class="cn-chip">${esc(n)}</span>`).join('')
    : '<span class="cn-none">— none yet</span>';
  el.title = notes.length > 1 ? `${notes.length} credit notes on this return`
    : (notes.length === 1 ? 'One credit note on file' : 'No credit note entered yet');
}
function rtTSplit(i) {
  const l = RT.tlines[i];
  if ((Number(l.qty) || 0) <= 1) return toast('Nothing to split — quantity is 1', 'err');
  // 1 unit peeled off for a separate status. Status and credit note are cleared on
  // purpose: the whole reason to split is that this unit gets a different outcome,
  // so carrying the parent's note over would be wrong more often than right.
  const child = { ...l, qty: 1, _split: true, return_status: '', credit_note: '', processed_at: null, _sel: false, moved: '' };
  l.qty = (Number(l.qty) || 0) - 1;
  RT.tlines.splice(i + 1, 0, child);
  rtRenderTLines();
}
function rtTRemove(i) {
  const l = RT.tlines[i];
  if (!l._split) return toast("Can't remove a received line — split it if you need to divide it", 'err');
  const sib = RT.tlines.find((x, j) => j !== i && x._grp === l._grp);   // give its qty back to the group
  if (sib) sib.qty = (Number(sib.qty) || 0) + (Number(l.qty) || 0);
  RT.tlines.splice(i, 1);
  rtRenderTLines();
}

// Complete is optional-treatment: warn before moving to History (esp. if untreated)
function rtAskComplete() {
  // Completion is now a property of the LINES, not of whoever happens to be clicking.
  // With lines finishable by different people at different times, "is this return done"
  // can only mean "is every line done" — otherwise a half-treated return walks off to
  // put-away and the open lines are never seen again.
  const open = RT.tlines.filter(l => !rtLineResolved(l));
  if (open.length) {
    const names = open.slice(0, 3).map(l => `${esc(l.sku)} (needs ${rtLineMissing(l).join(' + ')})`).join(', ');
    toast(`${open.length} line(s) not ready: ${names}${open.length > 3 ? '…' : ''}. Use Save progress and finish later.`, 'err');
    if (RT.tmode !== 'advanced') rtSetMode('advanced');   // show them what is missing
    return;
  }
  const people = [...new Set(RT.tlines.map(l => String(l.processed_by || '').trim()).filter(Boolean))];
  const notes = [...new Set(RT.tlines.map(l => String(l.credit_note || '').trim()).filter(Boolean))];
  $('rtCompleteMsg').innerHTML = 'Finish the office treatment and send it to the warehouse to <strong>put away</strong>?'
    + `<div class="rt-hint" style="margin-top:8px">${RT.tlines.length} line(s) · ${people.length > 1 ? 'processed by ' + esc(people.join(', ')) : 'processed by ' + esc(people[0] || '—')}`
    + `${notes.length > 1 ? ' · credit notes ' + esc(notes.join(', ')) : (notes[0] ? ' · credit note ' + esc(notes[0]) : '')}</div>`;
  $('rtCompleteModal').classList.add('active');
}
function rtCompleteClose() { $('rtCompleteModal').classList.remove('active'); }
function rtCompleteConfirm() { rtCompleteClose(); rtSaveAct(true); }

// Identity for the log. line_no shifts whenever a line is split, so it cannot be the
// key; sku plus its occurrence among same-sku lines survives splitting and reordering.
function rtLineKeys(list) {
  const seen = {};
  return list.map(l => { const n = (seen[l.sku] = (seen[l.sku] || 0) + 1); return `${l.sku}#${n}`; });
}

async function rtLogLines(returnId, byName) {
  const before = RT.tsnap || [], after = RT.tlines;
  const bk = rtLineKeys(before), ak = rtLineKeys(after);
  const prev = {}; before.forEach((l, i) => { prev[bk[i]] = l; });
  const events = [];
  after.forEach((l, i) => {
    const k = ak[i], b = prev[k];
    const push = (action, detail) => events.push({
      return_id: returnId, line_no: i + 1, sku: l.sku, action,
      detail, by_name: byName,
    });
    if (!b) { push('split', { qty: Number(l.qty) || 0 }); }
    else {
      if ((b.return_status || '') !== (l.return_status || '')) push('status', { from: b.return_status || null, to: l.return_status || null });
      if ((b.credit_note || '') !== (l.credit_note || '')) push('credit_note', { from: b.credit_note || null, to: l.credit_note || null });
    }
    const wasDone = b ? rtLineResolved(b) : false, isDone = rtLineResolved(l);
    if (isDone && !wasDone) push('resolved', { credit_note: l.credit_note || null, status: l.return_status || null, by: l.processed_by || null });
    if (!isDone && wasDone) push('reopened', { missing: rtLineMissing(l) });
  });
  if (!events.length) return;
  // Best-effort: a missing log table or a dropped connection must never fail a save
  // the office already believes went through.
  try { await sb().from('returns_line_log').insert(events); }
  catch (e) { console.warn('line log skipped:', e && e.message); }
}

async function rtSaveAct(complete) {
  const r = RT.actRow; if (!r) return;
  if (RT._saving) return;   // a second click, or Enter twice, would run the whole
                            // replace-lines sequence again against a half-applied table
  // Someone owns every save — it is the name the log is written under. It is NOT
  // borrowed from a line any more: with two people finishing one return, falling back
  // to whoever did the first half filed the second half under their name, which is
  // exactly the question the log exists to answer.
  const by = ($('rtActBy').value || '').trim();
  if (!by) { toast('Enter your name (Processed by) before saving', 'err'); return rtInvalid('rtActBy'); }
  // split quantities must add back up to what was received
  const grp = {};
  RT.tlines.forEach(l => { const g = grp[l._grp] || (grp[l._grp] = { recv: l._recv || 0, sum: 0, sku: l.sku }); g.sum += Number(l.qty) || 0; });
  const bad = Object.values(grp).find(g => g.sum !== g.recv);
  if (bad) return toast(`Split quantities for ${bad.sku} must add up to ${bad.recv} (received)`, 'err');
  RT._saving = true;
  const btns = ['rtActComplete', 'rtActSave'].map($).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  try {
    // Did anyone else save this return while it sat open? The write below replaces every
    // line, so a stale view does not merge — it deletes what is not on screen. Refusing
    // and asking for a reopen is the only honest answer without a transaction.
    const { data: cur } = await sb().from('returns_active').select('updated_at').eq('id', r.id).maybeSingle();
    if (cur && RT.actStamp && cur.updated_at && cur.updated_at !== RT.actStamp) {
      toast('Someone else saved this return while it was open. Close and reopen it to see their lines, then finish yours.', 'err');
      return;
    }
    const now = new Date().toISOString();
    const snapByKey = {}; const bk = rtLineKeys(RT.tsnap || []); (RT.tsnap || []).forEach((l, i) => { snapByKey[bk[i]] = l; });
    const ak = rtLineKeys(RT.tlines);
    const rows = RT.tlines.filter(l => l.sku).map((l, idx) => {
      const b = snapByKey[ak[idx]];
      // Stamp the moment a line first became ready, and keep it. Re-saving a return to
      // finish OTHER lines must not restamp the ones already done — that time is the
      // answer to "when was this line decided".
      const justResolved = rtLineResolved(l) && !(b && rtLineResolved(b));
      return {
        return_id: r.id, line_no: idx + 1, sku: l.sku, product_name: l.name,
        qty: Number(l.qty) || 0, reason: l.reason || null,
        return_status: l.return_status || null,
        credit_note: String(l.credit_note || '').trim() || null,
        processed_by: String(l.processed_by || '').trim() || null,
        processed_at: rtLineResolved(l) ? (justResolved ? now : (l.processed_at || now)) : null,
        unit_value: 0, line_value: 0,
      };
    });
    // Header mirrors the lines instead of holding a competing value of its own: with
    // several credit notes on one return, a single header field could only ever be one
    // of them, and History/CSV would quietly show the wrong one.
    const distinct = k => [...new Set(RT.tlines.map(l => String(l[k] || '').trim()).filter(Boolean))];
    const upd = {
      treatment_ref: distinct('credit_note').join('; ') || null,
      treatment_notes: ($('rtActNotes').value || '').trim() || null,
      treated_by: distinct('processed_by').join('; ') || by || null,
      status: complete ? 'to_putaway' : 'in_treatment',
      updated_at: now,
    };
    if (complete) upd.treated_at = now;
    // replace credit lines safely: insert new first, then drop the old ones by id
    const { data: oldT } = await sb().from('returns_treatment_lines').select('id').eq('return_id', r.id);
    const oldTIds = (oldT || []).map(o => o.id);
    let newIds = [];
    if (rows.length) {
      const { data: ins, error } = await sb().from('returns_treatment_lines').insert(rows).select('id');
      if (error) throw error;
      newIds = (ins || []).map(x => x.id);
    }
    if (oldTIds.length) {
      const { error: ed } = await sb().from('returns_treatment_lines').delete().in('id', oldTIds);
      // Two calls, no transaction. An unchecked delete used to mean a failure here left
      // the return carrying every line twice — silently, because PostgREST answers 204
      // even when a policy blocks the rows. Undo our own insert instead.
      if (ed) {
        if (newIds.length) await sb().from('returns_treatment_lines').delete().in('id', newIds);
        throw ed;
      }
    }
    // header LAST — a line failure above never leaves a wrong 'completed' status
    const { error: eu } = await sb().from('returns_active').update(upd).eq('id', r.id);
    if (eu) throw eu;
    await rtLogLines(r.id, by);
    const done = RT.tlines.filter(rtLineResolved).length, n = RT.tlines.length;
    toast(complete ? `${r.return_no} sent to put-away` : `Progress saved — ${done}/${n} line(s) ready${done < n ? ', the rest stay open' : ''}`, 'ok');
    RT.actDirtyBase = null;          // saved: closing is no longer a discard
    rtCloseAct(true); await loadReturns();
  } catch (e) { toast('Save failed: ' + e.message, 'err'); }
  finally { RT._saving = false; btns.forEach(b => { b.disabled = false; }); }
}

// ─── CSV export (History) — ONE ROW PER LINE. Each product on its own row, every field
// its own column, so there is no ambiguity about which SKU got which credit note or who
// processed it. 5DC / product / reason / condition come from the creation line; the
// disposition (return status / credit note / processed by) from the treatment line. ───
const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
function rtExportCsv() {
  const rows = rtHistoryFiltered();               // export exactly what the History filters show
  if (!rows.length) return toast('Nothing to export — adjust the History filters', 'err');
  const headers = ['Return #', 'Date', 'Status', 'Business', 'Account', 'Warehouse', 'Sales order', 'Invoice',
    '5DC', 'SKU', 'Product', 'Qty', 'Reason', 'Condition', 'Return status', 'Credit note',
    'Received by', 'Processed by', 'Processed date'];
  const out = [headers.map(csvCell).join(',')];
  let n = 0;
  rows.forEach(r => {
    const cl = (r.returns_lines || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
    const bySku = {}; cl.forEach(l => { if (!(l.sku in bySku)) bySku[l.sku] = l; });
    const tl = (r.returns_treatment_lines || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
    const usingT = tl.length > 0;                 // processed → one row per treatment line; else per creation line
    (usingT ? tl : cl).forEach(l => {
      const c = usingT ? (bySku[l.sku] || {}) : l; // 5DC / product / reason / condition from the creation line
      // Per-line credit note / processor when set (advanced); otherwise the return-level
      // value (simple, and pre-per-line returns where it only lived on the header).
      const credit = l.credit_note || r.treatment_ref || '';
      const proc = l.processed_by || r.treated_by || '';
      const procAt = l.processed_at || r.treated_at || '';
      out.push([
        r.return_no, fmtD(r.created_at), statusLabel(r.status), r.customer_name, r.customer_id, r.warehouse, r.origin_order, r.invoice_number,
        c.dc5 || '', l.sku, c.product_name || '', l.qty, c.reason || '', c.condition || '',
        l.return_status || '', credit, r.operator || '', proc, fmtD(procAt),
      ].map(csvCell).join(','));
      n++;
    });
  });
  const csv = '﻿' + out.join('\r\n');             // BOM so Excel reads UTF-8
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `returns_${stamp}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Exported ${n} line(s) across ${rows.length} return(s)`, 'ok');
}
