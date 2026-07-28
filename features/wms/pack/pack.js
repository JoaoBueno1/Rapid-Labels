// Pack Station (desktop) — Rapid WMS. Scan-first packing for picked orders:
//   1) scan items into cartons (barcode 13/14-digit, OR the SKU printed as CODE128
//      e.g. R1021-WH-TRI — both resolve to the same order line)
//   2) capture carton dimensions
//   3) authorise the pack in Cin7 (via the WMS outbox — exactly-once) → print slip →
//      hand off to booking in the TMS.
// Reads picked orders + commits via /api/wms/*; resolves scans against cin7_mirror
// products with the anon client (client-side, so scanning is instant).

const API = '/api/wms';
const PACK = {
  queue: [],
  sel: null,                 // { parcelId, taskId, wave, lines }
  lines: [],                 // [{ id, sku, name, qty_ordered, qty_scanned }]
  packed: {},                // lineId -> packed count
  lineBox: {},               // lineId -> carton name
  boxes: [{ name: 'Box 1', l: '', w: '', h: '', weight: '' }],
  currentBox: 'Box 1',
  barcodeMap: {},            // barcode -> sku
  skuByUpper: {},            // UPPER(sku) -> sku
  committed: false
};
window.PACK = PACK;          // debug/inspection handle

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function totOrdered() { return PACK.lines.reduce((s, l) => s + Number(l.qty_ordered || 0), 0); }
function totPacked() { return PACK.lines.reduce((s, l) => s + (PACK.packed[l.id] || 0), 0); }

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}
async function sbClient() {
  try { await (window.supabaseReady || Promise.resolve()); } catch (_) {}
  return (window.supabaseSearch && window.supabaseSearch.client) || window.supabase || null;
}

// ═══ landing: the pack queue ═══
async function loadQueue() {
  const body = $('pkQueueBody');
  body.innerHTML = '<tr><td colspan="4" class="pk-muted">Loading…</td></tr>';
  try {
    PACK.queue = await api('GET', '/pack/ready');
    renderQueue();
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="pk-muted">Couldn't load the pack queue — ${esc(e.message)}.<br><span class="pk-small">The WMS API needs the server running the latest code and the <b>wms</b> schema deployed + exposed.</span></td></tr>`;
    $('pkQueueCount').textContent = '';
  }
}
function renderQueue() {
  const body = $('pkQueueBody');
  $('pkQueueCount').textContent = PACK.queue.length ? `${PACK.queue.length} order${PACK.queue.length !== 1 ? 's' : ''}` : '';
  if (!PACK.queue.length) { body.innerHTML = '<tr><td colspan="4" class="pk-muted">Nothing waiting to pack right now.</td></tr>'; return; }
  body.innerHTML = PACK.queue.map(it => {
    const n = (it.lines || []).length;
    return `<tr class="pk-qrow" data-parcel="${it.parcelId}">` +
      `<td class="rt-mono"><b>${esc(it.wave.order_number || ('parcel ' + it.parcelId))}</b></td>` +
      `<td>${esc(it.wave.customer || '—')}</td>` +
      `<td class="r">${n}</td>` +
      `<td class="r"><button class="rt-btn rt-btn-sm rt-btn-primary" data-parcel="${it.parcelId}">Pack →</button></td></tr>`;
  }).join('');
}
function openBySearch() {
  const q = ($('pkOrderSearch').value || '').trim().toLowerCase();
  if (!q) return;
  const it = PACK.queue.find(x => String(x.wave.order_number || '').toLowerCase() === q) ||
             PACK.queue.find(x => String(x.wave.order_number || '').toLowerCase().includes(q));
  if (it) selectOrder(it.parcelId);
  else { $('pkScanMsg') && ($('pkScanMsg').textContent = ''); alert('That order is not in the pack queue — only PICKED orders can be packed.'); }
}

