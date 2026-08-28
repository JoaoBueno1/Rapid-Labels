'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   O menu do sistema — UMA definição, usada por todas as páginas.

   Antes: HTML estático dentro do index.html, e mais nada. Toda feature era
   uma ilha com "← Back" e nenhuma noção de onde estava. Acrescentar um item
   significava editar index.html; mudar de grupo, editar de novo.

   Agora: a lista abaixo é a fonte. Cada página inclui
       <link rel="stylesheet" href="/shared/rail.css">
       <script defer src="/shared/rail.js"></script>
   e o rail aparece, com o item certo marcado.

   Ordem do grupo Inventory Management: segue o caminho físico de uma unidade
   pelo prédio — decide-se comprar, chega e é conferida, fica no overflow,
   repõe o pickface, segue para as filiais. Quem trabalha no armazém lê a
   sequência sem legenda.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__railMounted) return;
  window.__railMounted = true;
  // A página chama isto ao trocar de aba: o hash mudou sem navegação, e o menu
  // precisa remarcar o item certo.
  window.__railSync = () => {
    document.querySelectorAll('.rl-item[data-hash]').forEach((a) => {
      const h = (location.hash || '').replace('#', '') || 'supply';
      a.classList.toggle('on', a.dataset.hash === h);   // a classe deste rail é 'on'
    });
  };

  // Ícones em traço, herdando currentColor — o mesmo dialeto do sprite antigo.
  const ICONS = {
    dash:  '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    box:   '<path d="M21 8v8l-9 5-9-5V8l9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    ret:   '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    list:  '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    cycle: '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18.5 2v4h-4M5.5 22v-4h4"/>',
    plan:  '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M7 13h4M7 17h7"/>',
    inbox: '<path d="M5 5h14l3 7v7H2v-7z"/><path d="M2 12h5l2 3h6l2-3h5"/>',
    fact:  '<path d="M2 21V10l6 4V10l6 4V7l8 5v9z"/><path d="M6 21v-3M12 21v-3M18 21v-3"/>',
    truck: '<rect x="1" y="6" width="14" height="11" rx="1"/><path d="M15 10h4l3 3v4h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>',
    ship:  '<path d="M3 17l1.5-6h15L21 17"/><path d="M12 11V4h5"/><path d="M2 20c1.5 0 1.5-1.5 3-1.5S6.5 20 8 20s1.5-1.5 3-1.5S12.5 20 14 20s1.5-1.5 3-1.5S18.5 20 20 20"/>',
    tag:   '<path d="M20.6 13.4L12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    bar:   '<path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14"/>',
    layers:'<path d="M12 2l9 5-9 5-9-5z"/><path d="M3 12l9 5 9-5M3 17l9 5 9-5"/>',
    grid:  '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    sync:  '<path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18.5 2v4h-4M5.5 22v-4h4"/>',
    lock:  '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    ext:   '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  };

  /**
   * `modal` = ação que só existe no index. Fora dele, o item navega para o
   * index com ?open=… e a home abre o modal ao carregar. Antes esses botões
   * simplesmente não existiam nas outras páginas.
   */
  const MENU = [
    { group: 'Overview', items: [
      { t: 'Dashboard', href: '/index.html', ic: 'dash', match: ['/', '/index.html'] },
    ]},
    { group: 'Operations', items: [
      { t: 'Collections', href: '/collections.html', ic: 'box', badge: 'collectionsCount' },
      { t: 'Returns', href: '/features/returns/returns.html', ic: 'ret', badge: 'returnsCount' },
      { t: 'Re-Stock', href: '/restock-v2.html', ic: 'cycle', dot: 'railDotRestock' },
    ]},
    { group: 'Inventory Management', items: [
      // Sem badge de propósito: o número de SKUs em risco fica sempre perto de
      // 500 e nunca zera. Badge que não vai a zero deixa de ser sinal e vira
      // enfeite — o alerta útil está dentro da tela, agrupado por SKU.
      // As três eram a MESMA página, separadas só pelo hash. Viraram páginas
      // próprias: quem abre Projects não carrega mais 1.951 SKUs de projeção
      // para ver uma linha de pedido. Continuam se alimentando — pela URL e
      // pelos dados, não por compartilharem escopo de script.
      { t: 'Stock Planning', href: '/planning#supply', ic: 'plan',
        match: ['/planning', '/planning/', '/features/stock-planning/ui/planning.html'] },
      { t: 'Projects', href: '/projects', ic: 'fact',
        match: ['/projects', '/features/stock-planning/ui/projects.html'] },
      { t: 'Purchase Orders', href: '/purchase-orders', ic: 'box',
        match: ['/purchase-orders', '/features/stock-planning/ui/po.html'] },
      { t: 'Master Stock', href: '/master', ic: 'box',
        match: ['/master', '/features/stock-planning/ui/master.html'] },
      { t: 'Container Check', href: '/features/container-check/container-check.html', ic: 'inbox' },
      { t: 'Gateway', href: '/gateway-main.html', ic: 'fact', dot: 'railDotGateway' },
      { t: 'Branch Replenishment', href: '/features/replenishment/ui/replenishment.html', ic: 'truck',
        match: ['/features/replenishment/ui/replenishment.html', '/features/replenishment/replenishment.html', '/features/replenishment/replenishment-branch.html'] },
    ]},
    { group: 'Labels & Barcodes', items: [
      { t: 'Search & Print', modal: 'openSearchModal', ic: 'tag' },
      { t: 'Custom Label', modal: 'openManualModal', ic: 'pencil' },
      { t: 'Barcodes', modal: 'openBarcodesModal', ic: 'bar' },
      { t: 'Multi-Label', modal: 'openMultiLabelModal', ic: 'layers' },
      { t: 'Label Sheets', href: '/features/label-sheets/label-sheets.html', ic: 'grid' },
    ]},
    { group: 'Quality & Compliance', pin: true, items: [
      // Fica FORA do PIN: é ferramenta de uso diário, e travá-la só faria as
      // pessoas digitarem o PIN todo dia — que é como um PIN vira post-it.
      { t: 'Open Orders', href: '/features/logistics/open-orders.html', ic: 'list', badge: 'openOrdersCount', nopin: true },
      { t: 'Pick Anomalies', href: '/features/pick-anomalies/pick-anomalies.html', ic: 'alert', dot: 'railDotPA' },
      { t: 'Pick Productivity', href: '/features/pick-productivity/pick-productivity.html', ic: 'trend' },
      { t: 'Sync Monitor', href: '/features/sync-monitor/sync-monitor.html', ic: 'sync' },
    ]},
    { group: 'Analytics', items: [
      { t: 'Monthly Review', href: '/analytics', ic: 'trend',
        match: ['/analytics', '/analytics/', '/features/analytics/ui/analytics.html'] },
    ]},
    { group: 'External', items: [
      { t: 'Rapid Express', href: 'https://rapidexpress.com.au', ic: 'ext', blank: true },
    ]},
  ];

  const PIN = '4209';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const svg = (k) => `<svg class="rl-ic" viewBox="0 0 24 24">${ICONS[k] || ICONS.box}</svg>`;

  const here = location.pathname.replace(/\/+$/, '') || '/';
  const isIndex = here === '/' || /\/index\.html$/.test(here);
  // O `hash` sobrevive porque outros itens podem precisar dele; hoje nenhum
  // dos três usa, desde que Projects e Purchase Orders ganharam URL própria.
  const isActive = (it) => {
    const list = it.match || (it.href ? [it.href] : []);
    const pathOk = list.some((m) => {
      const p = m.replace(/\/+$/, '') || '/';
      return here === p || (p !== '/' && here.endsWith(p));
    });
    if (!pathOk) return false;
    if (!it.hash) return true;
    const h = (location.hash || '').replace('#', '');
    // Sem hash, o primeiro item do grupo (o padrão da página) leva a marcação.
    return h ? h === it.hash : it.hash === 'supply';
  };

  let unlocked = false;
  try { unlocked = sessionStorage.getItem('qcUnlocked') === '1'; } catch (_) {}
  let collapsed = false;
  try { collapsed = localStorage.getItem('rail.min') === '1'; } catch (_) {}
  let shut = new Set();
  try { shut = new Set(JSON.parse(localStorage.getItem('rail.shut') || '[]')); } catch (_) {}
  const saveShut = () => { try { localStorage.setItem('rail.shut', JSON.stringify([...shut])); } catch (_) {} };

  function itemHTML(it) {
    const on = isActive(it) ? ' on' : '';
    const badge = it.badge ? `<span class="rl-badge" id="${it.badge}" style="display:none"></span>` : '';
    const dot = it.dot ? `<span class="rl-dot" id="${it.dot}" style="display:none"></span>` : '';
    const inner = `${svg(it.ic)}<span class="t">${esc(it.t)}</span>${badge}${dot}`;
    if (it.modal) {
      // Fora do index o modal não existe; então o item leva até ele.
      return isIndex
        ? `<button type="button" class="rl-item${on}" data-modal="${it.modal}" title="${esc(it.t)}">${inner}</button>`
        : `<a class="rl-item${on}" href="/index.html?open=${encodeURIComponent(it.modal)}" title="${esc(it.t)}">${inner}</a>`;
    }
    const target = it.blank ? ' target="_blank" rel="noopener"' : '';
    // data-hash: é por ele que __railSync remarca sem recarregar a página.
    const dh = it.hash ? ` data-hash="${esc(it.hash)}"` : '';
    return `<a class="rl-item${on}" href="${esc(it.href)}"${target}${dh} title="${esc(it.t)}">${inner}</a>`;
  }

  function groupHTML(g) {
    // O grupo da página aberta nunca fica fechado: perder a referência de onde
    // se está é pior do que a lista ser longa.
    const hasActive = g.items.some(isActive);
    const isShut = shut.has(g.group) && !hasActive;
    const cls = isShut ? ' shut' : '';
    const head = `<div class="rl-grp-sep"></div>
      <button type="button" class="rl-grp${cls}" data-grp="${esc(g.group)}">
        <svg class="rl-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
        <span>${esc(g.group)}</span>
        ${isShut ? `<i class="rl-grp-n">${g.pin && !unlocked ? 1 : g.items.length}</i>` : ''}
      </button>`;
    if (isShut) return head;
    if (g.pin && !unlocked) {
      return head + g.items.filter((it) => it.nopin).map(itemHTML).join('') + `
        <button type="button" class="rl-item" id="rlLock" title="Unlock">${svg('lock')}<span class="t">Unlock</span></button>
        <div class="rl-pin" id="rlPinRow" hidden>
          <input id="rlPin" type="password" maxlength="4" inputmode="numeric" placeholder="PIN">
          <button type="button" id="rlPinGo">Go</button>
        </div>`;
    }
    return head + g.items.map(itemHTML).join('');
  }

  function render() {
    const el = document.getElementById('railRoot') || document.createElement('aside');
    el.id = 'railRoot'; el.className = 'rl';
    el.innerHTML = `
      <div class="rl-head">
        <img src="/rapid-express-icon.png" alt="" onerror="this.style.display='none'">
        <b>Rapid LED</b>
      </div>
      <div class="rl-scroll">${MENU.map(groupHTML).join('')}</div>
      <div class="rl-foot">
        <button type="button" class="rl-toggle" id="rlToggle" title="Collapse the menu">
          <svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg><span>Collapse</span>
        </button>
      </div>`;
    if (!el.parentNode) document.body.insertBefore(el, document.body.firstChild);

    const lock = document.getElementById('rlLock');
    if (lock) lock.onclick = () => {
      const row = document.getElementById('rlPinRow');
      row.hidden = !row.hidden;
      if (!row.hidden) document.getElementById('rlPin').focus();
    };
    const go = document.getElementById('rlPinGo');
    if (go) {
      const tryPin = () => {
        const i = document.getElementById('rlPin');
        if (i.value.trim() !== PIN) { i.classList.add('bad'); i.value = ''; i.placeholder = 'Wrong'; return; }
        try { sessionStorage.setItem('qcUnlocked', '1'); } catch (_) {}
        unlocked = true; render();
      };
      go.onclick = tryPin;
      document.getElementById('rlPin').onkeydown = (e) => {
        if (e.key === 'Enter') tryPin();
        if (e.key === 'Escape') document.getElementById('rlPinRow').hidden = true;
      };
    }
    document.getElementById('rlToggle').onclick = () => {
      collapsed = !collapsed;
      document.documentElement.classList.toggle('rl-min', collapsed);
      try { localStorage.setItem('rail.min', collapsed ? '1' : '0'); } catch (_) {}
    };
    // Pinta o último valor conhecido no mesmo quadro em que o rail aparece.
    const cached = readCache();
    if (cached) paintCounts(cached.v);

    el.querySelectorAll('[data-grp]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.grp;
        if (shut.has(k)) shut.delete(k); else shut.add(k);
        saveShut(); render();
      };
    });
    el.querySelectorAll('[data-modal]').forEach((b) => {
      b.onclick = () => { const fn = window[b.dataset.modal]; if (typeof fn === 'function') fn(); };
    });
  }

  function mount() {
    document.documentElement.classList.add('rl-on');
    if (collapsed) document.documentElement.classList.add('rl-min');
    render();
    // A home chega com ?open=… quando alguém clicou num item de Labels vindo
    // de outra página. Abre o modal e limpa a URL, para o refresh não repetir.
    if (isIndex) {
      const q = new URLSearchParams(location.search).get('open');
      if (q && /^open[A-Za-z]+Modal$/.test(q)) {
        setTimeout(() => { const fn = window[q]; if (typeof fn === 'function') fn(); }, 120);
        history.replaceState(null, '', location.pathname);
      }
    }
    loadCounts();
    setInterval(() => loadCounts(true), 60000);
    // Voltar para a aba depois de um tempo fora merece um número fresco.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadCounts(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  /**
   * Contadores.
   *
   * A primeira versão só buscava do servidor no load, e o efeito era ruim: a
   * cada troca de página o número sumia e voltava um segundo depois. Um badge
   * que pisca é pior que badge nenhum — o olho persegue o movimento.
   *
   * Agora o último valor conhecido é pintado JUNTO com o rail, do
   * localStorage, e a busca só corrige se mudou. Trocar de página deixa de
   * ter piscada, e o número velho por trinta segundos é melhor que nenhum.
   */
  const COUNT_KEY = 'rail.counts';
  const COUNT_TTL = 45000;

  function readCache() {
    try {
      const raw = localStorage.getItem(COUNT_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.v ? c : null;
    } catch (_) { return null; }
  }

  function paintCounts(v) {
    if (!v) return;
    const put = (id, n) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (n == null || n === 0) { el.style.display = 'none'; return; }
      const txt = n > 999 ? '999+' : String(n);
      if (el.textContent !== txt) el.textContent = txt;
      el.style.display = '';
    };
    put('collectionsCount', v.collections);
    put('returnsCount', v.returns);
    put('openOrdersCount', v.openOrders);
  }

  async function loadCounts(force) {
    const cached = readCache();
    if (cached && !force && Date.now() - cached.at < COUNT_TTL) return;
    try {
      const r = await fetch('/api/nav/counts');
      if (!r.ok) return;
      const c = await r.json();
      const v = { collections: c.collections, returns: c.returns, openOrders: c.openOrders };
      try { localStorage.setItem(COUNT_KEY, JSON.stringify({ v, at: Date.now() })); } catch (_) {}
      paintCounts(v);
    } catch (_) { /* contador é conforto, não função: falhar em silêncio */ }
  }

  /** Para a página escrever contador ou pontinho de sync sem conhecer o rail. */
  window.RailBadge = {
    set(id, value) {
      const el = document.getElementById(id); if (!el) return;
      if (value == null || value === '' || value === 0) { el.style.display = 'none'; return; }
      el.textContent = value; el.style.display = '';
    },
    dot(id, state) {
      const el = document.getElementById(id); if (!el) return;
      el.className = 'rl-dot' + (state ? ' ' + state : ''); el.style.display = '';
    },
  };
})();
