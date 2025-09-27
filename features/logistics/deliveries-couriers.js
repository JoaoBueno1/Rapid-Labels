// Feature flag local to this page
window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true;

// Replaced mocks with live Supabase calls. Mocks file is no longer used.

// Keep in sync with mocks TYPES list for full chips rendering
const TYPES = ['Van Brisbane','Van Gold Coast','Endless Summer','Direct Freight','Phoenix','Jet','Aramex','Australia Post'];
// Helpers for robust normalization
const _alnum = s => (s ?? '').toString().toLowerCase().replace(/[^a-z0-9]+/g,'');
const _sortedTokens = s => ((s ?? '').toString().toLowerCase().match(/[a-z0-9]+/g) || []).sort().join('');
// Build canonical maps: join-no-punct and sorted-tokens for order-insensitive matching
const _TYPE_CANON_JOIN = new Map();
const _TYPE_CANON_SORT = new Map();
TYPES.forEach(t => { _TYPE_CANON_JOIN.set(_alnum(t), t); _TYPE_CANON_SORT.set(_sortedTokens(t), t); });
// Some common synonyms/abbrevs
const _TYPE_SYNONYM = new Map([
  ['auspost', 'Australia Post'],
  ['austpost', 'Australia Post'],
  ['australiapost', 'Australia Post'],
  ['df', 'Direct Freight'],
  ['directfreight', 'Direct Freight'],
  ['directfrt', 'Direct Freight']
]);
function canonType(name){
  const rawTrim = (name ?? '').toString().trim();
  const kJoin = _alnum(rawTrim);
  const kSort = _sortedTokens(rawTrim);
  // Direct synonyms first
  if (_TYPE_SYNONYM.has(kJoin)) return _TYPE_SYNONYM.get(kJoin);
  // Exact canonical (join) then order-insensitive (sorted)
  if (_TYPE_CANON_JOIN.has(kJoin)) return _TYPE_CANON_JOIN.get(kJoin);
  if (_TYPE_CANON_SORT.has(kSort)) return _TYPE_CANON_SORT.get(kSort);
  return rawTrim;
}

const state = {
  filters: { from:'', to:'', period:'week', collection:false, types: [], selectMode:false },
  appliedTypes: [], // charts use this only after pressing Apply in Select mode
  // Drill-down Types table independent filters
  tableFilters: { from:'', to:'', period:'week', collection:false, types: [], selectMode:false },
  pagination: { offset: 0, limit: 25 },
  gateway: { from:'', to:'', period:'week' },
  years: [], // no longer used (top selector removed)
  gwYears: [] // multi-select year filters for Gateway
};
// All-time table-specific year filters (multi-select; empty = all-time)
const allYears = { selected: [] };

// ---------- Supabase-backed data layer ----------
function isoToLabel(dStr){
  // Convert '2025-09-08' to 'Mon, 8 Sep'
  try{ const d = new Date(dStr+'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday:'short', day:'numeric', month:'short' });
  } catch{ return dStr; }
}
function isoToDMY(dStr){
  try{ const [y,m,d] = String(dStr||'').split('-'); return `${d.padStart(2,'0')}/${m.padStart(2,'0')}/${y}`; } catch{ return dStr; }
}
function ymToLabel(ym){
  try{ const d = new Date(`${ym}-01T00:00:00`); return d.toLocaleDateString(undefined, { month:'short', year:'numeric' }); } catch{ return ym; }
}
// Robust date normalization helpers (support 'YYYY-MM-DD', ISO timestamps, or Date objects)
function toISODateStr(v){
  try{
    if (!v) return '';
    if (typeof v === 'string'){
      // If timestamp, keep only date part
      if (v.length >= 10) return v.slice(0,10);
      return v;
    }
    if (v instanceof Date) return v.toISOString().slice(0,10);
    const s = String(v);
    return s.length >= 10 ? s.slice(0,10) : s;
  } catch{ return String(v||'').slice(0,10); }
}
function yearOf(v){ return toISODateStr(v).slice(0,4); }
function ymOf(v){ return toISODateStr(v).slice(0,7); }
// Monday week key from a YYYY-MM-DD string
function weekKey(dStr){
  try{
    const d=new Date(dStr+'T00:00:00');
    const wd=d.getDay();
    const monday=new Date(d);
    monday.setDate(d.getDate() - ((wd+6)%7));
    return monday.toISOString().slice(0,10);
  } catch{ return dStr; }
}
function daysBetweenISO(a,b){
  try{ const d1=new Date(a+'T00:00:00'), d2=new Date(b+'T00:00:00'); return Math.floor((d2 - d1) / (1000*60*60*24)); } catch{ return 0; }
}
function monthsBetweenISO(a,b){
  try{ const [y1,m1]=a.split('-').map(n=>parseInt(n,10)); const [y2,m2]=b.split('-').map(n=>parseInt(n,10)); return (y2*12 + m2) - (y1*12 + m1) + 1; } catch{ return 0; }
}
function setOverlayForChart(canvasEl, className, message){
  if (!canvasEl) return;
  const card = canvasEl.closest('.log-card'); if (!card) return;
  let note = card.querySelector('.'+className);
  if (message){
    if (!note){ note = document.createElement('div'); note.className = className; note.style.cssText = 'position:absolute; inset:auto 8px 8px 8px; background:#fff8; backdrop-filter:saturate(180%) blur(2px); border:1px solid #e2e8f0; border-radius:8px; padding:8px; font-size:12px; color:#334155;'; card.style.position='relative'; card.appendChild(note); }
    note.textContent = message; note.style.display = 'block';
  } else if (note){ note.style.display = 'none'; }
}
// Derive calendar range specifically for Gateway filters
function deriveGwRange(filters){
  const { from, to, period } = filters || {};
  if (from || to) return { from, to };
  const today = new Date();
  if (period === 'month'){
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth()+1, 0);
    return { from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10) };
  }
  if (period === 'week'){
    const d = new Date(today);
    const wd = d.getDay();
    const monday = new Date(d); monday.setDate(d.getDate() - ((wd+6)%7));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return { from: monday.toISOString().slice(0,10), to: sunday.toISOString().slice(0,10) };
  }
  return { from, to };
}
// Derive a compact date range when user didn't set from/to to reduce dataset size
function deriveRange(filters){
  const { from, to, period } = filters || {};
  if (from || to) return { from, to };
  const today = new Date();
  if (period === 'month'){
    // Use current calendar month
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth()+1, 0);
    return { from: start.toISOString().slice(0,10), to: end.toISOString().slice(0,10) };
  }
  if (period === 'week'){
    // Monday to Sunday of current week
    const d = new Date(today);
    const wd = d.getDay();
    const monday = new Date(d); monday.setDate(d.getDate() - ((wd+6)%7));
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return { from: monday.toISOString().slice(0,10), to: sunday.toISOString().slice(0,10) };
  }
  return { from, to };
}

// Paginated fetchers to avoid PostgREST row limits and support arbitrary long ranges
async function fetchAllDeliveriesRows({ from, to }){
  await window.supabaseReady; const sb = window.supabase;
  const pageSize = 1000; let offset = 0; let rows = []; let page = []; let safety = 0;
  do{
    let q = sb.from('deliveries_daily').select('record_date, type, orders, cartons, pallets').order('record_date', { ascending: true });
    if (from) q = q.gte('record_date', from);
    if (to) q = q.lte('record_date', to);
    const { data, error } = await q.range(offset, offset + pageSize - 1);
    if (error){ console.warn('fetchAllDeliveriesRows error', error); break; }
    page = data || [];
    rows = rows.concat(page);
    offset += pageSize; safety++;
    if (safety > 200){ console.warn('fetchAllDeliveriesRows: aborting after many pages'); break; }
  } while(page.length === pageSize);
  return rows;
}

async function fetchAllCollectionsRows({ from, to }){
  await window.supabaseReady; const sb = window.supabase;
  const pageSize = 1000; let offset = 0; let rows = []; let page = []; let safety = 0;
  do{
    let q = sb.from('collections_daily').select('record_date, orders, cartons, pallets').order('record_date', { ascending: true });
    if (from) q = q.gte('record_date', from);
    if (to) q = q.lte('record_date', to);
    const { data, error } = await q.range(offset, offset + pageSize - 1);
    if (error){ console.warn('fetchAllCollectionsRows error', error); break; }
    page = data || [];
    rows = rows.concat(page);
    offset += pageSize; safety++;
    if (safety > 200){ console.warn('fetchAllCollectionsRows: aborting after many pages'); break; }
  } while(page.length === pageSize);
  return rows;
}

