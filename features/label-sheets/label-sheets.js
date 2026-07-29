/*
 * label-sheets.js — Label Sheets feature (isolated). Read-only on data:
 * pulls products from cin7_mirror.products (same as multi-label), never writes.
 *
 * Print precision: renders a real A4 PDF with every label placed at its exact
 * mm position (jsPDF, unit mm). The published Avery/Celcast geometry is the
 * starting point, but a real printer still drifts a few mm (non-printable
 * border, driver centring), so each sheet keeps a small saved X/Y PRINTER
 * OFFSET (localStorage, per template) plus an ALIGNMENT TEST print — outlines +
 * a 100 mm ruler you overlay on a blank sheet to dial it in once. Printing at
 * 100% / Actual size is still required (a browser cannot force it); the ruler is
 * how the operator confirms the scale is right.
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
  function numVal(id, def) { var v = parseFloat(el(id) && el(id).value); return isNaN(v) ? def : v; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtDate(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }   // ISO → DD/MM/YYYY
  function dateToISO(s) { var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '')); return m ? m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]) : ''; }

  // ── Printer offset (calibration) ──
  // The one number a real printer forces on us: even at 100% scale a sheet lands
  // a couple of mm off (unprintable border, driver centring). We save a per-model
  // X/Y nudge (mm) and add it to every label's position in the PDF, so the
  // operator dials each Celcast sheet in once and it stays. Screen preview stays
  // at the true die-cut geometry; the offset only ever touches paper.
  function calibKey(id) { return 'ls_calib_' + id; }
  function getCalib(id) {
    try { var v = JSON.parse(localStorage.getItem(calibKey(id))); if (v && isFinite(v.dx) && isFinite(v.dy)) return { dx: +v.dx, dy: +v.dy }; } catch (e) {}
    return { dx: 0, dy: 0 };
  }
  function setCalib(id, dx, dy) { try { localStorage.setItem(calibKey(id), JSON.stringify({ dx: dx, dy: dy })); } catch (e) {} }
  // Calibrated top-left of a cell (mm) — used for the PDF and the test print.
  function cellPosCal(t, r, c) {
    var pos = window.LabelTemplates.cellXY(t, r, c), cal = getCalib(t.id);
    return { x: pos.x + cal.dx, y: pos.y + cal.dy, w: pos.w, h: pos.h };
  }

  // What each content type is called and what it does — shown on the model
  // cards so the operator can pick a sheet by what it prints, not by its code.
  var TYPE_NAME = { product: 'Product', plabel: 'Product label', location: 'Location', barcode: 'Barcode', text: 'Text', biglabel: 'Warehouse label' };
  function typeHint(type, recipe) {
    if (type === 'product') {
      if (recipe === 'code5dc') return '5DC + barcode, from a product';
      if (recipe === 'shipping') return 'Code on top, 5DC left, barcode right';
      return 'Code, 5DC and barcode';
    }
    if (type === 'plabel') return 'Rapid LED sticker';
    if (type === 'location') return 'Bin code — big, barcode, code again';
    if (type === 'barcode') return 'Any code — EAN-13 or CODE128';
    if (type === 'text') return 'Free text';
    if (type === 'biglabel') return 'SKU, code, barcode, QTY and date';
    return '';
  }
  // Types whose example teaches nothing on a card. Free text renders the same
  // way on every sheet — no layout to compare, no size to judge — so nine
  // identical thumbnails only add noise. It stays fully usable in the editor on
  // the templates that allow it.
  var NO_PREVIEW = { text: true };

  // Realistic sample content, so an example looks like the real thing.
  var SAMPLES = {
    product: { type: 'product', sku: 'R1021-WH-TRI', name: '8w Dimmable Downlight', dc5: '95908', barcode: '9727435304891', fmt: 'auto' },
    barcode: { type: 'barcode', value: '9727435304891', fmt: 'auto' },
    location: { type: 'location', code: 'MA-G-13-L3' },
    text: { type: 'text', text: 'Rapid LED' },
    plabel: { type: 'plabel', code: 'R1021-WH-TRI', dc5: '95908', desc: '8w Dimmable Downlight Integral Driver IP54 90mm Cut Out, Tri', lines: ['200 – 240VAC / 50-60Hz'], barcode: '9727435304891', fmt: 'auto' },
    biglabel: { type: 'biglabel', sku: 'R1021-WH-TRI', code: 'R1021-WH-TRI', dc5: '95908', qty: '50', date: '28/07/2026', fmt: 'auto' },
    multitable: { type: 'multitable', date: '28/07/2026', rows: [
      { dc5: '95908', sku: 'R1021-WH-TRI', barcode: '9727435304891', qty: '50' },
      { dc5: '30361', sku: 'R2201-WH-40', barcode: '', qty: '8' },
      { dc5: '77777', sku: 'R3206-TRI', barcode: '9727435181869', qty: '6' }
    ] }
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
  // ── Inline SVGs for the Zebra cards (no external asset, CSP-safe) ──
  // A thermal printer with a 4×6 label emerging; the label content differs per
  // model (3 barcode sections, or 1/2 Rapid LED stickers).
  function zbBars(x, y, w, h) {
    var pat = [2, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 2, 1], s = '', bx = x, i = 0;
    while (bx < x + w - 1) {
      var bw = pat[i % pat.length];
      if (i % 2 === 0) s += '<rect x="' + bx.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" fill="#111"/>';
      bx += bw + 1; i++;
    }
    return s;
  }
  function zbPrinter() {
    return '<rect x="30" y="90" width="90" height="10" rx="2" fill="#1f2937"/>' +
      '<rect x="14" y="98" width="122" height="66" rx="9" fill="#e2e8f0" stroke="#334155" stroke-width="2.2"/>' +
      '<rect x="90" y="116" width="32" height="24" rx="3" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>' +
      '<circle cx="34" cy="150" r="5" fill="#334155"/><circle cx="50" cy="150" r="5" fill="#94a3b8"/>';
  }
  function zbSvg(inner, label) {
    return '<svg width="158" height="178" viewBox="0 0 150 178" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + label + '">' + inner + '</svg>';
  }
  function zebraImageSVG() {          // 4×6 with the 3 barcode sections
    var lx = 47, lw = 56, sy = [12, 40, 68];
    var lbl = '<rect x="' + lx + '" y="8" width="' + lw + '" height="86" rx="2" fill="#fff" stroke="#334155" stroke-width="1.6"/>';
    for (var i = 0; i < 3; i++) {
      lbl += zbBars(lx + 6, sy[i] + 4, lw - 12, 12);
      lbl += '<rect x="' + (lx + 6) + '" y="' + (sy[i] + 18) + '" width="' + (lw - 12) + '" height="3" rx="1" fill="#94a3b8"/>';
      if (i < 2) lbl += '<line x1="' + lx + '" y1="' + (sy[i] + 26) + '" x2="' + (lx + lw) + '" y2="' + (sy[i] + 26) + '" stroke="#e2e8f0" stroke-width="1"/>';
    }
    return zbSvg(lbl + zbPrinter(), 'Zebra 4×6 — 3 barcode sections');
  }
  function zbSticker(x, y, w, h) {    // one mini Rapid LED sticker
    var cr = Math.min(w, h) * 0.11, cx = x + w * 0.30, cy = y + h * 0.17;
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1.5" fill="#fff" stroke="#334155" stroke-width="1"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + cr + '" fill="#0aa5e6" stroke="#111" stroke-width="0.8"/>' +
      '<text x="' + cx + '" y="' + (cy + cr * 0.55) + '" font-size="' + (cr * 1.35) + '" text-anchor="middle" fill="#fff" font-family="Georgia,serif">R</text>' +
      '<rect x="' + (x + w * 0.46) + '" y="' + (cy - cr * 0.6) + '" width="' + (w * 0.30) + '" height="2.4" rx="1" fill="#334155"/>' +
      '<rect x="' + (x + w * 0.46) + '" y="' + (cy + cr * 0.1) + '" width="' + (w * 0.22) + '" height="2.4" rx="1" fill="#334155"/>' +
      '<rect x="' + (x + w * 0.22) + '" y="' + (y + h * 0.44) + '" width="' + (w * 0.56) + '" height="' + Math.max(2, h * 0.07).toFixed(1) + '" rx="1" fill="#111"/>' +
      zbBars(x + w * 0.28, y + h * 0.66, w * 0.44, Math.max(6, h * 0.2));
  }
  function zebraStickerImageSVG(count) {   // 4×6 with `count` Rapid LED stickers
    var lx = 47, lw = 56, ly = 8, lh = 86, gap = 3;
    var out = '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh + '" rx="2" fill="#fff" stroke="#334155" stroke-width="1.6"/>';
    var ch = (lh - (count - 1) * gap) / count;
    for (var i = 0; i < count; i++) out += zbSticker(lx + 3, ly + 3 + i * (ch + gap), lw - 6, ch - 6);
    return zbSvg(out + zbPrinter(), count + ' Rapid LED sticker' + (count > 1 ? 's' : '') + ' on a Zebra 4×6');
  }

  // ── Plain A4/A3 sheet features (family 'sheet') — the home Search & Print,
  // Custom Label and Multi-Label. One card per feature (not per template): the
  // A4/A3 size is chosen inside the editor, exactly like the home modals.
  var SHEET_FEATURES = [
    { key: 'warehouse', kind: 'warehouse', name: 'Warehouse Label', tpl: 'a4label',
      purpose: 'One big single-product label per sheet — SKU, code, barcode, QTY and date. Search a product or type it by hand.',
      chip: 'Search or manual', size: 'A4 or A3 · landscape', badge: '1 per sheet', exName: 'Warehouse label', exHint: 'SKU, code, barcode, QTY and date' },
    { key: 'multi', kind: 'multi', name: 'Multi-Label', tpl: 'multiA4P',
      purpose: 'A table of products — 5DC, SKU, barcode and QTY, one row each. Pick A4/A3 and portrait/landscape in the editor.',
      chip: 'Product table', size: 'A4 / A3 · portrait or landscape', badge: 'up to 14 rows', exName: 'Product table', exHint: '5DC, SKU, barcode, QTY per row' }
  ];
  function sheetFeature(key) { return SHEET_FEATURES.filter(function (f) { return f.key === key; })[0] || null; }

  // Illustration: an A4/A3 sheet (portrait or landscape by the content's aspect)
  // with the REAL rendered label/table on it — so the card shows the actual print.
  function sheetFrameSVG(url, wmm, hmm) {
    var box = 158, boxH = 178, maxW = 150, maxH = 150, asp = wmm / hmm, pw, ph;
    if (asp >= 1) { pw = maxW; ph = pw / asp; } else { ph = maxH; pw = ph * asp; }
    var px = (box - pw) / 2, py = (boxH - ph) / 2;
    var s = '<svg width="' + box + '" height="' + boxH + '" viewBox="0 0 ' + box + ' ' + boxH + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="A4/A3 sheet">';
    s += '<rect x="' + (px + 3) + '" y="' + (py + 4) + '" width="' + pw + '" height="' + ph + '" rx="3" fill="#0f172a" opacity="0.10"/>';
    s += '<rect x="' + px + '" y="' + py + '" width="' + pw + '" height="' + ph + '" rx="3" fill="#ffffff" stroke="#334155" stroke-width="1.4"/>';
    if (url) s += '<image href="' + url + '" x="' + (px + 4) + '" y="' + (py + 4) + '" width="' + (pw - 8) + '" height="' + (ph - 8) + '" preserveAspectRatio="xMidYMid meet"/>';
    s += '</svg>';
    return s;
  }

  function renderSheetCard(f) {
    var t = window.LabelTemplates.byId(f.tpl);
    var m = window.LabelTemplates.meta(t);
    var multi = f.kind === 'multi';
    var sample = multi ? SAMPLES.multitable : SAMPLES.biglabel;
    var opts = multi ? { mlConfig: t.mlConfig } : { productRecipe: 'bigLabel' };
    var url = cellPreviewURL(sample, m.labelW, m.labelH, opts);
    var preview = sheetFrameSVG(url, m.labelW, m.labelH);
    var example = '<div class="ls-ex">' +
      '<div class="ls-ex-frame" style="min-height:62px;">' + (url ? '<img src="' + url + '" alt="" />' : '<span class="ls-loading">…</span>') + '</div>' +
      '<div class="ls-ex-name">' + esc(f.exName) + '</div>' +
      '<div class="ls-ex-hint">' + esc(f.exHint) + '</div>' +
    '</div>';
    return '<div class="ls-card zebra" onclick="LS.selectSheet(\'' + f.key + '\')">' +
      '<div class="ls-card-head">' +
        '<div class="ls-card-preview">' + preview + '</div>' +
        '<div class="ls-card-id">' +
          '<div class="ls-card-title">' + esc(f.name) + '</div>' +
          '<div class="ls-card-size">' + esc(f.size) + '</div>' +
          '<div class="ls-card-badges"><span class="ls-badge up">' + esc(f.badge) + '</span><span class="ls-badge">A4 / A3</span></div>' +
          '<div class="ls-card-codes"><span class="ls-chip">' + esc(f.chip) + '</span><span class="ls-chip code">' + (multi ? 'Copies' : 'Copies &amp; date') + '</span></div>' +
          '<div class="ls-card-purpose">' + esc(f.purpose) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="ls-card-prints">Prints</div>' +
      '<div class="ls-ex-row">' + example + '</div>' +
    '</div>';
  }

  function renderCard(t) {
    var m = window.LabelTemplates.meta(t);
    var zebra = (m.family === 'zebra');
    var zSticker = zebra && m.allow.length === 1 && m.allow[0] === 'plabel';
    var preview = !zebra ? window.LabelTemplates.svgPreview(t, 158, 178)
      : (zSticker ? zebraStickerImageSVG(m.up) : zebraImageSVG());

    var examples = m.allow.filter(function (type) { return !NO_PREVIEW[type]; }).map(function (type) {
      var url = cellPreviewURL(SAMPLES[type], m.labelW, m.labelH, { productRecipe: m.productRecipe, zebra: m.family === 'zebra' });
      return '<div class="ls-ex">' +
        '<div class="ls-ex-frame"' + (m.labelW > m.labelH * 1.6 ? ' style="min-height:62px;"' : '') + '>' +
          (url ? '<img src="' + url + '" alt="" />' : '<span class="ls-loading">…</span>') +
        '</div>' +
        '<div class="ls-ex-name">' + esc(TYPE_NAME[type] || type) + '</div>' +
        '<div class="ls-ex-hint">' + esc(typeHint(type, m.productRecipe)) + '</div>' +
      '</div>';
    }).join('');

    var sizeLine = zebra ? esc(m.media || m.size) : esc(m.size);
    var badges = !zebra
      ? '<span class="ls-badge up">' + m.up + ' per sheet</span><span class="ls-badge">grid ' + esc(m.grid) + '</span>'
      : (zSticker
          ? '<span class="ls-badge up">' + m.up + ' sticker' + (m.up > 1 ? 's' : '') + '</span><span class="ls-badge">grid ' + esc(m.grid) + '</span>'
          : '<span class="ls-badge up">up to ' + m.up + ' sections</span><span class="ls-badge">grid ' + esc(m.grid) + '</span>');
    var chips = !zebra
      ? '<span class="ls-chip">Avery ' + esc(m.avery) + '</span><span class="ls-chip code">' + (m.code ? 'Celcast ' + esc(m.code) : 'Celcast compat.') + '</span>'
      : '<span class="ls-chip">' + (zSticker ? 'Rapid LED sticker' : 'Thermal barcodes') + '</span><span class="ls-chip code">100 × 150 mm</span>';

    return '<div class="ls-card' + (m.fits ? '' : ' bad') + (zebra ? ' zebra' : '') + '" onclick="LS.selectModel(\'' + t.id + '\')">' +
      '<div class="ls-card-head">' +
        '<div class="ls-card-preview">' + preview + '</div>' +
        '<div class="ls-card-id">' +
          '<div class="ls-card-title">' + esc(m.name) + '</div>' +
          '<div class="ls-card-size">' + sizeLine + '</div>' +
          '<div class="ls-card-badges">' + badges + '</div>' +
          '<div class="ls-card-codes">' + chips + '</div>' +
          (m.purpose ? '<div class="ls-card-purpose">' + esc(m.purpose) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="ls-card-prints">Prints</div>' +
      '<div class="ls-ex-row">' + examples + '</div>' +
    '</div>';
  }

  function renderModels() {
    var all = window.LabelTemplates.list();
    var a4 = all.filter(function (t) { return (t.family || 'a4') === 'a4'; });
    var zebra = all.filter(function (t) { return t.family === 'zebra'; });
    function section(title, sub, list) {
      if (!list.length) return '';
      return '<div class="ls-sec">' + esc(title) + (sub ? ' <span>' + esc(sub) + '</span>' : '') + '</div>' +
        '<div class="ls-models">' + list.map(renderCard).join('') + '</div>';
    }
    function sheetSection() {
      return '<div class="ls-sec">' + esc('A4 / A3 sheets') + ' <span>' + esc('printed on your normal printer — a single big label, or a product table') + '</span></div>' +
        '<div class="ls-models">' + SHEET_FEATURES.map(renderSheetCard).join('') + '</div>';
    }
    el('lsModelGrid').innerHTML =
      sheetSection() +
      section('Zebra — thermal labels', 'single 4×6 labels on the Zebra thermal printer', zebra) +
      section('Celcast — A4 sheets', 'die-cut label sheets, printed on your normal printer', a4);
  }

  // A sheet feature = a base template + an editor. Warehouse opens the single-cell
  // fill form; Multi-Label opens its own rows table (choose size/orientation there).
  function selectSheet(key) {
    var f = sheetFeature(key); if (!f) return;
    LS._sheetFeature = f;
    selectModel(f.tpl);
    if (f.kind === 'multi') openMulti();
    else openCell(0, f);
  }

  // ═══ Multi-Label editor (the home 4-column product table) ═══
  var ML_CAP = { 'A4-portrait': 8, 'A4-landscape': 5, 'A3-portrait': 14, 'A3-landscape': 10 };
  function mlSizeOrient() {
    var c = (LS.tpl && LS.tpl.mlConfig) || 'A4-portrait', p = c.split('-');
    return { size: p[0], orient: p[1] };
  }
  function mlMaxSlots() { return ML_CAP[(LS.tpl && LS.tpl.mlConfig)] || 8; }

  function openMulti() {
    var c0 = LS.cells[0];
    LS.mlRows = (c0 && c0.rows) ? c0.rows.map(function (r) { return Object.assign({}, r); }) : [];
    mlResize();
    var so = mlSizeOrient();
    updateMlToggles(so.size, so.orient);
    renderMlRows();
    updateMlCap();
    openModal('lsMultiModal');
  }
  function closeMulti() { closeModal('lsMultiModal'); }

  function updateMlToggles(size, orient) {
    var map = { lsMlA4: size === 'A4', lsMlA3: size === 'A3', lsMlPortrait: orient === 'portrait', lsMlLandscape: orient === 'landscape' };
    Object.keys(map).forEach(function (id) { var e = el(id); if (e) e.classList.toggle('ls-btn-primary', map[id]); });
  }
  function updateMlCap() {
    var e = el('lsMlCap'); if (!e) return;
    var so = mlSizeOrient();
    e.innerHTML = '<b>' + mlMaxSlots() + '</b> rows fit · ' + so.size + ' ' + so.orient;
  }
  // Fixed slots: pad/trim to exactly maxSlots (keep filled data — pop extras, push
  // empties), like the home multi-label, so every slot that fits is laid out ready.
  function mlResize() {
    var n = mlMaxSlots();
    while (LS.mlRows.length > n) LS.mlRows.pop();
    while (LS.mlRows.length < n) LS.mlRows.push({ dc5: '', sku: '', qty: '', barcode: '' });
  }

  // Swap the Multi template on size / orientation change; the new row count is
  // laid out ready, keeping whatever was already typed.
  function setMultiConfig(size, orient) {
    var cur = mlSizeOrient();
    size = size || cur.size; orient = orient || cur.orient;
    var id = 'multi' + size + (orient === 'portrait' ? 'P' : 'L');
    var t = window.LabelTemplates.byId(id); if (!t) return;
    mlReadRows();
    LS.tpl = t; LS.caps = window.LabelTemplates.meta(t);
    LS.cells = [LS.cells[0] || null];
    mlResize();
    updateMlToggles(size, orient);
    renderMlRows();
    updateMlCap();
    el('lsEdName').textContent = LS.caps.name;
    el('lsEdMeta').textContent = LS.caps.media || LS.caps.size;
    el('lsSub').textContent = LS.caps.name + ' — ' + (LS.caps.media || LS.caps.size);
    renderSheet();
  }

  // A pre-made slot row: # · 5DC · Code/SKU · QTY · clear, with its own find
  // dropdown — type a 5DC or SKU in the row to search the catalogue right there.
  function mlRowHtml(r, i) {
    return '<div class="ls-mlrow-wrap">' +
      '<div class="ls-mlrow" data-i="' + i + '" data-bc="' + esc(r.barcode || '') + '" style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #eef2f6;">' +
        '<span style="width:20px;color:#94a3b8;font-size:12px;text-align:right;flex-shrink:0;">' + (i + 1) + '</span>' +
        '<input class="ls-input" data-f="dc5" value="' + esc(r.dc5 || '') + '" placeholder="5DC" style="width:82px;flex-shrink:0;" autocomplete="off" oninput="LS.mlRowSearch(' + i + ',this.value)" />' +
        '<input class="ls-input" data-f="sku" value="' + esc(r.sku || '') + '" placeholder="Code / SKU / name" style="flex:1;min-width:0;" autocomplete="off" oninput="LS.mlRowSearch(' + i + ',this.value)" />' +
        '<input class="ls-input" data-f="qty" value="' + esc(r.qty || '') + '" placeholder="QTY" style="width:60px;flex-shrink:0;" autocomplete="off" />' +
        '<button class="ls-btn ls-btn-sm ls-btn-ghost" onclick="LS.mlClearRow(' + i + ')" style="flex-shrink:0;" title="Clear row">✕</button>' +
      '</div>' +
      '<div class="ls-results ml-res" style="display:none;margin:2px 0 6px 28px;"></div>' +
    '</div>';
  }
  function renderMlRows() {
    var box = el('lsMlRows'); if (!box) return;
    box.innerHTML = LS.mlRows.map(mlRowHtml).join('');
  }
  function mlRowEl(i) { var b = el('lsMlRows'); return b ? b.querySelector('.ls-mlrow[data-i="' + i + '"]') : null; }
  // Read the DOM inputs back into state (barcode kept on the row's data-bc).
  function mlReadRows() {
    var box = el('lsMlRows'); if (!box) return;
    var out = [];
    box.querySelectorAll('.ls-mlrow').forEach(function (rowEl) {
      var g = function (f) { var e = rowEl.querySelector('[data-f="' + f + '"]'); return e ? e.value.trim() : ''; };
      out.push({ dc5: g('dc5'), sku: g('sku'), qty: g('qty'), barcode: rowEl.getAttribute('data-bc') || '' });
    });
    LS.mlRows = out;
  }
  // Per-row find: typing a 5DC or SKU in a row searches the catalogue and shows a
  // dropdown right under that row; picking fills the row's 5DC + Code + barcode.
  function mlRowSearch(i, term) {
    var row = mlRowEl(i); if (!row) return;
    var res = row.parentNode.querySelector('.ml-res');
    term = (term || '').trim().toLowerCase();
    if (term.length < 2) { res.style.display = 'none'; res.innerHTML = ''; return; }
    if (!LS.products) { res.style.display = 'block'; res.innerHTML = '<div class="ls-result"><span class="rname">Loading products…</span></div>'; return; }
    var hits = LS.products.filter(function (p) {
      return ((p.attribute1 || '').toLowerCase().indexOf(term) >= 0) || ((p.sku || '').toLowerCase().indexOf(term) >= 0) || ((p.name || '').toLowerCase().indexOf(term) >= 0);
    }).slice(0, 25);
    LS._mlRowRes = LS._mlRowRes || {}; LS._mlRowRes[i] = hits;
    if (!hits.length) { res.style.display = 'block'; res.innerHTML = '<div class="ls-result"><span class="rname">Nothing found.</span></div>'; return; }
    res.innerHTML = hits.map(function (p, k) {
      return '<div class="ls-result" onclick="LS.mlRowPick(' + i + ',' + k + ')">' +
        '<span class="r5dc">' + esc(p.attribute1 || '') + '</span>' +
        '<span class="rsku">' + esc(p.sku || '') + '</span>' +
        '<span class="rname">' + esc((p.name || '').slice(0, 42)) + '</span></div>';
    }).join('');
    res.style.display = 'block';
  }
  function mlRowPick(i, k) {
    var p = (LS._mlRowRes && LS._mlRowRes[i]) ? LS._mlRowRes[i][k] : null; if (!p) return;
    var row = mlRowEl(i); if (!row) return;
    row.querySelector('[data-f="dc5"]').value = p.attribute1 || '';
    row.querySelector('[data-f="sku"]').value = p.sku || '';
    var qe = row.querySelector('[data-f="qty"]'); if (qe && !qe.value.trim()) qe.value = '1';
    row.setAttribute('data-bc', p.barcode || '');
    var res = row.parentNode.querySelector('.ml-res'); res.style.display = 'none'; res.innerHTML = '';
    mlReadRows(); updateMlCap();
  }
  function mlClearRow(i) {
    var row = mlRowEl(i); if (!row) return;
    ['dc5', 'sku', 'qty'].forEach(function (f) { var e = row.querySelector('[data-f="' + f + '"]'); if (e) e.value = ''; });
    row.setAttribute('data-bc', '');
    var res = row.parentNode.querySelector('.ml-res'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
    mlReadRows(); updateMlCap();
  }
  function applyMulti() {
    mlReadRows();
    var rows = LS.mlRows.filter(function (r) { return usableStr(r.dc5) || usableStr(r.sku); });
    LS.cells[0] = rows.length ? { type: 'multitable', rows: rows, date: fmtDate(todayISO()) } : null;
    closeMulti();
    renderSheet();
  }
  function usableStr(v) { return String(v == null ? '' : v).trim(); }

  function selectModel(id) {
    var t = window.LabelTemplates.byId(id);
    if (!t || !(t._fit && t._fit.ok)) { alert('This model failed the page-fit check and is disabled.'); return; }
    LS.tpl = t;
    LS.caps = window.LabelTemplates.meta(t);
    LS.cells = new Array(t.cols * t.rows).fill(null);
    LS.selectMode = false; LS.selected.clear();
    var sb = el('lsSelectBar'); if (sb) sb.style.display = 'none';
    var stg = el('lsSelectToggle'); if (stg) stg.classList.remove('active');
    // "Fill all" / "Select" only make sense on a sheet with more than one label.
    // On a 1-up model (Warehouse, Multi-Label, Full sheet, single Zebra sticker)
    // they do nothing — hide them to keep the bar clean.
    var multiCell = (t.cols * t.rows) > 1;
    var fab = el('lsFillAllBtn'); if (fab) fab.style.display = multiCell ? '' : 'none';
    if (stg) stg.style.display = multiCell ? '' : 'none';
    var zebra = LS.caps.family === 'zebra';
    var sheet = LS.caps.family === 'sheet';
    el('lsEdName').textContent = LS.caps.name;
    el('lsEdMeta').textContent = zebra
      ? (LS.caps.media || LS.caps.size) + ' · ' + LS.caps.grid + ' · up to ' + LS.caps.up + ' sections'
      : sheet
        ? (LS.caps.media || LS.caps.size)
        : LS.caps.size + ' · grid ' + LS.caps.grid + ' · ' + LS.caps.up + ' per sheet · Avery ' + LS.caps.avery + (LS.caps.code ? ' · Celcast ' + LS.caps.code : '');
    el('lsSub').textContent = LS.caps.name + ' — ' + (zebra || sheet ? (LS.caps.media || LS.caps.size) : LS.caps.size);
    // Manual alignment retired — at 100% / actual size the sheets align on their own,
    // so the test-print + offset card stays hidden for every model.
    var ac = el('lsAlignCard'); if (ac) ac.style.display = 'none';
    var so = el('lsSheetOpts'); if (so) so.style.display = sheet ? 'block' : 'none';
    var cn = el('lsCelcastNote'); if (cn) cn.style.display = (zebra || sheet) ? 'none' : '';
    // Warehouse shows the A4/A3 toggle here; Multi picks size + orientation in its
    // own modal, so show an "Edit rows" button instead of the paper toggle.
    var isMulti = sheet && !!t.mlConfig;
    var whp = el('lsWhPaperWrap'); if (whp) whp.style.display = (sheet && !isMulti) ? 'block' : 'none';
    var mlb = el('lsMlEditBtn'); if (mlb) mlb.style.display = isMulti ? 'block' : 'none';
    if (sheet && !isMulti) updatePaperSeg(t.id === 'a3label' ? 'A3' : 'A4');
    el('lsModels').style.display = 'none';
    el('lsEditor').style.display = 'block';
    loadCalibInputs();
    renderSheet();
  }

  function backToModels() {
    el('lsEditor').style.display = 'none';
    el('lsModels').style.display = 'block';
    el('lsSub').textContent = 'Label formats · choose one';
  }

  // ═══ STEP 2 — visual sheet ═══
  // Cells are drawn by the same renderer that writes the PDF, so the sheet is a
  // true proof of what will come out of the printer.
  function renderSheet() {
    var t = LS.tpl; if (!t) return;
    var PW = window.LabelTemplates.pageW(t), PH = window.LabelTemplates.pageH(t);
    var sheet = el('lsSheet'), wrap = sheet.parentElement;
    var avail = Math.min((wrap.clientWidth || 520) - 4, 620);
    var scale = avail / PW;                                 // px per mm
    var maxH = 760;
    if (PH * scale > maxH) scale = maxH / PH;
    sheet.style.width = (PW * scale) + 'px';
    sheet.style.height = (PH * scale) + 'px';

    var start = Math.max(1, intVal('lsStart', 1));
    var opts = { productRecipe: LS.caps ? LS.caps.productRecipe : 'stack', zebra: !!(LS.caps && LS.caps.family === 'zebra'), mlConfig: LS.tpl && LS.tpl.mlConfig };
    var total = t.cols * t.rows, html = '', badCount = 0;

    // Margin visualisation: draw the page's real margin band around the label
    // grid so the operator sees exactly where the printable labels sit vs the
    // sheet edge — the boundary they must respect for alignment.
    // The die-cut margin guide is for aligning labels inside a Celcast sheet's
    // die-cuts — a plain A4/A3 sheet has no die-cuts, and the dimension tags would
    // just overlap the big label, so skip it there.
    if ((LS.caps ? LS.caps.family : 'a4') !== 'sheet') {
      var gridW = (t.cols - 1) * t.pitchX + t.labelW, gridH = (t.rows - 1) * t.pitchY + t.labelH;
      var mL = t.marginLeft, mT = t.marginTop;
      var mB = PH - mT - gridH;
      html += '<div class="ls-margin-box" style="left:' + (mL * scale).toFixed(1) + 'px;top:' + (mT * scale).toFixed(1) +
        'px;width:' + (gridW * scale).toFixed(1) + 'px;height:' + (gridH * scale).toFixed(1) + 'px;"></div>';
      html += '<span class="ls-mdim ls-mdim-t" style="top:' + (Math.max(0, mT * scale / 2 - 7)).toFixed(1) + 'px;">top ' + mT.toFixed(1) + ' mm</span>';
      html += '<span class="ls-mdim ls-mdim-l" style="left:2px;top:' + (mT * scale + gridH * scale / 2 - 7).toFixed(1) + 'px;">left ' + mL.toFixed(1) + ' mm</span>';
      html += '<span class="ls-mdim ls-mdim-b" style="bottom:' + (Math.max(0, mB * scale / 2 - 7)).toFixed(1) + 'px;">bottom ' + mB.toFixed(1) + ' mm</span>';
    }

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
    var filled = LS.cells.filter(function (c) { return c && c.type; }).length;
    var bad = LS._badCount || 0;
    el('lsSummary').innerHTML =
      '<b>' + filled + '</b> of ' + total + ' labels filled' +
      (bad ? '<br><span style="color:#c0392b;">⚠ <b>' + bad + '</b> label' + (bad > 1 ? 's have' : ' has') +
             ' a barcode too narrow to scan on this sheet — marked in red.</span>' : '');
  }

  // ═══ Cell editor ═══
  // The tabs are built from the template's own capability list: a 38 mm ticket
  // never offers the full product sticker, because it could not carry it.
  function renderTypeTabs(active) {
    var allow = (LS.caps && LS.caps.allow) || ['product', 'barcode', 'text'];
    var recipe = (LS.caps && LS.caps.productRecipe) || 'stack';
    var w = (LS.caps && LS.caps.labelW) || 63.5, h = (LS.caps && LS.caps.labelH) || 38.1;
    el('lsTypeTabs').innerHTML = allow.map(function (ty) {
      // Each option shows a real example of what THAT type prints on this sheet
      // (same sample product for all), so the operator picks the model by sight,
      // not just by the button name.
      var url = cellPreviewURL(SAMPLES[ty], w, h, { productRecipe: recipe });
      var thumb = url ? '<img src="' + url + '" alt="" />' : '<span class="ls-loading">…</span>';
      return '<div class="ls-type' + (ty === active ? ' active' : '') + '" data-type="' + ty + '" onclick="LS.pickType(\'' + ty + '\')">' +
        '<div class="ls-type-ex">' + thumb + '</div>' +
        '<div class="ls-type-name">' + esc(TYPE_NAME[ty] || ty) + '</div>' +
      '</div>';
    }).join('');
  }
  function defaultType() {
    var allow = (LS.caps && LS.caps.allow) || ['product'];
    return allow[0];
  }

  function openCell(index, feat) {
    LS.editor = { mode: 'cell', index: index, type: defaultType(), product: null, feat: feat || LS._sheetFeature || null };
    var isSheet = LS.caps && LS.caps.family === 'sheet';
    el('lsCellTitle').textContent = isSheet ? ((LS.editor.feat && LS.editor.feat.name) || 'Warehouse label') : ('Label ' + (index + 1));
    var existing = LS.cells[index];
    resetEditorInputs();
    if (existing && existing.type) {
      pickType(existing.type);
      if (existing.type === 'product') { LS.editor.product = { sku: existing.sku, name: existing.name, barcode: existing.barcode, attribute1: existing.dc5 }; showChosen(); }
      else if (existing.type === 'text') { el('lsTextVal').value = existing.text || ''; }
      else if (existing.type === 'barcode') { el('lsBcVal').value = existing.value || ''; el('lsBcFmt').value = existing.fmt || 'auto'; }
      else if (existing.type === 'location') { el('lsLocVal').value = existing.code || ''; }
      else if (existing.type === 'biglabel') {
        el('lsBigDc5').value = existing.dc5 || '';
        el('lsBigCode').value = existing.code || existing.sku || '';
        el('lsBigQty').value = existing.qty || '';
        el('lsBigDate').value = dateToISO(existing.date);
      }
      else if (existing.type === 'plabel') {
        LS.editor.plProduct = { sku: existing.sku || existing.code, name: existing.desc, barcode: existing.barcode, attribute1: existing.dc5 };
        el('lsPlCode').value = existing.code || '';
        el('lsPlDesc').value = existing.desc || '';
        el('lsPlLines').value = (existing.lines || []).join('\n');
        plBcNote(existing.barcode, existing.code || existing.sku);
        el('lsPlForm').style.display = 'block';
      }
    } else { pickType(defaultType()); }
    if (LS.editor.type === 'biglabel') {
      if (!el('lsBigDate').value) el('lsBigDate').value = todayISO();
      // A filled label opens in Manual (fields shown for editing); a fresh one
      // opens in Search (the common case — find the product).
      pickBigMode(existing && existing.type === 'biglabel' ? 'manual' : 'search');
    }
    updateModalPreview();
    openModal('lsCellModal');
  }

  function openFillAll(preType) {
    LS.editor = { mode: 'all', index: -1, type: preType || defaultType(), product: null };
    el('lsCellTitle').textContent = 'Fill all labels';
    resetEditorInputs();
    pickType(preType || defaultType());
    updateModalPreview();
    openModal('lsCellModal');
  }

  function resetEditorInputs() {
    el('lsProdSearch').value = ''; el('lsProdResults').style.display = 'none'; el('lsProdResults').innerHTML = '';
    el('lsProdChosen').style.display = 'none'; el('lsProdChosen').innerHTML = '';
    el('lsTextVal').value = ''; el('lsBcVal').value = ''; el('lsBcFmt').value = 'auto';
    var lv = el('lsLocVal'); if (lv) lv.value = '';
    var lr = el('lsLocResults'); if (lr) { lr.style.display = 'none'; lr.innerHTML = ''; }
    var pls = el('lsPlSearch'); if (pls) pls.value = '';
    var plr = el('lsPlResults'); if (plr) { plr.style.display = 'none'; plr.innerHTML = ''; }
    var plf = el('lsPlForm'); if (plf) plf.style.display = 'none';
    ['lsPlCode', 'lsPlDesc', 'lsPlLines'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    ['lsBigSearch', 'lsBigDc5', 'lsBigCode', 'lsBigQty', 'lsBigDate'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
    var bgr = el('lsBigResults'); if (bgr) { bgr.style.display = 'none'; bgr.innerHTML = ''; }
    var bgc = el('lsBigChosen'); if (bgc) { bgc.style.display = 'none'; bgc.innerHTML = ''; }
    LS.editor.product = null; LS.editor.plProduct = null;
  }

  function pickType(type) {
    LS.editor.type = type;
    renderTypeTabs(type);
    el('lsTypeProduct').style.display = type === 'product' ? 'block' : 'none';
    el('lsTypeProductLabel').style.display = type === 'plabel' ? 'block' : 'none';
    el('lsTypeLocation').style.display = type === 'location' ? 'block' : 'none';
    el('lsTypeText').style.display = type === 'text' ? 'block' : 'none';
    el('lsTypeBarcode').style.display = type === 'barcode' ? 'block' : 'none';
    var bl = el('lsTypeBigLabel'); if (bl) bl.style.display = type === 'biglabel' ? 'block' : 'none';
    updateModalPreview();
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
    updateModalPreview();
  }

  // What will be encoded on THIS sheet, in what symbology, and whether the bars
  // end up wide enough to scan — all three decided by the template, so the
  // operator sees the real answer before printing.
  function bcStatusHtml(cell) {
    var recipe = LS.caps ? LS.caps.productRecipe : 'stack';
    var eb = window.LabelRender.effectiveBarcode(cell);   // same value the label prints
    var eff = eb.value;
    if (!eff) return '<span style="color:#c0392b;">No barcode and no product code — nothing will be printed.</span>';
    var raw = String(cell.barcode == null ? '' : cell.barcode).trim();
    var fellBack = !raw || /^0+$/.test(raw);
    var box = window.LabelRender.barcodeBox(recipe, LS.caps.labelW, LS.caps.labelH);
    var q = window.LabelRender.scanQuality(eff, eb.fmt || 'auto', box.w, box.h);
    return 'Barcode: <b>' + esc(eff) + '</b> · ' + esc(q.format) +
      (fellBack ? ' <span style="color:#b45309;">(no Cin7 barcode — generated from the product code, which Cin7 can read; the 5DC is not used for the bars)</span>' : '') +
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

  // ── Locations ──
  // Codes come from the public Locations table (the same source the existing
  // barcode print validates against). Typing is not restricted to it: a bin
  // that is not registered yet still needs a label.
  function loadLocations() {
    (async function () {
      try {
        if (window.supabaseReady) { try { await window.supabaseReady; } catch (e) {} }
        var sb = window.supabase;
        if (!sb || !sb.from) return;
        var all = [], from = 0, size = 1000;
        while (true) {
          var res = await sb.from('Locations').select('code').range(from, from + size - 1);
          if (res.error) { console.warn('label-sheets: locations error', res.error.message); break; }
          var rows = res.data || [];
          all = all.concat(rows.map(function (r) { return String(r.code || '').trim(); }).filter(Boolean));
          if (rows.length < size) break;
          from += size;
          if (from > 20000) break;
        }
        LS.locations = all;
        console.log('label-sheets: loaded ' + all.length + ' locations');
      } catch (e) { console.warn('label-sheets: loadLocations failed', e); }
    })();
  }

  function locSearch(term) {
    term = (term || '').trim().toLowerCase();
    var box = el('lsLocResults'), note = el('lsLocNote');
    if (term.length < 2) { box.style.display = 'none'; box.innerHTML = ''; if (note) note.textContent = 'Prints the code big, the barcode, and the code again underneath.'; return; }
    if (!LS.locations) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Loading locations…</span></div>'; return; }
    LS._locResults = LS.locations.filter(function (c) { return c.toLowerCase().indexOf(term) >= 0; }).slice(0, 40);
    var exact = LS.locations.some(function (c) { return c.toLowerCase() === term; });
    if (note) {
      note.innerHTML = exact
        ? '<span style="color:#1a8a4a;">✓ registered location</span>'
        : '<span style="color:#b45309;">not in the Locations table — it will still print</span>';
    }
    if (!LS._locResults.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = LS._locResults.map(function (c, i) {
      return '<div class="ls-result" onclick="LS.locChoose(' + i + ')"><span class="r5dc">' + esc(c) + '</span></div>';
    }).join('');
    box.style.display = 'block';
  }
  function locChoose(i) {
    var c = LS._locResults[i]; if (!c) return;
    el('lsLocVal').value = c;
    el('lsLocResults').style.display = 'none';
    locSearch(c);
    updateModalPreview();
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
    updateModalPreview();
  }

  // ── Big warehouse label: product search fills the 5DC + code fields ──
  // (The barcode always encodes the code, so the EAN is not needed here.)
  function bigSearch(term) {
    term = (term || '').trim().toLowerCase();
    var box = el('lsBigResults');
    if (term.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
    if (!LS.products) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Loading products…</span></div>'; return; }
    LS._bigResults = LS.products.filter(function (p) {
      return ((p.attribute1 || '').toLowerCase().indexOf(term) >= 0) || ((p.sku || '').toLowerCase().indexOf(term) >= 0) || ((p.name || '').toLowerCase().indexOf(term) >= 0);
    }).slice(0, 40);
    if (!LS._bigResults.length) { box.style.display = 'block'; box.innerHTML = '<div class="ls-result"><span class="rname">Nothing found.</span></div>'; return; }
    box.innerHTML = LS._bigResults.map(function (p, i) {
      return '<div class="ls-result" onclick="LS.bigChoose(' + i + ')">' +
        '<span class="r5dc">' + esc(p.attribute1 || '') + '</span>' +
        '<span class="rsku">' + esc(p.sku || '') + '</span>' +
        '<span class="rname">' + esc((p.name || '').slice(0, 46)) + '</span></div>';
    }).join('');
    box.style.display = 'block';
  }
  function bigChoose(i) {
    var p = LS._bigResults[i]; if (!p) return;
    el('lsBigDc5').value = p.attribute1 || '';    // the fields are the single source of truth,
    el('lsBigCode').value = p.sku || '';          // whether filled by search or typed in Manual
    el('lsBigSearch').value = '';
    el('lsBigResults').style.display = 'none';
    var ch = el('lsBigChosen');
    if (ch) {
      ch.style.display = 'block';
      ch.innerHTML = '<div style="padding:9px 11px;border:1px solid #d7e3ec;border-radius:9px;background:#f7fbfd;">' +
        '<b style="font-size:15px;">' + esc(p.attribute1 || '') + '</b> <span style="color:#5b6b78;">' + esc(p.sku || '') + '</span>' +
        '<br><span style="color:#5b6b78;font-size:12px;">' + esc((p.name || '').slice(0, 54)) + '</span>' +
        '<div style="color:#8a97a2;font-size:11px;margin-top:5px;">Switch to <b>Manual</b> to tweak the code or 5DC.</div></div>';
    }
    updateModalPreview();
  }

  // Two ways to fill the warehouse label: Search a product, or type it by hand.
  // Both write to the same 5DC/Code fields, so buildCell reads them either way.
  function pickBigMode(mode) {
    LS.editor.bigMode = mode;
    var sp = el('lsBigSearchPanel'), mp = el('lsBigManualPanel');
    if (sp) sp.style.display = mode === 'search' ? 'block' : 'none';
    if (mp) mp.style.display = mode === 'manual' ? 'block' : 'none';
    var bs = el('lsBigModeSearch'), bm = el('lsBigModeManual');
    if (bs) bs.classList.toggle('ls-btn-primary', mode === 'search');
    if (bm) bm.classList.toggle('ls-btn-primary', mode === 'manual');
  }

  // ── Paper size (A4 ↔ A3) for the big-label features — swaps the base template,
  // keeping the label content. The two templates share the same recipe.
  function updatePaperSeg(size) {
    var a4 = el('lsPaperA4'), a3 = el('lsPaperA3');
    if (a4) a4.classList.toggle('ls-btn-primary', size === 'A4');
    if (a3) a3.classList.toggle('ls-btn-primary', size === 'A3');
  }
  function setSheetPaper(size) {
    var id = size === 'A3' ? 'a3label' : 'a4label';
    var t = window.LabelTemplates.byId(id);
    if (!t || (LS.tpl && LS.tpl.id === id)) { updatePaperSeg(size); return; }
    var keep = LS.cells && LS.cells.length ? LS.cells[0] : null;
    LS.tpl = t;
    LS.caps = window.LabelTemplates.meta(t);
    LS.cells = [keep || null];
    el('lsEdName').textContent = LS.caps.name;
    el('lsEdMeta').textContent = LS.caps.media || LS.caps.size;
    el('lsSub').textContent = LS.caps.name + ' — ' + (LS.caps.media || LS.caps.size);
    updatePaperSeg(size);
    loadCalibInputs();
    renderSheet();
  }

  // Builds the cell the editor currently describes. `quiet` skips the alerts so
  // the live preview can call it on every keystroke; applyCell wants them.
  function buildCell(quiet) {
    var type = LS.editor.type;
    if (type === 'product') {
      if (!LS.editor.product) { if (!quiet) alert('Choose a product — or use Barcode / Text.'); return null; }
      var pr = LS.editor.product;
      return { type: 'product', sku: pr.sku, name: pr.name, barcode: pr.barcode, dc5: pr.attribute1, fmt: 'auto' };
    }
    if (type === 'text') {
      var tv = el('lsTextVal').value.trim();
      if (!tv) { if (!quiet) alert('Type some text.'); return null; }
      return { type: 'text', text: tv };
    }
    if (type === 'barcode') {
      var bv = el('lsBcVal').value.trim();
      if (!bv) { if (!quiet) alert('Type the code value.'); return null; }
      return { type: 'barcode', value: bv, fmt: el('lsBcFmt').value };
    }
    if (type === 'location') {
      var lc = el('lsLocVal').value.trim();
      if (!lc) { if (!quiet) alert('Type or pick a location code.'); return null; }
      return { type: 'location', code: lc };
    }
    if (type === 'biglabel') {
      var bdc = el('lsBigDc5').value.trim(), bcode = el('lsBigCode').value.trim();
      if (!bcode && !bdc) { if (!quiet) alert('Search a product, or type at least the code.'); return null; }
      return { type: 'biglabel', sku: bcode, code: bcode, dc5: bdc,
        qty: el('lsBigQty').value.trim(), date: fmtDate(el('lsBigDate').value), fmt: 'auto' };
    }
    if (type === 'plabel') {
      var plCode = el('lsPlCode').value.trim();
      if (!plCode && !LS.editor.plProduct) { if (!quiet) alert('Find a product first.'); return null; }
      var plLines = el('lsPlLines').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var plP = LS.editor.plProduct || {};
      return { type: 'plabel', code: plCode, desc: el('lsPlDesc').value.trim(), lines: plLines,
        barcode: plP.barcode || '', dc5: plP.attribute1 || '', sku: plP.sku || plCode, fmt: 'auto' };
    }
    return null;
  }

  // ── Live preview inside the editor ──
  // The sheet behind the modal is too small to judge a label by, so the same
  // renderer draws it here at a readable size, at the exact proportions of the
  // sheet in play — what you approve is what prints.
  function updateModalPreview() {
    var box = el('lsModalPrev'), meta = el('lsModalPrevMeta');
    if (!box || !LS.caps) return;
    var cell = buildCell(true);
    if (!cell) {
      box.innerHTML = '<span class="ls-mprev-empty">Fill the fields to see the label</span>';
      if (meta) meta.textContent = LS.caps.size;
      return;
    }
    var url = cellPreviewURL(cell, LS.caps.labelW, LS.caps.labelH, { productRecipe: LS.caps.productRecipe, zebra: LS.caps.family === 'zebra' });
    box.innerHTML = url
      ? '<img src="' + url + '" alt="" style="aspect-ratio:' + LS.caps.labelW + '/' + LS.caps.labelH + ';" />'
      : '<span class="ls-mprev-empty">—</span>';
    if (meta) {
      var q = window.LabelRender.cellScan(cell, LS.caps.labelW, LS.caps.labelH, LS.caps.productRecipe);
      meta.innerHTML = esc(LS.caps.size) + (q.empty ? '' :
        ' · <span style="color:' + (q.ok ? '#1a8a4a' : '#c0392b') + ';">' +
        (q.ok ? '✓ scans well' : '⚠ bars too narrow') + ' (' + q.moduleMM.toFixed(2) + ' mm)</span>');
    }
  }

  function applyCell() {
    var cell = buildCell(false);
    if (!cell && LS.editor.type) return;
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
    var pW = window.LabelTemplates.pageW(t), pH = window.LabelTemplates.pageH(t);
    var orient = pW > pH ? 'landscape' : 'portrait';    // the plain A4/A3 sheets print landscape
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [pW, pH], orientation: orient, compress: true });
    // Ask viewers to print at actual size (Adobe honours it; harmless elsewhere).
    // The page is exact A4 (210×297), which is what actually stops Chrome fit-to-page.
    try { doc.viewerPreferences({ PrintScaling: 'None' }); } catch (e) {}
    // Plain sheets are 1-up: "Copies" repeats the single label; the die-cut sheets
    // reuse "Sheets" (how many identical A4 pages).
    var sheets = (LS.caps && LS.caps.family === 'sheet') ? Math.max(1, intVal('lsCopies', 1)) : Math.max(1, intVal('lsSheets', 1));
    var start = Math.max(1, intVal('lsStart', 1));
    var total = t.cols * t.rows;
    var opts = { productRecipe: LS.caps ? LS.caps.productRecipe : 'stack', zebra: !!(LS.caps && LS.caps.family === 'zebra'), mlConfig: LS.tpl && LS.tpl.mlConfig };

    for (var s = 0; s < sheets; s++) {
      if (s > 0) doc.addPage([pW, pH], orient);
      for (var p = 0; p < total; p++) {
        if (s === 0 && p < start - 1) continue;            // reuse a partly-used sheet
        var cell = LS.cells[p];
        if (!cell || !cell.type) continue;
        var r = Math.floor(p / t.cols), c = p % t.cols;
        var pos = cellPosCal(t, r, c);          // published geometry + saved printer offset
        window.LabelRender.toPdf(doc, cell, pos.x, pos.y, pos.w, pos.h, opts);
      }
    }

    openPdf(doc, 'labels-' + t.id + '.pdf');
  }

  function openPdf(doc, name) {
    try { var url = doc.output('bloburl'); var win = window.open(url, '_blank'); if (!win) doc.save(name); }
    catch (e) { doc.save(name); }
  }

  // ── Alignment test print ──
  // The honest answer to "why is my sheet a few mm off": print THIS on plain
  // paper at 100%, lay it over a blank Celcast sheet against the light. The
  // outlines should sit exactly inside the die-cut squares; if the whole grid is
  // shifted, nudge the X/Y offset and reprint. The 100 mm rulers prove the scale:
  // if either does not measure 100 mm, the print dialog is not at Actual size.
  function printAlignmentTest() {
    var t = LS.tpl; if (!t) return;
    if (!window.jspdf || !window.jspdf.jsPDF) { alert('PDF library failed to load. Reload the page.'); return; }
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [window.LabelTemplates.pageW(t), window.LabelTemplates.pageH(t)], orientation: 'portrait' });
    try { doc.viewerPreferences({ PrintScaling: 'None' }); } catch (e) {}
    var cal = getCalib(t.id);

    // Each label's die-cut outline (calibrated) + a faint centre crosshair —
    // overlay a blank Celcast sheet against the light to check the die-cut fit.
    var total = t.cols * t.rows, p, r, c, pos;
    for (p = 0; p < total; p++) {
      r = Math.floor(p / t.cols); c = p % t.cols; pos = cellPosCal(t, r, c);
      doc.setDrawColor(150); doc.setLineWidth(0.2);
      if (t.radius > 0) doc.roundedRect(pos.x, pos.y, pos.w, pos.h, t.radius, t.radius, 'S');
      else doc.rect(pos.x, pos.y, pos.w, pos.h, 'S');
      var mx = pos.x + pos.w / 2, my = pos.y + pos.h / 2;
      doc.setDrawColor(205); doc.setLineWidth(0.15);
      doc.line(mx - 2, my, mx + 2, my); doc.line(mx, my - 2, mx, my + 2);
    }

    // Corner registration crosses at fixed A4 positions.
    doc.setDrawColor(0); doc.setLineWidth(0.3);
    [[10, 10], [200, 10], [10, 287], [200, 287]].forEach(function (m) {
      doc.line(m[0] - 4, m[1], m[0] + 4, m[1]); doc.line(m[0], m[1] - 4, m[0], m[1] + 4);
    });

    // 100 mm rulers on a clean white band (legible over the grid). Kept clear of
    // the top ~10 mm so a printer's non-printable top border cannot clip them —
    // the scale proof: if either does not measure 100 mm, the print is not 100%.
    alignRuler(doc, 55, 27, 100, 'h');
    alignRuler(doc, 5, 105, 100, 'v');

    // Title band, on white, kept below the top ~10 mm. A raw (uncalibrated) print
    // can shift up a few mm, so putting the header at ~15 mm stops it being
    // clipped by the printer's non-printable top border.
    doc.setFillColor(255, 255, 255); doc.rect(27, 10.5, 168, 10, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(20);
    doc.text('RAPID LED — ALIGNMENT TEST', 30, 14.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(90);
    doc.text(t.avery + ' · ' + t.labelW + '×' + t.labelH + ' mm · grid ' + t.cols + '×' + t.rows +
      ' · offset X ' + cal.dx.toFixed(1) + ' Y ' + cal.dy.toFixed(1) + ' mm · PRINT AT 100% / ACTUAL SIZE', 30, 18);

    openPdf(doc, 'align-test-' + t.id + '.pdf');
  }

  function alignRuler(doc, x, y, len, dir) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6);
    var i, tk;
    if (dir === 'h') {
      doc.setFillColor(255, 255, 255); doc.rect(x - 3, y - 6, len + 8, 9, 'F');
      doc.setDrawColor(0); doc.setLineWidth(0.25); doc.setTextColor(0);
      doc.line(x, y, x + len, y);
      for (i = 0; i <= len; i += 10) { tk = (i % 50 === 0) ? 2.5 : 1.5; doc.line(x + i, y - tk, x + i, y + tk); }
      doc.text(len + ' mm — must measure exactly ' + len + ' mm at 100% scale', x + 3, y - 3);
    } else {
      doc.setFillColor(255, 255, 255); doc.rect(x - 3, y - 12, 6, len + 15, 'F');
      doc.setDrawColor(0); doc.setLineWidth(0.25); doc.setTextColor(0);
      doc.line(x, y, x, y + len);
      for (i = 0; i <= len; i += 10) { tk = (i % 50 === 0) ? 2.5 : 1.5; doc.line(x - tk, y + i, x + tk, y + i); }
      doc.text(len + ' mm', x + 1, y - 2, { angle: 90 });
    }
  }

  // ── Calibration inputs (per-model printer offset) ──
  function loadCalibInputs() {
    var t = LS.tpl; if (!t) return;
    var cal = getCalib(t.id);
    if (el('lsOffX')) el('lsOffX').value = cal.dx;
    if (el('lsOffY')) el('lsOffY').value = cal.dy;
    updateCalibNote();
  }
  function onCalibInput() {
    var t = LS.tpl; if (!t) return;
    setCalib(t.id, numVal('lsOffX', 0), numVal('lsOffY', 0));
    updateCalibNote();
  }
  function nudgeCalib(ddx, ddy) {
    var t = LS.tpl; if (!t) return;
    var cal = getCalib(t.id);
    var dx = Math.round((cal.dx + ddx) * 10) / 10, dy = Math.round((cal.dy + ddy) * 10) / 10;
    setCalib(t.id, dx, dy);
    if (el('lsOffX')) el('lsOffX').value = dx;
    if (el('lsOffY')) el('lsOffY').value = dy;
    updateCalibNote();
  }
  function resetCalib() {
    var t = LS.tpl; if (!t) return;
    setCalib(t.id, 0, 0);
    if (el('lsOffX')) el('lsOffX').value = 0;
    if (el('lsOffY')) el('lsOffY').value = 0;
    updateCalibNote();
  }
  // The drift is the printer's (non-printable margin + centring), the same for
  // every A4 sheet — so one calibration can seed them all.
  function applyCalibAll() {
    var t = LS.tpl; if (!t) return;
    var cal = getCalib(t.id);
    window.LabelTemplates.list().forEach(function (tpl) { setCalib(tpl.id, cal.dx, cal.dy); });
    var note = el('lsCalibNote');
    if (note) { note.style.display = ''; note.innerHTML = '<b>Offset X ' + cal.dx.toFixed(1) + ' mm, Y ' + cal.dy.toFixed(1) + ' mm applied to ALL sheets.</b>'; }
  }
  function updateCalibNote() {
    var t = LS.tpl, note = el('lsCalibNote'); if (!t || !note) return;
    var cal = getCalib(t.id);
    if (cal.dx || cal.dy) {
      note.style.display = '';
      note.innerHTML = '<b>Saved offset — X ' + cal.dx.toFixed(1) + ' · Y ' + cal.dy.toFixed(1) + ' mm</b>, applied to every PDF.';
    } else {
      note.style.display = 'none';
      note.innerHTML = '';
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

  // Brand assets: re-encode and TRIM.
  //
  // Re-encode because jsPDF mangles embedded JPEG/PIL-PNG into black side
  // panels; pushing each asset through a canvas (like the barcode, which comes
  // out clean) yields a safe PNG.
  //
  // Trim because both crops ship with a wide white border — 13 px around a
  // 216×92 logo is 14% of its height spent on nothing. Drawn into a box sized
  // for the artwork, that padding shrinks the visible mark and reads as a badly
  // placed, undersized logo. Cropping to the ink lets it fill the space it was
  // given.
  function trimToInk(img) {
    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!(w > 0) || !(h > 0)) return null;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    var d;
    try { d = ctx.getImageData(0, 0, w, h).data; } catch (e) { return c; }
    var INK = 245, x, y, i;
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4;
        if ((d[i] + d[i + 1] + d[i + 2]) / 3 < INK) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return c;                       // blank image, keep as-is

    // a hair of padding so the ink never sits flush against the edge
    var pad = Math.max(1, Math.round(Math.max(maxX - minX, maxY - minY) * 0.02));
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

    var tw = maxX - minX + 1, th = maxY - minY + 1;
    var t = document.createElement('canvas');
    t.width = tw; t.height = th;
    var tctx = t.getContext('2d');
    tctx.fillStyle = '#ffffff'; tctx.fillRect(0, 0, tw, th);
    tctx.drawImage(c, minX, minY, tw, th, 0, 0, tw, th);
    return t;
  }

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
        a.img = img;
        try {
          var t = trimToInk(img);
          if (t) {
            a.img = t;                            // canvas draws fine on canvas
            a.url = t.toDataURL('image/png');     // and this is what jsPDF embeds
            a.type = 'PNG'; a.w = t.width; a.h = t.height;
          }
        } catch (e) { console.warn('label-sheets: asset trim failed for ' + k, e); }
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
    loadLocations();
    var sheetsInput = el('lsSheets');
    if (sheetsInput) sheetsInput.addEventListener('input', updateSummary);
    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (el('lsEditor').style.display !== 'block') return;
      clearTimeout(resizeTimer); resizeTimer = setTimeout(renderSheet, 150);
    });
    var m = el('lsCellModal');
    if (m) {
      m.addEventListener('click', function (ev) { if (ev.target === m) m.classList.remove('open'); });
      var prevTimer = null;
      var live = function () { clearTimeout(prevTimer); prevTimer = setTimeout(updateModalPreview, 140); };
      m.addEventListener('input', live);
      m.addEventListener('change', live);
    }
    var mm = el('lsMultiModal');
    if (mm) mm.addEventListener('click', function (ev) { if (ev.target === mm) mm.classList.remove('open'); });
  }

  // expose
  LS.selectModel = selectModel;
  LS.selectSheet = selectSheet;
  LS.setSheetPaper = setSheetPaper;
  LS.bigSearch = bigSearch;
  LS.bigChoose = bigChoose;
  LS.pickBigMode = pickBigMode;
  LS.openMulti = openMulti;
  LS.closeMulti = closeMulti;
  LS.setMultiConfig = setMultiConfig;
  LS.mlRowSearch = mlRowSearch;
  LS.mlRowPick = mlRowPick;
  LS.mlClearRow = mlClearRow;
  LS.applyMulti = applyMulti;
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
  LS.printAlignmentTest = printAlignmentTest;
  LS.onCalibInput = onCalibInput;
  LS.nudgeCalib = nudgeCalib;
  LS.resetCalib = resetCalib;
  LS.applyCalibAll = applyCalibAll;
  LS.toggleSelectMode = toggleSelectMode;
  LS.toggleSelect = toggleSelect;
  LS.selectAll = selectAll;
  LS.selectNone = selectNone;
  LS.openFillSelected = openFillSelected;
  LS.clearSelected = clearSelected;
  LS.locSearch = locSearch;
  LS.locChoose = locChoose;
  LS.updateModalPreview = updateModalPreview;
  LS.cellPreviewURL = cellPreviewURL;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
