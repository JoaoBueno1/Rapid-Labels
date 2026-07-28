/* Rapid WMS PWA — scanner-first operator app. Talks to /api/wms/*.
   Screens: home · wave · pick · assembly · pack · lookup.
   All in-progress state is drafts on the server; commits go through the outbox. */
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
        '<button class="tile" id="tUser"><div class="ic">👤</div><div class="t">' + esc(S.user) + '</div><div class="s">Change operator</div></button>' +
      '</div>';
    wireScan(function (v) { openOrder(v); });
    $('tLook').onclick = function () { go('lookup', 'Stock lookup'); };
    $('tXfer').onclick = function () { S.transfer = null; go('transfer', 'Transfer'); };
    $('tUser').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
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
      var kb = view.querySelector('[data-open="pack"]'); if (kb) kb.onclick = function () { go('pack', 'Pack ' + wh.order_number, { waveId: wh.id, parcelId: pick.id }); };
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
      // picked → next step is pack (same fulfilment)
      action = parcel.status === 'committed'
        ? '<button class="btn go" data-open="pack">📦  Pack this</button>'
        : '<button class="btn go" disabled>Completed ✓</button>';
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
  function onPickScan(view, line, v) {
    // heuristic: a bin code matches the aisle grammar; else it's a product/SKU
    if (/^[A-Z]{2}-[A-Z0-9]/.test(v) && !/^R\d/.test(v)) {
      line.from_bin = v; toast('Bin ' + v); saveScan(line);
    } else {
      // product scan — accept if it matches the line SKU (barcode->SKU handled server-side later)
      if (v === line.sku || v.indexOf(line.sku) >= 0 || line.sku.indexOf(v) >= 0) { toast('Product OK'); }
      else { toast('Scanned ' + v + ' (expected ' + line.sku + ')', 'err'); return; }
      saveScan(line);
    }
    renderPick(view);
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
      .then(function (r) { toast((r.assemblyNumber || 'Built') + (r.adopted ? ' (adopted)' : '') + ' ✓', 'ok'); reloadWaveThen('wave'); })
      .catch(function (e) { toast(e.message, 'err'); });
  }

  // ═══════════════ PACK ═══════════════
  function packScreen(view, ctx) {
    var parcel = (S.wave.parcels || []).filter(function (p) { return p.id === ctx.parcelId; })[0];
    S.parcel = parcel;
    var box = { name: 'Box 1', length: '', width: '', height: '', weight: '' };
    S.box = box;
    view.innerHTML =
      '<div class="banner">Verify items into the carton, enter its size, then commit.</div>' +
      '<div class="card">' + (parcel.lines || []).map(function (l) {
        return '<div class="row" style="padding:8px 0;border-top:1px solid var(--line)"><div class="grow"><div class="sku">' + esc(l.sku) + '</div></div><div class="qty">×' + num(l.qty_scanned) + '</div><span class="pill done" style="margin-left:8px"><span class="dot"></span>Box 1</span></div>';
      }).join('') + '</div>' +
      '<div class="sec">Carton</div><div class="card">' +
        '<label class="fld">Name</label><input class="txt" id="bxName" value="Box 1" />' +
        '<div class="grid2"><div><label class="fld">Length cm</label><input class="txt" id="bxL" inputmode="decimal" /></div>' +
        '<div><label class="fld">Width cm</label><input class="txt" id="bxW" inputmode="decimal" /></div></div>' +
        '<div class="grid2"><div><label class="fld">Height cm</label><input class="txt" id="bxH" inputmode="decimal" /></div>' +
        '<div><label class="fld">Weight kg</label><input class="txt" id="bxKg" inputmode="decimal" /></div></div>' +
      '</div>';
    bottom('<button class="btn go lg" id="doPack">📦  Commit pack</button>');
    $('doPack').onclick = function () {
      var boxes = [{ name: $('bxName').value || 'Box 1', length: num($('bxL').value), width: num($('bxW').value), height: num($('bxH').value), weight: num($('bxKg').value) }];
      toast('Packing…');
      api('POST', '/commit/pack', { parcelId: S.parcel.id, boxes: boxes }).then(function (r) {
        toast(r.alreadyDone ? 'Already packed' : 'Packed ✓ — print slip', 'ok'); reloadWaveThen('wave');
      }).catch(function (e) { toast(e.message, 'err'); });
    };
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

  SCREENS = { home: homeScreen, wave: waveScreen, pick: pickScreen, assembly: assemblyScreen, pack: packScreen, lookup: lookupScreen, transfer: transferScreen };

  // ── boot ──
  $('backBtn').onclick = back;
  $('whoChip').textContent = S.user;
  $('whoChip').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
  S.stack = [{ screen: 'home', title: 'Rapid WMS' }];
  render();
})();