async function fetchKpis(filters){
  await window.supabaseReady;
  const sb = window.supabase;
  // Derive range by filters
  let { from, to, period, collection } = filters || {};
  const topYears = Array.isArray(state.years) ? state.years.slice() : [];
  const yearsSet = new Set((topYears||[]).map(String));
  if (!topYears.length){ ({ from, to } = deriveRange({ from, to, period })); }
  if (collection){
    // Collections mode: use paginated fetch across any range
    let rows = [];
    if (topYears.length){
      const minY = Math.min(...topYears), maxY = Math.max(...topYears);
      rows = await fetchAllCollectionsRows({ from: `${minY}-01-01`, to: `${maxY}-12-31` });
      rows = rows.filter(r=> yearsSet.has(yearOf(r.record_date)));
    } else {
      rows = await fetchAllCollectionsRows({ from, to });
    }
    const sum = rows.reduce((a,r)=>{ a.orders+=r.orders||0; a.cartons+=r.cartons||0; a.pallets+=r.pallets||0; return a; }, {orders:0,cartons:0,pallets:0});
    return { weeklyOrders: sum.orders, cartons: sum.cartons, pallets: sum.pallets, topCourier:'Collections' };
  }
  // Deliveries by type mode
  let rows = [];
  if (topYears.length){
    const minY = Math.min(...topYears), maxY = Math.max(...topYears);
    rows = await fetchAllDeliveriesRows({ from: `${minY}-01-01`, to: `${maxY}-12-31` });
    rows = rows.filter(r=> yearsSet.has(yearOf(r.record_date)));
  } else {
    rows = await fetchAllDeliveriesRows({ from, to });
  }
  // Respect applied Types selection (after user clicks Apply). If none applied, keep all types.
  const sel = Array.isArray(state.appliedTypes) ? new Set(state.appliedTypes) : new Set();
  if (sel.size){ rows = rows.filter(r=> sel.has(r.type)); }
  const sum = rows.reduce((acc,r)=>{ acc.orders+=r.orders||0; acc.cartons+=r.cartons||0; acc.pallets+=r.pallets||0; return acc; }, {orders:0,cartons:0,pallets:0});
  // Top courier by orders
  const byType = new Map();
  (rows||[]).forEach(r=>{ byType.set(r.type, (byType.get(r.type)||0) + (r.orders||0)); });
  let topCourier = '—', topVal=-1; byType.forEach((v,k)=>{ if (v>topVal){ topVal=v; topCourier=k; } });
  // WeeklyOrders here treated as total orders in current filter
  return { weeklyOrders: sum.orders, cartons: sum.cartons, pallets: sum.pallets, topCourier };
}

async function fetchDeliveryCharts(filters){
  await window.supabaseReady; const sb = window.supabase;
  let { from, to, collection, period } = filters||{};
  const topYears = Array.isArray(state.years) ? state.years.slice() : [];
  const yearsSet = new Set((topYears||[]).map(String));
  if (!topYears.length){ ({ from, to } = deriveRange({ from, to, period })); }
  if (collection){
    // Collections mode: fetch all rows paginated
    const yearsSel = state.years||[];
    let rows = [];
    if (topYears.length){
      const minY = Math.min(...topYears), maxY = Math.max(...topYears);
      rows = await fetchAllCollectionsRows({ from: `${minY}-01-01`, to: `${maxY}-12-31` });
      rows = rows.filter(r=> yearsSet.has(yearOf(r.record_date)));
    } else {
      rows = await fetchAllCollectionsRows({ from, to });
    }
    const orders = rows.reduce((a,r)=>a+(r.orders||0),0);
    const cartons = rows.reduce((a,r)=>a+(r.cartons||0),0);
    const pallets = rows.reduce((a,r)=>a+(r.pallets||0),0);
    const byCourier = { labels:['Collections'], orders:[orders], cartons:[cartons], pallets:[pallets] };
    // Evolution series (daily or monthly) for all three metrics
    const groupMonthly = (yearsSel||[]).length >= 1;
    const weeklyByCourier = { labels: [], orders: {}, cartons: {}, pallets: {} };
    if (groupMonthly){
      const map = new Map(); // ym -> {o,c,p}
      (rows||[]).forEach(r=>{
        const ym = ymOf(r.record_date);
        const m = map.get(ym) || { o:0, c:0, p:0 };
        m.o += (r.orders||0); m.c += (r.cartons||0); m.p += (r.pallets||0);
        map.set(ym, m);
      });
      const yms = [...map.keys()].sort();
      weeklyByCourier.labels = yms.map(ymToLabel);
      weeklyByCourier.orders['Collections'] = yms.map(k=> map.get(k)?.o||0);
      weeklyByCourier.cartons['Collections'] = yms.map(k=> map.get(k)?.c||0);
      weeklyByCourier.pallets['Collections'] = yms.map(k=> map.get(k)?.p||0);
    } else {
      const map = new Map(); // day -> {o,c,p}
      (rows||[]).forEach(r=>{
        const day = toISODateStr(r.record_date);
        const m = map.get(day) || { o:0, c:0, p:0 };
        m.o += (r.orders||0); m.c += (r.cartons||0); m.p += (r.pallets||0);
        map.set(day, m);
      });
      const days = [...map.keys()].sort();
      weeklyByCourier.labels = days.map(isoToLabel);
      weeklyByCourier.orders['Collections'] = days.map(k=> map.get(k)?.o||0);
      weeklyByCourier.cartons['Collections'] = days.map(k=> map.get(k)?.c||0);
      weeklyByCourier.pallets['Collections'] = days.map(k=> map.get(k)?.p||0);
    }
    // Cartons by Type (Collections-only)
    const cartonsByType = { labels:['Collections'], data:[cartons] };
    // gatewayWeekly from gateway_daily, respect gateway filters (years or dates)
    let gq = sb.from('gateway_daily').select('record_date, pallets_to_gateway, pallets_to_main').order('record_date', { ascending: true });
    const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : [];
    let effFrom = '', effTo = '';
    if (gwYears.length){
      const minY = Math.min(...gwYears), maxY = Math.max(...gwYears);
      gq = gq.gte('record_date', `${minY}-01-01`).lte('record_date', `${maxY}-12-31`);
    } else {
      if (state.gateway.from){ gq = gq.gte('record_date', state.gateway.from); effFrom = state.gateway.from; }
      if (state.gateway.to){ gq = gq.lte('record_date', state.gateway.to); effTo = state.gateway.to; }
      if (!state.gateway.from && !state.gateway.to){
        // Apply calendar period defaults for gateway
        const eff = deriveGwRange({ from:'', to:'', period: state.gateway.period });
        if (eff.from){ gq = gq.gte('record_date', eff.from); effFrom = eff.from; }
        if (eff.to){ gq = gq.lte('record_date', eff.to); effTo = eff.to; }
      }
    }
    const { data: gw } = await gq.limit(10000);
  const gwYearsSet = new Set((state.gwYears||[]).map(String));
  const gwRows = gwYearsSet.size ? (gw||[]).filter(r=> gwYearsSet.has(yearOf(r.record_date))) : (gw||[]);
      // Decide grouping: months when gwYears; date pickers: week if >30 days, else day; default day. Notice if >8 months.
      let labelsArr = [];
      let toGatewayArr = [];
      let toMainArr = [];
      let gatewayWeeklyNotice = '';
      let group = 'day';
      const datesActive = Boolean(effFrom && effTo && (state.gateway.from || state.gateway.to));
      if (gwYears.length){ group = 'month'; }
      else if (datesActive){
        const mdiff = monthsBetweenISO(effFrom, effTo);
        if (mdiff > 8){ gatewayWeeklyNotice = 'Selected date range spans more than 8 months. Please use annual mode (year filters).'; }
        const ddiff = daysBetweenISO(effFrom, effTo);
        group = (ddiff > 30) ? 'week' : 'day';
      }
      if (group === 'month'){
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const ym=ymOf(r.record_date); const m = map.get(ym)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(ym,m); keys.add(ym); });
        const yms = [...keys].sort();
        labelsArr = yms.map(ymToLabel);
        toGatewayArr = yms.map(k=> (map.get(k)?.g||0));
        toMainArr = yms.map(k=> (map.get(k)?.m||0));
      } else if (group === 'week'){
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const wk=weekKey(r.record_date); const m = map.get(wk)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(wk,m); keys.add(wk); });
        const wks = [...keys].sort();
        labelsArr = wks.map(isoToLabel);
        toGatewayArr = wks.map(k=> (map.get(k)?.g||0));
        toMainArr = wks.map(k=> (map.get(k)?.m||0));
      } else {
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const d=toISODateStr(r.record_date); const m = map.get(d)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(d,m); keys.add(d); });
        const days = [...keys].sort();
        labelsArr = days.map(isoToLabel);
        toGatewayArr = days.map(k=> (map.get(k)?.g||0));
        toMainArr = days.map(k=> (map.get(k)?.m||0));
      }
      const gatewayWeekly = { labels: labelsArr, toGateway: toGatewayArr, toMain: toMainArr, gatewayWeeklyNotice };
  return { byCourier, weeklyByCourier, weeklyByCourierUnsupported, cartonsByType, gatewayWeekly };
  }
  // Deliveries by type mode
  let rows = [];
  if (topYears.length){
    const minY = Math.min(...topYears), maxY = Math.max(...topYears);
    rows = await fetchAllDeliveriesRows({ from: `${minY}-01-01`, to: `${maxY}-12-31` });
    rows = rows.filter(r=> yearsSet.has(yearOf(r.record_date)));
  } else {
    rows = await fetchAllDeliveriesRows({ from, to });
  }
  // byCourier totals
  const totals = TYPES.map(t=>({ t, orders:0, cartons:0, pallets:0 }));
  const idx = new Map(TYPES.map((t,i)=>[t,i]));
  rows.forEach(r=>{ const i = idx.get(r.type); if (i!=null){ totals[i].orders+=(r.orders||0); totals[i].cartons+=(r.cartons||0); totals[i].pallets+=(r.pallets||0); }});
  const byCourier = { labels: totals.map(x=>x.t), orders: totals.map(x=>x.orders), cartons: totals.map(x=>x.cartons), pallets: totals.map(x=>x.pallets) };
  // Evolution chart series for all three metrics
  const yearsSel = state.years||[];
  const groupMonthly = (yearsSel||[]).length >= 1; // any year selection => monthly; otherwise daily
  const weeklyByCourier = { labels: [], orders: {}, cartons: {}, pallets: {} };
  if (groupMonthly){
    const map = new Map(); // ym -> Map(type -> {o,c,p})
    rows.forEach(r=>{
      const ym = ymOf(r.record_date);
      const inner = map.get(ym) || new Map();
      const cur = inner.get(r.type) || { o:0, c:0, p:0 };
      cur.o += (r.orders||0); cur.c += (r.cartons||0); cur.p += (r.pallets||0);
      inner.set(r.type, cur); map.set(ym, inner);
    });
    const yms = [...map.keys()].sort();
    weeklyByCourier.labels = yms.map(ymToLabel);
    TYPES.forEach(t=>{
      weeklyByCourier.orders[t] = yms.map(k=> (map.get(k)?.get(t)?.o || 0));
      weeklyByCourier.cartons[t] = yms.map(k=> (map.get(k)?.get(t)?.c || 0));
      weeklyByCourier.pallets[t] = yms.map(k=> (map.get(k)?.get(t)?.p || 0));
    });
  } else {
    const map = new Map(); // day -> Map(type -> {o,c,p})
    rows.forEach(r=>{
      const day = toISODateStr(r.record_date);
      const inner = map.get(day) || new Map();
      const cur = inner.get(r.type) || { o:0, c:0, p:0 };
      cur.o += (r.orders||0); cur.c += (r.cartons||0); cur.p += (r.pallets||0);
      inner.set(r.type, cur); map.set(day, inner);
    });
    const days = [...map.keys()].sort();
    weeklyByCourier.labels = days.map(isoToLabel);
    TYPES.forEach(t=>{
      weeklyByCourier.orders[t] = days.map(k=> (map.get(k)?.get(t)?.o || 0));
      weeklyByCourier.cartons[t] = days.map(k=> (map.get(k)?.get(t)?.c || 0));
      weeklyByCourier.pallets[t] = days.map(k=> (map.get(k)?.get(t)?.p || 0));
    });
  }
  // Cartons by Type
  const cartonsByType = { labels: byCourier.labels, data: byCourier.cartons.slice() };
  // gatewayWeekly from gateway_daily, respect gateway filters (years or dates)
  let gq = sb.from('gateway_daily').select('record_date, pallets_to_gateway, pallets_to_main').order('record_date', { ascending: true });
  const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : [];
  let effFrom = '', effTo = '';
  if (gwYears.length){
    const minY = Math.min(...gwYears), maxY = Math.max(...gwYears);
    gq = gq.gte('record_date', `${minY}-01-01`).lte('record_date', `${maxY}-12-31`);
  } else {
    if (state.gateway.from){ gq = gq.gte('record_date', state.gateway.from); effFrom = state.gateway.from; }
    if (state.gateway.to){ gq = gq.lte('record_date', state.gateway.to); effTo = state.gateway.to; }
    if (!state.gateway.from && !state.gateway.to){
      const eff = deriveGwRange({ from:'', to:'', period: state.gateway.period });
      if (eff.from){ gq = gq.gte('record_date', eff.from); effFrom = eff.from; }
      if (eff.to){ gq = gq.lte('record_date', eff.to); effTo = eff.to; }
    }
  }
  const { data: gw, error: gerr } = await gq.limit(10000);
  const gwYearsSet = new Set((state.gwYears||[]).map(String));
  const gwRows = gwYearsSet.size ? (gw||[]).filter(r=> gwYearsSet.has(yearOf(r.record_date))) : (gw||[]);
  // Group: months for gwYears; when using date pickers and span >30 days, group by week; else by day. Add notice if span >8 months.
  let labelsArr = [];
  let toGatewayArr = [];
  let toMainArr = [];
  let gatewayWeeklyNotice = '';
  let group = 'day';
  const datesActive = Boolean(effFrom && effTo && (state.gateway.from || state.gateway.to));
  if (gwYears.length){ group = 'month'; }
  else if (datesActive){
    const mdiff = monthsBetweenISO(effFrom, effTo);
    if (mdiff > 8){ gatewayWeeklyNotice = 'Selected date range spans more than 8 months. Please use annual mode (year filters).'; }
    const ddiff = daysBetweenISO(effFrom, effTo);
    group = (ddiff > 30) ? 'week' : 'day';
  }
      if (group === 'month'){
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const ym=ymOf(r.record_date); const m = map.get(ym)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(ym,m); keys.add(ym); });
        const yms = [...keys].sort();
        labelsArr = yms.map(ymToLabel);
        toGatewayArr = yms.map(k=> (map.get(k)?.g||0));
        toMainArr = yms.map(k=> (map.get(k)?.m||0));
      } else if (group === 'week'){
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const wk=weekKey(r.record_date); const m = map.get(wk)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(wk,m); keys.add(wk); });
        const wks = [...keys].sort();
        labelsArr = wks.map(isoToLabel);
        toGatewayArr = wks.map(k=> (map.get(k)?.g||0));
        toMainArr = wks.map(k=> (map.get(k)?.m||0));
      } else {
        const map = new Map(); const keys = new Set();
        gwRows.forEach(r=>{ const d=toISODateStr(r.record_date); const m = map.get(d)||{g:0,m:0}; m.g+=(r.pallets_to_gateway||0); m.m+=(r.pallets_to_main||0); map.set(d,m); keys.add(d); });
        const days = [...keys].sort();
        labelsArr = days.map(isoToLabel);
        toGatewayArr = days.map(k=> (map.get(k)?.g||0));
        toMainArr = days.map(k=> (map.get(k)?.m||0));
      }
  const gatewayWeekly = { labels: labelsArr, toGateway: toGatewayArr, toMain: toMainArr, gatewayWeeklyNotice };
  return { byCourier, weeklyByCourier, weeklyByCourierUnsupported: false, cartonsByType, gatewayWeekly };
}

