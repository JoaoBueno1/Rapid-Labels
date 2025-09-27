// Feature flag local to this page
window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

import { getInvoicingKpis, getInvoicingCharts, getUninvoicedTable } from './mocks/invoicing-monitor.mocks.js';

const state = { filters: { from:'', to:'', status:'', customer:'', currency:'', terms:'', channel:'', rep:'' }, pagination: { offset: 0, limit: 25 }, bucket: 'All' };

function setKpis(k){
  document.getElementById('kpiD0').textContent = `${k.pctSameDay.toFixed(1)}%`;
  document.getElementById('kpiYesterday').textContent = `${k.uninvoicedYesterday}`;
  document.getElementById('kpiWeek').textContent = `${k.uninvoicedLastWeek}`;
  document.getElementById('kpiAvg').textContent = `${k.avgTimeDays.toFixed(1)}`;
}

let chartWeeklyPct, chartByRep;
function renderCharts(d){
  chartWeeklyPct && chartWeeklyPct.destroy();
  chartWeeklyPct = new Chart(document.getElementById('chartWeeklyPct'), {
    type: 'line',
    data: { labels: d.weeklyPctInvoiced.labels, datasets: [
      { label: 'D+0', data: d.weeklyPctInvoiced.d0, borderColor: '#22c55e' },
      { label: 'D+1', data: d.weeklyPctInvoiced.d1, borderColor: '#eab308' },
      { label: 'D+3', data: d.weeklyPctInvoiced.d3, borderColor: '#ef4444' },
    ] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ position:'top' } } }
  });

  chartByRep && chartByRep.destroy();
  chartByRep = new Chart(document.getElementById('chartByRep'), {
    type: 'bar',
    data: { labels: d.uninvoicedByRep.labels, datasets: [{ label: 'Uninvoiced', data: d.uninvoicedByRep.data, backgroundColor: '#3b82f6' }] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ autoSkip:true, maxRotation: 0 } }, y:{ beginAtZero:true } } }
  });
}

async function load(){
  const k = await getInvoicingKpis(state.filters);
  setKpis(k);
  const ch = await getInvoicingCharts(state.filters);
  renderCharts(ch);
  await loadTable();
}

async function loadTable(){
  const res = await getUninvoicedTable(state.filters, state.bucket, state.pagination);
  const tbody = document.querySelector('#uninvoicedTable tbody');
  tbody.innerHTML = '';
  res.items.forEach(r=>{
    const tr = document.createElement('tr');
    if (r.daysPending > 3) tr.classList.add('highlight');
  tr.innerHTML = `<td>${r.order}</td><td>${r.customer}</td><td>${r.orderDate}</td><td class="num">${r.daysPending}</td><td>${r.rep}</td><td>${r.status}</td>`;
    tbody.appendChild(tr);
  });
}

function bind(){
  document.querySelectorAll('.chip[data-bucket]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('.chip[data-bucket]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      state.bucket = btn.dataset.bucket;
      loadTable();
    });
  });
  document.getElementById('applyFilters').addEventListener('click', ()=>{
    state.filters = {
      from: document.getElementById('fromDate').value,
      to: document.getElementById('toDate').value,
      status: document.getElementById('status').value,
      customer: document.getElementById('customer').value.trim(),
      currency: document.getElementById('currency').value.trim(),
      terms: document.getElementById('terms').value.trim(),
      channel: document.getElementById('channel').value.trim(),
      rep: document.getElementById('rep').value.trim(),
    };
    load();
  });
  document.getElementById('clearFilters').addEventListener('click', ()=>{
    ['fromDate','toDate','status','customer','currency','terms','channel','rep'].forEach(id=>{
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    state.filters = { from:'', to:'', status:'', customer:'', currency:'', terms:'', channel:'', rep:'' };
    load();
  });
}

bind();
load();
