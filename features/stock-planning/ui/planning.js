'use strict';
/* Stock Planning — front-end.
   Nenhum cálculo mora aqui: a projeção semanal vem pronta do servidor. O
   navegador só desenha e edita. É o que permite abrir 1.300 SKUs sem travar. */

const API = '/api/stock-planning';
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  view: 'overview',
  who: localStorage.getItem('sp.who') || '',
  projects: { q: '', status: 'ACTIVE', rep: '', only: '', sort: 'order_date', dir: 'desc', offset: 0, limit: 150 },
  supply:   { supplier: localStorage.getItem('sp.supplier') || '', q: '', weeks: 26, risk: false },
  pos:      { q: '', supplier: '', open: true },
  alerts:   { supplier: '' },
  weeks: [], reportingWeek: null, suppliers: [],
};

/* ── utilidades ─────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-sp-user': state.who || 'anon', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const n0 = (v) => (v == null || v === '' ? '' : Math.round(Number(v)).toLocaleString('en-AU'));
const n1 = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-AU', { maximumFractionDigits: 1 }));
const money = (v) => (v == null || v === '' ? '' : '$' + Number(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dmy = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${+d} ${MON[+m - 1]} ${y.slice(2)}`; };
const dm  = (iso) => { if (!iso) return ''; const [, m, d] = String(iso).slice(0, 10).split('-'); return `${+d} ${MON[+m - 1]}`; };

let toastT;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'sp-toast on' + (kind === 'err' ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.className = 'sp-toast'), kind === 'err' ? 5200 : 2400);
}
const debounce = (fn, ms = 260) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ── navegação ──────────────────────────────────────────────────────── */
function show(view) {
  state.view = view;
  $$('.sp-tab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $$('.sp-view').forEach((s) => s.classList.toggle('on', s.dataset.view === view));
  ({ overview: loadOverview, projects: loadProjects, supply: loadSupply, pos: loadPOs, alerts: loadAlerts }[view] || (() => {}))();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.sp-tab'); if (b) show(b.dataset.view); });
$('#who').addEventListener('input', (e) => { state.who = e.target.value.trim(); localStorage.setItem('sp.who', state.who); });

/* ── painel lateral ─────────────────────────────────────────────────── */
function side(title, html) {
  $('#sideTitle').textContent = title;
  $('#sideBody').innerHTML = html;
  $('#side').classList.add('on');
}
$('#sideClose').addEventListener('click', () => $('#side').classList.remove('on'));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  $('#side').classList.remove('on');
  $$('.sp-modal.on').forEach((m) => m.classList.remove('on'));
});
$$('.sp-modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('on');
}));

