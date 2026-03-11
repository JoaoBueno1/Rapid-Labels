/* ═══════════════════════════════════════════════════
   Multi-Label Print System
   Fetches from cin7_mirror.products (attribute1=5DC, sku, barcode)
   Prints a table-format page (1 product per row) for warehouse visibility
   ═══════════════════════════════════════════════════ */

// ── Layout configs per paper+orientation ──
const ML_CONFIGS = {
  'A4-portrait':   { maxSlots: 8,  font5dc: 34, fontSku: 22, fontQty: 34, bcH: 18, cellH: 30, pageSz: 'A4 portrait',  w5dc: '18%', wsku: '28%', wbc: '36%', wqty: '18%', bcW: 1.5 },
  'A4-landscape':  { maxSlots: 5,  font5dc: 42, fontSku: 26, fontQty: 42, bcH: 22, cellH: 32, pageSz: 'A4 landscape', w5dc: '16%', wsku: '28%', wbc: '38%', wqty: '18%', bcW: 1.8 },
  'A3-portrait':   { maxSlots: 14, font5dc: 40, fontSku: 26, fontQty: 40, bcH: 22, cellH: 27, pageSz: 'A3 portrait',  w5dc: '16%', wsku: '28%', wbc: '38%', wqty: '18%', bcW: 1.8 },
  'A3-landscape':  { maxSlots: 10, font5dc: 44, fontSku: 28, fontQty: 44, bcH: 22, cellH: 27, pageSz: 'A3 landscape', w5dc: '15%', wsku: '26%', wbc: '40%', wqty: '19%', bcW: 1.8 },
};

// ── State ──
const mlState = {
  slots: [],          // [{sku, fiveDC, barcode, name, qty}]
  maxSlots: 8,        // portrait default
  paperSize: 'A4',
  orientation: 'portrait',
  productsCache: null, // cin7_mirror.products cached
  loading: false,
};

// ── Modal open/close ──
function openMultiLabelModal() {
  if (typeof closeAllModals === 'function') closeAllModals();
  document.getElementById('multiLabelModal').classList.remove('hidden');
  mlUpdateSlots();
  // Pre-load cin7_mirror products
  if (!mlState.productsCache) mlLoadProducts();
}

function closeMultiLabelModal() {
  document.getElementById('multiLabelModal').classList.add('hidden');
  // Reset all data so modal opens fresh next time
  mlState.slots = [];
}

// ── Load products from cin7_mirror ──
async function mlLoadProducts() {
  if (mlState.loading || mlState.productsCache) return;
  mlState.loading = true;
  try {
    await window.supabaseReady;
    const sb = window.supabase;
    if (!sb) return;
    const all = [];
    let offset = 0;
    const chunk = 1000;
    while (true) {
      const { data, error } = await sb
        .schema('cin7_mirror')
        .from('products')
        .select('sku, name, barcode, attribute1')
        .range(offset, offset + chunk - 1);
      if (error) { console.warn('Multi-label: cin7_mirror.products error:', error.message); break; }
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < chunk) break;
      offset += chunk;
    }
    mlState.productsCache = all;
    console.log(`✅ Multi-label: loaded ${all.length} products from cin7_mirror`);
  } catch (e) {
    console.warn('Multi-label: failed to load products:', e.message);
  } finally {
    mlState.loading = false;
  }
}

// ── Update slots when paper size or orientation changes ──
function mlUpdateSlots() {
  const orient = document.querySelector('input[name="mlOrientation"]:checked').value;
  const paper  = document.querySelector('input[name="mlPaperSize"]:checked').value;
  mlState.orientation = orient;
  mlState.paperSize   = paper;

  const key = paper + '-' + orient;
  const cfg = ML_CONFIGS[key] || ML_CONFIGS['A4-portrait'];
  mlState.maxSlots = cfg.maxSlots;

  // Update the product count hints in the UI
  document.querySelectorAll('.ml-orient-count').forEach(el => {
    const o = el.dataset.orient;
    const k = paper + '-' + o;
    const c = ML_CONFIGS[k];
    if (c) el.textContent = '(' + c.maxSlots + ' products)';
  });

  // Preserve existing data, trim or extend
  while (mlState.slots.length > mlState.maxSlots) mlState.slots.pop();
  while (mlState.slots.length < mlState.maxSlots) {
    mlState.slots.push({ sku: '', fiveDC: '', barcode: '', name: '', qty: '' });
  }

  mlRenderSlots();
}

