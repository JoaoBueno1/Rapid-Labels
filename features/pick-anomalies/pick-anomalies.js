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
    searchQuery: '',
    searchTimer: null,
    syncing: false,
    autoSyncInterval: null,
    page: 1,
    perPage: 50,
    totalOrders: 0,
  };

  const AUTO_SYNC_MS = 10 * 60 * 1000; // Auto-sync every 10 minutes

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
  function updateKpis() {
    const el = document.getElementById('paKpis');
    el.style.display = '';

    let orders = 0, picks = 0, correct = 0, anomalies = 0, fg = 0;
    for (const o of state.orders) {
      orders++;
      picks += o.total_picks || 0;
      correct += o.correct_picks || 0;
      anomalies += o.anomaly_picks || 0;
      fg += o.fg_count || 0;
    }

    document.getElementById('kpiOrders').textContent = orders;
    document.getElementById('kpiPicks').textContent = picks;
    document.getElementById('kpiCorrect').textContent = correct;
    document.getElementById('kpiAnomalies').textContent = anomalies;
    document.getElementById('kpiFg').textContent = fg;
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
            tableBody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px">
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

      updateKpis();
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
     AUTO-SYNC — Fetch new orders in background
     ═══════════════════════════════════════════════ */
  async function syncNewOrders() {
    if (state.syncing) return;
    state.syncing = true;
    setSyncStatus('syncing', 'Syncing new orders...');
    showProgress('Fetching new orders from Cin7...');

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
        setSyncStatus('syncing', 'Sync already in progress...');
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

      // Reload history to show new data
      if (data.newOrders > 0) {
        await loadHistory();
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
      tbody.innerHTML = '<tr><td colspan="11" class="pa-empty">No orders found.</td></tr>';
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
      if (isReviewed) rowClass = 'pa-row-reviewed';
      else if (anom > 0 && fg > 0) rowClass = 'pa-row-mixed';
      else if (anom > 0) rowClass = 'pa-row-anomaly';
      else if (fg > 0) rowClass = 'pa-row-fg';
      else rowClass = 'pa-row-correct';

      // SO Status column (Cin7 real status)
      const soStatus = esc(o.order_status || '—');
      const soClass = soStatus.toUpperCase().includes('INVOICED') ? 'pa-so-invoiced'
        : soStatus.toUpperCase().includes('FULFILLED') ? 'pa-so-fulfilled'
        : soStatus.toUpperCase().includes('PACKED') ? 'pa-so-packed'
        : soStatus.toUpperCase().includes('SHIPPED') ? 'pa-so-shipped'
        : 'pa-so-other';

      // Anomaly Status column
      let statusHtml = '';
      if (anom === 0) {
        statusHtml = '<span class="pa-badge pa-badge-correct">✅ OK</span>';
      } else if (corrections.length >= anom) {
        statusHtml = '<span class="pa-badge pa-badge-correct">✅ Fixed</span>';
      } else if (corrections.length > 0) {
        statusHtml = `<span class="pa-badge pa-badge-anomaly">⚠️ ${corrections.length}/${anom} fixed</span>`;
      } else {
        statusHtml = `<span class="pa-badge pa-badge-anomaly">⚠️ ${anom} anomal${anom > 1 ? 'ies' : 'y'}</span>`;
      }

      // Reviewed column
      const reviewedHtml = isReviewed
        ? '<span class="pa-badge pa-badge-correct">✅ Reviewed</span>'
        : '<span class="pa-badge" style="opacity:0.5">—</span>';

      return `<tr class="${rowClass}" style="cursor:pointer" onclick="PA.openDetail(${idx})">
        <td>${offset + idx + 1}</td>
        <td><strong>${esc(o.order_number)}</strong></td>
        <td>${formatDate(o.order_date)}</td>
        <td>${esc(o.customer)}</td>
        <td><span class="pa-so-badge ${soClass}">${soStatus}</span></td>
        <td>${o.total_picks || 0}</td>
        <td>${correct}</td>
        <td>${anom || ''}</td>
        <td>${fg || ''}</td>
        <td>${statusHtml}</td>
        <td>${reviewedHtml}</td>
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

    document.getElementById('paModalTitle').textContent = `Order ${order.order_number} — ${order.customer || ''}`;

    const picks = order.picks || [];
    const anomalies = picks.filter(p => p.status === 'anomaly').length;
    const correct = picks.filter(p => p.status === 'correct').length;
    const fg = (order.fg_orders || []).length;

    document.getElementById('tabCountAnomalies').textContent = anomalies;
    document.getElementById('tabCountFg').textContent = fg;
    document.getElementById('tabCountCorrect').textContent = correct;

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

    document.getElementById('paModalSummary').innerHTML =
      `<strong>${picks.length}</strong> picks · <strong>${correct}</strong> correct · <strong>${anomalies}</strong> anomalies · <strong>${fg}</strong> FG orders ` +
      `· Analyzed: ${formatDate(order.analyzed_at)}`;

    setTabVisibility();
    renderTabContent();

    document.getElementById('paDetailModal').classList.add('open');
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
      case 'fg':        body.innerHTML = renderFgTab(order); break;
      case 'correct':   body.innerHTML = renderCorrectTab(order); break;
    }
    updateBatchSummary();
  }

  /* ═══════════════════════════════════════════════
     TAB RENDERERS
     ═══════════════════════════════════════════════ */

  function getCorrection(order, pickId) {
    return (order.corrections || []).find(c => c.pick_id === pickId);
  }

  function renderAnomaliesTab(order) {
    const anomalies = (order.picks || []).filter(p => p.status === 'anomaly');
    if (!anomalies.length) return '<div class="pa-empty">No anomalies found — all picks are correct! 🎉</div>';

    const uncorrected = anomalies.filter(pick => {
      const pickId = pick.id || `${order.order_number}_pick_0`;
      return !getCorrection(order, pickId);
    });

    return `
      ${uncorrected.length > 0 ? `
        <div class="pa-select-all">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:700">
            <input type="checkbox" onchange="PA.toggleSelectAll(this.checked)" /> Select All Unfixed
          </label>
        </div>
      ` : ''}
      ${anomalies.map((pick, idx) => {
        const err = classifyError(pick.bin, pick.expectedBin);
        const pickId = pick.id || `${order.order_number}_pick_${idx}`;
        const correction = getCorrection(order, pickId);

        return `
          <div class="pa-anomaly-card ${correction ? 'pa-card-corrected' : ''}" id="card-${pickId}">
            <div class="pa-anomaly-header">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                ${!correction ? `<input type="checkbox" class="pa-fix-check" data-pick-id="${pickId}" onchange="PA.toggleFix('${pickId}', this.checked)" />` : ''}
                <strong>${esc(pick.sku)}</strong>
                <span class="small-note">× ${pick.qty}</span>
                <span class="small-note" style="color:#64748b">${esc(pick.name || '')}</span>
              </label>
              ${severityBadge(err.severity)}
            </div>
            <div class="pa-anomaly-detail">
              <div class="pa-bin-compare">
                <div class="pa-bin-line pa-bin-wrong">
                  <span class="pa-bin-icon">❌</span>
                  <span class="pa-bin-label">Picked From:</span>
                  <span class="pa-bin-value">${esc(pick.bin)}</span>
                </div>
                <div class="pa-bin-line pa-bin-expected">
                  <span class="pa-bin-icon">✅</span>
                  <span class="pa-bin-label">Expected Bin:</span>
                  <span class="pa-bin-value">${esc(pick.expectedBin)}</span>
                </div>
                <div class="pa-bin-line">
                  <span class="pa-bin-icon">📏</span>
                  <span class="pa-bin-label">Error Type:</span>
                  <span class="pa-bin-value">${esc(err.label)}</span>
                </div>
              </div>
              ${correction ? `
                <div class="pa-correction-status">
                  <div class="pa-correction-title">✅ Transfer ${correction.transfer_status === 'COMPLETED' ? 'Completed' : 'Created'}</div>
                  <div class="pa-correction-detail">
                    <div>Transfer ID: <strong>${esc(correction.transfer_id || '—')}</strong></div>
                    <div>Ref: <strong>${esc(correction.transfer_ref || '—')}</strong></div>
                    <div>Status: <strong>${esc(correction.transfer_status || 'DRAFT')}</strong></div>
                    <div>Corrected: <strong>${formatDate(correction.corrected_at)}</strong></div>
                    <div>${esc(correction.from_bin)} → ${esc(correction.to_bin)} · ${correction.qty} units</div>
                  </div>
                </div>
              ` : `
                <div class="pa-fix-preview">
                  <div class="pa-fix-title">Transfer will move stock:</div>
                  <div class="pa-fix-detail">
                    FROM <strong>${esc(pick.expectedBin)}</strong> (expected)
                    → TO <strong>${esc(pick.bin)}</strong> (picked)
                  </div>
                  <div class="pa-fix-qty">${pick.qty} units of ${esc(pick.sku)}</div>
                </div>
              `}
            </div>
          </div>`;
      }).join('')}
    `;
  }

  function renderFgTab(order) {
    const fgs = order.fg_orders || [];
    if (!fgs.length) return '<div class="pa-empty">No FG/Assembly orders found for this order.</div>';

    return fgs.map(fg => {
      const components = fg.components || [];
      return `
        <div class="pa-fg-card">
          <div class="pa-fg-header">
            🔧 ${esc(fg.assemblyNumber || fg.taskId)} — ${esc(fg.productCode)}
            <span class="pa-badge">${esc(fg.status)}</span>
          </div>
          <div>Qty: ${fg.quantity} · Completed: ${formatDate(fg.completionDate)} ${fg.createdBy ? '· By: ' + esc(fg.createdBy) : ''}</div>
          <div class="pa-fg-components">
            <strong>Components (${components.length}):</strong>
            ${components.map(c => {
              const icon = c.status === 'anomaly' ? '⚠️' : '✅';
              return `<div class="pa-fg-comp-row">
                ${icon} <strong>${esc(c.sku)}</strong> ×${c.qty}
                ${c.bin ? `— Bin: <code>${esc(c.bin)}</code>` : '— No bin'}
                ${c.expectedBin ? ` (expected: <code>${esc(c.expectedBin)}</code>)` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>`;
    }).join('');
  }

  function renderCorrectTab(order) {
    const correct = (order.picks || []).filter(p => p.status === 'correct');
    if (!correct.length) return '<div class="pa-empty">No correct picks in this order.</div>';

    return `<table class="app-table" style="font-size:13px">
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
      const pick = (o.picks || []).find(p => p.id === pickId);
      if (pick) return { order: o, pick };
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

    const summaryLines = items.map(t =>
      `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9">
        <strong>${esc(t.sku)}</strong> ×${t.qty} — ${esc(t.expectedBin)} → ${esc(t.pickedBin)}
      </div>`
    ).join('');

    document.getElementById('paConfirmBody').innerHTML =
      `<div style="margin-bottom:10px">Create <strong>${count}</strong> Stock Transfer${count > 1 ? 's' : ''} (COMPLETED) in Cin7:</div>
      <div style="max-height:200px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;font-size:13px">${summaryLines}</div>
      <div style="margin-top:10px;font-size:12px;color:#64748b">Transfers will be created and completed automatically.</div>`;
    document.getElementById('paConfirmModal').classList.add('open');
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

    } catch (err) {
      console.error('Batch fix error:', err);
      alert('Batch fix error: ' + err.message);
    } finally {
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm'; }
      const cfBtn = document.querySelector('#paConfirmModal .pa-confirm-btn');
      if (cfBtn) cfBtn.style.display = '';
      const secBtn = document.querySelector('#paConfirmModal .secondary');
      if (secBtn) secBtn.textContent = 'Cancel';
    }
  }

  /* ═══════════════════════════════════════════════
     REVIEW ORDER — Mark as reviewed by operator
     ═══════════════════════════════════════════════ */
  async function reviewOrder() {
    const order = state.selectedOrder;
    if (!order) return;

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

      // Update modal button
      const reviewBtn = document.getElementById('paReviewBtn');
      if (reviewBtn) {
        reviewBtn.disabled = true;
        reviewBtn.innerHTML = '✅ Reviewed';
        reviewBtn.classList.add('pa-btn-reviewed');
      }

      // Refresh table
      renderOrdersTable();
    } catch (err) {
      console.error('Review error:', err);
      alert('Error marking as reviewed: ' + err.message);
    }
  }

  /* ═══════════════════════════════════════════════
     PUBLIC API (window.PA)
     ═══════════════════════════════════════════════ */
  window.PA = {
    loadHistory,
    syncNewOrders,
    debounceSearch,
    setFilter,
    openDetail,
    closeDetail,
    setTab,
    toggleFix,
    toggleSelectAll,
    fixSelected,
    confirmFix,
    reviewOrder,
    nextPage,
    prevPage,
  };

  /* ─── Init ─── */
  document.addEventListener('DOMContentLoaded', async () => {
    setSyncStatus('idle', 'Loading...');

    // 1. Load existing history from Supabase
    await loadHistory();

    // 2. Auto-sync new orders
    setSyncStatus('syncing', 'Checking for new orders...');
    await syncNewOrders();

    // 3. Set up auto-refresh every 10 minutes
    state.autoSyncInterval = setInterval(async () => {
      await syncNewOrders();
    }, AUTO_SYNC_MS);
  });

})();
