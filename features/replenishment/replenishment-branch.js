/**
 * Branch Replenishment Planner — Redesigned
 * Shows ONLY actionable items by default (send_qty > 0).
 * Simplified columns, print-ready transfer sheet.
 */

(function() {
  'use strict';

  // ============================================
  // CONFIG (shared across replenishment pages)
  // ============================================
  const CFG = window.ReplenishmentConfig;
  if (!CFG) {
    console.error('ReplenishmentConfig not loaded — include replenishment-config.js before replenishment-branch.js');
    return;
  }

  // Branch metadata as object keyed by code (matches legacy shape).
  const BRANCHES = {};
  for (const b of CFG.BRANCHES) BRANCHES[b.code] = { name: b.name, avgField: b.avgField, avgRepField: b.avgRepField };

  const CIN7_LOCATION_MAP = CFG.CIN7_LOCATION_MAP;
  const WEEKS_IN_MONTH = CFG.WEEKS_IN_MONTH;
  const BRANCH_TARGET_WEEKS = CFG.BRANCH_TARGET_WEEKS;
  const MAIN_MIN_WEEKS = CFG.MAIN_MIN_WEEKS;

  // ============================================
  // STATE
  // ============================================
  
  let state = {
    branchCode: null,
    branchInfo: null,
    syncStatus: null,
    syncAge: null,
    syncRunClass: null,
    plan: null,
    planLines: [],
    avgData: {},
    stockData: {},
    ctnMap: {},
    dcMap: {},
    productNames: {},      // product → display name
    locationMap: {},       // product → pickface location
    pendingTRs: {},        // product → { pending_qty, transfers: ['TR-XXXXX = QTY'] } — current branch only
    pendingTRsAllBranches: {}, // branchCode → { product → { pending_qty } } — used in conflict pass
    pendingTRList: [],     // array of { number, status, lines }
    pendingLoadFailed: false, // true when current-branch in-transit data couldn't load (double-send risk)
    pendingLoading: false,    // true while the (non-blocking) in-transit fetch is in flight
    cartonMode: false,     // Cartons Only mode toggle
    // Hide rows Main can't actually send (no Main stock / all in safety reserve).
    // Default ON so the plan only shows actionable lines. Persisted globally.
    hideNoMainStock: true,
    // Target weeks override — null means ABC tiers (default).
    // Persisted per-branch in localStorage.
    targetOverride: null,  // number | null
    selectedRows: new Set(),
    filter: 'to_send',    // Default: only actionable items
    search: '',
    currentPage: 1,
    pageSize: 100,
    sortField: 'cover_days',
    sortAsc: true          // Most urgent first
  };

  // ============================================
  // INITIALIZATION
  // ============================================
  
  document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(window.location.search);
    const branchCode = params.get('branch');
    
    if (!branchCode || !BRANCHES[branchCode]) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center"><h2>Invalid branch code</h2><a href="replenishment.html">Back to Overview</a></div>';
      return;
    }
    
    state.branchCode = branchCode;
    state.branchInfo = BRANCHES[branchCode];

    // Restore target settings from localStorage (per-branch).
    try {
      const stored = localStorage.getItem(`replenishment.targetOverride.${branchCode}`);
      if (stored !== null) {
        const n = parseInt(stored, 10);
        if (Number.isFinite(n) && n >= 1 && n <= 999) state.targetOverride = n;
      }
    } catch (e) { /* localStorage may be blocked — ignore */ }

    // Restore "hide what Main can't send" toggle (global, default ON).
    try {
      const h = localStorage.getItem('replenishment.hideNoMainStock');
      if (h !== null) state.hideNoMainStock = h === '1';
    } catch (e) { /* ignore */ }
    const hideChk = document.getElementById('hideNoMainStock');
    if (hideChk) hideChk.checked = state.hideNoMainStock;

    const branchNameEl = document.getElementById('branchName');
    const branchCodeEl = document.getElementById('branchCode');
    if (branchNameEl) branchNameEl.textContent = state.branchInfo.name;
    if (branchCodeEl) branchCodeEl.textContent = `(${branchCode})`;
    // Name the "This branch" column group with the actual branch.
    const groupBranchLabel = document.getElementById('groupBranchLabel');
    if (groupBranchLabel) groupBranchLabel.textContent = `This branch — ${state.branchInfo.name}`;
    document.title = `${state.branchInfo.name} — Transfer Plan`;

    console.log(`📦 Branch Replenishment: ${branchCode} - ${state.branchInfo.name}`);

    // Set default filter chip active
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === state.filter);
    });

    updateTargetBanner();
    await loadData();
  });

  // ============================================
  // LOAD DATA
  // ============================================
  
  async function loadData(force = false) {
    showLoading(true);

    try {
      await window.supabaseReady;
      
      // Filter status=success + ended_at IS NOT NULL — protects against
      // zombie "running" rows (NULL ended_at sorts FIRST in PG DESC).
      const { data: syncRuns, error: syncError } = await window.supabase
        .schema('cin7_mirror')
        .from('sync_runs')
        .select('run_id, started_at, ended_at, status, products_synced, stock_rows_synced')
        .eq('status', 'success')
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(1);
      
      if (syncError || !syncRuns || syncRuns.length === 0) {
        showNoSnapshot();
        return;
      }

      state.syncStatus = syncRuns[0];
      state.syncAge = CFG.classifySyncAge(state.syncStatus.ended_at);
      state.syncRunClass = CFG.classifySyncRun(state.syncStatus);
      updateSnapshotInfo();
      renderDataAlerts();

      if (state.syncAge.level === 'block') {
        // Hard block — don't render recommendations from stale data.
        const el = document.getElementById('alertContainer');
        if (el) {
          el.innerHTML += `<div class="alert critical">
            <strong>Recommendations hidden.</strong> Cin7 stock sync is more than ${Math.round(CFG.SYNC_BLOCK_MINUTES / 60)} hours old — data is likely wrong. Wait for the next successful sync before acting.
          </div>`;
        }
        const tbody = document.getElementById('planTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">Stock data is stale — refresh once sync recovers.</td></tr>';
        return;
      }

      console.log('Loading data...');
      // Block only on the data we need to draw the plan. Pending TRs (in-transit)
      // come from a throttled live Cin7 fetch that can take 20s+ on a cold cache,
      // so we DON'T block on it — we paint the plan immediately, then fill in the
      // in-transit numbers and recompute when they arrive (same pattern as the
      // overview). This avoids the page hanging + the double-send banner flashing
      // just because the first load was slow.
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadCtnData(),
        loadExistingPlan()
      ]);

      console.log('Data loaded, auto-generating plan...');
      console.log(`📊 AVG: ${Object.keys(state.avgData).length} | 📦 Stock: ${Object.keys(state.stockData).length} | 🗃️ CTN: ${Object.keys(state.ctnMap).length} | 📍 Locations: ${Object.keys(state.locationMap).length} | 🏷️ Names: ${Object.keys(state.productNames).length}`);

      state.pendingLoading = true;
      calculatePlan();
      renderTable();
      updateSummary();
      showLoading(false);   // plan is on screen — stop blocking the UI

      // Reactive pass: load in-transit, then recompute so sends subtract it.
      loadPendingTRs(force).then(() => {
        state.pendingLoading = false;
        calculatePlan();
        renderTable();
        updateSummary();
      }).catch(() => { state.pendingLoading = false; updateSummary(); });

    } catch (err) {
      console.error('Error loading data:', err);
      showError('Error loading data: ' + err.message);
    } finally {
      showLoading(false);
    }
  }

  function showNoSnapshot() {
    const el = document.getElementById('alertContainer');
    if (el) {
      el.innerHTML = '<div class="alert warning"><strong>No stock data available.</strong> Cin7 mirror sync has not run yet.</div>';
    }
  }

  function renderDataAlerts() {
    const el = document.getElementById('alertContainer');
    if (!el) return;
    const parts = [];
    if (state.syncAge && state.syncAge.level === 'warn') {
      parts.push(`<div class="alert warning">${escapeHtml(state.syncAge.message)}</div>`);
    }
    if (state.syncRunClass && state.syncRunClass.warn && state.syncRunClass.message) {
      parts.push(`<div class="alert warning">${escapeHtml(state.syncRunClass.message)}</div>`);
    }
    el.innerHTML = parts.join('');
  }

  function updateSnapshotInfo() {
    const el = document.getElementById('snapshotDate');
    if (el && state.syncStatus) {
      const date = new Date(state.syncStatus.ended_at || state.syncStatus.started_at);
      // Compact: "12 May 14:32"
      const opts = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' };
      el.textContent = date.toLocaleString(undefined, opts).replace(',', '');
    }
    // Reflect sync level on the pill
    const pill = document.getElementById('syncPill');
    if (pill) {
      pill.classList.remove('warn', 'block');
      const lvl = state.syncAge?.level;
      if (lvl === 'warn') pill.classList.add('warn');
      else if (lvl === 'block') pill.classList.add('block');
      if (state.syncAge?.message) pill.title = state.syncAge.message;
    }
  }

  async function loadAvgData() {
    let allData = [];
    let from = 0;
    const batchSize = 1000;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('branch_avg_monthly_sales')
        .select('*')
        .range(from, from + batchSize - 1);
      
      if (error) throw error;
      if (!data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < batchSize) break;
      from += batchSize;
    }
    
    state.avgData = {};
    for (const row of allData) {
      state.avgData[row.product] = row;
    }
  }

  async function loadStockData() {
    let allData = [];
    let from = 0;
    const batchSize = 1000;
    
    while (true) {
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('stock_snapshot')
        .select('sku, product_name, location_name, on_hand, available')
        .range(from, from + batchSize - 1);
      
      if (error) throw error;
      if (!data || data.length === 0) break;
      allData = allData.concat(data);
      if (data.length < batchSize) break;
      from += batchSize;
    }
    
    state.stockData = {};
    state.productNames = {};
    
    for (const row of allData) {
      const locName = (row.location_name || '').toLowerCase().trim();
      const warehouseCode = CIN7_LOCATION_MAP[locName];
      if (!warehouseCode) continue;
      
      const key = `${row.sku}:${warehouseCode}`;
      if (!state.stockData[key]) {
        state.stockData[key] = {
          product: row.sku,
          warehouse_code: warehouseCode,
          qty_available: 0,
          qty_on_hand: 0
        };
      }
      state.stockData[key].qty_available += (row.available != null ? row.available : row.on_hand || 0);
      state.stockData[key].qty_on_hand += (row.on_hand || 0);
      
      // Build product names map (take first non-empty name per SKU)
      if (row.product_name && !state.productNames[row.sku]) {
        state.productNames[row.sku] = row.product_name;
      }
    }
  }

  async function loadCtnData() {
    try {
      let allRows = [];
      let from = 0;
      const batchSize = 1000;
      while (true) {
        const { data, error } = await window.supabase
          .from('restock_setup')
          .select('product, qty_per_ctn, pickface_location')
          .range(from, from + batchSize - 1);
        if (error) { console.warn('Could not load CTN data:', error); return; }
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < batchSize) break;
        from += batchSize;
      }
      
      state.ctnMap = {};
      state.dcMap = {};
      state.locationMap = {};
      
      for (const row of allRows) {
        let product = (row.product || '').trim();
        const spaceMatch = product.match(/^(\d{4,6})\s+(.+)$/);
        if (spaceMatch) {
          state.dcMap[spaceMatch[2].trim()] = spaceMatch[1];
          product = spaceMatch[2].trim();
        }
        if (product && row.qty_per_ctn > 0) {
          state.ctnMap[product] = Number(row.qty_per_ctn);
        }
        if (product && row.pickface_location) {
          state.locationMap[product] = row.pickface_location;
        }
      }
    } catch (err) {
      console.warn('CTN data load failed:', err);
    }
  }

  // Delegate to the shared rounder so rules stay consistent across pages.
  const smartCartonRound = CFG.smartCartonRound;

  async function loadExistingPlan() {
    const { data: plans, error } = await window.supabase
      .from('transfer_plans')
      .select('*')
      .eq('branch_code', state.branchCode)
      .order('created_at', { ascending: false })
      .limit(1);
    
    if (error) throw error;
    
    if (plans && plans.length > 0) {
      state.plan = plans[0];
      const { data: lines, error: linesError } = await window.supabase
        .from('transfer_plan_lines')
        .select('*')
        .eq('plan_id', state.plan.id);
      if (linesError) throw linesError;
      state.planLines = lines || [];
    }
  }

  async function loadPendingTRs(force = false) {
    // Load pending TRs for ALL branches so the conflict-detection pass below
    // can subtract in-transit qty from each branch's effective need.
    //
    // Strategy: await ONLY the current branch (needed for second pass).
    // Other branches load in parallel in background — if they finish before
    // calculatePlan() runs they're used; if not, conflict detection falls
    // back to raw need for those branches (still correct, just less precise).
    //
    // The server caches results, so this is normally instant; the timeout is a
    // generous backstop for a COLD cache (Cin7 line fetch throttles 3.5s/TR).
    // It was 4s before, which reliably aborted on branches with 2+ TRs and left
    // the plan with NO in-transit data → double-send. 15s + the server cache
    // fixes that; if it still fails we flag it loudly (see pendingLoadFailed).
    const PENDING_TIMEOUT_MS = 25000;
    const qs = force ? '?fresh=1' : '';
    state.pendingTRs = {};
    state.pendingTRList = [];
    state.pendingTRsAllBranches = {};
    state.pendingLoadFailed = false;

    const fetchBranchPending = async (code) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PENDING_TIMEOUT_MS);
      try {
        const resp = await fetch(`/api/replenishment/pending-transfers/${code}${qs}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) return null;
        return await resp.json();
      } catch (err) {
        clearTimeout(timer);
        return null;
      }
    };

    // Step 1: await current branch (blocks page so calculatePlan has accurate data for self)
    const currentData = await fetchBranchPending(state.branchCode);
    if (currentData) {
      state.pendingTRs = currentData.products || {};
      state.pendingTRList = currentData.transfers || [];
      state.pendingTRsAllBranches[state.branchCode] = currentData.products || {};
    } else {
      // Couldn't confirm what's already on the way → the plan can't subtract it,
      // so it may recommend re-sending in-transit stock. Surface this loudly
      // instead of silently double-sending (updateSummary renders the banner).
      state.pendingLoadFailed = true;
      console.warn(`Pending TRs for ${state.branchCode}: failed or timed out — in-transit not applied`);
    }

    const trCount = state.pendingTRList.length;
    const productCount = Object.keys(state.pendingTRs).length;
    console.log(`📋 Pending TRs (current ${state.branchCode}): ${trCount} transfers, ${productCount} products in transit`);

    // Step 2: load OTHER branches in background — non-blocking.
    const otherBranches = Object.keys(BRANCHES).filter(c => c !== state.branchCode);
    Promise.allSettled(otherBranches.map(async (code) => {
      const data = await fetchBranchPending(code);
      if (data) {
        state.pendingTRsAllBranches[code] = data.products || {};
      }
    })).then(() => {
      const loadedCount = Object.keys(state.pendingTRsAllBranches).length;
      console.log(`📋 Pending TRs background load complete: ${loadedCount}/${Object.keys(BRANCHES).length} branches`);
    });
  }

  // ============================================
  // CALCULATION — Two-pass algorithm (preserved)
  // ============================================
  
  function calculatePlan() {
    const lines = [];
    const branchCode = state.branchCode;
    const branchInfo = state.branchInfo;
    
    // Collect ALL unique products (AVG + stock in this branch)
    const productSet = new Set(Object.keys(state.avgData));
    for (const key of Object.keys(state.stockData)) {
      const parts = key.split(':');
      if (parts[1] === branchCode || parts[1] === 'MAIN') {
        productSet.add(parts[0]);
      }
    }
    const allProducts = Array.from(productSet);

    // Compute ABC ranks once for the whole catalog (top-20% A → 12 wk target,
    // next-30% B → 8 wk, rest C → 6 wk). Lets the algorithm give top movers
    // proper cover without inflating tail SKUs.
    state.abcRanks = CFG.computeAbcRanks(Object.values(state.avgData));

    // ──────── FIRST PASS: calculate needs for ALL branches (conflict detection) ────────
    // Each branch's "need" here is the EFFECTIVE need (target − branch stock − pending TRs).
    const allBranchNeeds = {};
    for (const product of allProducts) {
      if (CFG.isExcludedProduct(product, state.productNames[product])) continue;

      const avgRow = state.avgData[product];
      if (!avgRow) continue;

      const mainStock = state.stockData[`${product}:MAIN`];
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = CFG.pickMainAvg(avgRow);  // raw, not rounded
      const mainMinQty = CFG.computeMainSafety(avgMonthMain);
      const canSendBase = Math.max(0, mainAvailable - mainMinQty);

      const tier = state.abcRanks.get(product) || 'C';
      // Custom override beats ABC tier (when user set one via the modal).
      const targetWeeks = state.targetOverride || CFG.targetWeeksForTier(tier);

      let totalNeed = 0;
      let anyOversold = false;
      const branchNeeds = {};

      for (const [code, info] of Object.entries(BRANCHES)) {
        const avgMonth = CFG.pickAvg(avgRow, info);  // raw, no early round
        if (avgMonth <= 0) continue;

        const branchStk = state.stockData[`${product}:${code}`];
        const branchAvailable = branchStk?.qty_available || 0;
        const soldDeficit = branchAvailable < 0 ? Math.abs(branchAvailable) : 0;
        const target = CFG.computeBranchTarget(avgMonth, targetWeeks);
        const rawNeed = Math.max(0, target - branchAvailable);

        const pending = state.pendingTRsAllBranches?.[code]?.[product]?.pending_qty || 0;
        const effectiveNeed = Math.max(0, rawNeed - pending);

        if (effectiveNeed > 0) {
          branchNeeds[code] = { need: effectiveNeed, soldDeficit };
          totalNeed += effectiveNeed;
          if (soldDeficit > 0) anyOversold = true;
        }
      }

      // If any competing branch is oversold AND base canSend can't cover total
      // need, the safety-override pool kicks in (mainAvailable, ignoring safety).
      // The conflict pool must reflect this so proportional shares match reality.
      let conflictPool = canSendBase;
      let overrideActiveInConflict = false;
      if (anyOversold && canSendBase < totalNeed && mainAvailable > 0) {
        conflictPool = mainAvailable;
        overrideActiveInConflict = true;
      }

      allBranchNeeds[product] = {
        totalNeed,
        canSend: conflictPool,
        canSendBase,
        overrideActiveInConflict,
        branches: branchNeeds,
        hasConflict: totalNeed > conflictPool && conflictPool > 0 && Object.keys(branchNeeds).length > 1
      };
    }
    
    // ──────── SECOND PASS: build product lines ────────
    for (const product of allProducts) {
      if (CFG.isExcludedProduct(product, state.productNames[product])) continue;
      
      const avgRow = state.avgData[product];
      // Use raw (non-rounded) avgs throughout — Math.round on small decimals
      // dropped fractional-demand SKUs and caused tiny precision drift.
      const avgMonthBranch = CFG.pickAvg(avgRow, branchInfo);
      const avgMonthBranchRaw = avgMonthBranch;
      const branchStock = state.stockData[`${product}:${branchCode}`];
      const mainStock = state.stockData[`${product}:MAIN`];
      const branchAvailable = branchStock?.qty_available || 0;
      const branchOnHand = branchStock?.qty_on_hand || 0;
      const branchCommitted = Math.max(0, branchOnHand - branchAvailable);
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = CFG.pickMainAvg(avgRow);
      const avgMonthMainRaw = avgMonthMain;
      // ABC tier and resulting target weeks (custom override wins)
      const tier = state.abcRanks?.get(product) || 'C';
      const targetWeeks = state.targetOverride || CFG.targetWeeksForTier(tier);
      // Main "abundance" flag (>12 months own cover) — used by slow-mover
      // carton bias inside smartCartonRound.
      const mainAbundant = avgMonthMain > 0
        ? (mainAvailable / avgMonthMain) > 12
        : mainAvailable > 0;
      const ctnQty = state.ctnMap[product] || 0;
      const dcCode = state.dcMap[product] || '';
      const productName = state.productNames[product] || '';
      const location = state.locationMap[product] || '';
      const pendingInfo = state.pendingTRs[product] || null;
      const pendingQty = pendingInfo ? pendingInfo.pending_qty : 0;
      // Sold deficit: when available < 0, stock is oversold
      const soldDeficit = branchAvailable < 0 ? Math.abs(branchAvailable) : 0;
      
      // ── NO AVG for this branch ──
      // Rule: align with overview/all-branches pages — skip entirely unless
      //   the branch is OVERSOLD (negative stock) for this SKU. Oversold
      //   must surface even without AVG history because the customer already
      //   sold it and we have to chase the stock.
      if (avgMonthBranch <= 0) {
        if (soldDeficit > 0) {
          lines.push({
            product, dc_code: dcCode, product_name: productName, location,
            category: 'no_avg',
            cover_days: 0, branch_stock: branchAvailable, branch_on_hand: branchOnHand, branch_committed: branchCommitted, sold_deficit: soldDeficit,
            avg_branch: 0, avg_branch_raw: 0,
            main_stock: mainAvailable, avg_main: avgMonthMain, avg_main_raw: avgMonthMainRaw,
            can_send: 0, main_safety: 0, need_qty: soldDeficit,
            send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
            cartons: 0,
            pending_qty: pendingQty, pending_transfers: pendingInfo?.transfers || [],
            has_conflict: false, conflict_branches: [], conflict_detail: null,
            send_note: 'no_avg_oversold'
          });
        }
        continue;
      }
      
      const avgWeekBranch = avgMonthBranch / WEEKS_IN_MONTH;
      const coverDays = avgWeekBranch > 0 ? Math.max(0, Math.round((branchAvailable / avgWeekBranch) * 7)) : 999;
      const targetQty = CFG.computeBranchTarget(avgMonthBranch, targetWeeks);
      const needQty = Math.max(0, targetQty - branchAvailable);
      const mainMinQty = CFG.computeMainSafety(avgMonthMain);
      const canSendQty = Math.max(0, mainAvailable - mainMinQty);

      let category;
      if (coverDays < CFG.COVER_CRITICAL_DAYS) category = 'critical';
      else if (coverDays < CFG.COVER_WARNING_DAYS) category = 'warning';
      else if (coverDays < CFG.COVER_OK_DAYS) category = 'ok';
      else category = 'sufficient';
      
      const conflict = allBranchNeeds[product];
      const conflictBranches = conflict?.hasConflict
        ? Object.keys(conflict.branches).filter(c => c !== branchCode)
        : [];
      
      // ── SUFFICIENT: no need to send OR branch already at target weeks ──
      // The cover check catches "dribble" cases where need rounds to 1-2
      // units just because target is slightly above branch_stock (e.g.
      // SOH=152, target=153, need=1 → branch actually has 4.68 weeks
      // cover and target_weeks is 4 → no need to ship anything).
      const coverWeeksNow = avgWeekBranch > 0 ? branchAvailable / avgWeekBranch : 0;
      const alreadyAtTarget = coverWeeksNow >= targetWeeks;
      if ((needQty <= 0 || alreadyAtTarget) && soldDeficit <= 0) {
        lines.push({
          product, dc_code: dcCode, product_name: productName, location,
          category,
          cover_days: coverDays, branch_stock: branchAvailable, branch_on_hand: branchOnHand, branch_committed: branchCommitted, sold_deficit: soldDeficit,
          avg_branch: avgMonthBranch, avg_branch_raw: avgMonthBranchRaw,
          main_stock: mainAvailable, avg_main: avgMonthMain, avg_main_raw: avgMonthMainRaw,
          can_send: canSendQty, main_safety: mainMinQty, need_qty: needQty,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          cartons: 0,
          pending_qty: pendingQty, pending_transfers: pendingInfo?.transfers || [],
          has_conflict: false, conflict_branches: [], conflict_detail: null,
          send_note: alreadyAtTarget && needQty > 0 ? 'cover_at_target' : null
        });
        continue;
      }
      
      // ── NO MAIN STOCK to send (but allow override for sold deficit) ──
      if (canSendQty <= 0 && soldDeficit <= 0) {
        lines.push({
          product, dc_code: dcCode, product_name: productName, location,
          category,
          cover_days: coverDays, branch_stock: branchAvailable, branch_on_hand: branchOnHand, branch_committed: branchCommitted, sold_deficit: soldDeficit,
          avg_branch: avgMonthBranch, avg_branch_raw: avgMonthBranchRaw,
          main_stock: mainAvailable, avg_main: avgMonthMain, avg_main_raw: avgMonthMainRaw,
          can_send: 0, main_safety: mainMinQty, need_qty: needQty,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          cartons: 0,
          pending_qty: pendingQty, pending_transfers: pendingInfo?.transfers || [],
          has_conflict: conflict?.hasConflict || false, conflict_branches: conflictBranches,
          conflict_detail: null, send_note: 'no_main_stock'
        });
        continue;
      }
      
      // ── NEEDS STOCK: apply smart rules ──
      // Account for in-transit stock: reduce effective need
      const effectiveNeedQty = Math.max(0, needQty - pendingQty);
      
      // Safety override: if branch has sold deficit, allow using Main safety stock
      let effectiveCanSend = canSendQty;
      let safetyOverride = false;
      if (soldDeficit > 0 && canSendQty < effectiveNeedQty && mainAvailable > 0) {
        // Allow sending up to all Main available stock (ignore safety) to cover sold orders
        effectiveCanSend = mainAvailable;
        safetyOverride = true;
      }
      
      let allocatedQty = Math.min(effectiveNeedQty, effectiveCanSend);
      let conflictDetail = null;

      if (conflict?.hasConflict && conflict.branches[branchCode]) {
        const thisBranchNeed = conflict.branches[branchCode].need;
        const totalNeed = conflict.totalNeed;

        // When safety override is active for THIS branch (it's oversold),
        // bypass the proportional cap. Oversold branches are paid first up
        // to their full need; remaining stock then splits proportionally
        // across the others (mirrors the all-branches global allocator).
        // Without this, an oversold branch could be capped to a tiny share
        // while Main has stock to clear its deficit.
        const skipProportionalCap = safetyOverride && soldDeficit > 0;

        const proportionalShare = Math.floor((thisBranchNeed / totalNeed) * conflict.canSend);
        if (!skipProportionalCap) {
          allocatedQty = Math.min(allocatedQty, proportionalShare);
        }

        conflictDetail = {
          thisBranchNeed,
          totalNeed,
          mainCanSend: conflict.canSend,
          proportionalShare,
          oversoldPriority: skipProportionalCap,
          otherBranches: Object.entries(conflict.branches)
            .filter(([c]) => c !== branchCode)
            .map(([code, info]) => ({ code, need: info.need }))
        };
      }
      
      let sendNote = null;
      let sendQty = 0;
      let rounded = 'none';
      let blockedQty = 0;
      
      // ── CARTONS ONLY MODE ──
      // Send ONLY what's needed, rounded UP to full ctn. Not max-fits.
      // Two gates:
      //   • If branch already has ≥ target_weeks of cover → skip
      //   • If 1 carton would push post-send stock past 2× target → skip
      //
      // Need = effectiveNeedQty (target − branch_stock − pending_TRs).
      // Carton qty = ceil(need / ctn) × ctn.
      if (state.cartonMode) {
        const cartonCanSend = safetyOverride ? mainAvailable : canSendQty;
        const coverNow = avgMonthBranch > 0
          ? branchAvailable / (avgMonthBranch / WEEKS_IN_MONTH)
          : 0;

        if (ctnQty <= 0) {
          sendNote = 'no_ctn';
        } else if (cartonCanSend < ctnQty) {
          sendNote = 'no_main_stock';
        } else if (coverNow >= targetWeeks && soldDeficit <= 0) {
          // Branch already at/above target weeks of cover — no need to ship
          // cartons unless there's a sold deficit. This avoids the "send 4
          // cartons because there's room" greedy behaviour.
          sendNote = 'cover_at_target';
        } else if (effectiveNeedQty <= 0) {
          sendNote = 'already_in_transit';
        } else {
          // Cartons needed to satisfy the demand (post-conflict / pending)
          const cartonsNeeded = Math.ceil(effectiveNeedQty / ctnQty);
          const candidateQty = cartonsNeeded * ctnQty;

          // Cap — same as default mode's smart round-up. Months cap rises
          // with target to avoid blocking high-target users (e.g. 20w).
          const ratioCap  = targetQty * CFG.CARTON_ROUND_UP_MAX_RATIO;
          const capMonths = Math.max(CFG.CARTON_ROUND_UP_MAX_MONTHS, targetWeeks / WEEKS_IN_MONTH);
          const monthsCap = Math.ceil(avgMonthBranch * capMonths);
          const cap = Math.min(ratioCap, monthsCap);
          const postSendStock = branchAvailable + candidateQty;

          if (postSendStock > cap) {
            sendNote = 'carton_over_target';
          } else if (candidateQty > cartonCanSend) {
            sendNote = 'no_main_stock';
          } else {
            sendQty = candidateQty;
            rounded = 'exact';
            allocatedQty = sendQty;
          }
        }
      }
      // ── DEFAULT MODE ──
      else {
        if (allocatedQty > 0) {
          // canSend cap for the rounder is the BRANCH's allocation (post conflict),
          // not the Main pool. Otherwise a carton round-up could exceed the
          // proportional split and steal stock from competing branches.
          const ctnResult = smartCartonRound(allocatedQty, ctnQty, allocatedQty, targetQty, {
            avgMonthBranch,
            branchAvailable,
            mainAbundant,
            targetWeeks  // lets monthsCap rise when user picks high target
          });
          sendQty = ctnResult.qty;
          rounded = ctnResult.rounded;
          
          if (branchAvailable > 0 && sendQty > 0) {
            const minThreshold = CFG.computeMinSend(ctnQty, avgMonthBranch);
            if (sendQty < minThreshold) {
              // Soft flag — qty preserved, manager review.
              sendNote = 'small_send';
              blockedQty = minThreshold;
            }
          }
        } else {
          if (effectiveNeedQty <= 0) {
            sendNote = 'already_in_transit';
          } else if (soldDeficit > 0 && mainAvailable <= 0) {
            sendNote = 'main_empty_sold';
          } else {
            sendNote = 'allocation_zero';
          }
        }
      }
      
      // If safety override is active, mark send_note
      if (safetyOverride && sendQty > 0 && sendQty > canSendQty) {
        sendNote = 'safety_override';
      }
      
      lines.push({
        product, dc_code: dcCode, product_name: productName, location,
        category,
        cover_days: coverDays, branch_stock: branchAvailable, branch_on_hand: branchOnHand, branch_committed: branchCommitted, sold_deficit: soldDeficit,
        avg_branch: avgMonthBranch, avg_branch_raw: avgMonthBranchRaw,
        main_stock: mainAvailable, avg_main: avgMonthMain, avg_main_raw: avgMonthMainRaw,
        can_send: canSendQty, main_safety: mainMinQty, need_qty: needQty,
        send_qty: sendQty, raw_qty: allocatedQty, blocked_qty: blockedQty,
        ctn_qty: ctnQty || null, rounded, safety_override: safetyOverride && sendQty > canSendQty,
        cartons: (sendQty > 0 && ctnQty > 0) ? Math.ceil(sendQty / ctnQty) : 0,
        pending_qty: pendingQty, pending_transfers: pendingInfo?.transfers || [],
        has_conflict: conflict?.hasConflict || false, conflict_branches: conflictBranches,
        conflict_detail: conflictDetail, send_note: sendNote
      });
    }
    
    lines.sort((a, b) => a.cover_days - b.cover_days);
    
    state.planLines = lines;
    console.log(`Plan: ${lines.length} total (${lines.filter(l => l.send_qty > 0).length} to send)`);
  }

  // Full reload from Cin7/DB (matches the button's "Reload data from Cin7"
  // tooltip). Forces a fresh pending-TR fetch so in-transit is re-confirmed —
  // this is the retry path when the double-send warning is showing.
  window.generatePlan = function() {
    loadData(true);
  };

  window.toggleCartonMode = function() {
    state.cartonMode = !state.cartonMode;
    const btn = document.getElementById('cartonModeBtn');
    const rules = document.getElementById('cartonModeRules');
    if (btn) {
      btn.classList.toggle('active', state.cartonMode);
      btn.textContent = state.cartonMode ? 'Cartons only · ON' : 'Cartons only';
    }
    if (rules) {
      rules.style.display = state.cartonMode ? 'inline-block' : 'none';
    }
    calculatePlan();
    renderTable();
    updateSummary();
  };

  // Toggle hiding rows Main can't send. Pure view change — no recompute needed.
  window.toggleHideNoMainStock = function() {
    const chk = document.getElementById('hideNoMainStock');
    state.hideNoMainStock = chk ? chk.checked : !state.hideNoMainStock;
    try { localStorage.setItem('replenishment.hideNoMainStock', state.hideNoMainStock ? '1' : '0'); } catch (e) {}
    state.currentPage = 1;
    renderTable();
    updateSummary();
  };

  // ============================================
  // RENDERING — Simplified
  // ============================================
  
  function renderTable() {
    const tbody = document.getElementById('planTableBody');
    if (!tbody) return;
    
    let lines = getFilteredLines();
    lines = sortLines(lines);
    
    // Result count
    const resultCount = document.getElementById('resultCount');
    if (resultCount) resultCount.textContent = `${lines.length} products`;
    
    // Pagination
    const totalPages = Math.ceil(lines.length / state.pageSize);
    const start = (state.currentPage - 1) * state.pageSize;
    const pageLines = lines.slice(start, start + state.pageSize);
    
    if (pageLines.length === 0) {
      const transitNote = Object.keys(state.pendingTRs || {}).length > 0
        ? ' — some stock is already on the way (see In transit)'
        : '';
      tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">' +
        (state.filter === 'to_send'
          ? 'No products to send right now (stock sufficient or already on the way)' + transitNote
          : 'No products match the current filter') +
        '</td></tr>';
      updatePagination(0, 0);
      return;
    }
    
    // Select-all checkbox
    const selectAllEl = document.getElementById('selectAllCheck');
    if (selectAllEl) {
      const sendableLines = lines.filter(l => l.send_qty > 0);
      const allSelected = sendableLines.length > 0 && sendableLines.every(l => state.selectedRows.has(l.product));
      const someSelected = sendableLines.some(l => state.selectedRows.has(l.product));
      selectAllEl.checked = allSelected;
      selectAllEl.indeterminate = !allSelected && someSelected;
    }
    
    tbody.innerHTML = pageLines.map(line => {
      // Cover badge
      let coverBadge = '';
      if (line.category === 'no_avg') {
        coverBadge = '<span class="cover-badge cover-na">N/A</span>';
      } else if (line.cover_days >= 999) {
        coverBadge = '<span class="cover-badge cover-suf">∞</span>';
      } else if (line.cover_days < CFG.COVER_CRITICAL_DAYS) {
        coverBadge = `<span class="cover-badge cover-crit">${line.cover_days}d</span>`;
      } else if (line.cover_days < CFG.COVER_WARNING_DAYS) {
        coverBadge = `<span class="cover-badge cover-warn">${line.cover_days}d</span>`;
      } else if (line.cover_days < CFG.COVER_OK_DAYS) {
        coverBadge = `<span class="cover-badge cover-ok">${line.cover_days}d</span>`;
      } else {
        coverBadge = `<span class="cover-badge cover-suf">${line.cover_days}d</span>`;
      }
      
      // Conflict indicator
      let conflictIcon = '';
      if (line.has_conflict && line.conflict_branches.length > 0) {
        let tipLines = [];
        if (line.conflict_detail) {
          const cd = line.conflict_detail;
          tipLines.push('ALLOCATION CONFLICT');
          tipLines.push(`Main can send: ${cd.mainCanSend}`);
          tipLines.push(`Total demand: ${cd.totalNeed}`);
          tipLines.push(`Your share: ${cd.proportionalShare} (${Math.round(cd.thisBranchNeed / cd.totalNeed * 100)}%)`);
          for (const ob of cd.otherBranches) {
            tipLines.push(`${ob.code}: ${ob.need}`);
          }
        }
        conflictIcon = ` <span class="conflict-dot" title="${escapeHtml(tipLines.join('\n'))}">!</span>`;
      }
      
      // Send qty display
      let sendDisplay = '';
      if (line.send_qty > 0) {
        let ctnBadge = '';
        if (line.rounded === 'up') ctnBadge = ' <span class="rnd-badge rnd-up" title="Rounded up from ' + line.raw_qty + '">▲</span>';
        else if (line.rounded === 'down') ctnBadge = ' <span class="rnd-badge rnd-down" title="Rounded down from ' + line.raw_qty + '">▼</span>';
        let safetyBadge = '';
        let shortBadge = '';
        if (line.safety_override) {
          const shortfall = line.need_qty - line.send_qty;
          const overrideTip = [
            'SAFETY OVERRIDE — sold orders',
            '───────────',
            'Total need: ' + line.need_qty,
            (line.sold_deficit > 0 ? '  Sold (committed): ' + line.sold_deficit : ''),
            '  Target (' + BRANCH_TARGET_WEEKS + 'wk): ' + Math.ceil((line.avg_branch / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS),
            '───────────',
            'Main stock: ' + line.main_stock + ' (all sent)',
            'Main safety: OVERRIDDEN',
            (shortfall > 0 ? '⚠ SHORT: ' + shortfall + ' units (Main needs restock)' : '')
          ].filter(Boolean).join('\n');
          safetyBadge = ' <span class="rnd-badge rnd-override" title="' + escapeHtml(overrideTip) + '">OVR</span>';
          if (shortfall > 0) {
            shortBadge = '<div class="short-badge" title="Need ' + line.need_qty + ' but Main only has ' + line.main_stock + '">SHORT ' + shortfall + '</div>';
          }
        }
        sendDisplay = '<strong class="send-val">' + line.send_qty + '</strong>' + ctnBadge + safetyBadge + shortBadge;
      } else if (line.send_note === 'small_send') {
        const minTip = 'Below typical send size (min ~' + (line.blocked_qty || '?') + '). Manager review — may batch with other reorders.';
        sendDisplay = '<strong class="send-val send-small">' + line.send_qty + '</strong>'
          + ' <span class="rnd-badge rnd-small" title="' + escapeHtml(minTip) + '">small</span>';
      } else if (line.send_note === 'no_main_stock') {
        sendDisplay = line.main_stock <= 0
          ? '<span class="send-dim">—</span>'
          : '<span class="send-dim" title="Main needs its safety stock">safety</span>';
      } else if (line.send_note === 'allocation_zero') {
        sendDisplay = '<span class="send-dim">0</span>';
      } else if (line.send_note === 'main_empty_sold') {
        sendDisplay = '<span class="send-blocked" title="Branch has ' + line.sold_deficit + ' units oversold but Main has 0 stock">Main empty</span>';
      } else if (line.send_note === 'no_avg_oversold') {
        sendDisplay = '<span class="send-blocked" title="Oversold but no AVG history — manually review. Upload AVG data or use Cartons Only mode.">review</span>';
      } else if (line.send_note === 'already_in_transit') {
        sendDisplay = '<span class="send-transit-ok" title="Need already covered by ' + line.pending_qty + ' unit(s) on the way — don\'t re-send">✓ on the way</span>';
      } else if (line.send_note === 'no_ctn') {
        sendDisplay = '<span class="send-dim" title="No carton info (Cartons Only mode)">no ctn</span>';
      } else if (line.send_note === 'carton_over_target' || line.send_note === 'carton_over_6mth') {
        sendDisplay = '<span class="send-dim" title="1 carton would exceed target weeks of cover">over target</span>';
      } else if (line.send_note === 'cover_at_target') {
        sendDisplay = '<span class="send-dim" title="Branch already covers target weeks — no carton needed">at target</span>';
      } else if (line.category === 'sufficient') {
        sendDisplay = '<span class="send-ok">ok</span>';
      } else {
        sendDisplay = '<span class="send-dim">—</span>';
      }
      
      // Cartons display
      const cartonDisplay = (line.send_qty > 0 && line.ctn_qty > 0)
        ? Math.ceil(line.send_qty / line.ctn_qty)
        : '—';
      
      // Product name line
      const nameLine = line.product_name
        ? '<div class="prod-name">' + escapeHtml(line.product_name) + '</div>'
        : '';
      const dcLine = line.dc_code ? '<span class="prod-dc">' + escapeHtml(line.dc_code) + '</span> · ' : '';

      // AVG now lives in its own columns (next to Branch stock + next to Main).
      // The carton pack-size ("25/ctn") was removed from the meta line — it
      // confused more than it helped, and the restock_setup pack-size data is
      // unreliable for some SKUs. The Cartons column still derives from it.
      const metaParts = [dcLine ? dcLine.replace(' · ', '') : ''].filter(Boolean);

      // AVG/mth column values (raw, formatted) — branch beside Branch stock, Main beside Main.
      const branchAvgDisplay = line.avg_branch_raw > 0 ? formatAvg(line.avg_branch_raw) : '<span class="send-dim">—</span>';
      const mainAvgDisplay   = line.avg_main_raw   > 0 ? formatAvg(line.avg_main_raw)   : '<span class="send-dim">—</span>';
      
      // Branch stock tooltip with AVG + committed info
      const branchTipParts = [];
      if (line.branch_committed > 0) {
        branchTipParts.push('On hand: ' + line.branch_on_hand);
        branchTipParts.push('Committed (sold): ' + line.branch_committed);
        branchTipParts.push('Available: ' + line.branch_stock);
      } else {
        branchTipParts.push('Branch stock: ' + line.branch_stock);
      }
      if (line.avg_branch_raw > 0) {
        branchTipParts.push('───────────');
        branchTipParts.push('AVG sales: ' + formatAvg(line.avg_branch_raw) + '/mth (' + formatAvg(line.avg_branch_raw / WEEKS_IN_MONTH) + '/wk)');
        branchTipParts.push('Target: ' + BRANCH_TARGET_WEEKS + ' weeks = ' + Math.ceil((line.avg_branch_raw / WEEKS_IN_MONTH) * BRANCH_TARGET_WEEKS) + ' units');
        branchTipParts.push('Need: ' + line.need_qty);
      } else {
        branchTipParts.push('No AVG data');
      }
      if (line.sold_deficit > 0) {
        branchTipParts.push('───────────');
        branchTipParts.push('OVERSOLD: ' + line.sold_deficit + ' units sold without stock');
        branchTipParts.push('Safety override active — Main will send to cover');
      }
      const branchTip = branchTipParts.join('&#10;');
      
      // Branch stock display: highlight negative
      let branchStockDisplay = '';
      if (line.branch_stock < 0) {
        branchStockDisplay = '<span class="sold-deficit-val">' + line.branch_stock + '</span>';
        if (line.branch_committed > 0) {
          branchStockDisplay += '<div class="sold-badge" title="' + line.branch_committed + ' units committed to orders">' + line.branch_committed + ' sold</div>';
        }
      } else if (line.branch_committed > 0) {
        branchStockDisplay = line.branch_stock + '<div class="committed-badge" title="On hand: ' + line.branch_on_hand + ' — Committed: ' + line.branch_committed + '">(' + line.branch_committed + ' sold)</div>';
      } else {
        branchStockDisplay = '' + line.branch_stock;
      }
      // Main stock tooltip with AVG
      const mainTipParts = [
        'Main stock: ' + line.main_stock,
        'AVG sales: ' + formatAvg(line.avg_main_raw) + '/mth',
        'Safety (' + MAIN_MIN_WEEKS + 'wk): ' + (line.main_safety || 0),
        'Can send (normal): ' + (line.can_send || 0)
      ];
      if (line.safety_override) {
        mainTipParts.push('───────────');
        mainTipParts.push('SAFETY OVERRIDDEN');
        mainTipParts.push('Sending ALL ' + line.main_stock + ' to cover sold orders');
      }
      const mainTip = mainTipParts.join('&#10;');
      
      // In-Transit display — show products in tooltip
      let transitDisplay = '';
      if (line.pending_qty > 0) {
        const trTip = line.pending_transfers.join('&#10;');
        transitDisplay = '<span class="transit-val tip-cell" title="' + escapeHtml(trTip) + '">' + line.pending_qty + '</span>';
      } else {
        transitDisplay = '<span class="send-dim">—</span>';
      }
      
      const checked = state.selectedRows.has(line.product) ? 'checked' : '';
      const dimClass = line.send_qty <= 0 ? ' dim-row' : '';
      const conflictClass = line.has_conflict ? ' has-conflict' : '';
      const checkDisabled = line.send_qty <= 0 ? ' disabled' : '';

      return '<tr class="plan-row' + dimClass + conflictClass + '">' +
        '<td class="check-cell"><input type="checkbox" class="row-check" ' + checked + checkDisabled + ' onchange="toggleRow(\'' + escapeHtml(line.product) + '\')"></td>' +
        '<td class="product-cell"><div class="prod-code">' + escapeHtml(line.product) + conflictIcon + '</div>' + nameLine + '<div class="prod-meta">' + metaParts.join(' · ') + '</div></td>' +
        '<td class="loc-cell">' + escapeHtml(line.location || '—') + '</td>' +
        '<td class="cover-cell group-start" title="Days of stock left at the current sales rate (Branch stock ÷ average daily sales)">' + coverBadge + '</td>' +
        '<td class="num-cell tip-cell' + (line.sold_deficit > 0 ? ' sold-deficit-cell' : '') + '" title="' + branchTip + '">' + branchStockDisplay + '</td>' +
        '<td class="num-cell avg-cell" title="This branch sells ' + formatAvg(line.avg_branch_raw) + '/month on average">' + branchAvgDisplay + '</td>' +
        '<td class="num-cell transit-cell' + (line.pending_qty > 0 ? ' has-transit' : '') + '">' + transitDisplay + '</td>' +
        '<td class="num-cell main-cell tip-cell group-start" title="' + mainTip + '">' + line.main_stock + '</td>' +
        '<td class="num-cell avg-cell" title="Main sells ' + formatAvg(line.avg_main_raw) + '/month on average">' + mainAvgDisplay + '</td>' +
        '<td class="send-cell group-start">' + sendDisplay + '</td>' +
        '<td class="ctn-cell">' + cartonDisplay + '</td>' +
        '</tr>';
    }).join('');
    
    updatePagination(lines.length, totalPages);
  }

  function getFilteredLines() {
    let lines = state.planLines;
    
    // Always hide no_avg unless specifically viewing "all" — but keep
    // oversold no_avg rows visible (emergency: branch has committed sales
    // with no AVG history, ops must review).
    if (state.filter !== 'all_full') {
      lines = lines.filter(l => l.category !== 'no_avg' || l.sold_deficit > 0);
    }

    // Hide rows Main can't send (no Main stock / all in safety reserve) — they
    // aren't actionable. Oversold lines are kept (sold_deficit > 0) because an
    // empty Main on an oversold SKU is exactly the signal to raise a PO.
    // The explicit "all_full" view bypasses this.
    if (state.hideNoMainStock && state.filter !== 'all_full') {
      lines = lines.filter(l => l.send_note !== 'no_main_stock' || l.sold_deficit > 0);
    }

    // Apply filter
    switch (state.filter) {
      case 'to_send':
        lines = lines.filter(l => l.send_qty > 0);
        break;
      case 'critical':
        lines = lines.filter(l => l.cover_days < CFG.COVER_CRITICAL_DAYS && l.category !== 'no_avg');
        break;
      case 'needs':
        lines = lines.filter(l => l.need_qty > 0 && l.category !== 'no_avg');
        break;
      case 'conflicts':
        lines = lines.filter(l => l.has_conflict);
        break;
      case 'oversold':
        lines = lines.filter(l => l.sold_deficit > 0);
        break;
      case 'in_transit':
        // Items with stock already on the way from Main — review before re-sending.
        lines = lines.filter(l => l.pending_qty > 0);
        break;
      case 'all':
        // Show all with avg data (excluding sufficient + no_avg for cleaner view)
        lines = lines.filter(l => l.category !== 'no_avg');
        break;
      case 'all_full':
        // Really everything
        break;
    }
    
    // Search
    if (state.search) {
      const s = state.search.toLowerCase();
      lines = lines.filter(l =>
        l.product.toLowerCase().includes(s) ||
        (l.dc_code && l.dc_code.includes(s)) ||
        (l.product_name && l.product_name.toLowerCase().includes(s)) ||
        (l.location && l.location.toLowerCase().includes(s))
      );
    }
    
    return lines;
  }

  function sortLines(lines) {
    const field = state.sortField;
    const asc = state.sortAsc;
    
    return [...lines].sort((a, b) => {
      let va = a[field];
      let vb = b[field];
      if (typeof va === 'string') {
        va = va.toLowerCase();
        vb = (vb || '').toLowerCase();
        return asc ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return asc ? (va - vb) : (vb - va);
    });
  }

  function updatePagination(total, totalPages) {
    const info = document.getElementById('pageInfo');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');
    if (info) info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${state.currentPage} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = state.currentPage >= totalPages;
  }

  function updateSummary() {
    const withAvg = state.planLines.filter(l => l.category !== 'no_avg');
    // Count base for the filter chips mirrors what the table actually shows
    // (respects the "hide what Main can't send" toggle). The KPI cards above
    // stay on the full health picture so a critical-but-unsendable SKU still
    // counts as a problem.
    const countBase = (state.hideNoMainStock)
      ? withAvg.filter(l => l.send_note !== 'no_main_stock' || l.sold_deficit > 0)
      : withAvg;
    const toSend = withAvg.filter(l => l.send_qty > 0);
    const totalUnits = toSend.reduce((s, l) => s + l.send_qty, 0);
    const totalCartons = toSend.reduce((s, l) => s + l.cartons, 0);
    const criticalCount = withAvg.filter(l => l.cover_days < CFG.COVER_CRITICAL_DAYS).length;
    const conflictCount = withAvg.filter(l => l.has_conflict).length;
    const pendingTRCount = state.pendingTRList.length;
    const pendingProductCount = Object.keys(state.pendingTRs).length;
    const soldDeficitCount = withAvg.filter(l => l.sold_deficit > 0).length;
    const safetyOverrideCount = withAvg.filter(l => l.safety_override).length;

    // KPI cards (top of page)
    const setKpi = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setKpi('kpi-critical', criticalCount);
    setKpi('kpi-conflicts', conflictCount);
    setKpi('kpi-pending', state.pendingLoading ? '…' : pendingTRCount);
    setKpi('kpi-pending-sub', state.pendingLoading
      ? 'checking in-transit…'
      : (pendingTRCount > 0
          ? `${pendingProductCount} product${pendingProductCount === 1 ? '' : 's'} in transit`
          : 'in transit'));
    setKpi('kpi-oversold', soldDeficitCount);

    // Safety-override banner: make it obvious Main is being drained past its
    // safety buffer. Operator needs to raise a Main PO. Styling lives in CSS
    // (selector `[data-alert="safety-override"]`).
    const alertEl = document.getElementById('alertContainer');
    if (alertEl) {
      // Double-send guard: if in-transit data couldn't load, the plan can't
      // subtract stock already on the way — warn instead of silently doubling.
      alertEl.querySelectorAll('[data-alert="pending-failed"]').forEach(n => n.remove());
      if (state.pendingLoadFailed) {
        const w = document.createElement('div');
        w.setAttribute('data-alert', 'pending-failed');
        w.className = 'alert warning';
        w.innerHTML = `<strong>In-transit transfers not loaded.</strong> Couldn't confirm stock already on the way from Main, so the quantities below may double up on pending transfers. Click <strong>Refresh</strong> to retry.`;
        alertEl.appendChild(w);
      }
    }
    if (alertEl) {
      alertEl.querySelectorAll('[data-alert="safety-override"]').forEach(n => n.remove());
      if (safetyOverrideCount > 0) {
        const units = withAvg.filter(l => l.safety_override).reduce((s, l) => s + l.send_qty, 0);
        const banner = document.createElement('div');
        banner.setAttribute('data-alert', 'safety-override');
        banner.className = 'alert';
        banner.innerHTML = `<strong>Safety override active on ${safetyOverrideCount} product${safetyOverrideCount > 1 ? 's' : ''}</strong> (${units.toLocaleString()} units) — Main is being drained past its ${MAIN_MIN_WEEKS}-week safety buffer to cover oversold orders. <strong>Raise a purchase order for Main</strong> once these transfers are sent, or this branch's next transfer will fall short.`;
        alertEl.appendChild(banner);
      }
    }

    const bar = document.getElementById('summaryBar');
    if (bar) {
      let parts = [];
      parts.push(`<span class="sum-item"><strong>${toSend.length}</strong> products to send</span>`);
      parts.push(`<span class="sum-item"><strong>${totalUnits.toLocaleString()}</strong> units</span>`);
      if (totalCartons > 0) parts.push(`<span class="sum-item"><strong>${totalCartons}</strong> cartons</span>`);
      if (safetyOverrideCount > 0) parts.push(`<span class="sum-item sum-crit"><strong>${safetyOverrideCount}</strong> safety override</span>`);
      if (state.cartonMode) parts.push(`<span class="sum-item">Cartons-only mode</span>`);
      bar.innerHTML = parts.join('<span class="sum-sep">·</span>');
      bar.style.display = parts.length > 0 ? 'flex' : 'none';
    }

    // Update Pending TRs panel — show product count + units, tooltip lists products
    const trPanel = document.getElementById('pendingTRPanel');
    if (trPanel) {
      if (pendingTRCount > 0) {
        const trLines = state.pendingTRList.map(tr => {
          const lineCount = tr.lines?.length || 0;
          const totalQty = (tr.lines || []).reduce((s, l) => s + l.qty, 0);
          const productList = (tr.lines || []).map(l => {
            const displayName = l.name ? l.name.substring(0, 40) : l.sku;
            return `${l.sku}: ${l.qty} — ${displayName}`;
          }).join('\n');
          const tipText = `${tr.number} (${tr.status})\n${lineCount} products, ${totalQty} units\n─────────\n${productList}`;
          return `<span class="tr-tag" title="${escapeHtml(tipText)}">${escapeHtml(tr.number)} <small>(${lineCount}P · ${totalQty}u)</small></span>`;
        }).join('');
        trPanel.innerHTML = `<strong>Pending transfers:</strong> ${trLines}`;
        trPanel.style.display = 'flex';
      } else {
        trPanel.style.display = 'none';
      }
    }
    
    // Update filter chip counts (mirror the table — countBase respects the toggle)
    const counts = {
      to_send: countBase.filter(l => l.send_qty > 0).length,
      critical: countBase.filter(l => l.cover_days < CFG.COVER_CRITICAL_DAYS).length,
      needs: countBase.filter(l => l.need_qty > 0).length,
      conflicts: countBase.filter(l => l.has_conflict).length,
      oversold: countBase.filter(l => l.sold_deficit > 0).length,
      in_transit: countBase.filter(l => l.pending_qty > 0).length,
      all: countBase.length
    };
    
    document.querySelectorAll('.filter-chip').forEach(chip => {
      const f = chip.dataset.filter;
      if (counts[f] !== undefined) {
        let badge = chip.querySelector('.chip-count');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'chip-count';
          chip.appendChild(badge);
        }
        badge.textContent = counts[f];
      }
    });
  }

  // ============================================
  // FILTERS, SORT & PAGINATION
  // ============================================
  
  window.setFilter = function(filter) {
    state.filter = filter;
    state.currentPage = 1;
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    renderTable();
  };

  window.sortBy = function(field) {
    if (state.sortField === field) {
      state.sortAsc = !state.sortAsc;
    } else {
      state.sortField = field;
      state.sortAsc = (field === 'product' || field === 'location');
    }
    document.querySelectorAll('.sort-icon').forEach(icon => {
      icon.textContent = '';
      icon.classList.remove('active');
    });
    const activeIcon = document.getElementById(`sort-${field}`);
    if (activeIcon) {
      activeIcon.textContent = state.sortAsc ? '▲' : '▼';
      activeIcon.classList.add('active');
    }
    state.currentPage = 1;
    renderTable();
  };

  window.applyFilters = function() {
    const searchInput = document.getElementById('searchInput');
    state.search = searchInput?.value.trim() || '';
    state.currentPage = 1;
    renderTable();
  };

  window.changePage = function(delta) {
    const newPage = state.currentPage + delta;
    if (newPage >= 1) {
      state.currentPage = newPage;
      renderTable();
    }
  };

  // ============================================
  // EXPORT
  // ============================================
  
  window.exportPlan = function() {
    let linesToExport;
    if (state.selectedRows.size > 0) {
      linesToExport = state.planLines.filter(l => state.selectedRows.has(l.product) && l.send_qty > 0);
    } else {
      linesToExport = state.planLines.filter(l => l.send_qty > 0);
    }
    
    if (linesToExport.length === 0) {
      alert('No items to export.');
      return;
    }

    // CSV escape: wrap in quotes only when needed, double internal quotes.
    const q = v => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '';

    // Resolve target weeks for a given SKU (custom override beats ABC tier).
    const tierFor = sku => state.abcRanks?.get(sku) || 'C';
    const targetWeeksFor = sku => state.targetOverride || CFG.targetWeeksForTier(tierFor(sku));

    const headers = [
      // ── Branch section ──
      'Product', 'Product Name',
      'Branch stock (now)', 'Branch weeks cover (now)',
      'Branch AVG/mth (used)',
      'Send qty', 'Cartons', 'CTN qty',
      'Branch weeks cover after this transfer',
      'Target weeks (this SKU)',
      // ── Main section ──
      'Main stock (now)', 'Main AVG/mth (used)',
      'Main weeks cover after this transfer'
    ];

    const rows = linesToExport.map(l => {
      const avgBranch  = Number(l.avg_branch_raw) || 0;
      const avgMain    = Number(l.avg_main_raw)   || 0;
      const avgWeekB   = avgBranch > 0 ? avgBranch / WEEKS_IN_MONTH : 0;
      const avgWeekM   = avgMain   > 0 ? avgMain   / WEEKS_IN_MONTH : 0;
      const coverBNow    = avgWeekB > 0 ? l.branch_stock / avgWeekB : null;
      const coverBAfter  = avgWeekB > 0 ? (l.branch_stock + l.send_qty) / avgWeekB : null;
      const coverMAfter  = avgWeekM > 0 ? (l.main_stock   - l.send_qty) / avgWeekM : null;
      const tier         = tierFor(l.product);
      const tw           = targetWeeksFor(l.product);
      const targetLabel  = state.targetOverride
        ? `${tw} (custom override)`
        : `${tw} (ABC ${tier})`;

      return [
        q(l.product),
        q(l.product_name),
        l.branch_stock,
        coverBNow != null ? fmt(coverBNow) : '',
        avgBranch > 0 ? fmt(avgBranch) : '',
        l.send_qty,
        l.cartons || '',
        l.ctn_qty || '',
        coverBAfter != null ? fmt(coverBAfter) : '',
        q(targetLabel),
        l.main_stock,
        avgMain > 0 ? fmt(avgMain) : '',
        coverMAfter != null ? fmt(coverMAfter) : ''
      ];
    });

    const label = state.selectedRows.size > 0 ? `selected-${linesToExport.length}` : 'all';
    const csv = [
      headers.join(','),
      ...rows.map(r => r.join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transfer-${state.branchCode}-${label}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ============================================
  // PRINT TRANSFER SHEET
  // ============================================
  
  window.printTransferSheet = function() {
    let lines;
    if (state.selectedRows.size > 0) {
      lines = state.planLines.filter(l => state.selectedRows.has(l.product) && l.send_qty > 0);
    } else {
      lines = state.planLines.filter(l => l.send_qty > 0);
    }
    
    if (lines.length === 0) {
      alert('No items to print.');
      return;
    }
    
    // Sort by location for warehouse walk-through efficiency
    lines = [...lines].sort((a, b) => (a.location || 'ZZZ').localeCompare(b.location || 'ZZZ'));
    
    const totalUnits = lines.reduce((s, l) => s + l.send_qty, 0);
    const totalCartons = lines.reduce((s, l) => s + l.cartons, 0);
    const syncDate = state.syncStatus ? new Date(state.syncStatus.ended_at).toLocaleString() : 'N/A';
    
    const html = `<!DOCTYPE html>
<html><head><title>Transfer — ${esc(state.branchInfo.name)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 12px; margin: 15px; color: #111; }
  h1 { font-size: 16px; margin-bottom: 2px; }
  .meta { color: #666; font-size: 10px; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f0f0f0; padding: 5px 8px; text-align: left; border: 1px solid #bbb; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 4px 8px; border: 1px solid #ddd; font-size: 11px; }
  .r { text-align: right; font-weight: 600; }
  .loc { font-family: monospace; font-size: 10px; color: #444; }
  .chk { width: 22px; text-align: center; }
  .name { font-size: 9px; color: #666; }
  .footer { margin-top: 10px; font-size: 10px; color: #444; border-top: 2px solid #333; padding-top: 6px; display: flex; justify-content: space-between; }
  tr:nth-child(even) { background: #fafafa; }
  @media print { body { margin: 8px; } @page { margin: 10mm; } }
</style></head><body>
<h1>Transfer Sheet — ${esc(state.branchInfo.name)} (${esc(state.branchCode)})</h1>
<div class="meta">Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; Cin7 Sync: ${syncDate}</div>
<table><thead><tr>
  <th class="chk">✓</th>
  <th>Product</th>
  <th>Location</th>
  <th style="text-align:right">Send</th>
  <th style="text-align:right">CTN</th>
</tr></thead><tbody>
${lines.map((l, i) => {
  const cartons = (l.ctn_qty > 0) ? Math.ceil(l.send_qty / l.ctn_qty) : '—';
  return `<tr>
    <td class="chk">☐</td>
    <td><strong>${esc(l.product)}</strong>${l.product_name ? '<br><span class="name">' + esc(l.product_name) + '</span>' : ''}</td>
    <td class="loc">${esc(l.location || '—')}</td>
    <td class="r">${l.send_qty}</td>
    <td class="r">${cartons}</td>
  </tr>`;
}).join('')}
</tbody></table>
<div class="footer">
  <span>${lines.length} products · ${totalUnits.toLocaleString()} units · ${totalCartons} cartons</span>
  <span>Branch: ${esc(state.branchInfo.name)} (${esc(state.branchCode)})</span>
</div>
</body></html>`;
    
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 300);
  };

  function esc(str) {
    return escapeHtml(str);
  }

  // ============================================
  // ROW SELECTION
  // ============================================

  window.toggleRow = function(product) {
    if (state.selectedRows.has(product)) {
      state.selectedRows.delete(product);
    } else {
      state.selectedRows.add(product);
    }
    updateSelectionUI();
  };
  
  window.toggleSelectAll = function() {
    const visibleLines = getFilteredLines().filter(l => l.send_qty > 0);
    const allSelected = visibleLines.every(l => state.selectedRows.has(l.product));
    
    if (allSelected) {
      visibleLines.forEach(l => state.selectedRows.delete(l.product));
    } else {
      visibleLines.forEach(l => state.selectedRows.add(l.product));
    }
    renderTable();
    updateSelectionUI();
  };
  
  function updateSelectionUI() {
    const count = state.selectedRows.size;
    const badge = document.getElementById('selectionBadge');
    const exportBtn = document.getElementById('exportBtn');
    const printBtn = document.getElementById('printBtn');
    
    if (badge) {
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
      badge.textContent = `${count} selected`;
    }
    if (exportBtn) exportBtn.textContent = count > 0 ? `Export (${count})` : 'Export CSV';
    if (printBtn) printBtn.textContent = count > 0 ? `Print (${count})` : 'Print Sheet';
  }

  // ============================================
  // UI HELPERS
  // ============================================
  
  function showLoading(show) {
    const el = document.getElementById('loadingOverlay');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function showError(message) {
    const el = document.getElementById('alertContainer');
    if (el) el.innerHTML = `<div class="alert warning"><strong>Error:</strong> ${message}</div>`;
  }

  function formatAvg(val) {
    if (!val || val <= 0) return '—';
    if (val < 10) return val.toFixed(1);
    return Math.round(val).toString();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ============================================
  // TARGET SETTINGS MODAL
  // ============================================

  function updateTargetBanner() {
    const banner = document.getElementById('targetBanner');
    const text   = document.getElementById('targetBannerText');
    const btn    = document.getElementById('targetBtn');
    if (!banner) return;
    if (state.targetOverride) {
      banner.style.display = 'flex';
      if (text) text.textContent = `every SKU aims for ${state.targetOverride} week${state.targetOverride === 1 ? '' : 's'} of cover`;
      if (btn) btn.textContent = `Target: ${state.targetOverride} wk`;
    } else {
      banner.style.display = 'none';
      if (btn) btn.textContent = 'Target settings';
    }
  }

  function renderTargetModalRules() {
    const grid = document.getElementById('targetModalRules');
    if (!grid) return;

    // Rules split into two plain-language groups so it's obvious what governs
    // each BRANCH's target vs what governs what MAIN is willing to release.
    const branchRules = [
      { t: 'Target cover',      d: `How many weeks of stock each branch aims to hold — the ABC tiers below, or a custom value if you set one above.` },
      { t: 'ABC demand tiers',  d: `Every SKU is graded by how fast it sells across ALL branches, then given cover to match: A = the top 20% fastest sellers → ${CFG.ABC_TARGET_WEEKS.A} weeks · B = the next 30% → ${CFG.ABC_TARGET_WEEKS.B} weeks · C = the slowest 50% → ${CFG.ABC_TARGET_WEEKS.C} weeks. Fast sellers get a bigger buffer because they run out first.` },
      { t: 'No-sales skip',     d: `A SKU with no sales history at a branch is left out of that branch's plan.` },
      { t: 'Small-send flag',   d: `Tiny top-ups (below about 1 week of demand) are flagged for review, not silently dropped.` },
      { t: 'Carton rounding',   d: `Sends round to full cartons, as long as that doesn't push the branch past ${CFG.CARTON_ROUND_UP_MAX_MONTHS} months of cover.` }
    ];
    const mainRules = [
      { t: 'Main safety stock', d: `Main keeps at least ${CFG.MAIN_MIN_WEEKS} weeks of its own demand in reserve before releasing stock to a branch.` },
      { t: 'In-transit aware',  d: `Stock already on the way (pending transfers) is subtracted, so the same units are never sent twice.` },
      { t: 'Proportional split',d: `When several branches need the same SKU and Main is short, each branch gets a share of Main's stock proportional to its need.` },
      { t: 'Safety override',   d: `A branch that already sold stock it doesn't have (oversold) may draw past Main's safety reserve — shown with an OVR badge.` },
      { t: 'Stale-data block',  d: `If the Cin7 sync is more than ${Math.round(CFG.SYNC_BLOCK_MINUTES / 60)} hours old, recommendations are hidden until the data refreshes.` }
    ];
    const col = (title, items, cls) =>
      `<div class="rules-col ${cls}"><h4>${escapeHtml(title)}</h4>` +
      items.map(x => `<div class="rule"><b>${escapeHtml(x.t)}</b><span>${escapeHtml(x.d)}</span></div>`).join('') +
      `</div>`;
    grid.innerHTML =
      col('Branch rules — how much each branch holds', branchRules, 'rules-branch') +
      col('Main rules — what Main will release', mainRules, 'rules-main');

    // Keep the ABC legend (inside the radio option) in sync with config so it
    // can never drift from the actual tier weights / percentiles.
    const wk = CFG.ABC_TARGET_WEEKS, pc = CFG.ABC_PERCENTILES;
    const pct = n => Math.round(n * 100);
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('abcWkA', `${wk.A} weeks`);  set('abcWkB', `${wk.B} weeks`);  set('abcWkC', `${wk.C} weeks`);
    set('abcPctA', `top ${pct(pc.A_CUTOFF)}%`);
    set('abcPctB', `next ${pct(pc.B_CUTOFF - pc.A_CUTOFF)}%`);
    set('abcPctC', `slowest ${pct(1 - pc.B_CUTOFF)}%`);
  }

  window.openTargetModal = function() {
    const modal = document.getElementById('targetModal');
    if (!modal) return;
    // Pre-fill UI based on current state
    if (state.targetOverride) {
      document.getElementById('targetModeCustom').checked = true;
      document.getElementById('targetWeeksInput').value = state.targetOverride;
      selectTargetMode('custom');
    } else {
      document.getElementById('targetModeAbc').checked = true;
      selectTargetMode('abc');
    }
    renderTargetModalRules();
    updateTargetPreview();
    modal.classList.add('open');
  };

  window.closeTargetModal = function() {
    document.getElementById('targetModal')?.classList.remove('open');
  };

  window.selectTargetMode = function(mode) {
    const optA = document.getElementById('optAbc');
    const optC = document.getElementById('optCustom');
    if (mode === 'abc') {
      optA?.classList.add('selected');
      optC?.classList.remove('selected');
      document.getElementById('targetModeAbc').checked = true;
    } else {
      optA?.classList.remove('selected');
      optC?.classList.add('selected');
      document.getElementById('targetModeCustom').checked = true;
    }
    updateTargetPreview();
  };

  window.updateTargetPreview = function() {
    const isCustom = document.getElementById('targetModeCustom')?.checked;
    const previewEl = document.getElementById('targetPreview');
    const formulaEl = document.getElementById('formulaText');
    const exampleEl = document.getElementById('examplePreview');
    if (!previewEl) return;

    if (isCustom) {
      const raw = parseInt(document.getElementById('targetWeeksInput').value, 10);
      const w = Number.isFinite(raw) && raw >= 1 && raw <= 999 ? raw : 6;
      if (formulaEl) formulaEl.innerHTML = `ceil(avg × ${w} / 4.345)`;
      if (exampleEl) {
        // Example with avg=30/mth (typical mid SKU)
        const target = Math.ceil(30 / 4.345 * w);
        exampleEl.textContent = `Example — SKU with avg 30/mth: target ≈ ${target} units (${w} weeks of cover)`;
      }
    } else {
      if (formulaEl) formulaEl.innerHTML = `ABC tiers — A=${CFG.ABC_TARGET_WEEKS.A}w · B=${CFG.ABC_TARGET_WEEKS.B}w · C=${CFG.ABC_TARGET_WEEKS.C}w`;
      if (exampleEl) {
        const tA = Math.ceil(30 / 4.345 * CFG.ABC_TARGET_WEEKS.A);
        const tC = Math.ceil(30 / 4.345 * CFG.ABC_TARGET_WEEKS.C);
        exampleEl.textContent = `Example — SKU with avg 30/mth: A-tier → ${tA} units · C-tier → ${tC} units`;
      }
    }
  };

  window.applyTargetSettings = function() {
    const isCustom = document.getElementById('targetModeCustom')?.checked;
    if (isCustom) {
      const raw = parseInt(document.getElementById('targetWeeksInput').value, 10);
      if (!Number.isFinite(raw) || raw < 1 || raw > 999) {
        alert('Custom target must be between 1 and 999 weeks.');
        return;
      }
      state.targetOverride = raw;
      try { localStorage.setItem(`replenishment.targetOverride.${state.branchCode}`, String(raw)); } catch (e) {}
    } else {
      state.targetOverride = null;
      try { localStorage.removeItem(`replenishment.targetOverride.${state.branchCode}`); } catch (e) {}
    }
    updateTargetBanner();
    closeTargetModal();
    calculatePlan();
    renderTable();
    updateSummary();
  };

})();
