'use strict';
/* Stock Planning — front end.

   Nenhum cálculo mora aqui: a projeção semanal vem pronta do servidor. O
   navegador desenha e edita. É o que permite abrir 1.300 SKUs sem travar.

   Datas em dd/mm/yyyy em toda a tela. Vale registrar que o workbook NÃO usa
   esse formato — ele usa 'd-mmm' (8-Nov). Foi decisão explícita padronizar,
   e dd/mm/yyyy é também o que Returns, Open Orders e Pick Anomalies já usam. */

const API = '/api/stock-planning';
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const S = {
  view: 'overview', ov: 'health',
  projects: { q:'', status:'ACTIVE', rep:'', branch:'', only:'', sort:'order_date', dir:'desc', offset:0, limit:400, col:{} },
  supply:   { supplier: localStorage.getItem('sp.sup') || '', q:'', view:(localStorage.getItem('sp.view')||''), line:'', scope:(localStorage.getItem('sp.scope')||''), weeks:26, risk:false, life:'', expandAll:false, open:{}, cell:null, sort:(localStorage.getItem('sp.sort')||'risk'), back:+(localStorage.getItem('sp.back')||0) },
  pos:      { q:'', supplier:'', open:true, overdue:false },
  alerts:   { muted:false, supplier:'' },
  buy:      { supplier:'', late:false },
  suppliers: [], branches: [], state: null,
};

/* ── utilidades ─────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts,
    headers: { 'Content-Type':'application/json', 'x-sp-user': localStorage.getItem('sp.who') || 'planner', ...(opts.headers||{}) } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}
const esc = v => v==null ? '' : String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n0  = v => (v==null||v==='') ? '' : Math.round(Number(v)).toLocaleString('en-AU');
/* Zero não é informação. O Excel deixa a célula vazia, e uma coluna de zeros
   compete visualmente com os números que importam. */
const nz0 = v => (v==null||v===''||Number(v)===0) ? '' : Math.round(Number(v)).toLocaleString('en-AU');
const n1  = v => (v==null||v==='') ? '' : Number(v).toLocaleString('en-AU',{maximumFractionDigits:1});
const aud = v => (v==null||v==='') ? '' : 'A$' + Math.round(Number(v)).toLocaleString('en-AU');
const usd = v => (v==null||v==='') ? '' : '$' + Number(v).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});