// ── Render slot inputs ──
function mlRenderSlots() {
  const container = document.getElementById('mlSlots');
  container.innerHTML = '';

  mlState.slots.forEach((slot, i) => {
    const filled = !!(slot.sku || slot.fiveDC);
    const complete = filled && slot.qty;

    // Visual states: empty → neutral gray, has product → light green, product+qty → solid green
    const rowBg    = complete ? '#ecfdf5' : filled ? '#f0fdf4' : '#f8fafc';
    const rowBdr   = complete ? '#86efac' : filled ? '#bbf7d0' : '#e2e8f0';
    const numColor = complete ? '#16a34a' : filled ? '#4ade80' : '#94a3b8';
    const numIcon  = complete ? '✓' : (i + 1) + '.';

    const row = document.createElement('div');
    row.className = 'ml-slot-row';
    row.style.background = rowBg;
    row.style.borderColor = rowBdr;
    row.innerHTML = `
      <span class="ml-slot-num" style="color:${numColor};font-size:${complete ? '14px' : '12px'}">${numIcon}</span>
      <div class="ml-slot-5dc">
        <input type="text" class="ml-slot-input ml-slot-input-5dc" placeholder="5DC" value="${_esc(slot.fiveDC)}" data-idx="${i}" data-field="fiveDC"
               style="border-color:${filled ? '#86efac' : '#cbd5e1'}"
               oninput="mlOnInput(this)" onfocus="mlOnFocus(this)" autocomplete="off">
      </div>
      <div class="ml-slot-sku">
        <input type="text" class="ml-slot-input" placeholder="SKU / Product code" value="${_esc(slot.sku)}" data-idx="${i}" data-field="sku"
               style="border-color:${filled ? '#86efac' : '#cbd5e1'}"
               oninput="mlOnInput(this)" onfocus="mlOnFocus(this)" autocomplete="off">
        <div class="ml-ac-panel" data-idx="${i}" style="display:none;position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.08);z-index:3000;max-height:140px;overflow-y:auto;margin-top:2px;padding:4px 0"></div>
      </div>
      <div class="ml-slot-qty">
        <input type="number" class="ml-slot-input ml-slot-input-qty" placeholder="QTY" value="${slot.qty}" data-idx="${i}" data-field="qty" min="1"
               style="border-color:${complete ? '#86efac' : '#cbd5e1'}"
               oninput="mlOnQtyChange(this)">
      </div>
      <button type="button" class="ml-slot-clear" onclick="mlClearSlot(${i})" style="opacity:${filled ? '.7' : '.3'}" title="Clear">✕</button>
    `;
    container.appendChild(row);
  });

  mlUpdatePrintBtn();
}

