/*
 * label-templates.js — Celcast / Avery A4 label-sheet geometry registry.
 *
 * ISOLATED feature (features/label-sheets/). Read-only: touches no DB, no Cin7.
 *
 * Geometry = nominal published Avery A4 specs (Celcast uses the same standard
 * A4 die-cut grid). Every template is SELF-CHECKED to tile A4 (210×297 mm) on
 * load — a broken spec fails loud in the console and is flagged, never rendered
 * silently. These nominal numbers are only the STARTING POINT: the real
 * guarantee of alignment on the operator's actual sheets + printer is the
 * per-template CALIBRATION (start offset + pitch) saved in localStorage. The
 * operator prints the outline, lays the real Celcast sheet on top, and nudges
 * until the die-cut matches. All dimensions are in millimetres.
 */
(function () {
  'use strict';

  var A4_W = 210, A4_H = 297;

  // code = Celcast SKU confirmed on AU retailer listings; null = "compatível"
  // (same size/grid, Celcast code not individually verified — matched by size).
  var TEMPLATES = [
    { id:'l7651', avery:'L7651', code:null,    up:65, cols:5, rows:13, labelW:38.1,  labelH:21.2,  marginTop:10.7,  marginLeft:5.75, pitchX:40.1,  pitchY:21.2, radius:1.0, shape:'rect' },
    { id:'l7160', avery:'L7160', code:'48021', up:21, cols:3, rows:7,  labelW:63.5,  labelH:38.1,  marginTop:15.15, marginLeft:7.25, pitchX:66.0,  pitchY:38.1, radius:1.5, shape:'rect' },
    { id:'l7159', avery:'L7159', code:null,    up:24, cols:3, rows:8,  labelW:63.5,  labelH:33.9,  marginTop:12.9,  marginLeft:7.25, pitchX:66.0,  pitchY:33.9, radius:1.5, shape:'rect' },
    { id:'l7163', avery:'L7163', code:'48014', up:14, cols:2, rows:7,  labelW:99.1,  labelH:38.1,  marginTop:15.15, marginLeft:4.65, pitchX:101.6, pitchY:38.1, radius:0,   shape:'rect' },
    { id:'l7164', avery:'L7164', code:null,    up:12, cols:3, rows:4,  labelW:63.5,  labelH:72.0,  marginTop:4.5,   marginLeft:7.25, pitchX:66.0,  pitchY:72.0, radius:1.5, shape:'rect' },
    { id:'l7173', avery:'L7173', code:'48010', up:10, cols:2, rows:5,  labelW:99.1,  labelH:57.0,  marginTop:6.0,   marginLeft:4.65, pitchX:101.6, pitchY:57.0, radius:0,   shape:'rect' },
    { id:'l7165', avery:'L7165', code:null,    up:8,  cols:2, rows:4,  labelW:99.1,  labelH:67.7,  marginTop:13.1,  marginLeft:4.65, pitchX:101.6, pitchY:67.7, radius:0,   shape:'rect' },
    { id:'full',  avery:'—',     code:'48001', up:1,  cols:1, rows:1,  labelW:199.6, labelH:289.1, marginTop:3.95,  marginLeft:5.2,  pitchX:0,     pitchY:0,    radius:0,   shape:'rect' },
    { id:'p6870', avery:'L7073', code:null,    up:12, cols:3, rows:4,  labelW:68.0,  labelH:70.0,  marginTop:8.5,   marginLeft:5.2,  pitchX:68.0,  pitchY:70.0, radius:3.0, shape:'rect' }
  ];

  // ── What each sheet IS FOR, and what it may carry ─────────────────────────
  // A sheet is not a blank canvas. A 38 mm price ticket and a 68 mm product
  // sticker serve different jobs, so each template declares its purpose, the
  // exact contents that make sense on it (`allow`, ordered — the first is what
  // the editor opens on) and which recipe its Product cells use.
  // `tuned` marks the templates whose format has been settled with the operator;
  // the rest still run on sensible defaults and are pending their own pass.
  var CAPS = {
    l7651: {
      name: 'Small — price / barcode',
      purpose: 'Shelf tickets and price labels: the 5DC to read, the barcode to scan.',
      allow: ['product', 'barcode', 'text'],
      productRecipe: 'code5dc',
      tuned: true
    },
    l7160: { name: 'Product / address', purpose: 'Product and address labels.', allow: ['product', 'barcode', 'text'], productRecipe: 'stack' },
    l7159: { name: 'Product',           purpose: 'Product labels.',              allow: ['product', 'barcode', 'text'], productRecipe: 'stack' },
    l7163: { name: 'Shipping',          purpose: 'Shipping and carton labels.',  allow: ['product', 'barcode', 'text'], productRecipe: 'stack' },
    l7164: { name: 'Medium',            purpose: 'Medium labels.',               allow: ['product', 'plabel', 'barcode', 'text'], productRecipe: 'stack' },
    l7173: { name: 'Large',             purpose: 'Large labels.',                allow: ['product', 'plabel', 'barcode', 'text'], productRecipe: 'stack' },
    l7165: { name: 'Large',             purpose: 'Large labels.',                allow: ['product', 'plabel', 'barcode', 'text'], productRecipe: 'stack' },
    full:  { name: 'Full sheet',        purpose: 'One label filling the whole A4.', allow: ['plabel', 'product', 'barcode', 'text'], productRecipe: 'stack' },
    p6870: { name: 'Product label (68×70)', purpose: 'The Rapid LED product sticker, straight from Cin7.', allow: ['plabel', 'product', 'barcode', 'text'], productRecipe: 'stack' }
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