/* ── boot ───────────────────────────────────────────────────────────── */
(async function boot() {
  $('#who').value = state.who;
  try {
    const [st, sup] = await Promise.all([api('/state'), api('/suppliers')]);
    state.reportingWeek = st.reporting_week;
    state.suppliers = sup;
    $('#repWeek').textContent = dmy(st.reporting_week);
    $('#tabProjects').textContent = n0(st.counts.active_lines);
    $('#tabPos').textContent = n0(st.counts.open_po_lines);
    for (const [sel, blank] of [['#spSupplier', null], ['#poSupplier', 'Todos os fornecedores'],
                                ['#alSupplier', 'Todos os fornecedores'], ['#npoSupplier', '—']]) {
      const el = $(sel);
      el.innerHTML = (blank ? `<option value="">${blank}</option>` : '<option value="">Escolha um fornecedor…</option>')
        + sup.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} (${s.sku_count})</option>`).join('');
    }
    if (state.supply.supplier) $('#spSupplier').value = state.supply.supplier;
    const f = await api('/filters');
    $('#pjRep').innerHTML = '<option value="">Todos os reps</option>'
      + f.reps.map((r) => `<option>${esc(r)}</option>`).join('');
    window.__spState = st;
    loadOverview();
  } catch (e) { toast('Não consegui carregar: ' + e.message, 'err'); }
})();

/* ══ OVERVIEW ═══════════════════════════════════════════════════════ */
async function loadOverview() {
  const st = window.__spState || (window.__spState = await api('/state'));
  const c = st.counts;
  $('#ovCards').innerHTML = [
    ['Projetos ativos', n0(c.active_projects), `${n0(c.active_lines)} linhas abertas`, ''],
    ['Draws em aberto', n0(c.open_draws), 'parcelas planejadas', ''],
    ['Sem pick date', n0(c.tba_draws), 'demanda conhecida, data a combinar — visível, nunca somada a uma semana', 'warn'],
    ['Linhas de PO abertas', n0(c.open_po_lines), 'alimentam a entrada de estoque pelo due date', ''],
    ['SKUs no planejamento', n0(c.planning_skus), 'a lista curada que o Analysis mantinha', ''],
    ['Estoque de', dmy(c.stock_as_of) || '—', 'último snapshot carregado', ''],
  ].map(([t, v, s, k]) => `<div class="sp-card ${k}"><b>${v}</b><small><b style="display:inline;font-size:12px;color:var(--sp-ink)">${t}</b><br>${s}</small></div>`).join('');

  $('#ovSuppliers').innerHTML = `
    <thead><tr><th>Fornecedor</th><th class="num">SKUs</th><th class="num">Abaixo de 1 mês</th><th class="num">Sem estoque</th><th></th></tr></thead>
    <tbody>${state.suppliers.map((s) => `
      <tr data-sup="${esc(s.code)}" style="cursor:pointer">
        <td class="strong">${esc(s.code)}</td>
        <td class="num mono">${n0(s.sku_count)}</td>
        <td class="num mono" style="${s.under_one_month ? 'color:var(--sp-warn);font-weight:700' : ''}">${n0(s.under_one_month)}</td>
        <td class="num mono" style="${s.out_of_stock ? 'color:var(--sp-crit);font-weight:700' : ''}">${n0(s.out_of_stock)}</td>
        <td style="color:var(--sp-muted)">abrir →</td>
      </tr>`).join('')}</tbody>`;
  $('#ovSuppliers').onclick = (e) => {
    const tr = e.target.closest('tr[data-sup]');
    if (!tr) return;
    state.supply.supplier = tr.dataset.sup;
    $('#spSupplier').value = tr.dataset.sup;
    show('supply');
  };
}

/* ══ PROJECTS ═══════════════════════════════════════════════════════ */
const PJ_COLS = [
  ['order_date','DATE','fz1',       (r) => dmy(r.order_date)],
  ['sales_order','SALES ORDER','fz2',(r) => `<span class="strong mono">${esc(r.sales_order)}</span>`],
  ['customer','CUSTOMER','fz3 clip',(r) => esc(r.customer)],
  ['reference','REFERENCE','clip',  (r) => esc(r.reference)],
  ['rep','REP','',                  (r) => esc(r.rep)],
  ['sku','SKU','',                  (r) => `<span class="mono strong">${esc(r.sku)}</span>`],
  ['qty','QTY','num',               (r) => n0(r.qty)],
  ['type','TYPE','clip',            (r) => cell(r, 'type', esc(r.type))],
  ['unit_price','UNIT PRICE','num', (r) => money(r.unit_price)],
  ['qty_to_pick','QTY to Pick','num',(r) => `<b>${n0(r.qty_to_pick)}</b>`],
  ['po_ref','PO','',                (r) => cell(r, 'po_ref', esc(r.po_ref))],
  ['pick','PICK DATE','',           (r) => drawsCell(r)],
  ['qty_held','QTY HELD','num',     (r) => cell(r, 'qty_held', n0(r.qty_held), 'num')],
  ['date_packed','Date packed','',  (r) => cell(r, 'date_packed', dmy(r.date_packed), 'date')],
  ['days_held','Days held','num',   (r) => (r.days_held > 0 ? `<span style="${r.days_held > 60 ? 'color:var(--sp-crit);font-weight:700' : ''}">${n0(r.days_held)}</span>` : '')],
  ['qty_inv','QTY INV','num',       (r) => cell(r, 'qty_inv', n0(r.qty_inv), 'num')],
  ['required_text','REQUIRED','clip',(r) => cell(r, 'required_text', esc(r.required_text))],
  ['warehouse_note','WAREHOUSE','clip',(r) => esc(r.warehouse_note)],
];

const cell = (r, field, html, kind = 'text') =>
  `<span class="sp-cell${html ? '' : ' empty'}" contenteditable="plaintext-only" spellcheck="false"
         data-line="${r.id}" data-field="${field}" data-kind="${kind}">${html || ''}</span>`;

function drawsCell(r) {
  if (!r.draw_count) {
    // Linha já faturada não tem saldo para planejar — ausência de draw ali é o
    // esperado, não um problema. Só alarma quando ainda há o que separar.
    return Number(r.qty_to_pick) > 0
      ? `<span class="sp-tag t-tba" data-draws="${r.id}">sem draw</span>`
      : `<span style="color:var(--sp-line);cursor:pointer" data-draws="${r.id}">—</span>`;
  }
  if (r.draw_count === 1) {
    const d = r.draws[0];
    return d && d.planned_date
      ? `<span data-draws="${r.id}" style="cursor:pointer">${dmy(d.planned_date)}</span>`
      : `<span class="sp-tag t-tba" data-draws="${r.id}">TBA</span>`;
  }
  return `<span class="sp-tag t-draws" data-draws="${r.id}">${r.draw_count} draws</span>`
    + (r.over_planned ? ' <span class="sp-tag t-over">&gt; linha</span>' : '');
}

let pjRows = [];
async function loadProjects() {
  const p = state.projects;
  const qs = new URLSearchParams({ status: p.status, limit: p.limit, offset: p.offset, sort: p.sort, dir: p.dir });
  if (p.q) qs.set('q', p.q);
  if (p.rep) qs.set('rep', p.rep);
  if (p.only) qs.set('only', p.only);
  $('#pjCount').textContent = 'carregando…';
  try {
    const data = await api('/lines?' + qs);
    pjRows = data.rows;
    $('#pjCount').textContent = `${n0(data.rows.length)} de ${n0(data.total)} linhas`;
    $('#pjGrid').innerHTML = `
      <thead><tr>${PJ_COLS.map(([k, label, cls]) =>
        `<th class="${cls} sortable" data-sort="${k}">${label}${p.sort === k ? (p.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('')}
        <th></th></tr></thead>
      <tbody>${data.rows.map(pjRow).join('')}</tbody>`;
  } catch (e) { $('#pjCount').textContent = ''; toast(e.message, 'err'); }
}

const pjRow = (r) => `<tr data-row="${r.id}">${PJ_COLS.map(([k, , cls, fn]) =>
  `<td class="${cls}"${cls === 'clip' && r[k] ? ` title="${esc(r[k])}"` : ''}>${fn(r) || ''}</td>`).join('')}
  <td><button class="sp-btn ghost" data-project="${r.project_id}" title="Abrir o projeto">↗</button></td></tr>`;

$('#pjSearch').addEventListener('input', debounce((e) => { state.projects.q = e.target.value; state.projects.offset = 0; loadProjects(); }));
$('#pjStatus').addEventListener('change', (e) => { state.projects.status = e.target.value; state.projects.offset = 0; loadProjects(); });
$('#pjRep').addEventListener('change', (e) => { state.projects.rep = e.target.value; state.projects.offset = 0; loadProjects(); });
$$('.sp-view[data-view=projects] .sp-chip').forEach((c) => c.addEventListener('click', () => {
  const on = state.projects.only === c.dataset.only;
  state.projects.only = on ? '' : c.dataset.only;
  $$('.sp-view[data-view=projects] .sp-chip').forEach((x) => x.classList.toggle('on', !on && x === c));
  state.projects.offset = 0; loadProjects();
}));
$('#pjGrid').addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    state.projects.dir = state.projects.sort === k && state.projects.dir === 'desc' ? 'asc' : 'desc';
    state.projects.sort = k;
    return loadProjects();
  }
  const dz = e.target.closest('[data-draws]');
  if (dz) return toggleDraws(+dz.dataset.draws);
  const pb = e.target.closest('[data-project]');
  if (pb) return openProject(+pb.dataset.project);
});

