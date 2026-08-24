/* ══════════════════════════════════════════════════════════════════════
   Gateway Inventory — front end.

   Talks only to /api/gateway/*. Nothing here computes a balance: every
   quantity on screen is what the ledger says, so the screen and the audit
   trail can never disagree.

   The word "lot" does not appear in the interface. A lot is a pallet that
   arrived on a date, so the screen says "arrived" and "pallet" and lets the
   database keep the vocabulary.
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const state = {
  view: 'overview',
  user: localStorage.getItem('gatewayUser') || '',
  inv:  { q: '', filter: 'in_stock', sort: 'oldest', offset: 0, limit: 100, total: 0 },
  tr:   { q: '', status: '', rows: [] },
  ov:   { weeks: 4, cov: 'all', rows: [], selected: new Set() },
  recon:{ state: '', rows: [] },
  qual: { batches: [], issues: [], severity: '' },
  caps: {},
  settings: {},
  openTransfer: null,
};

// ─── plumbing ──────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`/api/gateway${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-gw-user': state.user || 'unknown',
      ...(opts.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok || !body || body.success === false) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.payload = body;
    throw err;
  }
  return body.data;
}

const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const nfmt = (v, dp = 0) => v == null || v === '' || isNaN(Number(v))
  ? '—'
  : Number(v).toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Brisbane is where the warehouse is; render dates there and nowhere else. */
function dfmt(d) {
  if (!d) return null;
  const dt = new Date(d.length === 10 ? `${d}T00:00:00+10:00` : d);
  if (isNaN(dt)) return null;
  return dt.toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane',
  });
}
function dtfmt(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'Australia/Brisbane',
  });
}

function ageClass(days) {
  if (days == null) return 'age-unknown';
  const warn  = Number(state.settings.age_warn_days  || 60);
  const alert = Number(state.settings.age_alert_days || 120);
  return days >= alert ? 'age-alert' : days >= warn ? 'age-warn' : 'age-fresh';
}
const ageCell = d => d == null
  ? '<span class="age-unknown">unknown</span>'
  : `<span class="${ageClass(d)}">${nfmt(d)}d</span>`;

function diffCell(v) {
  const n = Number(v || 0);
  if (!n) return '<span class="var-zero">0</span>';
  return `<span class="${n > 0 ? 'var-pos' : 'var-neg'}">${n > 0 ? '+' : ''}${nfmt(n)}</span>`;
}

const STATUS_TAG = {
  draft: 'tag-grey', ready_for_cin7: 'tag-amber', cin7_created: 'tag-cyan',
  picking: 'tag-blue', dispatched: 'tag-blue', completed: 'tag-green', cancelled: 'tag-grey',
};
const STATUS_LABEL = {
  draft: 'Draft', ready_for_cin7: 'Ready for Cin7', cin7_created: 'In Cin7',
  picking: 'Picking', dispatched: 'Dispatched', completed: 'Completed', cancelled: 'Cancelled',
};
const statusTag = s => `<span class="tag ${STATUS_TAG[s] || 'tag-grey'}">${esc(STATUS_LABEL[s] || s)}</span>`;
const dirLabel  = d => d === 'main_to_gateway' ? 'Main &rarr; Gateway' : 'Gateway &rarr; Main';

const STATE_TAG = {
  match: ['tag-green', 'Match'], mismatch: ['tag-amber', 'Mismatch'],
  local_only: ['tag-red', 'Only ours'], cin7_only: ['tag-blue', 'Only Cin7'],
};
const stateTag = s => {
  const [c, l] = STATE_TAG[s] || ['tag-grey', s];
  return `<span class="tag ${c}">${esc(l)}</span>`;
};

