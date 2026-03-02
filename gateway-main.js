// gateway-main.js
// Purpose: Gateway → Main Warehouse — shows stock levels per product
//          with weeks-of-stock calculation to identify items needing
//          transfer from Gateway (MA-GA) to Main Warehouse pickface.
//          ONLY shows products that have stock in Gateway bins (MA-GA-*).
//
// Data sources (same as restock-v2):
//   cin7_mirror.stock_snapshot  → on_hand per bin in Main Warehouse
//   cin7_mirror.products        → product info, name, attribute1 (5DC)
//   restock_setup               → capacity, pickface, qty_per_ctn, qty_per_pallet
//   pallet_capacity_rules       → qty_pallet fallback
//   branch_avg_monthly_sales    → avg monthly sales per product
//   cin7_mirror.sync_runs       → last sync status card

(function () {
  'use strict';

  /* ── helpers ── */
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function normalizeLocation(loc) { return String(loc || '').replace(/\s+/g, '').toUpperCase(); }

  /* ── Carton SKU regex (same as restock-v2) ── */
  const _cartonRx       = /[-_]carton\d+$/i;
  const _cartonPrefixRx = /^carton[\s-]/i;

  /* ── state ── */
  const state = {
    q: '',
    loading: false,
    allRows: [],
    rows: [],
    weeksFilter: 'ALL',
    pfFilter: 'ALL',
    viewMode: 'main_stock',
    hiddenSkus: new Set(),
    showHidden: false,
    onlyWithDemand: false,
    selectedSkus: new Set(),
    page: 1,
    perPage: 30,
  };

  // Hidden products persistence
  const GW_HIDDEN_KEY = 'gw_hidden_skus';
  (function loadHiddenSkus() {
    try { const raw = localStorage.getItem(GW_HIDDEN_KEY); if (raw) JSON.parse(raw).forEach(s => state.hiddenSkus.add(String(s))); } catch {}
  })();
  function saveHiddenSkus() {
    try { localStorage.setItem(GW_HIDDEN_KEY, JSON.stringify(Array.from(state.hiddenSkus))); } catch {}
  }

  /* ── DOM refs ── */
  const COLS = 14;
  const tbody  = document.getElementById('gwTbody');
  const input  = document.getElementById('gwSearch');
  function setTbody(html) { if (tbody) tbody.innerHTML = html; }

  /* ═══════════════════════════════════════════════
     WEEKS-OF-STOCK classification
     ═══════════════════════════════════════════════ */
  const WEEKS_PER_MONTH = 4.33;

  function classifyWeeks(weeks) {
    if (weeks == null) return 'NO_SALES';
    if (weeks < 1) return 'CRITICAL';
    if (weeks < 2) return 'LOW';
    if (weeks < 4) return 'OK';
    return 'GOOD';
  }

  function weeksBadge(weeks, cls) {
    if (weeks == null) return '<span class="weeks-badge none">—</span>';
    const label = weeks.toFixed(1);
    return `<span class="weeks-badge ${cls}">${label}</span>`;
  }

  function classifyPickface(r) {
    if (!r.capacity || r.capacity <= 0) return 'NO_SETUP';
    if (r.pickface_on_hand <= 0) return 'EMPTY';
    if (r.pickface_on_hand >= r.capacity) return 'FULL';
    return 'NEEDS_RESTOCK';
  }

  function pickfaceBadge(r) {
    const cls = classifyPickface(r);
    if (cls === 'NO_SETUP') return '<span class="weeks-badge none">—</span>';
    const pct = Math.round((r.pickface_on_hand / r.capacity) * 100);
    const fillNeeded = r.capacity - r.pickface_on_hand;
    if (cls === 'EMPTY') return `<span class="weeks-badge critical">Empty (need ${fillNeeded})</span>`;
    if (cls === 'NEEDS_RESTOCK') return `<span class="weeks-badge low">${pct}% (need ${fillNeeded})</span>`;
    return `<span class="weeks-badge good">Full</span>`;
  }

  /* ═══════════════════════════════════════════════
     PAGER
     ═══════════════════════════════════════════════ */
  function updatePager(total) {
    const info = document.getElementById('gwPageInfo');
    const prev = document.getElementById('gwPrevPage');
    const next = document.getElementById('gwNextPage');
    if (!info) return;
    const tp = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > tp) state.page = tp;
    info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${state.page} / ${tp}`;
    const set = (b, d) => { if (!b) return; b.dataset.disabled = d ? '1' : '0'; b.style.opacity = d ? '.45' : '1'; b.style.pointerEvents = d ? 'none' : 'auto'; };
    set(prev, state.page <= 1);
    set(next, state.page >= tp);
  }

  /* ═══════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════ */
  function render(rows) {
    if (!rows || !rows.length) {
      setTbody(`<tr><td colspan="${COLS}" style="text-align:center;opacity:.7">No results</td></tr>`);
      updatePager(0);
      return;
    }
    const start = (state.page - 1) * state.perPage;
    const page  = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    const html = page.map(r => {
      const rawSku = String(r.__stock_sku || r.sku);
      const isSelected = state.selectedSkus.has(rawSku);
      const fiveDC    = escapeHtml(r.__5dc || '');
      const skuDisplay = escapeHtml(r.__stock_sku || r.sku);
      const productName = r.__full_description || r.product;
      const productNameEsc = escapeHtml(productName);
      const productHtml = productName.length > 50
        ? `<span title="${productNameEsc}" style="cursor:help">${escapeHtml(productName.substring(0, 48))}…</span>`
        : productNameEsc;
      const pickface  = escapeHtml(r.stock_locator);
      const pfStock   = r.pickface_on_hand ?? 0;
      const capacity  = r.capacity ?? '';
      const totalMW   = r.total_mw ?? 0;
      const gwStock   = r.gateway_stock ?? 0;
      const avgMth    = r.avg_month_sales;
      const avgWk     = avgMth != null && avgMth > 0 ? avgMth / 4.33 : null;
      const avgSalesO = r.__avg_sales_only;
      const avgXfrO   = r.__avg_transfer_only;
      const weeks     = r.weeks_available;
      const wCls      = classifyWeeks(weeks);

      let avgHtml;
      if (avgMth != null) {
        const mthStr = Math.round(avgMth).toLocaleString();
        const wkStr = avgWk != null ? Math.round(avgWk).toLocaleString() : '—';
        const salesMth = avgSalesO != null ? Math.round(avgSalesO).toLocaleString() : '0';
        const salesWk = avgSalesO != null && avgSalesO > 0 ? Math.round(avgSalesO / 4.33).toLocaleString() : '0';
        const xfrMth = avgXfrO != null ? Math.round(avgXfrO).toLocaleString() : '0';
        const xfrWk = avgXfrO != null && avgXfrO > 0 ? Math.round(avgXfrO / 4.33).toLocaleString() : '0';
        const tipHtml = `<div style="text-align:left;min-width:220px">`
          + `<div style="font-weight:700;margin-bottom:4px;border-bottom:1px solid #475569;padding-bottom:3px">AVG Demand Breakdown</div>`
          + `<div style="display:flex;justify-content:space-between;gap:12px;opacity:.6;font-size:11px;margin-bottom:2px"><span></span><span>mth / 4wk</span></div>`
          + `<div style="display:flex;justify-content:space-between;gap:12px"><span>📦 Sales Orders:</span><span>${salesMth} / ${salesWk}</span></div>`
          + `<div style="display:flex;justify-content:space-between;gap:12px"><span>🚚 Transfers NET:</span><span>${xfrMth} / ${xfrWk}</span></div>`
          + `<div style="border-top:1px solid #475569;margin-top:3px;padding-top:3px;font-weight:700;display:flex;justify-content:space-between;gap:12px"><span>Total:</span><span>${mthStr} / ${wkStr}</span></div>`
          + `<div style="margin-top:6px;font-size:10px;opacity:.6">Period: Aug 2025 – Feb 2026 (6.53 mths)</div>`
          + `</div>`;
        avgHtml = `<span class="tip-cell" onclick="toggleTip(this)"><span style="font-variant-numeric:tabular-nums">${mthStr}<span style="opacity:.45;margin:0 2px">/</span>${wkStr}</span><div class="tip-pop">${tipHtml}</div></span>`;
      } else {
        avgHtml = '<span style="opacity:.35">—</span>';
      }

      const gwHtml    = gwStock > 0
        ? `<span style="font-weight:600;color:#0369a1">${gwStock.toLocaleString()}</span>`
        : '<span style="opacity:.35">0</span>';

      const qtyCtnVal    = r.__qty_per_ctn;
      const qtyPalletVal = r.__qty_per_pallet;
      const qtyCtnHtml    = qtyCtnVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyCtnVal}</span>` : '<span style="opacity:.35">—</span>';
      const qtyPalletHtml = qtyPalletVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyPalletVal}</span>` : '<span style="opacity:.35">—</span>';

      // Actions: hide/unhide button
      const isHidden = state.hiddenSkus.has(rawSku);
      const hideBtn = `<button type="button" onclick="gwToggleHide('${escapeHtml(rawSku)}')" title="${isHidden ? 'Show product' : 'Hide product'}" style="background:none;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;padding:2px 8px;font-size:13px">${isHidden ? '👁' : '🚫'}</button>`;
      const trStyle = isHidden ? ' style="opacity:.4;background:#f8fafc"' : '';

      // Pickface fill badge (for pickface restock mode)
      const pfBadge = state.viewMode === 'pickface_restock' ? pickfaceBadge(r) : weeksBadge(weeks, wCls.toLowerCase());

      return `<tr${trStyle}>
        <td class="no-print"><input type="checkbox" ${isSelected ? 'checked' : ''} onchange="gwToggleSelectRow('${escapeHtml(rawSku)}', this.checked)" /></td>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#64748b">${fiveDC}</td>
        <td>${skuDisplay}</td>
        <td>${productHtml}</td>
        <td>${pickface}</td>
        <td>${pfStock}</td>
        <td>${capacity}</td>
        <td>${totalMW}</td>
        <td>${gwHtml}</td>
        <td>${avgHtml}</td>
        <td>${pfBadge}</td>
        <td>${qtyCtnHtml}</td>
        <td>${qtyPalletHtml}</td>
        <td class="no-print">${hideBtn}</td>
      </tr>`;
    }).join('');

    setTbody(html);
    updateBulkBar();
    // Update select-all checkbox state
    const selAll = document.getElementById('gwSelectAll');
    if (selAll) {
      const pageSkus = page.map(r => String(r.__stock_sku || r.sku));
      const allChecked = pageSkus.length > 0 && pageSkus.every(s => state.selectedSkus.has(s));
      const someChecked = pageSkus.some(s => state.selectedSkus.has(s));
      selAll.checked = allChecked;
      selAll.indeterminate = someChecked && !allChecked;
    }
  }

  /* ═══════════════════════════════════════════════
     COUNTERS
     ═══════════════════════════════════════════════ */
  function updateCounters() {
    // Filter out hidden for counting (unless showHidden)
    const visibleRows = state.showHidden ? state.allRows : state.allRows.filter(r => !state.hiddenSkus.has(String(r.__stock_sku || r.sku)));
    // Main Stock mode counters (weeks-based)
    const c = { all: 0, critical: 0, low: 0, ok: 0, good: 0, no_sales: 0 };
    // Pickface mode counters
    const pf = { all: 0, needs_restock: 0, empty: 0, full: 0, no_setup: 0 };
    for (const r of visibleRows) {
      c.all++;
      pf.all++;
      const w = classifyWeeks(r.weeks_available);
      if (w === 'CRITICAL') c.critical++;
      else if (w === 'LOW') c.low++;
      else if (w === 'OK') c.ok++;
      else if (w === 'GOOD') c.good++;
      else c.no_sales++;
      const p = classifyPickface(r);
      if (p === 'NEEDS_RESTOCK') pf.needs_restock++;
      else if (p === 'EMPTY') pf.empty++;
      else if (p === 'FULL') pf.full++;
      else pf.no_setup++;
    }
    const u = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    u('countAll', c.all);
    u('countCritical', c.critical);
    u('countLow', c.low);
    u('countOk', c.ok);
    u('countGood', c.good);
    u('countNoSales', c.no_sales);
    u('pfCountAll', pf.all);
    u('pfCountNeedsRestock', pf.needs_restock);
    u('pfCountEmpty', pf.empty);
    u('pfCountFull', pf.full);
    u('pfCountNoSetup', pf.no_setup);
    // Hidden count
    u('gwHiddenCount', state.hiddenSkus.size > 0 ? `(${state.hiddenSkus.size})` : '');
    // Filter badge
    const activeFilters = [];
    if (state.onlyWithDemand) activeFilters.push('With demand');
    if (state.showHidden) activeFilters.push('Show hidden');
    const badge = document.getElementById('gwFiltersBadge');
    if (badge) { badge.textContent = activeFilters.length || ''; badge.style.display = activeFilters.length ? 'inline-flex' : 'none'; }
    const tagsEl = document.getElementById('gwActiveFilterTags');
    if (tagsEl) {
      tagsEl.innerHTML = activeFilters.length === 0 ? '' : activeFilters.map(f => `<span style="display:inline-flex;align-items:center;gap:3px;background:#eef2ff;color:#4338ca;font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid #c7d2fe;white-space:nowrap">${escapeHtml(f)}</span>`).join('');
    }
  }

  /* ═══════════════════════════════════════════════
     FILTERS & SORT
     ═══════════════════════════════════════════════ */
  function applyFilters(rows) {
    let out = rows.slice();

    // Hidden filter
    if (!state.showHidden) {
      out = out.filter(r => !state.hiddenSkus.has(String(r.__stock_sku || r.sku)));
    }

    // Only with demand
    if (state.onlyWithDemand) {
      out = out.filter(r => r.avg_month_sales != null && r.avg_month_sales > 0);
    }

    if (state.viewMode === 'main_stock') {
      // weeks filter
      if (state.weeksFilter !== 'ALL') {
        out = out.filter(r => classifyWeeks(r.weeks_available) === state.weeksFilter);
      }
    } else {
      // pickface filter
      if (state.pfFilter !== 'ALL') {
        out = out.filter(r => classifyPickface(r) === state.pfFilter);
      }
    }

    return out;
  }

  function sortRows(rows) {
    if (state.viewMode === 'pickface_restock') {
      // Sort by fill % ascending (emptiest pickfaces first), no-setup last
      return rows.slice().sort((a, b) => {
        const aSetup = a.capacity > 0;
        const bSetup = b.capacity > 0;
        if (!aSetup && !bSetup) return String(a.sku).localeCompare(String(b.sku));
        if (!aSetup) return 1;
        if (!bSetup) return -1;
        const aFill = a.pickface_on_hand / a.capacity;
        const bFill = b.pickface_on_hand / b.capacity;
        if (aFill !== bFill) return aFill - bFill;
        return String(a.sku).localeCompare(String(b.sku));
      });
    }
    // Main stock mode: sort by weeks ascending (most urgent first), nulls last
    return rows.slice().sort((a, b) => {
      const wa = a.weeks_available;
      const wb = b.weeks_available;
      if (wa == null && wb == null) return String(a.sku).localeCompare(String(b.sku));
      if (wa == null) return 1;
      if (wb == null) return -1;
      if (wa !== wb) return wa - wb;
      return String(a.sku).localeCompare(String(b.sku));
    });
  }

  function rebuildView() {
    state.page = 1;
    state.selectedSkus.clear();
    const filtered = applyFilters(state.allRows);
    const sorted   = sortRows(filtered);
    state.rows = sorted;
    render(sorted);
  }

  /* ═══════════════════════════════════════════════
     SYNC STATUS CARD
     ═══════════════════════════════════════════════ */
  let _lastSyncEndedAt = null;

  function _refreshSyncCountdown() {
    const el = document.getElementById('syncCountdown');
    if (!el) return;
    const now = new Date();
    const INTERVAL_MS = 2 * 3600000; // 2 hours

    let nextSync;
    if (_lastSyncEndedAt) {
      nextSync = new Date(new Date(_lastSyncEndedAt).getTime() + INTERVAL_MS);
      if (nextSync <= now) {
        const elapsed = now - nextSync;
        nextSync = new Date(nextSync.getTime() + Math.ceil(elapsed / INTERVAL_MS) * INTERVAL_MS);
      }
    } else {
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      const utcS = now.getUTCSeconds();
      let nextH = utcH;
      if (utcM > 0 || utcS > 0) nextH++;
      if (nextH % 2 !== 0) nextH++;
      nextSync = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        nextH, 0, 0, 0
      ));
      if (nextSync <= now) nextSync = new Date(nextSync.getTime() + INTERVAL_MS);
    }

    const diffMs = nextSync - now;
    const diffMin = Math.max(0, Math.floor(diffMs / 60000));
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    const countdown = h > 0 ? `${h}h ${m}m` : `${m}m`;
    el.textContent = `🛡️ Next sync in ${countdown}`;
    el.title = `Next stock sync ~${nextSync.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} (every 2h from last sync). May vary ~5-15 min.`;
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
  }

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
        // Schema may not be exposed yet — show subtle info
        dot.style.background = '#94a3b8';
        text.textContent = 'Sync status unavailable — cin7_mirror schema needs to be exposed in Supabase API settings';
        text.style.color = '#64748b';
        return;
      }
      if (!data || data.length === 0) {
        dot.style.background = '#94a3b8';
        text.textContent = 'No sync runs found — run the first sync to populate data';
        return;
      }
      const run = data[0];
      const ok = run.status === 'success';
      const running = run.status === 'running';
      dot.style.background = ok ? '#22c55e' : running ? '#3b82f6' : '#ef4444';
      const prodCount = run.products_synced || 0;
      const stockCount = run.stock_rows_synced || 0;
      const dur = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '';
      text.textContent = `${ok ? 'Last sync successful' : running ? 'Sync running…' : 'Last sync failed'}${prodCount ? ` • ${prodCount} prods, ${stockCount} stock` : ''}${dur ? ` • ${dur}` : ''}`;
      text.style.color = ok ? '#166534' : running ? '#1d4ed8' : '#991b1b';
      const ts = run.ended_at || run.started_at;
      if (ts) {
        const d = new Date(ts), p = n => String(n).padStart(2, '0');
        time.textContent = `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
      }
      // Track for live age refresh
      if (run.ended_at) {
        _lastSyncEndedAt = run.ended_at;
        _refreshSyncAge();
        _refreshSyncCountdown();
      }
    } catch (e) {
      console.warn('Sync status error:', e);
      dot.style.background = '#f59e0b';
      text.textContent = 'Could not fetch sync status';
      text.style.color = '#92400e';
    }
  }

  /* ═══════════════════════════════════════════════
     PAGINATED FETCH helper
     ═══════════════════════════════════════════════ */
  async function fetchAllRows(table, cols, opts = {}) {
    const chunk = 1000;
    const all = [];
    let off = 0;
    while (true) {
      let q = opts.schema
        ? window.supabase.schema(opts.schema).from(table).select(cols)
        : window.supabase.from(table).select(cols);
      if (opts.eq) for (const [c, v] of opts.eq) q = q.eq(c, v);
      q = q.range(off, off + chunk - 1);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || !data.length) break;
      all.push(...data);
      if (data.length < chunk) break;
      off += chunk;
    }
    return all;
  }

  /* ═══════════════════════════════════════════════
     FETCH DATA — Main logic (same join patterns as restock-v2)
     ═══════════════════════════════════════════════ */
  async function fetchData() {
    if (!window.supabase || !window.supabaseReady) {
      setTbody(`<tr><td colspan="${COLS}" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>`);
      return;
    }
    state.loading = true;
    setTbody(`<tr><td colspan="${COLS}" style="text-align:center;opacity:.7">Loading from Cin7 mirror…</td></tr>`);

    try {
      await window.supabaseReady;

      /* 1. Sync status */
      await updateSyncStatusCard();

      /* 2. Stock snapshot — Main Warehouse */
      let mwStockRows = [];
      try {
        mwStockRows = await fetchAllRows('stock_snapshot', 'sku, location_name, bin, on_hand', {
          schema: 'cin7_mirror',
          eq: [['location_name', 'Main Warehouse']],
        });
      } catch (e) {
        console.warn('⚠️ Could not read cin7_mirror.stock_snapshot:', e.message);
        setTbody(`<tr><td colspan="${COLS}" style="text-align:center;color:#64748b;padding:30px">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">Setup Required</div>
          <div style="font-size:13px;color:#94a3b8">Expose <code>cin7_mirror</code> in Supabase Dashboard → Settings → API → Exposed schemas, then run the first sync.</div>
        </td></tr>`);
        state.loading = false;
        return;
      }

      /* 2b. Stock snapshot — Gateway (separate location) */
      let gwStockRows = [];
      try {
        gwStockRows = await fetchAllRows('stock_snapshot', 'sku, location_name, bin, on_hand', {
          schema: 'cin7_mirror',
          eq: [['location_name', 'Gateway']],
        });
      } catch (e) {
        console.warn('⚠️ Could not read Gateway stock:', e.message);
      }
      console.log(`📦 Stock fetched: ${mwStockRows.length} MW rows, ${gwStockRows.length} Gateway rows`);

      /* 3. Products (with attribute1 for 5DC fallback) */
      let productRows = [];
      try {
        productRows = await fetchAllRows('products', 'sku, name, stock_locator, category, brand, barcode, attribute1', {
          schema: 'cin7_mirror',
        });
      } catch (e) { console.warn('⚠️ Could not read cin7_mirror.products:', e.message); }

      /* 4. Restock setup (all columns for qty_per_ctn, qty_per_pallet) */
      const setupRows = await fetchAllRows('restock_setup', '*');

      /* 5. Pallet capacity rules (fallback for qty_pallet) */
      let palletRulesRows = [];
      try {
        palletRulesRows = await fetchAllRows('pallet_capacity_rules', 'product, sku, qty_pallet');
      } catch (e) { console.warn('⚠️ Could not read pallet_capacity_rules:', e.message); }

      /* 6. AVG monthly sales */
      let avgSalesRows = [];
      try {
        avgSalesRows = await fetchAllRows('branch_avg_monthly_sales', 'product, avg_mth_main, avg_sales_main, avg_transfer_main');
      } catch (e) { console.warn('⚠️ Could not read branch_avg_monthly_sales:', e.message); }

      /* ── Build lookup maps (same patterns as restock-v2) ── */

      // Product map: cin7 SKU → product record
      const productMap = Object.create(null);
      for (const p of productRows) productMap[p.sku] = p;

      // AVG sales by product name (uppercase)
      const avgSalesByName = Object.create(null);
      for (const a of avgSalesRows) {
        if (a.product) avgSalesByName[a.product.toUpperCase()] = {
          total: Number(a.avg_mth_main) || 0,
          sales: Number(a.avg_sales_main) || 0,
          transfer: Number(a.avg_transfer_main) || 0,
        };
      }

      // Pallet capacity: product/sku → qty_pallet
      const palletCapacity = Object.create(null);
      for (const r of palletRulesRows) {
        const key = (r.product || r.sku || '').trim();
        if (key && r.qty_pallet) palletCapacity[key] = Number(r.qty_pallet) || 0;
      }

      // Setup lookups: setupByProduct (keyed by product code), setupBy5DC (keyed by 5DC)
      const setupByProduct = Object.create(null);
      const setupBy5DC     = Object.create(null);
      for (const s of setupRows) {
        let productCode = (s.product || '').trim();
        // If product field contains "5DC  CODE" pattern, extract the CODE part
        const spaceMatch = productCode.match(/^\d{4,6}\s+(.+)$/);
        if (spaceMatch) productCode = spaceMatch[1].trim();

        const entry = {
          sku5dc: String(s.sku || ''),
          productCode: productCode,
          pickface_location: s.pickface_location || '',
          pickface_qty: s.pickface_qty != null ? Number(s.pickface_qty) : null,
          min: Number(s.cap_min),
          med: Number(s.cap_med),
          max: Number(s.cap_max),
          qty_per_ctn: s.qty_per_ctn != null ? Number(s.qty_per_ctn) : null,
          qty_per_pallet: s.qty_per_pallet != null ? Number(s.qty_per_pallet) : null,
        };
        if (productCode) setupByProduct[productCode] = entry;
        if (s.sku) setupBy5DC[s.sku] = entry;
      }

      // Merge restock_setup.qty_per_pallet into palletCapacity (higher priority)
      for (const key of Object.keys(setupByProduct)) {
        const s = setupByProduct[key];
        if (s.qty_per_pallet) {
          palletCapacity[key] = s.qty_per_pallet;
          if (s.sku5dc) palletCapacity[s.sku5dc] = s.qty_per_pallet;
        }
      }

      /* ── Group MW stock by SKU ── */
      const mwBySku = Object.create(null);
      for (const s of mwStockRows) {
        if (!s.sku) continue;
        if (!mwBySku[s.sku]) mwBySku[s.sku] = [];
        mwBySku[s.sku].push(s);
      }

      /* ── Group Gateway stock by SKU ── */
      const gwBySku = Object.create(null);
      for (const s of gwStockRows) {
        if (!s.sku) continue;
        gwBySku[s.sku] = (gwBySku[s.sku] || 0) + (Number(s.on_hand) || 0);
      }
      // Also add MA-GA bins from Main Warehouse
      for (const s of mwStockRows) {
        if (!s.sku) continue;
        const normBin = normalizeLocation(s.bin);
        if (normBin.startsWith('MA-GA')) {
          gwBySku[s.sku] = (gwBySku[s.sku] || 0) + (Number(s.on_hand) || 0);
        }
      }

      /* ── Union of SKUs that have Gateway stock ── */
      const gwSkus = Object.keys(gwBySku).filter(sku => gwBySku[sku] > 0);
      console.log(`🚪 ${gwSkus.length} SKUs with Gateway stock`);

      /* ── Search filter ── */
      const q = (state.q || '').trim().toLowerCase();

      /* ── Build rows — only products WITH Gateway stock ── */
      const rows = [];
      for (const stockSku of gwSkus) {
        // Skip carton items
        if (_cartonRx.test(stockSku) || _cartonPrefixRx.test(stockSku)) continue;

        const mwStocks = mwBySku[stockSku] || [];
        const prod     = productMap[stockSku] || {};

        // JOIN: same logic as restock-v2
        const setupDirect   = setupByProduct[stockSku];
        const setupFallback = !setupDirect && prod.attribute1
          ? setupBy5DC[(prod.attribute1 || '').trim()] : null;
        const setup = setupDirect || setupFallback;

        // 5DC source priority: 1) restock_setup.sku  2) cin7_mirror.products.attribute1
        const display5DC = (setup ? setup.sku5dc : '') || (prod.attribute1 || '').trim();

        // Product code for display (same as restock-v2)
        const displayProduct = setup ? setup.productCode : stockSku;

        // Full description from cin7 products
        const fullDescription = prod.name || '';

        // Pickface location (prefer setup, fallback to cin7 stock_locator)
        const stockLocator = (setup ? setup.pickface_location : '') || (prod.stock_locator || '').trim();
        const normPickface = normalizeLocation(stockLocator);

        // Capacity from setup
        const capacity = setup ? (setup.pickface_qty || 0) : 0;

        // Compute pickface on_hand and total MW from Main Warehouse bins
        let pickfaceOnHand = 0;
        let totalMW        = 0;

        for (const s of mwStocks) {
          const oh = Number(s.on_hand) || 0;
          totalMW += oh;

          const normBin = normalizeLocation(s.bin);
          if (normPickface && normBin === normPickface) {
            pickfaceOnHand += oh;
          }
        }

        // Gateway stock (already computed from Gateway location + MA-GA bins)
        const gatewayStock = gwBySku[stockSku] || 0;

        // AVG month sales (lookup by product code, uppercase)
        const avgLookup = avgSalesByName[displayProduct.toUpperCase()]
          ?? avgSalesByName[(fullDescription || '').toUpperCase()]
          ?? null;
        const avgMonthSales = avgLookup ? avgLookup.total : null;
        const avgSalesOnly = avgLookup ? avgLookup.sales : null;
        const avgTransferOnly = avgLookup ? avgLookup.transfer : null;

        // Weeks available = totalMW / (avgMonthSales / WEEKS_PER_MONTH)
        let weeksAvailable = null;
        if (avgMonthSales != null && avgMonthSales > 0) {
          const weeklyRate = avgMonthSales / WEEKS_PER_MONTH;
          weeksAvailable = totalMW / weeklyRate;
        }

        // Qty/CTN and Qty/Pallet (same priority as restock-v2)
        const qtyCtn = setup ? setup.qty_per_ctn : null;
        const qtyPallet = (setup && setup.qty_per_pallet) || palletCapacity[stockSku] || palletCapacity[display5DC] || null;

        const row = {
          sku: display5DC || stockSku,
          __5dc: display5DC,
          __stock_sku: stockSku,
          product: displayProduct,
          __full_description: fullDescription,
          stock_locator: stockLocator,
          capacity,
          pickface_on_hand: pickfaceOnHand,
          total_mw: totalMW,
          gateway_stock: gatewayStock,
          avg_month_sales: avgMonthSales,
          __avg_sales_only: avgSalesOnly,
          __avg_transfer_only: avgTransferOnly,
          weeks_available: weeksAvailable,
          __qty_per_ctn: qtyCtn,
          __qty_per_pallet: qtyPallet,
          has_setup: !!setup,
        };

        // Client-side search
        if (q) {
          const hay = `${display5DC} ${stockSku} ${displayProduct} ${fullDescription} ${stockLocator}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        rows.push(row);
      }

      console.log(`📊 Gateway→Main: ${rows.length} products with Gateway stock (${mwStockRows.length} MW rows, ${gwStockRows.length} GW rows, ${productRows.length} products, ${setupRows.length} setups, ${palletRulesRows.length} pallet rules, ${avgSalesRows.length} avg sales)`);

      state.allRows = rows;
      updateCounters();
      rebuildView();

    } catch (e) {
      console.error('gateway-main fetch error', e);
      setTbody(`<tr><td colspan="${COLS}" style="text-align:center;color:#b91c1c">Failed to load data: ${escapeHtml(e.message)}</td></tr>`);
    } finally {
      state.loading = false;
    }
  }

  /* ═══════════════════════════════════════════════
     TOOLTIP TOGGLE
     ═══════════════════════════════════════════════ */
  window.toggleTip = function (el) {
    const wrap = el.classList.contains('tip-cell') ? el : el.closest('.tip-cell');
    if (!wrap) return;
    const isOpen = wrap.classList.contains('show');
    document.querySelectorAll('.tip-cell.show').forEach(e => e.classList.remove('show'));
    if (!isOpen) {
      wrap.classList.add('show');
      const close = (ev) => { if (!wrap.contains(ev.target)) { wrap.classList.remove('show'); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 10);
    }
  };

  /* ═══════════════════════════════════════════════
     SEARCH
     ═══════════════════════════════════════════════ */
  window.runGwSearch = function () {
    state.q = (input && input.value) || '';
    fetchData();
  };

  const onInput = debounce(() => { state.q = (input && input.value) || ''; fetchData(); }, 350);
  if (input) {
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); window.runGwSearch(); } });
  }

  /* ═══════════════════════════════════════════════
     FILTER toggles
     ═══════════════════════════════════════════════ */
  window.gwSetWeeksFilter = function (val) {
    state.weeksFilter = String(val || 'ALL').toUpperCase();
    rebuildView();
  };

  window.gwSetPfFilter = function (val) {
    state.pfFilter = String(val || 'ALL').toUpperCase();
    rebuildView();
  };

  window.gwSwitchView = function (mode) {
    state.viewMode = mode;
    if (mode === 'main_stock') { state.pfFilter = 'ALL'; }
    else { state.weeksFilter = 'ALL'; }
    updateCounters();
    rebuildView();
  };

  window.gwToggleHide = function (sku) {
    const key = String(sku);
    if (state.hiddenSkus.has(key)) state.hiddenSkus.delete(key);
    else state.hiddenSkus.add(key);
    saveHiddenSkus();
    updateCounters();
    rebuildView();
  };

  window.gwSetOnlyDemand = function (checked) {
    state.onlyWithDemand = !!checked;
    updateCounters();
    rebuildView();
  };

  window.gwSetShowHiddenFn = function (checked) {
    state.showHidden = !!checked;
    updateCounters();
    rebuildView();
  };

  window.gwClearFilters = function () {
    state.onlyWithDemand = false;
    state.showHidden = false;
    updateCounters();
    rebuildView();
  };

  /* ═══════════════════════════════════════════════
     SELECTION & BULK ACTIONS
     ═══════════════════════════════════════════════ */
  function updateBulkBar() {
    const bar = document.getElementById('gwBulkBar');
    const cnt = document.getElementById('gwBulkCount');
    const showBtn = document.getElementById('gwBulkShowBtn');
    if (!bar) return;
    const n = state.selectedSkus.size;
    bar.style.display = n > 0 ? 'flex' : 'none';
    if (cnt) cnt.textContent = `${n} selected`;
    // Show "Show selected" button only when viewing hidden products
    if (showBtn) showBtn.style.display = state.showHidden ? 'inline-block' : 'none';
  }

  window.gwToggleSelectAll = function (checked) {
    const start = (state.page - 1) * state.perPage;
    const page = state.rows.slice(start, start + state.perPage);
    for (const r of page) {
      const sku = String(r.__stock_sku || r.sku);
      if (checked) state.selectedSkus.add(sku);
      else state.selectedSkus.delete(sku);
    }
    render(state.rows);
  };

  window.gwToggleSelectRow = function (sku, checked) {
    if (checked) state.selectedSkus.add(sku);
    else state.selectedSkus.delete(sku);
    updateBulkBar();
    // Update select-all checkbox
    const selAll = document.getElementById('gwSelectAll');
    if (selAll) {
      const start = (state.page - 1) * state.perPage;
      const page = state.rows.slice(start, start + state.perPage);
      const pageSkus = page.map(r => String(r.__stock_sku || r.sku));
      const allChecked = pageSkus.length > 0 && pageSkus.every(s => state.selectedSkus.has(s));
      const someChecked = pageSkus.some(s => state.selectedSkus.has(s));
      selAll.checked = allChecked;
      selAll.indeterminate = someChecked && !allChecked;
    }
  };

  window.gwHideSelected = function () {
    for (const sku of state.selectedSkus) {
      state.hiddenSkus.add(sku);
    }
    saveHiddenSkus();
    state.selectedSkus.clear();
    updateCounters();
    rebuildView();
  };

  window.gwShowSelected = function () {
    for (const sku of state.selectedSkus) {
      state.hiddenSkus.delete(sku);
    }
    saveHiddenSkus();
    state.selectedSkus.clear();
    updateCounters();
    rebuildView();
  };

  window.gwClearSelection = function () {
    state.selectedSkus.clear();
    render(state.rows);
  };

  /* ═══════════════════════════════════════════════
     COLUMN VISIBILITY
     ═══════════════════════════════════════════════ */
  const GW_COL_SETTINGS_KEY = 'gwMain_hiddenColumns';
  const GW_TOGGLEABLE_COLS = [
    { idx: 0, label: '5DC' },
    { idx: 1, label: 'SKU' },
    { idx: 2, label: 'Product' },
    { idx: 3, label: 'Pickface Location' },
    { idx: 4, label: 'Pickface Stock' },
    { idx: 5, label: 'Capacity' },
    { idx: 6, label: 'Total MW' },
    { idx: 7, label: 'Gateway' },
    { idx: 8, label: 'Avg Mth / 4Wk' },
    { idx: 9, label: 'Weeks Avail.' },
    { idx: 10, label: 'Qty/CTN' },
    { idx: 11, label: 'Qty/Pallet' },
  ];
  let gwHiddenCols = new Set();

  function gwLoadColSettings() {
    try {
      const raw = localStorage.getItem(GW_COL_SETTINGS_KEY);
      if (raw) gwHiddenCols = new Set(JSON.parse(raw));
    } catch {}
    gwApplyColVisibility();
  }
  function gwSaveColSettings() {
    try { localStorage.setItem(GW_COL_SETTINGS_KEY, JSON.stringify(Array.from(gwHiddenCols))); } catch {}
  }
  function gwApplyColVisibility() {
    const container = document.querySelector('.main-container');
    if (!container) return;
    for (const col of GW_TOGGLEABLE_COLS) {
      const cls = `gw-col-hidden-${col.idx}`;
      if (gwHiddenCols.has(col.idx)) container.classList.add(cls);
      else container.classList.remove(cls);
    }
  }
  window.openGwColumnSettingsModal = function () {
    const modal = document.getElementById('gwColumnSettingsModal');
    if (!modal) return;
    const container = document.getElementById('gwColumnToggles');
    if (!container) return;
    container.innerHTML = GW_TOGGLEABLE_COLS.map(col => {
      const checked = !gwHiddenCols.has(col.idx) ? 'checked' : '';
      return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:13px">
        <input type="checkbox" ${checked} onchange="gwToggleCol(${col.idx}, this.checked)" />
        <span>${col.label}</span>
      </label>`;
    }).join('');
    modal.classList.remove('hidden');
  };
  window.closeGwColumnSettingsModal = function () {
    const modal = document.getElementById('gwColumnSettingsModal');
    if (modal) modal.classList.add('hidden');
  };
  window.gwToggleCol = function (idx, visible) {
    if (visible) gwHiddenCols.delete(idx);
    else gwHiddenCols.add(idx);
    gwSaveColSettings();
    gwApplyColVisibility();
  };
  window.resetGwColumnSettings = function () {
    gwHiddenCols.clear();
    gwSaveColSettings();
    gwApplyColVisibility();
    window.openGwColumnSettingsModal(); // refresh checkmarks
  };
  gwLoadColSettings();

  /* ═══════════════════════════════════════════════
     PAGER controls
     ═══════════════════════════════════════════════ */
  window.gwPrevPage = function () { if (state.page > 1) { state.page--; render(state.rows); } };
  window.gwNextPage = function () {
    const tp = Math.max(1, Math.ceil(state.rows.length / state.perPage));
    if (state.page < tp) { state.page++; render(state.rows); }
  };

  /* ═══════════════════════════════════════════════
     INITIAL LOAD
     ═══════════════════════════════════════════════ */
  fetchData();

  console.log('✅ Gateway → Main loaded — data source: cin7_mirror');
})();