// ═══ workspace ═══
async function selectOrder(parcelId) {
  const it = PACK.queue.find(x => String(x.parcelId) === String(parcelId));
  if (!it) return;
  PACK.sel = it;
  PACK.lines = (it.lines || []).slice();
  PACK.packed = {}; PACK.lineBox = {};
  PACK.boxes = [{ name: 'Box 1', l: '', w: '', h: '', weight: '' }];
  PACK.currentBox = 'Box 1';
  PACK.committed = false;
  PACK.lines.forEach(l => { PACK.packed[l.id] = Number(l.qty_scanned) > 0 ? 0 : 0; PACK.lineBox[l.id] = 'Box 1'; });

  // pre-fetch product barcodes for instant client-side scan resolution
  PACK.barcodeMap = {}; PACK.skuByUpper = {};
  PACK.lines.forEach(l => { PACK.skuByUpper[String(l.sku).toUpperCase()] = l.sku; });
  try {
    const sb = await sbClient();
    if (sb) {
      const skus = [...new Set(PACK.lines.map(l => l.sku).filter(Boolean))];
      const { data } = await sb.schema('cin7_mirror').from('products').select('sku,barcode').in('sku', skus);
      (data || []).forEach(p => { if (p.barcode && !/^0+$/.test(String(p.barcode))) PACK.barcodeMap[String(p.barcode).trim()] = p.sku; });
    }
  } catch (_) {}

  $('pkLanding').style.display = 'none';
  $('pkWorkspace').style.display = '';
  $('pkWsNo').textContent = it.wave.order_number || ('parcel ' + it.parcelId);
  $('pkWsCust').textContent = it.wave.customer || '';
  renderBoxes(); renderCurrentBoxSelect(); renderLines(); updateProgress();
  setTimeout(() => { const s = $('pkScan'); if (s) s.focus(); }, 60);
}
function backToOrders() {
  $('pkWorkspace').style.display = 'none';
  $('pkLanding').style.display = '';
}

// ── scanning ──
function scanFeedback(kind, text) {
  const el = $('pkScanMsg'); if (!el) return;
  el.className = 'pk-scanmsg ' + kind;
  el.textContent = text;
}
function flashLine(lineId) {
  const row = document.querySelector(`#pkLinesBody tr[data-line="${lineId}"]`);
  if (row) { row.classList.remove('pk-flash'); void row.offsetWidth; row.classList.add('pk-flash'); }
}
function onScan(code) {
  code = String(code || '').trim();
  if (!code) return;
  const up = code.toUpperCase();
  let sku = PACK.barcodeMap[code] || PACK.barcodeMap[up];    // 13/14-digit barcode
  if (!sku && PACK.skuByUpper[up]) sku = PACK.skuByUpper[up]; // SKU printed as CODE128
  if (!sku) { scanFeedback('err', `✗ "${code}" — not on this order`); return; }
  const skuU = sku.toUpperCase();
  const anyLine = PACK.lines.find(l => String(l.sku).toUpperCase() === skuU);
  if (!anyLine) { scanFeedback('err', `✗ ${sku} — not on this order`); return; }
  const line = PACK.lines.find(l => String(l.sku).toUpperCase() === skuU && (PACK.packed[l.id] || 0) < Number(l.qty_ordered));
  if (!line) { scanFeedback('warn', `• ${sku} already fully packed`); flashLine(anyLine.id); return; }
  PACK.packed[line.id] = (PACK.packed[line.id] || 0) + 1;
  PACK.lineBox[line.id] = PACK.currentBox;
  scanFeedback('ok', `✓ ${sku} → ${PACK.currentBox}  (${PACK.packed[line.id]}/${Number(line.qty_ordered)})`);
  renderLines(); updateProgress(); flashLine(line.id);
}

// ── lines ──
function boxOptions(sel) { return PACK.boxes.map(b => `<option${b.name === sel ? ' selected' : ''}>${esc(b.name)}</option>`).join(''); }
function renderLines() {
  const body = $('pkLinesBody');
  body.innerHTML = PACK.lines.map(l => {
    const packed = PACK.packed[l.id] || 0, ord = Number(l.qty_ordered);
    const done = packed >= ord, over = packed > ord;
    return `<tr data-line="${l.id}" class="${done ? 'pk-done' : ''}${over ? ' pk-over' : ''}">` +
      `<td class="rt-mono">${esc(l.sku)}</td>` +
      `<td>${esc((l.name || '').slice(0, 54))}</td>` +
      `<td><select class="rt-input pk-boxsel" data-line="${l.id}">${boxOptions(PACK.lineBox[l.id])}</select></td>` +
      `<td class="c"><span class="pk-count ${done ? 'ok' : ''}">${packed} / ${ord}</span></td>` +
      `<td class="r"><button class="pk-mini" data-fill="${l.id}" title="Pack all">all</button>` +
      `<button class="pk-mini" data-minus="${l.id}" title="−1">−</button></td></tr>`;
  }).join('');
}
function updateProgress() {
  const p = totPacked(), t = totOrdered();
  const pct = t ? Math.min(100, Math.round(p / t * 100)) : 0;
  $('pkProgressBar').style.width = pct + '%';
  $('pkProgressTxt').textContent = `${p} / ${t} packed`;
  const auth = $('pkAuthorise');
  if (auth && !PACK.committed) auth.classList.toggle('pk-ready', p >= t && t > 0);
}

