/*
 * label-templates.js — Celcast / Avery A4 label-sheet geometry registry.
 *
 * ISOLATED feature (features/label-sheets/). Read-only: touches no DB, no Cin7.
 *
 * Geometry = published Avery A4 specs (Celcast uses the same standard A4
 * die-cut grid). Every template is SELF-CHECKED to tile A4 (210×297 mm) on
 * load — a broken spec fails loud in the console and is flagged, never rendered
 * silently. There is no per-operator calibration: this serves one company on
 * one known set of sheets, so these numbers are the answer and printing at
 * 100% / Actual size is what guarantees alignment.
 *
 * Each template also declares what it is FOR and what it may carry — see CAPS.
 * All dimensions are in millimetres.
 */
(function () {
  'use strict';

  var A4_W = 210, A4_H = 297;

  // code = Celcast SKU confirmed on AU retailer listings; null = "compatível"
  // (same size/grid, Celcast code not individually verified — matched by size).
  var TEMPLATES = [
    // Only the sheets Rapid LED actually stocks — Celcast codes confirmed on the
    // physical box (2026-07-24). Geometry verified vs Label Planet / Avery + exact
    // A4 tiling. The 64-wide 3-across sheets (l7159 24up, up33 33up) use the
    // Australian Celcast "QuickPeel" die (left 6.5, pitchX 66.5); the 99.1-wide
    // 2-across family (l7165/l7163/l7162) shares left 4.65 / pitchX 101.6 (4 in).
    { id:'full',  avery:'L7167', code:'48001', up:1,  cols:1, rows:1,  labelW:199.6, labelH:289.1, marginTop:3.95,  marginLeft:5.2,  pitchX:0,     pitchY:0,    radius:0,   shape:'rect' },
    { id:'l7165', avery:'L7165', code:'48008', up:8,  cols:2, rows:4,  labelW:99.1,  labelH:67.7,  marginTop:13.1,  marginLeft:4.65, pitchX:101.6, pitchY:67.7, radius:0,   shape:'rect' },
    { id:'l7163', avery:'L7163', code:'48014', up:14, cols:2, rows:7,  labelW:99.1,  labelH:38.1,  marginTop:15.15, marginLeft:4.65, pitchX:101.6, pitchY:38.1, radius:0,   shape:'rect' },
    { id:'l7162', avery:'L7162', code:'48016', up:16, cols:2, rows:8,  labelW:99.1,  labelH:33.9,  marginTop:12.9,  marginLeft:4.65, pitchX:101.6, pitchY:33.9, radius:0,   shape:'rect' },
    { id:'l7159', avery:'L7159', code:'48024', up:24, cols:3, rows:8,  labelW:64.0,  labelH:33.9,  marginTop:12.9,  marginLeft:6.5,  pitchX:66.5,  pitchY:33.9, radius:1.5, shape:'rect' },
    { id:'up33',  avery:'L7157', code:'48033', up:33, cols:3, rows:11, labelW:64.0,  labelH:24.3,  marginTop:14.85, marginLeft:6.5,  pitchX:66.5,  pitchY:24.3, radius:1.5, shape:'rect' }
  ];

  // ── What each sheet IS FOR, and what it may carry ─────────────────────────
  // A sheet is not a blank canvas. A 38 mm price ticket and a 68 mm product
  // sticker serve different jobs, so each template declares its purpose, the
  // exact contents that make sense on it (`allow`, ordered — the first is what
  // the editor opens on) and which recipe its Product cells use.
  // `tuned` marks the templates whose format has been settled with the operator;
  // the rest still run on sensible defaults and are pending their own pass.
  var CAPS = {
    full:  { name: 'Full sheet', purpose: 'One Rapid LED sticker filling the whole A4.', allow: ['plabel'], productRecipe: 'stack', tuned: true },
    l7165: { name: 'Large — product sticker', purpose: 'Rapid LED product stickers and large labels.', allow: ['plabel', 'product', 'barcode'], productRecipe: 'stack', tuned: true },
    l7163: {
      name: 'Shipping',
      purpose: 'Warehouse labels: code on top, 5DC left, barcode right. Also prints bin locations.',
      allow: ['product', 'location', 'barcode', 'text'],
      productRecipe: 'shipping',
      tuned: true
    },
    l7162: {
      name: 'Shipping — compact',
      purpose: 'Same warehouse/barcode format as Shipping, 16 to a sheet. Also prints bin locations.',
      allow: ['product', 'location', 'barcode', 'text'],
      productRecipe: 'shipping',
      tuned: true
    },
    l7159: { name: 'Product',           purpose: 'Product labels: code, 5DC and barcode.', allow: ['product', 'barcode', 'text'], productRecipe: 'stack', tuned: true },
    up33:  { name: 'Small — price / barcode', purpose: 'Shelf tickets and price labels: the 5DC to read, the barcode to scan.', allow: ['product', 'barcode', 'text'], productRecipe: 'code5dc', tuned: true }
  };
  var DEFAULT_CAPS = { name: '', purpose: '', allow: ['product', 'barcode', 'text'], productRecipe: 'stack', tuned: false };
  function caps(id) { return Object.assign({}, DEFAULT_CAPS, CAPS[id] || {}); }

  // ── Self-check: geometry must tile within A4 (non-negative right/bottom margin) ──
  function validate(t) {
    var usedX = t.marginLeft + (t.cols - 1) * t.pitchX + t.labelW;
    var usedY = t.marginTop  + (t.rows - 1) * t.pitchY + t.labelH;
    var rightM = A4_W - usedX, bottomM = A4_H - usedY;
    var ok = rightM >= -0.1 && bottomM >= -0.1;
    if (!ok) {
      console.error('[label-templates] ' + t.id + ' (' + t.avery + ') does NOT fit A4 — will not render.',
        { usedX: usedX.toFixed(2), usedY: usedY.toFixed(2), rightMargin: rightM.toFixed(2), bottomMargin: bottomM.toFixed(2) });
    }
    return { ok: ok, rightM: rightM, bottomM: bottomM };
  }

  // Top-left position (mm) of the cell at row r, col c.
  // This software serves one company on one known set of Celcast sheets, so the
  // geometry above is the answer — no per-operator calibration step, nothing to
  // get wrong before the first print. What guarantees alignment is printing the
  // PDF at 100% / Actual size.
  function cellXY(t, r, c) {
    return { x: t.marginLeft + c * t.pitchX, y: t.marginTop + r * t.pitchY, w: t.labelW, h: t.labelH };
  }

  // ── Accurate inline-SVG mini-map of the grid (nominal layout, for the picker) ──
  function svgPreview(t, boxW, boxH) {
    var pad = 5;
    var s = Math.min((boxW - 2 * pad) / A4_W, (boxH - 2 * pad) / A4_H);
    var pw = A4_W * s, ph = A4_H * s;
    var ox = (boxW - pw) / 2, oy = (boxH - ph) / 2;
    var svg = '<svg width="' + boxW + '" height="' + boxH + '" viewBox="0 0 ' + boxW + ' ' + boxH + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + t.avery + ' layout">';
    svg += '<rect x="' + ox.toFixed(1) + '" y="' + oy.toFixed(1) + '" width="' + pw.toFixed(1) + '" height="' + ph.toFixed(1) + '" rx="' + (2 * s).toFixed(1) + '" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>';
    for (var r = 0; r < t.rows; r++) {
      for (var c = 0; c < t.cols; c++) {
        var x = ox + (t.marginLeft + c * t.pitchX) * s;
        var y = oy + (t.marginTop + r * t.pitchY) * s;
        var w = t.labelW * s, h = t.labelH * s;
        var rad = Math.max(0, t.radius * s);
        svg += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="' + rad.toFixed(2) + '" fill="#e8f6fc" stroke="#0aa5e6" stroke-width="0.7"/>';
      }
    }
    svg += '</svg>';
    return svg;
  }

  function meta(t) {
    var c = caps(t.id);
    return {
      id: t.id,
      name: c.name || t.avery,
      purpose: c.purpose,
      allow: c.allow.slice(),
      productRecipe: c.productRecipe,
      tuned: !!c.tuned,
      up: t.up,
      labelW: t.labelW,
      labelH: t.labelH,
      size: t.labelW + ' × ' + t.labelH + ' mm',
      grid: t.cols + ' × ' + t.rows,
      avery: t.avery,
      code: t.code,
      fits: t._fit ? t._fit.ok : false
    };
  }

  // Validate every template on load (fail-loud if any spec is broken).
  TEMPLATES.forEach(function (t) { t._fit = validate(t); });
  var broken = TEMPLATES.filter(function (t) { return !t._fit.ok; });
  if (broken.length) console.error('[label-templates] ' + broken.length + ' template(s) failed the A4 self-check.');
  else console.log('[label-templates] ' + TEMPLATES.length + ' templates loaded, all pass A4 self-check.');

  window.LABEL_TEMPLATES = TEMPLATES;
  window.LabelTemplates = {
    list: function () { return TEMPLATES.slice(); },
    byId: function (id) { return TEMPLATES.filter(function (t) { return t.id === id; })[0] || null; },
    validate: validate,
    cellXY: cellXY,
    caps: caps,
    svgPreview: svgPreview,
    meta: meta,
    A4_W: A4_W, A4_H: A4_H
  };
})();