/* ── edição inline ──────────────────────────────────────────────────── */
const original = new WeakMap();
document.addEventListener('focusin', (e) => {
  const c = e.target.closest('.sp-cell');
  if (c) original.set(c, c.textContent);
});
document.addEventListener('keydown', (e) => {
  const c = e.target.closest('.sp-cell');
  if (!c) return;
  if (e.key === 'Enter') { e.preventDefault(); c.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); c.textContent = original.get(c) || ''; c.dataset.skip = '1'; c.blur(); }
  else if (e.key === 'Tab') {
    const cells = $$('.sp-cell', c.closest('tbody') || document);
    const i = cells.indexOf(c) + (e.shiftKey ? -1 : 1);
    if (cells[i]) { e.preventDefault(); c.blur(); cells[i].focus(); }
  }
});
document.addEventListener('focusout', async (e) => {
  const c = e.target.closest('.sp-cell');
  if (!c) return;
  if (c.dataset.skip) { delete c.dataset.skip; return; }
  const before = original.get(c);
  const now = c.textContent.trim();
  if (before === undefined || now === before.trim()) return;

  const field = c.dataset.field;
  let value = now;
  if (c.dataset.kind === 'num') value = now === '' ? 0 : Number(now.replace(/[^0-9.-]/g, ''));
  if (c.dataset.kind === 'date') value = parseDate(now);
  if (c.dataset.kind === 'num' && isNaN(value)) { c.classList.add('err'); toast('Número inválido', 'err'); return; }
  if (c.dataset.kind === 'date' && now && !value) { c.classList.add('err'); toast('Data inválida — use 30/08/2026 ou 2026-08-30', 'err'); return; }

  c.classList.add('saving');
  try {
    const target = c.dataset.line ? `/lines/${c.dataset.line}`
                 : c.dataset.po   ? `/po-lines/${c.dataset.po}`
                 : `/skus/${encodeURIComponent(c.dataset.sku)}`;
    const updated = await api(target, { method: 'PATCH', body: JSON.stringify({ [field]: value }) });
    c.classList.replace('saving', 'saved');
    setTimeout(() => c.classList.remove('saved'), 1100);
    original.set(c, c.textContent);
    if (c.dataset.line) refreshLineRow(+c.dataset.line, updated);
  } catch (err) {
    c.classList.replace('saving', 'err');
    c.textContent = before;
    toast('Não gravou: ' + err.message, 'err');
    setTimeout(() => c.classList.remove('err'), 2600);
  }
});

