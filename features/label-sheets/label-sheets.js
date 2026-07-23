/*
 * label-sheets.js — Label Sheets feature (isolated). Read-only on data:
 * pulls products from cin7_mirror.products (same as multi-label), never writes.
 *
 * Print precision: renders a real A4 PDF with every label placed at its exact
 * mm position (jsPDF, unit mm) — no browser print scaling involved. There is no
 * calibration step: the sheets are known, the geometry is fixed, and printing at
 * 100% / Actual size is the whole contract.
 *
 * Every pixel on screen and every mark on paper comes from LabelRender, so the
 * picker examples, the sheet preview and the PDF are the same drawing.
 */
(function () {
  'use strict';

  var LS = {
    tpl: null,
    caps: null,          // capability config of the selected template
    cells: [],           // per-position content or null
    products: null,      // cin7_mirror.products cache
    _results: [],        // current product-search matches
    _prev: {},           // rendered-cell preview cache
    selectMode: false,
    selected: new Set(),
    editor: { mode: 'cell', index: 0, type: 'product', product: null }
  };
  window.LS = LS;

  // ── helpers ──
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function intVal(id, def) { var v = parseInt(el(id) && el(id).value, 10); return isNaN(v) ? def : v; }

  // What each content type is called and what it does — shown on the model
  // cards so the operator can pick a sheet by what it prints, not by its code.
  var TYPE_NAME = { product: 'Product', plabel: 'Product label', barcode: 'Barcode', text: 'Text' };
  function typeHint(type, recipe) {
    if (type === 'product') return recipe === 'code5dc' ? '5DC + barcode, from a product' : 'Name, 5DC and barcode';
    if (type === 'plabel') return 'Full Rapid LED sticker, from Cin7';
    if (type === 'barcode') return 'Any code — EAN-13 or CODE128';
    if (type === 'text') return 'Free text';
    return '';
  }
  // Realistic sample content, so an example looks like the real thing.
  var SAMPLES = {
    product: { type: 'product', sku: 'R1051-WH', name: '8w Dimmable Downlight', dc5: '95908', barcode: '9727435304891', fmt: 'auto' },
    barcode: { type: 'barcode', value: '9727435304891', fmt: 'auto' },
    text: { type: 'text', text: 'Rapid LED' },
    plabel: { type: 'plabel', code: 'R1021-WH-TRI', desc: '8w Dimmable Downlight Integral Driver IP54 90mm Cut Out, Tri', lines: ['200 – 240VAC / 50-60Hz'], barcode: '9727435304891', fmt: 'auto' }
  };

  // ── Rendered preview of one cell (shared by the cards and the sheet) ──
  function cellPreviewURL(cell, wMM, hMM, opts) {
    if (!cell || !cell.type) return '';
    var key = wMM + 'x' + hMM + '|' + (opts && opts.productRecipe || '') + '|' + JSON.stringify(cell);
    if (LS._prev[key]) return LS._prev[key];
    try {
      var u = window.LabelRender.toCanvas(cell, wMM, hMM, 9, opts).toDataURL('image/png');
      LS._prev[key] = u;
      return u;
    } catch (e) { return ''; }
  }

  // ═══ STEP 1 — model picker ═══
  // Each card answers the two questions the operator actually has: is this the
  // sheet in my hand, and can it print what I need? The A4 minimap answers the
  // first; a rendered example of every allowed content type answers the second.
  function renderModels() {
    var grid = el('lsModelGrid');
    var cards = window.LabelTemplates.list().map(function (t) {
      var m = window.LabelTemplates.meta(t);
      var minimap = window.LabelTemplates.svgPreview(t, 150, 168);
      var codeTxt = m.code ? 'Celcast ' + m.code : 'Celcast compat.';

      var examples = m.allow.map(function (type) {
        var url = cellPreviewURL(SAMPLES[type], m.labelW, m.labelH, { productRecipe: m.productRecipe });
        return '<div class="ls-ex">' +
          '<div class="ls-ex-frame"' + (m.labelW > m.labelH * 1.6 ? ' style="min-height:44px;"' : '') + '>' +
            (url ? '<img src="' + url + '" alt="" />' : '<span class="ls-loading">…</span>') +
          '</div>' +
          '<div class="ls-ex-name">' + esc(TYPE_NAME[type] || type) + '</div>' +
          '<div class="ls-ex-hint">' + esc(typeHint(type, m.productRecipe)) + '</div>' +
        '</div>';
      }).join('');

      return '<div class="ls-card' + (m.fits ? '' : ' bad') + '" onclick="LS.selectModel(\'' + t.id + '\')">' +
        '<div class="ls-card-head">' +
          '<div class="ls-card-preview">' + minimap + '</div>' +
          '<div class="ls-card-id">' +
            '<div class="ls-card-title">' + esc(m.name) + '</div>' +
            '<div class="ls-card-sub">' + esc(m.size) + ' · grid ' + esc(m.grid) + '</div>' +
            '<div class="ls-card-facts">' + m.up + ' per sheet · Avery ' + esc(m.avery) + ' · ' + esc(codeTxt) + '</div>' +
            (m.purpose ? '<div class="ls-card-purpose">' + esc(m.purpose) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ls-card-prints">Prints</div>' +
        '<div class="ls-ex-row">' + examples + '</div>' +
      '</div>';
    }).join('');

    grid.innerHTML = '<div class="ls-models">' + cards + '</div>';
  }

  function selectModel(id) {
    var t = window.LabelTemplates.byId(id);
    if (!t || !(t._fit && t._fit.ok)) { alert('This model failed the A4-fit check and is disabled.'); return; }
    LS.tpl = t;
    LS.caps = window.LabelTemplates.meta(t);
    LS.cells = new Array(t.cols * t.rows).fill(null);
    LS.selectMode = false; LS.selected.clear();
    var sb = el('lsSelectBar'); if (sb) sb.style.display = 'none';
    var stg = el('lsSelectToggle'); if (stg) stg.classList.remove('active');
    el('lsEdName').textContent = LS.caps.name;
    el('lsEdMeta').textContent = LS.caps.size + ' · grid ' + LS.caps.grid + ' · ' + LS.caps.up + ' per sheet · Avery ' + LS.caps.avery + (LS.caps.code ? ' · Celcast ' + LS.caps.code : '');
    el('lsStart').value = 1;
    el('lsStart').max = t.cols * t.rows;
    el('lsSub').textContent = LS.caps.name + ' — ' + LS.caps.size;
    el('lsModels').style.display = 'none';
    el('lsEditor').style.display = 'block';
    renderSheet();
  }

  function backToModels() {
    el('lsEditor').style.display = 'none';
    el('lsModels').style.display = 'block';
    el('lsSub').textContent = 'Celcast label sheets · choose a model';
  }

  // ═══ STEP 2 — visual sheet ═══
  // Cells are drawn by the same renderer that writes the PDF, so the sheet is a
  // true proof of what will come out of the printer.
  function renderSheet() {
    var t = LS.tpl; if (!t) return;
    var sheet = el('lsSheet'), wrap = sheet.parentElement;
    var avail = Math.min((wrap.clientWidth || 520) - 4, 620);
    var scale = avail / window.LabelTemplates.A4_W;         // px per mm
    var maxH = 760;
    if (window.LabelTemplates.A4_H * scale > maxH) scale = maxH / window.LabelTemplates.A4_H;
    sheet.style.width = (window.LabelTemplates.A4_W * scale) + 'px';
    sheet.style.height = (window.LabelTemplates.A4_H * scale) + 'px';

    var start = Math.max(1, intVal('lsStart', 1));
    var opts = { productRecipe: LS.caps ? LS.caps.productRecipe : 'stack' };
    var total = t.cols * t.rows, html = '', badCount = 0;
    for (var p = 0; p < total; p++) {
      var r = Math.floor(p / t.cols), c = p % t.cols;
      var x = (t.marginLeft + c * t.pitchX) * scale;
      var y = (t.marginTop + r * t.pitchY) * scale;
      var w = t.labelW * scale, h = t.labelH * scale;
      var skipped = p < start - 1;
      var cell = LS.cells[p];
      var inner = '';
      if (skipped) { inner = ''; }
      else if (!cell || !cell.type) { inner = '<span class="ls-cell-empty">+</span>'; }
      else {
        var url = cellPreviewURL(cell, t.labelW, t.labelH, opts);
        inner = url ? '<img src="' + url + '" alt="" class="ls-cell-img" />' : '<span class="ls-cell-empty">?</span>';
      }

      // Flag any cell whose bars come out too narrow to scan, so a bad ticket is
      // caught on screen instead of on a wasted sheet.
      var bad = false;
      if (!skipped && cell && cell.type) {
        var q = window.LabelRender.cellScan(cell, t.labelW, t.labelH, opts.productRecipe);
        bad = !q.ok;
        if (bad) badCount++;
      }

      var isSel = LS.selectMode && LS.selected.has(p);
      var cls = 'ls-cell' + (skipped ? ' skipped' : '') +
        (cell && cell.type ? ' filled' : '') + (bad ? ' badscan' : '') +
        (LS.selectMode && !skipped ? ' selectable' : '') + (isSel ? ' selected' : '');
      var click = skipped ? '' : (LS.selectMode ? ' onclick="LS.toggleSelect(' + p + ')"' : ' onclick="LS.openCell(' + p + ')"');
      html += '<div class="' + cls + '" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;width:' + w.toFixed(1) + 'px;height:' + h.toFixed(1) + 'px;"' + click +
        (bad ? ' title="Barcode too narrow to scan reliably on this sheet"' : '') + '>' +
        '<span class="ls-cell-num">' + (p + 1) + '</span>' + inner +
        (bad ? '<span class="ls-cell-warn">!</span>' : '') + '</div>';
    }
    sheet.innerHTML = html;
    LS._badCount = badCount;
    updateSummary();
  }

  function updateSummary() {
    var t = LS.tpl; if (!t) return;
    var total = t.cols * t.rows;
    var start = Math.max(1, intVal('lsStart', 1));
    var sheets = Math.max(1, intVal('lsSheets', 1));
    var filled = LS.cells.filter(function (c) { return c && c.type; }).length;
    var first = 0, rest = 0;
    for (var p = 0; p < total; p++) {
      var c = LS.cells[p];
      if (c && c.type) { rest++; if (p >= start - 1) first++; }
    }
    var totalLabels = first + rest * (sheets - 1);
    var bad = LS._badCount || 0;
    el('lsSummary').innerHTML =
      '<b>' + filled + '</b> of ' + total + ' labels filled<br>' +
      'Sheet 1 starts at label <b>' + start + '</b>' + (start > 1 ? ' <span style="color:#8a97a2">(first ' + (start - 1) + ' already used)</span>' : '') + '<br>' +
      'Sheets: <b>' + sheets + '</b> · total to print: <b>' + totalLabels + '</b> labels' +
      (bad ? '<br><span style="color:#c0392b;">⚠ <b>' + bad + '</b> label' + (bad > 1 ? 's have' : ' has') +
             ' a barcode too narrow to scan on this sheet — marked in red.</span>' : '');
  }

  // ═══ Cell editor ═══
  // The tabs are built from the template's own capability list: a 38 mm ticket
  // never offers the full product sticker, because it could not carry it.
  function renderTypeTabs(active) {
    var allow = (LS.caps && LS.caps.allow) || ['product', 'barcode', 'text'];
    el('lsTypeTabs').innerHTML = allow.map(function (ty) {
      return '<div class="ls-type' + (ty === active ? ' active' : '') + '" data-type="' + ty + '" onclick="LS.pickType(\'' + ty + '\')">' +
        esc(TYPE_NAME[ty] || ty) + '</div>';
    }).join('');
  }
  function defaultType() {
    var allow = (LS.caps && LS.caps.allow) || ['product'];
    return allow[0];
  }

  function openCell(index) {
    LS.editor = { mode: 'cell', index: index, type: defaultType(), product: null };
    el('lsCellTitle').textContent = 'Label ' + (index + 1);
    var existing = LS.cells[index];
    resetEditorInputs();
    if (existing && existing.type) {
      pickType(existing.type);
      if (existing.type === 'product') { LS.editor.product = { sku: existing.sku, name: existing.name, barcode: existing.barcode, attribute1: existing.dc5 }; showChosen(); }
      else if (existing.type === 'text') { el('lsTextVal').value = existing.text || ''; }
      else if (existing.type === 'barcode') { el('lsBcVal').value = existing.value || ''; el('lsBcFmt').value = existing.fmt || 'auto'; }
      else if (existing.type === 'plabel') {
        LS.editor.plProduct = { sku: existing.code, name: existing.desc, barcode: existing.barcode };
        el('lsPlCode').value = existing.code || '';
        el('lsPlDesc').value = existing.desc || '';
        el('lsPlLines').value = (existing.lines || []).join('\n');
        if (el('lsPlBorder')) el('lsPlBorder').checked = !!existing.border;
        plBcNote(existing.barcode, existing.code);
        el('lsPlForm').style.display = 'block';
      }
    } else { pickType(defaultType()); }
    openModal('lsCellModal');
  }

  function openFillAll(preType) {
    var start = Math.max(1, intVal('lsStart', 1));
    LS.editor = { mode: 'all', index: -1, type: preType || defaultType(), product: null };
    el('lsCellTitle').textContent = 'Fill all (from label ' + start + ' to end)';
    resetEditorInputs();
    pickType(preType || defaultType());
    openModal('lsCellModal');
  }

  function resetEditorInputs() {
    el('lsProdSearch').value = ''; el('lsProdResults').style.display = 'none'; el('lsProdResults').innerHTML = '';
    el('lsProdChosen').style.display = 'none'; el('lsProdChosen').innerHTML = '';
    el('lsTextVal').value = ''; el('lsBcVal').value = ''; el('lsBcFmt').value = 'auto';
    var pls = el('lsPlSearch'); if (pls) pls.value = '';
    var plr = el('lsPlResults'); if (plr) { plr.style.display = 'none'; plr.innerHTML = ''; }
    var plf = el('lsPlForm'); if (plf) plf.style.display = 'none';
    ['lsPlCode', 'lsPlDesc', 'lsPlLines'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    if (el('lsPlBorder')) el('lsPlBorder').checked = false;
    LS.editor.product = null; LS.editor.plProduct = null;
  }

  function pickType(type) {
    LS.editor.type = type;
    renderTypeTabs(type);
    el('lsTypeProduct').style.display = type === 'product' ? 'block' : 'none';
    el('lsTypeProductLabel').style.display = type === 'plabel' ? 'block' : 'none';
    el('lsTypeText').style.display = type === 'text' ? 'block' : 'none';
    el('lsTypeBarcode').style.display = type === 'barcode' ? 'block' : 'none';
  }

  function searchProduct(term) {
    term = (term || '').trim().toLowerCase();
    var box = el('lsProdResults');
    if (term.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    if (!LS.products) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Loading products…</span></div>'; return; }
    LS._results = LS.products.filter(function (p) {
      return ((p.attribute1 || '').toLowerCase().indexOf(term) >= 0) || ((p.sku || '').toLowerCase().indexOf(term) >= 0) || ((p.name || '').toLowerCase().indexOf(term) >= 0);
    }).slice(0, 40);
    if (!LS._results.length) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Nothing found.</span></div>'; return; }
    box.innerHTML = LS._results.map(function (p, i) {
      return '<div class="ls-result" onclick="LS.chooseProduct(' + i + ')">' +
        '<span class="r5dc">' + esc(p.attribute1 || '') + '</span>' +
        '<span class="rsku">' + esc(p.sku || '') + '</span>' +
        '<span class="rname">' + esc((p.name || '').slice(0, 46)) + '</span></div>';
    }).join('');
    box.style.display = 'block';
  }

  function chooseProduct(i) {
    var p = LS._results[i]; if (!p) return;
    LS.editor.product = p;
    el('lsProdSearch').value = '';
    el('lsProdResults').style.display = 'none';
    showChosen();
  }

  // What will be encoded on THIS sheet, in what symbology, and whether the bars
  // end up wide enough to scan — all three decided by the template, so the
  // operator sees the real answer before printing.
  function bcStatusHtml(cell) {
    var recipe = LS.caps ? LS.caps.productRecipe : 'stack';
    var order = recipe === 'code5dc' ? ['barcode', 'dc5', 'sku', 'code'] : null;
    var eff = window.LabelRender.bcValue(cell, order);
    if (!eff) return '<span style="color:#c0392b;">No barcode and no code — nothing will be printed.</span>';
    var raw = String(cell.barcode == null ? '' : cell.barcode).trim();
    var fellBack = !raw || /^0+$/.test(raw);
    var box = window.LabelRender.barcodeBox(recipe, LS.caps.labelW, LS.caps.labelH);
    var q = window.LabelRender.scanQuality(eff, cell.fmt || 'auto', box.w, box.h);
    return 'Barcode: <b>' + esc(eff) + '</b> · ' + esc(q.format) +
      (fellBack ? ' <span style="color:#b45309;">(not in Cin7 — using the ' + (order && eff === String(cell.dc5 || '').trim() ? '5DC' : 'code') + ')</span>' : '') +
      '<br><span style="color:' + (q.ok ? '#1a8a4a' : '#c0392b') + ';">' +
        (q.ok ? '✓ scans well' : '⚠ bars too narrow to scan reliably') +
        ' — ' + q.moduleMM.toFixed(2) + ' mm per bar (min ' + q.minMM + ')</span>';
  }

  function showChosen() {
    var p = LS.editor.product; if (!p) return;
    var box = el('lsProdChosen');
    box.style.display = 'block';
    box.innerHTML =
      '<div style="padding:10px;border:1px solid #d7e3ec;border-radius:9px;background:#f7fbfd;">' +
        '<b style="font-size:15px;">' + esc(p.attribute1 || p.sku || '') + '</b> ' +
        '<span style="color:#5b6b78;">' + esc(p.sku || '') + '</span><br>' +
        '<span style="color:#5b6b78;font-size:12px;">' + esc((p.name || '').slice(0, 60)) + '</span>' +
        '<div style="color:#8a97a2;font-size:11.5px;margin-top:6px;line-height:1.5;">' +
          bcStatusHtml({ barcode: p.barcode, sku: p.sku, dc5: p.attribute1, fmt: 'auto' }) +
        '</div>' +
      '</div>';
  }

  // ── Product-label form: product search + auto-fill ──
  // Tell the operator the code that will actually be encoded — most of the
  // catalogue has no barcode in Cin7 and silently falls back to the SKU.
  function plBcNote(barcode, code) {
    var e = el('lsPlBc'); if (!e) return;
    e.innerHTML = bcStatusHtml({ barcode: barcode, code: code, fmt: 'auto' });
  }

  function cleanDesc(name) {
    // the label description is cleaner than the raw Cin7 name: drop the "(3000K…)"
    // tail and any "-Carton10" suffix, tidy trailing punctuation.
    return String(name || '').split('(')[0].replace(/[-–]\s*Carton\s*\d+\s*$/i, '').trim().replace(/[,;]\s*$/, '');
  }
  function plSearch(term) {
    term = (term || '').trim().toLowerCase();
    var box = el('lsPlResults');
    if (term.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    if (!LS.products) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Loading products…</span></div>'; return; }
    LS._plResults = LS.products.filter(function (p) {
      return ((p.attribute1 || '').toLowerCase().indexOf(term) >= 0) || ((p.sku || '').toLowerCase().indexOf(term) >= 0) || ((p.name || '').toLowerCase().indexOf(term) >= 0);
    }).slice(0, 40);
    if (!LS._plResults.length) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Nothing found.</span></div>'; return; }
    box.innerHTML = LS._plResults.map(function (p, i) {
      return '<div class="ls-result" onclick="LS.plChoose(' + i + ')">' +
        '<span class="r5dc">' + esc(p.attribute1 || '') + '</span>' +
        '<span class="rsku">' + esc(p.sku || '') + '</span>' +
        '<span class="rname">' + esc((p.name || '').slice(0, 46)) + '</span></div>';
    }).join('');
    box.style.display = 'block';
  }
  function plChoose(i) {
    var p = LS._plResults[i]; if (!p) return;
    LS.editor.plProduct = { sku: p.sku, name: p.name, barcode: p.barcode, attribute1: p.attribute1 };
    el('lsPlSearch').value = '';
    el('lsPlResults').style.display = 'none';
    el('lsPlCode').value = p.sku || '';
    el('lsPlDesc').value = cleanDesc(p.name);
    if (!el('lsPlLines').value.trim()) el('lsPlLines').value = '200 – 240VAC / 50-60Hz';
    plBcNote(p.barcode, p.sku);
    el('lsPlForm').style.display = 'block';
  }

  function applyCell() {
    var type = LS.editor.type, cell = null;
    if (type === 'product') {
      if (!LS.editor.product) { alert('Choose a product — or use Barcode / Text.'); return; }
      var pr = LS.editor.product;
      cell = { type: 'product', sku: pr.sku, name: pr.name, barcode: pr.barcode, dc5: pr.attribute1, fmt: 'auto' };
    } else if (type === 'text') {
      var tv = el('lsTextVal').value.trim();
      if (!tv) { alert('Type some text.'); return; }
      cell = { type: 'text', text: tv };
    } else if (type === 'barcode') {
      var bv = el('lsBcVal').value.trim();
      if (!bv) { alert('Type the code value.'); return; }
      cell = { type: 'barcode', value: bv, fmt: el('lsBcFmt').value };
    } else if (type === 'plabel') {
      var plCode = el('lsPlCode').value.trim();
      if (!plCode && !LS.editor.plProduct) { alert('Find a product first.'); return; }
      var plLines = el('lsPlLines').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var plBc = (LS.editor.plProduct && LS.editor.plProduct.barcode) || '';
      cell = { type: 'plabel', code: plCode, desc: el('lsPlDesc').value.trim(), lines: plLines, barcode: plBc, border: !!(el('lsPlBorder') && el('lsPlBorder').checked), fmt: 'auto' };
    }
    if (LS.editor.mode === 'all') {
      var start = Math.max(1, intVal('lsStart', 1));
      for (var p = start - 1; p < LS.tpl.cols * LS.tpl.rows; p++) LS.cells[p] = cell ? Object.assign({}, cell) : null;
    } else if (LS.editor.mode === 'selected') {
      LS.selected.forEach(function (p) { LS.cells[p] = cell ? Object.assign({}, cell) : null; });
    } else {
      LS.cells[LS.editor.index] = cell ? Object.assign({}, cell) : null;
    }
    closeCell();
    renderSheet();
  }

  function clearAll() {
    if (!LS.tpl) return;
    if (!confirm('Clear all labels on this sheet?')) return;
    LS.cells = new Array(LS.tpl.cols * LS.tpl.rows).fill(null);
    renderSheet();
  }

  // ═══ Multi-select (for models with many labels) ═══
  function toggleSelectMode() {
    LS.selectMode = !LS.selectMode;
    if (!LS.selectMode) LS.selected.clear();
    el('lsSelectBar').style.display = LS.selectMode ? 'flex' : 'none';
    el('lsSelectToggle').classList.toggle('active', LS.selectMode);
    updateSelCount();
    renderSheet();
  }
  function toggleSelect(p) {
    if (LS.selected.has(p)) LS.selected.delete(p); else LS.selected.add(p);
    updateSelCount();
    renderSheet();
  }
  function selectAll() {
    if (!LS.tpl) return;
    var start = Math.max(1, intVal('lsStart', 1)), total = LS.tpl.cols * LS.tpl.rows;
    LS.selected.clear();
    for (var p = start - 1; p < total; p++) LS.selected.add(p);
    updateSelCount(); renderSheet();
  }
  function selectNone() { LS.selected.clear(); updateSelCount(); renderSheet(); }
  function updateSelCount() { var e = el('lsSelCount'); if (e) e.textContent = LS.selected.size + ' selected'; }
  function openFillSelected() {
    if (!LS.selected.size) { alert('Select one or more labels first (click them).'); return; }
    LS.editor = { mode: 'selected', index: -1, type: defaultType(), product: null };
    el('lsCellTitle').textContent = 'Fill ' + LS.selected.size + ' selected label' + (LS.selected.size > 1 ? 's' : '');
    resetEditorInputs();
    pickType(defaultType());
    openModal('lsCellModal');
  }
  function clearSelected() {
    if (!LS.selected.size) return;
    LS.selected.forEach(function (p) { LS.cells[p] = null; });
    renderSheet();
  }

  // ═══ Generate the A4 PDF ═══
  function generatePdf() {
    var t = LS.tpl; if (!t) return;
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load. Reload the page.'); return; }
    // compress: the brand images are plain RGB and the vector bars are a long
    // run of rectangles — both deflate to a fraction of their raw size.
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    var sheets = Math.max(1, intVal('lsSheets', 1));
    var start = Math.max(1, intVal('lsStart', 1));
    var total = t.cols * t.rows;
    var opts = { productRecipe: LS.caps ? LS.caps.productRecipe : 'stack' };

    for (var s = 0; s < sheets; s++) {
      if (s > 0) doc.addPage();
      for (var p = 0; p < total; p++) {
        if (s === 0 && p < start - 1) continue;            // reuse a partly-used sheet
        var cell = LS.cells[p];
        if (!cell || !cell.type) continue;
        var r = Math.floor(p / t.cols), c = p % t.cols;
        var pos = window.LabelTemplates.cellXY(t, r, c);
        window.LabelRender.toPdf(doc, cell, pos.x, pos.y, pos.w, pos.h, opts);
      }
    }

    try {
      var url = doc.output('bloburl');
      var win = window.open(url, '_blank');
      if (!win) doc.save('labels-' + t.id + '.pdf');
    } catch (e) {
      doc.save('labels-' + t.id + '.pdf');
    }
  }

  // ═══ modal helpers ═══
  function openModal(id) { el(id).classList.add('open'); }
  function closeModal(id) { el(id).classList.remove('open'); }
  function closeCell() { closeModal('lsCellModal'); }

  // ═══ products load (mirror of multi-label.js) ═══
  function loadProducts() {
    (async function () {
      try {
        if (window.supabaseReady) { try { await window.supabaseReady; } catch (e) {} }
        var sb = window.supabase;
        if (!sb || !sb.from) { console.warn('label-sheets: supabase not ready'); return; }
        var all = [], from = 0, size = 1000;
        while (true) {
          var res = await sb.schema('cin7_mirror').from('products').select('sku, name, barcode, attribute1').range(from, from + size - 1);
          if (res.error) { console.warn('label-sheets: products error', res.error.message); break; }
          var rows = res.data || [];
          all = all.concat(rows);
          if (rows.length < size) break;
          from += size;
          if (from > 40000) break;
        }
        LS.products = all;
        console.log('label-sheets: loaded ' + all.length + ' products from cin7_mirror');
      } catch (e) { console.warn('label-sheets: loadProducts failed', e); }
    })();
  }

  // jsPDF mangles embedded JPEG/PIL-PNG into black side-panels; re-encode each brand
  // asset through a canvas (like the barcode, which renders clean) -> safe PNG.
  function normalizeAssets() {
    if (!window.LABEL_ASSETS) return;
    var pending = 0, done = function () {
      pending--;
      if (pending <= 0) {
        LS._prev = {};
        if (el('lsEditor') && el('lsEditor').style.display === 'block') renderSheet(); else renderModels();
      }
    };
    ['logo', 'symbols'].forEach(function (k) {
      var a = window.LABEL_ASSETS[k]; if (!a || !a.url) return;
      pending++;
      var img = new Image();
      img.onload = function () {
        a.img = img;   // keep the loaded Image for canvas drawImage (preview + print)
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth || a.w; c.height = img.naturalHeight || a.h;
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          a.url = c.toDataURL('image/png'); a.type = 'PNG'; a.w = c.width; a.h = c.height;
        } catch (e) {}
        done();
      };
      img.onerror = done;
      img.src = a.url;
    });
  }

  // ═══ init ═══
  function init() {
    normalizeAssets();
    renderModels();
    loadProducts();
    var sheetsInput = el('lsSheets');
    if (sheetsInput) sheetsInput.addEventListener('input', updateSummary);
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (el('lsEditor').style.display !== 'block') return;
      clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSheet, 150);
    });
    var m = el('lsCellModal');
    if (m) m.addEventListener('click', function (ev) { if (ev.target === m) m.classList.remove('open'); });
  }

  // expose
  LS.selectModel = selectModel;
  LS.backToModels = backToModels;
  LS.renderSheet = renderSheet;
  LS.updateSummary = updateSummary;
  LS.openCell = openCell;
  LS.openFillAll = openFillAll;
  LS.pickType = pickType;
  LS.searchProduct = searchProduct;
  LS.chooseProduct = chooseProduct;
  LS.plSearch = plSearch;
  LS.plChoose = plChoose;
  LS.applyCell = applyCell;
  LS.closeCell = closeCell;
  LS.clearAll = clearAll;
  LS.generatePdf = generatePdf;
  LS.toggleSelectMode = toggleSelectMode;
  LS.toggleSelect = toggleSelect;
  LS.selectAll = selectAll;
  LS.selectNone = selectNone;
  LS.openFillSelected = openFillSelected;
  LS.clearSelected = clearSelected;
  LS.cellPreviewURL = cellPreviewURL;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