let toastTimer;
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `gw-toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'gw-toast'; }, bad ? 6500 : 3200);
}
const fail = e => { console.error(e); toast(e.message || 'Something went wrong', true); };
const empty = (n, msg) => `<tr><td colspan="${n}" class="gw-empty">${esc(msg)}</td></tr>`;

// ─── modal ─────────────────────────────────────────────────────────────
function modal(title, bodyHtml, buttons) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  const foot = $('modalFoot');
  foot.innerHTML = '';
  (buttons || []).forEach(b => {
    const btn = el('button', `gw-btn ${b.cls || ''}`, esc(b.label));
    btn.onclick = async () => {
      if (!b.onClick) return closeModal();
      btn.disabled = true;
      try { await b.onClick(); } catch (e) { fail(e); } finally { btn.disabled = false; }
    };
    foot.appendChild(btn);
  });
  $('modalBack').classList.add('open');
  const first = $('modalBody').querySelector('input,select,textarea');
  if (first) setTimeout(() => first.focus(), 40);
}
const closeModal = () => $('modalBack').classList.remove('open');
$('modalBack').addEventListener('click', e => { if (e.target.id === 'modalBack') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if ($('modalBack').classList.contains('open')) return closeModal();
  if ($('drawer').classList.contains('open')) closeDrawer();
});

// ─── drawer ────────────────────────────────────────────────────────────
function openDrawer(title, sub) {
  $('drTitle').innerHTML = title;
  $('drSub').innerHTML = sub || '';
  $('drBody').innerHTML = '<div class="gw-empty"><span class="gw-spinner"></span></div>';
  $('drawer').classList.add('open');
  $('drawerBack').classList.add('open');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawerBack').classList.remove('open');
  state.openTransfer = null;
}
$('drClose').onclick = closeDrawer;
$('drawerBack').onclick = closeDrawer;

// ─── boot ──────────────────────────────────────────────────────────────
async function boot() {
  if (!state.user) {
    const who = prompt('Your name (recorded against everything you do here):', '');
    state.user = (who || '').trim() || 'unknown';
    localStorage.setItem('gatewayUser', state.user);
  }
  $('whoami').textContent = state.user;

  document.querySelectorAll('.gw-tab').forEach(t => {
    t.onclick = () => switchView(t.dataset.view);
  });

  try {
    state.caps = (await api('/capabilities')).capabilities || {};
  } catch { /* engine may not be up; the views will report it */ }

  wireOverview(); wireInventory(); wireTransfers(); wireRecon(); wireQuality();
  await loadOverview();
}

function switchView(v) {
  state.view = v;
  document.querySelectorAll('.gw-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.gw-view').forEach(s => {
    s.style.display = s.id === `view-${v}` ? '' : 'none';
  });
  ({ overview: loadOverview, inventory: loadInventory, transfers: loadTransfers,
     recon: loadRecon, quality: loadQuality }[v] || (() => {}))();
}

// ═══════════ OVERVIEW ═══════════
function wireOverview() {
  $('ovWeeks').onchange = e => { state.ov.weeks = Number(e.target.value); loadRestock(); };
  document.querySelectorAll('#view-overview .gw-chip[data-cov]').forEach(c => {
    c.onclick = () => {
      state.ov.cov = c.dataset.cov;
      document.querySelectorAll('#view-overview .gw-chip[data-cov]').forEach(x => x.classList.toggle('active', x === c));
      renderRestock();
    };
  });
  $('ovAll').onchange = e => {
    document.querySelectorAll('.ov-cb').forEach(cb => { cb.checked = e.target.checked; toggleOv(cb); });
  };
  $('ovBuild').onclick = buildTransferFromRestock;
}

async function loadOverview() {
  let s;
  try {
    s = await api('/summary');
  } catch (e) {
    if (e.status === 503) $('deployWarning').style.display = '';
    return fail(e);
  }
  $('deployWarning').style.display = 'none';
  state.settings = s.settings || {};

  const synced = s.cin7_synced_at ? new Date(s.cin7_synced_at) : null;
  const ageMin = synced ? Math.round((Date.now() - synced) / 60000) : null;
  $('syncDot').className = 'gw-dot ' + (ageMin == null ? 'dead' : ageMin < 120 ? 'fresh' : ageMin < 480 ? 'stale' : 'dead');
  $('syncText').textContent = synced
    ? `Cin7 stock synced ${ageMin < 90 ? `${ageMin} min` : `${Math.round(ageMin / 60)} h`} ago`
    : 'Cin7 sync unknown';

  // Slim KPIs — only what helps decide
  const tiles = [
    ['Products in Gateway', nfmt(s.products),      'holding stock',            ''],
    ['Units',               nfmt(s.units),         'total in Gateway',         ''],
    ['Open transfers',      nfmt(s.open_transfers),'in progress',              s.open_transfers > 0 ? 'warn' : ''],
    ['Reserved',            nfmt(s.reserved),      'held by open transfers',   s.reserved > 0 ? 'warn' : ''],
  ];
  $('tiles').innerHTML = tiles.map(([l, v, sub, cls]) => `
    <div class="gw-tile ${cls}">
      <div class="gw-tile-label">${esc(l)}</div>
      <div class="gw-tile-value">${v}</div>
      <div class="gw-tile-sub">${esc(sub)}</div>
    </div>`).join('');

  const badge = (id, n, cls) => {
    const b = $(id);
    if (!b) return;
    b.textContent = nfmt(n);
    b.className = `badge${n > 0 && cls ? ` ${cls}` : ''}`;
  };
  badge('tabTransfers', s.open_transfers, '');
  badge('tabRecon', s.discrepancies, 'warn');
  badge('tabQuality', s.open_import_issues, 'warn');

  await Promise.all([loadRestock(), loadOverviewTransfers()]);
}

// ── Restock: what Main is low on and Gateway can supply ──
async function loadRestock() {
  let d;
  try { d = await api(`/recommendations?weeks=${state.ov.weeks}&limit=500`); } catch (e) { return fail(e); }
  state.ov.rows = d.rows || [];
  state.ov.counts = d.counts || { lt2: 0, lt4: 0, lt6: 0 };
  state.ov.selected.clear();
  $('ovBuild').disabled = true;
  $('covAll').textContent = nfmt((d.rows || []).length);
  $('covLt2').textContent = nfmt(state.ov.counts.lt2);
  $('covLt4').textContent = nfmt(state.ov.counts.lt4);
  $('covLt6').textContent = nfmt(state.ov.counts.lt6);
  renderRestock();
}

function renderRestock() {
  const cov = state.ov.cov;
  const rows = state.ov.rows.filter(r => {
    if (cov === 'all') return true;
    if (cov === 'lt2') return r.weeks_cover < 2;
    if (cov === 'lt4') return r.weeks_cover < 4;
    if (cov === 'lt6') return r.weeks_cover < 6;
    return true;
  });
  const covClass = w => w < 2 ? 'var-neg' : w < 4 ? 'age-warn' : '';
  $('ovRestock').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td class="c"><input type="checkbox" class="ov-cb" data-sku="${esc(r.sku)}" data-qty="${r.recommended_qty}" /></td>
      <td class="mono clickable" onclick="showSku('${esc(r.sku)}')">${esc(r.sku)}</td>
      <td>${esc(r.product_name || '—')}</td>
      <td class="r num">${nfmt(r.main_qty)}</td>
      <td class="r num gw-sub">${nfmt(r.weekly_demand, 1)}</td>
      <td class="r num ${covClass(r.weeks_cover)}"><b>${nfmt(r.weeks_cover, 1)}</b> wk</td>
      <td class="r num"><b>${nfmt(r.recommended_qty)}</b>${r.capped_by_gateway ? ' <span class="tag tag-amber">capped</span>' : ''}</td>
      <td class="r num">${nfmt(r.gateway_available)}</td>
      <td>${r.oldest_received_on ? esc(dfmt(r.oldest_received_on)) : '<span class="age-unknown">no date</span>'}</td>
      <td class="gw-sub">${esc(r.shelves || '—')}</td>
    </tr>`).join('') : empty(10, 'Nothing to suggest — Main is covered at the chosen target');
  document.querySelectorAll('.ov-cb').forEach(cb => { cb.onchange = () => toggleOv(cb); });
  $('ovAll').checked = false;
}

function toggleOv(cb) {
  if (cb.checked) state.ov.selected.add(cb.dataset.sku);
  else state.ov.selected.delete(cb.dataset.sku);
  const n = state.ov.selected.size;
  $('ovBuild').disabled = n === 0;
  $('ovBuild').textContent = n ? `Create transfer from ${n} product(s)` : 'Create transfer from selected';
}

async function buildTransferFromRestock() {
  const picks = [...document.querySelectorAll('.ov-cb')].filter(c => c.checked)
    .map(c => ({ sku: c.dataset.sku, qty: Number(c.dataset.qty) }));
  if (!picks.length) return;
  try {
    const t = await api('/transfers', { method: 'POST', body: JSON.stringify({
      direction: 'gateway_to_main', reference: `Restock ${state.ov.weeks}wk`,
      notes: `Built from restock (target ${state.ov.weeks} weeks of cover)`,
    }) });
    // Lines start with allocation PENDING (allocate:false) — you allocate the
    // shelves as the driver actually pulled them, with a FIFO suggestion.
    for (const p of picks) {
      await api(`/transfers/${t.id}/lines`, { method: 'POST', body: JSON.stringify({
        sku: p.sku, qty_requested: p.qty, source: 'recommendation', allocate: false,
      }) });
    }
    toast(`${t.transfer_no} created with ${picks.length} product(s) — allocate the shelves`);
    switchView('transfers'); showTransfer(t.id);
  } catch (e) { fail(e); }
}

// ── Overview transfers: open + recent history ──
async function loadOverviewTransfers() {
  try {
    const [open, hist] = await Promise.all([
      api('/transfers?status=draft,ready_for_cin7,cin7_created,picking,dispatched&limit=25'),
      api('/transfers?status=completed&limit=8'),
    ]);
    $('ovOpenTr').innerHTML = (open.rows || []).length ? open.rows.map(t => `
      <tr class="clickable" onclick="showTransfer(${t.id})">
        <td class="mono">${esc(t.transfer_no)}</td>
        <td>${statusTag(t.status)}</td>
        <td>${Number(t.qty_allocated) < Number(t.qty_requested)
          ? `<span class="tag tag-amber">${nfmt(t.qty_allocated)}/${nfmt(t.qty_requested)}</span>`
          : '<span class="tag tag-green">full</span>'}</td>
        <td class="r num">${nfmt(t.line_count)}</td>
        <td class="r num">${nfmt(t.qty_requested)}</td>
        <td class="gw-sub">${esc(dtfmt(t.created_at))}</td></tr>`).join('')
      : empty(6, 'No open transfers');
    $('ovHistTr').innerHTML = (hist.rows || []).length ? hist.rows.map(t => `
      <tr class="clickable" onclick="showTransfer(${t.id})">
        <td class="mono">${esc(t.transfer_no)}</td>
        <td class="mono gw-sub">${esc(t.cin7_reference || '—')}</td>
        <td class="r num">${nfmt(t.qty_moved)}</td>
        <td class="gw-sub">${esc(dtfmt(t.completed_at))}</td></tr>`).join('')
      : empty(4, 'No completed transfers yet');
  } catch (e) { fail(e); }
}

