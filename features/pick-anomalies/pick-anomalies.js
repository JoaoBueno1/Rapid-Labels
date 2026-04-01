// pick-anomalies.js — v2 (Persistent History + Auto-Sync)
// Architecture:
//   - On page load: load history from Supabase (via backend /api/pick-anomalies/history)
//   - Auto-sync: trigger /api/pick-anomalies/sync to fetch new orders since last sync
//   - All data persisted — no need to re-analyze, just open the page
//   - Search bar filters in real-time
//   - Corrections tracked per pick (shows "Transfer Created" status)

(function () {
  'use strict';

  /* ───── Utilities ───── */
  const esc = (s) => {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  };

  const formatDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00'));
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  /* ───── State ───── */
  const state = {
    orders: [],
    activeFilter: 'all',
    activeTab: 'anomalies',
    selectedOrder: null,
    selectedFixes: new Set(),
    selectedBulk: new Set(),  // order indices selected for bulk print
    searchQuery: '',
    searchTimer: null,
    syncing: false,
    page: 1,
    perPage: 50,
    totalOrders: 0,
    stats: null,  // Global KPI stats (all orders, not just current page)
  };

  /* ═══════════════════════════════════════════════
     BIN PARSING & ERROR CLASSIFICATION
     ═══════════════════════════════════════════════ */

  function parseBin(bin) {
    if (!bin) return null;
    const m = bin.match(/^MA-([A-Z])-(\d+)-L(\d+)(?:-P(\d+))?$/i);
    if (!m) return { raw: bin, area: null, col: null, level: null, pallet: null };
    return { raw: bin, area: m[1].toUpperCase(), col: m[2], level: m[3], pallet: m[4] || null };
  }

  function classifyError(pickedBin, expectedBin) {
    if (!pickedBin || !expectedBin) return { type: 'unknown', severity: 'low', label: 'Unknown' };
    const p = parseBin(pickedBin);
    const e = parseBin(expectedBin);
    if (!p || !p.area || !e || !e.area) return { type: 'special_loc', severity: 'info', label: 'Special Location' };
    if (p.area === e.area && p.col === e.col && p.level === e.level && p.pallet !== e.pallet)
      return { type: 'pallet_only', severity: 'low', label: 'Wrong Pallet (same level)' };
    if (p.area === e.area && p.col === e.col)
      return { type: 'same_column', severity: 'medium', label: 'Wrong Level (same column)' };
    if (p.area === e.area)
      return { type: 'same_section', severity: 'medium', label: 'Wrong Column (same section)' };
    return { type: 'different_area', severity: 'high', label: 'Different Section!' };
  }

  function severityBadge(severity) {
    const map = { low: '🟡', medium: '🟠', high: '🔴', info: '🔵' };
    return `<span class="pa-badge pa-sev-${severity}">${map[severity] || '⚪'} ${severity}</span>`;
  }

  /* ═══════════════════════════════════════════════
     KPI UPDATE
     ═══════════════════════════════════════════════ */
  /**
   * Fetch global KPI stats from backend (aggregated across ALL orders).
   * Zero Cin7 API calls — Supabase only.
   */
  async function loadStats() {
    try {
      const res = await fetch('/api/pick-anomalies/stats');
      const data = await res.json();
      if (data.success && data.stats) {
        state.stats = data.stats;
        updateKpis();
      }
    } catch (err) {
      console.warn('Stats load failed:', err);
    }
  }

  function updateKpis() {
    const el = document.getElementById('paKpis');
    el.style.display = '';

    const s = state.stats;
    if (!s) return; // Stats not loaded yet

    // Reviewed KPI: only count orders WITH anomalies
    const anomalyOrders = s.anomalyOrders || 0;
    const anomalyReviewed = s.anomalyOrdersReviewed || 0;
    const reviewedPct = anomalyOrders > 0 ? Math.round((anomalyReviewed / anomalyOrders) * 100) : 100;

    document.getElementById('kpiOrders').textContent = s.orders;
    document.getElementById('kpiPicks').textContent = s.picks;
    document.getElementById('kpiCorrect').textContent = s.correct;
    document.getElementById('kpiAnomalies').textContent = s.anomalies;
    document.getElementById('kpiFg').textContent = s.fg;
    document.getElementById('kpiReviewed').textContent = anomalyOrders > 0
      ? `${anomalyReviewed}/${anomalyOrders}`
      : '✅';

    // Update review progress bar
    const bar = document.getElementById('kpiReviewedBar');
    if (bar) {
      bar.style.width = `${reviewedPct}%`;
      bar.className = 'pa-review-bar-fill' +
        (reviewedPct >= 100 ? ' pa-bar-complete' : reviewedPct >= 50 ? ' pa-bar-good' : ' pa-bar-low');
    }
  }

  /* ═══════════════════════════════════════════════
     SYNC STATUS
     ═══════════════════════════════════════════════ */
  function setSyncStatus(status, text) {
    const dot = document.getElementById('paSyncDot');
    const txt = document.getElementById('paSyncText');
    dot.className = 'pa-sync-dot pa-sync-' + status; // idle | syncing | success | error
    txt.textContent = text;
  }

  let _lastSyncTime = null;
  function updateSyncAge(syncDate) {
    _lastSyncTime = syncDate || new Date();
    const ageEl = document.getElementById('paSyncAge');
    if (!ageEl) return;
    _refreshSyncAge();
    _refreshCountdown();
  }

  function _refreshSyncAge() {
    const ageEl = document.getElementById('paSyncAge');
    if (!ageEl || !_lastSyncTime) return;
    const agoMs = Date.now() - _lastSyncTime.getTime();
    const agoMin = Math.floor(agoMs / 60000);
    let agoStr;
    if (agoMin < 1) agoStr = 'just now';
    else if (agoMin < 60) agoStr = `${agoMin}m ago`;
    else {
      const h = Math.floor(agoMin / 60);
      const m = agoMin % 60;
      agoStr = m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
    }
    ageEl.textContent = agoStr;
    ageEl.style.color = agoMin > 180 ? '#ef4444' : agoMin > 130 ? '#f59e0b' : '#94a3b8';
  }

  /* ─── Countdown to next backend sync ─── */
  function _refreshCountdown() {
    const el = document.getElementById('paSyncCountdown');
    if (!el) return;
    const now = new Date();
    const INTERVAL_MS = 2 * 3600000; // 2 hours

    let nextSync;
    if (_lastSyncTime) {
      nextSync = new Date(_lastSyncTime.getTime() + INTERVAL_MS);
      if (nextSync <= now) {
        const elapsed = now - nextSync;
        nextSync = new Date(nextSync.getTime() + Math.ceil(elapsed / INTERVAL_MS) * INTERVAL_MS);
      }
    } else {
      // Fallback: cron schedule '30 */2 * * *' → even UTC hours at :30
      const utcH = now.getUTCHours();
      const utcM = now.getUTCMinutes();
      const utcS = now.getUTCSeconds();
      let nextH = utcH;
      if (utcM > 30 || (utcM === 30 && utcS > 0)) nextH++;
      if (nextH % 2 !== 0) nextH++;
      nextSync = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
        nextH, 30, 0, 0
      ));
      if (nextSync <= now) nextSync = new Date(nextSync.getTime() + INTERVAL_MS);
    }

    const diffMs = nextSync - now;
    const diffMin = Math.max(0, Math.floor(diffMs / 60000));
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    const countdown = h > 0 ? `${h}h ${m}m` : `${m}m`;
    el.textContent = `🛡️ Next sync in ${countdown}`;
    el.title = `Next sync ~${nextSync.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} (every 2h from last sync). May vary ~5-15 min.`;
  }

  // Refresh "time ago" + countdown every 60s
  setInterval(() => { _refreshSyncAge(); _refreshCountdown(); }, 60000);
  _refreshCountdown();

  function showProgress(text) {
    const el = document.getElementById('paProgress');
    el.style.display = '';
    document.getElementById('paProgressFill').style.width = '100%';
    document.getElementById('paProgressFill').style.animation = 'paPulseBar 1.5s infinite';
    document.getElementById('paProgressText').textContent = text || 'Syncing new orders...';
  }

  function hideProgress() {
    document.getElementById('paProgress').style.display = 'none';
    document.getElementById('paProgressFill').style.animation = '';
  }

  /* ═══════════════════════════════════════════════
     LOAD HISTORY FROM SUPABASE (via backend)
     ═══════════════════════════════════════════════ */
  async function loadHistory() {
    try {
      const params = new URLSearchParams({
        filter: state.activeFilter,
        search: state.searchQuery,
        limit: String(state.perPage),
        offset: String((state.page - 1) * state.perPage),
      });

      const res = await fetch(`/api/pick-anomalies/history?${params}`);
      
      // Handle tables not created
      if (res.status === 503) {
        const data = await res.json();
        if (data.error === 'TABLES_NOT_CREATED') {
          setSyncStatus('error', '⚠️ Database tables not created yet');
          const tableBody = document.getElementById('paTableBody');
          if (tableBody) {
            tableBody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:40px">
              <div style="font-size:16px;font-weight:600;color:#b45309;margin-bottom:8px">⚠️ Setup Required</div>
              <div style="font-size:13px;color:#64748b;margin-bottom:12px">The Pick Anomalies tables have not been created in Supabase yet.</div>
              <div style="font-size:13px;color:#64748b">Go to <b>Supabase Dashboard → SQL Editor</b> and run the migration file:</div>
              <div style="font-size:12px;color:#3b82f6;margin-top:6px;font-family:monospace">features/pick-anomalies/pick-anomalies-migration.sql</div>
            </td></tr>`;
          }
          return;
        }
      }
      
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Load failed');

      state.orders = data.orders || [];
      state.totalOrders = data.total || state.orders.length;

      renderOrdersTable();
      renderPagination();

      // Footer
      document.getElementById('paFooter').style.display = '';
      document.getElementById('paFooterText').textContent =
        `Showing ${state.orders.length} of ${state.totalOrders} orders`;

    } catch (err) {
      console.error('History load error:', err);
      setSyncStatus('error', 'Failed to load history');
    }
  }

  /* ═══════════════════════════════════════════════
     FETCH SYNC STATUS (no Cin7 calls — just reads metadata)
     ═══════════════════════════════════════════════ */
  async function fetchSyncStatus() {
    try {
      const res = await fetch('/api/pick-anomalies/sync-status');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      if (data.lastSyncedAt) {
        const syncDate = new Date(data.lastSyncedAt);
        updateSyncAge(syncDate);

        // Build status message
        const parts = ['✅'];
        if (data.lastNewOrders > 0) {
          parts.push(`+${data.lastNewOrders} order${data.lastNewOrders > 1 ? 's' : ''} last sync`);
        } else {
          parts.push('Up to date');
        }
        parts.push(`· ${data.totalOrders} total`);
        setSyncStatus('success', parts.join(' '));
      } else {
        setSyncStatus('idle', 'No sync data yet');
      }

      if (data.syncing) {
        setSyncStatus('syncing', 'Backend sync running…');
      }
    } catch (err) {
      console.warn('Could not fetch sync status:', err);
    }
  }

  /* ═══════════════════════════════════════════════
     AUTO-SYNC — Fetch new orders in background
     ═══════════════════════════════════════════════ */
  async function syncNewOrders(silent = false) {
    if (state.syncing) return;
    state.syncing = true;
    if (!silent) {
      setSyncStatus('syncing', 'Syncing new orders...');
      showProgress('Fetching new orders from Cin7...');
    }

    try {
      const res = await fetch('/api/pick-anomalies/sync', { method: 'POST' });
      
      // Don't sync if tables don't exist
      if (res.status === 503) {
        state.syncing = false;
        hideProgress();
        return;
      }
      
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();

      if (data.syncing) {
        // Backend is already running a sync — just show status, don't alarm
        setSyncStatus('syncing', 'Backend sync running…');
        return;
      }

      if (!data.success) throw new Error(data.error || 'Sync failed');

      // Build sync message with datetime
      const now = new Date();
      const syncTime = now.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
      const msg = data.newOrders > 0
        ? `✅ Synced ${data.newOrders} new order${data.newOrders > 1 ? 's' : ''} · Last sync: ${syncTime} · ${data.elapsed}`
        : `✅ Up to date · Last sync: ${syncTime}`;
      setSyncStatus('success', msg);

      // Update "time ago" badge
      updateSyncAge(now);

      // Reload history + stats to show new data
      if (data.newOrders > 0) {
        await loadHistory();
        await loadStats();
      }

    } catch (err) {
      console.error('Sync error:', err);
      setSyncStatus('error', 'Sync failed: ' + err.message);
    } finally {
      state.syncing = false;
      hideProgress();
    }
  }

  /* ═══════════════════════════════════════════════
     SEARCH (debounce 400ms)
     ═══════════════════════════════════════════════ */
  function debounceSearch() {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchQuery = document.getElementById('paSearch').value.trim();
      state.page = 1; // Reset to page 1 on search
      loadHistory();
    }, 400);
  }

  /* ═══════════════════════════════════════════════
     ORDERS TABLE
     ═══════════════════════════════════════════════ */
  function renderOrdersTable() {
    const tbody = document.getElementById('paBody');
    const card = document.getElementById('paTableCard');
    card.style.display = '';

    if (!state.orders.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="pa-empty">No orders found.</td></tr>';
      return;
    }

    const offset = (state.page - 1) * state.perPage;

    tbody.innerHTML = state.orders.map((o, idx) => {
      const anom = o.anomaly_picks || 0;
      const correct = o.correct_picks || 0;
      const fg = o.fg_count || 0;
      const corrections = o.corrections || [];
      const isReviewed = !!o.reviewed;

      // Row background: reviewed/correct = green, anomaly pending = orange
      let rowClass = '';
      if (o.is_cancelled) rowClass = 'pa-row-cancelled';
      else if (isReviewed) rowClass = 'pa-row-reviewed';
      else if (anom > 0 && fg > 0) rowClass = 'pa-row-mixed';
      else if (anom > 0) rowClass = 'pa-row-anomaly';
      else if (fg > 0) rowClass = 'pa-row-fg';
      else rowClass = 'pa-row-correct';

      // SO Status column (Cin7 real status)
      const soStatus = esc(o.order_status || '—');
      const soClass = o.is_cancelled ? 'pa-so-cancelled'
        : soStatus.toUpperCase().includes('INVOICED') ? 'pa-so-invoiced'
        : soStatus.toUpperCase().includes('FULFILLED') ? 'pa-so-fulfilled'
        : soStatus.toUpperCase().includes('PACKED') ? 'pa-so-packed'
        : soStatus.toUpperCase().includes('SHIPPED') ? 'pa-so-shipped'
        : 'pa-so-other';

      // Anomaly Status column
      let statusHtml = '';
      if (o.is_cancelled && o.has_correction_conflict) {
        statusHtml = '<span class="pa-badge pa-badge-cancelled-conflict">🔴 Cancelled — Reversal needed</span>';
      } else if (o.is_cancelled) {
        statusHtml = '<span class="pa-badge pa-badge-cancelled">❌ Cancelled</span>';
      } else if (anom === 0) {
        statusHtml = '<span class="pa-badge pa-badge-correct">✅ OK</span>';
      } else if (corrections.length >= anom) {
        statusHtml = `<span class="pa-badge pa-badge-correct">✅ Fixed</span>`;
        // Show ALL TR refs
        const trRefs = corrections.map(c => c.transfer_ref).filter(Boolean);
        if (trRefs.length) {
          statusHtml += `<div class="pa-tr-ref" title="${trRefs.join(', ')}">${trRefs.join(', ')}</div>`;
        }
      } else if (corrections.length > 0) {
        statusHtml = `<span class="pa-badge pa-badge-anomaly">⚠️ ${corrections.length}/${anom} fixed</span>`;
        const trRefs = corrections.map(c => c.transfer_ref).filter(Boolean);
        if (trRefs.length) {
          statusHtml += `<div class="pa-tr-ref" title="${trRefs.join(', ')}">${trRefs.join(', ')}</div>`;
        }
      } else {
        statusHtml = `<span class="pa-badge pa-badge-anomaly">⚠️ ${anom} anomal${anom > 1 ? 'ies' : 'y'}</span>`;
      }

      // Reviewed column
      const reviewedHtml = isReviewed
        ? '<span class="pa-badge pa-badge-correct">✅ Reviewed</span>'
        : '<span class="pa-badge" style="opacity:0.5">—</span>';

      return `<tr class="${rowClass}" style="cursor:pointer">
        <td><input type="checkbox" class="pa-bulk-check" data-idx="${idx}" onclick="event.stopPropagation(); PA.toggleBulk(${idx}, this.checked)" ${state.selectedBulk.has(idx) ? 'checked' : ''} /></td>
        <td onclick="PA.openDetail(${idx})">${offset + idx + 1}</td>
        <td onclick="PA.openDetail(${idx})"><strong>${esc(o.order_number)}</strong></td>
        <td onclick="PA.openDetail(${idx})">${formatDate(o.order_date)}</td>
        <td onclick="PA.openDetail(${idx})">${formatDate(o.fulfilled_date)}</td>
        <td onclick="PA.openDetail(${idx})">${esc(o.customer)}</td>
        <td onclick="PA.openDetail(${idx})"><span class="pa-so-badge ${soClass}">${soStatus}</span></td>
        <td onclick="PA.openDetail(${idx})">${o.total_picks || 0}</td>
        <td onclick="PA.openDetail(${idx})">${correct}</td>
        <td onclick="PA.openDetail(${idx})">${anom || ''}</td>
        <td onclick="PA.openDetail(${idx})">${fg || ''}</td>
        <td onclick="PA.openDetail(${idx})">${statusHtml}</td>
        <td onclick="PA.openDetail(${idx})">${reviewedHtml}</td>
      </tr>`;
    }).join('');
  }

  /* ═══════════════════════════════════════════════
     PAGINATION
     ═══════════════════════════════════════════════ */
  function renderPagination() {
    const el = document.getElementById('paPagination');
    const totalPages = Math.max(1, Math.ceil(state.totalOrders / state.perPage));

    if (state.totalOrders <= state.perPage) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    document.getElementById('paPageInfo').textContent = `Page ${state.page} of ${totalPages}`;
    document.getElementById('paPrevBtn').disabled = state.page <= 1;
    document.getElementById('paNextBtn').disabled = state.page >= totalPages;
  }

  function nextPage() {
    const totalPages = Math.ceil(state.totalOrders / state.perPage);
    if (state.page < totalPages) {
      state.page++;
      loadHistory();
    }
  }

  function prevPage() {
    if (state.page > 1) {
      state.page--;
      loadHistory();
    }
  }

  /* ═══════════════════════════════════════════════
     FILTER CHIPS
     ═══════════════════════════════════════════════ */
  function setFilter(filter, btn) {
    state.activeFilter = filter;
    state.page = 1; // Reset to page 1 on filter change
    document.querySelectorAll('.pa-status-chips .chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    loadHistory();
  }

  /* ═══════════════════════════════════════════════
     ORDER DETAIL MODAL
     ═══════════════════════════════════════════════ */
  function openDetail(idx) {
    const order = state.orders[idx];
    if (!order) return;
    state.selectedOrder = order;
    state.selectedFixes.clear();
    state.activeTab = 'anomalies';
    state.stockData = null; // reset stock cache

    document.getElementById('paModalTitle').textContent = `Order ${order.order_number} — ${order.customer || ''}`;

    const picks = order.picks || [];
    const anomalies = picks.filter(p => p.status === 'anomaly').length;
    const correct = picks.filter(p => p.status === 'correct').length;
    const fgOrders = order.fg_orders || [];

    // Count FG component anomalies and correct
    let fgAnomalyCount = 0, fgCorrectCount = 0;
    for (const fg of fgOrders) {
      for (const c of (fg.components || [])) {
        if (c.status === 'anomaly') fgAnomalyCount++;
        else if (c.status === 'correct') fgCorrectCount++;
      }
    }

    document.getElementById('tabCountAnomalies').textContent = anomalies + fgAnomalyCount;
    document.getElementById('tabCountCorrect').textContent = correct + fgCorrectCount;

    // Review button state
    const reviewBtn = document.getElementById('paReviewBtn');
    if (reviewBtn) {
      if (order.reviewed) {
        reviewBtn.disabled = true;
        reviewBtn.innerHTML = '✅ Reviewed';
        reviewBtn.classList.add('pa-btn-reviewed');
      } else {
        reviewBtn.disabled = false;
        reviewBtn.innerHTML = '☑️ Mark Reviewed';
        reviewBtn.classList.remove('pa-btn-reviewed');
      }
    }

    // Calculate accuracy
    const totalItems = picks.length + fgAnomalyCount + fgCorrectCount;
    const totalAnom = anomalies + fgAnomalyCount;
    const totalCorrect = correct + fgCorrectCount;
    const accuracyPct = totalItems > 0 ? Math.round((totalCorrect / totalItems) * 100) : 100;
    const correctedCount = (order.corrections || []).length;
    const correctionPct = totalAnom > 0 ? Math.round((correctedCount / totalAnom) * 100) : 0;

    document.getElementById('paModalSummary').innerHTML =
      `${order.is_cancelled ? `<div class="pa-cancelled-banner">
        <div class="pa-cancelled-icon">❌</div>
        <div class="pa-cancelled-text">
          <strong>Order Cancelled</strong> — ${order.has_correction_conflict
            ? 'Corrections were applied before cancellation. Stock may be duplicated. <strong>Reversal recommended.</strong>'
            : 'No corrections applied — no action needed.'}
        </div>
        ${order.has_correction_conflict ? `<button class="pa-btn pa-btn-reverse" onclick="PA.reverseAllCorrections('${esc(order.order_number)}')">🔄 Reverse Corrections</button>` : ''}
      </div>` : ''}
      <div class="pa-summary-v2">
        <div class="pa-summary-accuracy">
          <div class="pa-accuracy-header">
            <span class="pa-accuracy-label">Pick Accuracy</span>
            <span class="pa-accuracy-pct ${accuracyPct >= 95 ? 'pa-acc-good' : accuracyPct >= 80 ? 'pa-acc-warn' : 'pa-acc-bad'}">${accuracyPct}%</span>
          </div>
          <div class="pa-accuracy-bar">
            <div class="pa-accuracy-fill pa-accuracy-correct" style="width:${accuracyPct}%"></div>
            <div class="pa-accuracy-fill pa-accuracy-anomaly" style="width:${100 - accuracyPct}%"></div>
          </div>
          <div class="pa-accuracy-legend">
            <span>✅ ${totalCorrect} correct</span>
            <span>⚠️ ${totalAnom} anomal${totalAnom === 1 ? 'y' : 'ies'}</span>
            ${fgOrders.length ? `<span>🔧 ${fgOrders.length} FG orders</span>` : ''}
            ${correctedCount > 0 ? `<span>🔄 ${correctedCount}/${totalAnom} corrected (${correctionPct}%)</span>` : ''}
          </div>
        </div>
        <div class="pa-summary-meta">
          <div class="pa-meta-chip"><span class="pa-meta-icon">📅</span>${formatDate(order.order_date)}</div>
          <div class="pa-meta-chip"><span class="pa-meta-icon">🚚</span>${order.fulfilled_date ? formatDate(order.fulfilled_date) : '—'}</div>
          <div class="pa-meta-chip"><span class="pa-so-badge ${order.is_cancelled ? 'pa-so-cancelled' : order.order_status === 'FULFILLED' ? 'pa-so-fulfilled' : 'pa-so-other'}">${esc(order.order_status || '—')}</span></div>
          <div class="pa-meta-chip"><span class="pa-meta-icon">🔍</span>${formatDate(order.analyzed_at)}</div>
        </div>
      </div>`;

    setTabVisibility();
    renderTabContent();

    document.getElementById('paDetailModal').classList.add('open');

    // Fetch stock data in background for anomaly cards
    _fetchStockForOrder(order);
  }

  function closeDetail() {
    document.getElementById('paDetailModal').classList.remove('open');
    state.selectedOrder = null;
    state.selectedFixes.clear();
  }

  function setTab(tab, btn) {
    state.activeTab = tab;
    document.querySelectorAll('.pa-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderTabContent();
    setTabVisibility();
  }

  function setTabVisibility() {
    // Batch actions bar always visible for Review button; Fix Selected only on anomalies tab
    document.getElementById('paBatchActions').style.display = '';
    const fixBtn = document.querySelector('#paBatchActions .search-btn-small[onclick*="fixSelected"]');
    const summarySpan = document.getElementById('paBatchSummary');
    if (fixBtn) fixBtn.style.display = state.activeTab === 'anomalies' ? '' : 'none';
    if (summarySpan) summarySpan.style.display = state.activeTab === 'anomalies' ? '' : 'none';
  }

  function renderTabContent() {
    const body = document.getElementById('paModalBody');
    const order = state.selectedOrder;
    if (!order) { body.innerHTML = ''; return; }
    switch (state.activeTab) {
      case 'anomalies': body.innerHTML = renderAnomaliesTab(order); break;
      case 'correct':   body.innerHTML = renderCorrectTab(order); break;
    }
    updateBatchSummary();
  }

  /* ─── Fetch stock snapshot for anomaly cards ─── */
  async function _fetchStockForOrder(order) {
    const picks = order.picks || [];
    const anomalies = picks.filter(p => p.status === 'anomaly');
    const fgAnomalies = [];
    for (const fg of (order.fg_orders || [])) {
      for (const c of (fg.components || [])) {
        if (c.status === 'anomaly') fgAnomalies.push(c);
      }
    }
    const allAnom = [...anomalies, ...fgAnomalies];
    if (!allAnom.length) return;

    const skuSet = new Set();
    const binSet = new Set();
    for (const a of allAnom) {
      if (a.sku) skuSet.add(a.sku);
      if (a.bin) binSet.add(a.bin);
      if (a.expectedBin) binSet.add(a.expectedBin);
    }

    try {
      const params = new URLSearchParams({
        skus: [...skuSet].join(','),
        bins: [...binSet].join(','),
      });
      const res = await fetch(`/api/pick-anomalies/stock-check?${params}`);
      const data = await res.json();
      if (data.success) {
        state.stockData = { stock: data.stock || {}, syncedAt: data.syncedAt };
        // Re-render anomalies tab with stock data
        if (state.activeTab === 'anomalies') {
          document.getElementById('paModalBody').innerHTML = renderAnomaliesTab(order);
          updateBatchSummary();
        }
      }
    } catch (err) {
      console.warn('Stock check failed:', err);
    }
  }

  /* ═══════════════════════════════════════════════
     TAB RENDERERS
     ═══════════════════════════════════════════════ */

  function getCorrection(order, pickId) {
    return (order.corrections || []).find(c => c.pick_id === pickId);
  }

  /* Build stock-snapshot info block for an anomaly card */
  function _stockInfoHtml(sku, expectedBin, pickedBin, qty) {
    if (!state.stockData || !state.stockData.stock) {
      return '<div class="pa-stock-info pa-stock-loading">⏳ Loading stock data…</div>';
    }
    const sd = state.stockData.stock;
    const fromKey = `${sku}|${expectedBin}`;
    const toKey   = `${sku}|${pickedBin}`;
    const fromStock = sd[fromKey];
    const toStock   = sd[toKey];

    const fmtNum = n => (n != null ? n : '—');
    const syncLabel = state.stockData.syncedAt
      ? `Synced: ${new Date(state.stockData.syncedAt).toLocaleString('en-AU', { hour12: false, day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })}`
      : '';

    let warnings = '';
    if (fromStock && fromStock.available != null && fromStock.available < qty) {
      warnings += `<div class="pa-stock-warn pa-stock-warn-red">⚠️ FROM only has ${fromStock.available} avail (need ${qty})</div>`;
    }
    if (toStock && toStock.on_hand != null && toStock.on_hand === 0) {
      warnings += `<div class="pa-stock-warn pa-stock-warn-amber">⚠️ TO bin empty — may have been moved</div>`;
    }

    return `<div class="pa-stock-info pa-stock-snapshot">
      <div class="pa-stock-title">📦 Stock Snapshot ${syncLabel ? `<span class="pa-stock-sync-label">${syncLabel}</span>` : ''}</div>
      <div class="pa-stock-row">
        <div class="pa-stock-col">
          <div class="pa-stock-bin-label pa-stock-from">FROM: ${esc(expectedBin)}</div>
          ${fromStock
            ? `<div class="pa-stock-numbers">OH: <strong>${fmtNum(fromStock.on_hand)}</strong> · Alloc: <strong>${fmtNum(fromStock.allocated)}</strong> · Avail: <strong>${fmtNum(fromStock.available)}</strong></div>`
            : `<div class="pa-stock-empty">No stock data</div>`}
        </div>
        <div class="pa-stock-col">
          <div class="pa-stock-bin-label pa-stock-to">TO: ${esc(pickedBin)}</div>
          ${toStock
            ? `<div class="pa-stock-numbers">OH: <strong>${fmtNum(toStock.on_hand)}</strong> · Alloc: <strong>${fmtNum(toStock.allocated)}</strong> · Avail: <strong>${fmtNum(toStock.available)}</strong></div>`
            : `<div class="pa-stock-empty">No stock data</div>`}
        </div>
      </div>
      ${warnings}
    </div>`;
  }

  function renderAnomaliesTab(order) {
    const anomalies = (order.picks || []).filter(p => p.status === 'anomaly');

    // Collect FG component anomalies too
    const fgAnomalies = [];
    for (const fg of (order.fg_orders || [])) {
      for (let ci = 0; ci < (fg.components || []).length; ci++) {
        const comp = fg.components[ci];
        if (comp.status === 'anomaly') {
          fgAnomalies.push({ ...comp, _fgTaskId: fg.taskId, _fgIdx: ci, _fgLabel: fg.assemblyNumber || fg.taskId, _fgProduct: fg.productCode });
        }
      }
    }

    if (!anomalies.length && !fgAnomalies.length) return '<div class="pa-empty">No anomalies found — all picks are correct! 🎉</div>';

    // Count uncorrected items (picks + FG)
    const uncorrectedPicks = anomalies.filter(pick => {
      const pickId = pick.id || `${order.order_number}_pick_0`;
      return !getCorrection(order, pickId);
    });
    const uncorrectedFg = fgAnomalies.filter(comp => {
      const pickId = `fg_${comp._fgTaskId}_${comp._fgIdx}`;
      return !getCorrection(order, pickId);
    });
    const totalUncorrected = uncorrectedPicks.length + uncorrectedFg.length;

    let html = '';

    if (totalUncorrected > 0) {
      html += `<div class="pa-select-all">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:700">
          <input type="checkbox" onchange="PA.toggleSelectAll(this.checked)" /> Select All Unfixed (${totalUncorrected})
        </label>
      </div>`;
    }

    // Render pick anomalies
    html += anomalies.map((pick, idx) => {
      const err = classifyError(pick.bin, pick.expectedBin);
      const pickId = pick.id || `${order.order_number}_pick_${idx}`;
      const correction = getCorrection(order, pickId);

      return _renderAnomalyCardV2(pick, err, pickId, correction, order);
    }).join('');

    // Render FG component anomalies
    if (fgAnomalies.length) {
      html += `<div style="margin:16px 0 8px;font-weight:700;font-size:14px;color:#7c3aed">🔧 FG/Assembly Component Anomalies</div>`;
      html += fgAnomalies.map(comp => {
        const err = classifyError(comp.bin, comp.expectedBin);
        const pickId = `fg_${comp._fgTaskId}_${comp._fgIdx}`;
        const correction = getCorrection(order, pickId);

        return _renderAnomalyCardV2(comp, err, pickId, correction, order, true);
      }).join('');
    }

    return html;
  }

  /* ─── Redesigned Anomaly Card V2 ─── */
  function _renderAnomalyCardV2(pick, err, pickId, correction, order, isFg) {
    const sevColors = { low: '#f59e0b', medium: '#f97316', high: '#dc2626', info: '#6366f1' };
    const sevLabels = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', info: 'INFO' };
    const borderColor = correction ? '#86efac' : (sevColors[err.severity] || '#e2e8f0');

    return `
      <div class="pa-card-v2 ${correction ? 'pa-card-v2-corrected' : ''}" id="card-${pickId}" style="border-left:4px solid ${borderColor}">
        <div class="pa-card-v2-top">
          <div class="pa-card-v2-left">
            ${!correction ? `<input type="checkbox" class="pa-fix-check" data-pick-id="${pickId}" onchange="PA.toggleFix('${pickId}', this.checked)" />` : ''}
            <div class="pa-card-v2-sku">
              <strong>${esc(pick.sku)}</strong>
              ${_repeatSkus.has(pick.sku) ? '<span class="pa-repeat-badge" title="Repeat offender SKU (3+ anomalies)">🔁 Repeat</span>' : ''}
              ${isFg ? `<span class="pa-fg-badge">FG: ${esc(pick._fgLabel)}</span>` : ''}
            </div>
            <span class="pa-card-v2-qty">× ${pick.qty}</span>
            <span class="pa-card-v2-name">${esc(pick.name || '')}</span>
          </div>
          <div class="pa-card-v2-severity pa-sev-${err.severity}" title="${esc(err.label)}" style="background:${sevColors[err.severity] || '#94a3b8'}">
            ${sevLabels[err.severity] || '?'}
          </div>
        </div>

        <div class="pa-card-v2-body">
          <div class="pa-card-v2-flow">
            <div class="pa-flow-box pa-flow-wrong">
              <div class="pa-flow-label">❌ PICKED FROM</div>
              <div class="pa-flow-bin">${esc(pick.bin)}</div>
            </div>
            <div class="pa-flow-arrow">→</div>
            <div class="pa-flow-box pa-flow-expected">
              <div class="pa-flow-label">✅ SHOULD BE</div>
              <div class="pa-flow-bin">${esc(pick.expectedBin)}</div>
            </div>
            <div class="pa-flow-type">
              <div class="pa-flow-type-label">Error</div>
              <div class="pa-flow-type-value">${esc(err.label)}</div>
            </div>
          </div>

          ${state.stockData ? _stockInfoCompactHtml(pick.sku, pick.expectedBin, pick.bin, pick.qty) : '<div class="pa-stock-info pa-stock-loading">⏳ Loading stock…</div>'}

          ${correction ? `
            <div class="pa-correction-v2">
              <div class="pa-correction-v2-badge">✅ ${correction.transfer_status === 'COMPLETED' ? 'Transfer Completed' : 'Transfer Created'}</div>
              <div class="pa-correction-v2-detail">
                ${esc(correction.from_bin)} → ${esc(correction.to_bin)} · <strong>${correction.qty} units</strong>
                ${correction.transfer_ref ? ` · Ref: <code>${esc(correction.transfer_ref)}</code>` : ''}
                ${correction.corrected_at ? ` · ${formatDate(correction.corrected_at)}` : ''}
              </div>
            </div>
          ` : `
            <div class="pa-fix-v2">
              <span class="pa-fix-v2-label">🔧 Fix:</span>
              <span class="pa-fix-v2-detail">Move ${pick.qty} × <strong>${esc(pick.sku)}</strong> from <code>${esc(pick.expectedBin)}</code> → <code>${esc(pick.bin)}</code></span>
            </div>
          `}
        </div>
      </div>`;
  }

  /* ─── Compact stock info for V2 cards ─── */
  function _stockInfoCompactHtml(sku, expectedBin, pickedBin, qty) {
    if (!state.stockData || !state.stockData.stock) return '';
    const sd = state.stockData.stock;
    const fromKey = `${sku}|${expectedBin}`;
    const toKey   = `${sku}|${pickedBin}`;
    const fromStock = sd[fromKey];
    const toStock   = sd[toKey];
    const fmtNum = n => (n != null ? n : '—');

    let warnings = '';
    if (fromStock && fromStock.available != null && fromStock.available < qty) {
      warnings += `<span class="pa-stock-flag pa-stock-flag-red">⚠ FROM only ${fromStock.available} avail</span>`;
    }
    if (toStock && toStock.on_hand != null && toStock.on_hand === 0) {
      warnings += `<span class="pa-stock-flag pa-stock-flag-amber">⚠ TO bin empty</span>`;
    }

    return `<div class="pa-stock-compact">
      <span class="pa-stock-chip" title="FROM: ${esc(expectedBin)}">📦 FROM: OH ${fmtNum(fromStock?.on_hand)} · Avail ${fmtNum(fromStock?.available)}</span>
      <span class="pa-stock-chip" title="TO: ${esc(pickedBin)}">📦 TO: OH ${fmtNum(toStock?.on_hand)} · Avail ${fmtNum(toStock?.available)}</span>
      ${warnings}
    </div>`;
  }

  /* ═══════════════════════════════════════════════
     PRINT REPORT
     ═══════════════════════════════════════════════ */
  function printReport() {
    const order = state.selectedOrder;
    if (!order) return;

    const picks = order.picks || [];
    const anomalies = picks.filter(p => p.status === 'anomaly');
    const correct = picks.filter(p => p.status === 'correct');
    const fgOrders = order.fg_orders || [];
    let fgAnomalyCount = 0, fgCorrectCount = 0;
    for (const fg of fgOrders) {
      for (const c of (fg.components || [])) {
        if (c.status === 'anomaly') fgAnomalyCount++;
        else if (c.status === 'correct') fgCorrectCount++;
      }
    }
    const totalItems = picks.length + fgAnomalyCount + fgCorrectCount;
    const totalAnom = anomalies.length + fgAnomalyCount;
    const totalCorrect = correct.length + fgCorrectCount;
    const accuracyPct = totalItems > 0 ? Math.round((totalCorrect / totalItems) * 100) : 100;
    const correctedCount = (order.corrections || []).length;

    // FG anomalies for report
    const fgAnomalies = [];
    for (const fg of fgOrders) {
      for (let ci = 0; ci < (fg.components || []).length; ci++) {
        const comp = fg.components[ci];
        if (comp.status === 'anomaly') {
          fgAnomalies.push({ ...comp, _fgLabel: fg.assemblyNumber || fg.taskId });
        }
      }
    }
    const allAnomalies = [...anomalies, ...fgAnomalies];

    // Group by error type
    const byType = {};
    for (const a of allAnomalies) {
      const err = classifyError(a.bin, a.expectedBin);
      if (!byType[err.label]) byType[err.label] = [];
      byType[err.label].push(a);
    }

    const now = new Date();
    const printDate = now.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' }) + ' ' +
                      now.toLocaleTimeString('en-AU', { hour12:false, hour:'2-digit', minute:'2-digit' });

    let reportHtml = `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Pick Anomaly Report — Order ${esc(order.order_number)}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:12px; color:#1e293b; padding:30px; }
        .report-header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #1e293b; padding-bottom:16px; margin-bottom:20px; }
        .report-title { font-size:22px; font-weight:800; }
        .report-subtitle { font-size:13px; color:#64748b; margin-top:4px; }
        .report-logo { text-align:right; font-size:11px; color:#94a3b8; }
        .report-meta { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px 18px; margin-bottom:20px; }
        .meta-item label { font-size:10px; font-weight:700; text-transform:uppercase; color:#64748b; letter-spacing:.5px; }
        .meta-item .val { font-size:14px; font-weight:600; }
        .accuracy-section { display:flex; align-items:center; gap:24px; margin-bottom:20px; padding:14px 18px; border-radius:8px; border:1px solid #e2e8f0; }
        .accuracy-bar-wrap { flex:1; height:14px; background:#e2e8f0; border-radius:7px; overflow:hidden; }
        .accuracy-bar { height:100%; border-radius:7px; }
        .accuracy-correct { background:#22c55e; }
        .accuracy-stats { display:flex; gap:16px; font-size:12px; font-weight:600; }
        .section-title { font-size:16px; font-weight:800; margin:24px 0 10px; border-bottom:2px solid #e2e8f0; padding-bottom:6px; }
        table { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:16px; }
        th { background:#f1f5f9; text-align:left; padding:8px 10px; font-weight:700; font-size:10px; text-transform:uppercase; letter-spacing:.5px; border-bottom:2px solid #cbd5e1; }
        td { padding:7px 10px; border-bottom:1px solid #e2e8f0; vertical-align:top; }
        tr:nth-child(even) { background:#fafbfc; }
        .bin-code { font-family:'Courier New',monospace; font-weight:700; font-size:12px; padding:2px 6px; border-radius:4px; }
        .bin-wrong { background:#fef2f2; color:#dc2626; }
        .bin-ok { background:#f0fdf4; color:#16a34a; }
        .sev-badge { display:inline-block; padding:2px 8px; border-radius:4px; font-weight:700; font-size:10px; text-transform:uppercase; color:#fff; }
        .sev-low { background:#f59e0b; } .sev-medium { background:#f97316; } .sev-high { background:#dc2626; } .sev-info { background:#6366f1; }
        .status-ok { color:#16a34a; font-weight:700; } .status-pending { color:#f59e0b; font-weight:700; }
        .summary-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px 18px; margin-top:16px; }
        .summary-box h4 { font-size:13px; margin-bottom:8px; }
        .error-summary-row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #f1f5f9; }
        .footer { margin-top:30px; border-top:2px solid #e2e8f0; padding-top:10px; font-size:10px; color:#94a3b8; text-align:center; }
        @media print { body { padding:15px; } .no-print { display:none; } }
      </style>
    </head><body>
      <div class="report-header">
        <div>
          <div class="report-title">🔍 Pick Anomaly Report</div>
          <div class="report-subtitle">Order ${esc(order.order_number)} — ${esc(order.customer || 'Unknown Customer')}</div>
        </div>
        <div class="report-logo">
          Rapid Labels Warehouse<br>
          Generated: ${printDate}
        </div>
      </div>

      <div class="report-meta">
        <div class="meta-item"><label>Order Date</label><div class="val">${formatDate(order.order_date)}</div></div>
        <div class="meta-item"><label>Shipped</label><div class="val">${order.fulfilled_date ? formatDate(order.fulfilled_date) : '—'}</div></div>
        <div class="meta-item"><label>SO Status</label><div class="val">${esc(order.order_status || '—')}</div></div>
        <div class="meta-item"><label>Analyzed</label><div class="val">${formatDate(order.analyzed_at)}</div></div>
      </div>

      <div class="accuracy-section">
        <div style="min-width:100px">
          <div style="font-size:28px;font-weight:800">${accuracyPct}%</div>
          <div style="font-size:11px;color:#64748b;font-weight:600">Accuracy</div>
        </div>
        <div class="accuracy-bar-wrap"><div class="accuracy-bar accuracy-correct" style="width:${accuracyPct}%"></div></div>
        <div class="accuracy-stats">
          <span>✅ ${totalCorrect}</span>
          <span>⚠️ ${totalAnom}</span>
          <span>🔄 ${correctedCount} fixed</span>
        </div>
      </div>

      <div class="section-title">⚠️ Anomaly Details (${totalAnom})</div>
      <table>
        <thead><tr><th>#</th><th>SKU</th><th>Product</th><th>Qty</th><th>Picked From</th><th>Should Be</th><th>Error Type</th><th>Severity</th><th>Corrected?</th></tr></thead>
        <tbody>
          ${allAnomalies.map((a, i) => {
            const err = classifyError(a.bin, a.expectedBin);
            const pickId = a._fgTaskId ? `fg_${a._fgTaskId}_${a._fgIdx}` : (a.id || `${order.order_number}_pick_${i}`);
            const correction = getCorrection(order, pickId);
            return `<tr>
              <td>${i + 1}</td>
              <td><strong>${esc(a.sku)}</strong>${a._fgLabel ? ` <span style="color:#7c3aed;font-size:10px">(FG)</span>` : ''}</td>
              <td>${esc(a.name || '')}</td>
              <td>${a.qty}</td>
              <td><span class="bin-code bin-wrong">${esc(a.bin)}</span></td>
              <td><span class="bin-code bin-ok">${esc(a.expectedBin)}</span></td>
              <td>${esc(err.label)}</td>
              <td><span class="sev-badge sev-${err.severity}">${err.severity}</span></td>
              <td>${correction ? '<span class="status-ok">✅ Yes</span>' : '<span class="status-pending">⏳ Pending</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div class="summary-box">
        <h4>📊 Error Type Breakdown</h4>
        ${Object.entries(byType).map(([label, items]) => `
          <div class="error-summary-row">
            <span>${esc(label)}</span>
            <span><strong>${items.length}</strong> (${Math.round(items.length / totalAnom * 100)}%)</span>
          </div>
        `).join('')}
      </div>

      ${correctedCount > 0 ? `
        <div class="section-title">🔄 Corrections Applied (${correctedCount})</div>
        <table>
          <thead><tr><th>SKU</th><th>From Bin</th><th>To Bin</th><th>Qty</th><th>Transfer Ref</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${(order.corrections || []).map(c => `<tr>
              <td><strong>${esc(c.sku || '—')}</strong></td>
              <td><span class="bin-code">${esc(c.from_bin)}</span></td>
              <td><span class="bin-code">${esc(c.to_bin)}</span></td>
              <td>${c.qty}</td>
              <td>${esc(c.transfer_ref || '—')}</td>
              <td><span class="status-ok">${esc(c.transfer_status || 'DRAFT')}</span></td>
              <td>${formatDate(c.corrected_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      ` : ''}

      <div class="footer">
        Rapid Labels Warehouse — Pick Anomaly Report · Generated by Pick Anomalies System · ${printDate}
      </div>
    </body></html>`;

    // Open print window
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    printWindow.document.write(reportHtml);
    printWindow.document.close();
    printWindow.onload = () => { printWindow.print(); };
  }

  function renderCorrectTab(order) {
    const correct = (order.picks || []).filter(p => p.status === 'correct');

    // Collect FG components that are correct
    const fgCorrect = [];
    for (const fg of (order.fg_orders || [])) {
      for (const c of (fg.components || [])) {
        if (c.status === 'correct') {
          fgCorrect.push({ ...c, _fgLabel: fg.assemblyNumber || fg.taskId });
        }
      }
    }

    if (!correct.length && !fgCorrect.length) return '<div class="pa-empty">No correct picks in this order.</div>';

    let html = '';

    if (correct.length) {
      html += `<table class="app-table" style="font-size:13px">
        <thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Bin</th><th>Expected</th></tr></thead>
        <tbody>
          ${correct.map(p => `<tr>
            <td><strong>${esc(p.sku)}</strong></td>
            <td>${esc(p.name || '')}</td>
            <td>${p.qty}</td>
            <td><code>${esc(p.bin || '—')}</code></td>
            <td><code>${esc(p.expectedBin || '—')}</code></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    }

    if (fgCorrect.length) {
      html += `<div style="margin:16px 0 8px;font-weight:700;font-size:14px;color:#7c3aed">🔧 FG Components (correct)</div>`;
      html += `<table class="app-table" style="font-size:13px">
        <thead><tr><th>SKU</th><th>FG Order</th><th>Qty</th><th>Bin</th><th>Expected</th></tr></thead>
        <tbody>
          ${fgCorrect.map(c => `<tr>
            <td><strong>${esc(c.sku)}</strong></td>
            <td style="color:#7c3aed">${esc(c._fgLabel)}</td>
            <td>${c.qty}</td>
            <td><code>${esc(c.bin || '—')}</code></td>
            <td><code>${esc(c.expectedBin || '—')}</code></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
    }

    return html;
  }

  /* ═══════════════════════════════════════════════
     BATCH SELECTION
     ═══════════════════════════════════════════════ */
  function toggleFix(pickId, checked) {
    if (checked) state.selectedFixes.add(pickId);
    else state.selectedFixes.delete(pickId);
    updateBatchSummary();
  }

  function toggleSelectAll(checked) {
    document.querySelectorAll('.pa-fix-check').forEach(cb => {
      cb.checked = checked;
      const id = cb.dataset.pickId;
      if (checked) state.selectedFixes.add(id);
      else state.selectedFixes.delete(id);
    });
    updateBatchSummary();
  }

  function updateBatchSummary() {
    document.getElementById('paBatchSummary').textContent = `${state.selectedFixes.size} selected`;
    document.getElementById('paBatchActions').style.display = state.activeTab === 'anomalies' ? '' : 'none';
  }

  /* ═══════════════════════════════════════════════
     ACCEPT / SKIP — REMOVED (simplified UI)
     ═══════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════
     FIX / CORRECTION ACTIONS
     ═══════════════════════════════════════════════ */

  function findPickData(pickId) {
    for (const o of state.orders) {
      // Check regular picks
      const pick = (o.picks || []).find(p => p.id === pickId);
      if (pick) return { order: o, pick };

      // Check FG component picks (id format: fg_{taskId}_{compIdx})
      if (pickId.startsWith('fg_')) {
        for (const fg of (o.fg_orders || [])) {
          for (let i = 0; i < (fg.components || []).length; i++) {
            const compId = `fg_${fg.taskId}_${i}`;
            if (compId === pickId) return { order: o, pick: fg.components[i] };
          }
        }
      }
    }
    return null;
  }

  async function fixSelected() {
    if (state.selectedFixes.size === 0) return;
    const count = state.selectedFixes.size;

    // Build summary of what will be transferred
    const ids = [...state.selectedFixes];
    const items = ids.map(id => {
      const found = findPickData(id);
      if (!found) return null;
      const { order, pick } = found;
      return {
        productId: pick.productId,
        sku: pick.sku,
        productName: pick.name || pick.sku,
        qty: pick.qty || 1,
        expectedBin: pick.expectedBin,
        pickedBin: pick.bin,
        orderNumber: order.order_number,
        pickId: id,
      };
    }).filter(Boolean);

    // Show loading while checking for duplicates
    document.getElementById('paConfirmBody').innerHTML = '<div style="text-align:center;padding:20px">⏳ Checking for recent transfers…</div>';
    document.getElementById('paConfirmModal').classList.add('open');

    // Check for recent duplicate transfers (parallel)
    let duplicateWarnings = '';
    try {
      const dupChecks = await Promise.all(items.map(async t => {
        const params = new URLSearchParams({ sku: t.sku, fromBin: t.expectedBin, toBin: t.pickedBin });
        const res = await fetch(`/api/pick-anomalies/recent-transfers?${params}`);
        const data = await res.json();
        if (data.success && data.recentTransfers && data.recentTransfers.length > 0) {
          return { item: t, transfers: data.recentTransfers };
        }
        return null;
      }));
      const dups = dupChecks.filter(Boolean);
      if (dups.length > 0) {
        duplicateWarnings = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;margin-bottom:10px">
          <div style="font-weight:700;color:#92400e;margin-bottom:6px">⚠️ Recent Transfers Detected</div>
          ${dups.map(d => {
            const latest = d.transfers[0];
            const ago = _timeAgo(latest.corrected_at);
            return `<div style="padding:3px 0;font-size:12px;color:#78350f">
              <strong>${esc(d.item.sku)}</strong> (${esc(d.item.expectedBin)} → ${esc(d.item.pickedBin)}) — last transfer ${ago}
            </div>`;
          }).join('')}
          <div style="font-size:11px;color:#92400e;margin-top:4px">These items already had a correction transfer recently. Creating another may cause phantom stock.</div>
        </div>`;
      }
    } catch (err) {
      console.warn('Duplicate check failed:', err);
    }

    // Stock warnings
    let stockWarnings = '';
    if (state.stockData && state.stockData.stock) {
      const sd = state.stockData.stock;
      const warns = [];
      for (const t of items) {
        const fromKey = `${t.sku}|${t.expectedBin}`;
        const fromStock = sd[fromKey];
        if (fromStock && fromStock.available != null && fromStock.available < t.qty) {
          warns.push(`<div style="padding:3px 0;font-size:12px;color:#991b1b">
            <strong>${esc(t.sku)}</strong> — FROM bin <strong>${esc(t.expectedBin)}</strong> has only ${fromStock.available} available (need ${t.qty})
          </div>`);
        }
      }
      if (warns.length) {
        stockWarnings = `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 12px;margin-bottom:10px">
          <div style="font-weight:700;color:#991b1b;margin-bottom:6px">⚠️ Insufficient Stock Warning</div>
          ${warns.join('')}
          <div style="font-size:11px;color:#991b1b;margin-top:4px">Transfer FROM bin may not have enough stock. Stock may have already been restocked by drivers.</div>
        </div>`;
      }
    }

    const summaryLines = items.map(t =>
      `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9">
        <strong>${esc(t.sku)}</strong> ×${t.qty} — ${esc(t.expectedBin)} → ${esc(t.pickedBin)}
      </div>`
    ).join('');

    document.getElementById('paConfirmBody').innerHTML =
      `${duplicateWarnings}${stockWarnings}
      <div style="margin-bottom:10px">Create <strong>${count}</strong> Stock Transfer${count > 1 ? 's' : ''} (COMPLETED) in Cin7:</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;font-size:13px">${summaryLines}</div>
      <div style="margin-top:10px;font-size:12px;color:#64748b">Transfers will be created and completed automatically.</div>`;
  }

  function _timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}min ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  async function confirmFix() {
    const ids = [...state.selectedFixes];
    if (ids.length === 0) return;

    const items = ids.map(id => {
      const found = findPickData(id);
      if (!found) return null;
      const { order, pick } = found;
      return {
        productId: pick.productId,
        sku: pick.sku,
        productName: pick.name || pick.sku,
        qty: pick.qty || 1,
        expectedBin: pick.expectedBin,
        pickedBin: pick.bin,
        orderNumber: order.order_number,
        pickId: id,
      };
    }).filter(Boolean);

    if (items.length === 0) {
      alert('No valid picks to fix.');
      document.getElementById('paConfirmModal').classList.remove('open');
      return;
    }

    const confirmBtn = document.querySelector('#paConfirmModal .pa-confirm-btn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = '⏳ Creating transfers...'; }

    try {
      const res = await fetch('/api/pick-anomalies/batch-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Batch transfer failed');

      const results = data.results || [];

      // Show detailed results with TR numbers
      const resultLines = results.map(r => {
        if (r.success) {
          const tr = r.transfer || {};
          return `<div style="padding:6px 0;border-bottom:1px solid #dcfce7;color:#166534">
            ✅ <strong>${esc(r.sku)}</strong> — Transfer <strong>${esc(tr.transferId || '—')}</strong>
            ${tr.transferRef ? `(${esc(tr.transferRef)})` : ''} — ${esc(tr.transferStatus || 'COMPLETED')}
          </div>`;
        } else {
          return `<div style="padding:6px 0;border-bottom:1px solid #fecaca;color:#991b1b">
            ❌ <strong>${esc(r.sku)}</strong> — ${esc(r.error)}
          </div>`;
        }
      }).join('');

      document.getElementById('paConfirmModal').classList.remove('open');

      // Show results in a results modal (reuse confirm modal)
      const okCount = results.filter(r => r.success).length;
      document.getElementById('paConfirmBody').innerHTML =
        `<div style="margin-bottom:10px;font-size:15px;font-weight:700">${okCount} of ${results.length} transfers created</div>
        <div style="max-height:300px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;font-size:13px">${resultLines}</div>`;
      document.querySelector('#paConfirmModal .pa-confirm-btn').style.display = 'none';
      document.querySelector('#paConfirmModal .secondary').textContent = 'Close';
      document.getElementById('paConfirmModal').classList.add('open');

      // Mark fixed items in UI
      for (const r of results) {
        if (r.success) {
          const tr = r.transfer || {};
          const card = document.getElementById(`card-${r.pickId}`);
          if (card) {
            card.classList.add('pa-card-corrected');
            // Remove checkbox
            const cb = card.querySelector('.pa-fix-check');
            if (cb) cb.parentElement.removeChild(cb);
            // Add correction info
            const detail = card.querySelector('.pa-fix-preview');
            if (detail) {
              detail.outerHTML = `
                <div class="pa-correction-status">
                  <div class="pa-correction-title">✅ Transfer Completed</div>
                  <div class="pa-correction-detail">
                    <div>Transfer ID: <strong>${esc(tr.transferId || '')}</strong></div>
                    <div>Ref: <strong>${esc(tr.transferRef || '')}</strong></div>
                    <div>Status: <strong>${esc(tr.transferStatus || 'COMPLETED')}</strong></div>
                  </div>
                </div>`;
            }
          }

          // Add correction to local state
          const found = findPickData(r.pickId);
          if (found) {
            const { order } = found;
            if (!order.corrections) order.corrections = [];
            order.corrections.push({
              pick_id: r.pickId,
              sku: r.sku,
              from_bin: tr.expectedBin,
              to_bin: tr.pickedBin,
              qty: 1,
              transfer_id: tr.transferId,
              transfer_ref: tr.transferRef,
              transfer_status: tr.transferStatus,
              corrected_at: new Date().toISOString(),
            });
          }
        }
      }

      state.selectedFixes.clear();
      updateBatchSummary();
      renderOrdersTable();
      // Reload stats to refresh KPIs after corrections
      loadStats();

    } catch (err) {
      console.error('Batch fix error:', err);
      alert('Batch fix error: ' + err.message);
      // Reset confirm button only on error
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm'; }
    }
  }

  /** Reset the confirm modal back to its default state (called when closing) */
  function _resetConfirmModal() {
    document.getElementById('paConfirmModal').classList.remove('open');
    const cfBtn = document.querySelector('#paConfirmModal .pa-confirm-btn');
    if (cfBtn) { cfBtn.style.display = ''; cfBtn.disabled = false; cfBtn.textContent = 'Confirm'; }
    const secBtn = document.querySelector('#paConfirmModal .secondary');
    if (secBtn) secBtn.textContent = 'Cancel';
  }

  /* ═══════════════════════════════════════════════
     REVIEW ORDER — Mark as reviewed by operator
     ═══════════════════════════════════════════════ */
  async function reviewOrder() {
    const order = state.selectedOrder;
    if (!order) return;

    // Optimistic update — update UI immediately
    const reviewBtn = document.getElementById('paReviewBtn');
    if (reviewBtn) {
      reviewBtn.disabled = true;
      reviewBtn.innerHTML = '⏳ Saving...';
    }

    try {
      const res = await fetch('/api/pick-anomalies/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderNumber: order.order_number }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Update local state
      order.reviewed = true;
      order.reviewed_at = new Date().toISOString();

      // Update modal button — confirmed
      if (reviewBtn) {
        reviewBtn.innerHTML = '✅ Reviewed';
        reviewBtn.classList.add('pa-btn-reviewed');
      }

      // Refresh table + KPIs
      renderOrdersTable();
      loadStats();
    } catch (err) {
      console.error('Review error:', err);
      // Revert button on error
      if (reviewBtn) {
        reviewBtn.disabled = false;
        reviewBtn.innerHTML = '☑️ Mark Reviewed';
        reviewBtn.classList.remove('pa-btn-reviewed');
      }
      alert('Error marking as reviewed: ' + err.message);
    }
  }

  /* ═══════════════════════════════════════════════
     VIEW TOGGLE — Orders vs Analytics
     ═══════════════════════════════════════════════ */
  function setView(view, btn) {
    document.querySelectorAll('.pa-view-toggle .chip').forEach(c => c.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const ordersEls = ['paTableCard', 'paPagination', 'paFooter'];
    const analyticsEl = document.getElementById('paAnalytics');
    const statusChips = document.getElementById('paStatusChips');
    const searchGroup = document.querySelector('.pa-search-group');

    if (view === 'analytics') {
      ordersEls.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      analyticsEl.style.display = '';
      if (statusChips) statusChips.style.display = 'none';
      if (searchGroup) searchGroup.style.display = 'none';
      loadAnalytics();
    } else {
      ordersEls.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
      analyticsEl.style.display = 'none';
      if (statusChips) statusChips.style.display = '';
      if (searchGroup) searchGroup.style.display = '';
    }
  }

  /* ═══════════════════════════════════════════════
     ANALYTICS DASHBOARD
     ═══════════════════════════════════════════════ */
  let _analyticsCache = null;
  let _repeatSkus = new Set(); // SKUs with 3+ anomalies across all orders

  async function loadAnalytics() {
    if (_analyticsCache) {
      renderAnalytics(_analyticsCache);
      return;
    }
    document.getElementById('paAnalyticsLoading').style.display = '';
    try {
      const res = await fetch('/api/pick-anomalies/analytics');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      _analyticsCache = data.analytics;
      // Cache repeat offenders for badges in order detail
      for (const s of (data.analytics.topSkus || [])) {
        if (s.count >= 3) _repeatSkus.add(s.sku);
      }
      renderAnalytics(_analyticsCache);
    } catch (err) {
      console.error('Analytics load error:', err);
      document.getElementById('paAnalyticsLoading').textContent = '❌ Failed to load analytics: ' + err.message;
    }
  }

  function renderAnalytics(a) {
    document.getElementById('paAnalyticsLoading').style.display = 'none';

    // ── Summary cards ──
    const s = a.summary;
    document.getElementById('paAnalyticsSummary').innerHTML = `
      <div class="pa-asummary-cards">
        <div class="pa-acard pa-acard-blue">
          <div class="pa-acard-val">${s.totalOrders}</div>
          <div class="pa-acard-label">Orders Analyzed</div>
        </div>
        <div class="pa-acard pa-acard-purple">
          <div class="pa-acard-val">${s.totalPicks}</div>
          <div class="pa-acard-label">Total Picks</div>
        </div>
        <div class="pa-acard pa-acard-green">
          <div class="pa-acard-val">${s.totalCorrect}</div>
          <div class="pa-acard-label">Correct (${(100 - s.anomalyRate).toFixed(1)}%)</div>
        </div>
        <div class="pa-acard ${s.anomalyRate > 10 ? 'pa-acard-red' : s.anomalyRate > 5 ? 'pa-acard-amber' : 'pa-acard-green'}">
          <div class="pa-acard-val">${s.totalAnomalies}</div>
          <div class="pa-acard-label">Anomalies (${s.anomalyRate}%)</div>
        </div>
      </div>`;

    // ── Weekly Trend (pure CSS bar chart) ──
    renderWeeklyTrend(a.weeklyTrend);

    // ── Error Types (horizontal bars) ──
    renderErrorTypes(a.errorTypes);

    // ── Section Heatmap ──
    renderSectionHeatmap(a.sectionHeatmap);

    // ── Top SKUs ──
    renderTopItems('paChartSkus', a.topSkus, 'sku');

    // ── Top Bins ──
    renderTopItems('paChartBins', a.topBins, 'bin');

    // ── Repeat Routes ──
    renderRepeatRoutes(a.repeatRoutes);
  }

  function renderWeeklyTrend(weeks) {
    const el = document.getElementById('paChartTrend');
    if (!weeks.length) { el.innerHTML = '<div class="pa-empty">No data yet</div>'; return; }

    const maxPicks = Math.max(...weeks.map(w => w.picks), 1);
    const maxRate = Math.max(...weeks.map(w => w.picks > 0 ? (w.anomalies / w.picks * 100) : 0), 1);

    el.innerHTML = `
      <div class="pa-trend-chart">
        ${weeks.map(w => {
          const rate = w.picks > 0 ? (w.anomalies / w.picks * 100) : 0;
          const barH = Math.max(4, (rate / maxRate) * 100);
          const picksH = Math.max(2, (w.picks / maxPicks) * 60);
          const rateColor = rate > 15 ? '#ef4444' : rate > 10 ? '#f59e0b' : rate > 5 ? '#eab308' : '#22c55e';
          return `<div class="pa-trend-col" title="${w.week}\n${w.orders} orders · ${w.picks} picks\n${w.anomalies} anomalies (${rate.toFixed(1)}%)">
            <div class="pa-trend-rate" style="height:${barH}%;background:${rateColor}">${rate.toFixed(1)}%</div>
            <div class="pa-trend-picks" style="height:${picksH}px"></div>
            <div class="pa-trend-label">${w.week.replace(/^\d{4}-/, '')}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="pa-trend-legend">
        <span>🟩 &lt;5%</span> <span>🟨 5-10%</span> <span>🟧 10-15%</span> <span>🟥 &gt;15%</span>
        <span style="margin-left:auto;color:#94a3b8">Gray bar = pick volume</span>
      </div>`;
  }

  function renderErrorTypes(types) {
    const el = document.getElementById('paChartErrorTypes');
    if (!types.length) { el.innerHTML = '<div class="pa-empty">No anomalies</div>'; return; }
    const total = types.reduce((s, t) => s + t.count, 0);
    const maxCount = types[0].count;

    const labels = {
      different_area: { icon: '🔴', label: 'Different Area', desc: 'Picked from completely wrong warehouse section' },
      same_section: { icon: '🟠', label: 'Wrong Column', desc: 'Same section but different column' },
      same_column: { icon: '🟡', label: 'Wrong Level', desc: 'Same column but different shelf level' },
      pallet_only: { icon: '🟢', label: 'Wrong Pallet', desc: 'Same level, just different pallet position' },
      special_loc: { icon: '🔵', label: 'Special Location', desc: 'Dock, staging, or non-standard bin' },
    };

    el.innerHTML = types.map(t => {
      const pct = ((t.count / total) * 100).toFixed(1);
      const barW = (t.count / maxCount) * 100;
      const info = labels[t.type] || { icon: '⚪', label: t.type, desc: '' };
      return `<div class="pa-etype-row" title="${info.desc}">
        <div class="pa-etype-label">${info.icon} ${info.label}</div>
        <div class="pa-etype-bar-wrap">
          <div class="pa-etype-bar" style="width:${barW}%;background:${t.type === 'different_area' ? '#ef4444' : t.type === 'same_section' ? '#f59e0b' : t.type === 'same_column' ? '#eab308' : '#22c55e'}"></div>
        </div>
        <div class="pa-etype-val">${t.count} <span class="pa-etype-pct">(${pct}%)</span></div>
      </div>`;
    }).join('');
  }

  function renderSectionHeatmap(sections) {
    const el = document.getElementById('paChartSections');
    if (!sections.length) { el.innerHTML = '<div class="pa-empty">No data</div>'; return; }
    const maxCount = sections[0].count;

    // All warehouse sections
    const allSections = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const sectionMap = {};
    for (const s of sections) sectionMap[s.section] = s.count;

    el.innerHTML = `<div class="pa-heatmap">
      ${allSections.map(sec => {
        const count = sectionMap[sec] || 0;
        const intensity = maxCount > 0 ? (count / maxCount) : 0;
        const bg = count === 0 ? '#f1f5f9'
          : intensity > 0.7 ? '#ef4444'
          : intensity > 0.4 ? '#f59e0b'
          : intensity > 0.15 ? '#fbbf24'
          : '#86efac';
        const color = intensity > 0.4 ? '#fff' : '#1e293b';
        return `<div class="pa-heatmap-cell" style="background:${bg};color:${color}" title="Section ${sec}: ${count} anomalies">
          <div class="pa-heatmap-letter">${sec}</div>
          <div class="pa-heatmap-count">${count}</div>
        </div>`;
      }).join('')}
    </div>
    <div class="pa-heatmap-legend">
      <span style="background:#86efac;color:#1e293b">Low</span>
      <span style="background:#fbbf24;color:#1e293b">Med</span>
      <span style="background:#f59e0b;color:#fff">High</span>
      <span style="background:#ef4444;color:#fff">Critical</span>
    </div>`;
  }

  function renderTopItems(containerId, items, key) {
    const el = document.getElementById(containerId);
    if (!items.length) { el.innerHTML = '<div class="pa-empty">No data</div>'; return; }
    const maxCount = items[0].count;

    el.innerHTML = items.map((item, idx) => {
      const val = item[key];
      const barW = (item.count / maxCount) * 100;
      const isRepeat = item.count >= 3;
      return `<div class="pa-top-row${isRepeat ? ' pa-top-repeat' : ''}">
        <span class="pa-top-rank">${idx + 1}</span>
        <span class="pa-top-name" title="${esc(val)}">${esc(val)}</span>
        <div class="pa-top-bar-wrap">
          <div class="pa-top-bar" style="width:${barW}%"></div>
        </div>
        <span class="pa-top-count">${item.count}×${isRepeat ? ' 🔁' : ''}</span>
      </div>`;
    }).join('');
  }

  function renderRepeatRoutes(routes) {
    const el = document.getElementById('paChartRoutes');
    if (!routes.length) { el.innerHTML = '<div class="pa-empty">No repeat routes detected — great! 🎉</div>'; return; }

    el.innerHTML = `<table class="app-table" style="font-size:12px">
      <thead><tr><th>Count</th><th>Expected Bin (FROM)</th><th>→</th><th>Picked From (TO)</th><th>SKUs</th><th>Action</th></tr></thead>
      <tbody>
      ${routes.map(r => {
        const isCritical = r.count >= 4;
        return `<tr class="${isCritical ? 'pa-route-critical' : ''}">
          <td><strong class="${isCritical ? 'pa-count-critical' : ''}">${r.count}×</strong></td>
          <td><code>${esc(r.from)}</code></td>
          <td>→</td>
          <td><code>${esc(r.to)}</code></td>
          <td>${r.skus.map(s => esc(s)).join(', ')}</td>
          <td>${isCritical ? '<span class="pa-badge pa-badge-anomaly" title="This route has repeated 4+ times — the stock_locator may need updating in Cin7">⚠️ Check Locator</span>' : ''}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
  }

  /* ═══════════════════════════════════════════════
     BULK PRINT SELECTION
     ═══════════════════════════════════════════════ */
  function toggleBulk(idx, checked) {
    if (checked) state.selectedBulk.add(idx);
    else state.selectedBulk.delete(idx);
    _updateBulkBar();
  }

  function toggleBulkAll(checked) {
    state.orders.forEach((_, idx) => {
      if (checked) state.selectedBulk.add(idx);
      else state.selectedBulk.delete(idx);
    });
    document.querySelectorAll('.pa-bulk-check').forEach(cb => cb.checked = checked);
    _updateBulkBar();
  }

  function _updateBulkBar() {
    const bar = document.getElementById('paBulkBar');
    const count = state.selectedBulk.size;
    if (count > 0) {
      bar.style.display = '';
      document.getElementById('paBulkCount').textContent = `${count} order${count > 1 ? 's' : ''} selected`;
    } else {
      bar.style.display = 'none';
    }
  }

  function openBulkPreview() {
    if (state.selectedBulk.size === 0) return;
    const container = document.getElementById('paBulkPreviewBody');
    const selected = [...state.selectedBulk].map(idx => state.orders[idx]).filter(Boolean);

    // Summary stats
    let totalPicks = 0, totalAnom = 0, totalCorrect = 0, totalCorrected = 0;
    for (const o of selected) {
      totalPicks += o.total_picks || 0;
      totalAnom += o.anomaly_picks || 0;
      totalCorrect += o.correct_picks || 0;
      totalCorrected += (o.corrections || []).length;
    }

    container.innerHTML = `
      <div class="pa-bulk-summary">
        <div class="pa-bulk-stat"><span class="pa-bulk-stat-val">${selected.length}</span><span class="pa-bulk-stat-label">Orders</span></div>
        <div class="pa-bulk-stat"><span class="pa-bulk-stat-val">${totalPicks}</span><span class="pa-bulk-stat-label">Total Picks</span></div>
        <div class="pa-bulk-stat"><span class="pa-bulk-stat-val">${totalAnom}</span><span class="pa-bulk-stat-label">Anomalies</span></div>
        <div class="pa-bulk-stat"><span class="pa-bulk-stat-val">${totalCorrect}</span><span class="pa-bulk-stat-label">Correct</span></div>
        <div class="pa-bulk-stat"><span class="pa-bulk-stat-val">${totalCorrected}</span><span class="pa-bulk-stat-label">Corrected</span></div>
      </div>

      <div class="pa-bulk-list-header">
        <span>Select which orders to include:</span>
      </div>
      <div class="pa-bulk-list">
        ${selected.map((o, i) => {
          const anom = o.anomaly_picks || 0;
          const corrections = (o.corrections || []).length;
          const accuracy = o.total_picks > 0 ? Math.round(((o.correct_picks || 0) / o.total_picks) * 100) : 100;
          return `
            <div class="pa-bulk-item" data-order="${esc(o.order_number)}">
              <input type="checkbox" checked class="pa-bulk-preview-check" data-order-num="${esc(o.order_number)}" onchange="PA._bulkPreviewToggle(this)" />
              <div class="pa-bulk-item-info">
                <strong>${esc(o.order_number)}</strong>
                <span class="pa-bulk-item-customer">${esc(o.customer || '')}</span>
              </div>
              <div class="pa-bulk-item-stats">
                <span class="pa-bulk-item-date">${formatDate(o.order_date)}</span>
                <span class="pa-bulk-item-accuracy ${accuracy >= 95 ? 'pa-acc-good' : accuracy >= 80 ? 'pa-acc-warn' : 'pa-acc-bad'}">${accuracy}%</span>
                ${anom > 0 ? `<span class="pa-bulk-item-anom">⚠️ ${anom}</span>` : '<span class="pa-bulk-item-ok">✅ OK</span>'}
                ${corrections > 0 ? `<span class="pa-bulk-item-fixed">🔄 ${corrections}</span>` : ''}
              </div>
            </div>`;
        }).join('')}
      </div>
    `;

    document.getElementById('paBulkPreviewModal').classList.add('open');
  }

  function closeBulkPreview() {
    document.getElementById('paBulkPreviewModal').classList.remove('open');
  }

  function _bulkPreviewToggle(checkbox) {
    // Just toggle visibility — the checked state determines what gets printed
  }

  function printBulkReport() {
    // Gather checked orders from preview modal
    const checkedNums = new Set();
    document.querySelectorAll('.pa-bulk-preview-check:checked').forEach(cb => {
      checkedNums.add(cb.dataset.orderNum);
    });
    if (checkedNums.size === 0) return;

    const selected = [...state.selectedBulk]
      .map(idx => state.orders[idx])
      .filter(o => o && checkedNums.has(o.order_number));

    if (!selected.length) return;

    // Build combined report
    let totalPicks = 0, totalAnom = 0, totalCorrect = 0, totalCorrected = 0;
    const allAnomalies = [];
    const allCorrections = [];
    const byType = {};

    for (const order of selected) {
      const picks = order.picks || [];
      const anomalies = picks.filter(p => p.status === 'anomaly');
      const correct = picks.filter(p => p.status === 'correct');
      // FG
      let fgAnom = 0, fgCorr = 0;
      const fgAnomalies = [];
      for (const fg of (order.fg_orders || [])) {
        for (let ci = 0; ci < (fg.components || []).length; ci++) {
          const comp = fg.components[ci];
          if (comp.status === 'anomaly') {
            fgAnom++;
            fgAnomalies.push({ ...comp, _fgLabel: fg.assemblyNumber || fg.taskId, _fgTaskId: fg.taskId, _fgIdx: ci });
          }
        }
      }

      totalPicks += picks.length + fgAnom + (order.fg_orders || []).reduce((s, fg) => s + (fg.components || []).filter(c => c.status === 'correct').length, 0);
      totalAnom += anomalies.length + fgAnom;
      totalCorrect += correct.length;
      totalCorrected += (order.corrections || []).length;

      for (const a of [...anomalies, ...fgAnomalies]) {
        const err = classifyError(a.bin, a.expectedBin);
        const pickId = a._fgTaskId ? `fg_${a._fgTaskId}_${a._fgIdx}` : (a.id || 'unknown');
        const correction = (order.corrections || []).find(c => c.pick_id === pickId);
        allAnomalies.push({ ...a, _orderNum: order.order_number, _customer: order.customer, _err: err, _correction: correction });
        if (!byType[err.label]) byType[err.label] = 0;
        byType[err.label]++;
      }
      allCorrections.push(...(order.corrections || []));
    }

    const accuracyPct = totalPicks > 0 ? Math.round((totalCorrect / totalPicks) * 100) : 100;
    const now = new Date();
    const printDate = now.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' }) + ' ' +
                      now.toLocaleTimeString('en-AU', { hour12:false, hour:'2-digit', minute:'2-digit' });

    // Date range
    const dates = selected.map(o => o.order_date).filter(Boolean).sort();
    const dateRange = dates.length > 1 ? `${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}` : (dates[0] ? formatDate(dates[0]) : '—');

    let reportHtml = `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Pick Anomaly Bulk Report — ${selected.length} Orders</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:12px; color:#1e293b; padding:30px; }
        .report-header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #1e293b; padding-bottom:16px; margin-bottom:20px; }
        .report-title { font-size:22px; font-weight:800; }
        .report-subtitle { font-size:13px; color:#64748b; margin-top:4px; }
        .report-logo { text-align:right; font-size:11px; color:#94a3b8; }
        .summary-cards { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:20px; }
        .s-card { padding:14px; border-radius:8px; border:1px solid #e2e8f0; text-align:center; }
        .s-card-val { font-size:28px; font-weight:800; }
        .s-card-label { font-size:10px; font-weight:700; text-transform:uppercase; color:#64748b; margin-top:2px; }
        .s-card-blue { background:#eff6ff; color:#1d4ed8; }
        .s-card-green { background:#f0fdf4; color:#166534; }
        .s-card-red { background:#fef2f2; color:#dc2626; }
        .s-card-amber { background:#fffbeb; color:#92400e; }
        .s-card-purple { background:#faf5ff; color:#7c3aed; }
        .accuracy-section { display:flex; align-items:center; gap:24px; margin-bottom:20px; padding:14px 18px; border-radius:8px; border:1px solid #e2e8f0; }
        .accuracy-bar-wrap { flex:1; height:14px; background:#e2e8f0; border-radius:7px; overflow:hidden; }
        .accuracy-bar { height:100%; border-radius:7px; background:#22c55e; }
        .section-title { font-size:16px; font-weight:800; margin:24px 0 10px; border-bottom:2px solid #e2e8f0; padding-bottom:6px; }
        .section-title-small { font-size:13px; font-weight:700; margin:16px 0 8px; color:#64748b; }
        table { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:16px; }
        th { background:#f1f5f9; text-align:left; padding:8px 10px; font-weight:700; font-size:10px; text-transform:uppercase; letter-spacing:.5px; border-bottom:2px solid #cbd5e1; }
        td { padding:7px 10px; border-bottom:1px solid #e2e8f0; vertical-align:top; }
        tr:nth-child(even) { background:#fafbfc; }
        .bin-code { font-family:'Courier New',monospace; font-weight:700; font-size:12px; padding:2px 6px; border-radius:4px; }
        .bin-wrong { background:#fef2f2; color:#dc2626; }
        .bin-ok { background:#f0fdf4; color:#16a34a; }
        .sev-badge { display:inline-block; padding:2px 8px; border-radius:4px; font-weight:700; font-size:10px; text-transform:uppercase; color:#fff; }
        .sev-low { background:#f59e0b; } .sev-medium { background:#f97316; } .sev-high { background:#dc2626; } .sev-info { background:#6366f1; }
        .status-ok { color:#16a34a; font-weight:700; } .status-pending { color:#f59e0b; font-weight:700; }
        .summary-box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:14px 18px; margin-top:16px; }
        .summary-box h4 { font-size:13px; margin-bottom:8px; }
        .error-row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #f1f5f9; }
        .order-section { margin:20px 0; padding:16px; border:1px solid #e2e8f0; border-radius:10px; page-break-inside:avoid; }
        .order-section-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
        .order-section-title { font-size:14px; font-weight:800; }
        .order-section-meta { font-size:11px; color:#64748b; }
        .page-break { page-break-before:always; }
        .footer { margin-top:30px; border-top:2px solid #e2e8f0; padding-top:10px; font-size:10px; color:#94a3b8; text-align:center; }
        @media print { body { padding:15px; } .no-print { display:none; } }
      </style>
    </head><body>
      <div class="report-header">
        <div>
          <div class="report-title">🔍 Pick Anomaly Report — Bulk</div>
          <div class="report-subtitle">${selected.length} Orders · ${dateRange}</div>
        </div>
        <div class="report-logo">
          Rapid Labels Warehouse<br>
          Generated: ${printDate}
        </div>
      </div>

      <div class="summary-cards">
        <div class="s-card s-card-blue"><div class="s-card-val">${selected.length}</div><div class="s-card-label">Orders</div></div>
        <div class="s-card s-card-green"><div class="s-card-val">${totalPicks}</div><div class="s-card-label">Total Picks</div></div>
        <div class="s-card s-card-red"><div class="s-card-val">${totalAnom}</div><div class="s-card-label">Anomalies</div></div>
        <div class="s-card s-card-amber"><div class="s-card-val">${accuracyPct}%</div><div class="s-card-label">Accuracy</div></div>
        <div class="s-card s-card-purple"><div class="s-card-val">${totalCorrected}</div><div class="s-card-label">Corrected</div></div>
      </div>

      <div class="accuracy-section">
        <div style="min-width:80px"><div style="font-size:24px;font-weight:800">${accuracyPct}%</div><div style="font-size:10px;color:#64748b;font-weight:600">OVERALL</div></div>
        <div class="accuracy-bar-wrap"><div class="accuracy-bar" style="width:${accuracyPct}%"></div></div>
        <div style="font-size:12px;font-weight:600;white-space:nowrap">✅ ${totalCorrect} · ⚠️ ${totalAnom} · 🔄 ${totalCorrected}</div>
      </div>

      <div class="summary-box">
        <h4>📊 Error Type Breakdown</h4>
        ${Object.entries(byType).sort((a,b) => b[1] - a[1]).map(([label, count]) => `
          <div class="error-row">
            <span>${esc(label)}</span>
            <span><strong>${count}</strong> (${Math.round(count / totalAnom * 100)}%)</span>
          </div>
        `).join('')}
      </div>

      <div class="section-title">📋 Orders Summary</div>
      <table>
        <thead><tr><th>#</th><th>Order</th><th>Customer</th><th>Date</th><th>Picks</th><th>✅</th><th>⚠️</th><th>Corrected</th><th>Accuracy</th></tr></thead>
        <tbody>
          ${selected.map((o, i) => {
            const acc = o.total_picks > 0 ? Math.round(((o.correct_picks || 0) / o.total_picks) * 100) : 100;
            return `<tr>
              <td>${i + 1}</td>
              <td><strong>${esc(o.order_number)}</strong></td>
              <td>${esc(o.customer || '')}</td>
              <td>${formatDate(o.order_date)}</td>
              <td>${o.total_picks || 0}</td>
              <td>${o.correct_picks || 0}</td>
              <td>${o.anomaly_picks || 0}</td>
              <td>${(o.corrections || []).length}</td>
              <td style="font-weight:700;color:${acc >= 95 ? '#16a34a' : acc >= 80 ? '#f59e0b' : '#dc2626'}">${acc}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div class="section-title">⚠️ All Anomalies (${allAnomalies.length})</div>
      <table>
        <thead><tr><th>#</th><th>Order</th><th>SKU</th><th>Product</th><th>Qty</th><th>Picked From</th><th>Should Be</th><th>Error Type</th><th>Severity</th><th>Corrected?</th></tr></thead>
        <tbody>
          ${allAnomalies.map((a, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(a._orderNum)}</td>
            <td><strong>${esc(a.sku)}</strong>${a._fgLabel ? ' <span style="color:#7c3aed;font-size:10px">(FG)</span>' : ''}</td>
            <td>${esc(a.name || '')}</td>
            <td>${a.qty}</td>
            <td><span class="bin-code bin-wrong">${esc(a.bin)}</span></td>
            <td><span class="bin-code bin-ok">${esc(a.expectedBin)}</span></td>
            <td>${esc(a._err.label)}</td>
            <td><span class="sev-badge sev-${a._err.severity}">${a._err.severity}</span></td>
            <td>${a._correction ? '<span class="status-ok">✅ Yes</span>' : '<span class="status-pending">⏳ Pending</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>

      ${allCorrections.length > 0 ? `
        <div class="section-title">🔄 Corrections Applied (${allCorrections.length})</div>
        <table>
          <thead><tr><th>SKU</th><th>From</th><th>To</th><th>Qty</th><th>Transfer Ref</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${allCorrections.map(c => `<tr>
              <td><strong>${esc(c.sku || '—')}</strong></td>
              <td><span class="bin-code">${esc(c.from_bin)}</span></td>
              <td><span class="bin-code">${esc(c.to_bin)}</span></td>
              <td>${c.qty}</td>
              <td>${esc(c.transfer_ref || '—')}</td>
              <td><span class="status-ok">${esc(c.transfer_status || 'DRAFT')}</span></td>
              <td>${formatDate(c.corrected_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      ` : ''}

      <div class="footer">
        Rapid Labels Warehouse — Pick Anomaly Bulk Report · ${selected.length} Orders · Generated: ${printDate}
      </div>
    </body></html>`;

    const printWindow = window.open('', '_blank', 'width=1000,height=800');
    printWindow.document.write(reportHtml);
    printWindow.document.close();
    printWindow.onload = () => { printWindow.print(); };

    closeBulkPreview();
  }

  function clearBulkSelection() {
    state.selectedBulk.clear();
    document.querySelectorAll('.pa-bulk-check').forEach(cb => cb.checked = false);
    _updateBulkBar();
  }

  /* ═══════════════════════════════════════════════
     REVERSE CORRECTIONS (for cancelled orders)
     ═══════════════════════════════════════════════ */
  async function reverseAllCorrections(orderNumber) {
    const order = state.orders.find(o => o.order_number === orderNumber);
    if (!order) return alert('Order not found');

    const corrections = order.corrections || [];
    if (!corrections.length) return alert('No corrections to reverse');

    // Filter out already-reversed corrections
    const toReverse = corrections.filter(c => !c.is_reversed);
    if (!toReverse.length) return alert('All corrections already reversed');

    if (!confirm(`Reverse ${toReverse.length} correction(s) for ${orderNumber}?\n\nThis will create INVERSE stock transfers (undo the corrections because the order was cancelled).`)) {
      return;
    }

    let ok = 0, fail = 0;
    for (const c of toReverse) {
      try {
        const resp = await fetch('/api/pick-anomalies/reverse-correction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            correctionId: c.id,
            productId: c.product_id || null,
            sku: c.sku,
            qty: c.qty,
            fromBin: c.from_bin,
            toBin: c.to_bin,
            orderNumber: c.order_number,
          }),
        });
        const data = await resp.json();
        if (data.success) ok++;
        else { fail++; console.error('Reversal failed:', data.error); }
      } catch (err) {
        fail++;
        console.error('Reversal error:', err);
      }
    }

    if (ok > 0) {
      alert(`✅ ${ok} correction(s) reversed successfully${fail > 0 ? ` (${fail} failed)` : ''}`);
      await loadHistory(); // Refresh
    } else {
      alert(`❌ All reversals failed. Check console.`);
    }
  }

  /* ═══════════════════════════════════════════════
     PUBLIC API (window.PA)
     ═══════════════════════════════════════════════ */
  window.PA = {
    loadHistory,
    loadStats,
    loadAnalytics,
    syncNewOrders,
    fetchSyncStatus,
    debounceSearch,
    setFilter,
    setView,
    openDetail,
    closeDetail,
    setTab,
    toggleFix,
    toggleSelectAll,
    fixSelected,
    confirmFix,
    reviewOrder,
    printReport,
    toggleBulk,
    toggleBulkAll,
    openBulkPreview,
    closeBulkPreview,
    printBulkReport,
    clearBulkSelection,
    reverseAllCorrections,
    _bulkPreviewToggle,
    nextPage,
    prevPage,
    _resetConfirmModal,
  };

  /* ─── Init ─── */
  document.addEventListener('DOMContentLoaded', async () => {
    setSyncStatus('idle', 'Loading...');

    // 1. Load existing history + global stats from Supabase (zero Cin7 calls)
    await loadHistory();
    await loadStats();

    // 2. Fetch sync status (shows "Xh Ym ago" + "+N orders" — no Cin7 API calls)
    await fetchSyncStatus();

    // 3. Pre-load analytics in background (for repeat offender badges)
    loadAnalytics().catch(() => {});

    // Note: No auto-sync on page open.
    // Backend scheduler syncs every 2h at :30. User can manually sync via button.
  });

})();