async function fetchCourierDetails(tableFilters, pagination){
  await window.supabaseReady; const sb=window.supabase;
  // New behavior: static table limited to last 30 days by default, optionally filtered by single selected date
  const MAX_ROWS = 30;
  const tf = state.typesTable?.from || '';
  const tt = state.typesTable?.to || '';
  const selectedType = (state.tableFilters?.collection ? 'Collections' : (state.tableFilters?.types?.[0] || 'All Types'));
  if (state.tableFilters?.collection){
    // Collections: if period selected, return within range; else last 30 days
    let q = sb.from('collections_daily').select('record_date, orders, cartons, pallets').order('record_date', { ascending:false });
    if (tf) q = q.gte('record_date', tf);
    if (tt) q = q.lte('record_date', tt);
    if (!tf && !tt){ q = q.limit(MAX_ROWS); }
    const { data, error } = await q;
    if (error){ console.warn('fetchCourierDetails (collections static) error', error); return { items: [], selectedFrom: tf, selectedTo: tt, selectedType } }
    const items = (data||[]).map(r=>({ date: toISODateStr(r.record_date), orders:r.orders||0, cartons:r.cartons||0, pallets:r.pallets||0, type:'Collections' }));
    return { items, selectedFrom: tf, selectedTo: tt, selectedType };
  } else {
    // Deliveries: if a single type is selected via quick filter, filter by it; else show all types
    let q = sb.from('deliveries_daily').select('record_date, type, orders, cartons, pallets').order('record_date', { ascending:false });
    if (state.tableFilters?.types && state.tableFilters.types.length === 1){ q = q.eq('type', state.tableFilters.types[0]); }
    if (tf) q = q.gte('record_date', tf);
    if (tt) q = q.lte('record_date', tt);
    if (!tf && !tt){ q = q.limit(MAX_ROWS); }
    const { data, error } = await q;
    if (error){ console.warn('fetchCourierDetails (deliveries static) error', error); return { items: [], selectedFrom: tf, selectedTo: tt, selectedType } }
    const items = (data||[]).map(r=>({ date: toISODateStr(r.record_date), orders:r.orders||0, cartons:r.cartons||0, pallets:r.pallets||0, type:r.type }));
    return { items, selectedFrom: tf, selectedTo: tt, selectedType };
  }
}

async function fetchGatewayDaily(gatewayFilters, pagination){
  await window.supabaseReady; const sb=window.supabase; const { from, to } = gatewayFilters||{}; const { offset=0, limit=200 } = pagination||{};
  // Respect gateway year chips if selected
  const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : [];
  let eff;
  if (gwYears.length){
    const minY = Math.min(...gwYears), maxY = Math.max(...gwYears);
    eff = { from: `${minY}-01-01`, to: `${maxY}-12-31` };
  } else {
    eff = deriveGwRange({ from, to, period: gatewayFilters?.period });
  }
  const gwYearsSet = new Set((state.gwYears||[]).map(String));
  const aggregateMonthly = gwYearsSet.size > 0; // Monthly compiled when gateway year filter is active
  let q = sb.from('gateway_daily').select('record_date, pallets_to_gateway, pallets_to_main, total');
  if (eff.from) q = q.gte('record_date', eff.from); if (eff.to) q = q.lte('record_date', eff.to);
  if (aggregateMonthly){
    q = q.order('record_date', { ascending:true }).limit(20000);
    const { data, error } = await q;
    if (error){ console.warn('fetchGatewayDaily (monthly) error', error); return { items: [] }; }
    const rows = gwYearsSet.size ? (data||[]).filter(r=> gwYearsSet.has(String(r.record_date).slice(0,4))) : (data||[]);
    const map = new Map(); // ym -> {toGateway,toMain,total}
    rows.forEach(r=>{
      const ym = String(r.record_date).slice(0,7);
      const m = map.get(ym) || { toGateway:0, toMain:0, total:0 };
      const tg = (r.pallets_to_gateway||0), tm = (r.pallets_to_main||0);
      m.toGateway += tg; m.toMain += tm; m.total += (r.total ?? (tg+tm));
      map.set(ym, m);
    });
    const yms = [...map.keys()].sort().reverse();
    const all = yms.map(ym=>({ date: `${ym}-01`, ymLabel: ymToLabel(ym), toGateway: map.get(ym).toGateway, toMain: map.get(ym).toMain, total: map.get(ym).total }));
    const items = all.slice(offset, offset+limit);
    return { items };
  } else {
    q = q.order('record_date', { ascending:false });
    const { data, error } = await q.range(offset, offset+limit-1);
    if (error){ console.warn('fetchGatewayDaily error', error); return { items: [] }; }
    const rows = gwYearsSet.size ? (data||[]).filter(r=> gwYearsSet.has(String(r.record_date).slice(0,4))) : (data||[]);
    const items = rows.map(r=>({ date:r.record_date, toGateway:r.pallets_to_gateway||0, toMain:r.pallets_to_main||0, total:r.total||((r.pallets_to_gateway||0)+(r.pallets_to_main||0)) }));
    return { items };
  }
}

