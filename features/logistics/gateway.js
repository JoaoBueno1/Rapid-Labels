// Gateway standalone page: extracted logic from Deliveries & Couriers gateway section

window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

const state = {
  pagination: { offset: 0, limit: 25 },
  gateway: { from:'', to:'', period:'week' },
  gwYears: []
};

function isoToLabel(dStr){
  try{ const d = new Date(dStr+'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short' });
  } catch{ return dStr; }
}
function ymToLabel(ym){
  try{ const d = new Date(`${ym}-01T00:00:00`); return d.toLocaleDateString(undefined, { month:'short', year:'numeric' }); } catch{ return ym; }
}
function toISODateStr(v){
  try{
    if (!v) return '';
    if (typeof v === 'string') return v.length>=10 ? v.slice(0,10) : v;
    if (v instanceof Date) return v.toISOString().slice(0,10);
    const s = String(v); return s.length>=10 ? s.slice(0,10) : s;
  } catch{ return String(v||'').slice(0,10); }
}
function yearOf(v){ return toISODateStr(v).slice(0,4); }
function ymOf(v){ return toISODateStr(v).slice(0,7); }
function weekKey(dStr){
  try{ const d=new Date(dStr+'T00:00:00'); const wd=d.getDay(); const monday=new Date(d); monday.setDate(d.getDate()-((wd+6)%7)); return monday.toISOString().slice(0,10); } catch{ return dStr; }
}
function daysBetweenISO(a,b){ try{ const d1=new Date(a+'T00:00:00'), d2=new Date(b+'T00:00:00'); return Math.floor((d2-d1)/(1000*60*60*24)); } catch{ return 0; } }
function monthsBetweenISO(a,b){ try{ const [y1,m1]=a.split('-').map(n=>parseInt(n,10)); const [y2,m2]=b.split('-').map(n=>parseInt(n,10)); return (y2*12+m2)-(y1*12+m1)+1; } catch{ return 0; } }
function setOverlayForChart(canvasEl, className, message){
  if (!canvasEl) return; const card=canvasEl.closest('.log-card'); if (!card) return; let note=card.querySelector('.'+className);
  if (message){ if (!note){ note=document.createElement('div'); note.className=className; note.style.cssText='position:absolute; inset:auto 8px 8px 8px; background:#fff8; backdrop-filter:saturate(180%) blur(2px); border:1px solid #e2e8f0; border-radius:8px; padding:8px; font-size:12px; color:#334155;'; card.style.position='relative'; card.appendChild(note);} note.textContent=message; note.style.display='block'; } else if (note){ note.style.display='none'; }
}
function deriveGwRange(filters){
  const { from, to, period } = filters || {}; if (from || to) return { from, to };
  const today = new Date();
  if (period === 'month'){
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth()+1, 0);
    return { from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10) };
  }
  if (period === 'week'){
    const d = new Date(today); const wd=d.getDay(); const monday=new Date(d); monday.setDate(d.getDate()-((wd+6)%7)); const sunday=new Date(monday); sunday.setDate(monday.getDate()+6);
    return { from: monday.toISOString().slice(0,10), to: sunday.toISOString().slice(0,10) };
  }
  return { from, to };
}

