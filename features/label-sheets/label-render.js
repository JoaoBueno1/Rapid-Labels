/*
 * label-render.js — Product-label layout engine (isolated feature).
 *
 * ONE layout, TWO backends. layout() turns a cell + a label rectangle into a
 * list of drawing primitives in MILLIMETRES; the canvas backend paints them for
 * the on-screen preview and the jsPDF backend paints the very same list for
 * print. Preview and print therefore cannot drift apart — that is the WYSIWYG
 * guarantee, without paying for it in bitmap.
 *
 * Why not rasterise the whole label (the previous approach): embedding a 300dpi
 * PNG per label made a 12-product A4 sheet weigh 30 MB, and it turned the text
 * and the barcode bars into pixels — soft on a 600dpi laser and a scan risk.
 * Here only the logo, the compliance strip and the barcode are images (jsPDF
 * dedupes the first two across the whole sheet); every glyph stays vector.
 *
 * All geometry lives in SPEC — tune the label there, not in the code.
 */
(function () {
  'use strict';

  var PT2MM = 25.4 / 72;          // jsPDF font sizes are points, layout is mm

  // Fractions of the label: `av` = inner height, `iw` = inner width. Absolute
  // floors are in mm so a small sheet degrades to "still legible" instead of
  // "technically drawn".
  var SPEC = {
    pad:         0.035,   // × H   outer padding
    logoH:       0.17,    // × av
    logoMaxW:    0.75,    // × iw
    logoGap:     0.02,    // × av
    codeH:       0.11,    // × av  starting em size, shrinks to fit the width
    codeMinMM:   1.6,
    codeGap:     0.012,   // × av
    descH:       0.052,   // × av
    descMinMM:   1.2,
    descLead:    1.12,
    descFloor:   0.18,    // × av  desc may always claim at least this height
    descMaxFrac: 0.62,    // × remaining content height
    descGap:     0.01,    // × av
    lineH:       0.042,   // × av  spec lines
    lineMinMM:   1.2,
    lineLead:    1.15,
    bcW:         0.55,    // × iw  barcode width
    bcMaxH:      0.19,    // × av
    bcMinBand:   0.10,    // × av  bottom band reserved even with no barcode
    bandGap:     0.025,   // × av
    symH:        0.06,    // × av  compliance strip
    symGap:      0.06,    // × iw  min clearance from the barcode
    borderInset: 0.025,   // × H
    borderW:     0.006,   // × H
    borderR:     0.03,    // × H
    ink:         '#111111'
  };

  // ── Text metrics in mm ──────────────────────────────────────────────────
  // A single measurer serves both backends, so the preview and the PDF wrap and
  // shrink at exactly the same place. Helvetica (PDF standard font) and Arial
  // (the canvas fallback on Windows) are metric-compatible by design.
  var REF_PX = 100, _mctx = null;
  function measurer() {
    if (!_mctx) { var c = document.createElement('canvas'); c.width = c.height = 8; _mctx = c.getContext('2d'); }
    return _mctx;
  }
  function fontCss(px, bold, mono) {
    return (bold ? 'bold ' : '') + Math.max(1, px) + 'px ' +
      (mono ? '"Courier New", Courier, monospace' : 'Helvetica, Arial, sans-serif');
  }
  function widthMM(text, sizeMM, bold) {
    var ctx = measurer();
    ctx.font = fontCss(REF_PX, bold);
    return ctx.measureText(String(text == null ? '' : text)).width / REF_PX * sizeMM;
  }
  // Text width is linear in the em size, so the largest size that fits is exact
  // arithmetic — no shrink loop needed.
  function fitSize(text, maxWMM, startMM, bold, minMM) {
    var w1 = widthMM(text, 1, bold);
    if (!(w1 > 0)) return startMM;
    return Math.max(minMM, Math.min(startMM, maxWMM / w1));
  }
  function wrap(text, maxWMM, sizeMM, bold) {
    var words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var t = cur ? cur + ' ' + words[i] : words[i];
      if (cur && widthMM(t, sizeMM, bold) > maxWMM) { lines.push(cur); cur = words[i]; }
      else cur = t;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  // Wrapping changes with the size, so this one does have to iterate.
  function fitBlock(text, maxWMM, maxHMM, startMM, minMM, lead) {
    var s = startMM;
    while (s > minMM) {
      var ls = wrap(text, maxWMM, s);
      if (ls.length * s * lead <= maxHMM) return { size: s, lines: ls };
      s -= 0.1;
    }
    return { size: minMM, lines: wrap(text, maxWMM, minMM) };
  }

  // ── Barcode ─────────────────────────────────────────────────────────────
  var BC_OPTS = { height: 140, width: 2, displayValue: true, fontSize: 30, margin: 6, textMargin: 2 };
  // Symbology per situation — the same rule the existing barcode feature
  // (multi-label.js) already prints with, so a code scanned off a sheet label
  // matches a code scanned off the table print.
  //   · 13 digits starting with 0 -> CODE128, NOT EAN13: a scanner reads that as
  //     UPC-A and drops the leading zero, but Cin7 needs the exact 13 digits.
  //   · 14 digits -> ITF14 (the carton GTIN-14).
  function bcFormat(value, fmt) {
    if (fmt && fmt !== 'auto') return fmt;
    var v = String(value == null ? '' : value).trim();
    if (!/^[0-9]+$/.test(v)) return 'CODE128';
    if (v.length === 13 && v.charAt(0) === '0') return 'CODE128';
    if (v.length === 14) return 'ITF14';
    if (v.length === 13) return 'EAN13';
    if (v.length === 12) return 'UPC';
    if (v.length === 8) return 'EAN8';
    return 'CODE128';
  }

  // What actually gets encoded. Cin7 leaves ~70% of the catalogue with an empty
  // or literal "0" barcode, and "0" is truthy — so the naive `barcode || code`
  // printed a perfectly scannable CODE128 meaning "0" on thousands of different
  // products. That is worse than a blank space, because it looks legitimate.
  //
  // `order` lets a template choose what to fall back to. On a 38 mm ticket an
  // 18-character SKU in CODE128 needs ~230 modules and lands near 0.15 mm per
  // module — too narrow to scan reliably — while the 5-digit 5DC fits with room
  // to spare, so that template asks for the 5DC first.
  var DEFAULT_ORDER = ['barcode', 'code', 'sku', 'dc5'];
  function usable(v) { v = String(v == null ? '' : v).trim(); return (!v || /^0+$/.test(v)) ? '' : v; }
  function bcValue(cell, order) {
    if (!cell) return '';
    var keys = order || DEFAULT_ORDER;
    for (var i = 0; i < keys.length; i++) {
      var v = usable(cell[keys[i]]);
      if (v) return v;
    }
    return '';
  }

  // Narrowest bar that still scans dependably in a warehouse. Below this the
  // symbol depends on a high-resolution scanner and a perfect print.
  var MIN_MODULE_MM = 0.25;

  // The value and symbology a recipe will actually encode for a cell. Both the
  // renderer and the quality check call this, so what is measured is always
  // exactly what gets printed.
  //
  // GTIN symbology detection applies to a real product barcode only. A 5DC or a
  // SKU is an internal code, not a GTIN: an 8-digit 5DC encoded as EAN-8 would
  // come back from the scanner with a check digit appended — no longer the
  // number printed above it. Internal codes are always CODE128.
  function effectiveBarcode(cell, recipe) {
    if (!cell) return { value: '', fmt: 'CODE128' };
    if (cell.type === 'barcode') return { value: usable(cell.value), fmt: cell.fmt || 'auto' };
    var real = usable(cell.barcode), code;
    if (cell.type === 'plabel') code = bcValue(cell, ['code', 'sku', 'dc5']);
    else code = bcValue(cell, recipe === 'code5dc' ? ['dc5', 'sku', 'code'] : ['sku', 'dc5', 'code']);
    return { value: real || code, fmt: real ? (cell.fmt || 'auto') : 'CODE128' };
  }

  // A barcode drawn as a bitmap is only as good as its resolution: at the size
  // these labels use, a canvas barcode lands near 165 dpi — below what a scanner
  // should be asked to read, and it cost ~115 KB of uncompressed RGB per label.
  // JsBarcode's SVG renderer hands us the exact bar geometry instead, which we
  // re-emit as filled rectangles: true vector edges at whatever resolution the
  // printer runs, for about 2 KB.
  var _bcVec = {};
  function translateOf(node, root) {
    var dx = 0, dy = 0, n = node;
    while (n && n !== root) {
      var tr = n.getAttribute && n.getAttribute('transform');
      if (tr) {
        var m = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(tr);
        if (m) { dx += parseFloat(m[1]); dy += parseFloat(m[2]); }
      }
      n = n.parentNode;
    }
    return { dx: dx, dy: dy };
  }
  function barcodeVector(value, fmt) {
    value = String(value == null ? '' : value).trim();
    if (!value || typeof JsBarcode === 'undefined') return null;
    var key = value + '|' + (fmt || 'auto');
    if (key in _bcVec) return _bcVec[key];
    var res = null;
    try {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      try { JsBarcode(svg, value, Object.assign({ format: bcFormat(value, fmt) }, BC_OPTS)); }
      catch (e) { JsBarcode(svg, value, Object.assign({ format: 'CODE128' }, BC_OPTS)); }

      var W = parseFloat(svg.getAttribute('width')), H = parseFloat(svg.getAttribute('height'));
      if (!(W > 0) || !(H > 0)) throw new Error('barcode svg has no size');

      var bars = [], texts = [], i, t;
      var rects = svg.querySelectorAll('rect');
      for (i = 0; i < rects.length; i++) {
        var r = rects[i];
        var paint = (r.getAttribute('style') || '') + ' ' + (r.getAttribute('fill') || '');
        if (/#f{3,6}\b|white|none/i.test(paint)) continue;          // skip the background
        var rw = parseFloat(r.getAttribute('width')) || 0, rh = parseFloat(r.getAttribute('height')) || 0;
        if (!(rw > 0) || !(rh > 0)) continue;
        t = translateOf(r, svg);
        bars.push({ x: (parseFloat(r.getAttribute('x')) || 0) + t.dx, y: (parseFloat(r.getAttribute('y')) || 0) + t.dy, w: rw, h: rh });
      }
      if (!bars.length) throw new Error('barcode svg has no bars');

      var tx = svg.querySelectorAll('text');
      for (i = 0; i < tx.length; i++) {
        var e = tx[i], txt = (e.textContent || '').trim();
        if (!txt) continue;
        t = translateOf(e, svg);
        var fm = /([\d.]+)px/.exec(e.getAttribute('style') || '');
        texts.push({
          x: (parseFloat(e.getAttribute('x')) || 0) + t.dx,
          y: (parseFloat(e.getAttribute('y')) || 0) + t.dy,
          size: fm ? parseFloat(fm[1]) : BC_OPTS.fontSize,
          anchor: e.getAttribute('text-anchor') || 'middle',
          text: txt
        });
      }
      res = { w: W, h: H, bars: bars, texts: texts };
    } catch (err) {
      console.warn('label-render: vector barcode failed, falling back to raster', err && err.message);
      res = null;
    }
    _bcVec[key] = res;
    return res;
  }

  // Raster fallback — used only if the SVG renderer is unavailable.
  var _bcCache = {};
  function barcodeCanvas(value, fmt) {
    value = String(value == null ? '' : value).trim();
    if (!value || typeof JsBarcode === 'undefined') return null;
    var key = value + '|' + (fmt || 'auto');
    if (key in _bcCache) return _bcCache[key];
    var c = document.createElement('canvas');
    try { JsBarcode(c, value, Object.assign({ format: bcFormat(value, fmt) }, BC_OPTS)); }
    catch (e) {
      try { JsBarcode(c, value, Object.assign({ format: 'CODE128' }, BC_OPTS)); }
      catch (e2) { _bcCache[key] = null; return null; }
    }
    _bcCache[key] = c;
    return c;
  }

  // Aspect ratio of the rendered barcode, so a caller can reserve space for it
  // before deciding the rest of its layout.
  function barcodeAspect(value, fmt) {
    var v = barcodeVector(value, fmt);
    if (v && v.h > 0) return v.w / v.h;
    var c = barcodeCanvas(value, fmt);
    return (c && c.height > 0) ? c.width / c.height : 0;
  }

  // Fit a barcode into a rectangle (aspect preserved, centred) and return the
  // primitives that draw it. Every cell type goes through here, so the whole
  // sheet gets the same vector bars.
  function barcodeFit(value, fmt, x, y, maxW, maxH) {
    var none = { prims: [], w: 0, h: 0 };
    if (!(maxW > 0) || !(maxH > 0)) return none;
    var v = barcodeVector(value, fmt), asp = v ? v.w / v.h : barcodeAspect(value, fmt);
    if (!(asp > 0)) return none;
    var w = maxW, h = w / asp;
    if (h > maxH) { h = maxH; w = h * asp; }
    var bx = x + (maxW - w) / 2, by = y + (maxH - h) / 2;
    if (!v) {                                            // raster fallback
      var c = barcodeCanvas(value, fmt);
      return c ? { prims: [{ kind: 'image', img: c, x: bx, y: by, w: w, h: h }], w: w, h: h } : none;
    }
    var k = w / v.w, out = [], i, b;
    for (i = 0; i < v.bars.length; i++) {
      b = v.bars[i];
      out.push({ kind: 'fill', x: bx + b.x * k, y: by + b.y * k, w: b.w * k, h: b.h * k });
    }
    for (i = 0; i < v.texts.length; i++) {
      b = v.texts[i];
      out.push({
        kind: 'text', text: b.text, x: bx + b.x * k, y: by + b.y * k, size: b.size * k,
        align: b.anchor === 'start' ? 'left' : (b.anchor === 'end' ? 'right' : 'center'), mono: true
      });
    }
    return { prims: out, w: w, h: h };
  }

  // Fill a rectangle EXACTLY with a barcode, stretching width and height
  // independently. A barcode is a row of vertical bars: only the horizontal
  // module ratios carry data, so squashing it vertically costs nothing while
  // using the full width buys the widest possible module — which is precisely
  // what decides whether a small ticket scans. (barcodeFit above keeps the
  // natural proportions; use it only where the look matters more than the read.)
  function barcodeFill(value, fmt, x, y, w, h) {
    var none = { prims: [], moduleMM: 0 };
    if (!(w > 0) || !(h > 0)) return none;
    var v = barcodeVector(value, fmt);
    if (!v) {                                            // raster fallback
      var c = barcodeCanvas(value, fmt);
      return c ? { prims: [{ kind: 'image', img: c, x: x, y: y, w: w, h: h }], moduleMM: 0 } : none;
    }
    var kx = w / v.w, ky = h / v.h, out = [], i, b, narrow = Infinity;
    for (i = 0; i < v.bars.length; i++) {
      b = v.bars[i];
      if (b.w < narrow) narrow = b.w;
      out.push({ kind: 'fill', x: x + b.x * kx, y: y + b.y * ky, w: b.w * kx, h: b.h * ky });
    }
    for (i = 0; i < v.texts.length; i++) {
      b = v.texts[i];
      out.push({
        kind: 'text', text: b.text, x: x + b.x * kx, y: y + b.y * ky,
        size: Math.min(b.size * kx, h * 0.22), mono: true,
        align: b.anchor === 'start' ? 'left' : (b.anchor === 'end' ? 'right' : 'center')
      });
    }
    return { prims: out, moduleMM: narrow === Infinity ? 0 : narrow * kx };
  }

  // ── Layout: cell + rectangle (mm) → primitives (mm) ─────────────────────
  // Primitives: {kind:'text', x, y(baseline), size, bold, align, text, mono}
  //             {kind:'fill',  x, y, w, h}                — solid black rectangle
  //             {kind:'image', img, url, x, y, w, h}
  //             {kind:'rect',  x, y, w, h, r, lw}         — stroked outline
  //
  // A sheet is not a generic canvas: a 38 mm price ticket and a 68 mm product
  // sticker want different content laid out differently. The template says which
  // RECIPE its Product cells use (opts.productRecipe); everything else follows
  // from the cell type.
  function layout(cell, W, H, opts) {
    if (!cell || !cell.type || !(W > 0) || !(H > 0)) return [];
    switch (cell.type) {
      case 'plabel':  return layoutBrandLabel(cell, W, H);
      case 'product': return (opts && opts.productRecipe === 'code5dc')
                        ? layoutCode5dc(cell, W, H)
                        : layoutProductStack(cell, W, H);
      case 'barcode': return layoutBarcodeCell(cell, W, H);
      case 'text':    return layoutTextCell(cell, W, H);
      default:        return [];
    }
  }

  // ── Recipe: 5DC over its barcode ────────────────────────────────────────
  // The whole job of a shelf/price ticket is: a human reads the 5DC, a scanner
  // reads the bars. Nothing else earns its space at 38 × 21 mm, so nothing else
  // is drawn — the two elements simply split the label between them.
  var R5 = {
    pad:       0.055,   // × min(W,H)
    codeH:     0.30,    // × ih   em size of the 5DC
    codeMinMM: 2.0,
    gap:       0.05,    // × ih
    bcMinH:    0.40     // × ih   the bars never give up more than this
  };
  function layoutCode5dc(cell, W, H) {
    var out = [];
    var pad = Math.min(W, H) * R5.pad;
    var iw = W - 2 * pad, ih = H - 2 * pad, cx = W / 2;
    if (iw <= 0 || ih <= 0) return out;

    // The printed line and the bars must agree: some products carry a 5DC of
    // literal "0", and showing "0" over a barcode encoding the SKU is a ticket
    // that lies. The human-readable line is resolved with the same precedence
    // the encoder uses. (5DC before SKU: at 38 mm a long SKU would not scan.)
    var code = bcValue(cell, ['dc5', 'sku', 'code']);
    var eb = effectiveBarcode(cell, 'code5dc'), value = eb.value, vfmt = eb.fmt;

    var codeH = 0, gap = 0;
    if (code) {
      codeH = fitSize(code, iw, ih * R5.codeH, true, R5.codeMinMM);
      gap = value ? ih * R5.gap : 0;
      if (value && ih - codeH - gap < ih * R5.bcMinH) {   // bars win ties
        codeH = Math.max(R5.codeMinMM, ih * (1 - R5.bcMinH - R5.gap));
        codeH = fitSize(code, iw, codeH, true, R5.codeMinMM);
        gap = ih * R5.gap;
      }
      out.push({ kind: 'text', text: code, x: cx, y: pad + codeH, size: codeH, bold: true, align: 'center' });
    }
    if (value) {
      var by = pad + codeH + gap, bh = ih - codeH - gap;
      if (bh > 0.5) {
        var bc = barcodeFill(value, vfmt, pad, by, iw, bh);
        for (var i = 0; i < bc.prims.length; i++) out.push(bc.prims[i]);
      }
    }
    return out;
  }

  // ── Recipe: SKU + 5DC + barcode (roomier sheets) ────────────────────────
  // No product description. On a warehouse label the code IS the identity —
  // R1021-WH-TRI says exactly which variant this is, while a wrapped marketing
  // name only eats the room the 5DC and the bars need. Same order as the
  // existing barcode print: the code on top, the 5DC big under it, bars below.
  var RS = {
    pad:      0.05,   // × min(W,H), clamped to 1–2 mm
    skuH:     0.13,   // × ih
    skuMinMM: 1.6,
    dc5H:     0.20,   // × ih
    dc5MinMM: 2.4,
    lead:     1.12,
    gap:      0.04    // × ih, between the text block and the bars
  };
  function stackPad(W, H) { return Math.max(1.0, Math.min(2.0, Math.min(W, H) * RS.pad)); }
  function layoutProductStack(cell, W, H) {
    var out = [];
    var pad = stackPad(W, H);
    var iw = W - 2 * pad, ih = H - 2 * pad, cx = W / 2;
    if (iw <= 0 || ih <= 0) return out;

    var eb = effectiveBarcode(cell, 'stack'), value = eb.value;
    var sku = usable(cell.sku) || usable(cell.code);
    var dc5 = usable(cell.dc5);

    // Codes never wrap — a code broken across two lines cannot be read back.
    // They shrink to fit the width instead.
    var rows = [], i;
    if (sku && ih >= 10) rows.push({ t: sku, fs: fitSize(sku, iw, ih * RS.skuH, false, RS.skuMinMM), b: false });
    if (dc5 && ih >= 6) rows.push({ t: dc5, fs: fitSize(dc5, iw, ih * RS.dc5H, true, RS.dc5MinMM), b: true });

    var textH = rows.reduce(function (s, r) { return s + r.fs * RS.lead; }, 0);
    var gap = rows.length && value ? Math.max(0.6, Math.min(1.6, ih * RS.gap)) : 0;
    var bcH = 0;
    if (value) {
      bcH = ih - textH - gap;
      if (bcH < 4) { rows = []; textH = 0; gap = 0; bcH = ih; }     // too tight -> bars only
    }
    var cy = pad + Math.max(0, (ih - (textH + gap + bcH)) / 2);
    for (i = 0; i < rows.length; i++) {
      cy += rows[i].fs;
      out.push({ kind: 'text', text: rows[i].t, x: cx, y: cy, size: rows[i].fs, bold: rows[i].b, align: 'center' });
      cy += rows[i].fs * (RS.lead - 1);
    }
    if (bcH > 0.5) {
      cy += gap;
      var bc = barcodeFill(value, eb.fmt, pad, cy, iw, bcH);
      for (i = 0; i < bc.prims.length; i++) out.push(bc.prims[i]);
    } else if (value) {
      out.push({ kind: 'text', text: value, x: cx, y: H / 2, size: 2.8, align: 'center' });
    }
    return out;
  }

  // ── Recipe: a barcode on its own ────────────────────────────────────────
  function layoutBarcodeCell(cell, W, H) {
    var eb = effectiveBarcode(cell);
    if (!eb.value) return [];
    var pad = Math.max(1.0, Math.min(2.0, Math.min(W, H) * 0.05));
    return barcodeFill(eb.value, eb.fmt, pad, pad, W - 2 * pad, H - 2 * pad).prims;
  }

  // ── Recipe: free text ───────────────────────────────────────────────────
  function layoutTextCell(cell, W, H) {
    var out = [];
    var pad = Math.max(1.0, Math.min(2.0, Math.min(W, H) * 0.06));
    var iw = W - 2 * pad, ih = H - 2 * pad;
    if (iw <= 0 || ih <= 0) return out;
    var blk = fitBlock(cell.text || '', iw, ih, Math.min(4.6, ih * 0.5), 1.4, 1.15);
    var lead = blk.size * 1.15, total = blk.lines.length * lead;
    var cy = pad + Math.max(0, (ih - total) / 2);
    for (var i = 0; i < blk.lines.length; i++) {
      cy += blk.size;
      out.push({ kind: 'text', text: blk.lines[i], x: W / 2, y: cy, size: blk.size, align: 'center' });
      cy += lead - blk.size;
    }
    return out;
  }

  function layoutBrandLabel(cell, W, H) {
    var A = window.LABEL_ASSETS || {}, S = SPEC, out = [];
    if (!cell || !(W > 0) || !(H > 0)) return out;

    var pad = H * S.pad;
    var iw = W - 2 * pad, av = H - 2 * pad;
    var top = pad, bot = H - pad, cx = W / 2;
    if (iw <= 0 || av <= 0) return out;

    if (cell.border) {
      var bi = H * S.borderInset;
      out.push({ kind: 'rect', x: bi, y: bi, w: W - 2 * bi, h: H - 2 * bi, r: H * S.borderR, lw: Math.max(0.08, H * S.borderW) });
    }

    // Bottom band — barcode on the right, compliance strip on the left.
    var bcBoxW = iw * S.bcW, bcBoxH = av * S.bcMaxH;
    var ebL = effectiveBarcode(cell);
    var bc = barcodeFit(ebL.value, ebL.fmt, W - pad - bcBoxW, bot - bcBoxH, bcBoxW, bcBoxH);
    var bcW = bc.w, bcH = bc.h;
    if (bcH > 0) {
      // barcodeFit centres inside the box; pin it to the bottom-right corner.
      var dx = (bcBoxW - bcW) / 2, dy = (bcBoxH - bcH) / 2;
      for (var i2 = 0; i2 < bc.prims.length; i2++) {
        bc.prims[i2].x += dx; bc.prims[i2].y += dy;
        out.push(bc.prims[i2]);
      }
    }
    var sym = A.symbols;
    if (sym && sym.img && sym.img.naturalWidth) {
      var sasp = sym.img.naturalWidth / sym.img.naturalHeight;
      var sh = av * S.symH, sw = sh * sasp;
      var room = Math.max(0, iw - bcW - iw * S.symGap);
      if (sw > room) { sw = room; sh = sw / sasp; }
      if (sw > 0.2) out.push({ kind: 'image', img: sym.img, url: sym.url, x: pad, y: bot - sh, w: sw, h: sh });
    }
    var contentBottom = bot - Math.max(bcH, av * S.bcMinBand) - av * S.bandGap;

    // Top-down content flow.
    var cy = top;
    var logo = A.logo;
    if (logo && logo.img && logo.img.naturalWidth) {
      var lasp = logo.img.naturalWidth / logo.img.naturalHeight;
      var lh = av * S.logoH, lw = lh * lasp;
      if (lw > iw * S.logoMaxW) { lw = iw * S.logoMaxW; lh = lw / lasp; }
      out.push({ kind: 'image', img: logo.img, url: logo.url, x: cx - lw / 2, y: cy, w: lw, h: lh });
      cy += lh + av * S.logoGap;
    }

    if (cell.code) {
      var cs = fitSize(cell.code, iw, av * S.codeH, true, S.codeMinMM);
      cy += cs;                                        // advance to the baseline
      out.push({ kind: 'text', text: String(cell.code), x: cx, y: cy, size: cs, bold: true, align: 'center' });
      cy += av * S.codeGap;
    }

    if (cell.desc) {
      var maxDescH = Math.max(av * S.descFloor, (contentBottom - cy) * S.descMaxFrac);
      var d = fitBlock(cell.desc, iw, maxDescH, av * S.descH, S.descMinMM, S.descLead);
      for (var i = 0; i < d.lines.length; i++) {
        cy += d.size;
        out.push({ kind: 'text', text: d.lines[i], x: cx, y: cy, size: d.size, align: 'center' });
        cy += d.size * (S.descLead - 1);
      }
      cy += av * S.descGap;
    }

    var specs = (cell.lines || []).map(function (s) { return String(s == null ? '' : s).trim(); }).filter(Boolean);
    var availL = contentBottom - cy;
    if (specs.length && availL > 1.5) {
      var wrapAll = function (size) {
        var acc = [];
        specs.forEach(function (ln) { wrap(ln, iw, size).forEach(function (x) { acc.push(x); }); });
        return acc;
      };
      var ls = av * S.lineH, rows = wrapAll(ls);
      while (ls > S.lineMinMM && rows.length * ls * S.lineLead > availL) { ls -= 0.1; rows = wrapAll(ls); }
      var lead = ls * S.lineLead;
      var ly = cy + Math.max(0, (availL - rows.length * lead) / 2);
      for (var j = 0; j < rows.length; j++) {
        ly += ls;
        out.push({ kind: 'text', text: rows[j], x: cx, y: ly, size: ls, align: 'center' });
        ly += lead - ls;
      }
    }

    return out;
  }

  // ── Backend A — canvas (on-screen preview) ──────────────────────────────
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function paint(ctx, prims, s) {
    for (var i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.kind === 'text') {
        ctx.font = fontCss(p.size * s, p.bold, p.mono);
        ctx.textAlign = p.align || 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = SPEC.ink;
        ctx.fillText(String(p.text), p.x * s, p.y * s);
      } else if (p.kind === 'fill') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(p.x * s, p.y * s, Math.max(0.6, p.w * s), p.h * s);
      } else if (p.kind === 'image') {
        if (p.img) { try { ctx.drawImage(p.img, p.x * s, p.y * s, p.w * s, p.h * s); } catch (e) {} }
      } else if (p.kind === 'rect') {
        ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, p.lw * s);
        roundRectPath(ctx, p.x * s, p.y * s, p.w * s, p.h * s, p.r * s);
        ctx.stroke();
      }
    }
  }
  function toCanvas(cell, W, H, pxPerMM, opts) {
    var s = pxPerMM || (300 / 25.4);
    var cv = document.createElement('canvas');
    cv.width = Math.max(4, Math.round(W * s));
    cv.height = Math.max(4, Math.round(H * s));
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    paint(ctx, layout(cell, W, H, opts), s);
    return cv;
  }

  // ── Backend B — jsPDF (print) ───────────────────────────────────────────
  // Images are re-encoded once and memoised on the element: jsPDF dedupes by
  // data, so the logo and the strip cost one object for the entire sheet.
  function imgUrl(p) {
    if (p.url) return p.url;
    var im = p.img;
    if (!im) return null;
    if (im._lrURL) return im._lrURL;
    if (im.toDataURL) { try { im._lrURL = im.toDataURL('image/png'); return im._lrURL; } catch (e) { return null; } }
    return null;
  }
  function toPdf(doc, cell, ox, oy, W, H, opts) {
    drawPdf(doc, layout(cell, W, H, opts), ox, oy);
  }
  function drawPdf(doc, prims, ox, oy) {
    ox = ox || 0; oy = oy || 0;
    for (var i = 0; i < prims.length; i++) {
      var p = prims[i];
      if (p.kind === 'text') {
        doc.setFont(p.mono ? 'courier' : 'helvetica', p.bold ? 'bold' : 'normal');
        doc.setFontSize(p.size / PT2MM);
        doc.setTextColor(17, 17, 17);
        doc.text(String(p.text), ox + p.x, oy + p.y, { align: p.align || 'center' });
      } else if (p.kind === 'fill') {
        doc.setFillColor(0, 0, 0);
        doc.rect(ox + p.x, oy + p.y, p.w, p.h, 'F');
      } else if (p.kind === 'image') {
        var url = imgUrl(p);
        if (url) { try { doc.addImage(url, 'PNG', ox + p.x, oy + p.y, p.w, p.h); } catch (e) {} }
      } else if (p.kind === 'rect') {
        doc.setDrawColor(0); doc.setLineWidth(p.lw);
        if (p.r > 0) doc.roundedRect(ox + p.x, oy + p.y, p.w, p.h, p.r, p.r, 'S');
        else doc.rect(ox + p.x, oy + p.y, p.w, p.h, 'S');
      }
    }
  }

  // ── Print-quality check ──────────────────────────────────────────────────
  // Answers the only question that matters about a printed barcode: will it
  // scan? Returns the narrowest bar in millimetres for the given box, so the
  // editor can say so before a sheet is wasted.
  function scanQuality(value, fmt, boxW, boxH) {
    var v = String(value == null ? '' : value).trim();
    if (!v) return { ok: false, empty: true, moduleMM: 0, minMM: MIN_MODULE_MM, format: '', value: '' };
    var bc = barcodeFill(v, fmt, 0, 0, boxW, boxH);
    return {
      ok: bc.moduleMM >= MIN_MODULE_MM,
      empty: false,
      moduleMM: bc.moduleMM,
      minMM: MIN_MODULE_MM,
      format: bcFormat(v, fmt),
      value: v
    };
  }
  // Same question, asked about a cell on a given template.
  function cellScan(cell, W, H, recipe) {
    if (!cell || cell.type === 'text') return { ok: true, empty: true, moduleMM: 0, minMM: MIN_MODULE_MM, format: '', value: '' };
    var eb = effectiveBarcode(cell, recipe);
    var box = barcodeBox(recipe, W, H);
    return scanQuality(eb.value, eb.fmt, box.w, box.h);
  }
  // The barcode box a recipe would give this label — used by the check above.
  function barcodeBox(recipe, W, H) {
    if (recipe === 'code5dc') {
      var pad = Math.min(W, H) * R5.pad, ih = H - 2 * pad;
      return { w: W - 2 * pad, h: ih * (1 - R5.codeH - R5.gap) };
    }
    var p2 = stackPad(W, H), ih2 = H - 2 * p2;
    var textH = ih2 * (RS.skuH + RS.dc5H) * RS.lead;
    return { w: W - 2 * p2, h: Math.max(1, ih2 - textH - ih2 * RS.gap) };
  }

  window.LabelRender = {
    SPEC: SPEC,
    MIN_MODULE_MM: MIN_MODULE_MM,
    scanQuality: scanQuality,
    cellScan: cellScan,
    barcodeBox: barcodeBox,
    effectiveBarcode: effectiveBarcode,
    layout: layout,
    toCanvas: toCanvas,
    toPdf: toPdf,
    drawPdf: drawPdf,
    barcodeFit: barcodeFit,
    barcodeFill: barcodeFill,
    barcodeAspect: barcodeAspect,
    bcValue: bcValue,
    usable: usable,
    bcFormat: bcFormat,
    barcodeVector: barcodeVector,
    barcodeCanvas: barcodeCanvas,
    widthMM: widthMM,
    PT2MM: PT2MM
  };
})();
