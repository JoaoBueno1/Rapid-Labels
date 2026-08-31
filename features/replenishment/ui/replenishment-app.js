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
  // Local: o stock-planning tem a sua, e importar de lá acoplaria dois
  // módulos por causa de três linhas.
  const debounce = (fn, ms = 180) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  // dd/mm/yyyy em toda a interface, definido uma vez. Espalhar
  // toLocaleDateString pelo código foi como o History acabou com outro formato.
  const dmy = (v) => { if (!v) return '—'; const d = new Date(v); if (isNaN(d)) return String(v);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`; };
  const dmyTime = (v) => { const d = new Date(v); return isNaN(d) ? '—'
    : `${dmy(v)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const clampInt = v => { const n = Math.round(Number(v)); return isFinite(n) && n > 0 ? n : 0; };
  const BLANK_ROWS = 10;

  // ── settings ─────────────────────────────────────────────────────────
  // ABC desligado por padrao: os degraus 10/8/6 vieram de quando a media era
// uma coluna importada. Com 13 meses de historico e janela escolhivel, a
// cobertura pura e mais honesta — quem quiser os degraus liga no Settings.
  // As quatro regras, nomeadas. Faltavam duas: o rodapé mostrava o código cru
  // ("rep_then_branch") para quem escolhesse uma delas.
  const DEMAND_LABEL = {
    branch: 'branch only', rep: 'reps only',
    branch_then_rep: 'branch, reps fill the gaps',
    rep_then_branch: 'reps, branch fills the gaps',
    both: 'the larger of the two',
  };

  /* Migração dos modos que saíram.
     'both' nunca foi regra de sugestão — o motor caía em 'branch' com ele, e
     por isso o mapeamento é exato, não uma escolha minha.
     'rep_then_branch' vira 'rep': medido, os dois diferem em 202 de 6.861
     pares filial-SKU, 3%. Quem tinha aquele modo perde a diferença em 3% das
     linhas, e ganha um seletor com três opções em vez de cinco. */
  const DEMAND_MIGRA = { both: 'branch', rep_then_branch: 'rep' };
  /* `period` saiu daqui. Ele era lido e escrito contra um #setPeriod que não
     existe no HTML desde que os dois seletores viraram um só — zero
     ocorrências no arquivo. Deixá-lo no DEFAULTS fazia o delete da migração
     ser desfeito na linha seguinte pelo Object.assign, e o campo morto
     ressuscitava a cada carga. */
  const DEFAULTS = { weeks: 6, cutDays: 25, abc: false, avgSource: 'branch', avgRound: 'pure', cartons: false,
    // demand: qual das duas médias vira quantidade sugerida. Não decide mais o
    // que a planilha MOSTRA — as duas estão sempre lá, cada uma na sua coluna.
    // O padrão é o fallback porque em 1.891 de 6.861 pares filial-SKU só o rep
    // vendeu: com 'branch' puro, o motor não sugeriria nada para eles.
    demand: 'branch_then_rep', salesMonths: 6,
    // minAvg: o piso de demanda, em unidades por mês.
    //
    // Sem ele, 37% das linhas de Sydney (459 SKUs) vinham de itens que vendem
    // menos de um por mês e somam 1,5% da demanda. A causa não é a régua nem o
    // arredondamento: é o Math.ceil do computeBranchTarget, que faz QUALQUER
    // demanda positiva virar alvo >= 1. Um item que vendeu uma unidade em seis
    // meses ganha alvo permanente na filial, e a filial zerada vira sugestão.
    //
    // Medido: piso 1/mês corta 41% das linhas e custa 3% das unidades.
    minAvg: 1 };
  let SET = loadSet();
  function loadSet() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem('rp.set') || '{}'); } catch (_) {}
    // Migra quem já tinha os dois seletores antigos: avgBasis e repMonths
    // viraram demand e salesMonths, e guardar os dois nomes convidaria a
    // divergirem em silêncio.
    if (raw.avgBasis && !raw.demand) raw.demand = raw.avgBasis === 'rep' ? 'rep' : 'branch';
    if (raw.repMonths && !raw.salesMonths) raw.salesMonths = raw.repMonths;
    delete raw.avgBasis; delete raw.repMonths;
    // E os dois modos que saíram do seletor. Sem isto, quem tem 'both' salvo
    // fica com um <select> que não casa com nenhuma opção e volta em branco.
    if (DEMAND_MIGRA[raw.demand]) raw.demand = DEMAND_MIGRA[raw.demand];

    /* avgSource ficou ÓRFÃO e mudava o número em silêncio.
       Ele perdeu o <select> quando os dois seletores viraram um só, mas
       continuou sendo lido pelo pickAvg — e sem migração. Qualquer navegador
       que apertou Apply antes daquela mudança guardou 'rep_then_branch' até
       hoje, e não havia campo nenhum na tela que mostrasse isso.
       Medido em Sydney, modo branch: 'branch' dá 11 linhas / 958 un e
       'rep_then_branch' dá 38 / 1.988 — 3,5x, invisível.
       Foi uma das duas causas de duas máquinas discordarem no mesmo commit.
       Agora ele é forçado ao padrão: quem decide a régua é `demand`, que tem
       seletor, e um segundo botão escondido decidindo a mesma coisa é a
       definição de configuração fantasma. */
    if (raw.avgSource && raw.avgSource !== DEFAULTS.avgSource) {
      console.warn(`[replenishment] avgSource="${raw.avgSource}" salvo neste navegador `
        + `foi trocado por "${DEFAULTS.avgSource}": o campo não existe mais na tela `
        + `e mudava os números sem aparecer.`);
    }
    raw.avgSource = DEFAULTS.avgSource;
    delete raw.period;   // mesma história: lido, sem elemento no HTML desde f87e34e
    // 'up' saiu do seletor. computeBranchTarget JÁ faz Math.ceil no alvo, então
    // arredondar a média para cima antes era um teto em cima de outro: média
    // 0,2 virava 1 e alvo 2 — dois anos de estoque parado. Medido em Sydney,
    // 'up' AUMENTAVA as linhas (236 -> 240) e inflava 208 unidades. Não é
    // preferência, é defeito; por isso migra em vez de continuar oferecendo.
    if (raw.avgRound === 'up') raw.avgRound = 'pure';
    const migrado = Object.assign({}, DEFAULTS, raw);

    /* Grava de volta.
       Sem isto a migração roda em memória e o localStorage guarda o valor
       velho para sempre — e migração que não persiste não é migração, é
       contorno repetido a cada carga. Pior: quem inspeciona o rp.set para
       comparar duas máquinas vê o valor antigo e conclui que a migração não
       funcionou. Foi exatamente o que aconteceu quando fui testar. */
    try {
      if (JSON.stringify(migrado) !== JSON.stringify(raw)) {
        localStorage.setItem('rp.set', JSON.stringify(migrado));
      }
    } catch (_) { /* modo privado — a migração vale para esta sessão */ }
    return migrado;
  }
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
    avg: [], avgBy: {}, ranks: null, stock: {}, inT: {}, prod: {}, prodList: [], pallet: {}, repAvg: {}, repAvgInfo: null, loaded: false,
    branch: null, view: 'weekly', mode: 'weekly', stage: 'draft', lines: [],
    sort: { key: null, dir: 1 }, search: '', vis: { weekly: null, daily: null }, sideSku: null,
    // Divergências entre a leitura emendada e o total que o servidor informa.
    emenda: [],
    // A régua viva de TODAS as filiais, por código. S.repAvg é a janela para a
    // filial aberta; os cartões da tela inicial precisam das sete.
    avgLive: {}, avgLiveInfo: {},
  };
  const BRANCHES = (RC && RC.BRANCHES) || [];   // guarded: init() shows a status if the engine is missing
  const DEPOTS = (RC && RC.DEPOTS) || [];       // Main e Project: origem, não destino
  // O nome do depósito no Cin7, que nem sempre é o nome que a tela mostra.
  const depotOf = (code) => {
    const b = BRANCHES.concat(DEPOTS).find(x => x.code === code);
    return b ? (b.warehouse || b.name) : '';
  };
  const VARIANT = { MEL: true, HBA: true };
  /* O nome do depósito no Cin7, por filial. O espelho de vendas grava
     location_name e não o código, e Sunshine Coast tem sufixo lá e as outras
     não — foi o que já quebrou um join neste projeto. */
  const LOCAL = { SYD: 'Sydney', MEL: 'Melbourne', BNE: 'Brisbane', CNS: 'Cairns',
                  CFS: 'Coffs Harbour', HBA: 'Hobart', SCS: 'Sunshine Coast Warehouse' };
  const DAILY_MAX = 12;

  // SKU de embalagem: 652 dos 8.515 ativos terminam em -Carton<N>. A filial não
  // pede caixa, pede unidade — e pedido impresso com esses produtos não é usado.
  // Esconder é suficiente: eles continuam existindo no Cin7, só não são
  // oferecidos nem sugeridos aqui.
  const isPackSku = sku => /carton|(-|\s)(ctn|pk)\d*$/i.test(String(sku || ''));

  /* O saldo do Gateway que PODE ser enviado. Marcar "não usar no Gateway" no
     Master Stock tem de tirar o número da conta, não só desenhar um aviso:
     senão o motor continua sugerindo em cima de um estoque que ninguém vai
     separar de lá. Sem marca nenhuma isto devolve o saldo inteiro — hoje é o
     caso de 100% do catálogo, então nada muda até alguém decidir. */
  const gwStock = k => (S.gwOff && S.gwOff.has(k)) ? 0 : Number((S.stock.GATEWAY && S.stock.GATEWAY[k]) || 0);

  // Deprecated no Cin7 esconde o produto — a não ser que alguém tenha aberto o
  // Master Stock e dito que ainda vale. A marca do usuário vence o ERP.
  const escondePorDeprecated = (p, k) => p.status === 'Deprecated' && !(S.allow && S.allow.has(k));

  const locBucket = name => {
    const n = String(name || '').toLowerCase();
    if (n.startsWith('main')) return 'MAIN'; if (n.startsWith('gateway')) return 'GATEWAY';
    if (n.startsWith('sydney')) return 'SYD'; if (n.startsWith('melbourne')) return 'MEL';
    if (n.startsWith('brisbane')) return 'BNE'; if (n.startsWith('cairns')) return 'CNS';
    if (n.startsWith('coffs')) return 'CFS'; if (n.startsWith('hobart')) return 'HBA';
    if (n.startsWith('sunshine')) return 'SCS'; return null;
  };

  /* Emenda páginas de 1.000 e CONFERE o resultado contra o total que o próprio
     PostgREST informa (`count: 'exact'`).
     Paginar sem conferir publica um número que ninguém validou: o rodapé diz
     "Live · 15.301 stock rows" e essa frase é lida como fato. Duas rodadas
     completas hoje não perderam uma linha — mas o sync roda 24×/dia e faz
     TRUNCATE commitado sozinho antes de reinserir em ~31 lotes, cada um sua
     transação. Existe janela em que o leitor vê a tabela pela metade, e uma
     resposta parcial é tão convincente quanto uma completa. `.order()` não
     fecha essa janela — leitura ordenada de tabela meio-vazia devolve metade,
     ordenada. O que fecha é comparar com o total e DIZER quando não bate.
     `S.emenda` guarda a divergência para o rodapé. */
  async function fetchAll(from, sel, opts) {
    let out = [], i = 0, total = null;
    for (;;) {
      const q = (opts && opts.schema ? sb().schema(opts.schema) : sb())
        .from(from).select(sel, { count: 'exact' }).range(i, i + 999);
      const { data, error, count } = await q; if (error) throw error;
      if (total == null && count != null) total = count;
      out = out.concat(data || []); if (!data || data.length < 1000) break; i += 1000;
    }
    if (total != null && out.length !== total) {
      (S.emenda || (S.emenda = [])).push({ tabela: from, emendado: out.length, esperado: total });
    }
    return out;
  }

  // A régua do REP: soma de todos os reps alocados à filial, sem olhar de onde
  // a mercadoria saiu. Existe porque a régua do local tem um buraco medido —
  // quando a filial está sem estoque o pedido despacha do Main e a venda some
  // da conta dela. Em Brisbane isso é +175%, e 635 SKUs vendem pelo rep com
  // ZERO pelo local: a média por local diz "não vende" e o motor nem sugere.
  /* A régua viva de UMA filial. `depotOf` e não `S.branch.name`: o nome de
     exibição de Sunshine Coast é "Sunshine Coast" e o depósito no Cin7 é
     "Sunshine Coast Warehouse" — mandando o de exibição, loc_avg voltava ZERO
     para os 914 SKUs dela, e zero em régua de demanda é "não vende". */
  async function fetchBranchAvg(code) {
    const qs = new URLSearchParams({ branch: code, location: depotOf(code), months: SET.salesMonths || 6 });
    const d = await fetch(`/api/replenishment/branch-averages?${qs}`).then(r => r.json());
    if (d.error) throw new Error(d.error);
    const porSku = {};
    d.rows.forEach(r => { porSku[r.sku_key] = r; });
    return { porSku, info: { months: d.months, reps: d.reps || [], count: d.rep_count,
                             breakdown: d.rep_breakdown || [], orphans: d.orphans || [],
                             totals: d.totals || null, location: d.location } };
  }

  /* AS SETE FILIAIS, não só a aberta.
     Os cartões da tela inicial calculam a sugestão de CADA filial trocando
     S.branch e chamando o mesmo motor. Carregando a régua só da filial aberta,
     na tela inicial não há filial aberta nenhuma — e os sete cartões
     mostravam ZERO. Zero ali é "está tudo abastecido", que é a leitura mais
     cara possível de um erro de carregamento.
     Sete chamadas em paralelo ao nosso próprio servidor; a página já traz
     15.301 linhas de estoque e 11.259 produtos. */
  async function loadRepAvg(codes) {
    const alvos = codes && codes.length ? codes : BRANCHES.map(b => b.code);
    const res = await Promise.all(alvos.map(async (code) => {
      try { return { code, ...(await fetchBranchAvg(code)) }; }
      catch (e) { return { code, erro: e.message }; }
    }));
    const falhou = [];
    for (const r of res) {
      if (r.erro) { falhou.push(`${r.code}: ${r.erro}`); S.avgLive[r.code] = {}; S.avgLiveInfo[r.code] = null; continue; }
      S.avgLive[r.code] = r.porSku; S.avgLiveInfo[r.code] = r.info;
    }
    /* Falhar aqui NÃO pode ser silencioso.
       O catch vazio de antes deixava a régua vazia e a tela seguia sem sinal.
       Medido em Sydney: o padrão cai de 56 para 11 linhas e o modo rep vai a
       ZERO — e parece que "não há o que repor". Foi assim que a falta de
       variável de ambiente numa máquina passou por regressão de código. */
    S.repAvgErro = falhou.length ? falhou.join(' · ') : null;
    if (falhou.length) console.error('[replenishment] régua não carregou:', S.repAvgErro);
    apontarRegua();
  }

  // S.repAvg / S.repAvgInfo são a janela para a filial ABERTA. O resto do
  // código continua lendo por esses nomes; quem troca de filial troca a janela.
  function apontarRegua() {
    const c = S.branch && S.branch.code;
    S.repAvg = (c && S.avgLive[c]) || {};
    S.repAvgInfo = (c && S.avgLiveInfo[c]) || null;
  }

  // Recarregar a régua não basta: as linhas já na tela foram construídas com o
  // valor antigo, e enterGrid() só redesenha o que elas têm. Sem costurar, a
  // segunda leitura do Cover não aparecia ao trocar a regra no Settings.
  async function refreshRepAvg() {
    // Só a filial aberta: trocar a janela de meses não precisa rebuscar as sete.
    await loadRepAvg(S.branch ? [S.branch.code] : null);
    S.lines.forEach(l => {
      const r = S.repAvg[String(l.code).toUpperCase()];
      l.repAvg = r ? r.rep_avg : null; l.locAvg = r ? r.loc_avg : null; l.repCount = r ? r.reps : 0;
      l.storedAvg = r ? Number(r.loc_avg || 0) : 0;
    });
  }

  async function loadBase() {
    setStatus('loading', 'Loading live stock & averages…');
    const [avg, stock, prod, pallet] = await Promise.all([
      fetchAll('branch_avg_monthly_sales', '*'),
      fetchAll('stock_snapshot', 'sku,location_name,available,in_transit', { schema: 'cin7_mirror' }),
      fetchAll('products', 'sku,attribute1,name,stock_locator,carton_quantity,status', { schema: 'cin7_mirror' }),
      // ATENÇÃO: nesta tabela a coluna chamada `sku` guarda o 5DC e a chamada
      // `product` guarda o SKU real — os nomes estão trocados. Juntar pela
      // coluna `sku` casa mais (2.276 ativos contra 1.772) e está errado: um
      // 5DC cobre o produto base E a variante -CartonNN, e a quantidade por
      // pallet de uma caixa de 26 não é a de uma unidade.
      fetchAll('pallet_capacity_rules', 'product,qty_pallet'),
    ]);
    S.avg = avg;
    S.avgBy = {}; avg.forEach(r => { if (r.product) S.avgBy[String(r.product).toUpperCase()] = r; });
    /* Os produtos que alguém marcou no Master Stock como "não mandar para
       filial". Vem por endpoint e não pelo PostgREST porque a decisão mora em
       rapid_inv.sku_settings, e aquele schema não é exposto ao navegador.
       Falhar aqui NÃO pode derrubar a tela: sem a lista a reposição continua
       funcionando como sempre funcionou, só sem esse corte — e o rodapé do
       autocomplete deixa de prometer que ele existe. */
    S.blocked = new Set(); S.blockedNote = {};
    S.allow = new Set(); S.gwOff = new Set(); S.lifeFlag = {};
    try {
      const r = await fetch('/api/stock-planning/replenishment-blocked');
      if (r.ok) { const b = await r.json();
        S.blocked = new Set(b.keys || []); S.blockedNote = b.notes || {};
        // Quem alguém liberou de propósito, mesmo o Cin7 dizendo Deprecated.
        S.allow = new Set(b.allow || []);
        // Quem não pode sair do Gateway: o saldo de lá some do pool de envio.
        S.gwOff = new Set(b.gateway_off || []);
        // DISCONTINUED e RUN-OUT: aparecem com bandeira, não somem. Um item
        // aposentado ainda tem saldo, e é sobre esse saldo que se decide.
        S.lifeFlag = b.flags || {}; }
    } catch (_) { /* segue sem o corte */ }
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
      const k = String(r.product || '').trim().toUpperCase(); const v = Number(r.qty_pallet) || 0;
      if (k && v > 0) S.pallet[k] = v;
    }
    S.stock = buckets; S.inT = inT; S.ranks = RC.computeAbcRanks(avg); S.loaded = true;
    // Se a emenda não bateu com o total do servidor, o rodapé diz isso em vez
    // de anunciar um número redondo que ninguém conferiu.
    if (S.emenda && S.emenda.length) {
      const e = S.emenda[0];
      setStatus('bad', `Partial read — ${e.tabela} returned ${n0(e.emendado)} of ${n0(e.esperado)} rows. Reload before ordering.`);
    } else {
      setStatus('fresh', `Live · ${n0(stock.length)} stock rows · ${n0(avg.length)} SKUs with averages`);
    }
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
    /* AS DUAS RÉGUAS VÊM DA MESMA FONTE E DA MESMA JANELA.
       Antes não vinham: `stored` saía de branch_avg_monthly_sales — uma tabela
       carregada à mão, de 29/07/2026, com 481 SKUs para Sydney — e `fromRep`
       saía da RPC ao vivo, com 1.192. Comparar as duas era comparar relógios
       diferentes, e a regra padrão ("branch, senão rep") escolhia entre elas
       linha a linha, misturando um número de um mês atrás com um de hoje.
       Agora `loc_avg` e `rep_avg` saem da MESMA chamada, mesma janela, mesmo
       dado. A régua padrão continua sendo a da filial — só que certa.
       O valor da tabela antiga segue disponível como `tableAvg`, para o painel
       poder mostrar a diferença em vez de escondê-la. */
    // Pela filial do argumento e não pela aberta: branchSuggestedCount troca
    // S.branch para contar cada cartão, e ler S.repAvg daria a régua errada.
    const viva = (S.avgLive[branch.code] || {})[k] || null;
    const tableAvg = avgRow ? pickAvg(avgRow, branch) : 0;
    const stored = viva ? Number(viva.loc_avg || 0) : 0;
    const fromRep = viva ? Number(viva.rep_avg || 0) : 0;
    // A régua escolhida MANDA no número que vira compra. Sem esta linha o
    // painel mostrava a diferença e o motor continuava comprando pela régua
    // antiga — a tela ficaria informando e não decidindo.
    const avg = SET.demand === 'rep' ? fromRep
              : SET.demand === 'branch' ? stored
              : SET.demand === 'branch_then_rep' ? (stored > 0 ? stored : fromRep)
              : SET.demand === 'rep_then_branch' ? (fromRep > 0 ? fromRep : stored)
              // 'both': o maior manda na sugestão, e as duas leituras aparecem
              // no Cover para o usuário ver de onde veio.
              : Math.max(stored, fromRep);
    const avail = Number(stock[k] || 0);
    const inTransit = Number((S.inT[branch.code] && S.inT[branch.code][k]) || 0);
    const mainOnly = Number((S.stock.MAIN && S.stock.MAIN[k]) || 0);
    const gw = gwStock(k);
    const mainGw = mainOnly + gw;
    const syd = Number((S.stock.SYD && S.stock.SYD[k]) || 0);
    const pallet = Number(S.pallet[k] || 0);   // por SKU, não por 5DC
    const ra = S.repAvg[k] || null;
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
      // A bandeira do Master Stock viaja com a linha: ela é gravada no
      // rascunho e a grade a desenha sem consultar o índice de novo.
      life: (S.lifeFlag && S.lifeFlag[k]) || '',
      gwBlocked: !!(S.gwOff && S.gwOff.has(k)),
      allowedDespiteCin7: !!(S.allow && S.allow.has(k)),
      repAvg: ra ? ra.rep_avg : null, locAvg: ra ? ra.loc_avg : null, repCount: ra ? ra.reps : 0,
      storedAvg: stored, tableAvg,
      loc: p.stock_locator || '', avg, soh: avail, inTransit, mainGw, mainOnly, gw, canSend, syd,
      tier, target, weeks, mainAvg, sug, coverWeeks,
      // invComment e flag nascem aqui para o rascunho salvo já ter o formato
      // novo — senão a linha antiga volta do localStorage sem eles.
      ask: sug, invQty: null, reason: '', comment: '', invComment: '', flag: false,
    };
  }

  // O mesmo corte vale para as sugestões: sem isto o SKU de caixa entra pela
  // porta dos fundos, no "Load suggested".
  function suggestionUniverse() {
    const out = [];
    /* O UNIVERSO DE CANDIDATOS vem das duas fontes, não só da tabela.
       Ele era `S.avg` — as 4.644 linhas de branch_avg_monthly_sales, carregadas
       à mão. Um SKU que a filial vende hoje e que não estava naquela planilha
       nunca era sequer avaliado: as médias podiam estar vivas e certas, e ele
       continuava fora da sugestão porque não existia na lista de entrada.
       Medido em Sydney: 816 SKUs pela régua da filial e 1.175 pela dos reps,
       contra 498 na tabela.
       A união é por chave em maiúscula porque as duas fontes escrevem o código
       com caixa diferente, e sem normalizar o mesmo SKU entrava duas vezes. */
    const universo = new Map();
    for (const r of S.avg) {
      const c = String(r.product || '').trim();
      if (c) universo.set(c.toUpperCase(), c);
    }
    for (const k of Object.keys(S.repAvg || {})) {
      if (!universo.has(k)) universo.set(k, (S.prod[k] && S.prod[k].sku) || k);
    }
    for (const c0 of universo.values()) {
      if (!c0) continue;
      const p = S.prod[c0.toUpperCase()] || {}; if (RC.isExcludedProduct(c0, p.name)) continue;
      if (isPackSku(c0) || escondePorDeprecated(p, c0.toUpperCase())) continue;
      // O MESMO corte do autocomplete. Aplicar num só deixaria o produto
      // bloqueado para quem digita e liberado para quem clica em "Load
      // suggested" — que é o buraco que já existe hoje entre os dois caminhos.
      if (S.blocked && S.blocked.has(c0.toUpperCase())) continue;
      const row = buildRow(c0); if (!row || row.avg <= 0) continue;
      const coverDays = Math.round(row.coverWeeks * 7);
      // O piso tira o item lento da sugestão AUTOMÁTICA — não da planilha:
      // quem digitar o código continua conseguindo pedir.
      //
      // TENTEI uma exceção aqui — "se a filial está zerada, sugere mesmo abaixo
      // do piso" — e ela ANULOU o piso: 236 linhas, o mesmo que não ter piso,
      // com 97 lentos voltando. O motivo é óbvio depois de medir: o item lento
      // zerado É a linha barulhenta. Alvo 1, estoque 0, cover 0 — a exceção
      // readmitia exatamente a população que o piso existe para tirar.
      //
      // O que a faria funcionar é recência, não estoque zero: "vendeu no último
      // mês E zerou" é reposição; "está zerado há seis meses" é item que a
      // filial não estoca. Isso precisa da data da última venda por SKU, que a
      // RPC ainda não devolve. Fica anotado, não improvisado.
      //
      // Sem ela o item lento continua na planilha e pode ser pedido digitando o
      // código — o piso tira da sugestão AUTOMÁTICA, não do alcance de quem
      // sabe que precisa. É o min/max com mínimo zero: a filial pede, o Main
      // atende, e ninguém espalha 459 SKUs por sete filiais.
      const passaNoPiso = row.avg >= (SET.minAvg || 0);
      row.isSuggested = (row.canSend > 0 && row.sug > 0 && coverDays < SET.cutDays && passaNoPiso);
      out.push(row);
    }
    out.sort((a, b) => (b.isSuggested - a.isSuggested) || (a.coverWeeks - b.coverWeeks) || (b.sug - a.sug));
    return out;
  }
  function branchSuggestedCount(code) {
    const save = S.branch; S.branch = BRANCHES.find(b => b.code === code);
    const n = suggestionUniverse().filter(r => r.isSuggested).length; S.branch = save; return n;
  }

  /* A contagem de SKU de uma filial por uma régua específica.
     Mesmo motor, mesma regra do Settings (cover < cutDays, piso, sem estoque no
     Main não conta) — é o MESMO número que o Load Suggested mostra. Contar de
     outro jeito aqui daria dois números para a mesma pergunta na mesma tela. */
  function branchCountFor(code, basis) {
    const b = S.branch, d = SET.demand;
    S.branch = BRANCHES.find(x => x.code === code); SET.demand = basis;
    try { return suggestionUniverse().filter(r => r.isSuggested).length; }
    finally { S.branch = b; SET.demand = d; }
  }
  function finalQty(l) { return (S.mode === 'weekly' && l.invQty != null) ? clampInt(l.invQty) : clampInt(l.ask); }

  // ═══ LANDING ═══════════════════════════════════════════════════════
  function renderLanding() {
    $('branchLanding').style.display = ''; $('branchGrid').style.display = 'none'; closeSide();
    /* CADA CARTÃO É DIVIDIDO NO MEIO.
       Em cima o que a filial DESPACHOU; embaixo o que os reps dela VENDERAM,
       com os nomes. As duas leituras lado a lado, por filial, na primeira
       tela — é aqui que se compara, não depois de entrar numa delas.
       E os nomes têm um segundo trabalho: rep novo que ninguém alocou some da
       régua da filial em silêncio. Vendo a lista, você percebe e aloca. */
    $('branchTiles').innerHTML = BRANCHES.map(b => {
      const inf = S.avgLiveInfo[b.code];
      const usaRep = SET.demand === 'rep' || SET.demand === 'rep_then_branch';
      // A MESMA unidade da linha de cima: quantidade de SKU sob a regra do
      // Settings. Unidades por mês era outra grandeza no mesmo cartão, e duas
      // grandezas empilhadas fazem o olho comparar o que não se compara.
      const nBranch = S.loaded ? branchCountFor(b.code, 'branch') : 0;
      const nRep = S.loaded ? branchCountFor(b.code, 'rep') : 0;
      // A cor do cartão segue a régua que está mandando: era o número da regra
      // configurada que a definia, e ele saiu.
      const nDriver = usaRep ? nRep : nBranch;
      // Só os nomes. O quanto cada rep vendeu não muda decisão nenhuma nesta
      // tela — o que ela responde é "quem é desta filial" e "está faltando
      // alguém". Número por rep vive no painel de dentro.
      const nomes = ((inf && inf.breakdown) || []).map(r => r.sales_rep);
      const cls = nDriver > 40 ? 'bad' : nDriver > 15 ? 'warn' : 'good';
      const reguas = inf ? `
        <div class="rp-tk">
          <div class="rp-tk-r${usaRep ? '' : ' is-driver'}"><span>Branch</span><b>${n0(nBranch)}</b></div>
          <div class="rp-tk-r${usaRep ? ' is-driver' : ''}"><span>Reps</span><b>${n0(nRep)}</b></div>
          <div class="rp-tile-sub">SKUs to restock (cover &lt; ${SET.cutDays}d)</div>
          ${nomes.length ? `<div class="rp-tk-reps">${esc(nomes.join(', '))}</div>` : ''}
          ${(inf.orphans || []).length ? `<div class="rp-tk-orphan" title="${
            esc(inf.orphans.map(o => o.sales_rep).join(', '))}">${n0(inf.orphans.length)} rep(s) with no branch</div>` : ''}
        </div>` : (S.repAvgErro ? '<div class="rp-tk rp-tk-bad">demand did not load</div>' : '');
      return `<div class="sp-tile ${cls}" data-code="${b.code}" role="button" tabindex="0">
        <span>${esc(b.name)}</span>
        ${reguas}
        ${VARIANT[b.code] ? '<span class="rp-tile-var">+ Sydney re-route</span>' : ''}</div>`;
    }).join('');
    $('landingNote').textContent = `${BRANCHES.length} branches · engine target ${SET.abc ? 'ABC (A10·B8·C6 wk)' : SET.weeks + ' wk'}`;
    renderBoard();
    $('branchTiles').querySelectorAll('.sp-tile').forEach(t => {
      const go = () => openBranch(t.dataset.code);
      t.addEventListener('click', go);
      t.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  /* ═══ O QUADRO DO QUE ESTÁ EM ANDAMENTO ══════════════════════════════
   *
   * Os cartões acima dizem quanto FALTA repor. Este diz o que já foi
   * começado — e é essa a informação que evita duas pessoas montarem o mesmo
   * pedido, ou um plano ficar parado em "submitted" a semana inteira sem
   * ninguém notar.
   *
   * Weekly e Daily aparecem JUNTOS, um ao lado do outro por filial: são dois
   * fluxos com estágios diferentes (o diário pula o check do gerente) e olhar
   * um de cada vez é como se perde o que está pendente no outro.
   *
   * LIMITE, dito na tela: o rascunho mora no localStorage deste navegador.
   * Este quadro mostra o que ESTE computador tem em andamento. O que já foi
   * enviado ao Cin7 vem do servidor e é o mesmo para todos — e é por isso que
   * as duas coisas aparecem separadas, e não somadas numa contagem só.
   */
  function readDraft(code, mode) {
    try {
      const d = JSON.parse(localStorage.getItem(`rp.draft.${code}.${mode}`) || 'null');
      if (!d || !Array.isArray(d.lines) || !d.lines.length) return null;
      return { stage: d.stage || 'draft', week: d.week || '',
               lines: d.lines.length,
               units: d.lines.reduce((n, l) => n + (Number(mode === 'weekly' && l.invQty != null ? l.invQty : l.ask) || 0), 0) };
    } catch (_) { return null; }
  }

  function renderBoard() {
    const el = $('rpBoard'); if (!el) return;
    const linhas = BRANCHES.map(b => ({ b, weekly: readDraft(b.code, 'weekly'), daily: readDraft(b.code, 'daily') }))
      .filter(x => x.weekly || x.daily);

    if (!linhas.length) {
      el.innerHTML = `<div class="rp-board-empty">
        Nothing in progress on this computer. Pick a branch above to start one.</div>`;
      return;
    }
    // A ordem é por urgência: o que espera alguém vem antes do que ainda está
    // sendo escrito. Um plano parado em "submitted" é o que trava a fila.
    const peso = { submitted: 0, ready_to_check: 1, draft: 2, approved: 3 };
    const pior = (x) => Math.min(...[x.weekly, x.daily].filter(Boolean).map(d => peso[d.stage] ?? 9));
    linhas.sort((a, b) => pior(a) - pior(b) || a.b.name.localeCompare(b.b.name));

    const pastilha = (d, modo) => {
      if (!d) return `<span class="rp-bs is-none">—</span>`;
      const espera = d.stage === 'submitted' ? 'the inventory team'
                   : d.stage === 'ready_to_check' ? 'the manager' : null;
      return `<span class="rp-bs st-${d.stage}" title="${esc(modo)} · ${n0(d.lines)} lines · ${n0(d.units)} units${
        espera ? ` · waiting on ${espera}` : ''}">${esc(STAGE_LABEL[d.stage] || d.stage)}<i>${n0(d.lines)}</i></span>`;
    };

    const esperando = linhas.filter(x => pior(x) <= 1).length;
    el.innerHTML = `
      <div class="rp-board-head">
        <b>In progress</b>
        <span>${esperando ? `${n0(esperando)} waiting on someone` : 'nothing is waiting'}</span>
        <span class="rp-board-note">drafts live on this computer · placed orders are shared</span>
      </div>
      <table class="rp-board-tbl"><thead><tr>
        <th>Branch</th><th>Weekly</th><th>Daily</th><th class="n">Units</th><th></th>
      </tr></thead><tbody>
      ${linhas.map(x => {
        const u = (x.weekly ? x.weekly.units : 0) + (x.daily ? x.daily.units : 0);
        return `<tr data-code="${esc(x.b.code)}" data-mode="${x.weekly ? 'weekly' : 'daily'}">
          <td class="em">${esc(x.b.name)}</td>
          <td>${pastilha(x.weekly, 'Weekly')}</td>
          <td>${pastilha(x.daily, 'Daily')}</td>
          <td class="n">${n0(u)}</td>
          <td class="n"><button class="ui-act">Open</button></td></tr>`;
      }).join('')}
      </tbody></table>`;
    el.querySelectorAll('tr[data-code]').forEach(tr => tr.addEventListener('click', () => {
      S.mode = tr.dataset.mode; openBranch(tr.dataset.code);
    }));
  }

  // ═══ BRANCH WORKSPACE ══════════════════════════════════════════════
  // O rodapé diz qual régua está valendo, e vive aqui e não em openBranch:
  // a régua muda no Settings, e escrito só na entrada da filial o rótulo
  // ficava velho enquanto os números já eram outros. Em Brisbane isso é a
  // diferença entre 20 e 396 sugestões — o pior tipo de rodapé errado.
  /* AS DUAS RÉGUAS, desenhadas.
     Em cima a da filial — o que saiu deste depósito — porque é ela que manda
     na sugestão. Embaixo a dos reps da filial — o que a filial vendeu, saindo
     de onde saísse — com os nomes e o que cada um somou.
     Os nomes não são enfeite: uma soma sem as parcelas não se confere, e a
     única pessoa que sabe se falta alguém na lista é quem lê a tela. */
  function writeRulers() {
    const el = $('rpRulers'); if (!el) return;
    const inf = S.repAvgInfo;
    if (!S.branch) { el.style.display = 'none'; return; }
    if (S.repAvgErro) {
      el.style.display = '';
      el.innerHTML = `<div class="rp-ruler rp-ruler-bad">
        <span class="rp-ruler-k">No ruler</span>
        <span class="rp-ruler-w"><b>The demand figures did not load</b> — every SKU below is showing
        zero demand, which is <b>not</b> the same as nothing to send. Do not order from this screen
        until it loads. <span class="rp-sub">${esc(S.repAvgErro)}</span></span></div>`;
      return;
    }
    if (!inf || !inf.totals) { el.style.display = 'none'; return; }
    el.style.display = '';
    const t = inf.totals;
    const usandoRep = SET.demand === 'rep' || SET.demand === 'rep_then_branch';
    // A diferença contra a tabela antiga, quando ela existe. Some quando o
    // usuário não tem mais nada carregado à mão — e some de propósito: um
    // aviso que nunca desliga vira parte do fundo.
    const daTabela = S.lines.length
      ? S.lines.reduce((a, l) => a + Number(l.tableAvg || 0), 0) : null;

    const chip = (r) => `<span class="rp-rep${Number(r.units) > 0 ? '' : ' is-quiet'}"
      title="${esc(r.sales_rep)} — ${n1(r.units_month)} a month · ${n0(r.units)} units, ${n0(r.orders)} orders and ${n0(r.skus)} SKUs across ${inf.months} months${
        r.note ? '\n' + esc(r.note) : ''}">${esc(r.sales_rep)}<b>${Number(r.units) > 0 ? n0(r.units_month) : '—'}</b></span>`;

    el.innerHTML = `
      <div class="rp-ruler${usandoRep ? '' : ' is-driver'}">
        <span class="rp-ruler-k">Branch</span>
        <span class="rp-ruler-v">${n0(t.loc_units)}<i>units / month</i></span>
        <span class="rp-ruler-n">${n0(t.loc_skus)} SKUs</span>
        <span class="rp-ruler-w">what shipped out of ${esc(inf.location || S.branch.name)} · live · ${inf.months}m${
          daTabela ? ` · the old loaded table said ${n0(daTabela)} for the lines on screen` : ''}</span>
        ${usandoRep ? '' : '<span class="rp-ruler-tag">driving the suggestion</span>'}
      </div>
      <div class="rp-ruler${usandoRep ? ' is-driver' : ''}">
        <span class="rp-ruler-k">By its reps</span>
        <span class="rp-ruler-v">${n0(t.rep_units)}<i>units / month</i></span>
        <span class="rp-ruler-n">${n0(t.rep_skus)} SKUs</span>
        <span class="rp-ruler-w">what ${esc(S.branch.name)} sold, wherever it shipped from · ${n0(inf.count)} reps · the chips below add up to this</span>
        ${usandoRep ? '<span class="rp-ruler-tag">driving the suggestion</span>' : ''}
        <div class="rp-reps">${(inf.breakdown || []).map(chip).join('')}</div>
        ${(inf.orphans || []).length ? `<div class="rp-orphan">
          <b>${n0(inf.orphans.length)} rep${inf.orphans.length === 1 ? '' : 's'} not allocated to any branch</b> —
          ${inf.orphans.slice(0, 6).map(o => `${esc(o.sales_rep)} (${n0(o.units)}${
            o.top_location ? ', mostly ' + esc(o.top_location) : ''})`).join(' · ')}.
          Their sales are missing from every branch ruler until someone allocates them.</div>` : ''}
      </div>`;
  }

  function writeScope() {
    const el = $('gridScope'); if (!el) return;
    const ruler = `${DEMAND_LABEL[SET.demand] || SET.demand} · ${SET.salesMonths}m`;
    el.textContent = `Main+Gateway is the send pool · ${SET.abc ? 'ABC tiers' : SET.weeks + '-week target'} · ruler: ${ruler}`;
  }

  function openBranch(code) {
    const branch = BRANCHES.find(b => b.code === code); if (!branch) return;
    S.branch = branch; apontarRegua();
    S.sort = { key: null, dir: 1 }; S.search = ''; $('gridSearch').value = '';
    S.vis.weekly = loadVis('weekly'); S.vis.daily = loadVis('daily');
    $('branchLanding').style.display = 'none'; $('branchGrid').style.display = '';
    $('gridTitle').textContent = branch.name;
    writeScope();
    setView('weekly');
  }
  function setView(v) {
    S.view = v;
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    closeSide();
    if (v === 'history') { const r = $('rpRulers'); if (r) r.style.display = 'none'; showHistory(); return; }
    S.mode = v; S.stage = 'draft'; S.lines = [];
    const d = loadDraft();
    if (d && d.lines && d.lines.length) restoreDraft(d);
    S.mode = v; enterGrid();
    // Assíncrono de propósito: a grade não espera por isto para aparecer.
    // writeRulers vem junto: o painel só tem número depois desta chamada.
    refreshRepAvg().then(() => { renderGrid(); writeRulers(); });
  }
  function enterGrid() {
    $('rpScroll').style.display = ''; $('rpHistory').style.display = 'none'; $('rpStage').style.display = ''; $('rpFoot').style.display = '';
    const rul = $('rpRulers'); if (rul) rul.style.display = '';
    // O diário tem regra própria e ela precisa estar na tela, não no treinamento.
    const note = $('rpDailyNote');
    if (note) {
      note.style.display = (S.view === 'daily') ? '' : 'none';
      note.innerHTML = 'Asked before <b>12:00</b> today. Does not include the weekly transfer — '
        + 'that goes on the Weekly tab. Up to ' + DAILY_MAX + ' items, each with a reason. '
        + 'Daily skips the manager check.';
    }
    setControls(); renderStage(); renderGrid();
  }
  function setControls() {
    writeScope(); writeRulers();
    const gridding = S.view !== 'history';
    const draft = S.stage === 'draft';
    $('gridSearch').style.display = gridding ? '' : 'none';
    $('btnCols').style.display = gridding ? '' : 'none';
    $('btnExport').style.display = gridding ? '' : 'none';
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
      action = `<span class="rp-step done">✓ ${S.lastTr ? 'Placed in Cin7 — ' + esc(S.lastTr) : 'Approved'}</span>
                <button class="sp-btn is-ghost" id="btnBackStage" style="font-size:13px">‹ reopen</button>`;
    }
    const hint = S.stage === 'draft' ? 'Branch fills Branch Ask'
      : S.stage === 'submitted' ? 'Inventory team checks and adjusts Inv Qty'
      : S.stage === 'ready_to_check' ? 'Manager checks — comments stay open' : '';
    // A lógica em uso fica ao lado dos estágios: ela muda TODOS os números da
    // tela, e quem chega no meio do fluxo não tem como saber qual está valendo.
    const ruler = `${DEMAND_LABEL[SET.demand] || SET.demand} · ${SET.salesMonths}m`;
    const logic = `<span class="rp-logic" title="Which demand the suggestions and the cover projection are using. Change it in Settings, or pick it when you load suggestions.">
        <b>${esc(ruler)}</b> · ${SET.abc ? 'ABC tiers' : SET.weeks + 'w cover'} · order under ${SET.cutDays}d</span>`;
    $('rpStage').innerHTML = `<div class="rp-steps">${pills}</div><span class="sp-gap"></span><span class="rp-sub">${hint}</span> ${logic} ${action}`;
    const a = $('btnAdvance'); if (a) a.addEventListener('click', advanceStage);
    const b = $('btnBackStage'); if (b) b.addEventListener('click', backStage);
  }
  function advanceStage() {
    const steps = STAGES[S.mode], i = stageIdx(); if (i >= steps.length - 1) return;
    // O diário exige motivo por linha. A regra estava escrita na tela e nunca
    // era verificada: dava para submeter 12 itens urgentes sem uma palavra.
    if (S.mode === 'daily' && S.stage === 'draft') {
      const sem = S.lines.filter(l => finalQty(l) > 0 && !String(l.comment || '').trim());
      if (sem.length) return toast(`${sem.length} line${sem.length === 1 ? '' : 's'} still need a reason`, true);
    }
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
  // UMA tabela só. O Daily tinha um catálogo próprio com 8 colunas contra as 14
  // do Weekly, e o resultado era que o mesmo produto mostrava informação
  // diferente dependendo da aba — sem Ctn, sem Pallet, sem Cover, sem Avg.
  // A diferença entre os dois fluxos é de PROCESSO (o diário pula o check do
  // gerente), não de tabela.
  //
  // O motivo do pedido vai no Comments, que é onde a filial já digita. Uma
  // coluna Reason separada obrigava a escolher entre dois campos de texto para
  // a mesma frase.
  function catalog(mode) {
    const c = [
      { key: 'dc', label: '5DC', w: 70, align: 'txt', group: 'id', sortable: true, def: true },
      // Medido: 12 de 120 códigos passavam de 130px e eram cortados, o pior
      // faltando 31px. R3250-300-BK-CW_R10503 é código de verdade, e código
      // cortado obriga a abrir o painel para ler o que já está na tela.
      { key: 'code', label: 'Rapid Code', w: 168, align: 'code', group: 'id', sortable: true, def: true, always: true },
      /* Produto era 210px numa linha e cortava em 105 de 120 linhas — ao pior
         faltavam 510px. Agora são 300px em duas linhas.
         Medido no catálogo: o nome tem mediana de 58 caracteres, p90 de 101 e
         máximo de 255. 300px em duas linhas comportam ~100, ou seja 90% deles
         inteiros. Os 10% mais longos ainda reticenciam — largura nenhuma
         resolve 255 caracteres — e para esses continua valendo o title e o
         painel da linha. */
      { key: 'name', label: 'Product', w: 300, align: 'txt', group: 'id', sortable: true, def: true },
      { key: 'loc', label: 'Location', w: 100, align: 'txt', group: 'id', sortable: true, def: false },
      // Ctn e Pallet vêm ANTES do pedido: são a unidade em que ele é feito.
      // Medido no cabeçalho, não no chute: Ctn Qty pedia 74px e tinha 59,
      // Pallet Qty pedia 95 e tinha 71. Um cabeçalho cortado é a mesma queixa
      // das células, só uma linha acima — e pior, porque ele nomeia a coluna.
      { key: 'ctn', label: 'Ctn Qty', w: 80, align: 'num', group: 'pack', sortable: true, def: true },
      { key: 'pallet', label: 'Pallet Qty', w: 100, align: 'num', group: 'pack', sortable: true, def: true },
      { key: 'ask', label: 'Branch Ask', w: 100, align: 'num', group: 'ord', sortable: true, def: true, always: true },
      // Inv Qty não existe no rascunho: ali ela ficava travada, ocupando espaço
      // e sugerindo que alguém deveria preenchê-la.
      { key: 'invQty', label: 'Inv Qty', w: 84, align: 'num', group: 'ord', sortable: true, def: true, stages: ['submitted', 'ready_to_check', 'approved'] },
      /* DUAS colunas de média, lado a lado e sempre visíveis.
         Era uma coluna só com a segunda leitura espremida como fantasma, e
         qual das duas aparecia dependia de um seletor no Settings. Isso pedia
         que o usuário configurasse antes de ver — e a comparação entre as
         duas é justamente o que ele precisa ver para decidir.
         Com as duas na tela, o seletor deixa de ser sobre o que MOSTRAR e
         passa a ser só sobre o que a SUGESTÃO usa. */
      // O estoque vem primeiro e as médias logo ao lado: a pergunta é "tenho
      // isto e vendo aquilo", e ler nessa ordem é uma comparação; com uma
      // coluna no meio vira duas leituras separadas.
      { key: 'soh', label: 'SOH', w: 72, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'avgBranch', label: 'Branch Avg', w: 110, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'avgRep', label: 'Rep Avg', w: 96, align: 'num', group: 'stk', sortable: true, def: true },
      // In Transit deixa de ser coluna: vira marca cinza no SOH, com o TR no
      // painel. Ela custava 82px para dizer, quase sempre, "·".
      // 168px comportava as duas leituras lado a lado no limite, e por isso
      // elas cortavam. Empilhadas, o que a coluna precisa é do valor + a
      // projeção + o selo numa linha só — 184px dá folga para o "99+w".
      { key: 'cover', label: 'Cover', w: 184, align: 'num', group: 'stk', sortable: true, def: true },
      { key: 'main', label: 'Main', w: 84, align: 'num', group: 'stk', sortable: true, def: true },
    ];
    if (S.branch && VARIANT[S.branch.code]) c.push({ key: 'syd', label: 'SYD Stock', w: 82, align: 'num', group: 'stk', sortable: true, def: true });
    // Sem isto o usuário digitava errado e não tinha como desfazer: só apagar
    // o número, deixando uma linha morta na planilha que o check ia ter que
    // interpretar.
    c.push({ key: 'comment', label: mode === 'daily' ? 'Reason' : 'Comments',
             w: 180, align: 'txt', group: 'ref', sortable: false, def: true });
    c.push({ key: 'invComment', label: 'Inv Comments', w: 180, align: 'txt', group: 'ref', sortable: false, def: true,
             stages: ['submitted', 'ready_to_check', 'approved'] });
    // Última coluna: ação vem DEPOIS do que se lê para decidir, não antes.
    c.push({ key: 'act', label: '', w: 54, align: 'num', group: 'ref', sortable: false, def: true, always: true });
    return c;
  }
  function defVis(mode) { return new Set(catalog(mode).filter(c => c.def).map(c => c.key)); }
  function loadVis(mode) {
    try {
      const s = JSON.parse(localStorage.getItem('rp.cols.' + mode) || 'null');
      if (Array.isArray(s) && s.length) {
        const set = new Set(s);
        /* A coluna 'avg' virou duas: avgBranch e avgRep. Quem já tinha uma
           escolha de colunas salva ficava com um conjunto que não menciona
           nenhuma das novas — e as duas simplesmente não apareciam, sem erro
           nenhum. Foi exatamente isso que aconteceu. */
        if (set.has('avg')) { set.delete('avg'); set.add('avgBranch'); set.add('avgRep'); }
        return set;
      }
    } catch (_) {}
    return defVis(mode);
  }
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
      case 'avgBranch': return l.storedAvg || 0; case 'avgRep': return l.repAvg || 0;
      case 'soh': return l.soh || 0; case 'inTransit': return l.inTransit || 0; case 'cover': return l.coverWeeks;
      case 'main': return l.mainGw || 0; case 'ask': return clampInt(l.ask);
      case 'invQty': return l.invQty == null ? -1 : clampInt(l.invQty); case 'syd': return l.syd || 0;
      case 'reason': return l.reason || ''; case 'comment': return l.comment || ''; default: return '';
    }
  }
  // As duas colunas que o usuário caça o tempo todo ganham cor própria.
  const IDCLS = { main: ' c-main', avg: ' c-avg' };
  function renderGrid() {
    coverLegend();
    // A coluna Cover mostra sempre as duas leituras agora, então a linha tem
    // altura constante e não há mais um "modo de uma leitura só".
    // Guarda de digitação. renderGrid() reescreve a tabela inteira; se alguém
    // está com o cursor num campo, o valor a meio digitar e a posição do cursor
    // desaparecem. Com várias pessoas na tela ao vivo isto acontece o tempo
    // todo — um contador que atualiza, um colega que salva. Guarda quem estava
    // focado e devolve o foco no fim.
    const act = document.activeElement;
    const keep = (act && act.classList && act.classList.contains('rp-in'))
      ? { code: (act.closest('tr') || {}).getAttribute && act.closest('tr').getAttribute('data-code'),
          k: act.dataset.k, start: act.selectionStart, end: act.selectionEnd }
      : null;
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
    if (keep && keep.code) {
      const back = $('rpGrid').querySelector(`tr[data-code="${CSS.escape(keep.code)}"] input[data-k="${keep.k}"]`);
      if (back) {
        back.focus();
        try { back.setSelectionRange(keep.start, keep.end); } catch (_) { /* number inputs recusam */ }
      }
    }
    // O contador de linhas e unidades saiu do cabeçalho: nenhum dos dois muda
    // uma decisão. Quantas linhas se vê rolando, e o total de unidades só
    // importa na hora de enviar — e ali ele aparece, no botão.
    updateCount();
    wireGrid();
  }
  // Um chip só, e o título explica o que ele muda. Duas marcas na mesma linha
  // brigariam por 8px numa coluna que já é a mais apertada da grade.
  function lifeChip(l) {
    if (l.life === 'DISCONTINUED')
      return '<span class="rp-life rp-life--disc" title="Discontinued in Master Stock. It still ships while there is stock; it is not reordered.">DISC</span>';
    if (l.life === 'RUN_OUT')
      return '<span class="rp-life rp-life--run" title="Run-out in Master Stock. Selling what is left; not reordered.">RUN-OUT</span>';
    if (l.gwBlocked)
      return '<span class="rp-life rp-life--gw" title="Master Stock says this one is not picked from Gateway — only Main stock counts as sendable.">MAIN ONLY</span>';
    return '';
  }

  function cell(l, c) {
    const g = c.group, gc = (g === 'ord' ? ' g-ord' : g === 'pack' ? ' g-pack' : '') + (IDCLS[c.key] || '');
    const base = c.align === 'num' ? 'num' : c.align === 'code' ? 'code txt' : 'txt';
    const wrap = (inner, extra, title) => `<td class="${base}${gc}${extra || ''}"${title ? ` title="${esc(title)}"` : ''}>${inner}</td>`;
    switch (c.key) {
      case 'dc': return wrap(esc(l.dc) || '<span class="rp-sub">—</span>');
      // O texto que pode quebrar vai num <div> DENTRO da célula, nunca na
      // própria célula: -webkit-box num <td> faz o navegador contar a altura
      // do texto inteiro desdobrado para dimensionar a linha, e a linha ia a
      // 72px por causa de um nome de 421px de altura que estava clampado a 30.
      // Medido: tirando o -webkit-box do <td>, a mesma linha cai para 37px.
      /* A bandeira do Master Stock vive aqui, colada no código. O item
         DESCONTINUADO não some da reposição — ele ainda tem saldo, e alguém
         precisa decidir o que fazer com esse saldo. Some seria esconder a
         decisão. */
      case 'code': return wrap(`<div class="rp-clamp">${esc(l.code)}</div>` + lifeChip(l));
      // rp-name é o que autoriza a quebra em duas linhas. Sem a classe o nome
      // volta a cortar, porque a regra geral da grade é nowrap.
      case 'name': return wrap(`<div class="rp-clamp">${esc(l.name)}</div>`, ' rp-name', l.name);
      case 'ctn': return wrap(l.ctn ? n0(l.ctn) : '<span class="rp-sub">—</span>');
      case 'loc': return wrap(esc(l.loc) || '<span class="rp-sub">—</span>', '', l.loc);
      /* As duas médias, cada uma na sua coluna.
         A que o motor está usando para sugerir ganha um ponto — sem ele, duas
         colunas iguais deixam o usuário sem saber qual virou quantidade. */
      case 'avgBranch': {
        const b = l.storedAvg != null ? l.storedAvg : 0;
        const usa = usaBranch(l);
        // Sem o ponto: ele apertava uma coluna que já estava justa para dizer
        // algo que o Settings já diz, e que não muda a decisão da linha.
        return wrap(
          (b > 0 ? n1(b) : '<span class="rp-sub">—</span>'),
          ' rp-avgb' + (usa ? ' is-driver' : ''),
          b > 0 ? `${n1(b)} a month shipped out of this branch's own depot.`
                : "Nothing shipped out of this branch's own depot in the window.");
      }
      case 'avgRep': {
        const r = l.repAvg;
        const usa = !usaBranch(l);
        const quantos = `${l.repCount || 0} of the branch's ${(S.repAvgInfo && S.repAvgInfo.count) || 0} reps sold it.`;
        return wrap(
          (r > 0 ? n1(r) : '<span class="rp-sub">—</span>'),
          ' rp-avgr' + (usa && r > 0 ? ' is-driver' : ''),
          r > 0 ? `${n1(r)} a month sold by this branch's reps, wherever it shipped from. ${quantos}`
                : 'No rep of this branch sold it in the window.');
      }
      case 'soh': {
        // In Transit era uma coluna de 82px que quase sempre dizia "·". Vira
        // marca aqui, e o painel mostra o TR — que é o que o usuário quer ver.
        const t = l.inTransit ? `<span class="rp-transit" title="${n0(l.inTransit)} on the way to this branch — open the row to see the TR">▸${n0(l.inTransit)}</span>` : '';
        // O negativo mora aqui e só aqui. O Cover parou de repeti-lo como
        // "short": duas colunas dizendo a mesma coisa de formas diferentes
        // fazem o usuário procurar a diferença entre elas.
        const v = l.soh < 0 ? `<span class="rp-neg">${n0(l.soh)}</span>`
                : l.soh === 0 ? '<span class="rp-zero">0</span>' : n0(l.soh);
        return wrap(v + t, '', l.soh < 0
          ? `${n0(l.soh)} — this branch has sold more than it had. Nothing to count on here.`
          : `${n0(l.soh)} on hand at this branch.`);
      }
      case 'pallet': return wrap(l.pallet ? n0(l.pallet) : '<span class="rp-sub">—</span>', '', l.pallet ? `${n0(l.pallet)} per pallet` : 'No pallet quantity on file for this 5DC');
      case 'inTransit': return wrap(l.inTransit ? n0(l.inTransit) : '<span class="rp-sub">·</span>');
      case 'cover': {
        /* Duas leituras EMPILHADAS, não lado a lado.
         *
         * Estavam lado a lado, separadas por uma barrinha, e não cabiam: em
         * 7 de 120 linhas medidas o conteúdo passava dos 168px e o
         * `overflow:hidden` comia a segunda leitura — o número simplesmente
         * sumia, e sumia justo no modo que mostra as duas. Pior que isso,
         * lado a lado ninguém sabia qual metade era qual.
         *
         * Empilhadas, cada uma ganha a linha inteira, os números alinham em
         * coluna e a etiqueta colorida diz de quem é a leitura. A cor está
         * explicada no rodapé — cor sem legenda é enfeite.
         *
         * Os quatro números têm o MESMO tamanho de propósito. Projeção menor
         * que o valor atual leria como nota de rodapé, e ela é justamente o
         * que o usuário está decidindo enquanto digita.
         */
        const q = finalQty(l);
        const wk = (base) => base > 0 ? (l.soh + l.inTransit) / (base / RC.WEEKS_IN_MONTH) : null;
        const after = (base) => (base > 0 && q > 0)
          ? (l.soh + l.inTransit + q) / (base / RC.WEEKS_IN_MONTH) : null;
        /* Cobertura negativa é estoque já vendido a mais. Ela dizia "short"
           aqui, e isso repetia — em vermelho e noutra coluna — o que o SOH
           negativo já diz. Duas maneiras de contar a mesma coisa fazem o
           usuário procurar a diferença entre elas. Agora o Cover cala e o
           número negativo aparece só onde ele nasce: no SOH.
           Sem média não há cobertura, e "—" é mais honesto que "n/a": não é
           erro, é que não há o que dividir. */
        const num = (v) => v == null ? '<span class="rp-sub">—</span>'
          : v < 0 ? '<span class="rp-sub">—</span>'
          : v >= 999 ? '99+w' : n1(v) + 'w';

        const bBase = l.storedAvg != null ? l.storedAvg : l.avg;
        const bNow = wk(bBase), bTo = after(bBase);
        const rNow = l.repAvg > 0 ? wk(l.repAvg) : null, rTo = after(l.repAvg);

        /* Sem letra e sem cápsula.
           A letra B/R gastava 17px de uma coluna apertada para dizer o que a
           cor já diz, e as cápsulas low/over eram um terceiro alfabeto na
           mesma célula — o número de semanas contra o alvo já é o alerta.
           Quem quiser o detalhe clica na linha: o painel tem as duas médias
           com o nome de cada rep. */
        const linha = (cls, now, to, tip) => `<span class="rp-cv ${cls}" title="${esc(tip)}"
            ><i class="t"></i><b>${num(now)}</b><u>${to == null ? '' : `›${num(to)}`}</u></span>`;

        const b1 = linha('is-br', bNow, bTo, `Branch shipments: ${n1(bBase || 0)} a month.`
          + (bTo == null ? '' : ` With ${n0(q)} units, cover goes to ${n1(bTo)} weeks.`));

        /* As duas leituras SEMPRE, e não só num modo. A segunda aparece mesmo
           quando não há venda por rep: sem ela a linha muda de altura conforme
           o SKU e a coluna deixa de alinhar, e "nenhum rep vendeu isto" é uma
           resposta, não um vazio. */
        const b2 = l.repAvg > 0
            ? linha('is-rep', rNow, rTo, `This branch's reps sold ${n1(l.repAvg)} a month, wherever it shipped from.`
                + (rTo == null ? '' : ` With ${n0(q)} units, cover goes to ${n1(rTo)} weeks.`))
            : linha('is-rep is-none', null, null, 'No rep of this branch sold this product in the window.');

        return `<td class="num rp-cover${b2 ? ' is-two' : ''}">${b1}${b2}</td>`;
      }
      case 'main': return wrap(
        l.mainGw <= 0 ? `<span class="rp-neg">${n0(l.mainGw)}</span>` : n0(l.mainGw), '',
        l.mainGw <= 0
          ? 'Nothing in Main or Gateway to send today. The line is not blocked — stock may be on the way.'
          : `Main ${n0(l.mainOnly)} · Gateway ${n0(l.gw)} · Main avg/mo ${n1(l.mainAvg)}`);
      case 'ask':
        return wrap(askEditable() ? `<input class="rp-in big" data-k="ask" value="${clampInt(l.ask) || ''}" inputmode="numeric">` : `<span class="rp-lock">${n0(clampInt(l.ask))}</span>`);
      case 'invQty': {
        if (invEditable()) return `<td class="num g-ord"><input class="rp-in big" data-k="invQty" value="${l.invQty == null ? '' : clampInt(l.invQty)}" inputmode="numeric"></td>`;
        const val = l.invQty == null ? '<span class="rp-sub" title="Unlocks when the branch submits and the inventory check starts">—</span>' : `<span class="rp-lock">${n0(clampInt(l.invQty))}</span>`;
        return `<td class="num g-ord locked">${val}</td>`;
      }
      case 'syd': return wrap(n0(l.syd));
      case 'act': {
        const bits = [];
        // No rascunho a filial só precisa poder APAGAR o que digitou errado.
        // O alerta é ferramenta de quem confere — oferecê-lo aqui convidaria a
        // filial a marcar o próprio pedido, que não é o ponto dele.
        if (askEditable())
          bits.push(`<button class="rp-act rp-del" data-act="del" title="Remove this line">×</button>`);
        else if (S.stage !== 'approved')
          bits.push(`<button class="rp-act rp-flag${l.flag ? ' on' : ''}" data-act="flag" title="${l.flag ? 'Clear the flag' : 'Flag for an extra check'}">!</button>`);
        return `<td class="num rp-acts">${bits.join('')}</td>`;
      }
      case 'comment':
        // O comentário da filial é dela, e trava quando ela entrega. Depois
        // disso quem fala é o Inv Comments.
        return `<td class="txt">${askEditable()
          ? `<input class="rp-in txt" data-k="comment" value="${esc(l.comment)}"
               placeholder="${S.mode === 'daily' ? 'why is this urgent…' : 'branch note…'}">`
          : (esc(l.comment) || '<span class="rp-sub">—</span>')}</td>`;
      case 'invComment':
        return `<td class="txt">${invEditable()
          ? `<input class="rp-in txt" data-k="invComment" value="${esc(l.invComment || '')}" placeholder="inventory reply…">`
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
      inp.addEventListener('input', () => {
        if (k === 'ask') l.ask = clampInt(inp.value);
        else if (k === 'invQty') l.invQty = inp.value === '' ? null : clampInt(inp.value);
        else l[k] = inp.value;
        if (k === 'ask' || k === 'invQty') { updateCount(); repaintCover(inp.closest('tr'), l); }
      });
      inp.addEventListener('change', saveDraft);
      inp.addEventListener('click', e => e.stopPropagation());
    });
    tb.querySelectorAll('button.rp-act').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const l = lineByRow(b.closest('tr')); if (!l) return;
      if (b.dataset.act === 'del') {
        const i = S.lines.indexOf(l); if (i < 0) return;
        S.lines.splice(i, 1); toast(`${l.code} removed`);
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
  /* Qual das duas médias o motor está usando NESTA linha.
     Precisa ser por linha e não por modo: em 'branch, fall back to reps' a
     resposta muda de SKU para SKU, e é exatamente nos 31% em que uma das duas
     está zerada que o usuário quer saber qual virou quantidade. */
  function usaBranch(l) {
    const b = l.storedAvg != null ? l.storedAvg : 0;
    const r = l.repAvg || 0;
    if (SET.demand === 'rep') return false;
    if (SET.demand === 'branch') return true;
    if (SET.demand === 'branch_then_rep') return b > 0 || r <= 0;
    if (SET.demand === 'rep_then_branch') return !(r > 0);
    return true;
  }

  // Repinta SÓ a célula do cover da linha digitada. Um renderGrid() a cada
  // tecla custaria ~250 ms em 480 linhas e ainda brigaria com o cursor — a
  // seta precisa acompanhar a digitação sem redesenhar a tabela.
  /* A legenda do cover.
     Duas cores sem legenda são enfeite: quem chega na tela não tem como saber
     que azul é a filial e âmbar é o rep. Ela só aparece no modo que mostra as
     duas — legenda de uma coisa que não está na tela é ruído. */
  function coverLegend() {
    const el = $('rpCoverKey'); if (!el) return;
    el.style.display = '';
    /* Se a régua do rep não carregou, a tela DIZ. Antes ela caía na régua do
       local calada, e o usuário lia 11 linhas onde deveria ver 56 — sem nada
       na tela sugerindo que faltava metade da conta. */
    if (S.repAvgErro) {
      el.innerHTML = `<span class="rp-cvkey is-rep"><i class="t"></i></span>`
        + `<b>Rep demand did not load</b>`
        + `<span>The sheet is falling back to what shipped out of this branch, which is a `
        + `smaller number — not fewer things to send. Reload; if it persists: ${esc(S.repAvgErro)}</span>`;
      el.classList.add('is-bad');
      return;
    }
    el.classList.remove('is-bad');
    el.innerHTML = `<span class="rp-cvkey is-br"><i class="t"></i></span>`
      + `<b>Branch</b><span>what shipped out of this branch's own depot</span>`
      + `<i class="sep"></i>`
      + `<span class="rp-cvkey is-rep"><i class="t"></i></span>`
      + `<b>Reps</b><span>what this branch's reps sold, wherever it shipped from</span>`
      + `<i class="sep"></i>`
      + `<span class="rp-key-to">›&nbsp;4.2w</span><span>where cover lands with the quantity you type</span>`
      + `<i class="sep"></i>`
      + `<span>the column with the tinted background is the average the suggestion uses</span>`;
  }

  function repaintCover(tr, l) {
    if (!tr) return;
    const C = visibleCols(); const i = C.findIndex(c => c.key === 'cover');
    if (i < 0) return;
    const td = tr.children[i]; if (!td) return;
    const tmp = document.createElement('tr'); tmp.innerHTML = cell(l, C[i]);
    const src = tmp.firstElementChild; if (!src) return;
    td.innerHTML = src.innerHTML; td.title = src.title || '';
  }
  function lineByRow(tr) { if (!tr) return null; const code = tr.getAttribute('data-code'); return code ? S.lines.find(l => l.code === code) : null; }
  // O cabeçalho dizia "129 lines · 738 units" o tempo todo. Nenhum dos dois
  // muda uma decisão: quantas linhas se vê rolando, e o total de unidades só
  // importa na hora de enviar — onde ele aparece de novo, no botão.
  // O elemento saiu do HTML; a função fica porque quem digita chama por ela.
  function updateCount() {}

  // ── load suggested (merge, write-protected) ──────────────────────────
  // A régua também se escolhe AQUI, e não só no Settings: é neste clique que a
  // diferença aparece — em Brisbane, 20 itens contra 396. Escolher com os dois
  // números na frente é diferente de escolher num menu de configuração.
  function loadCountFor(basis) {
    const keep = SET.demand; SET.demand = basis;
    let n = 0, units = 0;
    try {
      const have = new Set(S.lines.map(l => String(l.code).toUpperCase()));
      const sug = suggestionUniverse().filter(r => r.isSuggested && !have.has(String(r.code).toUpperCase()));
      n = sug.length; units = sug.reduce((a, r) => a + (r.sug || 0), 0);
    } finally { SET.demand = keep; }
    return { n, units };
  }
  function openLoadModal() {
    closeSide();
    const uni = suggestionUniverse(), sug = uni.filter(r => r.isSuggested);
    const have = new Set(S.lines.map(l => String(l.code).toUpperCase()));
    const toAdd = sug.filter(r => !have.has(String(r.code).toUpperCase()));
    $('loadMsg').innerHTML = `<b>${toAdd.length}</b> suggested line${toAdd.length === 1 ? '' : 's'} for <b>${esc(S.branch.name)}</b> under ${SET.cutDays}d cover.` +
      (S.lines.length ? ` Your ${S.lines.length} existing line${S.lines.length === 1 ? '' : 's'} stay untouched.` : '');
    // Os dois lados calculados de verdade, não estimados.
    /* AS QUATRO REGRAS, cada uma com o número que ela realmente produz — não
       estimado, calculado. É neste clique que a diferença aparece, e escolher
       com os quatro números na frente é diferente de escolher num menu.
       As duas do meio são as que se usam de verdade: régua principal com a
       outra cobrindo o buraco. "Só filial" deixa de fora o que o Main mandou
       em nome dela; "só reps" ignora o que a filial despachou sozinha. */
    const REGRAS = [
      ['branch', 'Branch only',
        'What shipped out of this branch. Ignores what Main sent on its behalf.'],
      ['branch_then_rep', 'Branch, reps fill the gaps',
        'The branch figure when there is one; its reps cover the SKUs the branch never shipped itself.'],
      ['rep_then_branch', 'Reps, branch fills the gaps',
        'What the branch sold, wherever it shipped from; the branch figure covers what no rep touched.'],
      ['rep', 'Reps only',
        'What this branch sold, wherever it shipped from. Ignores branch-only movement.'],
    ];
    const box = $('loadBasis');
    if (box) box.innerHTML = REGRAS.map(([v, titulo, texto]) => {
      const c = loadCountFor(v);
      const on = SET.demand === v;
      return `<label class="rp-basis${on ? ' is-on' : ''}">
        <input type="radio" name="lbasis" value="${v}"${on ? ' checked' : ''}>
        <b>${esc(titulo)}</b><span>${n0(c.n)} lines · ${n0(c.units)} units</span>
        <small>${esc(texto)}</small></label>`;
    }).join('');
    box && box.querySelectorAll('input[name=lbasis]').forEach(r => r.addEventListener('change', () => {
      SET.demand = r.value; saveSet();
      // Recarrega para as quantidades já virem preenchidas pela régua escolhida.
      refreshRepAvg().then(() => { writeScope(); writeRulers(); renderGrid(); openLoadModal(); });
    }));
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
    let hidDep = 0, hidNoMain = 0, hidPack = 0, hidBlk = 0;
    for (const p of S.prodList) {
      // Deprecated não entra: 2.744 de 11.259 no catálogo, e a filial não deve
      // pedir o que a empresa já aposentou.
      const kk = String(p.sku || '').toUpperCase();
      if (escondePorDeprecated(p, kk)) { hidDep++; continue; }
      if (isPackSku(p.sku)) { hidPack++; continue; }
      // Decisão explícita de alguém no Master Stock. Vem ANTES do corte por
      // estoque: um produto desligado de propósito não deve reaparecer só
      // porque hoje há saldo no Main.
      if (S.blocked && S.blocked.has(String(p.sku || '').toUpperCase())) { hidBlk++; continue; }
      // Nem o que Main+Gateway não tem: pedir o que ninguém pode mandar só
      // gera uma linha que morre no check. São 5.909 dos 8.515 ativos.
      if (((S.stock.MAIN && S.stock.MAIN[kk]) || 0) + gwStock(kk) <= 0) { hidNoMain++; continue; }
      const sku = kk.toLowerCase(), dc = String(p.attribute1 || '').toLowerCase(), nm = String(p.name || '').toLowerCase();
      if (sku.startsWith(q) || dc.startsWith(q)) starts.push(p);
      else if (sku.includes(q) || dc.includes(q) || nm.includes(q)) contains.push(p);
      if (starts.length >= 25) break;
    }
    acState.hidden = { dep: hidDep, noMain: hidNoMain, pack: hidPack, blocked: hidBlk };
    const items = starts.concat(contains).slice(0, 25); acState.items = items; acState.sel = items.length ? 0 : -1;
    const ac = $('rpAc');
    ac.innerHTML = items.length ? items.map((p, i) => {
      const k = String(p.sku).toUpperCase(), main = (S.stock.MAIN && S.stock.MAIN[k] || 0) + gwStock(k);
      return `<div data-sku="${esc(p.sku)}" class="${i === acState.sel ? 'sel' : ''}"><span class="sku">${esc(p.sku)}</span>${p.attribute1 ? `<span class="dc">${esc(p.attribute1)}</span>` : ''}<span class="nm">${esc(p.name || '')}</span><span class="st">Main ${n0(main)}</span></div>`;
    }).join('') : '<div class="none">No product matches</div>';
    // Esconder em silêncio faria o usuário procurar um código que existe e
    // concluir que o sistema está quebrado.
    // O rodapé lista o que foi escondido. Um corte novo que não apareça aqui
    // faz o usuário procurar um código que existe e concluir que quebrou.
    ac.innerHTML += `<div class="acfoot">Hidden: deprecated products, carton SKUs, anything Main + Gateway cannot send today${
      hidBlk ? `, and ${hidBlk} marked in Master Stock as not for branches` : ''}.</div>`;
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
    const mainSoh = Number((S.stock.MAIN && S.stock.MAIN[sku]) || 0), gwSoh = gwStock(sku);
    const gwReal = Number((S.stock.GATEWAY && S.stock.GATEWAY[sku]) || 0);
    const mainAvg = avgRow ? RC.pickMainAvg(avgRow) : 0;
    $('sideBody').innerHTML = `
      <div class="rp-side-code">${esc(line.code)}</div>
      <div class="rp-side-name">${esc(line.name || '')}</div>
      <div class="sp-panel" id="sideReps"><div class="in"><div class="rp-sub">loading…</div></div></div>
      <div class="sp-panel" style="margin-top:14px"><h4>Across branches <span>avg / mo · SOH · on the way</span></h4><div class="in" style="padding:0">
        <table><thead><tr><th>Branch</th><th class="n">Avg</th><th class="n">SOH</th><th class="n">In transit</th></tr></thead><tbody>
        ${across.map(x => `<tr class="${x.here ? 'rp-side-here' : ''}"><td>${esc(x.name)}${x.here ? ' •' : ''}</td><td class="n">${x.a ? n1(x.a) : '·'}</td><td class="n ${x.soh < 0 ? 'rp-neg' : ''}">${n0(x.soh)}</td><td class="n">${x.it ? n0(x.it) : '·'}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="sp-panel"><h4>Main &amp; Gateway <span>the send pool</span></h4><div class="in">
        <div class="rp-kv"><span>Main SOH</span><b>${n0(mainSoh)}</b></div>
        <div class="rp-kv"><span>Gateway SOH</span><b>${n0(gwSoh)}</b>${
          S.gwOff && S.gwOff.has(sku)
            ? `<span class="rp-sub" title="Master Stock excludes this SKU from the Gateway pool">not sendable${gwReal ? ` — ${n0(gwReal)} sits there` : ''}</span>` : ''}</div>
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
    // Depois de o painel existir: loadSideReps procura #sideReps no DOM, e
    // chamado antes ele não achava nada e voltava calado.
    loadSideReps(sku);
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
    if (!lines.length) { toast('No line has a quantity', true); return; }
    placing = true;
    const btn = $('btnAdvance'); if (btn) { btn.disabled = true; btn.textContent = 'Sending to Cin7…'; }
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
      toast(d.already ? `Already placed: ${d.number}` : `${d.number} created in Cin7 · ${d.order_lines} lines`);
      renderStage();
    } catch (e) {
      // Voltar o estágio: aprovado sem TR seria mentira na tela.
      S.stage = STAGES[S.mode][STAGES[S.mode].length - 2];
      saveDraft(); enterGrid();
      toast(`Could not place it: ${e.message}`, true);
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

  // Quem vende este SKU, e por qual local ele saiu. É a resposta para "por que
  // a média da minha filial é baixa se eu vendo isso" — a venda está no rep,
  // o despacho está no Main.
  /* As DUAS médias, cada uma na sua tabela, na janela do Settings.
   *
   * Era um "Who sells it" que listava todo rep de toda filial com unidades,
   * pedidos e a data do último — e a data do último pedido não muda nenhuma
   * decisão desta tela: quem está aqui já sabe que precisa repor, e quer
   * saber QUANTO por mês, não QUANDO foi a última vez.
   *
   * A separação em duas tabelas espelha as duas colunas da planilha: uma é a
   * venda dos reps desta filial, a outra é o que saiu do depósito dela. A
   * diferença entre as duas é o que a filial vende e o Main entrega por ela —
   * em Brisbane, 48% das linhas.
   */
  async function loadSideReps(sku) {
    const box = $('sideReps'); if (!box) return;
    const code = S.branch ? S.branch.code : '';
    const nome = S.branch ? S.branch.name : '';
    try {
      const qs = new URLSearchParams({ sku, branch: code, months: SET.salesMonths || 6 });
      const d = await fetch(`/api/replenishment/sku-detail?${qs}`).then(r => r.json());
      if (d.error) throw new Error(d.error);
      const m = d.months || SET.salesMonths || 6;

      const reps = (d.by_rep || []).filter(r => r.branch_code === code)
        .map(r => ({ ...r, mes: Number(r.qty) / m }))
        .sort((a, b) => b.mes - a.mes);
      const repTotal = reps.reduce((n, r) => n + r.mes, 0);

      // O depósito desta filial no espelho, e para onde mais o produto saiu.
      const alvo = LOCAL[code] || nome;
      const locs = (d.by_location || []).map(l => ({ ...l, mes: Number(l.qty) / m }));
      const daFilial = locs.find(l => l.location_name === alvo);
      const outros = locs.filter(l => l.location_name !== alvo).sort((a, b) => b.mes - a.mes);
      const locTotal = daFilial ? daFilial.mes : 0;

      const vazio = (t) => `<tr><td colspan="2" class="rp-sub">${t}</td></tr>`;
      box.innerHTML = `
        <div class="rp-two">
          <div class="rp-half">
            <h4><i class="rp-bar is-rep"></i>Rep Avg <span>${esc(nome)} · ${m} months</span></h4>
            <table class="rp-mini"><tbody>
              ${reps.length ? reps.map(r => `<tr><td>${esc(r.sales_rep)}</td>
                   <td class="n"><b>${n1(r.mes)}</b><i>/mo</i></td></tr>`).join('')
                : vazio('No rep of this branch sold it in the window.')}
              ${reps.length > 1 ? `<tr class="rp-mini-tot"><td>${reps.length} reps</td>
                   <td class="n"><b>${n1(repTotal)}</b><i>/mo</i></td></tr>` : ''}
            </tbody></table>
          </div>
          <div class="rp-half">
            <h4><i class="rp-bar is-br"></i>Branch Avg <span>${esc(nome)} · ${m} months</span></h4>
            <table class="rp-mini"><tbody>
              <tr><td>Out of ${esc(alvo)}</td><td class="n"><b>${n1(locTotal)}</b><i>/mo</i></td></tr>
              ${outros.length ? `<tr class="rp-mini-sep"><td colspan="2" class="rp-sub">also shipped from</td></tr>`
                + outros.slice(0, 4).map(l => `<tr class="rp-mini-dim"><td>${esc(l.location_name)}</td>
                     <td class="n"><b>${n1(l.mes)}</b><i>/mo</i></td></tr>`).join('') : ''}
            </tbody></table>
          </div>
        </div>
        ${repTotal > 0 && locTotal >= 0 ? `<div class="in rp-sub rp-gap">${
          repTotal > locTotal * 1.15
            ? `The reps sell <b>${n1(repTotal - locTotal)}</b> a month more than this branch ships — that difference goes out of Main on its behalf.`
            : locTotal > repTotal * 1.15
              ? `This branch ships <b>${n1(locTotal - repTotal)}</b> a month more than its own reps sell — the rest is other reps ordering from here.`
              : 'The two readings agree.'}</div>` : ''}`;
    } catch (e) {
      box.innerHTML = `<h4>Averages</h4><div class="in rp-sub">Could not load — ${esc(e.message)}</div>`;
    }
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

  // MAIN e NONE não estão em BRANCHES (não são destino de reposição), mas
  // precisam de nome: 12 reps são do Main e 2 não são pessoas, e mostrá-los
  // em branco fazia parecer que ninguém tinha decidido.
  const BRN = { MAIN: 'Main Warehouse', NONE: 'Not a person' };
  const branchName = (code) => BRN[code] || (BRANCHES.find(b => b.code === code) || {}).name || '—';

  function avRepTable(rows) {
    const LBL = { high: 'solid', medium: 'fair', low: 'split', inactive: 'inactive', not_a_person: 'not a person' };
    // NULL é resposta válida e precisa estar na lista: "não é rep de filial"
    // cobre o pessoal do Main, a razão social e o canal de API.
    return `<div class="rp-note rp-note-info">
      There is <b>no field anywhere</b> saying a rep belongs to a branch — this is inferred from where the goods
      shipped from. That is why every branch rep has a Main tail: about 43% of a Sydney rep's orders ship out of Main.
      <b>The second branch and the order count are shown on purpose</b> — 53% against 44% is a split book, not an allocation.
The branch column is the decision that was recorded; the columns after it are what the sales actually show.</div>
      <div class="sp-scroll"><table class="sp-grid rp-grid">
      <thead><tr><th class="txt" style="width:180px">Sales rep</th>
        <th class="txt" style="width:160px">Branch</th>
        <th class="txt" style="width:150px">Ships mostly from</th><th class="num" style="width:60px">%</th>
        <th class="txt" style="width:150px">Second</th><th class="num" style="width:60px">%</th>
        <th class="num" style="width:70px">Orders</th><th class="num" style="width:80px">Lower bound</th>
        <th class="txt" style="width:100px">Read</th><th class="num" style="width:96px">Last order</th></tr></thead>
      <tbody>${rows.map(r => `<tr class="${r.confidence === 'high' ? '' : 'rp-dim'}${r.decided ? ' rp-decided' : ''}">
        <td class="txt">${esc(r.rep)}</td>
        <td class="txt"><span class="rp-brn ${r.assigned_branch === 'MAIN' ? 'is-main' : r.assigned_branch === 'NONE' ? 'is-none' : ''}"
            title="${r.decided ? 'Decided by ' + esc(r.decided_by || '') + ' on ' + esc(dmy(r.decided_at)) : 'Not decided'}"
          >${esc(branchName(r.assigned_branch))}</span></td>
        <td class="txt">${esc(r.branch_1)}</td><td class="num">${n1(r.pct_1)}</td>
        <td class="txt">${esc(r.branch_2 || '—')}</td><td class="num">${r.branch_2 ? n1(r.pct_2) : '·'}</td>
        <td class="num">${n0(r.orders_total)}</td>
        <td class="num" title="Wilson 95% lower bound — below 50% the lead is not statistically real">${n1(r.wilson_lb)}%</td>
        <td class="txt"><span class="rp-conf c-${r.confidence}">${LBL[r.confidence]}</span></td>
        <td class="num">${esc(dmy(r.last_order))}${r.days_idle > 120 ? ` <span class="rp-sub">${r.days_idle}d</span>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  // Gravar a alocação. Um rep por vez, direto no change — não há botão de
  // salvar de propósito: é uma decisão por linha, e um formulário com 40
  // seletores e um Save no fim convida a perder tudo num refresh.


  // ── History ─────────────────────────────────────────────────────────────
  // Lê do BANCO, não do localStorage. O snapshot foi congelado no momento do
  // envio: recalcular a partir do estoque de hoje daria outro número e o
  // histórico deixaria de ser histórico. Cada cartão abre e fecha sozinho —
  // uma lista de 40 linhas aberta esconde os outros envios.
  async function showHistory() {
    // O aviso é regra do Daily; no History ele não descreve nada do que está
    // na tela. Escondido aqui e não só no render da grade, senão ele sobrevive
    // à troca de aba.
    $('rpScroll').style.display = 'none'; $('rpStage').style.display = 'none'; $('rpFoot').style.display = 'none';
    const dn = $('rpDailyNote'); if (dn) dn.style.display = 'none';
    $('rpHistory').style.display = ''; setControls();
    $('rpHistory').innerHTML = '<div class="rp-hist-empty">Loading…</div>';
    let rows = [];
    try {
      const r = await fetch(`/api/replenishment/orders?branch=${encodeURIComponent(S.branch.code)}`);
      // Só o que de fato virou pedido. Uma tentativa que falhou não é
      // histórico — é ruído de operação, e mostrar erro cru para a filial não
      // ajuda ninguém a decidir nada.
      const j = await r.json();
      rows = (j.rows || []).filter(o => o.status !== 'FAILED' && o.cin7_number);
      histErro = j.rows && j.rows[0] && j.rows[0].cin7_refresh_error || null;
    } catch (e) {
      $('rpHistory').innerHTML = `<div class="rp-hist-empty">Could not load the history.<br><span class="rp-sub">${esc(e.message)}</span></div>`;
      return;
    }
    if (!rows.length) {
      $('rpHistory').innerHTML = `<div class="rp-hist-empty">No order placed yet for ${esc(S.branch.name)}.<br>
        <span class="rp-sub">When a plan is approved the TR is recorded here, frozen at the values that were sent.</span></div>`;
      return;
    }
    /* Cancelada não é histórico útil.
       Você viu a TR-50193 aparecer como ORDERED quando no Cin7 ela está
       VOIDED — e não era só ela: as seis que este módulo criou estavam
       canceladas, e a tela mostrava as seis como ORDERED. A causa era o
       `status` guardar o que NÓS escrevemos ao criar, sem nunca reperguntar.
       Agora o cartão mostra o estado atual do Cin7, e as canceladas saem da
       lista — mas o número delas fica dito, porque esconder em silêncio faria
       procurar um pedido que se sabe que existe e concluir que a tela perdeu. */
    const cancelada = (o) => o.cin7_status === 'VOIDED';
    const vivas = histShowVoided ? rows : rows.filter(o => !cancelada(o));
    const nVoid = rows.filter(cancelada).length;
    histRows = vivas;

    const aviso = histErro
      ? `<div class="rp-hist-warn">Showing the last known status — Cin7 did not answer just now
           (${esc(histErro)}). Each card says when it was last read.</div>` : '';
    const alterna = nVoid
      ? `<div class="rp-hist-bar">${histShowVoided
          ? `Showing <b>${n0(nVoid)}</b> cancelled transfer${nVoid === 1 ? '' : 's'}`
          : `<b>${n0(nVoid)}</b> cancelled transfer${nVoid === 1 ? '' : 's'} hidden`}
         <button class="ui-act" id="histVoid">${histShowVoided ? 'Hide them' : 'Show them'}</button></div>` : '';

    if (!vivas.length) {
      $('rpHistory').innerHTML = aviso + alterna + `<div class="rp-hist-empty">
        No transfer is live for ${esc(S.branch.name)}.${nVoid ? ' Every one placed was cancelled in Cin7.' : ''}</div>`;
      wireHistory();
      return;
    }
    $('rpHistory').innerHTML = aviso + alterna + vivas.map((o, i) => histCard(o, i)).join('');
    wireHistory();
  }
  let histRows = [], histOpen = new Set(), histShowVoided = false, histErro = null;

  /* O estado que o Cin7 diz HOJE, e não o que pedimos ao criar.
     Sem leitura ainda, diz isso com essas palavras: um status sem procedência
     é o que causou o problema em primeiro lugar. */
  const CIN7_ST = {
    ORDERED:   { rot: 'Ordered',   cls: 'st-ord',  ajuda: 'Authorised in Cin7, nothing picked yet.' },
    PICKING:   { rot: 'Picking',   cls: 'st-pick', ajuda: 'Being picked at Main.' },
    PICKED:    { rot: 'Picked',    cls: 'st-pick', ajuda: 'Picked, not yet dispatched.' },
    SHIPPED:   { rot: 'Shipped',   cls: 'st-ship', ajuda: 'On its way to the branch.' },
    COMPLETED: { rot: 'Completed', cls: 'st-done', ajuda: 'Received at the branch.' },
    VOIDED:    { rot: 'Cancelled', cls: 'st-void', ajuda: 'Cancelled in Cin7. Nothing moved.' },
  };

  function histCard(o, i) {
    const when = o.ordered_at || o.created_at;
    const st = CIN7_ST[o.cin7_status] || null;
    const bad = o.cin7_status === 'VOIDED';
    const open = histOpen.has(i);
    return `<div class="rp-h2 ${bad ? 'is-void' : ''}" data-i="${i}">
      <div class="rp-h2-head">
        <button class="rp-h2-tog" data-tog="${i}" title="${open ? 'Collapse' : 'Expand the lines'}">${open ? '▾' : '▸'}</button>
        <span class="rp-h2-tr">${esc(o.cin7_number || '—')}</span>
        <span class="badge ${o.mode === 'daily' ? 'is-daily' : 'is-weekly'}">${o.mode === 'daily' ? 'Daily' : 'Weekly'}</span>
        <span class="rp-h2-when">${esc(fmtWhen(when))}</span>
        <span class="rp-h2-meta">${o.line_count} line${o.line_count === 1 ? '' : 's'} · ${n0(o.total_units)} units</span>
        <span class="rp-h2-route">${esc(o.from_location || '')} › ${esc(o.to_location || o.branch_name || '')}</span>
        <span class="sp-gap"></span>
        <span class="rp-h2-st ${st ? st.cls : 'st-unknown'}"
          title="${st ? esc(st.ajuda) : 'Never read back from Cin7 — this is only what we asked for when we created it.'}${
            o.cin7_status_at ? ` Read ${esc(dmyTime(o.cin7_status_at))}.` : ''}"
          >${st ? esc(st.rot) : 'Not checked'}</span>
        ${o.cin7_number ? `<button class="ui-act" data-print="${i}">Print</button>` : ''}
      </div>
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
  const fmtWhen = (iso) => (iso ? dmyTime(iso) : '—');
  function wireHistory() {
    const v = $('histVoid');
    if (v) v.addEventListener('click', () => { histShowVoided = !histShowVoided; showHistory(); });
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
    if (!w) { toast('The browser blocked the print window', true); return; }
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
        · ${o.line_count} lines · ${n0(o.total_units)} units · ${esc(o.status)}${o.created_by ? ' · ' + esc(o.created_by) : ''}</div>
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
  // ── Averages (aba do topo) ──────────────────────────────────────────────
  // Aqui é consulta: filtrar, comparar, entender de onde vem o número. A tela
  // de dentro da filial é para OPERAR, e por isso não tem nada disto.
  //
  // Três modos, porque são três perguntas diferentes:
  //   stored   — o que o motor usa hoje (as colunas pré-calculadas)
  //   measured — o que a venda diz, na janela que você escolher
  //   reps     — quem atende qual filial, que é o que corrige a régua
  const AV = { tab: 'stored', months: 6, branch: '', q: '', nonZero: true };

  function renderAverages() {
    const seg = $('avSeg');
    if (seg) seg.querySelectorAll('[data-a]').forEach(b => b.classList.toggle('on', b.dataset.a === AV.tab));
    if (AV.tab === 'stored') return avStored();
    if (AV.tab === 'measured') return avMeasured();
    return avReps();
  }
  // Uma barra de filtro só, montada conforme o modo — três barras diferentes
  // ensinariam três lugares para procurar a mesma coisa.
  function avBar(opts) {
    // Os dois depósitos só aparecem onde a pergunta é "de onde saiu" (a janela
    // medida). No modo "o que o motor usa" eles não são coluna, e oferecê-los
    // devolveria uma tabela sempre vazia.
    const lista = BRANCHES.concat(opts.window ? DEPOTS : []);
    const br = `<select id="avBranch"><option value="">All branches</option>` +
      lista.map(b => `<option value="${esc(b.code)}"${AV.branch === b.code ? ' selected' : ''}>${esc(b.name)}</option>`).join('') + '</select>';
    const win = [3, 6, 12].map(m => `<button class="sp-chip${AV.months === m ? ' is-on' : ''}" data-avm="${m}">${m}m</button>`).join('');
    return `<div class="sp-bar rp-avbar">
      ${opts.search ? `<input type="search" id="avSearch" placeholder="Filter SKU or product…" style="max-width:250px" value="${esc(AV.q)}">` : ''}
      ${opts.branch ? br : ''}
      ${opts.window ? `<span class="rp-sep"></span>${win}` : ''}
      ${opts.nonZero ? `<button class="sp-chip${AV.nonZero ? ' is-on' : ''}" id="avNonZero">Non-zero only</button>` : ''}
      <span class="sp-gap"></span><span class="sp-count" id="avNote"></span></div>`;
  }
  function avWire() {
    const q = $('avSearch'); if (q) q.addEventListener('input', debounce(() => { AV.q = q.value; renderAverages(); }));
    const b = $('avBranch'); if (b) b.addEventListener('change', () => { AV.branch = b.value; renderAverages(); });
    const nz = $('avNonZero'); if (nz) nz.addEventListener('click', () => { AV.nonZero = !AV.nonZero; renderAverages(); });
    $('avBody').querySelectorAll('[data-avm]').forEach(x => x.addEventListener('click', () => { AV.months = +x.dataset.avm; renderAverages(); }));
  }

  /** O que o motor usa hoje. */
  function avStored() {
    let rows = S.avg.slice();
    if (AV.q) rows = rows.filter(r => String(r.product || '').toLowerCase().includes(AV.q.toLowerCase()));
    rows = rows.map(r => { const p = S.prod[String(r.product || '').toUpperCase()] || {};
      const vals = {}; BRANCHES.forEach(b => { vals[b.code] = pickAvg(r, b); });
      return { code: r.product, name: p.name || '', vals }; });
    if (AV.nonZero) rows = rows.filter(r => BRANCHES.some(b => r.vals[b.code] > 0));
    if (AV.branch) rows = rows.filter(r => r.vals[AV.branch] > 0);
    const total = rows.length; rows = rows.slice(0, 600);
    $('avBody').innerHTML = avBar({ search: true, branch: true, nonZero: true }) +
      `<div class="rp-note rp-note-info">These are the stored columns the engine reads. They are a snapshot from an
       office import — the window they cover is not recorded anywhere, so this screen will not claim one.
       Use <b>Measured from sales</b> to see what the sales actually say for a window you choose.</div>
       <div class="sp-scroll"><table class="sp-grid rp-grid">
       <thead><tr><th class="txt" style="width:150px">Rapid Code</th><th class="txt">Product</th>` +
       BRANCHES.map(b => `<th class="num" style="width:90px">${esc(b.name)}</th>`).join('') + `</tr></thead><tbody>` +
       rows.map(r => `<tr><td class="code txt">${esc(r.code)}</td><td class="txt">${esc(String(r.name).slice(0, 46))}</td>` +
         BRANCHES.map(b => `<td class="num">${r.vals[b.code] > 0 ? n1(r.vals[b.code]) : '<span class="rp-sub">·</span>'}</td>`).join('') + '</tr>').join('') +
       '</tbody></table></div>';
    $('avCount').textContent = `${n0(total)} SKUs${total > 600 ? ' · showing 600' : ''}`;
    avWire();
  }

  /** O que a venda diz, na janela escolhida. */
  async function avMeasured() {
    $('avBody').innerHTML = avBar({ search: true, branch: true, window: true }) + '<div class="rp-hist-empty">Loading…</div>';
    avWire();
    // O nome do DEPÓSITO, não o da filial: "Sunshine Coast" não existe no dado.
    const bn = depotOf(AV.branch);
    const qs = new URLSearchParams({ months: AV.months }); if (bn) qs.set('location', bn);
    let d;
    try { d = await fetch(`/api/replenishment/averages?${qs}`).then(r => r.json()); }
    catch (e) { $('avBody').innerHTML = avBar({ search: true, branch: true, window: true }) +
      `<div class="rp-hist-empty">Could not load.<br><span class="rp-sub">${esc(e.message)}</span></div>`; avWire(); return; }
    let rows = d.rows || [];
    if (AV.q) { const q = AV.q.toLowerCase(); rows = rows.filter(r => (r.sku + ' ' + (r.name || '')).toLowerCase().includes(q)); }
    // Contado sobre o conjunto FILTRADO e ANTES do corte de 600.
    const distintos = new Set(rows.map(r => r.sku_key || r.sku)).size;
    const total = rows.length; rows = rows.slice(0, 600);
    const sp = d.span || {};
    $('avBody').innerHTML = avBar({ search: true, branch: true, window: true }) +
      `<div class="rp-note rp-note-info">History runs <b>${esc(String(sp.first_day || '').slice(0, 10))}</b> to
       <b>${esc(String(sp.last_day || '').slice(0, 10))}</b> — ${sp.months} months, all there is.
       ${sp.partial_month ? '<b>This month is still running</b>, so counting it whole drags the average down.' : ''}
       Sales swing about 2× across the year, so the window changes the average by up to 47%.</div>
       <div class="sp-scroll"><table class="sp-grid rp-grid">
       <thead><tr><th class="txt" style="width:150px">Rapid Code</th><th class="txt">Product</th>
       <th class="num" style="width:110px">Avg / month</th><th class="num" style="width:90px">Units</th>
       <th class="num" style="width:80px">Orders</th><th class="num" style="width:120px">Months w/ sales</th></tr></thead><tbody>` +
       rows.map(r => `<tr><td class="code txt">${esc(r.sku)}</td><td class="txt">${esc(String(r.name || '').slice(0, 46))}</td>
         <td class="num"><b>${n1(r.avg_month)}</b></td><td class="num">${n0(r.qty)}</td><td class="num">${n0(r.orders)}</td>
         <td class="num ${r.months_with_sales < AV.months / 2 ? 'rp-thin' : ''}"
             title="${r.months_with_sales} of the ${AV.months} months in the window had a sale">${r.months_with_sales} / ${AV.months}</td></tr>`).join('') +
       '</tbody></table></div>';
    /* Contava LINHAS (pares SKU × local) e escrevia "SKUs": 8.600 linhas são
       3.065 SKUs distintos. E o "4,000" de antes não era medição nenhuma — era
       o LIMIT da função, que saiu. Agora diz as duas coisas, e diz que a
       tabela mostra 600. */
    $('avCount').textContent = `${n0(distintos)} SKUs · ${n0(total)} SKU×location rows`
      + (total > 600 ? ' · showing 600' : '')
      + ` · ${AV.months}m${bn ? ' · ' + esc(bn) : ' · all branches'}`;
    avWire();
  }

  /** Quem atende qual filial. */
  async function avReps() {
    $('avBody').innerHTML = avBar({ search: true }) + '<div class="rp-hist-empty">Loading…</div>';
    avWire();
    let d;
    try { d = await fetch('/api/replenishment/reps').then(r => r.json()); }
    catch (e) { $('avBody').innerHTML = avBar({ search: true }) +
      `<div class="rp-hist-empty">Could not load.<br><span class="rp-sub">${esc(e.message)}</span></div>`; avWire(); return; }
    let rows = d.rows || [];
    if (AV.q) { const q = AV.q.toLowerCase(); rows = rows.filter(r => r.rep.toLowerCase().includes(q)); }
    $('avBody').innerHTML = avBar({ search: true }) + avRepTable(rows);
    $('avCount').textContent = `${rows.length} reps · ${rows.filter(r => r.assigned_branch && !['MAIN','NONE'].includes(r.assigned_branch)).length} on branches`;
    avWire();
  }

  // ── settings ─────────────────────────────────────────────────────────
  function openSettings() {
    closeSide();
    $('setWeeks').value = SET.weeks; $('setDays').value = Math.round(SET.weeks * 7) + ' days'; $('setCutDays').value = SET.cutDays; $('setAbc').checked = SET.abc;
    if ($('setDemand')) $('setDemand').value = SET.demand;
    if ($('setSalesMonths')) $('setSalesMonths').value = String(SET.salesMonths);
    if ($('setAvgSource')) $('setAvgSource').value = SET.avgSource;
    $('setAvgRound').value = SET.avgRound; $('setCartons').checked = SET.cartons;
    if ($('setMinAvg')) $('setMinAvg').value = SET.minAvg;
    const rows = S.avg.map(r => ({ code: r.product, tot: BRANCHES.reduce((s, b) => s + pickAvg(r, b), 0) })).filter(r => r.tot > 0).sort((a, b) => b.tot - a.tot).slice(0, 60);
    $('setAvgTable').innerHTML = '<thead><tr><th class="txt">Rapid Code</th><th class="num">Tier</th><th class="num">Network avg/mo</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td class="code txt">${esc(r.code)}</td><td class="num"><span class="rp-tier ${(S.ranks && S.ranks.get(r.code)) || 'C'}">${(S.ranks && S.ranks.get(r.code)) || 'C'}</span></td><td class="num">${n1(r.tot)}</td></tr>`).join('') + '</tbody>';
    $('mdSettings').classList.add('is-on');
  }
  $('setWeeks') && $('setWeeks').addEventListener('input', e => { $('setDays').value = Math.round((Number(e.target.value) || 0) * 7) + ' days'; });
  function applySettings() {
    SET.weeks = Math.max(1, Number($('setWeeks').value) || 6); SET.cutDays = Math.max(1, Number($('setCutDays').value) || 25);
    SET.abc = $('setAbc').checked; if ($('setAvgSource')) SET.avgSource = $('setAvgSource').value;
    SET.avgRound = $('setAvgRound').value; SET.cartons = $('setCartons').checked;
    if ($('setMinAvg')) SET.minAvg = Math.max(0, Number($('setMinAvg').value) || 0);
    const basisBefore = SET.demand, monthsBefore = SET.salesMonths;
    if ($('setDemand')) SET.demand = $('setDemand').value;
    if ($('setSalesMonths')) SET.salesMonths = +$('setSalesMonths').value;
    saveSet(); $('mdSettings').classList.remove('is-on');
    // Trocar a régua ou a janela muda o NÚMERO de cada linha, então a régua
    // tem de ser recarregada antes de a grade se redesenhar — senão a tela
    // mostra o alvo novo com a demanda velha.
    if (SET.demand !== basisBefore || SET.salesMonths !== monthsBefore) {
      refreshRepAvg().then(() => { if (S.branch) enterGrid(); });
    }
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
    if (v === 'averages') { renderAverages(); closeSide(); }
  }
  // ── CSV export (formato do Cin7: SKU · Name · Quantity · Comments) ────
  // SKU = Rapid Code · Name = Product · Quantity = Branch Ask · Comments = stock locator.
  // Só as linhas com Branch Ask > 0: é arquivo de pedido, linha sem quantidade não entra.
  function exportCSV() {
    const rows = (S.lines || []).filter(l => clampInt(l.ask) > 0);
    if (!rows.length) { toast('Nada para exportar — preencha o Branch Ask', true); return; }
    const q = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const out = [['SKU', 'Name', 'Quantity', 'Comments'].join(',')]
      .concat(rows.map(l => [q(l.code), q(l.name), clampInt(l.ask), q(l.loc || '')].join(',')));
    const csv = out.join('\r\n') + '\r\n';   // vírgula + CRLF, aspas só quando precisa — como o CSV do Cin7
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `branch_replenishment_${(S.branch && S.branch.code) || 'branch'}_${stamp}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exportado: ${rows.length} linha${rows.length === 1 ? '' : 's'}`);
  }

  function wire() {
    document.querySelectorAll('.sp-tab').forEach(b => b.addEventListener('click', () => showTop(b.dataset.view)));
    $('btnBack').addEventListener('click', renderLanding);
    document.querySelectorAll('#viewSeg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
    $('btnSettings').addEventListener('click', openSettings);
    $('btnLoadSuggest').addEventListener('click', openLoadModal);
    $('btnCols').addEventListener('click', openCols);
    $('btnExport').addEventListener('click', exportCSV);
    $('btnReset').addEventListener('click', startOver);
    $('loadConfirm').addEventListener('click', doLoad);
    $('sideClose').addEventListener('click', closeSide);
    $('setApply').addEventListener('click', applySettings);
    $('setReset').addEventListener('click', () => { SET = Object.assign({}, DEFAULTS); openSettings(); });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('mdSettings').classList.remove('is-on')));
    document.querySelectorAll('[data-close-load]').forEach(b => b.addEventListener('click', () => $('mdLoad').classList.remove('is-on')));
    document.querySelectorAll('[data-close-cols]').forEach(b => b.addEventListener('click', () => $('mdCols').classList.remove('is-on')));
    $('gridSearch').addEventListener('input', e => { S.search = e.target.value; renderGrid(); });
    document.querySelectorAll('#avSeg [data-a]').forEach(b => b.addEventListener('click', () => { AV.tab = b.dataset.a; renderAverages(); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { ['mdSettings', 'mdLoad', 'mdCols'].forEach(m => $(m).classList.remove('is-on')); closeSide(); } });
    window.addEventListener('scroll', () => { if ($('rpAc').classList.contains('on')) positionAc(); }, true);
  }

  (async function init() {
    try { if (window.supabaseReady) await window.supabaseReady; } catch (_) {}
    if (!sb() || !RC) { setStatus('bad', 'Supabase or engine not available'); return; }
    wire();
    /* A régua das sete filiais entra ANTES do primeiro desenho.
       Os cartões da tela inicial calculam a sugestão de cada filial com o
       mesmo motor da grade — sem a régua carregada eles somam zero, e zero ali
       lê-se "está tudo abastecido". É a leitura mais cara possível de um dado
       que ainda não chegou. */
    try { await loadBase(); await loadRepAvg(); renderLanding(); }
    catch (e) { console.error(e); setStatus('bad', 'Load failed: ' + e.message); toast('Load failed: ' + e.message, true); }
  })();
})();