async function fetchGatewayDaily(gatewayFilters, pagination){
  await window.supabaseReady; const sb=window.supabase; const { from, to } = gatewayFilters||{}; const { offset=0, limit=200 } = pagination||{};
  const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : [];
  let eff;
  if (gwYears.length){ const minY=Math.min(...gwYears), maxY=Math.max(...gwYears); eff={ from:`${minY}-01-01`, to:`${maxY}-12-31` }; }
  else { eff = deriveGwRange({ from, to, period: gatewayFilters?.period }); }
  const gwYearsSet = new Set((state.gwYears||[]).map(String));
  const aggregateMonthly = gwYearsSet.size > 0;
  let q = sb.from('gateway_daily').select('record_date, pallets_to_gateway, pallets_to_main, total');
  if (eff.from) q = q.gte('record_date', eff.from); if (eff.to) q = q.lte('record_date', eff.to);
  if (aggregateMonthly){
    q = q.order('record_date', { ascending:true }).limit(20000); const { data, error } = await q; if (error){ console.warn('fetchGatewayDaily (monthly) error', error); return { items: [] }; }
    const rows = gwYearsSet.size ? (data||[]).filter(r=> gwYearsSet.has(yearOf(r.record_date))) : (data||[]);
    const map=new Map(); rows.forEach(r=>{ const ym=ymOf(r.record_date); const m=map.get(ym)||{ toGateway:0, toMain:0, total:0 }; const tg=(r.pallets_to_gateway||0), tm=(r.pallets_to_main||0); m.toGateway+=tg; m.toMain+=tm; m.total+=(r.total ?? (tg+tm)); map.set(ym,m); });
    const yms=[...map.keys()].sort().reverse(); const all=yms.map(ym=>({ date:`${ym}-01`, ymLabel: ymToLabel(ym), toGateway: map.get(ym).toGateway, toMain: map.get(ym).toMain, total: map.get(ym).total }));
    const items = all.slice(offset, offset+limit); return { items };
  } else {
    q = q.order('record_date', { ascending:false }); const { data, error } = await q.range(offset, offset+limit-1); if (error){ console.warn('fetchGatewayDaily error', error); return { items: [] }; }
    const rows = gwYearsSet.size ? (data||[]).filter(r=> gwYearsSet.has(yearOf(r.record_date))) : (data||[]);
    const items = rows.map(r=>({ date: toISODateStr(r.record_date), toGateway:r.pallets_to_gateway||0, toMain:r.pallets_to_main||0, total: r.total || ((r.pallets_to_gateway||0)+(r.pallets_to_main||0)) }));
    return { items };
  }
}

