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
    onlyCapacityReview: false,
    onlyPickfaceMismatch: false,
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
      setTbody('<tr><td colspan="16" style="text-align:center;opacity:.7">No results</td></tr>');
      updatePager(0);
      if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
      return;
    }
    const start = (state.page - 1) * state.perPage;
    const limited = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    // DEBUG: show first 5 capacity values
    const _capSample = limited.slice(0, 8).map(r => ({ sku: r.sku, pickface_space: r.pickface_space, status: r.__norm_status }));
    console.log('🔍 RENDER capacity check (first 8):', _capSample);

    const chunks = [];
    for (let i = 0; i < limited.length; i += 30) {
      const slice = limited.slice(i, i + 30);
      const rowsHtml = slice.map(r => {
        const skuKey = escapeHtml(r.sku);               // action identifier (5DC || product code)
        const fiveDC = escapeHtml(r.__5dc || '');        // 5-digit code column
        const skuDisplay = escapeHtml(r.__stock_sku || r.sku);  // cin7 product code (e.g. R6078-BK-TRI)
        const product = escapeHtml(r.product);           // product code (for reserve info lines)
        const productName = r.__full_description || r.product;  // full description or product code
        const productNameEsc = escapeHtml(productName);
        // Product cell: show description, truncated with tooltip if long
        const productHtml = productName.length > 50
          ? `<span title="${productNameEsc}" style="cursor:help">${escapeHtml(productName.substring(0, 48))}…</span>`
          : productNameEsc;
        const avgMth = r.__avg_month_sales;
        const avgMthHtml = avgMth != null ? `<span style="font-variant-numeric:tabular-nums">${Math.round(avgMth).toLocaleString()}</span>` : '<span style="opacity:.35">—</span>';
        const pickface = escapeHtml(r.stock_locator);
        // Mismatch badge: cin7 stock_locator ≠ setup pickface → yellow ⚠
        let pickfaceHtml = pickface;
        if (r.__pickface_mismatch && r.__cin7_stock_locator) {
          const mismatchTip = `<div>Cin7 Stock Locator: ${escapeHtml(r.__cin7_stock_locator)}</div>`;
          pickfaceHtml = `<span class="tip-cell" onclick="toggleTip(this)">${pickface} <span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:0 4px;font-size:11px;font-weight:700">!</span><div class="tip-pop">${mismatchTip}</div></span>`;
        }
        const onHand = r.on_hand ?? '';
        const capacity = r.pickface_space ?? '';

        // ── Capacity tooltip with weeks coverage ──
        const capWeeks = r.__capacity_weeks;
        const runWeeks = r.__runway_weeks;
        const avgM = r.__avg_month_sales;
        let capacityHtml;
        if (capacity === '' || capacity == null) {
          capacityHtml = '<span style="opacity:.35">—</span>';
        } else if (capWeeks != null && avgM != null) {
          const tipLines = [
            `Capacity ${capacity} ≈ ${capWeeks} wk at ${Math.round(avgM)}/mth`,
            `Stock (${r.on_hand}) ≈ ${runWeeks != null ? runWeeks : 0} wk`,
            capWeeks < 3 ? '⚠ Too small — consider larger pickface' : capWeeks < 4 ? '⚡ Borderline — review needed' : '✓ Healthy capacity',
          ];
          const borderColor = capWeeks < 3 ? '#ef4444' : capWeeks < 4 ? '#f59e0b' : '';
          const borderStyle = borderColor ? `border-left:3px solid ${borderColor};padding-left:6px;` : '';
          const tipHtml = tipLines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
          capacityHtml = `<span class="tip-cell" onclick="toggleTip(this)" style="${borderStyle}font-variant-numeric:tabular-nums">${escapeHtml(String(capacity))}<div class="tip-pop">${tipHtml}</div></span>`;
        } else {
          capacityHtml = `<span style="font-variant-numeric:tabular-nums">${escapeHtml(String(capacity))}</span>`;
        }

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
          const lines = chosen.map(x => `SKU: ${skuKey} — Product: ${product} — Location: ${escapeHtml(x.location)} — QTY: ${escapeHtml(x.qty)}`);
          const popHtml = lines.length ? `<div class="reserve-pop">${lines.map(l => `<span class="line">${l}</span>`).join('')}</div>` : '';
          reserveCellHtml = `<span class="reserve-cell">${reserveCellHtml}<button type="button" class="info-badge" aria-label="Reserve locations" onclick="restockToggleReserveInfo(this)">i</button>${popHtml}</span>`;
        }

        const nearestLines = computeNearestReserveLines(r.stock_locator, r.__reserve_locations);
        const nearestHtml = nearestLines.length ? nearestLines.map(l => `<div>${escapeHtml(l)}</div>`).join('') : '';
        const favOn = favorites.has(String(r.sku));
        const star = `<button type="button" class="fav-btn" aria-label="Toggle favorite" data-sku="${skuKey}" onclick="restockToggleFavorite('${skuKey}')" title="${favOn ? 'Unfavorite' : 'Favorite'}" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1">${favOn ? '★' : '☆'}</button>`;
        const actionButtons = `
          <div class="action-buttons">
            <button type="button" class="action-btn edit" onclick="openEditProductModal('${skuKey}')" title="Configure capacity" style="background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;border:none;padding:6px 12px;border-radius:8px;font-weight:600;cursor:pointer;min-width:50px;height:28px;display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:all .3s;font-size:13px">⚙ Edit</button>
            <button type="button" class="action-btn delete" onclick="openDeleteConfirmModal('${skuKey}')" title="Remove configuration" style="background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;border:none;padding:6px 10px;border-radius:8px;font-weight:600;cursor:pointer;min-width:40px;height:28px;display:inline-flex;align-items:center;justify-content:center;letter-spacing:.5px;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:all .3s;font-size:12px">✕</button>
          </div>`;
        const wrapText = (text, chunkSize) => { if (!text) return ''; const e = escapeHtml(text); const c = []; for (let j = 0; j < e.length; j += chunkSize) c.push(e.substring(j, j + chunkSize)); return c.join('<br>'); };
        const notesHtml = r.__notes ? wrapText(r.__notes, 10) : '';

        // Qty per CTN / Qty per Pallet
        const qtyCtnVal = r.__qty_per_ctn;
        const qtyPalletVal = r.__qty_per_pallet;
        const qtyCtnHtml = qtyCtnVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyCtnVal}</span>` : '<span style="opacity:.35">—</span>';
        const qtyPalletHtml = qtyPalletVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyPalletVal}</span>` : '<span style="opacity:.35">—</span>';

        return `<tr>
          <td>${star}</td>
          <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#64748b">${fiveDC}</td>
          <td>${skuDisplay}</td>
          <td>${productHtml}</td>
          <td>${avgMthHtml}</td>
          <td>${pickfaceHtml}</td>
          <td>${onHand}</td>
          <td>${capacityHtml}</td>
          <td>${statusChip(status, r.__setup_info)}</td>
          <td>${reserveCellHtml}</td>
          <td>${restock}</td>
          <td>${qtyCtnHtml}</td>
          <td>${qtyPalletHtml}</td>
          <td class="print-only">${nearestHtml}</td>
          <td class="print-only">${notesHtml}</td>
          <td class="no-print">${actionButtons}</td>
        </tr>`;
      }).join('');
      chunks.push(rowsHtml);
      if (i + 30 < limited.length) chunks.push('<tr class="print-break"><td colspan="16"></td></tr>');
    }
    setTbody(chunks.join(''));
    if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
  }

  /* ═══════════════════════════════════════════════
     COUNTERS (now includes NOT_CONFIGURED)
     ═══════════════════════════════════════════════ */
  function updateStatusCounters() {
    const allRows = state.allRows || [];
    const counts = { all: allRows.length, low: 0, medium: 0, full: 0, over: 0, not_configured: 0, capacity_review: 0, pickface_mismatch: 0 };
    allRows.forEach(row => {
      const s = String(row.__norm_status || '').toUpperCase();
      if (s === 'LOW') counts.low++;
      else if (s === 'MEDIUM') counts.medium++;
      else if (s === 'FULL' || s === 'OK') counts.full++;
      else if (s === 'OVER') counts.over++;
      else if (s === 'NOT_CONFIGURED') counts.not_configured++;
      if (row.__capacity_weeks != null && row.__capacity_weeks < 4) counts.capacity_review++;
      if (row.__pickface_mismatch) counts.pickface_mismatch++;
    });
    const u = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    u('countAll', counts.all);
    u('countLow', counts.low);
    u('countMedium', counts.medium);
    u('countFull', counts.full);
    u('countOver', counts.over);
    u('countNotConfigured', counts.not_configured);
    u('countCapacityReview', counts.capacity_review);
    u('countPickfaceMismatch', counts.pickface_mismatch);

    // Update the filters button badge
    const activeFilters = [];
    if (state.onlyFavorites) activeFilters.push('Favorites');
    if (state.onlyConfigured) activeFilters.push('Configured');
    if (state.onlyCapacityReview) activeFilters.push('Capacity < 4wk');
    if (state.onlyPickfaceMismatch) activeFilters.push('Mismatch');
    if (state.onlyReserveInfo) activeFilters.push('Clear loc.');
    if (state.hideNoReserve) activeFilters.push('Hide no-reserve');
    const hiddenLocs = Object.entries(state.hideLocations).filter(([,v]) => v).map(([k]) => k);
    if (hiddenLocs.length) activeFilters.push('Hide ' + hiddenLocs.length + ' loc');
    const badge = document.getElementById('filtersBadge');
    if (badge) { badge.textContent = activeFilters.length || ''; badge.style.display = activeFilters.length ? 'inline-flex' : 'none'; }
    // Active filter tags next to button
    const tagsEl = document.getElementById('activeFilterTags');
    if (tagsEl) {
      if (activeFilters.length === 0) { tagsEl.innerHTML = ''; }
      else { tagsEl.innerHTML = activeFilters.map(f => `<span style="display:inline-flex;align-items:center;gap:3px;background:#eef2ff;color:#4338ca;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid #c7d2fe;white-space:nowrap">${escapeHtml(f)}</span>`).join(''); }
    }
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
  function applyCapacityReviewFilter(rows) {
    if (!state.onlyCapacityReview) return rows;
    return rows.filter(r => r.__capacity_weeks != null && r.__capacity_weeks < 4);
  }
  function applyPickfaceMismatchFilter(rows) {
    if (!state.onlyPickfaceMismatch) return rows;
    return rows.filter(r => r.__pickface_mismatch);
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
    rows = applyCapacityReviewFilter(rows);
    rows = applyPickfaceMismatchFilter(rows);
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
  let _lastSyncEndedAt = null;

  function _refreshSyncCountdown() {
    const el = document.getElementById('syncCountdown');
    if (!el) return;
    const now = new Date();
    // Stock cron: minute 00 of every even hour (0:00, 2:00, 4:00, ...)
    let nextSync = new Date(now);
    nextSync.setSeconds(0, 0);
    nextSync.setMinutes(0);
    // Move to next hour if past :00
    if (now.getMinutes() > 0 || now.getSeconds() > 0) {
      nextSync.setHours(nextSync.getHours() + 1);
    }
    // Align to even hour
    while (nextSync.getHours() % 2 !== 0) {
      nextSync.setHours(nextSync.getHours() + 1);
    }
    if (nextSync <= now) nextSync.setHours(nextSync.getHours() + 2);

    const diffMs = nextSync - now;
    const diffMin = Math.floor(diffMs / 60000);
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    const countdown = h > 0 ? `${h}h ${m}m` : `${m}m`;
    el.textContent = `🛡️ Next sync in ${countdown}`;
    el.title = `Next stock sync at ${nextSync.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}. Auto-sync every 2h at :00.`;
  }

  function _refreshSyncAge() {
    const ageEl = document.getElementById('syncStatusAge');
    if (!ageEl || !_lastSyncEndedAt) return;
    const agoMs = Date.now() - new Date(_lastSyncEndedAt).getTime();
    const agoMin = Math.floor(agoMs / 60000);
    let agoStr;
    if (agoMin < 1) agoStr = 'just now';
    else if (agoMin < 60) agoStr = `${agoMin}m ago`;
    else {
      const agoH = Math.floor(agoMin / 60);
      const remM = agoMin % 60;
      agoStr = remM > 0 ? `${agoH}h ${remM}m ago` : `${agoH}h ago`;
    }
    ageEl.textContent = agoStr;
    ageEl.style.color = agoMin > 180 ? '#ef4444' : agoMin > 130 ? '#f59e0b' : '#94a3b8';
    ageEl.style.fontWeight = agoMin > 130 ? '600' : '400';
  }

  // Auto-refresh countdown + age every 60s
  setInterval(() => { _refreshSyncAge(); _refreshSyncCountdown(); }, 60000);
  _refreshSyncCountdown();

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
        .select('run_id, started_at, ended_at, status, sync_type, products_synced, stock_rows_synced, duration_ms')
        .order('ended_at', { ascending: false })
        .limit(1);

      if (error) {
        // Schema may not be exposed yet — show subtle info instead of alarming warning
        dot.style.background = '#94a3b8';
        text.textContent = 'Sync status unavailable — cin7_mirror schema needs to be exposed in Supabase API settings';
        text.style.color = '#64748b';
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

      // Count metrics (columns are flat, not nested)
      const prodCount = run.products_synced || 0;
      const stockCount = run.stock_rows_synced || 0;
      const duration = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '';

      // Format time for prominent display
      const pad = n => String(n).padStart(2, '0');
      let timeStr = '';
      const ts = run.ended_at || run.started_at;
      if (ts) {
        const d = new Date(ts);
        timeStr = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }

      const statusLabel = isSuccess ? 'Last sync successful' : isRunning ? 'Sync running…' : 'Last sync failed';
      text.textContent = `${statusLabel}${prodCount ? ` • ${prodCount} products, ${stockCount} stock rows` : ''}${duration ? ` • ${duration}` : ''}`;
      text.style.color = isSuccess ? '#166534' : isRunning ? '#1d4ed8' : '#991b1b';

      // Show time prominently
      if (timeStr) {
        time.textContent = `Stock data from: ${timeStr}`;
      }

      // Track for live age refresh
      if (run.ended_at) {
        _lastSyncEndedAt = run.ended_at;
        _refreshSyncAge();
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
      setTbody('<tr><td colspan="16" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>');
      return;
    }
    state.loading = true;
    setTbody('<tr><td colspan="16" style="text-align:center;opacity:.7">Loading from Cin7 mirror…</td></tr>');

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
        setTbody(`<tr><td colspan="16" style="text-align:center;color:#64748b;padding:30px">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">Setup Required</div>
          <div style="font-size:13px;color:#94a3b8">Expose <code>cin7_mirror</code> in Supabase Dashboard → Settings → API → Exposed schemas,<br>then run <code>node cin7-stock-sync/sync-service.js</code> to populate stock data.</div>
        </td></tr>`);
        state.loading = false;
        return;
      }

      /* ── 3. Fetch cin7_mirror.products (includes attribute1 = 5DC from Cin7) ── */
      let productRows = [];
      try {
        productRows = await fetchAllRows('products', 'sku, name, stock_locator, category, brand, barcode, attribute1', {
          schema: 'cin7_mirror',
        });
      } catch (e) {
        console.warn('⚠️ Could not read cin7_mirror.products:', e.message);
      }

      /* ── 4. Fetch restock_setup (shared with V1) ── */
      const setupRows = await fetchAllRows('restock_setup', '*');

      /* ── 5. Fetch user_favorites ── */
      await loadFavoritesFromDB();

      /* ── 6. Fetch branch_avg_monthly_sales (avg_mth_main) ── */
      let avgSalesRows = [];
      try {
        avgSalesRows = await fetchAllRows('branch_avg_monthly_sales', 'product, avg_mth_main');
      } catch (e) {
        console.warn('⚠️ Could not read branch_avg_monthly_sales:', e.message);
      }

      /* ── 7. Fetch pallet_capacity_rules (for insights) ── */
      let palletRulesRows = [];
      try {
        palletRulesRows = await fetchAllRows('pallet_capacity_rules', 'product, sku, qty_pallet');
      } catch (e) {
        console.warn('⚠️ Could not read pallet_capacity_rules:', e.message);
      }

      /* ── Build lookup maps ── */
      const productMap = Object.create(null);
      for (const p of productRows) productMap[p.sku] = p;

      const avgSalesByName = Object.create(null);
      for (const a of avgSalesRows) {
        if (a.product) avgSalesByName[a.product.toUpperCase()] = Number(a.avg_mth_main) || 0;
      }

      // ── Pallet capacity lookup: product code → qty_pallet ──
      const palletCapacity = Object.create(null);
      for (const r of palletRulesRows) {
        const key = (r.product || r.sku || '').trim();
        if (key && r.qty_pallet) palletCapacity[key] = Number(r.qty_pallet) || 0;
      }

      // ── Setup lookup: index by PRODUCT CODE (not 5DC) ──
      // restock_setup.sku = 5-digit code (internal Cin7 Attribute1, e.g. "31471")
      // restock_setup.product = product code (Cin7 SKU field, e.g. "R6078-BK-TRI")
      // cin7_mirror.stock_snapshot.sku = product code (e.g. "R6078-BK-TRI")
      // So the join key is: setup.product = stock.sku
      const setupByProduct = Object.create(null);   // keyed by product code → matches stock.sku
      const setupBy5DC     = Object.create(null);   // keyed by 5DC → for reverse lookups
      for (const s of setupRows) {
        // Clean product code: some rows have "30290  R2101-WH-WW" format — extract the code part
        let productCode = (s.product || '').trim();
        // If product field contains "5DC  CODE" pattern, extract the CODE part
        const spaceMatch = productCode.match(/^\d{4,6}\s+(.+)$/);
        if (spaceMatch) productCode = spaceMatch[1].trim();

        const entry = {
          sku5dc: String(s.sku || ''),          // 5-digit code
          productCode: productCode,              // product code (cleaned)
          pickface_location: s.pickface_location || '',
          pickface_qty: Number(s.pickface_qty) || 0,
          min: Number(s.cap_min),
          med: Number(s.cap_med),
          max: Number(s.cap_max),
          notes: s.notes || '',
          qty_per_ctn: s.qty_per_ctn != null ? Number(s.qty_per_ctn) : null,
          qty_per_pallet: s.qty_per_pallet != null ? Number(s.qty_per_pallet) : null,
        };
        if (productCode) setupByProduct[productCode] = entry;
        if (s.sku) setupBy5DC[s.sku] = entry;
      }

      // ── Merge restock_setup.qty_per_pallet into palletCapacity (higher priority) ──
      for (const key of Object.keys(setupByProduct)) {
        const s = setupByProduct[key];
        if (s.qty_per_pallet) {
          palletCapacity[key] = s.qty_per_pallet;
          if (s.sku5dc) palletCapacity[s.sku5dc] = s.qty_per_pallet;
        }
      }

      /* ── Group stock by SKU ── */
      const stockBySku = Object.create(null);
      for (const s of stockRows) {
        if (!s.sku) continue;
        if (!stockBySku[s.sku]) stockBySku[s.sku] = [];
        stockBySku[s.sku].push(s);
      }

      /* ── Build rows from STOCK SKUs only (like V1 uses restock_view) ── */
      /* SKUs only in restock_setup but NOT in Main Warehouse stock are excluded */
      const q = (state.q || '').trim().toLowerCase();

      const rows = [];
      // Debug stats
      const _dbg = { total: 0, binMatch: 0, totalFallback: 0, noPickface: 0, zeroStock: 0 };
      window.__v2PickfaceMisses = [];

      for (const stockSku of Object.keys(stockBySku)) {
        const prod  = productMap[stockSku] || {};
        // JOIN: setup.product (product code) = stock.sku (product code)
        const setup = setupByProduct[stockSku];
        const stocks = stockBySku[stockSku] || [];
        _dbg.total++;

        // ── Display identifiers ──
        // V1 convention:  SKU column = 5-digit code,  Product column = product code (e.g. R6078-BK-TRI)
        // V2 follows the same convention for consistency.
        // cin7_mirror.products.name has the full description → shown as tooltip
        // 5DC source priority: 1) restock_setup.sku  2) cin7_mirror.products.attribute1
        const display5DC     = (setup ? setup.sku5dc : '') || (prod.attribute1 || '').trim();
        const displayProduct = setup ? setup.productCode : stockSku;  // product code (matches V1)
        const fullDescription = prod.name || '';                       // long description → tooltip

        // ── Pickface source ──
        // Priority: restock_setup.pickface_location (user-configured) > cin7_mirror.products.stock_locator
        const setupPickface = setup ? (setup.pickface_location || '').trim() : '';
        const cin7Locator   = (prod.stock_locator || '').trim();
        const pickfaceSource = setupPickface || cin7Locator;
        const normPickface   = normalizeLocation(pickfaceSource);

        // Mismatch: cin7 stock_locator ≠ setup pickface_location (different pick bay)
        const pickfaceMismatch = !!(setupPickface && cin7Locator
          && normalizeLocation(setupPickface) !== normalizeLocation(cin7Locator));

        // Product name for avg sales lookup
        const productName = fullDescription || displayProduct;

        // ═══════════════════════════════════════════════════════════════
        // COMPUTE ON_HAND AT PICKFACE  (replicating V1 logic)
        //
        // V1 approach: restock_view returns ONE row per SKU with on_hand
        // at the pickface location. The DB view joins restock_report.location
        // with restock_setup.pickface_location.
        //
        // V2 approach: we have all bins from stock_snapshot. We need to:
        //   1. Find the bin that matches the pickface → pickface on_hand
        //   2. Other bins → reserve
        //   3. If no bin matches → use TOTAL on_hand as pickface (fallback)
        //      This handles: no bin tracking, bin format mismatch, etc.
        // ═══════════════════════════════════════════════════════════════

        let pickfaceOnHand = 0;
        const reserveLocations = [];
        let matchMethod = 'none';

        // Total on_hand across ALL bins (ultimate fallback)
        const totalOnHand = stocks.reduce((sum, s) => sum + (Number(s.on_hand) || 0), 0);

        if (!normPickface) {
          // No pickface defined → total = on_hand (can't distinguish)
          pickfaceOnHand = totalOnHand;
          matchMethod = 'no-pickface';
          _dbg.noPickface++;
        } else {
          // Try to match bins to the configured pickface
          let matched = false;

          for (const s of stocks) {
            const binVal = (s.bin || '').trim();
            const normBin = normalizeLocation(binVal);

            // Match strategies: exact, suffix, contains
            const isPickface = normBin && (
              normBin === normPickface ||
              normPickface.endsWith(normBin) ||
              normBin.endsWith(normPickface)
            );

            if (isPickface) {
              pickfaceOnHand += Number(s.on_hand) || 0;
              matched = true;
            } else if (binVal) {
              // Non-matching bin with stock → reserve
              const oh = Number(s.on_hand) || 0;
              if (oh !== 0) {
                reserveLocations.push({ location: binVal, qty: oh });
              }
            }
            // Empty-bin entries: handled in fallback below
          }

          if (matched) {
            matchMethod = 'bin-match';
            _dbg.binMatch++;
            // Unbinned entries → unassigned reserve
            for (const s of stocks) {
              if (!(s.bin || '').trim()) {
                const oh = Number(s.on_hand) || 0;
                if (oh !== 0) reserveLocations.push({ location: 'Unassigned', qty: oh });
              }
            }
          } else {
            // ── FALLBACK: no bin matched the pickface ──
            // Use TOTAL on_hand as pickface stock.
            // This handles:
            //   a) No bin tracking (all bins empty) → total IS the pickface
            //   b) Bin format mismatch → total as best approximation
            // Same behavior as V1 when Excel only has one row per SKU.
            pickfaceOnHand = totalOnHand;
            reserveLocations.length = 0;
            matchMethod = totalOnHand > 0 ? 'total-fallback' : 'zero';
            if (totalOnHand > 0) _dbg.totalFallback++;
            else _dbg.zeroStock++;

            // Log mismatches for debugging (first 30)
            if (setup && totalOnHand > 0 && window.__v2PickfaceMisses.length < 30) {
              window.__v2PickfaceMisses.push({
                sku: stockSku, pickface: pickfaceSource, normPickface,
                bins: stocks.map(s => ({ bin: s.bin || '(empty)', on_hand: Number(s.on_hand) || 0 })),
              });
            }
          }
        }

        const reserveTotal = reserveLocations.reduce((sum, l) => sum + (l.qty || 0), 0);

        // ── Capacity / Status ──
        const pickfaceSpace = setup ? setup.pickface_qty : null;
        let restockQty = 0;
        let normStatus = '';
        let setupInfo = null;

        if (!setup || !Number.isFinite(setup.min) || !Number.isFinite(setup.med) || !Number.isFinite(setup.max)) {
          normStatus = 'NOT_CONFIGURED';
          setupInfo = { sku: stockSku, hasSetup: !!setup, min: setup ? setup.min : undefined, med: setup ? setup.med : undefined, max: setup ? setup.max : undefined };
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
          sku: display5DC || stockSku,          // action key (5DC when available, else product code)
          __5dc: display5DC,                       // 5-digit code (empty if not configured)
          product: displayProduct,               // product code (e.g. R6078-BK-TRI) — matches V1
          __stock_sku: stockSku,                 // always the cin7 product code (join key)
          __full_description: fullDescription,   // cin7 product description (for tooltip)
          stock_locator: pickfaceSource,
          on_hand: pickfaceOnHand,
          pickface_space: pickfaceSpace,
          restock_qty: restockQty,
          __norm_status: normStatus,
          __setup_info: setupInfo,
          __reserve_total: reserveTotal,
          __reserve_locations: reserveLocations,
          __notes: setup ? setup.notes : '',
          __qty_per_ctn: setup ? setup.qty_per_ctn : null,
          __qty_per_pallet: setup ? setup.qty_per_pallet : null,
          __avg_month_sales: avgSalesByName[displayProduct.toUpperCase()] ?? null,
          __pickface_mismatch: pickfaceMismatch,
          __cin7_stock_locator: cin7Locator,
          __match_method: matchMethod,
        };

        // ── Capacity coverage (weeks of stock) ──
        const avgMthVal = row.__avg_month_sales;
        const avgWeekly = avgMthVal != null && avgMthVal > 0 ? avgMthVal / 4.33 : null;
        // Capacity coverage: how many weeks does a FULL pickface last?
        const capMax = setup ? setup.max : 0;
        row.__capacity_weeks = avgWeekly && capMax > 0 ? Math.round((capMax / avgWeekly) * 10) / 10 : null;
        // Current runway: how many weeks does current on_hand last?
        row.__runway_weeks = avgWeekly && pickfaceOnHand > 0 ? Math.round((pickfaceOnHand / avgWeekly) * 10) / 10 : null;

        // Search filter (client-side)
        if (q) {
          const haystack = `${display5DC} ${stockSku} ${displayProduct} ${pickfaceSource}`.toLowerCase();
          if (!haystack.includes(q)) continue;
        }

        rows.push(row);
      }

      // ── JOIN diagnostics ──
      const setupProductKeys = Object.keys(setupByProduct).length;
      const configuredCount = rows.filter(r => r.__norm_status !== 'NOT_CONFIGURED').length;
      const notConfiguredCount = rows.filter(r => r.__norm_status === 'NOT_CONFIGURED').length;

      console.log(`📊 Re-Stock V2: ${rows.length} rows (${configuredCount} configured, ${notConfiguredCount} NOT_CONFIGURED)`);
      console.log(`📊 V2 Data: ${stockRows.length} stock rows → ${Object.keys(stockBySku).length} unique SKUs, ${productRows.length} cin7 products, ${setupRows.length} setups (${setupProductKeys} join-ready by product code)`);
      console.log('📊 V2 Pickface match stats:', _dbg);

      // Debug: status distribution
      const statusDist = {};
      rows.forEach(r => { const s = r.__norm_status || '?'; statusDist[s] = (statusDist[s] || 0) + 1; });
      console.log('📊 V2 Status distribution:', statusDist);

      // Sample: first 3 configured rows
      const sampleConfigured = rows.filter(r => r.__norm_status !== 'NOT_CONFIGURED').slice(0, 3);
      console.log('📊 V2 Sample configured rows:', sampleConfigured.map(r => ({
        sku: r.sku, product: r.product, on_hand: r.on_hand, capacity: r.pickface_space, status: r.__norm_status, method: r.__match_method, pickface: r.stock_locator,
      })));

      // Debug: pickface mismatches
      if (window.__v2PickfaceMisses.length > 0) {
        console.warn(`⚠️ V2: ${window.__v2PickfaceMisses.length} configured SKUs used total-fallback (no bin matched pickface):`, window.__v2PickfaceMisses);
      }

      // Debug: sample data inspection (first 5 rows with stock)
      const sampleWithStock = rows.filter(r => r.on_hand > 0).slice(0, 5);
      console.log('📊 V2 Sample rows with stock:', sampleWithStock.map(r => ({
        sku: r.sku, on_hand: r.on_hand, pickface: r.stock_locator, status: r.__norm_status, method: r.__match_method
      })));

      // Save all rows
      state.allRows = rows.slice();
      state.palletCapacity = palletCapacity;
      state.setupByProduct = setupByProduct;
      updateStatusCounters();

      // Apply filters & render
      rebuildView();

      // Generate stock insights (Redistribute + Consolidate)
      generateInsights();

    } catch (e) {
      console.error('restock-v2 fetch error', e);
      setTbody(`<tr><td colspan="16" style="text-align:center;color:#b91c1c">Failed to load data: ${escapeHtml(e.message)}</td></tr>`);
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
    state.onlyCapacityReview = false;
    state.onlyPickfaceMismatch = false;
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
  window.restockToggleCapacityReview = function (flag) { state.onlyCapacityReview = !!flag; rebuildView(); };
  window.restockTogglePickfaceMismatch = function (flag) { state.onlyPickfaceMismatch = !!flag; rebuildView(); };
  window.restockToggleHideLocation = function (location, flag) { state.hideLocations[location] = !!flag; rebuildView(); };
  window.restockToggleReserveInfo = function (btn) { try { const wrap = btn && btn.closest('.reserve-cell'); if (wrap) wrap.classList.toggle('show'); } catch {} };

  /* Toggle custom tooltip popover (Pickface / Capacity) */
  window.toggleTip = function (el) {
    const wrap = el.classList.contains('tip-cell') ? el : el.closest('.tip-cell');
    if (!wrap) return;
    const isOpen = wrap.classList.contains('show');
    // Close all open tooltips first
    document.querySelectorAll('.tip-cell.show').forEach(e => e.classList.remove('show'));
    if (!isOpen) {
      wrap.classList.add('show');
      setTimeout(() => wrap.classList.remove('show'), 4000);
      const close = (ev) => { if (!wrap.contains(ev.target)) { wrap.classList.remove('show'); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 10);
    }
  };

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
    const row = state.allRows.find(r => String(r.sku) === String(sku));
    if (!row) { showToast('Product not found', 'error'); return; }

    document.getElementById('addEditProductTitle').textContent = 'Configure Capacity';

    // Read-only info fields
    const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v || '—'; };
    el('editInfo5DC', row.__5dc || '');
    el('editInfoSKU', row.__stock_sku || row.product);
    el('editInfoProduct', row.__full_description || row.product);
    el('editInfoOnHand', row.on_hand != null ? String(row.on_hand) : '—');
    el('editInfoAvgMth', row.__avg_month_sales != null ? Math.round(row.__avg_month_sales).toLocaleString() + '/mth' : 'No data');
    el('editInfoQtyCtn', row.__qty_per_ctn != null ? String(row.__qty_per_ctn) : '—');
    el('editInfoQtyPallet', row.__qty_per_pallet != null ? String(row.__qty_per_pallet) : '—');

    // Coverage info (dynamic, updated on capacity input)
    window.__editRowRef = row;
    updateEditCoverageInfo();

    // Editable fields
    document.getElementById('productPickface').value = row.stock_locator || '';
    loadProductSetupData(sku);

    clearFormErrors();
    document.getElementById('addEditProductModal').classList.remove('hidden');
  };

  window.closeAddEditProductModal = function () {
    document.getElementById('addEditProductModal').classList.add('hidden');
    currentEditingSku = null;
  };

  window.openDeleteConfirmModal = function (sku) {
    const row = state.allRows.find(r => String(r.sku) === String(sku));
    const dc = row ? (row.__5dc || '') : '';
    const skuCode = row ? (row.__stock_sku || row.product || '') : '';
    const displayLabel = dc ? `${dc} — ${skuCode}` : skuCode || 'this product';
    const isConfigured = row && row.__norm_status !== 'NOT_CONFIGURED';
    if (!isConfigured) {
      showToast('This product is already not configured', 'info');
      return;
    }
    document.getElementById('deleteConfirmText').innerHTML = `Remove capacity configuration for <strong>${escapeHtml(displayLabel)}</strong>?<br><br><span style="font-size:13px;color:#64748b">The product will become <strong>Not Configured</strong>. No data is deleted — you can reconfigure it anytime via Edit.</span>`;
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
      // Deconfigure: clear capacity fields (don't delete the row)
      const { error } = await window.supabase.from('restock_setup').update({
        pickface_qty: null, cap_min: null, cap_med: null, cap_max: null
      }).eq('sku', sku);
      if (error) {
        // If row doesn't exist, nothing to deconfigure
        showToast('Could not deconfigure: ' + error.message, 'error');
        return;
      }
      showToast('Capacity removed — product is now Not Configured', 'success');
      window.closeDeleteConfirmModal();
      fetchData();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  };

  async function loadProductSetupData(sku) {
    try {
      await window.supabaseReady;
      const { data, error } = await window.supabase.from('restock_setup').select('*').eq('sku', sku).single();
      if (!error && data) {
        document.getElementById('productPickfaceQty').value = data.pickface_qty || '';
        document.getElementById('productCapMin').value = data.cap_min || '';
        document.getElementById('productCapMed').value = data.cap_med || '';
        document.getElementById('productCapMax').value = data.cap_max || '';
        const n = data.notes || '';
        document.getElementById('productNotes').value = n;
        document.getElementById('notesCharCount').textContent = n.length;
        // Qty per CTN / Pallet
        const qcEl = document.getElementById('productQtyPerCtn');
        const qpEl = document.getElementById('productQtyPerPallet');
        if (qcEl) qcEl.value = data.qty_per_ctn || '';
        if (qpEl) qpEl.value = data.qty_per_pallet || '';
        window.updateMaxCapacity();
        window.validateCapacities();
      }
    } catch (e) { console.warn('Could not load setup for', sku, e); }
  }

  document.getElementById('addEditProductForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    const row = window.__editRowRef;
    const fd = {
      sku: row ? (row.__5dc || row.sku) : currentEditingSku,
      product: row ? (row.__stock_sku || row.product) : '',
      pickface_location: document.getElementById('productPickface').value.trim(),
      pickface_qty: parseInt(document.getElementById('productPickfaceQty').value) || 0,
      cap_min: parseInt(document.getElementById('productCapMin').value) || 0,
      cap_med: parseInt(document.getElementById('productCapMed').value) || 0,
      cap_max: parseInt(document.getElementById('productCapMax').value) || 0,
      notes: document.getElementById('productNotes').value.trim(),
      qty_per_ctn: parseInt(document.getElementById('productQtyPerCtn').value) || null,
      qty_per_pallet: parseInt(document.getElementById('productQtyPerPallet').value) || null
    };
    if (!validateProductForm(fd)) return;

    try {
      await window.supabaseReady;
      if (currentEditingSku) {
        // Check if row exists
        const { data: existing } = await window.supabase.from('restock_setup').select('sku').eq('sku', currentEditingSku).maybeSingle();
        if (existing) {
          const updateData = {
            product: fd.product, pickface_location: fd.pickface_location, pickface_qty: fd.pickface_qty,
            cap_min: fd.cap_min, cap_med: fd.cap_med, cap_max: fd.cap_max, notes: fd.notes
          };
          // Add new columns if they have values (graceful if columns don't exist yet)
          if (fd.qty_per_ctn != null) updateData.qty_per_ctn = fd.qty_per_ctn;
          if (fd.qty_per_pallet != null) updateData.qty_per_pallet = fd.qty_per_pallet;
          let { error } = await window.supabase.from('restock_setup').update(updateData).eq('sku', currentEditingSku);
          // If error is about missing column, retry without new fields
          if (error && error.message && error.message.includes('column')) {
            delete updateData.qty_per_ctn;
            delete updateData.qty_per_pallet;
            const retry = await window.supabase.from('restock_setup').update(updateData).eq('sku', currentEditingSku);
            error = retry.error;
          }
          if (error) { showToast('Error updating: ' + error.message, 'error'); return; }
        } else {
          // Insert new setup row
          const insertData = { ...fd };
          if (insertData.qty_per_ctn == null) delete insertData.qty_per_ctn;
          if (insertData.qty_per_pallet == null) delete insertData.qty_per_pallet;
          let { error } = await window.supabase.from('restock_setup').insert([insertData]);
          if (error && error.message && error.message.includes('column')) {
            delete insertData.qty_per_ctn;
            delete insertData.qty_per_pallet;
            const retry = await window.supabase.from('restock_setup').insert([insertData]);
            error = retry.error;
          }
          if (error) { showToast('Error creating: ' + error.message, 'error'); return; }
        }
        showToast('Capacity configured successfully', 'success');
      }
      window.closeAddEditProductModal();
      fetchData();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  });

  function validateProductForm(d) {
    clearFormErrors();
    let ok = true;
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
    updateEditCoverageInfo();
  };

  function updateEditCoverageInfo() {
    const el = document.getElementById('editCoverageInfo');
    if (!el) return;
    const row = window.__editRowRef;
    const avg = row ? row.__avg_month_sales : null;
    const cap = parseInt(document.getElementById('productPickfaceQty')?.value) || 0;
    if (!avg || avg <= 0 || !cap) {
      el.innerHTML = '<span style="color:#94a3b8;font-size:12px">Enter Pickface Qty to see coverage estimate</span>';
      return;
    }
    const weeklyRate = avg / 4.33;
    const weeks = cap / weeklyRate;
    const weeksRound = Math.round(weeks * 10) / 10;
    const color = weeks < 3 ? '#ef4444' : weeks < 4 ? '#f59e0b' : '#22c55e';
    const icon = weeks < 3 ? '🔴' : weeks < 4 ? '🟡' : '🟢';
    el.innerHTML = `<span style="color:${color};font-weight:600">${icon} ${weeksRound} weeks</span> of stock at ${Math.round(avg)}/mth avg`;
  }

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

  /* ═══════════════════════════════════════════════
     COLUMN VISIBILITY SETTINGS
     ═══════════════════════════════════════════════ */
  const COL_SETTINGS_KEY = 'restockV2_hiddenColumns';
  const TOGGLEABLE_COLS = [
    { idx: 1,  label: '5DC' },
    { idx: 2,  label: 'SKU' },
    { idx: 3,  label: 'Product' },
    { idx: 4,  label: 'AVG/mth' },
    { idx: 5,  label: 'Pickface' },
    { idx: 6,  label: 'On Hand' },
    { idx: 7,  label: 'Capacity' },
    { idx: 8,  label: 'Status' },
    { idx: 9,  label: 'Reserve' },
    { idx: 10, label: 'Restock' },
    { idx: 11, label: 'Qty/CTN' },
    { idx: 12, label: 'Qty/Pallet' }
  ];

  function getHiddenColumns() {
    try { return JSON.parse(localStorage.getItem(COL_SETTINGS_KEY)) || []; }
    catch { return []; }
  }
  function saveHiddenColumns(arr) {
    localStorage.setItem(COL_SETTINGS_KEY, JSON.stringify(arr));
  }

  function applyColumnVisibility() {
    const hidden = getHiddenColumns();
    const wrapper = document.getElementById('restockTable')?.closest('.table-wrapper') || document.body;
    TOGGLEABLE_COLS.forEach(c => {
      wrapper.classList.toggle('col-hidden-' + c.idx, hidden.includes(c.idx));
    });
  }

  function buildColumnToggles() {
    const container = document.getElementById('columnToggles');
    if (!container) return;
    const hidden = getHiddenColumns();
    container.innerHTML = TOGGLEABLE_COLS.map(c => {
      const checked = !hidden.includes(c.idx) ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;color:#1e293b;background:${hidden.includes(c.idx) ? '#f8fafc' : '#f0f9ff'};border:1px solid ${hidden.includes(c.idx) ? '#e2e8f0' : '#bfdbfe'}">
        <input type="checkbox" ${checked} onchange="toggleColumnVisibility(${c.idx}, this.checked)" style="accent-color:#3b82f6;width:16px;height:16px">
        <span>${c.label}</span>
      </label>`;
    }).join('');
  }

  window.toggleColumnVisibility = function (idx, visible) {
    const hidden = getHiddenColumns();
    const newHidden = visible ? hidden.filter(i => i !== idx) : [...hidden.filter(i => i !== idx), idx];
    saveHiddenColumns(newHidden);
    applyColumnVisibility();
    // Update toggle styling
    buildColumnToggles();
  };

  window.openColumnSettingsModal = function () {
    buildColumnToggles();
    document.getElementById('columnSettingsModal').classList.remove('hidden');
  };
  window.closeColumnSettingsModal = function () {
    document.getElementById('columnSettingsModal').classList.add('hidden');
  };
  window.resetColumnSettings = function () {
    saveHiddenColumns([]);
    applyColumnVisibility();
    buildColumnToggles();
  };

  // Apply saved column visibility on load
  applyColumnVisibility();

  /* ═══════════════════════════════════════════════
     STOCK INSIGHTS — Redistribute + Consolidate
     Uses the same data V2 already loads (cin7_mirror).
     ═══════════════════════════════════════════════ */
  const insightState = {
    redistribute: [],
    consolidate: [],
    activeTab: 'redistribute',
    page: 1,
    perPage: 5,
    collapsed: false,
  };

  function generateInsights() {
    const rows = state.allRows || [];
    const palletCap = state.palletCapacity || {};
    const setupMap = state.setupByProduct || {};

    const redistributeInsights = [];
    const consolidateInsights = [];

    for (const row of rows) {
      const stockSku = row.__stock_sku || row.product;
      const setup = setupMap[stockSku];
      if (!setup || !Number.isFinite(setup.max)) continue;

      const palletQty = palletCap[stockSku] || palletCap[row.__5dc] || 0;
      const reserveLocs = row.__reserve_locations || [];
      const pickfaceOnHand = row.on_hand || 0;
      const capMax = setup.max;

      // ── REDISTRIBUTE: Pickface OVER capacity + reserve bins that are under ──
      if (pickfaceOnHand > capMax && palletQty > 0 && reserveLocs.length > 0) {
        const excess = pickfaceOnHand - capMax;
        // Find bins that are under pallet capacity
        const underBins = reserveLocs
          .filter(l => l.qty > 0 && l.qty < palletQty)
          .map(l => ({ location: l.location, qty: l.qty, missing: palletQty - l.qty }))
          .sort((a, b) => a.missing - b.missing);

        if (underBins.length > 0) {
          let remaining = excess;
          const completable = [];
          for (const bin of underBins) {
            if (remaining >= bin.missing) {
              completable.push(bin);
              remaining -= bin.missing;
            }
          }
          if (completable.length > 0) {
            const totalToMove = completable.reduce((s, b) => s + b.missing, 0);
            redistributeInsights.push({
              sku: stockSku,
              display5dc: row.__5dc || '',
              product: row.__full_description || row.product,
              pickfaceExcess: excess,
              palletQty,
              completableBins: completable,
              remainingExcess: remaining,
              incompleteBins: underBins.length - completable.length,
              totalToMove,
            });
          }
        }
      }

      // ── CONSOLIDATE: 2+ partial reserve bins → can merge into ~1 pallet ──
      if (palletQty > 0 && reserveLocs.length >= 2) {
        const partials = reserveLocs
          .filter(l => l.qty > 0 && l.qty < palletQty)
          .map(l => ({ location: l.location, qty: l.qty }))
          .sort((a, b) => b.qty - a.qty);

        if (partials.length >= 2) {
          const consolidations = [];
          const used = new Set();

          for (let i = 0; i < partials.length && consolidations.length < 3; i++) {
            if (used.has(i)) continue;
            const group = [partials[i]];
            let total = partials[i].qty;
            used.add(i);

            for (let j = i + 1; j < partials.length; j++) {
              if (used.has(j)) continue;
              if (total + partials[j].qty <= palletQty * 1.1) {
                group.push(partials[j]);
                total += partials[j].qty;
                used.add(j);
                if (total >= palletQty * 0.95) break;
              }
            }

            if (group.length >= 2 && total >= palletQty * 0.85) {
              consolidations.push({
                bins: group,
                totalQty: total,
                palletsFormed: Math.floor(total / palletQty),
                locationsFreed: group.length - Math.ceil(total / palletQty),
              });
            }
          }

          if (consolidations.length > 0) {
            consolidateInsights.push({
              sku: stockSku,
              display5dc: row.__5dc || '',
              product: row.__full_description || row.product,
              palletQty,
              consolidations,
              totalLocationsCanFree: consolidations.reduce((s, c) => s + c.locationsFreed, 0),
            });
          }
        }
      }
    }

    insightState.redistribute = redistributeInsights.sort((a, b) => b.completableBins.length - a.completableBins.length);
    insightState.consolidate  = consolidateInsights.sort((a, b) => b.totalLocationsCanFree - a.totalLocationsCanFree);
    insightState.page = 1;

    // Update tab counts
    const countR = document.getElementById('insightCountRedistribute');
    const countC = document.getElementById('insightCountConsolidate');
    if (countR) countR.textContent = redistributeInsights.length;
    if (countC) countC.textContent = consolidateInsights.length;

    console.log(`💡 Insights: ${redistributeInsights.length} redistribute, ${consolidateInsights.length} consolidate`);
  }

  /* ── View switching: Restock table ↔ Redistribute ↔ Consolidate ── */
  window.switchRestockView = function (view) {
    const restockView = document.getElementById('restockView');
    const insightsView = document.getElementById('insightsView');
    const searchGroup = document.getElementById('restockSearchGroup');
    const syncCard = document.getElementById('syncStatusCard');

    // Update tab active states
    document.querySelectorAll('.rv2-nav-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    // Sync banner always visible on all tabs
    if (syncCard) syncCard.style.display = '';

    if (view === 'restock') {
      // Show table, hide insights
      if (restockView) restockView.style.display = '';
      if (insightsView) insightsView.style.display = 'none';
      if (searchGroup) searchGroup.style.display = '';
    } else {
      // Show insights, hide table
      if (restockView) restockView.style.display = 'none';
      if (insightsView) insightsView.style.display = 'block';
      if (searchGroup) searchGroup.style.display = 'none';
      insightState.activeTab = view;
      insightState.page = 1;
      renderInsightsPage();
    }
  };

  window.changeInsightsPage = function (delta) {
    const items = insightState[insightState.activeTab] || [];
    const totalPages = Math.max(1, Math.ceil(items.length / insightState.perPage));
    insightState.page = Math.max(1, Math.min(totalPages, insightState.page + delta));
    renderInsightsPage();
  };

  function renderInsightsPage() {
    const container = document.getElementById('insightsContent');
    if (!container) return;

    const tab = insightState.activeTab;
    const items = insightState[tab] || [];
    const page = insightState.page;
    const perPage = insightState.perPage;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, items.length);
    const pageItems = items.slice(start, end);

    if (items.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:30px;color:#64748b;font-size:13px">No issues found in this category</div>';
      return;
    }

    let html = '';
    if (tab === 'redistribute') {
      html = renderRedistributeCards(pageItems);
    } else {
      html = renderConsolidateCards(pageItems);
    }

    // Pagination
    if (totalPages > 1) {
      html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid #e2e8f0;margin-top:8px">
        <span style="font-size:12px;color:#64748b">${start + 1}–${end} of ${items.length}</span>
        <div style="display:flex;align-items:center;gap:6px">
          <button onclick="changeInsightsPage(-1)" class="pages-btn" ${page <= 1 ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>‹</button>
          <span style="font-size:12px;color:#475569">Page ${page}/${totalPages}</span>
          <button onclick="changeInsightsPage(1)" class="pages-btn" ${page >= totalPages ? 'disabled style="opacity:.4;cursor:not-allowed"' : ''}>›</button>
        </div>
      </div>`;
    }

    container.innerHTML = html;
  }

  function renderRedistributeCards(items) {
    return items.map(ins => {
      const totalToMove = ins.totalToMove;
      return `<div style="padding:14px;background:#fff;border:1px solid #e2e8f0;border-left:4px solid #f59e0b;border-radius:8px;margin-bottom:8px">
        <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px">
          ${ins.display5dc ? '<span style="color:#64748b;font-size:12px">' + escapeHtml(ins.display5dc) + '</span> · ' : ''}${escapeHtml(ins.sku)} <span style="font-weight:400;color:#64748b">— ${escapeHtml(ins.product)}</span>
        </div>
        <div style="font-size:13px;color:#475569;line-height:1.6">
          <strong>Issue:</strong> Pickface has <strong style="color:#dc2626">+${ins.pickfaceExcess}</strong> excess units.
          ${ins.completableBins.length + ins.incompleteBins} bins with incomplete pallets (expected ${ins.palletQty}/pallet).
        </div>
        <div style="font-size:13px;color:#059669;margin-top:6px;line-height:1.6">
          <strong>Suggestion:</strong> Move <strong>${totalToMove} units</strong> from pickface to complete <strong>${ins.completableBins.length} bin${ins.completableBins.length > 1 ? 's' : ''}</strong>:
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">
          ${ins.completableBins.map(b => `<span style="display:inline-block;padding:3px 8px;background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;border-radius:4px;font-size:12px;font-weight:600">${escapeHtml(b.location)} (+${b.missing})</span>`).join('')}
        </div>
        ${ins.remainingExcess > 0 ? `<div style="font-size:12px;color:#6b7280;margin-top:8px">After: <strong>${ins.remainingExcess}</strong> units still excess.${ins.incompleteBins > 0 ? ` ${ins.incompleteBins} bins still incomplete.` : ''}${ins.palletQty > 0 && ins.remainingExcess >= ins.palletQty ? ` <span style="color:#dc2626">≈ ${Math.round(ins.remainingExcess / ins.palletQty)} pallet(s) — verify physical stock.</span>` : ''}</div>` : `<div style="font-size:12px;color:#059669;margin-top:8px">✓ Fully resolves pickface overflow.</div>`}
      </div>`;
    }).join('');
  }

  function renderConsolidateCards(items) {
    return items.map(ins => {
      return `<div style="padding:14px;background:#fff;border:1px solid #e2e8f0;border-left:4px solid #0ea5e9;border-radius:8px;margin-bottom:8px">
        <div style="font-weight:700;font-size:13px;color:#0f172a;margin-bottom:6px">
          ${ins.display5dc ? '<span style="color:#64748b;font-size:12px">' + escapeHtml(ins.display5dc) + '</span> · ' : ''}${escapeHtml(ins.sku)} <span style="font-weight:400;color:#64748b">— ${escapeHtml(ins.product)}</span>
        </div>
        <div style="font-size:13px;color:#475569;line-height:1.6">
          <strong>Opportunity:</strong> Multiple partial bins can be consolidated.
          Pallet capacity: <strong>${ins.palletQty}</strong> units.
        </div>
        ${ins.consolidations.map((c, idx) => `
          <div style="margin-top:8px;padding:10px;background:#f0f9ff;border-radius:6px">
            <div style="font-size:12px;color:#0369a1;font-weight:600;margin-bottom:4px">
              Merge ${c.bins.length} bins → ${c.palletsFormed} full pallet${c.palletsFormed > 1 ? 's' : ''}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center">
              ${c.bins.map((b, i) => `<span style="display:inline-block;padding:3px 8px;background:#e0f2fe;color:#0c4a6e;border:1px solid #bae6fd;border-radius:4px;font-size:12px">${escapeHtml(b.location)}: ${b.qty}</span>${i < c.bins.length - 1 ? '<span style="color:#94a3b8">+</span>' : ''}`).join('')}
              <span style="color:#0369a1;font-weight:600;font-size:12px;margin-left:4px">= ${c.totalQty}</span>
            </div>
            ${c.locationsFreed > 0 ? `<div style="font-size:11px;color:#059669;margin-top:4px">Frees ${c.locationsFreed} location${c.locationsFreed > 1 ? 's' : ''}</div>` : ''}
          </div>
        `).join('')}
        <div style="font-size:12px;color:#0369a1;font-weight:600;margin-top:10px">
          Total: free ${ins.totalLocationsCanFree} location${ins.totalLocationsCanFree > 1 ? 's' : ''}
        </div>
      </div>`;
    }).join('');
  }

  console.log('✅ Re-Stock V2 loaded — data source: cin7_mirror');
})();
