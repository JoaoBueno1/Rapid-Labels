'use strict';
/* Projects — página própria.

   Saiu de dentro do Stock Planning porque é outra pergunta: lá se decide o
   que comprar, aqui se acompanha o que já foi vendido e está preso. Quem usa
   uma raramente usa a outra no mesmo minuto, e as duas juntas obrigavam a
   carregar 1.951 SKUs de projeção para ver uma linha de projeto.

   O que as duas telas compartilham está em sp-core.js. Aqui não há roteador
   de view: a página TEM uma view só, e `show()` não vem junto de propósito —
   copiá-lo traria a tabela de carregadores inteira, e uma chave apontando
   para uma função que não existe nesta página é ReferenceError antes de
   qualquer coisa aparecer.

   Elas continuam conversando: a coluna PO Ref leva para /purchase-orders com
   o número já filtrado, e de lá se volta pelos projetos que esperam a carga. */

const S = { projects: { q:'', status:'ACTIVE', rep:'', branch:'', only:'', offset:0, limit:400, col:{} } };

/* O editor de célula do sp-core.js grava e devolve a linha atualizada. O que
   fazer depois é de cada página: aqui, remendar a linha em memória e
   redesenhar, para o total do pedido acompanhar sem recarregar tudo. */
window.SP_ON_SAVED = (c, upd) => {
  if (!c.dataset.line) return;
  const i = pjRows.findIndex(r => r.id === +c.dataset.line);
  if (i >= 0) { pjRows[i] = { ...pjRows[i], ...upd, draws: pjRows[i].draws }; renderProjects(); }
};

/* ═══ PROJECTS ══════════════════════════════════════════════════════ */
/* A grade mostra o pedido UMA vez, como faixa, e as linhas de produto abaixo.
   Tira cinco colunas repetidas da grade e resolve o pedido do usuário de
   separar visualmente cada sales order — coisa que o Excel não faz (medido:
   dos 318 blocos de pedido, 158 têm mais de uma cor de linha dentro). */
const LN = [
  ['sku',          'SKU',          '',      160, r => `<span class="mono em">${esc(r.sku)}</span>`],
  ['qty',          'QTY',          'n',      58, r => n0(r.qty)],
  ['type',         'TYPE',         'clip',   80, r => cellEd(r,'type',esc(r.type))],
  ['unit_price',   'UNIT PRICE',   'n',      78, r => Number(r.unit_price) ? usd(r.unit_price) : ''],
  ['qty_to_pick',  'QTY to Pick',  'n',      74, r => Number(r.qty_to_pick) ? `<b>${n0(r.qty_to_pick)}</b>` : ''],
  ['po_ref',       'PO',           '',       82, r => cellEd(r,'po_ref',esc(r.po_ref))],
  ['pick',         'PICK DATE',    '',      118, r => drawCell(r)],
  ['qty_held',     'QTY HELD',     'n',      70, r => cellEd(r,'qty_held',nz0(r.qty_held),'num')],
  ['date_packed',  'Date packed',  '',       94, r => cellEd(r,'date_packed',d10(r.date_packed),'date')],
  ['days_held',    'Days held',    'n',      66, r => r.days_held>0 ? `<span${r.days_held>180?' style="color:#9c0006;font-weight:600"':''}>${n0(r.days_held)}</span>` : ''],
  ['qty_inv',      'QTY INV',      'n',      68, r => cellEd(r,'qty_inv',nz0(r.qty_inv),'num')],
  ['required_text','REQUIRED',     'clip',  210, r => cellEd(r,'required_text',esc(r.required_text))],
  ['warehouse_note','WAREHOUSE',   'clip',  130, r => esc(r.warehouse_note)],
];
const cellEd = (r, f, html, kind='text') =>
  `<span class="sp-cell${html?'':' void'}" contenteditable="plaintext-only" spellcheck="false"
     data-line="${r.id}" data-field="${f}" data-kind="${kind}">${html||''}</span>`;

