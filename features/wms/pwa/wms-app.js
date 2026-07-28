/* Rapid WMS PWA — scanner-first HANDHELD app for pickers + stock staff.
   Screens: home · wave (order) · pick · assembly/production · transfer · stock-lookup.
   Pack is NOT here — packing is a separate desktop page for packers (open picked
   orders → authorise pack → print slip → booking). All in-progress state is drafts
   on the server; commits go through the outbox. */
(function () {
  'use strict';

  // ── tiny helpers ──
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var num = function (v) { return v == null || v === '' ? 0 : Number(v); };
  var toastT;
  function toast(msg, kind) {
    var t = $('toast'); t.textContent = msg; t.className = 'show ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(function () { t.className = ''; }, kind === 'err' ? 3800 : 2200);
  }
  function api(method, path, body) {
    return fetch('/api/wms' + path, {
      method: method, headers: { 'Content-Type': 'application/json', 'X-WMS-User': S.user },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  // ── state + navigation ──
  var S = { user: localStorage.getItem('wms_user') || 'operator', stack: [], wave: null, parcel: null, build: null };
  function setUser(u) { S.user = u || 'operator'; localStorage.setItem('wms_user', S.user); $('whoChip').textContent = S.user; }
  function go(screen, title, ctx) { S.stack.push({ screen: screen, title: title, ctx: ctx }); render(); }
  function back() { if (S.stack.length > 1) { S.stack.pop(); render(); } }
  function replace(screen, title, ctx) { S.stack[S.stack.length - 1] = { screen: screen, title: title, ctx: ctx }; render(); }

  var SCREENS;
  function render() {
    var cur = S.stack[S.stack.length - 1] || { screen: 'home', title: 'Rapid WMS' };
    $('topTitle').textContent = cur.title;
    $('backBtn').classList.toggle('hidden', S.stack.length <= 1);
    $('bottomBar').classList.add('hidden'); $('bottomBar').innerHTML = '';
    var view = $('view'); view.innerHTML = '<div class="empty"><span class="spin"></span></div>';
    (SCREENS[cur.screen] || SCREENS.home)(view, cur.ctx || {});
  }
  function bottom(html) { var b = $('bottomBar'); b.innerHTML = html; b.classList.remove('hidden'); }

  // ── scan input: a single field; hardware wedges end with Enter ──
  function scanField(placeholder, onScan) {
    return '<div class="scan"><input id="scanIn" autocomplete="off" autocapitalize="characters" spellcheck="false" ' +
      'inputmode="text" placeholder="' + esc(placeholder) + '" /><button class="go" id="scanGo">Enter</button></div>';
  }
  function wireScan(onScan) {
    var inp = $('scanIn'); if (!inp) return;
    function fire() { var v = inp.value.trim(); if (!v) return; inp.value = ''; onScan(v.toUpperCase()); }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
    var g = $('scanGo'); if (g) g.onclick = fire;
    setTimeout(function () { inp.focus(); }, 60);
  }

  function pill(status) {
    var m = { draft: ['draft', 'Not started'], in_progress: ['prog', 'In progress'], staged: ['prog', 'Staged'], committed: ['done', 'Done'], cancelled: ['warnp', 'Cancelled'] };
    var x = m[status] || ['draft', status];
    return '<span class="pill ' + x[0] + '"><span class="dot"></span>' + x[1] + '</span>';
  }

  // ═══════════════ HOME ═══════════════
  function homeScreen(view) {
    view.innerHTML =
      '<p class="eyebrow">Open an order</p>' +
      scanField('Scan or type SO number…') +
      '<div class="tiles">' +
        '<button class="tile" id="tLook"><div class="ic">🔎</div><div class="t">Stock lookup</div><div class="s">Find a SKU across bins</div></button>' +
        '<button class="tile" id="tXfer"><div class="ic">🔁</div><div class="t">Transfer</div><div class="s">Bin ↔ bin · warehouse ↔ warehouse</div></button>' +
        '<button class="tile" id="tRecv"><div class="ic">📥</div><div class="t">Receive</div><div class="s">PO putaway into bins</div></button>' +
        '<button class="tile" id="tOps"><div class="ic">📋</div><div class="t">Ops</div><div class="s">Outbox &amp; movements</div></button>' +
      '</div>' +
      '<div class="row" style="justify-content:space-between;margin-top:16px">' +
        '<div class="sec" style="margin:0">Open orders</div>' +
        '<button class="chip" id="tUser">' + esc(S.user) + ' ▾</button></div>' +
      '<div id="openList"><div class="empty"><span class="spin"></span></div></div>';
    wireScan(function (v) { openOrder(v); });
    $('tLook').onclick = function () { go('lookup', 'Stock lookup'); };
    $('tXfer').onclick = function () { S.transfer = null; go('transfer', 'Transfer'); };
    $('tRecv').onclick = function () { S.receipt = null; go('receive', 'Receive PO'); };
    $('tOps').onclick = function () { go('ops', 'Ops'); };
    $('tUser').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
    loadOpenList();
  }
  function loadOpenList() {
    api('GET', '/open').then(function (d) {
      var el = $('openList'); if (!el) return;
      var ip = (d.inProgress || []).map(function (w) {
        var picked = (w.parcels || []).filter(function (p) { return p.kind === 'pick' && p.status === 'committed'; }).length;
        var tag = (w.parcels || []).some(function (p) { return p.kind === 'assembly' && p.status !== 'committed'; }) ? 'awaiting build' : (picked ? 'picked' : 'picking');
        return '<button class="card" style="width:100%;text-align:left;cursor:pointer" data-so="' + esc(w.order_number) + '">' +
          '<div class="row"><div class="grow"><span class="sku">' + esc(w.order_number) + '</span><div class="nm">' + esc(w.customer || '') + '</div></div>' +
          '<span class="pill ' + (tag === 'picked' ? 'done' : 'prog') + '">' + tag + '</span></div></button>';
      }).join('');
      var ts = (d.toStart || []).map(function (o) {
        return '<button class="card" style="width:100%;text-align:left;cursor:pointer" data-so="' + esc(o.order_number) + '">' +
          '<div class="row"><div class="grow"><span class="sku">' + esc(o.order_number) + '</span><div class="nm">' + esc(o.customer || '') + '</div></div>' +
          '<span class="pill draft">to start</span></div></button>';
      }).join('');
      el.innerHTML = (ip || ts) ? (ip + (ts ? '<div class="sec">To start</div>' + ts : '')) : '<div class="empty">No open orders.</div>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-so]'), function (b) { b.onclick = function () { openOrder(b.getAttribute('data-so')); }; });
    }).catch(function () { var el = $('openList'); if (el) el.innerHTML = '<div class="empty">Open list unavailable.</div>'; });
  }
  function openOrder(order) {
    order = order.replace(/\s+/g, ''); if (!/^SO-?\d+/i.test(order)) order = order; // accept as-is
    if (/^\d+$/.test(order)) order = 'SO-' + order;
    toast('Opening ' + order + '…');
    api('POST', '/wave', { orderNumber: order }).then(function (w) {
      S.wave = w; go('wave', w.wave.order_number, { waveId: w.wave.id });
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ═══════════════ WAVE ═══════════════
  function waveScreen(view, ctx) {
    api('GET', '/wave/' + ctx.waveId).then(function (w) {
      S.wave = w;
      var wh = w.wave;
      var asm = w.parcels.filter(function (p) { return p.kind === 'assembly'; })[0];
      var pick = w.parcels.filter(function (p) { return p.kind === 'pick'; })[0];
      var claims = {}; w.claims.forEach(function (c) { claims[c.sale_line_ref] = c.claimed_by; });

      var html = '<div class="card"><div class="hd"><div><div class="sku">' + esc(wh.order_number) + '</div>' +
        '<div class="nm">' + esc(wh.customer || '') + '</div></div>' + pill(wh.status) + '</div>' +
        '<div class="meta" style="margin-top:6px">' + esc(wh.sale_type || '') +
        (wh.has_assembly ? ' · <b style="color:var(--warn)">has assembly</b>' : '') + '</div></div>';

      if (asm) {
        html += '<div class="sec">Assembly — production first</div>';
        html += parcelCard(asm, claims, 'assembly');
      }
      if (pick) {
        html += '<div class="sec">Pick — the rest</div>';
        html += parcelCard(pick, claims, 'pick');
      }
      view.innerHTML = html;
      var ab = view.querySelector('[data-open="assembly"]'); if (ab) ab.onclick = function () { go('assembly', 'Build ' + wh.order_number, { waveId: wh.id, parcelId: asm.id }); };
      var pb = view.querySelector('[data-open="pick"]'); if (pb) pb.onclick = function () { go('pick', 'Pick ' + wh.order_number, { waveId: wh.id, parcelId: pick.id }); };
    }).catch(function (e) { view.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function parcelCard(parcel, claims, kind) {
    var lines = parcel.lines || [];
    var done = lines.every(function (l) { return l.status === 'committed'; }) && lines.length;
    var body = lines.map(function (l) {
      var claimed = claims[l.sale_line_ref];
      return '<div class="row" style="padding:8px 0;border-top:1px solid var(--line)">' +
        '<div class="grow"><div class="sku">' + esc(l.sku) + (l.is_assembly ? ' <span class="pill warnp" style="font-size:10px">BOM</span>' : '') + '</div>' +
        '<div class="nm">' + esc(l.name || '') + '</div></div>' +
        '<div class="qty">' + (l.status === 'committed' ? '✓ ' : '') + num(l.qty_scanned) + '<span class="of">/' + num(l.qty_ordered) + '</span></div>' +
        (claimed ? '<span class="pill claim" style="margin-left:8px">' + esc(claimed) + '</span>' : '') + '</div>';
    }).join('');
    var action;
    if (kind === 'pick' && done) {
      // picked → packing happens at the desktop pack station, not on the handheld
      action = '<div class="banner" style="margin:0"><b>✓ Picked</b> — ready for the pack station.</div>';
    } else if (done) {
      action = '<button class="btn go" disabled>Completed ✓</button>';
    } else {
      action = '<button class="btn" data-open="' + kind + '">' + (kind === 'assembly' ? '🛠  Build components' : '📦  Start picking') + '</button>';
    }
    return '<div class="card ' + (done ? 'done' : '') + '">' + body + '<div style="margin-top:12px">' + action + '</div></div>';
  }

  // ═══════════════ PICK ═══════════════
  function pickScreen(view, ctx) {
    var parcel = (S.wave.parcels || []).filter(function (p) { return p.id === ctx.parcelId; })[0];
    S.parcel = parcel;
    S.pickIdx = 0;
    renderPick(view);
  }
  function renderPick(view) {
    var lines = (S.parcel.lines || []).filter(function (l) { return l.status !== 'committed'; });
    if (!lines.length) { view.innerHTML = '<div class="empty">Nothing to pick.</div>'; return; }
    var line = lines[Math.min(S.pickIdx, lines.length - 1)];
    var allScanned = lines.every(function (l) { return num(l.qty_scanned) >= num(l.qty_ordered); });

    view.innerHTML =
      '<div class="banner">Scan the <b>bin</b>, then the <b>product</b>. Bins suggested below.</div>' +
      scanField('Scan bin, then product…') +
      '<div class="card"><div class="hd"><div class="num">line ' + (S.pickIdx + 1) + '/' + lines.length + '</div>' + pill(line.status) + '</div>' +
        '<div class="sku">' + esc(line.sku) + '</div><div class="nm">' + esc(line.name || '') + '</div>' +
        '<div class="row" style="margin-top:12px;justify-content:space-between">' +
          '<div class="meta">Bin: <b class="mono">' + esc(line.from_bin || '—') + '</b></div>' +
          qtyStepper(num(line.qty_scanned) || num(line.qty_ordered)) +
        '</div>' +
        '<div class="meta" style="margin-top:8px">Need <b>' + num(line.qty_ordered) + '</b></div>' +
        '<div class="chips" id="binChips"><span class="spin"></span></div>' +
      '</div>' +
      lineNav(lines, S.pickIdx);
    wireScan(function (v) { onPickScan(view, line, v); });
    wireQty();
    loadSuggestions(line.sku, line);
    wireLineNav(view, lines);

    bottom('<button class="btn ghost" id="pkClaim">Claim line</button>' +
      '<button class="btn go" id="pkCommit"' + (allScanned ? '' : ' disabled') + '>Commit pick</button>');
    $('pkClaim').onclick = function () {
      api('POST', '/claim', { waveId: S.wave.wave.id, saleLineRef: line.sale_line_ref }).then(function () { toast('Claimed', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
    };
    $('pkCommit').onclick = function () {
      toast('Committing pick…');
      api('POST', '/commit/pick', { parcelId: S.parcel.id }).then(function (r) {
        toast(r.alreadyDone ? 'Already committed' : 'Picked ✓', 'ok'); reloadWaveThen('wave');
      }).catch(function (e) { toast(e.message, 'err'); });
    };
  }
  function isBinCode(v) { return /^[A-Z]{2}-[A-Z0-9]+-L\d/.test(v) || /DOCK|PRODUCTION|-GA\b/.test(v); }
  function onPickScan(view, line, v) {
    if (isBinCode(v)) { line.from_bin = v; toast('Bin ' + v); saveScan(line); renderPick(view); return; }
    // product scan → resolve barcode/SKU/5DC server-side (70% of SKUs have no barcode)
    api('GET', '/resolve/' + encodeURIComponent(v)).then(function (p) {
      if (p.sku === line.sku) { toast('✓ ' + p.sku + (p.matchedBy === 'barcode' ? ' (barcode)' : '')); saveScan(line); renderPick(view); }
      else { toast('Scanned ' + p.sku + ' — expected ' + line.sku, 'err'); }
    }).catch(function () { toast('Unknown code: ' + v, 'err'); });
  }
  function saveScan(line) {
    var qty = num($('qtyIn') && $('qtyIn').value) || num(line.qty_ordered);
    line.qty_scanned = qty; line.status = 'in_progress';
    api('POST', '/scan', { parcelLineId: line.id, binCode: line.from_bin, qty: qty, sku: line.sku }).catch(function (e) { toast(e.message, 'err'); });
  }
  function qtyStepper(v) {
    return '<div class="step"><button id="qMinus">−</button><input id="qtyIn" class="mono" value="' + (v || 1) + '" inputmode="numeric" /><button id="qPlus">+</button></div>';
  }
  function wireQty() {
    var i = $('qtyIn'); if (!i) return;
    $('qMinus').onclick = function () { i.value = Math.max(0, num(i.value) - 1); };
    $('qPlus').onclick = function () { i.value = num(i.value) + 1; };
  }
  function loadSuggestions(sku, line) {
    api('GET', '/suggest/' + encodeURIComponent(sku)).then(function (s) {
      var el = $('binChips'); if (!el) return;
      var pf = (s.pickface || []).map(function (b) { return '<span class="chip pf" data-bin="' + esc(b) + '">' + esc(b) + '</span>'; });
      var bins = (s.bins || []).slice(0, 5).map(function (b) { return '<span class="chip" data-bin="' + esc(b.bin) + '">' + esc(b.bin || '(none)') + '<span class="av">' + b.available + '</span></span>'; });
      el.innerHTML = pf.concat(bins).join('') || '<span class="meta">No stock suggestions.</span>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-bin]'), function (c) { c.onclick = function () { line.from_bin = c.getAttribute('data-bin'); saveScan(line); toast('Bin ' + line.from_bin); render(); }; });
    }).catch(function () { var el = $('binChips'); if (el) el.innerHTML = ''; });
  }
  function lineNav(lines, idx) {
    return '<div class="row" style="gap:10px;margin-top:4px">' +
      '<button class="btn ghost" id="prevLine"' + (idx <= 0 ? ' disabled' : '') + '>‹ Prev</button>' +
      '<button class="btn ghost" id="nextLine"' + (idx >= lines.length - 1 ? ' disabled' : '') + '>Next ›</button></div>';
  }
  function wireLineNav(view, lines) {
    var p = $('prevLine'), n = $('nextLine');
    if (p) p.onclick = function () { S.pickIdx = Math.max(0, S.pickIdx - 1); renderPick(view); };
    if (n) n.onclick = function () { S.pickIdx = Math.min(lines.length - 1, S.pickIdx + 1); renderPick(view); };
  }
  function reloadWaveThen(screen) {
    api('GET', '/wave/' + S.wave.wave.id).then(function (w) { S.wave = w; while (S.stack.length > 2) S.stack.pop(); replace('wave', w.wave.order_number, { waveId: w.wave.id }); });
  }

  // ═══════════════ ASSEMBLY / PRODUCTION ═══════════════
  function assemblyScreen(view, ctx) {
    var parcel = (S.wave.parcels || []).filter(function (p) { return p.id === ctx.parcelId; })[0];
    S.parcel = parcel;
    var fg = (parcel.lines || [])[0]; // one FG per assembly parcel line; handle first
    if (!fg) { view.innerHTML = '<div class="empty">No assembly line.</div>'; return; }
    view.innerHTML = '<div class="banner warn">Build <b>' + esc(fg.sku) + '</b> ×' + num(fg.qty_ordered) + '. Scan the bin you took each component from.</div><div id="recipe"><span class="spin"></span></div>';
    api('GET', '/recipe/' + encodeURIComponent(fg.sku)).then(function (r) {
      var comps = (r.components || []).map(function (c) { return { sku: c.sku, product_id: c.product_id, qty: num(c.qty_per) * num(fg.qty_ordered), from_bin: '' }; });
      S.build = { fg: fg, comps: comps };
      renderRecipe(view);
    }).catch(function (e) { $('recipe').innerHTML = '<div class="empty">Recipe unavailable: ' + esc(e.message) + '<br><span class="meta">Cin7 exposes it only via an existing build.</span></div>'; });
  }
  function renderRecipe(view) {
    var b = S.build;
    var body = b.comps.map(function (c, i) {
      return '<div class="card"><div class="hd"><div class="sku">' + esc(c.sku) + '</div><div class="qty">×' + c.qty + '</div></div>' +
        '<div class="meta" style="margin-top:6px">from bin <b class="mono">' + esc(c.from_bin || '— scan —') + '</b></div>' +
        '<div class="chips" id="cbin' + i + '"></div></div>';
    }).join('');
    $('recipe').innerHTML = scanField('Scan component bin…') + body;
    wireScan(function (v) { assignComponentBin(view, v); });
    b.comps.forEach(function (c, i) { loadCompSuggest(i, c); });
    var ready = b.comps.every(function (c) { return c.from_bin; });
    bottom('<button class="btn go lg" id="doBuild"' + (ready ? '' : ' disabled') + '>🛠  Complete build</button>');
    $('doBuild').onclick = doBuild;
  }
  function assignComponentBin(view, v) {
    var b = S.build; var next = b.comps.filter(function (c) { return !c.from_bin; })[0];
    if (next && /^[A-Z]{2}-/.test(v)) { next.from_bin = v; toast(next.sku + ' ← ' + v); renderRecipe(view); }
    else toast('Scan a bin (MA-…)', 'err');
  }
  function loadCompSuggest(i, c) {
    api('GET', '/suggest/' + encodeURIComponent(c.sku)).then(function (s) {
      var el = $('cbin' + i); if (!el) return;
      el.innerHTML = (s.bins || []).slice(0, 4).map(function (x) { return '<span class="chip" data-bin="' + esc(x.bin) + '">' + esc(x.bin || '(none)') + '<span class="av">' + x.available + '</span></span>'; }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('[data-bin]'), function (ch) { ch.onclick = function () { c.from_bin = ch.getAttribute('data-bin'); renderRecipe($('view')); }; });
    }).catch(function () {});
  }
  function doBuild() {
    var b = S.build;
    toast('Building… (adopting Cin7 build)');
    api('POST', '/build', { waveId: S.wave.wave.id, fgSku: b.fg.sku, fgProductId: b.fg.product_id, qty: num(b.fg.qty_ordered), components: b.comps })
      .then(function (build) { return api('POST', '/commit/build', { buildId: build.id }); })
      .then(function (r) {
        var msg = (r.assemblyNumber || 'Built') + (r.adopted ? ' (adopted)' : '');
        if (r.putaway && r.putaway.ok) msg += ' → ' + r.putaway.bin;
        toast(msg + ' ✓', 'ok'); reloadWaveThen('wave');
      })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  // ═══════════════ STOCK LOOKUP ═══════════════
  function lookupScreen(view) {
    view.innerHTML = '<p class="eyebrow">Find a SKU across bins</p>' + scanField('Scan or type a SKU…') + '<div id="lookRes"></div>';
    wireScan(function (v) { doLookup(v); });
  }
  function doLookup(sku) {
    $('lookRes').innerHTML = '<div class="empty"><span class="spin"></span></div>';
    api('GET', '/lookup/' + encodeURIComponent(sku)).then(function (r) {
      var rows = (r.locations || []).filter(function (x) { return x.onHand !== 0 || x.available !== 0; });
      if (!rows.length) { $('lookRes').innerHTML = '<div class="empty">No stock for ' + esc(sku) + '.</div>'; return; }
      $('lookRes').innerHTML = '<div class="card"><div class="sku" style="margin-bottom:8px">' + esc(r.sku) + '</div>' +
        rows.map(function (x) {
          return '<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><div class="grow"><span class="mono">' + esc(x.bin || x.warehouse) + '</span>' +
            (x.bin ? ' <span class="meta">' + esc(x.warehouse) + '</span>' : '') + '</div>' +
            '<div class="qty">' + x.available + '<span class="of"> avail</span></div></div>';
        }).join('') + '</div>';
    }).catch(function (e) { $('lookRes').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }

  // ═══════════════ TRANSFER ═══════════════
  function transferScreen(view) {
    if (!S.transfer) { renderTransferStart(view); return; }
    renderTransferBuild(view);
  }
  function renderTransferStart(view) {
    view.innerHTML =
      '<div class="banner">Move stock <b>bin → bin</b> or <b>warehouse → warehouse</b>. Build the list, then commit once — sessions pause and resume, so huge TRs are fine.</div>' +
      '<div class="card">' +
        '<label class="fld">From (bin code or warehouse name)</label><input class="txt" id="xFrom" placeholder="e.g. MA-A-07-L7-P2  or  Main Warehouse" />' +
        '<label class="fld">To</label><input class="txt" id="xTo" placeholder="e.g. MA-B-04-L5-P2  or  Sydney" />' +
      '</div>' +
      '<button class="btn lg" id="xStart">Start transfer</button>';
    setTimeout(function () { var f = $('xFrom'); if (f) f.focus(); }, 60);
    $('xStart').onclick = function () {
      var from = $('xFrom').value.trim(), to = $('xTo').value.trim();
      if (!from || !to) return toast('Enter from and to', 'err');
      var kind = /warehouse|sydney|brisbane|main|project|gateway/i.test(from + to) && !/-L\d/.test(from) ? 'warehouse' : 'bin';
      api('POST', '/transfer', { kind: kind, fromLocation: from, toLocation: to }).then(function (t) {
        S.transfer = { id: t.id, from: from, to: to, lines: [] }; renderTransferBuild(view);
      }).catch(function (e) { toast(e.message, 'err'); });
    };
  }
  function renderTransferBuild(view) {
    var x = S.transfer;
    view.innerHTML =
      '<div class="card"><div class="meta"><b class="mono">' + esc(x.from) + '</b> → <b class="mono">' + esc(x.to) + '</b></div></div>' +
      scanField('Scan product to add…') + qtyStepper(1) +
      '<div id="xLines" style="margin-top:12px"></div>';
    wireScan(function (v) { addTransferLine(view, v); });
    wireQty();
    renderTransferLines();
    bottom('<button class="btn ghost" id="xCancel">Discard</button><button class="btn go" id="xCommit"' + (x.lines.length ? '' : ' disabled') + '>Commit transfer (' + x.lines.length + ')</button>');
    $('xCancel').onclick = function () { S.transfer = null; back(); };
    $('xCommit').onclick = function () {
      toast('Committing transfer…');
      api('POST', '/commit/transfer', { transferId: x.id }).then(function (r) {
        toast((r.cin7_ref || 'Transfer') + ' ✓', 'ok'); S.transfer = null; back();
      }).catch(function (e) { toast(e.message, 'err'); });
    };
  }
  function addTransferLine(view, sku) {
    var qty = num($('qtyIn') && $('qtyIn').value) || 1;
    api('POST', '/transfer/' + S.transfer.id + '/line', { sku: sku, qty: qty, fromBin: S.transfer.from, toBin: S.transfer.to }).then(function (line) {
      S.transfer.lines.push({ id: line.id, sku: line.sku, qty: line.qty }); toast(line.sku + ' ×' + line.qty); renderTransferBuild(view);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function renderTransferLines() {
    var el = $('xLines'); if (!el) return;
    el.innerHTML = S.transfer.lines.length ? S.transfer.lines.map(function (l) {
      return '<div class="row" style="padding:10px 0;border-top:1px solid var(--line)"><div class="grow"><span class="sku">' + esc(l.sku) + '</span></div><div class="qty">×' + l.qty + '</div></div>';
    }).join('') : '<div class="empty">Scan products to add lines.</div>';
  }

  // ═══════════════ RECEIVE (PO putaway) ═══════════════
  function receiveScreen(view) {
    if (!S.receipt) {
      view.innerHTML = '<p class="eyebrow">Receive a purchase order</p>' + scanField('Scan or type PO number…');
      wireScan(function (v) {
        toast('Loading ' + v + '…');
        api('GET', '/purchase/' + encodeURIComponent(v)).then(function (po) { S.receipt = { po: v, lines: (po.lines || []).map(function (l) { return Object.assign({ done: 0 }, l); }), bin: '' }; renderReceive(view); }).catch(function (e) { toast(e.message, 'err'); });
      });
      return;
    }
    renderReceive(view);
  }
  function renderReceive(view) {
    var r = S.receipt;
    view.innerHTML =
      '<div class="banner"><b>' + esc(r.po) + '</b> — scan the <b>destination bin</b>, then each product to put it away.</div>' +
      scanField('Scan bin, then product…') + qtyStepper(1) +
      '<div class="card" style="margin-top:12px"><div class="meta">Bin: <b class="mono">' + esc(r.bin || '— scan —') + '</b></div></div>' +
      r.lines.map(function (l, i) {
        var full = l.done >= l.qty;
        return '<div class="card ' + (full ? 'done' : '') + '"><div class="row"><div class="grow"><span class="sku">' + esc(l.sku) + '</span><div class="nm">' + esc(l.name || '') + '</div></div>' +
          '<div class="qty">' + (full ? '✓ ' : '') + l.done + '<span class="of">/' + l.qty + '</span></div></div></div>';
      }).join('');
    wireScan(function (v) { onReceiveScan(view, v); });
    wireQty();
  }
  function onReceiveScan(view, v) {
    var r = S.receipt;
    if (isBinCode(v)) { r.bin = v; toast('Bin ' + v); renderReceive(view); return; }
    api('GET', '/resolve/' + encodeURIComponent(v)).then(function (p) {
      var line = r.lines.filter(function (l) { return l.sku === p.sku; })[0];
      if (!line) { toast(p.sku + ' not on this PO', 'err'); return; }
      if (!r.bin) { toast('Scan a destination bin first', 'err'); return; }
      var qty = num($('qtyIn') && $('qtyIn').value) || (line.qty - line.done) || 1;
      api('POST', '/receive', { sku: line.sku, productId: line.productId, qty: qty, toBin: r.bin, poNumber: r.po }).then(function () {
        line.done += qty; toast('Put away ' + line.sku + ' ×' + qty + ' → ' + r.bin, 'ok'); renderReceive(view);
      }).catch(function (e) { toast(e.message, 'err'); });
    }).catch(function () { toast('Unknown code: ' + v, 'err'); });
  }

  // ═══════════════ OPS (outbox + journal) ═══════════════
  function opsScreen(view) {
    view.innerHTML = '<div class="sec" style="margin-top:0">Outbox</div><div id="opsOut"><span class="spin"></span></div><div class="sec">Recent movements</div><div id="opsMov"><span class="spin"></span></div>';
    api('GET', '/outbox').then(function (rows) {
      $('opsOut').innerHTML = (rows || []).slice(0, 30).map(function (o) {
        var cls = o.status === 'confirmed' || o.status === 'reconciled' ? 'done' : (o.status === 'failed' ? 'warnp' : 'prog');
        return '<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><div class="grow"><span class="mono" style="font-size:13px">' + esc(o.op_type) + '</span>' + (o.cin7_ref ? ' <span class="meta">' + esc(o.cin7_ref) + '</span>' : '') + (o.last_error ? '<div class="nm" style="color:var(--bad)">' + esc(o.last_error) + '</div>' : '') + '</div><span class="pill ' + cls + '">' + esc(o.status) + '</span></div>';
      }).join('') || '<div class="empty">No writes yet.</div>';
    }).catch(function () { $('opsOut').innerHTML = '<div class="empty">unavailable</div>'; });
    api('GET', '/movements').then(function (rows) {
      $('opsMov').innerHTML = (rows || []).slice(0, 40).map(function (m) {
        return '<div class="row" style="padding:7px 0;border-top:1px solid var(--line)"><div class="grow"><span class="mono" style="font-size:13px">' + esc(m.movement_type) + '</span> <span class="sku" style="font-size:14px">' + esc(m.sku) + '</span></div><div class="qty">' + (m.qty > 0 ? '+' : '') + m.qty + '</div><span class="meta" style="margin-left:8px">' + esc(m.to_bin || m.from_bin || '') + '</span></div>';
      }).join('') || '<div class="empty">No movements yet.</div>';
    }).catch(function () { $('opsMov').innerHTML = '<div class="empty">unavailable</div>'; });
  }

  // NOTE: pack is intentionally NOT a PWA screen — packing is done at the desktop
  // pack station (packers see picked orders there, authorise, print the slip, then
  // booking). The commitPack engine/route stay in the backend for that page.
  SCREENS = { home: homeScreen, wave: waveScreen, pick: pickScreen, assembly: assemblyScreen, lookup: lookupScreen, transfer: transferScreen, receive: receiveScreen, ops: opsScreen };

  // ── boot ──
  $('backBtn').onclick = back;
  $('whoChip').textContent = S.user;
  $('whoChip').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
  S.stack = [{ screen: 'home', title: 'Rapid WMS' }];
  render();
})();
