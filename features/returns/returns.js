/*
 * Returns — Rapid LED. Warehouse ops return documents.
 * Client-side Supabase (anon). Customers from /api/customers (Cin7, cached).
 * Products from cin7_mirror. Flow: create -> (edit) -> action/treatment -> complete -> history.
 */
'use strict';

const RT = { customers: [], operators: [], lines: [], tlines: [], sel: null, active: [], history: [], prodTarget: null, editId: null, actRow: null };
const REASONS = ['Faulty', 'Change of mind', 'Wrong item', 'Warranty', 'Damaged in transit', 'Other'];
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const statusLabel = s => ({ pending: 'Pending', in_treatment: 'In treatment', completed: 'Completed' }[s] || s);
const sb = () => window.supabase;
function toast(msg, kind) { const el = document.createElement('div'); el.className = 'rt-toast ' + (kind || ''); el.textContent = msg; $('rtToast').appendChild(el); setTimeout(() => el.remove(), 3500); }

// ─── Init ───
(async function init() {
  try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
  if (!sb()) { $('rtSub').textContent = 'Supabase not available'; return; }
  await Promise.all([loadCustomers(), loadOperators(), loadReturns()]);
  document.addEventListener('click', e => {
    if (!e.target.closest('.rt-cust')) $('rtCustAc').classList.remove('show');
    if (!e.target.closest('.rt-prod-cell') && !e.target.closest('#rtProdAc')) $('rtProdAc').style.display = 'none';
  });
})();

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
    const r = await sb().from('returns_active').select('*, returns_lines(id)').order('created_at', { ascending: false });
    const rows = r.data || [];
    RT.active = rows.filter(x => x.status !== 'completed');
    RT.history = rows.filter(x => x.status === 'completed');
    $('rtSub').textContent = `${RT.active.length} active · ${RT.history.length} completed`;
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
  $('rtActiveBody').innerHTML = rows.map(r => `<tr class="rt-row" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtD(r.created_at)}</td>
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
    </td>
  </tr>`).join('') || '<tr><td colspan="9" class="rt-empty">No active returns. Click “+ New return” to create one.</td></tr>';
}
function rtRenderHistory() {
  const q = ($('rtHistSearch').value || '').toLowerCase();
  let rows = RT.history;
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.treatment_ref || ''}`.toLowerCase().includes(q));
  $('rtHistCount').textContent = `${rows.length} completed`;
  $('rtHistBody').innerHTML = rows.map(r => `<tr class="rt-row" onclick="rtView('${r.id}')">
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtD(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td>${esc(r.treatment_ref || '—')}</td>
    <td>${fmtD(r.treated_at)}</td>
    <td class="r rt-actions" onclick="event.stopPropagation()">
      <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      <button class="rt-btn rt-btn-sm" onclick="rtView('${r.id}')">View</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="rt-empty">No completed returns yet.</td></tr>';
}
function rtHdr(id) { return RT.active.concat(RT.history).find(r => r.id === id); }

// ─── Create / Edit ───
function rtOpenNew() { rtOpenForm(null); }
async function rtEdit(id) { rtOpenForm(rtHdr(id)); }
async function rtOpenForm(row) {
  RT.editId = row ? row.id : null; RT.sel = null; RT.lines = [];
  $('rtFormTitle').textContent = row ? `Edit return ${row.return_no}` : 'New return';
  $('rtSaveBtn').textContent = row ? 'Save changes' : 'Save & print';
  $('rtCustName').value = row ? (row.customer_name || '') : '';
  $('rtCustId').value = row ? (row.customer_id || '') : '';
  if (row) RT.sel = { name: row.customer_name, code: row.customer_id };
  $('rtOrigin').value = row ? (row.origin_order || '') : '';
  $('rtOperator').value = row ? (row.operator || '') : '';
  $('rtNotes').value = row ? (row.notes || '') : '';
  if (row) {
    const r = await sb().from('returns_lines').select('*').eq('return_id', row.id).order('line_no');
    RT.lines = (r.data || []).map(l => ({ sku: l.sku, name: l.product_name, dc5: l.dc5, qty: l.qty, reason: l.reason || '', unit: l.unit_value }));
  }
  if (!RT.lines.length) { RT.lines = [{ sku: '', name: '', dc5: '', qty: 1, reason: '', unit: 0 }, { sku: '', name: '', dc5: '', qty: 1, reason: '', unit: 0 }]; }
  rtRenderLines();
  $('rtNewModal').classList.add('active');
}
function rtCloseNew() { $('rtNewModal').classList.remove('active'); }

