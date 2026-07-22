/*
 * Returns — Rapid LED. Warehouse ops return documents.
 * Client-side Supabase (anon). Customers from /api/customers (Cin7, cached).
 * Products from cin7_mirror. Flow: create -> (edit) -> action/treatment -> complete -> history.
 */
'use strict';

const RT = { customers: [], operators: [], lines: [], tlines: [], sel: null, active: [], history: [], prodTarget: null, editId: null, actRow: null, activePage: 1, histPage: 1, so: null, soLoadedNumber: null, voidId: null };
const PAGE_SIZE = 25;
const REASONS = ['Faulty', 'Product Left Over / Change of Mind', 'Incorrect Item Supplied', 'Incorrect Item Ordered', 'Freight Damage', 'Other'];
const CONDITIONS = ['Resaleable', 'Not Resaleable', 'Faulty'];                                   // warehouse assessment (internal)
const RET_STATUSES = ['Accepted for Credit Assessment', 'Accepted for Warranty Assessment', 'Return Not Accepted']; // printed on customer receipt
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const fmtDT = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return fmtD(iso); return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); };
const statusLabel = s => ({ pending: 'Pending', in_treatment: 'In treatment', completed: 'Completed', void: 'Voided' }[s] || s);
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
(async function init() {
  try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
  if (!sb()) { $('rtSub').textContent = 'Supabase not available'; return; }
  await Promise.all([loadCustomers(), loadOperators(), loadReturns()]);
  document.addEventListener('click', e => {
    if (!e.target.closest('.rt-cust')) $('rtCustAc').classList.remove('show');
    if (!e.target.closest('.rt-oper')) $('rtOperatorAc') && $('rtOperatorAc').classList.remove('show');
    if (!e.target.closest('.rt-actby')) $('rtActByAc') && $('rtActByAc').classList.remove('show');
    if (!e.target.closest('.rt-prod-cell') && !e.target.closest('.rt-dc5-cell') && !e.target.closest('#rtProdAc')) $('rtProdAc').style.display = 'none';
  });
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
    RT.operators = [...new Set((r.data || []).map(o => o.name || o.operator || o.operator_name).filter(Boolean))].sort();
    $('rtOperators').innerHTML = RT.operators.map(o => `<option value="${esc(o)}">`).join('');
  } catch (_) {}
}
async function loadReturns() {
  try {
    const r = await sb().from('returns_active').select('*, returns_lines(sku,product_name,qty,reason,condition,line_no,line_value), returns_treatment_lines(sku,qty,line_value,line_no,return_status)').order('created_at', { ascending: false });
    const rows = r.data || [];
    RT.active = rows.filter(x => x.status !== 'completed' && x.status !== 'void');
    RT.history = rows.filter(x => x.status === 'completed' || x.status === 'void');   // voided kept here for audit
    RT.activePage = 1; RT.histPage = 1;
    $('rtSub').textContent = `${RT.active.length} active · ${RT.history.length} in history`;
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
  let rows = RT.active;
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.customer_id || ''} ${r.origin_order || ''} ${r.operator || ''}`.toLowerCase().includes(q));
  $('rtActiveCount').textContent = `${rows.length} return(s)`;
  const pg = paginate(rows, RT.activePage); rows = pg.slice; $('rtActivePager').innerHTML = pagerHtml('active', pg);
  $('rtActiveBody').innerHTML = rows.map(r => `<tr class="rt-row" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtDT(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td class="num" style="color:#5b6b86">${esc(r.customer_id || '—')}</td>
    <td>${esc(r.origin_order || '—')}</td>
    <td>${esc(r.operator || '—')}</td>
    <td class="r num">${(r.returns_lines || []).length}</td>
    <td class="rt-status ${r.status}">${statusLabel(r.status)}</td>
    <td class="r rt-actions" onclick="event.stopPropagation()">
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm" onclick="rtEdit('${r.id}')">Edit</button>` : ''}
      <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      <button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtAction('${r.id}')">Action</button>
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm rt-btn-danger" onclick="rtVoid('${r.id}')">Void</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="9" class="rt-empty">No active returns. Click “+ New return” to create one.</td></tr>';
}
function rtRenderHistory() {
  const q = ($('rtHistSearch').value || '').toLowerCase();
  let rows = RT.history;
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.treatment_ref || ''}`.toLowerCase().includes(q));
  $('rtHistCount').textContent = `${rows.length} completed`;
  const pg = paginate(rows, RT.histPage); rows = pg.slice; $('rtHistPager').innerHTML = pagerHtml('history', pg);
  $('rtHistBody').innerHTML = rows.map(r => `<tr class="rt-row ${r.status === 'void' ? 'rt-row-void' : ''}" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtDT(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td>${esc(r.treatment_ref || '—')}</td>
    <td class="r num">${rtCredit(r) ? '$' + money(rtCredit(r)) : '—'}</td>
    <td>${r.status === 'void' ? '—' : (fmtD(r.treated_at) + (r.treated_by ? ' · ' + esc(r.treated_by) : ''))}</td>
    <td class="rt-status ${r.status}">${statusLabel(r.status)}</td>
    <td class="r rt-actions" onclick="event.stopPropagation()">
      <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print form</button>
      <button class="rt-btn rt-btn-sm" onclick="rtView('${r.id}')">View</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="8" class="rt-empty">Nothing in history yet.</td></tr>';
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
  $('rtNotes').value = row ? (row.notes || '') : '';
  if (row) {
    const r = await sb().from('returns_lines').select('*').eq('return_id', row.id).order('line_no');
    RT.lines = (r.data || []).map(l => ({ sku: l.sku, name: l.product_name, dc5: l.dc5, qty: l.qty, reason: l.reason || '', condition: l.condition || '', return_status: l.return_status || '', unit: l.unit_value }));
  }
  if (!RT.lines.length) { RT.lines = [{ sku: '', name: '', dc5: '', qty: '', reason: '', condition: '', return_status: '', unit: 0 }]; }   // start with ONE line; user clicks "+ Add line" for more
  rtRenderLines();
  $('rtNewModal').classList.add('active');
}
function rtCloseNew() { $('rtNewModal').classList.remove('active'); }

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
      ac.innerHTML = (r.data || []).map(p => `<div class="rt-ac-item" onclick='rtPickProd(${JSON.stringify(p).replace(/'/g, "&#39;")})'><strong>${esc(p.sku)}</strong>${p.attribute1 ? ` <span class="sub">5DC ${esc(p.attribute1)}</span>` : ''}<div class="sub">${esc((p.name || '').slice(0, 60))}${p.price_tier1 != null ? ' · $' + money(p.price_tier1) : ''}</div></div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
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
      ac.innerHTML = (r.data || []).map(p => `<div class="rt-ac-item" onclick='rtPickProd(${JSON.stringify(p).replace(/'/g, "&#39;")})'><strong>5DC ${esc(p.attribute1)}</strong> <span class="sub">${esc(p.sku)}</span><div class="sub">${esc((p.name || '').slice(0, 60))}${p.price_tier1 != null ? ' · $' + money(p.price_tier1) : ''}</div></div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
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
  RT.lines.forEach(l => l._invalid = false);
  const withSku = RT.lines.filter(l => l.sku);
  const lines = withSku.filter(l => (Number(l.qty) || 0) > 0 && l.reason && l.condition);
  if (!name) { toast('Pick the business from the list (Cin7)', 'err'); return rtInvalid('rtCustName'); }
  if (!contact) { toast('Enter the customer name (contact)', 'err'); return rtInvalid('rtContact'); }
  if (!operator) { toast('Enter who received it (Received by)', 'err'); return rtInvalid('rtOperator'); }
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
      origin_order: ($('rtOrigin').value || '').trim() || null, operator, notes: ($('rtNotes').value || '').trim() || null,
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
    const lineRows = lines.map((l, idx) => ({ return_id: id, line_no: idx + 1, sku: l.sku, product_name: l.name, dc5: l.dc5 || null, qty: Number(l.qty) || 0, reason: l.reason || null, condition: l.condition || null, unit_value: Number(l.unit) || 0, line_value: (Number(l.qty) || 0) * (Number(l.unit) || 0) }));
    const { error: e2 } = await sb().from('returns_lines').insert(lineRows); if (e2) throw e2;
    if (oldLineIds.length) await sb().from('returns_lines').delete().in('id', oldLineIds);   // safe: new rows already in
    toast(`${return_no} ${RT.editId ? 'updated' : 'created'}`, 'ok');
    const wasNew = !RT.editId; rtCloseNew(); await loadReturns();
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
    <td class="r num">${money(l.price)}</td>
    <td class="r"><button class="rt-rm" title="Remove line" onclick="rtSoRemove(${i})">×</button></td>
  </tr>`).join('') || '<tr><td colspan="8" class="rt-empty">No items left — close and add manually.</td></tr>';
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
async function rtView(id) {
  const r = rtHdr(id); if (!r) return;
  const [ln, tl] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
  ]);
  const lines = ln.data || [], tlines = tl.data || [];
  const rowsC = lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc(l.product_name || '')}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td><td>${esc(l.condition || '')}</td></tr>`).join('');
  const treatBlock = (r.status === 'completed' || r.status === 'in_treatment') ? `
    <div class="rt-sec-title">Treatment</div>
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Credit note #</span><b>${esc(r.treatment_ref || '—')}</b></div>
      <div class="rt-kv"><span>Warehouse</span><b>${esc(r.warehouse || '—')}</b></div>
      <div class="rt-kv"><span>Emailed</span><b>${esc(r.customer_emailed || '—')}</b></div>
      <div class="rt-kv"><span>Moved to</span><b>${esc(r.treatment_location_notes || '—')}</b></div>
      <div class="rt-kv"><span>Treated by</span><b>${esc(r.treated_by || '—')} ${r.treated_at ? '· ' + fmtD(r.treated_at) : ''}</b></div>
      ${r.treatment_notes ? `<div class="rt-kv" style="grid-column:1/-1"><span>Notes</span><b>${esc(r.treatment_notes)}</b></div>` : ''}
    </div>
    ${tlines.length ? `<table class="rt-table" style="margin-top:8px"><thead><tr><th>SKU</th><th>Return status</th><th class="r">Qty</th><th>Reason</th><th class="r">Credit $</th><th>Moved to</th></tr></thead><tbody>${tlines.map(t => `<tr><td>${esc(t.sku)}</td><td>${esc(t.return_status || '')}</td><td class="r">${t.qty}</td><td>${esc(t.reason || '')}</td><td class="r num">${money(t.line_value)}</td><td>${esc(t.moved_to_location || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ` : '';
  $('rtViewBody').innerHTML = `
    <div class="rt-view-head">
      <div><div class="rt-view-no">${esc(r.return_no)}</div><div class="rt-status ${r.status}" style="display:inline-block">${statusLabel(r.status)}</div></div>
      <div><button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm" onclick="rtCloseView();rtEdit('${r.id}')">Edit</button>` : ''}
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtCloseView();rtAction('${r.id}')">Action</button>` : ''}
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm rt-btn-danger" onclick="rtCloseView();rtVoid('${r.id}')">Void</button>` : ''}</div>
    </div>
    ${r.status === 'void' ? `<div class="rt-void-banner">⊘ Voided${r.voided_at ? ' · ' + fmtD(r.voided_at) : ''}${r.voided_by ? ' · by ' + esc(r.voided_by) : ''}${r.void_reason ? ' — ' + esc(r.void_reason) : ''}</div>` : ''}
    <div class="rt-sec-title">Creation</div>
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Business</span><b>${esc(r.customer_name || '—')}</b></div>
      <div class="rt-kv"><span>Contact</span><b>${esc(r.contact_name || '—')}</b></div>
      <div class="rt-kv"><span>Account</span><b>${esc(r.customer_id || '—')}</b></div>
      <div class="rt-kv"><span>Email</span><b>${esc(r.customer_email || '—')}</b></div>
      <div class="rt-kv"><span>Rep</span><b>${esc(r.rep || '—')}</b></div>
      <div class="rt-kv"><span>Invoice</span><b>${esc(r.invoice_number || '—')}</b></div>
      <div class="rt-kv"><span>Sales order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Cust. reference</span><b>${esc(r.customer_reference || '—')}</b></div>
      <div class="rt-kv"><span>Received by</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtDT(r.created_at)}</b></div>
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
  $('rtVoidReason').value = ''; $('rtVoidBy').value = '';
  $('rtVoidModal').classList.add('active');
  setTimeout(() => { try { $('rtVoidReason').focus(); } catch (_) {} }, 50);
}
function rtVoidClose() { $('rtVoidModal').classList.remove('active'); }
async function rtVoidConfirm() {
  const reason = ($('rtVoidReason').value || '').trim();
  const btn = $('rtVoidBtn'); btn.disabled = true;
  try {
    const { error } = await sb().from('returns_active').update({ status: 'void', void_reason: reason || null, voided_by: ($('rtVoidBy').value || '').trim() || null, voided_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', RT.voidId);
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
  RT.tlines = (fromT ? tlines : lines).map((l, idx) => ({ sku: l.sku, name: l.product_name, dc5: l.dc5 || '', qty: l.qty, reason: l.reason || '', return_status: l.return_status || '', unit: fromT ? (l.unit_value != null ? l.unit_value : '') : '', moved: l.moved_to_location || '', _grp: 'g' + idx, _recv: Number(l.qty) || 0, _split: false }));
  $('rtActRef').value = r.treatment_ref || '';
  $('rtActMoved').value = r.treatment_location_notes || '';
  $('rtActNotes').value = r.treatment_notes || '';
  $('rtActBy').value = r.treated_by || '';
  $('rtActEmailed').value = r.customer_emailed || '';
  $('rtActWarehouse').value = r.warehouse || '';
  $('rtActTitle').innerHTML = `Action — ${esc(r.return_no)} <span class="rt-step">① Created ▸ <b>② Treatment</b></span>`;
  $('rtActStage1').innerHTML = `
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Business</span><b>${esc(r.customer_name || '—')} ${r.customer_id ? '(' + esc(r.customer_id) + ')' : ''}</b></div>
      <div class="rt-kv"><span>Contact</span><b>${esc(r.contact_name || '—')}</b></div>
      <div class="rt-kv"><span>Email</span><b>${esc(r.customer_email || '—')}</b></div>
      <div class="rt-kv"><span>Rep</span><b>${esc(r.rep || '—')}</b></div>
      <div class="rt-kv"><span>Invoice</span><b>${esc(r.invoice_number || '—')}</b></div>
      <div class="rt-kv"><span>Sales order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Cust. reference</span><b>${esc(r.customer_reference || '—')}</b></div>
      <div class="rt-kv"><span>Received by</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtDT(r.created_at)}</b></div>
    </div>
    <table class="rt-table" style="margin-top:6px"><thead><tr><th>5DC</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Reason</th><th>Condition</th></tr></thead>
    <tbody>${lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc((l.product_name || '').slice(0, 40))}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td><td>${esc(l.condition || '')}</td></tr>`).join('')}</tbody></table>`;
  rtRenderTLines();
  $('rtActModal').classList.add('active');
}
function rtCloseAct() { $('rtActModal').classList.remove('active'); }
function rtRenderTLines() {
  $('rtTLinesBody').innerHTML = RT.tlines.map((l, i) => {
    const grpN = RT.tlines.filter(x => x._grp === l._grp).length;   // >1 = this line was split
    const qtyEditable = grpN > 1;
    return `<tr>
    <td class="rt-dc5-cell">${esc(l.dc5 || '')}</td>
    <td><strong>${esc(l.sku)}</strong><div class="sub">${esc((l.name || '').slice(0, 26))}</div></td>
    <td><select class="rt-input" onchange="rtTSet(${i},'return_status',this.value)"><option value="">— status —</option>${RET_STATUSES.map(r => `<option ${l.return_status === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="rt-frozen">${esc(l.reason || '—')}</td>
    <td class="r">${qtyEditable ? `<input class="rt-input r" type="number" min="0" step="1" value="${l.qty}" oninput="rtTSet(${i},'qty',this.value)" />` : `<span class="rt-frozen num">${l.qty}</span>`}</td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="0.01" value="${l.unit}" oninput="rtTSet(${i},'unit',this.value)" /></td>
    <td class="r num">${money((Number(l.qty) || 0) * (Number(l.unit) || 0))}</td>
    <td><input class="rt-input" placeholder="e.g. Returns / Faulty" value="${esc(l.moved)}" oninput="rtTSet(${i},'moved',this.value)" /></td>
    <td class="r"><button class="rt-line-x" title="Split for credit vs warranty" onclick="rtTSplit(${i})">⧉</button>${l._split ? `<button class="rt-line-x" title="Remove split" onclick="rtTRemove(${i})">×</button>` : ''}</td>
  </tr>`; }).join('');
  $('rtTTotal').textContent = money(RT.tlines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit) || 0), 0));
}
function rtTSet(i, k, v) { RT.tlines[i][k] = v; if (k === 'qty' || k === 'unit') rtRenderTLines(); }
function rtTSplit(i) {
  const l = RT.tlines[i];
  if ((Number(l.qty) || 0) <= 1) return toast('Nothing to split — quantity is 1', 'err');
  const child = { ...l, qty: 1, _split: true, return_status: '', moved: '' };   // 1 unit peeled off for a separate status
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
  const by = ($('rtActBy').value || '').trim();
  if (!by) { toast('Enter who treated it (Treated by)', 'err'); return rtInvalid('rtActBy'); }
  $('rtCompleteMsg').innerHTML = 'Complete this return and move it to <strong>History</strong>?';
  $('rtCompleteModal').classList.add('active');
}
function rtCompleteClose() { $('rtCompleteModal').classList.remove('active'); }
function rtCompleteConfirm() { rtCompleteClose(); rtSaveAct(true); }

