'use strict';
/* Purchase Orders — página própria, três abas.

   Saiu de dentro do Stock Planning porque são três perguntas que ninguém faz
   ao mesmo tempo que "o que eu compro":

     Lines       o que está em aberto, e o que os projetos esperam dele
     Allocation  para qual filial vai cada linha
     Containers  como isso vira carga de 20 ou 40 pés

   As telas continuam conversando, mas NÃO pelo caminho óbvio. Eu ia ligar
   project_lines.po_ref -> po_lines.po_number e medi antes: das 1.442 linhas
   com po_ref, ZERO casam, nem pelos dígitos. O campo guarda nome de gente
   ("SONIA", "WILL", "Rod"), nota ("Airfreight") e algum número solto — é
   "quem pediu", não referência de compra. Uma tela ligada por ele mostraria
   sempre vazio e pareceria defeito.

   O elo de verdade é o SKU: a PO traz o produto que o projeto espera. Não é
   reserva, e a tela diz isso com essas palavras. */

/** Cor por navio, estável. O Excel pinta a Due Date com uma cor por
    consignação — 24 cores mapeadas quase 1:1 com o nome do navio. */
const VESSEL_HUES = [186,42,318,14,268,96,352,210,58,140,300,24,166,240,80,330,4,200,120,282];
function vesselColor(v) {
  if (!v) return null;
  let h = 0; for (let i=0;i<v.length;i++) h = (h*31 + v.charCodeAt(i)) >>> 0;
  return `hsl(${VESSEL_HUES[h % VESSEL_HUES.length]} 72% 62%)`;
}

const S = {
  tab: 'lines',
  pos:  { q:'', supplier:'', open:true, overdue:false },
  alloc:{ q:'', supplier:'', only:'pending' },
  cont: { q:'', supplier:'', type:'40GP', pick:new Set() },
  branches: [], suppliers: [],
};

/* ── abas ────────────────────────────────────────────────────────────
   A aba fica no hash para um link poder apontar direto para ela — é assim
   que o carrinho do Buy manda para cá depois de confirmar. */
function tab(name, dePop) {
  if (!TABS[name]) name = 'lines';
  S.tab = name;
  $$('.po-tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === name));
  $$('.po-pane').forEach(s => s.classList.toggle('is-on', s.dataset.pane === name));
  if (!dePop) history.replaceState(null, '', '#' + name);
  TABS[name]();
}
on('#poTabs', 'click', e => { const b = e.target.closest('.po-tab'); if (b) tab(b.dataset.tab); });
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (TABS[h] && h !== S.tab) tab(h, true);
});

/* Os quatro estados de toda grade desta tela.
   CLAUDE.md é explícito: vazio não é erro. Num controle de estoque, "nenhuma
   linha" por causa de um 500 vira decisão de compra errada. */
const estado = (el, tipo, msg) => {
  el.innerHTML = `<tbody><tr><td><div class="sp-${tipo === 'carregando' ? 'loading' : 'empty'}${
    tipo === 'erro' ? ' is-bad' : ''}">${esc(msg)}</div></td></tr></tbody>`;
};

