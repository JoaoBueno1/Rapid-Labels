/*
 * Returns — Rapid LED. Warehouse ops return documents.
 * Client-side Supabase (anon) like Collections. Customers come from the
 * same-origin /api/customers (Cin7, cached). Products from cin7_mirror.
 * Increment 1: Active tab + New (create) + PDF. Treatment/History next.
 */
'use strict';

const RT = { customers: [], operators: [], lines: [], sel: null, active: [], history: [], prodTarget: null };
const REASONS = ['Faulty', 'Change of mind', 'Wrong item', 'Warranty', 'Damaged in transit', 'Other'];
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const sb = () => window.supabase;

function toast(msg, kind) { const el = document.createElement('div'); el.className = 'rt-toast ' + (kind || ''); el.textContent = msg; $('rtToast').appendChild(el); setTimeout(() => el.remove(), 3500); }

// ─── Init ───
(async function init() {
  try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
  if (!sb()) { $('rtSub').textContent = 'Supabase not available'; return; }
  await Promise.all([loadCustomers(), loadOperators(), loadReturns()]);
  $('rtSub').textContent = `${RT.active.length} active · ${RT.history.length} completed`;
  document.addEventListener('click', e => {
    if (!e.target.closest('.rt-cust')) $('rtCustAc').classList.remove('show');
    if (!e.target.closest('.rt-prod-cell') && !e.target.closest('#rtProdAc')) $('rtProdAc').style.display = 'none';
  });
})();

async function loadCustomers() {
  try { const r = await fetch('/api/customers'); const j = await r.json(); RT.customers = j.customers || []; }
  catch (_) { RT.customers = []; }
}
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
    rtRenderActive(); rtRenderHistory();
  } catch (e) { toast('Could not load returns: ' + e.message, 'err'); }
}