// ═══════════ INVENTORY ═══════════
function wireInventory() {
  let t;
  $('invSearch').oninput = e => {
    clearTimeout(t);
    t = setTimeout(() => { state.inv.q = e.target.value.trim(); state.inv.offset = 0; loadInventory(); }, 280);
  };
  $('invFilter').onchange = e => { state.inv.filter = e.target.value; state.inv.offset = 0; loadInventory(); };
  $('invSort').onchange   = e => { state.inv.sort = e.target.value;   state.inv.offset = 0; loadInventory(); };
  $('invPrev').onclick = () => { state.inv.offset = Math.max(0, state.inv.offset - state.inv.limit); loadInventory(); };
  $('invNext').onclick = () => {
    if (state.inv.offset + state.inv.limit < state.inv.total) { state.inv.offset += state.inv.limit; loadInventory(); }
  };
  $('invReceive').onclick = () => receiveModal();
}

async function loadInventory() {
  const i = state.inv;
  const qs = new URLSearchParams({ q: i.q, filter: i.filter, sort: i.sort, limit: i.limit, offset: i.offset });
  let d;
  try { d = await api(`/inventory?${qs}`); } catch (e) { return fail(e); }
  i.total = d.total;

  $('invBody').innerHTML = d.rows.length ? d.rows.map(r => `
    <tr class="clickable" onclick="showSku('${esc(r.sku)}')">
      <td class="mono">${esc(r.sku)}</td>
      <td>${esc(r.product_name || '—')}</td>
      <td class="mono gw-sub">${esc(r.five_dc || '—')}</td>
      <td class="r num">${nfmt(r.local_qty)}</td>
      <td class="r num">${Number(r.qty_reserved) ? nfmt(r.qty_reserved) : '—'}</td>
      <td class="r num">${nfmt(r.qty_available)}</td>
      <td>${r.oldest_received_on ? esc(dfmt(r.oldest_received_on))
            : `<span class="age-unknown">unknown${r.undated_lots > 1 ? ` (${r.undated_lots})` : ''}</span>`}</td>
      <td class="r">${ageCell(r.oldest_age_days)}</td>
      <td class="r num">${nfmt(r.cin7_qty)}</td>
      <td class="r num">${diffCell(r.difference)}</td>
      <td class="gw-sub">${esc(r.shelves || '—')}</td>
    </tr>`).join('') : empty(11, 'Nothing matches those filters');

  $('invCount').textContent = `${nfmt(d.total)} products`;
  $('invPage').textContent = d.total
    ? `${nfmt(i.offset + 1)}–${nfmt(Math.min(i.offset + i.limit, d.total))} of ${nfmt(d.total)}`
    : '';
  $('invPrev').disabled = i.offset === 0;
  $('invNext').disabled = i.offset + i.limit >= d.total;
}

// ─── SKU detail ────────────────────────────────────────────────────────
async function showSku(sku) {
  openDrawer(esc(sku), '');
  let d;
  try { d = await api(`/inventory/${encodeURIComponent(sku)}`); } catch (e) { closeDrawer(); return fail(e); }

  const b = d.balance || {};
  $('drSub').innerHTML = esc(b.product_name || '') +
    (b.five_dc ? ` <span class="gw-sub">· 5DC ${esc(b.five_dc)}</span>` : '');

  const diff = Number(b.difference || 0);
  const MOVE_LABEL = {
    RECEIPT: 'Arrived', TRANSFER_OUT: 'Sent to Main', TRANSFER_OUT_REVERSAL: 'Returned from Main',
    ADJUSTMENT_IN: 'Adjustment in', ADJUSTMENT_OUT: 'Adjustment out',
    STOCKTAKE_ADJUSTMENT: 'Stocktake', WRITE_OFF: 'Written off', CORRECTION: 'Correction',
  };

  $('drBody').innerHTML = `
    <div class="gw-tiles">
      <div class="gw-tile"><div class="gw-tile-label">On hand</div>
        <div class="gw-tile-value">${nfmt(b.local_qty)}</div>
        <div class="gw-tile-sub">${nfmt(b.open_lots)} pallet(s)</div></div>
      <div class="gw-tile"><div class="gw-tile-label">Available</div>
        <div class="gw-tile-value">${nfmt(b.qty_available)}</div>
        <div class="gw-tile-sub">${nfmt(b.qty_reserved || 0)} reserved</div></div>
      <div class="gw-tile"><div class="gw-tile-label">Cin7</div>
        <div class="gw-tile-value">${nfmt(d.cin7.on_hand)}</div>
        <div class="gw-tile-sub">${d.cin7.synced_at ? esc(dtfmt(d.cin7.synced_at)) : 'not synced'}</div></div>
      <div class="gw-tile ${diff ? 'warn' : 'good'}"><div class="gw-tile-label">Difference</div>
        <div class="gw-tile-value">${diff > 0 ? '+' : ''}${nfmt(diff)}</div>
        <div class="gw-tile-sub">${diff ? 'Cin7 minus ours' : 'agrees'}</div></div>
    </div>

    <div class="gw-sec">
      <div class="gw-sec-hd"><span class="gw-sec-title">Stock to pick, oldest first</span>
        <span class="gw-sec-hint">this is the order FIFO will use</span></div>
      <div class="gw-table-wrap"><table class="gw-table">
        <thead><tr><th class="c">#</th><th>Arrived</th><th class="r">Age</th><th>Shelf</th><th>Pallet</th>
          <th class="r">Arrived qty</th><th class="r">Left</th><th class="r">Reserved</th>
          <th class="r">Free</th><th>Reference</th><th></th></tr></thead>
        <tbody>${d.lots.filter(l => Number(l.qty_remaining) > 0).length ? d.lots
          .filter(l => Number(l.qty_remaining) > 0)
          .map((l, idx) => `
          <tr>
            <td class="c num">${idx + 1}</td>
            <td>${l.received_on ? esc(dfmt(l.received_on)) : '<span class="age-unknown">unknown</span>'}</td>
            <td class="r">${ageCell(l.age_days)}</td>
            <td class="mono">${esc(l.shelf_id || l.shelf_text || '—')}</td>
            <td class="mono gw-sub">${esc(l.pallet_number || '—')}</td>
            <td class="r num gw-sub">${nfmt(l.qty_received)}</td>
            <td class="r num">${nfmt(l.qty_remaining)}</td>
            <td class="r num">${Number(l.qty_reserved) ? nfmt(l.qty_reserved) : '—'}</td>
            <td class="r num">${nfmt(l.qty_available)}</td>
            <td class="mono gw-sub">${esc(l.source_reference || '—')}</td>
            <td class="r"><button class="gw-btn gw-btn-sm" onclick="adjustModal(${l.id}, '${esc(sku)}', ${l.qty_remaining})">Adjust</button></td>
          </tr>`).join('') : empty(11, 'No stock on hand')}</tbody>
      </table></div>
    </div>

    <div class="gw-sec">
      <div class="gw-sec-hd"><span class="gw-sec-title">Everything that happened</span>
        <span class="gw-sec-hint">newest first — this is why the number above is what it is</span></div>
      <div class="gw-table-wrap"><table class="gw-table">
        <thead><tr><th>When</th><th>What</th><th class="r">Qty</th><th class="r">Balance after</th>
          <th>Shelf</th><th>Reference</th><th>Recorded</th><th>By</th></tr></thead>
        <tbody>${d.movements.length ? d.movements.map(m => `
          <tr>
            <td>${esc(dtfmt(m.occurred_at))}</td>
            <td>${esc(MOVE_LABEL[m.movement_type] || m.movement_type)}
                ${m.reason ? `<div class="gw-sub">${esc(m.reason)}</div>` : ''}</td>
            <td class="r num ${Number(m.qty) > 0 ? 'var-pos' : 'var-neg'}">${Number(m.qty) > 0 ? '+' : ''}${nfmt(m.qty)}</td>
            <td class="r num">${nfmt(m.qty_after)}</td>
            <td class="mono gw-sub">${esc(m.shelf_id || '—')}</td>
            <td class="mono gw-sub">${esc(m.source_reference || '—')}</td>
            <td class="gw-sub">${esc(dtfmt(m.recorded_at))}${m.source_system === 'excel_migration' ? ' <span class="tag tag-grey">migrated</span>' : ''}</td>
            <td class="gw-sub">${esc(m.created_by || '—')}</td>
          </tr>`).join('') : empty(8, 'No movements recorded')}</tbody>
      </table></div>
    </div>`;
}

