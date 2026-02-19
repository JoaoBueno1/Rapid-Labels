/**
 * Stock Audit — Frontend Logic
 *
 * Features:
 *   - Browse all stock movements with filters (type, date range, product)
 *   - Per-product drill-down with summary stats
 *   - Alerts tab with severity filtering and acknowledge
 *   - Auto-refresh every 30s for near-real-time monitoring
 *   - Internal (bin↔bin) movements dimmed / hideable
 *   - Pagination, search, date range
 */

(async function () {
  'use strict';

  // ── Wait for Supabase ──
  await window.supabaseReady;
  const sb = window.supabase;

  // ══════════════════════════════════════
  //  STATE
  // ══════════════════════════════════════
  const state = {
    // Movements
    movements: [],
    filteredMovements: [],
    mvtPage: 1,
    mvtPageSize: 50,
    typeFilter: 'ALL',
    hideInternal: true,
    searchTerm: '',
    productFilter: null,   // SKU string for drill-down
    dateFrom: null,
    dateTo: null,

    // Alerts
    alerts: [],
    filteredAlerts: [],
    alertPage: 1,
    alertPageSize: 20,
    alertFilter: 'ALL',
    hideAcknowledged: true,

    // Meta
    activeTab: 'movements',
    refreshTimer: null,
    loading: false,
  };

  // ══════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════
  async function init() {
    // Set default date range (last 7 days)
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    document.getElementById('dateFrom').value = fmtDateInput(weekAgo);
    document.getElementById('dateTo').value = fmtDateInput(now);
    state.dateFrom = fmtDateInput(weekAgo);
    state.dateTo = fmtDateInput(now);

    // Search on Enter
    document.getElementById('auditSearch').addEventListener('keydown', e => {
      if (e.key === 'Enter') window.auditApp.search();
    });

    await Promise.all([loadMovements(), loadAlerts()]);
    checkSyncStatus();

    // Auto-refresh every 30s
    state.refreshTimer = setInterval(() => {
      if (state.activeTab === 'movements') loadMovements();
      else loadAlerts();
    }, 30000);
  }

  // ══════════════════════════════════════
  //  DATA LOADING — Movements
  // ══════════════════════════════════════
  async function loadMovements() {
    if (state.loading) return;
    state.loading = true;

    try {
      let query = sb.schema('cin7_mirror')
        .from('stock_movements')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(2000);

      // Date range
      if (state.dateFrom) {
        query = query.gte('detected_at', state.dateFrom + 'T00:00:00');
      }
      if (state.dateTo) {
        query = query.lte('detected_at', state.dateTo + 'T23:59:59');
      }

      // Product filter (SKU)
      if (state.productFilter) {
        query = query.eq('sku', state.productFilter);
      }

      const { data, error } = await query;

      if (error) {
        console.error('❌ Load movements error:', error.message);
        showMovementsError(error.message);
        return;
      }

      state.movements = data || [];
      applyMovementFilters();

      // If product drill-down, show detail panel
      if (state.productFilter) {
        showProductDetail(state.productFilter);
      }

    } catch (e) {
      console.error('❌ Load movements exception:', e);
    } finally {
      state.loading = false;
    }
  }

  // ══════════════════════════════════════
  //  DATA LOADING — Alerts
  // ══════════════════════════════════════
  async function loadAlerts() {
    try {
      let query = sb.schema('cin7_mirror')
        .from('movement_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      // Product filter
      if (state.productFilter) {
        query = query.eq('sku', state.productFilter);
      }

      const { data, error } = await query;

      if (error) {
        console.error('❌ Load alerts error:', error.message);
        return;
      }

      state.alerts = data || [];
      applyAlertFilters();

    } catch (e) {
      console.error('❌ Load alerts exception:', e);
    }
  }

  // ══════════════════════════════════════
  //  SYNC STATUS
  // ══════════════════════════════════════
  async function checkSyncStatus() {
    try {
      const { data } = await sb.schema('cin7_mirror')
        .from('sync_runs')
        .select('id, started_at, ended_at, status, stats')
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

      const dot = document.getElementById('syncStatusDot');
      const text = document.getElementById('syncStatusText');
      const time = document.getElementById('syncStatusTime');

      if (!data) {
        text.textContent = 'No sync runs found';
        dot.style.background = '#94a3b8';
        return;
      }

      const endedAt = data.ended_at ? new Date(data.ended_at) : null;
      const age = endedAt ? (Date.now() - endedAt.getTime()) / 60000 : 999;

      if (data.status === 'running') {
        dot.style.background = '#f59e0b';
        text.textContent = 'Sync in progress…';
      } else if (data.status === 'completed' && age < 30) {
        dot.style.background = '#22c55e';
        text.textContent = 'Sync OK';
      } else if (data.status === 'completed') {
        dot.style.background = '#f59e0b';
        text.textContent = 'Sync stale';
      } else {
        dot.style.background = '#ef4444';
        text.textContent = `Sync ${data.status}`;
      }

      if (endedAt) {
        time.textContent = `Last: ${fmtRelative(endedAt)}`;
      }
    } catch {}
  }

  // ══════════════════════════════════════
  //  FILTERING — Movements
  // ══════════════════════════════════════
  function applyMovementFilters() {
    let list = [...state.movements];

    // Type filter
    if (state.typeFilter !== 'ALL') {
      const typeMap = {
        SALES: ['sales_pick', 'sales_ship'],
        TRANSFER: ['stock_transfer', 'bin_transfer'],
        ADJUSTMENT: ['stock_adjustment'],
        PURCHASE: ['purchase_receive'],
        DELTA: ['snapshot_delta'],
      };
      const accepted = typeMap[state.typeFilter] || [];
      list = list.filter(m => accepted.includes(m.movement_type));
    }

    // Hide internal
    if (state.hideInternal) {
      list = list.filter(m => !m.is_internal);
    }

    // Search
    if (state.searchTerm) {
      const q = state.searchTerm.toLowerCase();
      list = list.filter(m =>
        (m.sku || '').toLowerCase().includes(q) ||
        (m.product_name || '').toLowerCase().includes(q) ||
        (m.reference_number || '').toLowerCase().includes(q) ||
        (m.customer_name || '').toLowerCase().includes(q) ||
        (m.sales_rep || '').toLowerCase().includes(q) ||
        (m.member_email || '').toLowerCase().includes(q)
      );
    }

    state.filteredMovements = list;
    state.mvtPage = 1;

    updateMovementCounts();
    renderMovements();
  }

  function updateMovementCounts() {
    const all = state.movements.filter(m => !state.hideInternal || !m.is_internal);

    const count = (types) => all.filter(m => types.includes(m.movement_type)).length;

    setText('countAll', all.length);
    setText('countSales', count(['sales_pick', 'sales_ship']));
    setText('countTransfer', count(['stock_transfer', 'bin_transfer']));
    setText('countAdjustment', count(['stock_adjustment']));
    setText('countPurchase', count(['purchase_receive']));
    setText('countDelta', count(['snapshot_delta']));

    // Movements badge in tab
    setText('movementsBadge', state.filteredMovements.length);
  }

  // ══════════════════════════════════════
  //  FILTERING — Alerts
  // ══════════════════════════════════════
  function applyAlertFilters() {
    let list = [...state.alerts];

    // Severity filter
    if (state.alertFilter !== 'ALL') {
      list = list.filter(a => a.severity === state.alertFilter);
    }

    // Hide acknowledged
    if (state.hideAcknowledged) {
      list = list.filter(a => !a.acknowledged_at);
    }

    state.filteredAlerts = list;
    state.alertPage = 1;

    updateAlertCounts();
    renderAlerts();
  }

  function updateAlertCounts() {
    const base = state.hideAcknowledged
      ? state.alerts.filter(a => !a.acknowledged_at)
      : state.alerts;

    setText('alertCountAll', base.length);
    setText('alertCountCritical', base.filter(a => a.severity === 'critical').length);
    setText('alertCountWarning', base.filter(a => a.severity === 'warning').length);
    setText('alertCountInfo', base.filter(a => a.severity === 'info').length);

    // Alerts badge in tab — show unacknowledged count
    const unack = state.alerts.filter(a => !a.acknowledged_at).length;
    setText('alertsBadge', unack);
  }

  // ══════════════════════════════════════
  //  RENDER — Movements Table
  // ══════════════════════════════════════
  function renderMovements() {
    const tbody = document.getElementById('movementsTbody');
    const list = state.filteredMovements;
    const { mvtPage, mvtPageSize } = state;

    const totalPages = Math.max(1, Math.ceil(list.length / mvtPageSize));
    const start = (mvtPage - 1) * mvtPageSize;
    const page = list.slice(start, start + mvtPageSize);

    if (page.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;opacity:.6;padding:32px">
        ${state.movements.length === 0 ? 'No movements recorded yet. Movements will appear here after webhooks or snapshot diffs run.' : 'No movements match the current filters.'}
      </td></tr>`;
    } else {
      tbody.innerHTML = page.map(m => renderMovementRow(m)).join('');
    }

    // Pagination
    setText('movementsTotal', `${list.length} movement${list.length !== 1 ? 's' : ''}`);
    setText('mvtPageInfo', `Page ${mvtPage} / ${totalPages}`);
    document.getElementById('mvtPrevPage').disabled = mvtPage <= 1;
    document.getElementById('mvtNextPage').disabled = mvtPage >= totalPages;
  }

  function renderMovementRow(m) {
    const dateStr = m.detected_at ? fmtDateTime(new Date(m.detected_at)) : '—';
    const typeLabel = getTypeLabel(m.movement_type);
    const typeCls = m.movement_type || '';

    // From → To
    const from = formatLocationBin(m.from_location, m.from_bin);
    const to = formatLocationBin(m.to_location, m.to_bin);
    const direction = from && to
      ? `${from} <span class="direction-arrow">→</span> ${to}`
      : from || to || '—';

    // Quantity
    const qty = m.quantity || 0;
    const qtyClass = qty < 0 ? 'negative' : qty > 0 ? 'positive' : '';
    const qtyStr = qty > 0 ? `+${qty}` : `${qty}`;

    // Reference
    const ref = m.reference_number || '—';

    // Who
    const who = m.sales_rep || m.member_email || m.customer_name || '—';

    // Source badge
    const source = m.source === 'webhook' ? '⚡ Webhook' : m.source === 'snapshot_diff' ? '📸 Snapshot' : m.source || '—';

    // Row class
    let rowClass = '';
    if (m.is_internal) rowClass = 'internal';
    else if (m.is_anomaly) rowClass = 'anomaly';

    // SKU link
    const skuLink = `<a href="#" onclick="window.auditApp.filterByProduct('${esc(m.sku)}');return false" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(m.sku)}</a>`;

    return `<tr class="${rowClass}">
      <td style="white-space:nowrap;font-size:12px;color:#64748b">${dateStr}</td>
      <td><span class="mvmt-badge ${typeCls}">${typeLabel}</span></td>
      <td>${skuLink}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.product_name || '')}">${esc(m.product_name || '—')}</td>
      <td style="font-size:12px">${direction}</td>
      <td style="text-align:center"><span class="qty-badge ${qtyClass}">${qtyStr}</span></td>
      <td style="font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${esc(ref)}">${esc(ref)}</td>
      <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${esc(who)}">${esc(who)}</td>
      <td style="font-size:11px;color:#94a3b8">${source}</td>
    </tr>`;
  }

  // ══════════════════════════════════════
  //  RENDER — Alerts
  // ══════════════════════════════════════
  function renderAlerts() {
    const container = document.getElementById('alertsList');
    const list = state.filteredAlerts;
    const { alertPage, alertPageSize } = state;

    const totalPages = Math.max(1, Math.ceil(list.length / alertPageSize));
    const start = (alertPage - 1) * alertPageSize;
    const page = list.slice(start, start + alertPageSize);

    if (page.length === 0) {
      container.innerHTML = `<div style="text-align:center;opacity:.6;padding:32px">
        ${state.alerts.length === 0 ? 'No alerts yet. Alerts will be created automatically when movement rules trigger.' : 'No alerts match the current filters.'}
      </div>`;
    } else {
      container.innerHTML = page.map(a => renderAlertCard(a)).join('');
    }

    // Pagination
    setText('alertsTotal', `${list.length} alert${list.length !== 1 ? 's' : ''}`);
    setText('alertPageInfo', `Page ${alertPage} / ${totalPages}`);
    document.getElementById('alertPrevPage').disabled = alertPage <= 1;
    document.getElementById('alertNextPage').disabled = alertPage >= totalPages;
  }

  function renderAlertCard(a) {
    const time = a.created_at ? fmtRelative(new Date(a.created_at)) : '—';
    const sevClass = a.severity || 'info';
    const ackClass = a.acknowledged_at ? 'acknowledged' : '';

    // Direction
    const from = a.from_location || '';
    const to = a.to_location || '';
    const directionStr = from && to
      ? `${from} → ${to}`
      : from || to || '';

    // SKU link
    const skuLink = a.sku
      ? `<a href="#" onclick="window.auditApp.filterByProduct('${esc(a.sku)}');return false" style="color:#1d4ed8;text-decoration:none;font-weight:600">${esc(a.sku)}</a>`
      : '';

    const ackBtn = a.acknowledged_at
      ? `<span style="font-size:11px;color:#94a3b8">✓ Acknowledged</span>`
      : `<button class="ack-btn" onclick="window.auditApp.acknowledgeAlert(${a.id})">✓ Acknowledge</button>`;

    return `<div class="alert-card ${sevClass} ${ackClass}">
      <div class="alert-header">
        <span class="severity-badge ${sevClass}">${sevClass}</span>
        <span class="alert-title">${esc(a.title || 'Alert')}</span>
        <span class="alert-time">${time}</span>
        ${ackBtn}
      </div>
      <div class="alert-desc">${esc(a.description || '')}</div>
      <div class="alert-meta">
        ${skuLink ? `<span>📦 ${skuLink}</span>` : ''}
        ${a.movement_type ? `<span>🏷️ ${getTypeLabel(a.movement_type)}</span>` : ''}
        ${directionStr ? `<span>📍 ${esc(directionStr)}</span>` : ''}
        ${a.quantity ? `<span>📊 Qty: ${a.quantity > 0 ? '+' : ''}${a.quantity}</span>` : ''}
        ${a.member_email ? `<span>👤 ${esc(a.member_email)}</span>` : ''}
        ${a.sales_rep ? `<span>👤 ${esc(a.sales_rep)}</span>` : ''}
        ${a.reference_number ? `<span>📄 ${esc(a.reference_number)}</span>` : ''}
      </div>
    </div>`;
  }

  // ══════════════════════════════════════
  //  PRODUCT DETAIL PANEL
  // ══════════════════════════════════════
  async function showProductDetail(sku) {
    const panel = document.getElementById('productDetailPanel');
    const title = document.getElementById('productDetailTitle');
    const stats = document.getElementById('productDetailStats');

    // Get product info
    let productInfo = null;
    try {
      const { data } = await sb.schema('cin7_mirror')
        .from('products')
        .select('sku, name, category, stock_locator')
        .eq('sku', sku)
        .single();
      productInfo = data;
    } catch {}

    // Get current stock levels
    let stockLevels = [];
    try {
      const { data } = await sb.schema('cin7_mirror')
        .from('stock_snapshot')
        .select('location_name, bin, on_hand, available, allocated')
        .eq('sku', sku);
      stockLevels = data || [];
    } catch {}

    // Summary stats from movements
    const mvts = state.movements;
    const totalOut = mvts.filter(m => m.quantity < 0).reduce((s, m) => s + Math.abs(m.quantity), 0);
    const totalIn = mvts.filter(m => m.quantity > 0).reduce((s, m) => s + m.quantity, 0);
    const totalOnHand = stockLevels.reduce((s, r) => s + (r.on_hand || 0), 0);
    const totalAvail = stockLevels.reduce((s, r) => s + (r.available || 0), 0);
    const numSOs = mvts.filter(m => m.movement_type === 'sales_pick' || m.movement_type === 'sales_ship').length;
    const numAlerts = state.alerts.filter(a => !a.acknowledged_at).length;

    const name = productInfo ? productInfo.name : sku;
    const pickface = productInfo ? (productInfo.stock_locator || '—') : '—';

    title.innerHTML = `${esc(sku)} — ${esc(name)} <span style="font-size:12px;color:#94a3b8;font-weight:400">Pickface: ${esc(pickface)}</span>`;

    stats.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">On Hand</div>
        <div class="stat-value">${totalOnHand}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Available</div>
        <div class="stat-value">${totalAvail}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Out</div>
        <div class="stat-value" style="color:#dc2626">-${totalOut}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total In</div>
        <div class="stat-value" style="color:#16a34a">+${totalIn}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Sales Orders</div>
        <div class="stat-value">${numSOs}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Alerts</div>
        <div class="stat-value" ${numAlerts > 0 ? 'style="color:#dc2626"' : ''}>${numAlerts}</div>
      </div>
    `;

    panel.style.display = 'block';
  }

  // ══════════════════════════════════════
  //  ACTIONS
  // ══════════════════════════════════════

  function search() {
    const input = document.getElementById('auditSearch');
    const term = (input.value || '').trim();

    // If it looks like a specific SKU (no spaces, short), do a product filter
    if (term && !term.includes(' ') && term.length <= 30) {
      // Check if it's an exact SKU match
      const exactMatch = state.movements.find(m => (m.sku || '').toUpperCase() === term.toUpperCase());
      if (exactMatch) {
        filterByProduct(exactMatch.sku);
        return;
      }
    }

    state.searchTerm = term;
    state.productFilter = null;
    document.getElementById('productDetailPanel').style.display = 'none';
    applyMovementFilters();
    applyAlertFilters();
  }

  function filterByProduct(sku) {
    state.productFilter = sku;
    state.searchTerm = '';
    document.getElementById('auditSearch').value = sku;
    loadMovements();
    loadAlerts();
  }

  function clearProductFilter() {
    state.productFilter = null;
    state.searchTerm = '';
    document.getElementById('auditSearch').value = '';
    document.getElementById('productDetailPanel').style.display = 'none';
    loadMovements();
    loadAlerts();
  }

  function setTypeFilter(val, el) {
    state.typeFilter = val;

    const container = document.getElementById('movementFilters');
    container.querySelectorAll('.chip[data-type-filter]').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    container.classList.toggle('has-active', val !== 'ALL');

    applyMovementFilters();
  }

  function setAlertFilter(val, el) {
    state.alertFilter = val;

    const container = document.getElementById('alertFilters');
    container.querySelectorAll('.chip[data-alert-filter]').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    container.classList.toggle('has-active', val !== 'ALL');

    applyAlertFilters();
  }

  function toggleHideInternal(v) {
    state.hideInternal = v;
    applyMovementFilters();
  }

  function toggleHideAcknowledged(v) {
    state.hideAcknowledged = v;
    applyAlertFilters();
  }

  function setDateRange() {
    state.dateFrom = document.getElementById('dateFrom').value || null;
    state.dateTo = document.getElementById('dateTo').value || null;
    loadMovements();
  }

  function switchTab(tab, el) {
    state.activeTab = tab;
    document.querySelectorAll('.audit-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById(tab === 'movements' ? 'tabMovements' : 'tabAlerts').classList.add('active');

    // Refresh data for the active tab
    if (tab === 'alerts') loadAlerts();
    else loadMovements();
  }

  // ── Alert actions ──

  async function acknowledgeAlert(alertId) {
    try {
      const { error } = await sb.schema('cin7_mirror')
        .from('movement_alerts')
        .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'user' })
        .eq('id', alertId);

      if (error) { console.error('❌ Acknowledge error:', error.message); return; }

      // Update local state
      const alert = state.alerts.find(a => a.id === alertId);
      if (alert) alert.acknowledged_at = new Date().toISOString();
      applyAlertFilters();
    } catch (e) {
      console.error('❌ Acknowledge exception:', e);
    }
  }

  async function acknowledgeAll() {
    const visibleIds = state.filteredAlerts
      .filter(a => !a.acknowledged_at)
      .map(a => a.id);

    if (visibleIds.length === 0) return;

    try {
      const { error } = await sb.schema('cin7_mirror')
        .from('movement_alerts')
        .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'user' })
        .in('id', visibleIds);

      if (error) { console.error('❌ Bulk acknowledge error:', error.message); return; }

      // Update local
      state.alerts.forEach(a => {
        if (visibleIds.includes(a.id)) a.acknowledged_at = new Date().toISOString();
      });
      applyAlertFilters();
    } catch (e) {
      console.error('❌ Bulk acknowledge exception:', e);
    }
  }

  // ── Pagination ──
  function mvtNextPage() {
    const totalPages = Math.ceil(state.filteredMovements.length / state.mvtPageSize);
    if (state.mvtPage < totalPages) { state.mvtPage++; renderMovements(); }
  }
  function mvtPrevPage() {
    if (state.mvtPage > 1) { state.mvtPage--; renderMovements(); }
  }
  function alertNextPage() {
    const totalPages = Math.ceil(state.filteredAlerts.length / state.alertPageSize);
    if (state.alertPage < totalPages) { state.alertPage++; renderAlerts(); }
  }
  function alertPrevPage() {
    if (state.alertPage > 1) { state.alertPage--; renderAlerts(); }
  }

  // ══════════════════════════════════════
  //  HELPERS
  // ══════════════════════════════════════

  function getTypeLabel(type) {
    const labels = {
      sales_pick: 'Sales Pick',
      sales_ship: 'Sales Ship',
      stock_transfer: 'Transfer',
      bin_transfer: 'Bin↔Bin',
      stock_adjustment: 'Adjustment',
      purchase_receive: 'Purchase',
      snapshot_delta: 'Snapshot Δ',
      assembly: 'Assembly',
    };
    return labels[type] || type || '—';
  }

  function formatLocationBin(location, bin) {
    if (!location && !bin) return '';
    if (!bin) return esc(location);
    if (!location) return esc(bin);
    return `${esc(location)} <span style="color:#94a3b8;font-size:11px">[${esc(bin)}]</span>`;
  }

  function fmtDateTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtDateInput(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fmtRelative(d) {
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function showMovementsError(msg) {
    const tbody = document.getElementById('movementsTbody');
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#dc2626;padding:32px">
      Error loading movements: ${esc(msg)}
    </td></tr>`;
  }

  // ══════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════
  window.auditApp = {
    search,
    filterByProduct,
    clearProductFilter,
    setTypeFilter,
    setAlertFilter,
    toggleHideInternal,
    toggleHideAcknowledged,
    setDateRange,
    switchTab,
    acknowledgeAlert,
    acknowledgeAll,
    mvtNextPage,
    mvtPrevPage,
    alertNextPage,
    alertPrevPage,
  };

  // ── Start ──
  init();
})();