/** dd/mm/yyyy — o padrão do app (features/returns/returns.js:20). */
const d10 = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const dSh = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}` : ''; };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Aceita dd/mm/yyyy, yyyy-mm-dd e "8 Nov 26". Devolve sempre ISO. */
function parseDate(v) {
  const s = String(v||'').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
  m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/);
  if (m) { const y = m[3].length===2 ? '20'+m[3] : m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-]?(\d{2,4})?$/);
  if (m) { const i = MON.findIndex(x => x.toLowerCase()===m[2].toLowerCase()); if (i<0) return null;
    const y = !m[3] ? String(new Date().getFullYear()) : (m[3].length===2 ? '20'+m[3] : m[3]);
    return `${y}-${String(i+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return null;
}

let toastT;
function toast(msg, bad) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => el.className = 'sp-toast', bad ? 5000 : 2400);
}
const debounce = (fn, ms=260) => { let t; return (...a) => { clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

/** Cor por navio, estável. O Excel pinta a Due Date com uma cor por
    consignação — 24 cores mapeadas quase 1:1 com o nome do navio. */
const VESSEL_HUES = [186,42,318,14,268,96,352,210,58,140,300,24,166,240,80,330,4,200,120,282];
function vesselColor(v) {
  if (!v) return null;
  let h = 0; for (let i=0;i<v.length;i++) h = (h*31 + v.charCodeAt(i)) >>> 0;
  return `hsl(${VESSEL_HUES[h % VESSEL_HUES.length]} 72% 62%)`;
}

/* ── navegação ──────────────────────────────────────────────────────── */
// Projects e Purchase Orders ganharam entrada própria no menu lateral, mas
// continuam ABAS desta mesma página — mesmo código, mesmos dados, mesmo estado.
// O menu aponta para /planning#projects e a aba abre pelo hash. Duplicar as
// telas para dar a cada uma sua URL seria duplicar a lógica que as liga: o
// projeto puxa a linha de PO, a PO alimenta o incoming da grade.
const HASH_VIEWS = ['overview', 'projects', 'supply', 'buy', 'pos', 'alerts'];
function show(view, opts) {
  S.view = view;
  $$('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
  $$('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === view));
  // O hash acompanha a aba, para o item certo do menu ficar marcado e para
  // recarregar a página cair onde o usuário estava.
  if (!opts || !opts.fromHash) {
    const h = '#' + view;
    if (location.hash !== h) history.replaceState(null, '', h);
    if (window.__railSync) window.__railSync();
  }
  ({ overview:loadOverview, projects:loadProjects, supply:loadSupply, buy:loadBuy, pos:loadPOs, alerts:loadAlerts }[view] || (()=>{}))();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.sp-tab'); if (b) show(b.dataset.view); });
window.addEventListener('hashchange', () => {
  const v = location.hash.replace('#', '');
  if (HASH_VIEWS.includes(v) && v !== S.view) show(v, { fromHash: true });
});

function side(title, html) { $('#sideTitle').textContent = title; $('#sideBody').innerHTML = html; $('#side').classList.add('is-on'); }
$('#sideClose').addEventListener('click', () => $('#side').classList.remove('is-on'));
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return;
  $('#side').classList.remove('is-on'); $$('.sp-modal.is-on').forEach(m => m.classList.remove('is-on')); });
$$('.sp-modal').forEach(m => m.addEventListener('click', e => {
  if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('is-on'); }));

/* ── boot ───────────────────────────────────────────────────────────── */
(async function boot() {
  try {
    const [st, sup, br] = await Promise.all([api('/state'), api('/suppliers'), api('/branches')]);
    S.state = st; S.suppliers = sup; S.branches = br;
    const src = st.soh_source === 'CIN7_LIVE' ? 'Cin7 live' : 'Excel snapshot';
    const age = st.counts.cin7_lines_synced_at ? new Date(st.counts.cin7_lines_synced_at) : null;
    const hrs = age ? (Date.now() - age.getTime()) / 36e5 : 99;
    $('#statusDot').className = 'sp-dot ' + (hrs < 6 ? 'fresh' : hrs < 30 ? 'stale' : 'dead');
    $('#statusText').textContent = `Week ${d10(st.reporting_week)} · stock from ${src}`;
    const opts = sup.map(s => `<option value="${esc(s.code)}">${esc(s.code)} (${s.sku_count})</option>`).join('');
    // Era "Pick a supplier…" porque a tela inteira levava 15,7s. Depois que a
    // subconsulta LATERAL virou CTE MATERIALIZED (24×), os 1.951 SKUs saem em
    // 616 ms — a restrição sobrevivia ao motivo dela.
    $('#spSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#byySupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#poSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#alSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#npoSupplier').innerHTML = '<option value="">—</option>' + opts;
    if (S.supply.supplier) $('#spSupplier').value = S.supply.supplier;
    if (S.supply.view) { $('#spView').value = S.supply.view; S.supply.expandAll = true; }
    if (S.supply.back) $('#spBack').value = String(S.supply.back);
    $('#spSort').classList.toggle('is-on', S.supply.sort === 'risk');
    const f = await api('/filters');
    $('#pjRep').innerHTML = '<option value="">All reps</option>' + f.reps.map(r => `<option>${esc(r)}</option>`).join('');
    // A contagem no rótulo: um filtro de filial sem número obriga a testar uma
    // por uma para descobrir onde há trabalho.
    $('#pjBranch').innerHTML = '<option value="">All branches</option>'
      + (f.branches || []).map(b => `<option value="${esc(b.branch_code)}">${esc(b.name || b.branch_code)} (${n0(b.n)})</option>`).join('')
      + '<option value="__none">No branch yet</option>';
    $('#spLine').innerHTML = '<option value="">All lines</option>'
      + (f.lines || []).map(l => `<option value="${esc(l.line)}">${esc(l.line)} (${n0(l.n)})</option>`).join('');
    // Abre onde o link do menu pediu. Sem isto /planning#projects caía no
    // Overview e o item marcado no menu apontava para outra tela.
    const want = location.hash.replace('#', '');
    if (HASH_VIEWS.includes(want)) show(want, { fromHash: true });
    else loadOverview();
  } catch (e) { toast('Could not load: ' + e.message, true); }
})();

/* ═══ OVERVIEW ══════════════════════════════════════════════════════ */
$('#ovTabs').addEventListener('click', e => {
  const b = e.target.closest('.sp-subtab'); if (!b) return;
  S.ov = b.dataset.ov;
  $$('.sp-subtab').forEach(x => x.classList.toggle('is-on', x === b));
  loadOverview();
});
function loadOverview() {
  $('#ovBody').innerHTML = '<div class="sp-loading">Loading…</div>';
  ({ health:ovHealth, risk:ovRisk, inbound:ovInbound, demand:ovDemand, signal:ovSignal, dead:ovDead }[S.ov])();
}
const tile = (v, label, note, kind='') =>
  `<div class="sp-tile ${kind}"><b>${v}</b><em>${label}</em><small>${note}</small></div>`;

const COVER_BANDS = ['<1 mth','1-6 mths','6-12 mths','12+ mths','no demand set'];
const ABC_ROWS = ['A','B','C','D'];
function bandColor(abc, band, v, max) {
  if (!v) return '';
  const bad = band === '<1 mth' || (abc === 'A' && band === '12+ mths');
  const warm = band === '12+ mths' || band === 'no demand set';
  const t = Math.min(v / (max || 1), 1);
  if (bad)  return `background:rgba(156,0,6,${0.10 + t*0.55});color:${t>0.45?'#fff':'#9c0006'}`;
  if (warm) return `background:rgba(156,87,0,${0.08 + t*0.42});color:${t>0.5?'#fff':'#9c5700'}`;
  return `background:rgba(10,165,230,${0.08 + t*0.42});color:${t>0.5?'#fff':'#0b5f80'}`;
}

async function ovHealth() {
  try {
    const d = await api('/overview/stock-health');
    const t = d.totals;
    const max = Math.max(...d.matrix.map(m => Number(m.value_aud) || 0), 1);
    const cell = (abc, band) => {
      const m = d.matrix.find(x => x.abc === abc && x.cover_band === band);
      if (!m || !m.skus) return '<td class="z">·</td>';
      return `<td class="c" style="${bandColor(abc, band, Number(m.value_aud), max)}"
                data-abc="${abc}" data-band="${esc(band)}"><b>${aud(m.value_aud)}</b><small>${m.skus} SKUs</small></td>`;
    };
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(aud(t.total_stock_aud),'Stock on hand',`${n0(t.skus)} planned SKUs, valued at Cin7 average cost`)}
        ${tile(aud(t.excess_aud),'Above target cover','capital sitting still — the stop-buying list','warn')}
        ${tile(aud(t.buy_gap_aud),'Short of target','what it costs to reach the cover targets','good')}
        ${tile(n0(t.oos_skus),'Out of stock','zero or negative available — invisible in the Excel','bad')}
      </div>
      <div class="sp-panel">
        <h4>ABC by cover <span>Pareto on stock value. Class A short of cover is the urgent buy; class A over 12 months is the money that stopped moving.</span></h4>
        <div class="in"><table class="mx">
          <tr><td class="hd"></td>${COVER_BANDS.map(b=>`<td class="hd">${b}</td>`).join('')}</tr>
          ${ABC_ROWS.map(a=>`<tr><td class="rh">${a==='D'?'D · no value':a}</td>${COVER_BANDS.map(b=>cell(a,b)).join('')}</tr>`).join('')}
        </table></div>
      </div>
      <div class="sp-panel">
        <h4>By supplier <span>ordered by capital above target</span></h4>
        <table><thead><tr><th>Supplier</th><th class="n">SKUs</th><th class="n">Stock value</th>
          <th class="n">Above target</th><th class="n">Short</th><th class="n">Slow (&gt;12m)</th><th class="n">&lt;1 month</th><th class="n">Out</th></tr></thead>
        <tbody>${d.suppliers.map(s=>`<tr class="click" data-sup="${esc(s.supplier_code)}">
          <td class="em">${esc(s.supplier_code)}</td><td class="n">${n0(s.skus)}</td>
          <td class="n">${aud(s.stock_value_aud)}</td><td class="n">${aud(s.excess_value_aud)}</td>
          <td class="n">${aud(s.gap_to_target_aud)}</td><td class="n">${n0(s.slow_skus)}</td>
          <td class="n" ${s.under_one_month?'style="color:#9c0006;font-weight:600"':''}>${n0(s.under_one_month)}</td>
          <td class="n" ${s.out_of_stock?'style="color:#9c0006;font-weight:600"':''}>${n0(s.out_of_stock)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => {
      const tr = e.target.closest('tr[data-sup]');
      if (tr) return jumpSupply(tr.dataset.sup, '');
      const td = e.target.closest('td[data-abc]');
      if (td) toast(`${td.dataset.abc} · ${td.dataset.band} — open Supply Planning and filter by supplier to drill in`);
    };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

async function ovRisk() {
  try {
    const d = await api('/overview/coverage-risk?weeks=13');
    const max = Math.max(...d.weeks.map(w => w.skus), 1);
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(n0(d.exposed),'SKUs run out within 13 weeks','using real stock, PO due dates and dated project draws','bad')}
        ${tile(n0(d.weeks[0]?.skus||0),'…already next week',`week ending ${d10(d.weeks[0]?.week_ending)}`,'bad')}
        ${tile(n0(d.safe),'Clear the whole horizon','no projected stockout in 13 weeks','good')}
      </div>
      <div class="sp-panel">
        <h4>Week the stock runs out <span>same cascade the planning grid uses — these two can never disagree</span></h4>
        <div class="in"><div class="bars">${d.weeks.map((w,i)=>`
          <div class="bar ${i===0?'bad':''}" title="${w.skus} SKUs run out in the week ending ${d10(w.week_ending)}">
            ${w.skus?`<span class="t">${w.skus}</span>`:''}
            <span class="v" style="height:${Math.round((w.skus/max)*88)}%"></span>
            <span class="l">${dSh(w.week_ending)}</span></div>`).join('')}</div></div>
      </div>
      <div class="sp-panel">
        <h4>The exposed SKUs <span>soonest first</span></h4>
        <table><thead><tr><th>SKU</th><th>Supplier</th><th class="n">Week</th><th class="n">Runs out</th>
          <th class="n">Stock now</th><th class="n">Wk/Avg</th><th class="n">Incoming</th><th class="n">Draws</th></tr></thead>
        <tbody>${d.rows.slice(0,150).map(r=>`<tr class="click" data-sku="${esc(r.sku_key)}" data-sup="${esc(r.supplier||'')}">
          <td class="em mono">${esc(r.sku)}</td><td>${esc(r.supplier||'')}</td>
          <td class="n">+${r.week_index}</td><td class="n">${d10(r.week_ending)}</td>
          <td class="n" ${r.soh<=0?'style="color:#9c0006;font-weight:600"':''}>${n0(r.soh)}</td>
          <td class="n">${n1(r.wk_avg)}</td><td class="n">${n0(r.incoming)}</td><td class="n">${n0(r.draws)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => { const tr = e.target.closest('tr[data-sku]'); if (tr) jumpSupply(tr.dataset.sup, tr.dataset.sku); };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

async function ovInbound() {
  try {
    const d = await api('/overview/inbound');
    const max = Math.max(...d.byWeek.map(w => Number(w.value_aud)||0), 1);
    const totalVal = d.byWeek.reduce((s,w)=>s+(Number(w.value_aud)||0),0);
    const overdue = d.byWeek.reduce((s,w)=>s+w.overdue_lines,0);
    const noVessel = d.byWeek.reduce((s,w)=>s+w.no_vessel,0);
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(aud(totalVal),'On the water',`${n0(d.byWeek.reduce((s,w)=>s+w.po_lines,0))} open PO lines across ${d.bySupplier.length} suppliers`)}
        ${tile(n0(overdue),'Lines past their due date','promised and not here — chase these','bad')}
        ${tile(n0(noVessel),'Lines with no vessel','booked quantity with no shipment attached','warn')}
      </div>
      <div class="sp-panel">
        <h4>Arriving by week <span>value in AUD, from the due date</span></h4>
        <div class="in"><div class="bars">${d.byWeek.map(w=>{
          const late = w.overdue_lines > 0;
          return `<div class="bar ${late?'late':''}" title="${d10(w.week_ending)} — ${aud(w.value_aud)}, ${w.po_lines} lines${late?`, ${w.overdue_lines} overdue`:''}">
            <span class="v" style="height:${Math.round(((Number(w.value_aud)||0)/max)*88)}%"></span>
            <span class="l">${dSh(w.week_ending)}</span></div>`;}).join('')}</div></div>
      </div>
      <div class="sp-panel">
        <h4>By supplier</h4>
        <table><thead><tr><th>Supplier</th><th class="n">POs</th><th class="n">Lines</th><th class="n">Units</th>
          <th class="n">Value</th><th class="n">Next due</th><th class="n">Overdue</th><th class="n">No vessel</th></tr></thead>
        <tbody>${d.bySupplier.map(s=>`<tr class="click" data-sup="${esc(s.supplier_code||'')}">
          <td class="em">${esc(s.supplier_code||'—')}</td><td class="n">${s.pos}</td><td class="n">${s.lines}</td>
          <td class="n">${n0(s.units)}</td><td class="n">${aud(s.value_aud)}</td><td class="n">${d10(s.next_due)}</td>
          <td class="n" ${s.overdue?'style="color:#9c0006;font-weight:600"':''}>${s.overdue||''}</td>
          <td class="n" ${s.no_vessel?'style="color:#9c5700"':''}>${s.no_vessel||''}</td></tr>`).join('')}</tbody></table>
      </div>
      ${d.overdue.length ? `<div class="sp-panel"><h4>Overdue lines <span>oldest first</span></h4>
        <table><thead><tr><th>PO</th><th>Supplier</th><th>SKU</th><th class="n">Qty</th>
          <th class="n">Due</th><th class="n">Days late</th><th>Vessel</th></tr></thead>
        <tbody>${d.overdue.map(r=>`<tr><td class="em mono">${esc(r.po_number)}</td><td>${esc(r.supplier_code||'')}</td>
          <td class="mono">${esc(r.sku)}</td><td class="n">${n0(r.qty)}</td><td class="n">${d10(r.due_date)}</td>
          <td class="n" style="color:#9c0006;font-weight:600">${r.days_late}</td><td>${esc(r.vessel||'')}</td></tr>`).join('')}</tbody></table>
      </div>` : ''}`;
    $('#ovBody').onclick = e => { const tr = e.target.closest('tr[data-sup]'); if (tr) { S.pos.supplier = tr.dataset.sup; $('#poSupplier').value = tr.dataset.sup; show('pos'); } };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

async function ovDemand() {
  try {
    const d = await api('/overview/demand-book');
    const wk = d.byWeek.slice(0, 26);
    const max = Math.max(...wk.map(w => Number(w.units)||0), 1);
    const held180 = d.held.find(h => h.age_band === '180+ days');
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(n0(wk.reduce((s,w)=>s+Number(w.units),0)),'Dated demand, next 26 weeks','project draws with a pick date — firm, and in the plan')}
        ${tile(n0(d.undated.units),'No pick date',`${d.undated.skus} SKUs · known demand, never dropped into a week`,'warn')}
        ${held180 ? tile(n0(held180.units_held),'Held over 180 days',`${held180.lines} lines for ${held180.customers} customers — stock that stopped`,'bad') : ''}
      </div>
      <div class="sp-panel">
        <h4>Project demand by week <span>the TBA bar sits apart on purpose — it belongs to no week</span></h4>
        <div class="in"><div class="bars">
          ${wk.map(w=>`<div class="bar" title="${d10(w.week_ending)} — ${n0(w.units)} units, ${w.draws} draws, ${w.projects} projects">
            <span class="v" style="height:${Math.round((Number(w.units)/max)*88)}%"></span>
            <span class="l">${dSh(w.week_ending)}</span></div>`).join('')}
          <div style="width:14px"></div>
          <div class="bar" style="max-width:34px" title="${n0(d.undated.units)} units with no date">
            <span class="v" style="height:${Math.round((Number(d.undated.units)/max)*88)}%;background:#9c5700;opacity:.75"></span>
            <span class="l">TBA</span></div>
        </div></div>
      </div>
      <div class="sp-panel">
        <h4>Undated demand by customer <span>who to chase for a date</span></h4>
        <table><thead><tr><th>Customer</th><th class="n">Projects</th><th class="n">Draws</th>
          <th class="n">Units</th><th class="n">Oldest order</th><th class="n">Age</th></tr></thead>
        <tbody>${d.tba.map(c=>`<tr><td class="em">${esc(c.customer)}</td><td class="n">${c.projects}</td>
          <td class="n">${c.tba_draws}</td><td class="n">${n0(c.tba_units)}</td><td class="n">${d10(c.oldest_order)}</td>
          <td class="n" ${c.oldest_age_days>365?'style="color:#9c0006;font-weight:600"':''}>${c.oldest_age_days} d</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="sp-panel">
        <h4>Held stock, by age <span>picked and packed, still sitting</span></h4>
        <table><thead><tr><th>Age</th><th class="n">Lines</th><th class="n">Units held</th><th class="n">Customers</th></tr></thead>
        <tbody>${d.held.map(h=>`<tr class="click" data-held="1"><td class="em">${esc(h.age_band)}</td><td class="n">${h.lines}</td>
          <td class="n" ${h.band_order>=4?'style="color:#9c0006;font-weight:600"':''}>${n0(h.units_held)}</td>
          <td class="n">${h.customers}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => { if (e.target.closest('tr[data-held]')) {
      S.projects.only = 'held'; $$('.sp-view[data-view=projects] .sp-chip').forEach(c => c.classList.toggle('is-on', c.dataset.only==='held')); show('projects'); } };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

async function ovSignal() {
  try {
    const d = await api('/overview/demand-signal');
    const g = k => d.summary.find(s => s.verdict === k) || { skus:0, value_aud:0 };
    const over = g('over-forecast'), none = g('forecast, no sales'), under = g('under-forecast'), miss = g('sales, no forecast');
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(n0(over.skus),'Wk/Avg more than double actual','buying to a number the sales do not support','warn')}
        ${tile(n0(none.skus),'Forecast, no sales in 9 weeks','carrying cover for demand that is not arriving','bad')}
        ${tile(n0(under.skus),'Selling faster than forecast','these run out earlier than the grid says','bad')}
        ${tile(n0(miss.skus),'Selling with no Wk/Avg','invisible to the planning grid','warn')}
        ${d.age ? tile(n0(d.age.stale_365),'Untouched over a year',`average across all of them: ${n0(d.age.avg_days)} days since anyone edited the number`,'warn') : ''}
      </div>
      <div class="sp-panel">
        <h4>Wk/Avg against actual sales
          <span>Wk/Avg is typed by hand — 837 blocks checked in the workbook, not one formula. It drives every purchase and had never been measured.
          Window: last ${d.window_weeks} complete weeks, project orders excluded so draws are not counted twice.</span></h4>
        <table><thead><tr><th>SKU</th><th>Supplier</th><th class="n">Typed</th><th class="n">Actual/week</th>
          <th class="n">Gap</th><th class="n">Gap %</th><th class="n">Untouched</th><th class="n">Stock value</th><th>Reading</th></tr></thead>
        <tbody>${d.rows.map(r=>`<tr class="click" data-sku="${esc(r.sku_key)}" data-sup="${esc(r.supplier_code||'')}">
          <td class="em mono">${esc(r.sku)}</td><td>${esc(r.supplier_code||'')}</td>
          <td class="n">${n1(r.typed)}</td><td class="n">${n1(r.actual)}</td>
          <td class="n" style="color:${Number(r.gap)<0?'#9c5700':'#9c0006'}">${n1(r.gap)}</td>
          <td class="n">${r.gap_pct==null?'':r.gap_pct+'%'}</td>
          <td class="n"${r.days_since_touched>365?' style="color:#9c0006;font-weight:600"':''} title="${esc(r.touched_by||'')}">${r.days_since_touched==null?'':n0(r.days_since_touched)+' d'}</td>
          <td class="n">${aud(r.stock_value_aud)}</td><td>${esc(r.reading)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => { const tr = e.target.closest('tr[data-sku]'); if (tr) jumpSupply(tr.dataset.sup, tr.dataset.sku); };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

async function ovDead() {
  try {
    const d = await api('/overview/dead-stock');
    const g = k => d.totals.find(t => t.lifecycle_status === k) || { skus:0, with_stock:0, units:0, value_aud:0, still_forecast:0 };
    const disc = g('DISCONTINUED'), run = g('RUN_OUT');
    const total = Number(disc.value_aud||0) + Number(run.value_aud||0);
    $('#ovBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(aud(total),'Money in product we stopped selling','still on the shelf, still counted in stock value','bad')}
        ${tile(n0(disc.skus),'Discontinued',`${disc.with_stock} still hold stock · ${n0(disc.units)} units`,'bad')}
        ${tile(n0(run.skus),'Run-out',`selling down, never reordered · ${n0(run.units)} units`,'warn')}
        ${tile(n0(Number(disc.still_forecast||0)+Number(run.still_forecast||0)),'Still carry a Wk/Avg','the typed forecast outlived the decision','warn')}
      </div>
      <div class="sp-panel">
        <h4>By supplier <span>where the dead money sits</span></h4>
        <table><thead><tr><th>Supplier</th><th class="n">SKUs</th><th class="n">Units</th><th class="n">Value</th></tr></thead>
        <tbody>${d.supplier.map(s=>`<tr class="click" data-sup="${esc(s.supplier_code)}">
          <td class="em">${esc(s.supplier_code)}</td><td class="n">${s.skus}</td>
          <td class="n">${n0(s.units)}</td><td class="n">${aud(s.value_aud)}</td></tr>`).join('')}</tbody></table>
      </div>
      ${d.conflicts.length ? `<div class="sp-panel">
        <h4>Where Cin7 and we disagree <span>this is the useful half of the Cin7 status — it marks Deprecated only after stock hits zero</span></h4>
        <table><thead><tr><th>SKU</th><th>Supplier</th><th>We say</th><th>Cin7 says</th><th class="n">Stock</th><th class="n">Selling/wk</th><th>Reading</th></tr></thead>
        <tbody>${d.conflicts.map(c=>`<tr class="click" data-sku="${esc(c.sku)}" data-sup="${esc(c.supplier_code||'')}">
          <td class="em mono">${esc(c.sku)}</td><td>${esc(c.supplier_code||'')}</td>
          <td>${esc(c.lifecycle_status)}</td><td>${esc(c.cin7_status||'')}</td>
          <td class="n">${n0(c.soh_available)}</td><td class="n">${n1(c.actual_wk)}</td>
          <td>${esc(c.conflict)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="sp-panel">
        <h4>The stock itself <span>biggest value first</span></h4>
        <table><thead><tr><th>SKU</th><th>Supplier</th><th>Status</th><th>Replaced by</th>
          <th class="n">Units</th><th class="n">Unit cost</th><th class="n">Value</th><th>Why</th></tr></thead>
        <tbody>${d.rows.map(r=>`<tr class="click" data-sku="${esc(r.sku)}" data-sup="${esc(r.supplier_code||'')}">
          <td class="em mono">${esc(r.sku)}</td><td>${esc(r.supplier_code||'')}</td>
          <td>${esc(r.lifecycle_status)}</td><td>${esc(r.superseded_by)||''}</td>
          <td class="n">${n0(r.soh_available)}</td><td class="n">${r.unit_cost_aud?aud(r.unit_cost_aud):''}</td>
          <td class="n">${aud(r.stock_value_aud)}</td>
          <td style="color:var(--mut-2);font-size:11.5px">${esc(String(r.lifecycle_note||'').slice(0,60))}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => {
      const tr = e.target.closest('[data-sku]');
      if (tr) return jumpSupply(tr.dataset.sup, tr.dataset.sku);
      const su = e.target.closest('[data-sup]');
      if (su) return jumpSupply(su.dataset.sup, '');
    };
  } catch (e) { $('#ovBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

function jumpSupply(sup, sku) {
  S.supply.supplier = sup || ''; S.supply.q = sku || '';
  $('#spSupplier').value = S.supply.supplier; $('#spSearch').value = S.supply.q;
  show('supply');
}

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

$('#pjSearch').addEventListener('input', debounce(e => { S.projects.q = e.target.value; loadProjects(); }));
$('#pjStatus').addEventListener('change', e => { S.projects.status = e.target.value; loadProjects(); });
$('#pjRep').addEventListener('change', e => { S.projects.rep = e.target.value; loadProjects(); });
$('#pjBranch').addEventListener('change', e => { S.projects.branch = e.target.value; S.projects.offset = 0; loadProjects(); });
$('#pjFilters').addEventListener('click', e => { e.currentTarget.classList.toggle('is-on'); renderProjects(); });
$$('.sp-view[data-view=projects] .sp-chip').forEach(c => c.addEventListener('click', () => {
  const on = S.projects.only === c.dataset.only;
  S.projects.only = on ? '' : c.dataset.only;
  $$('.sp-view[data-view=projects] .sp-chip').forEach(x => x.classList.toggle('is-on', !on && x === c));
  loadProjects();
}));
$('#pjGrid').addEventListener('input', e => {
  const f = e.target.closest('[data-f]'); if (!f) return;
  S.projects.col[f.dataset.f] = f.value;
  clearTimeout(window.__fT); window.__fT = setTimeout(() => {
    const active = document.activeElement?.dataset?.f;
    renderProjects();
    if (active) { const el = $(`[data-f="${active}"]`); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
  }, 200);
});
$('#pjGrid').addEventListener('click', e => {
  const dz = e.target.closest('[data-draws]'); if (dz) return toggleDraws(+dz.dataset.draws);
  const pb = e.target.closest('[data-project]'); if (pb) return openProject(+pb.dataset.project);
});

/* ── edição inline ──────────────────────────────────────────────────── */
const before = new WeakMap();
document.addEventListener('focusin', e => { const c = e.target.closest('.sp-cell'); if (c) before.set(c, c.textContent); });
document.addEventListener('keydown', e => {
  const c = e.target.closest('.sp-cell'); if (!c) return;
  if (e.key === 'Enter') { e.preventDefault(); c.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); c.textContent = before.get(c)||''; c.dataset.skip='1'; c.blur(); }
  else if (e.key === 'Tab') {
    const cells = $$('.sp-cell', c.closest('tbody')||document);
    const i = cells.indexOf(c) + (e.shiftKey ? -1 : 1);
    if (cells[i]) { e.preventDefault(); c.blur(); cells[i].focus(); }
  }
});
document.addEventListener('focusout', async e => {
  const c = e.target.closest('.sp-cell'); if (!c) return;
  if (c.dataset.skip) { delete c.dataset.skip; return; }
  const was = before.get(c); const now = c.textContent.trim();
  if (was === undefined || now === was.trim()) return;
  const field = c.dataset.field;
  let value = now;
  if (c.dataset.kind === 'num')  value = now === '' ? 0 : Number(now.replace(/[^0-9.-]/g,''));
  if (c.dataset.kind === 'date') value = parseDate(now);
  if (c.dataset.kind === 'num' && isNaN(value)) { c.classList.add('bad'); return toast('Not a number', true); }
  if (c.dataset.kind === 'date' && now && !value) { c.classList.add('bad'); return toast('Use dd/mm/yyyy', true); }
  c.classList.add('busy');
  try {
    const t = c.dataset.line ? `/lines/${c.dataset.line}` : c.dataset.po ? `/po-lines/${c.dataset.po}`
            : `/skus/${encodeURIComponent(c.dataset.sku)}`;
    const upd = await api(t, { method:'PATCH', body: JSON.stringify({ [field]: value }) });
    c.classList.replace('busy','ok'); setTimeout(()=>c.classList.remove('ok'), 1000);
    before.set(c, c.textContent);
    if (c.dataset.line) { const i = pjRows.findIndex(r=>r.id===+c.dataset.line);
      if (i>=0) { pjRows[i] = { ...pjRows[i], ...upd, draws: pjRows[i].draws }; renderProjects(); } }
  } catch (err) {
    c.classList.replace('busy','bad'); c.textContent = was;
    toast('Not saved: ' + err.message, true); setTimeout(()=>c.classList.remove('bad'), 2500);
  }
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

/* ═══ SUPPLY PLANNING ═══════════════════════════════════════════════ */
/* O bloco de 5 linhas da aba de fornecedor: Opening / Inventory In /
   Inventory-Sales Out / Project orders / Closing. Colapsado mostra só o
   fechamento; "Show the working" abre a conta inteira, como no Excel. */
let spData = null;
async function loadSupply() {
  const s = S.supply;
  // Os modos de visão atravessam fornecedor. "O que está chegando" e "o que
  // não tem previsão" são perguntas do estoque inteiro, e obrigar a escolher
  // um fornecedor antes as tornaria impossíveis de fazer.

  // 600 cobre o maior fornecedor inteiro. Com 300, 36 das 57 linhas vermelhas
  // do CGD ficavam fora da tela — o selo existia e ninguém via.
  const qs = new URLSearchParams({ weeks:s.weeks, limit:500 });
  if (s.supplier) qs.set('supplier', s.supplier);
  if (s.view) qs.set('view', s.view);
  if (s.line) qs.set('line', s.line);
  if (s.scope) qs.set('scope', s.scope);
  if (s.sort === 'risk') qs.set('sort','risk');
  if (s.q) qs.set('q', s.q);
  if (s.risk) qs.set('only','risk');
  if (s.life) qs.set('lifecycle', s.life);
  $('#spCount').textContent = 'calculating…';
  try {
    // O passado é uma consulta separada de propósito: ele é REALIZADO e a grade
    // é PROJETADO. Misturar os dois no mesmo motor faria o realizado virar
    // entrada de uma recursão que ele não deve alimentar.
    const [proj, hist] = await Promise.all([
      api('/planning?' + qs),
      s.back ? api('/planning/history?' + qs + '&back=' + s.back).catch(() => null) : null,
    ]);
    spData = proj;
    const mudou = (hist ? hist.weeks.length : 0) !== (spHist ? spHist.weeks.length : 0);
    spHist = hist;
    if (mudou) spAnchor = true;
    // O servidor corta em 500 por página. Mostrar "500 of 1.951" sem explicar
    // faria a lista parecer completa para quem só olha a primeira tela.
    const cortou = spData.rows.length < spData.total;
    // E preciso dizer por QUE criterio a pagina cortou. No modo "specials"
    // todos tem mths_stock nulo, entao a ordem cai para o SKU — chamar isso de
    // "os de maior risco" seria descrever uma ordem que nao aconteceu.
    const criterio = S.supply.view === 'special' ? 'first 500 by SKU'
      : S.supply.sort === 'risk' ? `${n0(spData.rows.length)} at most risk`
      : `${n0(spData.rows.length)} with the least cover`;
    $('#spCount').textContent = `${n0(spData.rows.length)} of ${n0(spData.total)} SKUs`
      + (cortou ? ` — the ${criterio}; narrow by supplier or line to see the rest` : '')
      + (spData.bom_universe ? ` — the ${n0(spData.total)} assembled products in the planning file, of ${n0(spData.bom_universe)} in Cin7` : '')
      + (S.supply.view && S.supply.view !== 'bom' ? ` · ${VIEW_WHY[S.supply.view]}` : '')
      + ` · ${spData.ms} ms`
      + (hist ? ` · ${hist.weeks.length} wk back in ${hist.ms} ms` : '');
    // O seletor vem da rota: as filiais e as redes são definidas lá, e
    // duplicar a lista aqui garantiria que uma das duas ficasse velha.
    const sel = $('#spScope');
    if (spData.scopes && sel.options.length <= 1) {
      sel.innerHTML = '<option value="">Planning file (buy)</option>'
        + spData.scopes.map(x => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join('');
      sel.value = S.supply.scope || '';
    }
    scopeNote(spData.scope);
    renderSupply();
  } catch (e) { $('#spCount').textContent=''; toast(e.message, true); }
}
let spHist = null;
let spAnchor = false;
// Índice por SKU para a grade não varrer o array a cada linha.
const histFor = (k) => {
  if (!spHist) return null;
  if (!spHist._idx) spHist._idx = spHist.rows.reduce((m, r) => (m[r.sku_key] = r.cells, m), {});
  return spHist._idx[k] || null;
};
// A fronteira do que sabemos. Fora dela a célula diz "sem registro", não "0".
const histKnown = (src, week) => {
  const c = spHist && spHist.coverage && spHist.coverage[src];
  return !!c && week >= c.first_week && week <= c.last_week;
};
/* O selo de montado. Só aparece quando há BOM, e o número que ele carrega é
   quantos pais dá para montar HOJE com o componente que está em Main — que é a
   pergunta que o planejador faz. Medido: 1.154 produtos aparecem com estoque
   zero e já dão para montar, ou seja, a tela dizia "compre" com a peça na
   prateleira. */
const bomMark = (r) => !r.bom ? '' :
  `<span class="ui-tag bom-mark" title="Assembled from ${r.bom.length} component${r.bom.length>1?'s':''}${
    r.bom_build!=null ? ` — ${n0(r.bom_build)} can be built right now from what is in Main` : ''}">BOM${
    r.soh<=0 && r.bom_build>0 ? ` · build ${n0(r.bom_build)}` : ''}</span>`;

/* Os componentes ficam SOB o produto montado, dentro da mesma expansão em que
   já mora o cálculo. Cada um traz o próprio estoque, porque a lista sem o
   estoque ao lado é enciclopédia e não decisão. */
function bomRows(r) {
  if (!r.bom || !r.bom.length) return '';
  const colspan = 7;
  // Marcar o gargalo só informa quando ele DISTINGUE. Com todos os componentes
  // empatados — o caso comum aqui, todos em 0 — a marca ia para 404 das 609
  // linhas e deixava de significar "olhe este".
  const empatado = new Set(r.bom.map((c) => c.build)).size <= 1;
  return r.bom.map((c) => {
    const gargalo = !empatado && c.build != null && c.build === r.bom_build;
    return `<tr class="wrk bom-row${gargalo ? ' is-tight' : ''}">
      <td class="lbl" colspan="${colspan}">
        <span class="bom-qty">${n0(c.qty)}&times;</span>
        <b data-goto="${esc(c.sku)}" class="mono">${esc(c.sku)}</b>
        <span class="bom-name">${esc(c.name || '')}</span>
        ${c.life === 'DISCONTINUED' ? '<span class="ui-tag ui-tag--neutral">DISC</span>' : ''}
        <span class="bom-soh${c.neg ? ' is-neg' : ''}"${c.neg
          ? ' title="Main is negative for this component — oversold in the ERP. It cannot build anything, and the negative itself needs fixing."' : ''
          }>Main <b>${n0(c.main)}</b>${c.soh !== c.main ? ` · all ${n0(c.soh)}` : ''}</span>
        ${c.build != null ? `<span class="bom-build${gargalo ? ' tight' : ''}"
          title="${gargalo ? 'This is the component that limits the build' : 'How many parents this component alone allows'}"
          >builds ${n0(c.build)}</span>` : ''}
      </td></tr>`;
  }).join('');
}

/* O modo escolhido tem que se explicar. "647 SKUs" sem dizer o que os une é
   um número solto; o que informa é por que eles estão juntos. */
const VIEW_WHY = {
  coming:  'these have a purchase order on the way',
  special: 'no weekly average — the engine cannot project these, and they sink to the bottom of every risk sort',
  project: 'project demand is committed against these',
};

/* O aviso do escopo. Ele existe por um fato medido e não por prudência: não
   há UMA alocação de PO por filial gravada — 0 de 1.466 linhas em aberto. O
   contêiner chega no Main e é distribuído depois. Então dentro de um escopo de
   filial a coluna Incoming continua sendo a do Main, e sem dizer isso o
   planejador contaria como se a carga já fosse dele. */
function scopeNote(sc) {
  const el = $('#spScopeNote');
  if (!sc) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>${esc(sc.label)}</b> — stock and demand are this scope's`
    + ` (${sc.codes.join(' + ')}), measured over the last ${sc.months} months`
    + ` and counting a sale when the location <em>or</em> the rep belongs here.`
    + (sc.incoming_is_main
      ? ` <span class="sp-note-warn">Incoming is still the Main Warehouse's: no purchase order is allocated to a branch yet, so what is on the water is not this scope's until someone splits it.</span>`
      : '');
}

const WRK = [
  ['r-open', 'Opening Inventory Level', c => c.o],
  ['r-in',   'Inventory In:',           c => c.i],
  ['r-out',  'Inventory/Sales Out',     c => c.s],
  ['r-proj', 'Project orders',          c => c.d],
  ['r-close','Closing Inventory Level', c => c.c],
];
/* Uma vez abaixo do alvo, o SKU segue abaixo — pintar as vinte semanas
   seguintes não acrescenta informação, só ruído. O que informa é ONDE
   cruzou. Então marca-se cada travessia, não cada semana. */
function markCrossings(cells) {
  let wasLow = false, wasNeg = false;
  return cells.map(c => {
    const negEdge = c.neg && !wasNeg;
    const lowEdge = c.low && !c.neg && !wasLow;
    wasNeg = c.neg; wasLow = c.low;
    return { ...c, negEdge, lowEdge };
  });
}

// Qual número do realizado cada linha de trabalho mostra, e de qual fonte ele
// vem — porque a cobertura de cada fonte é diferente e a célula precisa saber
// se está fora dela. Opening e Closing ficam de fora: dependem de reconstruir
// o estoque para trás, e isso é o back-test do backfill, não esta tela.
const HPICK = { 'r-in':['recv','receipts'], 'r-out':['sold','sales'], 'r-proj':['proj','projects'] };

function renderSupply() {
  const d = spData; if (!d) return;
  const W = d.weeks;
  const HW = (spHist && spHist.weeks) || [];
  const head = `<thead><tr>
    <th style="width:190px">SKU</th><th class="n" style="width:${spData.scope?116:70}px">SOH</th>
    <th class="n" style="width:${spData.scope?104:62}px">Wk/Avg</th><th class="n" style="width:52px">Mths</th>
    <th class="n" style="width:60px">TBA</th><th class="n" style="width:74px">Incoming</th>
    <th class="n" style="width:52px">Target</th>
    ${HW.map(w=>`<th class="wk pastw" title="Realizado — o que de fato aconteceu nesta semana">
      ${dSh(w.week_ending)}<small>actual</small></th>`).join('')}
    ${W.map((w,i)=>`<th class="wk ${i===0?'rep':''} ${Number(w.factor)!==1?'cny':''}" title="${esc(w.factor_reason||'')}">
      ${dSh(w.week_ending)}<small>${i===0?'reporting':Number(w.factor)!==1?Math.round(w.factor*100)+'%':'&nbsp;'}</small></th>`).join('')}
  </tr></thead>`;
  const bodies = d.rows.map(r0 => {
    const r = { ...r0, cells: markCrossings(r0.cells) };
    const open = S.supply.expandAll || S.supply.open[r.sku_key];
    const m = r.summary;
    const lc = r.lifecycle_status === 'RUN_OUT' ? 'lc-runout'
             : r.lifecycle_status === 'DISCONTINUED' ? 'lc-disc' : '';
    const lcMark = r.lifecycle_status === 'RUN_OUT'
        ? `<span class="ui-tag ui-tag--warn lc-mark" data-life="${esc(r.sku_key)}" title="${esc(r.lifecycle_note||'Selling what is left; not reordered')}">RUN-OUT</span>`
      : r.lifecycle_status === 'DISCONTINUED'
        ? `<span class="ui-tag ui-tag--neutral lc-mark" data-life="${esc(r.sku_key)}" title="${esc(r.lifecycle_note||'Discontinued')}">DISC</span>`
        : '';
    const sup = r.superseded_by
        ? `<span class="sup-to">→ <b data-goto="${esc(r.superseded_by)}">${esc(r.superseded_by)}</b></span>` : '';
    const skuRow = `<tr class="sk ${lc}" data-sku="${esc(r.sku_key)}">
      <td class="em"><button class="tog" data-tog="${esc(r.sku_key)}">${open?'▾':'▸'}</button><span class="mono sku-code">${esc(r.sku)}</span>${lcMark}${badgeMark(r)}${bomMark(r)}${sup}${r.line?`<span class="sp-line" title="Product line">${esc(r.line)}</span>`:''}</td>
      <td class="n mono"${r.soh<=0?' style="color:#9c0006;font-weight:700"':''}>${n0(r.soh)}${
        r.file_soh!=null&&r.file_soh!==r.soh
          ? `<span class="meas" title="the whole company holds ${n0(r.file_soh)}">${n0(r.file_soh)}</span>` : ''}</td>
      <td class="n${r.badge_drift?' drift':''}"${r.badge_drift?` title="${esc(r.badge_why||'')}"`:''}
        >${r.scope_wk!=null ? n1(r.scope_wk) : cellSku(r,'wk_avg',n1(r.wk_avg))}${
          r.scope_wk!=null && r.file_wk!=null
            ? `<span class="meas" title="the planning file says ${n1(r.file_wk)} a week for the whole company${
                r.scope_by_rep ? ` · ${r.scope_by_rep} of ${r.scope_by_loc+r.scope_by_rep} sale lines here came in through a rep, shipped from Main` : ''}">${n1(r.file_wk)}</span>` : ''}${r.scope_wk==null && r.badge_drift
          // O digitado fica editável; a venda medida entra ao lado, fantasma.
          // Sem isto, 50 linhas de NO FORECAST abrem a tela mostrando zero em
          // tudo — e zero é exatamente o que o planejador ignora.
          ? `<span class="meas" title="venda medida nas últimas 13 semanas">${n1(r.badge_rate)}</span>` : ''}</td>
      <td class="n mono"${m.mthsStock!=null&&m.mthsStock<1?' style="color:#9c0006;font-weight:700"':''}>${m.mthsStock==null?'—':n1(m.mthsStock)}</td>
      <td class="n mono"${m.undatedQty?' style="color:#9c5700;font-weight:600"':' class="n mono faint"'}>${m.undatedQty?n0(m.undatedQty):'—'}</td>
      <td class="n mono">${m.totalIncoming?n0(m.totalIncoming):''}</td>
      <td class="n">${cellSku(r,'target_cover_weeks',r.target_cover_weeks)}</td>
      ${(() => { const H = histFor(r.sku_key);
        // Na linha fechada o passado mostra a VENDA realizada: é o número que o
        // planejador compara com o Wk/Avg que ele mesmo digitou ao lado.
        return HW.map((w, i) => {
          const h = H && H[i];
          if (!histKnown('sales', w.week_ending))
            return `<td class="wk pastw nodata" title="Sem registro de venda nesta semana — a série começa em ${esc((spHist.coverage.sales||{}).first_week||'?')}">·</td>`;
          return `<td class="wk pastw" title="realizado · vendido ${n0(h?h.sold:0)} · recebido ${n0(h?h.recv:0)} · projeto ${n0(h?h.proj:0)}">${n0(h?h.sold:0)}</td>`;
        }).join(''); })()}
      ${r.cells.map((c,i)=>open
        ? `<td class="wk ${i===0?'rep':''} faint"></td>`
        : `<td class="wk ${i===0?'rep':''} ${c.neg?'neg':''} ${c.lowEdge?'low':''} ${c.i?'has-in':''} ${c.d?'has-dr':''} ${isOpenCell(r.sku_key,c.w)?'is-open':''}"
             data-week="${c.w}" title="opening ${n0(c.o)} · in ${n0(c.i)} · sales ${n1(c.s)} · project ${n0(c.d)}${c.lowEdge?' — drops below target cover here':''}">${n0(c.c)}</td>`).join('')}
    </tr>`;
    if (!open) return `<tbody>${skuRow}</tbody>`;
    const H = histFor(r.sku_key);
    const work = WRK.map(([cls,label,pick]) => `<tr class="wrk ${cls} ${cls==='r-close'?'close':''}">
      <td class="lbl" colspan="7">${label}</td>
      ${HW.map((w,i)=>{
        const pk = HPICK[cls];
        // Opening e Closing não têm passado: exigem reconstruir o estoque para
        // trás. Marcar como vazio é honesto; preencher seria inventar.
        if (!pk) return `<td class="wk pastw nodata" title="O estoque do passado ainda não foi reconstruído">·</td>`;
        if (!histKnown(pk[1], w.week_ending))
          return `<td class="wk pastw nodata" title="Sem registro desta fonte nesta semana">·</td>`;
        const v = H && H[i] ? H[i][pk[0]] : 0;
        return `<td class="wk pastw">${v===0?'<span class="faint">0</span>':n0(v)}</td>`;
      }).join('')}
      ${r.cells.map((c,i)=>{
        const v = pick(c);
        const isClose = cls === 'r-close';
        return `<td class="wk ${i===0?'rep':''} ${isClose&&c.neg?'neg':''} ${isClose&&c.lowEdge?'low':''} ${isClose&&isOpenCell(r.sku_key,c.w)?'is-open':''}"
          ${isClose?`data-week="${c.w}"`:''}>${v===0?'<span class="faint">0</span>':cls==='r-out'?n1(v):n0(v)}</td>`;
      }).join('')}</tr>`).join('');
    return `<tbody>${skuRow}${bomRows(r)}${work}</tbody>`;
  }).join('');
  $('#spGrid').innerHTML = head + bodies;

  // O pedido era "ver o passado SEM perder o foco na semana atual". Com 26
  // colunas de realizado à esquerda, a semana de reporte nasceria fora da tela.
  // Ancorar só quando o histórico muda: depois disso a rolagem é do usuário.
  if (spAnchor) {
    spAnchor = false;
    const rep = $('#spGrid').querySelector('th.wk.rep');
    const box = $('#spGrid').closest('.sp-scroll');
    if (rep && box) {
      // offsetLeft mede contra o offsetParent, que aqui não é a caixa que rola —
      // por isso o primeiro salto erra. Medir a posição real e corrigir acerta
      // sem depender de qual ancestral está posicionado.
      box.scrollLeft = Math.max(0, rep.offsetLeft - FROZEN_PX);
      box.scrollLeft += rep.getBoundingClientRect().left
                      - box.getBoundingClientRect().left - FROZEN_PX;
    }
  }
}
// As 7 colunas fixas: 190+70+62+52+60+74+52. A rolagem para nesta borda para a
// semana de reporte encostar no congelado, e não sumir atrás dele.
const FROZEN_PX = 560;
// Três tons, todos já existentes. --warn está fora: o selo RUN-OUT já ocupa
// laranja na MESMA célula, e 17 das linhas teriam dois chips laranja colados.
const BADGE = {
  'ORDER NOW':    ['danger',  'Vende, zera dentro da janela de pedido, e nada em trânsito.'],
  'CHASE PO':     ['danger',  'Vende e zera dentro da janela — mas o pedido já saiu. É cobrar prazo, não comprar.'],
  'NO FORECAST':  ['danger',  'Vende e zera dentro da janela, e a lista de compra não enxerga este SKU.'],
  'ORDER SOON':   ['info',    'Zera dentro do horizonte, ainda dá tempo de planejar.'],
  'FIX FORECAST': ['neutral', 'Tem previsão viva e não vendeu nada no trimestre: o cadastro contradiz a venda.'],
};
const badgeMark = (r) => {
  const b = BADGE[r.badge]; if (!b) return '';
  const why = r.badge_why ? ' ' + r.badge_why : '';
  return `<span class="ui-tag ui-tag--${b[0]} bdg" title="${esc(b[1] + why)}">${esc(r.badge)}</span>`;
};
const cellSku = (r, f, html) =>
  `<span class="sp-cell" contenteditable="plaintext-only" spellcheck="false"
     data-sku="${esc(r.sku_key)}" data-field="${f}" data-kind="num">${html==null?'':html}</span>`;

// Com 34 colunas, o painel abria mostrando um detalhe cuja célula de origem ninguém
// identificava. A marca sobrevive ao re-render porque mora no estado, não no DOM.
const isOpenCell = (sku, week) =>
  !!S.supply.cell && S.supply.cell.sku === sku && S.supply.cell.week === week;

// Expandir tudo era um atalho de leitura: enquanto ligado, o estado por linha ficava
// ignorado e clicar num chevron não fazia nada. Materializa o "todos abertos" em estado
// real antes de fechar um, para o clique voltar a responder.
function toggleSku(k) {
  if (S.supply.expandAll) {
    S.supply.expandAll = false;
    $('#spExpand').classList.remove('is-on');
    (spData?.rows || []).forEach(r => { S.supply.open[r.sku_key] = true; });
  }
  S.supply.open[k] = !S.supply.open[k];
  renderSupply();
}

$('#spSupplier').addEventListener('change', e => { S.supply.supplier = e.target.value; localStorage.setItem('sp.sup', e.target.value); loadSupply(); });
$('#spSearch').addEventListener('input', debounce(e => { S.supply.q = e.target.value; loadSupply(); }));
$('#spWeeks').addEventListener('change', e => { S.supply.weeks = +e.target.value; loadSupply(); });
$('#spBack').addEventListener('change', e => {
  S.supply.back = +e.target.value; localStorage.setItem('sp.back', e.target.value); loadSupply();
});
$('#spSort').addEventListener('click', e => {
  S.supply.sort = S.supply.sort === 'risk' ? '' : 'risk';
  localStorage.setItem('sp.sort', S.supply.sort);
  e.currentTarget.classList.toggle('is-on', S.supply.sort === 'risk');
  loadSupply();
});
$('#spRisk').addEventListener('click', e => { S.supply.risk = !S.supply.risk; e.currentTarget.classList.toggle('is-on', S.supply.risk); loadSupply(); });
$('#spLife').addEventListener('change', e => { S.supply.life = e.target.value; loadSupply(); });
$('#spLine').addEventListener('change', e => { S.supply.line = e.target.value; loadSupply(); });
$('#spScope').addEventListener('change', e => {
  S.supply.scope = e.target.value; localStorage.setItem('sp.scope', e.target.value); loadSupply();
});
$('#spView').addEventListener('change', e => {
  S.supply.view = e.target.value; localStorage.setItem('sp.view', e.target.value);
  // Entrar no modo BOM abre a expansão sozinho: o motivo de entrar nele é ver
  // os componentes, e obrigar a clicar 300 vezes seria esconder o que se pediu.
  S.supply.expandAll = e.target.value === 'bom';
  $('#spExpand').classList.toggle('is-on', S.supply.expandAll);
  loadSupply();
});
$('#spExpand').addEventListener('click', e => {
  S.supply.expandAll = !S.supply.expandAll;
  // Desligar precisa fechar de verdade: sem isto, as linhas abertas uma a uma
  // continuavam abertas e o botão parecia não fazer nada.
  if (!S.supply.expandAll) S.supply.open = {};
  e.currentTarget.classList.toggle('is-on', S.supply.expandAll);
  renderSupply();
});
$('#spGrid').addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { S.supply.q = g.dataset.goto; $('#spSearch').value = g.dataset.goto; return loadSupply(); }
  const lf = e.target.closest('[data-life]');
  if (lf) return openLifecycle(lf.dataset.life);
  const t = e.target.closest('[data-tog]');
  if (t) return toggleSku(t.dataset.tog);
  const td = e.target.closest('td.wk[data-week]');
  if (td) {
    S.supply.cell = { sku: td.closest('tbody').querySelector('tr.sk').dataset.sku, week: td.dataset.week };
    $('#spGrid').querySelectorAll('td.wk.is-open').forEach(x => x.classList.remove('is-open'));
    td.classList.add('is-open');
    return openWeek(S.supply.cell.sku, S.supply.cell.week);
  }
  // O alvo do chevron era 151 px². A célula do SKU é 72× maior. Fica na CÉLULA e não
  // na linha: os links de sucessão e de ciclo de vida já saíram acima, e a linha inteira
  // engoliria o drill-down das semanas e as duas células editáveis.
  const em = e.target.closest('tr.sk td.em');
  if (em && !String(window.getSelection())) return toggleSku(em.closest('tr.sk').dataset.sku);
});

async function openWeek(sku, week) {
  try {
    const d = await api(`/planning/${encodeURIComponent(sku)}/week/${week}`);
    const row = spData?.rows.find(r => r.sku_key === sku);
    const cell = row?.cells.find(c => c.w === week);
    const inQty = d.incoming.reduce((s,x)=>s+Number(x.qty),0);
    const drQty = d.draws.reduce((s,x)=>s+Number(x.qty),0);
    side(`${sku} · week ending ${d10(week)}`, `
      <table class="brk">
        ${cell ? `<tr><td>Opening</td><td>${n0(cell.o)}</td></tr>` : ''}
        <tr class="hd"><td>Inventory In</td><td>${inQty?'+'+n0(inQty):'—'}</td></tr>
        ${d.incoming.map(x=>`<tr class="sub"><td>${esc(x.po_number)}${x.vessel?` · ${esc(x.vessel)}`:''}</td><td>+${n0(x.qty)}</td></tr>`).join('')}
        <tr class="hd"><td>Inventory/Sales Out</td><td>&minus;${n1(d.expected_sales)}</td></tr>
        <tr class="sub"><td>Wk/Avg ${n1(d.sku?d.sku.wk_avg:0)} &times; ${Math.round(d.factor*100)}%${d.factor_reason?` · ${esc(d.factor_reason)}`:''}</td><td></td></tr>
        <tr class="hd"><td>Project orders</td><td>${drQty?'&minus;'+n0(drQty):'—'}</td></tr>
        ${d.draws.map(x=>`<tr class="sub"><td>${esc(x.sales_order)} · ${esc(x.customer||'')}${x.seq>1?` (draw ${x.seq})`:''}</td><td>&minus;${n0(x.qty)}</td></tr>`).join('')}
        ${cell ? `<tr class="tot"><td>Closing</td><td>${n0(cell.c)}</td></tr>` : ''}
      </table>
      ${d.sku && d.sku.undated_qty>0 ? `<h4>Outside every week</h4>
        <p style="color:#9c5700"><b>${n0(d.sku.undated_qty)}</b> units of project demand with no pick date.
        They stay visible in the TBA column and never land in an invented week.</p>`:''}
      <h4>Stock context</h4>
      <table class="brk">
        <tr><td>Company-wide (the basis)</td><td>${n0(d.sku?d.sku.soh_available:0)}</td></tr>
        <tr><td>Main</td><td>${n0(d.sku?d.sku.main_soh:0)}</td></tr>
        <tr><td>Gateway</td><td>${n0(d.sku?d.sku.gateway_soh:0)}</td></tr>
        <tr><td>Project commitment</td><td>${n0(d.sku?d.sku.project_orders:0)}</td></tr>
      </table>
      <h4>Who this demand belongs to</h4>
      <div id="sideDemand" class="sp-loading">loading…</div>
      <h4>Put this SKU in the cart</h4>
      <p class="faint">The buy list only suggests what the engine flagged. Anything you
        know needs ordering goes in from here.</p>
      <div class="cart-add">
        <input id="sideQty" type="number" min="1" step="1" placeholder="quantity">
        <button class="sp-btn" id="sideAdd" data-sku="${esc(sku)}"
          data-sup="${esc(row?row.supplier||'':'')}">Add to the ${esc(row&&row.supplier?row.supplier:'')} cart</button>
      </div>`);
    demandBreak(sku);
    const add = $('#sideAdd');
    if (add) add.addEventListener('click', async () => {
      const q = Number($('#sideQty').value);
      if (!isFinite(q) || q <= 0) { toast('Type how many first', true); return; }
      try {
        await addToCart(add.dataset.sup, [{ sku_key: add.dataset.sku, sku: add.dataset.sku,
          qty: q, source: 'manual' }], S.supply.scope || null);
        $('#sideQty').value = '';
      } catch (err) { toast(err.message, true); }
    });
  } catch (e) { toast(e.message, true); }
}

/* A decomposição da média por filial.
   O planejador só confia num número depois de responder "isso é venda de
   quem?", e sem a resposta na tela ele volta para a planilha. As duas colunas
   existem porque a diferença entre elas É a informação: onde a venda por rep é
   muito maior que a por depósito, aquela filial está sendo atendida do Main e
   a conta por local a subestima. */
async function demandBreak(sku) {
  const el = $('#sideDemand'); if (!el) return;
  try {
    const d = await api(`/planning/${encodeURIComponent(sku)}/demand?months=6`);
    if (!d.rows.length) { el.innerHTML = '<p class="faint">No sale in the last 6 months.</p>'; return; }
    const soma = d.rows.reduce((a, r) => a + r.total, 0);
    const sobra = Math.round(soma - d.total);
    const dentro = (S.supply.scope && spData.scope) ? spData.scope.codes : null;
    el.innerHTML = `<table class="brk">
      <tr class="hd"><td>Branch</td><td>from its depot</td><td>via its rep</td><td>a week</td></tr>
      ${d.rows.map(r => `<tr${dentro ? (dentro.includes(r.code) ? ' class="in-scope"' : ' class="out-scope"') : ''}>
        <td>${esc(r.name || r.code)}${dentro && dentro.includes(r.code) ? '<i class="dot"></i>' : ''}</td>
        <td>${r.by_loc ? n0(r.by_loc) : '<span class="faint">—</span>'}</td>
        <td${r.by_rep > r.by_loc ? ' class="lean"' : ''}
            title="${r.reps} rep${r.reps === 1 ? '' : 's'} of this branch sold it${
              r.by_rep > r.by_loc ? ' — more through reps than from its own depot, which means it ships from Main' : ''}"
          >${r.by_rep ? n0(r.by_rep) : '<span class="faint">—</span>'}</td>
        <td><b>${n1(r.wk)}</b></td></tr>`).join('')}
      <tr class="tot"><td>Sold in 6 months</td><td colspan="2">${n0(d.total)}</td><td><b>${n1(d.total / d.weeks)}</b></td></tr>
    </table>
    ${sobra > 0 ? `<p class="faint">The rows add to ${n0(soma)}, which is ${n0(sobra)} more than ${n0(d.total)}:
      a sale whose rep is from one branch and whose depot is another belongs to both, and is counted on both lines.</p>` : ''}
    ${d.unassigned.qty ? `<p class="faint">${n0(d.unassigned.qty)} units on ${n0(d.unassigned.lines)} lines
      belong to no branch — sold from Project Warehouse, or by a rep with no branch assigned.</p>` : ''}
    ${dentro ? `<p class="faint">The dot marks the branches inside <b>${esc(spData.scope.label)}</b>.</p>` : ''}`;
  } catch (e) { el.innerHTML = `<p class="faint">${esc(e.message)}</p>`; }
}

/** O planejador decide o ciclo de vida. O Cin7 só confirma depois — e
    confirma tarde: os 2.743 Deprecated dele têm todos estoque zero. */
async function openLifecycle(skuKey) {
  const r = spData?.rows.find(x => x.sku_key === skuKey);
  if (!r) return;
  side(`${r.sku} · lifecycle`, `
    <table class="brk">
      <tr><td>Current</td><td>${esc(r.lifecycle_status||'ACTIVE')}</td></tr>
      <tr><td>Cin7 says</td><td>${esc(r.cin7_status||'—')}</td></tr>
      <tr><td>Replaced by</td><td>${esc(r.superseded_by)||'—'}</td></tr>
      <tr><td>Stock on hand</td><td>${n0(r.soh)}</td></tr>
      <tr><td>Wk/Avg typed</td><td>${n1(r.wk_avg_input != null ? r.wk_avg_input : r.wk_avg)}</td></tr>
    </table>
    ${r.lifecycle_note ? `<p class="sp-hint">${esc(r.lifecycle_note)}</p>` : ''}
    <h4>Change it</h4>
    <label class="sp-field"><span>Status</span><select id="lcStatus">
      <option value="ACTIVE"${r.lifecycle_status==='ACTIVE'?' selected':''}>Active — buy normally</option>
      <option value="RUN_OUT"${r.lifecycle_status==='RUN_OUT'?' selected':''}>Run-out — sell what is left, stop buying</option>
      <option value="DISCONTINUED"${r.lifecycle_status==='DISCONTINUED'?' selected':''}>Discontinued — dead</option>
    </select></label>
    <label class="sp-field"><span>Replaced by</span><input id="lcSup" value="${esc(r.superseded_by)||''}" placeholder="SKU that takes over"></label>
    <label class="sp-field"><span>Note</span><input id="lcNote" value="${esc(r.lifecycle_note)||''}" placeholder="Why"></label>
    <button class="sp-btn is-primary" id="lcSave" data-sku="${esc(skuKey)}">Save</button>
    <p class="sp-hint">Run-out keeps selling the stock down but never asks to buy again.
    Discontinued also stops the weekly sale, so the balance stops decaying and the grid says
    “this is what is left and it is not moving”. Neither hides the money — it stays in the stock value.</p>`);
  $('#lcSave').onclick = async ev => {
    try {
      await api(`/skus/${encodeURIComponent(ev.currentTarget.dataset.sku)}/lifecycle`, { method:'PATCH',
        body: JSON.stringify({ lifecycle_status: $('#lcStatus').value,
          superseded_by: $('#lcSup').value.trim() || null, lifecycle_note: $('#lcNote').value.trim() || null }) });
      toast('Lifecycle saved'); $('#side').classList.remove('is-on'); loadSupply();
    } catch (e) { toast(e.message, true); }
  };
}

/* ═══ BUY ═══════════════════════════════════════════════════════════
   O passo que o Excel nunca deu. O ritual semanal terminava em "ler
   Analysis!F, decidir o que recomprar — e calcular a quantidade fora do
   Excel". Esta é a tela do fora-do-Excel.

   Cada linha se explica sozinha: quanto tem, quanto vende, quanto demora
   para chegar, qual é o pior ponto do saldo nessa janela, e por isso
   quantas caixas. Se o comprador não conseguir repetir a conta em voz
   alta, ele não vai confiar nela. */
let buyData = null;
async function loadBuy() {
  const qs = new URLSearchParams({ limit: 400 });
  if (S.buy.supplier) qs.set('supplier', S.buy.supplier);
  $('#byyBody').innerHTML = '<div class="sp-loading">Working out what to buy…</div>';
  try {
    buyData = await api('/buy-recommendation?' + qs);
    const pip = $('#pipBuy'); pip.textContent = n0(buyData.late); pip.classList.toggle('on', buyData.late > 0);
    renderBuy();
  } catch (e) { $('#byyBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}
/* ── O CARRINHO ───────────────────────────────────────────────────────
   O Buy calculava bem e não guardava nada: quem comprava anotava noutro
   lugar e o que foi decidido morria quando a aba fechava.

   O carrinho é por fornecedor e compartilhado — ver 019_buy_cart.sql. Por
   isso ele é recarregado do servidor a cada abertura em vez de viver em
   memória: com duas pessoas montando o mesmo pedido, um estado local ficaria
   velho sem avisar. */
let cartData = null;

async function loadCart(abrir) {
  try {
    cartData = await api('/cart' + (S.buy.supplier ? `?supplier=${encodeURIComponent(S.buy.supplier)}` : ''));
    const n = cartData.carts.reduce((a, c) => a + c.lines.length, 0);
    const pip = $('#pipCart'); pip.textContent = n ? n0(n) : ''; pip.classList.toggle('on', n > 0);
    if (abrir) { renderCart(); $('#cartModal').classList.add('is-on'); }
  } catch (e) { toast(e.message, true); }
}

function renderCart() {
  const carts = (cartData && cartData.carts) || [];
  if (!carts.length) {
    $('#cartBody').innerHTML = `<div class="sp-empty">Nothing in the cart yet.<br>
      Add lines from the buy list, or from any SKU in Supply Planning.</div>`;
    $('#cartFoot').innerHTML = '<button class="sp-btn" data-close>Close</button>';
    return;
  }
  $('#cartBody').innerHTML = carts.map((c) => {
    const units = c.lines.reduce((a, l) => a + Number(l.qty), 0);
    const val = c.lines.reduce((a, l) => a + Number(l.qty) * Number(l.unit_cost_aud || 0), 0);
    return `<div class="cart-block" data-cart="${c.id}">
      <h4>${esc(c.supplier_code)}
        <span>${n0(c.lines.length)} SKUs · ${n0(units)} units${val ? ` · ${aud(val)}` : ''}${
          c.scope ? ` · built in the ${esc(c.scope)} view` : ''}</span></h4>
      <table class="brk cart-tbl"><thead><tr>
        <th>SKU</th><th class="n">Qty</th><th class="n">Engine said</th><th>Added by</th><th></th>
      </tr></thead><tbody>
      ${c.lines.map((l) => {
        // O que o motor calculou fica ao lado do que a pessoa decidiu. Sem os
        // dois, ninguém sabe depois se o pedido seguiu ou contrariou a conta.
        const dif = l.qty_suggested != null && Number(l.qty) !== Number(l.qty_suggested);
        return `<tr data-line="${l.id}">
          <td class="mono">${esc(l.sku)}${l.source === 'manual'
            ? '<i class="cart-man" title="Added by hand, not suggested by the engine">manual</i>' : ''}</td>
          <td class="n"><input class="cart-qty" type="number" min="1" step="1" value="${Number(l.qty)}"></td>
          <td class="n${dif ? ' lean' : ''}" title="${dif
            ? `The engine suggested ${n0(l.qty_suggested)} — this line was changed by hand`
            : 'Matches the suggestion'}">${l.qty_suggested != null ? n0(l.qty_suggested) : '—'}</td>
          <td class="faint">${esc(l.added_by || '')}</td>
          <td class="n"><button class="sp-btn is-ghost cart-del" title="Remove this line">&times;</button></td>
        </tr>`; }).join('')}
      </tbody></table></div>`;
  }).join('');
  const c0 = carts[0];
  $('#cartFoot').innerHTML = `<button class="sp-btn" data-close>Close</button>
    <span class="sp-gap"></span>
    <input id="cartPO" class="cart-po" placeholder="PO number" autocomplete="off">
    <button class="sp-btn is-primary" id="cartConfirm" data-cart="${c0.id}">Confirm as a purchase order</button>`;
}

/* Um clique só do lado do usuário; do lado do servidor, a linha some do
   carrinho e o carrinho é relido. Não se apaga a linha na tela e torce: com
   duas pessoas mexendo, o que a tela mostra tem que ter vindo do banco. */
$('#cartBody').addEventListener('click', async (e) => {
  const del = e.target.closest('.cart-del'); if (!del) return;
  const tr = del.closest('tr[data-line]');
  try { await api(`/cart/lines/${tr.dataset.line}`, { method: 'DELETE' }); await loadCart(true); }
  catch (err) { toast(err.message, true); }
});
$('#cartBody').addEventListener('change', async (e) => {
  const inp = e.target.closest('.cart-qty'); if (!inp) return;
  const tr = inp.closest('tr[data-line]');
  const q = Number(inp.value);
  if (!isFinite(q) || q <= 0) { toast('Quantity must be above zero — remove the line instead', true); return loadCart(true); }
  try { await api(`/cart/lines/${tr.dataset.line}`, { method: 'PATCH', body: JSON.stringify({ qty: q }) }); await loadCart(true); }
  catch (err) { toast(err.message, true); }
});
$('#cartFoot').addEventListener('click', async (e) => {
  const b = e.target.closest('#cartConfirm'); if (!b) return;
  const po = ($('#cartPO').value || '').trim();
  if (!po) { toast('Give the purchase order a number first', true); return; }
  try {
    const r = await api(`/cart/${b.dataset.cart}/confirm`, { method: 'POST', body: JSON.stringify({ po_number: po }) });
    toast(`${r.po_number} created with ${r.lines} lines`);
    $('#cartModal').classList.remove('is-on');
    await loadCart(false); loadPOs(); show('pos');
  } catch (err) { toast(err.message, true); }
});
$('#byyCartBtn').addEventListener('click', () => loadCart(true));

/** Põe linhas no carrinho e devolve quantas entraram. */
async function addToCart(supplier, lines, scope) {
  if (!supplier) { toast('This SKU has no supplier on file, so it cannot go in a purchase order', true); return; }
  const r = await api('/cart/lines', { method: 'POST', body: JSON.stringify({ supplier, lines, scope }) });
  await loadCart(false);
  toast(`${r.lines.length} line${r.lines.length === 1 ? '' : 's'} added to the ${supplier} cart`);
}

function renderBuy() {
  const d = buyData;
  const rows = S.buy.late ? d.rows.filter(r => r.already_late) : d.rows;
  $('#byyCount').textContent = `${n0(rows.length)} of ${n0(d.total)} SKUs · ${d.ms} ms`;
  $('#byyBody').innerHTML = `
    <div class="sp-tiles">
      ${tile(aud(d.total_value_aud),'To order','at Cin7 average cost')}
      ${tile(n0(d.total_units),'Units',`across ${n0(d.total)} SKUs`)}
      ${tile(n0(d.late),'Already past the order date','with the measured lead time, these should have gone out weeks ago','bad')}
      ${tile(n0(d.bySupplier.length),'Suppliers','group the order by supplier to fill a container')}
      ${d.skipped && d.skipped.length
        ? tile(aud(d.skipped_value), 'Held back',
            `${n0(d.skipped.filter(x=>x.why==='never_sold').length)} never sold in 52 weeks · `
            + `${n0(d.skipped.filter(x=>x.why==='suspect_draw').length)} with a draw the engine flagged as a typo`,
            'warn')
        : ''}
    </div>
    <div class="sp-panel">
      <h4>By supplier <span>a purchase order per supplier — and the start of a container</span></h4>
      <table><thead><tr><th>Supplier</th><th class="n">SKUs</th><th class="n">Units</th><th class="n">Value</th><th class="n">Late</th><th class="n"></th></tr></thead>
      <tbody>${d.bySupplier.map(s=>`<tr class="click" data-sup="${esc(s.supplier)}">
        <td class="em">${esc(s.supplier)}</td><td class="n">${s.skus}</td><td class="n">${n0(s.units)}</td>
        <td class="n">${aud(s.value_aud)}</td>
        <td class="n"${s.late?' style="color:#9c0006;font-weight:600"':''}>${s.late||''}</td>
        <td class="n"><button class="sp-btn is-ghost add-all" data-addall="${esc(s.supplier)}"
          title="Put all ${s.skus} suggested lines for ${esc(s.supplier)} in the cart">add all</button></td>
        </tr>`).join('')}</tbody></table>
    </div>
    <div class="sp-panel">
      <h4>What to order <span>soonest order date first · every number here comes from the same cascade as the week grid</span></h4>
      <table><thead><tr>
        <th>SKU</th><th>Supplier</th><th class="n">Stock</th><th class="n">Wk/Avg</th>
        <th class="n">Lead</th><th class="n">Low point</th><th class="n">Need</th>
        <th class="n">Cartons</th><th class="n">Order</th><th class="n">Value</th><th class="n">Order by</th>
        <th class="n"></th></tr></thead>
      <tbody>${rows.map(r=>`<tr class="click" data-sku="${esc(r.sku_key)}" data-sup="${esc(r.supplier||'')}">
        <td class="em mono">${esc(r.sku)}</td><td>${esc(r.supplier||'')}</td>
        <td class="n"${r.soh<=0?' style="color:#9c0006;font-weight:600"':''}>${n0(r.soh)}</td>
        <td class="n">${n1(r.wk_avg)}</td>
        <td class="n" title="${esc(r.lead_source)}${r.sd_weeks?` ±${r.sd_weeks} wk`:''}">${n1(r.lead_weeks)}w${r.lead_source==='MEASURED'?'':' *'}</td>
        <td class="n"${r.low_point<0?' style="color:#9c0006;font-weight:600"':''} title="worst week: ${d10(r.low_week)}">${n0(r.low_point)}</td>
        <td class="n">${n0(r.raw_need)}</td>
        <td class="n" title="${r.carton_qty} per carton${r.moq_applied?' · MOQ applied':''}">${n0(r.cartons)}${r.moq_applied?' ᴹ':''}</td>
        <td class="n em">${n0(r.suggested)}</td>
        <td class="n">${r.value_aud?aud(r.value_aud):''}</td>
        <td class="n"${r.already_late?' style="color:#9c0006;font-weight:600"':''}
            title="${r.already_late
              ? `A data de pedir cai antes do início da projeção, então ela não é recuperável desta tela. Com o lead de ${n1(r.lead_weeks)} semanas, deveria ter saído há cerca de ${r.weeks_late} semana(s).`
              : 'Semana em que o pedido precisa sair para chegar antes do saldo cruzar o alvo.'}"
          >${r.already_late?'was due':d10(r.order_by_week)}</td>
        <td class="n"><button class="sp-btn is-ghost add-one" title="Add ${n0(r.suggested)} to the ${esc(r.supplier||'')} cart"
          data-add="${esc(r.sku_key)}">+</button></td>
      </tr>`).join('') || '<tr><td colspan="12"><div class="sp-empty">Nothing to order with these filters.</div></td></tr>'}</tbody></table>
    </div>
    ${d.skipped && d.skipped.length ? `<div class="sp-panel">
      <h4>Held back <span>calculated, then blocked — a suggestion is only as good as the number under it</span></h4>
      <table><thead><tr><th>SKU</th><th>Why</th><th class="n">Qty it would have asked</th><th class="n">Value</th></tr></thead>
      <tbody>${d.skipped.map(x=>`<tr><td class="mono">${esc(x.sku)}</td>
        <td>${x.why==='never_sold'?'No sale in 52 weeks — the forecast is typed, the demand is not there'
                                  :'Draw far above the average — the engine flagged it as a likely typo'}</td>
        <td class="n mono">${n0(x.qty)}</td><td class="n mono">${x.value?aud(x.value):'—'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <p class="sp-hint" style="max-width:70ch">
      The rule, in one sentence: <b>if the PO goes out today it lands in week lead + review;
      buy enough that the worst point between now and there plus the cover target sits at the target</b> —
      rounded up to a full carton${d.rows.some(r=>r.moq_applied)
        ? ', and never under the MOQ'
        : '. <b>No supplier MOQ is on file</b>, so nothing here is being lifted to a minimum'}.
      A lead time marked <b>*</b> is a supplier default, not measured.</p>`;
  $('#byyBody').onclick = async e => {
    // Os botões de carrinho vêm ANTES do resto: eles ficam dentro de linhas
    // que já respondem ao clique, e sem sair aqui o "+" também navegaria.
    const one = e.target.closest('.add-one');
    if (one) {
      e.stopPropagation();
      const r = buyData.rows.find(x => x.sku_key === one.dataset.add); if (!r) return;
      return addToCart(r.supplier, [{ sku_key: r.sku_key, sku: r.sku, qty: r.suggested,
        qty_suggested: r.suggested, carton_qty: r.carton_qty,
        unit_cost_aud: r.value_aud && r.suggested ? r.value_aud / r.suggested : null }]);
    }
    const all = e.target.closest('.add-all');
    if (all) {
      e.stopPropagation();
      const sup = all.dataset.addall;
      const rs = buyData.rows.filter(x => x.supplier === sup);
      if (!rs.length) return;
      return addToCart(sup, rs.map(r => ({ sku_key: r.sku_key, sku: r.sku, qty: r.suggested,
        qty_suggested: r.suggested, carton_qty: r.carton_qty,
        unit_cost_aud: r.value_aud && r.suggested ? r.value_aud / r.suggested : null })));
    }
    const su = e.target.closest('[data-sup]:not([data-sku])');
    if (su) { S.buy.supplier = su.dataset.sup; $('#byySupplier').value = su.dataset.sup; return loadBuy(); }
    const tr = e.target.closest('[data-sku]');
    if (tr) return jumpSupply(tr.dataset.sup, tr.dataset.sku);
  };
}
$('#byySupplier').addEventListener('change', e => { S.buy.supplier = e.target.value; loadBuy(); });
$('#byyLate').addEventListener('click', e => { S.buy.late = !S.buy.late; e.currentTarget.classList.toggle('is-on', S.buy.late); renderBuy(); });
$('#byyCopy').addEventListener('click', () => {
  if (!buyData) return;
  const rows = S.buy.late ? buyData.rows.filter(r => r.already_late) : buyData.rows;
  // Formato que a tela de Add PO já entende: SKU, qty, custo, due date.
  const text = rows.map(r => `${r.sku}\t${r.suggested}`).join('\n');
  navigator.clipboard.writeText(text)
    .then(() => toast(`${rows.length} lines copied — paste straight into Add PO`))
    .catch(() => toast('Could not reach the clipboard', true));
});

/* ═══ PURCHASE ORDERS ═══════════════════════════════════════════════ */
let poRows = [];
async function loadPOs() {
  const p = S.pos;
  const qs = new URLSearchParams({ limit:500 });
  if (p.q) qs.set('q', p.q);
  if (p.supplier) qs.set('supplier', p.supplier);
  if (p.open) qs.set('only','open');
  try {
    let rows = await api('/pos?' + qs);
    const today = new Date().toISOString().slice(0,10);
    if (p.overdue) rows = rows.filter(r => r.due_date && r.due_date < today);
    poRows = rows;
    $('#poCount').textContent = `${n0(rows.length)} lines`;
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
          <td><button class="ui-act" data-alloc="${r.id}">Allocate</button></td></tr>`;
      }).join('')}</tbody>`;
  } catch (e) { toast(e.message, true); }
}
const cellPo = (r,f,html,kind='text') =>
  `<span class="sp-cell${html?'':' void'}" contenteditable="plaintext-only" spellcheck="false"
     data-po="${r.id}" data-field="${f}" data-kind="${kind}">${html||''}</span>`;

$('#poSearch').addEventListener('input', debounce(e => { S.pos.q = e.target.value; loadPOs(); }));
$('#poSupplier').addEventListener('change', e => { S.pos.supplier = e.target.value; loadPOs(); });
$('#poOpen').addEventListener('click', e => { S.pos.open = !S.pos.open; e.currentTarget.classList.toggle('is-on', S.pos.open); loadPOs(); });
$('#poOverdue').addEventListener('click', e => { S.pos.overdue = !S.pos.overdue; e.currentTarget.classList.toggle('is-on', S.pos.overdue); loadPOs(); });
$('#poGrid').addEventListener('click', e => { const b = e.target.closest('[data-alloc]'); if (b) openAllocation(+b.dataset.alloc); });

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

/* ═══ ALERTS ═══════════════════════════════════════════════════════
   Uma lista de mensagens obriga a sair da tela para decidir qualquer coisa.
   Aqui cada SKU alertado traz os números que geraram o alerta — estoque,
   média, cobertura, quando rompe, o que já vem chegando e quando. Dá para
   decidir sem abrir outra aba. */
const AL = {
  PROJECTED_STOCKOUT:'Runs out inside the horizon',
  SOH_NON_POSITIVE:'Zero or negative stock',
  BELOW_TARGET_COVER:'Drops below target cover',
  BELOW_ONE_MONTH:'Under one month of cover',
  UNDATED_DEMAND:'Project demand with no pick date',
  PO_AFTER_STOCKOUT:'PO lands after the stockout',
  LARGE_DRAW:'Draw far above this SKU’s pattern',
  STALE_REPORTING_WEEK:'Reporting week is behind',
};
let alData = null;
S.alerts.group = 'sku'; S.alerts.code = ''; S.alerts.crit = false;

async function loadAlerts() {
  const qs = new URLSearchParams({ limit:1200 });
  if (S.alerts.muted) qs.set('muted','1');
  if (S.alerts.supplier) qs.set('supplier', S.alerts.supplier);
  $('#alBody').innerHTML = '<div class="sp-loading">Calculating…</div>';
  try {
    alData = await api('/alerts?' + qs);
    const crit = alData.bySeverity.CRITICAL || 0;
    const pip = $('#pipAlerts'); pip.textContent = n0(crit); pip.classList.toggle('on', crit > 0);
    const sel = $('#alCode');
    if (sel.options.length <= 1) sel.innerHTML = '<option value="">All exception types</option>' +
      Object.entries(alData.byCode).sort((a,b)=>b[1]-a[1])
        .map(([c,n])=>`<option value="${c}">${esc(AL[c]||c)} (${n})</option>`).join('');
    renderAlerts();
  } catch (e) { $('#alBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

function alFilter(list) {
  return list.filter(s => {
    const keep = s.alerts.filter(a =>
      (!S.alerts.code || a.code === S.alerts.code) && (!S.alerts.crit || a.severity === 'CRITICAL'));
    if (!keep.length) return false;
    s._shown = keep; return true;
  });
}

/** A linha de fatos: é ela que evita ter de abrir outra tela. */
function alFacts(s) {
  const bits = [
    ['Stock', n0(s.soh), s.soh <= 0 ? 'bad' : ''],
    ['Wk/Avg', s.wk_avg == null ? '—' : n1(s.wk_avg), ''],
    ['Cover', s.mths_stock == null ? '—' : n1(s.mths_stock) + ' mth', s.mths_stock != null && s.mths_stock < 1 ? 'bad' : ''],
    ['Target', s.target_qty == null ? '—' : n0(s.target_qty), ''],
    ['Runs out', s.first_stockout ? `${d10(s.first_stockout)} (+${s.weeks_to_stockout}w)` : 'not in horizon', s.first_stockout ? 'bad' : 'good'],
    ['Low point', s.min_closing == null ? '—' : n0(s.min_closing), s.min_closing < 0 ? 'bad' : ''],
    ['Next PO', s.next_incoming ? `${n0(s.next_incoming_qty)} on ${d10(s.next_incoming)}` : 'none booked', s.next_incoming ? '' : 'bad'],
    ['Draws', n0(s.draws) + (s.undated ? ` (+${n0(s.undated)} TBA)` : ''), s.undated ? 'warn' : ''],
    ['Main / Gateway', `${n0(s.main_soh)} / ${n0(s.gateway_soh)}`, ''],
  ];
  return `<div class="alf">${bits.map(([k,v,t])=>
    `<span class="alf-i"><em>${k}</em><b class="${t}">${v}</b></span>`).join('')}</div>`;
}

function renderAlerts() {
  const g = S.alerts.group;
  if (g === 'flat') {
    const rows = alData.alerts.filter(a =>
      (!S.alerts.code || a.code === S.alerts.code) && (!S.alerts.crit || a.severity === 'CRITICAL'));
    $('#alCount').textContent = `${n0(rows.length)} alerts`;
    const seg = alData.bySegment || {};
    const segBar = Object.keys(seg).length
      ? `<div class="al-segs">${['Buy now','No forecast','Order soon','Top up','Fix record','Review','Dead SKUs']
          .filter(k=>seg[k]).map(k=>`<span class="al-seg"><b>${n0(seg[k])}</b> ${k}</span>`).join('')}</div>`
      : '';
    $('#alBody').innerHTML = alTiles() + segBar + `<div class="sp-panel">${rows.map(a=>`<div class="al">
      <span class="sv sv-${a.severity}">${a.severity}</span>
      <span class="k" data-sku="${esc(a.sku)}" data-sup="${esc(a.supplier||'')}">${esc(a.sku)}</span>
      <span class="m">${esc(a.message)}</span></div>`).join('') || '<div class="sp-empty">Nothing matches.</div>'}</div>`;
  } else if (g === 'supplier') {
    const skus = alFilter(alData.skuList);
    const by = new Map();
    for (const s of skus) {
      const k = s.supplier || '—';
      if (!by.has(k)) by.set(k, { supplier:k, skus:[], critical:0, alerts:0, stockout:0 });
      const b = by.get(k); b.skus.push(s); b.alerts += s._shown.length;
      b.critical += s._shown.filter(a=>a.severity==='CRITICAL').length;
      if (s.first_stockout) b.stockout++;
    }
    const list = [...by.values()].sort((a,b)=>b.critical-a.critical||b.skus.length-a.skus.length);
    $('#alCount').textContent = `${n0(skus.length)} SKUs across ${list.length} suppliers`;
    const seg = alData.bySegment || {};
    const segBar = Object.keys(seg).length
      ? `<div class="al-segs">${['Buy now','No forecast','Order soon','Top up','Fix record','Review','Dead SKUs']
          .filter(k=>seg[k]).map(k=>`<span class="al-seg"><b>${n0(seg[k])}</b> ${k}</span>`).join('')}</div>`
      : '';
    $('#alBody').innerHTML = alTiles() + segBar + list.map(b=>`
      <div class="sp-panel">
        <h4>${esc(b.supplier)}
          <span>${b.skus.length} SKUs · ${b.alerts} exceptions${b.critical?` · ${b.critical} critical`:''}${b.stockout?` · ${b.stockout} run out in the horizon`:''}</span>
          <button class="sp-btn" style="margin-left:auto;font-size:11.5px;padding:3px 9px" data-sup-open="${esc(b.supplier)}">Open in planning</button>
        </h4>
        <table><tbody>${b.skus.slice(0,40).map(s=>alSkuRow(s)).join('')}</tbody></table>
        ${b.skus.length>40?`<div class="in" style="color:var(--mut-3);font-size:12px">…and ${b.skus.length-40} more</div>`:''}
      </div>`).join('');
  } else {
    const skus = alFilter(alData.skuList);
    $('#alCount').textContent = `${n0(skus.length)} SKUs · ${n0(skus.reduce((n,s)=>n+s._shown.length,0))} exceptions`
      + (alData.muted_count ? ` · ${n0(alData.muted_count)} silenced` : '');
    const seg = alData.bySegment || {};
    const segBar = Object.keys(seg).length
      ? `<div class="al-segs">${['Buy now','No forecast','Order soon','Top up','Fix record','Review','Dead SKUs']
          .filter(k=>seg[k]).map(k=>`<span class="al-seg"><b>${n0(seg[k])}</b> ${k}</span>`).join('')}</div>`
      : '';
    $('#alBody').innerHTML = alTiles() + segBar +
      `<div class="sp-panel"><table><tbody>${skus.map(s=>alSkuRow(s)).join('')}</tbody></table>
       ${alData.muted_count?`<div class="in al-muted" title="Nenhum deles vendeu uma unidade em 52 semanas, e a regra não olha o ciclo de vida: 125 dos silenciados estão marcados ACTIVE.">
         <b>${n0(alData.muted_count)} SKUs silenciados</b> — estoque 0, sem previsão, sem venda em 52 semanas, sem PO e sem draw.
         <button class="ui-act" id="alShowMuted">${S.alerts.muted?'Ocultar':'Mostrar'}</button></div>`:''}</div>`;
  }
}
function alSkuRow(s) {
  const worst = s._shown[0];
  return `<tr class="al-row" data-sku="${esc(s.sku_key)}" data-sup="${esc(s.supplier||'')}">
    <td style="width:100%;padding:9px 14px">
      <div class="al-head">
        <span class="sv sv-${worst.severity}">${worst.severity}</span>
        <span class="al-sku">${esc(s.sku)}</span>
        <span class="al-sup">${esc(s.supplier||'')}</span>
        <span class="al-msgs">${s._shown.map(a=>`<span class="al-tag" title="${esc(a.message)}">${esc(AL[a.code]||a.code)}</span>`).join('')}</span>
        <span class="al-go"><button class="ui-act" data-open="1">Open week grid</button></span>
      </div>
      ${alFacts(s)}
      <div class="al-why">${s._shown.map(a=>esc(a.message)).join(' · ')}</div>
    </td></tr>`;
}
function alTiles() {
  return `<div class="sp-tiles">${Object.entries(alData.byCode).sort((a,b)=>b[1]-a[1]).map(([c,n])=>
    `<div class="sp-tile ${c==='PROJECTED_STOCKOUT'||c==='SOH_NON_POSITIVE'?'bad':''} ${S.alerts.code===c?'is-on':''}"
       data-code="${c}" style="cursor:pointer"><b>${n0(n)}</b><em>${esc(AL[c]||c)}</em>
       <small>${S.alerts.code===c?'filtering — click to clear':'click to filter'}</small></div>`).join('')}</div>`;
}
$('#alSupplier').addEventListener('change', e => { S.alerts.supplier = e.target.value; loadAlerts(); });
$('#alCode').addEventListener('change', e => { S.alerts.code = e.target.value; renderAlerts(); });
$('#alCrit').addEventListener('click', e => { S.alerts.crit = !S.alerts.crit; e.currentTarget.classList.toggle('is-on', S.alerts.crit); renderAlerts(); });
$$('.sp-view[data-view=alerts] .sp-chip[data-grp]').forEach(c => c.addEventListener('click', () => {
  S.alerts.group = c.dataset.grp;
  $$('.sp-view[data-view=alerts] .sp-chip[data-grp]').forEach(x => x.classList.toggle('is-on', x === c));
  renderAlerts();
}));
$('#alBody').addEventListener('click', e => {
  const t = e.target.closest('[data-code]');
  if (e.target.closest('#alShowMuted')) { S.alerts.muted = !S.alerts.muted; return loadAlerts(); }
  if (t) { S.alerts.code = S.alerts.code === t.dataset.code ? '' : t.dataset.code; $('#alCode').value = S.alerts.code; return renderAlerts(); }
  const so = e.target.closest('[data-sup-open]');
  if (so) return jumpSupply(so.dataset.supOpen, '');
  const row = e.target.closest('[data-sku]');
  if (row) return jumpSupply(row.dataset.sup, row.dataset.sku);
});

/* ═══ IMPORT SALES ORDER ════════════════════════════════════════════ */
let soPick = null;
$('#btnImportSO').addEventListener('click', () => {
  soPick = null; $('#soSearch').value=''; $('#soResults').innerHTML=''; $('#soPreview').innerHTML='';
  $('#soImport').disabled = true; $('#mdImport').classList.add('is-on');
  setTimeout(()=>$('#soSearch').focus(), 50);
});
$('#soSearch').addEventListener('input', debounce(async e => {
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
$('#soResults').addEventListener('click', async e => {
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
$('#soImport').addEventListener('click', async () => {
  if (!soPick) return;
  const b = $('#soImport'); b.disabled = true; b.textContent = 'Importing…';
  try {
    const out = await api('/projects/import-order', { method:'POST', body: JSON.stringify({ sales_order: soPick }) });
    toast(`${soPick} imported — ${out.lines} lines, nothing retyped`);
    $('#mdImport').classList.remove('is-on');
    S.projects.q = soPick.replace('SO-',''); $('#pjSearch').value = S.projects.q; show('projects');
  } catch (e) { toast(e.message, true); }
  finally { b.disabled = false; b.textContent = 'Import as project'; }
});

/* ═══ NEW PO ════════════════════════════════════════════════════════ */
$('#btnAddPO').addEventListener('click', () => {
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
$('#npoLines').addEventListener('input', debounce(() => {
  const lines = parsePoLines($('#npoLines').value);
  const total = lines.reduce((s,l)=>s+(l.unit_cost_usd||0)*l.qty, 0);
  $('#npoPreview').innerHTML = lines.length
    ? `<p class="sp-hint"><b>${lines.length}</b> lines · ${n0(lines.reduce((s,l)=>s+l.qty,0))} units${total?` · ${usd(total)} USD`:''}</p>`
    : '<p class="sp-hint">No lines recognised yet.</p>';
}, 200));
$('#npoSave').addEventListener('click', async () => {
  const lines = parsePoLines($('#npoLines').value);
  if (!$('#npoNumber').value.trim()) return toast('PO number is required', true);
  if (!lines.length) return toast('At least one line is required', true);
  try {
    const out = await api('/pos', { method:'POST', body: JSON.stringify({
      po_number: $('#npoNumber').value.trim(), po_date: $('#npoDate').value,
      supplier_code: $('#npoSupplier').value || null, due_date: $('#npoDue').value || null,
      vessel: $('#npoVessel').value.trim() || null, lines }) });
    toast(`PO saved — ${out.created} lines now count as stock arriving`);
    $('#mdPO').classList.remove('is-on'); loadPOs();
  } catch (e) { toast(e.message, true); }
});
