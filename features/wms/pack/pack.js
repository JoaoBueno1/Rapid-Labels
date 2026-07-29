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

// ═══ landing: open a typed/scanned sales order ═══
async function openOrder() {
  const on = ($('pkOrderSearch').value || '').trim();
  if (!on) return;
  const msg = $('pkOpenMsg'), btn = $('pkOrderGo');
  msg.className = 'pk-openmsg'; msg.textContent = 'Opening ' + on + '…'; btn.disabled = true;
  try {
    const sel = await api('POST', '/pack/open', { orderNumber: on });   // reads Cin7, builds our wave (no Cin7 write)
    msg.textContent = '';
    await openWorkspace(sel);
  } catch (e) {
    msg.className = 'pk-openmsg err'; msg.textContent = '✗ ' + e.message;
  } finally { btn.disabled = false; }
}

// ═══ workspace ═══
async function openWorkspace(sel) {
  PACK.sel = sel;
  PACK.lines = (sel.lines || []).slice();
  PACK.packed = {}; PACK.lineBox = {};
  PACK.boxes = [{ name: 'Box 1', l: '', w: '', h: '', weight: '' }];
  PACK.currentBox = 'Box 1';
  PACK.committed = false;
  PACK.lines.forEach(l => { PACK.packed[l.id] = 0; PACK.lineBox[l.id] = 'Box 1'; });

  // pre-fetch product barcodes for instant client-side scan resolution
  PACK.barcodeMap = {}; PACK.skuByUpper = {};
  PACK.lines.forEach(l => { PACK.skuByUpper[String(l.sku).toUpperCase()] = l.sku; });
  try {
    const sb = await sbClient();
    if (sb) {
      const skus = [...new Set(PACK.lines.map(l => l.sku).filter(Boolean))];
      if (skus.length) { const { data } = await sb.schema('cin7_mirror').from('products').select('sku,barcode').in('sku', skus); (data || []).forEach(p => { if (p.barcode && !/^0+$/.test(String(p.barcode))) PACK.barcodeMap[String(p.barcode).trim()] = p.sku; }); }
    }
  } catch (_) {}

  $('pkLanding').style.display = 'none';
  $('pkWorkspace').style.display = '';
  $('pkWsNo').textContent = sel.wave.order_number || '';
  $('pkWsCust').textContent = sel.wave.customer || '';
  const auth = $('pkAuthorise');
  auth.textContent = sel.picked ? '✓ Authorise pack' : '✓ Pick & pack';   // un-picked orders get picked+packed together
  renderBoxes(); renderCurrentBoxSelect(); renderLines(); updateProgress();
  setTimeout(() => { const s = $('pkScan'); if (s) s.focus(); }, 60);
}
function backToOrders() {
  $('pkWorkspace').style.display = 'none';
  $('pkLanding').style.display = '';
  const s = $('pkOrderSearch'); if (s) { s.value = ''; s.focus(); }
  const m = $('pkOpenMsg'); if (m) m.textContent = '';
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
  if (p === 0) { alert('Scan at least one item before authorising.'); return; }
  if (p < t && !confirm(`Only ${p} of ${t} items scanned. Authorise a short pack anyway?`)) return;
  if (!it.picked && !confirm(`${it.wave.order_number} isn't picked in our WMS yet.\n\nAuthorising will PICK it (from Main Warehouse) AND PACK it in Cin7 — one clean write each (safe to retry). Use this for orders not yet picked elsewhere.\n\nContinue?`)) return;
  const btn = $('pkAuthorise'), msg = $('pkAuthMsg');
  btn.disabled = true; msg.textContent = '';
  try {
    // 1) not picked in our WMS → record the scanned qtys (from Main Warehouse root) and pick first
    if (!it.picked) {
      btn.textContent = 'Picking…';
      const scanned = PACK.lines.filter(l => (PACK.packed[l.id] || 0) > 0);
      for (const l of scanned) await api('POST', '/scan', { parcelLineId: l.id, binCode: '', qty: PACK.packed[l.id], sku: l.sku });
      await api('POST', '/commit/pick', { parcelId: it.parcelId });
      it.picked = true;
    }
    // 2) assign cartons + pack
    btn.textContent = 'Packing…';
    await Promise.all(PACK.lines.map(l => api('POST', '/pack/assign', { parcelLineId: l.id, box: PACK.lineBox[l.id] || 'Box 1' })));
    const boxes = PACK.boxes.map(b => ({ name: b.name, length: num(b.l), width: num(b.w), height: num(b.h), weight: num(b.weight) }));
    const r = await api('POST', '/commit/pack', { parcelId: it.parcelId, boxes });
    PACK.committed = true;
    msg.innerHTML = `<span class="pk-ok-msg">✓ Packed${r.alreadyDone ? ' (already done)' : ''} — fulfilment ${esc(r.taskId || '')}.</span>`;
    btn.textContent = '✓ Packed'; btn.classList.remove('pk-ready');
    $('pkPrint').disabled = false; $('pkBook').disabled = false;
    printSlip();
  } catch (e) {
    msg.innerHTML = `<span class="pk-err-msg">✗ ${esc(e.message)}</span>`;
    btn.disabled = false; btn.textContent = it.picked ? '✓ Authorise pack' : '✓ Pick & pack';
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
// The TMS base URL for the booking deep-link. Override per-site via
// localStorage.rapidExpressWebBaseUrl; defaults to the production TMS.
function tmsBase() {
  try {
    const v = (localStorage.getItem('rapidExpressWebBaseUrl') || '').trim().replace(/\/+$/, '');
    return v || 'https://www.rapidexpress.com.au';
  } catch (e) { return 'https://www.rapidexpress.com.au'; }
}
// Persist the packed carton dims (best-effort — needs the 003 boxes column). The
// deep-link works without this; it just makes the dims queryable server-side too.
function saveBoxes() {
  const it = PACK.sel; if (!it) return;
  readBoxInputs();
  const boxes = PACK.boxes.map(b => ({ name: b.name, length: num(b.l), width: num(b.w), height: num(b.h), weight: num(b.weight) }));
  api('POST', '/pack/boxes', { parcelId: it.parcelId, boxes }).catch(() => {});
}
// Hand off to the TMS Book Order screen: ?ref=<SO> makes the TMS fill customer/address
// from Cin7 (its existing lookup), and ?parcels=<json> pre-fills the packed cartons. The
// operator then rate-shops + picks a carrier IN the TMS (its quote/validation stay the
// source of truth). Opens a new tab where the operator is already logged into the TMS.
function sendToBooking() {
  const it = PACK.sel; if (!it) return;
  readBoxInputs();
  saveBoxes();
  const parcels = PACK.boxes.map(b => ({
    type: 'carton', quantity: 1,
    length: num(b.l), width: num(b.w), height: num(b.h), weight: num(b.weight),
  }));
  const url = tmsBase() + '/book-order?use_flask=1'
    + '&ref=' + encodeURIComponent(it.wave.order_number || '')
    + '&parcels=' + encodeURIComponent(JSON.stringify(parcels))
    + '&src=wms-pack';
  window.open(url, '_blank', 'noopener');
}

// ═══ events ═══
document.addEventListener('click', e => {
  if (e.target.id === 'pkOrderGo') { openOrder(); return; }
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
  if (e.target.id === 'pkOrderSearch' && e.key === 'Enter') { e.preventDefault(); openOrder(); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'pkCurrentBox') { PACK.currentBox = e.target.value; }
  if (e.target.classList && e.target.classList.contains('pk-boxsel')) { PACK.lineBox[e.target.getAttribute('data-line')] = e.target.value; }
});

setTimeout(() => { const s = $('pkOrderSearch'); if (s) s.focus(); }, 50);