/** Estado da linha, com as cores que o workbook usa. */
function lineState(r) {
  if (Number(r.qty_inv) >= Number(r.qty) && Number(r.qty) > 0) return 'st-closed';
  if (Number(r.qty_held) > 0 && r.date_packed) return 'st-held';
  return '';
}
function drawCell(r) {
  if (!r.draw_count) return Number(r.qty_to_pick) > 0
    ? `<button class="ui-act ui-act--warn" data-draws="${r.id}">plan it</button>`
    : `<span class="faint">—</span>`;
  if (r.draw_count === 1) {
    const d = r.draws[0];
    return d && d.planned_date
      ? `<button class="ui-act" data-draws="${r.id}">${d10(d.planned_date)}</button>`
      : `<button class="ui-act ui-act--warn" data-draws="${r.id}">TBA</button>`;
  }
  return `<button class="ui-act" data-draws="${r.id}">${r.draw_count} draws</button>`
       + (r.over_planned ? ' <span class="ui-tag ui-tag--danger">over</span>' : '');
}

let pjRows = [], pjOrders = [];
async function loadProjects() {
  const p = S.projects;
  const qs = new URLSearchParams({ status:p.status, limit:p.limit, offset:p.offset, sort:'order_date', dir:'desc' });
  if (p.q) qs.set('q', p.q);
  if (p.rep) qs.set('rep', p.rep);
  if (p.branch) qs.set('branch', p.branch);
  if (p.only) qs.set('only', p.only);
  $('#pjCount').textContent = 'loading…';
  try {
    const d = await api('/lines?' + qs);
    pjRows = d.rows;
    const by = new Map();
    for (const r of d.rows) {
      const k = r.project_id || r.sales_order;
      if (!by.has(k)) by.set(k, { key:k, id:r.project_id, so:r.sales_order, cu:r.customer, rf:r.reference,
                                  rp:r.rep, dt:r.order_date, wh:r.warehouse_note,
                                  br:r.branch_code, brs:r.branch_source, lines:[] });
      by.get(k).lines.push(r);
    }
    pjOrders = [...by.values()];
    $('#pjCount').textContent = `${n0(pjOrders.length)} orders · ${n0(d.rows.length)} of ${n0(d.total)} lines`;
    renderProjects();
  } catch (e) { $('#pjCount').textContent=''; toast(e.message, true); }
}

/* A filial e de onde ela veio, na mesma marca.
   "order" e fato: o pedido de venda diz. "rep" e inferencia pelo mapa
   rep->filial — 1.468 dos 1.667 vem por ai, e apaga-las na mesma cor do fato
   seria transformar palpite em dado. Contorno tracejado marca o inferido. */
const branchChip = (o) => {
  if (!o.br) return o.brs === 'ambiguous'
    ? `<span class="sep"></span><span class="pj-br is-amb" title="The rep's first name belongs to more than one person, in different branches — it cannot be decided from the name alone">branch?</span>`
    : '';
  const inferido = o.brs === 'rep';
  return `<span class="sep"></span><span class="pj-br${inferido ? ' is-inf' : ''}" title="${
    inferido ? `Inferred from the rep ${esc(o.rp || '')} — the sales order does not say which branch`
             : 'From the sales order itself'}">${esc(o.br)}${inferido ? '?' : ''}</span>`;
};

