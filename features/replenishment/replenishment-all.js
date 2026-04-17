/**
 * Restock All Branches — Consolidated Distribution Planner
 * Distributes Main/Gateway stock across ALL branches simultaneously.
 * Proportional conflict resolution when branches compete for the same SKU.
 * Export as Excel with 1 sheet per branch (SKU, Product, Qty to Send).
 */

(function() {
  'use strict';

  // ============================================
  // CONSTANTS
  // ============================================

  const BRANCHES = [
    { code: 'SYD', name: 'Sydney', avgField: 'avg_mth_sydney' },
    { code: 'MEL', name: 'Melbourne', avgField: 'avg_mth_melbourne' },
    { code: 'BNE', name: 'Brisbane', avgField: 'avg_mth_brisbane' },
    { code: 'CNS', name: 'Cairns', avgField: 'avg_mth_cairns' },
    { code: 'CFS', name: 'Coffs Harbour', avgField: 'avg_mth_coffs_harbour' },
    { code: 'HBA', name: 'Hobart', avgField: 'avg_mth_hobart' },
    { code: 'SCS', name: 'Sunshine Coast', avgField: 'avg_mth_sunshine_coast' }
  ];

  const CIN7_LOCATION_MAP = {
    'main warehouse': 'MAIN', 'main': 'MAIN',
    'gateway': 'MAIN', 'gateway warehouse': 'MAIN',
    'sydney': 'SYD', 'sydney warehouse': 'SYD',
    'melbourne': 'MEL', 'melbourne warehouse': 'MEL',
    'brisbane': 'BNE', 'brisbane warehouse': 'BNE',
    'cairns': 'CNS', 'cairns warehouse': 'CNS',
    'coffs harbour': 'CFS', 'coffs harbour warehouse': 'CFS',
    'hobart': 'HBA', 'hobart warehouse': 'HBA',
    'sunshine coast warehouse': 'SCS', 'sunshine coast': 'SCS'
  };

  const WEEKS_IN_MONTH = 4.345;
  const BRANCH_TARGET_WEEKS = 6;
  const MAIN_MIN_WEEKS = 8;

  // ============================================
  // STATE
  // ============================================

  let state = {
    syncStatus: null,
    avgData: {},           // product → avg row
    stockData: {},         // "product:WAREHOUSE" → { qty_available, qty_on_hand }
    productNames: {},      // product → display name
    ctnMap: {},            // product → qty_per_ctn
    dcMap: {},             // product → dc code
    locationMap: {},       // product → pickface
    pendingTRs: {},        // branchCode → { product → { pending_qty } }

    // computed
    allocations: {},       // product → { branches: { CODE: qty }, mainStock, mainSafety, canSend, conflict }
    branchSendLists: {},   // CODE → [{ product, product_name, send_qty, ... }]
    activeTab: 'ALL'       // 'ALL' or branch code
  };

  // ============================================
  // INITIALIZATION
  // ============================================

  document.addEventListener('DOMContentLoaded', async () => {
    console.log('📦 Restock All Branches — initializing');
    showLoading(true);

    try {
      await window.supabaseReady;

      // Load sync status
      const { data: syncRuns } = await window.supabase
        .schema('cin7_mirror')
        .from('sync_runs')
        .select('run_id, started_at, ended_at, status')
        .order('ended_at', { ascending: false })
        .limit(1);

      if (!syncRuns || syncRuns.length === 0) {
        document.getElementById('alertContainer').innerHTML =
          '<div class="alert warning">No stock data available. Run Cin7 sync first.</div>';
        showLoading(false);
        return;
      }

      state.syncStatus = syncRuns[0];
      const d = new Date(state.syncStatus.ended_at || state.syncStatus.started_at);
      document.getElementById('snapshotDate').textContent =
        d.toLocaleDateString() + ' ' + d.toLocaleTimeString();

      // Load all data in parallel
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadCtnData(),
        loadAllPendingTRs()
      ]);

      console.log(`📊 AVG: ${Object.keys(state.avgData).length} | Stock: ${Object.keys(state.stockData).length} | CTN: ${Object.keys(state.ctnMap).length}`);

      // Run the global allocation algorithm
      calculateGlobalAllocation();

      // Build branch tabs
      renderBranchTabs();

      // Render table (default: ALL view)
      renderTable();
      updateSummary();

    } catch (err) {
      console.error('Error:', err);
      document.getElementById('alertContainer').innerHTML =
        `<div class="alert warning">Error loading data: ${err.message}</div>`;
    } finally {
      showLoading(false);
    }
  });

  // ============================================
  // DATA LOADING
  // ============================================

  async function loadAvgData() {
    let all = [], from = 0;
    while (true) {
      const { data, error } = await window.supabase
        .from('branch_avg_monthly_sales')
        .select('*')
        .range(from, from + 999);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    state.avgData = {};
    for (const r of all) state.avgData[r.product] = r;
  }

  async function loadStockData() {
    let all = [], from = 0;
    while (true) {
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('stock_snapshot')
        .select('sku, product_name, location_name, on_hand, available')
        .range(from, from + 999);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all = all.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    state.stockData = {};
    state.productNames = {};
    for (const r of all) {
      const loc = (r.location_name || '').toLowerCase().trim();
      const wh = CIN7_LOCATION_MAP[loc];
      if (!wh) continue;
      const key = `${r.sku}:${wh}`;
      if (!state.stockData[key]) {
        state.stockData[key] = { product: r.sku, warehouse_code: wh, qty_available: 0, qty_on_hand: 0 };
      }
      state.stockData[key].qty_available += (r.available != null ? r.available : r.on_hand || 0);
      state.stockData[key].qty_on_hand += (r.on_hand || 0);
      if (r.product_name && !state.productNames[r.sku]) {
        state.productNames[r.sku] = r.product_name;
      }
    }
  }

  async function loadCtnData() {
    try {
      let all = [], from = 0;
      while (true) {
        const { data, error } = await window.supabase
          .from('restock_setup')
          .select('product, qty_per_ctn, pickface_location')
          .range(from, from + 999);
        if (error) break;
        if (!data || data.length === 0) break;
        all = all.concat(data);
        if (data.length < 1000) break;
        from += 1000;
      }
      state.ctnMap = {};
      state.dcMap = {};
      state.locationMap = {};
      for (const r of all) {
        let p = (r.product || '').trim();
        const m = p.match(/^(\d{4,6})\s+(.+)$/);
        if (m) { state.dcMap[m[2].trim()] = m[1]; p = m[2].trim(); }
        if (p && r.qty_per_ctn > 0) state.ctnMap[p] = Number(r.qty_per_ctn);
        if (p && r.pickface_location) state.locationMap[p] = r.pickface_location;
      }
    } catch (e) { console.warn('CTN load failed:', e); }
  }

  async function loadAllPendingTRs() {
    state.pendingTRs = {};
    try {
      for (const b of BRANCHES) {
        const resp = await fetch(`/api/replenishment/pending-transfers/${b.code}`);
        if (resp.ok) {
          const data = await resp.json();
          state.pendingTRs[b.code] = data.products || {};
        }
      }
    } catch (e) { console.warn('Pending TRs load failed:', e); }
  }

  // ============================================
  // SMART CARTON ROUNDING
  // ============================================

  function smartCartonRound(suggestedQty, ctnQty, canSendQty, targetQty) {
    if (!ctnQty || ctnQty <= 0) return { qty: suggestedQty, rounded: 'none' };
    const roundedUp = Math.ceil(suggestedQty / ctnQty) * ctnQty;
    const roundedDown = Math.floor(suggestedQty / ctnQty) * ctnQty;
    if (suggestedQty === roundedUp) return { qty: suggestedQty, rounded: 'exact' };
    const maxAcceptable = targetQty ? targetQty * 3 : Infinity;
    if (roundedUp <= canSendQty && roundedUp <= maxAcceptable) return { qty: roundedUp, rounded: 'up' };
    if (roundedDown > 0) return { qty: roundedDown, rounded: 'down' };
    return { qty: suggestedQty, rounded: 'partial' };
  }

  // ============================================
  // GLOBAL ALLOCATION ALGORITHM
  // ============================================
  //
  // Single pass across ALL branches simultaneously.
  // 1. For every product, compute each branch's need.
  // 2. Sum total need vs Main available (after safety).
  // 3. If enough Main → give each branch what it needs.
  //    If not enough → distribute proportionally.
  // 4. Safety override: if any branch has sold deficit (available < 0),
  //    use Main safety stock to cover.
  // 5. Apply carton rounding on final quantities.
  // 6. Apply minimum threshold (skip tiny sends).

  function calculateGlobalAllocation() {
    const allProducts = new Set(Object.keys(state.avgData));
    // Also include products with stock in Main
    for (const key of Object.keys(state.stockData)) {
      const [sku, wh] = key.split(':');
      if (wh === 'MAIN') allProducts.add(sku);
    }

    state.allocations = {};
    state.branchSendLists = {};
    for (const b of BRANCHES) state.branchSendLists[b.code] = [];

    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;

      const avgRow = state.avgData[product];
      if (!avgRow) continue;

      const mainStock = state.stockData[`${product}:MAIN`];
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = Math.round(avgRow.avg_mth_main || 0);
      const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
      const mainSafety = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSendBase = Math.max(0, mainAvailable - mainSafety);
      const ctnQty = state.ctnMap[product] || 0;
      const productName = state.productNames[product] || '';

      // ── Step 1: compute each branch's raw need ──
      const branchNeeds = []; // { code, need, soldDeficit, branchAvailable, target, avgMonth }
      let totalNeed = 0;
      let anySoldDeficit = false;

      for (const b of BRANCHES) {
        const avgMonth = Math.round(avgRow[b.avgField] || 0);
        if (avgMonth <= 0) continue;

        const bStock = state.stockData[`${product}:${b.code}`];
        const branchAvailable = bStock?.qty_available || 0;
        const branchOnHand = bStock?.qty_on_hand || 0;
        const soldDeficit = branchAvailable < 0 ? Math.abs(branchAvailable) : 0;

        const avgWeek = avgMonth / WEEKS_IN_MONTH;
        const target = Math.ceil(avgWeek * BRANCH_TARGET_WEEKS);
        const rawNeed = Math.max(0, target - branchAvailable);

        // Subtract pending TRs
        const pendingQty = state.pendingTRs[b.code]?.[product]?.pending_qty || 0;
        const effectiveNeed = Math.max(0, rawNeed - pendingQty);

        if (effectiveNeed > 0) {
          branchNeeds.push({
            code: b.code, name: b.name,
            need: effectiveNeed, soldDeficit, branchAvailable, target, avgMonth, pendingQty
          });
          totalNeed += effectiveNeed;
          if (soldDeficit > 0) anySoldDeficit = true;
        }
      }

      if (branchNeeds.length === 0) continue;

      // ── Step 2: determine available pool ──
      // Safety override: if any branch has sold deficit and canSendBase is not enough → use full Main
      let pool = canSendBase;
      let safetyOverride = false;
      if (anySoldDeficit && canSendBase < totalNeed && mainAvailable > 0) {
        pool = mainAvailable;
        safetyOverride = true;
      }

      if (pool <= 0) continue; // nothing to send

      // ── Step 3: distribute pool across branches ──
      const hasConflict = totalNeed > pool;
      const branchAllocs = {};

      for (const bn of branchNeeds) {
        let allocated;
        if (hasConflict) {
          // Proportional distribution
          allocated = Math.floor((bn.need / totalNeed) * pool);
        } else {
          allocated = bn.need;
        }

        // Apply carton rounding
        const availableForRounding = hasConflict ? allocated : Math.min(allocated, pool);
        const ctnResult = smartCartonRound(allocated, ctnQty, availableForRounding, bn.target);
        let sendQty = ctnResult.qty;

        // Minimum threshold: skip tiny sends (unless branch has sold deficit)
        if (sendQty > 0 && bn.branchAvailable > 0 && bn.soldDeficit <= 0) {
          const weeklyDemand = bn.avgMonth / WEEKS_IN_MONTH;
          const minThreshold = Math.max(Math.ceil(weeklyDemand), 2);
          if (sendQty < minThreshold) sendQty = 0;
        }

        // Don't exceed remaining pool
        sendQty = Math.min(sendQty, pool);

        if (sendQty > 0) {
          branchAllocs[bn.code] = sendQty;
          pool -= sendQty; // deduct from remaining pool

          state.branchSendLists[bn.code].push({
            product,
            product_name: productName,
            send_qty: sendQty,
            ctn_qty: ctnQty,
            cartons: ctnQty > 0 ? Math.ceil(sendQty / ctnQty) : 0,
            branch_stock: bn.branchAvailable,
            need: bn.need,
            sold_deficit: bn.soldDeficit,
            has_conflict: hasConflict,
            safety_override: safetyOverride && sendQty > canSendBase
          });
        }
      }

      state.allocations[product] = {
        mainStock: mainAvailable,
        mainSafety,
        canSendBase,
        totalNeed,
        hasConflict,
        safetyOverride,
        branches: branchAllocs,
        productName
      };
    }

    // Sort each branch list by product code
    for (const code of Object.keys(state.branchSendLists)) {
      state.branchSendLists[code].sort((a, b) => a.product.localeCompare(b.product));
    }

    // Stats
    let totalSKUs = 0, totalUnits = 0;
    for (const code of Object.keys(state.branchSendLists)) {
      const list = state.branchSendLists[code];
      totalSKUs += list.length;
      totalUnits += list.reduce((s, l) => s + l.send_qty, 0);
    }
    console.log(`✅ Global allocation: ${totalSKUs} product-branch sends, ${totalUnits} total units`);
  }

  // ============================================
  // BRANCH TABS
  // ============================================

  function renderBranchTabs() {
    const bar = document.getElementById('branchTabs');
    if (!bar) return;

    let html = `<button class="branch-tab active" onclick="switchTab('ALL')">All <span class="tab-count">${Object.keys(state.allocations).length}</span></button>`;

    for (const b of BRANCHES) {
      const list = state.branchSendLists[b.code];
      const count = list.length;
      const units = list.reduce((s, l) => s + l.send_qty, 0);
      html += `<button class="branch-tab" onclick="switchTab('${b.code}')">${b.name} <span class="tab-count">${count}P · ${units}u</span></button>`;
    }

    bar.innerHTML = html;
  }

  window.switchTab = function(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.branch-tab').forEach(el => el.classList.remove('active'));
    event.target.closest('.branch-tab').classList.add('active');
    renderTable();
  };

  // ============================================
  // TABLE RENDERING
  // ============================================

  function renderTable() {
    const thead = document.querySelector('#planTable thead tr');
    const tbody = document.getElementById('planTableBody');

    if (state.activeTab === 'ALL') {
      renderAllView(thead, tbody);
    } else {
      renderBranchView(thead, tbody, state.activeTab);
    }
  }

  function renderAllView(thead, tbody) {
    // Build branch columns dynamically
    let thHtml = '<th style="text-align:left">Product</th><th>Main Stock</th><th>Main Safety</th><th>Can Send</th>';
    for (const b of BRANCHES) {
      thHtml += `<th><span class="branch-label">${b.code}</span></th>`;
    }
    thead.innerHTML = thHtml;

    // Collect products that have at least one send
    const products = Object.keys(state.allocations).filter(p => {
      const a = state.allocations[p];
      return Object.values(a.branches).some(q => q > 0);
    });

    if (products.length === 0) {
      tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:#64748b">No products need restocking across any branch.</td></tr>';
      return;
    }

    // Sort by product
    products.sort();

    let html = '';
    for (const product of products) {
      const a = state.allocations[product];
      const name = a.productName || '';
      const conflictDot = a.hasConflict ? ' <span class="conflict-dot" title="Branches competing for limited stock">⚡</span>' : '';
      const safetyDot = a.safetyOverride ? ' <span class="safety-badge" title="Safety stock overridden for sold deficit">⛑️</span>' : '';

      html += '<tr>';
      html += `<td class="product-cell"><div class="prod-code">${esc(product)}${conflictDot}${safetyDot}</div><div class="prod-name" title="${esc(name)}">${esc(name)}</div></td>`;
      html += `<td class="num-cell">${a.mainStock}</td>`;
      html += `<td class="num-cell">${a.mainSafety}</td>`;
      html += `<td class="num-cell">${a.canSendBase}</td>`;

      for (const b of BRANCHES) {
        const qty = a.branches[b.code] || 0;
        if (qty > 0) {
          html += `<td class="num-cell"><span class="send-val">${qty}</span></td>`;
        } else {
          html += `<td class="num-cell"><span class="send-dim">—</span></td>`;
        }
      }
      html += '</tr>';
    }

    tbody.innerHTML = html;
  }

  function renderBranchView(thead, tbody, branchCode) {
    thead.innerHTML = '<th style="text-align:left">Product</th><th>Send Qty</th><th>Cartons</th><th>Branch Stock</th><th>Need</th><th>Info</th>';

    const list = state.branchSendLists[branchCode] || [];

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:#64748b">No products to send to this branch.</td></tr>';
      return;
    }

    let html = '';
    for (const item of list) {
      const conflictDot = item.has_conflict ? ' ⚡' : '';
      const safetyDot = item.safety_override ? ' ⛑️' : '';
      const soldBadge = item.sold_deficit > 0 ? ` <span class="sold-deficit-val">(${item.sold_deficit} sold)</span>` : '';

      html += '<tr>';
      html += `<td class="product-cell"><div class="prod-code">${esc(item.product)}${conflictDot}${safetyDot}</div><div class="prod-name" title="${esc(item.product_name)}">${esc(item.product_name)}</div></td>`;
      html += `<td class="num-cell"><span class="send-val">${item.send_qty}</span></td>`;
      html += `<td class="num-cell">${item.ctn_qty > 0 ? item.cartons + ' ctn' : '—'}</td>`;
      html += `<td class="num-cell">${item.branch_stock}${soldBadge}</td>`;
      html += `<td class="num-cell">${item.need}</td>`;
      html += `<td class="num-cell">${item.has_conflict ? '<span class="conflict-dot" title="Proportional split">⚡ Split</span>' : ''}${item.safety_override ? '<span class="safety-badge"> ⛑️ Override</span>' : ''}</td>`;
      html += '</tr>';
    }

    tbody.innerHTML = html;
  }

  // ============================================
  // SUMMARY BAR
  // ============================================

  function updateSummary() {
    const bar = document.getElementById('summaryBar');
    if (!bar) return;

    let totalProducts = 0, totalUnits = 0, conflictProducts = 0, safetyOverrides = 0;
    const branchStats = [];

    for (const b of BRANCHES) {
      const list = state.branchSendLists[b.code];
      const count = list.length;
      const units = list.reduce((s, l) => s + l.send_qty, 0);
      if (count > 0) branchStats.push({ code: b.code, name: b.name, count, units });
      totalProducts += count;
      totalUnits += units;
    }

    for (const p of Object.keys(state.allocations)) {
      if (state.allocations[p].hasConflict) conflictProducts++;
      if (state.allocations[p].safetyOverride) safetyOverrides++;
    }

    let html = '';
    html += `<span class="sum-item">📦 <strong>${totalProducts}</strong> product-sends</span>`;
    html += `<span class="sum-sep">•</span>`;
    html += `<span class="sum-item">📊 <strong>${totalUnits.toLocaleString()}</strong> total units</span>`;
    html += `<span class="sum-sep">•</span>`;
    html += `<span class="sum-item">🏢 <strong>${branchStats.length}</strong> branches</span>`;

    if (conflictProducts > 0) {
      html += `<span class="sum-sep">•</span>`;
      html += `<span class="sum-item sum-warn">⚡ <strong>${conflictProducts}</strong> conflicts</span>`;
    }
    if (safetyOverrides > 0) {
      html += `<span class="sum-sep">•</span>`;
      html += `<span class="sum-item sum-crit">⛑️ <strong>${safetyOverrides}</strong> safety overrides</span>`;
    }

    bar.innerHTML = html;
    bar.style.display = 'flex';
  }

  // ============================================
  // EXCEL EXPORT — 1 sheet per branch
  // ============================================

  window.exportExcel = function() {
    if (typeof XLSX === 'undefined') {
      alert('SheetJS library not loaded. Please try again.');
      return;
    }

    const wb = XLSX.utils.book_new();
    let sheetCount = 0;

    for (const b of BRANCHES) {
      const list = state.branchSendLists[b.code];
      if (list.length === 0) continue;

      const rows = list.map(item => ({
        'SKU': item.product,
        'Product Name': item.product_name,
        'Qty to Send': item.send_qty
      }));

      const ws = XLSX.utils.json_to_sheet(rows);

      // Column widths
      ws['!cols'] = [
        { wch: 20 },  // SKU
        { wch: 45 },  // Product Name
        { wch: 12 }   // Qty
      ];

      XLSX.utils.book_append_sheet(wb, ws, b.name);
      sheetCount++;
    }

    if (sheetCount === 0) {
      alert('No products to export.');
      return;
    }

    const date = new Date();
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `Restock_All_Branches_${dateStr}.xlsx`);
  };

  // ============================================
  // HELPERS
  // ============================================

  function esc(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showLoading(show) {
    const el = document.getElementById('loadingOverlay');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

})();