function parseDate(s) {
  s = (s || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/);          // 30/08/2026
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-]?(\d{2,4})?$/);     // 30 Aug 26
  if (m) {
    const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mi < 0) return null;
    const y = !m[3] ? String(new Date().getFullYear()) : (m[3].length === 2 ? '20' + m[3] : m[3]);
    return `${y}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function refreshLineRow(id, updated) {
  const i = pjRows.findIndex((r) => r.id === id);
  if (i < 0) return;
  pjRows[i] = { ...pjRows[i], ...updated, draws: pjRows[i].draws };
  const tr = $(`tr[data-row="${id}"]`);
  if (!tr) return;
  const tds = tr.children;
  PJ_COLS.forEach(([k], ci) => {
    if (['qty_to_pick', 'days_held', 'pick'].includes(k)) tds[ci].innerHTML = PJ_COLS[ci][3](pjRows[i]) || '';
  });
}

/* ── draws ──────────────────────────────────────────────────────────── */
function toggleDraws(lineId) {
  const open = $(`tr.sp-draws[data-for="${lineId}"]`);
  if (open) return open.remove();
  $$('tr.sp-draws').forEach((t) => t.remove());
  const row = pjRows.find((r) => r.id === lineId);
  const tr = $(`tr[data-row="${lineId}"]`);
  if (!row || !tr) return;
  const el = document.createElement('tr');
  el.className = 'sp-draws';
  el.dataset.for = lineId;
  el.innerHTML = `<td colspan="${PJ_COLS.length + 1}">${drawEditor(row)}</td>`;
  tr.after(el);
}

function drawEditor(row) {
  const planned = (row.draws || []).reduce((s, d) => s + Number(d.qty), 0);
  const diff = Number(row.qty_to_pick) - planned;
  return `<div class="sp-drawlist">
    <span style="color:var(--sp-muted)">Saldo a separar <b style="color:var(--sp-ink)">${n0(row.qty_to_pick)}</b> ·
      planejado <b style="color:var(--sp-ink)">${n0(planned)}</b>
      ${diff > 0 ? `<span class="sp-tag t-tba">faltam ${n0(diff)}</span>`
        : diff < 0 ? `<span class="sp-tag t-over">${n0(-diff)} a mais</span>`
        : '<span class="sp-tag t-ok">fecha</span>'}</span>
    ${(row.draws || []).map((d) => `
      <span class="sp-draw" data-draw="${d.id}">
        <span class="q">${n0(d.qty)}</span>
        <span class="d ${d.planned_date ? '' : 'tba'}">${d.planned_date ? dmy(d.planned_date) : 'TBA'}</span>
        ${d.note ? `<span class="d" title="${esc(d.note)}">✎</span>` : ''}
        <button data-act="edit" title="Alterar quantidade e data">✎</button>
        <button data-act="split" title="Split Draw — dividir em duas parcelas">⇄</button>
        <button data-act="del" class="del" title="Remover">✕</button>
      </span>`).join('')}
    <button class="sp-btn" data-act="add" data-line="${row.id}">+ draw</button>
  </div>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const drawEl = btn.closest('[data-draw]');
  const lineId = Number(btn.dataset.line || btn.closest('tr.sp-draws')?.dataset.for);
  const row = pjRows.find((r) => r.id === lineId);
  try {
    if (act === 'add') {
      const planned = (row.draws || []).reduce((s, d) => s + Number(d.qty), 0);
      const qty = prompt('Quantidade do draw:', String(Math.max(Number(row.qty_to_pick) - planned, 0) || ''));
      if (qty === null) return;
      const when = prompt('Data planejada — deixe em branco para TBA:', '');
      if (when === null) return;
      const created = await api(`/lines/${lineId}/draws`, {
        method: 'POST', body: JSON.stringify({ qty: Number(qty), planned_date: parseDate(when) }) });
      row.draws.push(created); row.draw_count = row.draws.length;
      redraw(lineId); toast('Draw criado');
    } else if (act === 'del') {
      const id = +drawEl.dataset.draw;
      if (!confirm('Remover este draw?')) return;
      await api(`/draws/${id}`, { method: 'DELETE' });
      row.draws = row.draws.filter((d) => d.id !== id); row.draw_count = row.draws.length;
      redraw(lineId); toast('Draw removido');
    } else if (act === 'edit') {
      const id = +drawEl.dataset.draw;
      const d = row.draws.find((x) => x.id === id);
      const qty = prompt('Quantidade:', String(d.qty));
      if (qty === null) return;
      const when = prompt('Data planejada — em branco para TBA:', d.planned_date || '');
      if (when === null) return;
      const upd = await api(`/draws/${id}`, {
        method: 'PATCH', body: JSON.stringify({ qty: Number(qty), planned_date: parseDate(when) }) });
      Object.assign(d, upd);
      redraw(lineId); toast('Draw atualizado');
    } else if (act === 'split') {
      const id = +drawEl.dataset.draw;
      const d = row.draws.find((x) => x.id === id);
      const qty = prompt(`Split Draw — quanto sai numa data diferente? (de ${n0(d.qty)})`, String(Math.floor(d.qty / 2)));
      if (qty === null) return;
      const when = prompt('Data da parcela separada — em branco para TBA:', '');
      if (when === null) return;
      const out = await api(`/draws/${id}/split`, {
        method: 'POST', body: JSON.stringify({ qty: Number(qty), planned_date: parseDate(when) }) });
      d.qty = Number(d.qty) - Number(qty);
      row.draws.push(out.created); row.draw_count = row.draws.length;
      redraw(lineId); toast('Draw dividido');
    }
  } catch (err) { toast(err.message, 'err'); }
});

function redraw(lineId) {
  const row = pjRows.find((r) => r.id === lineId);
  const holder = $(`tr.sp-draws[data-for="${lineId}"] td`);
  if (holder) holder.innerHTML = drawEditor(row);
  const tr = $(`tr[data-row="${lineId}"]`);
  if (tr) {
    const i = PJ_COLS.findIndex(([k]) => k === 'pick');
    tr.children[i].innerHTML = drawsCell(row);
  }
}