// ---------- Debounced reloads and caching ----------
let _chartsTimer = null, _tablesTimer = null, _gwTrendTimer = null, _kpiTimer = null;
let _lastChartsData = null;
let _lastChartsKey = '';
let _chartsGen = 0, _tablesGen = 0;

function chartsCacheKey(filters){
  const { from, to, period, collection } = filters || {};
  const eff = deriveRange({ from, to, period });
  const years = Array.isArray(state.years) ? state.years.slice().sort() : [];
  // Include gateway filters as they affect the gateway chart
  const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice().sort() : [];
  let gf = '', gt = '', gp = state.gateway?.period || '';
  if (!gwYears.length){
    const gEff = deriveGwRange({ from: state.gateway?.from, to: state.gateway?.to, period: state.gateway?.period });
    gf = gEff.from || ''; gt = gEff.to || '';
  }
  return JSON.stringify({ top:{ f: eff.from||'', t: eff.to||'', c: !!collection, y: years }, gw:{ f: gf, t: gt, p: gp, y: gwYears } });
}

async function _doReloadChartsOnly(){
  const myGen = ++_chartsGen;
  const key = chartsCacheKey(state.filters);
  if (_lastChartsData && key === _lastChartsKey){
    // Reuse cached base data and only reapply type filter
    let dd = _lastChartsData;
    if (!state.filters.collection && state.appliedTypes && state.appliedTypes.length){
      dd = filterChartsByTypes(_lastChartsData, state.appliedTypes);
    }
    renderCharts(dd);
    return;
  }
  const d = await fetchDeliveryCharts(state.filters);
  // If a newer request started, ignore this result
  if (myGen !== _chartsGen) return;
  _lastChartsData = d; _lastChartsKey = key;
  let dd = d;
  if (!state.filters.collection && state.appliedTypes && state.appliedTypes.length){
    dd = filterChartsByTypes(d, state.appliedTypes);
  }
  renderCharts(dd);
}
function reloadChartsOnly(){
  if (_chartsTimer) clearTimeout(_chartsTimer);
  _chartsTimer = setTimeout(_doReloadChartsOnly, 80);
}

function reloadKpis(){
  if (_kpiTimer) clearTimeout(_kpiTimer);
  _kpiTimer = setTimeout(async ()=>{
    const k = await fetchKpis(state.filters);
    setKpis(k);
  }, 80);
}

async function _doLoadTables(){
  const myGen = ++_tablesGen;
  // Use new static behavior for Types Details
  const c = await fetchCourierDetails(state.tableFilters, state.pagination);
  if (myGen !== _tablesGen) return;
  const tbody = document.querySelector('#courierTable tbody');
  if (tbody){
    let html = '';
    c.items.forEach(r=>{ const label = r.ymLabel || isoToDMY(r.date); html += `<tr><td>${label}</td><td class=\"num\">${r.orders}</td><td class=\"num\">${r.cartons}</td><td class=\"num\">${r.pallets}</td><td>${r.type}</td></tr>`; });
    tbody.innerHTML = html;
  }
  // Update selection info text
  const info = document.getElementById('typeTableInfo');
  if (info){
    let dateText = 'Last 30 days';
    if (c.selectedFrom || c.selectedTo){
      const f = c.selectedFrom ? isoToDMY(c.selectedFrom) : '…';
      const t = c.selectedTo ? isoToDMY(c.selectedTo) : '…';
      dateText = `${f} — ${t}`;
    }
    info.textContent = `Showing: ${dateText} — Type: ${c.selectedType || 'All Types'}`;
  }
  const g = await fetchGatewayDaily(state.gateway, state.pagination);
  if (myGen !== _tablesGen) return;
  const gtbody = document.querySelector('#gatewayTable tbody');
  if (gtbody){
    let ghtml = '';
    g.items.forEach(r=>{ const label = r.ymLabel || isoToDMY(r.date); ghtml += `<tr><td>${label}</td><td class="num">${r.toGateway}</td><td class="num">${r.toMain}</td><td class="num">${r.total}</td></tr>`; });
    gtbody.innerHTML = ghtml;
  }
  // Update drill-down granularity label if element exists
  const gwDetailGran = document.getElementById('gwDetailGran');
  if (gwDetailGran){
    const isMonthly = (state.gwYears && state.gwYears.length>0);
    gwDetailGran.textContent = isMonthly ? '(Monthly)' : '(Daily)';
  }
}
function loadTables(){
  if (_tablesTimer) clearTimeout(_tablesTimer);
  _tablesTimer = setTimeout(_doLoadTables, 80);
}

// Saves
async function saveDeliveries(date, resultByType){
  await window.supabaseReady; const sb=window.supabase;
  const rows = TYPES.map(t=>({ record_date: date, type: t, orders: resultByType[t]?.orders||0, cartons: resultByType[t]?.cartons||0, pallets: resultByType[t]?.pallets||0 }));
  // Upsert one-by-one to use composite PK
  for (const r of rows){
    const { error } = await sb.from('deliveries_daily').upsert(r, { onConflict: 'record_date,type' });
    if (error){ console.warn('saveDeliveries row error', r, error.message); }
  }
}

async function saveGateway(date, toGateway, toMain){
  await window.supabaseReady; const sb=window.supabase;
  const payload = { record_date: date, pallets_to_gateway: toGateway||0, pallets_to_main: toMain||0 };
  const { error } = await sb.from('gateway_daily').upsert(payload, { onConflict: 'record_date' });
  if (error){ console.warn('saveGateway error', error.message); }
}

function setKpis(k){
  document.getElementById('kpiOrders').textContent = k.weeklyOrders.toLocaleString();
  document.getElementById('kpiCartons').textContent = k.cartons.toLocaleString();
  document.getElementById('kpiPallets').textContent = k.pallets.toLocaleString();
  document.getElementById('kpiTopCourier').textContent = k.topCourier;
}

let cByCourier, cWeekly, cPct, cGateway, cAvgCartons;
// removed evolution chart

// Ensure all categories fit horizontally by expanding canvas width and enabling horizontal scroll
function adjustCategoryChartWidth(canvasEl, labelCount, chartInstance, pxPerCat = 70){
  if (!canvasEl || !canvasEl.closest) return;
  const card = canvasEl.closest('.log-card');
  if (!card) return;
  // Enable horizontal scroll on the card, but hide vertical
  card.style.overflowX = 'auto';
  card.style.overflowY = 'hidden';
  const cardWidth = card.clientWidth || 600;
  const desired = Math.max(cardWidth, Math.ceil((labelCount || 0) * pxPerCat));
  // Apply explicit canvas width; height remains flexible due to maintainAspectRatio:false
  canvasEl.style.width = desired + 'px';
  // Ask Chart.js to resize to the new CSS size
  try{ chartInstance?.resize(); }catch{}
}

// Static all-time totals chart (ignores filters): Orders, Cartons, Pallets by Type
async function renderStaticTotalsChart(){
  await window.supabaseReady; const sb=window.supabase;
  // Reliable client-side aggregation for true all-time totals with pagination (bypass 1k limit)
  const totals = new Map(); // type -> {o,c,p}
  TYPES.forEach(t=> totals.set(t, {o:0,c:0,p:0}));
  const pageSize = 1000;
  let offset = 0;
  let page = [];
  let pageNum = 0;
  do{
    const { data, error } = await sb
      .from('deliveries_daily')
      .select('record_date, type, orders, cartons, pallets')
      .range(offset, offset + pageSize - 1);
    if (error){ console.warn('renderStaticTotalsChart page error', error); break; }
    page = data || [];
    page.forEach(r=>{
      if (!r || !r.type) return;
      // Per-table year filter: when years selected, keep only those records
      if (allYears.selected.length){
        const y = String(r.record_date||'').slice(0,4);
        if (!allYears.selected.map(String).includes(y)) return;
      }
      const t = canonType(r.type);
      if (!totals.has(t)) totals.set(t, {o:0,c:0,p:0});
      const m = totals.get(t);
      m.o += (r.orders||0); m.c += (r.cartons||0); m.p += (r.pallets||0);
    });
    offset += pageSize;
    pageNum++;
    // Safety cap to avoid infinite loop
    if (pageNum > 1000) { console.warn('renderStaticTotalsChart: aborting after too many pages'); break; }
  } while(page.length === pageSize);
  const tbody = document.getElementById('allTimeTotalsBody');
  if (!tbody) return;
  let html = '';
        const extras = [...totals.keys()].filter(k => !TYPES.includes(k));
        const ordered = [...TYPES, ...extras];
        ordered.forEach(t=>{
          const m = totals.get(t) || {o:0,c:0,p:0};
          html += `<tr><td>${t}</td><td class="num">${m.o.toLocaleString()}</td><td class="num">${m.c.toLocaleString()}</td><td class="num">${m.p.toLocaleString()}</td></tr>`;
        });
  tbody.innerHTML = html;
}

// Realtime subscription to keep all-time totals fresh when any delivery is inserted/updated
let _allTimeTotalsChan = null;
function subscribeAllTimeTotalsRealtime(){
  if (_allTimeTotalsChan || !window.supabase) return;
  try{
    _allTimeTotalsChan = window.supabase
      .channel('deliveries_daily_totals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries_daily' }, () => {
        // Debounce a bit to avoid thrashing on batch upserts
        clearTimeout(window._totalsRTimer);
        window._totalsRTimer = setTimeout(renderStaticTotalsChart, 150);
      })
      .subscribe();
    // Optional: cleanup on page unload
    window.addEventListener('beforeunload', ()=>{ try{ _allTimeTotalsChan?.unsubscribe(); }catch{} });
  }catch(e){ console.warn('subscribeAllTimeTotalsRealtime failed', e); }
}

