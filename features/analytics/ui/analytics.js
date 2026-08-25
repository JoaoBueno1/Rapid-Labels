'use strict';
/* Monthly Review — o deck mensal, ao vivo.

   Sete apresentações montadas à mão, das quais quatro não têm um único
   gráfico nativo: tudo é print de Excel. O dado sempre esteve no banco —
   78.256 pedidos desde 2021. Isto é a tela que faltava. */

const A = '/api/analytics';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function api(p) {
  const r = await fetch(A + p);
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}
const esc = v => v == null ? '' : String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n0 = v => (v == null || v === '') ? '' : Math.round(Number(v)).toLocaleString('en-AU');
const n1 = v => (v == null || v === '') ? '' : Number(v).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const aud = v => (v == null || v === '') ? '' : 'A$' + Math.round(Number(v)).toLocaleString('en-AU');
const k$ = v => { const n = Math.abs(Number(v) || 0);
  return n >= 1e6 ? 'A$' + (n/1e6).toFixed(1) + 'M' : n >= 1000 ? 'A$' + Math.round(n/1000) + 'k' : 'A$' + Math.round(n); };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const d10 = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const mLabel = iso => { const m = /^(\d{4})-(\d{2})/.exec(String(iso||'')); return m ? `${MON[+m[2]-1]} ${m[1].slice(2)}` : ''; };

let toastT;
function toast(msg, bad) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => el.className = 'sp-toast', bad ? 4600 : 2200);
}
function side(title, html) { $('#sideTitle').textContent = title; $('#sideBody').innerHTML = html; $('#side').classList.add('is-on'); }
$('#sideClose').addEventListener('click', () => $('#side').classList.remove('is-on'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#side').classList.remove('is-on'); });

const tile = (v, label, note, kind = '') =>
  `<div class="sp-tile ${kind}"><b>${v}</b><em>${label}</em><small>${note}</small></div>`;

let view = 'month';
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.sp-tab'); if (!b) return;
  view = b.dataset.view;
  $$('.sp-tab').forEach(x => x.classList.toggle('is-on', x === b));
  $$('.sp-view').forEach(s => s.classList.toggle('is-on', s.dataset.view === view));
  ({ month: loadMonth, stuck: loadStuck, ops: loadOps, release: loadRelease }[view])();
});