// ─── receive / adjust ──────────────────────────────────────────────────
function receiveModal() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  modal('Record stock arriving at Gateway', `
    <div class="gw-field"><label>SKU</label>
      <input class="gw-input" id="rcSku" placeholder="e.g. R6052-WH-TRI" />
      <div class="hint">Matched to Cin7 case-insensitively and stored with Cin7's spelling.</div></div>
    <div class="gw-field-row">
      <div class="gw-field"><label>Quantity</label>
        <input class="gw-input" id="rcQty" type="number" min="0.001" step="any" /></div>
      <div class="gw-field"><label>Arrived on</label>
        <input class="gw-input" id="rcDate" type="date" value="${today}" />
        <div class="hint">Required — this drives FIFO.</div></div>
    </div>
    <div class="gw-field-row">
      <div class="gw-field"><label>Shelf</label><input class="gw-input" id="rcShelf" placeholder="e.g. A12" /></div>
      <div class="gw-field"><label>Pallet number</label><input class="gw-input" id="rcPallet" /></div>
    </div>
    <div class="gw-field-row">
      <div class="gw-field"><label>Source</label>
        <select class="gw-input" id="rcSource">
          <option value="transfer_in">Transfer from Main</option>
          <option value="container">Container / supplier</option>
          <option value="return">Return</option>
          <option value="found">Stock found</option>
        </select></div>
      <div class="gw-field"><label>Reference</label>
        <input class="gw-input" id="rcRef" placeholder="TR-49562 / PO / container" /></div>
    </div>
    <div class="gw-field"><label>Notes</label><textarea class="gw-input" id="rcNotes" rows="2"></textarea></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Record arrival', cls: 'gw-btn-primary', onClick: async () => {
      await api('/lots', { method: 'POST', body: JSON.stringify({
        sku: $('rcSku').value, qty_received: Number($('rcQty').value),
        received_on: $('rcDate').value, shelf_id: $('rcShelf').value.toUpperCase().trim() || null,
        shelf_text: $('rcShelf').value.trim() || null,
        pallet_number: $('rcPallet').value, source_type: $('rcSource').value,
        source_reference: $('rcRef').value, notes: $('rcNotes').value,
      }) });
      closeModal(); toast('Arrival recorded');
      loadInventory(); loadOverview();
    } },
  ]);
}

function adjustModal(lotId, sku, current) {
  modal(`Adjust ${sku}`, `
    <div class="gw-note gw-note-warn">
      This does not overwrite the quantity. It records a correction, and the balance moves by
      the amount you enter — so the history still explains how we got here.
    </div>
    <div class="gw-field"><label>Currently on this pallet</label>
      <input class="gw-input" value="${nfmt(current)}" disabled /></div>
    <div class="gw-field-row">
      <div class="gw-field"><label>Adjustment (negative to remove)</label>
        <input class="gw-input" id="adDelta" type="number" step="any" placeholder="-3" /></div>
      <div class="gw-field"><label>New balance</label>
        <input class="gw-input" id="adNew" disabled value="${nfmt(current)}" /></div>
    </div>
    <div class="gw-field"><label>Reason type</label>
      <select class="gw-input" id="adCode">
        <option value="stocktake">Stocktake correction</option>
        <option value="damaged">Damaged</option>
        <option value="found">Stock found</option>
        <option value="lost">Stock lost</option>
        <option value="write_off">Write-off</option>
        <option value="manual">Other</option>
      </select></div>
    <div class="gw-field"><label>What happened</label>
      <textarea class="gw-input" id="adReason" rows="2" placeholder="Required"></textarea></div>
    <div class="gw-field"><label>Reference</label><input class="gw-input" id="adRef" /></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Record adjustment', cls: 'gw-btn-primary', onClick: async () => {
      await api(`/lots/${lotId}/adjust`, { method: 'POST', body: JSON.stringify({
        delta: Number($('adDelta').value), reason_code: $('adCode').value,
        reason: $('adReason').value, reference: $('adRef').value,
      }) });
      closeModal(); toast('Adjustment recorded');
      showSku(sku); loadOverview();
    } },
  ]);
  $('adDelta').oninput = e => {
    const d = Number(e.target.value);
    $('adNew').value = isNaN(d) ? nfmt(current) : nfmt(Number(current) + d);
  };
}

// ═══════════ TRANSFERS ═══════════
function wireTransfers() {
  let t;
  $('trSearch').oninput = e => {
    clearTimeout(t);
    t = setTimeout(() => { state.tr.q = e.target.value.trim(); loadTransfers(); }, 280);
  };
  $('trStatus').onchange = e => { state.tr.status = e.target.value; loadTransfers(); };
  $('trNew').onclick   = () => newTransfer('gateway_to_main');
  $('trNewIn').onclick = () => newTransfer('main_to_gateway');
}

const OPEN_STATUSES = 'draft,ready_for_cin7,cin7_created,picking,dispatched';

async function loadTransfers() {
  const s = state.tr;
  const qs = new URLSearchParams({ q: s.q, limit: 100 });
  if (!s.status) qs.set('status', OPEN_STATUSES);
  else if (s.status !== 'all') qs.set('status', s.status);

  let d;
  try { d = await api(`/transfers?${qs}`); } catch (e) { return fail(e); }
  s.rows = d.rows;

  $('trBody').innerHTML = d.rows.length ? d.rows.map(t => `
    <tr class="clickable" onclick="showTransfer(${t.id})">
      <td class="mono">${esc(t.transfer_no)}</td>
      <td>${dirLabel(t.direction)}</td>
      <td>${statusTag(t.status)}</td>
      <td>${t.direction === 'main_to_gateway' ? '<span class="gw-sub">n/a</span>'
            : t.fifo_compliant === false
              ? `<span class="tag tag-amber">${t.override_count} override${t.override_count === 1 ? '' : 's'}</span>`
              : t.fifo_compliant === true ? '<span class="tag tag-green">Compliant</span>'
              : '<span class="gw-sub">—</span>'}</td>
      <td class="mono gw-sub">${esc(t.cin7_reference || '—')}</td>
      <td class="r num">${nfmt(t.line_count)}</td>
      <td class="r num">${nfmt(t.qty_requested)}</td>
      <td class="r num">${nfmt(t.qty_allocated)}</td>
      <td class="r num">${Number(t.qty_moved) ? nfmt(t.qty_moved) : '—'}</td>
      <td class="gw-sub">${esc(dtfmt(t.created_at))}</td>
    </tr>`).join('') : empty(10, 'No transfers');
  $('trCount').textContent = `${nfmt(d.total)} transfers`;
}

