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

  // ═══════════════ HOME — open an order to pick ═══════════════
  function homeScreen(view) {
    view.innerHTML =
      '<p class="eyebrow">Open a sales order to pick</p>' +
      scanField('Scan or type SO number…') +
      '<div class="tiles" style="margin-top:18px">' +
        '<button class="tile" id="tLook"><div class="ic">🔎</div><div class="t">Stock lookup</div><div class="s">Find a SKU across bins</div></button>' +
        '<button class="tile" id="tXfer"><div class="ic">🔁</div><div class="t">Transfer</div><div class="s">Bin ↔ bin · warehouse ↔ warehouse</div></button>' +
      '</div>' +
      '<div class="row" style="justify-content:flex-end;margin-top:20px"><button class="chip" id="tUser">' + esc(S.user) + ' ▾</button></div>';
    wireScan(function (v) { openOrder(v); });
    $('tLook').onclick = function () { go('lookup', 'Stock lookup'); };
    $('tXfer').onclick = function () { S.transfer = null; go('transfer', 'Transfer'); };
    $('tUser').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
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
      bottom('<button class="btn go lg" id="pkFinal">✓ Finalize order — build &amp; pick</button>');
      $('pkFinal').onclick = doFinalize;
    } else {
      bottom('<button class="btn ghost" id="pkReload">↻ Refresh</button><button class="btn go" disabled>' + (total - done) + ' left to pick</button>');
      $('pkReload').onclick = function () { render(); };
    }
  }
  function pickCard(it, i) {
    var comp = it.kind === 'component';
    return '<button class="card ' + (it.picked ? 'done' : '') + '" data-item="' + i + '" style="width:100%;text-align:left;cursor:pointer">' +
      '<div class="row"><div class="grow">' +
        '<div class="sku">' + esc(it.sku) + (comp ? ' <span class="pill warnp" style="font-size:10px">for ' + esc(it.forFg || 'assembly') + '</span>' : '') + '</div>' +
        '<div class="nm">' + esc(it.name || '') + '</div>' +
        (it.picked && it.fromBin ? '<div class="meta">picked from <b class="mono">' + esc(it.fromBin) + '</b></div>' : '') +
      '</div>' +
      '<div class="qty">' + (it.picked ? '✓ ' : '') + '×' + num(it.qty) + '</div></div></button>';
  }

  // focused pick of ONE item (bin + product + qty) — same for a line or a component
  function pickItemScreen(view, ctx) {
    var it = ctx.item;
    S.cur = { it: it, bin: it.fromBin || '' };
    view.innerHTML =
      '<div class="banner">Scan the <b>bin</b>, then the <b>product</b>. Suggested bins below (pickface first).</div>' +
      scanField('Scan bin, then product…') +
      '<div class="card"><div class="hd"><div class="sku">' + esc(it.sku) + '</div>' +
        (it.kind === 'component' ? '<span class="pill warnp">for ' + esc(it.forFg || 'assembly') + '</span>' : '') + '</div>' +
        '<div class="nm">' + esc(it.name || '') + '</div>' +
        '<div class="row" style="margin-top:12px;justify-content:space-between">' +
          '<div class="meta">Bin: <b class="mono" id="curBin">' + esc(S.cur.bin || '—') + '</b></div>' + qtyStepper(num(it.qty)) +
        '</div>' +
        '<div class="meta" style="margin-top:8px">Need <b>' + num(it.qty) + '</b></div>' +
        '<div class="chips" id="binChips"><span class="spin"></span></div>' +
      '</div>';
    wireScan(function (v) { onItemScan(it, v); });
    wireQty();
    loadSuggestions(it.sku);
    bottom('<button class="btn ghost" id="pkCancel">Back</button><button class="btn go" id="pkSave"' + (S.cur.bin ? '' : ' disabled') + '>Confirm pick</button>');
    $('pkCancel').onclick = back;
    $('pkSave').onclick = saveItem;
  }
  function onItemScan(it, v) {
    if (isBinCode(v)) { S.cur.bin = v; var b = $('curBin'); if (b) b.textContent = v; var s = $('pkSave'); if (s) s.disabled = false; toast('Bin ' + v); return; }
    api('GET', '/resolve/' + encodeURIComponent(v)).then(function (p) {
      if (p.sku === it.sku) { toast('✓ ' + p.sku + (p.matchedBy === 'barcode' ? ' (barcode)' : '')); if (S.cur.bin) saveItem(); else toast('Now scan or tap the bin', 'err'); }
      else { toast('Scanned ' + p.sku + ' — expected ' + it.sku, 'err'); }
    }).catch(function () { toast('Unknown code: ' + v, 'err'); });
  }
  function loadSuggestions(sku) {
    api('GET', '/suggest/' + encodeURIComponent(sku)).then(function (s) {
      var el = $('binChips'); if (!el) return;
      var pf = (s.pickface || []).map(function (b) { return '<span class="chip pf" data-bin="' + esc(b) + '" title="pickface">' + esc(b) + '</span>'; });
      var bins = (s.bins || []).slice(0, 6).map(function (b) { return '<span class="chip" data-bin="' + esc(b.bin) + '">' + esc(b.bin || '(root)') + '<span class="av">' + b.available + '</span></span>'; });
      el.innerHTML = (pf.length ? '<div class="meta" style="width:100%;margin-bottom:4px">Pickface</div>' : '') + pf.join('') +
        (bins.length ? '<div class="meta" style="width:100%;margin:6px 0 4px">Other bins (available)</div>' : '') + bins.join('') ||
        '<span class="meta">No stock suggestions — scan the bin.</span>';
      Array.prototype.forEach.call(el.querySelectorAll('[data-bin]'), function (c) {
        c.onclick = function () { S.cur.bin = c.getAttribute('data-bin'); var b = $('curBin'); if (b) b.textContent = S.cur.bin; var sv = $('pkSave'); if (sv) sv.disabled = false; toast('Bin ' + S.cur.bin); };
      });
    }).catch(function () { var el = $('binChips'); if (el) el.innerHTML = '<span class="meta">Suggestions unavailable — scan the bin.</span>'; });
  }
  function saveItem() {
    var it = S.cur.it, bin = S.cur.bin, qty = num($('qtyIn') && $('qtyIn').value) || num(it.qty);
    if (!bin) return toast('Scan or tap a bin first', 'err');
    var call = it.kind === 'component'
      ? api('POST', '/component-scan', { buildComponentId: it.id, binCode: bin, qty: qty })
      : api('POST', '/scan', { parcelLineId: it.id, binCode: bin, qty: qty, sku: it.sku });
    toast('Saving…');
    call.then(function () { toast(it.sku + ' ✓', 'ok'); back(); }).catch(function (e) { toast(e.message, 'err'); });
  }
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

  SCREENS = { home: homeScreen, pick: pickScreen, pickItem: pickItemScreen, lookup: lookupScreen, transfer: transferScreen };

  // ── boot ──
  $('backBtn').onclick = back;
  $('whoChip').textContent = S.user;
  $('whoChip').onclick = function () { var u = prompt('Operator name', S.user); if (u) { setUser(u.trim()); render(); } };
  S.stack = [{ screen: 'home', title: 'Rapid WMS' }];
  render();
})();
