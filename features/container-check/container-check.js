/**
 * Container Check — front-end (QC de recebimento / inbound).
 *
 * Vanilla. Usa o cliente Supabase do front (supabase-config.js) so para
 * subir foto direto para o Storage; todo o resto vai pela API REST.
 *
 * Fluxo: New record -> awaiting review -> o revisor escreve a resolucao e
 * confirma -> reviewed. Tudo fica logado.
 *
 * DESENHO. A tela passou a usar o sistema do Stock Planning
 * (/features/stock-planning/ui/planning.css), igual a Branch Replenishment:
 * mesmo header, mesma grade, mesmo painel lateral, mesmo modal, mesmo toast.
 * Tres consequencias que valem dizer:
 *
 *   · Emoji saiu. Ele estava fazendo trabalho de dado — uma camera dizendo
 *     "tem foto" e um circulo amarelo dizendo "esperando". Agora a foto
 *     aparece como miniatura na propria linha, e o estado e uma etiqueta
 *     com contraste medido.
 *   · O detalhe deixou de ser modal e virou painel lateral: e onde as outras
 *     duas telas do modulo poem o detalhe de uma linha.
 *   · confirm() nativo saiu (o design system proibe) e virou modal.
 */
(function () {
  'use strict';

  const API        = '/api/container-check';
  const BUCKET     = 'container-check';
  const LABELS     = ['OK', 'Wrong', 'Missing', 'N/A'];
  const MAX_PHOTOS = 4;
  const PAGE_SIZE  = 50;
  const LATE_DAYS  = 7;   // a partir daqui a fila deixou de ser fila

  const state = {
    view:      'records',
    records:   [],
    summary:   null,
    page:      1, pageSize: PAGE_SIZE, total: 0, pageCount: 1,
    sort:      'date', dir: 'desc',
    issuesOnly: false,
    editingId: null,
    form:      { ocl: null, icl: null, bar: null },
    photos:    [],
    uploading: 0,
    acTimer:   null,
    photoSets: {},          // id -> [url] (alimenta o lightbox de qualquer tela)
    lb:        { list: [], i: 0 },
    onConfirm: null,
  };

  // ── helpers ─────────────────────────────────────────────────────
  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const lvClass = (v) => (v === 'N/A' ? 'NA' : v);
  const n0 = (v) => (v == null || v === '') ? '' : Number(v).toLocaleString('en-AU');
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  /** dd/mm/yyyy — o padrao do app (features/returns/returns.js:20). */
  const d10 = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const dSh = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}` : ''; };
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('en-AU'); } catch (_) { return iso || ''; } };
  const daysSince = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); if (!m) return null;
    return Math.round((Date.parse(today() + 'T00:00:00Z') - Date.parse(m[0] + 'T00:00:00Z')) / 86400000);
  };
  const pluralDays = (n) => n === 0 ? 'today' : n === 1 ? '1 day' : n + ' days';
  const plural = (n, one, many) => `${n0(n)} ${Number(n) === 1 ? one : (many || one + 's')}`;

  let toastT;
  function toast(msg, bad) {
    const el = $('toast'); el.textContent = msg;
    el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.className = 'sp-toast'; }, bad ? 5000 : 2400);
  }

  /** O ponto no header e o unico lugar que diz, sempre, o que a tela acabou
      de fazer. Sem ele o estado de erro so existia dentro da tabela. */
  function setStatus(level, text) {
    const dot = $('statusDot');
    if (dot) dot.className = 'sp-dot ' + (level === 'loading' ? 'stale' : level === 'bad' ? 'dead' : 'fresh');
    if ($('statusText')) $('statusText').textContent = text;
  }

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.method && opts.method !== 'GET') {
      const u = (opts.user || '').trim();
      if (!u) throw new Error('Enter your name first.');
      headers['x-cc-user'] = u;
    }
    const res = await fetch(API + path, {
      method: opts.method || 'GET', headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch (_) {}
    if (!res.ok || !json.success) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json.data;
  }

  // ════════════════════════════════════════════════════════════════
  // PECAS DE RENDER COMPARTILHADAS
  // ════════════════════════════════════════════════════════════════

  /** Etiqueta de valor de label. Vazio e um traco, nao um branco: "nao
      conferido" e "conferido e estava OK" nao podem parecer a mesma coisa. */
  function lv(v) {
    if (!v) return '<span class="cc-lv cc-lv-blank">&mdash;</span>';
    return `<span class="cc-lv cc-lv-${lvClass(v)}">${esc(v)}</span>`;
  }

  const STATUS_TAG = {
    pending: ['Missing', 'awaiting'],
    green:   ['OK',      'reviewed'],
    red:     ['Wrong',   'red'],       // legado: nada escreve mais estes dois
    orange:  ['Missing', 'orange'],
  };
  function statusTag(s) {
    const t = STATUS_TAG[s] || ['NA', s || '—'];
    return `<span class="cc-lv cc-lv-${t[0]}">${esc(t[1])}</span>`;
  }

  /** Registra as fotos de um registro e devolve miniaturas clicaveis.
      O lightbox precisa da LISTA para ter proximo/anterior, e as tres telas
      que mostram foto (grade, fila, painel) nao compartilham fonte de dados —
      por isso o mapa por id em vez de ler do array da tela. */
  function shots(rec, kind) {
    const arr = (Array.isArray(rec.photos) ? rec.photos : []).filter(p => p && p.url);
    state.photoSets[rec.id] = arr.map(p => p.url);
    if (!arr.length) return null;
    const img = (i, cls) =>
      `<img class="${cls}" src="${esc(arr[i].url)}" alt="Photo ${i + 1} of ${esc(rec.rapid_code || 'record')}"
            loading="lazy" data-set="${esc(rec.id)}" data-i="${i}">`;
    if (kind === 'grid') {
      const n = Math.min(3, arr.length);
      let h = '';
      for (let i = 0; i < n; i++) h += img(i, 'cc-th');
      if (arr.length > n) h += `<span class="cc-more">+${arr.length - n}</span>`;
      return `<span class="cc-thumbs">${h}</span>`;
    }
    if (kind === 'card') {
      let strip = '';
      for (let i = 1; i < arr.length; i++) strip += img(i, 'cc-th');
      return `<div class="cc-rev-shots">${img(0, 'cc-hero')}${strip ? `<div class="cc-strip">${strip}</div>` : ''}</div>`;
    }
    let h = '';
    for (let i = 0; i < arr.length; i++) h += img(i, 'cc-side-shot');
    return `<div class="cc-side-shots">${h}</div>`;
  }

  const NO_SHOT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.4"/></svg>';
  const noShot = () => `<div class="cc-noshot">${NO_SHOT_SVG}<span>no photo</span></div>`;

  function note(kind, txt, cls) {
    if (!txt) return '';
    return `<div class="cc-note ${cls || ''}"><i>${esc(kind)}</i>${esc(txt)}</div>`;
  }

  /** Qual das tres etiquetas mais falha. E a pergunta que o fornecedor
      precisa responder, e nenhum dos numeros antigos respondia. */
  function worstLabel(by) {
    const NAME = { ocl: 'OCL', icl: 'ICL', bar: 'Bar' };
    let best = null;
    ['ocl', 'icl', 'bar'].forEach(k => {
      const o = (by && by[k]) || {};
      const wrong = o.Wrong || 0, missing = o.Missing || 0;
      const bad = wrong + missing;
      if (!best || bad > best.bad) best = { k, name: NAME[k], bad, wrong, missing };
    });
    return best;
  }

  // ════════════════════════════════════════════════════════════════
  // RECORDS — a grade
  // ════════════════════════════════════════════════════════════════
  /* Larguras fixas: table-layout:fixed nao deixa a coluna pular de tamanho
     quando muda a pagina, que era o que fazia a grade antiga "tremer".
     `reviewed_by` NAO e ordenavel de proposito — a coluna so existe depois da
     migracao 003, e pedir ORDER BY numa coluna que pode nao existir devolve
     400 em vez de uma lista. */
  const COLS = [
    { k: 'date',     t: 'Date',        w: 78,  srt: true },
    { k: 'dc',       t: '5DC',         w: 64,  srt: true },
    { k: 'code',     t: 'Rapid code',  w: 152, srt: true },
    { k: 'po',       t: 'PO',          w: 92,  srt: true },
    { k: 'qty',      t: 'Qty',         w: 58,  srt: true, cls: 'n' },
    { k: 'ocl',      t: 'OCL',         w: 74,  cls: 'c' },
    { k: 'icl',      t: 'ICL',         w: 74,  cls: 'c' },
    { k: 'bar',      t: 'Bar',         w: 74,  cls: 'c' },
    { k: 'photos',   t: 'Photos',      w: 98,  cls: 'c' },
    { k: 'status',   t: 'Status',      w: 104, srt: true, cls: 'c' },
    { k: 'by',       t: 'Recorded by', w: 112, srt: true },
    { k: 'reviewer', t: 'Reviewed by', w: 112 },
    { k: 'notes',    t: 'Notes' },
  ];

  function gridHead() {
    // As larguras vivem no CSS (.cc-grid col:nth-child): atributo `width` em
    // <col> e presentacional e style= inline e proibido pelo design system.
    const cg = '<colgroup>' + COLS.map(() => '<col>').join('') + '</colgroup>';
    const th = COLS.map(c => {
      const on  = c.srt && state.sort === c.k;
      const cls = [c.cls || '', c.srt ? 'srt' : '', on ? 'on' : ''].filter(Boolean).join(' ');
      const ar  = c.srt ? `<span class="ar">${on && state.dir === 'asc' ? '&#9650;' : '&#9660;'}</span>` : '';
      return `<th class="${cls}"${c.srt ? ` data-srt="${c.k}"` : ''}>${esc(c.t)}${ar}</th>`;
    }).join('');
    return cg + `<thead><tr>${th}</tr></thead>`;
  }
  const stateBody = (html) => `<tbody class="cc-st"><tr><td colspan="${COLS.length}">${html}</td></tr></tbody>`;

  function filtersQS(extra) {
    const qs = new URLSearchParams();
    if ($('fFrom').value)          qs.set('from', $('fFrom').value);
    if ($('fTo').value)            qs.set('to', $('fTo').value);
    if ($('fStatus').value)        qs.set('status', $('fStatus').value);
    if ($('fSearch').value.trim()) qs.set('q', $('fSearch').value.trim());
    if (state.issuesOnly)          qs.set('issues', '1');
    qs.set('sort', state.sort);
    qs.set('dir', state.dir);
    qs.set('page', state.page);
    qs.set('pageSize', state.pageSize);
    Object.keys(extra || {}).forEach(k => qs.set(k, extra[k]));
    return qs.toString();
  }

  async function loadRecords() {
    $('grid').innerHTML = gridHead() + stateBody('<div class="cc-state">Loading records&hellip;</div>');
    setStatus('loading', 'Loading…');
    try {
      const data = await api('/records?' + filtersQS());
      state.records   = data.items || [];
      state.summary   = data.summary || null;
      state.total     = data.total || 0;
      state.page      = data.page || 1;
      state.pageCount = data.pageCount || 1;
      renderKpis(state.summary || {});
      renderGrid(state.records);
      renderFoot();
      renderQuality();
      paintPip((state.summary && state.summary.by_status && state.summary.by_status.pending) || 0);
      const s = state.summary || {};
      $('rowCount').textContent =
        `${plural(state.total, 'record')} · ${plural(s.skus || 0, 'SKU')} · ${plural(s.days || 0, 'day')}`;
      setStatus('ok', s.last_check ? 'Last check ' + d10(s.last_check) : 'Loaded');
    } catch (e) {
      // Vazio nao pode parecer erro nem o contrario: aqui a tela diz o que
      // falhou, mostra a mensagem crua e oferece tentar de novo.
      $('grid').innerHTML = gridHead() + stateBody(
        `<div class="cc-state err"><b>Could not load the records</b>
           <code>${esc(e.message)}</code>
           <div><button class="sp-btn" type="button" data-retry>Try again</button></div>
         </div>`);
      $('kpis').innerHTML = '';
      $('foot').innerHTML = '';
      $('rowCount').textContent = '';
      setStatus('bad', 'Load failed');
    }
  }
  function reload(fromFirstPage) { if (fromFirstPage) state.page = 1; loadRecords(); }

  function renderGrid(items) {
    if (!items.length) {
      $('grid').innerHTML = gridHead() + stateBody(
        `<div class="cc-state"><b>No records match this filter</b>
           Nothing was rejected — there is simply nothing recorded in this range.
           <div><button class="sp-btn" type="button" data-clear>Clear the filter</button></div>
         </div>`);
      return;
    }
    const rows = items.map(r => {
      const inv = r.inventory_notes || '';
      const res = r.reviewer_notes || '';
      const notes = [inv, res && '→ ' + res].filter(Boolean).join('   ');
      return `<tr data-id="${esc(r.id)}"${r.status === 'pending' ? ' class="is-pending"' : ''}>
        <td class="mono">${esc(d10(r.check_date))}</td>
        <td class="mono mut">${esc(r.five_dc || '') || '<span class="void">&mdash;</span>'}</td>
        <td class="code" title="${esc(r.rapid_code || '')}">${esc(r.rapid_code || '')}</td>
        <td class="mono mut" title="${esc(r.po || '')}">${esc(r.po || '') || '<span class="void">&mdash;</span>'}</td>
        <td class="n">${r.qty != null ? esc(n0(r.qty)) : '<span class="void">&mdash;</span>'}</td>
        <td class="c">${lv(r.ocl)}</td>
        <td class="c">${lv(r.icl)}</td>
        <td class="c">${lv(r.bar)}</td>
        <td class="c">${shots(r, 'grid') || '<span class="cc-lv cc-lv-blank">&mdash;</span>'}</td>
        <td class="c">${statusTag(r.status)}</td>
        <td class="mut">${esc(r.created_by || '')}</td>
        <td class="mut">${esc(r.reviewed_by || '') || '<span class="void">&mdash;</span>'}</td>
        <td class="mut" title="${esc(notes)}">${esc(notes) || '<span class="void">&mdash;</span>'}</td>
      </tr>`;
    }).join('');
    $('grid').innerHTML = gridHead() + `<tbody>${rows}</tbody>`;
  }

  // ── KPIs ────────────────────────────────────────────────────────
  /* Cinco perguntas, e so estas cinco: o que preciso fazer, ha quanto tempo
     esta parado, quanto deu problema, com que frequencia, e onde. Os numeros
     antigos (Total / Items OK / With issues / Issue rate / dois blocos de
     pilulas) contavam a mesma coisa tres vezes e nao diziam a idade da fila,
     que e a unica que vira reclamacao de fornecedor. */
  function renderKpis(s) {
    const by      = s.by_status || {};
    const pending = by.pending || 0;
    const age     = s.pending_age_days;
    const over    = s.pending_over_7d || 0;
    const issues  = s.issues || 0;
    const rate    = s.total ? (s.issue_rate * 100) : 0;
    const worst   = worstLabel(s.by_label);

    const ageTone = pending === 0 ? 'good' : (age != null && age > LATE_DAYS) ? 'bad' : 'warn';
    const tile = (tone, val, unit, label, sub) =>
      `<div class="sp-tile ${tone}"><b>${val}${unit ? `<u>${unit}</u>` : ''}</b><em>${label}</em><small>${sub}</small></div>`;

    $('kpis').innerHTML = [
      `<button class="sp-tile ${pending ? 'warn' : 'good'}" type="button" data-go="review">
         <b>${n0(pending)}</b><em>Awaiting review</em>
         <small>${pending ? 'open the queue to close them' : 'the queue is clear'}</small>
       </button>`,
      tile(ageTone,
        pending && age != null ? n0(age) : '&mdash;',
        pending && age != null ? 'd' : '',
        'Oldest waiting',
        pending ? (over ? `${n0(over)} past ${LATE_DAYS} days` : `none past ${LATE_DAYS} days`) : 'nothing is waiting'),
      tile(issues ? 'bad' : 'good', n0(issues), '', 'With issues',
        `of ${n0(s.total || 0)} records checked`),
      tile(rate >= 10 ? 'bad' : rate >= 4 ? 'warn' : 'good', rate.toFixed(1), '%', 'Issue rate',
        'Wrong or Missing on any label'),
      worst && worst.bad
        ? tile('bad', worst.name, '', 'Worst label',
            `${n0(worst.bad)} bad &mdash; ${n0(worst.wrong)} wrong · ${n0(worst.missing)} missing`)
        : tile('good', '&mdash;', '', 'Worst label', 'no label failed in this range'),
    ].join('');
  }

  function paintPip(n) {
    const pip = $('pipReview');
    if (!pip) return;
    pip.textContent = n ? n : '';
    pip.className = 'sp-pip' + (n ? ' on' : '');
  }

  // ── rodape: legenda + paginacao ─────────────────────────────────
  function renderFoot() {
    const from = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const to   = Math.min(state.total, state.page * state.pageSize);
    const btn  = (pg, txt, off) =>
      `<button class="cc-pgbtn" type="button" data-pg="${pg}"${off ? ' disabled' : ''}>${txt}</button>`;
    const first = state.page <= 1, last = state.page >= state.pageCount;
    $('foot').innerHTML = `
      <span><i class="k" data-key="pending"></i>awaiting review</span>
      <span>Click a row for the whole record and its history</span>
      <span class="cc-pg">
        <span class="cc-pos">${n0(from)}&ndash;${n0(to)} of ${n0(state.total)}</span>
        ${btn('first', '&laquo;', first)}${btn('prev', '&lsaquo; Prev', first)}
        <span class="cc-pos">${state.page} / ${state.pageCount}</span>
        ${btn('next', 'Next &rsaquo;', last)}${btn('last', '&raquo;', last)}
      </span>`;
  }

  // ════════════════════════════════════════════════════════════════
  // QUALITY — onde a falha esta
  // ════════════════════════════════════════════════════════════════
  /* Le o MESMO summary da aba Records (varrido sobre o filtro inteiro), por
     isso nao ha segunda consulta nem segunda verdade. Larguras de barra vao
     em style porque sao geometria de dado, nao decisao de estilo — mesmo
     caminho que planning.js usa nos graficos dele. */
  const LABEL_NAMES = { ocl: ['OCL', 'Outer carton label'], icl: ['ICL', 'Inner carton label'], bar: ['Bar', 'Barcode on the unit'] };
  const CHART_H = 88;

  function qStack(o, total) {
    if (!total) return '<div class="cc-qbar"></div>';
    const seg = (key, cls, name) => {
      const v = o[key] || 0;
      if (!v) return '';
      return `<i class="s-${cls}" style="width:${(v / total * 100).toFixed(3)}%" title="${name}: ${n0(v)}"></i>`;
    };
    return '<div class="cc-qbar">'
      + seg('OK', 'OK', 'OK') + seg('Wrong', 'Wrong', 'Wrong') + seg('Missing', 'Missing', 'Missing')
      + seg('N/A', 'NA', 'N/A') + seg('blank', 'blank', 'not checked')
      + '</div>';
  }

  function qLabels(s) {
    const total = s.total || 0;
    const rows = ['ocl', 'icl', 'bar'].map(k => {
      const o = (s.by_label && s.by_label[k]) || {};
      const nm = LABEL_NAMES[k];
      return `<div class="cc-qrow">
        <span class="cc-qname">${nm[0]}<small>${nm[1]}</small></span>
        ${qStack(o, total)}
        <span class="cc-qnums"><b>${n0(o.Wrong || 0)}</b> wrong · <em>${n0(o.Missing || 0)}</em> missing</span>
      </div>`;
    }).join('');
    return `<div class="sp-panel">
      <h4>Where the label fails <span>&mdash; every record in the current filter</span></h4>
      <div class="in">${rows}
        <div class="cc-key">
          <span><i class="s-OK"></i>OK</span><span><i class="s-Wrong"></i>Wrong</span>
          <span><i class="s-Missing"></i>Missing</span><span><i class="s-NA"></i>N/A</span>
          <span><i class="s-blank"></i>not checked</span>
        </div>
      </div></div>`;
  }

  function qOffenders(s) {
    const list = s.top_offenders || [];
    const body = list.length
      ? list.map(c => `<tr class="click" data-code="${esc(c.code)}">
          <td class="code">${esc(c.code)}</td>
          <td class="n">${n0(c.records)}</td>
          <td class="n">${n0(c.issues)}</td>
          <td class="n">${c.records ? Math.round(c.issues / c.records * 100) : 0}%</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="cc-hist-empty">No SKU failed a label in this range.</td></tr>';
    return `<div class="sp-panel">
      <h4>SKUs that keep coming back <span>&mdash; click one to filter the log by it</span></h4>
      <table><thead><tr><th>Rapid code</th><th class="n">Checks</th><th class="n">Issues</th><th class="n">Rate</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
  }

  function qDaily(s) {
    const days = s.by_day || [];
    if (!days.length) return '';
    const max = Math.max.apply(null, days.map(d => d.n).concat([1]));
    const cols = days.map(d => {
      const h   = Math.max(2, Math.round(d.n / max * CHART_H));
      const bad = d.issues ? Math.max(1, Math.round(h * d.issues / d.n)) : 0;
      return `<div class="cc-col" title="${esc(d10(d.d))} — ${n0(d.n)} checked, ${n0(d.issues)} with issues">
        <span class="t">${n0(d.n)}</span>
        <span class="st" style="height:${h}px"><i class="ok" style="height:${h - bad}px"></i><i class="bad" style="height:${bad}px"></i></span>
        <span class="l">${esc(dSh(d.d))}</span>
      </div>`;
    }).join('');
    return `<div class="sp-panel cc-q-wide">
      <h4>Checked per day <span>&mdash; the last ${days.length} days with any record</span></h4>
      <div class="in"><div class="cc-cols">${cols}</div>
        <div class="cc-key"><span><i class="s-vol"></i>checked</span><span><i class="s-bad"></i>with an issue</span></div>
      </div></div>`;
  }

  function renderQuality() {
    const s = state.summary;
    if (!s) { $('qBody').innerHTML = '<div class="cc-state">Load the records first.</div>'; return; }
    if (!s.total) {
      $('qBody').innerHTML = '<div class="cc-state"><b>Nothing to analyse</b>No records match the filter set on the Records tab.</div>';
      $('qScope').textContent = '';
      return;
    }
    $('qScope').textContent = `${plural(s.total, 'record')} · ${plural(s.skus || 0, 'SKU')}`;
    $('qBody').innerHTML = qLabels(s) + qOffenders(s) + qDaily(s);
  }

  // ════════════════════════════════════════════════════════════════
  // NEED REVIEW — a fila
  // ════════════════════════════════════════════════════════════════
  /* O cartao mudou de eixo: a foto e a evidencia, entao ela lidera. Antes o
     que aparecia era uma lista de rotulos e um botao verde com emoji, e a
     foto ficava embaixo de tudo, pequena. */
  function revCard(r) {
    const age  = daysSince(r.check_date);
    const late = age != null && age > LATE_DAYS;
    const wait = age == null ? ''
      : `<span class="cc-lv cc-lv-${late ? 'Wrong' : 'Missing'}">waiting ${esc(pluralDays(age))}</span>`;
    const chip = (k, v) => `<span class="cc-pair"><i>${k}</i>${lv(v)}</span>`;
    return `<article class="cc-rev${late ? ' is-late' : ''}">
      <div class="cc-rev-h">
        <b>${esc(r.rapid_code || '—')}</b>
        ${r.five_dc ? `<span class="cc-lv cc-lv-NA">5DC ${esc(r.five_dc)}</span>` : ''}
        <span class="sp-gap"></span>${wait}
        <button class="ui-act" type="button" data-detail="${esc(r.id)}">Detail</button>
      </div>
      <div class="cc-rev-b">
        ${shots(r, 'card') || noShot()}
        <div class="cc-rev-facts">
          <div class="cc-fact"><i>Checked</i><b>${esc(d10(r.check_date))}</b></div>
          <div class="cc-fact"><i>Qty &middot; PO</i><b>${r.qty != null ? esc(n0(r.qty)) : '—'}</b> &middot; ${esc(r.po || '—')}</div>
          <div class="cc-fact"><i>Recorded by</i>${esc(r.created_by || '—')}</div>
          <div class="cc-lrow-inline">${chip('OCL', r.ocl)}${chip('ICL', r.icl)}${chip('Bar', r.bar)}</div>
          ${note('What inventory saw', r.inventory_notes)}
        </div>
      </div>
      <div class="cc-rev-f">
        <label><span>Reviewed by *</span>
          <input type="text" data-name="${esc(r.id)}" placeholder="Your name" autocomplete="off"></label>
        <label><span>Resolution * <small>what you did</small></span>
          <textarea data-note="${esc(r.id)}" rows="1">${esc(r.reviewer_notes || '')}</textarea></label>
        <button class="sp-btn is-primary" type="button" data-confirm="${esc(r.id)}">Confirm treated</button>
      </div>
    </article>`;
  }

  async function loadReview() {
    const list = $('revList');
    list.innerHTML = '<div class="cc-state">Loading the queue&hellip;</div>';
    try {
      const data  = await api('/review');
      const items = data.items || [];
      state.review = items;
      paintPip(items.length);
      $('revCount').textContent = items.length ? `${plural(items.length, 'record')} waiting` : 'nothing waiting';
      list.innerHTML = items.length
        ? items.map(revCard).join('')
        : `<div class="cc-state"><b>Nothing waiting</b>Every record recorded so far has been reviewed and closed.</div>`;
    } catch (e) {
      list.innerHTML = `<div class="cc-state err"><b>Could not load the queue</b>
        <code>${esc(e.message)}</code>
        <div><button class="sp-btn" type="button" data-retry-review>Try again</button></div></div>`;
      $('revCount').textContent = '';
    }
  }

  /** Modal de confirmacao. confirm() nativo e proibido pelo design system, e
      com razao: ele nao diz para onde o registro vai. */
  function confirmBox(title, body, okLabel) {
    return new Promise(resolve => {
      $('cfTitle').textContent = title;
      $('cfBody').textContent  = body;
      $('cfOk').textContent    = okLabel || 'Confirm';
      state.onConfirm = resolve;
      $('mdConfirm').classList.add('is-on');
    });
  }
  function closeConfirm(v) {
    $('mdConfirm').classList.remove('is-on');
    const fn = state.onConfirm; state.onConfirm = null;
    if (fn) fn(!!v);
  }

  async function reviewItem(id, btn) {
    const nameEl = document.querySelector(`input[data-name="${id}"]`);
    const reviewer = nameEl ? nameEl.value.trim() : '';
    if (!reviewer) { toast('Enter your name first', true); if (nameEl) nameEl.focus(); return; }
    const ta = document.querySelector(`textarea[data-note="${id}"]`);
    const reviewer_notes = ta ? ta.value.trim() : '';
    if (!reviewer_notes) { toast('Write the resolution before confirming', true); if (ta) ta.focus(); return; }

    const okd = await confirmBox('Close this record?',
      'It moves out of the queue and into the log as reviewed, stamped with your name. Editing it afterwards is still possible from the record detail.',
      'Confirm treated');
    if (!okd) return;

    // Acao em voo trava o botao que a disparou — a defesa contra o duplo clique.
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await api('/records/' + id, { method: 'PUT', body: { status: 'green', reviewer_notes }, user: reviewer });
      toast('Reviewed');
      loadReview();
      loadRecords();
    } catch (e) {
      toast('Not saved: ' + e.message, true);
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // DETALHE — painel lateral (era modal)
  // ════════════════════════════════════════════════════════════════
  const ACTION = {
    created:  ['Created',  'ui-tag--info'],
    updated:  ['Edited',   'ui-tag--neutral'],
    reviewed: ['Reviewed', 'ui-tag--ok'],
    deleted:  ['Deleted',  'ui-tag--danger'],
  };

  function openDetail(r) {
    $('sideTitle').textContent = r.rapid_code || 'Record';
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const reviewed = r.reviewed_by
      ? row('Reviewed by', `${esc(r.reviewed_by)}<br><span class="cc-hist-d">${esc(fmtTime(r.reviewed_at))}</span>`)
      : '';
    $('sideBody').innerHTML = `
      <table class="brk">
        ${row('Status', statusTag(r.status))}
        ${row('Date', esc(d10(r.check_date)))}
        ${row('5DC', esc(r.five_dc || '—'))}
        ${row('Qty', r.qty != null ? esc(n0(r.qty)) : '—')}
        ${row('PO', esc(r.po || '—'))}
        ${row('OCL', lv(r.ocl))}
        ${row('ICL', lv(r.icl))}
        ${row('Bar', lv(r.bar))}
        ${row('Recorded by', esc(r.created_by || '—'))}
        ${reviewed}
      </table>
      <h4>Photos</h4>
      ${shots(r, 'side') || '<div class="cc-hist-empty">No photo on this record.</div>'}
      ${note('What inventory saw', r.inventory_notes)}
      ${note('Resolution', r.reviewer_notes, 'is-res')}
      <h4>History</h4>
      <div id="sideHist"><div class="cc-hist-empty">loading&hellip;</div></div>
      <div class="cc-side-act"><button class="sp-btn" type="button" id="sideEdit">Edit this record</button></div>`;
    $('sideEdit').addEventListener('click', () => { closeSide(); openForm(r); });
    $('side').classList.add('is-on');
    loadHistory(r.id);
  }
  function closeSide() { $('side').classList.remove('is-on'); }

  function histDetails(action, d) {
    if (!d) return '';
    const bits = [];
    if (action === 'created') {
      ['ocl', 'icl', 'bar'].forEach(k => { if (d[k]) bits.push(`${k.toUpperCase()} ${d[k]}`); });
      if (d.photos) bits.push(`${d.photos} photo(s)`);
    }
    if (action === 'reviewed' && d.to_status) bits.push('→ ' + d.to_status);
    if (action === 'updated' && Array.isArray(d.changed) && d.changed.length) bits.push('changed: ' + d.changed.join(', '));
    if (d.photos_added)   bits.push(`+${d.photos_added} photo`);
    if (d.photos_removed) bits.push(`−${d.photos_removed} photo`);
    return bits.length ? `<span class="cc-hist-d">${esc(bits.join(' · '))}</span>` : '';
  }
  async function loadHistory(id) {
    const box = $('sideHist'); if (!box) return;
    try {
      const data  = await api('/records/' + id + '/log');
      const items = data.items || [];
      if (!items.length) {
        box.innerHTML = `<div class="cc-hist-empty">${esc(data.note || 'No history recorded for this one yet.')}</div>`;
        return;
      }
      box.innerHTML = items.map(l => {
        const a = ACTION[l.action] || [l.action, 'ui-tag--neutral'];
        return `<div class="cc-hist-row"><span class="ui-tag ${a[1]}">${esc(a[0])}</span>
          ${histDetails(l.action, l.details)}
          <span class="cc-hist-m">${esc(l.actor || '—')} · ${esc(fmtTime(l.created_at))}</span></div>`;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div class="cc-hist-empty">History unavailable: ${esc(e.message)}</div>`;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // FORMULARIO — novo / editar
  // ════════════════════════════════════════════════════════════════
  function buildSegments() {
    $$('.cc-seg').forEach(seg => {
      seg.innerHTML = LABELS.map(v =>
        `<button type="button" data-field="${seg.dataset.field}" data-val="${v}">${v}</button>`).join('');
    });
  }
  function paintSegments() {
    $$('.cc-seg button').forEach(b => {
      b.className = state.form[b.dataset.field] === b.dataset.val ? 'on-' + lvClass(b.dataset.val) : '';
    });
  }

  function openForm(record) {
    state.editingId = record ? record.id : null;
    state.form   = { ocl: (record && record.ocl) || null, icl: (record && record.icl) || null, bar: (record && record.bar) || null };
    state.photos = record && Array.isArray(record.photos) ? record.photos.slice() : [];
    $('fmTitle').textContent = record ? 'Edit record' : 'New record';
    $('fmDate').value  = (record && record.check_date) || today();
    $('fmCode').value  = (record && record.rapid_code) || '';
    $('fmDc').value    = (record && record.five_dc) || '';
    $('fmQty').value   = (record && record.qty != null) ? record.qty : '';
    $('fmPo').value    = (record && record.po) || '';
    $('fmNotes').value = (record && record.inventory_notes) || '';
    // O nome comeca VAZIO de proposito: quem age digita o proprio nome toda
    // vez. Pre-preencher com o anterior faz o log mentir sobre quem conferiu.
    $('fmBy').value = '';
    hideAc();
    paintSegments();
    renderPhotos();
    $('mdForm').classList.add('is-on');
    setTimeout(() => $('fmCode').focus(), 50);
  }
  function closeForm() { hideAc(); $('mdForm').classList.remove('is-on'); }

  async function saveForm() {
    const rapid_code = $('fmCode').value.trim();
    if (!rapid_code) { toast('Rapid code is required', true); $('fmCode').focus(); return; }
    const recordedBy = $('fmBy').value.trim();
    if (!recordedBy) { toast('Recorded by (your name) is required', true); $('fmBy').focus(); return; }
    if (state.uploading > 0) { toast('Wait for the photos to finish uploading', true); return; }

    const body = {
      check_date:      $('fmDate').value || today(),
      rapid_code,
      five_dc:         $('fmDc').value.trim(),
      qty:             $('fmQty').value,
      po:              $('fmPo').value.trim(),
      ocl:             state.form.ocl,
      icl:             state.form.icl,
      bar:             state.form.bar,
      photos:          state.photos,
      inventory_notes: $('fmNotes').value.trim(),
    };
    // Novo registro: o engine forca `pending`. Na edicao o status nao e
    // tocado aqui — quem manda nele e a revisao.

    const btn = $('fmSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (state.editingId) await api('/records/' + state.editingId, { method: 'PUT', body, user: recordedBy });
      else                 await api('/records', { method: 'POST', body, user: recordedBy });
      closeForm();
      toast('Saved');
      loadRecords();
      if (state.view === 'review') loadReview();
    } catch (e) {
      toast('Not saved: ' + e.message, true);
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  // ── autocomplete do Rapid Code (sugere, nao bloqueia) ───────────
  function onCodeInput() {
    const v = $('fmCode').value.trim();
    clearTimeout(state.acTimer);
    if (v.length < 2) { hideAc(); return; }
    state.acTimer = setTimeout(async () => {
      try {
        const data = await api('/products?q=' + encodeURIComponent(v));
        renderAc(data.items || []);
      } catch (_) { hideAc(); }
    }, 220);
  }
  function renderAc(items) {
    const box = $('fmAc');
    if (!items.length) { hideAc(); return; }
    box.innerHTML = items.slice(0, 8).map(p =>
      `<div data-sku="${esc(p.sku)}" data-dc="${esc(p.five_dc)}">
         <span class="sku">${esc(p.sku)}</span>
         ${p.five_dc ? `<span class="dc">${esc(p.five_dc)}</span>` : ''}
         <span class="nm">${esc(p.name)}</span>
       </div>`).join('');
    box.classList.add('on');
  }
  function hideAc() { const b = $('fmAc'); if (b) { b.classList.remove('on'); b.innerHTML = ''; } }

  // ════════════════════════════════════════════════════════════════
  // FOTOS — redimensiona no navegador, sobe direto pro Storage
  // ════════════════════════════════════════════════════════════════
  const CAM_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h3l2-3h8l2 3h3v11H3z"/><circle cx="12" cy="13" r="3.4"/><path d="M19 3v4M17 5h4"/></svg>';

  function renderPhotos() {
    const wrap = $('fmPhotos');
    const items = state.photos.map((p, i) =>
      `<div class="cc-up-item">
         <img src="${esc(p.url)}" alt="Photo ${i + 1}" data-up="${i}">
         <button class="cc-up-rm" type="button" data-rm="${i}" title="Remove this photo">&times;</button>
       </div>`).join('');
    const add = state.photos.length < MAX_PHOTOS
      ? `<label class="cc-up-add">${CAM_SVG}<span>Add photo</span>
           <input type="file" id="fmPhotoInput" accept="image/*" multiple hidden></label>`
      : '';
    wrap.innerHTML = items + add;
    const inp = $('fmPhotoInput');
    if (inp) inp.addEventListener('change', onPhotoPick);
  }

  function resizeImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width, height = img.height;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality || 0.72);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error('invalid image'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function uploadPhoto(blob) {
    await window.supabaseReady;
    const code = ($('fmCode').value.trim() || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const date = $('fmDate').value || today();
    const rand = Math.random().toString(36).slice(2, 7);
    const path = `${date}/${code}-${Date.now()}-${rand}.jpg`;
    const { error } = await window.supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    const { data } = window.supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  async function onPhotoPick(ev) {
    const files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = '';
    for (const file of files) {
      if (state.photos.length >= MAX_PHOTOS) { toast(`Maximum ${MAX_PHOTOS} photos`, true); break; }
      const wrap = $('fmPhotos');
      const ph = document.createElement('div');
      ph.className = 'cc-up-item busy';
      ph.innerHTML = '<span class="cc-spin"></span>';
      const addBtn = wrap.querySelector('.cc-up-add');
      wrap.insertBefore(ph, addBtn || null);
      state.uploading++;
      try {
        const blob = await resizeImage(file, 1280, 0.72);
        const url  = await uploadPhoto(blob);
        state.photos.push({ url, label: '' });
      } catch (e) {
        toast('Photo failed: ' + (e.message || e), true);
      } finally {
        state.uploading--;
        renderPhotos();
      }
    }
  }

  // ── lightbox (expandir, navegar, baixar) ────────────────────────
  function openLightbox(list, i) {
    if (!list || !list.length) return;
    state.lb = { list, i: Math.max(0, Math.min(i || 0, list.length - 1)) };
    paintLightbox();
    $('lightbox').classList.add('is-on');
  }
  function paintLightbox() {
    const { list, i } = state.lb;
    $('lbImg').src = list[i];
    $('lbCap').textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
    const many = list.length > 1;
    $('lbPrev').hidden = !many;
    $('lbNext').hidden = !many;
  }
  function stepLightbox(d) {
    const { list } = state.lb;
    if (!list.length) return;
    state.lb.i = (state.lb.i + d + list.length) % list.length;
    paintLightbox();
  }
  function closeLightbox() { $('lightbox').classList.remove('is-on'); $('lbImg').src = ''; }
  async function downloadCurrent() {
    const url = state.lb.list[state.lb.i]; if (!url) return;
    const name = (url.split('/').pop() || 'photo.jpg').split('?')[0];
    try {
      const r = await fetch(url);
      const blob = await r.blob();
      const a = document.createElement('a');
      const obj = URL.createObjectURL(blob);
      a.href = obj; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(obj);
    } catch (_) { window.open(url, '_blank', 'noopener'); }
  }

  // ════════════════════════════════════════════════════════════════
  // ABAS + LIGACOES
  // ════════════════════════════════════════════════════════════════
  function showView(v) {
    state.view = v;
    $$('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === v));
    $$('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === v));
    if (v === 'review')  loadReview();
    if (v === 'quality') renderQuality();
  }

  const DESC_FIRST = { date: 1, qty: 1 };
  function sortBy(key) {
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else { state.sort = key; state.dir = DESC_FIRST[key] ? 'desc' : 'asc'; }
    reload(true);
  }

  function clearFilters() {
    $('fFrom').value = ''; $('fTo').value = ''; $('fStatus').value = ''; $('fSearch').value = '';
    state.issuesOnly = false;
    $('fIssues').classList.remove('is-on');
    reload(true);
  }

  /** Abre o lightbox a partir de qualquer miniatura da pagina. */
  function zoomFrom(el) {
    const list = state.photoSets[el.dataset.set];
    if (list && list.length) openLightbox(list, Number(el.dataset.i) || 0);
  }

  function init() {
    buildSegments();

    $$('.sp-tab').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
    $('btnNew').addEventListener('click', () => openForm(null));

    // ── filtros ──
    $('fApply').addEventListener('click', () => reload(true));
    $('fClear').addEventListener('click', clearFilters);
    $('fStatus').addEventListener('change', () => reload(true));
    $('fIssues').addEventListener('click', () => {
      state.issuesOnly = !state.issuesOnly;
      $('fIssues').classList.toggle('is-on', state.issuesOnly);
      reload(true);
    });
    $('fSearch').addEventListener('keydown', e => { if (e.key === 'Enter') reload(true); });
    [$('fFrom'), $('fTo')].forEach(el => el.addEventListener('change', () => reload(true)));

    // ── grade: ordenar, abrir detalhe, ampliar foto, recuperar de erro ──
    $('grid').addEventListener('click', e => {
      const zoom = e.target.closest('[data-set]');
      if (zoom) { e.stopPropagation(); zoomFrom(zoom); return; }
      const th = e.target.closest('th[data-srt]');
      if (th) { sortBy(th.dataset.srt); return; }
      if (e.target.closest('[data-retry]')) { loadRecords(); return; }
      if (e.target.closest('[data-clear]')) { clearFilters(); return; }
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const r = state.records.find(x => String(x.id) === tr.dataset.id);
      if (r) openDetail(r);
    });

    $('foot').addEventListener('click', e => {
      const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return;
      const pg = b.dataset.pg;
      if (pg === 'first')     state.page = 1;
      else if (pg === 'prev') state.page = Math.max(1, state.page - 1);
      else if (pg === 'next') state.page = Math.min(state.pageCount, state.page + 1);
      else                    state.page = state.pageCount;
      loadRecords();
    });

    $('kpis').addEventListener('click', e => {
      const go = e.target.closest('[data-go]');
      if (go) showView(go.dataset.go);
    });

    // ── Quality: clicar um SKU leva ele para o filtro do log ──
    $('qBody').addEventListener('click', e => {
      const tr = e.target.closest('[data-code]'); if (!tr) return;
      $('fSearch').value = tr.dataset.code;
      showView('records');
      reload(true);
    });

    // ── fila de revisao ──
    $('revList').addEventListener('click', e => {
      const zoom = e.target.closest('[data-set]'); if (zoom) { zoomFrom(zoom); return; }
      if (e.target.closest('[data-retry-review]')) { loadReview(); return; }
      const det = e.target.closest('[data-detail]');
      if (det) {
        const r = (state.review || []).find(x => String(x.id) === det.dataset.detail);
        if (r) openDetail(r);
        return;
      }
      const cf = e.target.closest('[data-confirm]');
      if (cf) reviewItem(cf.dataset.confirm, cf);
    });

    // ── formulario ──
    $('mdForm').addEventListener('click', e => {
      if (e.target === $('mdForm') || e.target.hasAttribute('data-close')) { closeForm(); return; }
      const seg = e.target.closest('.cc-seg button');
      if (seg) {
        const f = seg.dataset.field;
        state.form[f] = state.form[f] === seg.dataset.val ? null : seg.dataset.val;
        paintSegments();
        return;
      }
      const rm = e.target.closest('[data-rm]');
      if (rm) { state.photos.splice(Number(rm.dataset.rm), 1); renderPhotos(); return; }
      const up = e.target.closest('[data-up]');
      if (up) openLightbox(state.photos.map(p => p.url), Number(up.dataset.up) || 0);
    });
    $('fmSave').addEventListener('click', saveForm);
    $('fmCode').addEventListener('input', onCodeInput);
    $('fmCode').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); hideAc(); } });
    // mousedown dispara antes do blur do input — no click a selecao ja se perdeu
    $('fmAc').addEventListener('mousedown', e => {
      const it = e.target.closest('[data-sku]'); if (!it) return;
      e.preventDefault();
      $('fmCode').value = it.dataset.sku;
      if (it.dataset.dc && !$('fmDc').value.trim()) $('fmDc').value = it.dataset.dc;
      hideAc();
    });

    // ── confirmacao ──
    $('cfOk').addEventListener('click', () => closeConfirm(true));
    $('mdConfirm').addEventListener('click', e => {
      if (e.target === $('mdConfirm') || e.target.hasAttribute('data-close')) closeConfirm(false);
    });

    // ── painel lateral + lightbox ──
    $('sideClose').addEventListener('click', closeSide);
    $('sideBody').addEventListener('click', e => {
      const zoom = e.target.closest('[data-set]'); if (zoom) zoomFrom(zoom);
    });
    $('lbClose').addEventListener('click', closeLightbox);
    $('lbDl').addEventListener('click', downloadCurrent);
    $('lbPrev').addEventListener('click', () => stepLightbox(-1));
    $('lbNext').addEventListener('click', () => stepLightbox(1));
    $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) closeLightbox(); });

    document.addEventListener('keydown', e => {
      const lbOn = $('lightbox').classList.contains('is-on');
      if (lbOn && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { stepLightbox(e.key === 'ArrowLeft' ? -1 : 1); return; }
      if (e.key !== 'Escape') return;
      // Uma camada por Escape, da mais alta para a mais baixa.
      if (lbOn) { closeLightbox(); return; }
      if ($('mdConfirm').classList.contains('is-on')) { closeConfirm(false); return; }
      if ($('mdForm').classList.contains('is-on')) { closeForm(); return; }
      closeSide();
    });

    loadRecords();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
