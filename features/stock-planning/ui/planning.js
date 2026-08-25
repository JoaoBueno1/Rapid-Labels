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
  projects: { q:'', status:'ACTIVE', rep:'', only:'', sort:'order_date', dir:'desc', offset:0, limit:400, col:{} },
  supply:   { supplier: localStorage.getItem('sp.sup') || '', q:'', weeks:26, risk:false, expandAll:false, open:{} },
  pos:      { q:'', supplier:'', open:true, overdue:false },
  alerts:   { supplier:'' },
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
function show(view) {
  S.view = view;
  $$('.sp-tab').forEach(b => b.classList.toggle('is-on', b.dataset.view === view));
  $$('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === view));
  ({ overview:loadOverview, projects:loadProjects, supply:loadSupply, pos:loadPOs, alerts:loadAlerts }[view] || (()=>{}))();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('.sp-tab'); if (b) show(b.dataset.view); });

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
    $('#spSupplier').innerHTML = '<option value="">Pick a supplier…</option>' + opts;
    $('#poSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#alSupplier').innerHTML = '<option value="">All suppliers</option>' + opts;
    $('#npoSupplier').innerHTML = '<option value="">—</option>' + opts;
    if (S.supply.supplier) $('#spSupplier').value = S.supply.supplier;
    const f = await api('/filters');
    $('#pjRep').innerHTML = '<option value="">All reps</option>' + f.reps.map(r => `<option>${esc(r)}</option>`).join('');
    loadOverview();
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
  ({ health:ovHealth, risk:ovRisk, inbound:ovInbound, demand:ovDemand, signal:ovSignal }[S.ov])();
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
      </div>
      <div class="sp-panel">
        <h4>Wk/Avg against actual sales
          <span>Wk/Avg is typed by hand — 837 blocks checked in the workbook, not one formula. It drives every purchase and had never been measured.
          Window: last ${d.window_weeks} complete weeks, project orders excluded so draws are not counted twice.</span></h4>
        <table><thead><tr><th>SKU</th><th>Supplier</th><th class="n">Wk/Avg (typed)</th><th class="n">Actual/week</th>
          <th class="n">Gap</th><th class="n">Gap %</th><th class="n">Cover</th><th class="n">Stock value</th><th>Reading</th></tr></thead>
        <tbody>${d.rows.map(r=>`<tr class="click" data-sku="${esc(r.sku_key)}" data-sup="${esc(r.supplier_code||'')}">
          <td class="em mono">${esc(r.sku)}</td><td>${esc(r.supplier_code||'')}</td>
          <td class="n">${n1(r.wk_avg)}</td><td class="n">${n1(r.actual_wk)}</td>
          <td class="n" style="color:${Number(r.bias_units)<0?'#9c5700':'#9c0006'}">${n1(r.bias_units)}</td>
          <td class="n">${r.bias_pct==null?'':r.bias_pct+'%'}</td><td class="n">${r.mths_stock==null?'':n1(r.mths_stock)}</td>
          <td class="n">${aud(r.stock_value_aud)}</td><td>${esc(r.verdict)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#ovBody').onclick = e => { const tr = e.target.closest('tr[data-sku]'); if (tr) jumpSupply(tr.dataset.sup, tr.dataset.sku); };
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
    ? `<span class="sp-mark m-tba" data-draws="${r.id}">plan it</span>`
    : `<span class="faint">—</span>`;
  if (r.draw_count === 1) {
    const d = r.draws[0];
    return d && d.planned_date
      ? `<span class="sp-mark m-n" data-draws="${r.id}">${d10(d.planned_date)}</span>`
      : `<span class="sp-mark m-tba" data-draws="${r.id}">TBA</span>`;
  }
  return `<span class="sp-mark m-n" data-draws="${r.id}">${r.draw_count} draws</span>`
       + (r.over_planned ? ' <span class="sp-mark m-over">over</span>' : '');
}

let pjRows = [], pjOrders = [];
async function loadProjects() {
  const p = S.projects;
  const qs = new URLSearchParams({ status:p.status, limit:p.limit, offset:p.offset, sort:'order_date', dir:'desc' });
  if (p.q) qs.set('q', p.q);
  if (p.rep) qs.set('rep', p.rep);
  if (p.only) qs.set('only', p.only);
  $('#pjCount').textContent = 'loading…';
  try {
    const d = await api('/lines?' + qs);
    pjRows = d.rows;
    const by = new Map();
    for (const r of d.rows) {
      const k = r.project_id || r.sales_order;
      if (!by.has(k)) by.set(k, { key:k, id:r.project_id, so:r.sales_order, cu:r.customer, rf:r.reference,
                                  rp:r.rep, dt:r.order_date, wh:r.warehouse_note, lines:[] });
      by.get(k).lines.push(r);
    }
    pjOrders = [...by.values()];
    $('#pjCount').textContent = `${n0(pjOrders.length)} orders · ${n0(d.rows.length)} of ${n0(d.total)} lines`;
    renderProjects();
  } catch (e) { $('#pjCount').textContent=''; toast(e.message, true); }
}

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
        <span class="sep"></span><span class="dt">${d10(o.dt)}</span>
        <span class="rt">
          <span class="mt">${lines.length} lines · ${n0(qty)} ordered · ${n0(pick)} to pick</span>
          ${o.id?`<button class="act" data-project="${o.id}">Open</button>`:''}
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
      ${left>0 ? `<span class="sp-mark m-tba">${n0(left)} unplanned</span>`
        : left<0 ? `<span class="sp-mark m-over">${n0(-left)} over</span>`
        : '<span class="sp-mark m-ok">balanced</span>'}
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
  if (!s.supplier) {
    $('#spGrid').innerHTML = `<tbody><tr><td><div class="sp-empty">
      Pick a supplier to load the projection.<br>
      Same slice as the 22 supplier tabs — and it is what keeps this fast.</div></td></tr></tbody>`;
    $('#spCount').textContent=''; return;
  }
  const qs = new URLSearchParams({ supplier:s.supplier, weeks:s.weeks, limit:300 });
  if (s.q) qs.set('q', s.q);
  if (s.risk) qs.set('only','risk');
  $('#spCount').textContent = 'calculating…';
  try {
    spData = await api('/planning?' + qs);
    $('#spCount').textContent = `${n0(spData.rows.length)} of ${n0(spData.total)} SKUs · ${spData.ms} ms`;
    renderSupply();
  } catch (e) { $('#spCount').textContent=''; toast(e.message, true); }
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

function renderSupply() {
  const d = spData; if (!d) return;
  const W = d.weeks;
  const head = `<thead><tr>
    <th style="width:190px">SKU</th><th class="n" style="width:70px">SOH</th>
    <th class="n" style="width:62px">Wk/Avg</th><th class="n" style="width:52px">Mths</th>
    <th class="n" style="width:60px">TBA</th><th class="n" style="width:74px">Incoming</th>
    <th class="n" style="width:52px">Target</th>
    ${W.map((w,i)=>`<th class="wk ${i===0?'rep':''} ${Number(w.factor)!==1?'cny':''}" title="${esc(w.factor_reason||'')}">
      ${dSh(w.week_ending)}<small>${i===0?'reporting':Number(w.factor)!==1?Math.round(w.factor*100)+'%':'&nbsp;'}</small></th>`).join('')}
  </tr></thead>`;
  const bodies = d.rows.map(r0 => {
    const r = { ...r0, cells: markCrossings(r0.cells) };
    const open = S.supply.expandAll || S.supply.open[r.sku_key];
    const m = r.summary;
    const skuRow = `<tr class="sk" data-sku="${esc(r.sku_key)}">
      <td class="em"><button class="tog" data-tog="${esc(r.sku_key)}">${open?'▾':'▸'}</button><span class="mono">${esc(r.sku)}</span></td>
      <td class="n mono"${r.soh<=0?' style="color:#9c0006;font-weight:700"':''}>${n0(r.soh)}</td>
      <td class="n">${cellSku(r,'wk_avg',n1(r.wk_avg))}</td>
      <td class="n mono"${m.mthsStock!=null&&m.mthsStock<1?' style="color:#9c0006;font-weight:700"':''}>${m.mthsStock==null?'—':n1(m.mthsStock)}</td>
      <td class="n mono"${m.undatedQty?' style="color:#9c5700;font-weight:600"':' class="n mono faint"'}>${m.undatedQty?n0(m.undatedQty):'—'}</td>
      <td class="n mono">${m.totalIncoming?n0(m.totalIncoming):''}</td>
      <td class="n">${cellSku(r,'target_cover_weeks',r.target_cover_weeks)}</td>
      ${r.cells.map((c,i)=>open
        ? `<td class="wk ${i===0?'rep':''} faint"></td>`
        : `<td class="wk ${i===0?'rep':''} ${c.neg?'neg':''} ${c.lowEdge?'low':''} ${c.i?'has-in':''} ${c.d?'has-dr':''}"
             data-week="${c.w}" title="opening ${n0(c.o)} · in ${n0(c.i)} · sales ${n1(c.s)} · project ${n0(c.d)}${c.lowEdge?' — drops below target cover here':''}">${n0(c.c)}</td>`).join('')}
    </tr>`;
    if (!open) return `<tbody>${skuRow}</tbody>`;
    const work = WRK.map(([cls,label,pick]) => `<tr class="wrk ${cls} ${cls==='r-close'?'close':''}">
      <td class="lbl" colspan="7">${label}</td>
      ${r.cells.map((c,i)=>{
        const v = pick(c);
        const isClose = cls === 'r-close';
        return `<td class="wk ${i===0?'rep':''} ${isClose&&c.neg?'neg':''} ${isClose&&c.lowEdge?'low':''}"
          ${isClose?`data-week="${c.w}"`:''}>${v===0?'<span class="faint">0</span>':cls==='r-out'?n1(v):n0(v)}</td>`;
      }).join('')}</tr>`).join('');
    return `<tbody>${skuRow}${work}</tbody>`;
  }).join('');
  $('#spGrid').innerHTML = head + bodies;
}
const cellSku = (r, f, html) =>
  `<span class="sp-cell" contenteditable="plaintext-only" spellcheck="false"
     data-sku="${esc(r.sku_key)}" data-field="${f}" data-kind="num">${html==null?'':html}</span>`;

$('#spSupplier').addEventListener('change', e => { S.supply.supplier = e.target.value; localStorage.setItem('sp.sup', e.target.value); loadSupply(); });
$('#spSearch').addEventListener('input', debounce(e => { S.supply.q = e.target.value; loadSupply(); }));
$('#spWeeks').addEventListener('change', e => { S.supply.weeks = +e.target.value; loadSupply(); });
$('#spRisk').addEventListener('click', e => { S.supply.risk = !S.supply.risk; e.currentTarget.classList.toggle('is-on', S.supply.risk); loadSupply(); });
$('#spExpand').addEventListener('click', e => { S.supply.expandAll = !S.supply.expandAll; e.currentTarget.classList.toggle('is-on', S.supply.expandAll); renderSupply(); });
$('#spGrid').addEventListener('click', e => {
  const t = e.target.closest('[data-tog]');
  if (t) { const k = t.dataset.tog; S.supply.open[k] = !S.supply.open[k]; return renderSupply(); }
  const td = e.target.closest('td.wk[data-week]');
  if (td) { const tb = td.closest('tbody'); openWeek(tb.querySelector('tr.sk').dataset.sku, td.dataset.week); }
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
      </table>`);
  } catch (e) { toast(e.message, true); }
}

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
          <td><button class="sp-mark m-n" data-alloc="${r.id}">Allocate</button></td></tr>`;
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

/* ═══ ALERTS ════════════════════════════════════════════════════════ */
const AL = {
  PROJECTED_STOCKOUT:'Projection goes negative',
  SOH_NON_POSITIVE:'Zero or negative stock — invisible in the Excel',
  BELOW_TARGET_COVER:'Below target cover',
  BELOW_ONE_MONTH:'Under one month of cover',
  UNDATED_DEMAND:'Project demand with no pick date',
  PO_AFTER_STOCKOUT:'PO lands after the stockout',
  LARGE_DRAW:'Draw far above this SKU’s pattern',
  STALE_REPORTING_WEEK:'Reporting week is behind',
};
async function loadAlerts() {
  const qs = new URLSearchParams({ limit:400 });
  if (S.alerts.supplier) qs.set('supplier', S.alerts.supplier);
  $('#alBody').innerHTML = '<div class="sp-loading">Calculating…</div>';
  try {
    const d = await api('/alerts?' + qs);
    const pip = $('#pipAlerts');
    const crit = d.bySeverity.CRITICAL || 0;
    pip.textContent = n0(crit); pip.classList.toggle('on', crit > 0);
    $('#alCount').textContent = `${n0(d.total)} exceptions`;
    $('#alBody').innerHTML = `
      <div class="sp-tiles">${Object.entries(d.byCode).sort((a,b)=>b[1]-a[1]).map(([c,n])=>
        tile(n0(n), AL[c]||c, '', c==='PROJECTED_STOCKOUT'||c==='SOH_NON_POSITIVE' ? 'bad' : '')).join('')}</div>
      <div class="sp-panel">${d.alerts.map(a=>`<div class="al">
        <span class="sv sv-${a.severity}">${a.severity}</span>
        <span class="k" data-sku="${esc(a.sku)}" data-sup="${esc(a.supplier||'')}">${esc(a.sku)}</span>
        <span class="m">${esc(a.message)}</span></div>`).join('') || '<div class="sp-empty">No exceptions.</div>'}</div>`;
    $('#alBody').onclick = e => { const k = e.target.closest('.k'); if (k) jumpSupply(k.dataset.sup, k.dataset.sku); };
  } catch (e) { $('#alBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}
$('#alSupplier').addEventListener('change', e => { S.alerts.supplier = e.target.value; loadAlerts(); });

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
