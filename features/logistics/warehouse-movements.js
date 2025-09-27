// Feature flag local to this page
window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

import { getWarehouseKpis, getWarehouseCharts, getWarehouseErrorsTable } from './mocks/warehouse-movements.mocks.js';

const state = {
  filters: { from: '', to: '', warehouse: '', movementType: '', status: '', sku: '', reason: '', picker: '' },
  pagination: { offset: 0, limit: 25 },
  activeKpi: 'errors', // 'errors' | 'correct' | 'osk'
};

function qs(id){ return document.getElementById(id); }

function setKpis(data){
  qs('kpiCorrectValue').textContent = `${data.correctOrdersPct.toFixed(1)}%`;
  qs('kpiErrorsValue').textContent = `${data.ordersWithErrorsPct.toFixed(1)}%`;
  qs('kpiOskValue').textContent = `${data.skusOutOfStockLocator}`;
}

let chartWeekly, chartPicker, chartHeatmap, chartTypes;

function renderCharts(d){
  const ctxW = document.getElementById('chartWeekly');
  chartWeekly && chartWeekly.destroy();
  chartWeekly = new Chart(ctxW, {
    type: 'line',
    data: { labels: d.weeklyErrorsPct.labels, datasets: [{ label: '% Errors', data: d.weeklyErrorsPct.data, borderColor: '#dc3545', backgroundColor: 'rgba(220,53,69,0.2)' }] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: {top: 8, right: 8, bottom: 8, left: 8} }, plugins:{ legend:{ position:'top', labels:{ boxWidth: 12 } } } }
  });

  const ctxP = document.getElementById('chartPicker');
  chartPicker && chartPicker.destroy();
  chartPicker = new Chart(ctxP, {
    type: 'bar',
    data: { labels: d.errorsByPicker.labels, datasets: [{ label: 'Errors', data: d.errorsByPicker.data, backgroundColor: '#3b82f6' }] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ autoSkip:true, maxRotation: 0 } }, y:{ beginAtZero:true } } }
  });

  const ctxH = document.getElementById('chartHeatmap');
  chartHeatmap && chartHeatmap.destroy();
  // Simulate heatmap as stacked bars per row for simplicity
  chartHeatmap = new Chart(ctxH, {
    type: 'bar',
    data: { labels: d.errorsByLocationHeatmap.xLabels, datasets: d.errorsByLocationHeatmap.yLabels.map((yl, idx)=>({ label: yl, data: d.errorsByLocationHeatmap.values[idx], stack: 'heat', backgroundColor: `hsl(${(idx*60)%360} 70% 50%)` })) },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ position:'right', labels:{ boxWidth: 10 } } }, scales:{ x:{ stacked:true }, y:{ stacked:true } } }
  });

  const ctxT = document.getElementById('chartTypes');
  chartTypes && chartTypes.destroy();
  chartTypes = new Chart(ctxT, {
    type: 'doughnut',
    data: { labels: d.errorTypeDistribution.labels, datasets: [{ data: d.errorTypeDistribution.data, backgroundColor: ['#dc3545','#ffc107','#3b82f6','#6b7280'] }] },
    options: { responsive:true, maintainAspectRatio:false, layout:{ padding: 8 }, plugins:{ legend:{ position:'bottom', labels:{ boxWidth: 12 } } } }
  });
}

async function load(){
  const kpis = await getWarehouseKpis(state.filters);
  setKpis(kpis);
  const charts = await getWarehouseCharts(state.filters);
  renderCharts(charts);
  await loadTable();
}

async function loadTable(){
  const res = await getWarehouseErrorsTable({ ...state.filters, focus: state.activeKpi }, state.pagination);
  const tbody = document.querySelector('#errorsTable tbody');
  tbody.innerHTML = '';
  res.items.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.order}</td><td>${r.customer}</td><td>${r.date}</td><td>${r.usedLocation}</td><td>${r.correctLocator}</td>`;
    tbody.appendChild(tr);
  });
}

function bind(){
  ['kpi-correct','kpi-errors','kpi-osk'].forEach((id)=>{
    document.getElementById(id).addEventListener('click', ()=>{
      state.activeKpi = id==='kpi-correct' ? 'correct' : id==='kpi-osk' ? 'osk' : 'errors';
      loadTable();
      document.querySelector('.section').scrollIntoView({ behavior:'smooth' });
    });
  });
  // Apply/Clear filters
  document.getElementById('applyFilters').addEventListener('click', ()=>{
    state.filters = {
      from: document.getElementById('fromDate').value,
      to: document.getElementById('toDate').value,
      warehouse: document.getElementById('warehouse').value,
      movementType: document.getElementById('movementType').value,
      status: document.getElementById('status').value,
      sku: document.getElementById('sku').value.trim(),
      reason: document.getElementById('reason').value.trim(),
      picker: document.getElementById('picker').value.trim(),
    };
    load();
  });
  document.getElementById('clearFilters').addEventListener('click', ()=>{
    ['fromDate','toDate','warehouse','movementType','status','sku','reason','picker'].forEach(id=>{
      const el = document.getElementById(id);
      if (el.tagName === 'SELECT') el.value = '';
      else el.value = '';
    });
    state.filters = { from:'', to:'', warehouse:'', movementType:'', status:'', sku:'', reason:'', picker:'' };
    load();
  });
  // Import button now navigates (no modal)
}

bind();
load();