// ── cartons ──
function readBoxInputs() {
  document.querySelectorAll('#pkBoxes .pk-dim').forEach(inp => {
    const i = Number(inp.getAttribute('data-i')), f = inp.getAttribute('data-f');
    if (PACK.boxes[i]) PACK.boxes[i][f] = inp.value.trim();
  });
}
function renderBoxes() {
  $('pkBoxes').innerHTML = PACK.boxes.map((b, i) => `
    <div class="pk-box">
      <span class="pk-box-name">${esc(b.name)}</span>
      <input class="rt-input pk-dim" data-i="${i}" data-f="l" value="${esc(b.l)}" placeholder="L" />
      <input class="rt-input pk-dim" data-i="${i}" data-f="w" value="${esc(b.w)}" placeholder="W" />
      <input class="rt-input pk-dim" data-i="${i}" data-f="h" value="${esc(b.h)}" placeholder="H" />
      <input class="rt-input pk-dim pk-dim-wt" data-i="${i}" data-f="weight" value="${esc(b.weight)}" placeholder="kg" />
      ${PACK.boxes.length > 1 ? `<button class="pk-mini pk-boxdel" data-i="${i}" title="Remove">✕</button>` : '<span class="pk-dim-unit">cm</span>'}
    </div>`).join('');
}
function renderCurrentBoxSelect() {
  const sel = $('pkCurrentBox');
  sel.innerHTML = PACK.boxes.map(b => `<option${b.name === PACK.currentBox ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}
function addBox() {
  readBoxInputs();
  PACK.boxes.push({ name: 'Box ' + (PACK.boxes.length + 1), l: '', w: '', h: '', weight: '' });
  renderBoxes(); renderCurrentBoxSelect(); renderLines();
}
function removeBox(i) {
  readBoxInputs();
  PACK.boxes.splice(i, 1);
  PACK.boxes.forEach((b, k) => { b.name = 'Box ' + (k + 1); });
  Object.keys(PACK.lineBox).forEach(id => { if (!PACK.boxes.some(b => b.name === PACK.lineBox[id])) PACK.lineBox[id] = 'Box 1'; });
  if (!PACK.boxes.some(b => b.name === PACK.currentBox)) PACK.currentBox = 'Box 1';
  renderBoxes(); renderCurrentBoxSelect(); renderLines();
}

// ── authorise + slip + booking ──
async function authorise() {
  const it = PACK.sel; if (!it || PACK.committed) return;
  readBoxInputs();
  document.querySelectorAll('.pk-boxsel').forEach(s => { PACK.lineBox[s.getAttribute('data-line')] = s.value; });
  const p = totPacked(), t = totOrdered();
  if (p < t && !confirm(`Only ${p} of ${t} items scanned. Authorise a short pack anyway?`)) return;
  const btn = $('pkAuthorise'), msg = $('pkAuthMsg');
  btn.disabled = true; btn.textContent = 'Authorising…'; msg.textContent = '';
  try {
    await Promise.all(PACK.lines.map(l => api('POST', '/pack/assign', { parcelLineId: l.id, box: PACK.lineBox[l.id] || 'Box 1' })));
    const boxes = PACK.boxes.map(b => ({ name: b.name, length: num(b.l), width: num(b.w), height: num(b.h), weight: num(b.weight) }));
    const r = await api('POST', '/commit/pack', { parcelId: it.parcelId, boxes });
    PACK.committed = true;
    msg.innerHTML = `<span class="pk-ok-msg">✓ Packed${r.alreadyDone ? ' (already done)' : ''} — fulfilment ${esc(r.taskId || '')}.</span>`;
    btn.textContent = '✓ Packed'; btn.classList.remove('pk-ready');
    $('pkPrint').disabled = false; $('pkBook').disabled = false;
    PACK.queue = PACK.queue.filter(x => x.parcelId !== it.parcelId);
    printSlip();
  } catch (e) {
    msg.innerHTML = `<span class="pk-err-msg">✗ ${esc(e.message)}</span>`;
    btn.disabled = false; btn.textContent = '✓ Authorise pack';
  }
}
function printSlip() {
  const it = PACK.sel; if (!it) return;
  readBoxInputs();
  const ship = it.wave.ship_to || {};
  const addr = [ship.Line1 || ship.line1, ship.Line2 || ship.line2, ship.City || ship.city, [ship.State || ship.state, ship.Postcode || ship.postcode].filter(Boolean).join(' ')].filter(Boolean);
  const byBox = {}; PACK.lines.forEach(l => { const b = PACK.lineBox[l.id] || 'Box 1'; (byBox[b] = byBox[b] || []).push(l); });
  const boxesHtml = PACK.boxes.map(b => {
    const dims = [b.l && b.w && b.h ? `${b.l}×${b.w}×${b.h} cm` : '', b.weight ? `${b.weight} kg` : ''].filter(Boolean).join(' · ');
    const rows = (byBox[b.name] || []).map(l => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name || '')}</td><td style="text-align:right">${PACK.packed[l.id] || Number(l.qty_ordered)}</td></tr>`).join('');
    return `<div class="slip-box"><div class="slip-box-h">${esc(b.name)}${dims ? ' — ' + esc(dims) : ''}</div>` +
      `<table class="slip-tbl"><thead><tr><th>SKU</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead><tbody>${rows || '<tr><td colspan="3">—</td></tr>'}</tbody></table></div>`;
  }).join('');
  $('pkSlip').innerHTML = `
    <div class="slip-head"><div><div class="slip-title">PACKING SLIP</div><div class="slip-order">${esc(it.wave.order_number || '')}</div></div><div class="slip-date">${new Date().toLocaleDateString('en-AU')}</div></div>
    <div class="slip-to"><b>${esc(it.wave.customer || '')}</b><br>${addr.map(esc).join('<br>')}</div>
    <div>${boxesHtml}</div>
    <div class="slip-foot">${PACK.boxes.length} carton${PACK.boxes.length !== 1 ? 's' : ''} · Rapid LED</div>`;
  window.print();
}
function sendToBooking() {
  const it = PACK.sel; if (!it) return;
  // TODO: wire to the TMS booking screen (carry SO#, customer, cartons+dims).
  const dims = PACK.boxes.map(b => `${b.name}: ${b.l || '?'}×${b.w || '?'}×${b.h || '?'}cm ${b.weight || '?'}kg`).join('\n');
  alert(`Ready for booking:\n\nOrder ${it.wave.order_number}\n${it.wave.customer || ''}\n${PACK.boxes.length} carton(s)\n${dims}\n\nNext: this hands off to the booking screen in the TMS (connection coming).`);
}