function renderGatewayTrend(){
  setTimeout(async ()=>{
    const { items } = await fetchGatewayDaily(state.gateway, state.pagination);
    let effFrom='', effTo=''; const gwYears=Array.isArray(state.gwYears)?state.gwYears.slice():[];
    if (gwYears.length){ effFrom = `${Math.min(...gwYears)}-01-01`; effTo = `${Math.max(...gwYears)}-12-31`; }
    else { if (state.gateway.from) effFrom=state.gateway.from; if (state.gateway.to) effTo=state.gateway.to; if (!effFrom || !effTo){ const eff=deriveGwRange({ from:'', to:'', period: state.gateway.period }); effFrom=eff.from||effFrom; effTo=eff.to||effTo; } }
    const datesActive = Boolean(effFrom && effTo && (state.gateway.from || state.gateway.to));
    let gwNotice=''; let group = gwYears.length ? 'month' : 'day';
    if (!gwYears.length && datesActive){ const mdiff=monthsBetweenISO(effFrom, effTo); if (mdiff>8){ gwNotice='Selected date range spans more than 8 months. Please use annual mode (year filters).'; } const ddiff=daysBetweenISO(effFrom, effTo); if (ddiff>30) group='week'; }
    let labels=[], totals=[];
    if (group==='month'){
      if (gwYears.length && items.length && items[0].ymLabel){ const sorted=[...items].sort((a,b)=> (a.date||'')<(b.date||'')?-1:(a.date||'')>(b.date||'')?1:0); labels=sorted.map(r=>r.ymLabel); totals=sorted.map(r=> r.total ?? ((r.toGateway||0)+(r.toMain||0))); }
      else { const map=new Map(); const keys=new Set(); items.forEach(r=>{ const ym=(r.date||'').slice(0,7); const cur=map.get(ym)||0; map.set(ym, cur + (r.total ?? ((r.toGateway||0)+(r.toMain||0)))); keys.add(ym); }); const yms=[...keys].sort(); labels=yms.map(ymToLabel); totals=yms.map(k=> map.get(k)||0); }
    } else if (group==='week'){
      const map=new Map(); const keys=new Set(); items.forEach(r=>{ const wk=weekKey(r.date); const cur=map.get(wk)||0; map.set(wk, cur + (r.total ?? ((r.toGateway||0)+(r.toMain||0)))); keys.add(wk); }); const wks=[...keys].sort(); labels=wks.map(isoToLabel); totals=wks.map(k=> map.get(k)||0);
    } else {
      const sorted=[...items].sort((a,b)=> (a.date||'')<(b.date||'')?-1:(a.date||'')>(b.date||'')?1:0); labels=sorted.map(r=> isoToLabel(r.date)); totals=sorted.map(r=> r.total ?? ((r.toGateway||0) + (r.toMain||0)));
    }
    const total = totals.reduce((a,b)=>a+b,0); const trend = totals.length>1 ? (totals[totals.length-1] - totals[0]) : 0;
    document.getElementById('gwTotal').textContent = total; document.getElementById('gwTrend').textContent = trend>=0?`+${trend}`:`${trend}`;
    const avg = totals.length ? Math.round(total / totals.length) : 0; document.getElementById('gwAvg').textContent = totals.length ? avg : '—'; const avgMode = group==='month'?'Monthly':group==='week'?'Weekly':'Daily'; document.getElementById('gwAvgLabel').textContent = `Avg (${avgMode})`;
    const el = document.getElementById('chartGatewayTrend');
    if (window._gwTrend){ window._gwTrend.data.labels = labels; window._gwTrend.data.datasets[0].data = totals; window._gwTrend.update('none'); }
    else { window._gwTrend = new Chart(el, { type:'line', data:{ labels, datasets:[{ label:'Total', data: totals, borderColor:'#6366f1' }] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ display:false } } } }); }
    setOverlayForChart(document.getElementById('chartGatewayTrend'), 'gw-range-note', gwNotice || '');
  }, 100);
}