async function newTransfer(direction) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Brisbane' });
  modal(direction === 'main_to_gateway' ? 'New Main to Gateway transfer' : 'New Gateway to Main transfer', `
    <div class="gw-field-row">
      <div class="gw-field"><label>Planned for</label>
        <input class="gw-input" id="ntDate" type="date" value="${today}" /></div>
      <div class="gw-field"><label>Reference</label>
        <input class="gw-input" id="ntRef" placeholder="optional" /></div>
    </div>
    <div class="gw-field"><label>Notes</label><textarea class="gw-input" id="ntNotes" rows="2"></textarea></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Create', cls: 'gw-btn-primary', onClick: async () => {
      const t = await api('/transfers', { method: 'POST', body: JSON.stringify({
        direction, planned_for: $('ntDate').value,
        reference: $('ntRef').value, notes: $('ntNotes').value,
      }) });
      closeModal(); toast(`${t.transfer_no} created`);
      switchView('transfers'); showTransfer(t.id);
    } },
  ]);
}

async function showTransfer(id) {
  openDrawer('—', '');
  let d;
  try { d = await api(`/transfers/${id}`); } catch (e) { closeDrawer(); return fail(e); }
  state.openTransfer = d;
  const t = d.transfer;
  const editable = ['draft', 'ready_for_cin7'].includes(t.status);
  const outbound = t.direction === 'gateway_to_main';

  $('drTitle').innerHTML = esc(t.transfer_no);
  $('drSub').innerHTML = `${dirLabel(t.direction)} · ${statusTag(t.status)}` +
    (t.cin7_reference ? ` · Cin7 <span class="mono">${esc(t.cin7_reference)}</span>` : '');

  const allocsByLine = {};
  d.allocations.forEach(a => { (allocsByLine[a.line_id] = allocsByLine[a.line_id] || []).push(a); });

  const short = d.lines.filter(l => Number(l.qty_allocated) < Number(l.qty_requested));

  $('drBody').innerHTML = `
    <div class="gw-toolbar no-print">
      ${editable ? '<button class="gw-btn gw-btn-primary" id="btnAddLine">Add product</button>' : ''}
      ${outbound && d.allocations.some(a => a.state !== 'released')
        ? '<button class="gw-btn" id="btnPrint">Print pick sheet</button>' : ''}
      ${t.status === 'draft' ? '<button class="gw-btn" id="btnReady">Mark ready for Cin7</button>' : ''}
      ${t.status === 'ready_for_cin7' || t.status === 'cin7_created'
        ? '<button class="gw-btn" id="btnCin7">Record Cin7 reference</button>' : ''}
      ${['cin7_created', 'picking', 'dispatched'].includes(t.status)
        ? '<button class="gw-btn gw-btn-primary" id="btnPost">Confirm the stock moved</button>' : ''}
      ${!['completed', 'cancelled'].includes(t.status)
        ? '<button class="gw-btn gw-btn-danger" id="btnCancel">Cancel</button>' : ''}
    </div>

    ${t.status === 'ready_for_cin7' ? `<div class="gw-note gw-note-warn no-print">
      <b>Next step is manual.</b> Raise this transfer in Cin7 yourself, then record its
      TR reference here. This module never writes to Cin7.</div>` : ''}
    ${short.length ? `<div class="gw-note gw-note-warn no-print">
      <b>${short.length} line${short.length === 1 ? '' : 's'} short of stock.</b>
      ${short.map(l => `${esc(l.sku)} needs ${nfmt(l.qty_requested)}, only ${nfmt(l.qty_allocated)} free`).join(' · ')}
    </div>` : ''}
    ${t.status === 'cancelled' ? `<div class="gw-note gw-note-bad no-print">
      Cancelled by ${esc(t.cancelled_by || '—')} on ${esc(dtfmt(t.cancelled_at))}.
      ${esc(t.cancel_reason || '')}</div>` : ''}

    <div class="gw-sec">
      <div class="gw-sec-hd"><span class="gw-sec-title">Products</span></div>
      <div class="gw-table-wrap"><table class="gw-table">
        <thead><tr><th>SKU</th><th>Product</th><th class="r">Wanted</th><th class="r">Allocated</th>
          <th class="r">Moved</th><th>Stock to pick</th>${editable ? '<th></th>' : ''}</tr></thead>
        <tbody>${d.lines.length ? d.lines.map(l => {
          const as = allocsByLine[l.id] || [];
          return `<tr>
            <td class="mono">${esc(l.sku)}</td>
            <td>${esc(l.product_name || '—')}</td>
            <td class="r num">${nfmt(l.qty_requested)}</td>
            <td class="r num ${Number(l.qty_allocated) < Number(l.qty_requested) ? 'var-neg' : ''}">${nfmt(l.qty_allocated)}</td>
            <td class="r num">${l.qty_moved == null ? '—' : nfmt(l.qty_moved)}</td>
            <td>${as.filter(a => a.state !== 'released').map(a => `
              <div style="margin:1px 0">
                <span class="num">${nfmt(a.qty)}</span> from
                <span class="mono">${esc(a.lot?.shelf_id || a.lot?.shelf_text || '?')}</span>
                ${a.lot?.pallet_number ? `<span class="gw-sub">pallet ${esc(a.lot.pallet_number)}</span>` : ''}
                <span class="gw-sub">${a.lot?.received_on ? esc(dfmt(a.lot.received_on)) : 'date unknown'}</span>
                ${a.is_fifo_override ? `<span class="tag tag-amber" title="${esc(a.override_reason || '')}">out of FIFO order</span>` : ''}
                ${editable ? `<button class="gw-btn gw-btn-sm no-print" onclick="removeAlloc(${a.id}, ${t.id})">remove</button>` : ''}
              </div>`).join('') || '<span class="gw-sub">allocation pending</span>'}
              ${editable && outbound && Number(l.qty_allocated) < Number(l.qty_requested)
                ? `<div class="no-print" style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
                     <button class="gw-btn gw-btn-primary gw-btn-sm" onclick="allocFifo(${l.id}, ${t.id})">Allocate FIFO (auto)</button>
                     <button class="gw-btn gw-btn-sm" onclick="overrideModal(${l.id}, '${esc(l.sku)}', ${t.id})">Pick shelf / split</button>
                   </div>` : ''}
            </td>
            ${editable ? `<td class="r no-print"><button class="gw-btn gw-btn-sm" onclick="removeLine(${t.id}, ${l.id})">Remove</button></td>` : ''}
          </tr>`;
        }).join('') : empty(editable ? 7 : 6, 'No products yet')}</tbody>
      </table></div>
    </div>`;

  const bind = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  bind('btnAddLine', () => addLineModal(t.id, t.direction));
  bind('btnPrint',   () => printPicklist(t.id));
  bind('btnReady',   async () => {
    try {
      await api(`/transfers/${t.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'ready_for_cin7' }) });
      toast('Ready for Cin7'); showTransfer(t.id); loadTransfers();
    } catch (e) { fail(e); }
  });
  bind('btnCin7',   () => cin7Modal(t.id, t.cin7_reference));
  bind('btnPost',   () => postModal(t.id, d));
  bind('btnCancel', () => cancelModal(t.id));
}

// One click: allocate the line in FIFO order (auto splits across the oldest
// shelves; undated stock goes first).
async function allocFifo(lineId, transferId) {
  try {
    const r = await api(`/transfers/${transferId}/allocate`, { method: 'POST',
      body: JSON.stringify({ line_id: lineId }) });
    toast(Number(r.shortfall) > 0
      ? `Allocated ${nfmt(r.allocated)} — ${nfmt(r.shortfall)} short of free stock`
      : `Allocated ${nfmt(r.allocated)} (FIFO)`, Number(r.shortfall) > 0);
    showTransfer(transferId);
  } catch (e) { fail(e); }
}