// ─── Tabs ───
function rtTab(t) {
  document.querySelectorAll('.rt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $('rtActive').style.display = t === 'active' ? '' : 'none';
  $('rtHistory').style.display = t === 'history' ? '' : 'none';
}

// ─── Render lists ───
function rtRenderActive() {
  const q = ($('rtSearch').value || '').toLowerCase();
  let rows = RT.active;
  if (q) rows = rows.filter(r => `${r.return_no} ${r.customer_name || ''} ${r.customer_id || ''} ${r.origin_order || ''} ${r.operator || ''}`.toLowerCase().includes(q));
  $('rtActiveCount').textContent = `${rows.length} return(s)`;
  $('rtActiveBody').innerHTML = rows.map(r => `<tr>
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtD(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td class="num" style="font-size:11px;color:#7a8aa2">${esc(r.customer_id || '—')}</td>
    <td>${esc(r.origin_order || '—')}</td>
    <td>${esc(r.operator || '—')}</td>
    <td class="r num">${(r.returns_lines || []).length}</td>
    <td><span class="rt-pill ${r.status}">${r.status.replace('_', ' ')}</span></td>
    <td class="r">
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
  $('rtHistBody').innerHTML = rows.map(r => `<tr>
    <td class="num"><strong>${esc(r.return_no)}</strong></td>
    <td>${fmtD(r.created_at)}</td>
    <td>${esc(r.customer_name || '—')}</td>
    <td>${esc(r.treatment_ref || '—')}</td>
    <td>${fmtD(r.treated_at)}</td>
    <td class="r">
      <button class="rt-btn rt-btn-sm" onclick="rtPrint('${r.id}')">Print</button>
      <button class="rt-btn rt-btn-sm" onclick="rtAction('${r.id}')">View</button>
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="rt-empty">No completed returns yet.</td></tr>';
}

// ─── New / create ───
function rtOpenNew() {
  RT.sel = null; RT.lines = [];
  $('rtCustName').value = ''; $('rtCustId').value = ''; $('rtOrigin').value = ''; $('rtOperator').value = ''; $('rtNotes').value = '';
  rtAddLine(); rtAddLine();
  $('rtNewModal').classList.add('active');
}
function rtCloseNew() { $('rtNewModal').classList.remove('active'); }

// customer autocomplete
function rtCustInput() {
  const q = ($('rtCustName').value || '').trim().toLowerCase();
  const ac = $('rtCustAc');
  if (q.length < 2) { ac.classList.remove('show'); return; }
  const hits = RT.customers.filter(c => c.name.toLowerCase().includes(q)).slice(0, 12);
  ac.innerHTML = hits.map(c => `<div class="rt-ac-item" onclick='rtPickCust(${JSON.stringify(c).replace(/'/g, "&#39;")})'>${esc(c.name)}${c.code ? `<span class="sub"> · ${esc(c.code)}</span>` : ''}</div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
  ac.classList.add('show');
  RT.sel = null; $('rtCustId').value = '';
}
function rtPickCust(c) {
  RT.sel = c;
  $('rtCustName').value = c.name;
  $('rtCustId').value = c.id || '';
  $('rtCustAc').classList.remove('show');
}

// lines
function rtAddLine(dup) {
  RT.lines.push(dup ? { ...dup } : { sku: '', name: '', dc5: '', qty: 1, reason: '', unit: 0 });
  rtRenderLines();
}
function rtRemoveLine(i) { RT.lines.splice(i, 1); rtRenderLines(); }
function rtRenderLines() {
  $('rtLinesBody').innerHTML = RT.lines.map((l, i) => `<tr>
    <td class="rt-prod-cell" style="position:relative">
      <input class="rt-input" placeholder="SKU / name / 5DC" value="${esc(l.name ? l.sku + ' — ' + l.name : (l.sku || ''))}"
             oninput="rtProdInput(${i}, this)" onfocus="rtProdInput(${i}, this)" autocomplete="off" />
    </td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="1" value="${l.qty}" oninput="rtLineSet(${i},'qty',this.value)" /></td>
    <td><select class="rt-input" onchange="rtLineSet(${i},'reason',this.value)">
      <option value="">— reason —</option>
      ${REASONS.map(r => `<option ${l.reason === r ? 'selected' : ''}>${r}</option>`).join('')}
    </select></td>
    <td class="r"><input class="rt-input r" type="number" min="0" step="0.01" value="${l.unit}" oninput="rtLineSet(${i},'unit',this.value)" /></td>
    <td class="r num">${money((Number(l.qty) || 0) * (Number(l.unit) || 0))}</td>
    <td class="r"><button class="rt-line-x" title="Duplicate line" onclick="rtAddLine(RT.lines[${i}])">⧉</button>
        <button class="rt-line-x" title="Remove" onclick="rtRemoveLine(${i})">×</button></td>
  </tr>`).join('');
  const total = RT.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit) || 0), 0);
  $('rtTotal').textContent = money(total);
}
function rtLineSet(i, k, v) { RT.lines[i][k] = v; if (k === 'qty' || k === 'unit') rtRenderLines(); }

// product autocomplete (floating)
let _prodTimer = null;
function rtProdInput(i, inp) {
  RT.prodTarget = { i, inp };
  const q = (inp.value || '').trim();
  const ac = $('rtProdAc');
  const rect = inp.getBoundingClientRect();
  ac.style.left = rect.left + 'px'; ac.style.top = (rect.bottom + 2) + 'px'; ac.style.width = rect.width + 'px';
  if (q.length < 2) { ac.style.display = 'none'; return; }
  clearTimeout(_prodTimer);
  _prodTimer = setTimeout(async () => {
    try {
      const like = `%${q}%`;
      const r = await sb().schema('cin7_mirror').from('products')
        .select('sku,name,attribute1,price_tier1')
        .or(`sku.ilike.${like},name.ilike.${like},attribute1.ilike.${like}`).limit(8);
      const hits = r.data || [];
      ac.innerHTML = hits.map(p => `<div class="rt-ac-item" onclick='rtPickProd(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        <strong>${esc(p.sku)}</strong>${p.attribute1 ? ` <span class="sub">5DC ${esc(p.attribute1)}</span>` : ''}
        <div class="sub">${esc((p.name || '').slice(0, 60))}${p.price_tier1 != null ? ' · $' + money(p.price_tier1) : ''}</div>
      </div>`).join('') || '<div class="rt-ac-item" style="color:#9aa6ba">No match</div>';
      ac.style.display = 'block';
    } catch (e) { ac.style.display = 'none'; }
  }, 200);
}
function rtPickProd(p) {
  const t = RT.prodTarget; if (!t) return;
  const l = RT.lines[t.i];
  l.sku = p.sku; l.name = p.name || ''; l.dc5 = p.attribute1 || '';
  if (!l.unit || Number(l.unit) === 0) l.unit = p.price_tier1 != null ? Number(p.price_tier1) : 0;
  $('rtProdAc').style.display = 'none';
  rtRenderLines();
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
    const { data: hdr, error: e1 } = await sb().from('returns_active').insert({
      customer_name: name,
      customer_id: RT.sel ? RT.sel.id : ($('rtCustId').value || null),
      origin_order: ($('rtOrigin').value || '').trim() || null,
      operator, notes: ($('rtNotes').value || '').trim() || null,
      status: 'pending',
    }).select('id,return_no').single();
    if (e1) throw e1;
    const lineRows = lines.map((l, idx) => ({
      return_id: hdr.id, line_no: idx + 1, sku: l.sku, product_name: l.name, dc5: l.dc5 || null,
      qty: Number(l.qty) || 0, reason: l.reason || null,
      unit_value: Number(l.unit) || 0, line_value: (Number(l.qty) || 0) * (Number(l.unit) || 0),
    }));
    const { error: e2 } = await sb().from('returns_lines').insert(lineRows);
    if (e2) throw e2;
    toast(`${hdr.return_no} created`, 'ok');
    rtCloseNew();
    await loadReturns();
    rtPrint(hdr.id);
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  } finally { btn.disabled = false; btn.textContent = 'Save & print'; }
}

function rtPrint(id) { window.open('returns_doc.html?id=' + encodeURIComponent(id) + '&v=20260717a', '_blank'); }

function rtAction(id) {
  toast('Treatment flow is the next increment — creation + print is live now.', '');
}