/* ═══ ABA 1 — LINHAS ════════════════════════════════════════════════ */
let poRows = [], poCap = false;
async function loadPOs() {
  const p = S.pos;
  const qs = new URLSearchParams({ limit:500 });
  if (p.q) qs.set('q', p.q);
  if (p.supplier) qs.set('supplier', p.supplier);
  if (p.open) qs.set('only','open');
  estado($('#poGrid'), 'carregando', 'Loading purchase orders…');
  $('#poCount').textContent = 'loading…';
  try {
    let rows = await api('/pos?' + qs);
    poCap = rows.length >= 500;
    const today = new Date().toISOString().slice(0,10);
    if (p.overdue) rows = rows.filter(r => r.due_date && r.due_date < today);
    poRows = rows;
    if (!rows.length) {
      $('#poCount').textContent = '0 lines';
      return estado($('#poGrid'), 'vazio', 'No purchase order line matches these filters.');
    }
    // O "Overdue" e filtrado no navegador sobre uma pagina de 500. Com o corte
    // batendo, ele esconde atraso de verdade — dizer isso e o minimo.
    $('#poCount').textContent = `${n0(rows.length)} lines`
      + (poCap ? ` — the first 500; "Overdue" only searches inside them` : '');
    $('#poGrid').innerHTML = `<thead><tr>
        <th style="width:92px">PO #</th><th style="width:88px">Date</th><th style="width:92px">Supplier</th>
        <th style="width:190px">SKU</th><th class="n" style="width:78px">QTY</th>
        <th style="width:92px">Finish</th><th style="width:92px">Due Date</th><th style="width:200px">Vessel</th>
        <th class="n" style="width:84px">Unit USD</th><th class="n" style="width:48px">FX</th>
        <th class="n" style="width:96px">Value AUD</th><th style="width:150px">Allocation</th></tr></thead>
      <tbody>${rows.map(r => {
        const vc = vesselColor(r.vessel);
        const late = r.due_date && r.due_date < today;
        return `<tr data-po="${r.id}">
          <td class="po-anchor mono">${esc(r.po_number)}</td>
          <td>${d10(r.po_date)}</td>
          <td>${esc(r.supplier_code)||'<span style="color:#9c0006">?</span>'}</td>
          <td class="mono">${esc(r.sku)}</td>
          <td class="n">${cellPo(r,'qty',n0(r.qty),'num')}</td>
          <td>${d10(r.finish_date)||esc(r.require_status)||''}</td>
          <td class="due ${late?'overdue':''}" style="${vc?`border-left-color:${vc}`:''}">${cellPo(r,'due_date',d10(r.due_date),'date')}</td>
          <td class="clip" title="${esc(r.vessel||'')}">${cellPo(r,'vessel',esc(r.vessel))}</td>
          <td class="n mono">${r.unit_cost_usd==null?'':usd(r.unit_cost_usd)}</td>
          <td class="n mono" style="color:var(--mut-3)">${r.fx_used||''}</td>
          <td class="n mono">${r.value_aud==null?'':aud(r.value_aud)}</td>
          <td><button class="ui-act" data-alloc="${r.id}">Allocate</button>
              <button class="ui-act" data-waiting="${esc(r.po_number)}"
                title="Which project orders are waiting on this product">Waiting</button></td></tr>`;
      }).join('')}</tbody>`;
  } catch (e) {
    // O catch antigo so dava toast e deixava as linhas velhas na tela: um 500
    // ficava igual a "nao ha nada". Sao coisas opostas para quem compra.
    estado($('#poGrid'), 'erro', 'Could not load the purchase orders: ' + e.message);
    $('#poCount').textContent = '';
  }
}
const cellPo = (r,f,html,kind='text') =>
  `<span class="sp-cell${html?'':' void'}" contenteditable="plaintext-only" spellcheck="false"
     data-po="${r.id}" data-field="${f}" data-kind="${kind}">${html||''}</span>`;

on('#poSearch', 'input', debounce(e => { S.pos.q = e.target.value; loadPOs(); }));
on('#poSupplier', 'change', e => { S.pos.supplier = e.target.value; loadPOs(); });
on('#poOpen', 'click', e => { S.pos.open = !S.pos.open; e.currentTarget.classList.toggle('is-on', S.pos.open); loadPOs(); });
on('#poOverdue', 'click', e => { S.pos.overdue = !S.pos.overdue; e.currentTarget.classList.toggle('is-on', S.pos.overdue); loadPOs(); });
on('#poGrid', 'click', e => {
  const a = e.target.closest('[data-alloc]'); if (a) return openAllocation(+a.dataset.alloc);
  const w = e.target.closest('[data-waiting]'); if (w) return openWaiting(w.dataset.waiting);
});

/* Quem espera esta PO. Ligado por SKU e nao por referencia de compra — ver o
   cabecalho. Por isso o texto diz "esperando este produto" e nao "reservado":
   ninguem amarrou esta carga a este pedido, e prometer isso seria mentira. */
