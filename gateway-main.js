// gateway-main.js
// Purpose: Gateway → Main Warehouse — shows stock levels per product
//          with weeks-of-stock calculation to identify items needing
//          transfer from Gateway (MA-GA) to Main Warehouse pickface.
//
// Data sources:
//   cin7_mirror.stock_snapshot  → on_hand per bin in Main Warehouse
//   cin7_mirror.products        → product info + stock_locator (pickface)
//   restock_setup               → capacity thresholds (shared)
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

  /* ── state ── */
  const state = {
    q: '',
    loading: false,
    allRows: [],
    rows: [],          // filtered
    weeksFilter: 'ALL', // ALL | CRITICAL | LOW | OK | GOOD | NO_SALES
    onlyGateway: false,
    onlyConfigured: false,
    page: 1,
    perPage: 30,
  };

  /* ── DOM refs ── */
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
      setTbody('<tr><td colspan="9" style="text-align:center;opacity:.7">No results</td></tr>');
      updatePager(0);
      return;
    }
    const start = (state.page - 1) * state.perPage;
    const page  = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    const html = page.map(r => {
      const sku       = escapeHtml(r.sku);
      const product   = escapeHtml(r.product);
      const pickface  = escapeHtml(r.stock_locator);
      const capacity  = r.capacity ?? '';
      const pfStock   = r.pickface_on_hand ?? 0;
      const totalMW   = r.total_mw ?? 0;
      const gwStock   = r.gateway_stock ?? 0;
      const avgMth    = r.avg_month_sales;
      const weeks     = r.weeks_available;
      const wCls      = classifyWeeks(weeks);

      const avgHtml   = avgMth != null
        ? `<span style="font-variant-numeric:tabular-nums">${Math.round(avgMth).toLocaleString()}</span>`
        : '<span style="opacity:.35">—</span>';

      const gwHtml    = gwStock > 0
        ? `<span style="font-weight:600;color:#0369a1">${gwStock.toLocaleString()}</span>`
        : '<span style="opacity:.35">0</span>';

      return `<tr>
        <td>${sku}</td>
        <td>${product}</td>
        <td>${pickface}</td>
        <td>${capacity}</td>
        <td>${pfStock}</td>
        <td>${totalMW}</td>
        <td>${gwHtml}</td>
        <td>${avgHtml}</td>
        <td>${weeksBadge(weeks, wCls.toLowerCase())}</td>
      </tr>`;
    }).join('');

    setTbody(html);
  }

  /* ═══════════════════════════════════════════════
     COUNTERS
     ═══════════════════════════════════════════════ */
  function updateCounters() {
    const c = { all: 0, critical: 0, low: 0, ok: 0, good: 0, no_sales: 0 };
    for (const r of state.allRows) {
      c.all++;
      const w = classifyWeeks(r.weeks_available);
      if (w === 'CRITICAL') c.critical++;
      else if (w === 'LOW') c.low++;
      else if (w === 'OK') c.ok++;
      else if (w === 'GOOD') c.good++;
      else c.no_sales++;
    }
    const u = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    u('countAll', c.all);
    u('countCritical', c.critical);
    u('countLow', c.low);
    u('countOk', c.ok);
    u('countGood', c.good);
    u('countNoSales', c.no_sales);
  }

  /* ═══════════════════════════════════════════════
     FILTERS & SORT
     ═══════════════════════════════════════════════ */
  function applyFilters(rows) {
    let out = rows.slice();

    // weeks filter
    if (state.weeksFilter !== 'ALL') {
      out = out.filter(r => classifyWeeks(r.weeks_available) === state.weeksFilter);
    }

    // only gateway stock
    if (state.onlyGateway) {
      out = out.filter(r => (r.gateway_stock || 0) > 0);
    }

    // only configured (has restock_setup)
    if (state.onlyConfigured) {
      out = out.filter(r => r.has_setup);
    }

    return out;
  }

  function sortRows(rows) {
    // Sort by weeks ascending (most urgent first), nulls last
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
    const filtered = applyFilters(state.allRows);
    const sorted   = sortRows(filtered);
    state.rows = sorted;
    render(sorted);
  }

  /* ═══════════════════════════════════════════════
     SYNC STATUS CARD (same as restock-v2)
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
        dot.style.background = '#f59e0b';
        text.textContent = 'cin7_mirror schema not accessible — expose it in Supabase API settings';
        text.style.color = '#92400e';
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
      const m = run.metrics || {};
      const dur = run.timing?.duration_ms ? `${(run.timing.duration_ms / 1000).toFixed(1)}s` : '';
      text.textContent = `${ok ? 'Last sync successful' : running ? 'Sync running…' : 'Last sync failed'}${m.products_synced ? ` • ${m.products_synced} prods, ${m.stock_synced} stock` : ''}${dur ? ` • ${dur}` : ''}`;
      text.style.color = ok ? '#166534' : running ? '#1d4ed8' : '#991b1b';
      const ts = run.ended_at || run.started_at;
      if (ts) {
        const d = new Date(ts), p = n => String(n).padStart(2, '0');
        time.textContent = `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
     FETCH DATA — Main logic
     ═══════════════════════════════════════════════ */
  async function fetchData() {
    if (!window.supabase || !window.supabaseReady) {
      setTbody('<tr><td colspan="9" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>');
      return;
    }
    state.loading = true;
    setTbody('<tr><td colspan="9" style="text-align:center;opacity:.7">Loading from Cin7 mirror…</td></tr>');

    try {
      await window.supabaseReady;

      /* 1. Sync status */
      await updateSyncStatusCard();

      /* 2. Stock snapshot — Main Warehouse */
      let stockRows = [];
      try {
        stockRows = await fetchAllRows('stock_snapshot', 'sku, location_name, bin, on_hand', {
          schema: 'cin7_mirror',
          eq: [['location_name', 'Main Warehouse']],
        });
      } catch (e) {
        console.warn('⚠️ Could not read cin7_mirror.stock_snapshot:', e.message);
        setTbody(`<tr><td colspan="9" style="text-align:center;color:#b45309;padding:30px">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ cin7_mirror schema not accessible</div>
          <div style="font-size:13px;color:#64748b">Expose <code>cin7_mirror</code> in Supabase → Settings → API → Exposed schemas, then run the first sync.</div>
        </td></tr>`);
        state.loading = false;
        return;
      }

      /* 3. Products */
      let productRows = [];
      try {
        productRows = await fetchAllRows('products', 'sku, name, stock_locator, category, brand, barcode', {
          schema: 'cin7_mirror',
        });
      } catch (e) { console.warn('⚠️ Could not read cin7_mirror.products:', e.message); }

      /* 4. Restock setup */
      const setupRows = await fetchAllRows('restock_setup', 'sku, product, pickface_location, pickface_qty, cap_min, cap_med, cap_max');

      /* 5. AVG monthly sales */
      let avgSalesRows = [];
      try {
        avgSalesRows = await fetchAllRows('branch_avg_monthly_sales', 'product, avg_mth_main');
      } catch (e) { console.warn('⚠️ Could not read branch_avg_monthly_sales:', e.message); }

      /* ── Build lookup maps ── */
      const productMap = Object.create(null);
      for (const p of productRows) productMap[p.sku] = p;

      const setupBySku = Object.create(null);
      for (const s of setupRows) {
        setupBySku[s.sku] = {
          product: s.product || '',
          pickface_location: s.pickface_location || '',
          pickface_qty: Number(s.pickface_qty) || 0,
          min: Number(s.cap_min),
          med: Number(s.cap_med),
          max: Number(s.cap_max),
        };
      }

      const avgSalesByName = Object.create(null);
      for (const a of avgSalesRows) {
        if (a.product) avgSalesByName[a.product.toUpperCase()] = Number(a.avg_mth_main) || 0;
      }

      /* ── Group stock by SKU ── */
      const stockBySku = Object.create(null);
      for (const s of stockRows) {
        if (!s.sku) continue;
        if (!stockBySku[s.sku]) stockBySku[s.sku] = [];
        stockBySku[s.sku].push(s);
      }

      /* ── Union of SKUs ── */
      const allSkus = new Set();
      for (const sku of Object.keys(stockBySku)) allSkus.add(sku);
      for (const sku of Object.keys(setupBySku)) allSkus.add(sku);

      /* ── Search filter ── */
      const q = (state.q || '').trim().toLowerCase();

      /* ── Build rows ── */
      const rows = [];
      for (const sku of allSkus) {
        const prod   = productMap[sku] || {};
        const setup  = setupBySku[sku];
        const stocks = stockBySku[sku] || [];

        const stockLocator = (prod.stock_locator || (setup ? setup.pickface_location : '') || '').trim();
        const normPickface = normalizeLocation(stockLocator);
        const productName  = prod.name || (setup ? setup.product : '') || sku;

        // Compute pickface on_hand, gateway stock, total MW
        let pickfaceOnHand = 0;
        let gatewayStock   = 0;
        let totalMW        = 0;

        for (const s of stocks) {
          const oh = Number(s.on_hand) || 0;
          totalMW += oh;

          const normBin = normalizeLocation(s.bin);
          if (normPickface && normBin === normPickface) {
            pickfaceOnHand += oh;
          }

          // Gateway bins start with MA-GA
          const binUp = (s.bin || '').toUpperCase().replace(/\s+/g, '');
          if (binUp.startsWith('MA-GA')) {
            gatewayStock += oh;
          }
        }

        // Capacity
        const capacity = setup ? setup.pickface_qty : 0;

        // AVG month sales
        const avgMonthSales = avgSalesByName[productName.toUpperCase()] ?? null;

        // Weeks available = totalMW / (avgMonthSales / WEEKS_PER_MONTH)
        let weeksAvailable = null;
        if (avgMonthSales != null && avgMonthSales > 0) {
          const weeklyRate = avgMonthSales / WEEKS_PER_MONTH;
          weeksAvailable = totalMW / weeklyRate;
        }

        const row = {
          sku,
          product: productName,
          stock_locator: stockLocator,
          capacity,
          pickface_on_hand: pickfaceOnHand,
          total_mw: totalMW,
          gateway_stock: gatewayStock,
          avg_month_sales: avgMonthSales,
          weeks_available: weeksAvailable,
          has_setup: !!setup,
        };

        // Client-side search
        if (q) {
          const hay = `${sku} ${productName} ${stockLocator}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }

        rows.push(row);
      }

      console.log(`📊 Gateway→Main: ${rows.length} products loaded (${stockRows.length} stock rows, ${productRows.length} products, ${setupRows.length} setups, ${avgSalesRows.length} avg sales)`);

      state.allRows = rows;
      updateCounters();
      rebuildView();

    } catch (e) {
      console.error('gateway-main fetch error', e);
      setTbody(`<tr><td colspan="9" style="text-align:center;color:#b91c1c">Failed to load data: ${escapeHtml(e.message)}</td></tr>`);
    } finally {
      state.loading = false;
    }
  }

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
  window.gwToggleOnlyGateway = function (f) { state.onlyGateway = !!f; rebuildView(); };
  window.gwToggleOnlyConfigured = function (f) { state.onlyConfigured = !!f; rebuildView(); };

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
