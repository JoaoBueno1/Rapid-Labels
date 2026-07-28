// Pack Station (desktop) — Rapid WMS. For packers: pick a PICKED order, scan-verify
// items into cartons, capture box dims, authorise the pack in Cin7 (via the WMS
// outbox — exactly-once), and print our own packing slip. All Cin7 writes go through
// /api/wms/* → the engine → the outbox; this page never touches Cin7 directly.

const API = '/api/wms';
const PACK = {
  queue: [],
  selected: null,                         // { parcelId, waveId, taskId, ref, wave, lines }
  boxes: [{ name: 'Box 1', l: '', w: '', h: '', weight: '' }],
  lineBox: {},                            // parcel_line_id -> box name
  filter: '',
  committed: false
};

function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.error)) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

// ── queue ──
async function loadQueue() {
  const box = $('packQueue');
  box.innerHTML = '<div class="pk-muted">Loading…</div>';
  try {
    PACK.queue = await api('GET', '/pack/ready');
    renderQueue();
  } catch (e) {
    box.innerHTML = `<div class="pk-muted">Couldn't load the pack queue.<br><span class="pk-small">${esc(e.message)}</span><br><span class="pk-small">The WMS API needs the server running the latest code and the <b>wms</b> schema deployed + exposed.</span></div>`;
    $('packCount').textContent = '—';
  }
}
function renderQueue() {
  const box = $('packQueue');
  const q = PACK.filter.toLowerCase();
  const items = PACK.queue.filter(it => !q || String(it.wave.order_number || '').toLowerCase().includes(q) || String(it.wave.customer || '').toLowerCase().includes(q));
  $('packCount').textContent = PACK.queue.length + ' to pack';
  if (!items.length) { box.innerHTML = '<div class="pk-muted">Nothing waiting to pack.</div>'; return; }
  box.innerHTML = items.map(it => {
    const n = (it.lines || []).length;
    const active = PACK.selected && PACK.selected.parcelId === it.parcelId;
    return `<button class="pk-qitem${active ? ' active' : ''}" data-parcel="${it.parcelId}">` +
      `<div class="pk-qorder">${esc(it.wave.order_number || ('parcel ' + it.parcelId))}</div>` +
      `<div class="pk-qcust">${esc(it.wave.customer || '—')}</div>` +
      `<div class="pk-qmeta">${n} line${n !== 1 ? 's' : ''}</div></button>`;
  }).join('');
}

// ── detail ──
function selectOrder(parcelId) {
  const it = PACK.queue.find(x => String(x.parcelId) === String(parcelId));
  if (!it) return;
  PACK.selected = it;
  PACK.boxes = [{ name: 'Box 1', l: '', w: '', h: '', weight: '' }];
  PACK.lineBox = {};
  (it.lines || []).forEach(l => { PACK.lineBox[l.id] = l.box || 'Box 1'; });
  PACK.committed = false;
  renderQueue();
  renderDetail();
}

