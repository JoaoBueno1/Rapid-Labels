/* Branch Replenishment — app (Phase 0: live read-only grid + engine suggestions + settings).
 * Reuses window.ReplenishmentConfig (the tuned engine) and reads live cin7_mirror + the
 * branch averages. No writes yet — QTY shows the engine's suggested send; editing / approve /
 * place-order come in later phases. Design = Stock Planning (planning.css linked). */
'use strict';
(function () {
  const RC = window.ReplenishmentConfig;
  const $ = id => document.getElementById(id);
  const sb = () => window.supabase;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = v => (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString('en-AU');
  const n1 = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-AU', { minimumFractionDigits: 1 });
  const toast = (m, bad) => { const t = $('toast'); t.textContent = m; t.className = 'sp-toast show' + (bad ? ' bad' : ''); setTimeout(() => t.className = 'sp-toast', 2600); };

  // ── settings (localStorage) ──────────────────────────────────────────
  const DEFAULTS = { weeks: 6, cutDays: 25, abc: true, avgSource: 'rep_then_branch', period: 'stored', avgRound: 'pure', cartons: false };
  let SET = load();
  function load() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rp.set') || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function save() { try { localStorage.setItem('rp.set', JSON.stringify(SET)); } catch (_) {} }

  // ── state ────────────────────────────────────────────────────────────
  const S = { avg: [], avgBy: {}, ranks: null, stock: {}, prod: {}, loaded: false, branch: null, rows: [] };
  const BRANCHES = RC.BRANCHES;                     // 7 branches, codes + avg fields
  const VARIANT = { MEL: true, HBA: true };         // extra SYD Stock column (Sydney re-route)

  const locBucket = name => {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('main')) return 'MAIN'; if (n.startsWith('gateway')) return 'GATEWAY';
    if (n.startsWith('sydney')) return 'SYD'; if (n.startsWith('melbourne')) return 'MEL';
    if (n.startsWith('brisbane')) return 'BNE'; if (n.startsWith('cairns')) return 'CNS';
    if (n.startsWith('coffs')) return 'CFS'; if (n.startsWith('hobart')) return 'HBA';
    if (n.startsWith('sunshine')) return 'SCS'; return null;   // Project/Quarantine → skip
  };

  // paginate past PostgREST's 1000-row cap
  async function fetchAll(from, sel, opts) {
    let out = [], i = 0;
    for (;;) {
      let q = (opts && opts.schema ? sb().schema(opts.schema) : sb()).from(from).select(sel).range(i, i + 999);
      const { data, error } = await q;
      if (error) throw error;
      out = out.concat(data || []);
      if (!data || data.length < 1000) break; i += 1000;
    }
    return out;
  }

  async function loadBase() {
    setStatus('loading', 'Loading live stock & averages…');
    const [avg, stock, prod] = await Promise.all([
      fetchAll('branch_avg_monthly_sales', '*'),
      fetchAll('stock_snapshot', 'sku,location_name,available,in_transit', { schema: 'cin7_mirror' }),
      fetchAll('products', 'sku,attribute1,name,stock_locator,carton_quantity', { schema: 'cin7_mirror' }),
    ]);
    S.avg = avg;
    S.avgBy = {}; avg.forEach(r => { if (r.product) S.avgBy[String(r.product).toUpperCase()] = r; });
    S.prod = {}; prod.forEach(p => { if (p.sku) S.prod[String(p.sku).toUpperCase()] = p; });
    // bucket available + in_transit per (bucket, sku)
    const buckets = {}; const inT = {};
    for (const r of stock) {
      const b = locBucket(r.location_name); if (!b || !r.sku) continue;
      const k = String(r.sku).toUpperCase();
      (buckets[b] || (buckets[b] = {}));
      buckets[b][k] = (buckets[b][k] || 0) + (Number(r.available) || 0);
      inT[k] = (inT[k] || 0) + (Number(r.in_transit) || 0);
    }
    S.stock = buckets; S.inT = inT;
    S.ranks = RC.computeAbcRanks(avg);
    S.loaded = true;
    setStatus('fresh', `Live · ${n0(stock.length)} stock rows · ${n0(avg.length)} SKUs with averages`);
  }

  function setStatus(level, text) {
    const d = $('statusDot'); if (d) d.className = 'sp-dot ' + (level === 'loading' ? 'stale' : level === 'bad' ? 'dead' : 'fresh');
    if ($('statusText')) $('statusText').textContent = text;
  }

  // ── average pick honouring the settings ──────────────────────────────
  function pickAvg(avgRow, branch) {
    if (!avgRow) return 0;
    const rep = Number(avgRow[branch.avgRepField] || 0);
    const whs = Number(avgRow[branch.avgField] || 0);
    let v;
    switch (SET.avgSource) {
      case 'branch': v = whs; break;
      case 'rep': v = rep; break;
      case 'both_max': v = Math.max(rep, whs); break;
      case 'both_sum': v = rep + whs; break;
      case 'both_avg': v = (rep && whs) ? (rep + whs) / 2 : (rep || whs); break;
      default: v = rep > 0 ? rep : whs;            // rep_then_branch (engine default)
    }
    if (SET.avgRound === 'nearest') v = Math.round(v);
    else if (SET.avgRound === 'up') v = Math.ceil(v);
    else if (SET.avgRound === 'down') v = Math.floor(v);
    return v;
  }

  // ── compute a branch's rows ──────────────────────────────────────────
  function computeBranch(code) {
    const branch = BRANCHES.find(b => b.code === code); if (!branch) return [];
    const stock = S.stock[code] || {};
    const mainOnly = S.stock.MAIN || {};
    const mainGwMap = k => (S.stock.MAIN && S.stock.MAIN[k] || 0) + (S.stock.GATEWAY && S.stock.GATEWAY[k] || 0);
    const sydMap = S.stock.SYD || {};
    const rows = [];
    // universe = SKUs that have an average for this branch (that is what the branch sells)
    for (const r of S.avg) {
      const code0 = String(r.product || '').trim(); if (!code0) continue;
      const k = code0.toUpperCase();
      const p = S.prod[k] || {};
      if (RC.isExcludedProduct(code0, p.name)) continue;
      const avg = pickAvg(r, branch);
      if (avg <= 0) continue;
      const avail = Number(stock[k] || 0);          // branch available (can be negative)
      const inTransit = Number((S.inT && S.inT[k]) || 0);
      const mainGw = mainGwMap(k);
      const tier = (S.ranks && S.ranks.get(code0)) || 'C';
      const weeks = SET.abc ? RC.targetWeeksForTier(tier) : SET.weeks;
      const target = RC.computeBranchTarget(avg, weeks);
      const mainSafety = RC.computeMainSafety(RC.pickMainAvg(r));
      const canSend = Math.max(0, mainGw - mainSafety);
      let sug = Math.max(0, target - avail - inTransit);
      if (SET.cartons && p.carton_quantity) sug = RC.smartCartonRound(sug, p.carton_quantity, canSend, target, { avgMonthBranch: avg, branchAvailable: avail, targetWeeks: weeks }).qty;
      sug = Math.min(sug, canSend);
      const coverDays = avg > 0 ? Math.round((avail + inTransit) / (avg / RC.WEEKS_IN_MONTH) * 7) : 999;
      rows.push({
        code: code0, dc: p.attribute1 || '', name: p.name || '', ctn: p.carton_quantity || '',
        loc: p.stock_locator || '', avg, soh: avail, main: Number(mainOnly[k] || 0), mainGw,
        syd: Number(sydMap[k] || 0), tier, target, canSend, inTransit, coverDays, sug,
        isSuggested: (avg > 0 && canSend > 0 && sug > 0 && coverDays < SET.cutDays),
      });
    }
    // suggestions first (by urgency), then the rest
    rows.sort((a, b) => (b.isSuggested - a.isSuggested) || (a.coverDays - b.coverDays) || (b.sug - a.sug));
    return rows;
  }

  // ── render: landing ──────────────────────────────────────────────────
  function renderLanding() {
    $('branchLanding').style.display = ''; $('branchGrid').style.display = 'none';
    const tiles = BRANCHES.map(b => {
      const rows = S.loaded ? computeBranch(b.code) : [];
      const sug = rows.filter(r => r.isSuggested).length;
      const cls = sug > 40 ? 'bad' : sug > 15 ? 'warn' : 'good';
      return `<div class="sp-tile ${cls}" data-code="${b.code}" role="button" tabindex="0">
        <span>${esc(b.name)}</span><b>${sug}</b>
        <div class="rp-tile-sub">SKUs to restock (cover &lt; ${SET.cutDays}d)</div>
        ${VARIANT[b.code] ? '<span class="rp-tile-var">+ Sydney re-route</span>' : ''}
      </div>`;
    }).join('');
    $('branchTiles').innerHTML = tiles;
    $('landingNote').textContent = `${BRANCHES.length} branches · engine target ${SET.abc ? 'ABC (A10·B8·C6 wk)' : SET.weeks + ' wk'}`;
    $('branchTiles').querySelectorAll('.sp-tile').forEach(t => {
      const go = () => openBranch(t.dataset.code);
      t.addEventListener('click', go);
      t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  // ── render: branch grid ──────────────────────────────────────────────
  let _filter = { q: '', suggested: true, yellow: false };
  function openBranch(code) {
    const branch = BRANCHES.find(b => b.code === code); if (!branch) return;
    S.branch = branch; S.rows = computeBranch(code);
    $('branchLanding').style.display = 'none'; $('branchGrid').style.display = '';
    $('gridTitle').textContent = branch.name + ' — transfer plan';
    $('gridScope').textContent = `Main+Gateway is the send pool · ${SET.abc ? 'ABC tiers' : SET.weeks + '-week target'} · avg: ${SET.avgSource.replace(/_/g, ' ')}`;
    renderGrid();
  }
  function cols() {
    const c = [
      ['tier', '', 'rp-tag', 26], ['dc', '5DC', 'n', 54], ['code', 'Rapid Code', '', 128], ['name', 'Product', '', 250],
      ['ctn', 'Ctn', 'n', 42], ['qty', 'QTY', 'n rp-qty', 54], ['loc', 'Location', '', 106],
      ['avg', 'Mthly Avg', 'n', 78], ['soh', 'SOH', 'n', 58], ['cover', 'Cover', 'n', 78], ['main', 'Main', 'n', 66],
    ];
    if (VARIANT[S.branch.code]) c.push(['syd', 'SYD Stock', 'n', 74]);
    c.push(['comments', 'Comments', '', 150], ['inv', 'Inventory', '', 150]);
    return c;
  }
  function renderGrid() {
    const C = cols();
    let rows = S.rows.slice();
    if (_filter.suggested) rows = rows.filter(r => r.isSuggested);
    if (_filter.yellow) rows = rows.filter(r => coverMonths(r) > 1.5);
    if (_filter.q) { const q = _filter.q.toLowerCase(); rows = rows.filter(r => (r.code + ' ' + r.name + ' ' + r.dc).toLowerCase().includes(q)); }
    const head = '<thead><tr>' + C.map(c => `<th class="${c[1] === '' ? '' : (c[2].includes('n') ? 'n' : '')}" style="width:${c[3]}px">${c[1]}</th>`).join('') + '</tr></thead>';
    const body = rows.map(r => {
      const cm = coverMonths(r);
      const trc = cm > 1.5 ? 'rp-yellow' : (r.soh < 0 ? 'rp-neg' : '');
      return `<tr class="${trc}">` + C.map(c => cell(r, c, cm)).join('') + '</tr>';
    }).join('') || `<tr><td colspan="${C.length}" class="sp-empty">No lines match.</td></tr>`;
    $('rpGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
    $('gridCount').textContent = `${rows.length} lines${_filter.suggested ? ' · suggested' : ''}`;
  }
  function coverMonths(r) { return r.avg > 0 ? (r.soh + (r.qtyOverride != null ? r.qtyOverride : r.sug)) / r.avg : 0; }
  function cell(r, c, cm) {
    const key = c[0]; const cls = c[2] || '';
    if (key === 'tier') return `<td class="rp-tag"><span class="rp-tier ${r.tier}">${r.tier}</span></td>`;
    if (key === 'qty') return `<td class="${cls}">${n0(r.qtyOverride != null ? r.qtyOverride : r.sug)}</td>`;
    if (key === 'cover') { const days = r.coverDays >= 999 ? '∞' : r.coverDays + 'd'; return `<td class="n" title="${n1(cm)} months">${n1(cm)} mo <small class="rp-sub">${days}</small></td>`; }
    if (key === 'avg') return `<td class="n">${n1(r.avg)}</td>`;
    if (key === 'soh') return `<td class="n">${n0(r.soh)}${r.inTransit ? ` <small class="rp-sub">+${n0(r.inTransit)} in transit</small>` : ''}</td>`;
    if (key === 'main') return `<td class="n" title="Main only. Main+Gateway sendable: ${n0(r.canSend)}">${n0(r.main)}</td>`;
    if (key === 'syd') return `<td class="n">${n0(r.syd)}</td>`;
    if (key === 'name') return `<td>${esc(String(r.name).slice(0, 46))}</td>`;
    if (key === 'comments' || key === 'inv') return `<td class="rp-sub" style="color:#b6c0cf">—</td>`;
    return `<td class="${cls}">${esc(r[key] === '' || r[key] == null ? '—' : r[key])}</td>`;
  }

  // ── averages view (consultative) ─────────────────────────────────────
  function renderAverages() {
    const q = ($('avSearch').value || '').toLowerCase();
    const bf = $('avBranch').value;
    const nz = $('avNonZero').classList.contains('is-on');
    const C = [['code', 'Rapid Code', 128], ['name', 'Product', 240]].concat(BRANCHES.map(b => [b.code, b.name, 90]));
    let rows = S.avg.slice();
    if (q) rows = rows.filter(r => String(r.product || '').toLowerCase().includes(q));
    rows = rows.map(r => {
      const p = S.prod[String(r.product || '').toUpperCase()] || {};
      const vals = {}; BRANCHES.forEach(b => { vals[b.code] = pickAvg(r, b); });
      return { code: r.product, name: p.name || '', vals };
    });
    if (nz) rows = rows.filter(r => BRANCHES.some(b => r.vals[b.code] > 0));
    if (bf) rows = rows.filter(r => r.vals[bf] > 0);
    rows = rows.slice(0, 600);
    const head = '<thead><tr>' + C.map(c => `<th class="${c[0] === 'code' || c[0] === 'name' ? '' : 'n'}" style="width:${c[2]}px">${c[1]}</th>`).join('') + '</tr></thead>';
    const body = rows.map(r => '<tr><td>' + esc(r.code) + '</td><td>' + esc(String(r.name).slice(0, 44)) + '</td>' +
      BRANCHES.map(b => `<td class="n">${r.vals[b.code] > 0 ? n1(r.vals[b.code]) : '<span style="color:#c3ccda">·</span>'}</td>`).join('') + '</tr>').join('');
    $('avGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
    $('avCount').textContent = `${rows.length} shown`;
  }

  // ── settings modal ───────────────────────────────────────────────────
  function openSettings() {
    $('setWeeks').value = SET.weeks; $('setDays').value = Math.round(SET.weeks * 7) + ' days';
    $('setCutDays').value = SET.cutDays; $('setAbc').checked = SET.abc;
    $('setAvgSource').value = SET.avgSource; $('setPeriod').value = SET.period;
    $('setAvgRound').value = SET.avgRound; $('setCartons').checked = SET.cartons;
    // averages-in-use mini table (network total per branch, top movers)
    const rows = S.avg.map(r => ({ code: r.product, tot: BRANCHES.reduce((s, b) => s + pickAvg(r, b), 0) }))
      .filter(r => r.tot > 0).sort((a, b) => b.tot - a.tot).slice(0, 60);
    $('setAvgTable').innerHTML = '<thead><tr><th>Rapid Code</th><th class="n">Tier</th><th class="n">Network avg/mo</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td>${esc(r.code)}</td><td class="n"><span class="rp-tier ${(S.ranks && S.ranks.get(r.code)) || 'C'}">${(S.ranks && S.ranks.get(r.code)) || 'C'}</span></td><td class="n">${n1(r.tot)}</td></tr>`).join('') + '</tbody>';
    $('mdSettings').classList.add('is-on');
  }
  $('setWeeks') && $('setWeeks').addEventListener('input', e => { $('setDays').value = Math.round((Number(e.target.value) || 0) * 7) + ' days'; });
  function applySettings() {
    SET.weeks = Math.max(1, Number($('setWeeks').value) || 6);
    SET.cutDays = Math.max(1, Number($('setCutDays').value) || 25);
    SET.abc = $('setAbc').checked; SET.avgSource = $('setAvgSource').value; SET.period = $('setPeriod').value;
    SET.avgRound = $('setAvgRound').value; SET.cartons = $('setCartons').checked;
    save(); $('mdSettings').classList.remove('is-on');
    // recompute everything
    if (S.branch) { S.rows = computeBranch(S.branch.code); renderGrid(); } renderLanding();
    toast('Settings applied — suggestions recomputed');
  }

  // ── tabs / wiring ────────────────────────────────────────────────────
  function showView(v) {
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === v));
    document.querySelectorAll('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === v));
    if (v === 'averages') { $('avBranch').innerHTML = '<option value="">All branches</option>' + BRANCHES.map(b => `<option value="${b.code}">${b.name}</option>`).join(''); renderAverages(); }
  }
  function wire() {
    document.querySelectorAll('.sp-tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('btnBack').addEventListener('click', renderLanding);
    $('btnSettings').addEventListener('click', openSettings);
    $('setApply').addEventListener('click', applySettings);
    $('setReset').addEventListener('click', () => { SET = Object.assign({}, DEFAULTS); openSettings(); });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('mdSettings').classList.remove('is-on')));
    $('gridSearch').addEventListener('input', e => { _filter.q = e.target.value; renderGrid(); });
    $('chipSuggested').addEventListener('click', function () { this.classList.toggle('is-on'); _filter.suggested = this.classList.contains('is-on'); renderGrid(); });
    $('chipYellow').addEventListener('click', function () { this.classList.toggle('is-on'); _filter.yellow = this.classList.contains('is-on'); renderGrid(); });
    $('btnSuggest').addEventListener('click', () => { _filter.suggested = true; $('chipSuggested').classList.add('is-on'); renderGrid(); toast('Showing the engine coverage suggestions'); });
    ['avSearch', 'avBranch'].forEach(id => $(id).addEventListener('input', renderAverages));
    $('avNonZero').addEventListener('click', function () { this.classList.toggle('is-on'); renderAverages(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $('mdSettings').classList.remove('is-on'); });
  }

  (async function init() {
    try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
    if (!sb() || !RC) { setStatus('bad', 'Supabase or engine not available'); return; }
    wire();
    try { await loadBase(); renderLanding(); }
    catch (e) { console.error(e); setStatus('bad', 'Load failed: ' + e.message); toast('Load failed: ' + e.message, true); }
  })();
})();
