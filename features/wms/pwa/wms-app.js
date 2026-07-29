/* Rapid WMS PWA — scanner-first handheld. Three screens: Pick · Stock lookup · Transfer.
   Like Cin7's own WMS the flow is just PICK: open a sales order and pick every card.
   Assembly components are shown INLINE as ordinary pick cards (each with the qty needed
   to build its FG); picking them all + the normal lines and hitting Finalize builds the
   FGs and picks everything in ONE commit. No wave/assembly/receive/ops screens.
   All in-progress state is drafts on the server → multi-user, pausable, resumable. */
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
  var S = { user: localStorage.getItem('wms_user') || 'operator', stack: [], pick: null };
  function setUser(u) { S.user = u || 'operator'; localStorage.setItem('wms_user', S.user); $('whoChip').textContent = S.user; }
  function go(screen, title, ctx) { S.stack.push({ screen: screen, title: title, ctx: ctx }); render(); }
  function back() {
    var cur = S.stack[S.stack.length - 1];
    if (cur && cur.screen === 'pickItem' && S.cur && S.cur.dirty) {
      if (confirm('Save this pick before leaving?\nOK = save · Cancel = discard (resets it)')) savePick(false); else discardPick();
      return;
    }
    if (S.stack.length > 1) { S.stack.pop(); render(); }
  }
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

  // ── scan input: single field; hardware wedges end with Enter ──
  function scanField(placeholder) {
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
  function isBinCode(v) { return /^[A-Z]{2}-[A-Z0-9]+-L\d/.test(v) || /DOCK|PRODUCTION|-GA\b/.test(v); }
  function qtyStepper(v) { return '<div class="step"><button id="qMinus">&minus;</button><input id="qtyIn" class="mono" value="' + (v || 1) + '" inputmode="numeric" /><button id="qPlus">+</button></div>'; }
  function wireQty() {
    var i = $('qtyIn'); if (!i) return;
    $('qMinus').onclick = function () { i.value = Math.max(0, num(i.value) - 1); };
    $('qPlus').onclick = function () { i.value = num(i.value) + 1; };
  }

  // ═══════════════ HOME — menu of options ═══════════════
  function homeScreen(view) {
    view.innerHTML =
      '<p class="eyebrow">Warehouse</p>' +
      '<div class="tiles">' +
        '<button class="tile" id="tPick"><div class="t">Pick</div><div class="s">Open a sales order and pick its items</div></button>' +
        '<button class="tile" id="tTr"><div class="t">Transfer (TR)</div><div class="s">Scan a stock transfer and pick its items</div></button>' +
        '<button class="tile" id="tXfer"><div class="t">Bin transfer</div><div class="s">Move stock bin to bin or between warehouses</div></button>' +
        '<button class="tile" id="tLook"><div class="t">Stock lookup</div><div class="s">Find a SKU across all bins</div></button>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:22px"><button class="who" id="tUser">' + esc(S.user) + ' ▾</button></div>';
    $('tPick').onclick = function () { go('pickEntry', 'Pick'); };
    $('tTr').onclick = function () { go('trEntry', 'Transfer (TR)'); };
    $('tXfer').onclick = function () { S.transfer = null; go('transfer', 'Bin transfer'); };
    $('tLook').onclick = function () { go('lookup', 'Stock lookup'); };
    $('tUser').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
  }
  // Transfer (TR) — scan an ordered stock transfer and pick its items. (Pick flow next.)
  function trEntryScreen(view) {
    view.innerHTML =
      '<p class="eyebrow">Stock transfer (TR)</p>' +
      '<div class="banner">Scan or type the <b>TR</b> number to open it and pick its items.</div>' +
      scanField('Scan or type TR number…');
    wireScan(function (v) { toast('TR pick flow is being built — next update (' + v + ')', 'err'); });
  }
  // Pick entry — scan/type the sales order, then straight into the pick list.
  function pickEntryScreen(view) {
    view.innerHTML =
      '<p class="eyebrow">Pick a sales order</p>' +
      '<div class="banner">Scan or type the <b>sales order</b> to start picking.</div>' +
      scanField('Scan or type SO number…');
    wireScan(function (v) { openOrder(v); });
  }
  function openOrder(order) {
    order = String(order).replace(/\s+/g, '');
    if (/^\d+$/.test(order)) order = 'SO-' + order;
    toast('Opening ' + order + '…');
    api('POST', '/wave', { orderNumber: order }).then(function (w) {
      go('pick', w.wave.order_number, { waveId: w.wave.id });
    }).catch(function (e) { toast(e.message, 'err'); });
  }

  // ═══════════════ PICK — the unified pick list ═══════════════
  function pickScreen(view, ctx) {
    var waveId = ctx.waveId;
    api('GET', '/pick-list/' + waveId).then(function (pl) {
      S.pick = pl; S.pick.waveId = waveId;
      renderPickList(view);
    }).catch(function (e) { view.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  }
  function renderPickList(view) {
    var pl = S.pick, wh = pl.wave;
    var done = pl.items.filter(function (i) { return i.picked; }).length, total = pl.items.length;
    var head = '<div class="card"><div class="hd"><div><div class="sku">' + esc(wh.order_number) + '</div>' +
      '<div class="nm">' + esc(wh.customer || '') + '</div></div>' +
      '<div class="qty">' + done + '<span class="of">/' + total + '</span></div></div>' +
      '<div class="pbar" style="margin-top:10px"><span style="width:' + (total ? Math.round(100 * done / total) : 0) + '%"></span></div></div>';
    var cards = pl.items.map(pickCard).join('') || '<div class="empty">Nothing to pick on this order.</div>';
    view.innerHTML = head + '<div class="sec">Pick list</div>' + cards;
    Array.prototype.forEach.call(view.querySelectorAll('[data-item]'), function (el) {
      el.onclick = function () {
        var it = pl.items[Number(el.getAttribute('data-item'))];
        if (it.picked) { toast('Already picked — tap again to re-pick'); }
        go('pickItem', it.sku, { item: it });
      };
    });
    if (pl.allPicked) {
      bottom('<button class="btn go lg" id="pkFinal">Finish order — build &amp; pick</button>');
      $('pkFinal').onclick = doFinalize;
    } else {
      bottom('<button class="btn ghost" disabled style="opacity:1;color:var(--muted)">' + done + ' / ' + total + ' picked · ' + (total - done) + ' to go</button>');
    }
  }
  function pickCard(it, i) {
    var comp = it.kind === 'component';
    var loc = it.picked
      ? '<div class="meta" style="margin-top:6px">picked from <b class="mono">' + esc(it.fromBin || '—') + '</b></div>'
      : (it.pickface
          ? '<div class="loc"><span class="lbl">pick from</span> ' + esc(it.pickface) + '</div>'
          : '<div class="loc none"><span class="lbl">no pickface</span> check bins</div>');
    return '<button class="card ' + (it.picked ? 'done' : '') + '" data-item="' + i + '" style="width:100%;text-align:left;cursor:pointer">' +
      '<div class="row"><div class="grow">' +
        '<div class="sku">' + esc(it.sku) + (comp ? ' <span class="pill warnp" style="font-size:10px">for ' + esc(it.forFg || 'assembly') + '</span>' : '') + '</div>' +
        '<div class="nm">' + esc(it.name || '') + '</div>' + loc +
      '</div>' +
      '<div class="qty">' + (it.picked ? '✓ ' : '') + '×' + num(it.qty) + '</div></div></button>';
  }

  // Focused pick of ONE item — separate Bin + Product fields (like Cin7 WMS). The bin
  // must MATCH the pickface (no random bins); each product scan adds one to the count
  // (or type it), capped at the need; when the count reaches the need it auto-saves and
  // the card turns green. Back prompts save-or-discard, and leaving unsaved resets the
  // pick so another operator resumes cleanly.
  function pickItemScreen(view, ctx) {
    var it = ctx.item;
    S.cur = { it: it, need: num(it.qty), bin: '', binOk: false, productOk: false, picked: num(it.qtyScanned) || 0, dirty: false };
    renderPickItem(view);
    loadItemStock(it);
  }
  function renderPickItem(view) {
    var c = S.cur, it = c.it, remain = Math.max(0, c.need - c.picked);
    view.innerHTML =
      (it.pickface
        ? '<div class="banner">Pick <b>' + c.need + '</b> from <b>' + esc(it.pickface) + '</b> — the pickface.</div>'
        : '<div class="banner warn">No pickface set — scan the bin you take it from.</div>') +
      '<div class="card">' +
        '<div class="sku">' + esc(it.sku) + (it.kind === 'component' ? ' <span class="pill warnp" style="font-size:10px">for ' + esc(it.forFg || 'assembly') + '</span>' : '') + '</div>' +
        '<div class="nm" style="white-space:normal">' + esc(it.name || '') + '</div>' +
        '<div class="meta" style="margin-top:6px">Pick from <b class="mono">' + esc(it.pickface || '—') + '</b> <span id="pfLive" class="faint"></span></div>' +
        '<div class="statrow">' +
          '<div class="statbox" id="boxPicked"><span class="k">Picked</span><b id="cPicked">' + c.picked + '</b></div>' +
          '<div class="statbox"><span class="k">Remain</span><b id="cRemain">' + remain + '</b></div>' +
        '</div>' +
        '<label class="fld">Bin</label>' +
        '<div class="fldrow"><input class="txt" id="binIn" placeholder="Scan the pickface bin" autocomplete="off" autocapitalize="characters" spellcheck="false" />' +
          '<span class="okmark" id="binOk"></span></div>' +
        '<label class="fld">Product</label>' +
        '<div class="fldrow"><input class="txt" id="prodIn" placeholder="Scan the product barcode" autocomplete="off" autocapitalize="characters" spellcheck="false"' + (c.binOk ? '' : ' disabled') + ' />' +
          '<span class="okmark" id="prodOk"></span></div>' +
        '<label class="fld">Quantity picked</label>' +
        '<input class="txt mono qtybig" id="qtyIn" inputmode="numeric" placeholder="0" value="' + (c.picked || '') + '" />' +
        '<div class="sec" style="margin:16px 0 6px">Stock in other bins <span style="text-transform:none;font-weight:400;letter-spacing:0">— consultative only</span></div>' +
        '<div class="chips" id="binChips"><span class="spin"></span></div>' +
      '</div>';
    wireItemInputs();
    bottom('<button class="btn ghost" id="pkDiscard">Discard</button><button class="btn go" id="pkSave">Save &amp; back</button>');
    $('pkDiscard').onclick = function () { discardPick(); };
    $('pkSave').onclick = function () { savePick(false); };
  }
  function wireItemInputs() {
    var binIn = $('binIn'), prodIn = $('prodIn'), qtyIn = $('qtyIn');
    if (binIn) {
      var doBin = function () { var v = (binIn.value || '').trim().toUpperCase(); if (v) confirmBin(v); };
      binIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doBin(); } });
      binIn.addEventListener('blur', doBin);
    }
    if (prodIn) {
      var doProd = function () { var v = (prodIn.value || '').trim().toUpperCase(); if (v) { prodIn.value = ''; scanProduct(v); } };
      prodIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doProd(); } });
    }
    if (qtyIn) qtyIn.addEventListener('input', function () { setPicked(num(qtyIn.value), true); });
    setTimeout(function () { var f = S.cur.binOk ? prodIn : binIn; if (f) f.focus(); }, 60);
  }
  function confirmBin(v) {
    var c = S.cur, it = c.it;
    if (it.pickface && v !== String(it.pickface).toUpperCase()) { toast('Wrong bin — pick from ' + it.pickface, 'err'); var b0 = $('binIn'); if (b0) b0.value = ''; return; }
    c.bin = it.pickface || v; c.binOk = true;
    var bi = $('binIn'); if (bi) { bi.value = c.bin; bi.disabled = true; }
    var ok = $('binOk'); if (ok) ok.textContent = '✓';
    var p = $('prodIn'); if (p) { p.disabled = false; p.focus(); }
    toast('Bin confirmed', 'ok');
  }
  function scanProduct(v) {
    var c = S.cur, it = c.it;
    if (!c.binOk) { toast('Scan the bin first', 'err'); return; }
    api('GET', '/resolve/' + encodeURIComponent(v)).then(function (p) {
      if (p.sku !== it.sku) { toast('Wrong product: ' + p.sku + ' — need ' + it.sku, 'err'); return; }
      c.productOk = true; var ok = $('prodOk'); if (ok) ok.textContent = '✓';
      if (c.picked >= c.need) { toast('Full qty already (' + c.need + ')', 'err'); return; }
      setPicked(c.picked + 1, false);
      if (c.picked >= c.need) { toast(it.sku + ' complete', 'ok'); savePick(true); }
    }).catch(function () { toast('Unknown code: ' + v, 'err'); });
  }
  function setPicked(n, typed) {
    var c = S.cur;
    n = Math.max(0, Math.min(c.need, Math.floor(num(n))));
    if (typed) { var qi = $('qtyIn'); if (qi && num(qi.value) > c.need) qi.value = c.need; }
    c.picked = n; c.dirty = true;
    var cp = $('cPicked'); if (cp) cp.textContent = n;
    var cr = $('cRemain'); if (cr) cr.textContent = Math.max(0, c.need - n);
    var bx = $('boxPicked'); if (bx) bx.classList.toggle('hit', n >= c.need && n > 0);
    if (!typed) { var q = $('qtyIn'); if (q) q.value = n || ''; }
  }
  function loadItemStock(it) {
    api('GET', '/suggest/' + encodeURIComponent(it.sku)).then(function (s) {
      var bins = s.bins || [];
      if (it.pickface) {
        var pf = bins.filter(function (b) { return String(b.bin).toUpperCase() === String(it.pickface).toUpperCase(); })[0];
        var el = $('pfLive'); if (el) el.textContent = pf ? '· ' + pf.available + ' in this bin' : '· 0 here — restock needed';
      }
      var el2 = $('binChips'); if (!el2) return;
      var others = bins.filter(function (b) { return !it.pickface || String(b.bin).toUpperCase() !== String(it.pickface).toUpperCase(); }).slice(0, 8);
      el2.innerHTML = others.map(function (b) { return '<span class="chip" style="cursor:default">' + esc(b.bin || '(root)') + '<span class="av">' + b.available + '</span></span>'; }).join('') || '<span class="meta">No stock in other bins.</span>';
    }).catch(function () { var el = $('binChips'); if (el) el.innerHTML = '<span class="meta">Bins unavailable.</span>'; });
  }
  function savePick(auto) {
    var c = S.cur, it = c.it;
    if (!c.binOk) return toast('Scan the bin first', 'err');
    if (!c.productOk) return toast('Scan the product to confirm', 'err');
    var call = it.kind === 'component'
      ? api('POST', '/component-scan', { buildComponentId: it.id, binCode: c.bin, qty: c.picked })
      : api('POST', '/scan', { parcelLineId: it.id, binCode: c.bin, qty: c.picked, sku: it.sku });
    call.then(function () { c.dirty = false; toast(it.sku + ' saved ' + c.picked + '/' + c.need, 'ok'); popBack(); }).catch(function (e) { toast(e.message, 'err'); });
  }
  function discardPick() {
    var c = S.cur, it = c.it;
    var call = it.kind === 'component'
      ? api('POST', '/component-scan', { buildComponentId: it.id, binCode: '', qty: 0 })
      : api('POST', '/scan', { parcelLineId: it.id, binCode: '', qty: 0, sku: it.sku });
    c.dirty = false;
    call.then(function () { toast('Pick reset'); popBack(); }).catch(function () { popBack(); });
  }
  function popBack() { if (S.stack.length > 1) { S.stack.pop(); render(); } }
  function doFinalize() {
    if (!confirm('Finalize ' + S.pick.wave.order_number + '?\nThis builds any assemblies and picks everything in Cin7 (real stock move).')) return;
    toast('Finalizing — build + pick…');
    var b = $('pkFinal'); if (b) { b.disabled = true; b.textContent = 'Working…'; }
    api('POST', '/finalize', { waveId: S.pick.waveId }).then(function (r) {
      var msg = (r.order || 'Order') + ' picked ✓';
      if (r.builds && r.builds.length) msg += ' · built ' + r.builds.map(function (x) { return x.assemblyNumber || x.fg; }).join(', ');
      toast(msg, 'ok');
      while (S.stack.length > 1) S.stack.pop();
      render();
    }).catch(function (e) { toast(e.message, 'err'); var bb = $('pkFinal'); if (bb) { bb.disabled = false; bb.textContent = '✓ Finalize order — build & pick'; } });
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

  // ═══════════════ TRANSFER (bin↔bin / warehouse↔warehouse) ═══════════════
  function transferScreen(view) {
    if (!S.transfer) { renderTransferStart(view); return; }
    renderTransferBuild(view);
  }
  function renderTransferStart(view) {
    view.innerHTML =
      '<div class="banner">Move stock <b>bin → bin</b> (restock) or <b>warehouse → warehouse</b>. Build the list, then commit once — sessions pause and resume.</div>' +
      '<div class="card">' +
        '<label class="fld">From (bin code or warehouse name)</label><input class="txt" id="xFrom" placeholder="e.g. MA-A-07-L7-P2  or  Main Warehouse" />' +
        '<label class="fld">To</label><input class="txt" id="xTo" placeholder="e.g. MA-B-04-L5-P2  or  Sydney" />' +
      '</div><button class="btn lg" id="xStart">Start transfer</button>';
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
      scanField('Scan product to add…') + qtyStepper(1) + '<div id="xLines" style="margin-top:12px"></div>';
    wireScan(function (v) { addTransferLine(view, v); });
    wireQty(); renderTransferLines();
    bottom('<button class="btn ghost" id="xCancel">Discard</button><button class="btn go" id="xCommit"' + (x.lines.length ? '' : ' disabled') + '>Commit (' + x.lines.length + ')</button>');
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

  SCREENS = { home: homeScreen, pickEntry: pickEntryScreen, trEntry: trEntryScreen, pick: pickScreen, pickItem: pickItemScreen, lookup: lookupScreen, transfer: transferScreen };

  // ── boot ──
  $('backBtn').onclick = back;
  $('whoChip').textContent = S.user;
  $('whoChip').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
  S.stack = [{ screen: 'home', title: 'Rapid WMS' }];
  render();
})();
