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
    branchKPIs: {},
    pendingByBranch: {}   // branchCode → { product → { pending_qty } } — in-transit, subtracted so cards match the branch detail page
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
      { title: 'Branch Target', text: `${CFG.BRANCH_TARGET_WEEKS} weeks of cover (ABC tiers adjust this per SKU)` },
      { title: 'Main Safety Stock', text: `Keep ≥ ${CFG.MAIN_MIN_WEEKS} weeks before sending` },
      { title: 'Zero Sales Skip', text: 'SKUs with 0 avg for a branch are excluded from that branch\'s plan' },
      { title: 'Formula', text: 'Send = min(Need − In-transit, Main Can Send)' },
      { title: 'Smart Carton Rounding', text: `Round up only if post-send stock ≤ ${CFG.CARTON_ROUND_UP_MAX_MONTHS} months cover (also ≤ ${CFG.CARTON_ROUND_UP_MAX_RATIO}× target)` },
      { title: 'Min Send Threshold', text: 'Small top-ups (below ~1 week of branch demand) are flagged for review, not dropped' },
      { title: 'Proportional Allocation', text: 'Competing branches get a share of Main proportional to need' },
      { title: 'Safety Override', text: 'Oversold branches bypass Main safety — flagged in UI' },
      { title: 'Stale Data Block', text: `Plans hidden if sync > ${Math.round(CFG.SYNC_BLOCK_MINUTES / 60)}h old` }
    ];
    grid.innerHTML = items.map(r => `
      <div class="rule-item">
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
      // IMPORTANT: filter status=success to avoid zombie "running" rows that
      // crashed mid-sync. PG default ORDER BY x DESC puts NULLs FIRST, so
      // raw "order ended_at desc" returns the oldest zombie (started days ago
      // with ended_at NULL). Filtering on success+ended_at is the safest.
      const { data, error } = await window.supabase
        .schema('cin7_mirror')
        .from('sync_runs')
        .select('run_id, started_at, ended_at, status, sync_type, products_synced, stock_rows_synced, duration_ms')
        .eq('status', 'success')
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(1);

      if (error) {
        dot.className = 'dot';
        text.textContent = 'Sync status unavailable — cin7_mirror schema needs to be exposed in Supabase';
        return;
      }

      if (!data || data.length === 0) {
        dot.className = 'dot';
        text.textContent = 'No sync runs found — run the first sync to populate data';
        state.syncStatus = null;
        return;
      }

      const run = data[0];
      state.syncStatus = run;
      state.syncRunClass = CFG.classifySyncRun(run);

      const isSuccess = run.status === 'success';
      const isRunning = run.status === 'running';
      dot.className = 'dot ' + (isSuccess ? 'ok' : isRunning ? 'warn' : 'crit');

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
      el.textContent = 'Syncing soon';
    } else {
      el.textContent = 'Auto 1h';
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
        parts.push(`<div class="alert warning">${escapeHtml(state.syncAge.message)}</div>`);
      }
    }
    if (state.syncRunClass && state.syncRunClass.warn && state.syncRunClass.message) {
      parts.push(`<div class="alert warning">${escapeHtml(state.syncRunClass.message)}</div>`);
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

    grid.innerHTML = '<p class="empty-state">Loading stock data from Cin7…</p>';

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
            ${Math.round(CFG.SYNC_BLOCK_MINUTES / 60)} hours. Refresh once sync recovers to avoid
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
            <div class="empty-state-sub">Waiting for Cin7 stock sync…</div>
          </div>
        `).join('');
        return;
      }

      computeBranchKPIs();
      renderBranchCards(grid, planMap);
      updateKPIBar();

      // Refine in the background with in-transit (pending TRs). The first paint
      // above shows cards immediately (without subtracting stock on the way);
      // once pending loads we recompute so the card numbers match what you see
      // when you open a branch. Non-blocking + non-fatal — if the endpoint is
      // unavailable the cards simply stay at the pre-transit estimate.
      loadOverviewPending().then((loaded) => {
        if (!loaded || isDataBlocked()) return;
        computeBranchKPIs();
        renderBranchCards(grid, planMap);
        updateKPIBar();
        console.log('📋 Overview refined with in-transit data');
      }).catch(() => {});

    } catch (err) {
      console.error('Error loading branch statuses:', err);
      grid.innerHTML = '<p class="empty-state error">Error loading branches</p>';
    }
  }

  // Fetch pending TRs for all branches (server-cached) and store the per-product
  // in-transit qty. Sequential to respect Cin7 rate limits (the all-branches
  // page does the same); the server cache makes repeat loads instant.
  async function loadOverviewPending() {
    let any = false;
    for (const b of BRANCHES) {
      try {
        const resp = await fetch(`/api/replenishment/pending-transfers/${b.code}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        state.pendingByBranch[b.code] = data.products || {};
        any = true;
      } catch (e) { /* non-fatal — overview falls back to pre-transit estimate */ }
    }
    return any;
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
        .select('sku, product_name, location_name, on_hand, available')
        .range(from, from + batchSize - 1);

      if (error) throw new Error('Cannot read cin7_mirror.stock_snapshot: ' + error.message);
      if (!data || data.length === 0) break;
      allStock = allStock.concat(data);
      if (data.length < batchSize) break;
      from += batchSize;
    }

    console.log(`📦 Loaded ${allStock.length} stock rows from cin7_mirror`);

    const aggregated = {};
    const names = {};
    for (const row of allStock) {
      // Capture first non-empty name per SKU — needed for per-metre / by-name exclusions.
      if (row.product_name && !names[row.sku]) names[row.sku] = row.product_name;

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

    state.productNames = names;
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

  // Branch lookup by code (for pickAvg, which needs both avgField and avgRepField).
  const BRANCH_BY_CODE = {};
  for (const b of CFG.BRANCHES) BRANCH_BY_CODE[b.code] = b;

  function computeBranchKPIs() {
    const products = Object.keys(state.avgDataMap);
    state.branchKPIs = {};

    // ABC ranks computed once per render (top movers → longer cover target)
    state.abcRanks = CFG.computeAbcRanks(Object.values(state.avgDataMap));

    // ── Pre-pass: honest cross-branch conflict map ──
    // A "conflict" = >1 branch competing for the same SKU AND Main can't cover
    // the combined (in-transit-adjusted) need. Same definition as the branch
    // detail + all-branches pages — the old code flagged ANY single-branch
    // shortfall as a "conflict", which inflated the KPI.
    const skuConflict = {}; // product → Set(branchCodes competing)
    for (const product of products) {
      if (CFG.isExcludedProduct(product, state.productNames?.[product])) continue;
      const avgRow = state.avgDataMap[product];
      if (!avgRow) continue;
      const mainStock = state.stockDataMap[`${product}:MAIN`];
      const mainAvailable = mainStock?.qty_available || 0;
      const canSendBase = Math.max(0, mainAvailable - CFG.computeMainSafety(CFG.pickMainAvg(avgRow)));
      const tier = state.abcRanks.get(product) || 'C';
      const targetWeeks = CFG.targetWeeksForTier(tier);
      let totalNeed = 0; const needing = [];
      for (const b of BRANCHES) {
        const avgMonth = CFG.pickAvg(avgRow, BRANCH_BY_CODE[b.code]);
        if (avgMonth <= 0) continue;
        const branchAvailable = state.stockDataMap[`${product}:${b.code}`]?.qty_available || 0;
        const target = CFG.computeBranchTarget(avgMonth, targetWeeks);
        const pendingQty = state.pendingByBranch?.[b.code]?.[product]?.pending_qty || 0;
        const eff = Math.max(0, Math.max(0, target - branchAvailable) - pendingQty);
        if (eff > 0) { totalNeed += eff; needing.push(b.code); }
      }
      // conflictPool > 0 required (matches branch page) — pure no-stock isn't a "conflict".
      if (needing.length > 1 && canSendBase > 0 && totalNeed > canSendBase) {
        skuConflict[product] = new Set(needing);
      }
    }

    for (const b of BRANCHES) {
      const branchInfo = BRANCH_BY_CODE[b.code];
      let totalProducts = 0;
      let totalUnits = 0;
      let critical = 0;
      let warning = 0;
      let ok = 0;
      let conflicts = 0;
      let safetyOverrides = 0;

      for (const product of products) {
        if (CFG.isExcludedProduct(product, state.productNames?.[product])) continue;

        const avgRow = state.avgDataMap[product];
        const avgMonth = CFG.pickAvg(avgRow, branchInfo);
        if (avgMonth <= 0) continue;

        const branchStock = state.stockDataMap[`${product}:${b.code}`];
        const mainStock = state.stockDataMap[`${product}:MAIN`];
        const branchAvailable = branchStock?.qty_available || 0;
        const mainAvailable = mainStock?.qty_available || 0;
        const avgMonthMain = CFG.pickMainAvg(avgRow);

        const tier = state.abcRanks.get(product) || 'C';
        const targetWeeks = CFG.targetWeeksForTier(tier);
        const mainAbundant = avgMonthMain > 0
          ? (mainAvailable / avgMonthMain) > 12
          : mainAvailable > 0;

        const avgWeekBranch = avgMonth / WEEKS_IN_MONTH;
        const coverDays = avgWeekBranch > 0 ? Math.round((branchAvailable / avgWeekBranch) * 7) : 999;
        const coverWeeksNow = avgWeekBranch > 0 ? branchAvailable / avgWeekBranch : 0;

        const targetQty = CFG.computeBranchTarget(avgMonth, targetWeeks);
        const needQty = Math.max(0, targetQty - branchAvailable);
        const mainMinQty = CFG.computeMainSafety(avgMonthMain);
        const canSendQty = Math.max(0, mainAvailable - mainMinQty);
        const soldDeficit = branchAvailable < 0 ? Math.abs(branchAvailable) : 0;
        const pendingQty = state.pendingByBranch?.[b.code]?.[product]?.pending_qty || 0;

        // The following mirrors the branch detail page's "is this a send?" path
        // EXACTLY so the overview counts reconcile with what you see on open:
        //   1) sufficient / already at target cover → not a send
        //   2) need already covered by in-transit TRs → not a send
        //   3) no Main stock to send (and not oversold) → not a send
        //   4) small top-ups are KEPT (soft flag on detail page), not dropped —
        //      previously this page hard-dropped them, so it read LOWER.
        const alreadyAtTarget = coverWeeksNow >= targetWeeks;
        if ((needQty <= 0 || alreadyAtTarget) && soldDeficit <= 0) continue;

        const effectiveNeed = Math.max(0, needQty - pendingQty);
        if (effectiveNeed <= 0 && soldDeficit <= 0) continue;   // on the way

        let pool = canSendQty;
        let override = false;
        if (soldDeficit > 0 && canSendQty < effectiveNeed && mainAvailable > 0) {
          pool = mainAvailable;
          override = true;
        }
        if (pool <= 0 && soldDeficit <= 0) continue;            // no Main stock

        let suggestedQty = Math.min(effectiveNeed, pool);
        const ctnQty = state.ctnMap[product] || 0;
        const rounded = CFG.smartCartonRound(suggestedQty, ctnQty, pool, targetQty, {
          avgMonthBranch: avgMonth,
          branchAvailable,
          mainAbundant
        });
        suggestedQty = rounded.qty;
        if (suggestedQty <= 0) continue;
        // NOTE: no min-send hard-drop here — kept consistent with the detail
        // page, which flags small sends for review rather than hiding them.

        totalProducts++;
        totalUnits += suggestedQty;
        if (override) safetyOverrides++;

        if (coverDays < CFG.COVER_CRITICAL_DAYS) critical++;
        else if (coverDays < CFG.COVER_WARNING_DAYS) warning++;
        else ok++;

        if (skuConflict[product]?.has(b.code)) conflicts++;
      }

      const total = critical + warning + ok;
      // Proportions for the stacked bar (only meaningful when total > 0)
      const critPct = total > 0 ? (critical / total) * 100 : 0;
      const warnPct = total > 0 ? (warning  / total) * 100 : 0;
      const okPct   = total > 0 ? (ok       / total) * 100 : 0;

      state.branchKPIs[b.code] = {
        totalProducts, totalUnits, critical, warning, ok,
        conflicts, safetyOverrides,
        critPct, warnPct, okPct, total
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
      const kpi = state.branchKPIs[b.code] || { totalProducts:0, totalUnits:0, critical:0, warning:0, ok:0, safetyOverrides:0, critPct:0, warnPct:0, okPct:0, total:0 };

      // Card severity — based on PROPORTION of critical, not raw count.
      // Avoids "everything is red" when most branches have 1-2 criticals.
      //  critical: > 25% of products to send are critical
      //  warning:  any critical present OR >25% warning
      //  good:     fully stocked OR <25% warning and 0 critical
      let healthClass = 'health-good';
      if (kpi.critPct > 25 || kpi.critical >= 10) healthClass = 'health-critical';
      else if (kpi.critical > 0 || kpi.warnPct > 25) healthClass = 'health-warning';

      // Severity label (more meaningful than "no_plan"/"draft")
      let severityLabel = 'Stable', severityClass = 'sev-ok';
      if (healthClass === 'health-critical') { severityLabel = 'Critical'; severityClass = 'sev-crit'; }
      else if (healthClass === 'health-warning') { severityLabel = 'Attention'; severityClass = 'sev-warn'; }
      if (kpi.totalProducts === 0) { severityLabel = 'Stocked'; severityClass = 'sev-stocked'; }

      const overrideBadge = kpi.safetyOverrides > 0
        ? ` <span class="override-badge" title="${kpi.safetyOverrides} safety-override product(s) — Main drained for oversold lines">OVR ${kpi.safetyOverrides}</span>`
        : '';

      // Stacked bar — only renders when there ARE products to send.
      // Shows ACTUAL breakdown (critical | warning | ok) so you see the
      // distribution at a glance — not a synthetic "health %" that misleads.
      const stackedBar = kpi.total > 0 ? `
        <div class="card-bar-row" title="${kpi.critical} critical · ${kpi.warning} warning · ${kpi.ok} ok">
          <div class="card-bar">
            ${kpi.critPct > 0 ? `<div class="seg seg-crit" style="width:${kpi.critPct}%"></div>` : ''}
            ${kpi.warnPct > 0 ? `<div class="seg seg-warn" style="width:${kpi.warnPct}%"></div>` : ''}
            ${kpi.okPct   > 0 ? `<div class="seg seg-ok"   style="width:${kpi.okPct}%"></div>`   : ''}
          </div>
          <div class="card-bar-legend">
            <span class="lg-crit">${kpi.critical}</span>
            <span class="lg-warn">${kpi.warning}</span>
            <span class="lg-ok">${kpi.ok}</span>
          </div>
        </div>
      ` : '';

      const footerMsg = kpi.totalProducts > 0
        ? `${kpi.totalProducts} to send · ${kpi.totalUnits.toLocaleString()} units`
        : 'Fully stocked';

      return `
        <a href="replenishment-branch.html?branch=${b.code}" class="branch-card ${healthClass}">
          <div class="card-header">
            <div>
              <div class="branch-name">${escapeHtml(b.name)}</div>
              <div class="branch-code">${escapeHtml(b.code)}${overrideBadge}</div>
            </div>
            <span class="severity-badge ${severityClass}">${severityLabel}</span>
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

          ${stackedBar}

          <div class="card-footer">
            <span>${footerMsg}</span>
            ${status !== 'no_plan' ? `<span class="card-status">${statusLabel}</span>` : ''}
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

    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px">Loading…</td></tr>';

    try {
      await window.supabaseReady;

      // Supabase has a 1000-row hard cap per request (PostgREST max-rows).
      // We have ~3000+ rows in branch_avg_monthly_sales — must paginate.
      let allData = [];
      let from = 0;
      const batchSize = 1000;
      while (true) {
        const { data, error } = await window.supabase
          .from('branch_avg_monthly_sales')
          .select('*')
          .order('product')
          .range(from, from + batchSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allData = allData.concat(data);
        if (data.length < batchSize) break;
        from += batchSize;
        if (from > 100000) break; // safety
      }

      state.avgData = allData;
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