function addLineModal(transferId, direction) {
  const outbound = direction === 'gateway_to_main';
  modal('Add a product', `
    <div class="gw-field"><label>SKU</label>
      <input class="gw-input" id="alSku" placeholder="e.g. R6052-WH-TRI" />
      <div class="hint" id="alHint">${outbound
        ? 'Leave pending and allocate the shelves as the driver pulled them, or tick to allocate FIFO now.'
        : 'Stock arriving into Gateway. It becomes a new shelf lot when you confirm the move.'}</div></div>
    <div class="gw-field"><label>Quantity</label>
      <input class="gw-input" id="alQty" type="number" min="0.001" step="any" /></div>
    ${outbound ? `<div class="gw-field"><label style="display:flex;align-items:center;gap:8px;font-weight:500">
      <input type="checkbox" id="alAuto" /> Allocate FIFO automatically now
      </label><div class="hint">Leave unticked to allocate shelf by shelf later.</div></div>` : ''}
    <div id="alFifo"></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Add', cls: 'gw-btn-primary', onClick: async () => {
      const auto = outbound && $('alAuto') && $('alAuto').checked;
      const r = await api(`/transfers/${transferId}/lines`, { method: 'POST', body: JSON.stringify({
        sku: $('alSku').value, qty_requested: Number($('alQty').value), allocate: auto,
      }) });
      closeModal();
      if (auto && r.allocation && r.allocation.shortfall > 0) {
        toast(`Added — only ${nfmt(r.allocation.allocated)} free, ${nfmt(r.allocation.shortfall)} short`, true);
      } else toast(auto ? 'Added and allocated (FIFO)' : 'Added — allocation pending');
      showTransfer(transferId);
    } },
  ]);

  if (direction !== 'gateway_to_main') return;
  let t;
  $('alSku').oninput = e => {
    clearTimeout(t);
    const sku = e.target.value.trim();
    if (!sku) { $('alFifo').innerHTML = ''; return; }
    t = setTimeout(async () => {
      try {
        const q = await api(`/fifo/${encodeURIComponent(sku)}`);
        $('alFifo').innerHTML = q.length ? `
          <div class="gw-sec-title" style="margin-bottom:5px">Stock available, oldest first</div>
          <div class="gw-table-wrap"><table class="gw-table">
            <thead><tr><th class="c">#</th><th>Arrived</th><th>Shelf</th><th>Pallet</th><th class="r">Free</th></tr></thead>
            <tbody>${q.map(l => `<tr>
              <td class="c num">${l.fifo_rank}</td>
              <td>${l.received_on ? esc(dfmt(l.received_on)) : '<span class="age-unknown">unknown</span>'}</td>
              <td class="mono">${esc(l.shelf_id || l.shelf_text || '—')}</td>
              <td class="mono gw-sub">${esc(l.pallet_number || '—')}</td>
              <td class="r num">${nfmt(l.qty_available)}</td></tr>`).join('')}</tbody>
          </table></div>` : '<div class="gw-note gw-note-warn">No free stock in Gateway for that SKU.</div>';
      } catch { $('alFifo').innerHTML = ''; }
    }, 320);
  };
}

async function overrideModal(lineId, sku, transferId) {
  let q;
  try { q = await api(`/fifo/${encodeURIComponent(sku)}`); } catch (e) { return fail(e); }
  if (!q.length) return toast('No free stock for that SKU', true);

  modal(`Allocate ${sku} — pick a shelf`, `
    <div class="gw-note gw-note-info">
      Suggested in FIFO order (oldest first; undated stock first). Pick the shelf the driver
      pulled from. To <b>split</b> across shelves, allocate one, then open again and allocate
      the next. A reason is only needed if you go against FIFO.
    </div>
    <div class="gw-field"><label>Shelf / pallet</label>
      <select class="gw-input" id="ovLot">${q.map(l => `
        <option value="${l.lot_id}" data-free="${l.qty_available}">
          ${l.fifo_rank === 1 ? '★ FIFO · ' : ''}shelf ${l.shelf_id || l.shelf_text || '?'}${l.pallet_number ? ` · pallet ${l.pallet_number}` : ''}
          · ${l.received_on ? dfmt(l.received_on) : 'no date'} · ${nfmt(l.qty_available)} free
        </option>`).join('')}</select></div>
    <div class="gw-field"><label>Quantity from this shelf</label>
      <input class="gw-input" id="ovQty" type="number" min="0.001" step="any" value="${q[0].qty_available}" /></div>
    <div class="gw-field"><label>Reason (only if not the oldest)</label>
      <select class="gw-input" id="ovPreset">
        <option value="">Optional — choose or type…</option>
        <option>Damaged cartons in the older lot</option>
        <option>Older pallet not accessible</option>
        <option>Allocated to a project</option>
        <option>Older lot needs a quality check</option>
      </select></div>
    <div class="gw-field"><textarea class="gw-input" id="ovReason" rows="2" placeholder="Optional"></textarea></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Allocate from this shelf', cls: 'gw-btn-primary', onClick: async () => {
      await api(`/transfers/${transferId}/override`, { method: 'POST', body: JSON.stringify({
        line_id: lineId, lot_id: Number($('ovLot').value),
        qty: Number($('ovQty').value), reason: $('ovReason').value,
      }) });
      closeModal(); toast('Shelf allocated');
      showTransfer(transferId);
    } },
  ]);
  $('ovPreset').onchange = e => { if (e.target.value) $('ovReason').value = e.target.value; };
  $('ovLot').onchange = e => {
    $('ovQty').value = e.target.selectedOptions[0].dataset.free;
  };
}

async function removeAlloc(allocId, transferId) {
  try {
    await api(`/allocations/${allocId}`, { method: 'DELETE' });
    toast('Allocation removed, stock released'); showTransfer(transferId);
  } catch (e) { fail(e); }
}
async function removeLine(transferId, lineId) {
  try {
    await api(`/transfers/${transferId}/lines/${lineId}`, { method: 'DELETE' });
    toast('Removed'); showTransfer(transferId);
  } catch (e) { fail(e); }
}

