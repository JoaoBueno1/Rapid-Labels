/* ════════════════════════════════════════════════════════════════════
   pa-analytics.js — Redesigned Pick Anomalies Analytics tab (v2)
   Self-contained module. Owns everything inside #paAnalytics.
   - Independent filter bar (date presets / range / granularity / only-fixed)
   - Chart.js charts (standardised on the TMS look)
   - Corrections/Fixes tracking section (who · when · from→to · qty · status · reversed)
   - Export to PNG / PDF (html2canvas + jsPDF), per-card show/hide
   Backend: GET /api/pick-anomalies/analytics-v2  (leaves v1 /analytics untouched)
   Production Orders view is NOT touched — setView() just delegates here.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SCANNER_CUTOFF = '2026-03-26';
  const esc = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; };
  const $ = (id) => document.getElementById(id);

  // Palette — matches the TMS management-reports design language
  const C = {
    navy: '#1B2A3F', accent: '#FF9100', blue: '#3b82f6', teal: '#14b8a6',
    green: '#22c55e', red: '#ef4444', amber: '#f59e0b', purple: '#8b5cf6',
    slate: '#64748b', grid: '#eef2f7',
  };
  const ETYPE = {
    different_area: { label: 'Different Area', color: C.red },
    same_section:   { label: 'Wrong Column',  color: C.amber },
    same_column:    { label: 'Wrong Level',   color: '#eab308' },
    pallet_only:    { label: 'Wrong Pallet',  color: C.green },
    special_loc:    { label: 'Special Loc',   color: C.blue },
    unknown:        { label: 'Unknown',       color: C.slate },
  };

  const state = {
    built: false,
    preset: '90d',
    from: null, to: null,
    granularity: 'auto',   // auto|day|week|month
    onlyFixed: false,
    hidden: {},            // cardId -> true
    charts: {},            // chartId -> Chart instance
    lastData: null,
  };

  /* ───────── date helpers ───────── */
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  function applyPreset(p) {
    state.preset = p;
    const today = todayStr();
    if (p === '7d')  { state.from = addDays(-6);  state.to = today; }
    else if (p === '30d') { state.from = addDays(-29); state.to = today; }
    else if (p === '90d') { state.from = addDays(-89); state.to = today; }
    else if (p === 'month') { const d = new Date(); state.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; state.to = today; }
    else if (p === 'ytd') { state.from = `${new Date().getFullYear()}-01-01`; state.to = today; }
    else if (p === 'all') { state.from = SCANNER_CUTOFF; state.to = today; }
    if (state.from < SCANNER_CUTOFF) state.from = SCANNER_CUTOFF;
  }

  /* ───────── public entry ───────── */
  function open() {
    if (!state.built) build();
    refresh();
  }

  /* ───────── build DOM once ───────── */
  function build() {
    applyPreset('90d');
    const root = $('paAnalytics');
    if (!root) return;
    root.innerHTML = `
      <!-- Toolbar -->
      <div class="pav2-toolbar" id="pav2Toolbar">
        <div class="pav2-presets" id="pav2Presets">
          ${['7d:7D', '30d:30D', '90d:90D', 'month:This Month', 'ytd:YTD', 'all:All'].map(x => {
            const [k, lbl] = x.split(':');
            return `<button class="pav2-chip${k === state.preset ? ' active' : ''}" data-preset="${k}">${lbl}</button>`;
          }).join('')}
        </div>
        <div class="pav2-dates">
          <label>From <input type="date" id="pav2From" value="${state.from}"></label>
          <label>To <input type="date" id="pav2To" value="${state.to}"></label>
        </div>
        <div class="pav2-gran" id="pav2Gran">
          ${['auto:Auto', 'day:Day', 'week:Week', 'month:Month'].map(x => {
            const [k, lbl] = x.split(':');
            return `<button class="pav2-seg${k === state.granularity ? ' active' : ''}" data-gran="${k}">${lbl}</button>`;
          }).join('')}
        </div>
        <label class="pav2-toggle"><input type="checkbox" id="pav2OnlyFixed"> Only fixed</label>
        <div class="pav2-grow"></div>
        <button class="pav2-btn" id="pav2Cards" title="Show / hide cards">⚙ Cards</button>
        <button class="pav2-btn" id="pav2Png" title="Export visible dashboard as PNG">🖼 PNG</button>
        <button class="pav2-btn pav2-btn-accent" id="pav2Pdf" title="Export visible dashboard as PDF">⬇ PDF</button>
        <div class="pav2-cards-menu" id="pav2CardsMenu" style="display:none"></div>
      </div>

      <div class="pav2-loading" id="pav2Loading">⏳ Loading analytics…</div>

      <!-- KPI strip (single line) -->
      <div class="pav2-kpis" id="pav2Kpis"></div>

      <!-- Capture region for export -->
      <div class="pav2-capture" id="pav2Capture">
        <div class="pav2-grid" id="pav2Grid">
          ${card('trend',     '📈 Anomaly Rate Over Time', true,  'canvas')}
          ${card('corrTrend', '🔧 Corrections Over Time',  false, 'canvas')}
          ${card('etypes',    '🎯 Error Type Distribution', false, 'canvas')}
          ${card('etypeTrend','📊 Error Type Trend',        true,  'canvas')}
          ${card('skus',      '🔄 Repeat Offender SKUs',    false, 'canvas')}
          ${card('bins',      '📍 Problem Bins',            false, 'canvas')}
          ${card('customers', '🏢 Anomalies by Customer',   false, 'canvas')}
          ${card('funnel',    '🧭 Review → Fix Funnel',     false, 'html')}
          ${card('sections',  '🗺 Warehouse Section Heatmap', false, 'html')}
          ${card('routes',    '🔁 Repeat Routes (locator errors)', true, 'html')}
          ${card('fixes',     '🛠 Corrections / Fixes Log', true,  'html')}
        </div>
      </div>`;

    // wire events
    $('pav2Presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]'); if (!b) return;
      applyPreset(b.dataset.preset);
      $('pav2From').value = state.from; $('pav2To').value = state.to;
      syncChips(); refresh();
    });
    $('pav2Gran').addEventListener('click', (e) => {
      const b = e.target.closest('[data-gran]'); if (!b) return;
      state.granularity = b.dataset.gran;
      [...$('pav2Gran').children].forEach(c => c.classList.toggle('active', c === b));
      refresh();
    });
    const onDate = () => { state.preset = null; state.from = $('pav2From').value; state.to = $('pav2To').value; syncChips(); refresh(); };
    $('pav2From').addEventListener('change', onDate);
    $('pav2To').addEventListener('change', onDate);
    $('pav2OnlyFixed').addEventListener('change', (e) => { state.onlyFixed = e.target.checked; refresh(); });
    $('pav2Cards').addEventListener('click', toggleCardsMenu);
    $('pav2Png').addEventListener('click', () => exportImage('png'));
    $('pav2Pdf').addEventListener('click', () => exportImage('pdf'));

    state.built = true;
  }

  function card(id, title, wide, kind) {
    return `<div class="pav2-card${wide ? ' pav2-wide' : ''}" id="pav2card-${id}" data-card="${id}">
      <div class="pav2-card-head"><span class="pav2-card-title">${title}</span>
        <button class="pav2-eye" data-hide="${id}" title="Hide this card">✕</button></div>
      <div class="pav2-card-body">${kind === 'canvas' ? `<canvas id="pav2cv-${id}"></canvas>` : `<div id="pav2html-${id}"></div>`}</div>
    </div>`;
  }

  function syncChips() {
    [...$('pav2Presets').children].forEach(c => c.classList.toggle('active', c.dataset.preset === state.preset));
  }

  /* ───────── cards show/hide menu ───────── */
  const CARD_TITLES = {
    trend: 'Anomaly Rate Over Time', corrTrend: 'Corrections Over Time', etypes: 'Error Type Distribution',
    etypeTrend: 'Error Type Trend', skus: 'Repeat Offender SKUs', bins: 'Problem Bins',
    customers: 'Anomalies by Customer', funnel: 'Review → Fix Funnel', sections: 'Section Heatmap',
    routes: 'Repeat Routes', fixes: 'Corrections / Fixes Log',
  };
  function toggleCardsMenu() {
    const m = $('pav2CardsMenu');
    if (m.style.display !== 'none') { m.style.display = 'none'; return; }
    m.innerHTML = Object.entries(CARD_TITLES).map(([id, t]) =>
      `<label><input type="checkbox" data-show="${id}" ${state.hidden[id] ? '' : 'checked'}> ${t}</label>`).join('');
    m.querySelectorAll('input[data-show]').forEach(cb => cb.addEventListener('change', (e) => {
      const id = e.target.dataset.show; state.hidden[id] = !e.target.checked;
      applyHidden();
    }));
    m.style.display = '';
  }
  function applyHidden() {
    Object.keys(CARD_TITLES).forEach(id => {
      const el = $(`pav2card-${id}`); if (el) el.style.display = state.hidden[id] ? 'none' : '';
    });
  }

  /* ───────── fetch + render ───────── */
  async function refresh() {
    const loading = $('pav2Loading'); if (loading) loading.style.display = '';
    const qs = new URLSearchParams({ from: state.from, to: state.to });
    if (state.granularity !== 'auto') qs.set('granularity', state.granularity);
    if (state.onlyFixed) qs.set('onlyFixed', '1');
    try {
      const res = await fetch('/api/pick-anomalies/analytics-v2?' + qs.toString());
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'failed');
      state.lastData = data;
      renderAll(data.analytics, data.meta);
    } catch (err) {
      console.error('analytics-v2 load error', err);
      if (loading) { loading.style.display = ''; loading.textContent = '❌ Failed to load: ' + err.message; }
      return;
    }
    if (loading) loading.style.display = 'none';
    applyHidden();
  }

  function renderAll(a, meta) {
    renderKpis(a.summary, meta);
    renderTrend(a.timeSeries, meta);
    renderCorrTrend(a.corrections.trend);
    renderEtypes(a.errorTypes);
    renderEtypeTrend(a.errorTypeTrend, a.errorTypeKeys);
    renderBarList('skus', a.topSkus, 'sku', C.blue);
    renderBarList('bins', a.topBins, 'bin', C.purple);
    renderBarList('customers', a.byCustomer, 'customer', C.teal);
    renderFunnel(a.reviewFunnel);
    renderSections(a.sectionHeatmap);
    renderRoutes(a.repeatRoutes);
    renderFixes(a.corrections.list, a.summary);
  }

  /* ───────── KPIs (compact single line) ───────── */
  function renderKpis(s, meta) {
    const rateColor = s.anomalyRate > 10 ? C.red : s.anomalyRate > 5 ? C.amber : C.green;
    const items = [
      { v: s.anomalyRate + '%', l: 'Anomaly Rate', c: rateColor },
      { v: fmt(s.totalAnomalies), l: 'Anomalies', c: C.navy },
      { v: fmt(s.totalOrders), l: 'Orders', c: C.navy },
      { v: fmt(s.anomalyOrders), l: 'Anomaly Orders', c: C.navy },
      { v: s.reviewRate + '%', l: 'Reviewed', c: C.blue },
      { v: fmt(s.fixesNet), l: 'Fixes (net)', c: C.teal },
      { v: s.fixRate + '%', l: 'Fix Rate', c: C.green },
      { v: fmt(s.fixesReversed), l: 'Reversed', c: s.fixesReversed > 0 ? C.amber : C.slate },
      { v: fmt(s.conflictCount), l: 'Cancel Conflicts', c: s.conflictCount > 0 ? C.red : C.slate },
      { v: s.avgReviewLagDays == null ? '—' : s.avgReviewLagDays + 'd', l: 'Avg Review Lag', c: C.slate },
    ];
    $('pav2Kpis').innerHTML = items.map(k =>
      `<div class="pav2-kpi" style="border-left-color:${k.c}">
        <span class="pav2-kpi-v" style="color:${k.c}">${k.v}</span>
        <span class="pav2-kpi-l">${k.l}</span>
      </div>`).join('') +
      `<div class="pav2-range-note">${meta.from} → ${meta.to} · ${meta.granularity} buckets${state.onlyFixed ? ' · only fixed' : ''}</div>`;
  }
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-AU'));

  /* ───────── Chart.js helpers ───────── */
  function chart(id, cfg) {
    const cv = $('pav2cv-' + id); if (!cv) return;
    if (state.charts[id]) state.charts[id].destroy();
    Chart.defaults.font.family = "'Inter','Segoe UI',sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = C.slate;
    state.charts[id] = new Chart(cv.getContext('2d'), cfg);
  }
  const noGridX = { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } };
  const yGrid = { grid: { color: C.grid }, beginAtZero: true };

  function renderTrend(ts, meta) {
    const labels = ts.map(t => t.bucket);
    chart('trend', {
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Anomaly rate %', data: ts.map(t => t.rate), yAxisID: 'y',
            borderColor: C.red, backgroundColor: 'rgba(239,68,68,.08)', fill: true, tension: .3,
            pointRadius: ts.length > 40 ? 0 : 3, borderWidth: 2, order: 0 },
          { type: 'bar', label: 'Picks', data: ts.map(t => t.picks), yAxisID: 'y1',
            backgroundColor: 'rgba(59,130,246,.25)', order: 1 },
        ],
      },
      options: baseOpts({
        scales: {
          x: noGridX,
          y: { ...yGrid, position: 'left', title: { display: true, text: 'Anomaly %' }, suggestedMax: Math.max(...ts.map(t => t.rate), 5) },
          y1: { ...yGrid, position: 'right', grid: { display: false }, title: { display: true, text: 'Pick volume' } },
        },
      }),
    });
  }

  function renderCorrTrend(trend) {
    const labels = trend.map(t => t.bucket);
    chart('corrTrend', {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Applied', data: trend.map(t => t.applied - t.reversed), backgroundColor: C.green, stack: 's' },
          { label: 'Reversed', data: trend.map(t => t.reversed), backgroundColor: C.amber, stack: 's' },
        ],
      },
      options: baseOpts({ scales: { x: { ...noGridX, stacked: true }, y: { ...yGrid, stacked: true } } }),
    });
  }

  function renderEtypes(types) {
    chart('etypes', {
      type: 'bar',
      data: {
        labels: types.map(t => (ETYPE[t.type] || { label: t.type }).label),
        datasets: [{ label: 'Anomalies', data: types.map(t => t.count),
          backgroundColor: types.map(t => (ETYPE[t.type] || { color: C.slate }).color) }],
      },
      options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false } },
        scales: { x: yGrid, y: { grid: { display: false } } } }),
    });
  }

  function renderEtypeTrend(trend, keys) {
    const labels = trend.map(t => t.bucket);
    chart('etypeTrend', {
      type: 'line',
      data: {
        labels,
        datasets: (keys || []).map(k => ({
          label: (ETYPE[k] || { label: k }).label, data: trend.map(t => t[k] || 0),
          borderColor: (ETYPE[k] || { color: C.slate }).color,
          backgroundColor: (ETYPE[k] || { color: C.slate }).color + '33',
          fill: true, tension: .3, pointRadius: 0, borderWidth: 1.5,
        })),
      },
      options: baseOpts({ scales: { x: { ...noGridX, stacked: true }, y: { ...yGrid, stacked: true } } }),
    });
  }

  function renderBarList(id, items, key, color) {
    const html = $('pav2html-' + id);
    if (!items || !items.length) { if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; } return; }
    chart(id, {
      type: 'bar',
      data: { labels: items.map(i => i[key]), datasets: [{ label: 'Count', data: items.map(i => i.count), backgroundColor: color }] },
      options: baseOpts({ indexAxis: 'y', plugins: { legend: { display: false } },
        scales: { x: yGrid, y: { grid: { display: false }, ticks: { autoSkip: false, font: { size: 10 } } } } }),
    });
  }

  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, padding: 8 } } },
    }, extra);
  }

  /* ───────── HTML cards ───────── */
  function renderFunnel(f) {
    const stages = [
      { l: 'Anomaly orders', v: f.anomalyOrders, c: C.navy },
      { l: 'Reviewed', v: f.reviewed, c: C.blue },
      { l: 'Fixed (transfer created)', v: f.fixed, c: C.green },
      { l: 'Reversed', v: f.reversed, c: C.amber },
    ];
    const max = Math.max(f.anomalyOrders, 1);
    $('pav2html-funnel').innerHTML = stages.map(s => {
      const pct = Math.round((s.v / max) * 100);
      return `<div class="pav2-funnel-row">
        <span class="pav2-funnel-l">${s.l}</span>
        <div class="pav2-funnel-bar"><div style="width:${pct}%;background:${s.c}"></div></div>
        <span class="pav2-funnel-v">${fmt(s.v)} <em>${pct}%</em></span>
      </div>`;
    }).join('');
  }

  function renderSections(sections) {
    const el = $('pav2html-sections');
    if (!sections.length) { el.innerHTML = '<div class="pav2-empty">No data</div>'; return; }
    const max = sections[0].count;
    const all = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    const map = {}; sections.forEach(s => map[s.section] = s.count);
    el.innerHTML = `<div class="pav2-heat">${all.map(sec => {
      const n = map[sec] || 0, i = max ? n / max : 0;
      const bg = n === 0 ? '#f1f5f9' : i > 0.7 ? C.red : i > 0.4 ? C.amber : i > 0.15 ? '#fbbf24' : '#86efac';
      const fg = i > 0.4 ? '#fff' : C.navy;
      return `<div class="pav2-heat-cell" style="background:${bg};color:${fg}" title="Section ${sec}: ${n}"><b>${sec}</b><span>${n}</span></div>`;
    }).join('')}</div>`;
  }

  function renderRoutes(routes) {
    const el = $('pav2html-routes');
    if (!routes.length) { el.innerHTML = '<div class="pav2-empty">No repeat routes — great! 🎉</div>'; return; }
    el.innerHTML = `<table class="pav2-table"><thead><tr><th>#</th><th>Expected (FROM)</th><th>→</th><th>Picked (TO)</th><th>SKUs</th></tr></thead><tbody>
      ${routes.map(r => `<tr class="${r.count >= 4 ? 'pav2-crit' : ''}">
        <td><b>${r.count}×</b></td><td><code>${esc(r.from)}</code></td><td>→</td><td><code>${esc(r.to)}</code></td>
        <td>${r.skus.map(esc).join(', ')}</td></tr>`).join('')}
      </tbody></table>`;
  }

  function renderFixes(list, s) {
    const el = $('pav2html-fixes');
    const head = `<div class="pav2-fixes-summary">
      <span><b>${fmt(s.fixesApplied)}</b> applied</span>
      <span><b>${fmt(s.fixesReversed)}</b> reversed</span>
      <span><b>${fmt(s.fixesNet)}</b> net</span>
      <span><b>${s.fixRate}%</b> fix rate</span>
      <span><b>${fmt(s.fixedOrders)}</b> orders fixed</span></div>`;
    if (!list.length) { el.innerHTML = head + '<div class="pav2-empty">No corrections in this period</div>'; return; }
    el.innerHTML = head + `<table class="pav2-table"><thead><tr>
      <th>When</th><th>Order</th><th>SKU</th><th>From → To</th><th>Qty</th><th>Transfer</th><th>Status</th></tr></thead><tbody>
      ${list.map(c => `<tr class="${c.is_reversed ? 'pav2-reversed' : ''}">
        <td>${fmtDT(c.corrected_at)}</td><td>${esc(c.order_number)}</td><td>${esc(c.sku)}</td>
        <td><code>${esc(c.from)}</code> → <code>${esc(c.to)}</code></td><td>${esc(c.qty)}</td>
        <td>${esc(c.ref || '—')}</td>
        <td>${c.is_reversed ? '<span class="pav2-pill pav2-pill-rev">↩ reversed</span>'
          : `<span class="pav2-pill pav2-pill-${(c.status || '').toLowerCase() === 'completed' ? 'ok' : 'draft'}">${esc(c.status || 'draft')}</span>`}</td>
      </tr>`).join('')}
      </tbody></table>`;
  }
  const fmtDT = (iso) => { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }); };

  /* ───────── export PNG / PDF ───────── */
  async function exportImage(kind) {
    const region = $('pav2Capture');
    if (!window.html2canvas || !region) { alert('Export library not loaded'); return; }
    const btn = kind === 'pdf' ? $('pav2Pdf') : $('pav2Png');
    const prev = btn.textContent; btn.textContent = '…'; btn.disabled = true;
    try {
      const canvas = await window.html2canvas(region, { scale: 2, backgroundColor: '#f8fafc', useCORS: true, logging: false });
      const stamp = `${state.from}_${state.to}`;
      if (kind === 'png') {
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png'); a.download = `pick-anomalies_${stamp}.png`; a.click();
      } else {
        const jsPDF = window.jspdf && window.jspdf.jsPDF;
        if (!jsPDF) { alert('jsPDF not loaded'); return; }
        const img = canvas.toDataURL('image/png');
        const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        const iw = pw, ih = canvas.height * (pw / canvas.width);
        // Paginate the tall capture across A4-landscape pages via negative Y offset.
        let heightLeft = ih, position = 0, page = 0;
        while (heightLeft > 0) {
          if (page > 0) pdf.addPage('a4', 'landscape');
          pdf.addImage(img, 'PNG', 0, position, iw, ih, undefined, 'FAST');
          heightLeft -= ph; position -= ph; page++;
        }
        pdf.save(`pick-anomalies_${stamp}.pdf`);
      }
    } catch (e) {
      console.error('export error', e); alert('Export failed: ' + e.message);
    } finally {
      btn.textContent = prev; btn.disabled = false;
    }
  }

  window.PAAnalytics = { open, refresh };
})();
