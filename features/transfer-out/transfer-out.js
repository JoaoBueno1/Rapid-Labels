/*
 * Transfer Out — list open transfers leaving Main, open one into an editable staging
 * table (lines + pickbay, add/edit/remove), then print a pickbay-ordered sheet.
 * Lines come from the server (/api/transfer-out/*, Cin7 key stays server-side); the
 * pickbay (products.stock_locator) + destination address come from cin7_mirror (anon).
 */
'use strict';

const TO = { list: [], sel: null, lines: [] };
const MAIN = 'Main Warehouse';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sb = () => window.supabase;
const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
const cls = s => String(s || '').toLowerCase().replace(/\s+/g, '-');
function toast(msg, kind) { const el = document.createElement('div'); el.className = 'toast ' + (kind || 'info'); el.textContent = msg; $('toasts').appendChild(el); setTimeout(() => el.remove(), 3500); }

(async function init() {
  try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
  if (!sb()) { $('sub').textContent = 'Supabase not available'; return; }
  await TO.load();
})();

TO.load = async function () {
  $('rows').innerHTML = '<tr><td colspan="6" class="empty">Loading transfers…</td></tr>';
  try {
    // Same source the home dashboard uses: cin7_mirror.order_pipeline, type='TR'.
    let rows = [], from = 0;
    for (;;) {
      const { data, error } = await sb().schema('cin7_mirror').from('order_pipeline')
        .select('id,number,from_location,to_location,status,order_date,reference,line_count,type')
        .eq('type', 'TR').eq('from_location', MAIN).range(from, from + 999);
      if (error) throw error;
      rows = rows.concat(data || []);
      if (!data || data.length < 1000) break; from += 1000;
    }
    // "Open" = still going out (not completed / voided)
    const open = s => !['COMPLETED', 'VOIDED', 'CANCELLED'].includes(String(s || '').toUpperCase());
    TO.list = rows.filter(r => open(r.status));
    $('sub').textContent = `${TO.list.length} open transfer(s) out of Main`;
    TO.render();
  } catch (e) { $('rows').innerHTML = `<tr><td colspan="6" class="empty">Could not load: ${esc(e.message)}</td></tr>`; }
};

TO.render = function () {
  const q = ($('q').value || '').toLowerCase();
  const sf = $('status').value;
  let rows = TO.list.slice();
  if (sf) rows = rows.filter(r => String(r.status).toUpperCase() === sf);
  if (q) rows = rows.filter(r => `${r.number} ${r.to_location || ''} ${r.reference || ''}`.toLowerCase().includes(q));
  // IN TRANSIT first, then ORDERED, newest date first
  const ord = { 'IN TRANSIT': 0, 'ORDERED': 1 };
  rows.sort((a, b) => ((ord[a.status] ?? 9) - (ord[b.status] ?? 9)) || String(b.order_date || '').localeCompare(a.order_date || ''));
  $('count').textContent = `${rows.length} shown`;
  if (!rows.length) { $('rows').innerHTML = '<tr><td colspan="6" class="empty">No open transfers out. Use “Find in Cin7” if one was just created.</td></tr>'; return; }
  $('rows').innerHTML = rows.map(r => `<tr class="row" onclick='TO.open(${JSON.stringify(r).replace(/'/g, "&#39;")})'>
    <td class="tr-num">${esc(r.number || '—')}${r._live ? '<span class="src-live">live</span>' : ''}</td>
    <td class="to">${esc(r.to_location || '—')}</td>
    <td><span class="badge ${cls(r.status)}">${esc(r.status || '—')}</span></td>
    <td>${esc(fmtD(r.order_date))}</td>
    <td class="num">${r.line_count != null ? r.line_count : '—'}</td>
    <td class="r"><button class="btn sm primary" onclick="event.stopPropagation();TO.open(${JSON.stringify(r).replace(/'/g, "&#39;")})">Open</button></td>
  </tr>`).join('');
};

// ── open a TR into the shared editable staging modal ──
TO.open = function (row) { return TOStaging.open(row); };
TO._openOld = async function (row) {   // superseded by the shared TOStaging module (kept dead)
  TO.sel = row; TO.lines = [];
  $('mDest').textContent = String(row.to_location || '—').replace(/\s+Warehouse$/i, '');
  $('mMeta').innerHTML = `<b>${esc(row.number || '')}</b> · ${esc(row.status || '')} · ${esc(fmtD(row.order_date))} · loading lines…`;
  $('stRows').innerHTML = '<tr><td colspan="6" class="empty"><span class="spin"></span> Loading lines from Cin7…</td></tr>';
  $('mask').classList.add('on'); document.body.style.overflow = 'hidden';
  try {
    const j = await (await fetch('/api/transfer-out/detail/' + encodeURIComponent(row.id))).json();
    if (!j.success) throw new Error(j.error || 'detail failed');
    const lines = j.lines || [];
    // enrich with pickbay + 5DC from the mirror
    const skus = [...new Set(lines.map(l => l.sku).filter(Boolean))];
    const map = {};
    if (skus.length) {
      const { data } = await sb().schema('cin7_mirror').from('products').select('sku,attribute1,stock_locator,name').in('sku', skus);
      (data || []).forEach(p => { map[p.sku] = p; });
    }
    TO.lines = lines.map(l => {
      const p = map[l.sku] || {};
      return { dc: p.attribute1 || '', code: l.sku, product: l.product_name || p.name || '', qty: l.qty, loc: p.stock_locator || '', _manual: false };
    });
    // destination address from the mirror (best-effort)
    TO.toAddr = await TO.lookupAddr(row.to_location);
    TO.sortLines();
    $('mMeta').innerHTML = `<b>${esc(row.number || '')}</b> · ${esc(row.status || '')} · ${esc(fmtD(row.order_date))} · ${TO.lines.length} lines`;
    TO.renderStaging();
  } catch (e) {
    $('stRows').innerHTML = `<tr><td colspan="6" class="empty">Could not load lines: ${esc(e.message)}</td></tr>`;
  }
};