async function openWaiting(po) {
  side(po + ' · who is waiting', '<div class="sp-loading">Loading…</div>');
  try {
    const d = await api(`/pos/${encodeURIComponent(po)}/projects`);
    if (!d.rows.length) return side(po + ' · who is waiting',
      `<p class="faint">No active project line is waiting on any product in this purchase order.</p>`);
    $('#sideBody').innerHTML = `
      <p><b>${n0(d.orders)}</b> sales order${d.orders === 1 ? '' : 's'} ·
         <b>${n0(d.rows.length)}</b> lines · <b>${n0(d.units)}</b> units still to pick</p>
      <p class="faint">Matched by product, not by a purchase reference: nothing on this order is
        reserved for these projects. It is what they are short of.</p>
      <table class="brk"><thead><tr><th>Order</th><th>SKU</th><th class="n">To pick</th><th class="n">On this PO</th></tr></thead>
      <tbody>${d.rows.slice(0, 200).map(r => `<tr>
        <td><a href="/projects?q=${encodeURIComponent(r.sales_order)}">${esc(r.sales_order)}</a>
            <span class="faint">${esc(r.customer || '')}</span></td>
        <td class="mono">${esc(r.sku)}</td>
        <td class="n">${n0(r.qty_to_pick)}</td>
        <td class="n faint">${n0(r.po_qty)}</td></tr>`).join('')}</tbody></table>
      ${d.rows.length > 200 ? `<p class="faint">Showing the first 200 of ${n0(d.rows.length)}.</p>` : ''}`;
  } catch (e) { $('#sideBody').innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
}

/** Repartir a linha entre filiais. O saldo não alocado fica com o Main, e
    isso aparece escrito — não fica implícito. */
async function openAllocation(id) {
  try {
    const d = await api(`/po-lines/${id}/allocations`);
    const rows = d.allocations.length ? d.allocations : [{ branch_code:'', qty:'', eta_date:null }];
    const opts = b => S.branches.map(x =>
      `<option value="${x.code}"${x.code===b?' selected':''}>${esc(x.name)}</option>`).join('');
    side(`${d.po_number} · ${d.sku}`, `
      <table class="brk">
        <tr><td>Line quantity</td><td>${n0(d.qty)}</td></tr>
        <tr><td>Due date</td><td>${d10(d.due_date)}</td></tr>
        <tr><td>Vessel</td><td>${esc(d.vessel)||'—'}</td></tr>
      </table>
      <h4>Split across branches</h4>
      <div class="alloc" id="allocList">
        ${rows.map(a=>`<div class="alloc-row">
          <select data-k="branch_code"><option value="">Branch…</option>${opts(a.branch_code)}</select>
          <input class="q" data-k="qty" value="${a.qty===''?'':n0(a.qty)}" placeholder="qty">
          <input data-k="eta_date" value="${a.eta_date?d10(a.eta_date):''}" placeholder="ETA dd/mm/yyyy">
          <button class="sp-btn is-ghost" data-rm>&times;</button></div>`).join('')}
      </div>
      <button class="sp-btn" id="allocAdd" style="margin-top:8px">+ branch</button>
      <div class="alloc-sum"><span>Unallocated — stays at Main</span><b id="allocLeft">${n0(d.unallocated_qty)}</b></div>
      <p class="sp-hint">Allocating more than the line warns; it never blocks. The planning grid keeps using
      company-wide stock — branch allocation is context, not the basis of the calculation.</p>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="sp-btn is-primary" id="allocSave" data-id="${id}">Save allocation</button>
      </div>`);
    const recalc = () => {
      const used = $$('#allocList .alloc-row').reduce((s,r)=>s+(Number(String(r.querySelector('[data-k=qty]').value).replace(/[^0-9.]/g,''))||0),0);
      const left = Number(d.qty) - used;
      const el = $('#allocLeft'); el.textContent = n0(left);
      el.style.color = left < 0 ? '#9c0006' : left === 0 ? '#006100' : '';
    };
    $('#allocList').addEventListener('input', recalc);
    $('#allocList').addEventListener('click', e => { if (e.target.closest('[data-rm]')) { e.target.closest('.alloc-row').remove(); recalc(); } });
    $('#allocAdd').onclick = () => {
      const el = document.createElement('div'); el.className = 'alloc-row';
      el.innerHTML = `<select data-k="branch_code"><option value="">Branch…</option>${opts('')}</select>
        <input class="q" data-k="qty" placeholder="qty"><input data-k="eta_date" placeholder="ETA dd/mm/yyyy">
        <button class="sp-btn is-ghost" data-rm>&times;</button>`;
      $('#allocList').append(el);
    };
    $('#allocSave').onclick = async ev => {
      const allocations = $$('#allocList .alloc-row').map(r => ({
        branch_code: r.querySelector('[data-k=branch_code]').value,
        qty: Number(String(r.querySelector('[data-k=qty]').value).replace(/[^0-9.]/g,'')),
        eta_date: parseDate(r.querySelector('[data-k=eta_date]').value),
      })).filter(a => a.branch_code && a.qty > 0);
      try {
        const out = await api(`/po-lines/${ev.currentTarget.dataset.id}/allocations`,
          { method:'PUT', body: JSON.stringify({ allocations }) });
        toast(out.over_allocated ? `Saved — ${n0(-out.unallocated_qty)} over the line quantity` : 'Allocation saved');
        $('#side').classList.remove('is-on');
      } catch (err) { toast(err.message, true); }
    };
  } catch (e) { toast(e.message, true); }
}

/* ═══ ABA 2 — ALOCAÇÃO POR FILIAL ═══════════════════════════════════
   A mesma pergunta que o botão Allocate faz por linha, mas para o conjunto:
   quanto de cada PO ainda não tem dono. Medido hoje: 1.466 linhas em aberto e
   637.701 unidades sem filial nenhuma — todas caem no Main por omissão, o que
   é regra do sistema (005) e não descuido, mas ninguém tinha onde ver isso. */
async function loadAlloc() {
  const a = S.alloc;
  const qs = new URLSearchParams({ limit: 300, only: a.only });
  if (a.q) qs.set('q', a.q);
  if (a.supplier) qs.set('supplier', a.supplier);
  estado($('#alGrid'), 'carregando', 'Loading allocations…');
  $('#alCount').textContent = 'loading…';
  try {
    const d = await api('/pos/allocations?' + qs);
    $('#alTiles').innerHTML = `
      ${cartao(n0(d.counts.total), 'Open PO lines', 'not yet received')}
      ${cartao(n0(d.counts.pending), 'With no branch', 'the remainder is Main by default', d.counts.pending ? 'warn' : '')}
      ${cartao(n0(d.counts.units_pending), 'Units unallocated', 'across those lines')}
      ${cartao(n0(d.counts.over_count), 'Over-allocated', 'more promised than the line carries', d.counts.over_count ? 'bad' : '')}`;
    if (!d.rows.length) {
      $('#alCount').textContent = '0 lines';
      return estado($('#alGrid'), 'vazio', 'Every open line matching these filters already has a branch.');
    }
    $('#alCount').textContent = `${n0(d.rows.length)} lines · ${d.ms} ms`;
    $('#alGrid').innerHTML = `<thead><tr>
        <th style="width:92px">PO #</th><th style="width:190px">SKU</th><th style="width:92px">Supplier</th>
        <th style="width:92px">Due</th><th class="n" style="width:78px">QTY</th>
        <th class="n" style="width:88px">Allocated</th><th class="n" style="width:96px">No branch</th>
        <th>Split</th><th style="width:96px"></th></tr></thead>
      <tbody>${d.rows.map(r => `<tr data-po="${r.po_line_id}"${r.over_allocated ? ' class="al-over"' : ''}>
        <td class="mono">${esc(r.po_number)}</td>
        <td class="mono">${esc(r.sku)}</td>
        <td>${esc(r.supplier_code || '')}</td>
        <td>${d10(r.due_date)}</td>
        <td class="n">${n0(r.qty)}</td>
        <td class="n">${r.allocated_qty > 0 ? n0(r.allocated_qty) : '<span class="faint">—</span>'}</td>
        <td class="n${r.unallocated_qty > 0 ? ' al-rest' : ''}"
            title="${r.unallocated_qty > 0 ? 'Goes to Main Warehouse unless someone splits it' : 'Fully allocated'}"
          >${r.unallocated_qty > 0 ? n0(r.unallocated_qty) : '<span class="faint">—</span>'}</td>
        <td class="al-split">${r.allocations.length
          ? r.allocations.map(x => `<span class="al-chip">${esc(x.branch_name || x.branch_code)} ${n0(x.qty)}</span>`).join('')
          : '<span class="faint">all Main</span>'}</td>
        <td><button class="ui-act" data-alloc="${r.po_line_id}">Allocate</button></td></tr>`).join('')}</tbody>`;
  } catch (e) {
    estado($('#alGrid'), 'erro', 'Could not load allocations: ' + e.message);
    $('#alCount').textContent = '';
  }
}
on('#alSearch', 'input', debounce(e => { S.alloc.q = e.target.value; loadAlloc(); }));
on('#alSupplier', 'change', e => { S.alloc.supplier = e.target.value; loadAlloc(); });
on('#alOnly', 'change', e => { S.alloc.only = e.target.value; loadAlloc(); });
on('#alGrid', 'click', e => { const b = e.target.closest('[data-alloc]'); if (b) openAllocation(+b.dataset.alloc); });

/* Mesma marcação do tile() do Stock Planning — b/em/small, não b/span/i.
   O CSS de .sp-tile é compartilhado e estiliza por elemento; trocar as tags
   dá um cartão sem estilo nenhum e nada no console. */
const cartao = (v, t, s, cls = '') =>
  `<div class="sp-tile ${cls}"><b>${v}</b><em>${esc(t)}</em><small>${esc(s)}</small></div>`;

/* ═══ ABA 3 — CONTÊINER ═════════════════════════════════════════════
   Volumétrico, e SÓ volumétrico. Existe um packer 3D pronto neste repo
   (features/container-builder/packer.js, com testes), mas ligá-lo aqui
   exigiria as três medidas da caixa em 100% do que entra na carga, e a
   cobertura é 78% das linhas em aberto. Desenhar a posição de cada caixa com
   um quinto do carregamento faltando é uma imagem convincente de uma coisa
   que não se sabe.

   O que ESTA aba faz é a conta que fecha: caixas inteiras × cubo da caixa,
   contra o volume útil do contêiner. E ela diz, o tempo todo, quanto da carga
   está sobre medida e quanto está sobre suposição. */
let contData = null;
async function loadCont() {
  const c = S.cont;
  const qs = new URLSearchParams({ limit: 500 });
  if (c.q) qs.set('q', c.q);
  if (c.supplier) qs.set('supplier', c.supplier);
  estado($('#ctGrid'), 'carregando', 'Working out the cube…');
  $('#ctCount').textContent = 'loading…';
  try {
    contData = await api('/containers/lines?' + qs);
    if ($('#ctPlans').options.length <= 1) carregarPlanos();
    if ($('#ctType').options.length <= 1) {
      $('#ctType').innerHTML = contData.types.map(t =>
        `<option value="${esc(t.code)}"${t.code === c.type ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    }
    renderCont();
  } catch (e) {
    estado($('#ctGrid'), 'erro', 'Could not work out the cube: ' + e.message);
    $('#ctCount').textContent = '';
  }
}

function renderCont() {
  const d = contData; if (!d) return;
  const tipo = d.types.find(t => t.code === S.cont.type) || d.types[0];
  const util = Number(tipo.cbm_internal) * Number(tipo.usable_pct) / 100;
  const sel = d.rows.filter(r => S.cont.pick.has(String(r.id)) && r.cbm != null);
  const cbmSel = sel.reduce((a, r) => a + Number(r.cbm), 0);
  const kgSel  = sel.reduce((a, r) => a + Number(r.kg || 0), 0);
  const semPeso = sel.filter(r => r.kg == null).length;
  const suposto = sel.filter(r => r.cube_basis !== 'measured');
  const cbmSup  = suposto.reduce((a, r) => a + Number(r.cbm), 0);
  const pct = util > 0 ? (cbmSel / util) * 100 : 0;

  $('#ctSummary').innerHTML = `
    <div class="ct-bar" title="${n1(cbmSel)} m³ of ${n1(util)} m³ usable">
      <i style="width:${Math.min(pct, 100)}%"></i>
      ${pct > 100 ? `<em style="width:${Math.min(pct - 100, 100)}%">over</em>` : ''}
    </div>
    <div class="ct-nums">
      <b>${n1(cbmSel)} m³</b> of <b>${n1(util)} m³</b> usable
      <span>(${esc(tipo.name)}: ${n1(tipo.cbm_internal)} m³ internal at ${n0(tipo.usable_pct)}%)</span>
      <span class="ct-pct${pct > 100 ? ' is-over' : ''}">${n0(pct)}% full</span>
      <span>${n0(sel.length)} lines picked</span>
      ${cbmSel > 0 ? `<span>≈ ${n1(cbmSel / util)} container${cbmSel / util >= 2 ? 's' : ''}</span>` : ''}
    </div>
    <div class="ct-honest">
      ${cbmSup >= 0.05
        ? `<span class="ct-warn">${n1(cbmSup)} m³ of that (${n0(cbmSup / Math.max(cbmSel, 0.001) * 100)}%) is an
            <b>assumption</b>: the product has no shipping-carton size, so its own dimensions are being
            treated as the carton.</span>`
        : cbmSup > 0
        ? `<span>All but ${n1(cbmSup)} m³ has a measured shipping-carton size.</span>`
        : `<span class="ct-good">Every picked line has a measured shipping-carton size.</span>`}
      ${semPeso
        ? `<span class="ct-warn">Weight is unknown for ${n0(semPeso)} of ${n0(sel.length)} picked lines —
            the ${n0(tipo.payload_kg)} kg payload limit is <b>not being checked</b>.
            ${kgSel ? `What is known adds to ${n0(kgSel)} kg.` : ''}</span>`
        : kgSel ? `<span>${n0(kgSel)} kg of ${n0(tipo.payload_kg)} kg payload.</span>` : ''}
    </div>`;

  const s = d.summary;
  $('#ctCount').textContent = `${n0(s.cubed)} of ${n0(s.lines)} lines can be cubed`
    + ` · ${n1(s.cbm)} m³` + (s.no_cube ? ` · ${n0(s.no_cube)} cannot` : '') + ` · ${d.ms} ms`;

  if (!d.rows.length) return estado($('#ctGrid'), 'vazio', 'No open purchase order line matches these filters.');
  $('#ctGrid').innerHTML = `<thead><tr>
      <th style="width:34px"></th><th style="width:92px">PO #</th><th style="width:190px">SKU</th>
      <th style="width:88px">Supplier</th><th style="width:88px">Due</th>
      <th class="n" style="width:74px">QTY</th><th class="n" style="width:62px">Ctns</th>
      <th class="n" style="width:82px">m³</th><th class="n" style="width:74px">kg</th>
      <th style="width:150px">Cube from</th></tr></thead>
    <tbody>${d.rows.map(r => {
      const on0 = S.cont.pick.has(String(r.id));
      return `<tr data-line="${r.id}" class="${r.cbm == null ? 'ct-nocube' : ''}${on0 ? ' is-picked' : ''}">
        <td>${r.cbm == null ? '<span class="faint" title="Cannot be cubed — see the reason at the end of the row">—</span>'
             : `<input type="checkbox" class="ct-pick"${on0 ? ' checked' : ''}>`}</td>
        <td class="mono">${esc(r.po_number)}</td>
        <td class="mono">${esc(r.sku)}</td>
        <td>${esc(r.supplier_code || '')}</td>
        <td>${d10(r.due_date)}</td>
        <td class="n">${n0(r.qty)}</td>
        <td class="n">${r.cartons != null ? n0(r.cartons) : '<span class="faint">—</span>'}</td>
        <td class="n">${r.cbm != null ? n1(r.cbm) : '<span class="faint">—</span>'}</td>
        <td class="n">${r.kg != null ? n0(r.kg) : '<span class="faint" title="No usable weight on this product">—</span>'}</td>
        <td>${cubeTag(r)}</td></tr>`;
    }).join('')}</tbody>`;
}

/* De onde saiu o cubo desta linha, ou por que não saiu.
   Nunca "0" e nunca uma média: uma linha sem medida sai da conta e diz o
   motivo. Preencher o buraco com um valor plausível é como se monta um
   contêiner que não fecha no porto. */
function cubeTag(r) {
  if (r.cbm == null) {
    const motivo = r.cbm_carton == null
      ? 'No usable carton or product dimension in Cin7 or in the product file'
      : 'Has a size but no units-per-carton, so cartons cannot be counted';
    return `<span class="ct-no" title="${esc(motivo)}">cannot cube</span>`;
  }
  const medido = r.cube_basis === 'measured';
  return `<span class="ct-src ${medido ? 'is-measured' : 'is-assumed'}"
    title="${medido
      ? 'From the shipping-carton dimensions held in Cin7'
      : 'No shipping-carton size on file, so the dimensions of the product itself are being treated as the carton'}"
    >${medido ? 'carton' : 'assumed'}</span>`
    + (r.cube_disputed ? `<span class="ct-dis" title="Cin7 and the product file disagree by more than 20% on this product">disputed</span>` : '')
    + (r.qty_planned ? `<span class="ct-plan" title="Already on: ${esc(r.plan_names || '')}">on a plan</span>` : '');
}

on('#ctGrid', 'change', e => {
  const c = e.target.closest('.ct-pick'); if (!c) return;
  const id = c.closest('tr').dataset.line;
  if (c.checked) S.cont.pick.add(id); else S.cont.pick.delete(id);
  c.closest('tr').classList.toggle('is-picked', c.checked);
  renderCont();
});
on('#ctSearch', 'input', debounce(e => { S.cont.q = e.target.value; loadCont(); }));
on('#ctSupplier', 'change', e => { S.cont.supplier = e.target.value; loadCont(); });
on('#ctType', 'change', e => { S.cont.type = e.target.value; renderCont(); });
on('#ctAll', 'click', () => {
  // "Tudo" é tudo o que DÁ para cubar. Marcar o que não tem medida faria a
  // barra parecer mais cheia do que a carga está.
  const cub = (contData?.rows || []).filter(r => r.cbm != null).map(r => String(r.id));
  const todos = cub.every(id => S.cont.pick.has(id));
  S.cont.pick = todos ? new Set() : new Set(cub);
  renderCont();
});
/* Guardar a carga.
   Montar contêiner leva horas e passa por mais de uma pessoa. Sem gravar, o
   trabalho morre no primeiro F5 e a conversa recomeça do zero. O cubo vai
   CONGELADO: a dimensão muda no Cin7 e um plano fechado não pode se
   reescrever — quem embarcou precisa ver o número em que decidiu. */
on('#ctSave', 'click', async (ev) => {
  const b = ev.currentTarget; if (b.disabled) return;
  const ids = [...S.cont.pick];
  if (!ids.length) return toast('Pick the lines that go in the container first', true);
  const nome = prompt('Name this load — the vessel, the week, whatever you call it:');
  if (!nome || !nome.trim()) return;
  b.disabled = true; const rot = b.textContent; b.textContent = 'Saving…';
  try {
    const r = await api('/container-plans', { method: 'POST', body: JSON.stringify({
      name: nome.trim(), container_code: S.cont.type,
      supplier_code: S.cont.supplier || null, po_line_ids: ids.map(Number) }) });
    toast(`"${r.name}" saved with ${r.lines} lines`);
    S.cont.pick = new Set();
    await carregarPlanos(); await loadCont();
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = rot; }
});

async function carregarPlanos() {
  try {
    const d = await api('/container-plans');
    $('#ctPlans').innerHTML = '<option value="">Saved plans…</option>'
      + d.plans.map(p => `<option value="${p.id}">${esc(p.name)} · ${esc(p.container_name)} · ${n1(p.cbm)} m³ · ${n0(p.lines)} lines</option>`).join('');
  } catch (_) { /* a aba funciona sem a lista */ }
}

on('#ctPlans', 'change', async (e) => {
  const id = e.target.value; if (!id) return;
  try {
    const d = await api(`/container-plans/${id}`);
    S.cont.type = d.plan.container_code; $('#ctType').value = d.plan.container_code;
    // Reabrir marca as linhas do plano que ainda estão na lista. As que já
    // foram recebidas somem da consulta, e dizer isso evita o susto de ver
    // um plano voltar menor do que foi salvo.
    const naLista = new Set((contData?.rows || []).map(r => String(r.id)));
    const doPlano = d.lines.map(l => String(l.po_line_id)).filter(Boolean);
    S.cont.pick = new Set(doPlano.filter(x => naLista.has(x)));
    const faltam = doPlano.length - S.cont.pick.size;
    renderCont();
    toast(faltam
      ? `"${d.plan.name}" reopened — ${S.cont.pick.size} of ${doPlano.length} lines; ${faltam} are no longer open`
      : `"${d.plan.name}" reopened with ${S.cont.pick.size} lines`);
  } catch (err) { toast(err.message, true); }
});

on('#ctFill', 'click', () => {
  /* Encher até o contêiner. Ordena por data de vencimento — o que chega
     primeiro embarca primeiro — e para quando a próxima linha não cabe.
     Não é otimização de empacotamento: é a conta que o comprador faz à mão
     hoje, feita sem erro de digitação. */
  const t = contData.types.find(x => x.code === S.cont.type);
  const util = Number(t.cbm_internal) * Number(t.usable_pct) / 100;
  const cand = (contData?.rows || []).filter(r => r.cbm != null)
    .sort((a, b) => String(a.due_date || '9').localeCompare(String(b.due_date || '9')));
  let acc = 0; const pick = new Set();
  for (const r of cand) { const v = Number(r.cbm); if (acc + v > util) continue; acc += v; pick.add(String(r.id)); }
  S.cont.pick = pick; renderCont();
  toast(`${pick.size} lines fit a ${t.name} — ${n1(acc)} of ${n1(util)} m³`);
});
/* ═══ NEW PO ════════════════════════════════════════════════════════ */
on('#btnAddPO', 'click', () => {
  $('#npoNumber').value=''; $('#npoLines').value=''; $('#npoPreview').innerHTML='';
  $('#npoDate').value = new Date().toISOString().slice(0,10);
  $('#mdPO').classList.add('is-on'); setTimeout(()=>$('#npoNumber').focus(), 50);
});
function parsePoLines(text) {
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{
    const [sku,qty,cost,due] = l.split(/\t|;|,(?=\s*\S)/).map(x=>(x||'').trim());
    return { sku, qty:Number(String(qty||'').replace(/[^0-9.]/g,'')),
             unit_cost_usd: cost ? Number(String(cost).replace(/[^0-9.]/g,'')) : null,
             due_date: due ? parseDate(due) : null };
  }).filter(l => l.sku && l.qty > 0);
}
on('#npoLines', 'input', debounce(() => {
  const lines = parsePoLines($('#npoLines').value);
  const total = lines.reduce((s,l)=>s+(l.unit_cost_usd||0)*l.qty, 0);
  $('#npoPreview').innerHTML = lines.length
    ? `<p class="sp-hint"><b>${lines.length}</b> lines · ${n0(lines.reduce((s,l)=>s+l.qty,0))} units${total?` · ${usd(total)} USD`:''}</p>`
    : '<p class="sp-hint">No lines recognised yet.</p>';
}, 200));
on('#npoSave', 'click', async (ev) => {
  const lines = parsePoLines($('#npoLines').value);
  if (!$('#npoNumber').value.trim()) return toast('PO number is required', true);
  if (!lines.length) return toast('At least one line is required', true);
  // A rota de criacao ACRESCENTA numeros de linha em vez de deduplicar, entao
  // um duplo clique grava a PO duas vezes. CLAUDE.md: acao em voo trava o
  // botao que a disparou.
  const b = ev.currentTarget; if (b.disabled) return;
  b.disabled = true; const rot = b.textContent; b.textContent = 'Saving…';
  try {
    const out = await api('/pos', { method:'POST', body: JSON.stringify({
      po_number: $('#npoNumber').value.trim(), po_date: $('#npoDate').value,
      supplier_code: $('#npoSupplier').value || null, due_date: $('#npoDue').value || null,
      vessel: $('#npoVessel').value.trim() || null, lines }) });
    toast(`PO saved — ${out.created} lines now count as stock arriving`);
    $('#mdPO').classList.remove('is-on'); loadPOs();
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = rot; }
});
/* ── boot ────────────────────────────────────────────────────────────
   A tabela de carregadores fica DEPOIS das funções: um objeto literal
   avalia tudo na hora, e uma chave apontando para uma função que ainda não
   existe é ReferenceError antes de qualquer coisa aparecer na tela. */
const TABS = { lines: loadPOs, alloc: loadAlloc, cont: loadCont };

(async function boot() {
  try {
    const [sup, br] = await Promise.all([api('/suppliers'), api('/branches')]);
    S.suppliers = sup; S.branches = br;
    const opts = sup.map(s => `<option value="${esc(s.code)}">${esc(s.code)} (${s.sku_count})</option>`).join('');
    $('#poSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#alSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#ctSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#npoSupplier').innerHTML = '<option value="">—</option>' + opts;

    // Chegando de outra tela: o Buy manda ?po=… depois de confirmar o carrinho.
    const q = new URLSearchParams(location.search);
    if (q.get('po'))       { S.pos.q = q.get('po'); $('#poSearch').value = S.pos.q; S.pos.open = false;
                             $('#poOpen').classList.remove('is-on'); }
    if (q.get('supplier')) { S.pos.supplier = S.alloc.supplier = S.cont.supplier = q.get('supplier');
                             $('#poSupplier').value = $('#alSupplier').value = $('#ctSupplier').value = S.pos.supplier; }
    tab(location.hash.replace('#', '') || 'lines', true);
  } catch (e) { toast(e.message, true); }
})();
