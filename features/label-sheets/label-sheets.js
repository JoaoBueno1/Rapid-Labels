/*
 * label-sheets.js — Label Sheets feature (isolated). Read-only on data:
 * pulls products from cin7_mirror.products (same as multi-label), never writes.
 * Print precision: renders a real A4 PDF with every label placed at its exact
 * CALIBRATED mm position (jsPDF, unit mm) — no browser print scaling involved.
 */
(function () {
  'use strict';

  var LS = {
    tpl: null,
    cells: [],           // per-position content or null
    products: null,      // cin7_mirror.products cache
    _results: [],        // current product-search matches
    selectMode: false,   // multi-select mode on/off
    selected: new Set(), // selected cell indices (multi-select)
    editor: { mode: 'cell', index: 0, type: 'product', product: null }
  };
  window.LS = LS;

  // ── helpers ──
  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function intVal(id, def) { var v = parseInt(el(id) && el(id).value, 10); return isNaN(v) ? def : v; }
  function looksEan13(v) { return /^\d{12,13}$/.test(String(v == null ? '' : v).trim()); }

  // ═══ STEP 1 — model picker ═══
  function renderModels() {
    var grid = el('lsModelGrid');
    grid.innerHTML = window.LabelTemplates.list().map(function (t) {
      var m = window.LabelTemplates.meta(t);
      var prev = window.LabelTemplates.svgPreview(t, 178, 196);
      var codeBadge = m.code
        ? '<span class="ls-badge code">Celcast ' + m.code + '</span>'
        : '<span class="ls-badge code">Celcast compat.</span>';
      return '<div class="ls-card' + (m.fits ? '' : ' bad') + '" onclick="LS.selectModel(\'' + t.id + '\')">' +
        '<div class="ls-card-preview">' + prev + '</div>' +
        '<div class="ls-card-title">' + esc(m.name) + '</div>' +
        '<div class="ls-card-sub">' + esc(m.size) + ' · grid ' + esc(m.grid) + '</div>' +
        '<div class="ls-badges">' +
          '<span class="ls-badge up">' + m.up + ' per sheet</span>' +
          '<span class="ls-badge">Avery ' + esc(m.avery) + '</span>' +
          codeBadge +
        '</div></div>';
    }).join('');
  }

  function selectModel(id) {
    var t = window.LabelTemplates.byId(id);
    if (!t || !(t._fit && t._fit.ok)) { alert('This model failed the A4-fit check and is disabled.'); return; }
    LS.tpl = t;
    LS.cells = new Array(t.cols * t.rows).fill(null);
    LS.selectMode = false; LS.selected.clear();
    var sb = el('lsSelectBar'); if (sb) sb.style.display = 'none';
    var stg = el('lsSelectToggle'); if (stg) stg.classList.remove('active');
    var m = window.LabelTemplates.meta(t);
    el('lsEdName').textContent = m.name;
    el('lsEdMeta').textContent = m.size + ' · grid ' + m.grid + ' · ' + m.up + ' per sheet · Avery ' + m.avery + (m.code ? ' · Celcast ' + m.code : '');
    el('lsStart').value = 1;
    el('lsStart').max = t.cols * t.rows;
    el('lsSub').textContent = m.name + ' — ' + m.size;
    el('lsModels').style.display = 'none';
    el('lsEditor').style.display = 'block';
    updateCalibPill();
    renderSheet();
  }

  function backToModels() {
    el('lsEditor').style.display = 'none';
    el('lsModels').style.display = 'block';
    el('lsSub').textContent = 'Celcast label sheets · choose a model';
  }

  // ═══ STEP 2 — visual sheet ═══
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
    var showName = t.labelH >= 30;                          // preview mirrors the adaptive PDF layout
    var total = t.cols * t.rows, html = '';
    for (var p = 0; p < total; p++) {
      var r = Math.floor(p / t.cols), c = p % t.cols;
      var x = (t.marginLeft + c * t.pitchX) * scale;
      var y = (t.marginTop + r * t.pitchY) * scale;
      var w = t.labelW * scale, h = t.labelH * scale;
      var skipped = p < start - 1;
      var cell = LS.cells[p];
      var inner = '';
      if (skipped) { inner = ''; }
      else if (!cell || cell.type === 'blank') { inner = '<span class="ls-cell-empty">+</span>'; }
      else if (cell.type === 'product') {
        inner = (showName && cell.name ? '<span class="ls-cell-name">' + esc(String(cell.name).slice(0, 46)) + '</span>' : '') +
          '<span class="ls-cell-5dc">' + esc(cell.dc5 || cell.sku || '') + '</span>' +
          '<span class="ls-cell-bc">▮▮▮</span>';
      }
      else if (cell.type === 'text') { inner = '<span class="ls-cell-txt">' + esc((cell.text || '').slice(0, 44)) + '</span>'; }
      else if (cell.type === 'barcode') { inner = '<span class="ls-cell-bc">▮▮ ' + esc(String(cell.value || '').slice(0, 14)) + '</span>'; }

      var isSel = LS.selectMode && LS.selected.has(p);
      var cls = 'ls-cell' + (skipped ? ' skipped' : '') +
        (cell && cell.type && cell.type !== 'blank' ? ' filled' : '') +
        (LS.selectMode && !skipped ? ' selectable' : '') + (isSel ? ' selected' : '');
      var click = skipped ? '' : (LS.selectMode ? ' onclick="LS.toggleSelect(' + p + ')"' : ' onclick="LS.openCell(' + p + ')"');
      html += '<div class="' + cls + '" style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;width:' + w.toFixed(1) + 'px;height:' + h.toFixed(1) + 'px;"' + click + '>' +
        '<span class="ls-cell-num">' + (p + 1) + '</span>' + inner + '</div>';
    }
    sheet.innerHTML = html;
    updateSummary();
  }

  function updateSummary() {
    var t = LS.tpl; if (!t) return;
    var total = t.cols * t.rows;
    var start = Math.max(1, intVal('lsStart', 1));
    var sheets = Math.max(1, intVal('lsSheets', 1));
    var filled = LS.cells.filter(function (c) { return c && c.type && c.type !== 'blank'; }).length;
    var first = 0, rest = 0;
    for (var p = 0; p < total; p++) {
      var c = LS.cells[p];
      if (c && c.type && c.type !== 'blank') { rest++; if (p >= start - 1) first++; }
    }
    var totalLabels = first + rest * (sheets - 1);
    el('lsSummary').innerHTML =
      '<b>' + filled + '</b> of ' + total + ' labels filled<br>' +
      'Sheet 1 starts at label <b>' + start + '</b>' + (start > 1 ? ' <span style="color:#8a97a2">(first ' + (start - 1) + ' already used)</span>' : '') + '<br>' +
      'Sheets: <b>' + sheets + '</b> · total to print: <b>' + totalLabels + '</b> labels';
  }

  // ═══ Cell editor ═══
  function openCell(index) {
    LS.editor = { mode: 'cell', index: index, type: 'product', product: null };
    el('lsCellTitle').textContent = 'Label ' + (index + 1);
    var existing = LS.cells[index];
    resetEditorInputs();
    if (existing) {
      pickType(existing.type === 'blank' ? 'blank' : existing.type);
      if (existing.type === 'product') { LS.editor.product = { sku: existing.sku, name: existing.name, barcode: existing.barcode, attribute1: existing.dc5 }; showChosen(); }
      else if (existing.type === 'text') { el('lsTextVal').value = existing.text || ''; }
      else if (existing.type === 'barcode') { el('lsBcVal').value = existing.value || ''; el('lsBcFmt').value = existing.fmt || 'auto'; }
    } else { pickType('product'); }
    openModal('lsCellModal');
  }

  function openFillAll() {
    var start = Math.max(1, intVal('lsStart', 1));
    LS.editor = { mode: 'all', index: -1, type: 'product', product: null };
    el('lsCellTitle').textContent = 'Fill all (from label ' + start + ' to end)';
    resetEditorInputs();
    pickType('product');
    openModal('lsCellModal');
  }

  function resetEditorInputs() {
    el('lsProdSearch').value = ''; el('lsProdResults').style.display = 'none'; el('lsProdResults').innerHTML = '';
    el('lsProdChosen').style.display = 'none'; el('lsProdChosen').innerHTML = '';
    el('lsTextVal').value = ''; el('lsBcVal').value = ''; el('lsBcFmt').value = 'auto';
    LS.editor.product = null;
  }

  function pickType(type) {
    LS.editor.type = type;
    var tabs = document.querySelectorAll('#lsTypeTabs .ls-type');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-type') === type);
    el('lsTypeProduct').style.display = type === 'product' ? 'block' : 'none';
    el('lsTypeText').style.display = type === 'text' ? 'block' : 'none';
    el('lsTypeBarcode').style.display = type === 'barcode' ? 'block' : 'none';
    el('lsTypeBlank').style.display = type === 'blank' ? 'block' : 'none';
  }

  function searchProduct(term) {
    term = (term || '').trim().toLowerCase();
    var box = el('lsProdResults');
    if (term.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    if (!LS.products) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Loading products…</span></div>'; return; }
    LS._results = LS.products.filter(function (p) {
      return ((p.attribute1 || '').toLowerCase().indexOf(term) >= 0) ||
             ((p.sku || '').toLowerCase().indexOf(term) >= 0) ||
             ((p.name || '').toLowerCase().indexOf(term) >= 0);
    }).slice(0, 40);
    if (!LS._results.length) {
      box.style.display = 'block';
      box.innerHTML = '<div class="ls-result"><span class="rname">Nothing found — you can still use Text or Barcode.</span></div>';
      return;
    }
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
    LS.editor.product = { sku: p.sku, name: p.name, barcode: p.barcode, attribute1: p.attribute1 };
    el('lsProdResults').style.display = 'none';
    el('lsProdSearch').value = '';
    showChosen();
  }

  function showChosen() {
    var p = LS.editor.product; if (!p) return;
    el('lsProdChosen').style.display = 'block';
    el('lsProdChosen').innerHTML =
      '<div style="padding:10px 12px;background:#eef6fb;border-radius:8px;">' +
        '<b>' + esc(p.attribute1 || '') + '</b> — ' + esc(p.sku || '') + '<br>' +
        '<span style="color:#5b6b78;font-size:12px;">' + esc((p.name || '').slice(0, 60)) + '</span><br>' +
        '<span style="color:#8a97a2;font-size:11.5px;">barcode: ' + esc(p.barcode || '(uses SKU)') + '</span>' +
      '</div>';
  }

  function applyCell() {
    var type = LS.editor.type, cell = null;
    if (type === 'product') {
      if (!LS.editor.product) { alert('Choose a product — or use Text/Barcode.'); return; }
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
    } else if (type === 'blank') {
      cell = null;
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
    LS.editor = { mode: 'selected', index: -1, type: 'product', product: null };
    el('lsCellTitle').textContent = 'Fill ' + LS.selected.size + ' selected label' + (LS.selected.size > 1 ? 's' : '');
    resetEditorInputs();
    pickType('product');
    openModal('lsCellModal');
  }
  function clearSelected() {
    if (!LS.selected.size) return;
    LS.selected.forEach(function (p) { LS.cells[p] = null; });
    renderSheet();
  }

  // ═══ Barcode → dataURL (for exact-mm PDF placement) ═══
  function barcodeDataUrl(value, fmt) {
    value = String(value == null ? '' : value).trim();
    if (!value) return null;
    var format = fmt === 'auto' || !fmt ? (looksEan13(value) ? 'EAN13' : 'CODE128') : fmt;
    var canvas = document.createElement('canvas');
    try {
      JsBarcode(canvas, value, { format: format, height: 130, width: 2, displayValue: true, fontSize: 28, margin: 6, textMargin: 2 });
    } catch (e) {
      try { JsBarcode(canvas, value, { format: 'CODE128', height: 130, width: 2, displayValue: true, fontSize: 28, margin: 6, textMargin: 2 }); }
      catch (e2) { return null; }
    }
    return { url: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height };
  }

  // ═══ Render one cell into the PDF at exact mm ═══
  var PT2MM = 0.3528;
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function renderCellPdf(doc, cell, x, y, w, h) {
    if (cell.type === 'text') {
      var pad0 = 1.4, iw0 = w - 2 * pad0;
      var fs = Math.max(6, Math.min(13, (h - 2 * pad0) * 1.6));
      doc.setFont('helvetica', 'normal'); doc.setFontSize(fs);
      var lines = doc.splitTextToSize(cell.text || '', iw0);
      var lh = fs * PT2MM * 1.15, total = lines.length * lh, ty = y + h / 2 - total / 2 + lh * 0.8;
      for (var i = 0; i < lines.length; i++) { doc.text(lines[i], x + w / 2, ty, { align: 'center' }); ty += lh; }
      return;
    }
    if (cell.type === 'product') { renderProductCell(doc, cell, x, y, w, h); return; }
    renderBarcodeOnly(doc, cell.value, cell.fmt, x, y, w, h);
  }

  // Adaptive product label: stacks [name?] [5DC] [barcode], sized to the square.
  // Big labels get a 2-line name; medium/wide get 1 line; tiny ones drop the name
  // (and, if truly cramped, the 5DC) so the barcode always stays scannable.
  function renderProductCell(doc, cell, x, y, w, h) {
    var pad = clamp(Math.min(w, h) * 0.05, 1.0, 2.0);
    var iw = w - 2 * pad, ih = h - 2 * pad, cx = x + w / 2;
    var value = cell.barcode || cell.sku;
    var bc = value ? barcodeDataUrl(value, cell.fmt || 'auto') : null;

    var rows = [];
    if (cell.name && (ih >= 46 || (ih >= 30 && iw >= 55))) {           // Product name
      var nfs = clamp(ih * 0.11, 6, 10);
      var maxLines = ih >= 46 ? 2 : 1;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(nfs);
      doc.splitTextToSize(String(cell.name), iw).slice(0, maxLines).forEach(function (ln) { rows.push({ t: ln, fs: nfs, b: false }); });
    }
    if (cell.dc5 && ih >= 16) rows.push({ t: String(cell.dc5), fs: clamp(ih * 0.17, 8, 13), b: true }); // 5DC (bold)

    var lineGap = 1.12;
    var textH = rows.reduce(function (s, r) { return s + r.fs * PT2MM * lineGap; }, 0);
    var gap = rows.length && bc ? clamp(ih * 0.04, 0.6, 1.6) : 0;

    var bcW = 0, bcH = 0;
    if (bc) {
      var areaH = ih - textH - gap;
      if (areaH < 5) { rows = []; textH = 0; gap = 0; areaH = ih; }    // too tight -> barcode only
      var asp = bc.w / bc.h;
      bcW = iw; bcH = bcW / asp;
      if (bcH > areaH) { bcH = areaH; bcW = bcH * asp; }
    }

    var cy = y + pad + Math.max(0, (ih - (textH + gap + bcH)) / 2);     // vertically centered stack
    for (var i = 0; i < rows.length; i++) {
      doc.setFont('helvetica', rows[i].b ? 'bold' : 'normal'); doc.setFontSize(rows[i].fs);
      cy += rows[i].fs * PT2MM;
      doc.text(rows[i].t, cx, cy, { align: 'center' });
      cy += rows[i].fs * PT2MM * (lineGap - 1);
    }
    if (bc) { cy += gap; doc.addImage(bc.url, 'PNG', x + (w - bcW) / 2, cy, bcW, bcH); }
    else if (value) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(String(value), cx, y + h / 2, { align: 'center' }); }
  }

  function renderBarcodeOnly(doc, value, fmt, x, y, w, h) {
    value = value != null ? String(value) : '';
    if (!value) return;
    var pad = clamp(Math.min(w, h) * 0.05, 1.0, 2.0), iw = w - 2 * pad, ih = h - 2 * pad;
    var bc = barcodeDataUrl(value, fmt || 'auto');
    if (!bc) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(value, x + w / 2, y + h / 2, { align: 'center' }); return; }
    var asp = bc.w / bc.h, bw = iw, bh = bw / asp;
    if (bh > ih) { bh = ih; bw = bh * asp; }
    doc.addImage(bc.url, 'PNG', x + (w - bw) / 2, y + (h - bh) / 2, bw, bh);
  }

  function drawCrosshairs(doc) {
    var pts = [[10, 10], [200, 10], [10, 287], [200, 287]];
    doc.setDrawColor(0); doc.setLineWidth(0.2);
    pts.forEach(function (p) { doc.line(p[0] - 4, p[1], p[0] + 4, p[1]); doc.line(p[0], p[1] - 4, p[0], p[1] + 4); });
    doc.setFontSize(6); doc.setTextColor(120);
    doc.text('Marks 10 mm from edge — print at 100% / Actual size (no page scaling)', 105, 293, { align: 'center' });
  }

  // ═══ Generate PDF (real print or calibration outline) ═══
  function generatePdf(testOutline) {
    var t = LS.tpl; if (!t) return;
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load. Reload the page.'); return; }
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    var sheets = testOutline ? 1 : Math.max(1, intVal('lsSheets', 1));
    var start = Math.max(1, intVal('lsStart', 1));
    var total = t.cols * t.rows;

    for (var s = 0; s < sheets; s++) {
      if (s > 0) doc.addPage();
      for (var p = 0; p < total; p++) {
        var r = Math.floor(p / t.cols), c = p % t.cols;
        var pos = window.LabelTemplates.cellXY(t, r, c);   // calibrated mm
        if (testOutline) {
          doc.setDrawColor(150); doc.setLineWidth(0.2);
          if (t.radius > 0) doc.roundedRect(pos.x, pos.y, pos.w, pos.h, t.radius, t.radius, 'S');
          else doc.rect(pos.x, pos.y, pos.w, pos.h, 'S');
          doc.setFontSize(7); doc.setTextColor(150);
          doc.text(String(p + 1), pos.x + 1.5, pos.y + 4);
          continue;
        }
        if (s === 0 && p < start - 1) continue;            // reuse partial (sheet 1 only)
        var cell = LS.cells[p];
        if (!cell || cell.type === 'blank') continue;
        doc.setTextColor(20);
        renderCellPdf(doc, cell, pos.x, pos.y, pos.w, pos.h);
      }
    }
    if (testOutline) drawCrosshairs(doc);

    try {
      var url = doc.output('bloburl');
      var win = window.open(url, '_blank');
      if (!win) doc.save((testOutline ? 'calibration-' : 'labels-') + t.id + '.pdf');
    } catch (e) {
      doc.save((testOutline ? 'calibration-' : 'labels-') + t.id + '.pdf');
    }
  }

  // ═══ Calibration ═══
  function updateCalibPill() {
    var on = LS.tpl && window.LabelTemplates.isCalibrated(LS.tpl.id);
    ['lsCalibPill', 'lsCalibPill2'].forEach(function (id) {
      var e = el(id); if (!e) return;
      e.className = 'ls-calib-pill ' + (on ? 'on' : 'off');
      e.textContent = on ? 'Calibrated' : (id === 'lsCalibPill2' ? 'off' : 'Not calibrated');
    });
  }
  function openCalib() {
    if (!LS.tpl) return;
    var c = window.LabelTemplates.getCalib(LS.tpl.id);
    el('lsCalibModel').textContent = window.LabelTemplates.meta(LS.tpl).name;
    el('lsCbOffX').value = c.offsetX; el('lsCbOffY').value = c.offsetY;
    el('lsCbPitchX').value = c.pitchXAdj; el('lsCbPitchY').value = c.pitchYAdj;
    openModal('lsCalibModal');
  }
  function saveCalib() {
    if (!LS.tpl) return;
    window.LabelTemplates.setCalib(LS.tpl.id, {
      offsetX: parseFloat(el('lsCbOffX').value) || 0,
      offsetY: parseFloat(el('lsCbOffY').value) || 0,
      pitchXAdj: parseFloat(el('lsCbPitchX').value) || 0,
      pitchYAdj: parseFloat(el('lsCbPitchY').value) || 0
    });
    updateCalibPill();
    closeCalib();
  }
  function resetCalib() {
    el('lsCbOffX').value = 0; el('lsCbOffY').value = 0; el('lsCbPitchX').value = 0; el('lsCbPitchY').value = 0;
    if (LS.tpl) { window.LabelTemplates.setCalib(LS.tpl.id, {}); updateCalibPill(); }
  }
  function printOutline() { generatePdf(true); }

  // ═══ modal helpers ═══
  function openModal(id) { el(id).classList.add('open'); }
  function closeModal(id) { el(id).classList.remove('open'); }
  function closeCell() { closeModal('lsCellModal'); }
  function closeCalib() { closeModal('lsCalibModal'); }

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

  // ═══ init ═══
  function init() {
    renderModels();
    loadProducts();
    var sheetsInput = el('lsSheets');
    if (sheetsInput) sheetsInput.addEventListener('input', updateSummary);
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (el('lsEditor').style.display !== 'block') return;
      clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSheet, 150);
    });
    // click backdrop to close
    ['lsCellModal', 'lsCalibModal'].forEach(function (id) {
      var m = el(id);
      if (m) m.addEventListener('click', function (ev) { if (ev.target === m) m.classList.remove('open'); });
    });
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
  LS.applyCell = applyCell;
  LS.closeCell = closeCell;
  LS.clearAll = clearAll;
  LS.generatePdf = generatePdf;
  LS.openCalib = openCalib;
  LS.saveCalib = saveCalib;
  LS.resetCalib = resetCalib;
  LS.closeCalib = closeCalib;
  LS.printOutline = printOutline;
  LS.toggleSelectMode = toggleSelectMode;
  LS.toggleSelect = toggleSelect;
  LS.selectAll = selectAll;
  LS.selectNone = selectNone;
  LS.openFillSelected = openFillSelected;
  LS.clearSelected = clearSelected;
  LS.renderCellPdf = renderCellPdf;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