async function renderGatewayStacked(){
  await window.supabaseReady; const sb=window.supabase; let gq = sb.from('gateway_daily').select('record_date, pallets_to_gateway, pallets_to_main').order('record_date', { ascending: true });
  const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : []; let effFrom='', effTo='';
  if (gwYears.length){ const minY=Math.min(...gwYears), maxY=Math.max(...gwYears); gq = gq.gte('record_date', `${minY}-01-01`).lte('record_date', `${maxY}-12-31`); }
  else {
    if (state.gateway.from){ gq = gq.gte('record_date', state.gateway.from); effFrom = state.gateway.from; }
    if (state.gateway.to){ gq = gq.lte('record_date', state.gateway.to); effTo = state.gateway.to; }
    if (!state.gateway.from && !state.gateway.to){ const eff=deriveGwRange({ from:'', to:'', period: state.gateway.period }); if (eff.from){ gq=gq.gte('record_date', eff.from); effFrom=eff.from; } if (eff.to){ gq=gq.lte('record_date', eff.to); effTo=eff.to; } }
  }
  const { data: gw } = await gq.limit(10000); const gwYearsSet = new Set((state.gwYears||[]).map(String)); const gwRows = gwYearsSet.size ? (gw||[]).filter(r=> gwYearsSet.has(yearOf(r.record_date))) : (gw||[]);
  let labelsArr=[], toGatewayArr=[], toMainArr=[], gatewayWeeklyNotice=''; let group='day'; const datesActive=Boolean(effFrom && effTo && (state.gateway.from || state.gateway.to));
  if (gwYears.length){ group='month'; }
  else if (datesActive){ const mdiff=monthsBetweenISO(effFrom, effTo); if (mdiff>8){ gatewayWeeklyNotice='Selected date range spans more than 8 months. Please use annual mode (year filters).'; } const ddiff=daysBetweenISO(effFrom, effTo); group = (ddiff>30)?'week':'day'; }
  if (group==='month'){
    const map=new Map(); const keys=new Set(); gwRows.forEach(r=>{ const ym=ymOf(r.record_date); const m=map.get(ym)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(ym,m); keys.add(ym); }); const yms=[...keys].sort(); labelsArr=yms.map(ymToLabel); toGatewayArr=yms.map(k=> (map.get(k)?.g||0)); toMainArr=yms.map(k=> (map.get(k)?.m||0));
  } else if (group==='week'){
    const map=new Map(); const keys=new Set(); gwRows.forEach(r=>{ const wk=weekKey(r.record_date); const m=map.get(wk)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(wk,m); keys.add(wk); }); const wks=[...keys].sort(); labelsArr=wks.map(isoToLabel); toGatewayArr=wks.map(k=> (map.get(k)?.g||0)); toMainArr=wks.map(k=> (map.get(k)?.m||0));
  } else {
    const map=new Map(); const keys=new Set(); gwRows.forEach(r=>{ const d=toISODateStr(r.record_date); const m=map.get(d)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(d,m); keys.add(d); }); const days=[...keys].sort(); labelsArr=days.map(isoToLabel); toGatewayArr=days.map(k=> (map.get(k)?.g||0)); toMainArr=days.map(k=> (map.get(k)?.m||0));
  }
  const el = document.getElementById('chartGateway');
  if (window._gwStacked){ window._gwStacked.data.labels = labelsArr; window._gwStacked.data.datasets[0].data = toGatewayArr; window._gwStacked.data.datasets[1].data = toMainArr; window._gwStacked.update('none'); }
  else { window._gwStacked = new Chart(el, { type:'bar', data:{ labels:labelsArr, datasets:[ { label:'Gateway', data:toGatewayArr, backgroundColor:'#6366f1', stack:'gw' }, { label:'Main Warehouse', data:toMainArr, backgroundColor:'#06b6d4', stack:'gw' } ] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ position:'top' } }, scales:{ x:{ stacked:true, ticks:{ autoSkip:true, maxRotation:0 } }, y:{ stacked:true, beginAtZero:true } } } }); }
  setOverlayForChart(el, 'gw-range-note', gatewayWeeklyNotice || '');
}

// Year chips and filters
function renderGwYearChips(){
  const container=document.getElementById('gwYearChips'); if (!container) return; const YEARS=[2024,2025,2026,2027,2028]; container.innerHTML='';
  const gwYearClearBtn = document.getElementById('gwYearClear'); if (gwYearClearBtn) gwYearClearBtn.onclick=()=>{ clearGwYears(); renderGwYearChips(); renderGatewayTrend(); renderGatewayStacked(); loadTables(); };
  YEARS.forEach(y=>{ const b=document.createElement('button'); b.className='chip'; b.textContent=String(y); if (state.gwYears.includes(y)) b.classList.add('active'); b.onclick=()=>{ const i=state.gwYears.indexOf(y); if (i>=0) state.gwYears.splice(i,1); else state.gwYears.push(y); b.classList.toggle('active'); const any=state.gwYears.length>0; if (any){ clearGwDates(); disableGwPeriodButtons(true); document.getElementById('gwFrom')?.classList.add('disabled'); document.getElementById('gwTo')?.classList.add('disabled'); document.getElementById('gwFrom')?.setAttribute('disabled','true'); document.getElementById('gwTo')?.setAttribute('disabled','true'); } else { document.getElementById('gwFrom')?.classList.remove('disabled'); document.getElementById('gwTo')?.classList.remove('disabled'); document.getElementById('gwFrom')?.removeAttribute('disabled'); document.getElementById('gwTo')?.removeAttribute('disabled'); disableGwPeriodButtons(false); } renderGatewayTrend(); renderGatewayStacked(); loadTables(); }; container.appendChild(b); });
  // Reflect current active state on Years button
  const yBtn = document.getElementById('gwYearSelectorBtn'); if (yBtn){ yBtn.classList.toggle('active', state.gwYears.length>0); }
}
function clearGwYears(){ state.gwYears=[]; document.getElementById('gwFrom')?.classList.remove('disabled'); document.getElementById('gwTo')?.classList.remove('disabled'); document.getElementById('gwFrom')?.removeAttribute('disabled'); document.getElementById('gwTo')?.removeAttribute('disabled'); disableGwPeriodButtons(false); }
function areGwDatesActive(){ const f=document.getElementById('gwFrom')?.value; const t=document.getElementById('gwTo')?.value; return Boolean(f||t); }
function disableGwPeriodButtons(dis){ const week=document.getElementById('gwWeek'); const month=document.getElementById('gwMonth'); [week,month].forEach(b=>{ if (!b) return; b.disabled=!!dis; b.classList.toggle('disabled', !!dis); if(dis) b.classList.remove('active'); }); }
function clearGwDates(){ const f=document.getElementById('gwFrom'); const t=document.getElementById('gwTo'); if (f) f.value=''; if (t) t.value=''; state.gateway.from=''; state.gateway.to=''; state.gateway.period='week'; disableGwPeriodButtons(false); }
function setActive(activeId, all){ all.forEach(id=> document.getElementById(id)?.classList.toggle('active', id===activeId)); }