function rtCustInput() {
  const q = ($('rtCustName').value || '').trim().toLowerCase(); const ac = $('rtCustAc');
  if (q.length < 2) { ac.classList.remove('show'); return; }
  const hits = RT.customers.filter(c => c.name.toLowerCase().includes(q)).slice(0, 12);
  ac.innerHTML = hits.map(c => `<div class="rt-ac-item" onclick='rtPickCust(${JSON.stringify(c).replace(/'/g, "&#39;")})'>${esc(c.name)}${c.code ? `<span class="sub"> · ${esc(c.code)}</span>` : ''}</div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
  ac.classList.add('show'); RT.sel = null; $('rtCustId').value = '';
}
function rtPickCust(c) { RT.sel = c; $('rtCustName').value = c.name; $('rtCustId').value = c.code || ''; $('rtCustAc').classList.remove('show'); }

function rtAddLine(dup) { RT.lines.push(dup ? { ...dup } : { sku: '', name: '', dc5: '', qty: 1, reason: '', unit: 0 }); rtRenderLines(); }
function rtRemoveLine(i) { RT.lines.splice(i, 1); rtRenderLines(); }
function rtRenderLines() {
  $('rtLinesBody').innerHTML = RT.lines.map((l, i) => `<tr>
    <td class="rt-prod-cell" style="position:relative">
      <input class="rt-input" placeholder="SKU / name / 5DC" value="${esc(l.name ? l.sku + ' — ' + l.name : (l.sku || ''))}" oninput="rtProdInput(${i}, this)" onfocus="rtProdInput(${i}, this)" autocomplete="off" /></td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="1" value="${l.qty}" oninput="rtLineSet(${i},'qty',this.value)" /></td>
    <td><select class="rt-input" onchange="rtLineSet(${i},'reason',this.value)"><option value="">— reason —</option>${REASONS.map(r => `<option ${l.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="0.01" value="${l.unit}" oninput="rtLineSet(${i},'unit',this.value)" /></td>
    <td class="r num">${money((Number(l.qty) || 0) * (Number(l.unit) || 0))}</td>
    <td class="r"><button class="rt-line-x" title="Duplicate" onclick="rtAddLine(RT.lines[${i}])">⧉</button><button class="rt-line-x" title="Remove" onclick="rtRemoveLine(${i})">×</button></td>
  </tr>`).join('');
  $('rtTotal').textContent = money(RT.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit) || 0), 0));
}
function rtLineSet(i, k, v) { RT.lines[i][k] = v; if (k === 'qty' || k === 'unit') rtRenderLines(); }

let _prodTimer = null;
function rtProdInput(i, inp) {
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
  if (!l.unit || Number(l.unit) === 0) l.unit = p.price_tier1 != null ? Number(p.price_tier1) : 0;
  $('rtProdAc').style.display = 'none'; rtRenderLines();
}