// Reduce chart datasets to selected types (used when Select mode + Apply)
function filterChartsByTypes(d, selected){
  if (!selected || !selected.length) return d;
  // Slice byCourier arrays to selected labels
  const idxs = d.byCourier.labels.map((l,i)=> selected.includes(l) ? i : -1).filter(i=> i>=0);
  const byCourier = {
    labels: idxs.map(i=> d.byCourier.labels[i]),
    orders: idxs.map(i=> d.byCourier.orders[i]),
    cartons: idxs.map(i=> d.byCourier.cartons[i]),
    pallets: idxs.map(i=> d.byCourier.pallets[i])
  };
  // weeklyByCourier: keep only selected series
  const weeklyByCourier = { labels: d.weeklyByCourier.labels };
  selected.forEach(name=>{ if (d.weeklyByCourier[name]) weeklyByCourier[name] = d.weeklyByCourier[name]; });
  // Cartons by Type filtered
  const cartonsByType = { labels: byCourier.labels, data: byCourier.cartons.slice() };
  return { ...d, byCourier, weeklyByCourier, cartonsByType };
}

function renderCharts(d){
  // Orders by Type (bar) — only Orders
  const byEl = document.getElementById('chartByCourier');
  if (cByCourier){
    cByCourier.data.labels = d.byCourier.labels;
    cByCourier.data.datasets[0].data = d.byCourier.orders;
    // ensure ticks show all labels, tilted for legibility
    if (cByCourier.options?.scales?.x?.ticks){ cByCourier.options.scales.x.ticks.autoSkip = false; cByCourier.options.scales.x.ticks.maxRotation = 50; cByCourier.options.scales.x.ticks.minRotation = 35; }
    cByCourier.update('none');
  } else {
    cByCourier = new Chart(byEl, { type:'bar', data:{ labels:d.byCourier.labels, datasets:[ { label:'Orders', data:d.byCourier.orders, backgroundColor:'#3b82f6', barThickness:28 } ] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ position:'top' } }, scales:{ x:{ ticks:{ autoSkip:false, maxRotation:50, minRotation:35 } }, y:{ beginAtZero:true } } } });
  }
  adjustCategoryChartWidth(byEl, d.byCourier.labels.length, cByCourier);

  // Pallets by Type (bar) — only Pallets
  const wkEl = document.getElementById('chartWeekly');
  if (cWeekly){
    cWeekly.data.labels = d.byCourier.labels;
    cWeekly.data.datasets[0].data = d.byCourier.pallets;
    if (cWeekly.options?.scales?.x?.ticks){ cWeekly.options.scales.x.ticks.autoSkip = false; cWeekly.options.scales.x.ticks.maxRotation = 50; cWeekly.options.scales.x.ticks.minRotation = 35; }
    cWeekly.update('none');
  } else {
    cWeekly = new Chart(wkEl, { type:'bar', data:{ labels:d.byCourier.labels, datasets:[ { label:'Pallets', data:d.byCourier.pallets, backgroundColor:'#eab308', barThickness:28 } ] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ position:'top' } }, scales:{ x:{ ticks:{ autoSkip:false, maxRotation:50, minRotation:35 } }, y:{ beginAtZero:true } } } });
  }
  adjustCategoryChartWidth(wkEl, d.byCourier.labels.length, cWeekly);

  // Cartons by Type (bar)
  const pctEl = document.getElementById('chartPct');
  if (cPct){
    cPct.data.labels = d.cartonsByType.labels;
    cPct.data.datasets[0].data = d.cartonsByType.data;
    if (cPct.options?.scales?.x?.ticks){ cPct.options.scales.x.ticks.autoSkip = false; cPct.options.scales.x.ticks.maxRotation = 50; cPct.options.scales.x.ticks.minRotation = 35; }
    cPct.update('none');
  } else {
    cPct = new Chart(pctEl, { type:'bar', data:{ labels:d.cartonsByType.labels, datasets:[{ label:'Cartons', data:d.cartonsByType.data, backgroundColor:'#22c55e', barThickness:28 }] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ position:'top' } }, scales:{ x:{ ticks:{ autoSkip:false, maxRotation:50, minRotation:35 } }, y:{ beginAtZero:true } } } });
  }
  adjustCategoryChartWidth(pctEl, d.cartonsByType.labels.length, cPct);


  // Static all-time totals chart (ignores filters)
  renderStaticTotalsChart();

  // Gateway weekly stacked
  const gwEl = document.getElementById('chartGateway');
  if (gwEl){
    const gwData = d?.gatewayWeekly || { labels: [], toGateway: [], toMain: [], gatewayWeeklyNotice:'' };
    if (cGateway){
      cGateway.data.labels = gwData.labels;
      cGateway.data.datasets[0].data = gwData.toGateway;
      cGateway.data.datasets[1].data = gwData.toMain;
      cGateway.update('none');
    } else {
      cGateway = new Chart(gwEl, { type:'bar', data:{ labels:gwData.labels, datasets:[ { label:'Gateway', data:gwData.toGateway, backgroundColor:'#6366f1', stack:'gw' }, { label:'Main Warehouse', data:gwData.toMain, backgroundColor:'#06b6d4', stack:'gw' } ] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ position:'top' } }, scales:{ x:{ stacked:true, ticks:{ autoSkip:true, maxRotation:0 } }, y:{ stacked:true, beginAtZero:true } } } });
    }
    // Overlay notice for long ranges on Gateway chart
    setOverlayForChart(gwEl, 'gw-range-note', gwData.gatewayWeeklyNotice || '');
  }
}

// evolution chart removed

function renderCourierChips(labels){
  const wrap = document.getElementById('courierChips');
  wrap.innerHTML = '';
  labels.forEach(name=>{
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = name;
    // reflect current active state for top chips (charts types)
    if (state.filters.types.includes(name)) btn.classList.add('active');
    btn.onclick = ()=>{
      if (!state.filters.selectMode) return; // chips active only in Select mode
      const idx = state.filters.types.indexOf(name);
      if (idx>=0) state.filters.types.splice(idx,1); else state.filters.types.push(name);
      btn.classList.toggle('active');
      // Do not update charts yet; applied via Apply button
    };
    wrap.appendChild(btn);
  });
  // Move the Apply button inside the chips container so it appears after the last type
  const applyBtn = document.getElementById('typesApply');
  if (applyBtn) wrap.appendChild(applyBtn);
  // Quick filters under the table too
  const qf = document.getElementById('courierQuickFilters');
  qf.innerHTML = '';
  // Include 'Collections' for table drill-down (single-select)
  const tableLabels = ['Collections', ...labels];
  tableLabels.forEach(name=>{
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = name;
    // Reflect current single-select state on tableFilters
    if (name==='Collections'){
      if (state.tableFilters.collection) b.classList.add('active');
    } else if (state.tableFilters.types?.[0] === name) b.classList.add('active');
    b.onclick = ()=>{
      // Single-select for Types Details only
      if (name==='Collections'){
        const on = !state.tableFilters.collection;
        state.tableFilters.collection = on;
        state.tableFilters.types = [];
      } else {
        state.tableFilters.collection = false;
        const currently = state.tableFilters.types?.[0] || null;
        state.tableFilters.types = (currently === name) ? [] : [name];
      }
      // Update quick filter active states (single active)
      qf.querySelectorAll('.chip').forEach(c=> c.classList.remove('active'));
      if (state.tableFilters.collection || state.tableFilters.types.length) b.classList.add('active');
      // Reload only tables (charts unaffected)
      loadTables();
    };
    qf.appendChild(b);
  });
}

async function load(){
  const k = await fetchKpis(state.filters); setKpis(k);
  await reloadChartsOnly();
  // Always render all type chips (not donut labels which change in Collections)
  renderCourierChips(TYPES);
  // Top-level year selector removed; don't render
  renderGwYearChips();
  renderAllYearChips();
  bindSmartSelectors();
  await loadTables();
}

// remove duplicate heavy loadTables (debounced version defined above)

