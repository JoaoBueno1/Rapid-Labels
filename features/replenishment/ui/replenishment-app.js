/* Branch Replenishment — app.
 *
 * Opens straight into the sheet (no pre-open menu). Weekly sub-tab = Excel-style rows you fill,
 * with a "Load suggested (N)" that merges the engine's coverage picks into the empty rows (never
 * overwrites what you typed). Daily = items asked up to 12pm + reason, ≤12, skips the manager check.
 * History = approved snapshots, locked at the approved values. A right panel (click any row) shows
 * the product across every branch, Main/Gateway bins, and what's on the way + ETA.
 * Reuses window.ReplenishmentConfig; reads live cin7_mirror. Place-order (Cin7 write) NOT built. */
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
  const BLANK_ROWS = 10;

  // ── settings ─────────────────────────────────────────────────────────
  const DEFAULTS = { weeks: 6, cutDays: 25, abc: true, avgSource: 'rep_then_branch', period: 'stored', avgRound: 'pure', cartons: false };
  let SET = loadSet();
  function loadSet() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('rp.set') || '{}')); } catch (_) { return Object.assign({}, DEFAULTS); } }
  function saveSet() { try { localStorage.setItem('rp.set', JSON.stringify(SET)); } catch (_) {} }

  // ── stage model ──────────────────────────────────────────────────────
  const STAGES = { weekly: ['draft', 'submitted', 'ready_to_check', 'approved'], daily: ['draft', 'submitted', 'approved'] };
  const STAGE_LABEL = { draft: 'Draft', submitted: 'Submitted', ready_to_check: 'Ready to check', approved: 'Approved' };
  const stageIdx = () => STAGES[S.mode].indexOf(S.stage);
  // Quem escreve o quê, e quando. Antes o Inv Qty só abria em ready_to_check e
  // no diário nunca — então dar Submit não mudava nada na tela, que era a
  // reclamação. São dois checks: o time de estoque no submitted, o gerente no
  // ready_to_check. O diário pula o segundo, mas mantém o primeiro.
  const askEditable = () => S.stage === 'draft';
  const invEditable = () => S.stage === 'submitted' || S.stage === 'ready_to_check';
  const invCommentEditable = () => invEditable();

  // ── state ────────────────────────────────────────────────────────────
  const S = {
    avg: [], avgBy: {}, ranks: null, stock: {}, inT: {}, prod: {}, prodList: [], pallet: {}, loaded: false,
    branch: null, view: 'weekly', mode: 'weekly', stage: 'draft', lines: [],
    sort: { key: null, dir: 1 }, search: '', vis: { weekly: null, daily: null }, sideSku: null,
  };
  const BRANCHES = (RC && RC.BRANCHES) || [];   // guarded: init() shows a status if the engine is missing
  const VARIANT = { MEL: true, HBA: true };
  const DAILY_MAX = 12;

  const locBucket = name => {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('main')) return 'MAIN'; if (n.startsWith('gateway')) return 'GATEWAY';
    if (n.startsWith('sydney')) return 'SYD'; if (n.startsWith('melbourne')) return 'MEL';
    if (n.startsWith('brisbane')) return 'BNE'; if (n.startsWith('cairns')) return 'CNS';
    if (n.startsWith('coffs')) return 'CFS'; if (n.startsWith('hobart')) return 'HBA';
    if (n.startsWith('sunshine')) return 'SCS'; return null;
  };

  async function fetchAll(from, sel, opts) {
    let out = [], i = 0;
    for (;;) {
      const q = (opts && opts.schema ? sb().schema(opts.schema) : sb()).from(from).select(sel).range(i, i + 999);
      const { data, error } = await q; if (error) throw error;
      out = out.concat(data || []); if (!data || data.length < 1000) break; i += 1000;
    }
    return out;
  }

  async function loadBase() {
    setStatus('loading', 'Loading live stock & averages…');
    const [avg, stock, prod, pallet] = await Promise.all([
      fetchAll('branch_avg_monthly_sales', '*'),
      fetchAll('stock_snapshot', 'sku,location_name,available,in_transit', { schema: 'cin7_mirror' }),
      fetchAll('products', 'sku,attribute1,name,stock_locator,carton_quantity,status', { schema: 'cin7_mirror' }),
      // Pallet casa pelo 5DC, não pelo Rapid Code — medido: 1 match por sku
      // contra 2.385 por attribute1. Faz sentido físico: o mesmo produto tem
      // vários códigos. pallet_capacity_rules cobre 1.900 SKUs contra 1.030 do
      // restock_setup, e as duas concordam em 948 dos 980 em comum.
      fetchAll('pallet_capacity_rules', 'sku,qty_pallet'),
    ]);
    S.avg = avg;
    S.avgBy = {}; avg.forEach(r => { if (r.product) S.avgBy[String(r.product).toUpperCase()] = r; });
    S.prod = {}; S.prodList = prod;
    prod.forEach(p => { if (p.sku) S.prod[String(p.sku).toUpperCase()] = p; });
    const buckets = {}, inT = {};
    for (const r of stock) {
      const b = locBucket(r.location_name); if (!b || !r.sku) continue;
      const k = String(r.sku).toUpperCase();
      (buckets[b] || (buckets[b] = {})); buckets[b][k] = (buckets[b][k] || 0) + (Number(r.available) || 0);
      (inT[b] || (inT[b] = {})); inT[b][k] = (inT[b][k] || 0) + (Number(r.in_transit) || 0);
    }
    S.pallet = {};
    for (const r of pallet) {
      const k = String(r.sku || '').trim().toUpperCase(); const v = Number(r.qty_pallet) || 0;
      if (k && v > 0) S.pallet[k] = v;
    }
    S.stock = buckets; S.inT = inT; S.ranks = RC.computeAbcRanks(avg); S.loaded = true;
    setStatus('fresh', `Live · ${n0(stock.length)} stock rows · ${n0(avg.length)} SKUs with averages`);
  }
  function setStatus(level, text) {
    const d = $('statusDot'); if (d) d.className = 'sp-dot ' + (level === 'loading' ? 'stale' : level === 'bad' ? 'dead' : 'fresh');
    if ($('statusText')) $('statusText').textContent = text;
  }

  // ── average pick honouring settings ──────────────────────────────────
  function pickAvg(avgRow, branch) {
    if (!avgRow) return 0;
    const rep = Number(avgRow[branch.avgRepField] || 0), whs = Number(avgRow[branch.avgField] || 0);
    let v;
    switch (SET.avgSource) {
      case 'branch': v = whs; break; case 'rep': v = rep; break;
      case 'both_max': v = Math.max(rep, whs); break; case 'both_sum': v = rep + whs; break;
      case 'both_avg': v = (rep && whs) ? (rep + whs) / 2 : (rep || whs); break;
      default: v = rep > 0 ? rep : whs;
    }
    if (SET.avgRound === 'nearest') v = Math.round(v); else if (SET.avgRound === 'up') v = Math.ceil(v); else if (SET.avgRound === 'down') v = Math.floor(v);
    return v;
  }

  // ── build one line from a SKU code for the current branch ─────────────
  function buildRow(code) {
    const branch = S.branch, k = String(code || '').trim().toUpperCase(); if (!k) return null;
    const p = S.prod[k] || {}, avgRow = S.avgBy[k] || null, stock = S.stock[branch.code] || {};
    const avg = avgRow ? pickAvg(avgRow, branch) : 0;
    const avail = Number(stock[k] || 0);
    const inTransit = Number((S.inT[branch.code] && S.inT[branch.code][k]) || 0);
    const mainOnly = Number((S.stock.MAIN && S.stock.MAIN[k]) || 0);
    const gw = Number((S.stock.GATEWAY && S.stock.GATEWAY[k]) || 0);
    const mainGw = mainOnly + gw;
    const syd = Number((S.stock.SYD && S.stock.SYD[k]) || 0);
    const pallet = Number(S.pallet[String(p.attribute1 || '').trim().toUpperCase()] || 0);
    const tier = (S.ranks && (S.ranks.get(k) || S.ranks.get(code))) || 'C';
    const weeks = SET.abc ? RC.targetWeeksForTier(tier) : SET.weeks;
    const target = RC.computeBranchTarget(avg, weeks);
    const mainAvg = avgRow ? RC.pickMainAvg(avgRow) : 0;
    const canSend = Math.max(0, mainGw - RC.computeMainSafety(mainAvg));
    let sug = Math.max(0, target - avail - inTransit);
    if (SET.cartons && p.carton_quantity) sug = RC.smartCartonRound(sug, p.carton_quantity, canSend, target, { avgMonthBranch: avg, branchAvailable: avail, targetWeeks: weeks }).qty;
    sug = Math.min(sug, canSend);
    const coverWeeks = avg > 0 ? (avail + inTransit) / (avg / RC.WEEKS_IN_MONTH) : 999;
    return {
      code: p.sku || code, dc: p.attribute1 || '', name: p.name || '', ctn: p.carton_quantity || 0,
      pallet, deprecated: p.status === 'Deprecated',
      loc: p.stock_locator || '', avg, soh: avail, inTransit, mainGw, mainOnly, gw, canSend, syd,
      tier, target, weeks, mainAvg, sug, coverWeeks,
      // invComment e flag nascem aqui para o rascunho salvo já ter o formato
      // novo — senão a linha antiga volta do localStorage sem eles.
      ask: sug, invQty: null, reason: '', comment: '', invComment: '', flag: false,
    };
  }

  function suggestionUniverse() {
    const out = [];
    for (const r of S.avg) {
      const c0 = String(r.product || '').trim(); if (!c0) continue;
      const p = S.prod[c0.toUpperCase()] || {}; if (RC.isExcludedProduct(c0, p.name)) continue;
      const row = buildRow(c0); if (!row || row.avg <= 0) continue;
      const coverDays = Math.round(row.coverWeeks * 7);
      row.isSuggested = (row.canSend > 0 && row.sug > 0 && coverDays < SET.cutDays);
      out.push(row);
    }
    out.sort((a, b) => (b.isSuggested - a.isSuggested) || (a.coverWeeks - b.coverWeeks) || (b.sug - a.sug));
    return out;
  }
  function branchSuggestedCount(code) {
    const save = S.branch; S.branch = BRANCHES.find(b => b.code === code);
    const n = suggestionUniverse().filter(r => r.isSuggested).length; S.branch = save; return n;
  }
  function finalQty(l) { return (S.mode === 'weekly' && l.invQty != null) ? clampInt(l.invQty) : clampInt(l.ask); }

  // ═══ LANDING ═══════════════════════════════════════════════════════
  function renderLanding() {
    $('branchLanding').style.display = ''; $('branchGrid').style.display = 'none'; closeSide();
    $('branchTiles').innerHTML = BRANCHES.map(b => {
      const sug = S.loaded ? branchSuggestedCount(b.code) : 0;
      const cls = sug > 40 ? 'bad' : sug > 15 ? 'warn' : 'good';
      return `<div class="sp-tile ${cls}" data-code="${b.code}" role="button" tabindex="0">
        <span>${esc(b.name)}</span><b>${sug}</b>
        <div class="rp-tile-sub">SKUs to restock (cover &lt; ${SET.cutDays}d)</div>
        ${VARIANT[b.code] ? '<span class="rp-tile-var">+ Sydney re-route</span>' : ''}</div>`;
    }).join('');
    $('landingNote').textContent = `${BRANCHES.length} branches · engine target ${SET.abc ? 'ABC (A10·B8·C6 wk)' : SET.weeks + ' wk'}`;
    $('branchTiles').querySelectorAll('.sp-tile').forEach(t => {
      const go = () => openBranch(t.dataset.code);
      t.addEventListener('click', go);
      t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  // ═══ BRANCH WORKSPACE ══════════════════════════════════════════════
  function openBranch(code) {
    const branch = BRANCHES.find(b => b.code === code); if (!branch) return;
    S.branch = branch; S.sort = { key: null, dir: 1 }; S.search = ''; $('gridSearch').value = '';
    S.vis.weekly = loadVis('weekly'); S.vis.daily = loadVis('daily');
    $('branchLanding').style.display = 'none'; $('branchGrid').style.display = '';
    $('gridTitle').textContent = branch.name;
    $('gridScope').textContent = `Main+Gateway is the send pool · ${SET.abc ? 'ABC tiers' : SET.weeks + '-week target'} · avg: ${SET.avgSource.replace(/_/g, ' ')}`;
    setView('weekly');
  }
  function setView(v) {
    S.view = v;
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    closeSide();
    if (v === 'history') { showHistory(); return; }
    S.mode = v; S.stage = 'draft'; S.lines = [];
    const d = loadDraft();
    if (d && d.lines && d.lines.length) restoreDraft(d);
    S.mode = v; enterGrid();
  }
  function enterGrid() {
    $('rpScroll').style.display = ''; $('rpHistory').style.display = 'none'; $('rpStage').style.display = ''; $('rpFoot').style.display = '';
    // O diário tem regra própria e ela precisa estar na tela, não no treinamento.
    const note = $('rpDailyNote');
    if (note) {
      note.style.display = S.mode === 'daily' ? '' : 'none';
      note.innerHTML = 'Pedidos feitos até <b>12:00</b> de hoje. Não inclui a transferência semanal — '
        + 'essa vai na aba Weekly. Máximo de ' + DAILY_MAX + ' itens, e cada um precisa de motivo. '
        + 'O diário não passa pelo check do gerente.';
    }
    setControls(); renderStage(); renderGrid();
  }
  function setControls() {
    const gridding = S.view !== 'history';
    const draft = S.stage === 'draft';
    $('gridSearch').style.display = gridding ? '' : 'none';
    $('btnCols').style.display = gridding ? '' : 'none';
    $('btnReset').style.display = gridding ? '' : 'none';
    const showLoad = S.view === 'weekly' && draft;
    $('btnLoadSuggest').style.display = showLoad ? '' : 'none';
    if (showLoad) $('btnLoadSuggest').textContent = `Load suggested (${suggestionUniverse().filter(r => r.isSuggested).length})`;
  }

  // ── stage bar ────────────────────────────────────────────────────────
  const STAGE_NEXT = { draft: 'Submit to inventory team', submitted: m => m === 'weekly' ? 'Mark Ready to check' : 'Approve', ready_to_check: 'Approve' };
  function renderStage() {
    const steps = STAGES[S.mode], cur = stageIdx();
    const pills = steps.map((s, i) => `<span class="rp-step ${i < cur ? 'done' : i === cur ? 'now' : ''}">${STAGE_LABEL[s]}</span>` + (i < steps.length - 1 ? '<span class="rp-step-arrow">›</span>' : '')).join('');
    let action = '';
    if (S.stage !== 'approved') {
      let label = STAGE_NEXT[S.stage]; if (typeof label === 'function') label = label(S.mode);
      action = `<button class="sp-btn is-primary" id="btnAdvance" ${S.lines.length ? '' : 'disabled'}>${label} ›</button>`;
      if (cur > 0) action += ` <button class="sp-btn is-ghost" id="btnBackStage" style="font-size:13px">‹ back</button>`;
    } else {
      action = `<span class="rp-step done">✓ ${S.lastTr ? 'Colocado no Cin7 — ' + esc(S.lastTr) : 'Aprovado'}</span>
                <button class="sp-btn is-ghost" id="btnBackStage" style="font-size:13px">‹ reopen</button>`;
    }
    const hint = S.stage === 'draft' ? 'A filial preenche o Branch Ask'
      : S.stage === 'submitted' ? 'O time de estoque confere e ajusta o Inv Qty'
      : S.stage === 'ready_to_check' ? 'O gerente confere — comentários seguem abertos' : '';
    $('rpStage').innerHTML = `<div class="rp-steps">${pills}</div><span class="sp-gap"></span><span class="rp-sub">${hint}</span> ${action}`;
    const a = $('btnAdvance'); if (a) a.addEventListener('click', advanceStage);
    const b = $('btnBackStage'); if (b) b.addEventListener('click', backStage);
  }
  function advanceStage() {
    const steps = STAGES[S.mode], i = stageIdx(); if (i >= steps.length - 1) return;
    S.stage = steps[i + 1];
    // No Submit o Inv Qty nasce igual ao pedido da filial: o check vira
    // confirmar ou corrigir, não redigitar 40 linhas.
    if (S.stage === 'submitted') {
      let seeded = 0;
      S.lines.forEach(l => { if (l.invQty == null) { l.invQty = clampInt(l.ask); seeded++; } });
      if (seeded) saveDraft();
    }
    if (S.stage === 'approved') { saveDraft(); enterGrid(); return placeOrder(); }
    saveDraft(); enterGrid(); toast(`Stage → ${STAGE_LABEL[S.stage]}`);
  }
  function backStage() { const steps = STAGES[S.mode], i = stageIdx(); if (i > 0) { S.stage = steps[i - 1]; saveDraft(); enterGrid(); } }

  // ── columns ──────────────────────────────────────────────────────────
  function catalog(mode) {
    if (mode === 'daily') return [
      { key: 'dc', label: '5DC', w: 70, align: 'txt', group: 'id', sortable: true, def: true },
      { key: 'code', label: 'Rapid Code', w: 130, align: 'code', group: 'id', sortable: true, def: true, always: true },
      { key: 'name', label: 'Product', w: 0, align: 'txt', group: 'id', sortable: true, def: true },
      { key: 'ask', label: 'Qty', w: 80, align: 'num', group: 'ord', sortable: true, def: true, always: true },
      { key: 'reason', label: 'Reason', w: 230, align: 'txt', group: 'ord', sortable: false, def: true },
      { key: 'soh', label: 'SOH', w: 66, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'main', label: 'Main', w: 84, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'comment', label: 'Comments', w: 180, align: 'txt', group: 'ref', sortable: false, def: true },
    ];
    const c = [
      { key: 'dc', label: '5DC', w: 70, align: 'txt', group: 'id', sortable: true, def: true },
      { key: 'code', label: 'Rapid Code', w: 130, align: 'code', group: 'id', sortable: true, def: true, always: true },
      // Produto encolheu: ele empurrava as colunas de decisão para fora da tela.
      { key: 'name', label: 'Product', w: 210, align: 'txt', group: 'id', sortable: true, def: true },
      { key: 'loc', label: 'Location', w: 100, align: 'txt', group: 'id', sortable: true, def: false },
      // Ctn e Pallet vêm ANTES do pedido: são a unidade em que ele é feito.
      { key: 'ctn', label: 'Ctn Qty', w: 62, align: 'num', group: 'pack', sortable: true, def: true },
      { key: 'pallet', label: 'Pallet Qty', w: 72, align: 'num', group: 'pack', sortable: true, def: true },
      { key: 'ask', label: 'Branch Ask', w: 92, align: 'num', group: 'ord', sortable: true, def: true, always: true },
      // Inv Qty não existe no rascunho: ali ela ficava travada, ocupando espaço
      // e sugerindo que alguém deveria preenchê-la.
      { key: 'invQty', label: 'Inv Qty', w: 84, align: 'num', group: 'ord', sortable: true, def: true, stages: ['submitted', 'ready_to_check', 'approved'] },
      { key: 'avg', label: 'Mthly Avg', w: 80, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'soh', label: 'SOH', w: 64, align: 'num', group: 'stk', sortable: true, def: true },
      // In Transit deixa de ser coluna: vira marca cinza no SOH, com o TR no
      // painel. Ela custava 82px para dizer, quase sempre, "·".
      { key: 'cover', label: 'Cover', w: 108, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'main', label: 'Main', w: 84, align: 'num', group: 'stk', sortable: true, def: true },
    ];
    if (S.branch && VARIANT[S.branch.code]) c.push({ key: 'syd', label: 'SYD Stock', w: 82, align: 'num', group: 'stk', sortable: true, def: true });
    // Sem isto o usuário digitava errado e não tinha como desfazer: só apagar
    // o número, deixando uma linha morta na planilha que o check ia ter que
    // interpretar.
    c.push({ key: 'act', label: '', w: 54, align: 'num', group: 'ref', sortable: false, def: true, always: true });
    c.push({ key: 'comment', label: 'Comments', w: 180, align: 'txt', group: 'ref', sortable: false, def: true });
    c.push({ key: 'invComment', label: 'Inv Comments', w: 180, align: 'txt', group: 'ref', sortable: false, def: true,
             stages: ['submitted', 'ready_to_check', 'approved'] });
    return c;
  }
  function defVis(mode) { return new Set(catalog(mode).filter(c => c.def).map(c => c.key)); }
  function loadVis(mode) { try { const s = JSON.parse(localStorage.getItem('rp.cols.' + mode) || 'null'); if (Array.isArray(s) && s.length) return new Set(s); } catch (_) {} return defVis(mode); }
  function saveVis(mode) { try { localStorage.setItem('rp.cols.' + mode, JSON.stringify([...S.vis[mode]])); } catch (_) {} }
  function visibleCols() {
    const set = S.vis[S.mode] || defVis(S.mode);
    // Uma coluna que só faz sentido depois do rascunho não aparece antes dele.
    return catalog(S.mode).filter(c => (set.has(c.key) || c.always) && (!c.stages || c.stages.includes(S.stage)));
  }

  // ── grid ─────────────────────────────────────────────────────────────
  function visibleLines() {
    let rows = S.lines.slice();
    if (S.search) { const q = S.search.toLowerCase(); rows = rows.filter(r => (r.code + ' ' + r.name + ' ' + r.dc).toLowerCase().includes(q)); }
    if (S.sort.key) {
      const k = S.sort.key, d = S.sort.dir;
      rows.sort((a, b) => { const va = sortVal(a, k), vb = sortVal(b, k); return (typeof va === 'number' && typeof vb === 'number') ? (va - vb) * d : String(va).localeCompare(String(vb)) * d; });
    }
    return rows;
  }
  function sortVal(l, k) {
    switch (k) {
      case 'dc': return l.dc || ''; case 'code': return l.code || ''; case 'name': return l.name || '';
      case 'ctn': return l.ctn || 0; case 'loc': return l.loc || ''; case 'avg': return l.avg || 0;
      case 'soh': return l.soh || 0; case 'inTransit': return l.inTransit || 0; case 'cover': return l.coverWeeks;
      case 'main': return l.mainGw || 0; case 'ask': return clampInt(l.ask);
      case 'invQty': return l.invQty == null ? -1 : clampInt(l.invQty); case 'syd': return l.syd || 0;
      case 'reason': return l.reason || ''; case 'comment': return l.comment || ''; default: return '';
    }
  }
  // As duas colunas que o usuário caça o tempo todo ganham cor própria.
  const IDCLS = { main: ' c-main', avg: ' c-avg' };
  function renderGrid() {
    const C = visibleCols(), rows = visibleLines();
    const gcls = g => g === 'stk' ? 'g-stk' : g === 'ord' ? 'g-ord' : g === 'ref' ? 'g-ref' : g === 'pack' ? 'g-pack' : '';
    let prevG = null;
    const head = '<thead><tr>' + C.map(c => {
      const sep = (c.group !== prevG && prevG !== null) ? ' gsep' : ''; prevG = c.group;
      const a = c.align === 'num' ? 'num' : 'txt';
      const arrow = c.sortable ? `<span class="ar">${S.sort.key === c.key ? (S.sort.dir > 0 ? '▲' : '▼') : '▲'}</span>` : '';
      return `<th class="${a} ${gcls(c.group)}${IDCLS[c.key] || ''}${sep}${c.sortable ? ' srt' + (S.sort.key === c.key ? ' on' : '') : ''}" data-k="${c.key}"${c.w ? ` style="width:${c.w}px"` : ''}>${esc(c.label)}${arrow}</th>`;
    }).join('') + '</tr></thead>';
    let body = rows.map(l => {
      const nomain = l.mainGw <= 0;
      const open = S.sideSku && String(l.code).toUpperCase() === S.sideSku ? ' rp-open' : '';
      return `<tr class="rp-line${nomain ? ' rp-nomain' : ''}${l.flag ? ' rp-flagged' : ''}${open}" data-code="${esc(l.code)}">` + C.map(c => cell(l, c)).join('') + '</tr>';
    }).join('');
    // Excel-style empty rows to fill (draft only, not while searching)
    if (S.stage === 'draft' && !S.search) {
      const idCols = C.filter(c => c.group === 'id'), rest = C.filter(c => c.group !== 'id');
      const atMax = S.mode === 'daily' && S.lines.length >= DAILY_MAX;
      const blank = `<tr class="rp-blank"><td colspan="${idCols.length || 1}">${atMax ? '<span class="rp-sub">Daily limit reached (12 items)</span>' : '<input class="rp-acq" placeholder="＋ add product — type 5DC, Rapid Code or name…" autocomplete="off">'}</td>` +
        rest.map(c => `<td class="${c.group === 'ord' ? 'g-ord' : ''}"></td>`).join('') + '</tr>';
      body += atMax ? blank : blank.repeat(BLANK_ROWS);
    }
    if (!rows.length && S.stage !== 'draft') body = `<tr><td colspan="${C.length}" class="sp-empty">No lines.</td></tr>`;
    $('rpGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
    const total = rows.reduce((s, l) => s + finalQty(l), 0);
    $('gridCount').textContent = `${rows.length} line${rows.length === 1 ? '' : 's'} · ${n0(total)} units`;
    wireGrid();
  }
  function cell(l, c) {
    const g = c.group, gc = (g === 'ord' ? ' g-ord' : g === 'pack' ? ' g-pack' : '') + (IDCLS[c.key] || '');
    const base = c.align === 'num' ? 'num' : c.align === 'code' ? 'code txt' : 'txt';
    const wrap = (inner, extra, title) => `<td class="${base}${gc}${extra || ''}"${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`;
    switch (c.key) {
      case 'dc': return wrap(esc(l.dc) || '<span class="rp-sub">—</span>');
      case 'code': return wrap(esc(l.code));
      case 'name': return wrap(esc(l.name), '', l.name);
      case 'ctn': return wrap(l.ctn ? n0(l.ctn) : '<span class="rp-sub">—</span>');
      case 'loc': return wrap(esc(l.loc) || '<span class="rp-sub">—</span>', '', l.loc);
      case 'avg': return wrap(l.avg ? n1(l.avg) : '<span class="rp-sub">—</span>');
      case 'soh': {
        // In Transit era uma coluna de 82px que quase sempre dizia "·". Vira
        // marca aqui, e o painel mostra o TR — que é o que o usuário quer ver.
        const t = l.inTransit ? `<span class="rp-transit" title="${n0(l.inTransit)} em trânsito para esta filial — abra a linha para ver o TR">▸${n0(l.inTransit)}</span>` : '';
        return wrap((l.soh < 0 ? `<span class="rp-neg">${n0(l.soh)}</span>` : n0(l.soh)) + t);
      }
      case 'pallet': return wrap(l.pallet ? n0(l.pallet) : '<span class="rp-sub">—</span>', '', l.pallet ? `${n0(l.pallet)} por pallet` : 'Sem pallet cadastrado para este 5DC');
      case 'inTransit': return wrap(l.inTransit ? n0(l.inTransit) : '<span class="rp-sub">·</span>');
      case 'cover': {
        const w = l.coverWeeks;
        const mk = !l.avg ? '' : (w * 7 < 7 ? '<span class="rp-mk low">low</span>' : w > 12 ? '<span class="rp-mk over">over</span>' : '');
        // Para onde o pedido leva a cobertura. É a pergunta que o usuário faz
        // ao digitar a quantidade, e ele respondia de cabeça.
        const q = finalQty(l);
        const after = (l.avg > 0 && q > 0)
          ? (l.soh + l.inTransit + q) / (l.avg / RC.WEEKS_IN_MONTH) : null;
        const arrow = after == null ? ''
          : `<span class="rp-after" title="Com ${n0(q)} unidades, a cobertura vai de ${n1(w >= 999 ? 0 : w)} para ${n1(after)} semanas">›${n1(after)}w</span>`;
        return wrap(`${l.avg ? n1(w >= 999 ? 0 : w) + 'w' : '<span class="rp-sub">n/a</span>'}${mk}${arrow}`,
          '', l.avg ? `${Math.round(w * 7)} dias de cobertura hoje` : '');
      }
      case 'main': return wrap(n0(l.mainGw), '', `Main ${n0(l.mainOnly)} · Gateway ${n0(l.gw)} · Main avg/mo ${n1(l.mainAvg)}`);
      case 'ask':
        return wrap(askEditable() ? `<input class="rp-in big" data-k="ask" value="${clampInt(l.ask) || ''}" inputmode="numeric">` : `<span class="rp-lock">${n0(clampInt(l.ask))}</span>`);
      case 'invQty': {
        if (invEditable()) return `<td class="num g-ord"><input class="rp-in big" data-k="invQty" value="${l.invQty == null ? '' : clampInt(l.invQty)}" inputmode="numeric"></td>`;
        const val = l.invQty == null ? '<span class="rp-sub" title="Abre quando a filial dá Submit e o estoque começa o check">—</span>' : `<span class="rp-lock">${n0(clampInt(l.invQty))}</span>`;
        return `<td class="num g-ord locked">${val}</td>`;
      }
      case 'syd': return wrap(n0(l.syd));
      case 'act': {
        const bits = [];
        // O alerta é para quem faz o check final: diz "olhe esta com atenção".
        // Vale em qualquer estágio menos o aprovado, que é imutável.
        if (S.stage !== 'approved')
          bits.push(`<button class="rp-act rp-flag${l.flag ? ' on' : ''}" data-act="flag" title="${l.flag ? 'Tirar o alerta' : 'Marcar para conferência extra no check'}">!</button>`);
        if (askEditable())
          bits.push(`<button class="rp-act rp-del" data-act="del" title="Remover esta linha">×</button>`);
        return `<td class="num rp-acts">${bits.join('')}</td>`;
      }
      case 'reason': return `<td class="txt${gc}">${askEditable() ? `<input class="rp-in txt" data-k="reason" value="${esc(l.reason)}" placeholder="why — e.g. just sold, special order…">` : esc(l.reason) || '<span class="rp-sub">—</span>'}</td>`;
      case 'comment':
        // O comentário da filial é dela, e trava quando ela entrega. Depois
        // disso quem fala é o Inv Comments.
        return `<td class="txt">${askEditable()
          ? `<input class="rp-in txt" data-k="comment" value="${esc(l.comment)}" placeholder="nota da filial…">`
          : (esc(l.comment) || '<span class="rp-sub">—</span>')}</td>`;
      case 'invComment':
        return `<td class="txt">${invEditable()
          ? `<input class="rp-in txt" data-k="invComment" value="${esc(l.invComment || '')}" placeholder="resposta do estoque…">`
          : (esc(l.invComment) || '<span class="rp-sub">—</span>')}</td>`;
      default: return wrap('—');
    }
  }
  function wireGrid() {
    const tb = $('rpGrid');
    tb.querySelectorAll('th.srt').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k; if (S.sort.key === k) S.sort.dir = -S.sort.dir; else { S.sort.key = k; S.sort.dir = 1; } renderGrid();
    }));
    tb.querySelectorAll('input.rp-in').forEach(inp => {
      const l = lineByRow(inp.closest('tr')); if (!l) return; const k = inp.dataset.k;
      inp.addEventListener('input', () => { if (k === 'ask') l.ask = clampInt(inp.value); else if (k === 'invQty') l.invQty = inp.value === '' ? null : clampInt(inp.value); else l[k] = inp.value; if (k === 'ask' || k === 'invQty') updateCount(); });
      inp.addEventListener('change', saveDraft);
      inp.addEventListener('click', e => e.stopPropagation());
    });
    tb.querySelectorAll('button.rp-act').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const l = lineByRow(b.closest('tr')); if (!l) return;
      if (b.dataset.act === 'del') {
        const i = S.lines.indexOf(l); if (i < 0) return;
        S.lines.splice(i, 1); toast(`${l.code} removido`);
      } else {
        l.flag = !l.flag;
      }
      // renderStage também: apagar a última linha tem de desabilitar o avanço.
      saveDraft(); renderGrid(); renderStage();
    }));
    tb.querySelectorAll('tr.rp-line').forEach(tr => tr.addEventListener('click', e => {
      if (e.target.closest('input,button,a,textarea')) return; const l = lineByRow(tr); if (l) openSide(l);
    }));
    const ac = tb.querySelector('.rp-acq'); tb.querySelectorAll('.rp-acq').forEach(a => attachAutocomplete(a)); if (ac && S.autoFocusAdd) { ac.focus(); S.autoFocusAdd = false; }
  }
  function lineByRow(tr) { if (!tr) return null; const code = tr.getAttribute('data-code'); return code ? S.lines.find(l => l.code === code) : null; }
  function updateCount() { const rows = visibleLines(); const total = rows.reduce((s, l) => s + finalQty(l), 0); $('gridCount').textContent = `${rows.length} line${rows.length === 1 ? '' : 's'} · ${n0(total)} units`; }

  // ── load suggested (merge, write-protected) ──────────────────────────
  function openLoadModal() {
    closeSide();
    const uni = suggestionUniverse(), sug = uni.filter(r => r.isSuggested);
    const have = new Set(S.lines.map(l => String(l.code).toUpperCase()));
    const toAdd = sug.filter(r => !have.has(String(r.code).toUpperCase()));
    $('loadMsg').innerHTML = `<b>${toAdd.length}</b> suggested line${toAdd.length === 1 ? '' : 's'} for <b>${esc(S.branch.name)}</b> under ${SET.cutDays}d cover.` +
      (S.lines.length ? ` Your ${S.lines.length} existing line${S.lines.length === 1 ? '' : 's'} stay untouched.` : '');
    $('loadConfirm').textContent = toAdd.length ? `Load ${toAdd.length}` : 'Nothing to add';
    $('loadConfirm').disabled = !toAdd.length;
    $('mdLoad')._toAdd = toAdd;
    $('mdLoad').classList.add('is-on');
  }
  function doLoad() {
    const toAdd = $('mdLoad')._toAdd || [];
    toAdd.forEach(r => S.lines.push(Object.assign({}, r)));   // ask already = sug
    // renderStage() junto, e não é detalhe: o botão de avançar nasce disabled
    // quando a planilha está vazia, e sem este redesenho a filial carregava as
    // sugestões e ficava sem conseguir dar Submit até recarregar a página.
    $('mdLoad').classList.remove('is-on'); saveDraft(); renderGrid(); renderStage();
    toast(`Loaded ${toAdd.length} suggested — kept your ${S.lines.length - toAdd.length}`);
  }

  // ── autocomplete ─────────────────────────────────────────────────────
  let acState = { items: [], sel: -1, input: null };
  function attachAutocomplete(input) {
    input.addEventListener('input', () => { acState.input = input; acSearch(input.value); });
    input.addEventListener('focus', () => { acState.input = input; if (input.value) acSearch(input.value); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); acMove(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); acMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (acState.sel >= 0 && acState.items[acState.sel]) acPick(acState.items[acState.sel].sku); }
      else if (e.key === 'Escape') acHide();
    });
    input.addEventListener('blur', () => setTimeout(acHide, 150));
    input.addEventListener('click', e => e.stopPropagation());
  }
  function acSearch(q) {
    q = (q || '').trim().toLowerCase(); if (q.length < 2) return acHide();
    const starts = [], contains = [];
    let hidDep = 0, hidNoMain = 0;
    for (const p of S.prodList) {
      // Deprecated não entra: 2.744 de 11.259 no catálogo, e a filial não deve
      // pedir o que a empresa já aposentou.
      if (p.status === 'Deprecated') { hidDep++; continue; }
      // Nem o que Main+Gateway não tem: pedir o que ninguém pode mandar só
      // gera uma linha que morre no check. São 5.909 dos 8.515 ativos.
      const kk = String(p.sku || '').toUpperCase();
      if (((S.stock.MAIN && S.stock.MAIN[kk]) || 0) + ((S.stock.GATEWAY && S.stock.GATEWAY[kk]) || 0) <= 0) { hidNoMain++; continue; }
      const sku = kk.toLowerCase(), dc = String(p.attribute1 || '').toLowerCase(), nm = String(p.name || '').toLowerCase();
      if (sku.startsWith(q) || dc.startsWith(q)) starts.push(p);
      else if (sku.includes(q) || dc.includes(q) || nm.includes(q)) contains.push(p);
      if (starts.length >= 25) break;
    }
    acState.hidden = { dep: hidDep, noMain: hidNoMain };
    const items = starts.concat(contains).slice(0, 25); acState.items = items; acState.sel = items.length ? 0 : -1;
    const ac = $('rpAc');
    ac.innerHTML = items.length ? items.map((p, i) => {
      const k = String(p.sku).toUpperCase(), main = (S.stock.MAIN && S.stock.MAIN[k] || 0) + (S.stock.GATEWAY && S.stock.GATEWAY[k] || 0);
      return `<div data-sku="${esc(p.sku)}" class="${i === acState.sel ? 'sel' : ''}"><span class="sku">${esc(p.sku)}</span>${p.attribute1 ? `<span class="dc">${esc(p.attribute1)}</span>` : ''}<span class="nm">${esc(p.name || '')}</span><span class="st">Main ${n0(main)}</span></div>`;
    }).join('') : '<div class="none">No product matches</div>';
    // Esconder em silêncio faria o usuário procurar um código que existe e
    // concluir que o sistema está quebrado.
    ac.innerHTML += `<div class="acfoot">Hidden: deprecated products, and anything Main + Gateway cannot send today.</div>`;
    ac.querySelectorAll('[data-sku]').forEach(d => d.addEventListener('mousedown', e => { e.preventDefault(); acPick(d.dataset.sku); }));
    positionAc(); ac.classList.add('on');
  }
  function acMove(dir) { const ac = $('rpAc'); if (!acState.items.length) return; acState.sel = (acState.sel + dir + acState.items.length) % acState.items.length; [...ac.children].forEach((c, i) => c.classList.toggle('sel', i === acState.sel)); const el = ac.children[acState.sel]; if (el) el.scrollIntoView({ block: 'nearest' }); }
  function positionAc() {
    if (!acState.input) return;
    const ac = $('rpAc'), r = acState.input.getBoundingClientRect();
    ac.style.left = r.left + 'px'; ac.style.minWidth = Math.max(460, r.width) + 'px';
    const h = Math.min(340, ac.scrollHeight || 340), below = window.innerHeight - r.bottom;
    // flip up when the dropdown would spill past the bottom of the (non-scrolling) viewport
    ac.style.top = (below < h + 8 && r.top > below) ? Math.max(4, r.top - h - 4) + 'px' : (r.bottom + 4) + 'px';
  }
  function acHide() { $('rpAc').classList.remove('on'); acState.items = []; acState.sel = -1; }
  function acPick(sku) {
    acHide(); const k = String(sku).toUpperCase();
    if (S.lines.some(l => String(l.code).toUpperCase() === k)) { toast('Already on the sheet'); return; }
    if (S.mode === 'daily' && S.lines.length >= DAILY_MAX) { toast(`Daily limit is ${DAILY_MAX} items`, true); return; }
    const row = buildRow(sku); if (!row) { toast('Product not found', true); return; }
    row.ask = 0; S.lines.push(row); saveDraft(); S.autoFocusAdd = true; renderStage(); renderGrid();
  }

  // ── right side panel ─────────────────────────────────────────────────
  function openSide(line) {
    const sku = String(line.code).toUpperCase(); S.sideSku = sku;
    $('sideTitle').textContent = line.code;
    document.querySelectorAll('#rpGrid tr.rp-line').forEach(tr => tr.classList.toggle('rp-open', tr.getAttribute('data-code') && tr.getAttribute('data-code').toUpperCase() === sku));
    const avgRow = S.avgBy[sku] || null;
    const across = BRANCHES.map(b => {
      const soh = Number((S.stock[b.code] && S.stock[b.code][sku]) || 0);
      const a = avgRow ? pickAvg(avgRow, b) : 0;
      const it = Number((S.inT[b.code] && S.inT[b.code][sku]) || 0);
      return { code: b.code, name: b.name, soh, a, it, here: b.code === S.branch.code };
    });
    const mainSoh = Number((S.stock.MAIN && S.stock.MAIN[sku]) || 0), gwSoh = Number((S.stock.GATEWAY && S.stock.GATEWAY[sku]) || 0);
    const mainAvg = avgRow ? RC.pickMainAvg(avgRow) : 0;
    $('sideBody').innerHTML = `
      <div class="rp-side-code">${esc(line.code)}</div>
      <div class="rp-side-name">${esc(line.name || '')}</div>
      <div class="sp-panel" style="margin-top:14px"><h4>Across branches <span>avg / mo · SOH · on the way</span></h4><div class="in" style="padding:0">
        <table><thead><tr><th>Branch</th><th class="n">Avg</th><th class="n">SOH</th><th class="n">In transit</th></tr></thead><tbody>
        ${across.map(x => `<tr class="${x.here ? 'rp-side-here' : ''}"><td>${esc(x.name)}${x.here ? ' •' : ''}</td><td class="n">${x.a ? n1(x.a) : '·'}</td><td class="n ${x.soh < 0 ? 'rp-neg' : ''}">${n0(x.soh)}</td><td class="n">${x.it ? n0(x.it) : '·'}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="sp-panel"><h4>Main &amp; Gateway <span>the send pool</span></h4><div class="in">
        <div class="rp-kv"><span>Main SOH</span><b>${n0(mainSoh)}</b></div>
        <div class="rp-kv"><span>Gateway SOH</span><b>${n0(gwSoh)}</b></div>
        <div class="rp-kv"><span>Main+Gateway</span><b>${n0(mainSoh + gwSoh)}</b></div>
        <div class="rp-kv"><span>Main avg / mo</span><b>${n1(mainAvg)}</b></div>
        <div id="sideBins" class="rp-kv"><span>Main bins</span><b class="rp-sub">loading…</b></div>
        <div id="sideOnWay" class="rp-kv"><span>On the way</span><b class="rp-sub">loading…</b></div>
      </div></div>
      <div class="sp-panel"><h4>Comment</h4><div class="in">
        <textarea class="rp-side-txt" id="sideComment" ${S.stage === 'approved' ? 'disabled' : ''} placeholder="note for this line…">${esc(line.comment || '')}</textarea>
      </div></div>`;
    const ta = $('sideComment'); if (ta) ta.addEventListener('input', () => { line.comment = ta.value; const inp = document.querySelector(`#rpGrid tr[data-code="${cssEsc(line.code)}"] input[data-k="comment"]`); if (inp) inp.value = ta.value; }); if (ta) ta.addEventListener('change', saveDraft);
    $('side').classList.add('is-on');
    loadSideDetail(line.code);
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }
  async function loadSideDetail(rawCode) {
    const up = String(rawCode).toUpperCase();
    try {
      // query the DB's own casing (in-memory maps are upper-cased, the table may not be)
      const { data, error } = await sb().schema('cin7_mirror').from('stock_snapshot').select('location_name,in_transit,on_order,bin,next_delivery_date').eq('sku', rawCode);
      if (error) throw error; if (S.sideSku !== up) return;
      const bins = []; let onway = 0, eta = null;                 // on-the-way scoped to the send pool (Main+Gateway), like bins
      for (const r of (data || [])) {
        const b = locBucket(r.location_name); if (b !== 'MAIN' && b !== 'GATEWAY') continue;
        if (r.bin && String(r.bin).trim()) bins.push(String(r.bin).trim());
        const inc = (Number(r.in_transit) || 0) + (Number(r.on_order) || 0);
        if (inc > 0) { onway += inc; if (r.next_delivery_date && (!eta || r.next_delivery_date < eta)) eta = r.next_delivery_date; }
      }
      const binEl = $('sideBins'); if (binEl) binEl.innerHTML = `<span>Main bins</span>${bins.length ? `<span class="rp-bins">${[...new Set(bins)].map(x => `<span class="rp-bin">${esc(x)}</span>`).join('')}</span>` : '<b class="rp-sub">—</b>'}`;
      const owEl = $('sideOnWay'); if (owEl) owEl.innerHTML = `<span>On the way (Main)</span>${onway ? `<b>${n0(onway)} ${eta ? `<span class="rp-eta">ETA ${esc(String(eta).slice(0, 10))}</span>` : ''}</b>` : '<b class="rp-sub">nothing incoming</b>'}`;
    } catch (e) {
      if (S.sideSku !== up) return;
      const bEl = $('sideBins'); if (bEl) bEl.innerHTML = '<span>Main bins</span><b class="rp-sub">n/a</b>';
      const oEl = $('sideOnWay'); if (oEl) oEl.innerHTML = '<span>On the way (Main)</span><b class="rp-sub">n/a</b>';
    }
  }
  function closeSide() { S.sideSku = null; $('side').classList.remove('is-on'); document.querySelectorAll('#rpGrid tr.rp-open').forEach(t => t.classList.remove('rp-open')); }


  // ── colocar o pedido no Cin7 ────────────────────────────────────────────
  // A idempotência de verdade está no servidor (op_key UNIQUE derivada do
  // conteúdo do plano). Este `placing` é só cortesia: impede o segundo clique
  // de sair, mas nunca é a garantia — o usuário pode recarregar e clicar de novo.
  let placing = false;
  async function placeOrder() {
    if (placing) return;
    const lines = S.lines.map(l => ({ sku: l.code, qty: finalQty(l) })).filter(x => x.qty > 0);
    if (!lines.length) { toast('Nenhuma linha com quantidade', true); return; }
    placing = true;
    const btn = $('btnAdvance'); if (btn) { btn.disabled = true; btn.textContent = 'Enviando ao Cin7…'; }
    try {
      const r = await fetch('/api/replenishment/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sp-user': (localStorage.getItem('rp.user') || 'branch') },
        body: JSON.stringify({
          branch_code: S.branch.code, branch_name: S.branch.name, mode: S.mode,
          week_ending: weekEndingISO(), lines,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      S.lastTr = d.number;
      toast(d.already ? `Já estava colocado: ${d.number}` : `${d.number} criado no Cin7 · ${d.order_lines} linhas`);
      renderStage();
    } catch (e) {
      // Voltar o estágio: aprovado sem TR seria mentira na tela.
      S.stage = STAGES[S.mode][STAGES[S.mode].length - 2];
      saveDraft(); enterGrid();
      toast(`Não deu para colocar: ${e.message}`, true);
    } finally {
      placing = false;
    }
  }
  // A semana que termina no domingo, no formato que o servidor guarda.
  function weekEndingISO() {
    const d = new Date(); const dow = d.getDay();          // 0=domingo
    d.setDate(d.getDate() + (dow === 0 ? 0 : 7 - dow));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── history (approved snapshots) ─────────────────────────────────────
  function histKey() { return `rp.history.${S.branch.code}`; }
  function loadHist() { try { return JSON.parse(localStorage.getItem(histKey()) || '[]'); } catch (_) { return []; } }
  function snapshotToHistory() {
    const list = loadHist();
    const snap = {
      id: weekLabel() + '-' + new Date().toISOString().slice(11, 19), approvedAt: new Date().toISOString(),
      week: weekLabel(), mode: S.mode, total: S.lines.reduce((s, l) => s + finalQty(l), 0),
      lines: S.lines.map(l => ({ code: l.code, name: l.name, dc: l.dc, ask: clampInt(l.ask), invQty: l.invQty == null ? null : clampInt(l.invQty), final: finalQty(l), soh: l.soh, avg: l.avg, mainGw: l.mainGw, reason: l.reason || '', comment: l.comment || '' })),
    };
    list.unshift(snap); try { localStorage.setItem(histKey(), JSON.stringify(list.slice(0, 60))); } catch (_) {}
  }
  // ── History ─────────────────────────────────────────────────────────────
  // Lê do BANCO, não do localStorage. O snapshot foi congelado no momento do
  // envio: recalcular a partir do estoque de hoje daria outro número e o
  // histórico deixaria de ser histórico. Cada cartão abre e fecha sozinho —
  // uma lista de 40 linhas aberta esconde os outros envios.
  async function showHistory() {
    $('rpScroll').style.display = 'none'; $('rpStage').style.display = 'none'; $('rpFoot').style.display = 'none';
    $('rpHistory').style.display = ''; setControls();
    $('rpHistory').innerHTML = '<div class="rp-hist-empty">Carregando…</div>';
    let rows = [];
    try {
      const r = await fetch(`/api/replenishment/orders?branch=${encodeURIComponent(S.branch.code)}`);
      rows = (await r.json()).rows || [];
    } catch (e) {
      $('rpHistory').innerHTML = `<div class="rp-hist-empty">Não deu para ler o histórico.<br><span class="rp-sub">${esc(e.message)}</span></div>`;
      return;
    }
    if (!rows.length) {
      $('rpHistory').innerHTML = `<div class="rp-hist-empty">Nenhum pedido colocado ainda para ${esc(S.branch.name)}.<br>
        <span class="rp-sub">Quando um plano é aprovado, o TR gerado fica registrado aqui, congelado nos valores do envio.</span></div>`;
      return;
    }
    histRows = rows;
    $('rpHistory').innerHTML = rows.map((o, i) => histCard(o, i)).join('');
    wireHistory();
  }
  let histRows = [], histOpen = new Set();

  function histCard(o, i) {
    const when = o.ordered_at || o.created_at;
    const bad = o.status === 'FAILED';
    const open = histOpen.has(i);
    return `<div class="rp-h2 ${bad ? 'is-bad' : ''}" data-i="${i}">
      <div class="rp-h2-head">
        <button class="rp-h2-tog" data-tog="${i}" title="${open ? 'Fechar' : 'Abrir as linhas'}">${open ? '▾' : '▸'}</button>
        <span class="rp-h2-tr">${esc(o.cin7_number || '—')}</span>
        <span class="badge ${o.mode === 'daily' ? 'is-daily' : 'is-weekly'}">${o.mode === 'daily' ? 'Daily' : 'Weekly'}</span>
        <span class="rp-h2-when">${esc(fmtWhen(when))}</span>
        <span class="rp-h2-meta">${o.line_count} linha${o.line_count === 1 ? '' : 's'} · ${n0(o.total_units)} un</span>
        <span class="rp-h2-route">${esc(o.from_location || '')} › ${esc(o.to_location || o.branch_name || '')}</span>
        <span class="sp-gap"></span>
        <span class="rp-h2-st ${bad ? 'bad' : ''}">${esc(o.status)}</span>
        ${o.cin7_number ? `<button class="ui-act" data-print="${i}">Print</button>` : ''}
      </div>
      ${bad && o.error ? `<div class="rp-h2-err">${esc(o.error)}</div>` : ''}
      ${open ? histLines(o) : ''}
    </div>`;
  }
  function histLines(o) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    return `<div class="rp-h2-body"><table class="sp-grid rp-grid">
      <thead><tr><th class="txt" style="width:160px">Rapid Code</th><th class="num" style="width:90px">Qty</th></tr></thead>
      <tbody>${lines.map(l => `<tr><td class="code txt">${esc(l.sku)}</td><td class="num"><b>${n0(l.qty)}</b></td></tr>`).join('')}</tbody>
    </table></div>`;
  }
  function fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  }
  function wireHistory() {
    $('rpHistory').querySelectorAll('[data-tog]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const i = +b.dataset.tog;
      if (histOpen.has(i)) histOpen.delete(i); else histOpen.add(i);
      $('rpHistory').innerHTML = histRows.map((o, k) => histCard(o, k)).join('');
      wireHistory();
    }));
    $('rpHistory').querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); printOrder(histRows[+b.dataset.print]);
    }));
  }

  // Reimprimir. Janela própria e não a página: imprimir a tela levaria o menu,
  // os filtros e o resto junto.
  function printOrder(o) {
    const lines = Array.isArray(o.lines) ? o.lines : [];
    const w = window.open('', '_blank', 'width=820,height=900');
    if (!w) { toast('O navegador bloqueou a janela de impressão', true); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(o.cin7_number || 'Transfer')}</title>
      <style>
        body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1b2230;margin:26px}
        h1{font-size:19px;margin:0 0 3px} .sub{color:#5b6472;font-size:12px;margin-bottom:16px}
        table{border-collapse:collapse;width:100%;font-size:12.5px}
        th{background:#f1f3f6;text-align:left;padding:6px 9px;border-bottom:1px solid #cfd6df;font-size:11px;
           text-transform:uppercase;letter-spacing:.05em;color:#5b6472}
        td{padding:5px 9px;border-bottom:1px solid #e6eaef}
        td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
        tfoot td{font-weight:700;border-top:2px solid #cfd6df;border-bottom:0}
        @media print{body{margin:12mm}}
      </style>
      <h1>${esc(o.cin7_number || '—')} · ${esc(o.from_location || '')} › ${esc(o.to_location || o.branch_name || '')}</h1>
      <div class="sub">${o.mode === 'daily' ? 'Daily' : 'Weekly'} · ${esc(fmtWhen(o.ordered_at || o.created_at))}
        · ${o.line_count} linhas · ${n0(o.total_units)} unidades · ${esc(o.status)}${o.created_by ? ' · ' + esc(o.created_by) : ''}</div>
      <table><thead><tr><th>Rapid Code</th><th class="n">Qty</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td>${esc(l.sku)}</td><td class="n">${n0(l.qty)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td>Total</td><td class="n">${n0(o.total_units)}</td></tr></tfoot></table>`);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 260);
  }

  // ── draft persistence ────────────────────────────────────────────────
  function draftKey() { return `rp.draft.${S.branch.code}.${S.mode}`; }
  function saveDraft() {
    try {
      localStorage.setItem(draftKey(), JSON.stringify({ stage: S.stage, week: weekLabel(),
        lines: S.lines.map(l => ({ code: l.code, ask: clampInt(l.ask), invQty: l.invQty == null ? null : clampInt(l.invQty), reason: l.reason || '', comment: l.comment || '' })) }));
    } catch (_) {}
  }
  function loadDraft() { try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (_) { return null; } }
  function restoreDraft(d) {
    S.stage = d.stage || 'draft';
    S.lines = (d.lines || []).map(sv => { const r = buildRow(sv.code); if (!r) return null; r.ask = clampInt(sv.ask); r.invQty = sv.invQty == null ? null : clampInt(sv.invQty); r.reason = sv.reason || ''; r.comment = sv.comment || ''; return r; }).filter(Boolean);
  }
  function startOver() {
    if (S.lines.length && !confirm('Start this plan over? Your current lines will be cleared (approved snapshots are kept in History).')) return;
    try { localStorage.removeItem(draftKey()); } catch (_) {}
    S.stage = 'draft'; S.lines = []; closeSide(); enterGrid(); toast('Cleared — start fresh');
  }
  function weekLabel() { const d = new Date(), j = new Date(d.getFullYear(), 0, 1); const wk = Math.ceil((((d - j) / 86400000) + j.getDay() + 1) / 7); return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`; }

  // ── averages tab (consultative) ──────────────────────────────────────
  function renderAverages() {
    const q = ($('avSearch').value || '').toLowerCase(), bf = $('avBranch').value, nz = $('avNonZero').classList.contains('is-on');
    const C = [['code', 'Rapid Code', 128], ['name', 'Product', 240]].concat(BRANCHES.map(b => [b.code, b.name, 90]));
    let rows = S.avg.slice(); if (q) rows = rows.filter(r => String(r.product || '').toLowerCase().includes(q));
    rows = rows.map(r => { const p = S.prod[String(r.product || '').toUpperCase()] || {}; const vals = {}; BRANCHES.forEach(b => { vals[b.code] = pickAvg(r, b); }); return { code: r.product, name: p.name || '', vals }; });
    if (nz) rows = rows.filter(r => BRANCHES.some(b => r.vals[b.code] > 0)); if (bf) rows = rows.filter(r => r.vals[bf] > 0);
    rows = rows.slice(0, 600);
    const head = '<thead><tr>' + C.map(c => `<th class="${c[0] === 'code' || c[0] === 'name' ? 'txt' : 'num'}" style="width:${c[2]}px">${c[1]}</th>`).join('') + '</tr></thead>';
    const body = rows.map(r => '<tr><td class="code txt">' + esc(r.code) + '</td><td class="txt">' + esc(String(r.name).slice(0, 44)) + '</td>' + BRANCHES.map(b => `<td class="num">${r.vals[b.code] > 0 ? n1(r.vals[b.code]) : '<span style="color:#c3ccda">·</span>'}</td>`).join('') + '</tr>').join('');
    $('avGrid').innerHTML = head + '<tbody>' + body + '</tbody>'; $('avCount').textContent = `${rows.length} shown`;
  }

  // ── settings ─────────────────────────────────────────────────────────
  function openSettings() {
    closeSide();
    $('setWeeks').value = SET.weeks; $('setDays').value = Math.round(SET.weeks * 7) + ' days'; $('setCutDays').value = SET.cutDays; $('setAbc').checked = SET.abc;
    $('setAvgSource').value = SET.avgSource; $('setPeriod').value = SET.period; $('setAvgRound').value = SET.avgRound; $('setCartons').checked = SET.cartons;
    const rows = S.avg.map(r => ({ code: r.product, tot: BRANCHES.reduce((s, b) => s + pickAvg(r, b), 0) })).filter(r => r.tot > 0).sort((a, b) => b.tot - a.tot).slice(0, 60);
    $('setAvgTable').innerHTML = '<thead><tr><th class="txt">Rapid Code</th><th class="num">Tier</th><th class="num">Network avg/mo</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td class="code txt">${esc(r.code)}</td><td class="num"><span class="rp-tier ${(S.ranks && S.ranks.get(r.code)) || 'C'}">${(S.ranks && S.ranks.get(r.code)) || 'C'}</span></td><td class="num">${n1(r.tot)}</td></tr>`).join('') + '</tbody>';
    $('mdSettings').classList.add('is-on');
  }
  $('setWeeks') && $('setWeeks').addEventListener('input', e => { $('setDays').value = Math.round((Number(e.target.value) || 0) * 7) + ' days'; });
  function applySettings() {
    SET.weeks = Math.max(1, Number($('setWeeks').value) || 6); SET.cutDays = Math.max(1, Number($('setCutDays').value) || 25);
    SET.abc = $('setAbc').checked; SET.avgSource = $('setAvgSource').value; SET.period = $('setPeriod').value; SET.avgRound = $('setAvgRound').value; SET.cartons = $('setCartons').checked;
    saveSet(); $('mdSettings').classList.remove('is-on');
    if (S.branch) { if (S.view !== 'history') { closeSide(); S.lines = S.lines.map(l => { const r = buildRow(l.code); if (!r) return l; r.ask = l.ask; r.invQty = l.invQty; r.reason = l.reason; r.comment = l.comment; return r; }); setControls(); renderGrid(); } }
    else renderLanding();
    toast('Settings applied — recomputed');
  }

  // ── column chooser ───────────────────────────────────────────────────
  function openCols() {
    closeSide();
    const cat = catalog(S.mode), set = S.vis[S.mode];
    $('colsList').innerHTML = cat.map(c => `<label><input type="checkbox" data-ck="${c.key}" ${set.has(c.key) || c.always ? 'checked' : ''} ${c.always ? 'disabled' : ''}> ${esc(c.label)}${c.always ? ' <span class="rp-sub">(fixed)</span>' : ''}</label>`).join('');
    $('colsList').querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.ck; if (inp.checked) set.add(k); else set.delete(k); saveVis(S.mode); renderGrid();
    }));
    $('mdCols').classList.add('is-on');
  }

  // ── tabs / wiring ────────────────────────────────────────────────────
  function showTop(v) {
    document.querySelectorAll('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === v));
    document.querySelectorAll('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === v));
    if (v === 'branches') closeSide();
    if (v === 'averages') { $('avBranch').innerHTML = '<option value="">All branches</option>' + BRANCHES.map(b => `<option value="${b.code}">${b.name}</option>`).join(''); renderAverages(); closeSide(); }
  }
  function wire() {
    document.querySelectorAll('.sp-tab').forEach(b => b.addEventListener('click', () => showTop(b.dataset.view)));
    $('btnBack').addEventListener('click', renderLanding);
    document.querySelectorAll('#viewSeg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
    $('btnSettings').addEventListener('click', openSettings);
    $('btnLoadSuggest').addEventListener('click', openLoadModal);
    $('btnCols').addEventListener('click', openCols);
    $('btnReset').addEventListener('click', startOver);
    $('loadConfirm').addEventListener('click', doLoad);
    $('sideClose').addEventListener('click', closeSide);
    $('setApply').addEventListener('click', applySettings);
    $('setReset').addEventListener('click', () => { SET = Object.assign({}, DEFAULTS); openSettings(); });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('mdSettings').classList.remove('is-on')));
    document.querySelectorAll('[data-close-load]').forEach(b => b.addEventListener('click', () => $('mdLoad').classList.remove('is-on')));
    document.querySelectorAll('[data-close-cols]').forEach(b => b.addEventListener('click', () => $('mdCols').classList.remove('is-on')));
    $('gridSearch').addEventListener('input', e => { S.search = e.target.value; renderGrid(); });
    ['avSearch', 'avBranch'].forEach(id => $(id).addEventListener('input', renderAverages));
    $('avNonZero').addEventListener('click', function () { this.classList.toggle('is-on'); renderAverages(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { ['mdSettings', 'mdLoad', 'mdCols'].forEach(m => $(m).classList.remove('is-on')); closeSide(); } });
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
