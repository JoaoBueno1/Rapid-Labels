/**
 * Branch Replenishment Planner — Redesigned
 * Shows ONLY actionable items by default (send_qty > 0).
 * Simplified columns, print-ready transfer sheet.
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
    ctnMap: {},
    dcMap: {},
    productNames: {},      // product → display name
    locationMap: {},       // product → pickface location
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
      updateSnapshotInfo();
      
      console.log('Loading data...');
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadCtnData(),
        loadExistingPlan()
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
          qty_available: 0
        };
      }
      state.stockData[key].qty_available += (row.available != null ? row.available : row.on_hand || 0);
      
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

  function smartCartonRound(suggestedQty, ctnQty, canSendQty) {
    if (!ctnQty || ctnQty <= 0) return { qty: suggestedQty, rounded: 'none' };
    
    const roundedUp = Math.ceil(suggestedQty / ctnQty) * ctnQty;
    const roundedDown = Math.floor(suggestedQty / ctnQty) * ctnQty;
    
    if (suggestedQty === roundedUp) return { qty: suggestedQty, rounded: 'exact' };
    if (roundedUp <= canSendQty) return { qty: roundedUp, rounded: 'up' };
    if (roundedDown > 0) return { qty: roundedDown, rounded: 'down' };
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
      const { data: lines, error: linesError } = await window.supabase
        .from('transfer_plan_lines')
        .select('*')
        .eq('plan_id', state.plan.id);
      if (linesError) throw linesError;
      state.planLines = lines || [];
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
      const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
      const mainMinQty = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSendTotal = Math.max(0, mainAvailable - mainMinQty);
      
      let totalNeed = 0;
      const branchNeeds = {};
      
      for (const [code, info] of Object.entries(BRANCHES)) {
        const branchAvgField = info.avgField;
        const avgMonth = Math.round(avgRow?.[branchAvgField] || 0);
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
    
    // ──────── SECOND PASS: build product lines ────────
    for (const product of allProducts) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      const avgMonthBranch = Math.round(avgRow?.[avgField] || 0);
      const branchStock = state.stockData[`${product}:${branchCode}`];
      const mainStock = state.stockData[`${product}:MAIN`];
      const branchAvailable = branchStock?.qty_available || 0;
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = Math.round(avgRow?.avg_mth_main || 0);
      const ctnQty = state.ctnMap[product] || 0;
      const dcCode = state.dcMap[product] || '';
      const productName = state.productNames[product] || '';
      const location = state.locationMap[product] || '';
      
      // ── NO AVG for this branch ──
      if (avgMonthBranch <= 0) {
        if (branchAvailable > 0 || mainAvailable > 0) {
          lines.push({
            product, dc_code: dcCode, product_name: productName, location,
            category: 'no_avg',
            cover_days: 999, branch_stock: branchAvailable, avg_branch: 0,
            main_stock: mainAvailable, avg_main: avgMonthMain,
            can_send: 0, main_safety: 0, need_qty: 0,
            send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
            cartons: 0,
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
          product, dc_code: dcCode, product_name: productName, location,
          category,
          cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
          main_stock: mainAvailable, avg_main: avgMonthMain,
          can_send: canSendQty, main_safety: mainMinQty, need_qty: needQty,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          cartons: 0,
          has_conflict: false, conflict_branches: [], conflict_detail: null,
          send_note: null
        });
        continue;
      }
      
      // ── NO MAIN STOCK to send ──
      if (canSendQty <= 0) {
        lines.push({
          product, dc_code: dcCode, product_name: productName, location,
          category,
          cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
          main_stock: mainAvailable, avg_main: avgMonthMain,
          can_send: 0, main_safety: mainMinQty, need_qty: needQty,
          send_qty: 0, raw_qty: 0, ctn_qty: ctnQty || null, rounded: 'none',
          cartons: 0,
          has_conflict: conflict?.hasConflict || false, conflict_branches: conflictBranches,
          conflict_detail: null, send_note: 'no_main_stock'
        });
        continue;
      }
      
      // ── NEEDS STOCK: apply smart rules ──
      let allocatedQty = Math.min(needQty, canSendQty);
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
      
      if (allocatedQty > 0) {
        const ctnResult = smartCartonRound(allocatedQty, ctnQty, canSendQty);
        sendQty = ctnResult.qty;
        rounded = ctnResult.rounded;
        
        if (branchAvailable > 0) {
          const weeklyDemand = avgMonthBranch / WEEKS_IN_MONTH;
          const minThreshold = Math.max(Math.ceil(weeklyDemand), 2);
          if (sendQty < minThreshold) {
            sendNote = 'below_min';
            blockedQty = sendQty;
            sendQty = 0;
            rounded = 'none';
          }
        }
      } else {
        sendNote = 'allocation_zero';
      }
      
      lines.push({
        product, dc_code: dcCode, product_name: productName, location,
        category,
        cover_days: coverDays, branch_stock: branchAvailable, avg_branch: avgMonthBranch,
        main_stock: mainAvailable, avg_main: avgMonthMain,
        can_send: canSendQty, main_safety: mainMinQty, need_qty: needQty,
        send_qty: sendQty, raw_qty: allocatedQty, blocked_qty: blockedQty,
        ctn_qty: ctnQty || null, rounded,
        cartons: (sendQty > 0 && ctnQty > 0) ? Math.ceil(sendQty / ctnQty) : 0,
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
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:30px;color:#64748b">' +
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
      } else if (line.cover_days < 7) {
        coverBadge = `<span class="cover-badge cover-crit">${line.cover_days}d</span>`;
      } else if (line.cover_days < 21) {
        coverBadge = `<span class="cover-badge cover-warn">${line.cover_days}d</span>`;
      } else if (line.cover_days < 35) {
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
        sendDisplay = '<strong class="send-val">' + line.send_qty + '</strong>' + ctnBadge;
      } else if (line.send_note === 'below_min') {
        sendDisplay = '<span class="send-blocked" title="Qty below min threshold">' + (line.blocked_qty || line.raw_qty) + ' ‹min</span>';
      } else if (line.send_note === 'no_main_stock') {
        sendDisplay = line.main_stock <= 0
          ? '<span class="send-dim">—</span>'
          : '<span class="send-dim" title="Main needs its safety stock">safety</span>';
      } else if (line.send_note === 'allocation_zero') {
        sendDisplay = '<span class="send-dim">0</span>';
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
      
      const checked = state.selectedRows.has(line.product) ? 'checked' : '';
      const dimClass = line.send_qty <= 0 ? ' dim-row' : '';
      const checkDisabled = line.send_qty <= 0 ? ' disabled' : '';
      
      return '<tr class="plan-row' + dimClass + '">' +
        '<td class="check-cell"><input type="checkbox" class="row-check" ' + checked + checkDisabled + ' onchange="toggleRow(\'' + escapeHtml(line.product) + '\')"></td>' +
        '<td class="product-cell"><div class="prod-code">' + escapeHtml(line.product) + conflictIcon + '</div>' + nameLine + '<div class="prod-meta">' + dcLine + (line.ctn_qty ? line.ctn_qty + '/ctn' : '') + '</div></td>' +
        '<td class="loc-cell">' + escapeHtml(line.location || '—') + '</td>' +
        '<td class="cover-cell">' + coverBadge + '</td>' +
        '<td class="num-cell">' + line.branch_stock + '</td>' +
        '<td class="num-cell main-cell">' + line.main_stock + '</td>' +
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
        lines = lines.filter(l => l.cover_days < 7 && l.category !== 'no_avg');
        break;
      case 'needs':
        lines = lines.filter(l => l.need_qty > 0 && l.category !== 'no_avg');
        break;
      case 'conflicts':
        lines = lines.filter(l => l.has_conflict);
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
    const criticalCount = withAvg.filter(l => l.cover_days < 7).length;
    const conflictCount = withAvg.filter(l => l.has_conflict).length;
    
    const bar = document.getElementById('summaryBar');
    if (bar) {
      let parts = [];
      parts.push(`<span class="sum-item"><strong>${toSend.length}</strong> products to send</span>`);
      parts.push(`<span class="sum-item"><strong>${totalUnits.toLocaleString()}</strong> units</span>`);
      if (totalCartons > 0) parts.push(`<span class="sum-item"><strong>${totalCartons}</strong> cartons</span>`);
      if (criticalCount > 0) parts.push(`<span class="sum-item sum-crit">🔴 <strong>${criticalCount}</strong> critical</span>`);
      if (conflictCount > 0) parts.push(`<span class="sum-item sum-warn">⚠️ <strong>${conflictCount}</strong> conflicts</span>`);
      bar.innerHTML = parts.join('<span class="sum-sep">·</span>');
      bar.style.display = 'flex';
    }
    
    // Update filter chip counts
    const counts = {
      to_send: toSend.length,
      critical: criticalCount,
      needs: withAvg.filter(l => l.need_qty > 0).length,
      conflicts: conflictCount,
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