/* ── projeto: detalhe e conclusão ───────────────────────────────────── */
async function openProject(id) {
  if (!id) return;
  try {
    const { project, lines } = await api(`/projects/${id}`);
    const done = project.status === 'COMPLETED';
    side(`${project.sales_order} · ${project.customer || ''}`, `
      <table class="sp-break">
        <tr><td>Referência</td><td>${esc(project.reference) || '—'}</td></tr>
        <tr><td>Rep</td><td>${esc(project.rep) || '—'}</td></tr>
        <tr><td>Data do pedido</td><td>${dmy(project.order_date) || '—'}</td></tr>
        <tr><td>Status</td><td>${project.status}${project.finish_date ? ' · ' + dmy(project.finish_date) : ''}</td></tr>
        <tr><td>Origem</td><td>${project.source}</td></tr>
        <tr><td>Armazém</td><td>${esc(project.warehouse_note) || '—'}</td></tr>
        <tr class="total"><td>Linhas</td><td>${lines.length}</td></tr>
      </table>
      <div style="display:flex;gap:8px;margin:14px 0">
        <button class="sp-btn ${done ? '' : 'primary'}" id="pjToggle" data-id="${id}" data-to="${done ? 'ACTIVE' : 'COMPLETED'}">
          ${done ? 'Reativar projeto' : 'Concluir projeto'}</button>
        <button class="sp-btn" id="pjAudit" data-id="${id}">Histórico</button>
      </div>
      <h4>Linhas</h4>
      <table class="sp-break">${lines.map((l) => `
        <tr><td><span class="mono">${esc(l.sku)}</span></td>
            <td>${n0(l.qty)} · saldo ${n0(l.qty_to_pick)}${l.draw_count > 1 ? ` · ${l.draw_count} draws` : ''}</td></tr>`).join('')}
      </table>`);
    $('#pjToggle').onclick = async (ev) => {
      const b = ev.currentTarget;
      try {
        await api(`/projects/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.to }) });
        toast(b.dataset.to === 'COMPLETED' ? 'Projeto concluído — nenhuma linha foi movida' : 'Projeto reativado');
        $('#side').classList.remove('on');
        loadProjects();
      } catch (err) { toast(err.message, 'err'); }
    };
    $('#pjAudit').onclick = () => openAudit('projects', id);
  } catch (e) { toast(e.message, 'err'); }
}

async function openAudit(table, id) {
  const rows = await api(`/audit?table=${table}&record=${id}&limit=60`);
  side('Histórico', rows.length ? `<table class="sp-break">${rows.map((r) => `
      <tr><td>${esc(r.user_email || 'sistema')}<br><span style="color:var(--sp-muted);font-size:11px">${new Date(r.changed_at).toLocaleString('en-AU')}</span></td>
          <td>${r.action}</td></tr>`).join('')}</table>`
    : '<p style="color:var(--sp-muted)">Sem alterações registradas ainda.</p>');
}

/* ══ SUPPLY PLANNING ════════════════════════════════════════════════ */
async function loadSupply() {
  const s = state.supply;
  if (!s.supplier) {
    $('#spGrid').innerHTML = '<tbody><tr><td class="sp-empty">Escolha um fornecedor para carregar a projeção.<br>É o mesmo recorte das 22 abas — e é o que mantém a tela rápida.</td></tr></tbody>';
    $('#spCount').textContent = '';
    return;
  }
  const qs = new URLSearchParams({ supplier: s.supplier, weeks: s.weeks, limit: 300 });
  if (s.q) qs.set('q', s.q);
  if (s.risk) qs.set('only', 'risk');
  $('#spCount').textContent = 'calculando…';
  try {
    const data = await api('/planning?' + qs);
    state.weeks = data.weeks;
    $('#spCount').textContent = `${n0(data.rows.length)} de ${n0(data.total)} SKUs · ${data.ms} ms`;
    const head = `<thead><tr>
      <th class="fz fz1">SKU</th><th class="fz fz2" style="left:96px;width:96px">SOH</th>
      <th class="num">Wk/Avg</th><th class="num">Mths</th><th class="num">TBA</th><th class="num">Incoming</th>
      <th class="num">Meta</th>
      ${data.weeks.map((w, i) => `<th class="wk ${i === 0 ? 'rep' : ''} ${Number(w.factor) !== 1 ? 'cny' : ''}"
          title="${w.factor_reason || ''}">${w.label}<small>${i === 0 ? 'reporte' : Number(w.factor) !== 1 ? Math.round(w.factor * 100) + '%' : '&nbsp;'}</small></th>`).join('')}
    </tr></thead>`;
    $('#spGrid').innerHTML = head + `<tbody>${data.rows.map(spRow).join('')}</tbody>`;
  } catch (e) { $('#spCount').textContent = ''; toast(e.message, 'err'); }
}

function spRow(r) {
  const m = r.summary;
  const cellData = r.cells.map((c) => c.o).join(',');
  return `<tr data-sku="${esc(r.sku_key)}" data-openings="${cellData}">
    <td class="fz fz1 mono strong" style="width:96px;overflow:hidden;text-overflow:ellipsis" title="${esc(r.sku)}">${esc(r.sku)}</td>
    <td class="fz num mono" style="left:96px;width:96px;box-shadow:1px 0 0 var(--sp-line);${r.soh <= 0 ? 'color:var(--sp-crit);font-weight:700' : ''}">${n0(r.soh)}</td>
    <td class="num">${cellSku(r, 'wk_avg', n1(r.wk_avg))}</td>
    <td class="num mono" style="${m.mthsStock != null && m.mthsStock < 1 ? 'color:var(--sp-crit);font-weight:700' : ''}">${m.mthsStock == null ? '—' : n1(m.mthsStock)}</td>
    <td class="num mono" style="${m.undatedQty ? 'color:var(--sp-warn);font-weight:600' : 'color:var(--sp-line)'}">${m.undatedQty ? n0(m.undatedQty) : '—'}</td>
    <td class="num mono">${m.totalIncoming ? n0(m.totalIncoming) : ''}</td>
    <td class="num">${cellSku(r, 'target_cover_weeks', r.target_cover_weeks)}</td>
    ${r.cells.map((c, i) => `<td class="wk ${c.neg ? 'neg' : c.low ? 'low' : ''} ${c.i ? 'has-in' : ''} ${c.d ? 'has-draw' : ''}"
        data-week="${c.w}" title="${i === 0 ? 'Semana de reporte: fechamento é o SOH real' : `abre ${n0(c.o)} · entra ${n0(c.i)} · vende ${n1(c.s)} · projeto ${n0(c.d)}`}">${n0(c.c)}</td>`).join('')}
  </tr>`;
}

const cellSku = (r, field, html) =>
  `<span class="sp-cell" contenteditable="plaintext-only" spellcheck="false"
         data-sku="${esc(r.sku_key)}" data-field="${field}" data-kind="num">${html == null ? '' : html}</span>`;

$('#spSupplier').addEventListener('change', (e) => {
  state.supply.supplier = e.target.value;
  localStorage.setItem('sp.supplier', e.target.value);
  loadSupply();
});
$('#spSearch').addEventListener('input', debounce((e) => { state.supply.q = e.target.value; loadSupply(); }));
$('#spWeeks').addEventListener('change', (e) => { state.supply.weeks = +e.target.value; loadSupply(); });
$('#spRisk').addEventListener('click', (e) => {
  state.supply.risk = !state.supply.risk;
  e.currentTarget.classList.toggle('on', state.supply.risk);
  loadSupply();
});
$('#spGrid').addEventListener('click', (e) => {
  const td = e.target.closest('td.wk');
  if (!td) return;
  openWeek(td.closest('tr').dataset.sku, td.dataset.week);
});

/* O drill-down. Se o planejador não consegue explicar o número, a tela falhou. */
async function openWeek(sku, week) {
  try {
    const d = await api(`/planning/${encodeURIComponent(sku)}/week/${week}`);
    const tr = $(`tr[data-sku="${CSS.escape(sku)}"]`);
    const cells = tr ? [...tr.querySelectorAll('td.wk')] : [];
    const cell = cells.find((c) => c.dataset.week === week);
    const idx = cells.indexOf(cell);
    const openings = tr && tr.dataset.openings ? tr.dataset.openings.split(',') : [];
    const opening = idx >= 0 && openings[idx] != null ? Number(openings[idx]) : null;
    const inQty = d.incoming.reduce((s, x) => s + Number(x.qty), 0);
    const drawQty = d.draws.reduce((s, x) => s + Number(x.qty), 0);
    const closing = cell ? Number(cell.textContent.replace(/,/g, '')) : null;

    side(`${sku} · semana de ${dmy(week)}`, `
      <table class="sp-break">
        ${opening != null ? `<tr><td>Opening</td><td>${n0(opening)}</td></tr>` : ''}
        <tr class="head"><td>Incoming</td><td>${inQty ? '+' + n0(inQty) : '—'}</td></tr>
        ${d.incoming.map((x) => `<tr class="sub"><td>${esc(x.po_number)}${x.vessel ? ` · ${esc(x.vessel)}` : ''}</td><td>+${n0(x.qty)}</td></tr>`).join('')}
        <tr class="head"><td>Expected sales</td><td>−${n1(d.expected_sales)}</td></tr>
        <tr class="sub"><td>Wk/Avg ${n1(d.sku ? d.sku.wk_avg : 0)} × ${Math.round(d.factor * 100)}%${d.factor_reason ? ` · ${esc(d.factor_reason)}` : ''}</td><td></td></tr>
        <tr class="head"><td>Project draws</td><td>${drawQty ? '−' + n0(drawQty) : '—'}</td></tr>
        ${d.draws.map((x) => `<tr class="sub"><td>${esc(x.sales_order)} · ${esc(x.customer || '')}${x.seq > 1 ? ` (draw ${x.seq})` : ''}</td><td>−${n0(x.qty)}</td></tr>`).join('')}
        ${closing != null ? `<tr class="total"><td>Closing</td><td>${n0(closing)}</td></tr>` : ''}
      </table>
      ${d.sku && d.sku.undated_qty > 0 ? `<h4>Fora de qualquer semana</h4>
        <p style="color:var(--sp-warn)"><b>${n0(d.sku.undated_qty)}</b> unidades de demanda de projeto sem pick date.
        Ficam visíveis na coluna TBA e nunca entram num bucket inventado.</p>` : ''}
      <h4>Contexto de estoque</h4>
      <table class="sp-break">
        <tr><td>Empresa (base do cálculo)</td><td>${n0(d.sku ? d.sku.soh_available : 0)}</td></tr>
        <tr><td>Main</td><td>${n0(d.sku ? d.sku.main_soh : 0)}</td></tr>
        <tr><td>Gateway</td><td>${n0(d.sku ? d.sku.gateway_soh : 0)}</td></tr>
        <tr><td>Compromisso de projeto</td><td>${n0(d.sku ? d.sku.project_orders : 0)}</td></tr>
      </table>`);
  } catch (e) { toast(e.message, 'err'); }
}

/* ══ PURCHASE ORDERS ════════════════════════════════════════════════ */
async function loadPOs() {
  const p = state.pos;
  const qs = new URLSearchParams({ limit: 400 });
  if (p.q) qs.set('q', p.q);
  if (p.supplier) qs.set('supplier', p.supplier);
  if (p.open) qs.set('only', 'open');
  try {
    const rows = await api('/pos?' + qs);
    $('#poCount').textContent = `${n0(rows.length)} linhas`;
    $('#poGrid').innerHTML = `
      <thead><tr><th class="fz fz1">PO #</th><th>Data</th><th>Fornecedor</th><th>SKU</th>
        <th class="num">QTY</th><th>Finish</th><th>Checked</th><th>Due Date</th><th>Navio</th>
        <th class="num">Custo USD</th><th class="num">FX</th><th class="num">Valor AUD</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="fz fz1 mono strong">${esc(r.po_number)}</td>
        <td>${dmy(r.po_date)}</td>
        <td>${esc(r.supplier_code) || '<span style="color:var(--sp-crit)">?</span>'}</td>
        <td class="mono">${esc(r.sku)}</td>
        <td class="num">${cellPo(r, 'qty', n0(r.qty), 'num')}</td>
        <td>${dmy(r.finish_date) || esc(r.require_status) || ''}</td>
        <td>${dmy(r.date_checked)}</td>
        <td>${cellPo(r, 'due_date', dmy(r.due_date), 'date')}</td>
        <td>${cellPo(r, 'vessel', esc(r.vessel))}</td>
        <td class="num mono">${r.unit_cost_usd == null ? '' : money(r.unit_cost_usd)}</td>
        <td class="num mono" style="color:var(--sp-muted)">${r.fx_used || ''}</td>
        <td class="num mono">${r.value_aud == null ? '' : money(r.value_aud)}</td></tr>`).join('')}</tbody>`;
  } catch (e) { toast(e.message, 'err'); }
}
const cellPo = (r, field, html, kind = 'text') =>
  `<span class="sp-cell${html ? '' : ' empty'}" contenteditable="plaintext-only" spellcheck="false"
         data-po="${r.id}" data-field="${field}" data-kind="${kind}">${html || ''}</span>`;

$('#poSearch').addEventListener('input', debounce((e) => { state.pos.q = e.target.value; loadPOs(); }));
$('#poSupplier').addEventListener('change', (e) => { state.pos.supplier = e.target.value; loadPOs(); });
$('#poOpen').addEventListener('click', (e) => { state.pos.open = !state.pos.open; e.currentTarget.classList.toggle('on', state.pos.open); loadPOs(); });

/* ══ ALERTS ═════════════════════════════════════════════════════════ */
async function loadAlerts() {
  const qs = new URLSearchParams({ limit: 400 });
  if (state.alerts.supplier) qs.set('supplier', state.alerts.supplier);
  $('#alBody').innerHTML = '<div class="sp-empty">Calculando…</div>';
  try {
    const d = await api('/alerts?' + qs);
    $('#tabAlerts').textContent = n0(d.total);
    $('#alCount').textContent = `${n0(d.total)} exceções`;
    const cards = Object.entries(d.byCode).sort((a, b) => b[1] - a[1]).map(([code, n]) =>
      `<div class="sp-card ${code === 'PROJECTED_STOCKOUT' || code === 'SOH_NON_POSITIVE' ? 'crit' : ''}">
         <b>${n0(n)}</b><small>${esc(ALERT_LABELS[code] || code)}</small></div>`).join('');
    $('#alBody').innerHTML = `<div class="sp-cards">${cards}</div>
      <div style="border:1px solid var(--sp-line);border-radius:9px;overflow:hidden">
        ${d.alerts.map((a) => `<div class="sp-alert">
          <span class="sev sev-${a.severity}">${a.severity}</span>
          <span class="k" data-sku="${esc(a.sku)}" data-sup="${esc(a.supplier || '')}">${esc(a.sku)}</span>
          <span class="m">${esc(a.message)}</span></div>`).join('') || '<div class="sp-empty">Nenhuma exceção.</div>'}
      </div>`;
    $('#alBody').onclick = (e) => {
      const k = e.target.closest('.k');
      if (!k) return;
      state.supply.supplier = k.dataset.sup;
      state.supply.q = k.dataset.sku;
      $('#spSupplier').value = k.dataset.sup;
      $('#spSearch').value = k.dataset.sku;
      show('supply');
    };
  } catch (e) { $('#alBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}
const ALERT_LABELS = {
  PROJECTED_STOCKOUT: 'Projeção fica negativa',
  SOH_NON_POSITIVE: 'Estoque zerado ou negativo — invisível no Excel',
  BELOW_TARGET_COVER: 'Abaixo da meta de cobertura',
  BELOW_ONE_MONTH: 'Menos de 1 mês de cobertura',
  UNDATED_DEMAND: 'Demanda de projeto sem pick date',
  PO_AFTER_STOCKOUT: 'PO chega depois da ruptura',
  LARGE_DRAW: 'Draw fora do padrão do SKU',
  STALE_REPORTING_WEEK: 'Semana de reporte atrasada',
};
$('#alSupplier').addEventListener('change', (e) => { state.alerts.supplier = e.target.value; loadAlerts(); });

/* ══ IMPORTAR SALES ORDER ═══════════════════════════════════════════ */
let soPick = null;
$('#btnImportSO').addEventListener('click', () => {
  soPick = null;
  $('#soSearch').value = ''; $('#soResults').innerHTML = ''; $('#soPreview').innerHTML = '';
  $('#soImport').disabled = true;
  $('#mdImport').classList.add('on');
  setTimeout(() => $('#soSearch').focus(), 60);
});
$('#soSearch').addEventListener('input', debounce(async (e) => {
  const q = e.target.value.trim();
  if (q.length < 3) return ($('#soResults').innerHTML = '');
  try {
    const rows = await api('/find/orders?q=' + encodeURIComponent(q));
    $('#soResults').innerHTML = rows.length ? rows.map((r) => `
      <div class="sp-result" data-no="${esc(r.number)}" data-dup="${r.existing_project_id || ''}">
        <span class="m">${esc(r.number)}</span>
        <span class="g">${esc(r.customer || '')} · ${esc(r.reference || '')}</span>
        <span class="g" style="flex:0;text-align:right">${dmy(r.order_date)} · ${r.mirrored_lines} linhas</span>
        ${r.existing_project_id ? '<span class="dup">já importado</span>' : ''}
      </div>`).join('') : '<div class="sp-empty">Nada encontrado.</div>';
  } catch (err) { toast(err.message, 'err'); }
}));
$('#soResults').addEventListener('click', async (e) => {
  const row = e.target.closest('.sp-result');
  if (!row) return;
  $$('.sp-result', $('#soResults')).forEach((r) => r.classList.toggle('sel', r === row));
  soPick = row.dataset.no;
  const dup = row.dataset.dup;
  try {
    const lines = await api(`/find/orders/${encodeURIComponent(soPick)}/lines`);
    $('#soImport').disabled = !lines.length || !!dup;
    $('#soPreview').innerHTML = `<h4 style="margin:16px 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--sp-muted)">
        ${lines.length} linhas · confira antes de importar</h4>
      ${dup ? '<p class="sp-hint" style="color:var(--sp-warn)"><b>Este Sales Order já é um projeto.</b> Importar de novo criaria duplicata, então está bloqueado.</p>' : ''}
      <div class="sp-results" style="max-height:220px">${lines.map((l) => `
        <div class="sp-result"><span class="m">${esc(l.sku)}</span>
          <span class="g">${esc(l.product_name || '')}</span>
          <span class="g" style="flex:0">${n0(l.quantity)} × ${money(l.price)}</span>
          ${l.in_planning ? '' : '<span class="dup">fora do planejamento</span>'}</div>`).join('')}</div>
      <p class="sp-hint">Cada linha entra com um draw <b>sem data</b>. Inventar um pick date seria pior que TBA —
      metade da demanda real do workbook é legitimamente sem data.</p>`;
  } catch (err) { toast(err.message, 'err'); }
});
$('#soImport').addEventListener('click', async () => {
  if (!soPick) return;
  const btn = $('#soImport');
  btn.disabled = true; btn.textContent = 'Importando…';
  try {
    const out = await api('/projects/import-order', { method: 'POST', body: JSON.stringify({ sales_order: soPick }) });
    toast(`${soPick} importado — ${out.lines} linhas, sem redigitar nada`);
    $('#mdImport').classList.remove('on');
    state.projects.q = soPick.replace('SO-', '');
    $('#pjSearch').value = state.projects.q;
    show('projects');
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = 'Importar como projeto'; }
});

/* ══ NOVA PO ════════════════════════════════════════════════════════ */
$('#btnAddPO').addEventListener('click', () => {
  $('#npoNumber').value = ''; $('#npoLines').value = ''; $('#npoPreview').innerHTML = '';
  $('#npoDate').value = new Date().toISOString().slice(0, 10);
  $('#mdPO').classList.add('on');
  setTimeout(() => $('#npoNumber').focus(), 60);
});
function parsePoLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [sku, qty, cost, due] = l.split(/\t|;|,(?=\s*\S)/).map((x) => (x || '').trim());
    return { sku, qty: Number(String(qty || '').replace(/[^0-9.]/g, '')),
             unit_cost_usd: cost ? Number(String(cost).replace(/[^0-9.]/g, '')) : null,
             due_date: due || null };
  }).filter((l) => l.sku && l.qty > 0);
}
$('#npoLines').addEventListener('input', debounce(() => {
  const lines = parsePoLines($('#npoLines').value);
  const total = lines.reduce((s, l) => s + (l.unit_cost_usd || 0) * l.qty, 0);
  $('#npoPreview').innerHTML = lines.length
    ? `<p class="sp-hint"><b>${lines.length}</b> linhas reconhecidas · ${n0(lines.reduce((s, l) => s + l.qty, 0))} unidades${total ? ` · ${money(total)} USD` : ''}</p>`
    : '<p class="sp-hint">Nenhuma linha reconhecida ainda.</p>';
}, 200));
$('#npoSave').addEventListener('click', async () => {
  const lines = parsePoLines($('#npoLines').value);
  if (!$('#npoNumber').value.trim()) return toast('Informe o número da PO', 'err');
  if (!lines.length) return toast('Informe ao menos uma linha', 'err');
  try {
    const out = await api('/pos', { method: 'POST', body: JSON.stringify({
      po_number: $('#npoNumber').value.trim(), po_date: $('#npoDate').value,
      supplier_code: $('#npoSupplier').value || null, due_date: $('#npoDue').value || null,
      vessel: $('#npoVessel').value.trim() || null, lines }) });
    toast(`PO gravada — ${out.created} linhas já contam como estoque entrando`);
    $('#mdPO').classList.remove('on');
    loadPOs();
  } catch (e) { toast(e.message, 'err'); }
});