function _esc(s) { return (s || '').replace(/"/g, '&quot;'); }

// ── Autocomplete logic ──
let mlAcDebounce = null;

function mlOnFocus(input) {
  const field = input.dataset.field;
  if (field === 'sku' && input.value.length >= 3) {
    mlShowAutocomplete(input);
  } else if (field === 'fiveDC' && input.value.length >= 3) {
    mlShowAc5DC(input);
  }
}

function mlOnInput(input) {
  const idx = parseInt(input.dataset.idx);
  const field = input.dataset.field;
  const val = input.value.trim();

  mlState.slots[idx][field] = val;

  if (field === 'fiveDC') {
    // Show autocomplete dropdown for 5DC (attribute1) — require user click to select
    clearTimeout(mlAcDebounce);
    mlAcDebounce = setTimeout(() => {
      if (val.length >= 3) mlShowAc5DC(input);
      else mlHideAcPanel(idx);
    }, 300);
  } else if (field === 'sku') {
    clearTimeout(mlAcDebounce);
    mlAcDebounce = setTimeout(() => {
      if (val.length >= 3) mlShowAutocomplete(input);
      else mlHideAcPanel(idx);
    }, 250);
  }

  mlUpdatePrintBtn();
}

function mlOnQtyChange(input) {
  const idx = parseInt(input.dataset.idx);
  mlState.slots[idx].qty = input.value;
  mlUpdatePrintBtn();
}

function mlSearchBy5DC(idx, term) {
  // Only called from autocomplete selection now (not auto-match)
  if (!mlState.productsCache) return;
  const match = mlState.productsCache.find(p => (p.attribute1 || '').trim() === term);
  if (match) {
    mlState.slots[idx].sku = match.sku || '';
    mlState.slots[idx].barcode = match.barcode || '';
    mlState.slots[idx].name = match.name || '';
    mlState.slots[idx].fiveDC = term;
    mlRenderSlots();
  }
}

function mlShowAc5DC(input) {
  const idx = parseInt(input.dataset.idx);
  const term = input.value.trim();
  if (!mlState.productsCache || term.length < 3) { mlHideAc5DCPanel(idx); return; }

  const matches = mlState.productsCache
    .filter(p => (p.attribute1 || '').includes(term))
    .slice(0, 12);

  // Find or create a panel near the 5DC input
  let panel = document.querySelector(`.ml-ac-5dc[data-idx="${idx}"]`);
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'ml-ac-5dc';
    panel.dataset.idx = idx;
    panel.style.cssText = 'display:none;position:absolute;left:0;top:100%;min-width:380px;background:#fff;border:1px solid #94a3b8;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.18);z-index:9999;max-height:220px;overflow-y:auto;margin-top:4px;padding:4px 0';
    input.parentElement.style.position = 'relative';
    input.parentElement.appendChild(panel);
  }

  if (matches.length === 0) { panel.style.display = 'none'; _ml5dcResetRowZ(idx); return; }

  panel.innerHTML = matches.map(m => `
    <div style="padding:8px 12px;font-size:13px;display:flex;align-items:center;gap:12px;cursor:pointer;border-bottom:1px solid #f1f5f9;transition:background .15s"
         onmouseenter="this.style.background='#f0f9ff'" onmouseleave="this.style.background=''"
         onmousedown="mlSelectProduct(${idx}, '${_escJs(m.sku)}', '${_escJs(m.attribute1 || '')}', '${_escJs(m.barcode || '')}', '${_escJs(m.name || '')}')">
      <span style="font-weight:700;color:#0f172a;font-size:15px;min-width:55px;flex-shrink:0">${_esc(m.attribute1 || '')}</span>
      <span style="color:#475569;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(m.sku)}</span>
      <span style="color:#64748b;font-size:11px;flex:1;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc((m.name || '').substring(0, 50))}</span>
    </div>
  `).join('');
  panel.style.display = 'block';

  // Raise current row above siblings so dropdown isn't clipped
  const row = input.closest('div[style*="display:flex"]');
  if (row) row.style.zIndex = '100';

  setTimeout(() => {
    document.addEventListener('click', function _close(e) {
      if (!panel.contains(e.target) && e.target !== input) {
        panel.style.display = 'none';
        _ml5dcResetRowZ(idx);
        document.removeEventListener('click', _close);
      }
    });
  }, 50);
}

function mlHideAc5DCPanel(idx) {
  const panel = document.querySelector(`.ml-ac-5dc[data-idx="${idx}"]`);
  if (panel) panel.style.display = 'none';
  _ml5dcResetRowZ(idx);
}

function _ml5dcResetRowZ(idx) {
  const container = document.getElementById('mlSlots');
  if (!container) return;
  const rows = container.children;
  if (rows[idx]) rows[idx].style.zIndex = '';
}

function mlShowAutocomplete(input) {
  const idx = parseInt(input.dataset.idx);
  const term = input.value.trim().toLowerCase();
  if (!mlState.productsCache || term.length < 3) { mlHideAcPanel(idx); return; }

  const matches = mlState.productsCache
    .filter(p =>
      (p.sku || '').toLowerCase().includes(term) ||
      (p.name || '').toLowerCase().includes(term)
    )
    .slice(0, 12);

  const panel = document.querySelector(`.ml-ac-panel[data-idx="${idx}"]`);
  if (!panel || matches.length === 0) { mlHideAcPanel(idx); return; }

  panel.innerHTML = matches.map(m => `
    <div style="padding:6px 10px;font-size:11px;display:flex;justify-content:space-between;gap:8px;cursor:pointer"
         onmousedown="mlSelectProduct(${idx}, '${_escJs(m.sku)}', '${_escJs(m.attribute1 || '')}', '${_escJs(m.barcode || '')}', '${_escJs(m.name || '')}')">
      <span style="font-weight:600;color:#0f172a">${_esc(m.sku)}</span>
      <span style="color:#64748b;font-size:10px;text-align:right;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(m.attribute1 || '')} · ${_esc((m.name || '').substring(0, 40))}</span>
    </div>
  `).join('');
  panel.style.display = 'block';

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function _close(e) {
      if (!panel.contains(e.target) && e.target !== input) {
        panel.style.display = 'none';
        document.removeEventListener('click', _close);
      }
    });
  }, 50);
}

