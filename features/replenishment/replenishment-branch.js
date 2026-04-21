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
  for (const b of CFG.BRANCHES) BRANCHES[b.code] = { name: b.name, avgField: b.avgField };

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
    pendingTRs: {},        // product → { pending_qty, transfers: ['TR-XXXXX = QTY'] }
    pendingTRList: [],     // array of { number, status, lines }
    cartonMode: false,     // Cartons Only mode toggle
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
    
    const branchNameEl = document.getElementById('branchName');
    const branchCodeEl = document.getElementById('branchCode');
    if (branchNameEl) branchNameEl.textContent = state.branchInfo.name;
    if (branchCodeEl) branchCodeEl.textContent = `(${branchCode})`;
    document.title = `${state.branchInfo.name} — Transfer Plan`;
    
    console.log(`📦 Branch Replenishment: ${branchCode} - ${state.branchInfo.name}`);
    
    // Set default filter chip active
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.filter === state.filter);
    });
    
    await loadData();
  });

  // ============================================
  // LOAD DATA
  // ============================================
  
  async function loadData() {
    showLoading(true);
    
    try {
      await window.supabaseReady;
      
      const { data: syncRuns, error: syncError } = await window.supabase
        .schema('cin7_mirror')
        .from('sync_runs')
        .select('run_id, started_at, ended_at, status, products_synced, stock_rows_synced')
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
          el.innerHTML += `<div class="alert" style="background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;padding:10px 14px;border-radius:8px;margin-bottom:10px;font-weight:500">
            <strong>⛔ Recommendations hidden.</strong> Cin7 stock sync is more than ${CFG.SYNC_BLOCK_MINUTES} minutes old — data is likely wrong. Wait for the next successful sync before acting.
          </div>`;
        }
        const tbody = document.getElementById('planTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:40px;color:#64748b">Stock data is stale — refresh once sync recovers.</td></tr>';
        return;
      }

      console.log('Loading data...');
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadCtnData(),
        loadExistingPlan(),
        loadPendingTRs()
      ]);
      
      console.log('Data loaded, auto-generating plan...');
      console.log(`📊 AVG: ${Object.keys(state.avgData).length} | 📦 Stock: ${Object.keys(state.stockData).length} | 🗃️ CTN: ${Object.keys(state.ctnMap).length} | 📍 Locations: ${Object.keys(state.locationMap).length} | 🏷️ Names: ${Object.keys(state.productNames).length}`);
      
      calculatePlan();
      renderTable();
      updateSummary();
      
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
      parts.push(`<div class="alert warning">⚠️ ${escapeHtml(state.syncAge.message)}</div>`);
    }
    if (state.syncRunClass && state.syncRunClass.warn && state.syncRunClass.message) {
      parts.push(`<div class="alert warning">⚠️ ${escapeHtml(state.syncRunClass.message)}</div>`);
    }
    el.innerHTML = parts.join('');
  }

  function updateSnapshotInfo() {
    const el = document.getElementById('snapshotDate');
    if (el && state.syncStatus) {
      const date = new Date(state.syncStatus.ended_at || state.syncStatus.started_at);
      el.textContent = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
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

  async function loadPendingTRs() {
    try {
      const resp = await fetch(`/api/replenishment/pending-transfers/${state.branchCode}`);
      if (!resp.ok) {
        console.warn('Pending TRs: HTTP', resp.status);
        return;
      }
      const data = await resp.json();
      state.pendingTRs = data.products || {};
      state.pendingTRList = data.transfers || [];
      const trCount = state.pendingTRList.length;
      const productCount = Object.keys(state.pendingTRs).length;
      console.log(`📋 Pending TRs: ${trCount} transfers, ${productCount} products in transit`);
    } catch (err) {
      console.warn('Could not load pending TRs:', err.message);
      state.pendingTRs = {};
      state.pendingTRList = [];
    }
  }

  // ============================================
  // CALCULATION — Two-pass algorithm (preserved)
  // ============================================
  
  function calculatePlan() {
    const lines = [];
    const branchCode = state.branchCode;
    const avgField = state.branchInfo.avgField;
    
    // Collect ALL unique products (AVG + stock in this branch)
    const productSet = new Set(Object.keys(state.avgData));
    for (const key of Object.keys(state.stockData)) {
      const parts = key.split(':');
      if (parts[1] === branchCode || parts[1] === 'MAIN') {
        productSet.add(parts[0]);
      }
    }
    const allProducts = Array.from(productSet);
    
    // ──────── FIRST PASS: calculate needs for ALL branches (conflict detection) ────────
    const allBranchNeeds = {};
    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      if (!avgRow) continue;
      
      const mainStock = state.stockData[`${product}:MAIN`];
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = Math.round(avgRow?.avg_mth_main || 0);
      const mainMinQty = CFG.computeMainSafety(avgMonthMain);
      const canSendTotal = Math.max(0, mainAvailable - mainMinQty);

      let totalNeed = 0;
      const branchNeeds = {};

      for (const [code, info] of Object.entries(BRANCHES)) {
        const branchAvgField = info.avgField;
        const avgMonth = Math.round(avgRow?.[branchAvgField] || 0);
        if (avgMonth <= 0) continue;

        const branchStk = state.stockData[`${product}:${code}`];
        const branchAvailable = branchStk?.qty_available || 0;
        const target = CFG.computeBranchTarget(avgMonth);
        const need = Math.max(0, target - branchAvailable);

        if (need > 0) {
          branchNeeds[code] = { need };
          totalNeed += need;
        }
      }
      
      allBranchNeeds[product] = {
        totalNeed,
        canSend: canSendTotal,
        branches: branchNeeds,
        hasConflict: totalNeed > canSendTotal && canSendTotal > 0 && Object.keys(branchNeeds).length > 1
      };
    }
    
    // ──────── SECOND PASS: build product lines ────────
    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      const avgMonthBranchRaw = avgRow?.[avgField] || 0;       // raw decimal for display
      const avgMonthBranch = Math.round(avgMonthBranchRaw);    // rounded for calc
      const branchStock = state.stockData[`${product}:${branchCode}`];
      const mainStock = state.stockData[`${product}:MAIN`];
      const branchAvailable = branchStock?.qty_available || 0;
      const branchOnHand = branchStock?.qty_on_hand || 0;
      const branchCommitted = Math.max(0, branchOnHand - branchAvailable);
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMainRaw = avgRow?.avg_mth_main || 0;        // raw decimal for display
      const avgMonthMain = Math.round(avgMonthMainRaw);         // rounded for calc
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
      const targetQty = CFG.computeBranchTarget(avgMonthBranch);
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
      
      // ── SUFFICIENT: no need to send ──
      if (needQty <= 0 && soldDeficit <= 0) {
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
          send_note: null
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
        const proportionalShare = Math.floor((thisBranchNeed / totalNeed) * conflict.canSend);
        allocatedQty = Math.min(allocatedQty, proportionalShare);
        
        conflictDetail = {
          thisBranchNeed,
          totalNeed,
          mainCanSend: conflict.canSend,
          proportionalShare,
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
      if (state.cartonMode) {
        // Rules: send min 1 full carton, max 6 months AVG, keep Main safety stock (unless oversold)
        const cartonCanSend = safetyOverride ? mainAvailable : canSendQty;
        if (ctnQty <= 0) {
          // No carton info → skip in carton mode
          sendNote = 'no_ctn';
        } else if (cartonCanSend < ctnQty) {
          // Main can't spare even one carton after safety stock
          sendNote = 'no_main_stock';
        } else {
          const maxBranchStock = Math.ceil(avgMonthBranch * CFG.CARTON_MODE_MAX_MONTHS);
          const roomInBranch = Math.max(0, maxBranchStock - branchAvailable - pendingQty);
          
          if (roomInBranch < ctnQty) {
            // Sending 1 carton would exceed 6 months at branch
            sendNote = 'carton_over_6mth';
          } else {
            // How many cartons can we send?
            const maxCartons = Math.floor(Math.min(cartonCanSend, roomInBranch) / ctnQty);
            if (maxCartons >= 1) {
              sendQty = maxCartons * ctnQty;
              rounded = 'exact';
              allocatedQty = sendQty;
            } else {
              sendNote = 'carton_over_6mth';
            }
          }
        }
      }
      // ── DEFAULT MODE ──
      else {
        if (allocatedQty > 0) {
          const ctnResult = smartCartonRound(allocatedQty, ctnQty, effectiveCanSend, targetQty);
          sendQty = ctnResult.qty;
          rounded = ctnResult.rounded;
          
          if (branchAvailable > 0) {
            const minThreshold = CFG.computeMinSend(ctnQty, avgMonthBranch);
            if (sendQty < minThreshold) {
              sendNote = 'below_min';
              blockedQty = sendQty;
              sendQty = 0;
              rounded = 'none';
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

  window.generatePlan = function() {
    showLoading(true);
    try {
      calculatePlan();
      renderTable();
      updateSummary();
    } catch (err) {
      console.error('Error generating plan:', err);
      showError('Error: ' + err.message);
    } finally {
      showLoading(false);
    }
  };

  window.toggleCartonMode = function() {
    state.cartonMode = !state.cartonMode;
    const btn = document.getElementById('cartonModeBtn');
    const rules = document.getElementById('cartonModeRules');
    if (btn) {
      btn.classList.toggle('active', state.cartonMode);
      btn.textContent = state.cartonMode ? '📦 Cartons Only ON' : '📦 Cartons Only';
    }
    if (rules) {
      rules.style.display = state.cartonMode ? 'inline-block' : 'none';
    }
    calculatePlan();
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
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:30px;color:#64748b">' +
        (state.filter === 'to_send' ? 'No products to send — branch is fully stocked ✓' : 'No products match the current filter') +
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
        conflictIcon = ` <span class="conflict-dot" title="${escapeHtml(tipLines.join('\n'))}">⚠️</span>`;
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
          safetyBadge = ' <span class="rnd-badge" style="background:#fef2f2;color:#dc2626" title="' + escapeHtml(overrideTip) + '">⚡</span>';
          if (shortfall > 0) {
            shortBadge = '<div class="short-badge" title="Need ' + line.need_qty + ' but Main only has ' + line.main_stock + '">SHORT ' + shortfall + '</div>';
          }
        }
        sendDisplay = '<strong class="send-val">' + line.send_qty + '</strong>' + ctnBadge + safetyBadge + shortBadge;
      } else if (line.send_note === 'below_min') {
        sendDisplay = '<span class="send-blocked" title="Qty below min threshold">' + (line.blocked_qty || line.raw_qty) + ' ‹min</span>';
      } else if (line.send_note === 'no_main_stock') {
        sendDisplay = line.main_stock <= 0
          ? '<span class="send-dim">—</span>'
          : '<span class="send-dim" title="Main needs its safety stock">safety</span>';
      } else if (line.send_note === 'allocation_zero') {
        sendDisplay = '<span class="send-dim">0</span>';
      } else if (line.send_note === 'main_empty_sold') {
        sendDisplay = '<span class="send-blocked" title="Branch has ' + line.sold_deficit + ' units oversold but Main has 0 stock">🔴 Main empty</span>';
      } else if (line.send_note === 'no_avg_oversold') {
        sendDisplay = '<span class="send-blocked" title="Oversold but no AVG history — manually review. Upload AVG data or use Cartons Only mode.">🔴 review</span>';
      } else if (line.send_note === 'already_in_transit') {
        sendDisplay = '<span class="send-dim" title="Need covered by pending TRs">in transit</span>';
      } else if (line.send_note === 'no_ctn') {
        sendDisplay = '<span class="send-dim" title="No carton info (Cartons Only mode)">no ctn</span>';
      } else if (line.send_note === 'carton_over_6mth') {
        sendDisplay = '<span class="send-dim" title="1 carton would exceed 6 months AVG">&gt;6mth</span>';
      } else if (line.category === 'sufficient') {
        sendDisplay = '<span class="send-ok">✓</span>';
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
      
      // AVG display in meta
      const avgDisplay = line.avg_branch_raw > 0
        ? 'avg ' + formatAvg(line.avg_branch_raw) + '/mth'
        : '';
      const metaParts = [dcLine ? dcLine.replace(' · ', '') : '', line.ctn_qty ? line.ctn_qty + '/ctn' : '', avgDisplay].filter(Boolean);
      
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
        branchTipParts.push('⚠️ OVERSOLD: ' + line.sold_deficit + ' units sold without stock');
        branchTipParts.push('Safety override active — Main will send to cover');
      }
      const branchTip = branchTipParts.join('&#10;');
      
      // Branch stock display: highlight negative
      let branchStockDisplay = '';
      if (line.branch_stock < 0) {
        branchStockDisplay = '<span class="sold-deficit-val">' + line.branch_stock + '</span>';
        if (line.branch_committed > 0) {
          branchStockDisplay += '<div class="sold-badge" title="' + line.branch_committed + ' units committed to orders">🔴 ' + line.branch_committed + ' sold</div>';
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
        mainTipParts.push('⚡ SAFETY OVERRIDDEN');
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
      const checkDisabled = line.send_qty <= 0 ? ' disabled' : '';
      
      return '<tr class="plan-row' + dimClass + '">' +
        '<td class="check-cell"><input type="checkbox" class="row-check" ' + checked + checkDisabled + ' onchange="toggleRow(\'' + escapeHtml(line.product) + '\')"></td>' +
        '<td class="product-cell"><div class="prod-code">' + escapeHtml(line.product) + conflictIcon + '</div>' + nameLine + '<div class="prod-meta">' + metaParts.join(' · ') + '</div></td>' +
        '<td class="loc-cell">' + escapeHtml(line.location || '—') + '</td>' +
        '<td class="cover-cell">' + coverBadge + '</td>' +
        '<td class="num-cell tip-cell' + (line.sold_deficit > 0 ? ' sold-deficit-cell' : '') + '" title="' + branchTip + '">' + branchStockDisplay + '</td>' +
        '<td class="num-cell transit-cell">' + transitDisplay + '</td>' +
        '<td class="num-cell main-cell tip-cell" title="' + mainTip + '">' + line.main_stock + '</td>' +
        '<td class="send-cell">' + sendDisplay + '</td>' +
        '<td class="ctn-cell">' + cartonDisplay + '</td>' +
        '</tr>';
    }).join('');
    
    updatePagination(lines.length, totalPages);
  }

  function getFilteredLines() {
    let lines = state.planLines;
    
    // Always hide no_avg unless specifically viewing "all"
    if (state.filter !== 'all_full') {
      lines = lines.filter(l => l.category !== 'no_avg');
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
    const toSend = withAvg.filter(l => l.send_qty > 0);
    const totalUnits = toSend.reduce((s, l) => s + l.send_qty, 0);
    const totalCartons = toSend.reduce((s, l) => s + l.cartons, 0);
    const criticalCount = withAvg.filter(l => l.cover_days < CFG.COVER_CRITICAL_DAYS).length;
    const conflictCount = withAvg.filter(l => l.has_conflict).length;
    const pendingTRCount = state.pendingTRList.length;
    const pendingProductCount = Object.keys(state.pendingTRs).length;
    const soldDeficitCount = withAvg.filter(l => l.sold_deficit > 0).length;
    const safetyOverrideCount = withAvg.filter(l => l.safety_override).length;

    // Safety-override banner: make it obvious Main is being drained past its
    // safety buffer. Operator needs to raise a Main PO.
    const alertEl = document.getElementById('alertContainer');
    if (alertEl) {
      // Strip previous override banner (keeps other alerts untouched)
      alertEl.querySelectorAll('[data-alert="safety-override"]').forEach(n => n.remove());
      if (safetyOverrideCount > 0) {
        const units = withAvg.filter(l => l.safety_override).reduce((s, l) => s + l.send_qty, 0);
        const banner = document.createElement('div');
        banner.setAttribute('data-alert', 'safety-override');
        banner.className = 'alert';
        banner.style.cssText = 'background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;padding:10px 14px;border-radius:8px;margin-bottom:10px;font-size:12px;font-weight:500';
        banner.innerHTML = `⚡ <strong>Safety override active on ${safetyOverrideCount} product${safetyOverrideCount > 1 ? 's' : ''}</strong> (${units.toLocaleString()} units) — Main is being drained past its ${MAIN_MIN_WEEKS}-week safety buffer to cover oversold orders. <strong>Raise a purchase order for Main</strong> once these transfers are sent, or this branch's next transfer will fall short.`;
        alertEl.appendChild(banner);
      }
    }
    
    const bar = document.getElementById('summaryBar');
    if (bar) {
      let parts = [];
      parts.push(`<span class="sum-item"><strong>${toSend.length}</strong> products to send</span>`);
      parts.push(`<span class="sum-item"><strong>${totalUnits.toLocaleString()}</strong> units</span>`);
      if (totalCartons > 0) parts.push(`<span class="sum-item"><strong>${totalCartons}</strong> cartons</span>`);
      if (criticalCount > 0) parts.push(`<span class="sum-item sum-crit">🔴 <strong>${criticalCount}</strong> critical</span>`);
      if (conflictCount > 0) parts.push(`<span class="sum-item sum-warn">⚠️ <strong>${conflictCount}</strong> conflicts</span>`);
      if (pendingTRCount > 0) parts.push(`<span class="sum-item sum-transit">🚚 <strong>${pendingTRCount}</strong> pending TR${pendingTRCount > 1 ? 's' : ''} (${pendingProductCount} products)</span>`);
      if (soldDeficitCount > 0) parts.push(`<span class="sum-item sum-crit">🔴 <strong>${soldDeficitCount}</strong> oversold</span>`);
      if (safetyOverrideCount > 0) parts.push(`<span class="sum-item" style="color:#dc2626">⚡ <strong>${safetyOverrideCount}</strong> safety override</span>`);
      if (state.cartonMode) parts.push(`<span class="sum-item" style="color:#7c3aed">📦 Cartons Only</span>`);
      bar.innerHTML = parts.join('<span class="sum-sep">·</span>');
      bar.style.display = 'flex';
    }
    
    // Update Pending TRs panel — show product count + units, tooltip lists products
    const trPanel = document.getElementById('pendingTRPanel');
    if (trPanel) {
      if (pendingTRCount > 0) {
        const trLines = state.pendingTRList.map(tr => {
          const lineCount = tr.lines?.length || 0;
          const totalQty = (tr.lines || []).reduce((s, l) => s + l.qty, 0);
          const statusIcon = tr.status === 'IN TRANSIT' ? '🚚' : '📋';
          // Build product list tooltip
          const productList = (tr.lines || []).map(l => {
            const displayName = l.name ? l.name.substring(0, 40) : l.sku;
            return `${l.sku}: ${l.qty} — ${displayName}`;
          }).join('\n');
          const tipText = `${tr.number} (${tr.status})\n${lineCount} products, ${totalQty} units\n─────────\n${productList}`;
          return `<span class="tr-tag" title="${escapeHtml(tipText)}">${statusIcon} ${escapeHtml(tr.number)} <small>(${lineCount}P · ${totalQty}u)</small></span>`;
        }).join('');
        trPanel.innerHTML = `<strong>Pending Transfers:</strong> ${trLines}`;
        trPanel.style.display = 'flex';
      } else {
        trPanel.style.display = 'none';
      }
    }
    
    // Update filter chip counts
    const counts = {
      to_send: toSend.length,
      critical: criticalCount,
      needs: withAvg.filter(l => l.need_qty > 0).length,
      conflicts: conflictCount,
      oversold: soldDeficitCount,
      all: withAvg.length
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
    
    const headers = ['5DC', 'Product', 'Product Name', 'Location', 'Cover Days', 'Branch Stock', 'Main Stock', 'Send Qty', 'Cartons', 'CTN Qty', 'Conflict'];
    const rows = linesToExport.map(l => [
      `"${l.dc_code || ''}"`,
      `"${(l.product || '').replace(/"/g, '""')}"`,
      `"${(l.product_name || '').replace(/"/g, '""')}"`,
      `"${(l.location || '').replace(/"/g, '""')}"`,
      l.cover_days >= 999 ? '' : l.cover_days,
      l.branch_stock,
      l.main_stock,
      l.send_qty,
      l.cartons || '',
      l.ctn_qty || '',
      l.has_conflict ? 'Yes' : ''
    ]);
    
    const label = state.selectedRows.size > 0 ? `selected-${linesToExport.length}` : 'all';
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
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

})();