// ═══ events ═══
document.addEventListener('click', e => {
  const row = e.target.closest('[data-parcel]'); if (row) { selectOrder(row.getAttribute('data-parcel')); return; }
  if (e.target.id === 'pkReload') { loadQueue(); return; }
  if (e.target.id === 'pkOrderGo') { openBySearch(); return; }
  if (e.target.id === 'pkBack') { backToOrders(); return; }
  if (e.target.id === 'pkAddBox') { addBox(); return; }
  const del = e.target.closest('.pk-boxdel'); if (del) { removeBox(Number(del.getAttribute('data-i'))); return; }
  const fill = e.target.closest('[data-fill]'); if (fill) { const l = PACK.lines.find(x => String(x.id) === fill.getAttribute('data-fill')); if (l) { PACK.packed[l.id] = Number(l.qty_ordered); PACK.lineBox[l.id] = PACK.currentBox; renderLines(); updateProgress(); } return; }
  const minus = e.target.closest('[data-minus]'); if (minus) { const id = minus.getAttribute('data-minus'); PACK.packed[id] = Math.max(0, (PACK.packed[id] || 0) - 1); renderLines(); updateProgress(); return; }
  if (e.target.id === 'pkAuthorise') { authorise(); return; }
  if (e.target.id === 'pkPrint') { printSlip(); return; }
  if (e.target.id === 'pkBook') { sendToBooking(); return; }
});
document.addEventListener('keydown', e => {
  if (e.target.id === 'pkScan' && e.key === 'Enter') { e.preventDefault(); const v = e.target.value; e.target.value = ''; onScan(v); e.target.focus(); }
  if (e.target.id === 'pkOrderSearch' && e.key === 'Enter') { e.preventDefault(); openBySearch(); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'pkCurrentBox') { PACK.currentBox = e.target.value; }
  if (e.target.classList && e.target.classList.contains('pk-boxsel')) { PACK.lineBox[e.target.getAttribute('data-line')] = e.target.value; }
});

loadQueue();
