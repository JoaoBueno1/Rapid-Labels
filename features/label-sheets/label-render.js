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
    pad:         0.045,   // × H   outer padding
    logoH:       0.15,    // × av
    logoMaxW:    0.68,    // × iw
    logoGap:     0.050,   // × av  clearance below the logo, above the code
    codeH:       0.115,   // × av  starting em size, shrinks to fit the width
    codeMinMM:   1.6,
    codeGap:     0.030,   // × av
    descH:       0.055,   // × av
    descMinMM:   1.2,
    descLead:    1.15,
    descShare:   0.55,    // × free height, when spec lines follow
    descGap:     0.035,   // × av
    lineH:       0.045,   // × av  spec lines
    lineMinMM:   1.2,
    lineLead:    1.20,
    bandH:       0.23,    // × av  bottom band: symbols + barcode
    bandGap:     0.030,   // × av  between the content block and the band
    bcW:         0.58,    // × iw  barcode fills this share of the band
    symGap:      0.04,    // × iw  clearance between strip and barcode
    symMaxW:     0.32,    // × iw  cap the compliance strip's width (small footnote)
    symMaxH:     0.62,    // × bandH  and its height, so it never crowds the barcode
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

  // The value and symbology actually encoded for a cell. Both the renderer and
  // the quality check call this, so what is measured is always exactly what
  // gets printed.
  //
  // GTIN symbology detection applies to a real product barcode only. A 5DC or a
  // SKU is an internal code, not a GTIN: an 8-digit 5DC encoded as EAN-8 would
  // come back from the scanner with a check digit appended — no longer the
  // number printed above it. Internal codes are always CODE128.
  //
  // With no product barcode the fallback is the 5DC, on EVERY template — so one
  // product scans to one value whichever sheet it was printed on. The SKU would
  // be unique where the 5DC is not (657 codes are shared, almost all of them a
  // product and its carton), but an 18-character SKU in CODE128 needs ~230
  // modules: 0.15 mm per bar on a 38 mm ticket and 0.25 mm on a 63.5 mm one,
  // which took 28% of the catalogue below the scan threshold. Of the shared
  // 5DCs only 18 groups have more than one member lacking a real barcode, and
  // that ambiguity is already on the label — the 5DC is printed either way.
  var FALLBACK_ORDER = ['dc5', 'sku', 'code'];
  function effectiveBarcode(cell) {
    if (!cell) return { value: '', fmt: 'CODE128' };
    if (cell.type === 'barcode') return { value: usable(cell.value), fmt: cell.fmt || 'auto' };
    if (cell.type === 'location') return { value: usable(cell.code) || usable(cell.value), fmt: 'CODE128' };
    var real = usable(cell.barcode);
    if (real) return { value: real, fmt: cell.fmt || 'auto' };
    return { value: bcValue(cell, FALLBACK_ORDER), fmt: 'CODE128' };
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
  function barcodeVector(value, fmt, noText) {
    value = String(value == null ? '' : value).trim();
    if (!value || typeof JsBarcode === 'undefined') return null;
    var key = value + '|' + (fmt || 'auto') + (noText ? '|nt' : '');
    if (key in _bcVec) return _bcVec[key];
    var res = null;
    try {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      var opt = noText ? Object.assign({}, BC_OPTS, { displayValue: false }) : BC_OPTS;
      try { JsBarcode(svg, value, Object.assign({ format: bcFormat(value, fmt) }, opt)); }
      catch (e) { JsBarcode(svg, value, Object.assign({ format: 'CODE128' }, opt)); }

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
  function barcodeFill(value, fmt, x, y, w, h, noText) {
    var none = { prims: [], moduleMM: 0 };
    if (!(w > 0) || !(h > 0)) return none;
    var v = barcodeVector(value, fmt, noText);
    if (!v) {                                            // raster fallback
      var c = barcodeCanvas(value, fmt);
      return c ? { prims: [{ kind: 'image', img: c, x: x, y: y, w: w, h: h }], moduleMM: 0 } : none;
    }
    var out = [], i, b, narrow = Infinity;
    var kx = w / v.w;

    // The digits get a reserved band at the bottom; the bars are scaled to end
    // exactly where it starts. Scaling the whole symbol by one vertical factor
    // and then clamping the font size separately let the two drift: squashed
    // into a wide, short box the baseline landed above where the bars ended and
    // the digits printed on top of them.
    var barBottom = 0;
    for (i = 0; i < v.bars.length; i++) barBottom = Math.max(barBottom, v.bars[i].y + v.bars[i].h);
    if (!(barBottom > 0)) barBottom = v.h;

    // JsBarcode leaves ~21% of its height for the digits, which on a short band
    // renders them near-illegible. Bar HEIGHT carries no data — only the widths
    // do — so the digits may take a bigger share than the symbol shipped with.
    var hasText = v.texts.length > 0;
    var textFrac = hasText ? Math.max(0.28, Math.min(0.34, (v.h - barBottom) / v.h)) : 0;
    var textH = h * textFrac;
    var barH = h - textH;
    var kyBar = barH / barBottom;

    for (i = 0; i < v.bars.length; i++) {
      b = v.bars[i];
      if (b.w < narrow) narrow = b.w;
      out.push({ kind: 'fill', x: x + b.x * kx, y: y + b.y * kyBar, w: b.w * kx, h: b.h * kyBar });
    }
    if (hasText && textH > 0.3) {
      var fs = Math.min(textH * 0.80, v.texts[0].size * kx);
      var base = y + barH + textH * 0.92;          // ~12% of the band stays clear of the bars
      for (i = 0; i < v.texts.length; i++) {
        b = v.texts[i];
        out.push({
          kind: 'text', text: b.text, x: x + b.x * kx, y: base, size: fs, mono: true,
          align: b.anchor === 'start' ? 'left' : (b.anchor === 'end' ? 'right' : 'center')
        });
      }
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
      case 'plabel':   return layoutBrandLabel(cell, W, H);
      case 'location': return layoutLocation(cell, W, H);
      case 'product':  return PRODUCT_RECIPES[(opts && opts.productRecipe) || 'stack'](cell, W, H);
      case 'barcode':  return layoutBarcodeCell(cell, W, H);
      case 'text':     return layoutTextCell(cell, W, H);
      default:         return [];
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
    var code = bcValue(cell, FALLBACK_ORDER);
    var eb = effectiveBarcode(cell), value = eb.value, vfmt = eb.fmt;

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

  // ── Recipe: shipping — code on top, 5DC left, barcode right ─────────────
  // This is the layout the existing barcode print already uses, and the sheet it
  // targets (99.1 × 38.1) is within a millimetre of that print's 100 × 40 mm
  // section, so the proportions carry over directly: code centred on top, the
  // 5DC large on the left for the human, the bars taking the whole right side.
  var SH = {
    pad:        1.0,     // mm
    titleH:     0.17,    // × H
    titleMinMM: 2.0,
    titleGap:   0.05,    // × H
    dc5H:       0.24,    // × H
    dc5MinMM:   3.0,
    bcW:        0.60,    // × iw
    colGap:     0.02     // × iw
  };
  function layoutShipping(cell, W, H) {
    var out = [];
    var pad = Math.min(SH.pad, Math.min(W, H) * 0.05);
    var iw = W - 2 * pad, ih = H - 2 * pad;
    if (iw <= 0 || ih <= 0) return out;

    var eb = effectiveBarcode(cell), value = eb.value;
    var title = usable(cell.sku) || usable(cell.code);
    var dc5 = usable(cell.dc5);

    var y = pad, titleFs = 0;
    if (title) {
      titleFs = fitSize(title, iw, H * SH.titleH, false, SH.titleMinMM);
      y += titleFs;
      out.push({ kind: 'text', text: title, x: W / 2, y: y, size: titleFs, align: 'center' });
      y += H * SH.titleGap;
    }

    var rowTop = y, rowH = (H - pad) - rowTop;
    if (rowH <= 0.5) return out;

    var bcWmm = iw * SH.bcW;
    if (value) {
      var bc = barcodeFill(value, eb.fmt, W - pad - bcWmm, rowTop, bcWmm, rowH);
      for (var i = 0; i < bc.prims.length; i++) out.push(bc.prims[i]);
    }
    if (dc5) {
      var colW = Math.max(2, iw - (value ? bcWmm + iw * SH.colGap : 0));
      var fs = fitSize(dc5, colW, Math.min(H * SH.dc5H, rowH * 0.9), true, SH.dc5MinMM);
      // cap height is roughly 0.7em, so half of it centres the line on the row
      out.push({ kind: 'text', text: dc5, x: pad, y: rowTop + rowH / 2 + fs * 0.35, size: fs, bold: true, align: 'left' });
    }
    return out;
  }

  // ── Recipe: location ────────────────────────────────────────────────────
  // Mirrors the existing location print: the code large above, the bars in the
  // middle with NO human-readable line of their own, and the code again small
  // underneath. Always CODE128 — a bin code is not a GTIN.
  var LOC = {
    pad:       1.0,     // mm
    topH:      0.235,   // × H
    topMinMM:  3.0,
    gap1:      0.025,   // × H
    bcH:       0.62,    // × H
    gap2:      0.015,   // × H
    botH:      0.095,   // × H
    botMinMM:  1.6,
    bcW:       0.94     // × iw
  };
  function layoutLocation(cell, W, H) {
    var out = [];
    var code = usable(cell.code) || usable(cell.value);
    if (!code) return out;
    var pad = Math.min(LOC.pad, Math.min(W, H) * 0.05);
    var iw = W - 2 * pad;
    if (iw <= 0 || H - 2 * pad <= 0) return out;

    var bcWmm = iw * LOC.bcW, bx = pad + (iw - bcWmm) / 2;

    var topFs = fitSize(code, bcWmm, H * LOC.topH, true, LOC.topMinMM);
    var botFs = fitSize(code, iw, H * LOC.botH, false, LOC.botMinMM);
    var bcHmm = H * LOC.bcH;
    // if the pieces overflow the label, the bars give way first — the code is
    // still readable by eye, and a squashed symbol still scans.
    var total = topFs + H * LOC.gap1 + bcHmm + H * LOC.gap2 + botFs;
    var room = H - 2 * pad;
    if (total > room) bcHmm = Math.max(2, bcHmm - (total - room));

    var y = pad + topFs;
    out.push({ kind: 'text', text: code, x: bx, y: y, size: topFs, bold: true, align: 'left' });
    y += H * LOC.gap1;

    var bc = barcodeFill(code, 'CODE128', bx, y, bcWmm, bcHmm, true);   // no HRI line
    for (var i = 0; i < bc.prims.length; i++) out.push(bc.prims[i]);
    y += bcHmm + H * LOC.gap2 + botFs;

    out.push({ kind: 'text', text: code, x: W / 2, y: y, size: botFs, align: 'center' });
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

    var eb = effectiveBarcode(cell), value = eb.value;
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

  function wrapAllLines(lines, maxWMM, sizeMM) {
    var acc = [];
    for (var i = 0; i < lines.length; i++) {
      wrap(lines[i], maxWMM, sizeMM).forEach(function (x) { acc.push(x); });
    }
    return acc;
  }

  // Brand assets arrive as an <img> and are replaced by a trimmed <canvas>
  // once normalised, so read whichever pair of dimensions is present.
  function assetDims(a) {
    var im = a && a.img;
    if (!im) return null;
    var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
    return (w > 0 && h > 0) ? { w: w, h: h } : null;
  }

  function layoutBrandLabel(cell, W, H) {
    var A = window.LABEL_ASSETS || {}, S = SPEC, out = [], i;
    if (!cell || !(W > 0) || !(H > 0)) return out;

    var pad = H * S.pad;
    var iw = W - 2 * pad, av = H - 2 * pad;
    var top = pad, bot = H - pad, cx = W / 2;
    if (iw <= 0 || av <= 0) return out;

    if (cell.border) {
      var bi = H * S.borderInset;
      out.push({ kind: 'rect', x: bi, y: bi, w: W - 2 * bi, h: H - 2 * bi, r: H * S.borderR, lw: Math.max(0.08, H * S.borderW) });
    }

    // ── Bottom band: compliance strip left, barcode right ──
    // The barcode FILLS its half of the band instead of keeping the symbol's
    // natural proportions. Preserving them meant the height cap decided the
    // width, so on a wide sheet the code shrank to 14% of the label — the same
    // small symbol on every size. Only horizontal ratios carry data, so filling
    // costs nothing and makes the code grow with the sheet.
    var bandH = av * S.bandH, bandTop = bot - bandH;
    var bcBoxW = iw * S.bcW;
    var ebL = effectiveBarcode(cell);
    var bc = barcodeFill(ebL.value, ebL.fmt, W - pad - bcBoxW, bandTop, bcBoxW, bandH);
    for (i = 0; i < bc.prims.length; i++) out.push(bc.prims[i]);

    var sym = A.symbols, symD = assetDims(sym);
    if (symD) {
      var sasp = symD.w / symD.h;
      // The compliance strip is a footnote, not a feature: cap both its width
      // (never past its half of the band) and its height so it sits small in
      // the bottom-left with clear air before the barcode, whatever the sheet.
      var symMaxW = Math.min(iw * S.symMaxW, iw - bcBoxW - iw * S.symGap);
      var sh = Math.min(bandH * S.symMaxH, symMaxW / sasp), sw = sh * sasp;
      if (sw > symMaxW) { sw = symMaxW; sh = sw / sasp; }
      if (sw > 0.2) out.push({ kind: 'image', img: sym.img, url: sym.url, x: pad, y: bot - sh, w: sw, h: sh });
    }

    // ── Content block, measured first then centred ──
    // Sizing every piece before placing any of it lets the whole block sit
    // centred in the space above the band. Laying it out top-down instead left
    // the spec line floating in a pool of leftover white, which read as a bug.
    var contentTop = top, contentBottom = bandTop - av * S.bandGap;
    var availH = contentBottom - contentTop;
    if (availH <= 1) return out;

    var blocks = [], blockH = 0;

    var logo = A.logo, logoD = assetDims(logo);
    if (logoD) {
      var lasp = logoD.w / logoD.h;
      var lh = av * S.logoH, lw = lh * lasp;
      if (lw > iw * S.logoMaxW) { lw = iw * S.logoMaxW; lh = lw / lasp; }
      blocks.push({ kind: 'logo', img: logo, w: lw, h: lh, gap: av * S.logoGap });
      blockH += lh + av * S.logoGap;
    }

    if (usable(cell.code)) {
      var cs = fitSize(cell.code, iw, av * S.codeH, true, S.codeMinMM);
      blocks.push({ kind: 'line', text: String(cell.code), size: cs, bold: true, gap: av * S.codeGap });
      blockH += cs + av * S.codeGap;
    }

    var specs = (cell.lines || []).map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
    var free = Math.max(0, availH - blockH);

    if (cell.desc) {
      var descRoom = specs.length ? free * S.descShare : free;
      var d = fitBlock(cell.desc, iw, Math.max(av * 0.12, descRoom), av * S.descH, S.descMinMM, S.descLead);
      blocks.push({ kind: 'para', lines: d.lines, size: d.size, lead: S.descLead, gap: av * S.descGap });
      blockH += d.lines.length * d.size * S.descLead + av * S.descGap;
    }

    if (specs.length) {
      var specRoom = Math.max(av * 0.06, availH - blockH);
      var joined = specs.join('\n');
      var ls = av * S.lineH, rows = wrapAllLines(specs, iw, ls);
      while (ls > S.lineMinMM && rows.length * ls * S.lineLead > specRoom) { ls -= 0.1; rows = wrapAllLines(specs, iw, ls); }
      blocks.push({ kind: 'para', lines: rows, size: ls, lead: S.lineLead, gap: 0 });
      blockH += rows.length * ls * S.lineLead;
      void joined;
    }

    // trailing gap of the last block should not push the centring off
    if (blocks.length) blockH -= blocks[blocks.length - 1].gap;

    var y = contentTop + Math.max(0, (availH - blockH) / 2);
    for (i = 0; i < blocks.length; i++) {
      var bkt = blocks[i];
      if (bkt.kind === 'logo') {
        out.push({ kind: 'image', img: bkt.img.img, url: bkt.img.url, x: cx - bkt.w / 2, y: y, w: bkt.w, h: bkt.h });
        y += bkt.h;
      } else if (bkt.kind === 'line') {
        y += bkt.size;
        out.push({ kind: 'text', text: bkt.text, x: cx, y: y, size: bkt.size, bold: bkt.bold, align: 'center' });
      } else {
        for (var j = 0; j < bkt.lines.length; j++) {
          y += bkt.size;
          out.push({ kind: 'text', text: bkt.lines[j], x: cx, y: y, size: bkt.size, align: 'center' });
          y += bkt.size * (bkt.lead - 1);
        }
      }
      y += bkt.gap;
    }

    return out;
  }

  var PRODUCT_RECIPES = { code5dc: layoutCode5dc, shipping: layoutShipping, stack: layoutProductStack };

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
    var eb = effectiveBarcode(cell);
    var box = barcodeBox(cell.type === 'location' ? 'location' : (cell.type === 'plabel' ? 'plabel' : recipe), W, H);
    return scanQuality(eb.value, eb.fmt, box.w, box.h);
  }
  // The barcode box a recipe would give this label — used by the check above.
  function barcodeBox(recipe, W, H) {
    if (recipe === 'location') {
      var pl = Math.min(LOC.pad, Math.min(W, H) * 0.05);
      return { w: (W - 2 * pl) * LOC.bcW, h: H * LOC.bcH };
    }
    if (recipe === 'shipping') {
      var ps = Math.min(SH.pad, Math.min(W, H) * 0.05);
      return { w: (W - 2 * ps) * SH.bcW, h: Math.max(1, (H - ps) - (ps + H * SH.titleH + H * SH.titleGap)) };
    }
    if (recipe === 'plabel') {
      var pb = H * SPEC.pad;
      return { w: (W - 2 * pb) * SPEC.bcW, h: (H - 2 * pb) * SPEC.bandH };
    }
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
