/* ═══════════════════════════════════════════════════════════════════
   MOVEMENTS TAB — every NON-pick stock movement (transfers incl. to other
   warehouses, bin moves, adjustments, purchase receipts), separate from the
   quick-action sales/assembly view. Reads cin7_mirror.movement_log via
   /api/pick-anomalies/movements. Owned module: window.PAMovements.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  let built = false;
  const $ = id => document.getElementById(id);
  const state = { type: 'all', days: '30', q: '' };

  const esc = s => (s == null ? '' : String(s)).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmtDate = s => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '—');
  // Assembly is quick-action, but expose it here too so the user can inspect
  // component consumption from the movements view → flip the category for it.
  const categoryFor = t => (t === 'assembly_consume' ? 'quick_action' : 'other');

  function setActive(btn) {
    document.querySelectorAll('#pamFilters .chip').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
  }

  function injectStyle() {
    if (document.getElementById('paMovStyle')) return;
    const s = document.createElement('style');
    s.id = 'paMovStyle';
    s.textContent = `
      body.pa-mode-movements #paKpis, body.pa-mode-movements #paProgress { display:none !important; }
      .pa-mov-card { padding: 0; }
      .pa-mov-toolbar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; padding:14px 16px; border-bottom:1px solid var(--border,#e5e7eb); }
      .pa-mov-filters { display:flex; flex-wrap:wrap; gap:6px; }
      .pa-mov-right { display:flex; gap:8px; align-items:center; }
      .pa-mov-days { padding:7px 10px; border:1px solid var(--border,#d1d5db); border-radius:8px; background:var(--bg,#fff); font-size:13px; }
      .pa-mov-summary { display:flex; flex-wrap:wrap; gap:8px; padding:10px 16px; }
      .pa-mov-pill { background:rgba(99,102,241,.1); color:#4338ca; border-radius:999px; padding:3px 10px; font-size:12px; font-weight:500; }
      .pa-mov-table th { position:sticky; top:0; }
      .pa-mov-table td { font-size:13px; padding:8px 12px; white-space:nowrap; }
      .pa-mov-date { color:var(--muted,#6b7280); }
      .pa-mov-type { background:#f3f4f6; border-radius:6px; padding:2px 8px; font-size:12px; font-weight:600; }
      .pa-mov-sku { font-family:ui-monospace,monospace; font-weight:600; }
      .pa-mov-name { color:var(--muted,#6b7280); max-width:280px; overflow:hidden; text-overflow:ellipsis; }
      .pa-mov-ref { font-family:ui-monospace,monospace; color:#4338ca; }
      .pa-mov-pos { color:#059669; font-weight:700; }
      .pa-mov-neg { color:#dc2626; font-weight:700; }
      .pa-mov-loading { text-align:center; color:var(--muted,#6b7280); padding:24px; }
      .pa-mov-foot { padding:10px 16px; color:var(--muted,#6b7280); font-size:12px; border-top:1px solid var(--border,#e5e7eb); }`;
    document.head.appendChild(s);
  }

  function build() {
    if (built) return;
    injectStyle();
    $('paMovements').innerHTML = `
      <div class="log-card pa-mov-card">
        <div class="pa-mov-toolbar">
          <div class="pa-mov-filters" id="pamFilters">
            <button class="chip active" data-mtype="all">All</button>
            <button class="chip" data-mtype="bin_transfer">🔀 Bin transfer</button>
            <button class="chip" data-mtype="stock_transfer">🏬 To warehouse</button>
            <button class="chip" data-mtype="stock_adjustment">✏️ Adjustment</button>
            <button class="chip" data-mtype="purchase_receive">📥 Purchase</button>
            <button class="chip" data-mtype="assembly_consume">🔧 Assembly</button>
          </div>
          <div class="pa-mov-right">
            <input id="pamSearch" class="pa-search-input" placeholder="SKU or reference…" />
            <select id="pamDays" class="pa-mov-days">
              <option value="7">7 days</option>
              <option value="30" selected>30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </div>
        </div>
        <div class="pa-mov-summary" id="pamSummary"></div>
        <div class="table-wrapper">
          <table class="app-table pa-mov-table">
            <thead><tr>
              <th>Date</th><th>Type</th><th>SKU</th><th>Product</th>
              <th style="text-align:right">Qty</th><th>From</th><th>To</th><th>Reference</th>
            </tr></thead>
            <tbody id="pamBody"></tbody>
          </table>
        </div>
        <div class="pa-mov-foot" id="pamFoot"></div>
      </div>`;

    document.querySelectorAll('#pamFilters .chip').forEach(c =>
      c.addEventListener('click', () => { setActive(c); state.type = c.dataset.mtype; load(); }));
    let t;
    $('pamSearch').addEventListener('input', () => {
      clearTimeout(t); t = setTimeout(() => { state.q = $('pamSearch').value.trim(); load(); }, 350);
    });
    $('pamDays').addEventListener('change', () => { state.days = $('pamDays').value; load(); });
    built = true;
  }

  async function load() {
    const body = $('pamBody');
    body.innerHTML = `<tr><td colspan="8" class="pa-mov-loading">Loading…</td></tr>`;
    const p = new URLSearchParams({ category: categoryFor(state.type), days: state.days });
    if (state.type !== 'all') p.set('type', state.type);
    if (state.q) p.set('q', state.q);
    try {
      const res = await fetch('/api/pick-anomalies/movements?' + p.toString());
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'failed');
      render(data);
    } catch (e) {
      body.innerHTML = `<tr><td colspan="8" class="pa-mov-loading">❌ ${esc(e.message)}</td></tr>`;
    }
  }

  function render(data) {
    const rows = data.movements || [];
    $('pamSummary').innerHTML = Object.entries(data.byType || {})
      .map(([k, v]) => `<span class="pa-mov-pill">${esc(k)} <b>${v}</b></span>`).join('')
      || '<span class="pa-mov-pill">No movements in range</span>';
    $('pamFoot').textContent = `${rows.length} movements${rows.length >= 1000 ? ' (capped)' : ''}`;
    $('pamBody').innerHTML = rows.map(m => {
      const qty = Number(m.quantity);
      const qcls = qty < 0 ? 'pa-mov-neg' : 'pa-mov-pos';
      return `<tr>
        <td class="pa-mov-date">${fmtDate(m.detected_at)}</td>
        <td><span class="pa-mov-type">${esc(m.type_label)}</span></td>
        <td class="pa-mov-sku">${esc(m.sku)}</td>
        <td class="pa-mov-name" title="${esc(m.product_name)}">${esc((m.product_name || '').slice(0, 42))}</td>
        <td style="text-align:right" class="${qcls}">${qty > 0 ? '+' : ''}${qty}</td>
        <td>${esc(m.from_bin || m.from_location || '—')}</td>
        <td>${esc(m.to_bin || m.to_location || '—')}</td>
        <td class="pa-mov-ref">${esc(m.reference_number)}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="pa-mov-loading">Nothing here for this filter</td></tr>`;
  }

  window.PAMovements = { open() { build(); load(); } };
})();
