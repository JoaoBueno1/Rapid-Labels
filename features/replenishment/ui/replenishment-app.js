/* Branch Replenishment — app (P1 clarity rebuild + P2 gate / manual / stage).
 *
 * Reuses window.ReplenishmentConfig (the tuned engine) and reads live cin7_mirror +
 * branch averages. Two order types per branch:
 *   • Weekly replenishment — engine suggestions OR manual; branch asks → inventory team
 *     confirms → approve. Inv Qty unlocks at "Ready to check".
 *   • Daily / urgent — no suggestions; up to 12 items + reason; no branch ready-to-check.
 * Draft state persists in localStorage. Place-order (Cin7 write) is NOT built yet.
 * Design = Stock Planning (planning.css linked). */
'use strict';
(function () {
  const RC = window.ReplenishmentConfig;
  const $ = id => document.getElementById(id);
  const sb = () => window.supabase;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = v => (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString('en-AU');
  const n1 = v => (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-AU', { minimumFractionDigits: 1 });
  const toast = (m, bad) => { const t = $('toast'); t.textContent = m; t.className = 'sp-toast is-on' + (bad ? ' bad' : ''); setTimeout(() => t.className = 'sp-toast', 2600); };
  const clampInt = v => { const n = Math.round(Number(v)); return isFinite(n) && n > 0 ? n : 0; };

  // ── settings (localStorage) ──────────────────────────────────────────
  const DEFAULTS = { weeks: 6, cutDays: 25, abc: true, avgSource: 'rep_then_branch', period: 'stored', avgRound: 'pure', cartons: false };
  let SET = loadSet();
  function loadSet() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rp.set') || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function saveSet() { try { localStorage.setItem('rp.set', JSON.stringify(SET)); } catch (_) {} }

  // ── stage model ──────────────────────────────────────────────────────
  const STAGES = {
    weekly: ['draft', 'submitted', 'ready_to_check', 'approved'],
    daily:  ['draft', 'submitted', 'approved'],
  };
  const STAGE_LABEL = { draft: 'Draft', submitted: 'Submitted', ready_to_check: 'Ready to check', approved: 'Approved' };
  const STAGE_NEXT_BTN = {
    draft: 'Submit to inventory team',
    submitted: (mode) => mode === 'weekly' ? 'Mark Ready to check' : 'Approve',
    ready_to_check: 'Approve',
  };
  const stageIdx = () => STAGES[S.mode].indexOf(S.stage);
  const askEditable = () => S.stage === 'draft';                      // branch fills in draft
  const invEditable = () => S.mode === 'weekly' && S.stage === 'ready_to_check'; // inventory team fills then
  const dailyEditable = () => S.stage === 'draft';

  // ── state ────────────────────────────────────────────────────────────
  const S = {
    avg: [], avgBy: {}, ranks: null, stock: {}, inT: {}, prod: {}, prodList: [], loaded: false,
    branch: null, mode: 'weekly', stage: 'draft', lines: [], loadedKind: null,
    sort: { key: null, dir: 1 }, filters: {}, showFilters: false, search: '',
  };
  const BRANCHES = RC.BRANCHES;                     // 7 branches, codes + avg fields
  const VARIANT = { MEL: true, HBA: true };         // extra SYD Stock column (Sydney re-route)
  const DAILY_MAX = 12;

  const locBucket = name => {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('main')) return 'MAIN'; if (n.startsWith('gateway')) return 'GATEWAY';
    if (n.startsWith('sydney')) return 'SYD'; if (n.startsWith('melbourne')) return 'MEL';
    if (n.startsWith('brisbane')) return 'BNE'; if (n.startsWith('cairns')) return 'CNS';
    if (n.startsWith('coffs')) return 'CFS'; if (n.startsWith('hobart')) return 'HBA';
    if (n.startsWith('sunshine')) return 'SCS'; return null;   // Project/Quarantine → skip
  };

  async function fetchAll(from, sel, opts) {         // paginate past PostgREST's 1000 cap
    let out = [], i = 0;
    for (;;) {
      const q = (opts && opts.schema ? sb().schema(opts.schema) : sb()).from(from).select(sel).range(i, i + 999);
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
    S.prod = {}; S.prodList = prod;
    prod.forEach(p => { if (p.sku) S.prod[String(p.sku).toUpperCase()] = p; });
    const buckets = {}, inT = {};
    for (const r of stock) {
      const b = locBucket(r.location_name); if (!b || !r.sku) continue;
      const k = String(r.sku).toUpperCase();
      (buckets[b] || (buckets[b] = {}));
      buckets[b][k] = (buckets[b][k] || 0) + (Number(r.available) || 0);
      // in-transit that is heading TO the branch bucket (per destination location)
      inT[b] || (inT[b] = {});
      inT[b][k] = (inT[b][k] || 0) + (Number(r.in_transit) || 0);
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

  // ── build one line from a SKU code for the current branch ─────────────
  function buildRow(code) {
    const branch = S.branch;
    const k = String(code || '').trim().toUpperCase(); if (!k) return null;
    const p = S.prod[k] || {};
    const avgRow = S.avgBy[k] || null;
    const stock = S.stock[branch.code] || {};
    const avg = avgRow ? pickAvg(avgRow, branch) : 0;
    const avail = Number(stock[k] || 0);
    const inTransit = Number((S.inT[branch.code] && S.inT[branch.code][k]) || 0);
    const mainGw = (S.stock.MAIN && S.stock.MAIN[k] || 0) + (S.stock.GATEWAY && S.stock.GATEWAY[k] || 0);
    const mainOnly = Number((S.stock.MAIN && S.stock.MAIN[k]) || 0);
    const syd = Number((S.stock.SYD && S.stock.SYD[k]) || 0);
    const tier = (S.ranks && S.ranks.get(k)) || (S.ranks && S.ranks.get(code)) || 'C';
    const weeks = SET.abc ? RC.targetWeeksForTier(tier) : SET.weeks;
    const target = RC.computeBranchTarget(avg, weeks);
    const mainSafety = avgRow ? RC.computeMainSafety(RC.pickMainAvg(avgRow)) : 0;
    const canSend = Math.max(0, mainGw - mainSafety);
    let sug = Math.max(0, target - avail - inTransit);
    if (SET.cartons && p.carton_quantity) sug = RC.smartCartonRound(sug, p.carton_quantity, canSend, target, { avgMonthBranch: avg, branchAvailable: avail, targetWeeks: weeks }).qty;
    sug = Math.min(sug, canSend);
    return {
      code: p.sku || code, dc: p.attribute1 || '', name: p.name || '', ctn: p.carton_quantity || 0,
      loc: p.stock_locator || '', avg, soh: avail, inTransit, mainGw, mainOnly, canSend, syd,
      tier, target, weeks, sug, mainSafety,
      ask: sug, invQty: null, reason: '', comment: '',
    };
  }

  // universe = SKUs that have an average for this branch (what the branch sells)
  function suggestionUniverse() {
    const out = [];
    for (const r of S.avg) {
      const code0 = String(r.product || '').trim(); if (!code0) continue;
      const p = S.prod[code0.toUpperCase()] || {};
      if (RC.isExcludedProduct(code0, p.name)) continue;
      const row = buildRow(code0); if (!row || row.avg <= 0) continue;
      row.coverDays = row.avg > 0 ? Math.round((row.soh + row.inTransit) / (row.avg / RC.WEEKS_IN_MONTH) * 7) : 999;
      row.isSuggested = (row.canSend > 0 && row.sug > 0 && row.coverDays < SET.cutDays);
      out.push(row);
    }
    out.sort((a, b) => (b.isSuggested - a.isSuggested) || (a.coverDays - b.coverDays) || (b.sug - a.sug));
    return out;
  }
  function branchSuggestedCount(code) {
    const save = S.branch; S.branch = BRANCHES.find(b => b.code === code);
    const n = suggestionUniverse().filter(r => r.isSuggested).length;
    S.branch = save; return n;
  }

  // ── cover helpers (recomputed live off the ask) ──────────────────────
  function orderQty(l) { return S.mode === 'daily' ? clampInt(l.ask) : clampInt(l.ask); }
  function coverMonths(l) { return l.avg > 0 ? (l.soh + l.inTransit + orderQty(l)) / l.avg : 0; }
  function coverDays(l) { return l.avg > 0 ? Math.round((l.soh + l.inTransit + orderQty(l)) / (l.avg / RC.WEEKS_IN_MONTH) * 7) : 999; }

  // ═══════════════════════════════════════════════════════════════════
  //  LANDING
  // ═══════════════════════════════════════════════════════════════════
  function renderLanding() {
    $('branchLanding').style.display = ''; $('branchGrid').style.display = 'none';
    const tiles = BRANCHES.map(b => {
      const sug = S.loaded ? branchSuggestedCount(b.code) : 0;
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

  // ═══════════════════════════════════════════════════════════════════
  //  BRANCH WORKSPACE
  // ═══════════════════════════════════════════════════════════════════
  function openBranch(code, mode) {
    const branch = BRANCHES.find(b => b.code === code); if (!branch) return;
    S.branch = branch; S.mode = mode || 'weekly'; S.stage = 'draft'; S.lines = []; S.loadedKind = null;
    S.sort = { key: null, dir: 1 }; S.filters = {}; S.showFilters = false; S.search = '';
    $('branchLanding').style.display = 'none'; $('branchGrid').style.display = '';
    $('gridTitle').textContent = branch.name;
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('gridScope').textContent = `Main+Gateway is the send pool · ${SET.abc ? 'ABC tiers' : SET.weeks + '-week target'} · avg: ${SET.avgSource.replace(/_/g, ' ')}`;
    const draft = loadDraft();
    if (draft && draft.lines && draft.lines.length) { restoreDraft(draft); }
    else { showGateOrDaily(); }
  }
  function switchMode(mode) {
    if (mode === S.mode) return;
    // moving to a mode with an existing draft? load it; else fresh
    S.mode = mode; S.stage = 'draft'; S.lines = []; S.loadedKind = null;
    document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    const draft = loadDraft();
    if (draft && draft.lines && draft.lines.length) restoreDraft(draft);
    else showGateOrDaily();
  }
  function showGateOrDaily() {
    if (S.mode === 'daily') { S.stage = 'draft'; enterGrid(); }   // daily = straight to add-line sheet
    else renderGate();
  }

  // ── the gate (weekly only) ───────────────────────────────────────────
  function renderGate() {
    setWorkspaceMode('gate');
    const uni = suggestionUniverse();
    const nSug = uni.filter(r => r.isSuggested).length;
    const nSell = uni.length;
    const rules = SET.abc ? 'ABC tiers (A 10 · B 8 · C 6 wk)' : `${SET.weeks}-week cover`;
    $('rpGate').innerHTML = `
      <div class="rp-gate-h">${esc(S.branch.name)} — weekly replenishment</div>
      <div class="rp-gate-sub">Start from the engine's coverage suggestions, or build the sheet by hand.
        You choose before any line appears.</div>
      <div class="rp-rules">
        <span>Engine rules:</span>
        <b>${rules}</b><span>·</span>
        <b>avg: ${esc(SET.avgSource.replace(/_/g, ' '))}</b><span>·</span>
        <b>suggest under ${SET.cutDays}d cover</b><span>·</span>
        <b>Main keeps ${RC.MAIN_MIN_WEEKS}-wk safety</b><span>·</span>
        <a id="gateSettings">Adjust in Settings</a>
      </div>
      <div class="rp-choices">
        <div class="rp-choice" id="gateSuggest">
          <div class="big">${nSug}</div>
          <h4>Load engine suggestions</h4>
          <p>Pre-fills the sheet with the ${nSug} SKUs under ${SET.cutDays}d of cover, each with the
             engine's send quantity (capped by what Main can actually send). You review, adjust, approve.</p>
          <div class="row">
            <button class="sp-btn is-primary" data-kind="suggested">Load ${nSug} suggested</button>
            <button class="sp-btn" data-kind="all">Load all ${nSell} sellable</button>
          </div>
        </div>
        <div class="rp-choice manual" id="gateManual">
          <div class="big">＋</div>
          <h4>Add lines manually</h4>
          <p>Blank sheet. Add products with autocomplete by <b>5DC</b>, Rapid Code or name — the engine
             still shows avg, cover, Main and marks each line, but you set the quantities.</p>
          <div class="row"><button class="sp-btn" data-kind="manual">Start blank sheet</button></div>
        </div>
      </div>`;
    $('gateSettings').addEventListener('click', openSettings);
    $('rpGate').querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => {
      const kind = b.dataset.kind;
      if (kind === 'manual') startManual();
      else loadSuggestions(kind);
    }));
  }

  function loadSuggestions(kind) {
    const uni = suggestionUniverse();
    const rows = kind === 'all' ? uni : uni.filter(r => r.isSuggested);
    S.lines = rows.map(r => Object.assign({}, r));   // ask already = sug
    S.loadedKind = kind; S.stage = 'draft';
    enterGrid(); saveDraft();
    toast(`Loaded ${rows.length} ${kind === 'all' ? 'sellable' : 'suggested'} lines — review & adjust`);
  }
  function startManual() {
    S.lines = []; S.loadedKind = 'manual'; S.stage = 'draft';
    enterGrid(); saveDraft();
    toast('Blank sheet — add products by 5DC or code');
  }

  function setWorkspaceMode(m) {           // 'gate' | 'grid'
    const gate = m === 'gate';
    $('rpGate').style.display = gate ? '' : 'none';
    $('rpScroll').style.display = gate ? 'none' : '';
    $('rpFoot').style.display = gate ? 'none' : (S.mode === 'weekly' ? '' : 'none');
    $('rpStage').style.display = gate ? 'none' : '';
    $('gridSearch').style.display = gate ? 'none' : '';
    $('chipFilters').style.display = gate ? 'none' : '';
    $('btnReset').style.display = gate ? 'none' : '';
    $('btnAddLine').style.display = (gate) ? 'none' : ((S.loadedKind === 'manual' || S.mode === 'daily') && S.stage === 'draft' ? '' : 'none');
  }

  function enterGrid() { setWorkspaceMode('grid'); renderStage(); renderGrid(); }

  // ── stage bar ────────────────────────────────────────────────────────
  function renderStage() {
    const steps = STAGES[S.mode];
    const cur = stageIdx();
    const pills = steps.map((s, i) => {
      const cls = i < cur ? 'done' : i === cur ? 'now' : '';
      return `<span class="rp-step ${cls}">${STAGE_LABEL[s]}</span>` + (i < steps.length - 1 ? '<span class="rp-step-arrow">›</span>' : '');
    }).join('');
    let action = '';
    if (S.stage !== 'approved') {
      let label = STAGE_NEXT_BTN[S.stage];
      if (typeof label === 'function') label = label(S.mode);
      const disabled = S.lines.length === 0 ? 'disabled' : '';
      action = `<button class="sp-btn is-primary" id="btnAdvance" ${disabled}>${label} ›</button>`;
      if (cur > 0) action += ` <button class="sp-btn is-ghost" id="btnBackStage" style="font-size:13px">‹ back</button>`;
    } else {
      action = `<span class="rp-step done">✓ Approved — ready to place (Cin7 write held)</span>
                <button class="sp-btn is-ghost" id="btnBackStage" style="font-size:13px">‹ reopen</button>`;
    }
    $('rpStage').innerHTML = `<div class="rp-steps">${pills}</div><span class="sp-gap"></span>
      <span class="rp-sub" id="stageHint"></span> ${action}`;
    const adv = $('btnAdvance'); if (adv) adv.addEventListener('click', advanceStage);
    const bk = $('btnBackStage'); if (bk) bk.addEventListener('click', backStage);
    updateStageHint();
  }
  function updateStageHint() {
    const h = $('stageHint'); if (!h) return;
    if (S.stage === 'draft' && S.mode === 'weekly') h.textContent = 'Branch fills Branch Ask';
    else if (S.stage === 'ready_to_check') h.textContent = 'Inventory team fills Inv Qty';
    else if (S.stage === 'submitted' && S.mode === 'weekly') h.textContent = 'Waiting for inventory team';
    else h.textContent = '';
  }
  function advanceStage() {
    const steps = STAGES[S.mode], i = stageIdx();
    if (i < steps.length - 1) {
      S.stage = steps[i + 1];
      // when the inventory team gets it, seed Inv Qty from Branch Ask so they only tweak
      if (S.stage === 'ready_to_check') S.lines.forEach(l => { if (l.invQty == null) l.invQty = clampInt(l.ask); });
      saveDraft(); enterGrid();
      toast(`Stage → ${STAGE_LABEL[S.stage]}`);
    }
  }
  function backStage() {
    const steps = STAGES[S.mode], i = stageIdx();
    if (i > 0) { S.stage = steps[i - 1]; saveDraft(); enterGrid(); }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  GRID
  // ═══════════════════════════════════════════════════════════════════
  // col: [key,label,cls('txt'|'num'|'code'),width, group('id'|'stk'|'ord'|'ref'), sortable]
  function cols() {
    if (S.mode === 'daily') {
      const c = [
        ['idx', '#', 'num', 34, 'id', false], ['dc', '5DC', 'txt', 58, 'id', true], ['code', 'Rapid Code', 'code', 122, 'id', true],
        ['name', 'Product', 'txt', 260, 'id', true], ['loc', 'Location', 'txt', 96, 'id', true],
        ['soh', 'SOH', 'num', 64, 'stk', true], ['main', 'Main', 'num', 72, 'stk', true],
        ['ask', 'Qty', 'num', 74, 'ord', true], ['reason', 'Reason', 'txt', 240, 'ord', false],
        ['rm', '', 'num', 34, 'ref', false],
      ];
      return c;
    }
    const c = [
      ['tier', 'Tier', 'num', 40, 'id', true], ['dc', '5DC', 'txt', 58, 'id', true], ['code', 'Rapid Code', 'code', 122, 'id', true],
      ['name', 'Product', 'txt', 240, 'id', true], ['ctn', 'Ctn', 'num', 44, 'id', true], ['loc', 'Location', 'txt', 96, 'id', true],
      ['avg', 'Mthly Avg', 'num', 78, 'stk', true], ['soh', 'SOH', 'num', 62, 'stk', true], ['inTransit', 'In Transit', 'num', 86, 'stk', true],
      ['cover', 'Cover', 'num', 88, 'stk', true], ['main', 'Main', 'num', 74, 'stk', true],
      ['ask', 'Branch Ask', 'num', 90, 'ord', true], ['invQty', 'Inv Qty', 'num', 84, 'ord', true],
    ];
    if (VARIANT[S.branch.code]) c.push(['syd', 'SYD Stock', 'num', 78, 'ref', true]);
    c.push(['comment', 'Comments', 'txt', 150, 'ref', false], ['inv', 'Inv', 'num', 48, 'ref', false], ['rm', '', 'num', 34, 'ref', false]);
    return c;
  }

  function visibleLines() {
    let rows = S.lines.slice();
    if (S.search) { const q = S.search.toLowerCase(); rows = rows.filter(r => (r.code + ' ' + r.name + ' ' + r.dc).toLowerCase().includes(q)); }
    for (const key in S.filters) {
      const f = (S.filters[key] || '').toLowerCase(); if (!f) continue;
      rows = rows.filter(r => String(sortVal(r, key)).toLowerCase().includes(f));
    }
    if (S.sort.key) {
      const k = S.sort.key, d = S.sort.dir;
      rows.sort((a, b) => {
        const va = sortVal(a, k), vb = sortVal(b, k);
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * d;
        return String(va).localeCompare(String(vb)) * d;
      });
    }
    return rows;
  }
  function sortVal(l, k) {
    switch (k) {
      case 'idx': return S.lines.indexOf(l);
      case 'tier': return l.tier; case 'dc': return l.dc || ''; case 'code': return l.code || '';
      case 'name': return l.name || ''; case 'ctn': return l.ctn || 0; case 'loc': return l.loc || '';
      case 'avg': return l.avg || 0; case 'soh': return l.soh || 0; case 'inTransit': return l.inTransit || 0;
      case 'cover': return coverDays(l); case 'main': return l.canSend || 0;
      case 'ask': return clampInt(l.ask); case 'invQty': return l.invQty == null ? -1 : clampInt(l.invQty);
      case 'syd': return l.syd || 0; case 'reason': return l.reason || ''; case 'comment': return l.comment || '';
      default: return '';
    }
  }

  function renderGrid() {
    const C = cols();
    const rows = visibleLines();
    // header row (with group tint + sort arrows)
    const groupCls = g => g === 'stk' ? 'g-stk' : g === 'ord' ? 'g-ord' : g === 'ref' ? 'g-ref' : '';
    let prevG = null;
    const head = '<thead><tr>' + C.map(c => {
      const [key, label, cls, w, g, sortable] = c;
      const sep = (g !== prevG && prevG !== null) ? ' gsep' : ''; prevG = g;
      const alignCls = cls === 'num' ? 'num' : 'txt';
      const on = S.sort.key === key ? ' on' : '';
      const arrow = sortable ? `<span class="ar">${S.sort.key === key ? (S.sort.dir > 0 ? '▲' : '▼') : '▲'}</span>` : '';
      return `<th class="${alignCls} ${groupCls(g)}${sep}${sortable ? ' srt' + on : ''}" data-k="${key}" style="width:${w}px">${esc(label)}${arrow}</th>`;
    }).join('') + '</tr>';
    // filter row
    let flt = '';
    if (S.showFilters) {
      prevG = null;
      flt = '<tr class="rp-flt">' + C.map(c => {
        const [key, , , , g, sortable] = c;
        const sep = (g !== prevG && prevG !== null) ? ' gsep' : ''; prevG = g;
        const cell = (sortable && key !== 'inv' && key !== 'rm') ? `<input data-fk="${key}" value="${esc(S.filters[key] || '')}" placeholder="…">` : '';
        return `<th class="${cell ? '' : 'no'}${sep}">${cell}</th>`;
      }).join('') + '</tr>';
    }
    const body = rows.map(l => {
      const nomain = l.mainGw <= 0;
      return `<tr data-code="${esc(l.code)}" class="${nomain ? 'rp-nomain' : ''}">` + C.map(c => cell(l, c)).join('') + '</tr>';
    }).join('') || `<tr><td colspan="${C.length}" class="sp-empty">${S.mode === 'daily' || S.loadedKind === 'manual' ? 'No lines yet — use ＋ Add line.' : 'No lines.'}</td></tr>`;
    // add-line row (manual / daily, while editable)
    let addRow = '';
    const canAdd = (S.loadedKind === 'manual' || S.mode === 'daily') && dailyOrDraftEditable();
    if (canAdd) {
      const atMax = S.mode === 'daily' && S.lines.length >= DAILY_MAX;
      addRow = `<tr class="rp-add"><td colspan="${C.length}"><div class="rp-addwrap">
        <input class="rp-acq" id="acInput" placeholder="Add product — type 5DC, Rapid Code or name…" autocomplete="off" ${atMax ? 'disabled' : ''}>
        ${S.mode === 'daily' ? `<span class="rp-hint">${S.lines.length}/${DAILY_MAX} items${atMax ? ' — daily limit reached' : ''}</span>` : ''}
      </div></td></tr>`;
    }
    $('rpGrid').innerHTML = head + flt + '</thead><tbody>' + body + addRow + '</tbody>';
    $('gridCount').textContent = `${rows.length} line${rows.length === 1 ? '' : 's'}${S.loadedKind && S.loadedKind !== 'manual' ? ' · ' + S.loadedKind : ''}`;
    wireGrid();
  }
  function dailyOrDraftEditable() { return S.mode === 'daily' ? dailyEditable() : (S.stage === 'draft'); }

  function cell(l, c) {
    const [key, , cls, , g] = c;
    const gc = g === 'ord' ? ' g-ord' : '';
    const numCls = cls === 'num' ? 'num' : cls === 'code' ? 'code txt' : 'txt';
    const wrap = (inner, extra, title) => `<td class="${numCls}${gc}${extra || ''}"${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`;
    switch (key) {
      case 'idx': return wrap(S.lines.indexOf(l) + 1);
      case 'tier': return wrap(`<span class="rp-tier ${l.tier}">${l.tier}</span>`);
      case 'dc': return wrap(esc(l.dc) || '<span class="rp-sub">—</span>');
      case 'code': return wrap(esc(l.code));
      case 'name': return `<td class="txt" title="${esc(l.name)}">${esc(String(l.name).slice(0, 46))}</td>`;
      case 'ctn': return wrap(l.ctn ? n0(l.ctn) : '<span class="rp-sub">—</span>');
      case 'loc': return wrap(esc(l.loc) || '<span class="rp-sub">—</span>');
      case 'avg': return wrap(l.avg ? n1(l.avg) : '<span class="rp-sub">—</span>');
      case 'soh': return wrap(n0(l.soh) + (l.soh < 0 ? '<span class="rp-mk sold">oversold</span>' : ''));
      case 'inTransit': return wrap(l.inTransit ? n0(l.inTransit) + '<span class="rp-mk it">in transit</span>' : '<span class="rp-sub">·</span>');
      case 'cover': {
        const mo = coverMonths(l), d = coverDays(l);
        const mk = d < 7 ? '<span class="rp-mk low">low</span>' : mo > 2.2 ? '<span class="rp-mk over">over</span>' : '';
        const dtxt = d >= 999 ? '∞' : d + 'd';
        return wrap(`${l.avg ? n1(mo) + ' mo <small class="rp-sub">' + dtxt + '</small>' : '<span class="rp-sub">n/a</span>'}${mk}`, ' cover');
      }
      case 'main': {
        const sub = (l.canSend < l.mainGw && l.mainGw > 0) ? `<small class="rp-sub">≤${n0(l.canSend)}</small>` : '';
        return wrap(`${n0(l.mainGw)} ${sub}`, '', `Main+Gateway ${n0(l.mainGw)} · keep ${n0(l.mainSafety)} safety · can send ${n0(l.canSend)}`);
      }
      case 'ask': {
        if (S.mode === 'daily') {
          const ed = dailyEditable();
          return wrap(ed ? `<input class="rp-in big" data-k="ask" value="${clampInt(l.ask) || ''}" inputmode="numeric">` : `<span class="rp-lock">${n0(clampInt(l.ask))}</span>`);
        }
        const ed = askEditable();
        return wrap(ed ? `<input class="rp-in big" data-k="ask" value="${clampInt(l.ask) || ''}" inputmode="numeric">` : `<span class="rp-lock">${n0(clampInt(l.ask))}</span>`);
      }
      case 'invQty': {
        const ed = invEditable();
        if (ed) return `<td class="num g-ord"><input class="rp-in big" data-k="invQty" value="${l.invQty == null ? '' : clampInt(l.invQty)}" inputmode="numeric"></td>`;
        const val = l.invQty == null ? '<span class="rp-sub" title="Unlocks when warehouse marks Ready to check">locked</span>' : `<span class="rp-lock">${n0(clampInt(l.invQty))}</span>`;
        return `<td class="num g-ord locked">${val}</td>`;
      }
      case 'syd': return wrap(n0(l.syd));
      case 'reason': {
        const ed = dailyEditable();
        return `<td class="txt${gc}">${ed ? `<input class="rp-in txt" data-k="reason" value="${esc(l.reason)}" placeholder="why — e.g. just sold, special order…">` : esc(l.reason) || '<span class="rp-sub">—</span>'}</td>`;
      }
      case 'comment': {
        const ed = S.stage !== 'approved';
        return `<td class="txt">${ed ? `<input class="rp-in txt" data-k="comment" value="${esc(l.comment)}" placeholder="…">` : esc(l.comment) || '<span class="rp-sub">—</span>'}</td>`;
      }
      case 'inv': return `<td class="num"><a class="rp-sub" href="/features/rapid-inventory/dashboard.html?sku=${encodeURIComponent(l.code)}" target="_blank" title="Open inventory">view</a></td>`;
      case 'rm': {
        const canRm = dailyOrDraftEditable();
        return `<td class="num">${canRm ? `<button class="rp-rm" data-rm="1" title="Remove line">✕</button>` : ''}</td>`;
      }
      default: return wrap('—');
    }
  }

  function wireGrid() {
    const tb = $('rpGrid');
    // header sort
    tb.querySelectorAll('th.srt').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (S.sort.key === k) S.sort.dir = -S.sort.dir; else { S.sort.key = k; S.sort.dir = 1; }
      renderGrid();
    }));
    // filter inputs
    tb.querySelectorAll('tr.rp-flt input').forEach(inp => inp.addEventListener('input', () => {
      S.filters[inp.dataset.fk] = inp.value; renderGridPreserve(inp.dataset.fk);
    }));
    // editable cells
    tb.querySelectorAll('input.rp-in').forEach(inp => {
      const tr = inp.closest('tr'); const l = lineByRow(tr); if (!l) return;
      const k = inp.dataset.k;
      inp.addEventListener('input', () => {
        if (k === 'ask') l.ask = clampInt(inp.value);
        else if (k === 'invQty') l.invQty = inp.value === '' ? null : clampInt(inp.value);
        else l[k] = inp.value;
        if (k === 'ask') updateCoverCell(tr, l);
      });
      inp.addEventListener('change', saveDraft);
    });
    // remove buttons
    tb.querySelectorAll('button[data-rm]').forEach(btn => btn.addEventListener('click', () => {
      const l = lineByRow(btn.closest('tr')); if (!l) return;
      S.lines = S.lines.filter(x => x !== l); saveDraft(); renderStage(); renderGrid();
    }));
    // add-line autocomplete
    const ac = $('acInput'); if (ac) attachAutocomplete(ac);
  }
  function renderGridPreserve(focusFk) {
    renderGrid();
    if (focusFk) { const el = $('rpGrid').querySelector(`tr.rp-flt input[data-fk="${focusFk}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
  }
  function lineByRow(tr) {
    if (!tr) return null;
    const code = tr.getAttribute('data-code'); return S.lines.find(l => l.code === code);
  }
  function updateCoverCell(tr, l) {
    const td = tr.querySelector('td.cover'); if (!td) return;
    const mo = coverMonths(l), d = coverDays(l);
    const mk = d < 7 ? '<span class="rp-mk low">low</span>' : mo > 2.2 ? '<span class="rp-mk over">over</span>' : '';
    td.innerHTML = `${l.avg ? n1(mo) + ' mo <small class="rp-sub">' + (d >= 999 ? '∞' : d + 'd') + '</small>' : '<span class="rp-sub">n/a</span>'}${mk}`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  AUTOCOMPLETE (product by 5DC / code / name)
  // ═══════════════════════════════════════════════════════════════════
  let acState = { items: [], sel: -1, input: null };
  function attachAutocomplete(input) {
    acState.input = input;
    input.addEventListener('input', () => acSearch(input.value));
    input.addEventListener('focus', () => { if (input.value) acSearch(input.value); });
    input.addEventListener('keydown', e => {
      const ac = $('rpAc');
      if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (acState.sel >= 0 && acState.items[acState.sel]) acPick(acState.items[acState.sel].sku); }
      else if (e.key === 'Escape') acHide();
    });
    input.addEventListener('blur', () => setTimeout(acHide, 150));
    input.focus();
  }
  function acSearch(q) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 2) return acHide();
    const starts = [], contains = [];
    for (const p of S.prodList) {
      const sku = String(p.sku || '').toLowerCase(), dc = String(p.attribute1 || '').toLowerCase(), nm = String(p.name || '').toLowerCase();
      if (sku.startsWith(q) || dc.startsWith(q)) starts.push(p);
      else if (sku.includes(q) || dc.includes(q) || nm.includes(q)) contains.push(p);
      if (starts.length >= 25) break;
    }
    const items = starts.concat(contains).slice(0, 25);
    acState.items = items; acState.sel = items.length ? 0 : -1;
    const ac = $('rpAc');
    if (!items.length) { ac.innerHTML = '<div class="none">No product matches</div>'; }
    else ac.innerHTML = items.map((p, i) => {
      const k = String(p.sku).toUpperCase();
      const main = (S.stock.MAIN && S.stock.MAIN[k] || 0) + (S.stock.GATEWAY && S.stock.GATEWAY[k] || 0);
      return `<div data-sku="${esc(p.sku)}" class="${i === acState.sel ? 'sel' : ''}">
        <span class="sku">${esc(p.sku)}</span>${p.attribute1 ? `<span class="dc">${esc(p.attribute1)}</span>` : ''}
        <span class="nm">${esc(p.name || '')}</span><span class="st">Main ${n0(main)}</span></div>`;
    }).join('');
    ac.querySelectorAll('[data-sku]').forEach(d => d.addEventListener('mousedown', e => { e.preventDefault(); acPick(d.dataset.sku); }));
    positionAc(); ac.classList.add('on');
  }
  function acMove(dir) {
    const ac = $('rpAc'); if (!acState.items.length) return;
    acState.sel = (acState.sel + dir + acState.items.length) % acState.items.length;
    [...ac.children].forEach((c, i) => c.classList.toggle('sel', i === acState.sel));
    const el = ac.children[acState.sel]; if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function positionAc() {
    const ac = $('rpAc'), r = acState.input.getBoundingClientRect();
    ac.style.left = r.left + 'px'; ac.style.top = (r.bottom + 4) + 'px'; ac.style.minWidth = Math.max(460, r.width) + 'px';
  }
  function acHide() { $('rpAc').classList.remove('on'); acState.items = []; acState.sel = -1; }
  function acPick(sku) {
    acHide();
    const k = String(sku).toUpperCase();
    if (S.lines.some(l => String(l.code).toUpperCase() === k)) {
      toast('Already on the sheet'); const inp = acState.input; if (inp) { inp.value = ''; inp.focus(); } return;
    }
    if (S.mode === 'daily' && S.lines.length >= DAILY_MAX) { toast(`Daily limit is ${DAILY_MAX} items`, true); return; }
    const row = buildRow(sku); if (!row) { toast('Product not found', true); return; }
    if (S.mode !== 'daily') row.ask = 0;        // manual: user sets the qty
    else row.ask = 0;
    S.lines.push(row); saveDraft(); renderStage(); renderGrid();
    const inp = $('acInput'); if (inp) inp.focus();
  }

  // ═══════════════════════════════════════════════════════════════════
  //  DRAFT PERSISTENCE (localStorage; DB in a later phase)
  // ═══════════════════════════════════════════════════════════════════
  function draftKey() { return `rp.draft.${S.branch.code}.${S.mode}`; }
  function saveDraft() {
    try {
      const payload = {
        stage: S.stage, loadedKind: S.loadedKind, week: weekLabel(),
        lines: S.lines.map(l => ({ code: l.code, ask: clampInt(l.ask), invQty: l.invQty == null ? null : clampInt(l.invQty), reason: l.reason || '', comment: l.comment || '' })),
      };
      localStorage.setItem(draftKey(), JSON.stringify(payload));
    } catch (_) {}
  }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (_) { return null; } }
  function restoreDraft(d) {
    S.stage = d.stage || 'draft'; S.loadedKind = d.loadedKind || (S.mode === 'daily' ? 'daily' : 'manual');
    S.lines = (d.lines || []).map(saved => {
      const row = buildRow(saved.code); if (!row) return null;
      row.ask = clampInt(saved.ask); row.invQty = saved.invQty == null ? null : clampInt(saved.invQty);
      row.reason = saved.reason || ''; row.comment = saved.comment || '';
      return row;
    }).filter(Boolean);
    enterGrid();
    toast(`Resumed your ${S.mode} draft (${S.lines.length} lines · ${STAGE_LABEL[S.stage]})`);
  }
  function clearDraft() { try { localStorage.removeItem(draftKey()); } catch (_) {} }
  function weekLabel() {
    const d = new Date(); const onejan = new Date(d.getFullYear(), 0, 1);
    const wk = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
  }
  function startOver() {
    if (S.lines.length && !confirm('Start this plan over? Your current lines will be cleared.')) return;
    clearDraft(); S.stage = 'draft'; S.lines = []; S.loadedKind = null;
    showGateOrDaily();
    toast('Cleared — start fresh');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  AVERAGES (consultative)
  // ═══════════════════════════════════════════════════════════════════
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
    const head = '<thead><tr>' + C.map(c => `<th class="${c[0] === 'code' || c[0] === 'name' ? 'txt' : 'num'}" style="width:${c[2]}px">${c[1]}</th>`).join('') + '</tr></thead>';
    const body = rows.map(r => '<tr><td class="code txt">' + esc(r.code) + '</td><td class="txt">' + esc(String(r.name).slice(0, 44)) + '</td>' +
      BRANCHES.map(b => `<td class="num">${r.vals[b.code] > 0 ? n1(r.vals[b.code]) : '<span style="color:#c3ccda">·</span>'}</td>`).join('') + '</tr>').join('');
    $('avGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
    $('avCount').textContent = `${rows.length} shown`;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  SETTINGS
  // ═══════════════════════════════════════════════════════════════════
  function openSettings() {
    $('setWeeks').value = SET.weeks; $('setDays').value = Math.round(SET.weeks * 7) + ' days';
    $('setCutDays').value = SET.cutDays; $('setAbc').checked = SET.abc;
    $('setAvgSource').value = SET.avgSource; $('setPeriod').value = SET.period;
    $('setAvgRound').value = SET.avgRound; $('setCartons').checked = SET.cartons;
    const rows = S.avg.map(r => ({ code: r.product, tot: BRANCHES.reduce((s, b) => s + pickAvg(r, b), 0) }))
      .filter(r => r.tot > 0).sort((a, b) => b.tot - a.tot).slice(0, 60);
    $('setAvgTable').innerHTML = '<thead><tr><th class="txt">Rapid Code</th><th class="num">Tier</th><th class="num">Network avg/mo</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td class="code txt">${esc(r.code)}</td><td class="num"><span class="rp-tier ${(S.ranks && S.ranks.get(r.code)) || 'C'}">${(S.ranks && S.ranks.get(r.code)) || 'C'}</span></td><td class="num">${n1(r.tot)}</td></tr>`).join('') + '</tbody>';
    $('mdSettings').classList.add('is-on');
  }
  $('setWeeks') && $('setWeeks').addEventListener('input', e => { $('setDays').value = Math.round((Number(e.target.value) || 0) * 7) + ' days'; });
  function applySettings() {
    SET.weeks = Math.max(1, Number($('setWeeks').value) || 6);
    SET.cutDays = Math.max(1, Number($('setCutDays').value) || 25);
    SET.abc = $('setAbc').checked; SET.avgSource = $('setAvgSource').value; SET.period = $('setPeriod').value;
    SET.avgRound = $('setAvgRound').value; SET.cartons = $('setCartons').checked;
    saveSet(); $('mdSettings').classList.remove('is-on');
    // recompute: rebuild any loaded lines' engine fields (keep the user's asks)
    if (S.branch && S.lines.length) {
      S.lines = S.lines.map(l => { const r = buildRow(l.code); if (!r) return l; r.ask = l.ask; r.invQty = l.invQty; r.reason = l.reason; r.comment = l.comment; return r; });
      renderGrid();
    } else if (S.branch && $('rpGate').style.display !== 'none') renderGate();
    renderLanding();
    toast('Settings applied — recomputed');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  WIRING
  // ═══════════════════════════════════════════════════════════════════
  function showView(v) {
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === v));
    document.querySelectorAll('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === v));
    if (v === 'averages') { $('avBranch').innerHTML = '<option value="">All branches</option>' + BRANCHES.map(b => `<option value="${b.code}">${b.name}</option>`).join(''); renderAverages(); }
  }
  function wire() {
    document.querySelectorAll('.sp-tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('btnBack').addEventListener('click', renderLanding);
    document.querySelectorAll('#modeSeg button').forEach(b => b.addEventListener('click', () => switchMode(b.dataset.mode)));
    $('btnSettings').addEventListener('click', openSettings);
    $('setApply').addEventListener('click', applySettings);
    $('setReset').addEventListener('click', () => { SET = Object.assign({}, DEFAULTS); openSettings(); });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('mdSettings').classList.remove('is-on')));
    $('gridSearch').addEventListener('input', e => { S.search = e.target.value; renderGrid(); });
    $('chipFilters').addEventListener('click', function () { S.showFilters = !S.showFilters; this.classList.toggle('is-on', S.showFilters); renderGrid(); });
    $('btnAddLine').addEventListener('click', () => { const i = $('acInput'); if (i) i.focus(); else renderGrid(); });
    $('btnReset').addEventListener('click', startOver);
    ['avSearch', 'avBranch'].forEach(id => $(id).addEventListener('input', renderAverages));
    $('avNonZero').addEventListener('click', function () { this.classList.toggle('is-on'); renderAverages(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $('mdSettings').classList.remove('is-on'); });
    window.addEventListener('scroll', () => { if ($('rpAc').classList.contains('on')) positionAc(); }, true);
  }

  (async function init() {
    try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
    if (!sb() || !RC) { setStatus('bad', 'Supabase or engine not available'); return; }
    wire();
    try { await loadBase(); renderLanding(); }
    catch (e) { console.error(e); setStatus('bad', 'Load failed: ' + e.message); toast('Load failed: ' + e.message, true); }
  })();
})();