function renderProjects() {
  const showFlt = $('#pjFilters').classList.contains('is-on');
  const head = `<thead>
    <tr>${LN.map(([k,l,c,w])=>`<th class="${c==='n'?'n':''}" style="width:${w}px">${l}</th>`).join('')}</tr>
    <tr class="sp-filters${showFlt?'':' hide'}">${LN.map(([k])=>
      k==='pick' ? `<th><select data-f="${k}"><option value="">all</option><option value="dated">dated</option><option value="tba">TBA</option><option value="none">no draw</option></select></th>`
                 : `<th><input data-f="${k}" placeholder="filter" value="${esc(S.projects.col[k]||'')}"></th>`).join('')}</tr>
  </thead>`;
  const f = S.projects.col;
  const keep = r => LN.every(([k]) => {
    const v = (f[k]||'').trim().toLowerCase(); if (!v) return true;
    if (k === 'pick') {
      if (v==='dated') return r.draws && r.draws.some(d=>d.planned_date);
      if (v==='tba')   return r.draws && r.draws.some(d=>!d.planned_date);
      if (v==='none')  return !r.draw_count;
      return true;
    }
    return String(r[k] ?? '').toLowerCase().includes(v);
  });
  const bodies = pjOrders.map(o => {
    const lines = o.lines.filter(keep);
    if (!lines.length) return '';
    const qty = lines.reduce((s,r)=>s+Number(r.qty||0),0);
    const pick = lines.reduce((s,r)=>s+Number(r.qty_to_pick||0),0);
    return `<tbody data-order="${o.key}">
      <tr class="sp-ord${showFlt?' flt':''}"><td colspan="${LN.length}"><div class="sp-ord-in">
        <span class="so">${esc(o.so)}</span><span class="sep"></span>
        <span class="cu">${esc(o.cu||'')}</span>
        ${o.rf?`<span class="sep"></span><span class="rf" title="${esc(o.rf)}">${esc(o.rf)}</span>`:''}
        ${o.rp?`<span class="sep"></span><span class="rp">${esc(o.rp)}</span>`:''}
        ${branchChip(o)}
        <span class="sep"></span><span class="dt">${d10(o.dt)}</span>
        <span class="rt">
          <span class="mt">${lines.length} lines · ${n0(qty)} ordered · ${n0(pick)} to pick</span>
          ${o.id?`<button class="ui-act" data-project="${o.id}">Open</button>`:''}
        </span></div></td></tr>
      ${lines.map(r=>`<tr class="sp-ln ${lineState(r)}" data-row="${r.id}">
        ${LN.map(([k,l,c,w,fn])=>{
          const cls = [c==='n'?'n':'', c==='clip'?'clip':''].filter(Boolean).join(' ');
          const extra = k==='qty_inv' && Number(r.qty_inv)>=Number(r.qty) && Number(r.qty)>0 ? ' cf-inv'
                      : k==='qty_held' && Number(r.qty_held)>=Number(r.qty) && Number(r.qty)>0 ? ' cf-held' : '';
          const title = c==='clip' && r[k] ? ` title="${esc(r[k])}"` : '';
          return `<td class="${cls}${extra}" style="width:${w}px"${title}>${fn(r)||''}</td>`;
        }).join('')}</tr>`).join('')}
    </tbody>`;
  }).join('');
  $('#pjGrid').innerHTML = head + (bodies || `<tbody><tr><td colspan="${LN.length}"><div class="sp-empty">Nothing matches those filters.</div></td></tr></tbody>`);
}