/* ═══ O MÊS ═════════════════════════════════════════════════════════ */
async function loadMonth() {
  try {
    const d = await api('/monthly?months=15');
    const t = d.totals;
    // A manchete tem de ser o último mês FECHADO.
    // Duas armadilhas aqui, as duas encontradas rodando: o mês corrente está
    // pela metade, E existem faturas com data FUTURA no Cin7 — setembro já
    // aparece com dois pedidos. Então "fechado" é estritamente antes do mês
    // corrente, não "tudo menos o mês corrente".
    const thisMonth = new Date().toISOString().slice(0, 7);
    const closed = t.filter(x => String(x.mth).slice(0, 7) < thisMonth);
    const running = t.filter(x => String(x.mth).slice(0, 7) >= thisMonth);
    const cur = closed[closed.length - 1] || {};
    const partial = running.find(x => String(x.mth).slice(0, 7) === thisMonth) || null;
    const future = running.filter(x => String(x.mth).slice(0, 7) > thisMonth);
    const max = Math.max(...t.map(x => Number(x.sales) || 0), 1);
    const branches = d.byWarehouse.filter(w => w.kind === 'BRANCH');
    const maxSoh = Math.max(...d.byWarehouse.map(w => Number(w.soh_value) || 0), 1);
    const totalSoh = d.byWarehouse.reduce((n, w) => n + Number(w.soh_value || 0), 0);
    const lastMth = closed.length >= 2 ? closed[closed.length - 2] : null;

    $('#monthBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(aud(cur.sales), `Sales · ${mLabel(cur.mth)}`,
          cur.sales_ly ? `${Number(cur.sales) >= Number(cur.sales_ly) ? '▲' : '▼'} ${n1(Math.abs(100*(cur.sales-cur.sales_ly)/cur.sales_ly))}% on the same month last year` : 'no comparison for last year')}
        ${tile(n1(cur.gp_pct) + '%', 'Gross margin', `${aud(cur.gross_profit)} on ${aud(cur.cogs)} of cost`)}
        ${tile(aud(totalSoh), 'Stock on hand', `${d.byWarehouse.length} locations at Cin7 average cost`)}
        ${lastMth ? tile(aud(lastMth.sales), `Month before · ${mLabel(lastMth.mth)}`, `margin ${n1(lastMth.gp_pct)}%`) : ''}
        ${partial ? tile(aud(partial.sales), `${mLabel(partial.mth)} so far`, 'month still running — not comparable yet', 'warn') : ''}
      </div>

      <div class="sp-panel">
        <h4>Sales and margin by month <span>net of tax · the bar is the month, the darker part is gross profit</span></h4>
        <div class="in">
          <div class="mbars">${t.map((m, i) => {
            const h = Math.round((Number(m.sales) / max) * 100);
            const gpShare = Number(m.sales) ? Number(m.gross_profit) / Number(m.sales) : 0;
            const isPartial = String(m.mth).slice(0,7) >= thisMonth;
            return `<div class="mbar ${isPartial ? 'partial' : ''} ${m.mth === cur.mth ? 'now' : ''}"
              title="${mLabel(m.mth)} — sales ${aud(m.sales)}, cost ${aud(m.cogs)}, margin ${n1(m.gp_pct)}%${isPartial ? ' · month still running' : ''}">
              <span class="t">${k$(m.sales)}</span>
              <span class="stack" style="height:${h}%">
                <span class="gp" style="height:${Math.round(gpShare*100)}%"></span>
                <span class="cg" style="height:${Math.round((1-gpShare)*100)}%"></span>
              </span>
              <span class="l">${mLabel(m.mth)}</span></div>`;
          }).join('')}</div>
          <div class="mlegend"><span><i style="background:var(--acc)"></i>gross profit</span>
            <span><i style="background:#b9cbdb"></i>cost of goods</span>
            ${partial ? '<span style="opacity:.55"><i style="background:var(--acc)"></i>faded = still running or future-dated</span>' : ''}</div>
          ${future.length ? `<p class="sp-hint" style="margin-top:8px">${future.length} month${future.length>1?'s':''} ahead already carry
            invoices in Cin7 (${future.map(f=>mLabel(f.mth)+' '+aud(f.sales)).join(', ')}). They are shown faded and never used for the headline.</p>` : ''}
        </div>
      </div>

      <div class="two">
        <div class="sp-panel">
          <h4>Stock by location <span>cover uses cost of goods, not revenue</span></h4>
          <table><thead><tr><th>Location</th><th class="n">SKUs</th><th class="n">Value</th><th class="n">Cover</th><th style="width:90px"></th></tr></thead>
          <tbody>${d.byWarehouse.map(w => `<tr>
            <td class="em">${esc(w.wh)}${w.kind !== 'BRANCH' ? ` <span class="ui-tag ui-tag--${w.kind==='QUARANTINE'?'danger':'neutral'}">${w.kind==='QUARANTINE'?'quarantine':'project'}</span>` : ''}</td>
            <td class="n">${n0(w.skus)}</td><td class="n">${aud(w.soh_value)}</td>
            <td class="n"${Number(w.months_stock) > 12 ? ' style="color:#9c5700;font-weight:600"' : ''}>${w.months_stock == null ? '—' : n1(w.months_stock)}</td>
            <td><i class="wbar ${w.kind==='QUARANTINE'?'q':''}" style="width:${Math.round((Number(w.soh_value)/maxSoh)*100)}%"></i></td></tr>`).join('')}</tbody></table>
        </div>
        <div class="sp-panel">
          <h4>${mLabel(cur.mth)} by location <span>against the same month last year</span></h4>
          <table><thead><tr><th>Location</th><th class="n">Sales</th><th class="n">Margin</th><th class="n">Orders</th><th class="n">vs LY</th></tr></thead>
          <tbody>${d.sales.filter(x => x.mth === cur.mth).map(s => `<tr>
            <td class="em">${esc(s.wh)}</td><td class="n">${aud(s.sales)}</td>
            <td class="n">${s.gp_pct == null ? '' : n1(s.gp_pct) + '%'}</td><td class="n">${n0(s.orders)}</td>
            <td class="n"><span class="grow ${Number(s.growth_pct) >= 0 ? 'up' : 'down'}">${s.growth_pct == null ? '—' : (Number(s.growth_pct) >= 0 ? '+' : '') + n1(s.growth_pct) + '%'}</span></td></tr>`).join('')}</tbody></table>
        </div>
      </div>
      <p class="sp-hint" style="max-width:74ch">Months of cover divides stock value by <b>cost of goods</b>, not by revenue.
      Dividing by revenue inflates cover by the whole margin — it is the mistake that went into the deck in April.</p>`;
  } catch (e) { $('#monthBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

/* ═══ DINHEIRO PARADO ═══════════════════════════════════════════════ */
async function loadStuck() {
  try {
    const d = await api('/stuck-money');
    const total = d.quarantine.reduce((n, q) => n + Number(q.value_aud || 0), 0);
    const dead = d.dead.reduce((n, x) => n + Number(x.value_aud || 0), 0);
    const c = d.crossTotal;
    $('#stuckBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(aud(total), 'In quarantine', 'Ghost, Faulty and Damaged — three places that only fill up', 'bad')}
        ${tile(aud(c.value_aud), 'Waiting on a customer', `${n0(c.skus)} SKUs are on backorder right now and sitting in quarantine`, 'bad')}
        ${tile(n0(c.only_here), 'Exist only in quarantine', 'zero units anywhere sellable — the order cannot be filled at all', 'bad')}
        ${tile(aud(dead), 'Stopped selling', 'discontinued and run-out, still on the shelf', 'warn')}
      </div>

      <div class="two">
        <div class="sp-panel">
          <h4>The quarantine ledger</h4>
          <table><thead><tr><th>Location</th><th class="n">SKUs</th><th class="n">Units</th><th class="n">Value</th></tr></thead>
          <tbody>${d.quarantine.map(q => `<tr><td class="em">${esc(q.location)}</td>
            <td class="n">${n0(q.skus)}</td><td class="n">${n0(q.units)}</td><td class="n">${aud(q.value_aud)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="sp-panel">
          <h4>Where it sits <span>bin by bin</span></h4>
          <table><thead><tr><th>Location</th><th>Bin</th><th class="n">SKUs</th><th class="n">Value</th></tr></thead>
          <tbody>${d.byBin.slice(0,14).map(b => `<tr><td class="em">${esc(b.location)}</td><td>${esc(b.bin)}</td>
            <td class="n">${n0(b.skus)}</td><td class="n">${aud(b.value_aud)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>

      <div class="sp-panel">
        <h4>On backorder and in quarantine at the same time
          <span>the customer is waiting while the part is in the building</span></h4>
        <table><thead><tr><th>SKU</th><th class="n">Units stuck</th><th class="n">Value</th><th>Where</th>
          <th class="n">Sellable elsewhere</th><th></th></tr></thead>
        <tbody>${d.cross.map(x => `<tr>
          <td class="em mono">${esc(x.sku)}</td><td class="n">${n0(x.units)}</td><td class="n">${aud(x.value_aud)}</td>
          <td>${esc(x.locations)}</td>
          <td class="n"${x.only_in_quarantine ? ' style="color:#9c0006;font-weight:600"' : ''}>${n0(x.sellable_elsewhere)}</td>
          <td>${x.only_in_quarantine ? '<span class="ui-tag ui-tag--danger">nowhere else</span>' : ''}</td></tr>`).join('')}</tbody></table>
      </div>

      <div class="sp-panel">
        <h4>Biggest single lines in quarantine</h4>
        <table><thead><tr><th>SKU</th><th>Product</th><th>Location</th><th>Bin</th>
          <th class="n">Units</th><th class="n">Value</th><th>Cin7</th></tr></thead>
        <tbody>${d.topSkus.slice(0,30).map(s => `<tr>
          <td class="em mono">${esc(s.sku)}</td><td class="clip" title="${esc(s.product)}">${esc(String(s.product||'').slice(0,52))}</td>
          <td>${esc(s.location)}</td><td>${esc(s.bin)}</td>
          <td class="n">${n0(s.units)}</td><td class="n">${aud(s.value_aud)}</td>
          <td>${esc(s.cin7_status||'')}</td></tr>`).join('')}</tbody></table>
      </div>`;
  } catch (e) { $('#stuckBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

/* ═══ OPERAÇÕES ═════════════════════════════════════════════════════ */
async function loadOps() {
  try {
    const d = await api('/operations');
    const maxT = Math.max(...d.transfer.map(t => Number(t.transfers) || 0), 1);
    $('#opsBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(n0(d.stuckTotal.n), 'Transfers stuck', `open more than 3 days · worst is ${n0(d.stuckTotal.worst)} days`, 'bad')}
        ${tile(n1(d.sla.reduce((n,s)=>n+Number(s.avg_days)*s.orders,0) / Math.max(d.sla.reduce((n,s)=>n+s.orders,0),1)), 'Days order to dispatch', 'network average over the last 90 days')}
        ${tile(n0(d.transfer.reduce((n,t)=>n+t.transfers,0)), 'Transfers completed', 'last 90 days, to real branches')}
      </div>

      <div class="two">
        <div class="sp-panel">
          <h4>How long a transfer takes <span>departure to arrival, last 90 days</span></h4>
          <table><thead><tr><th>Branch</th><th class="n">Transfers</th><th class="n">Median</th><th class="n">p90</th>
            <th class="n">Worst</th><th class="n">Over 5d</th></tr></thead>
          <tbody>${d.transfer.map(t => `<tr>
            <td class="em">${esc(t.branch)}</td><td class="n">${n0(t.transfers)}</td>
            <td class="n">${n1(t.median_days)}d</td><td class="n">${n1(t.p90_days)}d</td>
            <td class="n"${t.worst_days > 10 ? ' style="color:#9c0006;font-weight:600"' : ''}>${n0(t.worst_days)}d</td>
            <td class="n"${t.over_5_days > 10 ? ' style="color:#9c5700;font-weight:600"' : ''}>${n0(t.over_5_days)}</td></tr>`).join('')}</tbody></table>
        </div>
        <div class="sp-panel">
          <h4>Order to dispatch <span>the only SLA that can be measured — a promised date exists on 1.7% of orders</span></h4>
          <table><thead><tr><th>Branch</th><th class="n">Orders</th><th class="n">Median</th><th class="n">p90</th>
            <th class="n">Same/next day</th><th class="n">Over 5d</th></tr></thead>
          <tbody>${d.sla.map(s => `<tr>
            <td class="em">${esc(s.branch)}</td><td class="n">${n0(s.orders)}</td>
            <td class="n">${n1(s.median_days)}d</td><td class="n">${n1(s.p90_days)}d</td>
            <td class="n"${Number(s.same_next_day_pct) < 60 ? ' style="color:#9c5700;font-weight:600"' : ''}>${n1(s.same_next_day_pct)}%</td>
            <td class="n">${n0(s.over_5_days)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>

      <div class="sp-panel">
        <h4>Transfers that never closed <span>left and did not arrive, or was created and never left</span></h4>
        <table><thead><tr><th>Transfer</th><th>From</th><th>To</th><th>Status</th>
          <th class="n">Lines</th><th class="n">Qty</th><th class="n">Days open</th><th class="n">Days quiet</th></tr></thead>
        <tbody>${d.stuck.map(t => `<tr>
          <td class="em mono">${esc(t.transfer_number)}</td><td>${esc(t.from_location)}</td><td>${esc(t.to_location)}</td>
          <td>${esc(t.status)}</td><td class="n">${n0(t.line_count)}</td><td class="n">${n0(t.total_qty)}</td>
          <td class="n"${t.days_open > 30 ? ' style="color:#9c0006;font-weight:600"' : ''}>${n0(t.days_open)}</td>
          <td class="n">${n0(t.days_quiet)}</td></tr>`).join('')}</tbody></table>
      </div>`;
  } catch (e) { $('#opsBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}

/* ═══ LIBERAR AGORA ═════════════════════════════════════════════════ */
let relKind = '';
async function loadRelease() {
  try {
    const d = await api('/releasable' + (relKind ? `?kind=${relKind}` : ''));
    const s = d.summary;
    const tot = s.reduce((a, x) => ({ orders: a.orders + x.orders, value: a.value + Number(x.value_aud || 0) }), { orders: 0, value: 0 });
    const branch = s.find(x => x.branch_kind === 'BRANCH') || {};
    const project = s.find(x => x.branch_kind === 'PROJECT') || {};
    const pip = $('#pipRel'); pip.textContent = n0(tot.orders); pip.classList.toggle('on', tot.orders > 0);
    $('#relCount').textContent = `${n0(d.rows.length)} orders`;
    $('#relBody').innerHTML = `
      <div class="sp-tiles">
        ${tile(n0(tot.orders), 'Orders that could ship today', 'every backordered line has sellable stock available now', 'bad')}
        ${tile(aud(tot.value), 'Sitting in those orders', 'invoiced value waiting on nothing')}
        ${tile(n0(branch.orders), 'Branch orders', `${aud(branch.value_aud)} · oldest ${n0(branch.worst_age)} days`)}
        ${tile(n0(project.orders), 'Project orders', `${aud(project.value_aud)} · oldest ${n0(project.worst_age)} days`, 'warn')}
      </div>
      <div class="sp-panel">
        <h4>Oldest first <span>click an order to see which lines and where the stock is</span></h4>
        <table><thead><tr><th>Order</th><th>Customer</th><th>Location</th><th class="n">Ordered</th>
          <th class="n">Waiting</th><th class="n">Lines</th><th class="n">Value</th></tr></thead>
        <tbody>${d.rows.map(r => `<tr class="click" data-order="${esc(r.order_number)}">
          <td class="em mono">${esc(r.order_number)}</td>
          <td class="clip" title="${esc(r.customer)}">${esc(String(r.customer||'').slice(0,38))}</td>
          <td>${esc(r.branch)}${r.branch_kind === 'PROJECT' ? ' <span class="ui-tag ui-tag--warn">project</span>' : ''}</td>
          <td class="n">${d10(r.order_date)}</td>
          <td class="n"${r.age_days > 90 ? ' style="color:#9c0006;font-weight:600"' : ''}>${n0(r.age_days)} d</td>
          <td class="n">${n0(r.bo_lines)}</td><td class="n">${aud(r.order_value)}</td></tr>`).join('')
          || '<tr><td colspan="7"><div class="sp-empty">Nothing to release.</div></td></tr>'}</tbody></table>
      </div>
      <p class="sp-hint" style="max-width:74ch">The Open Orders screen filters project warehouses out, which hides the
      bigger half of the company's backorder. Both are shown here — hiding is not the same as deciding.</p>`;
    $('#relBody').onclick = async e => {
      const tr = e.target.closest('[data-order]'); if (!tr) return;
      const no = tr.dataset.order;
      try {
        const lines = await api(`/releasable/${encodeURIComponent(no)}/lines`);
        side(no, `<table class="brk">${lines.map(l => `
          <tr><td><span class="mono">${esc(l.sku)}</span><br>
            <span style="color:var(--mut-3);font-size:11px">${esc(String(l.product_name||'').slice(0,54))}</span></td>
            <td>${n0(l.bo_qty)} on backorder<br>
            <span style="color:${l.coverable?'var(--xl-good-ink)':'var(--xl-bad-ink)'};font-size:11.5px">
              ${n0(l.available)} available${l.where_it_is ? ' · ' + esc(l.where_it_is) : ''}</span></td></tr>`).join('')}</table>`);
      } catch (err) { toast(err.message, true); }
    };
  } catch (e) { $('#relBody').innerHTML = `<div class="sp-empty">${esc(e.message)}</div>`; }
}
$$('.sp-view[data-view=release] .sp-chip').forEach(c => c.addEventListener('click', () => {
  relKind = c.dataset.kind;
  $$('.sp-view[data-view=release] .sp-chip').forEach(x => x.classList.toggle('is-on', x === c));
  loadRelease();
}));

loadMonth();
