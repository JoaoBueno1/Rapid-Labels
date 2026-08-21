/*
 * Transfer Out — shared staging + print. Load on ANY page that has window.supabase
 * (it injects its own modal + styles). Call:  TOStaging.open(row)
 *   row = { id, number, to_location, status, order_date }
 * Rules: ORDER lines are LOCKED (only their Location is editable, never deletable);
 * ADD-lines (non-stock) are fully editable + removable. On print it is re-sorted by
 * pickbay and handed to transfer_out_print.html via localStorage.
 */
(function () {
  const PRINT_URL = '/features/transfer-out/transfer_out_print.html';
  const KEY = 'transferOutPrint';
  const st = { sel: null, lines: [], toAddr: '' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
  const $ = id => document.getElementById(id);
  const sbc = () => window.supabase;

  const CSS = `
   .tost-mask{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;align-items:center;justify-content:center;padding:16px}
   .tost-mask.on{display:flex}
   .tost-modal{background:#fff;border-radius:14px;width:100%;max-width:1080px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.3);font-family:"Segoe UI",Arial,sans-serif;color:#0f172a}
   .tost-hd{padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:14px}
   .tost-hd .dest{font-size:24px;font-weight:800}
   .tost-hd .meta{font-size:13px;color:#64748b}
   .tost-hd .x{margin-left:auto;background:none;border:none;font-size:22px;cursor:pointer;color:#64748b}
   .tost-tools{padding:10px 20px;border-bottom:1px solid #e2e8f0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
   .tost-btn{padding:7px 12px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;font-size:13px;font-weight:600;cursor:pointer;color:#0f172a}
   .tost-btn:hover{border-color:#94a3b8}
   .tost-btn.primary{background:#2563eb;color:#fff;border-color:#2563eb}
   .tost-btn.add{background:#ecfdf5;border-color:#a7f3d0;color:#047857;font-weight:700;font-size:14px}
   .tost-btn.add:hover{background:#d1fae5}
   .tost-hint{color:#64748b;font-size:12px;margin-left:auto;max-width:420px}
   .tost-body{flex:1;overflow:auto}
   .tost-tbl{width:100%;border-collapse:collapse;font-size:13px}
   .tost-tbl th{position:sticky;top:0;background:#f8fafc;padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:#64748b;border-bottom:1px solid #e2e8f0;z-index:1}
   .tost-tbl td{padding:5px 8px;border-bottom:1px solid #eef2f7;vertical-align:middle}
   .tost-tbl td.ro{color:#334155}
   .tost-tbl .dc{width:80px;text-align:center;font-weight:600}
   .tost-tbl .code{width:150px;font-family:Consolas,monospace;font-weight:600}
   .tost-tbl .qty{width:60px;text-align:center;font-weight:700}
   .tost-tbl .locw{width:150px}
   .tost-inp{width:100%;padding:6px 8px;border:1px solid transparent;border-radius:6px;font-size:13px;background:transparent;font-family:inherit}
   .tost-inp:hover{border-color:#e2e8f0}
   .tost-inp:focus{border-color:#2563eb;background:#fff;outline:none;box-shadow:0 0 0 2px rgba(37,99,235,.12)}
   .tost-inp.loc{font-family:Consolas,monospace}
   .tost-tbl tr.manual td{background:#fffbeb}
   .tost-tbl tr.manual td:first-child{box-shadow:inset 3px 0 0 #f59e0b}
   .tost-tag{font-size:9px;background:#fde68a;color:#92400e;padding:1px 6px;border-radius:5px;margin-left:6px;font-weight:700;vertical-align:middle}
   .tost-rm{background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#ef4444;cursor:pointer;font-size:15px;width:26px;height:26px;line-height:1}
   .tost-lock{color:#cbd5e1;font-size:13px}
   .tost-ft{padding:12px 20px;border-top:1px solid #e2e8f0;display:flex;gap:10px;align-items:center}
   .tost-ft .tot{color:#64748b;font-size:13px;margin-right:auto}
   .tost-spin{display:inline-block;width:16px;height:16px;border:2px solid #cbd5e1;border-top-color:#2563eb;border-radius:50%;animation:tostsp .8s linear infinite;vertical-align:middle}
   @keyframes tostsp{to{transform:rotate(360deg)}}
   .tost-empty{text-align:center;color:#94a3b8;padding:24px}`;

  function ensureDom() {
    if ($('tostMask')) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="tost-mask" id="tostMask">
      <div class="tost-modal">
        <div class="tost-hd"><div><div class="dest" id="tostDest">—</div><div class="meta" id="tostMeta">—</div></div><button class="x" onclick="TOStaging.close()">×</button></div>
        <div class="tost-tools">
          <button class="tost-btn add" onclick="TOStaging.add()">＋ Add a line</button>
          <button class="tost-btn" onclick="TOStaging.sort()">⇅ Sort by pickbay</button>
          <span class="tost-hint">Order lines are locked — only their <b>Location</b> is editable. Use <b>Add a line</b> for anything extra (non-stock) — free to type, removable.</span>
        </div>
        <div class="tost-body"><table class="tost-tbl"><thead><tr>
          <th class="dc">5DC</th><th class="code">Rapid Code</th><th>Product</th><th class="qty">Qty</th><th class="locw">Location</th><th style="width:40px"></th>
        </tr></thead><tbody id="tostRows"></tbody></table></div>
        <div class="tost-ft"><span class="tot" id="tostTot"></span><button class="tost-btn" onclick="TOStaging.close()">Cancel</button><button class="tost-btn primary" onclick="TOStaging.print()">🖨️ Print</button></div>
      </div></div>`;
    document.body.appendChild(wrap.firstElementChild);
  }

  async function open(row) {
    ensureDom();
    st.sel = row; st.lines = []; st.toAddr = '';
    $('tostDest').textContent = String(row.to_location || '—').replace(/\s+Warehouse$/i, '');
    $('tostMeta').innerHTML = `<b>${esc(row.number || '')}</b> · ${esc(row.status || '')} · ${esc(fmtD(row.order_date))} · loading…`;
    $('tostRows').innerHTML = `<tr><td colspan="6" class="tost-empty"><span class="tost-spin"></span> Loading lines from Cin7…</td></tr>`;
    $('tostMask').classList.add('on'); document.body.style.overflow = 'hidden';
    try {
      const j = await (await fetch('/api/transfer-out/detail/' + encodeURIComponent(row.id))).json();
      if (!j.success) throw new Error(j.error || 'detail failed');
      const lines = j.lines || [];
      const skus = [...new Set(lines.map(l => l.sku).filter(Boolean))];
      const map = {};
      if (skus.length && sbc()) {
        const { data } = await sbc().schema('cin7_mirror').from('products').select('sku,attribute1,stock_locator,name').in('sku', skus);
        (data || []).forEach(p => { map[p.sku] = p; });
      }
      st.lines = lines.map(l => { const p = map[l.sku] || {}; return { dc: p.attribute1 || '', code: l.sku, product: l.product_name || p.name || '', qty: l.qty, loc: p.stock_locator || '', _manual: false }; });
      st.toAddr = await lookupAddr(row.to_location);
      sortLines();
      $('tostMeta').innerHTML = `<b>${esc(row.number || '')}</b> · ${esc(row.status || '')} · ${esc(fmtD(row.order_date))} · ${st.lines.length} lines`;
      render();
    } catch (e) { $('tostRows').innerHTML = `<tr><td colspan="6" class="tost-empty">Could not load lines: ${esc(e.message)}</td></tr>`; }
  }

  async function lookupAddr(name) {
    try {
      if (!sbc()) return '';
      const { data } = await sbc().schema('cin7_mirror').from('locations').select('*').ilike('name', String(name || '').trim()).limit(1);
      const l = (data || [])[0]; if (!l) return '';
      return [l.address_line1, l.address_city, [l.address_state, l.address_postcode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    } catch (_) { return ''; }
  }

  const locKey = l => (l.loc && l.loc.trim()) ? l.loc.trim() : '~~~';   // blanks last
  function sortLines() { st.lines.sort((a, b) => locKey(a).localeCompare(locKey(b), undefined, { numeric: true })); }
  function sort() { sortLines(); render(); }

  function render() {
    const units = st.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('tostTot').textContent = `${st.lines.length} lines · ${units} units`;
    $('tostRows').innerHTML = st.lines.map((l, i) => {
      if (l._manual) return `<tr class="manual">
        <td class="dc"><input class="tost-inp" style="text-align:center;font-weight:600" value="${esc(l.dc)}" oninput="TOStaging.set(${i},'dc',this.value)" placeholder="5DC" /></td>
        <td class="code"><input class="tost-inp" style="font-family:Consolas,monospace;font-weight:600" value="${esc(l.code)}" oninput="TOStaging.set(${i},'code',this.value)" placeholder="code" /></td>
        <td><input class="tost-inp" value="${esc(l.product)}" oninput="TOStaging.set(${i},'product',this.value)" placeholder="description (free — non-stock item)" /><span class="tost-tag">added</span></td>
        <td class="qty"><input class="tost-inp" style="text-align:center;font-weight:700" value="${esc(l.qty)}" inputmode="numeric" oninput="TOStaging.set(${i},'qty',this.value)" placeholder="0" /></td>
        <td class="locw"><input class="tost-inp loc" value="${esc(l.loc)}" oninput="TOStaging.set(${i},'loc',this.value)" placeholder="pickbay (opt.)" /></td>
        <td><button class="tost-rm" title="Remove this add-line" onclick="TOStaging.remove(${i})">×</button></td>
      </tr>`;
      // real order line: locked except Location
      return `<tr>
        <td class="dc ro">${esc(l.dc)}</td>
        <td class="code ro">${esc(l.code)}</td>
        <td class="ro">${esc(l.product)}</td>
        <td class="qty ro">${esc(l.qty)}</td>
        <td class="locw"><input class="tost-inp loc" value="${esc(l.loc)}" oninput="TOStaging.set(${i},'loc',this.value)" placeholder="set pickbay" /></td>
        <td><span class="tost-lock" title="Order line — can't be deleted">🔒</span></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="tost-empty">No lines.</td></tr>';
  }

  function set(i, k, v) { if (st.lines[i]) { st.lines[i][k] = v; if (k === 'qty') { const u = st.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0); $('tostTot').textContent = `${st.lines.length} lines · ${u} units`; } } }
  function add() { st.lines.unshift({ dc: '', code: '', product: '', qty: '', loc: '', _manual: true }); render(); const inp = $('tostRows').querySelector('tr.manual input'); if (inp) inp.focus(); }
  function remove(i) { if (st.lines[i] && !st.lines[i]._manual) return; st.lines.splice(i, 1); render(); }   // never removes an order line
  function close() { $('tostMask').classList.remove('on'); document.body.style.overflow = ''; }

  function print() {
    if (!st.lines.length) return;
    sortLines();
    const r = st.sel || {};
    const data = {
      tr: r.number || '', to_name: String(r.to_location || '').replace(/\s+Warehouse$/i, ''),
      to_addr: st.toAddr || '', date: fmtD(r.order_date),
      lines: st.lines.map(l => ({ dc: l.dc, code: l.code, product: l.product, qty: l.qty, loc: l.loc })),
    };
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {}
    window.open(PRINT_URL, '_blank');
  }

  window.TOStaging = { open, add, sort, set, remove, close, print };
})();