on('#pjSearch', 'input', debounce(e => { S.projects.q = e.target.value; loadProjects(); }));
on('#pjStatus', 'change', e => { S.projects.status = e.target.value; loadProjects(); });
on('#pjRep', 'change', e => { S.projects.rep = e.target.value; loadProjects(); });
on('#pjBranch', 'change', e => { S.projects.branch = e.target.value; S.projects.offset = 0; loadProjects(); });
on('#pjFilters', 'click', e => { e.currentTarget.classList.toggle('is-on'); renderProjects(); });
$$('.sp-view[data-view=projects] .sp-chip').forEach(c => c.addEventListener('click', () => {
  const on = S.projects.only === c.dataset.only;
  S.projects.only = on ? '' : c.dataset.only;
  $$('.sp-view[data-view=projects] .sp-chip').forEach(x => x.classList.toggle('is-on', !on && x === c));
  loadProjects();
}));
on('#pjGrid', 'input', e => {
  const f = e.target.closest('[data-f]'); if (!f) return;
  S.projects.col[f.dataset.f] = f.value;
  clearTimeout(window.__fT); window.__fT = setTimeout(() => {
    const active = document.activeElement?.dataset?.f;
    renderProjects();
    if (active) { const el = $(`[data-f="${active}"]`); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
  }, 200);
});
on('#pjGrid', 'click', e => {
  const dz = e.target.closest('[data-draws]'); if (dz) return toggleDraws(+dz.dataset.draws);
  const pb = e.target.closest('[data-project]'); if (pb) return openProject(+pb.dataset.project);
});

/* ── draws: editor de verdade, não prompt() ─────────────────────────── */
function toggleDraws(lineId) {
  const open = $(`tr.sp-draw-row[data-for="${lineId}"]`);
  if (open) return open.remove();
  $$('tr.sp-draw-row').forEach(t => t.remove());
  const row = pjRows.find(r => r.id === lineId);
  const tr = $(`tr[data-row="${lineId}"]`);
  if (!row || !tr) return;
  const el = document.createElement('tr');
  el.className = 'sp-draw-row'; el.dataset.for = lineId;
  el.innerHTML = `<td colspan="${LN.length}">${drawEditor(row)}</td>`;
  tr.after(el);
  const first = el.querySelector('input.q'); if (first) first.focus();
}
function drawEditor(row) {
  const planned = (row.draws||[]).reduce((s,d)=>s+Number(d.qty),0);
  const left = Number(row.qty_to_pick) - planned;
  return `<div class="dw-head">
      <b>${esc(row.sku)}</b>
      <span>${n0(row.qty_to_pick)} to pick · ${n0(planned)} planned</span>
      ${left>0 ? `<span class="ui-tag ui-tag--warn">${n0(left)} unplanned</span>`
        : left<0 ? `<span class="ui-tag ui-tag--danger">${n0(-left)} over</span>`
        : '<span class="ui-tag ui-tag--ok">balanced</span>'}
    </div>
    <div class="dw-list">
      ${(row.draws||[]).map(d=>`<span class="dw ${d.planned_date?'':'tba'}" data-draw="${d.id}">
        <input class="q" value="${n0(d.qty)}" data-k="qty" title="Quantity">
        <input class="d" value="${d.planned_date?d10(d.planned_date):''}" data-k="planned_date"
               placeholder="dd/mm/yyyy — blank = TBA" title="Planned pick date">
        <button class="sp" data-act="split" title="Split this draw in two">&#8646;</button>
        <button class="x" data-act="del" title="Remove">&times;</button></span>`).join('')}
      <button class="dw-add" data-act="add" data-line="${row.id}">+ add draw${left>0?` (${n0(left)})`:''}</button>
    </div>
    <p class="dw-note">Leave the date blank for TBA — a made-up pick date is worse than none, and half the workbook's demand legitimately has no date. Changes save as you leave the field.</p>`;
}
document.addEventListener('change', async e => {
  const inp = e.target.closest('.dw input'); if (!inp) return;
  const wrap = inp.closest('[data-draw]'); const id = +wrap.dataset.draw;
  const lineId = +inp.closest('tr.sp-draw-row').dataset.for;
  const row = pjRows.find(r => r.id === lineId);
  const body = {};
  if (inp.dataset.k === 'qty') {
    const q = Number(String(inp.value).replace(/[^0-9.]/g,''));
    if (!(q > 0)) { toast('Quantity must be more than zero', true); return; }
    body.qty = q;
  } else {
    const v = inp.value.trim();
    if (v && !parseDate(v)) { toast('Use dd/mm/yyyy', true); return; }
    body.planned_date = v ? parseDate(v) : null;
  }
  try {
    const upd = await api(`/draws/${id}`, { method:'PATCH', body: JSON.stringify(body) });
    const d = row.draws.find(x => x.id === id); Object.assign(d, upd);
    redrawLine(lineId); toast('Draw updated');
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('click', async e => {
  const b = e.target.closest('.dw-list [data-act]'); if (!b) return;
  const act = b.dataset.act;
  const lineId = +b.closest('tr.sp-draw-row').dataset.for;
  const row = pjRows.find(r => r.id === lineId);
  const wrap = b.closest('[data-draw]');
  try {
    if (act === 'add') {
      const planned = (row.draws||[]).reduce((s,d)=>s+Number(d.qty),0);
      const qty = Math.max(Number(row.qty_to_pick) - planned, 1);
      const created = await api(`/lines/${lineId}/draws`, { method:'POST', body: JSON.stringify({ qty, planned_date:null }) });
      row.draws.push(created); row.draw_count = row.draws.length; redrawLine(lineId);
    } else if (act === 'del') {
      const id = +wrap.dataset.draw;
      await api(`/draws/${id}`, { method:'DELETE' });
      row.draws = row.draws.filter(d => d.id !== id); row.draw_count = row.draws.length; redrawLine(lineId);
    } else if (act === 'split') {
      const id = +wrap.dataset.draw;
      const d = row.draws.find(x => x.id === id);
      const half = Math.floor(Number(d.qty)/2);
      if (half < 1) return toast('Too small to split', true);
      const out = await api(`/draws/${id}/split`, { method:'POST', body: JSON.stringify({ qty:half, planned_date:null }) });
      d.qty = Number(d.qty) - half; row.draws.push(out.created); row.draw_count = row.draws.length;
      redrawLine(lineId); toast('Split — set the date on the new draw');
    }
  } catch (err) { toast(err.message, true); }
});
function redrawLine(lineId) {
  const row = pjRows.find(r => r.id === lineId);
  const holder = $(`tr.sp-draw-row[data-for="${lineId}"] td`);
  if (holder) holder.innerHTML = drawEditor(row);
  const tr = $(`tr[data-row="${lineId}"]`);
  if (tr) { const i = LN.findIndex(([k])=>k==='pick'); tr.children[i].innerHTML = drawCell(row); }
}

/* ── projeto ────────────────────────────────────────────────────────── */
async function openProject(id) {
  try {
    const { project, lines } = await api(`/projects/${id}`);
    const done = project.status === 'COMPLETED';
    side(`${project.sales_order} · ${project.customer||''}`, `
      <table class="brk">
        <tr><td>Reference</td><td>${esc(project.reference)||'—'}</td></tr>
        <tr><td>Rep</td><td>${esc(project.rep)||'—'}</td></tr>
        <tr><td>Order date</td><td>${d10(project.order_date)||'—'}</td></tr>
        <tr><td>Status</td><td>${project.status}${project.finish_date?' · '+d10(project.finish_date):''}</td></tr>
        <tr><td>Source</td><td>${project.source}</td></tr>
        <tr><td>Warehouse</td><td>${esc(project.warehouse_note)||'—'}</td></tr>
        <tr class="tot"><td>Lines</td><td>${lines.length}</td></tr>
      </table>
      <div style="display:flex;gap:8px;margin:14px 0">
        <button class="sp-btn ${done?'':'is-primary'}" id="pjTog" data-id="${id}" data-to="${done?'ACTIVE':'COMPLETED'}">
          ${done?'Reactivate':'Complete project'}</button>
        <button class="sp-btn" id="pjAud" data-id="${id}">History</button>
      </div>
      <h4>Lines</h4>
      <table class="brk">${lines.map(l=>`<tr><td><span class="mono">${esc(l.sku)}</span></td>
        <td>${n0(l.qty)} · ${n0(l.qty_to_pick)} to pick${l.draw_count>1?` · ${l.draw_count} draws`:''}</td></tr>`).join('')}</table>`);
    $('#pjTog').onclick = async ev => {
      const b = ev.currentTarget;
      try { await api(`/projects/${b.dataset.id}`, { method:'PATCH', body: JSON.stringify({ status:b.dataset.to }) });
        toast(b.dataset.to==='COMPLETED' ? 'Completed — no rows were moved' : 'Reactivated');
        $('#side').classList.remove('is-on'); loadProjects();
      } catch (err) { toast(err.message, true); }
    };
    $('#pjAud').onclick = () => openAudit('projects', id);
  } catch (e) { toast(e.message, true); }
}
async function openAudit(table, id) {
  const rows = await api(`/audit?table=${table}&record=${id}&limit=60`);
  side('History', rows.length ? `<table class="brk">${rows.map(r=>`<tr>
      <td>${esc(r.user_email||'system')}<br><span style="color:var(--mut-3);font-size:11px">${d10(String(r.changed_at).slice(0,10))} ${String(r.changed_at).slice(11,16)}</span></td>
      <td>${r.action}</td></tr>`).join('')}</table>`
    : '<p style="color:var(--mut-2)">Nothing changed yet.</p>');
}


/* ═══ IMPORT SALES ORDER ════════════════════════════════════════════ */
/* ═══ IMPORT SALES ORDER ════════════════════════════════════════════ */
let soPick = null;
on('#btnImportSO', 'click', () => {
  soPick = null; $('#soSearch').value=''; $('#soResults').innerHTML=''; $('#soPreview').innerHTML='';
  $('#soImport').disabled = true; $('#mdImport').classList.add('is-on');
  setTimeout(()=>$('#soSearch').focus(), 50);
});
on('#soSearch', 'input', debounce(async e => {
  const q = e.target.value.trim();
  if (q.length < 3) return $('#soResults').innerHTML = '';
  try {
    const rows = await api('/find/orders?q=' + encodeURIComponent(q));
    $('#soResults').innerHTML = rows.length ? rows.map(r=>`
      <div class="sp-res" data-no="${esc(r.number)}" data-dup="${r.existing_project_id||''}">
        <span class="m">${esc(r.number)}</span>
        <span class="g">${esc(r.customer||'')} · ${esc(r.reference||'')}</span>
        <span class="g" style="flex:0;text-align:right">${d10(r.order_date)} · ${r.mirrored_lines} lines</span>
        ${r.existing_project_id?'<span class="w">already imported</span>':''}</div>`).join('')
      : '<div class="sp-empty">Nothing found.</div>';
  } catch (err) { toast(err.message, true); }
}));
on('#soResults', 'click', async e => {
  const row = e.target.closest('.sp-res'); if (!row) return;
  $$('.sp-res', $('#soResults')).forEach(r => r.classList.toggle('is-on', r === row));
  soPick = row.dataset.no;
  const dup = row.dataset.dup;
  try {
    const lines = await api(`/find/orders/${encodeURIComponent(soPick)}/lines`);
    $('#soImport').disabled = !lines.length || !!dup;
    $('#soPreview').innerHTML = `<h4 style="margin:16px 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut-2)">
        ${lines.length} lines · check before importing</h4>
      ${dup?'<p class="sp-hint warn"><b>This sales order is already a project.</b> Importing again would duplicate it, so it is blocked.</p>':''}
      <div class="sp-results" style="max-height:210px">${lines.map(l=>`
        <div class="sp-res"><span class="m">${esc(l.sku)}</span>
          <span class="g">${esc(l.product_name||'')}</span>
          <span class="g" style="flex:0">${n0(l.quantity)} &times; ${usd(l.price)}</span>
          ${l.in_planning?'':'<span class="w">not in planning</span>'}</div>`).join('')}</div>
      <p class="sp-hint">Every line arrives with one draw and <b>no date</b>. Inventing a pick date is worse than TBA —
      half the workbook's real demand legitimately has none.</p>`;
  } catch (err) { toast(err.message, true); }
});
on('#soImport', 'click', async () => {
  if (!soPick) return;
  const b = $('#soImport'); b.disabled = true; b.textContent = 'Importing…';
  try {
    const out = await api('/projects/import-order', { method:'POST', body: JSON.stringify({ sales_order: soPick }) });
    toast(`${soPick} imported — ${out.lines} lines, nothing retyped`);
    $('#mdImport').classList.remove('is-on');
    // Era show('projects') quando havia seis views numa página. Aqui já
    // estamos nela: basta filtrar e recarregar.
    S.projects.q = soPick.replace('SO-',''); $('#pjSearch').value = S.projects.q; loadProjects();
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = 'Import as project'; }
});


/* ── boot ────────────────────────────────────────────────────────────
   Sem roteador: uma página, uma view. O filtro pela URL existe para o
   Stock Planning poder mandar para cá já filtrado — é o "as telas
   conversam" na prática, e não um enfeite. */
(async function boot() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('only'))   S.projects.only   = q.get('only');
    if (q.get('branch')) S.projects.branch = q.get('branch');
    if (q.get('q'))      S.projects.q      = q.get('q');
    if (q.get('status')) S.projects.status = q.get('status').toUpperCase();

    const f = await api('/filters');
    $('#pjRep').innerHTML = '<option value="">All reps</option>'
      + f.reps.map(r => `<option>${esc(r)}</option>`).join('');
    $('#pjBranch').innerHTML = '<option value="">All branches</option>'
      + (f.branches || []).map(b => `<option value="${esc(b.branch_code)}">${esc(b.name || b.branch_code)} (${n0(b.n)})</option>`).join('')
      + '<option value="__none">No branch yet</option>';
    if (S.projects.branch) $('#pjBranch').value = S.projects.branch;
    if (S.projects.q)      $('#pjSearch').value = S.projects.q;
    if (S.projects.status) $('#pjStatus').value = S.projects.status;
    if (S.projects.only)   $$('.sp-chip[data-only]').forEach(b =>
      b.classList.toggle('is-on', b.dataset.only === S.projects.only));
    await loadProjects();
  } catch (e) { toast(e.message, true); }
})();