async function rtSaveNew() {
  const name = ($('rtCustName').value || '').trim();
  const operator = ($('rtOperator').value || '').trim();
  const lines = RT.lines.filter(l => l.sku && (Number(l.qty) || 0) > 0);
  if (!name) return toast('Pick a customer', 'err');
  if (!operator) return toast('Enter the operator', 'err');
  if (!lines.length) return toast('Add at least one product line', 'err');
  const btn = $('rtSaveBtn'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const hdr = {
      customer_name: name, customer_id: (RT.sel ? RT.sel.code : ($('rtCustId').value || '')) || null,
      origin_order: ($('rtOrigin').value || '').trim() || null, operator, notes: ($('rtNotes').value || '').trim() || null,
    };
    let id, return_no;
    if (RT.editId) {
      await sb().from('returns_active').update({ ...hdr, updated_at: new Date().toISOString() }).eq('id', RT.editId);
      await sb().from('returns_lines').delete().eq('return_id', RT.editId);
      id = RT.editId; return_no = (rtHdr(RT.editId) || {}).return_no;
    } else {
      const { data, error } = await sb().from('returns_active').insert({ ...hdr, status: 'pending' }).select('id,return_no').single();
      if (error) throw error; id = data.id; return_no = data.return_no;
    }
    const lineRows = lines.map((l, idx) => ({ return_id: id, line_no: idx + 1, sku: l.sku, product_name: l.name, dc5: l.dc5 || null, qty: Number(l.qty) || 0, reason: l.reason || null, unit_value: Number(l.unit) || 0, line_value: (Number(l.qty) || 0) * (Number(l.unit) || 0) }));
    const { error: e2 } = await sb().from('returns_lines').insert(lineRows); if (e2) throw e2;
    toast(`${return_no} ${RT.editId ? 'updated' : 'created'}`, 'ok');
    const wasNew = !RT.editId; rtCloseNew(); await loadReturns();
    if (wasNew) rtPrint(id);
  } catch (e) { toast('Save failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}

function rtPrint(id) { window.open('returns_doc.html?id=' + encodeURIComponent(id) + '&v=20260717c', '_blank'); }

// ─── View (consult) ───
async function rtView(id) {
  const r = rtHdr(id); if (!r) return;
  const [ln, tl] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
  ]);
  const lines = ln.data || [], tlines = tl.data || [];
  const rowsC = lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc(l.product_name || '')}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td></tr>`).join('');
  const treatBlock = (r.status === 'completed' || r.status === 'in_treatment') ? `
    <div class="rt-sec-title">Treatment</div>
    <div class="rt-kv"><span>Treatment ref</span><b>${esc(r.treatment_ref || '—')}</b></div>
    <div class="rt-kv"><span>Moved to</span><b>${esc(r.treatment_location_notes || '—')}</b></div>
    <div class="rt-kv"><span>Treated by</span><b>${esc(r.treated_by || '—')} ${r.treated_at ? '· ' + fmtD(r.treated_at) : ''}</b></div>
    ${r.treatment_notes ? `<div class="rt-kv"><span>Notes</span><b>${esc(r.treatment_notes)}</b></div>` : ''}
    ${tlines.length ? `<table class="rt-table" style="margin-top:8px"><thead><tr><th>SKU</th><th class="r">Qty</th><th>Reason</th><th class="r">Credit $</th><th>Moved to</th></tr></thead><tbody>${tlines.map(t => `<tr><td>${esc(t.sku)}</td><td class="r">${t.qty}</td><td>${esc(t.reason || '')}</td><td class="r num">${money(t.line_value)}</td><td>${esc(t.moved_to_location || '')}</td></tr>`).join('')}</tbody></table>` : ''}
  ` : '';
  $('rtViewBody').innerHTML = `
    <div class="rt-view-head">
      <div><div class="rt-view-no">${esc(r.return_no)}</div><div class="rt-status ${r.status}" style="display:inline-block">${statusLabel(r.status)}</div></div>
      <div><button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      ${r.status === 'pending' ? `<button class="rt-btn rt-btn-sm" onclick="rtCloseView();rtEdit('${r.id}')">Edit</button>` : ''}
      ${r.status !== 'completed' ? `<button class="rt-btn rt-btn-sm rt-btn-primary" onclick="rtCloseView();rtAction('${r.id}')">Action</button>` : ''}</div>
    </div>
    <div class="rt-sec-title">Creation</div>
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Customer</span><b>${esc(r.customer_name || '—')}</b></div>
      <div class="rt-kv"><span>Customer ID</span><b>${esc(r.customer_id || '—')}</b></div>
      <div class="rt-kv"><span>Origin order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Operator</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtD(r.created_at)}</b></div>
      ${r.notes ? `<div class="rt-kv" style="grid-column:1/-1"><span>Notes</span><b>${esc(r.notes)}</b></div>` : ''}
    </div>
    <table class="rt-table" style="margin-top:8px"><thead><tr><th>5DC</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Reason</th></tr></thead><tbody>${rowsC}</tbody></table>
    ${treatBlock}`;
  $('rtViewModal').classList.add('active');
}
function rtCloseView() { $('rtViewModal').classList.remove('active'); }

// ─── Action / Treatment ───
async function rtAction(id) {
  const r = rtHdr(id); if (!r) return; RT.actRow = r;
  const [ln, tl] = await Promise.all([
    sb().from('returns_lines').select('*').eq('return_id', id).order('line_no'),
    sb().from('returns_treatment_lines').select('*').eq('return_id', id).order('line_no'),
  ]);
  const lines = ln.data || [], tlines = tl.data || [];
  RT.stageLines = lines;
  // credit lines: existing treatment lines, or seed from stage-1
  RT.tlines = (tlines.length ? tlines : lines).map(l => ({ sku: l.sku, name: l.product_name, qty: l.qty, reason: l.reason || '', unit: l.unit_value != null ? l.unit_value : 0, moved: l.moved_to_location || '' }));
  $('rtActRef').value = r.treatment_ref || '';
  $('rtActMoved').value = r.treatment_location_notes || '';
  $('rtActNotes').value = r.treatment_notes || '';
  $('rtActBy').value = r.treated_by || '';
  $('rtActTitle').innerHTML = `Action — ${esc(r.return_no)} <span class="rt-step">① Created ▸ <b>② Treatment</b></span>`;
  $('rtActStage1').innerHTML = `
    <div class="rt-kv-grid">
      <div class="rt-kv"><span>Customer</span><b>${esc(r.customer_name || '—')} ${r.customer_id ? '(' + esc(r.customer_id) + ')' : ''}</b></div>
      <div class="rt-kv"><span>Origin order</span><b>${esc(r.origin_order || '—')}</b></div>
      <div class="rt-kv"><span>Operator</span><b>${esc(r.operator || '—')}</b></div>
      <div class="rt-kv"><span>Created</span><b>${fmtD(r.created_at)}</b></div>
    </div>
    <table class="rt-table" style="margin-top:6px"><thead><tr><th>5DC</th><th>SKU</th><th>Description</th><th class="r">Qty</th><th>Reason</th></tr></thead>
    <tbody>${lines.map(l => `<tr><td>${esc(l.dc5 || '')}</td><td><strong>${esc(l.sku)}</strong></td><td>${esc((l.product_name || '').slice(0, 40))}</td><td class="r">${l.qty}</td><td>${esc(l.reason || '')}</td></tr>`).join('')}</tbody></table>`;
  rtRenderTLines();
  $('rtActModal').classList.add('active');
}
function rtCloseAct() { $('rtActModal').classList.remove('active'); }
function rtRenderTLines() {
  $('rtTLinesBody').innerHTML = RT.tlines.map((l, i) => `<tr>
    <td><strong>${esc(l.sku)}</strong><div class="sub">${esc((l.name || '').slice(0, 34))}</div></td>
    <td><input class="rt-input" value="${esc(l.reason)}" oninput="rtTSet(${i},'reason',this.value)" /></td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="1" value="${l.qty}" oninput="rtTSet(${i},'qty',this.value)" /></td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="0.01" value="${l.unit}" oninput="rtTSet(${i},'unit',this.value)" /></td>
    <td class="r num">${money((Number(l.qty) || 0) * (Number(l.unit) || 0))}</td>
    <td><input class="rt-input" placeholder="e.g. Returns / Faulty" value="${esc(l.moved)}" oninput="rtTSet(${i},'moved',this.value)" /></td>
    <td class="r"><button class="rt-line-x" title="Split (duplicate)" onclick="rtTSplit(${i})">⧉</button><button class="rt-line-x" title="Remove" onclick="rtTRemove(${i})">×</button></td>
  </tr>`).join('');
  $('rtTTotal').textContent = money(RT.tlines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit) || 0), 0));
}
function rtTSet(i, k, v) { RT.tlines[i][k] = v; if (k === 'qty' || k === 'unit') rtRenderTLines(); }
function rtTSplit(i) { RT.tlines.splice(i + 1, 0, { ...RT.tlines[i] }); rtRenderTLines(); }
function rtTRemove(i) { RT.tlines.splice(i, 1); rtRenderTLines(); }

async function rtSaveAct(complete) {
  const r = RT.actRow; if (!r) return;
  const by = ($('rtActBy').value || '').trim();
  if (complete && !by) return toast('Enter who treated it (Treated by)', 'err');
  const btn = complete ? $('rtActComplete') : $('rtActSave'); btn.disabled = true;
  try {
    const upd = {
      treatment_ref: ($('rtActRef').value || '').trim() || null,
      treatment_location_notes: ($('rtActMoved').value || '').trim() || null,
      treatment_notes: ($('rtActNotes').value || '').trim() || null,
      treated_by: by || null,
      status: complete ? 'completed' : 'in_treatment',
      updated_at: new Date().toISOString(),
    };
    if (complete) upd.treated_at = new Date().toISOString();
    await sb().from('returns_active').update(upd).eq('id', r.id);
    // replace treatment (credit) lines
    await sb().from('returns_treatment_lines').delete().eq('return_id', r.id);
    const rows = RT.tlines.filter(l => l.sku).map((l, idx) => ({ return_id: r.id, line_no: idx + 1, sku: l.sku, product_name: l.name, qty: Number(l.qty) || 0, reason: l.reason || null, unit_value: Number(l.unit) || 0, line_value: (Number(l.qty) || 0) * (Number(l.unit) || 0), moved_to_location: l.moved || null }));
    if (rows.length) { const { error } = await sb().from('returns_treatment_lines').insert(rows); if (error) throw error; }
    toast(complete ? `${r.return_no} completed` : 'Progress saved', 'ok');
    rtCloseAct(); await loadReturns();
  } catch (e) { toast('Save failed: ' + e.message, 'err'); } finally { btn.disabled = false; }
}