async function _doLoadTables(){
  const { items } = await fetchGatewayDaily(state.gateway, state.pagination);
  const gtbody = document.querySelector('#gatewayTable tbody'); if (gtbody){ let ghtml=''; items.forEach(r=>{ const label=r.ymLabel || r.date; ghtml += `<tr><td>${label}</td><td class="num">${r.toGateway}</td><td class="num">${r.toMain}</td><td class="num">${r.total}</td></tr>`; }); gtbody.innerHTML = ghtml; }
  const gwDetailGran=document.getElementById('gwDetailGran'); if (gwDetailGran){ const isMonthly=(state.gwYears && state.gwYears.length>0); gwDetailGran.textContent = isMonthly ? '(Monthly)' : '(Daily)'; }
}
function loadTables(){ setTimeout(_doLoadTables, 60); }

function bind(){
  const gwWeek=document.getElementById('gwWeek'); const gwMonth=document.getElementById('gwMonth');
  if (gwWeek) gwWeek.addEventListener('click', ()=>{ if (areGwDatesActive()) clearGwDates(); if (state.gwYears.length) clearGwYears(); state.gateway.period='week'; setActive('gwWeek', ['gwWeek','gwMonth']); renderGatewayTrend(); renderGatewayStacked(); loadTables(); });
  if (gwMonth) gwMonth.addEventListener('click', ()=>{ if (areGwDatesActive()) clearGwDates(); if (state.gwYears.length) clearGwYears(); state.gateway.period='month'; setActive('gwMonth', ['gwWeek','gwMonth']); renderGatewayTrend(); renderGatewayStacked(); loadTables(); });
  ['gwFrom','gwTo'].forEach(id=> document.getElementById(id)?.addEventListener('change', ()=>{ state.gateway.from=document.getElementById('gwFrom').value; state.gateway.to=document.getElementById('gwTo').value; const gwDatesActive=areGwDatesActive(); if (gwDatesActive){ state.gateway.period='range'; disableGwPeriodButtons(true); } else { disableGwPeriodButtons(false); } renderGatewayTrend(); renderGatewayStacked(); loadTables(); }));
  document.getElementById('gwClearDates')?.addEventListener('click', ()=>{ clearGwDates(); clearGwYears(); renderGwYearChips(); setActive('gwWeek', ['gwWeek','gwMonth']); renderGatewayTrend(); renderGatewayStacked(); loadTables(); });

  // Smart selector open/close for Gateway Years
  const gSel = document.getElementById('gwYearSelector');
  const gBtn = document.getElementById('gwYearSelectorBtn');
  const gPanel = document.getElementById('gwYearSelectorPanel');
  if (gBtn && gSel){
    gBtn.addEventListener('click', (e)=>{ e.stopPropagation(); const open = gSel.classList.toggle('open'); gBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); });
    gPanel?.addEventListener('click', (e)=> e.stopPropagation());
  }
  // Global outside click to close any open smart selector
  document.addEventListener('click', ()=>{
    document.querySelectorAll('.smart-selector.open').forEach(el=>{
      const btn = el.querySelector('button[aria-haspopup="true"]');
      el.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded','false');
    });
  });

  // Register modal (copy)
  (()=>{
    const modal=document.getElementById('gwRegisterModal'); if (!modal) return;
    modal.hidden=true; modal.classList.remove('open');
    const openBtn=document.getElementById('openGwRegister'); const closeBtn=document.getElementById('closeGwRegister'); const cancelBtn=document.getElementById('cancelGwRegister'); const saveBtn=document.getElementById('saveGwRegister');
    const dateInput=document.getElementById('gwRegDate'); const warn=document.getElementById('gwRegDateWarn'); const toGateway=document.getElementById('gwRegToGateway'); const toMain=document.getElementById('gwRegToMain'); const totalEl=document.getElementById('gwRegTotal');
    function setEnabled(enabled){ toGateway.disabled=!enabled; toMain.disabled=!enabled; }
    function showWarn(){ if (warn) warn.style.display='block'; }
    function hideWarn(){ if (warn) warn.style.display='none'; }
    function parseNum(v){ const n=parseInt((v??'').toString().trim(),10); return Number.isFinite(n)?n:0; }
    function recompute(){ if (totalEl) totalEl.textContent = String(parseNum(toGateway.value) + parseNum(toMain.value)); }
    function open(){ modal.classList.add('open'); modal.hidden=false; const hasDate=!!dateInput?.value; setEnabled(hasDate); if (hasDate) hideWarn(); else showWarn(); recompute(); }
    function close(){ modal.classList.remove('open'); modal.hidden=true; }
    openBtn?.addEventListener('click', open); closeBtn?.addEventListener('click', close); cancelBtn?.addEventListener('click', close); modal.addEventListener('click', (e)=>{ if (e.target===modal) close(); });
    dateInput?.addEventListener('change', ()=>{ const hasDate=!!dateInput.value; setEnabled(hasDate); if (hasDate) hideWarn(); else showWarn(); });
    ['input','change'].forEach(evt=>{ toGateway?.addEventListener(evt, recompute); toMain?.addEventListener(evt, recompute); });
    async function saveGateway(date, toG, toM){ await window.supabaseReady; const sb=window.supabase; const payload={ record_date: date, pallets_to_gateway: toG||0, pallets_to_main: toM||0 }; const { error } = await sb.from('gateway_daily').upsert(payload, { onConflict: 'record_date' }); if (error){ console.warn('saveGateway error', error.message); } }
    saveBtn?.addEventListener('click', async ()=>{ const date = dateInput?.value || ''; if (!date){ showWarn(); dateInput?.focus(); return; } const toG=parseNum(toGateway.value), toM=parseNum(toMain.value); try{ await saveGateway(date, toG, toM); try{ const key='gateway:lockedDates'; const set=new Set(JSON.parse(localStorage.getItem(key)||'[]')); set.add(date); localStorage.setItem(key, JSON.stringify([...set])); }catch{} } finally { renderGatewayStacked(); renderGatewayTrend(); loadTables(); } close(); });
  })();
}

function load(){ renderGwYearChips(); bind(); setActive('gwWeek', ['gwWeek','gwMonth']); renderGatewayStacked(); renderGatewayTrend(); loadTables(); }

load();