function cin7Modal(id, current) {
  modal('Record the Cin7 transfer reference', `
    <div class="gw-note gw-note-info">
      Raise the transfer in Cin7 by hand, then put its number here so the two records point at
      each other. This module does not create Cin7 transfers.
    </div>
    <div class="gw-field"><label>Cin7 reference</label>
      <input class="gw-input" id="c7Ref" placeholder="TR-49562" value="${esc(current || '')}" /></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Save', cls: 'gw-btn-primary', onClick: async () => {
      const r = await api(`/transfers/${id}/cin7`, { method: 'POST', body: JSON.stringify({
        cin7_reference: $('c7Ref').value,
      }) });
      closeModal();
      toast(r.matched_in_mirror
        ? `Linked and found in Cin7 (${r.cin7.from_location} to ${r.cin7.to_location})`
        : 'Linked. Not in the Cin7 mirror yet — it syncs every couple of hours.');
      showTransfer(id); loadTransfers();
    } },
  ]);
}

function postModal(id, d) {
  const outbound = d.transfer.direction === 'gateway_to_main';
  const rows = outbound
    ? d.allocations.filter(a => ['reserved', 'picked'].includes(a.state))
    : d.lines;
  const now = new Date().toISOString().slice(0, 16);

  modal('Confirm the stock physically moved', `
    <div class="gw-note gw-note-warn">
      This writes the movement into the ledger and cannot be edited afterwards — a mistake is
      corrected by recording a reversal. Change any quantity that was short-picked.
    </div>
    <div class="gw-field"><label>When it moved</label>
      <input class="gw-input" id="poWhen" type="datetime-local" value="${now}" /></div>
    <div class="gw-table-wrap"><table class="gw-table">
      <thead><tr><th>SKU</th><th>${outbound ? 'From' : 'Into'}</th><th class="r">Planned</th><th class="r">Actually moved</th></tr></thead>
      <tbody>${rows.map(r => outbound ? `
        <tr><td class="mono">${esc(r.lot?.sku || d.lines.find(l => l.id === r.line_id)?.sku || '')}</td>
          <td class="mono gw-sub">${esc(r.lot?.shelf_id || r.lot?.shelf_text || '—')}</td>
          <td class="r num">${nfmt(r.qty)}</td>
          <td class="r"><input class="gw-input po-qty" data-id="${r.id}" type="number" step="any"
              min="0" max="${r.qty}" value="${r.qty}" style="width:100px;text-align:right" /></td></tr>` : `
        <tr><td class="mono">${esc(r.sku)}</td><td class="gw-sub">new pallet</td>
          <td class="r num">${nfmt(r.qty_requested)}</td>
          <td class="r"><input class="gw-input po-qty" data-line="${r.id}" type="number" step="any"
              min="0" value="${r.qty_requested}" style="width:100px;text-align:right" /></td></tr>`).join('')}
      </tbody></table></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Confirm the move', cls: 'gw-btn-primary', onClick: async () => {
      const picked = [...document.querySelectorAll('.po-qty')].map(i => (
        i.dataset.id
          ? { allocation_id: Number(i.dataset.id), qty: Number(i.value) }
          : { line_id: Number(i.dataset.line), qty: Number(i.value) }));
      const when = $('poWhen').value;
      const r = await api(`/transfers/${id}/post`, { method: 'POST', body: JSON.stringify({
        picked, occurred_at: when ? new Date(when).toISOString() : null,
      }) });
      closeModal();
      toast(r.already_completed ? 'Already completed' : `Recorded ${r.movements} movement(s)`);
      showTransfer(id); loadTransfers(); loadOverview();
    } },
  ]);
}

