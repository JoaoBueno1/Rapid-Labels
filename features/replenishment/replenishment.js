/**
 * Branch Replenishment Planner - Main Page JS
 * Reads stock directly from cin7_mirror (auto-synced every 1h).
 * All thresholds and rules live in replenishment-config.js.
 */

(function() {
  'use strict';

  const CFG = window.ReplenishmentConfig;
  if (!CFG) {
    console.error('ReplenishmentConfig not loaded — include replenishment-config.js before replenishment.js');
    return;
  }

  const BRANCHES = CFG.BRANCHES.map(b => ({ code: b.code, name: b.name }));
  const CIN7_LOCATION_MAP = CFG.CIN7_LOCATION_MAP;
  const WEEKS_IN_MONTH = CFG.WEEKS_IN_MONTH;

  // ============================================
  // STATE
  // ============================================

  let state = {
    syncStatus: null,        // latest cin7_mirror.sync_runs row
    syncAge: null,           // classifySyncAge output
    syncRunClass: null,      // classifySyncRun output
    branchPlans: {},
    avgData: [],
    avgDataMap: {},
    stockDataMap: {},
    ctnMap: {},
    branchKPIs: {}
  };

  // ============================================
  // INITIALIZATION
  // ============================================

  document.addEventListener('DOMContentLoaded', async () => {
    console.log('📦 Branch Replenishment Planner initialized');
    renderRulesPanel();
    await loadBranchStatuses();
  });

  // ============================================
  // RULES PANEL — driven by config
  // ============================================
  function renderRulesPanel() {
    const grid = document.getElementById('rulesGrid');
    if (!grid) return;
    const items = [
      { icon: '🎯', title: 'Branch Target', text: `${CFG.BRANCH_TARGET_WEEKS} weeks cover + ${CFG.LEAD_TIME_DAYS}d lead-time buffer` },
      { icon: '🛡️', title: 'Main Safety Stock', text: `Keep ≥ ${CFG.MAIN_MIN_WEEKS} weeks before sending` },
      { icon: '🚚', title: 'Lead Time', text: `+${CFG.LEAD_TIME_DAYS} days freight buffer added to target` },
      { icon: '🚫', title: 'Zero Sales Skip', text: 'SKUs with 0 avg for a branch are excluded from that branch\'s plan' },
      { icon: '📐', title: 'Formula', text: 'Send = min(Need − In-transit, Main Can Send)' },
      { icon: '📦', title: 'Smart Carton Rounding', text: `Rounds up only if ≤ ${CFG.CARTON_ROUND_UP_MAX_RATIO}× target (avoids flooding slow movers)` },
      { icon: '🔻', title: 'Min Send Threshold', text: `Skip if qty < ½ carton (or < ${CFG.MIN_SEND_FALLBACK_UNITS} units when no CTN data)` },
      { icon: '⚖️', title: 'Proportional Allocation', text: 'Competing branches get a share of Main proportional to need' },
      { icon: '⚡', title: 'Safety Override', text: 'Oversold branches bypass Main safety — flagged in UI' },
      { icon: '⏰', title: 'Stale Data Block', text: `Plans hidden if sync > ${CFG.SYNC_BLOCK_MINUTES} min old` }
    ];
    grid.innerHTML = items.map(r => `
      <div class="rule-item">
        <span class="rule-icon">${r.icon}</span>
        <div>
          <strong>${escapeHtml(r.title)}</strong>
          <span>${escapeHtml(r.text)}</span>
        </div>
      </div>
    `).join('');
  }

  // ============================================
  // SYNC STATUS CARD
  // ============================================

  let _lastSyncEndedAt = null;

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
        dot.style.background = '#94a3b8';
        text.textContent = 'Sync status unavailable — cin7_mirror schema needs to be exposed in Supabase';
        text.style.color = '#64748b';
        return;
      }

      if (!data || data.length === 0) {
        dot.style.background = '#94a3b8';
        text.textContent = 'No sync runs found — run the first sync to populate data';
        state.syncStatus = null;
        return;
      }

      const run = data[0];
      state.syncStatus = run;
      state.syncRunClass = CFG.classifySyncRun(run);

      const isSuccess = run.status === 'success';
      const isRunning = run.status === 'running';
      dot.style.background = isSuccess ? '#22c55e' : isRunning ? '#3b82f6' : '#ef4444';

      const prodCount = run.products_synced || 0;
      const stockCount = run.stock_rows_synced || 0;
      const duration = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '';

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

      if (timeStr) {
        time.textContent = `Stock data from: ${timeStr}`;
      }

      if (run.ended_at) {
        _lastSyncEndedAt = run.ended_at;
        state.syncAge = CFG.classifySyncAge(run.ended_at);
        _refreshSyncAge();
        _refreshSyncCountdown();
      }
    } catch (e) {
      console.warn('Error fetching sync status:', e);
      dot.style.background = '#f59e0b';
      text.textContent = 'Could not fetch sync status';
      text.style.color = '#92400e';
    }
  }

  function _refreshSyncAge() {
    const ageEl = document.getElementById('syncStatusAge');
    if (!ageEl || !_lastSyncEndedAt) return;
    const cls = CFG.classifySyncAge(_lastSyncEndedAt);
    state.syncAge = cls;

    ageEl.textContent = cls.ageMinutes == null ? '' : CFG.formatAge(cls.ageMinutes) + ' ago';
    if (cls.level === 'block') {
      ageEl.style.color = '#dc2626';
      ageEl.style.fontWeight = '700';
    } else if (cls.level === 'warn') {
      ageEl.style.color = '#f59e0b';
      ageEl.style.fontWeight = '600';
    } else {
      ageEl.style.color = '#94a3b8';
      ageEl.style.fontWeight = '400';
    }
  }

  function _refreshSyncCountdown() {
    const el = document.getElementById('syncCountdown');
    if (!el) return;
    const now = new Date();
    const nextH = new Date(now);
    nextH.setMinutes(0, 0, 0);
    if (nextH <= now) nextH.setHours(nextH.getHours() + 1);
    const diffMin = Math.max(0, Math.ceil((nextH - now) / 60000));
    if (diffMin <= 5) {
      el.textContent = '🔄 Syncing soon…';
      el.style.color = '#3b82f6';
    } else {
      el.textContent = '🛡️ Auto 1h';
      el.style.color = '#94a3b8';
    }
  }

  setInterval(() => {
    _refreshSyncAge();
    _refreshSyncCountdown();
    renderDataAlerts();
  }, 60000);
  _refreshSyncCountdown();

  // ============================================
  // DATA-FRESHNESS ALERTS (stale + partial sync)
  // ============================================
  function renderDataAlerts() {
    const container = document.getElementById('dataAlertContainer');
    if (!container) return;
    const parts = [];
    if (state.syncAge) {
      if (state.syncAge.level === 'block') {
        parts.push(`<div class="alert critical">⛔ ${escapeHtml(state.syncAge.message)}</div>`);
      } else if (state.syncAge.level === 'warn') {
        parts.push(`<div class="alert warning">⚠️ ${escapeHtml(state.syncAge.message)}</div>`);
      }
    }
    if (state.syncRunClass && state.syncRunClass.warn && state.syncRunClass.message) {
      parts.push(`<div class="alert warning">⚠️ ${escapeHtml(state.syncRunClass.message)}</div>`);
    }
    container.innerHTML = parts.join('');
  }

  function isDataBlocked() {
    return state.syncAge && state.syncAge.level === 'block';
  }

  // ============================================
  // LOAD DATA
  // ============================================

  async function loadBranchStatuses() {
    const grid = document.getElementById('branchGrid');
    if (!grid) return;

    grid.innerHTML = '<p style="color:#64748b;text-align:center;padding:20px">Loading stock data from Cin7…</p>';

    try {
      await window.supabaseReady;

      const [, , , , plansResult] = await Promise.all([
        updateSyncStatusCard(),
        loadAllStockData(),
        loadAllAvgData(),
        loadCtnData(),
        window.supabase
          .from('transfer_plans')
          .select('branch_code, status, created_at')
          .order('created_at', { ascending: false })
      ]);

      renderDataAlerts();

      if (plansResult.error) throw plansResult.error;

      const planMap = {};
      for (const p of (plansResult.data || [])) {
        if (!planMap[p.branch_code]) planMap[p.branch_code] = p;
      }
      state.branchPlans = planMap;

      if (isDataBlocked()) {
        // Hard block — do not render potentially misleading recommendations.
        grid.innerHTML = `
          <div class="alert critical" style="grid-column:1/-1">
            <strong>Recommendations hidden.</strong> Cin7 sync has not succeeded in over
            ${CFG.SYNC_BLOCK_MINUTES} minutes. Refresh once sync recovers to avoid
            acting on stale stock levels.
          </div>`;
        return;
      }

      if (Object.keys(state.stockDataMap).length === 0) {
        grid.innerHTML = BRANCHES.map(b => `
          <div class="branch-card">
            <div class="card-header">
              <div>
                <div class="branch-name">${escapeHtml(b.name)}</div>
                <div class="branch-code">${escapeHtml(b.code)}</div>
              </div>
              <span class="status-badge no_plan">No Data</span>
            </div>
            <div style="font-size:12px;color:#64748b;padding:8px 0">Waiting for Cin7 stock sync…</div>
          </div>
        `).join('');
        return;
      }

      computeBranchKPIs();
      renderBranchCards(grid, planMap);
      updateKPIBar();

    } catch (err) {
      console.error('Error loading branch statuses:', err);
      grid.innerHTML = '<p style="color:#dc2626">Error loading branches</p>';
    }
  }

  // ============================================
  // DATA LOADING
  // ============================================

  async function loadAllAvgData() {
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

    state.avgData = allData;
    state.avgDataMap = {};
    for (const row of allData) state.avgDataMap[row.product] = row;
    return allData;
  }

  async function loadAllStockData() {
    let allStock = [];
    let from = 0;
    const batchSize = 1000;

    while (true) {
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('stock_snapshot')
        .select('sku, location_name, on_hand, available')
        .range(from, from + batchSize - 1);

      if (error) throw new Error('Cannot read cin7_mirror.stock_snapshot: ' + error.message);
      if (!data || data.length === 0) break;
      allStock = allStock.concat(data);
      if (data.length < batchSize) break;
      from += batchSize;
    }

    console.log(`📦 Loaded ${allStock.length} stock rows from cin7_mirror`);

    const aggregated = {};
    for (const row of allStock) {
      const locName = (row.location_name || '').toLowerCase().trim();
      const warehouseCode = CIN7_LOCATION_MAP[locName];
      if (!warehouseCode) continue;

      const key = `${row.sku}:${warehouseCode}`;
      if (!aggregated[key]) {
        aggregated[key] = {
          product: row.sku,
          warehouse_code: warehouseCode,
          qty_available: 0
        };
      }
      aggregated[key].qty_available += (row.available != null ? row.available : row.on_hand || 0);
    }

    state.stockDataMap = aggregated;
    console.log(`📊 Aggregated to ${Object.keys(state.stockDataMap).length} SKU/warehouse entries`);
    return aggregated;
  }

  async function loadCtnData() {
    try {
      const { data, error } = await window.supabase
        .from('restock_setup')
        .select('product, qty_per_ctn')
        .not('qty_per_ctn', 'is', null);

      if (error) { console.warn('Could not load CTN data:', error); return; }

      state.ctnMap = {};
      for (const row of (data || [])) {
        let product = (row.product || '').trim();
        const spaceMatch = product.match(/^\d{4,6}\s+(.+)$/);
        if (spaceMatch) product = spaceMatch[1].trim();
        if (product && row.qty_per_ctn > 0) {
          state.ctnMap[product] = Number(row.qty_per_ctn);
        }
      }
      console.log(`📦 Loaded CTN data for ${Object.keys(state.ctnMap).length} products`);
    } catch (err) {
      console.warn('CTN data load failed:', err);
    }
  }

  // ============================================
  // KPI COMPUTATION — uses config helpers
  // ============================================

  const AVG_FIELDS = {};
  for (const b of CFG.BRANCHES) AVG_FIELDS[b.code] = b.avgField;

  function computeBranchKPIs() {
    const products = Object.keys(state.avgDataMap);
    state.branchKPIs = {};

    for (const b of BRANCHES) {
      const avgField = AVG_FIELDS[b.code];
      let totalProducts = 0;
      let totalUnits = 0;
      let critical = 0;
      let warning = 0;
      let ok = 0;
      let conflicts = 0;
      let safetyOverrides = 0;

      for (const product of products) {
        if (CFG.isExcludedProduct(product)) continue;

        const avgRow = state.avgDataMap[product];
        const avgMonth = avgRow?.[avgField] || 0;
        if (avgMonth <= 0) continue;

        const branchStock = state.stockDataMap[`${product}:${b.code}`];
        const mainStock = state.stockDataMap[`${product}:MAIN`];
        const branchAvailable = branchStock?.qty_available || 0;
        const mainAvailable = mainStock?.qty_available || 0;
        const avgMonthMain = avgRow?.avg_mth_main || 0;

        const avgWeekBranch = avgMonth / WEEKS_IN_MONTH;
        const coverDays = avgWeekBranch > 0 ? Math.round((branchAvailable / avgWeekBranch) * 7) : 999;

        const targetQty = CFG.computeBranchTarget(avgMonth);
        const needQty = Math.max(0, targetQty - branchAvailable);
        const mainMinQty = CFG.computeMainSafety(avgMonthMain);
        const canSendQty = Math.max(0, mainAvailable - mainMinQty);
        const soldDeficit = branchAvailable < 0 ? Math.abs(branchAvailable) : 0;

        // Mirror safety override logic from detail pages
        let pool = canSendQty;
        let override = false;
        if (soldDeficit > 0 && canSendQty < needQty && mainAvailable > 0) {
          pool = mainAvailable;
          override = true;
        }

        let suggestedQty = Math.min(needQty, pool);
        if (suggestedQty <= 0) continue;

        const ctnQty = state.ctnMap[product] || 0;
        const rounded = CFG.smartCartonRound(suggestedQty, ctnQty, pool, targetQty);
        suggestedQty = rounded.qty;

        // Minimum threshold
        if (branchAvailable > 0 && soldDeficit <= 0) {
          const minThreshold = CFG.computeMinSend(ctnQty, avgMonth);
          if (suggestedQty < minThreshold) continue;
        }

        totalProducts++;
        totalUnits += suggestedQty;
        if (override) safetyOverrides++;

        if (coverDays < CFG.COVER_CRITICAL_DAYS) critical++;
        else if (coverDays < CFG.COVER_WARNING_DAYS) warning++;
        else ok++;

        if (canSendQty < needQty) conflicts++;
      }

      const total = critical + warning + ok;
      const healthPct = total > 0 ? Math.round(((ok + warning * 0.5) / total) * 100) : 100;

      state.branchKPIs[b.code] = {
        totalProducts, totalUnits, critical, warning, ok,
        conflicts, safetyOverrides, healthPct
      };
    }
  }

  function updateKPIBar() {
    const kpiBar = document.getElementById('kpiBar');
    if (!kpiBar) return;

    let totalProducts = 0, totalUnits = 0, totalCritical = 0, totalWarning = 0, totalConflicts = 0;
    const branchCodes = Object.keys(state.branchKPIs);

    for (const code of branchCodes) {
      const k = state.branchKPIs[code];
      totalProducts += k.totalProducts;
      totalUnits += k.totalUnits;
      totalCritical += k.critical;
      totalWarning += k.warning;
      totalConflicts += k.conflicts;
    }

    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setEl('kpiTotalProducts', totalProducts);
    setEl('kpiTotalUnits', totalUnits.toLocaleString());
    setEl('kpiCritical', totalCritical);
    setEl('kpiWarning', totalWarning);
    setEl('kpiConflicts', totalConflicts);

    kpiBar.style.display = 'block';

    const summaryText = document.getElementById('branchSummaryText');
    if (summaryText) {
      const activeBranches = branchCodes.filter(c => state.branchKPIs[c].totalProducts > 0).length;
      summaryText.textContent = `${activeBranches} of ${BRANCHES.length} branches need stock`;
    }
  }

  function renderBranchCards(grid, planMap) {
    grid.innerHTML = BRANCHES.map(b => {
      const plan = planMap[b.code];
      const status = plan ? plan.status : 'no_plan';
      const statusLabel = status === 'no_plan' ? 'No Plan' : status.charAt(0).toUpperCase() + status.slice(1);
      const kpi = state.branchKPIs[b.code] || { totalProducts: 0, totalUnits: 0, critical: 0, warning: 0, ok: 0, safetyOverrides: 0, healthPct: 100 };

      let healthClass = 'health-good';
      if (kpi.critical > 0) healthClass = 'health-critical';
      else if (kpi.warning > 0) healthClass = 'health-warning';

      let barColor = '#10b981';
      if (kpi.healthPct < 50) barColor = '#dc2626';
      else if (kpi.healthPct < 80) barColor = '#f59e0b';

      const planDate = plan ? new Date(plan.created_at).toLocaleDateString() : '';
      const overrideBadge = kpi.safetyOverrides > 0
        ? `<span title="${kpi.safetyOverrides} safety-override product(s) — Main drained for oversold lines" style="font-size:10px;color:#dc2626;font-weight:700"> ⚡${kpi.safetyOverrides}</span>`
        : '';

      return `
        <a href="replenishment-branch.html?branch=${b.code}" class="branch-card ${healthClass}" style="text-decoration:none;color:inherit">
          <div class="card-header">
            <div>
              <div class="branch-name">${escapeHtml(b.name)}</div>
              <div class="branch-code">${escapeHtml(b.code)}${overrideBadge}</div>
            </div>
            <span class="status-badge ${status}">${statusLabel}</span>
          </div>

          <div class="card-stats">
            <div class="card-stat">
              <span>Products</span>
              <span class="stat-val">${kpi.totalProducts}</span>
            </div>
            <div class="card-stat">
              <span>Units</span>
              <span class="stat-val">${kpi.totalUnits.toLocaleString()}</span>
            </div>
            <div class="card-stat">
              <span>Critical</span>
              <span class="stat-val ${kpi.critical > 0 ? 'crit' : ''}">${kpi.critical}</span>
            </div>
            <div class="card-stat">
              <span>Warning</span>
              <span class="stat-val ${kpi.warning > 0 ? 'warn' : ''}">${kpi.warning}</span>
            </div>
          </div>

          <div class="card-health-bar">
            <div class="card-health-fill" style="width:${kpi.healthPct}%;background:${barColor}"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#94a3b8">
            <span>${kpi.totalProducts > 0 ? kpi.totalProducts + ' to send · ' + kpi.totalUnits.toLocaleString() + ' units' : 'Fully stocked ✓'}</span>
            ${planDate ? `<span>Plan: ${planDate}</span>` : ''}
          </div>
        </a>
      `;
    }).join('');
  }

  // ============================================
  // AVG MANAGEMENT MODAL
  // ============================================

  window.openAvgManagementModal = async function() {
    document.getElementById('avgModal')?.classList.remove('hidden');
    await loadAvgData();
  };

  window.closeAvgManagementModal = function() {
    document.getElementById('avgModal')?.classList.add('hidden');
  };

  async function loadAvgData() {
    const tbody = document.getElementById('avgTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px">Loading...</td></tr>';

    try {
      await window.supabaseReady;

      const { data, error } = await window.supabase
        .from('branch_avg_monthly_sales')
        .select('*')
        .order('product')
        .limit(5000);

      if (error) throw error;

      state.avgData = data || [];
      renderAvgTable(state.avgData);

    } catch (err) {
      console.error('Error loading AVG data:', err);
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#dc2626">Error loading data</td></tr>';
    }
  }

  function renderAvgTable(data) {
    const tbody = document.getElementById('avgTableBody');
    if (!tbody) return;

    const countEl = document.getElementById('avgCount');
    if (countEl) {
      countEl.textContent = `Showing ${data.length} of ${state.avgData.length} products`;
    }

    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#64748b">No data. Upload AVG via Supabase CSV import.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map(row => `
      <tr data-product="${escapeHtml(row.product)}">
        <td style="font-weight:600">${escapeHtml(row.product || '')}</td>
        <td class="num">${(row.avg_mth_main || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_sydney || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_melbourne || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_brisbane || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_cairns || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_coffs_harbour || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_hobart || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_sunshine_coast || 0).toFixed(1)}</td>
      </tr>
    `).join('');
  }

  window.filterAvgTable = function() {
    const search = document.getElementById('avgSearchInput')?.value.toLowerCase() || '';
    const filtered = state.avgData.filter(row => {
      return (row.product || '').toLowerCase().includes(search);
    });
    renderAvgTable(filtered);
  };

  // ============================================
  // UTILITIES
  // ============================================

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

})();