function _escJs(s) { return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

function mlHideAcPanel(idx) {
  const panel = document.querySelector(`.ml-ac-panel[data-idx="${idx}"]`);
  if (panel) panel.style.display = 'none';
}

function mlSelectProduct(idx, sku, fiveDC, barcode, name) {
  mlState.slots[idx] = { sku, fiveDC, barcode, name, qty: mlState.slots[idx].qty || '' };
  mlHideAcPanel(idx);
  mlRenderSlots();
}

function mlClearSlot(idx) {
  mlState.slots[idx] = { sku: '', fiveDC: '', barcode: '', name: '', qty: '' };
  mlRenderSlots();
}

function mlClearAll() {
  mlState.slots = [];
  mlUpdateSlots();
}

function mlUpdatePrintBtn() {
  const hasAny = mlState.slots.some(s => s.sku || s.fiveDC);
  const btn = document.getElementById('mlPrintBtn');
  if (btn) btn.disabled = !hasAny;
}

// ── PRINT ──
function mlPrint() {
  var items = mlState.slots.filter(function(s) { return s.sku || s.fiveDC; });
  if (items.length === 0) return;

  var key = mlState.paperSize + '-' + mlState.orientation;
  var cfg = ML_CONFIGS[key] || ML_CONFIGS['A4-portrait'];

  var font5dc  = cfg.font5dc;
  var fontSku  = cfg.fontSku;
  var fontQty  = cfg.fontQty;
  var bcH      = cfg.bcH;
  var cellH    = cfg.cellH;
  var pageSz   = cfg.pageSz;
  var bcPixelH = Math.round(bcH * 2.5);
  var bcW      = cfg.bcW || 1.5;
  var w5dc     = cfg.w5dc;
  var wsku     = cfg.wsku;
  var wbc      = cfg.wbc;
  var wqty     = cfg.wqty;

  // Build table rows
  var rowsHtml = '';
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    rowsHtml += '<tr>';
    rowsHtml += '<td class="ml-cell ml-5dc">' + _esc(item.fiveDC) + '</td>';
    rowsHtml += '<td class="ml-cell ml-sku">' + _esc(item.sku) + '</td>';
    rowsHtml += '<td class="ml-cell ml-bc"><svg data-bc="' + _esc(item.barcode) + '" data-sku="' + _esc(item.sku) + '"></svg></td>';
    rowsHtml += '<td class="ml-cell ml-qty">' + _esc(String(item.qty || '')) + '</td>';
    rowsHtml += '</tr>';
  }

  var dateStr = new Date().toLocaleDateString('en-AU');

  var parts = [];
  var isA3 = mlState.paperSize === 'A3';
  var pageMargin = isA3 ? '4mm 6mm' : '6mm 8mm';

  parts.push('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Multi-Label Print</title>');
  parts.push('<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></scr' + 'ipt>');
  parts.push('<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></scr' + 'ipt>');
  parts.push('<style>');
  parts.push('@page { size: ' + pageSz + '; margin: ' + pageMargin + '; }');
  parts.push('* { margin:0; padding:0; box-sizing:border-box; }');
  parts.push('body { font-family: Arial, Helvetica, sans-serif; }');
  parts.push('table { width:100%; border-collapse:collapse; table-layout:fixed; }');
  parts.push('thead th { font-size:10pt; font-weight:700; color:#334155; text-align:center; padding:1.5mm 2mm; border-bottom:2px solid #334155; text-transform:uppercase; letter-spacing:0.5px; }');
  parts.push('.ml-cell { text-align:center; vertical-align:middle; border-bottom:1px solid #cbd5e1; padding:1mm 2mm; height:' + cellH + 'mm; overflow:hidden; }');
  parts.push('.ml-5dc { font-size:' + font5dc + 'pt; font-weight:800; color:#0f172a; width:' + w5dc + '; line-height:1; }');
  parts.push('.ml-sku { font-size:' + fontSku + 'pt; font-weight:600; color:#1e293b; width:' + wsku + '; word-break:break-all; line-height:1.1; }');
  parts.push('.ml-bc { width:' + wbc + '; }');
  parts.push('.ml-bc svg { height:' + bcH + 'mm; width:auto; max-width:100%; }');
  parts.push('.ml-qty { font-size:' + fontQty + 'pt; font-weight:800; color:#0f172a; width:' + wqty + '; line-height:1; }');
  parts.push('tr:last-child .ml-cell { border-bottom:2px solid #334155; }');
  parts.push('@media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }');
  parts.push('.ml-footer { position:fixed; bottom:3mm; right:8mm; font-size:7pt; color:#94a3b8; }');
  parts.push('</style></head><body>');
  parts.push('<table><thead><tr><th>5DC</th><th>SKU</th><th>BARCODE</th><th>QTY</th></tr></thead>');
  parts.push('<tbody>' + rowsHtml + '</tbody></table>');
  parts.push('<div class="ml-footer">' + dateStr + ' · Rapid Labels</div>');
  parts.push('<scr' + 'ipt>');
  parts.push('document.addEventListener("DOMContentLoaded", function() {');
  parts.push('  var svgs = document.querySelectorAll(".ml-bc svg[data-bc]");');
  parts.push('  for (var i = 0; i < svgs.length; i++) {');
  parts.push('    var svg = svgs[i];');
  parts.push('    var val = svg.getAttribute("data-bc") || "";');
  parts.push('    var skuFallback = svg.getAttribute("data-sku") || "";');
  parts.push('    if (!val && !skuFallback) { svg.style.display="none"; continue; }');
  parts.push('    if (!val) { val = skuFallback; }');
  parts.push('    try {');
  parts.push('      var fmt = val.length === 13 ? "EAN13" : (val.length === 12 ? "UPC" : "CODE128");');
  parts.push('      JsBarcode(svg, val, { format:fmt, height:' + bcPixelH + ', width:' + bcW + ', displayValue:true, fontSize:11, margin:2, textMargin:1 });');
  parts.push('    } catch(e) {');
  parts.push('      try { JsBarcode(svg, val, { format:"CODE128", height:' + bcPixelH + ', width:' + bcW + ', displayValue:true, fontSize:11, margin:2, textMargin:1 }); }');
  parts.push('      catch(e2) { svg.style.display="none"; }');
  parts.push('    }');
  parts.push('  }');
  parts.push('  var __isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);');
  parts.push('  setTimeout(function(){');
  parts.push('    if (!__isMobile) { window.print(); return; }');
  parts.push('    html2pdf().from(document.body).set({');
  parts.push('      margin: ' + (isA3 ? 4 : 6) + ',');
  parts.push('      filename: "multi-label.pdf",');
  parts.push('      image: { type: "jpeg", quality: 0.95 },');
  parts.push('      html2canvas: { scale: 2, useCORS: true },');
  parts.push('      jsPDF: { unit: "mm", format: "' + mlState.paperSize.toLowerCase() + '", orientation: "' + mlState.orientation + '" }');
  parts.push('    }).output("blob").then(function(blob) {');
  parts.push('      var url = URL.createObjectURL(blob);');
  parts.push('      window.location.href = url;');
  parts.push('    });');
  parts.push('  }, 400);');
  parts.push('});');
  parts.push('</scr' + 'ipt></body></html>');

  var html = parts.join('\n');

  var win = window.open('', '_blank');
  if (!win) { alert('Pop-up blocked. Please allow pop-ups for this site.'); return; }
  win.document.write(html);
  win.document.close();
}
