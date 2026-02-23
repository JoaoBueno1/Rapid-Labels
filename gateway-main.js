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
    page: 1,
    perPage: 30,
  };

  /* ── DOM refs ── */
  const COLS = 12;
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
      setTbody(`<tr><td colspan="${COLS}" style="text-align:center;opacity:.7">No results</td></tr>`);
      updatePager(0);
      return;
    }
    const start = (state.page - 1) * state.perPage;
    const page  = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    const html = page.map(r => {
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
      const weeks     = r.weeks_available;
      const wCls      = classifyWeeks(weeks);

      const avgHtml   = avgMth != null
        ? `<span style="font-variant-numeric:tabular-nums">${Math.round(avgMth).toLocaleString()}</span>`
        : '<span style="opacity:.35">—</span>';

      const gwHtml    = gwStock > 0
        ? `<span style="font-weight:600;color:#0369a1">${gwStock.toLocaleString()}</span>`
        : '<span style="opacity:.35">0</span>';

      const qtyCtnVal    = r.__qty_per_ctn;
      const qtyPalletVal = r.__qty_per_pallet;
      const qtyCtnHtml    = qtyCtnVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyCtnVal}</span>` : '<span style="opacity:.35">—</span>';
      const qtyPalletHtml = qtyPalletVal != null ? `<span style="font-variant-numeric:tabular-nums">${qtyPalletVal}</span>` : '<span style="opacity:.35">—</span>';

      return `<tr>
        <td style="font-variant-numeric:tabular-nums;font-size:12px;color:#64748b">${fiveDC}</td>
        <td>${skuDisplay}</td>
        <td>${productHtml}</td>
        <td>${pickface}</td>
        <td>${pfStock}</td>
        <td>${capacity}</td>
        <td>${totalMW}</td>
        <td>${gwHtml}</td>
        <td>${avgHtml}</td>
        <td>${weeksBadge(weeks, wCls.toLowerCase())}</td>
        <td>${qtyCtnHtml}</td>
        <td>${qtyPalletHtml}</td>
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
        setTbody(`<tr><td colspan="${COLS}" style="text-align:center;color:#b45309;padding:30px">
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">⚠️ cin7_mirror schema not accessible</div>
          <div style="font-size:13px;color:#64748b">Expose <code>cin7_mirror</code> in Supabase → Settings → API → Exposed schemas, then run the first sync.</div>
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
        avgSalesRows = await fetchAllRows('branch_avg_monthly_sales', 'product, avg_mth_main');
      } catch (e) { console.warn('⚠️ Could not read branch_avg_monthly_sales:', e.message); }

      /* ── Build lookup maps (same patterns as restock-v2) ── */

      // Product map: cin7 SKU → product record
      const productMap = Object.create(null);
      for (const p of productRows) productMap[p.sku] = p;

      // AVG sales by product name (uppercase)
      const avgSalesByName = Object.create(null);
      for (const a of avgSalesRows) {
        if (a.product) avgSalesByName[a.product.toUpperCase()] = Number(a.avg_mth_main) || 0;
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
        const avgMonthSales = avgSalesByName[displayProduct.toUpperCase()]
          ?? avgSalesByName[(fullDescription || '').toUpperCase()]
          ?? null;

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