async function rtSaveAct(complete) {
  const r = RT.actRow; if (!r) return;
  const by = ($('rtActBy').value || '').trim();
  if (complete && !by) return toast('Enter who treated it (Treated by)', 'err');   // only Treated by is required
  // split quantities must add back up to what was received
  const grp = {};
  RT.tlines.forEach(l => { const g = grp[l._grp] || (grp[l._grp] = { recv: l._recv || 0, sum: 0, sku: l.sku }); g.sum += Number(l.qty) || 0; });
  const bad = Object.values(grp).find(g => g.sum !== g.recv);
  if (bad) return toast(`Split quantities for ${bad.sku} must add up to ${bad.recv} (received)`, 'err');
  const btn = $('rtActComplete'); btn.disabled = true;
  try {
    const upd = {
      treatment_ref: ($('rtActRef').value || '').trim() || null,
      treatment_location_notes: ($('rtActMoved').value || '').trim() || null,
      treatment_notes: ($('rtActNotes').value || '').trim() || null,
      customer_emailed: ($('rtActEmailed').value || '') || null,
      warehouse: ($('rtActWarehouse').value || '').trim() || null,
      treated_by: by || null,
      status: complete ? 'completed' : 'in_treatment',
      updated_at: new Date().toISOString(),
    };
    if (complete) upd.treated_at = new Date().toISOString();
    // replace credit lines safely: insert new first, then drop the old ones by id
    const { data: oldT } = await sb().from('returns_treatment_lines').select('id').eq('return_id', r.id);
    const oldTIds = (oldT || []).map(o => o.id);
    const rows = RT.tlines.filter(l => l.sku).map((l, idx) => ({ return_id: r.id, line_no: idx + 1, sku: l.sku, product_name: l.name, qty: Number(l.qty) || 0, reason: l.reason || null, return_status: l.return_status || null, unit_value: Number(l.unit) || 0, line_value: (Number(l.qty) || 0) * (Number(l.unit) || 0), moved_to_location: l.moved || null }));
    if (rows.length) { const { error } = await sb().from('returns_treatment_lines').insert(rows); if (error) throw error; }
    if (oldTIds.length) await sb().from('returns_treatment_lines').delete().in('id', oldTIds);
    // header LAST — a line failure above never leaves a wrong 'completed' status
    const { error: eu } = await sb().from('returns_active').update(upd).eq('id', r.id);
    if (eu) throw eu;
    toast(complete ? `${r.return_no} completed` : 'Progress saved', 'ok');
    rtCloseAct(); await loadReturns();
  } catch (e) { toast('Save failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}

// ─── CSV export (History) — mirrors the team's credit-note sheet + our detail ───
const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const rtProductsStr = r => (r.returns_lines || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0)).map(l => {
  const extra = [l.reason, l.condition].filter(Boolean).join(' / ');
  return `${l.qty}× ${l.sku}${extra ? ' (' + extra + ')' : ''}`;
}).join(' | ');
const rtStatuses = r => [...new Set((r.returns_treatment_lines || []).map(t => t.return_status).filter(Boolean))].join('; ');
const rtQtyTotal = r => (r.returns_lines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
function rtExportCsv() {
  const rows = RT.history;
  if (!rows.length) return toast('No completed returns to export', 'err');
  const headers = ['Date', 'Return #', 'Business', 'Contact', 'Account', 'Email', 'Warehouse', 'Rep', 'Invoice', 'Sales order', 'Cust. reference', 'Products (qty × sku / reason / condition)', 'Total Qty', 'Credit Note', 'Return status', 'Emailed', 'Received by', 'Treated by', 'Treated Date', 'Credit $', 'Comments', 'Treatment Notes'];
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(r => lines.push([
    fmtD(r.created_at), r.return_no, r.customer_name, r.contact_name, r.customer_id, r.customer_email, r.warehouse, r.rep, r.invoice_number, r.origin_order, r.customer_reference,
    rtProductsStr(r), rtQtyTotal(r), r.treatment_ref, rtStatuses(r), r.customer_emailed, r.operator, r.treated_by, fmtD(r.treated_at),
    rtCredit(r) ? money(rtCredit(r)) : '', r.notes, r.treatment_notes,
  ].map(csvCell).join(',')));
  const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `returns_export_${stamp}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Exported ${rows.length} return(s)`, 'ok');
}