TO.lookupAddr = async function (name) {
  try {
    const { data } = await sb().schema('cin7_mirror').from('locations').select('*').ilike('name', String(name || '').trim()).limit(1);
    const l = (data || [])[0]; if (!l) return '';
    return [l.address_line1, l.address_city, [l.address_state, l.address_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  } catch (_) { return ''; }
};

TO.sortLines = function () {
  const key = l => (l.loc && l.loc.trim()) ? l.loc.trim() : '~~~';   // blanks last
  TO.lines.sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true }));
};
TO.sort = function () { TO.sortLines(); TO.renderStaging(); toast('Sorted by pickbay', 'info'); };

TO.renderStaging = function () {
  const units = TO.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  $('mTot').textContent = `${TO.lines.length} lines · ${units} units`;
  $('stRows').innerHTML = TO.lines.map((l, i) => `<tr class="${l._manual ? 'manual' : ''}">
    <td class="cdc"><input value="${esc(l.dc)}" oninput="TO.set(${i},'dc',this.value)" /></td>
    <td class="ccode"><input value="${esc(l.code)}" oninput="TO.set(${i},'code',this.value)" /></td>
    <td><input value="${esc(l.product)}" oninput="TO.set(${i},'product',this.value)" /></td>
    <td class="cqty"><input value="${esc(l.qty)}" inputmode="numeric" oninput="TO.set(${i},'qty',this.value)" /></td>
    <td class="cloc"><input value="${esc(l.loc)}" placeholder="pickbay" oninput="TO.set(${i},'loc',this.value)" /></td>
    <td><button class="rm" title="Remove" onclick="TO.remove(${i})">×</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">No lines. Click “+ Add line”.</td></tr>';
};
TO.set = function (i, k, v) { if (TO.lines[i]) { TO.lines[i][k] = v; if (k === 'qty') { const u = TO.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0); $('mTot').textContent = `${TO.lines.length} lines · ${u} units`; } } };
TO.addLine = function () { TO.lines.push({ dc: '', code: '', product: '', qty: '', loc: '', _manual: true }); TO.renderStaging(); const b = $('modal-body'); };
TO.remove = function (i) { TO.lines.splice(i, 1); TO.renderStaging(); };
TO.close = function () { $('mask').classList.remove('on'); document.body.style.overflow = ''; };

// ── print: guarantee pickbay order, hand the staged lines to the print sheet ──
TO.print = function () {
  if (!TO.lines.length) { toast('Nothing to print', 'err'); return; }
  TO.sortLines();
  const r = TO.sel || {};
  const data = {
    tr: r.number || '', to_name: String(r.to_location || '').replace(/\s+Warehouse$/i, ''),
    to_addr: TO.toAddr || '', date: fmtD(r.order_date),
    lines: TO.lines.map(l => ({ dc: l.dc, code: l.code, product: l.product, qty: l.qty, loc: l.loc })),
  };
  try { sessionStorage.setItem('transferOutPrint', JSON.stringify(data)); } catch (_) {}
  window.open('transfer_out_print.html', '_blank');
};

// ── live Cin7 search (for a transfer the mirror/webhook hasn't caught yet) ──
TO.liveSearch = async function () {
  const q = ($('live').value || '').trim();
  if (!q) return;
  toast('Searching Cin7…', 'info');
  try {
    const j = await (await fetch('/api/transfer-out/search?q=' + encodeURIComponent(q))).json();
    if (!j.success) throw new Error(j.error || 'search failed');
    const outFromMain = (j.results || []).filter(t => t.from_location === MAIN);
    if (!outFromMain.length) { toast('No Main-out transfer found for “' + q + '”', 'err'); return; }
    let added = 0;
    outFromMain.forEach(t => {
      if (!TO.list.some(x => x.id === t.id)) { TO.list.unshift({ ...t, line_count: null, type: 'TR', _live: true }); added++; }
    });
    TO.render();
    toast(added ? `Added ${added} from Cin7` : 'Already in the list', 'ok');
  } catch (e) { toast('Search failed: ' + e.message, 'err'); }
};