function boxOptions(sel) {
  return PACK.boxes.map(b => `<option${b.name === sel ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}
function renderDetail() {
  const it = PACK.selected;
  const el = $('packDetail');
  if (!it) { el.innerHTML = '<div class="pk-empty">Select a picked order on the left to pack it.</div>'; return; }
  const ship = it.wave.ship_to || {};
  const addr = [ship.Line1 || ship.line1, ship.City || ship.city, ship.State || ship.state, ship.Postcode || ship.postcode].filter(Boolean).join(', ');

  const linesHtml = (it.lines || []).map(l => {
    const short = Number(l.qty_scanned) < Number(l.qty_ordered);
    return `<tr class="${short ? 'pk-short' : ''}">` +
      `<td class="pk-mono">${esc(l.sku)}</td>` +
      `<td>${esc((l.name || '').slice(0, 60))}</td>` +
      `<td class="pk-num">${Number(l.qty_scanned || 0)} / ${Number(l.qty_ordered)}</td>` +
      `<td><select class="pk-input pk-boxsel" data-line="${l.id}">${boxOptions(PACK.lineBox[l.id])}</select></td></tr>`;
  }).join('');

  const boxesHtml = PACK.boxes.map((b, i) => `
    <div class="pk-box" data-i="${i}">
      <div class="pk-box-name">${esc(b.name)}</div>
      <input class="pk-input pk-dim" data-i="${i}" data-f="l" value="${esc(b.l)}" placeholder="L cm" />
      <input class="pk-input pk-dim" data-i="${i}" data-f="w" value="${esc(b.w)}" placeholder="W cm" />
      <input class="pk-input pk-dim" data-i="${i}" data-f="h" value="${esc(b.h)}" placeholder="H cm" />
      <input class="pk-input pk-dim" data-i="${i}" data-f="weight" value="${esc(b.weight)}" placeholder="kg" />
      ${PACK.boxes.length > 1 ? `<button class="pk-btn pk-btn-ghost pk-boxdel" data-i="${i}" title="Remove box">✕</button>` : ''}
    </div>`).join('');

  el.innerHTML = `
    <div class="pk-card">
      <div class="pk-order-head">
        <div>
          <div class="pk-order-no">${esc(it.wave.order_number || ('parcel ' + it.parcelId))}</div>
          <div class="pk-order-cust">${esc(it.wave.customer || '—')}</div>
          ${addr ? `<div class="pk-order-addr">${esc(addr)}</div>` : ''}
        </div>
        <div class="pk-order-task pk-small">Fulfilment ${esc(it.taskId || '')}</div>
      </div>

      <div class="pk-section-title">Items</div>
      <table class="pk-table">
        <thead><tr><th>SKU</th><th>Item</th><th class="pk-num">Qty</th><th>Carton</th></tr></thead>
        <tbody>${linesHtml || '<tr><td colspan="4" class="pk-muted">No lines.</td></tr>'}</tbody>
      </table>

      <div class="pk-section-title">Cartons &amp; dimensions</div>
      <div id="packBoxes">${boxesHtml}</div>
      <button id="packAddBox" class="pk-btn pk-btn-sm">+ Add carton</button>

      <div class="pk-actions">
        <div id="packMsg" class="pk-msg"></div>
        <button id="packPrint" class="pk-btn">🖨 Print slip</button>
        <button id="packCommit" class="pk-btn pk-btn-primary">✓ Authorise pack</button>
      </div>
      <div class="pk-small pk-note">Authorising writes the pack to Cin7 once (via the WMS outbox). Dimensions are also kept in our system for the shipping slip.</div>
    </div>`;
}

// ── box editing ──
function readBoxInputs() {
  document.querySelectorAll('#packBoxes .pk-dim').forEach(inp => {
    const i = Number(inp.getAttribute('data-i')), f = inp.getAttribute('data-f');
    if (PACK.boxes[i]) PACK.boxes[i][f] = inp.value.trim();
  });
}
function addBox() { readBoxInputs(); PACK.boxes.push({ name: 'Box ' + (PACK.boxes.length + 1), l: '', w: '', h: '', weight: '' }); renderDetail(); }
function removeBox(i) {
  readBoxInputs();
  const removed = PACK.boxes[i] ? PACK.boxes[i].name : null;
  PACK.boxes.splice(i, 1);
  PACK.boxes.forEach((b, k) => { b.name = 'Box ' + (k + 1); });   // renumber
  // reassign any line that pointed at the removed/renumbered box to Box 1
  Object.keys(PACK.lineBox).forEach(id => { if (!PACK.boxes.some(b => b.name === PACK.lineBox[id])) PACK.lineBox[id] = 'Box 1'; });
  renderDetail();
}

// ── commit ──
async function authorisePack() {
  const it = PACK.selected; if (!it) return;
  readBoxInputs();
  // read line→box from the selects
  document.querySelectorAll('.pk-boxsel').forEach(s => { PACK.lineBox[s.getAttribute('data-line')] = s.value; });
  const btn = $('packCommit'); const msg = $('packMsg');
  btn.disabled = true; btn.textContent = 'Authorising…'; msg.textContent = '';
  try {
    // persist each line's carton, then commit the pack
    await Promise.all((it.lines || []).map(l => api('POST', '/pack/assign', { parcelLineId: l.id, box: PACK.lineBox[l.id] || 'Box 1' })));
    const boxes = PACK.boxes.map(b => ({ name: b.name, length: num(b.l), width: num(b.w), height: num(b.h), weight: num(b.weight) }));
    const r = await api('POST', '/commit/pack', { parcelId: it.parcelId, boxes });
    PACK.committed = true;
    msg.innerHTML = `<span class="pk-ok">✓ Packed${r.alreadyDone ? ' (already done)' : ''}. Fulfilment ${esc(r.taskId || '')}.</span>`;
    btn.textContent = '✓ Packed';
    // drop it from the queue
    PACK.queue = PACK.queue.filter(x => x.parcelId !== it.parcelId);
    renderQueue();
    printSlip();   // auto-open the slip after a successful pack
  } catch (e) {
    msg.innerHTML = `<span class="pk-err">✗ ${esc(e.message)}</span>`;
    btn.disabled = false; btn.textContent = '✓ Authorise pack';
  }
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

// ── packing slip (print) ──
function printSlip() {
  const it = PACK.selected; if (!it) return;
  readBoxInputs();
  const ship = it.wave.ship_to || {};
  const addr = [ship.Line1 || ship.line1, ship.Line2 || ship.line2, ship.City || ship.city, [ship.State || ship.state, ship.Postcode || ship.postcode].filter(Boolean).join(' ')].filter(Boolean);
  const lineBy = {}; (it.lines || []).forEach(l => { const b = PACK.lineBox[l.id] || 'Box 1'; (lineBy[b] = lineBy[b] || []).push(l); });
  const boxesHtml = PACK.boxes.map(b => {
    const dims = [b.l && b.w && b.h ? `${b.l}×${b.w}×${b.h} cm` : '', b.weight ? `${b.weight} kg` : ''].filter(Boolean).join(' · ');
    const rows = (lineBy[b.name] || []).map(l => `<tr><td>${esc(l.sku)}</td><td>${esc(l.name || '')}</td><td style="text-align:right">${Number(l.qty_scanned || l.qty_ordered)}</td></tr>`).join('');
    return `<div class="slip-box"><div class="slip-box-h">${esc(b.name)}${dims ? ' — ' + esc(dims) : ''}</div>` +
      `<table class="slip-tbl"><thead><tr><th>SKU</th><th>Item</th><th style="text-align:right">Qty</th></tr></thead><tbody>${rows || '<tr><td colspan="3">—</td></tr>'}</tbody></table></div>`;
  }).join('');
  $('packSlip').innerHTML = `
    <div class="slip-head">
      <div><div class="slip-title">PACKING SLIP</div><div class="slip-order">${esc(it.wave.order_number || '')}</div></div>
      <div class="slip-date">${new Date().toLocaleDateString('en-AU')}</div>
    </div>
    <div class="slip-to"><b>${esc(it.wave.customer || '')}</b><br>${addr.map(esc).join('<br>')}</div>
    <div class="slip-boxes">${boxesHtml}</div>
    <div class="slip-foot">${PACK.boxes.length} carton${PACK.boxes.length !== 1 ? 's' : ''} · Rapid LED</div>`;
  window.print();
}

// ── events ──
document.addEventListener('click', e => {
  const q = e.target.closest('.pk-qitem'); if (q) { selectOrder(q.getAttribute('data-parcel')); return; }
  if (e.target.id === 'packReload') { loadQueue(); return; }
  if (e.target.id === 'packAddBox') { addBox(); return; }
  const del = e.target.closest('.pk-boxdel'); if (del) { removeBox(Number(del.getAttribute('data-i'))); return; }
  if (e.target.id === 'packCommit') { authorisePack(); return; }
  if (e.target.id === 'packPrint') { printSlip(); return; }
});
document.addEventListener('input', e => {
  if (e.target.id === 'packSearch') { PACK.filter = e.target.value || ''; renderQueue(); }
});

loadQueue();