function cancelModal(id) {
  modal('Cancel this transfer', `
    <div class="gw-note gw-note-info">
      Cancelling releases the stock it was holding. It does not record a movement, because
      nothing physically moved — that is deliberately a different thing from stock coming back.
    </div>
    <div class="gw-field"><label>Why</label>
      <textarea class="gw-input" id="cnReason" rows="2" placeholder="Required"></textarea></div>`,
  [
    { label: 'Keep it', onClick: closeModal },
    { label: 'Cancel the transfer', cls: 'gw-btn-danger', onClick: async () => {
      const r = await api(`/transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify({
        reason: $('cnReason').value,
      }) });
      closeModal(); toast(`Cancelled, ${r.allocations_released} allocation(s) released`);
      showTransfer(id); loadTransfers(); loadOverview();
    } },
  ]);
}

// ─── the pick sheet ────────────────────────────────────────────────────
// Delivery docket — mirrors the Gateway Excel template the team already uses
// ('PALLET DELIVERY TO MAIN'): No. | Location | Pallet # | 5DC | Description |
// Units | Carton/Pallet | Sent | Left, then "please fill everything" + sign.
// No FIFO decoration and no Cin7-TR consignment — this is the picker's paper.
// Re-sortable on screen (walk route / shelf / SKU) before printing.
let _picklist = null;
async function printPicklist(id) {
  try { _picklist = await api(`/transfers/${id}/picklist`); } catch (e) { return fail(e); }
  _picklist.sort = 'route';
  openDrawer(esc(_picklist.transfer.transfer_no), 'Delivery docket');
  renderPicklist(id);
}

function renderPicklist(id) {
  const d = _picklist, t = d.transfer;
  const toMain = t.direction === 'gateway_to_main';
  const printed = new Date().toLocaleString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Australia/Brisbane',
  });

  // sort the docket the way the user wants to walk it
  const rows = [...d.rows];
  const bySku   = (a, b) => String(a.sku || '').localeCompare(String(b.sku || ''));
  const byShelf = (a, b) => String(a.shelf || '~').localeCompare(String(b.shelf || '~')) || bySku(a, b);
  const byRoute = (a, b) =>
    (a.pick_sequence ?? 1e9) - (b.pick_sequence ?? 1e9) ||
    String(a.area || '~').localeCompare(String(b.area || '~')) ||
    (a.shelf_number ?? 1e9) - (b.shelf_number ?? 1e9) || byShelf(a, b);
  rows.sort(d.sort === 'sku' ? bySku : d.sort === 'shelf' ? byShelf : byRoute);
  rows.forEach((r, i) => { r.line_no = i + 1; });

  const sortBtn = (key, label) =>
    `<button class="gw-btn gw-btn-sm ${d.sort === key ? 'gw-btn-primary' : ''}" onclick="setPicklistSort(${id},'${key}')">${label}</button>`;

  $('drBody').innerHTML = `
    <div class="gw-toolbar no-print">
      <button class="gw-btn gw-btn-primary" onclick="window.print()">Print</button>
      <button class="gw-btn" onclick="showTransfer(${id})">Back to the transfer</button>
      <span style="margin-left:auto;font-size:12px;color:#5b6b86">Sort:</span>
      ${sortBtn('route', 'Walk route')} ${sortBtn('shelf', 'Location')} ${sortBtn('sku', 'SKU')}
    </div>

    <div class="gw-print-only">
      <div class="print-hd">
        <div>
          <div class="print-title">PALLET DELIVERY TO ${toMain ? 'MAIN' : 'GATEWAY'}</div>
          <div>${esc(t.transfer_no)}${t.cin7_reference ? ' · Cin7 ' + esc(t.cin7_reference) : ''}</div>
        </div>
        <div class="print-meta">
          ${esc(printed)}<br />
          ${nfmt(rows.length)} lines · ${nfmt(rows.reduce((s, r) => s + r.qty, 0))} units
        </div>
      </div>
      ${d.unallocated.length ? `<div class="print-warn">
        NOT YET ALLOCATED: ${d.unallocated.map(u =>
          `${esc(u.sku)} — ${nfmt(u.short)} of ${nfmt(u.requested)}`).join(' · ')}
      </div>` : ''}
    </div>

    <div class="gw-table-wrap"><table class="gw-table">
      <thead><tr>
        <th class="c">No.</th><th>Location</th><th>Pallet #</th><th>5DC</th><th>Description</th>
        <th class="r">Units</th><th>Carton/Pallet</th><th class="c">Sent</th><th class="c">Left</th>
      </tr></thead>
      <tbody>${rows.length ? rows.map(r => `
        <tr>
          <td class="c num">${r.line_no}</td>
          <td class="mono"><b>${esc(r.shelf || '—')}</b></td>
          <td class="mono">${esc(r.pallet || '—')}</td>
          <td class="mono gw-sub">${esc(r.five_dc || '—')}</td>
          <td class="mono">${esc(r.sku)}</td>
          <td class="r num"><b>${nfmt(r.qty)}</b></td>
          <td>${esc(r.carton_pack || '')}</td>
          <td class="c" style="min-width:56px">&nbsp;</td>
          <td class="c" style="min-width:56px">&nbsp;</td>
        </tr>`).join('') : empty(9, 'Nothing allocated yet — allocate the lines first')}</tbody>
    </table></div>

    <div class="gw-print-only">
      <div style="margin-top:8pt;font-size:9.5pt">*** Please fill everything and return to Joao ***</div>
      <div class="print-sign">
        <div>Picked by &nbsp; / &nbsp; date</div>
        <div>Driver &nbsp; / &nbsp; date</div>
        <div>Received at Main &nbsp; / &nbsp; date</div>
      </div>
    </div>`;
}

function setPicklistSort(id, key) { if (_picklist) { _picklist.sort = key; renderPicklist(id); } }

// ═══════════ RECOMMENDATIONS ═══════════
// ═══════════ RECONCILIATION ═══════════
function wireRecon() {
  $('reconState').onchange = e => { state.recon.state = e.target.value; loadRecon(); };
  $('reconRefresh').onclick = async () => {
    try {
      const r = await api('/reconciliation/refresh', { method: 'POST', body: JSON.stringify({}) });
      toast(`${r.upserted} open, ${r.auto_closed} closed automatically`);
      loadRecon(); loadOverview();
    } catch (e) { fail(e); }
  };
}

async function loadRecon() {
  const qs = new URLSearchParams();
  if (state.recon.state) qs.set('state', state.recon.state);
  let d;
  try { d = await api(`/reconciliation?${qs}`); } catch (e) { return fail(e); }
  state.recon.rows = d.rows;

  const f = d.cin7_freshness;
  $('reconNote').innerHTML = `Cin7 owns the per-SKU total. We own the shelf, the pallet and the
    arrival date, because Cin7 does not model any of them for Gateway. A difference is recorded
    and explained, never corrected by editing our history to agree.
    ${f ? `<br /><b>Cin7 stock last synced:</b> ${esc(dtfmt(f.latest_sync))} (${esc(f.staleness || '')} old).` : ''}`;

  $('reconBody').innerHTML = d.rows.length ? d.rows.map(r => `
    <tr>
      <td class="mono clickable" onclick="showSku('${esc(r.sku)}')">${esc(r.sku)}</td>
      <td>${esc(r.product_name || '—')}</td>
      <td class="r num">${nfmt(r.local_qty)}</td>
      <td class="r num">${nfmt(r.cin7_qty)}</td>
      <td class="r num">${diffCell(r.difference)}</td>
      <td>${stateTag(r.state)}</td>
      <td>${r.issue_status
        ? `<span class="tag ${r.issue_status === 'open' ? 'tag-red' : r.issue_status === 'investigating' ? 'tag-amber' : 'tag-green'}">${esc(r.issue_status)}</span>
           ${r.issue_cause ? `<div class="gw-sub">${esc(r.issue_cause.replace(/_/g, ' '))}</div>` : ''}`
        : '<span class="gw-sub">not opened</span>'}</td>
      <td class="gw-sub">${esc(r.shelves || '—')}</td>
      <td class="r">${r.issue_id
        ? `<button class="gw-btn gw-btn-sm" onclick="resolveModal(${r.issue_id}, '${esc(r.sku)}')">Explain</button>`
        : ''}</td>
    </tr>`).join('') : empty(9, 'No differences');
  $('reconCount').textContent = `${nfmt(d.total)} differences`;
}

function resolveModal(issueId, sku) {
  modal(`Explain the difference on ${sku}`, `
    <div class="gw-note gw-note-info">
      Recording a cause does not change any quantity. If stock really is wrong, correct it with
      an adjustment on the pallet so the ledger keeps explaining itself.
    </div>
    <div class="gw-field"><label>Most likely cause</label>
      <select class="gw-input" id="rsCause">
        <option value="cin7_transfer_not_recorded">A Cin7 transfer we never recorded</option>
        <option value="local_movement_not_in_cin7">A move we recorded that never reached Cin7</option>
        <option value="stocktake">Stocktake correction</option>
        <option value="duplicate_movement">Something counted twice</option>
        <option value="bad_opening_balance">The migrated opening balance was wrong</option>
        <option value="timing">Timing — Cin7 has not caught up</option>
        <option value="wrong_location">Booked to the wrong warehouse</option>
        <option value="unknown">Still unknown</option>
      </select></div>
    <div class="gw-field"><label>Status</label>
      <select class="gw-input" id="rsStatus">
        <option value="investigating">Investigating</option>
        <option value="resolved">Resolved</option>
        <option value="accepted">Accepted — leave as is</option>
      </select></div>
    <div class="gw-field"><label>Notes</label>
      <textarea class="gw-input" id="rsNote" rows="3" placeholder="Required when resolving or accepting"></textarea></div>`,
  [
    { label: 'Cancel', onClick: closeModal },
    { label: 'Save', cls: 'gw-btn-primary', onClick: async () => {
      await api(`/reconciliation/${issueId}/resolve`, { method: 'POST', body: JSON.stringify({
        status: $('rsStatus').value, cause_code: $('rsCause').value, note: $('rsNote').value,
      }) });
      closeModal(); toast('Recorded'); loadRecon(); loadOverview();
    } },
  ]);
}

// ═══════════ DATA QUALITY ═══════════
function wireQuality() {
  $('qualSev').onchange = e => { state.qual.severity = e.target.value; loadQuality(); };
}

async function loadQuality() {
  let batches;
  try { batches = await api('/imports'); } catch (e) { return fail(e); }
  state.qual.batches = batches;

  $('qualBatches').innerHTML = batches.length ? batches.map(b => `
    <tr><td>${esc(b.source_file)}</td><td class="gw-sub">${esc(b.source_sheet || '—')}</td>
      <td><span class="tag ${b.status === 'completed' ? 'tag-green' : b.status === 'rolled_back' ? 'tag-grey' : 'tag-amber'}">${esc(b.status)}</span></td>
      <td class="r num">${nfmt(b.rows_read)}</td><td class="r num">${nfmt(b.lots_created)}</td>
      <td class="r num">${nfmt(b.movements_created)}</td>
      <td class="r num ${b.warnings ? 'var-neg' : ''}">${nfmt(b.warnings)}</td>
      <td class="r num ${b.errors ? 'var-neg' : ''}">${nfmt(b.errors)}</td>
      <td class="gw-sub">${esc(dtfmt(b.started_at))}</td></tr>`).join('')
    : empty(9, 'Nothing imported yet');

  const latest = batches.find(b => b.status === 'completed');
  if (!latest) { $('qualIssues').innerHTML = empty(6, 'No import to review'); return; }

  const qs = new URLSearchParams({ resolved: 'false', limit: 300 });
  if (state.qual.severity) qs.set('severity', state.qual.severity);
  let d;
  try { d = await api(`/imports/${latest.id}/issues?${qs}`); } catch (e) { return fail(e); }

  $('qualIssues').innerHTML = d.rows.length ? d.rows.map(i => `
    <tr>
      <td><span class="tag ${i.severity === 'error' ? 'tag-red' : i.severity === 'warning' ? 'tag-amber' : 'tag-grey'}">${esc(i.severity)}</span></td>
      <td class="gw-sub">${esc(i.code.replace(/_/g, ' '))}</td>
      <td class="mono gw-sub">${esc((i.row_ref || '').replace('MAIN Stock Movement!', ''))}</td>
      <td class="mono">${i.sku ? `<span class="clickable" onclick="showSku('${esc(i.sku)}')">${esc(i.sku)}</span>` : '—'}</td>
      <td>${esc(i.message)}</td>
      <td class="r"><button class="gw-btn gw-btn-sm" onclick="resolveIssue(${i.id})">Mark reviewed</button></td>
    </tr>`).join('') : empty(6, 'Nothing outstanding');
  $('qualCount').textContent = `${nfmt(d.total)} open`;
}

async function resolveIssue(id) {
  try {
    await api(`/imports/issues/${id}/resolve`, { method: 'POST', body: JSON.stringify({}) });
    toast('Marked reviewed'); loadQuality(); loadOverview();
  } catch (e) { fail(e); }
}

boot().catch(fail);