function bind(){
  // Period buttons
  const periodWeek = document.getElementById('periodWeek');
  const periodMonth = document.getElementById('periodMonth');
  if (periodWeek) periodWeek.addEventListener('click', ()=>{
    // If dates or years are active, auto-clear to quickly return to Week
    if (areTopDatesActive()) clearTopDates();
    if (state.years.length) clearYears();
    state.filters.period='week';
    toggleActive(['periodWeek']);
    syncTableDates(); reloadChartsOnly(); reloadKpis(); loadTables();
  });
  if (periodMonth) periodMonth.addEventListener('click', ()=>{
    // If dates or years are active, auto-clear to quickly return to Month
    if (areTopDatesActive()) clearTopDates();
    if (state.years.length) clearYears();
    state.filters.period='month';
    toggleActive(['periodMonth']);
    syncTableDates(); reloadChartsOnly(); reloadKpis(); loadTables();
  });

  // Collections exclusive mode
  const collectionsBtn = document.getElementById('collectionsMode');
  if (collectionsBtn) collectionsBtn.addEventListener('click', ()=>{
    const active = collectionsBtn.classList.toggle('active');
    state.filters.collection = active;
    if (active){
      state.filters.selectMode = false;
      state.filters.types = [];
      state.appliedTypes = [];
      document.getElementById('typesSelect')?.classList.remove('active');
      document.getElementById('typesAll')?.classList.remove('active');
      document.querySelectorAll('#courierChips .chip').forEach(c=>c.classList.remove('active'));
      // Also make the Types Details table reflect Collections only
      state.tableFilters.collection = true;
      state.tableFilters.types = [];
    }
    // Update only charts
    const ab = document.getElementById('typesApply'); if (ab) ab.style.display = 'none';
    reloadChartsOnly(); reloadKpis(); loadTables();
  });

  // Types All / Select
  const typesAll = document.getElementById('typesAll');
  const typesSelect = document.getElementById('typesSelect');
  if (typesAll) typesAll.addEventListener('click', ()=>{
    state.filters.collection = false;
    state.filters.selectMode = false;
    state.filters.types = [];
    state.appliedTypes = [];
    document.getElementById('collectionsMode')?.classList.remove('active');
    typesAll.classList.add('active');
    typesSelect?.classList.remove('active');
    document.querySelectorAll('#courierChips .chip').forEach(c=>c.classList.remove('active'));
      const ab = document.getElementById('typesApply'); if (ab) ab.style.display = 'none'; // Hide Apply button
    // Reflect in Types Details table (deliveries mode)
    state.tableFilters.collection = false;
    state.tableFilters.types = [];
    reloadChartsOnly(); reloadKpis(); loadTables();
  });
  if (typesSelect) typesSelect.addEventListener('click', ()=>{
    state.filters.collection = false;
    state.filters.selectMode = true;
    document.getElementById('collectionsMode')?.classList.remove('active');
    typesSelect.classList.add('active');
    typesAll?.classList.remove('active');
    // Show Apply button; charts update only when Apply is clicked
      const ab = document.getElementById('typesApply'); if (ab) ab.style.display = 'inline-flex'; // Show Apply button
    // Reflect in Types Details table (deliveries mode)
    state.tableFilters.collection = false;
    state.tableFilters.types = [];
    reloadKpis();
  });

  // Date inputs
  ['fromDate','toDate'].forEach(id=> document.getElementById(id)?.addEventListener('change', ()=>{
    state.filters.from = document.getElementById('fromDate').value;
    state.filters.to = document.getElementById('toDate').value;
    if (state.years.length) clearYears();
    // If any date provided, force range mode and disable Week/Month buttons visually
    const datesActive = areTopDatesActive();
    if (datesActive){
      state.filters.period = 'range';
      disableTopPeriodButtons(true);
    } else {
      disableTopPeriodButtons(false);
    }
    syncTableDates();
    reloadChartsOnly(); reloadKpis();
    loadTables();
  }));

  // Clear top dates
  document.getElementById('clearTopDates')?.addEventListener('click', ()=>{
    // Clear both dates and year selections
    clearTopDates();
    clearYears();
    renderYearChips();
    // Default back to Week if none active
    if (!document.getElementById('periodMonth')?.classList.contains('active')) toggleActive(['periodWeek']);
    syncTableDates(); reloadChartsOnly(); reloadKpis(); loadTables();
  });

  // Apply types selection to charts
  const applyBtn = document.getElementById('typesApply');
  if (applyBtn) applyBtn.addEventListener('click', ()=>{
    state.appliedTypes = [...state.filters.types];
    reloadChartsOnly();
    reloadKpis(); // KPIs must reflect applied Types as well
  });

  // Gateway side filters
  const gwWeek = document.getElementById('gwWeek');
  const gwMonth = document.getElementById('gwMonth');
  if (gwWeek) gwWeek.addEventListener('click', ()=>{
    if (areGwDatesActive()) clearGwDates();
    if (state.gwYears.length) clearGwYears();
    state.gateway.period='week';
    setActive('gwWeek', ['gwWeek','gwMonth']);
    renderGatewayTrend();
    reloadChartsOnly();
    loadTables();
  });
  if (gwMonth) gwMonth.addEventListener('click', ()=>{
    if (areGwDatesActive()) clearGwDates();
    if (state.gwYears.length) clearGwYears();
    state.gateway.period='month';
    setActive('gwMonth', ['gwWeek','gwMonth']);
    renderGatewayTrend();
    reloadChartsOnly();
    loadTables();
  });
  ['gwFrom','gwTo'].forEach(id=> document.getElementById(id)?.addEventListener('change', ()=>{
    state.gateway.from = document.getElementById('gwFrom').value;
    state.gateway.to = document.getElementById('gwTo').value;
    // If any gateway date set, force range-like behavior and disable buttons
    const gwDatesActive = areGwDatesActive();
    if (gwDatesActive){
      state.gateway.period = 'range';
      disableGwPeriodButtons(true);
    } else {
      disableGwPeriodButtons(false);
    }
    renderGatewayTrend();
    reloadChartsOnly();
    loadTables();
  }));

  // Clear gateway dates
  document.getElementById('gwClearDates')?.addEventListener('click', ()=>{
    // Clear both gateway dates and gateway years
    clearGwDates();
    clearGwYears();
    renderGwYearChips();
    setActive('gwWeek', ['gwWeek','gwMonth']);
    renderGatewayTrend();
    reloadChartsOnly();
    loadTables();
  });

  // Types Details: date picker and export CSV
  const typeFrom = document.getElementById('typeTableFrom');
  const typeTo = document.getElementById('typeTableTo');
  const exportBtn = document.getElementById('typeTableExport');
  function syncTypesPeriod(){
    state.typesTable = state.typesTable || {};
    state.typesTable.from = typeFrom?.value || '';
    state.typesTable.to = typeTo?.value || '';
    const enable = !!(state.typesTable.from || state.typesTable.to);
    exportBtn?.classList.toggle('disabled', !enable);
    if (enable) exportBtn?.removeAttribute('disabled'); else exportBtn?.setAttribute('disabled','true');
  }
  typeFrom?.addEventListener('change', ()=>{ syncTypesPeriod(); loadTables(); });
  typeTo?.addEventListener('change', ()=>{ syncTypesPeriod(); loadTables(); });
  if (exportBtn){
    exportBtn.addEventListener('click', async ()=>{
      // Need at least a partial period (from or to)
      const f = document.getElementById('typeTableFrom')?.value || '';
      const t = document.getElementById('typeTableTo')?.value || '';
      if (!f && !t) return;
      // Fetch the exact same data used by the table for the selected period
      const prevFrom = state.typesTable?.from || '';
      const prevTo = state.typesTable?.to || '';
      state.typesTable = state.typesTable || {}; state.typesTable.from = f; state.typesTable.to = t;
      const { items } = await fetchCourierDetails(state.tableFilters, state.pagination);
      // Build CSV
      const headers = ['Date','Orders','Cartons','Pallets','Type'];
      const rows = items.map(r=> [isoToDMY(r.date), r.orders, r.cartons, r.pallets, r.type]);
      const csv = [headers.join(','), ...rows.map(cols=> cols.map(val=> typeof val==='string' && val.includes(',') ? '"'+val.replace(/"/g,'""')+'"' : val).join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `types-details_${f || 'from'}_${t || 'to'}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // Restore previous period state (optional)
      state.typesTable.from = prevFrom; state.typesTable.to = prevTo;
    });
  }
}

function toggleActive(ids){
  ['periodWeek','periodMonth'].forEach(id=> document.getElementById(id)?.classList.remove('active'));
  ids.forEach(id=> document.getElementById(id)?.classList.add('active'));
}

function setActive(activeId, all){ all.forEach(id=> document.getElementById(id)?.classList.toggle('active', id===activeId)); }

// remove duplicate non-debounced reloadChartsOnly (debounced version defined above)

// Helpers: date activity and disabling period buttons
function areTopDatesActive(){
  const f = document.getElementById('fromDate')?.value;
  const t = document.getElementById('toDate')?.value;
  return Boolean(f || t);
}
function disableTopPeriodButtons(dis){
  const week = document.getElementById('periodWeek');
  const month = document.getElementById('periodMonth');
  [week,month].forEach(b=>{ if (!b) return; b.disabled = !!dis; b.classList.toggle('disabled', !!dis); if(dis) b.classList.remove('active'); });
}
function clearTopDates(){
  const f = document.getElementById('fromDate');
  const t = document.getElementById('toDate');
  if (f) f.value = '';
  if (t) t.value = '';
  state.filters.from = '';
  state.filters.to = '';
  state.filters.period = 'week';
  disableTopPeriodButtons(false);
}
function areGwDatesActive(){
  const f = document.getElementById('gwFrom')?.value;
  const t = document.getElementById('gwTo')?.value;
  return Boolean(f || t);
}
function disableGwPeriodButtons(dis){
  const week = document.getElementById('gwWeek');
  const month = document.getElementById('gwMonth');
  [week,month].forEach(b=>{ if (!b) return; b.disabled = !!dis; b.classList.toggle('disabled', !!dis); if(dis) b.classList.remove('active'); });
}
function clearGwDates(){
  const f = document.getElementById('gwFrom');
  const t = document.getElementById('gwTo');
  if (f) f.value = '';
  if (t) t.value = '';
  state.gateway.from = '';
  state.gateway.to = '';
  state.gateway.period = 'week';
  disableGwPeriodButtons(false);
}

// Year chips rendering and behavior
function renderYearChips(){
  const container = document.getElementById('yearChips');
  if (!container) return;
  const YEARS = [2023,2024,2025,2026,2027,2028];
  container.innerHTML = '';
  // Bind clear action (use onclick to avoid stacking listeners)
  const yearClearBtn = document.getElementById('yearClear');
  if (yearClearBtn) yearClearBtn.onclick = ()=>{ clearYears(); renderYearChips(); reloadChartsOnly(); reloadKpis(); loadTables(); };
  YEARS.forEach(y=>{
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = String(y);
    if (state.years.includes(y)) b.classList.add('active');
    b.onclick = ()=>{
      // Single-select: replace any existing selection with this year
      const currentlySelected = state.years[0];
      state.years = (currentlySelected === y) ? [] : [y];
      // Visual
      b.classList.toggle('active');
      const any = state.years.length>0;
      if (any){
        // Disable dates and week/month
        clearTopDates(); // clears values and ensures buttons enabled, then we'll disable them again
        disableTopPeriodButtons(true);
        // Disable date pickers visually and functionally
        document.getElementById('fromDate')?.classList.add('disabled');
        document.getElementById('toDate')?.classList.add('disabled');
        document.getElementById('fromDate')?.setAttribute('disabled','true');
        document.getElementById('toDate')?.setAttribute('disabled','true');
        // Mark Years button active for consistency
        document.getElementById('yearSelectorBtn')?.classList.add('active');
      } else {
        // Re-enable dates and period buttons
        document.getElementById('fromDate')?.classList.remove('disabled');
        document.getElementById('toDate')?.classList.remove('disabled');
        document.getElementById('fromDate')?.removeAttribute('disabled');
        document.getElementById('toDate')?.removeAttribute('disabled');
        disableTopPeriodButtons(false);
        // Remove active style from Years button
        document.getElementById('yearSelectorBtn')?.classList.remove('active');
        // Restore Week as default active for visual consistency
        toggleActive(['periodWeek']);
      }
      // Refresh charts/tables based on years selection
      reloadChartsOnly(); reloadKpis();
      loadTables();
    };
    container.appendChild(b);
  });
  // Reflect current active state on Years button
  const yBtn = document.getElementById('yearSelectorBtn');
  if (yBtn){ yBtn.classList.toggle('active', state.years.length>0); }
}

function renderGwYearChips(){
  const container = document.getElementById('gwYearChips');
  if (!container) return;
  const YEARS = [2024,2025,2026,2027,2028];
  container.innerHTML = '';
  const gwYearClearBtn = document.getElementById('gwYearClear');
  if (gwYearClearBtn) gwYearClearBtn.onclick = ()=>{ clearGwYears(); renderGwYearChips(); renderGatewayTrend(); loadTables(); };
  YEARS.forEach(y=>{
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = String(y);
    if (state.gwYears.includes(y)) b.classList.add('active');
    b.onclick = ()=>{
      const i = state.gwYears.indexOf(y);
      if (i>=0) state.gwYears.splice(i,1); else state.gwYears.push(y);
      b.classList.toggle('active');
      const any = state.gwYears.length>0;
      if (any){
        clearGwDates();
        disableGwPeriodButtons(true);
        document.getElementById('gwFrom')?.classList.add('disabled');
        document.getElementById('gwTo')?.classList.add('disabled');
        document.getElementById('gwFrom')?.setAttribute('disabled','true');
        document.getElementById('gwTo')?.setAttribute('disabled','true');
      } else {
        document.getElementById('gwFrom')?.classList.remove('disabled');
        document.getElementById('gwTo')?.classList.remove('disabled');
        document.getElementById('gwFrom')?.removeAttribute('disabled');
        document.getElementById('gwTo')?.removeAttribute('disabled');
        disableGwPeriodButtons(false);
      }
      renderGatewayTrend();
      reloadChartsOnly();
      loadTables();
    };
    container.appendChild(b);
  });
}

function clearYears(){
  state.years = [];
  // Re-enable date inputs and period buttons
  document.getElementById('fromDate')?.classList.remove('disabled');
  document.getElementById('toDate')?.classList.remove('disabled');
  document.getElementById('fromDate')?.removeAttribute('disabled');
  document.getElementById('toDate')?.removeAttribute('disabled');
  disableTopPeriodButtons(false);
}

// One-time binding for smart selector open/close behavior to avoid stacking listeners
let _smartSelectorsBound = false;
function bindSmartSelectors(){
  if (_smartSelectorsBound) return; _smartSelectorsBound = true;
  // All-time table year selector
  const aSel = document.getElementById('allYearSelector');
  const aBtn = document.getElementById('allYearSelectorBtn');
  const aPanel = document.getElementById('allYearSelectorPanel');
  if (aBtn && aSel){
    aBtn.addEventListener('click', (e)=>{ e.stopPropagation(); const open = aSel.classList.toggle('open'); aBtn.setAttribute('aria-expanded', open?'true':'false'); });
    aPanel?.addEventListener('click', (e)=> e.stopPropagation());
  }
  // Gateway year selector
  const gSel = document.getElementById('gwYearSelector');
  const gBtn = document.getElementById('gwYearSelectorBtn');
  const gPanel = document.getElementById('gwYearSelectorPanel');
  if (gBtn && gSel){
    gBtn.addEventListener('click', (e)=>{ e.stopPropagation(); const open = gSel.classList.toggle('open'); gBtn.setAttribute('aria-expanded', open?'true':'false'); });
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
}

// Render year chips for the All-time totals table (independent of top filters)
function renderAllYearChips(){
  const container = document.getElementById('allYearChips');
  if (!container) return;
  const YEARS = [2023,2024,2025,2026,2027,2028];
  container.innerHTML = '';
  const clearBtn = document.getElementById('allYearClear');
  if (clearBtn) clearBtn.onclick = ()=>{ allYears.selected = []; renderAllYearChips(); renderStaticTotalsChart(); };
  YEARS.forEach(y=>{
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = String(y);
    if (allYears.selected.includes(y)) b.classList.add('active');
    b.onclick = ()=>{
      const i = allYears.selected.indexOf(y);
      if (i>=0) allYears.selected.splice(i,1); else allYears.selected.push(y);
      b.classList.toggle('active');
      renderStaticTotalsChart();
    };
    container.appendChild(b);
  });
}
function clearGwYears(){
  state.gwYears = [];
  document.getElementById('gwFrom')?.classList.remove('disabled');
  document.getElementById('gwTo')?.classList.remove('disabled');
  document.getElementById('gwFrom')?.removeAttribute('disabled');
  document.getElementById('gwTo')?.removeAttribute('disabled');
  disableGwPeriodButtons(false);
}
function syncTableDates(){ state.tableFilters.from = state.filters.from; state.tableFilters.to = state.filters.to; state.tableFilters.period = state.filters.period; }

function renderGatewayTrend(){
  if (_gwTrendTimer) clearTimeout(_gwTrendTimer);
  _gwTrendTimer = setTimeout(async ()=>{
    const { items } = await fetchGatewayDaily(state.gateway, state.pagination);
    // Decide grouping for Movement: monthly when gwYears selected; else week if date-picker span >30 days; else day.
    let effFrom = '', effTo = '';
    const gwYears = Array.isArray(state.gwYears) ? state.gwYears.slice() : [];
    if (gwYears.length){
      effFrom = `${Math.min(...gwYears)}-01-01`; effTo = `${Math.max(...gwYears)}-12-31`;
    } else {
      if (state.gateway.from) effFrom = state.gateway.from;
      if (state.gateway.to) effTo = state.gateway.to;
      if (!effFrom || !effTo){ const eff = deriveGwRange({ from:'', to:'', period: state.gateway.period }); effFrom = eff.from||effFrom; effTo = eff.to||effTo; }
    }
    const datesActive = Boolean(effFrom && effTo && (state.gateway.from || state.gateway.to));
    let gwNotice = '';
    let group = gwYears.length ? 'month' : 'day';
    if (!gwYears.length && datesActive){
      const mdiff = monthsBetweenISO(effFrom, effTo);
      if (mdiff > 8){ gwNotice = 'Selected date range spans more than 8 months. Please use annual mode (year filters).'; }
      const ddiff = daysBetweenISO(effFrom, effTo);
      if (ddiff > 30) group = 'week';
    }
    // Items: daily when no gwYears; monthly when gwYears. Aggregate to requested group.
    let labels = [];
    let totals = [];
    if (group === 'month'){
      // If items already monthly (gwYears), just map; else aggregate daily to months
      if (gwYears.length && items.length && items[0].ymLabel){
        const sorted = [...items].sort((a,b)=> (a.date||'') < (b.date||'') ? -1 : (a.date||'') > (b.date||'') ? 1 : 0);
        labels = sorted.map(r=> r.ymLabel);
        totals = sorted.map(r=> r.total ?? ((r.toGateway||0)+(r.toMain||0)));
      } else {
        const map = new Map(); const keys = new Set();
        items.forEach(r=>{ const ym=(r.date||'').slice(0,7); const cur = map.get(ym)||0; map.set(ym, cur + (r.total ?? ((r.toGateway||0)+(r.toMain||0)))); keys.add(ym); });
        const yms = [...keys].sort();
        labels = yms.map(ymToLabel);
        totals = yms.map(k=> map.get(k)||0);
      }
    } else if (group === 'week'){
      const map = new Map(); const keys = new Set();
      items.forEach(r=>{ const wk=weekKey(r.date); const cur = map.get(wk)||0; map.set(wk, cur + (r.total ?? ((r.toGateway||0)+(r.toMain||0)))); keys.add(wk); });
      const wks = [...keys].sort();
      labels = wks.map(isoToLabel);
      totals = wks.map(k=> map.get(k)||0);
    } else {
      const sorted = [...items].sort((a,b)=> (a.date||'') < (b.date||'') ? -1 : (a.date||'') > (b.date||'') ? 1 : 0);
      labels = sorted.map(r => isoToLabel(r.date));
      totals = sorted.map(r => r.total ?? ((r.toGateway||0) + (r.toMain||0)));
    }
    const total = totals.reduce((a,b)=>a+b,0);
    const trend = totals.length>1 ? (totals[totals.length-1] - totals[0]) : 0;
    const totalEl = document.getElementById('gwTotal'); if (totalEl) totalEl.textContent = total;
    const trendEl = document.getElementById('gwTrend'); if (trendEl) trendEl.textContent = trend>=0 ? `+${trend}` : `${trend}`;
    // AVG KPI label: Daily/Weekly/Monthly
    const avg = totals.length ? Math.round(total / totals.length) : 0;
    const avgEl = document.getElementById('gwAvg'); if (avgEl) avgEl.textContent = totals.length ? avg : '—';
    const avgLabel = document.getElementById('gwAvgLabel');
    const avgMode = group === 'month' ? 'Monthly' : group === 'week' ? 'Weekly' : 'Daily';
    if (avgLabel){ avgLabel.textContent = `Avg (${avgMode})`; }
    // Update or create chart
    const el = document.getElementById('chartGatewayTrend');
    if (el){
      if (window._gwTrend){
        window._gwTrend.data.labels = labels;
        window._gwTrend.data.datasets[0].data = totals;
        window._gwTrend.update('none');
      } else {
        window._gwTrend = new Chart(el, { type:'line', data:{ labels, datasets:[{ label:'Total', data: totals, borderColor:'#6366f1' }] }, options:{ responsive:true, maintainAspectRatio:false, layout:{ padding:8 }, plugins:{ legend:{ display:false } } } });
      }
    }
    // Overlay notice for long ranges on Movement chart
    setOverlayForChart(document.getElementById('chartGatewayTrend'), 'gw-range-note', gwNotice || '');
  }, 100);
}

bind();
toggleActive(['periodWeek']);
setActive('gwWeek', ['gwWeek','gwMonth']);
syncTableDates();
// Default: single type selected in Types drill-down
state.tableFilters.types = [TYPES[0]];
// Default top: All active and hide Apply
document.getElementById('typesAll')?.classList.add('active');
const _ab = document.getElementById('typesApply'); if (_ab) _ab.style.display = 'none';
load();
// renderGatewayTrend is no-op on this page (Gateway section removed), but safe to call if elements exist
renderGatewayTrend();
// Keep all-time totals chart automatically updated as data is registered
subscribeAllTimeTotalsRealtime();
// Also render it once on startup for robustness
  // Static all-time totals table (ignores page filters, but respects its own year chips)
  renderStaticTotalsChart();

// Register modal wiring
(()=>{
  const modal = document.getElementById('registerModal');
  if (!modal) return;
  // Start hidden and closed (safety)
  modal.hidden = true; modal.classList.remove('open');
  const openBtn = document.getElementById('openRegister');
  const closeBtn = document.getElementById('closeRegister');
  const cancelBtn = document.getElementById('cancelRegister');
  const saveBtn = document.getElementById('saveRegister');
  const tbody = document.getElementById('regTableBody');
  function buildRows(){
    tbody.innerHTML = '';
    // Fixed type order; placeholders now guide the user (blank = 0 on save)
  const PLACEHOLDER = 'Type here';
    const ORDERED = [
      'Van Brisbane',
      'Van Gold Coast',
      'Endless Summer',
      'Direct Freight',
      'Phoenix',
      'Jet',
      'Aramex',
      'Australia Post',
    ];
    ORDERED.forEach((type)=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${type}</td>
        <td class="num"><input class="reg-input" type="number" inputmode="numeric" pattern="\\d*" min="0" step="1" data-field="orders" data-type="${type}" placeholder="${PLACEHOLDER}" /></td>
        <td class="num"><input class="reg-input" type="number" inputmode="numeric" pattern="\\d*" min="0" step="1" data-field="cartons" data-type="${type}" placeholder="${PLACEHOLDER}" /></td>
        <td class="num"><input class="reg-input" type="number" inputmode="numeric" pattern="\\d*" min="0" step="1" data-field="pallets" data-type="${type}" placeholder="${PLACEHOLDER}" /></td>
      `;
      tbody.appendChild(tr);
    });
  }
  function setRegInputsEnabled(enabled){
    const inputs = tbody.querySelectorAll('input.reg-input');
    inputs.forEach(inp=>{ inp.disabled = !enabled; });
  }
  function showDateWarn(){
    const w = document.getElementById('regDateWarn');
    if (w) { w.style.display = 'inline'; }
  }
  function hideDateWarn(){
    const w = document.getElementById('regDateWarn');
    if (w) { w.style.display = 'none'; }
  }
  function open(){
    buildRows();
    modal.classList.add('open');
    modal.hidden = false;
    // Disable inputs until a date is selected; show warning by default if empty
    const hasDate = !!document.getElementById('regDate')?.value;
    setRegInputsEnabled(hasDate);
    if (hasDate) hideDateWarn(); else showDateWarn();
  }
  function close(){ modal.classList.remove('open'); modal.hidden = true; }
  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);
  // Close on outside click
  modal.addEventListener('click', (e)=>{ if (e.target === modal) close(); });
  // Date change toggles inputs enabled/disabled
  document.getElementById('regDate')?.addEventListener('change', (e)=>{
    const hasDate = !!e.target.value;
    setRegInputsEnabled(hasDate);
    if (hasDate) hideDateWarn(); else showDateWarn();
  });
  // If user clicks in the table while date not selected, show warning
  // Show warning if user tries to interact without date
  tbody.addEventListener('click', ()=>{
    const hasDate = !!document.getElementById('regDate')?.value;
    if (!hasDate) showDateWarn();
  });
  tbody.addEventListener('input', ()=>{
    const hasDate = !!document.getElementById('regDate')?.value;
    if (!hasDate) showDateWarn();
  });
  saveBtn?.addEventListener('click', async ()=>{
    const date = document.getElementById('regDate')?.value || '';
    if (!date){
      showDateWarn();
      document.getElementById('regDate')?.focus();
      return; // block save until date selected
    }
    const inputs = tbody.querySelectorAll('input[data-type]');
    const result = {};
    TYPES.forEach(t=> result[t] = { orders:0, cartons:0, pallets:0 });
    inputs.forEach(inp=>{
      const type = inp.getAttribute('data-type');
      const field = inp.getAttribute('data-field');
      const val = parseInt(inp.value, 10);
      const number = Number.isFinite(val) ? val : 0; // empty -> 0
      result[type][field] = number;
    });
    try{
      await saveDeliveries(date, result);
      // Optional: lock the date locally for UI
      try{ const key='deliveries:lockedDates'; const set=new Set(JSON.parse(localStorage.getItem(key)||'[]')); set.add(date); localStorage.setItem(key, JSON.stringify([...set])); }catch{}
    } finally {
      // Refresh charts and tables
      await reloadChartsOnly(); reloadKpis();
      renderStaticTotalsChart(); // refresh static all-time chart
      await loadTables();
    }
    close();
  });
})();

// Gateway Register modal wiring
(()=>{
  const modal = document.getElementById('gwRegisterModal');
  if (!modal) return;
  // Start hidden and closed
  modal.hidden = true; modal.classList.remove('open');
  const openBtn = document.getElementById('openGwRegister');
  const closeBtn = document.getElementById('closeGwRegister');
  const cancelBtn = document.getElementById('cancelGwRegister');
  const saveBtn = document.getElementById('saveGwRegister');
  const dateInput = document.getElementById('gwRegDate');
  const warn = document.getElementById('gwRegDateWarn');
  const toGateway = document.getElementById('gwRegToGateway');
  const toMain = document.getElementById('gwRegToMain');
  const totalEl = document.getElementById('gwRegTotal');

  function setEnabled(enabled){ toGateway.disabled = !enabled; toMain.disabled = !enabled; }
  function showWarn(){ if (warn) warn.style.display = 'block'; }
  function hideWarn(){ if (warn) warn.style.display = 'none'; }
  function parseNum(v){ const n = parseInt((v ?? '').toString().trim(), 10); return Number.isFinite(n) ? n : 0; }
  function recompute(){ if (totalEl) totalEl.textContent = String(parseNum(toGateway.value) + parseNum(toMain.value)); }

  function open(){
    modal.classList.add('open'); modal.hidden = false;
    const hasDate = !!dateInput?.value;
    setEnabled(hasDate);
    if (hasDate) hideWarn(); else showWarn();
  recompute();
  }
  function close(){ modal.classList.remove('open'); modal.hidden = true; }

  openBtn?.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);
  modal.addEventListener('click', (e)=>{ if (e.target === modal) close(); });
  dateInput?.addEventListener('change', ()=>{ const hasDate = !!dateInput.value; setEnabled(hasDate); if (hasDate) hideWarn(); else showWarn(); });
  ['input','change'].forEach(evt=>{ toGateway?.addEventListener(evt, recompute); toMain?.addEventListener(evt, recompute); });
  saveBtn?.addEventListener('click', async ()=>{
    const date = dateInput?.value || '';
    if (!date){ showWarn(); dateInput?.focus(); return; }
    const toG = parseNum(toGateway.value), toM = parseNum(toMain.value);
    try{
      await saveGateway(date, toG, toM);
      try{ const key='gateway:lockedDates'; const set=new Set(JSON.parse(localStorage.getItem(key)||'[]')); set.add(date); localStorage.setItem(key, JSON.stringify([...set])); }catch{}
    } finally {
      await reloadChartsOnly(); reloadKpis();
      await loadTables();
      renderGatewayTrend();
      renderStaticTotalsChart();
    }
    close();
  });
})();

// Controlled scroll behavior: page scroll by default; table scroll only after click inside
(()=>{
  const wrappers = [
    document.getElementById('courierTableWrapper'),
    document.getElementById('gatewayTableWrapper')
  ].filter(Boolean);
  wrappers.forEach(wrapper=>{
    const lock = ()=>{ wrapper.style.overflow = 'hidden'; };
    const unlock = ()=>{ wrapper.style.overflow = 'auto'; };
    // Start locked so hovering doesn't capture the wheel; page will scroll
    lock();
    // Enable table scrolling on click inside
    wrapper.addEventListener('click', unlock);
    // Re-lock when leaving the wrapper to restore smooth page scroll
    wrapper.addEventListener('mouseleave', lock);
  });
})();
