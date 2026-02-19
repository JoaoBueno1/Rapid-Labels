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

  const WEEKS_IN_MONTH = 4.345;
  const BRANCH_TARGET_WEEKS = 5;
  const MAIN_MIN_WEEKS = 8;

  // ============================================
  // STATE
  // ============================================
  
  let state = {
    branchCode: null,
    branchInfo: null,
    snapshot: null,
    plan: null,
    planLines: [],
    avgData: {},
    stockData: {},
    filter: 'all',
    search: '',
    currentPage: 1,
    pageSize: 50
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
      
      // Load latest snapshot
      const { data: snapshots, error: snapError } = await window.supabase
        .from('stock_snapshots')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (snapError) throw snapError;
      
      if (!snapshots || snapshots.length === 0) {
        showNoSnapshot();
        return;
      }
      
      state.snapshot = snapshots[0];
      updateSnapshotInfo();
      
      // Load AVG data and stock in parallel
      console.log('Loading data...');
      await Promise.all([
        loadAvgData(),
        loadStockData(),
        loadExistingPlan()
      ]);
      
      console.log('Data loaded, checking for existing plan...');
      
      // If existing plan, show it; otherwise show empty table (user needs to click Generate)
      if (state.plan && state.planLines.length > 0) {
        renderTable();
        updateStats();
      } else {
        // No plan yet - show empty state, user must click Generate Plan
        const tbody = document.getElementById('planTableBody');
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:40px;color:#64748b">Click <strong>Generate Plan</strong> to calculate replenishment needs</td></tr>';
        }
      }
      
    } catch (err) {
      console.error('Error loading data:', err);
      showError('Error loading data: ' + err.message);
    } finally {
      showLoading(false);
    }
  }

  function showNoSnapshot() {
    // Show alert instead of changing display of elements that don't exist
    const alertContainer = document.getElementById('alertContainer');
    if (alertContainer) {
      alertContainer.innerHTML = `
        <div class="alert warning">
          <strong>No stock snapshot available.</strong> 
          Please <a href="replenishment.html">upload a stock report</a> first.
        </div>
      `;
    }
  }

  function updateSnapshotInfo() {
    const el = document.getElementById('snapshotDate');
    if (el && state.snapshot) {
      const date = new Date(state.snapshot.created_at);
      el.textContent = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
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
    console.log('Loading stock data for snapshot:', state.snapshot.id);
    
    // Need to paginate because Supabase has 1000 row limit per request
    let allData = [];
    let from = 0;
    const batchSize = 1000;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('stock_snapshot_lines')
        .select('product, warehouse_code, qty_available')
        .eq('snapshot_id', state.snapshot.id)
        .range(from, from + batchSize - 1);
      
      if (error) throw error;
      if (!data || data.length === 0) break;
      
      allData = allData.concat(data);
      console.log(`Loaded ${allData.length} stock lines...`);
      
      if (data.length < batchSize) break;
      from += batchSize;
    }
    
    console.log(`Total stock loaded: ${allData.length}`);
    
    // Index by product + warehouse for quick lookup
    state.stockData = {};
    for (const row of allData) {
      const key = `${row.product}:${row.warehouse_code}`;
      state.stockData[key] = row;
    }
    
    console.log(`Indexed ${Object.keys(state.stockData).length} stock entries`);
  }

  async function loadExistingPlan() {
    const { data: plans, error } = await window.supabase
      .from('transfer_plans')
      .select('*')
      .eq('snapshot_id', state.snapshot.id)
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
    
    // Use AVG table products as the source (2660 products)
    const products = Object.keys(state.avgData);
    
    console.log(`Calculating plan for ${products.length} products with AVG data...`);
    
    // First pass: calculate needs for ALL branches to detect conflicts
    const allBranchNeeds = {};
    for (const product of products) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
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
        
        const branchStock = state.stockData[`${product}:${code}`];
        const branchAvailable = branchStock?.qty_available || 0;
        const avgWeekBranch = avgMonth / WEEKS_IN_MONTH;
        const target = Math.ceil(avgWeekBranch * BRANCH_TARGET_WEEKS);
        const need = Math.max(0, target - branchAvailable);
        
        if (need > 0) {
          branchNeeds[code] = need;
          totalNeed += need;
        }
      }
      
      // Check for conflict: total need > can send
      if (totalNeed > canSendTotal && canSendTotal > 0 && Object.keys(branchNeeds).length > 1) {
        allBranchNeeds[product] = {
          totalNeed,
          canSend: canSendTotal,
          branches: Object.keys(branchNeeds).filter(c => c !== branchCode),
          hasConflict: true
        };
      }
    }
    
    // Second pass: calculate this branch's plan
    for (const product of products) {
      if (product.toLowerCase().includes('carton')) continue;
      
      const avgRow = state.avgData[product];
      const avgMonthBranch = avgRow?.[avgField] || 0;
      
      if (avgMonthBranch <= 0) continue;
      
      const branchStock = state.stockData[`${product}:${branchCode}`];
      const mainStock = state.stockData[`${product}:MAIN`];
      
      const branchAvailable = branchStock?.qty_available || 0;
      const mainAvailable = mainStock?.qty_available || 0;
      const avgMonthMain = avgRow?.avg_mth_main || 0;
      
      const avgWeekBranch = avgMonthBranch / WEEKS_IN_MONTH;
      const avgWeekMain = avgMonthMain / WEEKS_IN_MONTH;
      
      // Cover Days = (current stock / weekly avg) * 7
      const coverDays = avgWeekBranch > 0 ? Math.round((branchAvailable / avgWeekBranch) * 7) : 999;
      
      const targetQty = Math.ceil(avgWeekBranch * BRANCH_TARGET_WEEKS);
      const needQty = Math.max(0, targetQty - branchAvailable);
      const mainMinQty = Math.ceil(avgWeekMain * MAIN_MIN_WEEKS);
      const canSendQty = Math.max(0, mainAvailable - mainMinQty);
      const suggestedQty = Math.min(needQty, canSendQty);
      
      if (suggestedQty <= 0) continue;
      
      // Check if this product has conflict
      const conflictInfo = allBranchNeeds[product];
      
      lines.push({
        product,
        cover_days: coverDays,
        branch_stock: branchAvailable,
        avg_branch: avgMonthBranch,
        main_stock: mainAvailable,
        avg_main: avgMonthMain,
        send_qty: suggestedQty,
        has_conflict: conflictInfo?.hasConflict || false,
        conflict_branches: conflictInfo?.branches || []
      });
    }
    
    // Sort by cover days (ascending) - most urgent first
    lines.sort((a, b) => a.cover_days - b.cover_days);
    
    console.log(`Plan calculated: ${lines.length} products to send`);
    state.planLines = lines;
    state.conflictCount = lines.filter(l => l.has_conflict).length;
  }

  window.generatePlan = function() {
    showLoading(true);
    
    try {
      console.log('Generating plan...');
      calculatePlan();
      renderTable();
      updateStats();
      
      // Show export button, hide generate
      const generateBtn = document.getElementById('generateBtn');
      const exportBtn = document.getElementById('exportBtn');
      
      if (generateBtn) generateBtn.textContent = 'Regenerate';
      if (exportBtn) exportBtn.style.display = '';
      
      console.log('Plan generated successfully');
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
    
    // Apply search filter
    let lines = state.planLines;
    
    if (state.search) {
      const s = state.search.toLowerCase();
      lines = lines.filter(l => l.product.toLowerCase().includes(s));
    }
    
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
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#64748b">No products to send</td></tr>';
      updatePagination(0, 0);
      return;
    }
    
    // 7-column table with Cover Days
    tbody.innerHTML = pageLines.map(line => {
      // Cover days styling
      let coverClass = 'cover-ok';
      if (line.cover_days < 7) coverClass = 'cover-critical';
      else if (line.cover_days < 21) coverClass = 'cover-warning';
      
      const coverText = line.cover_days >= 999 ? '∞' : `${line.cover_days}d`;
      
      // Conflict badge
      const conflictBadge = line.has_conflict 
        ? `<span class="conflict-badge" title="Also needed by: ${line.conflict_branches.join(', ')}">⚠️ ${line.conflict_branches.length}</span>`
        : '';
      
      return `
        <tr>
          <td style="font-weight:500">${escapeHtml(line.product)}${conflictBadge}</td>
          <td class="${coverClass}">${coverText}</td>
          <td>${line.branch_stock}</td>
          <td class="avg-cell">${Math.round(line.avg_branch)}</td>
          <td>${line.main_stock}</td>
          <td class="avg-cell">${Math.round(line.avg_main)}</td>
          <td style="font-weight:600;color:#059669">${line.send_qty}</td>
        </tr>
      `;
    }).join('');
    
    updatePagination(lines.length, totalPages);
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
    const stats = {
      totalProducts: state.planLines.length,
      totalUnits: state.planLines.reduce((sum, l) => sum + l.send_qty, 0),
      criticalCount: state.planLines.filter(l => l.cover_days < 7).length,
      conflictCount: state.planLines.filter(l => l.has_conflict).length
    };
    
    // Update UI elements
    const totalProductsEl = document.getElementById('totalProducts');
    const totalUnitsEl = document.getElementById('totalUnits');
    const criticalCountEl = document.getElementById('criticalCount');
    const summarySection = document.getElementById('summarySection');
    const conflictAlert = document.getElementById('conflictAlert');
    const conflictCountEl = document.getElementById('conflictCount');
    
    if (totalProductsEl) totalProductsEl.textContent = stats.totalProducts;
    if (totalUnitsEl) totalUnitsEl.textContent = stats.totalUnits;
    if (criticalCountEl) criticalCountEl.textContent = stats.criticalCount;
    if (summarySection) summarySection.style.display = 'flex';
    
    // Show conflict alert if any conflicts
    if (conflictAlert && conflictCountEl) {
      if (stats.conflictCount > 0) {
        conflictCountEl.textContent = stats.conflictCount;
        conflictAlert.style.display = 'block';
      } else {
        conflictAlert.style.display = 'none';
      }
    }
  }

  // ============================================
  // FILTERS & PAGINATION
  // ============================================
  
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
          snapshot_id: state.snapshot.id,
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
    if (state.planLines.length === 0) {
      alert('No items to export. Generate a plan first.');
      return;
    }
    
    // Build CSV with simple columns
    const headers = ['Product', 'Branch Stock', 'Main Stock', 'Send Qty'];
    const rows = state.planLines.map(l => [
      `"${(l.product || '').replace(/"/g, '""')}"`,
      l.branch_stock,
      l.main_stock,
      l.send_qty
    ]);
    
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    
    // Download
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transfer-${state.branchCode}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

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
