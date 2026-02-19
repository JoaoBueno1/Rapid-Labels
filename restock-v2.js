// restock-v2.js
// Purpose: Re-Stock V2 – same logic as V1 but reads from cin7_mirror (Cin7 stock sync)
//          instead of manually-uploaded Excel reports.
// Data sources:
//   cin7_mirror.stock_snapshot  → on_hand per bin in Main Warehouse
//   cin7_mirror.products        → product info + stock_locator (pickface)
//   restock_setup               → capacity thresholds (shared with V1)
//   user_favorites              → favorites (shared with V1)
//   cin7_mirror.sync_runs       → last sync status for the status card

(function () {
  'use strict';

  /* ───── tiny debounce ───── */
  function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), delay); };
  }

  /* ───── state ───── */
  const state = {
    q: '',
    loading: false,
    rows: [],
    allRows: [],
    statusFilter: 'ALL', // ALL | LOW | MEDIUM | FULL | OVER | NOT_CONFIGURED
    hideNoReserve: false,
    onlyNeedsAdjustment: false,
    onlyFavorites: false,
    onlyConfigured: false,
    onlyReserveInfo: false,
    page: 1,
    perPage: 30,
    hideLocations: {
      'MA-GA': false,
      'MA-PRODUCTION': false,
      'MA-SAMPLES': false,
      'MA-DOCK': false,
      'MA-RETURNS': false
    },
    syncStatus: null,          // latest sync_runs row
    mirrorAvailable: null,     // null = unknown, true/false after first fetch
  };

  /* ═══════════════════════════════════════════════
     FAVORITES  (same as V1 – shared table)
     ═══════════════════════════════════════════════ */
  const FAVORITES_KEY = 'restock_favorites_skus';
  const favorites = new Set();

  async function loadFavoritesFromDB() {
    try {
      await window.supabaseReady;
      const { data, error } = await window.supabase.from('user_favorites').select('sku');
      if (error) { loadFavoritesFromLocalStorage(); return; }
      favorites.clear();
      (data || []).forEach(r => favorites.add(String(r.sku)));
    } catch { loadFavoritesFromLocalStorage(); }
  }
  function loadFavoritesFromLocalStorage() {
    try { const raw = localStorage.getItem(FAVORITES_KEY); if (raw) JSON.parse(raw).forEach(s => favorites.add(String(s))); } catch {}
  }
  async function addFavoriteToDB(sku) {
    try {
      await window.supabaseReady;
      const { error } = await window.supabase.from('user_favorites').upsert({ sku: String(sku) }, { onConflict: 'sku' });
      return !error;
    } catch { return false; }
  }
  async function removeFavoriteFromDB(sku) {
    try {
      await window.supabaseReady;
      const { error } = await window.supabase.from('user_favorites').delete().eq('sku', String(sku));
      return !error;
    } catch { return false; }
  }
  async function persistFavorites(sku, isAdding) {
    const ok = isAdding ? await addFavoriteToDB(sku) : await removeFavoriteFromDB(sku);
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favorites))); } catch {}
    return ok;
  }

  /* ═══════════════════════════════════════════════
     DOM helpers
     ═══════════════════════════════════════════════ */
  const tbody = document.getElementById('restockTbody');
  const input = document.getElementById('restockSearch');

  function setTbody(html) { if (tbody) tbody.innerHTML = html; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  /* ═══════════════════════════════════════════════
     STATUS helpers  (now includes NOT_CONFIGURED)
     ═══════════════════════════════════════════════ */
  function statusChip(status, setupInfo) {
    const s = String(status || '').toLowerCase();
    const map = { low:'low', medium:'medium', full:'full', ok:'full', over:'over', configure:'configure', 'not configured':'not-configured', 'not_configured':'not-configured' };
    const cls = map[s] || '';
    if (s === 'configure' && setupInfo) {
      const { hasSetup, min, med, max } = setupInfo;
      let tooltip = 'Needs setup: ';
      if (!hasSetup) tooltip += 'No configuration found for this SKU';
      else {
        const issues = [];
        if (!Number.isFinite(min)) issues.push('min not set');
        if (!Number.isFinite(med)) issues.push('med not set');
        if (!Number.isFinite(max)) issues.push('max not set');
        tooltip += issues.length ? issues.join(', ') : 'Invalid capacity values';
      }
      return `<span class="status-badge configure" title="${escapeHtml(tooltip)}" style="cursor:help">needs setup</span>`;
    }
    if (s === 'not configured' || s === 'not_configured') {
      return `<span class="status-badge not-configured">not configured</span>`;
    }
    const label = s === 'ok' ? 'full' : s;
    return `<span class="status-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function formatReserveCell(extra) {
    const n = Number(extra);
    if (!Number.isFinite(n) || n <= 0) return '<span class="reserve-none">No reserve</span>';
    return escapeHtml(n);
  }

  /* ═══════════════════════════════════════════════
     PAGER
     ═══════════════════════════════════════════════ */
  function updatePager(total) {
    const prevBtn = document.getElementById('restockPrevPage');
    const nextBtn = document.getElementById('restockNextPage');
    const info    = document.getElementById('restockPageInfo');
    if (!info) return;
    const totalPages = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > totalPages) state.page = totalPages;
    info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${state.page} / ${totalPages}`;
    const setBtnState = (btn, disabled) => {
      if (!btn) return;
      btn.dataset.disabled = disabled ? '1' : '0';
      btn.style.opacity    = disabled ? '.45' : '1';
      btn.style.pointerEvents = disabled ? 'none' : 'auto';
    };
    setBtnState(prevBtn, state.page <= 1);
    setBtnState(nextBtn, state.page >= totalPages);
  }

  /* ═══════════════════════════════════════════════
     LOCATION parsing & distance (same as V1)
     ═══════════════════════════════════════════════ */
  function parseLocation(code) {
    if (!code) return null;
    const m = String(code).trim().match(/^([A-Z]{2})-([A-Z])-([0-9]{2})-L(\d)(?:-P(\d))?$/i);
    if (!m) return null;
    return { site: m[1].toUpperCase(), area: m[2].toUpperCase(), row: parseInt(m[3],10), level: parseInt(m[4],10), pos: m[5] ? parseInt(m[5],10) : 0, raw: String(code).trim() };
  }
  function locationDistance(a, b) {
    if (!a || !b) return Infinity;
    if (a.site !== b.site) return 100000;
    let score = 0;
    if (a.area !== b.area) score += 10000;
    score += Math.abs(a.row - b.row) * 100;
    score += Math.abs(a.level - b.level) * 10;
    score += Math.abs(a.pos - b.pos);
    return score;
  }
  function normalizeLocation(loc) { return String(loc || '').replace(/\s+/g, '').toUpperCase(); }

  function computeNearestReserveLines(pickface, reserveLocs) {
    const p = parseLocation(pickface);
    if (!p || !Array.isArray(reserveLocs) || !reserveLocs.length) return [];
    const scored = [];
    for (const r of reserveLocs) {
      if (!r || !r.location || !Number.isFinite(r.qty) || r.qty <= 0) continue;
      const q = parseLocation(r.location);
      if (!q) continue;
      const dist = locationDistance(p, q);
      const sameLane = (p.site === q.site && p.area === q.area && p.row === q.row);
      scored.push({ location: String(r.location), qty: r.qty, dist, sameLane });
    }
    scored.sort((a,b) => a.dist - b.dist);
    const top = scored.slice(0, 3);
    const specials = ['MA-RETURNS','MA-GA','MA-SAMPLES','MA-DOCK','MA-PRODUCTION'];
    const setIncluded = new Set(top.map(x => x.location.toUpperCase()));
    const extras = [];
    for (const zone of specials) {
      const zoneUpper = zone.toUpperCase();
      const candidates = [];
      for (const r of reserveLocs) {
        if (!r || !r.location || !Number.isFinite(r.qty) || r.qty <= 0) continue;
        const locUp = String(r.location).toUpperCase();
        if (locUp.startsWith(zoneUpper) && !setIncluded.has(locUp)) candidates.push({ location: String(r.location), qty: Number(r.qty), dist: Number.MAX_SAFE_INTEGER, sameLane: false });
      }
      candidates.sort((a,b) => b.qty - a.qty);
      for (const c of candidates) { if (extras.length >= 50) break; if (!setIncluded.has(c.location.toUpperCase())) { extras.push(c); setIncluded.add(c.location.toUpperCase()); } }
    }
    return top.concat(extras).map(item => `${item.location}${item.sameLane ? ' (Same Lane)' : ''}  •  QTY = ${item.qty}`);
  }

  /* ═══════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════ */
  function render(rows) {
    if (!rows || !rows.length) {
      setTbody('<tr><td colspan="13" style="text-align:center;opacity:.7">No results</td></tr>');
      updatePager(0);
      if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
      return;
    }
    const start = (state.page - 1) * state.perPage;
    const limited = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    const chunks = [];
    for (let i = 0; i < limited.length; i += 30) {
      const slice = limited.slice(i, i + 30);
      const rowsHtml = slice.map(r => {
        const sku = escapeHtml(r.sku);
        const product = escapeHtml(r.product);
        const avgMth = r.__avg_month_sales;
        const avgMthHtml = avgMth != null ? `<span style="font-variant-numeric:tabular-nums">${Math.round(avgMth).toLocaleString()}</span>` : '<span style="opacity:.35">—</span>';
        const pickface = escapeHtml(r.stock_locator);
        const onHand = r.on_hand ?? '';
        const capacity = r.pickface_space ?? '';
        const status = (r.__norm_status || r.status || 'configure').toLowerCase();
        const reserveQty = Number(r.__reserve_total ?? 0);
        const restock = r.restock_qty ?? '';

        let reserveCellHtml = formatReserveCell(reserveQty);
        const restockNum = Number(restock);
        const showInfo = Number.isFinite(restockNum) && reserveQty > 1 && reserveQty < restockNum;
        if (showInfo) {
          const locs = (Array.isArray(r.__reserve_locations) ? r.__reserve_locations : [])
            .filter(x => x && x.location && Number(x.qty) > 0)
            .map(x => ({ location: String(x.location), qty: Number(x.qty) }));
          let chosen = [];
          const exact = locs.find(x => x.qty === restockNum);
          if (exact) { chosen = [exact]; }
          else {
            locs.sort((a,b) => b.qty - a.qty);
            let sum = 0;
            for (const x of locs) { if (sum + x.qty <= restockNum) { chosen.push(x); sum += x.qty; } }
            if (!chosen.length) { const under = locs.filter(x => x.qty < restockNum).sort((a,b) => b.qty - a.qty)[0]; if (under) chosen = [under]; }
          }
          const lines = chosen.map(x => `SKU: ${sku} — Product: ${product} — Location: ${escapeHtml(x.location)} — QTY: ${escapeHtml(x.qty)}`);
          const popHtml = lines.length ? `<div class="reserve-pop">${lines.map(l => `<span class="line">${l}</span>`).join('')}</div>` : '';
          reserveCellHtml = `<span class="reserve-cell">${reserveCellHtml}<button type="button" class="info-badge" aria-label="Reserve locations" onclick="restockToggleReserveInfo(this)">i</button>${popHtml}</span>`;
        }

        const nearestLines = computeNearestReserveLines(r.stock_locator, r.__reserve_locations);
        const nearestHtml = nearestLines.length ? nearestLines.map(l => `<div>${escapeHtml(l)}</div>`).join('') : '';
        const favOn = favorites.has(String(r.sku));
        const star = `<button type="button" class="fav-btn" aria-label="Toggle favorite" data-sku="${sku}" onclick="restockToggleFavorite('${sku}')" title="${favOn ? 'Unfavorite' : 'Favorite'}" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1">${favOn ? '★' : '☆'}</button>`;
        const actionButtons = `
          <div class="action-buttons">
            <button type="button" class="action-btn edit" onclick="openEditProductModal('${sku}')" title="Edit" style="background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;border:none;padding:6px 12px;border-radius:8px;font-weight:600;cursor:pointer;min-width:50px;height:28px;display:inline-flex;align-items:center;justify-content:center;text-transform:uppercase;letter-spacing:.5px;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:all .3s">Edit</button>
            <button type="button" class="action-btn delete" onclick="openDeleteConfirmModal('${sku}')" title="Delete" style="background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;border:none;padding:6px 12px;border-radius:8px;font-weight:600;cursor:pointer;min-width:50px;height:28px;display:inline-flex;align-items:center;justify-content:center;text-transform:uppercase;letter-spacing:.5px;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:all .3s">Delete</button>
          </div>`;
        const wrapText = (text, chunkSize) => { if (!text) return ''; const e = escapeHtml(text); const c = []; for (let j = 0; j < e.length; j += chunkSize) c.push(e.substring(j, j + chunkSize)); return c.join('<br>'); };
        const notesHtml = r.__notes ? wrapText(r.__notes, 10) : '';

        return `<tr>
          <td>${star}</td>
          <td>${sku}</td>
          <td>${product}</td>
          <td>${avgMthHtml}</td>
          <td>${pickface}</td>
          <td>${onHand}</td>
          <td>${capacity}</td>
          <td>${statusChip(status, r.__setup_info)}</td>
          <td>${reserveCellHtml}</td>
          <td>${restock}</td>
          <td class="print-only">${nearestHtml}</td>
          <td class="print-only">${notesHtml}</td>
          <td class="no-print">${actionButtons}</td>
        </tr>`;
      }).join('');
      chunks.push(rowsHtml);
      if (i + 30 < limited.length) chunks.push('<tr class="print-break"><td colspan="13"></td></tr>');
    }
    setTbody(chunks.join(''));
    if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
  }

  /* ═══════════════════════════════════════════════
     COUNTERS (now includes NOT_CONFIGURED)
     ═══════════════════════════════════════════════ */
  function updateStatusCounters() {
    const allRows = state.allRows || [];
    const counts = { all: allRows.length, low: 0, medium: 0, full: 0, over: 0, not_configured: 0 };
    allRows.forEach(row => {
      const s = String(row.__norm_status || '').toUpperCase();
      if (s === 'LOW') counts.low++;
      else if (s === 'MEDIUM') counts.medium++;
      else if (s === 'FULL' || s === 'OK') counts.full++;
      else if (s === 'OVER') counts.over++;
      else if (s === 'NOT_CONFIGURED') counts.not_configured++;
    });
    const u = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    u('countAll', counts.all);
    u('countLow', counts.low);
    u('countMedium', counts.medium);
    u('countFull', counts.full);
    u('countOver', counts.over);
    u('countNotConfigured', counts.not_configured);
  }

  /* ═══════════════════════════════════════════════
     FILTERS  (same as V1 + NOT_CONFIGURED)
     ═══════════════════════════════════════════════ */
  function applyStatusFilter(rows) {
    if (!state.statusFilter || state.statusFilter === 'ALL') return rows.slice();
    return rows.filter(r => String(r.__norm_status || '').toUpperCase() === state.statusFilter);
  }
  function applyFavoritesFilter(rows) {
    if (!state.onlyFavorites) return rows;
    return rows.filter(r => favorites.has(String(r.sku)));
  }
  function hasReserveInfoBadge(r) {
    const reserveQty = Number(r.__reserve_total || 0);
    const restock = Number(r.restock_qty);
    return Number.isFinite(restock) && reserveQty > 1 && reserveQty < restock;
  }
  function applyOnlyConfiguredFilter(rows) {
    if (!state.onlyConfigured) return rows;
    return rows.filter(r => {
      const s = String(r.__norm_status || '').toUpperCase();
      return s !== 'NOT_CONFIGURED' && s !== 'CONFIGURE';
    });
  }
  function applyOnlyReserveInfoFilter(rows) {
    if (!state.onlyReserveInfo) return rows;
    return rows.filter(hasReserveInfoBadge);
  }
  function applyLocationFilters(rows) {
    const hideList = Object.keys(state.hideLocations).filter(loc => state.hideLocations[loc]);
    if (!hideList.length) return rows;
    const filtered = [];
    for (const row of rows) {
      const locations = row.__reserve_locations || [];
      const visible = locations.filter(loc => {
        const locName = String(loc.location || '').toUpperCase();
        return !hideList.some(h => locName.includes(h));
      });
      if (locations.length > 0 && visible.length === 0) continue;
      row.__reserve_locations = visible;
      row.__reserve_total = visible.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      filtered.push(row);
    }
    return filtered;
  }

  /* ═══════════════════════════════════════════════
     SORT  (now includes NOT_CONFIGURED group)
     ═══════════════════════════════════════════════ */
  function stableSortByBusinessRules(rows) {
    const order = { LOW: 0, MEDIUM: 1, FULL: 2, OVER: 3, CONFIGURE: 4, NOT_CONFIGURED: 5 };
    const groups = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const r of rows) {
      const key = order[(r.__norm_status || '').toUpperCase()] ?? 4;
      groups[key].push(r);
    }
    const moveNoReserveDown = arr => {
      const withR = [], noR = [];
      for (const r of arr) (Number(r.__reserve_total || 0) > 0 ? withR : noR).push(r);
      const sortInner = (a, b) => {
        const pa = parseLocation(a.stock_locator) || { site:'', area:'', row:0, level:0, pos:0 };
        const pb = parseLocation(b.stock_locator) || { site:'', area:'', row:0, level:0, pos:0 };
        if (pa.site !== pb.site) return pa.site.localeCompare(pb.site);
        if (pa.area !== pb.area) return pa.area.localeCompare(pb.area);
        if (pa.row !== pb.row) return pa.row - pb.row;
        if (pa.level !== pb.level) return pa.level - pb.level;
        if (pa.pos !== pb.pos) return pa.pos - pb.pos;
        const ra = Number.isFinite(a.restock_qty) ? a.restock_qty : -Infinity;
        const rb = Number.isFinite(b.restock_qty) ? b.restock_qty : -Infinity;
        if (rb !== ra) return rb - ra;
        return String(a.sku).localeCompare(String(b.sku));
      };
      withR.sort(sortInner);
      noR.sort(sortInner);
      return withR.concat(noR);
    };
    return [].concat(
      moveNoReserveDown(groups[0]),
      moveNoReserveDown(groups[1]),
      moveNoReserveDown(groups[2]),
      moveNoReserveDown(groups[3]),
      moveNoReserveDown(groups[4]),
      moveNoReserveDown(groups[5])
    );
  }

  /* ═══════════════════════════════════════════════
     REBUILD filtered view helper
     ═══════════════════════════════════════════════ */
  function rebuildView() {
    state.page = 1;
    let rows = applyLocationFilters(state.allRows.slice());
    rows = applyStatusFilter(rows);
    rows = applyOnlyConfiguredFilter(rows);
    rows = applyFavoritesFilter(rows);
    rows = applyOnlyReserveInfoFilter(rows);
    const arranged = stableSortByBusinessRules(rows);
    let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total || 0) > 0) : arranged;
    if (state.onlyNeedsAdjustment) {
      visible = visible.filter(r => (Number(r.on_hand) === 0 && Number(r.__reserve_total || 0) > 0));
    }
    state.rows = visible;
    render(visible);
  }

  /* ═══════════════════════════════════════════════
     SYNC STATUS CARD
     ═══════════════════════════════════════════════ */
  async function updateSyncStatusCard() {
    const dot  = document.getElementById('syncStatusDot');
    const text = document.getElementById('syncStatusText');
    const time = document.getElementById('syncStatusTime');
    if (!dot || !text || !time) return;

    try {
      await window.supabaseReady;
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('sync_runs')
        .select('run_id, started_at, ended_at, status, sync_type, metrics, timing')
        .order('ended_at', { ascending: false })
        .limit(1);

      if (error) {
        // Schema may not be exposed yet
        dot.style.background = '#f59e0b';
        text.textContent = 'cin7_mirror schema not accessible — expose it in Supabase API settings';
        text.style.color = '#92400e';
        state.mirrorAvailable = false;
        return;
      }

      if (!data || data.length === 0) {
        dot.style.background = '#94a3b8';
        text.textContent = 'No sync runs found — run the first sync to populate data';
        state.mirrorAvailable = true;
        state.syncStatus = null;
        return;
      }

      const run = data[0];
      state.syncStatus = run;
      state.mirrorAvailable = true;

      const isSuccess = run.status === 'success';
      const isRunning = run.status === 'running';

      dot.style.background = isSuccess ? '#22c55e' : isRunning ? '#3b82f6' : '#ef4444';
      const statusLabel = isSuccess ? 'Last sync successful' : isRunning ? 'Sync running…' : 'Last sync failed';

      // Count metrics
      const metrics = run.metrics || {};
      const prodCount = metrics.products_synced || 0;
      const stockCount = metrics.stock_synced || 0;
      const duration = run.timing?.duration_ms ? `${(run.timing.duration_ms / 1000).toFixed(1)}s` : '';

      text.textContent = `${statusLabel}${prodCount ? ` • ${prodCount} products, ${stockCount} stock rows` : ''}${duration ? ` • ${duration}` : ''}`;
      text.style.color = isSuccess ? '#166534' : isRunning ? '#1d4ed8' : '#991b1b';

      // Format time
      if (run.ended_at) {
        const d = new Date(run.ended_at);
        const pad = n => String(n).padStart(2, '0');
        time.textContent = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } else if (run.started_at) {
        const d = new Date(run.started_at);
        const pad = n => String(n).padStart(2, '0');
        time.textContent = `Started ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    } catch (e) {
      console.warn('Error fetching sync status:', e);
      dot.style.background = '#f59e0b';
      text.textContent = 'Could not fetch sync status';
      text.style.color = '#92400e';
    }
  }

  /* ═══════════════════════════════════════════════
     PAGINATED FETCH helper
     Fetches all rows from a table in chunks of 1000,
     supporting either default or named schema.
     ═══════════════════════════════════════════════ */
  async function fetchAllRows(tableName, selectCols, opts = {}) {
    const chunkSize = 1000;
    const all = [];
    let offset = 0;
    while (true) {
      let q;
      if (opts.schema) {
        q = window.supabase.schema(opts.schema).from(tableName).select(selectCols);
      } else {
        q = window.supabase.from(tableName).select(selectCols);
      }
      if (opts.eq)  for (const [col, val] of opts.eq)  q = q.eq(col, val);
      if (opts.order) q = q.order(opts.order);
      q = q.range(offset, offset + chunkSize - 1);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < chunkSize) break;
      offset += chunkSize;
    }
    return all;
  }

  /* ═══════════════════════════════════════════════
     FETCH DATA — V2: cin7_mirror based
     ═══════════════════════════════════════════════ */
  async function fetchData() {
    if (!window.supabase || !window.supabaseReady) {
      setTbody('<tr><td colspan="13" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>');
      return;
    }
    state.loading = true;
    setTbody('<tr><td colspan="13" style="text-align:center;opacity:.7">Loading from Cin7 mirror…</td></tr>');

    try {
      await window.supabaseReady;

      /* ── 1. Update sync status card ── */
      await updateSyncStatusCard();

      /* ── 2. Fetch cin7_mirror.stock_snapshot (Main Warehouse) ── */
      let stockRows = [];
      try {
        stockRows = await fetchAllRows('stock_snapshot', 'sku, location_name, bin, on_hand', {
          schema: 'cin7_mirror',
          eq: [['location_name', 'Main Warehouse']],
        });
        state.mirrorAvailable = true;
      } catch (e) {
        console.warn('⚠️ Could not read cin7_mirror.stock_snapshot:', e.message);
        if (state.mirrorAvailable === null) state.mirrorAvailable = false;
        // Show helpful message
        setTbody(`<tr><td colspan="13" style="text-align:center;color:#b45309;padding:30px">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ cin7_mirror schema not accessible</div>
          <div style="font-size:13px;color:#64748b">To enable V2, expose the <code>cin7_mirror</code> schema in Supabase Dashboard → Settings → API → Exposed schemas,<br>then run the first sync with <code>node cin7-stock-sync/sync-service.js</code></div>
        </td></tr>`);
        state.loading = false;
        return;
      }

      /* ── 3. Fetch cin7_mirror.products ── */
      let productRows = [];
      try {
        productRows = await fetchAllRows('products', 'sku, name, stock_locator, category, brand, barcode', {
          schema: 'cin7_mirror',
        });
      } catch (e) {
        console.warn('⚠️ Could not read cin7_mirror.products:', e.message);
      }

      /* ── 4. Fetch restock_setup (shared with V1) ── */
      const setupRows = await fetchAllRows('restock_setup', 'sku, product, pickface_location, pickface_qty, cap_min, cap_med, cap_max, notes');

      /* ── 5. Fetch user_favorites ── */
      await loadFavoritesFromDB();

      /* ── 6. Fetch branch_avg_monthly_sales (avg_mth_main) ── */
      let avgSalesRows = [];
      try {
        avgSalesRows = await fetchAllRows('branch_avg_monthly_sales', 'product, avg_mth_main');
      } catch (e) {
        console.warn('⚠️ Could not read branch_avg_monthly_sales:', e.message);
      }

      /* ── Build lookup maps ── */
      const productMap = Object.create(null);
      for (const p of productRows) productMap[p.sku] = p;

      const avgSalesByName = Object.create(null);
      for (const a of avgSalesRows) {
        if (a.product) avgSalesByName[a.product.toUpperCase()] = Number(a.avg_mth_main) || 0;
      }

      const setupBySku = Object.create(null);
      for (const s of setupRows) {
        setupBySku[s.sku] = {
          product: s.product || '',
          pickface_location: s.pickface_location || '',
          pickface_qty: Number(s.pickface_qty) || 0,
          min: Number(s.cap_min),
          med: Number(s.cap_med),
          max: Number(s.cap_max),
          notes: s.notes || ''
        };
      }

      /* ── Group stock by SKU ── */
      const stockBySku = Object.create(null);
      for (const s of stockRows) {
        if (!s.sku) continue;
        if (!stockBySku[s.sku]) stockBySku[s.sku] = [];
        stockBySku[s.sku].push(s);
      }

      /* ── Build unique SKU set (union of stock + setup) ── */
      const allSkus = new Set();
      for (const sku of Object.keys(stockBySku)) allSkus.add(sku);
      for (const sku of Object.keys(setupBySku)) allSkus.add(sku);

      /* ── Apply search filter ── */
      const q = (state.q || '').trim().toLowerCase();

      /* ── Build rows ── */
      const rows = [];
      for (const sku of allSkus) {
        const prod  = productMap[sku] || {};
        const setup = setupBySku[sku];
        const stocks = stockBySku[sku] || [];

        // Determine stock_locator: prefer cin7_mirror.products.stock_locator, fallback to setup.pickface_location
        const stockLocator = (prod.stock_locator || (setup ? setup.pickface_location : '') || '').trim();
        const normPickface = normalizeLocation(stockLocator);

        // Determine product name: prefer cin7_mirror, fallback to setup
        const productName = prod.name || (setup ? setup.product : '') || sku;

        // Compute pickface on_hand and reserve
        let pickfaceOnHand = 0;
        const reserveLocations = [];

        for (const s of stocks) {
          const normBin = normalizeLocation(s.bin);
          if (normPickface && normBin === normPickface) {
            pickfaceOnHand += Number(s.on_hand) || 0;
          } else {
            const locLabel = s.bin || s.location_name || '';
            const oh = Number(s.on_hand) || 0;
            if (oh !== 0) {
              reserveLocations.push({ location: locLabel, qty: oh });
            }
          }
        }

        const reserveTotal = reserveLocations.reduce((sum, l) => sum + (l.qty || 0), 0);

        // Capacity / status
        const pickfaceSpace = setup ? setup.pickface_qty : 0;
        let restockQty = 0;
        let normStatus = '';
        let setupInfo = null;

        if (!setup) {
          normStatus = 'NOT_CONFIGURED';
          setupInfo = { sku, hasSetup: false };
        } else if (!Number.isFinite(setup.min) || !Number.isFinite(setup.med) || !Number.isFinite(setup.max)) {
          normStatus = 'CONFIGURE';
          setupInfo = { sku, hasSetup: true, min: setup.min, med: setup.med, max: setup.max };
        } else {
          const on = pickfaceOnHand;
          if (on < setup.min) normStatus = 'LOW';
          else if (on >= setup.min && on < setup.med) normStatus = 'MEDIUM';
          else if (on >= setup.med && on <= setup.max) normStatus = 'FULL';
          else if (on > setup.max) normStatus = 'OVER';
          else normStatus = 'CONFIGURE';
          restockQty = Math.max(0, setup.max - pickfaceOnHand);
        }

        const row = {
          sku,
          product: productName,
          stock_locator: stockLocator,
          on_hand: pickfaceOnHand,
          pickface_space: pickfaceSpace,
          restock_qty: restockQty,
          __norm_status: normStatus,
          __setup_info: setupInfo,
          __reserve_total: reserveTotal,
          __reserve_locations: reserveLocations,
          __notes: setup ? setup.notes : '',
          __avg_month_sales: avgSalesByName[productName.toUpperCase()] ?? null,
        };

        // Search filter (client-side)
        if (q) {
          const haystack = `${sku} ${productName} ${stockLocator}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        rows.push(row);
      }

      console.log(`📊 Re-Stock V2: ${rows.length} products loaded (${stockRows.length} stock rows, ${productRows.length} products, ${setupRows.length} setups)`);

      // Save all rows
      state.allRows = rows.slice();
      updateStatusCounters();

      // Apply filters & render
      rebuildView();

    } catch (e) {
      console.error('restock-v2 fetch error', e);
      setTbody(`<tr><td colspan="13" style="text-align:center;color:#b91c1c">Failed to load data: ${escapeHtml(e.message)}</td></tr>`);
    } finally {
      state.loading = false;
    }
  }

  /* ═══════════════════════════════════════════════
     SEARCH  (same as V1 + not-configured keyword)
     ═══════════════════════════════════════════════ */
  window.runRestockSearch = function () {
    const searchTerm = (input && input.value) || '';
    const searchLower = searchTerm.trim().toLowerCase();
    const keywords = {
      'adjustment': 'needs-adjustment', 'adjustments': 'needs-adjustment',
      'needs adjustment': 'needs-adjustment', 'needs adjustments': 'needs-adjustment',
      'favorites': 'favorites', 'favourite': 'favorites', 'favourites': 'favorites',
      'low': 'status-low', 'medium': 'status-medium', 'full': 'status-full', 'over': 'status-over',
      'clear locations': 'reserve-info',
      'not configured': 'status-not-configured', 'unconfigured': 'status-not-configured',
      'configured': 'only-configured', 'only configured': 'only-configured',
    };
    const matched = keywords[searchLower];
    if (matched) { handleKeywordFilter(matched); return; }
    state.onlyNeedsAdjustment = false;
    state.q = searchTerm;
    fetchData();
  };

  function handleKeywordFilter(keyword) {
    state.q = '';
    state.onlyNeedsAdjustment = false;
    state.onlyFavorites = false;
    state.onlyConfigured = false;
    state.onlyReserveInfo = false;
    state.statusFilter = 'ALL';
    switch (keyword) {
      case 'needs-adjustment': state.onlyNeedsAdjustment = true; break;
      case 'favorites':
        state.onlyFavorites = true;
        { const c = document.getElementById('toggleOnlyFavorites'); if (c) c.checked = true; }
        break;
      case 'status-low':
        state.statusFilter = 'LOW';
        window.setStatusFilter('LOW', document.querySelector('[data-status-filter="LOW"]'));
        break;
      case 'status-medium':
        state.statusFilter = 'MEDIUM';
        window.setStatusFilter('MEDIUM', document.querySelector('[data-status-filter="MEDIUM"]'));
        break;
      case 'status-full':
        state.statusFilter = 'FULL';
        window.setStatusFilter('FULL', document.querySelector('[data-status-filter="FULL"]'));
        break;
      case 'status-over':
        state.statusFilter = 'OVER';
        window.setStatusFilter('OVER', document.querySelector('[data-status-filter="OVER"]'));
        break;
      case 'status-not-configured':
        state.statusFilter = 'NOT_CONFIGURED';
        window.setStatusFilter('NOT_CONFIGURED', document.querySelector('[data-status-filter="NOT_CONFIGURED"]'));
        break;
      case 'reserve-info':
        state.onlyReserveInfo = true;
        { const c = document.getElementById('toggleOnlyReserveInfo'); if (c) c.checked = true; }
        break;
      case 'only-configured':
        state.onlyConfigured = true;
        { const c = document.getElementById('toggleOnlyConfigured'); if (c) c.checked = true; }
        break;
    }
    rebuildView();
  }

  /* ═══════════════════════════════════════════════
     INPUT listener
     ═══════════════════════════════════════════════ */
  const onInput = debounce(() => { state.q = (input && input.value) || ''; fetchData(); }, 350);
  if (input) {
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); window.runRestockSearch(); } });
  }

  /* ═══════════════════════════════════════════════
     INITIAL LOAD
     ═══════════════════════════════════════════════ */
  fetchData();

  /* ═══════════════════════════════════════════════
     PAGER controls
     ═══════════════════════════════════════════════ */
  window.restockPrevPage = function () { if (state.page > 1) { state.page--; render(state.rows); } };
  window.restockNextPage = function () { const tp = Math.max(1, Math.ceil(state.rows.length / state.perPage)); if (state.page < tp) { state.page++; render(state.rows); } };

  /* ═══════════════════════════════════════════════
     PRINT helpers
     ═══════════════════════════════════════════════ */
  let __beforePrintCache = null;
  window.restockPreparePrintView = function () {
    try {
      __beforePrintCache = { rows: state.rows.slice(), page: state.page, perPage: state.perPage };
      const start = (state.page - 1) * state.perPage;
      const subset = state.rows.slice(start, start + state.perPage);
      const sorter = (a, b) => {
        const pa = parseLocation(a.stock_locator) || { site:'', area:'', row:0, level:0, pos:0 };
        const pb = parseLocation(b.stock_locator) || { site:'', area:'', row:0, level:0, pos:0 };
        if (pa.site !== pb.site) return pa.site.localeCompare(pb.site);
        if (pa.area !== pb.area) return pa.area.localeCompare(pb.area);
        if (pa.row !== pb.row) return pa.row - pb.row;
        if (pa.level !== pb.level) return pa.level - pb.level;
        return pa.pos - pb.pos;
      };
      const sorted = subset.slice().sort(sorter);
      const prevPP = state.perPage;
      state.page = 1;
      state.perPage = sorted.length;
      render(sorted);
      state.perPage = prevPP;
    } catch {}
  };
  window.restockRestoreView = function () {
    try {
      if (__beforePrintCache) { state.page = __beforePrintCache.page; state.perPage = __beforePrintCache.perPage; render(__beforePrintCache.rows); }
      __beforePrintCache = null;
    } catch {}
  };

  /* ═══════════════════════════════════════════════
     FILTER toggle exposures
     ═══════════════════════════════════════════════ */
  window.restockSetStatusFilter = function (val) {
    state.statusFilter = String(val || 'ALL').toUpperCase();
    rebuildView();
  };
  window.restockGetAllRows = function () { return state.allRows || []; };
  window.restockToggleHideNoReserve = function (flag) { state.hideNoReserve = !!flag; rebuildView(); };
  window.restockToggleOnlyNeedsAdjustment = function (flag) { state.onlyNeedsAdjustment = !!flag; rebuildView(); };
  window.restockToggleOnlyFavorites = function (flag) { state.onlyFavorites = !!flag; rebuildView(); };
  window.restockToggleOnlyConfigured = function (flag) { state.onlyConfigured = !!flag; rebuildView(); };
  window.restockToggleOnlyReserveInfo = function (flag) { state.onlyReserveInfo = !!flag; rebuildView(); };
  window.restockToggleHideLocation = function (location, flag) { state.hideLocations[location] = !!flag; rebuildView(); };
  window.restockToggleReserveInfo = function (btn) { try { const wrap = btn && btn.closest('.reserve-cell'); if (wrap) wrap.classList.toggle('show'); } catch {} };

  /* ═══════════════════════════════════════════════
     FAVORITES toggle
     ═══════════════════════════════════════════════ */
  window.restockToggleFavorite = async function (sku) {
    const key = String(sku);
    const isAdding = !favorites.has(key);
    if (isAdding) favorites.add(key); else favorites.delete(key);
    updateFavoriteStars();
    await persistFavorites(key, isAdding);
    if (state.onlyFavorites) rebuildView();
  };
  function updateFavoriteStars() {
    if (!tbody) return;
    [...tbody.querySelectorAll('button.fav-btn')].forEach(btn => {
      const sk = btn.getAttribute('data-sku');
      const on = favorites.has(String(sk));
      btn.textContent = on ? '★' : '☆';
      btn.title = on ? 'Unfavorite' : 'Favorite';
    });
  }

  /* ═══════════════════════════════════════════════
     CRUD — Add / Edit / Delete  (shared restock_setup)
     ═══════════════════════════════════════════════ */
  let currentEditingSku = null;

  // V2: Add Product removed — products come from Cin7 API sync.
  // Use Edit to configure capacity thresholds for mirror products.

  window.openEditProductModal = function (sku) {
    currentEditingSku = sku;
    document.getElementById('addEditProductTitle').textContent = 'Edit Product';
    const product = state.allRows.find(r => String(r.sku) === String(sku));
    if (product) {
      const skuField = document.getElementById('productSku');
      skuField.value = product.sku || '';
      skuField.readOnly = true;
      skuField.style.backgroundColor = '#f8f9fa';
      document.getElementById('productName').value = product.product || '';
      document.getElementById('productPickface').value = product.stock_locator || '';
      loadProductSetupData(sku);
    }
    clearFormErrors();
    document.getElementById('addEditProductModal').classList.remove('hidden');
  };

  window.closeAddEditProductModal = function () {
    document.getElementById('addEditProductModal').classList.add('hidden');
    currentEditingSku = null;
  };

  window.openDeleteConfirmModal = function (sku) {
    const product = state.allRows.find(r => String(r.sku) === String(sku));
    const name = product ? product.product : 'this product';
    document.getElementById('deleteConfirmText').textContent = `Are you sure you want to delete "${name}" (SKU: ${sku})? This action cannot be undone.`;
    document.getElementById('confirmDeleteBtn').dataset.sku = sku;
    document.getElementById('deleteConfirmModal').classList.remove('hidden');
  };

  window.closeDeleteConfirmModal = function () {
    document.getElementById('deleteConfirmModal').classList.add('hidden');
  };

  window.confirmDelete = async function () {
    const sku = document.getElementById('confirmDeleteBtn').dataset.sku;
    if (!sku) return;
    try {
      await window.supabaseReady;
      const { error } = await window.supabase.from('restock_setup').delete().eq('sku', sku);
      if (error) { showToast('Error deleting: ' + error.message, 'error'); return; }
      showToast('Product deleted successfully', 'success');
      window.closeDeleteConfirmModal();
      fetchData();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  };

  async function loadProductSetupData(sku) {
    try {
      await window.supabaseReady;
      const { data, error } = await window.supabase.from('restock_setup').select('pickface_qty, cap_min, cap_med, cap_max, notes').eq('sku', sku).single();
      if (!error && data) {
        document.getElementById('productPickfaceQty').value = data.pickface_qty || '';
        document.getElementById('productCapMin').value = data.cap_min || '';
        document.getElementById('productCapMed').value = data.cap_med || '';
        document.getElementById('productCapMax').value = data.cap_max || '';
        const n = data.notes || '';
        document.getElementById('productNotes').value = n;
        document.getElementById('notesCharCount').textContent = n.length;
        window.updateMaxCapacity();
        window.validateCapacities();
      }
    } catch (e) { console.warn('Could not load setup for', sku, e); }
  }

  document.getElementById('addEditProductForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const fd = {
      sku: document.getElementById('productSku').value.trim(),
      product: document.getElementById('productName').value.trim(),
      pickface_location: document.getElementById('productPickface').value.trim(),
      pickface_qty: parseInt(document.getElementById('productPickfaceQty').value) || 0,
      cap_min: parseInt(document.getElementById('productCapMin').value) || 0,
      cap_med: parseInt(document.getElementById('productCapMed').value) || 0,
      cap_max: parseInt(document.getElementById('productCapMax').value) || 0,
      notes: document.getElementById('productNotes').value.trim()
    };
    if (!validateProductForm(fd)) return;

    try {
      await window.supabaseReady;
      if (currentEditingSku) {
        const { error } = await window.supabase.from('restock_setup').update({
          product: fd.product, pickface_location: fd.pickface_location, pickface_qty: fd.pickface_qty,
          cap_min: fd.cap_min, cap_med: fd.cap_med, cap_max: fd.cap_max, notes: fd.notes
        }).eq('sku', currentEditingSku);
        if (error) { showToast('Error updating: ' + error.message, 'error'); return; }
        showToast('Product updated successfully', 'success');
      } else {
        const { data: existing } = await window.supabase.from('restock_setup').select('sku').eq('sku', fd.sku).single();
        if (existing) { showToast('A product with this SKU already exists', 'error'); return; }
        const { error } = await window.supabase.from('restock_setup').insert([fd]);
        if (error) { showToast('Error adding: ' + error.message, 'error'); return; }
        showToast('Product added successfully', 'success');
      }
      window.closeAddEditProductModal();
      fetchData();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  });

  function validateProductForm(d) {
    clearFormErrors();
    let ok = true;
    if (!d.sku) { showFieldError('productSkuError', 'SKU is required'); ok = false; }
    if (!d.product) { showFieldError('productNameError', 'Product name is required'); ok = false; }
    if (!d.pickface_location) { showFieldError('productPickfaceError', 'Pickface location is required'); ok = false; }
    if (d.pickface_qty < 0) { showFieldError('productPickfaceQtyError', 'Must be ≥ 0'); ok = false; }
    if (d.cap_min < 0) { showFieldError('productCapMinError', 'Must be ≥ 0'); ok = false; }
    if (d.cap_med < 0) { showFieldError('productCapMedError', 'Must be ≥ 0'); ok = false; }
    if (d.cap_max < 0) { showFieldError('productCapMaxError', 'Must be ≥ 0'); ok = false; }
    if (d.cap_min > d.cap_med) { showFieldError('productCapMinError', 'Min > Med'); ok = false; }
    if (d.cap_med > d.cap_max) { showFieldError('productCapMedError', 'Med > Max'); ok = false; }
    if (d.cap_min > d.cap_max) { showFieldError('productCapMinError', 'Min > Max'); ok = false; }
    if (d.cap_max !== d.pickface_qty) { showFieldError('productCapMaxError', 'Must match Pickface Qty'); ok = false; }
    return ok;
  }

  function clearFormErrors() {
    document.querySelectorAll('#addEditProductModal .error').forEach(el => el.textContent = '');
    document.querySelectorAll('#addEditProductModal input[type="text"], #addEditProductModal input[type="number"]').forEach(inp => {
      inp.style.borderColor = '';
      inp.style.backgroundColor = inp.id === 'productCapMax' ? '#f3f4f6' : '';
    });
  }
  function showFieldError(id, msg) { const el = document.getElementById(id); if (el) el.textContent = msg; }

  function showToast(message, type) {
    let c = document.querySelector('.toast-container');
    if (!c) { c = document.createElement('div'); c.className = 'toast-container'; document.body.appendChild(c); }
    const t = document.createElement('div');
    t.className = `toast ${type || 'info'}`;
    t.textContent = message;
    c.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 5000);
  }

  window.updateMaxCapacity = function () {
    const pq = document.getElementById('productPickfaceQty').value;
    const mc = document.getElementById('productCapMax');
    mc.value = pq && !isNaN(pq) ? pq : '';
    window.validateCapacities();
  };

  window.validateCapacities = function () {
    const minV = document.getElementById('productCapMin').value;
    const medV = document.getElementById('productCapMed').value;
    const maxV = document.getElementById('productCapMax').value;
    const min = minV ? parseInt(minV) : 0;
    const med = medV ? parseInt(medV) : 0;
    const max = maxV ? parseInt(maxV) : 0;
    document.getElementById('productCapMinError').textContent = '';
    document.getElementById('productCapMedError').textContent = '';
    document.getElementById('productCapMaxError').textContent = '';
    ['productCapMin','productCapMed','productCapMax'].forEach(id => {
      const f = document.getElementById(id);
      f.style.borderColor = '';
      f.style.backgroundColor = id === 'productCapMax' ? '#f3f4f6' : '';
    });
    if (minV && medV && min > med) { showFieldError('productCapMinError', 'Min > Med'); document.getElementById('productCapMin').style.borderColor = '#dc2626'; return false; }
    if (medV && maxV && med > max) { showFieldError('productCapMedError', 'Med > Max'); document.getElementById('productCapMed').style.borderColor = '#dc2626'; return false; }
    if (minV && maxV && min > max) { showFieldError('productCapMinError', 'Min > Max'); document.getElementById('productCapMin').style.borderColor = '#dc2626'; return false; }
    if (minV && medV && maxV && min <= med && med <= max) {
      ['productCapMin','productCapMed'].forEach(id => { document.getElementById(id).style.borderColor = '#10b981'; });
    }
    return true;
  };

  /* ═══════════════════════════════════════════════
     DEBUG helpers
     ═══════════════════════════════════════════════ */
  window.debugSkuReserve = function (sku) {
    const row = state.allRows.find(r => String(r.sku) === String(sku));
    if (!row) { console.log('SKU not found'); return; }
    console.log('V2 row data:', { sku: row.sku, pickface: row.stock_locator, on_hand: row.on_hand, reserve_total: row.__reserve_total, reserve_locations: row.__reserve_locations, status: row.__norm_status });
    return row;
  };
  window.getTotalProducts = function () {
    const counts = {};
    state.allRows.forEach(r => { const s = r.__norm_status || 'UNKNOWN'; counts[s] = (counts[s] || 0) + 1; });
    console.log('📊 Re-Stock V2 Summary:', { total: state.allRows.length, visible: state.rows.length, byStatus: counts });
    console.table(counts);
    return { total: state.allRows.length, visible: state.rows.length, byStatus: counts };
  };

  console.log('✅ Re-Stock V2 loaded — data source: cin7_mirror');
})();
