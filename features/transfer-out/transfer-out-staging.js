/*
 * Transfer Out — shared staging + print. Load on ANY page that has window.supabase
 * (it injects its own modal + styles). Call:  TOStaging.open(row)
 *   row = { id, number, to_location, status, order_date }
 * The staging modal is a WYSIWYG, print-styled editable preview of the sheet.
 * Rules: ORDER lines are LOCKED (only their Location is editable, never deletable);
 * ADD lines (non-stock) are fully editable + removable. On print it is re-sorted by
 * pickbay and handed to transfer_out_print.html via localStorage.
 */
(function () {
  const PRINT_URL = '/features/transfer-out/transfer_out_print.html';
  const KEY = 'transferOutPrint';
  // Kit components are only shown for extrusion / linear. Those are the products that
  // physically leave the shelf as loose parts — extrusion + diffuser + end caps + clips —
  // while the transfer line names only the finished item. Everywhere else the Internal
  // Note is a production instruction ("Module must be set to 6w"), which belongs on a
  // build sheet, not on a transfer. Cin7 Category, mirrored in cin7_mirror.products.
  const KIT_CATEGORIES = new Set(['strip light & extrusion', 'linear']);
  const inKitCategory = cat => KIT_CATEGORIES.has(String(cat || '').trim().toLowerCase());
  const st = { sel: null, lines: [], toAddr: '' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || ''); };
  const $ = id => document.getElementById(id);
  const sbc = () => window.supabase;

  const CSS = `
   .tost-mask{display:none;position:fixed;inset:0;background:rgba(30,41,59,.62);z-index:2000;align-items:flex-start;justify-content:center;padding:26px 20px;overflow:auto;
     --ink:#1a2230;--muted:#5b6b86;--line:#333;--hair:#c8d0dc;--head:#eef2f7;font-family:"Segoe UI",Arial,sans-serif}
   .tost-mask.on{display:flex}
   .tost-modal{background:#fff;border-radius:6px;width:100%;max-width:1040px;max-height:calc(100vh - 52px);display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.4);color:var(--ink)}
   .tost-bar{display:flex;align-items:center;gap:10px;padding:11px 18px;border-bottom:1px solid var(--hair);background:#fbfcfe;border-radius:6px 6px 0 0;flex-shrink:0}
   .tost-bar .tbtn{padding:7px 13px;border:1px solid var(--hair);border-radius:6px;background:#fff;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink)}
   .tost-bar .tbtn:hover{border-color:#94a3b8}
   .tost-bar .tbtn.add{border-color:#cfd8e6}
   .tost-bar .tbtn.primary{background:#1e3a8a;color:#fff;border-color:#1e3a8a}
   .tost-bar .tbtn.ghost{border:none;background:none;color:var(--muted);margin-left:auto}
   .tost-bar .sp{flex:1}
   .tost-scroll{overflow:auto;padding:22px 26px;background:#eef1f5;flex:1}
   .tost-sheet{background:#fff;padding:22px 26px;box-shadow:0 1px 6px rgba(20,28,42,.12);max-width:940px;margin:0 auto}
   .tost-hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid var(--line);padding-bottom:8px}
   .tost-hd .title{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);font-weight:600}
   .tost-hd .dest{font-size:28px;font-weight:800;line-height:1.05;margin:1px 0 3px}
   .tost-hd .fromline{font-size:12px;color:var(--muted)}
   .tost-hd .fromline b{color:var(--ink);font-size:13px}
   .tost-hd .lbl{text-transform:uppercase;font-size:10px;letter-spacing:.06em}
   .tost-hd .right{text-align:right}
   .tost-hd .trno{font-size:21px;font-weight:700}
   .tost-hd .meta{font-size:11px;color:var(--muted);margin-top:2px}
   .tost-hd .meta b{color:var(--ink)}
   .tost-sum{display:flex;gap:16px;font-size:11px;color:var(--muted);margin:9px 0 6px}
   .tost-sum b{color:var(--ink)}
   table.tost-t{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}
   table.tost-t th{background:var(--head);border:1px solid var(--line);padding:6px 8px;text-align:left;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#37435a}
   table.tost-t td{border:1px solid var(--hair);padding:0;height:30px;vertical-align:middle}
   table.tost-t td .cell{padding:6px 8px}
   table.tost-t td.ro .cell{color:#2b3648}
   table.tost-t .dc{width:60px;text-align:center;font-variant-numeric:tabular-nums;font-weight:600}
   table.tost-t .code{width:140px;font-family:Consolas,monospace;font-weight:600}
   table.tost-t .qty{width:46px;text-align:center;font-weight:700}
   table.tost-t .loc{width:128px;font-family:Consolas,monospace}
   table.tost-t .act{width:34px;text-align:center}
   table.tost-t tr.zebra td{background:#fafbfd}
   table.tost-t input{width:100%;border:0;padding:6px 8px;font:inherit;font-size:12px;background:#eff4ff;color:var(--ink);outline:none}
   table.tost-t input:focus{background:#fff;box-shadow:inset 0 0 0 2px #1e3a8a}
   table.tost-t .dc input{text-align:center;font-weight:600}
   table.tost-t .code input,table.tost-t .loc input{font-family:Consolas,monospace;font-weight:600}
   table.tost-t .qty input{text-align:center;font-weight:700}
   table.tost-t tr.manual td{background:#fff8ec}
   table.tost-t tr.manual .dc{box-shadow:inset 3px 0 0 #c88a12}
   table.tost-t tr.manual input{background:#fff}
   .tost-added{font-size:9px;color:#8a6d1f;letter-spacing:.04em;text-transform:uppercase;margin-left:6px}
   .tost-x{border:1px solid var(--hair);background:#fff;border-radius:5px;width:22px;height:22px;color:#b04242;cursor:pointer;font-size:14px;line-height:1}
   .tost-x:hover{background:#fbeaea;border-color:#e7bcbc}
   .tost-empty{text-align:center;color:#9aa6ba;padding:22px}
   .tost-spin{display:inline-block;width:15px;height:15px;border:2px solid #cbd5e1;border-top-color:#1e3a8a;border-radius:50%;animation:tostsp .8s linear infinite;vertical-align:middle}
   @keyframes tostsp{to{transform:rotate(360deg)}}
   table.tost-t tr.kit td{background:#f4f8ff;height:24px;border-top:0;border-bottom-color:#e4ecf9}
   table.tost-t tr.kit td.qty{font-weight:700;color:#1e3a8a}
   table.tost-t tr.kit .cell{padding:3px 8px}
   .tost-kt{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.09em;color:#1e3a8a;background:#dbe6fd;border-radius:4px;padding:1px 6px}
   .tost-kt.note{color:#8a6d1f;background:#fdf3d9}
   .tost-khd{font-size:11px;color:#4a5c78}
   .tost-khd b{color:#1e3a8a}
   .tost-chips{white-space:normal;line-height:1.55;font-size:11.5px;padding:5px 8px}
   .tost-lead{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#5b6b86;margin-right:4px}
   .tost-chip{white-space:nowrap}
   .tost-chip b{font-size:13px;color:#12203a}
   .tost-sep{color:#b9c4d6}
   .tost-knote{font-size:11px;color:#8a6d1f;font-style:italic}`;

  function ensureDom() {
    if ($('tostMask')) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="tost-mask" id="tostMask">
      <div class="tost-modal">
        <div class="tost-bar">
          <button class="tbtn add" onclick="TOStaging.add()">Add line</button>
          <button class="tbtn" onclick="TOStaging.sort()">Sort by pickbay</button>
          <span class="sp"></span>
          <button class="tbtn primary" onclick="TOStaging.print()">Print</button>
          <button class="tbtn ghost" onclick="TOStaging.close()">Close</button>
        </div>
        <div class="tost-scroll">
          <div class="tost-sheet">
            <div class="tost-hd">
              <div>
                <div class="title">Stock Transfer</div>
                <div class="dest" id="tostDest">—</div>
                <div class="fromline"><span class="lbl">From</span> <b>Main Warehouse</b> &nbsp;•&nbsp; <span class="lbl">To</span> <span id="tostToAddr">—</span></div>
              </div>
              <div class="right">
                <div class="trno" id="tostTr">—</div>
                <div class="meta" id="tostMeta">—</div>
              </div>
            </div>
            <div class="tost-sum" id="tostSum"></div>
            <table class="tost-t"><thead><tr>
              <th class="dc">5DC</th><th class="code">Rapid Code</th><th>Product</th><th class="qty">Qty</th><th class="loc">Location</th><th class="act"></th>
            </tr></thead><tbody id="tostRows"></tbody></table>
          </div>
        </div>
      </div></div>`;
    document.body.appendChild(wrap.firstElementChild);
    $('tostMask').addEventListener('click', e => { if (e.target === $('tostMask')) close(); });
  }

  async function open(row) {
    ensureDom();
    st.sel = row; st.lines = []; st.toAddr = '';
    $('tostDest').textContent = String(row.to_location || '—').replace(/\s+Warehouse$/i, '').toUpperCase();
    $('tostTr').textContent = row.number || '—';
    $('tostToAddr').textContent = '…';
    $('tostMeta').innerHTML = `Date <b>${esc(fmtD(row.order_date)) || '—'}</b> · ${esc(row.status || '')}`;
    $('tostSum').innerHTML = '';
    $('tostRows').innerHTML = `<tr><td colspan="6" class="tost-empty"><span class="tost-spin"></span> Loading lines from Cin7…</td></tr>`;
    $('tostMask').classList.add('on'); document.body.style.overflow = 'hidden';
    try {
      const j = await (await fetch('/api/transfer-out/detail/' + encodeURIComponent(row.id))).json();
      if (!j.success) throw new Error(j.error || 'detail failed');
      const lines = j.lines || [];
      const skus = [...new Set(lines.map(l => l.sku).filter(Boolean))];
      const map = {};
      if (skus.length && sbc()) {
        const { data } = await sbc().schema('cin7_mirror').from('products').select('sku,attribute1,stock_locator,name,category').in('sku', skus);
        (data || []).forEach(p => { map[p.sku] = p; });
      }
      st.lines = lines.map(l => { const p = map[l.sku] || {}; return { dc: p.attribute1 || '', code: l.sku, product: l.product_name || p.name || '', qty: l.qty, loc: p.stock_locator || '', _manual: false }; });
      st.toAddr = await lookupAddr(row.to_location);
      $('tostToAddr').textContent = st.toAddr || row.to_location || '—';
      sortLines(); render();
      // Only extrusion/linear lines get a note lookup — that also keeps the Cin7 call
      // count down to the handful of SKUs that can actually carry a kit.
      loadKits(skus.filter(sku => inKitCategory((map[sku] || {}).category)));
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

  const locKey = l => (l.loc && l.loc.trim()) ? l.loc.trim() : '~~~';
  function sortLines() { st.lines.sort((a, b) => locKey(a).localeCompare(locKey(b), undefined, { numeric: true })); }
  function sort() { sortLines(); render(); }

  // ── kit components (product Internal Note) ──
  // Cin7 gives us no readable BOM over the API, so the InternalNote the team writes on
  // the product is the recipe: one component per line, "End caps x 2". Those numbers are
  // PER UNIT of the parent line — printing them raw is exactly how a picker sends 2 end
  // caps for a line of 2 kits instead of 4, so the sheet multiplies them out.
  const KIT_LINE = /^(.+?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*$/i;
  const fmtQ = n => String(Math.round(n * 100) / 100);

  function parseKit(note) {
    const parts = [], plain = [];
    String(note || '').split(/\r?\n/).forEach(raw => {
      const t = raw.trim(); if (!t) return;
      const m = KIT_LINE.exec(t);
      const name = m ? m[1].replace(/[:;,\-–]\s*$/, '').trim() : '';
      if (m && /[a-z0-9]/i.test(name)) parts.push({ name, per: Number(String(m[2]).replace(',', '.')) || 0 });
      else plain.push(t);                       // free-form note ("Module must be set to 6w")
    });
    return { parts, plain };
  }

  function kitRows(l) {
    const k = l._kit;
    if (!k) return '';
    const parts = k.parts || [], plain = k.plain || [];
    if (!parts.length && !plain.length) return '';
    const q = Number(l.qty) || 0;
    const tag = t => `<td class="code"><div class="cell"><span class="tost-kt${t === 'NOTE' ? ' note' : ''}">${t}</span></div></td>`;
    // Free-text lines collapse into one row too — "***ATTENTION***:" + its sentence is
    // one instruction, not two, and every saved row is a row the sheet doesn't spend.
    const joinPlain = ls => ls.reduce((a, t) => a ? a + (/[:\-–]$/.test(a) ? ' ' : ' · ') + t : t, '');
    // A note with no parseable components is just an instruction ("Module must be set
    // to 6w") — it gets no KIT header and no multiplication, or the sheet would claim
    // totals for something that has no quantity at all.
    if (!parts.length) {
      return `<tr class="kit"><td class="dc"></td>${tag('NOTE')}
        <td colspan="4"><div class="cell tost-knote">${esc(joinPlain(plain))}</div></td></tr>`;
    }
    // One collapsed row, not one row per component: a 4-part kit is the common case and
    // used to cost 5 sheet rows. The chips carry the TOTAL already multiplied; the lead
    // says what those totals are for, so nobody has to do the arithmetic at the shelf.
    // Note the real space between chips — without it the line cannot wrap and the last
    // component gets clipped by the cell.
    const chips = parts.map(p => `<span class="tost-chip">${esc(p.name)} <b>${fmtQ(q ? p.per * q : p.per)}</b></span>`)
      .join(' <span class="tost-sep">·</span> ');
    const head = `<tr class="kit"><td class="dc"></td>${tag('KIT')}
      <td colspan="4"><div class="cell tost-chips"><span class="tost-lead">${q ? `for ${esc(l.qty)} unit${q === 1 ? '' : 's'}, pick` : 'per unit, pick'}</span> ${chips}</div></td></tr>`;
    const plainRows = plain.length ? `<tr class="kit"><td class="dc"></td><td class="code"></td>
      <td colspan="4"><div class="cell tost-knote">${esc(joinPlain(plain))}</div></td></tr>` : '';
    return head + plainRows;
  }

  // Fired after the first render so a slow Cin7 lookup never holds the sheet back.
  async function loadKits(skus) {
    if (!skus.length) return;
    try {
      const j = await (await fetch('/api/transfer-out/product-notes?skus=' + encodeURIComponent(skus.join(',')))).json();
      if (!j || !j.success) return;
      let touched = false;
      st.lines.forEach(l => {
        const note = j.notes[l.code];
        if (!note) return;
        l._note = note; l._kit = parseKit(note); touched = true;
      });
      if (touched) render();
    } catch (_) { /* the sheet is still correct without the notes */ }
  }

  function render() {
    const units = st.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('tostSum').innerHTML = `<span><b>${st.lines.length}</b> lines</span><span><b>${units}</b> units total</span><span>Sorted by pickbay (Location)</span>`;
    let z = 0;
    $('tostRows').innerHTML = st.lines.map((l, i) => {
      const zebra = (z++ % 2) ? ' zebra' : '';
      if (l._manual) return `<tr class="manual${zebra}">
        <td class="dc"><input value="${esc(l.dc)}" oninput="TOStaging.set(${i},'dc',this.value)" placeholder="5DC" /></td>
        <td class="code"><input value="${esc(l.code)}" oninput="TOStaging.set(${i},'code',this.value)" placeholder="code" /></td>
        <td><input value="${esc(l.product)}" oninput="TOStaging.set(${i},'product',this.value)" placeholder="description — non-stock item, free to type" /></td>
        <td class="qty"><input value="${esc(l.qty)}" inputmode="numeric" oninput="TOStaging.set(${i},'qty',this.value)" placeholder="0" /></td>
        <td class="loc"><input value="${esc(l.loc)}" oninput="TOStaging.set(${i},'loc',this.value)" placeholder="pickbay" /></td>
        <td class="act"><button class="tost-x" title="Remove this added line" onclick="TOStaging.remove(${i})">×</button></td>
      </tr>`;
      return `<tr class="${zebra.trim()}">
        <td class="dc ro"><div class="cell">${esc(l.dc)}</div></td>
        <td class="code ro"><div class="cell">${esc(l.code)}</div></td>
        <td class="ro"><div class="cell">${esc(l.product)}</div></td>
        <td class="qty ro"><div class="cell">${esc(l.qty)}</div></td>
        <td class="loc"><input value="${esc(l.loc)}" oninput="TOStaging.set(${i},'loc',this.value)" placeholder="set pickbay" /></td>
        <td class="act"></td>
      </tr>` + kitRows(l);
    }).join('') || '<tr><td colspan="6" class="tost-empty">No lines.</td></tr>';
  }

  function set(i, k, v) { if (st.lines[i]) { st.lines[i][k] = v; if (k === 'qty') { const u = st.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0); const el = $('tostSum'); if (el) el.innerHTML = `<span><b>${st.lines.length}</b> lines</span><span><b>${u}</b> units total</span><span>Sorted by pickbay (Location)</span>`; } } }
  function add() { st.lines.unshift({ dc: '', code: '', product: '', qty: '', loc: '', _manual: true }); render(); const inp = $('tostRows').querySelector('tr.manual input'); if (inp) inp.focus(); }
  function remove(i) { if (st.lines[i] && !st.lines[i]._manual) return; st.lines.splice(i, 1); render(); }
  function close() { $('tostMask').classList.remove('on'); document.body.style.overflow = ''; }

  function print() {
    if (!st.lines.length) return;
    sortLines();
    const r = st.sel || {};
    const data = {
      tr: r.number || '', to_name: String(r.to_location || '').replace(/\s+Warehouse$/i, ''),
      to_addr: st.toAddr || '', date: fmtD(r.order_date),
      lines: st.lines.map(l => ({ dc: l.dc, code: l.code, product: l.product, qty: l.qty, loc: l.loc, kit: l._kit || null })),
    };
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (_) {}
    window.open(PRINT_URL, '_blank');
  }

  window.TOStaging = { open, add, sort, set, remove, close, print };
})();
