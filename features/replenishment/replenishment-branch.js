/**
 * Branch Replenishment Planner - Branch Page JS
 * Handles plan generation, calculation, and management
 */

(function() {
  'use strict';

  // ============================================
  // CONSTANTS
  // ============================================
  
  const BRANCHES = {
    SYD: { name: 'Sydney', avgField: 'avg_mth_sydney' },
    MEL: { name: 'Melbourne', avgField: 'avg_mth_melbourne' },
    BNE: { name: 'Brisbane', avgField: 'avg_mth_brisbane' },
    CNS: { name: 'Cairns', avgField: 'avg_mth_cairns' },
    CFS: { name: 'Coffs Harbour', avgField: 'avg_mth_coffs_harbour' },
    HBA: { name: 'Hobart', avgField: 'avg_mth_hobart' },
    SCS: { name: 'Sunshine Coast', avgField: 'avg_mth_sunshine_coast' }
  };

  // Mapping from cin7_mirror.stock_snapshot.location_name → warehouse code
  const CIN7_LOCATION_MAP = {
    'main warehouse': 'MAIN',
    'main': 'MAIN',
    'sydney': 'SYD',
    'sydney warehouse': 'SYD',
    'melbourne': 'MEL',
    'melbourne warehouse': 'MEL',
    'brisbane': 'BNE',
    'brisbane warehouse': 'BNE',
    'cairns': 'CNS',
    'cairns warehouse': 'CNS',
    'coffs harbour': 'CFS',
    'coffs harbour warehouse': 'CFS',
    'hobart': 'HBA',
    'hobart warehouse': 'HBA',
    'sunshine coast warehouse': 'SCS',
    'sunshine coast': 'SCS'
  };

  const WEEKS_IN_MONTH = 4.345;
  const BRANCH_TARGET_WEEKS = 5;
  const MAIN_MIN_WEEKS = 8;

  // ============================================
  // STATE
  // ============================================
  
  let state = {
    branchCode: null,
    branchInfo: null,
    syncStatus: null,
    plan: null,
    planLines: [],
    avgData: {},
    stockData: {},
    ctnMap: {},            // product → qty_per_ctn from restock_setup
    dcMap: {},             // product → 5DC code from restock_setup
    selectedRows: new Set(),
    showNoAvg: false,
    filter: 'all',
    search: '',
    currentPage: 1,
    pageSize: 100,
    sortField: 'cover_days',
    sortAsc: true
  };

  // ============================================
  // INITIALIZATION
  // ============================================
  
  document.addEventListener('DOMContentLoaded', async () => {
    // Get branch code from URL
    const params = new URLSearchParams(window.location.search);
    const branchCode = params.get('branch');
    
    if (!branchCode || !BRANCHES[branchCode]) {
      document.body.innerHTML = '<div style="padding:40px;text-align:center"><h2>Invalid branch code</h2><a href="replenishment.html">Back to Overview</a></div>';
      return;
    }
    
    state.branchCode = branchCode;
    state.branchInfo = BRANCHES[branchCode];
    
    // Update page title elements
    const branchNameEl = document.getElementById('branchName');
    const branchCodeEl = document.getElementById('branchCode');
    if (branchNameEl) branchNameEl.textContent = state.branchInfo.name;
    if (branchCodeEl) branchCodeEl.textContent = `(${branchCode})`;
    document.title = `${state.branchInfo.name} - Replenishment Plan`;
    
    console.log(`📦 Branch Replenishment: ${branchCode} - ${state.branchInfo.name}`);
    
    await loadData();
    setupEventListeners();
  });

  function setupEventListeners() {
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeApprovalModal();
      }
    });
  }

  // ============================================
  // LOAD DATA
  // ============================================
  
  async function loadData() {
    showLoading(true);
    
    try {
      await window.supabaseReady;
      
      // Load cin7_mirror sync status
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
      updateSnapshotInfo();
      
      // Load AVG data, stock, CTN info, and existing plan in parallel
      console.log('Loading data...');
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadCtnData(),
        loadExistingPlan()
      ]);
      
      console.log('Data loaded, auto-generating plan...');
      console.log(`📊 AVG data: ${Object.keys(state.avgData).length} products`);
      console.log(`📦 Stock data: ${Object.keys(state.stockData).length} entries`);
      console.log(`🗃️ CTN map: ${Object.keys(state.ctnMap).length} | DC map: ${Object.keys(state.dcMap).length}`);
      
      // Auto-generate plan on page load
      calculatePlan();
      renderTable();
      updateStats();
      
      // Show export button
      const exportBtn = document.getElementById('exportBtn');
      if (exportBtn) exportBtn.style.display = '';
      
    } catch (err) {
      console.error('Error loading data:', err);
      showError('Error loading data: ' + err.message);
    } finally {
      showLoading(false);
    }
  }

  function showNoSnapshot() {
    const alertContainer = document.getElementById('alertContainer');
    if (alertContainer) {
      alertContainer.innerHTML = `
        <div class="alert warning">
          <strong>No stock data available.</strong> 
          Cin7 mirror sync has not run yet. Stock data auto-syncs every 2 hours.
        </div>
      `;
    }
  }

  function updateSnapshotInfo() {
    const el = document.getElementById('snapshotDate');
    if (el && state.syncStatus) {
      const date = new Date(state.syncStatus.ended_at || state.syncStatus.started_at);
      el.textContent = `Cin7 sync: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }
  }

  async function loadAvgData() {
    // Need to paginate because Supabase has 1000 row limit per request
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
      console.log(`Loaded ${allData.length} AVG records...`);
      
      if (data.length < batchSize) break;
      from += batchSize;
    }
    
    // Index by product for quick lookup (e.g., R3206-TRI)
    state.avgData = {};
    for (const row of allData) {
      state.avgData[row.product] = row;
    }
    console.log(`Total AVG products: ${Object.keys(state.avgData).length}`);
  }

  async function loadStockData() {
    console.log('Loading stock data from cin7_mirror...');
    
    // Read directly from cin7_mirror.stock_snapshot (all warehouses)
    let allData = [];
    let from = 0;
    const batchSize = 1000;
    
    while (true) {
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('stock_snapshot')
        .select('sku, location_name, on_hand, available')
        .range(from, from + batchSize - 1);
      
      if (error) throw error;
      if (!data || data.length === 0) break;
      
      allData = allData.concat(data);
      console.log(`Loaded ${allData.length} stock rows...`);
      
      if (data.length < batchSize) break;
      from += batchSize;
    }
    
    console.log(`Total stock loaded: ${allData.length}`);
    
    // Aggregate by SKU + warehouse (sum available across bins)
    state.stockData = {};
    for (const row of allData) {
      const locName = (row.location_name || '').toLowerCase().trim();
      const warehouseCode = CIN7_LOCATION_MAP[locName];
      if (!warehouseCode) continue;
      
      const key = `${row.sku}:${warehouseCode}`;
      if (!state.stockData[key]) {
        state.stockData[key] = {
          product: row.sku,
          warehouse_code: warehouseCode,
          qty_available: 0
        };
      }
      state.stockData[key].qty_available += (row.available != null ? row.available : row.on_hand || 0);
    }
    
    console.log(`Aggregated to ${Object.keys(state.stockData).length} SKU/warehouse entries`);
  }

  async function loadCtnData() {
    try {
      // Load ALL products (not just those with CTN) so we can get 5DC codes
      let allRows = [];
      let from = 0;
      const batchSize = 1000;
      while (true) {
        const { data, error } = await window.supabase
          .from('restock_setup')
          .select('product, qty_per_ctn')
          .range(from, from + batchSize - 1);
        if (error) { console.warn('Could not load CTN data:', error); return; }
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < batchSize) break;
        from += batchSize;
      }
      
      state.ctnMap = {};
      state.dcMap = {};
      for (const row of allRows) {
        let product = (row.product || '').trim();
        const spaceMatch = product.match(/^(\d{4,6})\s+(.+)$/);
        if (spaceMatch) {
          state.dcMap[spaceMatch[2].trim()] = spaceMatch[1]; // product_code → 5DC
          product = spaceMatch[2].trim();
        }
        if (product && row.qty_per_ctn > 0) {
          state.ctnMap[product] = Number(row.qty_per_ctn);
        }
      }
      console.log(`📦 Loaded ${Object.keys(state.ctnMap).length} CTN + ${Object.keys(state.dcMap).length} 5DC codes`);
    } catch (err) {
      console.warn('CTN data load failed:', err);
    }
  }

  /**
   * Smart Carton Rounding: rounds suggestedQty to nearest full carton
   * if Main safety stock still respected. Falls back to rounding down.
   * @param {number} suggestedQty - raw qty to send
   * @param {number} ctnQty - units per carton (0 or null = no rounding)
   * @param {number} canSendQty - max Main can send (after 8-week safety)
   * @returns {{ qty: number, rounded: string }} qty and rounding direction
   */
  function smartCartonRound(suggestedQty, ctnQty, canSendQty) {
    if (!ctnQty || ctnQty <= 0) return { qty: suggestedQty, rounded: 'none' };
    
    const roundedUp = Math.ceil(suggestedQty / ctnQty) * ctnQty;
    const roundedDown = Math.floor(suggestedQty / ctnQty) * ctnQty;
    
    // Already a full carton multiple
    if (suggestedQty === roundedUp) return { qty: suggestedQty, rounded: 'exact' };
    
    // Try rounding up — only if Main can still afford it
    if (roundedUp <= canSendQty) {
      return { qty: roundedUp, rounded: 'up' };
    }
    
    // Can't round up — round down (if > 0)
    if (roundedDown > 0) {
      return { qty: roundedDown, rounded: 'down' };
    }
    
    // Rounded down = 0 but we had suggested > 0 — keep original (partial carton)
    return { qty: suggestedQty, rounded: 'partial' };
  }

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
      
      // Load plan lines
      const { data: lines, error: linesError } = await window.supabase
        .from('transfer_plan_lines')
        .select('*')
        .eq('plan_id', state.plan.id);
      
      if (linesError) throw linesError;
      
      state.planLines = lines || [];
      
      // Update UI based on status
      updatePlanStatus();
    }
  }

  function updatePlanStatus() {
    const approveBtn = document.getElementById('approveBtn');
    const exportBtn = document.getElementById('exportBtn');
    const statusBadge = document.getElementById('planStatusBadge');
    
    if (!state.plan) {
      if (statusBadge) {
        statusBadge.className = 'status-badge no_plan';
        statusBadge.textContent = 'No Plan';
      }
      return;
    }
    
    if (statusBadge) {
      statusBadge.className = `status-badge ${state.plan.status}`;
      statusBadge.textContent = state.plan.status.charAt(0).toUpperCase() + state.plan.status.slice(1);
    }
    
    // Disable approve if already approved
    if (approveBtn) {
      approveBtn.disabled = state.plan.status === 'approved';
    }
    
    // Enable export only if we have lines
    if (exportBtn) {
      exportBtn.disabled = state.planLines.length === 0;
    }
  }

  // ============================================
  // CALCULATION
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
    
    console.log(`Calculating for ${allProducts.length} total products (${Object.keys(state.avgData).length} from AVG)...`);
    
    // First pass: calculate needs for ALL branches (for conflict detection + proportional allocation)
    const allBranchNeeds = {};
    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      if (!avgRow) continue;
      
      const mainStock = state.stockData[`${product}:MAIN`];
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = avgRow?.avg_mth_main || 0;
      const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
      const mainMinQty = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSendTotal = Math.max(0, mainAvailable - mainMinQty);
      
      let totalNeed = 0;
      const branchNeeds = {};
      
      for (const [code, info] of Object.entries(BRANCHES)) {
        const branchAvgField = info.avgField;
        const avgMonth = avgRow?.[branchAvgField] || 0;
        if (avgMonth <= 0) continue;
        
        const branchStk = state.stockData[`${product}:${code}`];
        const branchAvailable = branchStk?.qty_available || 0;
        const avgWeekBranch = avgMonth / WEEKS_IN_MONTH;
        const target = Math.ceil(avgWeekBranch * BRANCH_TARGET_WEEKS);
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
    
    // Second pass: build ALL product lines (not just those needing stock)
    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      const avgMonthBranch = avgRow?.[avgField] || 0;
      const branchStock = state.stockData[`${product}:${branchCode}`];
      const mainStock = state.stockData[`${product}:MAIN`];
      const branchAvailable = branchStock?.qty_available || 0;
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = avgRow?.avg_mth_main || 0;
      const ctnQty = state.ctnMap[product] || 0;
      const dcCode = state.dcMap[product] || '';
      
      // ── NO AVG for this branch ──
      if (avgMonthBranch <= 0) {
        if (branchAvailable > 0 || mainAvailable > 0) {
          lines.push({
            product, dc_code: dcCode, category: 'no_avg',
            cover_days: 999, branch_stock: branchAvailable, avg_branch: 0,
            main_stock: mainAvailable, avg_main: avgMonthMain,
            send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
            has_conflict: false, conflict_branches: [], conflict_detail: null,
            send_note: 'no_avg'
          });
        }
        continue;
      }
      
      const avgWeekBranch = avgMonthBranch / WEEKS_IN_MONTH;
      const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
      const coverDays = avgWeekBranch > 0 ? Math.max(0, Math.round((branchAvailable / avgWeekBranch) * 7)) : 999;
      const targetQty = Math.ceil(avgWeekBranch * BRANCH_TARGET_WEEKS);
      const needQty = Math.max(0, targetQty - branchAvailable);
      const mainMinQty = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSendQty = Math.max(0, mainAvailable - mainMinQty);
      
      // Determine category
      let category;
      if (coverDays < 7) category = 'critical';
      else if (coverDays < 21) category = 'warning';
      else if (coverDays < 35) category = 'ok';
      else category = 'sufficient';
      
      const conflict = allBranchNeeds[product];
      const conflictBranches = conflict?.hasConflict
        ? Object.keys(conflict.branches).filter(c => c !== branchCode)
        : [];
      
      // ── SUFFICIENT: no need to send ──
      if (needQty <= 0) {
        lines.push({
          product, dc_code: dcCode, category,
          cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
          main_stock: mainAvailable, avg_main: avgMonthMain,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          has_conflict: false, conflict_branches: [], conflict_detail: null,
          send_note: null
        });
        continue;
      }
      
      // ── NO MAIN STOCK to send ──
      if (canSendQty <= 0) {
        lines.push({
          product, dc_code: dcCode, category,
          cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
          main_stock: mainAvailable, avg_main: avgMonthMain,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          has_conflict: conflict?.hasConflict || false, conflict_branches: conflictBranches,
          conflict_detail: null, send_note: 'no_main_stock'
        });
        continue;
      }
      
      // ── NEEDS STOCK: apply smart rules ──
      let allocatedQty = Math.min(needQty, canSendQty);
      let conflictDetail = null;
      
      // Rule: Proportional Allocation
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
      
      if (allocatedQty > 0) {
        // Rule: Smart Carton Rounding
        const ctnResult = smartCartonRound(allocatedQty, ctnQty, canSendQty);
        sendQty = ctnResult.qty;
        rounded = ctnResult.rounded;
        
        // Rule: Min threshold check — but still show the product
        const minThreshold = ctnQty > 0 ? Math.ceil(ctnQty / 2) : 3;
        if (sendQty < minThreshold) {
          sendNote = 'below_min';
          sendQty = 0;
          rounded = 'none';
        }
      } else {
        sendNote = 'allocation_zero';
      }
      
      lines.push({
        product, dc_code: dcCode, category,
        cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
        main_stock: mainAvailable, avg_main: avgMonthMain,
        send_qty: sendQty, raw_qty: allocatedQty, ctn_qty: ctnQty || null, rounded,
        has_conflict: conflict?.hasConflict || false, conflict_branches: conflictBranches,
        conflict_detail: conflictDetail, send_note: sendNote
      });
    }
    
    // Sort by cover days (ascending) - most urgent first
    lines.sort((a, b) => a.cover_days - b.cover_days);
    
    console.log(`Plan built: ${lines.length} total lines (${lines.filter(l => l.send_qty > 0).length} to send, ${lines.filter(l => l.category === 'no_avg').length} no_avg)`);
    state.planLines = lines;
    state.conflictCount = lines.filter(l => l.has_conflict).length;
  }

  window.generatePlan = function() {
    showLoading(true);
    
    try {
      console.log('Regenerating plan...');
      calculatePlan();
      renderTable();
      updateStats();
      
      console.log('Plan regenerated successfully');
    } catch (err) {
      console.error('Error generating plan:', err);
      showError('Error generating plan: ' + err.message);
    } finally {
      showLoading(false);
    }
  };

  // ============================================
  // RENDERING
  // ============================================
  
  function renderTable() {
    const tbody = document.getElementById('planTableBody');
    if (!tbody) return;
    
    // Apply filter + search
    let lines = getFilteredLines();
    
    // Apply sorting
    lines = sortLines(lines);
    
    // Update result count
    const resultCount = document.getElementById('resultCount');
    if (resultCount) {
      resultCount.textContent = `${lines.length} products`;
    }
    
    // Pagination
    const totalPages = Math.ceil(lines.length / state.pageSize);
    const start = (state.currentPage - 1) * state.pageSize;
    const pageLines = lines.slice(start, start + state.pageSize);
    
    if (pageLines.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:#64748b">No products match the current filter</td></tr>';
      updatePagination(0, 0);
      return;
    }
    
    // Find max cover days for bar scaling (cap at 60)
    const maxCover = 60;
    
    // Update select-all checkbox
    const selectAllEl = document.getElementById('selectAllCheck');
    if (selectAllEl) {
      const allSelected = lines.length > 0 && lines.every(l => state.selectedRows.has(l.product));
      const someSelected = lines.some(l => state.selectedRows.has(l.product));
      selectAllEl.checked = allSelected;
      selectAllEl.indeterminate = !allSelected && someSelected;
    }
    
    tbody.innerHTML = pageLines.map(line => {
      // Cover days styling
      let coverClass = 'cover-ok';
      let barColor = '#10b981';
      if (line.category === 'no_avg') { coverClass = ''; barColor = '#cbd5e1'; }
      else if (line.cover_days < 7) { coverClass = 'cover-critical'; barColor = '#dc2626'; }
      else if (line.cover_days < 21) { coverClass = 'cover-warning'; barColor = '#f59e0b'; }
      
      const coverText = line.category === 'no_avg' ? 'N/A' : (line.cover_days >= 999 ? '∞' : `${line.cover_days}d`);
      const barPct = line.category === 'no_avg' ? 0 : (line.cover_days >= 999 ? 100 : Math.min(100, Math.round((line.cover_days / maxCover) * 100)));
      
      // Conflict badge with DETAILED tooltip
      let conflictBadge = '';
      if (line.has_conflict && line.conflict_branches.length > 0) {
        let tipLines = [];
        if (line.conflict_detail) {
          const cd = line.conflict_detail;
          tipLines.push('⚠️ ALLOCATION CONFLICT');
          tipLines.push(`Main can send: ${cd.mainCanSend} units`);
          tipLines.push(`Total demand: ${cd.totalNeed} units`);
          tipLines.push(`Your need: ${cd.thisBranchNeed} (${Math.round(cd.thisBranchNeed / cd.totalNeed * 100)}%)`);
          for (const ob of cd.otherBranches) {
            tipLines.push(`${ob.code} needs: ${ob.need} (${Math.round(ob.need / cd.totalNeed * 100)}%)`);
          }
          tipLines.push(`Your share: ${cd.proportionalShare} units`);
        } else {
          tipLines.push(`Also needed by: ${line.conflict_branches.join(', ')}`);
        }
        conflictBadge = `<span class="conflict-badge" title="${escapeHtml(tipLines.join('\n'))}">⚠️ ${line.conflict_branches.length}</span>`;
      }
      
      // Send qty display
      let sendDisplay = '';
      if (line.send_qty > 0) {
        let ctnBadge = '';
        if (line.rounded === 'up') {
          ctnBadge = ' <span class="ctn-rnd up" title="Rounded up from ' + line.raw_qty + '">▲</span>';
        } else if (line.rounded === 'down') {
          ctnBadge = ' <span class="ctn-rnd down" title="Rounded down from ' + line.raw_qty + '">▼</span>';
        } else if (line.rounded === 'exact') {
          ctnBadge = ' <span class="ctn-rnd exact" title="Exact carton multiple">=</span>';
        }
        sendDisplay = '<strong class="send-val">' + line.send_qty + '</strong>' + ctnBadge;
      } else if (line.send_note === 'below_min') {
        sendDisplay = '<span class="send-hint" title="Below minimum send threshold">&lt; min</span>';
      } else if (line.send_note === 'no_main_stock') {
        sendDisplay = '<span class="send-warn" title="Main has no surplus after 8-week safety">No main</span>';
      } else if (line.send_note === 'allocation_zero') {
        sendDisplay = '<span class="send-hint" title="Proportional allocation resulted in 0">0 (alloc)</span>';
      } else if (line.category === 'sufficient') {
        sendDisplay = '<span class="send-ok">✓</span>';
      } else if (line.category === 'no_avg') {
        sendDisplay = '<span class="send-na">—</span>';
      } else {
        sendDisplay = '<span class="send-na">0</span>';
      }
      
      const checked = state.selectedRows.has(line.product) ? 'checked' : '';
      const dimClass = line.send_qty <= 0 && line.category !== 'no_avg' ? ' dim-row' : '';
      const noAvgClass = line.category === 'no_avg' ? ' no-avg-row' : '';
      
      return '<tr class="plan-row' + dimClass + noAvgClass + '">' +
        '<td class="check-cell"><input type="checkbox" class="row-check" ' + checked + ' onchange="toggleRow(\'' + escapeHtml(line.product) + '\')"></td>' +
        '<td class="dc-cell">' + escapeHtml(line.dc_code) + '</td>' +
        '<td class="product-cell">' + escapeHtml(line.product) + conflictBadge + '</td>' +
        '<td><div class="cover-bar-container"><div class="cover-mini-bar"><div class="cover-mini-fill" style="width:' + barPct + '%;background:' + barColor + '"></div></div><span class="' + coverClass + '">' + coverText + '</span></div></td>' +
        '<td class="num-cell">' + line.branch_stock + '</td>' +
        '<td class="avg-cell">' + formatAvg(line.avg_branch) + '</td>' +
        '<td class="num-cell">' + line.main_stock + '</td>' +
        '<td class="avg-cell">' + formatAvg(line.avg_main) + '</td>' +
        '<td class="ctn-cell">' + (line.ctn_qty || '—') + '</td>' +
        '<td class="send-cell">' + sendDisplay + '</td>' +
        '</tr>';
    }).join('');
    
    updatePagination(lines.length, totalPages);
  }

  function getFilteredLines() {
    let lines = state.planLines;
    
    // Hide no_avg by default unless toggled on
    if (!state.showNoAvg) {
      lines = lines.filter(l => l.category !== 'no_avg');
    }
    
    // Filter by category
    if (state.filter === 'critical') {
      lines = lines.filter(l => l.cover_days < 7 && l.category !== 'no_avg');
    } else if (state.filter === 'warning') {
      lines = lines.filter(l => l.cover_days >= 7 && l.cover_days < 21 && l.category !== 'no_avg');
    } else if (state.filter === 'ok') {
      lines = lines.filter(l => l.cover_days >= 21 && l.cover_days < 35 && l.category !== 'no_avg');
    } else if (state.filter === 'sufficient') {
      lines = lines.filter(l => l.category === 'sufficient');
    } else if (state.filter === 'conflict') {
      lines = lines.filter(l => l.has_conflict);
    } else if (state.filter === 'no_avg') {
      lines = lines.filter(l => l.category === 'no_avg');
    }
    
    // Search (also matches 5DC code)
    if (state.search) {
      const s = state.search.toLowerCase();
      lines = lines.filter(l => l.product.toLowerCase().includes(s) || (l.dc_code && l.dc_code.includes(s)));
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
    
    if (info) {
      if (total === 0) {
        info.textContent = 'Page 0 / 0';
      } else {
        info.textContent = `Page ${state.currentPage} / ${totalPages}`;
      }
    }
    
    if (prevBtn) prevBtn.disabled = state.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = state.currentPage >= totalPages;
  }

  function updateStats() {
    // Stats only for products WITH avg (exclude no_avg)
    const withAvg = state.planLines.filter(l => l.category !== 'no_avg');
    const noAvg = state.planLines.filter(l => l.category === 'no_avg');
    
    const stats = {
      totalProducts: withAvg.length,
      toSendCount: withAvg.filter(l => l.send_qty > 0).length,
      totalUnits: withAvg.reduce((sum, l) => sum + l.send_qty, 0),
      criticalCount: withAvg.filter(l => l.cover_days < 7).length,
      warningCount: withAvg.filter(l => l.cover_days >= 7 && l.cover_days < 21).length,
      okCount: withAvg.filter(l => l.cover_days >= 21 && l.cover_days < 35).length,
      sufficientCount: withAvg.filter(l => l.category === 'sufficient').length,
      conflictCount: withAvg.filter(l => l.has_conflict).length,
      noAvgCount: noAvg.length
    };
    
    // Update UI elements
    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('totalProducts', stats.totalProducts);
    setEl('toSendCount', stats.toSendCount);
    setEl('totalUnits', stats.totalUnits.toLocaleString());
    setEl('criticalCount', stats.criticalCount);
    setEl('warningCount', stats.warningCount);
    setEl('okCount', stats.okCount);
    setEl('sufficientCount', stats.sufficientCount);
    setEl('noAvgCount', stats.noAvgCount);
    
    const summarySection = document.getElementById('summarySection');
    if (summarySection) summarySection.style.display = 'flex';
    
    // Conflict alert with better explanation
    const conflictAlert = document.getElementById('conflictAlert');
    if (conflictAlert) {
      if (stats.conflictCount > 0) {
        conflictAlert.innerHTML = `⚠️ <strong>${stats.conflictCount}</strong> products have allocation conflicts — Multiple branches need these products but Main doesn't have enough to fulfill all. Stock is distributed <strong>proportionally</strong> based on each branch's need. Hover the ⚠️ badge on each row for details.`;
        conflictAlert.style.display = 'block';
      } else {
        conflictAlert.style.display = 'none';
      }
    }
    
    // Update filter chip counts
    updateFilterChipCounts(stats);
    
    // Coverage distribution chart
    renderCoverageChart();
  }

  function updateFilterChipCounts(stats) {
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
      const filter = chip.dataset.filter;
      let count = 0;
      if (filter === 'all') count = stats.totalProducts;
      else if (filter === 'critical') count = stats.criticalCount;
      else if (filter === 'warning') count = stats.warningCount;
      else if (filter === 'ok') count = stats.okCount;
      else if (filter === 'sufficient') count = stats.sufficientCount;
      else if (filter === 'conflict') count = stats.conflictCount;
      
      // Add count badge
      let badge = chip.querySelector('.chip-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'chip-count';
        badge.style.cssText = 'font-size:10px;opacity:0.7;margin-left:2px';
        chip.appendChild(badge);
      }
      badge.textContent = `(${count})`;
    });
    
    // Update No AVG toggle count
    const noAvgEl = document.getElementById('noAvgToggle');
    if (noAvgEl) {
      let badge = noAvgEl.querySelector('.chip-count');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'chip-count';
        badge.style.cssText = 'font-size:10px;opacity:0.7;margin-left:2px';
        noAvgEl.appendChild(badge);
      }
      badge.textContent = `(${stats.noAvgCount})`;
    }
  }

  function renderCoverageChart() {
    const container = document.getElementById('coverageChart');
    const barsEl = document.getElementById('coverageBars');
    const infoEl = document.getElementById('coverageChartInfo');
    if (!container || !barsEl) return;
    
    if (state.planLines.length === 0) {
      container.style.display = 'none';
      return;
    }
    
    // Build histogram buckets: 0-7, 7-14, 14-21, 21-28, 28-35, 35+
    const buckets = [
      { label: '0-7d', min: 0, max: 7, color: '#dc2626', count: 0 },
      { label: '7-14d', min: 7, max: 14, color: '#f87171', count: 0 },
      { label: '14-21d', min: 14, max: 21, color: '#f59e0b', count: 0 },
      { label: '21-28d', min: 21, max: 28, color: '#fbbf24', count: 0 },
      { label: '28-35d', min: 28, max: 35, color: '#34d399', count: 0 },
      { label: '35d+', min: 35, max: 9999, color: '#10b981', count: 0 }
    ];
    
    for (const line of state.planLines) {
      if (line.category === 'no_avg') continue;
      const d = line.cover_days >= 999 ? 60 : line.cover_days;
      for (const bucket of buckets) {
        if (d >= bucket.min && d < bucket.max) {
          bucket.count++;
          break;
        }
      }
    }
    
    const maxCount = Math.max(...buckets.map(b => b.count), 1);
    
    barsEl.innerHTML = buckets.map(b => {
      const pct = Math.round((b.count / maxCount) * 100);
      return `
        <div class="coverage-bar-item" style="height:${Math.max(pct, 4)}%;background:${b.color}" 
             title="${b.label}: ${b.count} products">
          <span class="coverage-bar-label">${b.label}</span>
        </div>
      `;
    }).join('');
    
    if (infoEl) {
      const withAvg = state.planLines.filter(l => l.category !== 'no_avg');
      const avgCover = withAvg.length > 0
        ? Math.round(withAvg.reduce((s, l) => s + Math.min(l.cover_days, 60), 0) / withAvg.length)
        : 0;
      infoEl.textContent = `Avg: ${avgCover}d`;
    }
    
    container.style.display = 'block';
  }

  // ============================================
  // FILTERS, SORTING & PAGINATION
  // ============================================
  
  window.setFilter = function(filter) {
    state.filter = filter;
    state.currentPage = 1;
    
    // Update chip active state
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
      state.sortAsc = field === 'product' ? true : true; // asc for all
    }
    
    // Update sort icons
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
  // EDIT & APPROVAL
  // ============================================
  
  window.updateApprovedQty = function(product, value) {
    const line = state.planLines.find(l => l.product === product);
    if (!line) return;
    
    const qty = Math.max(0, Math.min(parseInt(value) || 0, line.can_send_qty));
    line.approved_qty = qty;
    
    updateStats();
  };

  window.openApprovalModal = function() {
    // Get lines that will be sent
    const toSend = state.planLines.filter(l => l.approved_qty > 0);
    
    if (toSend.length === 0) {
      alert('No items with approved quantities to send.');
      return;
    }
    
    const summary = document.getElementById('approvalSummary');
    summary.innerHTML = `
      <p><strong>${toSend.length}</strong> products will be transferred</p>
      <p><strong>${toSend.reduce((sum, l) => sum + l.approved_qty, 0)}</strong> total units</p>
    `;
    
    document.getElementById('approvalModal')?.classList.remove('hidden');
  };

  window.closeApprovalModal = function() {
    document.getElementById('approvalModal')?.classList.add('hidden');
  };

  window.confirmApproval = async function() {
    const btn = document.querySelector('#approvalModal .search-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    
    try {
      await savePlan('approved');
      closeApprovalModal();
      updatePlanStatus();
      renderTable();
      
    } catch (err) {
      console.error('Error approving plan:', err);
      alert('Error: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm & Approve';
    }
  };

  // ============================================
  // SAVE & EXPORT
  // ============================================
  
  window.savePlanDraft = async function() {
    try {
      await savePlan('draft');
      alert('Draft saved!');
    } catch (err) {
      console.error('Error saving draft:', err);
      alert('Error saving: ' + err.message);
    }
  };

  async function savePlan(status) {
    await window.supabaseReady;
    
    // Create or update plan
    if (!state.plan) {
      const { data: plan, error: planError } = await window.supabase
        .from('transfer_plans')
        .insert({
          branch_code: state.branchCode,
          status
        })
        .select()
        .single();
      
      if (planError) throw planError;
      state.plan = plan;
    } else {
      const { error: planError } = await window.supabase
        .from('transfer_plans')
        .update({
          status,
          updated_at: new Date().toISOString()
        })
        .eq('id', state.plan.id);
      
      if (planError) throw planError;
      state.plan.status = status;
    }
    
    // Delete existing lines and insert new ones
    await window.supabase
      .from('transfer_plan_lines')
      .delete()
      .eq('plan_id', state.plan.id);
    
    // Insert lines with approved > 0
    const linesToInsert = state.planLines
      .filter(l => l.approved_qty > 0)
      .map(l => ({
        plan_id: state.plan.id,
        product_code: l.product,
        branch_available_frozen: l.branch_available,
        avg_month_frozen: l.avg_month,
        target_qty: l.target_qty,
        need_qty: l.need_qty,
        main_available_frozen: l.main_available,
        main_min_qty: l.main_min_qty,
        can_send_qty: l.can_send_qty,
        suggested_qty: l.suggested_qty,
        approved_qty: l.approved_qty,
        status: l.status
      }));
    
    if (linesToInsert.length > 0) {
      const { error: linesError } = await window.supabase
        .from('transfer_plan_lines')
        .insert(linesToInsert);
      
      if (linesError) throw linesError;
    }
    
    updatePlanStatus();
  }

  window.exportPlan = function() {
    let linesToExport;
    
    // Export selected rows if any, otherwise export all visible (filtered)
    if (state.selectedRows.size > 0) {
      linesToExport = state.planLines.filter(l => state.selectedRows.has(l.product));
    } else {
      linesToExport = getFilteredLines();
    }
    
    if (linesToExport.length === 0) {
      alert('No items to export.');
      return;
    }
    
    const headers = ['5DC', 'Product', 'Cover Days', 'Branch Stock', 'Branch AVG', 'Main Stock', 'Main AVG', 'CTN Qty', 'Send Qty', 'Conflict'];
    const rows = linesToExport.map(l => [
      `"${l.dc_code || ''}"`,
      `"${(l.product || '').replace(/"/g, '""')}"`,
      l.cover_days >= 999 ? '' : l.cover_days,
      l.branch_stock,
      Math.round(l.avg_branch || 0),
      l.main_stock,
      Math.round(l.avg_main || 0),
      l.ctn_qty || '',
      l.send_qty,
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
    const visibleLines = getFilteredLines();
    const allSelected = visibleLines.every(l => state.selectedRows.has(l.product));
    
    if (allSelected) {
      visibleLines.forEach(l => state.selectedRows.delete(l.product));
    } else {
      visibleLines.forEach(l => state.selectedRows.add(l.product));
    }
    renderTable();
    updateSelectionUI();
  };
  
  window.toggleNoAvg = function() {
    state.showNoAvg = !state.showNoAvg;
    const btn = document.getElementById('noAvgToggle');
    if (btn) btn.classList.toggle('active', state.showNoAvg);
    state.currentPage = 1;
    renderTable();
  };
  
  function updateSelectionUI() {
    const count = state.selectedRows.size;
    const badge = document.getElementById('selectionBadge');
    const exportBtn = document.getElementById('exportBtn');
    
    if (badge) {
      badge.style.display = count > 0 ? 'inline' : 'none';
      badge.textContent = `${count} selected`;
    }
    if (exportBtn) {
      exportBtn.textContent = count > 0 ? `Export Selected (${count})` : 'Export CSV';
    }
  }

  // ============================================
  // UI HELPERS
  // ============================================
  
  function showLoading(show) {
    const loader = document.getElementById('loadingOverlay');
    if (loader) {
      loader.style.display = show ? 'flex' : 'none';
    }
  }

  function showError(message) {
    const container = document.getElementById('alertContainer');
    if (container) {
      container.innerHTML = `<div class="alert warning"><strong>Error:</strong> ${message}</div>`;
    }
    console.error('Error:', message);
  }

  /**
   * Format AVG values: show 1 decimal for small values, round for big ones
   * 0 → '—', 0.3 → '0.3', 2.1 → '2.1', 15.6 → '16', 105.2 → '105'
   */
  function formatAvg(val) {
    if (!val || val <= 0) return '—';
    if (val < 10) return val.toFixed(1);
    return Math.round(val).toString();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

})();
