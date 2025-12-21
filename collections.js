// Collections page logic – DB only (local storage removed)
let collectionsActive = [];
// history kept only for immediate session logic after confirm (not persisted locally)
let collectionsHistory = [];
let draftParcels = [];
// Fallback operators (used only if DB fetch fails)
let operators = ['Operator A','Operator B','Operator C'];
// Real operator names loaded from DB table collection_operators (active=true)
let operatorNames = [];
let operatorFilterBuffer = '';
let operatorFilterTimer = null;
let operatorInputInitialized = false;
let pendingCollectId = null;
let editingOrderId = null;
let signature = { enabled:false, drawing:false, dataUrl:null };
// dbIdMap legacy removed – all IDs must be server IDs now
let dbIdMap = {};

// ================= Customer Autocomplete (Add Order) =================
// In-memory index of customers -> latest known contact info and recency
let customerIndex = new Map(); // key: nameLower -> { name, contactName, contactNumber, email, lastDateMs, count }
let customerSuggestionsInitialized = false;
let customerAutocompleteTimer = null;
let customerBlacklist = new Set();
let skipNextCustomerInputSuggestions = false; // suprimir overlay após seleção
// Sales rep lightweight autocomplete
let salesRepSet = new Set();
// Overlay UI elements for richer interactions (no layout changes)
let customerSugPanel = null; // wrapper div appended to body
let customerSugVisible = false;
let customerSugAnchor = null; // input element
let customerDatalistDisabled = false;
let lastCustomerEntry = null; // guarda última seleção para debug / reaplicar

function loadCustomerBlacklist(){
  try{
    const raw = localStorage.getItem('customerBlacklist') || '[]';
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)) customerBlacklist = new Set(arr.map(s=>String(s).toLowerCase()));
  }catch(e){ customerBlacklist = new Set(); }
}
function saveCustomerBlacklist(){
  try{ localStorage.setItem('customerBlacklist', JSON.stringify(Array.from(customerBlacklist))); }catch(e){}
}

function normStr(s){ return (s==null?'':String(s)).trim(); }
function keyStr(s){ return normStr(s).toLowerCase(); }

function buildCustomerIndex(){
  try{
    const idx = new Map();
    const push = (name, contactName, contactNumber, email, dateStr, createdAt, salesRep)=>{
      const nameClean = normStr(name); if(!nameClean) return;
      const k = keyStr(nameClean);
  // Recency must reflect the last saved order, not the planned date
  const when = (()=>{ try{ return new Date(createdAt||dateStr||Date.now()).getTime(); }catch{ return Date.now(); } })();
      const prev = idx.get(k);
      if(!prev){
        idx.set(k, { name: nameClean, contactName: normStr(contactName)||'', contactNumber: normStr(contactNumber)||'', email: normStr(email)||'', lastDateMs: when, count: 1, salesRep: normStr(salesRep)||'' });
      } else {
        prev.count += 1;
        if(when >= prev.lastDateMs){
          prev.lastDateMs = when;
          if(contactName) prev.contactName = normStr(contactName);
          if(contactNumber) prev.contactNumber = normStr(contactNumber);
          if(email) prev.email = normStr(email);
          if(salesRep) prev.salesRep = normStr(salesRep);
        }
      }
    };
    for(const o of collectionsActive){ if(o) push(o.customer, o.contactName, o.contactNumber, o.email, o.date, o.createdAt, o.salesRep); }
    customerIndex = idx;
  }catch(e){ reportError('buildCustomerIndex', e); }
}

function rebuildSalesRepIndex(){
  try {
    const s = new Set();
    for(const o of collectionsActive){ if(o && o.salesRep){ s.add(normStr(o.salesRep)); } }
    salesRepSet = s;
  } catch(e){ reportError('rebuildSalesRepIndex', e); }
}

async function extendSalesRepIndexFromHistory(limit=500){
  if(!dbIsEnabled() || !window.supabaseCollections || typeof window.supabaseCollections.listHistory !== 'function') return;
  try {
    const res = await window.supabaseCollections.listHistory(limit);
    if(res.success && Array.isArray(res.data)){
      for(const r of res.data){ if(r.sales_rep) salesRepSet.add(normStr(r.sales_rep)); }
      ensureSalesRepDatalist();
    }
  } catch(e){ reportError('extendSalesRepIndexFromHistory', e); }
}

function ensureSalesRepDatalist(){
  // Disabled: Sales Rep is customer-driven. Remove any datalist/arrow UI.
  try{
    const inp = document.getElementById('orderSalesRep');
    if(inp) inp.removeAttribute('list');
    const dl = document.getElementById('salesRepSuggestions');
    if(dl && dl.parentNode) dl.parentNode.removeChild(dl);
  }catch(e){ /* noop */ }
}
// (previous misplaced block removed – replaced by proper buildCustomerIndex above)

async function extendCustomerIndexFromHistory(limit=1000){
  // Pull additional customers from collections history (broader dataset)
  if(!dbIsEnabled() || !window.supabaseCollections || typeof window.supabaseCollections.listHistory !== 'function') return;
  try{
    const res = await window.supabaseCollections.listHistory(limit);
    if(!res || !res.success || !Array.isArray(res.data)) return;
    // Merge into existing index
    const rows = res.data;
    for(const r of rows){
      // History columns come snake_cased; mirror collections-history.js normalize
      const name = r.customer;
      const contactName = r.contact_name;
      const contactNumber = r.contact_number;
      const email = r.email;
      const salesRep = r.sales_rep || r.salesRep || '';
  // Use created_at for recency so the latest saved entry wins; fallback to collected_at
  const collectedAt = r.created_at || r.collected_at;
      const k = keyStr(name);
      if(!k) continue;
      const when = (()=>{ try{ return new Date(collectedAt||Date.now()).getTime(); }catch{ return Date.now(); } })();
      const prev = customerIndex.get(k);
      if(!prev){
        customerIndex.set(k, { name: normStr(name), contactName: normStr(contactName)||'', contactNumber: normStr(contactNumber)||'', email: normStr(email)||'', lastDateMs: when, count: 1, salesRep: normStr(salesRep)||'' });
      } else {
        prev.count += 1;
  if(when >= prev.lastDateMs){
          prev.lastDateMs = when;
          if(contactName) prev.contactName = normStr(contactName);
          if(contactNumber) prev.contactNumber = normStr(contactNumber);
          if(email) prev.email = normStr(email);
          if(salesRep) prev.salesRep = normStr(salesRep);
        }
      }
    }
  } catch(e){ reportError('extendCustomerIndexFromHistory', e); }
}

function getCustomerEntry(name){
  if(!name) return null;
  return customerIndex.get(keyStr(name)) || null;
}

function fillContactsForCustomer(name){
  try{
    const entry = getCustomerEntry(name);
    if(!entry) return;
    const n = document.getElementById('orderContactName'); if(n && entry.contactName) n.value = entry.contactName;
    const p = document.getElementById('orderContactNumber'); if(p && entry.contactNumber) p.value = entry.contactNumber;
    const e = document.getElementById('orderEmail'); if(e && entry.email) e.value = entry.email;
  const sr = document.getElementById('orderSalesRep');
  if(sr && !sr.value && entry.salesRep) sr.value = entry.salesRep;
  // Only hint Sales Rep while Add Order modal is open; otherwise restore original placeholder
  const addModal = document.getElementById('addOrderModal');
  if(sr){
    if(addModal && !addModal.classList.contains('hidden')){
      if(entry.salesRep){ sr.setAttribute('placeholder', entry.salesRep); }
    } else if(sr.dataset && sr.dataset.phOrig !== undefined){
      sr.setAttribute('placeholder', sr.dataset.phOrig);
    }
  }
  }catch(err){ reportError('fillContactsForCustomer', err); }
}

function computeCustomerSuggestions(prefix){
  const p = keyStr(prefix);
  const all = [];
  for(const [k,v] of customerIndex.entries()){
    if(customerBlacklist.has(k)) continue;
    all.push(v);
  }
  // Sort master list once (recency, frequency, alpha)
  all.sort((a,b)=> (b.lastDateMs - a.lastDateMs) || (b.count - a.count) || a.name.localeCompare(b.name));
  if(!p){
    return all.slice(0,30); // top recent when nada digitado
  }
  // Accept prefix length 1 agora
  const filtered = all.filter(v=> keyStr(v.name).startsWith(p));
  return filtered.slice(0,50);
}

function ensureCustomerDatalist(){
  // Create datalist once and attach to #orderCustomer via JS (no HTML/layout change)
  let dl = document.getElementById('customerSuggestions');
  if(!dl){
    dl = document.createElement('datalist');
    dl.id = 'customerSuggestions';
    document.body.appendChild(dl);
  }
  const inp = document.getElementById('orderCustomer');
  if(inp && inp.getAttribute('list') !== 'customerSuggestions'){
    inp.setAttribute('list','customerSuggestions');
  }
  return dl;
}

function setCustomerDatalistEnabled(enabled){
  const inp = document.getElementById('orderCustomer');
  if(!inp) return;
  if(enabled){
    if(customerDatalistDisabled){
      // Keep disabled to avoid duplicate UI
      customerDatalistDisabled = false;
    }
  } else {
    if(!customerDatalistDisabled){
      inp.removeAttribute('list');
      customerDatalistDisabled = true;
    }
  }
}

function disableCustomerDatalistHard(){
  try{
    const inp = document.getElementById('orderCustomer');
    if(inp) inp.removeAttribute('list');
    const dl = document.getElementById('customerSuggestions');
    if(dl && dl.parentNode) dl.parentNode.removeChild(dl);
    customerDatalistDisabled = true;
  } catch(e){ /* noop */ }
}

// Datalist desativado: usamos somente overlay custom
function updateCustomerDatalist(prefix){ /* no-op: native datalist removido */ }

function ensureCustomerOverlay(){
  if(customerSugPanel) return customerSugPanel;
  const panel = document.createElement('div');
  panel.id = 'customerSugPanel';
  Object.assign(panel.style,{
    position: 'absolute',
    left: '0px', top: '0px', width: '0px',
    background: '#fff', border: '1px solid var(--border, #cbd5e1)', borderRadius: '8px',
    boxShadow: '0 8px 20px rgba(0,0,0,0.10)',
    padding: '4px 0', maxHeight: '260px', overflowY: 'auto', zIndex: '1000',
    display: 'none'
  });
  document.body.appendChild(panel);
  customerSugPanel = panel;
  return panel;
}

function positionCustomerOverlay(anchor){
  if(!customerSugPanel || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  customerSugPanel.style.left = (rect.left + scrollX) + 'px';
  customerSugPanel.style.top = (rect.bottom + scrollY + 6) + 'px';
  customerSugPanel.style.width = rect.width + 'px';
}

function closeCustomerOverlay(){
  if(!customerSugPanel) return;
  customerSugPanel.style.display = 'none';
  customerSugPanel.innerHTML = '';
  customerSugVisible = false;
  // Keep datalist disabled to avoid duplicate suggestion UI
}

function openCustomerOverlay(matches, anchor){
  ensureCustomerOverlay();
  customerSugAnchor = anchor;
  positionCustomerOverlay(anchor);
  const panel = customerSugPanel;
  panel.innerHTML = '';
  if(!matches || !matches.length){ closeCustomerOverlay(); return; }
  // Build items: top 5 first, but all in list; panel shows scroll for rest
  const applySelection = (entry)=>{
    try{
      lastCustomerEntry = entry;
      const inp = document.getElementById('orderCustomer');
      if(inp){
        inp.value = entry.name;
        // Clear required error state if any
        inp.classList.remove('error'); inp.removeAttribute('aria-invalid');
        if(inp.dataset && inp.dataset.phOrig !== undefined){ inp.setAttribute('placeholder', inp.dataset.phOrig); }
      }
      fillContactsForCustomer(entry.name);
      // Fire both input and change so other listeners react
      if(inp){
        skipNextCustomerInputSuggestions = true;
        inp.dispatchEvent(new Event('input', {bubbles:true}));
        inp.dispatchEvent(new Event('change', {bubbles:true}));
        // Focus and move caret to end
        inp.focus();
        const len = inp.value.length;
        if(typeof inp.setSelectionRange === 'function') inp.setSelectionRange(len, len);
      }
      closeCustomerOverlay();
    }catch(e){ reportError('applyCustomerSelection', e); }
  };
  const makeItem = (entry)=>{
    const row = document.createElement('div');
    row.className = 'cust-sug-item';
    Object.assign(row.style,{
      display:'flex', alignItems:'flex-start', justifyContent:'space-between',
      gap:'8px', padding:'8px 10px', cursor:'pointer', fontSize:'.9rem'
    });
    // left: name + preview (hidden until hover)
    const left = document.createElement('div');
    left.style.flex = '1';
    const nameEl = document.createElement('div');
    nameEl.textContent = entry.name;
    nameEl.style.fontWeight = '600';
    nameEl.style.color = 'var(--text, #0f172a)';
    const prev = document.createElement('div');
    prev.className = 'cust-sug-preview';
    prev.textContent = [entry.contactName, entry.contactNumber, entry.email].filter(Boolean).join(' • ') || '—';
    Object.assign(prev.style,{ fontSize:'.78rem', color:'#475569', marginTop:'2px', display:'none' });
    left.appendChild(nameEl);
    left.appendChild(prev);
    // right: remove X
  const right = document.createElement('button');
    right.type = 'button';
    right.title = 'Remove from suggestions';
    right.textContent = '×';
  right.className = 'cust-sug-remove';
    Object.assign(right.style,{
      border:'none', background:'transparent', color:'#64748b',
      fontWeight:'700', fontSize:'16px', lineHeight:'1', cursor:'pointer',
      padding:'0 4px', marginLeft:'8px'
    });
    const handleRemove = async ()=>{
      const ok = await uiConfirm(`Remove "${entry.name}" from suggestions?`);
      if(!ok) return;
      customerBlacklist.add(keyStr(entry.name));
      saveCustomerBlacklist();
      // Rebuild current list based on current input value
      const v = (customerSugAnchor && customerSugAnchor.value) ? customerSugAnchor.value : '';
      const next = computeCustomerSuggestions(v);
      openCustomerOverlay(next, customerSugAnchor);
      toast('Suggestion removed','warn');
    };
    // Stop propagation early to avoid row mousedown selection
    right.addEventListener('mousedown', (ev)=>{ ev.stopPropagation(); ev.preventDefault(); });
    right.addEventListener('click', async (ev)=>{
      ev.stopPropagation(); ev.preventDefault();
      await handleRemove();
    });
    row.addEventListener('mouseenter', ()=>{ prev.style.display = 'block'; row.style.background = '#f8fafc'; });
    row.addEventListener('mouseleave', ()=>{ prev.style.display = 'none'; row.style.background = '#fff'; });
    // Select on mousedown (ignore clicks on remove X) and on click as fallback
    row.addEventListener('mousedown', (ev)=>{
      if(ev.target && ev.target.closest && ev.target.closest('.cust-sug-remove')) return; // ignore remove
      ev.preventDefault();
      applySelection(entry);
    });
    row.addEventListener('click', (ev)=>{
      if(ev.target && ev.target.closest && ev.target.closest('.cust-sug-remove')) return; // ignore remove
      ev.preventDefault();
      applySelection(entry);
    });
    row.appendChild(left);
    row.appendChild(right);
    return row;
  };
  // Append all items; browser will limit visible via panel maxHeight
  const top = matches.slice(0,5), rest = matches.slice(5);
  top.forEach(m => panel.appendChild(makeItem(m)));
  rest.forEach(m => panel.appendChild(makeItem(m)));
  panel.style.display = 'block';
  customerSugVisible = true;
}

function setupCustomerAutocomplete(){
  if(customerSuggestionsInitialized) return;
  loadCustomerBlacklist();
  buildCustomerIndex();
  // Fully disable native datalist and autofill to avoid duplicate suggestions
  disableCustomerDatalistHard();
  const inp = document.getElementById('orderCustomer');
  if(!inp) return;
  // Reduce browser's own autofill to avoid duplicate suggestion UIs
  inp.setAttribute('autocomplete','new-password');
  inp.setAttribute('autocapitalize','off');
  inp.setAttribute('autocorrect','off');
  inp.setAttribute('spellcheck','false');
  inp.setAttribute('name','no-autofill-customer');

  // Background: extend from history for richer suggestions (no UI block)
  (async ()=>{
    try{
      await extendCustomerIndexFromHistory(1000);
      // If user already typed something, refresh suggestions with the extended index
      const v = inp.value || '';
      if((v.trim().length)>=2){
        const matches = computeCustomerSuggestions(v);
        openCustomerOverlay(matches, inp);
      }
    } catch(e){ reportError('customerHistoryWarmup', e); }
  })();

  const onInput = ()=>{
    const v = inp.value || '';
    if(customerAutocompleteTimer) clearTimeout(customerAutocompleteTimer);
  customerAutocompleteTimer = setTimeout(()=>{
      // Custom overlay suggestions (match width to input)
      if(skipNextCustomerInputSuggestions){
        skipNextCustomerInputSuggestions = false;
        return; // não reabrir imediatamente após seleção
      }
      if(v.trim().length >= 1){
        const matches = computeCustomerSuggestions(v);
        openCustomerOverlay(matches, inp);
      } else {
        closeCustomerOverlay();
      }
    }, 120);
  };
  inp.addEventListener('input', onInput);
  // Mostrar top sugestões ao focar sem digitar
  inp.addEventListener('focus', ()=>{
    const v = inp.value.trim();
    const matches = computeCustomerSuggestions(v);
    if(matches && matches.length){ openCustomerOverlay(matches, inp); }
  });

  // Fill contacts when a known customer is chosen (change fires on datalist selection)
  inp.addEventListener('change', ()=>{
    const v = inp.value || '';
    const entry = getCustomerEntry(v);
    if(entry){
      fillContactsForCustomer(entry.name);
      // Force-remove datalist artifacts from Sales Rep
      try{
        const sr = document.getElementById('orderSalesRep');
        if(sr){ sr.removeAttribute('list'); sr.setAttribute('autocomplete','off'); }
      }catch(e){ /* noop */ }
    }
    closeCustomerOverlay();
  });

  // Long-press to remove current value from suggestions (no layout changes)
  let pressTimer = null;
  const pressStart = () => {
    if(pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(async ()=>{
      try{
        const v = (inp.value||'').trim();
        if(!v) return;
        const k = keyStr(v);
        if(!customerIndex.has(k)) return;
        const ok = await uiConfirm(`Remove "${v}" from suggestions?`);
        if(!ok) return;
        customerBlacklist.add(k);
        saveCustomerBlacklist();
        updateCustomerDatalist(inp.value||'');
        toast('Suggestion removed','warn');
      } catch(e){ reportError('customerLongPress', e); }
    }, 800); // ~0.8s hold
  };
  const pressEnd = () => { if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; } };
  inp.addEventListener('mousedown', pressStart);
  inp.addEventListener('touchstart', pressStart, {passive:true});
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(ev=> inp.addEventListener(ev, pressEnd));

  // Keyboard remove: Shift+Delete when value matches a known suggestion
  inp.addEventListener('keydown', async (e)=>{
    if(e.key === 'Delete' && e.shiftKey){
      const v = (inp.value||'').trim(); if(!v) return;
      const k = keyStr(v); if(!customerIndex.has(k)) return;
      e.preventDefault();
      const ok = await uiConfirm(`Remove "${v}" from suggestions?`);
      if(!ok) return;
  customerBlacklist.add(k); saveCustomerBlacklist();
  // Refresh overlay (no datalist)
  const matches = computeCustomerSuggestions(v);
  if(matches.length){ openCustomerOverlay(matches, inp); } else { closeCustomerOverlay(); }
  toast('Suggestion removed','warn');
    }
  });

  // Close overlay when clicking outside
  document.addEventListener('click', (e)=>{
    const target = e.target;
    if(customerSugVisible){
      if(customerSugPanel && !customerSugPanel.contains(target) && target !== inp){
        closeCustomerOverlay();
      }
    }
  });
  window.addEventListener('resize', ()=>{ if(customerSugVisible && customerSugAnchor) positionCustomerOverlay(customerSugAnchor); });
  window.addEventListener('scroll', ()=>{ if(customerSugVisible && customerSugAnchor) positionCustomerOverlay(customerSugAnchor); }, true);

  customerSuggestionsInitialized = true;
}

function refreshCustomerAutocompleteSources(){
  // Recompute index after data changes and refresh current suggestions if input has content
  buildCustomerIndex();
  const inp = document.getElementById('orderCustomer');
  if(inp && (inp.value||'').length>=1){
    const matches = computeCustomerSuggestions(inp.value);
    if(matches.length) openCustomerOverlay(matches, inp);
  }
}

// ---- Validation helpers (no UI impact) ----
function clampNumber(v, min, max){
  const n = Number(v); if(Number.isNaN(n)) return min; return Math.min(max, Math.max(min, n));
}
function sanitizeText(str, maxLen){
  if(!str) return '';
  let s = String(str).trim();
  if(s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Date helpers: always compute local YYYY-MM-DD (avoid UTC off-by-one via toISOString)
function getTodayLocalYMD(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// Accept any non ord_ id as server (uuid or numeric)
function isServerId(v){
  if (v == null) return false;
  const s = String(v);
  return !s.startsWith('ord_');
}

// Lightweight DB status helpers
function dbIsEnabled(){ return !!(window.supabaseCollections && !window.dbDisabled); }
function reportInfo(tag, msg){
  try{
    const panel = document.getElementById('selfTestPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.innerHTML += `<div>${tag}: ${msg}</div>`;
  } catch(e){}
}
function handleDbError(tag, err){
  reportError(tag, err);
  const msg = (err||'').toString().toLowerCase();
  const policyLike = msg.includes('permission') || msg.includes('policy') || msg.includes('rls');
  if (policyLike){
    window.dbPolicyIssue = true;
    toast('Database policy prevented the operation','warn');
  } else {
    toast('Database unavailable','error');
  }
}

// ensureDbIdForOrder removed – all creates must succeed before UI insertion

function mapDbToUi(row){
  if (!row) return row;
  if (row.contact_name !== undefined || row.collection_date !== undefined){
    return {
  id: row.id != null ? String(row.id) : row.id,
      customer: row.customer,
      reference: row.reference,
      cartons: row.cartons,
      pallets: row.pallets,
  tubes: row.tubes,
  invoice: row.invoice || row.invoice_number || row.invoice_no || '',
  salesRep: row.sales_rep || row.salesrep || row.rep || '',
      contactName: row.contact_name,
      contactNumber: row.contact_number,
      email: row.email,
      date: row.collection_date,
      createdAt: row.created_at
    };
  }
  return row;
      // Inline error reporter to the selfTestPanel (if present)
}

// Toasts
function toast(message, type='success'){
  const cont = document.getElementById('toastContainer');
  if(!cont) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  cont.appendChild(el);
  setTimeout(()=>{ try { cont.removeChild(el); } catch(e){} }, 2800);
}

// Inline error reporter to the selfTestPanel (if present)
function reportError(tag, err){
  try{
    const panel = document.getElementById('selfTestPanel');
    if (!panel) return;
    const msg = (err && err.message) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
    panel.classList.remove('hidden');
    panel.innerHTML += `<div>${tag}: ERR: ${msg}</div>`;
  } catch(e){ /* noop */ }
}

// Modal confirm (promise)
function uiConfirm(message){
  return new Promise((resolve)=>{
    const modal = document.getElementById('confirmModal');
    const msg = document.getElementById('confirmMessage');
    const yes = document.getElementById('confirmYes');
    const no = document.getElementById('confirmNo');
    if (!modal || !msg || !yes || !no){ resolve(false); return; }
    msg.textContent = message || 'Confirm?';
    modal.classList.remove('hidden');
    const cleanup = ()=>{
      yes.onclick = null; no.onclick = null;
      modal.classList.add('hidden');
    };
    yes.onclick = ()=>{ cleanup(); resolve(true); };
    no.onclick = ()=>{ cleanup(); resolve(false); };
  });
}
function closeConfirmModal(){
  const modal = document.getElementById('confirmModal');
  if (modal) modal.classList.add('hidden');
}

async function refreshCollections(silent = false){
  if(!dbIsEnabled()) return;
  try{
    const res = await window.supabaseCollections.listActive();
    if(res.success){
      collectionsActive = (res.data||[]).map(mapDbToUi);
      renderCollections();
  // keep customer index in sync
  refreshCustomerAutocompleteSources();
  // Sales Rep field no longer uses a datalist; it is populated from customer selection only
    } else if(!silent){
      handleDbError('realtime:listActive', res.error);
    }
  }catch(e){
    if(!silent) reportError('refreshCollections', e);
  }
}

(async function init() {
  // Seed operator select (will be replaced after DB fetch)
  const opSel = document.getElementById('collectionOperator');
  if (opSel) operators.forEach(o => { const opt=document.createElement('option'); opt.value=o; opt.textContent=o; opSel.appendChild(opt); });

  // Fetch real operators from DB (if available)
  try {
    if (dbIsEnabled() && window.supabase){
      const { data, error } = await supabase
        .from('collection_operators')
        .select('name')
        .eq('active', true)
        .order('name');
      if(!error && Array.isArray(data)){
        operatorNames = data.map(r=>r.name).filter(Boolean);
        if (operatorNames.length){
          populateOperatorSelect();
          bindOperatorTypeAhead();
          enhanceOperatorSelect();
        }
      } else {
        bindOperatorTypeAhead();
        enhanceOperatorSelect();
      }
    } else {
      bindOperatorTypeAhead();
      enhanceOperatorSelect();
    }
  } catch(e){
    reportError('loadOperators', e);
    bindOperatorTypeAhead();
    enhanceOperatorSelect();
  }
  const todayStr = getTodayLocalYMD();
  const orderDate = document.getElementById('orderDate'); if (orderDate) orderDate.value = todayStr;
  const cDate = document.getElementById('collectionDate'); if (cDate) cDate.value = todayStr;
  const cTime = document.getElementById('collectionTime'); if (cTime) cTime.value = new Date().toTimeString().slice(0,5);
  try {
    if (dbIsEnabled()){
      const res = await window.supabaseCollections.listActive();
      if (res.success){
        collectionsActive = (res.data || []).map(mapDbToUi);
  // Sales Rep datalist disabled; value/placeholder come from customer history
      } else {
        console.error('Supabase listActive error:', res.error);
        handleDbError('listActive', res.error);
      }
    } else {
      toast('Database not initialised','error');
    }
  } catch(e){ reportError('init:listActive', e); }
  renderCollections();
  // Initialize customer autocomplete data after first load
  refreshCustomerAutocompleteSources();
  // Sales Rep suggestions warm-up removed (not used by UI)
  try { await maybeRunSelfTest(); } catch(e) { console.error('SelfTest error', e); }

  // === Realtime subscribe (após primeira carga) ===
  if (dbIsEnabled() && window.supabase && !window.collectionsRealtimeChannel){
    window.collectionsRealtimeChannel = supabase
      .channel('realtime:collections_active')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'collections_active' },
        (_payload)=> { refreshCollections(true); })
      .subscribe();
  }
})();

function openAddOrderModal(){
  console.log('[AddOrder] openAddOrderModal()');
  // Reset draft parcels FIRST
  draftParcels = [];
  // Show modal earlier so elements are measurable/visible if any CSS depends on :not(.hidden)
  showModal('addOrderModal');
  // Ensure customer autocomplete is ready (no layout change)
  try { setupCustomerAutocomplete(); } catch(e){ reportError('setupCustomerAutocomplete', e); }
  const addModal = document.getElementById('addOrderModal');
  // Ensure placeholder present immediately (in case JS execution later fails)
  const wrap = document.getElementById('parcelDraftList');
  if(wrap){ wrap.innerHTML = 'No parcels added yet.'; wrap.classList.add('field-error-msg'); wrap.style.color = '#dc2626'; }
  // Clear input fields
  if(addModal){
    addModal.querySelectorAll('input').forEach(inp=>{
  // Capture original placeholder once
  if(!inp.dataset.phOrig){ inp.dataset.phOrig = inp.getAttribute('placeholder') || ''; }
      if(inp.id !== 'orderDate') inp.value='';
      inp.classList.remove('error');
      inp.removeAttribute('aria-invalid');
  // Always restore original placeholder (e.g., "Sales Rep")
  inp.setAttribute('placeholder', inp.dataset.phOrig || '');
    });
    addModal.querySelectorAll('.field-error-msg').forEach(el=>{
      // keep the parcelDraftList message; remove only those next to inputs
      if(el.id !== 'parcelDraftList') el.remove();
    });
  }
  // Always set to today's local date on open (prevents UTC/offset showing yesterday)
  const dateEl = document.getElementById('orderDate'); if (dateEl) dateEl.value = getTodayLocalYMD();
  
  // Auto-focus on Reference field (Sales Order) for quick scanning
  setTimeout(() => {
    const refInput = document.getElementById('orderReference');
    if (refInput) {
      refInput.focus();
      refInput.select();
    }
  }, 100);
  
  // Re-render parcel UI after a tick (ensures DOM ready)
  setTimeout(()=>{ try { updateParcelDraftUI(); } catch(e){ console.error('[AddOrder] updateParcelDraftUI after open failed', e); } }, 0);
}
function closeAddOrderModal(){
  const modal = document.getElementById('addOrderModal');
  if(modal) modal.classList.add('hidden');
  // Garantir remoção do overlay de sugestões (evita "fantasma" no meio da página)
  try {
    if(customerSugPanel){
      customerSugPanel.style.display='none';
      customerSugPanel.innerHTML='';
      customerSugVisible = false;
    }
  } catch(e){ /* noop */ }
}

// ================= Cin7 Integration =================
async function lookupCin7Order() {
  const refInput = document.getElementById('orderReference');
  const statusDiv = document.getElementById('cin7Status');
  const fetchBtn = document.getElementById('cin7LookupBtn');
  
  if (!refInput) return;
  
  let reference = refInput.value.trim().toUpperCase();
  
  if (!reference) {
    showCin7Status('⚠️ Please enter a reference number', 'warning');
    refInput.focus();
    return;
  }
  
  // Auto-add SO- prefix if missing
  if (!reference.startsWith('SO-')) {
    reference = 'SO-' + reference.replace(/^SO/, '');
    refInput.value = reference;
  }
  
  // Show loading state
  const startTime = performance.now();
  if (fetchBtn) {
    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  showCin7Status('🔍 Looking up...', 'info');
  
  try {
    const result = await cin7Service.lookupOrder(reference);
    const elapsed = Math.round(performance.now() - startTime);
    
    if (result.success) {
      // Populate form fields
      populateFromCin7(result);
      
      // Track request in integration monitor
      if (window.cin7TrackRequest) {
        window.cin7TrackRequest(reference, result.customer_name || 'Unknown', elapsed);
      }
      
      // Show success feedback
      const source = result.source === 'cache' ? '⚡ CACHE' : '☁️ API';
      showCin7Status(`✓ ${source} (${elapsed}ms) - ${result.customer_name || reference}`, 'success');
      
      // Focus on next field (customer or contact)
      const customerInput = document.getElementById('orderCustomer');
      if (customerInput) customerInput.focus();
    } else {
      showCin7Status(`❌ ${result.error || 'Could not fetch order'}`, 'error');
    }
  } catch (error) {
    console.error('[Cin7] Lookup error:', error);
    showCin7Status('❌ Error fetching order', 'error');
  } finally {
    if (fetchBtn) {
      fetchBtn.disabled = false;
      fetchBtn.innerHTML = '<i class="fas fa-search"></i>';
    }
  }
}

function populateFromCin7(data) {
  try {
    // Customer info
    if (data.customer_name) {
      document.getElementById('orderCustomer').value = data.customer_name;
    }
    
    // Contact info
    if (data.contact_name) {
      document.getElementById('orderContactName').value = data.contact_name;
    }
    
    if (data.phone) {
      document.getElementById('orderContactNumber').value = data.phone;
    }
    
    if (data.email) {
      document.getElementById('orderEmail').value = data.email;
    }
    
    // Sales Rep - populate if field exists
    if (data.sales_rep) {
      const salesRepInput = document.getElementById('orderSalesRep');
      if (salesRepInput) {
        salesRepInput.value = data.sales_rep;
      }
    }
    
    // Invoice Number - Direct API fetch (fresh data)
    if (data.invoice_number) {
      const invoiceInput = document.getElementById('orderInvoice');
      if (invoiceInput) {
        invoiceInput.value = data.invoice_number;
      }
    }
    
    // Trigger customer autocomplete to update
    const customerInput = document.getElementById('orderCustomer');
    if (customerInput && data.customer_name) {
      customerInput.dispatchEvent(new Event('input', {bubbles: true}));
    }
    
    console.log('[Cin7] Form populated:', {
      customer: data.customer_name,
      contact: data.contact_name,
      email: data.email,
      salesRep: data.sales_rep,
      invoice: data.invoice_number,
      invoice: data.invoice_number
    });
  } catch (error) {
    console.error('[Cin7] Error populating form:', error);
  }
}

function showCin7Status(message, type) {
  const statusDiv = document.getElementById('cin7Status');
  if (!statusDiv) return;
  
  const colors = {
    info: '#3b82f6',
    success: '#16a34a',
    warning: '#f59e0b',
    error: '#dc2626'
  };
  
  statusDiv.textContent = message;
  statusDiv.style.color = colors[type] || colors.info;
  statusDiv.style.fontWeight = type === 'error' || type === 'warning' ? '600' : '400';
}

// Auto-lookup on Enter key in reference field
// Also auto-lookup when barcode scanner fills the field
document.addEventListener('DOMContentLoaded', () => {
  const refInput = document.getElementById('orderReference');
  if (refInput) {
    let scanTimer = null;
    let lastValue = '';
    
    // Enter key trigger
    refInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupCin7Order();
      }
    });
    
    // Auto-trigger after barcode scan (fast typing followed by pause)
    refInput.addEventListener('input', (e) => {
      const currentValue = e.target.value.trim();
      
      // Clear previous timer
      if (scanTimer) clearTimeout(scanTimer);
      
      // If value changed significantly and looks like an order number
      if (currentValue && currentValue !== lastValue) {
        // Check if it looks like an order number (SO-XXXXX or just numbers)
        const looksLikeOrder = /^(SO-?\d+|\d+)$/i.test(currentValue);
        
        if (looksLikeOrder) {
          // Wait 300ms after last input, then auto-lookup
          // Barcode scanners type fast and finish quickly
          scanTimer = setTimeout(() => {
            console.log('[Cin7] Auto-triggering lookup after scan');
            lookupCin7Order();
          }, 300);
        }
      }
      
      lastValue = currentValue;
    });
  }
});

function showModal(id){ const el=document.getElementById(id); if(el) el.classList.remove('hidden'); }
function hideModal(id){ const el=document.getElementById(id); if(el) el.classList.add('hidden'); }

function addParcelToDraft(){
  console.log('[AddOrder] addParcelToDraft click');
  const type = document.getElementById('parcelType').value;
  const qtyInput = document.getElementById('parcelQty');
  const qty = parseInt(qtyInput.value||'0',10);
  if(!qty||qty<1){ toast('Enter a valid quantity','error'); return; }
  draftParcels.push({type,qty});
  console.log('[AddOrder] parcels now:', draftParcels);
  qtyInput.value='1'; // Reset to 1 instead of empty
  updateParcelDraftUI();
}

// Defensive: if inline onclick was stripped or script loaded late, ensure button works
document.addEventListener('DOMContentLoaded', () => {
  try {
    const btn = document.getElementById('addParcelBtn');
    if(btn && !btn._boundAdd){
      btn.addEventListener('click', (e)=>{ e.preventDefault(); addParcelToDraft(); });
      btn._boundAdd = true;
    }
  } catch(e){ console.warn('Add parcel bind failed', e); }
});
function updateParcelDraftUI(){
  try { console.log('[AddOrder] updateParcelDraftUI start len=', draftParcels.length); } catch(e){}
  const wrap=document.getElementById('parcelDraftList');
  if(!wrap) return;
  if(draftParcels.length){
    // remove error class if present
    wrap.classList.remove('field-error-msg');
    wrap.style.color='';
    wrap.innerHTML = draftParcels.map((p,i)=>
      `<span class="parcel-tag" style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--border);border-radius:8px;background:#fff;margin:2px 4px 2px 0;font-size:.8rem;font-weight:600;color:var(--text)">
        ${p.type} x ${p.qty}
        <button type="button" class="parcel-remove" data-i="${i}" aria-label="Remove parcel" style="border:none;background:#fff;color:#dc2626;font-weight:700;cursor:pointer;font-size:.9em;line-height:1;padding:0 4px">×</button>
      </span>`).join('');
  } else {
    wrap.classList.add('field-error-msg');
    wrap.style.color='#dc2626';
    wrap.innerHTML = 'No parcels added yet.';
  }
  // Attach handlers
  wrap.querySelectorAll('.parcel-remove').forEach(btn=>{
    btn.onclick = ()=>{
      const idx = parseInt(btn.getAttribute('data-i'),10);
      if(!isNaN(idx)){
        draftParcels.splice(idx,1);
        updateParcelDraftUI();
      }
    };
  });
  try { console.log('[AddOrder] updateParcelDraftUI done'); } catch(e){}
}

// (Legacy confirmAddOrder removed; single implementation lives in confirmAddOrderInternal)

// Save & immediately print labels (opens after successful create)
async function confirmAddOrderAndPrint(){
  await confirmAddOrderInternal(true);
}

// Extract shared logic so we can branch for print
async function confirmAddOrderInternal(shouldPrint){
  // Sanitize textual fields (no layout/UI change)
  const customer = sanitizeText(document.getElementById('orderCustomer').value, 80);
  const reference = sanitizeText(document.getElementById('orderReference').value, 80);
  const salesRep = sanitizeText((document.getElementById('orderSalesRep')?.value||''), 80);
  const invoice = sanitizeText((document.getElementById('orderInvoice')?.value||''), 40);
  const contactName = sanitizeText(document.getElementById('orderContactName').value, 80);
  const contactNumber = sanitizeText(document.getElementById('orderContactNumber').value, 40);
  const email = sanitizeText((document.getElementById('orderEmail')?.value||''), 120);
  const date = document.getElementById('orderDate').value;
  // Clear previous required state
  ['orderCustomer','orderReference','orderDate'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.classList.remove('error'); el.removeAttribute('aria-invalid'); }});
  let missing=[];
  if(!customer) missing.push('Customer');
  if(!reference) missing.push('Reference');
  if(!date) missing.push('Date');
  if(missing.length){
    ['orderCustomer','orderReference','orderDate'].forEach(id=>{
      const el=document.getElementById(id);
      if(el && !el.value.trim()) {
        el.classList.add('error'); el.setAttribute('aria-invalid','true');
        if(!el.dataset.phOrig){ el.dataset.phOrig = el.getAttribute('placeholder')||''; }
        el.setAttribute('placeholder', 'Required');
        // attach inline small message if not exists
        if(!el.nextElementSibling || !el.nextElementSibling.classList.contains('field-error-msg')){
          const msg=document.createElement('div');
          msg.className='field-error-msg';
          msg.setAttribute('role','alert');
          msg.textContent='This field is required';
          // inline style fallback to guarantee red even if CSS caching/order issues
          msg.style.color = '#dc2626';
          msg.style.fontWeight = '600';
          el.parentElement.appendChild(msg);
        }
        if(!el.dataset._bindRequiredRestore){
          el.addEventListener('input', ()=>{
            if(el.value.trim()){
              el.classList.remove('error'); el.removeAttribute('aria-invalid');
              if(el.dataset.phOrig!==undefined){ el.setAttribute('placeholder', el.dataset.phOrig); }
              const next=el.nextElementSibling; if(next && next.classList.contains('field-error-msg')) next.remove();
            }
          });
          el.dataset._bindRequiredRestore = '1';
        }
      }
    });
  toast('Missing: '+missing.join(', '),'error');
  return;
  }
  // Aggregate + clamp parcel counts
  const cartons = clampNumber(draftParcels.filter(p=>p.type==='carton').reduce((a,b)=>a+b.qty,0),0,9999);
  const pallets = clampNumber(draftParcels.filter(p=>p.type==='pallet').reduce((a,b)=>a+b.qty,0),0,9999);
  const tubes   = clampNumber(draftParcels.filter(p=>p.type==='tube').reduce((a,b)=>a+b.qty,0),0,9999);
  if(!cartons&&!pallets&&!tubes){
    toast('Add at least one parcel','error');
    return;
  }
  const summary=draftParcels.map(p=>`${p.type} x ${p.qty}`).join(', ');
  const ok = await uiConfirm(`Add order with: ${summary}?`);
  if(!ok) return; 

  // Cria direto no DB (sem fallback local)
  let createRes = await window.supabaseCollections.create({
    customer, reference, cartons, pallets, tubes,
    contactName, contactNumber, email, date,
    salesRep, invoice
  });
  if(!createRes.success){
    handleDbError('create', createRes.error);
    toast('Create failed','error');
    return;
  }
  const order = mapDbToUi(createRes.data);
  collectionsActive.unshift(order);
  try { // update customer sources immediately
    buildCustomerIndex();
    if(order && order.customer){
      // Prefer the latest contact values just submitted
      const k = keyStr(order.customer);
      const ex = customerIndex.get(k);
  const newMs = new Date(order.createdAt || order.date || Date.now()).getTime();
  const merged = ex || { name: order.customer, contactName:'', contactNumber:'', email:'', lastDateMs:0, count:0, salesRep:'' };
      merged.contactName = normStr(order.contactName) || merged.contactName;
      merged.contactNumber = normStr(order.contactNumber) || merged.contactNumber;
      merged.email = normStr(order.email) || merged.email;
      merged.lastDateMs = Math.max(merged.lastDateMs, newMs);
      merged.count = (merged.count||0) + 1;
  if(order.salesRep) merged.salesRep = normStr(order.salesRep);
      customerIndex.set(k, merged);
    }
    // Refresh overlay imediatamente para incluir novo cliente
    const custInput = document.getElementById('orderCustomer');
    if(custInput){
      const matches = computeCustomerSuggestions(custInput.value.trim());
      if(matches.length) openCustomerOverlay(matches, custInput);
    }
  } catch(e){ reportError('postCreateCustomerIndex', e); }
  toast('Order added','success');
  closeAddOrderModal();
  renderCollections();
  ['orderCustomer','orderReference','orderSalesRep','orderInvoice','orderContactName','orderContactNumber','orderEmail']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  // Restore Sales Rep placeholder to its original label after save
  (function(){
    const sr = document.getElementById('orderSalesRep');
    if(sr){
      if(!sr.dataset.phOrig){ sr.dataset.phOrig = sr.getAttribute('placeholder') || ''; }
      sr.setAttribute('placeholder', sr.dataset.phOrig || '');
    }
  })();
  if(salesRep) { salesRepSet.add(salesRep); ensureSalesRepDatalist(); }
  draftParcels=[]; updateParcelDraftUI();
  if (shouldPrint){
    try { printOrderLabels(order); } catch(e){ reportError('printLabels', e); toast('Print failed','error'); }
  }
}

// Override original confirmAddOrder to reuse internal logic (preserve existing external calls)
async function confirmAddOrder(){ await confirmAddOrderInternal(false); }

function printOrderLabels(order){
  const total = (order.cartons||0) + (order.pallets||0) + (order.tubes||0);
  if (!total){ toast('No parcels to print labels for','warn'); return; }
  // Generate pages: one label per parcel
  const html = buildCollectionLabelsHTML(order, total);
  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
}

function buildCollectionLabelsHTML(order, total){
  const safe = v => (v==null?'':String(v)).replace(/[<>]/g,'');
  const fmtDate = (dStr)=>{ try{ const d=new Date(dStr); const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); const yyyy=d.getFullYear(); return `${dd}-${mm}-${yyyy}`; } catch { return safe(dStr); } };
  const pages = [];
  for (let i=1;i<=total;i++){
    const codeContent = `COLL:${safe(order.id)}:${i}/${total}`; // conteúdo para scan
    const encoded = encodeURIComponent(codeContent);
  pages.push(`
      <div class="label">
        <div class="header">COLLECTION ORDER</div>
        <div class="divider"></div>
        <div class="info-line"><span class="section-label">CUSTOMER:</span><span>${safe(order.customer)}</span></div>
  <div class="info-line"><span class="section-label">REFERENCE:</span><span>${safe(order.reference)}</span></div>
  <div class='info-line'><span class='section-label'>INVOICE:</span><span>${safe(order.invoice)||'—'}</span></div>
        ${order.cartons?`<div class='info-line'><span class='section-label'>CARTONS:</span><span>${order.cartons}</span></div>`:''}
        ${order.pallets?`<div class='info-line'><span class='section-label'>PALLETS:</span><span>${order.pallets}</span></div>`:''}
        ${order.tubes?`<div class='info-line'><span class='section-label'>TUBES:</span><span>${order.tubes}</span></div>`:''}
        <div class="info-line"><span class="section-label">DATE:</span><span>${fmtDate(order.date)}</span></div>
        <div class="footer">
          <div class="label-number">${i} / ${total}</div>
          <div class="qr-wrap">
      <img class="qr-img" src="https://barcode.tec-it.com/barcode.ashx?data=${encoded}&code=QRCode&translate-esc=true" alt="QR code" />
          </div>
        </div>
      </div>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Collection Labels</title>
    <style>
      body{margin:0;font-family:Arial,sans-serif;}
  .label{width:100mm;height:150mm;border:2px solid #000;box-sizing:border-box;padding:8mm 8mm 12mm;page-break-after:always;position:relative;}
  .header{text-align:center;font-weight:bold;font-size:30px;letter-spacing:1px;}
      .divider{border-bottom:2px solid #000;margin:8px 0 10px;}
  .info-line{display:flex;align-items:baseline;font-size:16px;margin:5px 0;}
  .section-label{font-weight:bold;min-width:96px;font-size:15px;}
      .footer{position:absolute;left:0;bottom:8mm;width:100%;display:flex;justify-content:space-between;align-items:flex-end;padding:0 6mm;box-sizing:border-box;}
  .label-number{font-weight:bold;font-size:18px;}
  .qr-wrap{display:flex;align-items:center;justify-content:center;}
  .qr-img{width:34mm;height:34mm;border:1px solid #000;border-radius:4px;object-fit:contain;}
      @media print{@page{size:100mm 150mm;margin:0;}body{margin:0;} .label{margin:0;}}
    </style>
  </head><body>${pages.join('')}
  <script>
  window.onload = function(){
    // Imprime após pequeno delay para garantir load das imagens remotas
    setTimeout(()=>{ try { window.print(); window.onafterprint=()=>window.close(); } catch(e){} }, 160);
  };
  </script>
  </body></html>`;
}

function printOrderLabelsById(id){
  const order = collectionsActive.find(o=>String(o.id)===String(id));
  if (!order){ toast('Order not found','error'); return; }
  try { printOrderLabels(order); } catch(e){ reportError('printOrderLabelsById', e); toast('Print failed','error'); }
}

function clearLocalCaches(){ toast('Local cache disabled in DB-only mode','warn'); }

function daysDiffFrom(dateStr){ const d1=new Date(dateStr); const d2=new Date(); return Math.floor((d2-d1)/(1000*60*60*24)); }
function dateClass(dateStr){ const d=daysDiffFrom(dateStr); if(d<7) return 'neutral'; if(d<14) return 'warn'; return 'danger'; }
function formatShort(dateStr){ try{ const d=new Date(dateStr); const dd=String(d.getDate()).padStart(2,'0'); const mm=String(d.getMonth()+1).padStart(2,'0'); const yy=String(d.getFullYear()).slice(-2); return `${dd}/${mm}/${yy}`; } catch { return dateStr; } }
// Status now indicated only by color of the date chip

function renderCollections(){
  const q=(document.getElementById('collectionsSearch').value||'').toLowerCase();
  const rows=collectionsActive
    .slice()
    .sort((a,b)=> new Date(b.date||0) - new Date(a.date||0))
    .filter(o=>{ if(!q) return true; return [o.customer,o.reference,o.invoice,o.salesRep,o.contactName,o.email,o.id].some(v=>(v||'').toLowerCase().includes(q)); });
  // Build duplicate info
  const normalizeCustomer = (name)=> (typeof keyStr==='function'? keyStr(name): String(name||'').trim().toLowerCase());
  const counts = new Map();
  rows.forEach(o=>{ const k = normalizeCustomer(o.customer); counts.set(k, (counts.get(k)||0)+1); });
  const dupKeys = new Set(Array.from(counts.entries()).filter(([,c])=>c>1).map(([k])=>k));
  const btn = document.getElementById('toggleDupBtn');
  const showOnlyDup = !!(btn && btn.getAttribute('aria-pressed')==='true');
  if(btn){
    const n = dupKeys.size;
    btn.disabled = n===0;
    btn.textContent = showOnlyDup ? `Show all (${n})` : `Show duplicates (${n})`;
  }
  const effRows = showOnlyDup ? rows.filter(o=> dupKeys.has(normalizeCustomer(o.customer))) : rows;
  const tbody=document.getElementById('collectionsTbody');
  if (!tbody) return;
  if (effRows.length === 0){
    if(q || showOnlyDup){ tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:.7">Order not found</td></tr>'; }
    else { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;opacity:.7">No data</td></tr>'; }
    return;
  }
  tbody.innerHTML = effRows.map(o=>{
    const highlight = q && [o.customer,o.reference,o.invoice,o.salesRep,o.contactName,o.email,o.id].some(v => (v||'').toLowerCase().includes(q));
    const isDup = dupKeys.has(normalizeCustomer(o.customer));
    const hlAttr = (highlight || (showOnlyDup && isDup)) ? ' style="background:#fffbe6"' : '';
    const custKey = normalizeCustomer(o.customer);
    const dupCount = counts.get(custKey) || 0;
    const dupBadge = (!showOnlyDup && dupCount>1) ? `<span class="dup-badge" title="This customer has ${dupCount} active orders">×${dupCount}</span>` : '';
    return `<tr>
      <td${hlAttr}>${o.customer} ${dupBadge}</td>
      <td>${o.reference}</td>
      <td>${o.cartons||0}</td>
      <td>${o.pallets||0}</td>
      <td>${o.tubes||0}</td>
      <td>${o.invoice||''}</td>
      <td>${o.salesRep||''}</td>
      <td><span class="date-chip ${dateClass(o.date)}">${formatShort(o.date)}</span></td>
      <td class="actions-col" style="text-align:right">
        <div class="action-buttons">
          <button class="btn-mini btn-green" title="Confirm" onclick="openConfirmCollect('${o.id}')">✓</button>
          <button class="btn-mini btn-blue" title="Edit" onclick="openEditOrder('${o.id}')">✎</button>
          <button class="btn-mini" title="Print Labels" onclick="printOrderLabelsById('${o.id}')">🖨️</button>
          <button class="btn-mini" title="Message" onclick="messageOrder('${o.id}')">💬</button>
          <button class="btn-mini btn-red" title="Cancel" onclick="cancelOrder('${o.id}')">✕</button>
        </div>
      </td>
    </tr>`; }).join('');
}
function filterCollections(){ renderCollections(); }
function resetCollectionsFilters(){ document.getElementById('collectionsSearch').value=''; renderCollections(); }

// Bind Show Duplicates toggle
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.getElementById('toggleDupBtn');
  if(btn && !btn._dupBound){
    btn.addEventListener('click', ()=>{
      const pressed = btn.getAttribute('aria-pressed')==='true';
      btn.setAttribute('aria-pressed', pressed ? 'false' : 'true');
      renderCollections();
    });
    btn._dupBound = true;
  }
});

async function cancelOrder(id){
  const ok = await uiConfirm('Cancel this order?');
  if(!ok) return;
  const idx = collectionsActive.findIndex(o=>String(o.id)===String(id));
  if(idx===-1){ toast('Order not found','error'); return; }
  const res = await window.supabaseCollections.remove(id);
  if(!res.success){
    handleDbError('cancel', res.error);
    toast('Delete failed','error');
    return;
  }
  collectionsActive.splice(idx,1);
  toast('Order canceled','warn');
  renderCollections();
}
function openEditOrder(id){
  const o = collectionsActive.find(x => String(x.id) === String(id));
  if(!o) return;
  editingOrderId = String(id);
  showModal('editOrderModal');
  ['Customer','Reference','SalesRep','Invoice','ContactName','ContactNumber','Email'].forEach(k=>{
    const el=document.getElementById('edit'+k); if(el) el.value = o[ k.charAt(0).toLowerCase()+k.slice(1) ] || '';
  });
  const ec=document.getElementById('editCartons'); if(ec) ec.value = o.cartons||0;
  const ep=document.getElementById('editPallets'); if(ep) ep.value = o.pallets||0;
  const et=document.getElementById('editTubes'); if(et) et.value = o.tubes||0;
  const ed=document.getElementById('editDate'); if(ed) ed.value = o.date || '';
}
function closeEditOrderModal(){ hideModal('editOrderModal'); editingOrderId=null; }
async function saveEditOrder(){
  if(!editingOrderId) return;
  const idx = collectionsActive.findIndex(x => String(x.id) === String(editingOrderId));
  if(idx===-1) return;
  const updated = {
    ...collectionsActive[idx],
  customer: sanitizeText((document.getElementById('editCustomer').value||''), 80),
  reference: sanitizeText((document.getElementById('editReference').value||''), 80),
  salesRep: sanitizeText((document.getElementById('editSalesRep')?.value||''), 80),
  invoice: sanitizeText((document.getElementById('editInvoice')?.value||''), 40),
  contactName: sanitizeText((document.getElementById('editContactName').value||''), 80),
  contactNumber: sanitizeText((document.getElementById('editContactNumber').value||''), 40),
  email: sanitizeText((document.getElementById('editEmail').value||''), 120),
  cartons: clampNumber(parseInt(document.getElementById('editCartons').value||'0',10) || 0,0,9999),
  pallets: clampNumber(parseInt(document.getElementById('editPallets').value||'0',10) || 0,0,9999),
  tubes: clampNumber(parseInt(document.getElementById('editTubes').value||'0',10) || 0,0,9999),
    date: document.getElementById('editDate').value
  };
  // Required: customer, reference, date (contact fields now optional, same regra do Add Order)
  if(!updated.customer || !updated.reference || !updated.date){
    toast('Fill required fields','error');
    return;
  }
  // Must still have at least one parcel (cartons/pallets/tubes > 0)
  if(!updated.cartons && !updated.pallets && !updated.tubes){
    toast('Add at least one parcel','error');
    return;
  }
  if (dbIsEnabled()){
    const res = await window.supabaseCollections.update(editingOrderId, {
      customer: updated.customer,
      reference: updated.reference,
      cartons: updated.cartons,
      pallets: updated.pallets,
  tubes: updated.tubes,
  salesRep: updated.salesRep,
  invoice: updated.invoice,
  contactName: updated.contactName,
      contactNumber: updated.contactNumber,
      email: updated.email,
      date: updated.date
    });
    if (!res.success){
      console.error('Supabase update error:', res.error);
      handleDbError('update', res.error);
  collectionsActive[idx] = updated; // keep optimistic change
    } else {
      collectionsActive[idx] = mapDbToUi(res.data);
    }
  } else {
    collectionsActive[idx] = updated;
  }
  toast('Order updated','success');
  closeEditOrderModal();
  renderCollections();
}

function openConfirmCollect(id){
  pendingCollectId=id;
  const today=new Date();
  // Set local date (not UTC) to avoid off-by-one
  document.getElementById('collectionDate').value=getTodayLocalYMD();
  document.getElementById('collectionTime').value=today.toTimeString().slice(0,5);
  // Clear collectedBy field
  const cb = document.getElementById('collectedBy'); if (cb){ cb.value = ''; cb.classList.remove('error'); cb.removeAttribute('aria-invalid'); }
  // Reset operator input + select to first option (fresh)
  operatorFilterBuffer='';
  const opInput = document.getElementById('operatorTypeInput'); if(opInput){ opInput.value=''; opInput.classList.remove('error'); opInput.removeAttribute('aria-invalid'); }
  const opSel = document.getElementById('collectionOperator');
  if(opSel){
    populateOperatorSelect(); // rebuild list (resets selection to first item internally)
    opSel.selectedIndex = 0;
  }
  // Remove previous validation messages inside confirm modal
  const confirmModal = document.getElementById('confirmCollectModal');
  if(confirmModal){ confirmModal.querySelectorAll('.field-error-msg').forEach(el=>el.remove()); }
  const order = collectionsActive.find(o=> String(o.id) === String(id));
  const custEl = document.getElementById('collectCustomerName');
  if (custEl) custEl.textContent = order ? `${order.customer} — ${order.reference}` : '—';
  // Build parcel summary (highlighted)
  if(order){
    const parts=[];
    if(order.cartons) parts.push(`${order.cartons} carton${order.cartons>1?'s':''}`);
    if(order.pallets) parts.push(`${order.pallets} pallet${order.pallets>1?'s':''}`);
    if(order.tubes) parts.push(`${order.tubes} tube${order.tubes>1?'s':''}`);
    const summary = parts.length? parts.join(' • ') : 'No parcels';
    // Inject or update parcel summary badge ABOVE operator controls
    let badge = document.getElementById('collectParcelSummary');
    const opSel = document.getElementById('collectionOperator');
    if(opSel && opSel.parentElement){
      const container = opSel.parentElement; // parent holds label + custom controls
      if(!badge){
        badge = document.createElement('div');
        badge.id='collectParcelSummary';
        badge.style.fontWeight='800';
        badge.style.fontSize = '0.85rem';
        badge.style.marginTop='4px';
        badge.style.marginBottom='4px';
        badge.style.color='#1e293b';
        badge.style.background='#fffbe6';
        badge.style.border='1px solid #facc15';
        badge.style.padding='6px 10px';
        badge.style.borderRadius='8px';
        badge.style.boxShadow='0 1px 2px rgba(0,0,0,.06)';
        // Insert before the first element related to operator (label or wrapper)
        const firstChild = container.firstElementChild;
        container.insertBefore(badge, firstChild);
      } else {
        // Ensure it's before operator controls if moved previously
        if(badge.nextElementSibling && badge.nextElementSibling.id !== 'operatorTypeInput' && badge.nextElementSibling.id !== 'operatorListButton'){
          container.insertBefore(badge, container.firstElementChild);
        }
      }
      badge.textContent = `Collecting: ${summary}`;
    }
  }
  // Reset signature
  signature.enabled=false; signature.dataUrl=null; signature.drawing=false;
  const wrap = document.getElementById('signaturePadWrap'); if(wrap) wrap.classList.add('hidden');
  const canvas = document.getElementById('signatureCanvas'); if(canvas){ const ctx=canvas.getContext('2d'); resizeSignatureCanvas(); ctx.clearRect(0,0,canvas.width,canvas.height); }
  document.getElementById('confirmCollectModal').classList.remove('hidden');
}
function closeConfirmCollectModal(){ document.getElementById('confirmCollectModal').classList.add('hidden'); pendingCollectId=null; }
async function submitCollection(){
  // Use explicit confirm button (avoid capturing operator 'Select' button)
  const btn = document.getElementById('confirmCollectionBtn');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Confirming…'; }
    const collectedBy = sanitizeText(document.getElementById('collectedBy').value, 80);
  // Operator selection: prefer typed value (input overlay) else select value
  const operatorInput = document.getElementById('operatorTypeInput');
  const operatorRaw = operatorInput ? sanitizeText(operatorInput.value, 80) : '';
  const selectVal = document.getElementById('collectionOperator').value;
  const operator = operatorRaw || selectVal;
    // Validate operator with case-insensitive match and normalize to canonical casing
    const validList = operatorNames.length ? operatorNames : operators;
    const match = (operator || '').trim() ? validList.find(n => n.toLowerCase() === operator.toLowerCase()) : '';
    if (!match){
      toast('Select a valid operator','error');
      return;
    }
    const operatorFinal = match; // use canonical capitalization from the list
    const date=document.getElementById('collectionDate').value;
    const time=document.getElementById('collectionTime').value;
    // Reset invalid state
    ['collectedBy','collectionDate','collectionTime'].forEach(id=>{ const el=document.getElementById(id); if(el){ el.classList.remove('error'); el.removeAttribute('aria-invalid'); }});
    let miss=[];
    if(!collectedBy) miss.push('Collected by');
    if(!operator) miss.push('Operator');
    if(!date) miss.push('Date');
    if(!time) miss.push('Time');
    if(!pendingCollectId || miss.length){
      ['collectedBy','collectionDate','collectionTime'].forEach(id=>{ const el=document.getElementById(id); if(el && !el.value){
        el.classList.add('error'); el.setAttribute('aria-invalid','true');
        if(!el.dataset.phOrig){ el.dataset.phOrig = el.getAttribute('placeholder')||''; }
        el.setAttribute('placeholder','Required');
        if(!el.nextElementSibling || !el.nextElementSibling.classList.contains('field-error-msg')){
          const msg=document.createElement('div');
          msg.className='field-error-msg';
          msg.setAttribute('role','alert');
          msg.textContent='This field is required';
          msg.style.color = '#dc2626';
          msg.style.fontWeight = '600';
          el.parentElement.appendChild(msg);
        }
        if(!el.dataset._bindRequiredRestore){
          el.addEventListener('input', ()=>{
            if(el.value.trim()){
              el.classList.remove('error'); el.removeAttribute('aria-invalid');
              if(el.dataset.phOrig!==undefined){ el.setAttribute('placeholder', el.dataset.phOrig); }
              const next=el.nextElementSibling; if(next && next.classList.contains('field-error-msg')) next.remove();
            }
          });
          el.dataset._bindRequiredRestore='1';
        }
      }});
      if(!pendingCollectId) miss.unshift('Internal order id');
      toast('Missing: '+miss.join(', '),'error');
      return;
    }
    const idx = collectionsActive.findIndex(o => String(o.id) === String(pendingCollectId));
    if(idx===-1){ toast('Order not found','error'); return; }
    const order = collectionsActive[idx];
    if (!dbIsEnabled()){
      toast('Database unavailable','error'); return;
    }
    // Remove prefix para reduzir tamanho armazenado
    const sigPayload = signature.dataUrl
      ? signature.dataUrl.replace(/^data:image\/png;base64,/, '')
      : null;

    const iso = new Date(`${date}T${time}:00`).toISOString();
    const res = await window.supabaseCollections.confirm(
      order.id, collectedBy, operatorFinal, iso, sigPayload, order.invoice, order.salesRep
    );

    if (!res.success){
      handleDbError('confirm', res.error);
      toast('Confirm failed','error');
      return; // mantém pedido na lista
    }

    collectionsActive.splice(idx,1);
    toast('Confirmed','success');
    renderCollections();
    closeConfirmCollectModal();
  } catch (e){
    reportError('confirm', e);
    toast(`Unexpected error: ${e.message || e}`,'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
  }
}

function messageOrder(id){
  const o = collectionsActive.find(x => String(x.id) === String(id));
  if(!o){ toast('Order not found','error'); return; }
  const modal = document.getElementById('messageModal');
  const body = document.getElementById('messageModalBody');
  if(!modal || !body){ toast('Modal missing','error'); return; }
  body.innerHTML = `
    <div><strong>Customer:</strong> ${escapeHtml(o.customer||'')}</div>
    <div><strong>Reference:</strong> ${escapeHtml(o.reference||'')}</div>
    <div><strong>Invoice:</strong> ${escapeHtml(o.invoice||'')}</div>
    <div><strong>Sales Rep:</strong> ${escapeHtml(o.salesRep||'')}</div>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0" />
    <div><strong>Contact name:</strong> ${escapeHtml(o.contactName||'')}</div>
    <div><strong>Contact number:</strong> ${escapeHtml(o.contactNumber||'')}</div>
    <div><strong>Email:</strong> ${escapeHtml(o.email||'')}</div>
    <div><strong>Date:</strong> ${escapeHtml(formatShort(o.date)||'')}</div>
  `;
  modal.classList.remove('hidden');
}

function closeMessageModal(){ const m=document.getElementById('messageModal'); if(m) m.classList.add('hidden'); }

function escapeHtml(str){
  return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ================= Operator Select Helpers (type-ahead filter) =================
function populateOperatorSelect(prefix){
  const opSel = document.getElementById('collectionOperator');
  if(!opSel) return;
  const fullList = operatorNames.length ? operatorNames : operators;
  let list = fullList;
  if(prefix && prefix.length >= 2){
    const p = prefix.toLowerCase();
    list = fullList.filter(n=> n.toLowerCase().startsWith(p));
    if(!list.length) list = fullList; // if no matches, show all again
  }
  const current = opSel.value;
  opSel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    opSel.appendChild(opt);
  });
  // Reselect previous if still present else first
  if(current && list.includes(current)) opSel.value = current; else if(list.length) opSel.value = list[0];
}

function bindOperatorTypeAhead(){
  const opSel = document.getElementById('collectionOperator');
  if(!opSel) return;
  opSel.addEventListener('keydown', e => {
    // Letters / Backspace only
    if(e.key === 'Backspace'){
      operatorFilterBuffer = operatorFilterBuffer.slice(0,-1);
      populateOperatorSelect(operatorFilterBuffer);
      return;
    }
    if(e.key === 'Escape'){
      operatorFilterBuffer='';
      populateOperatorSelect();
      return;
    }
    if(e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey){
      operatorFilterBuffer += e.key;
      populateOperatorSelect(operatorFilterBuffer);
      if(operatorFilterTimer) clearTimeout(operatorFilterTimer);
      operatorFilterTimer = setTimeout(()=>{ operatorFilterBuffer=''; }, 1800);
    }
  });
}

function enhanceOperatorSelect(){
  if (operatorInputInitialized) return;
  const sel = document.getElementById('collectionOperator');
  if(!sel) return;
  const parent = sel.parentElement; if(!parent) return;
  parent.style.position = parent.style.position || 'relative';
  // Hide original select but keep it for fallback/validation
  sel.style.display='none';
  const labelEl = parent.querySelector('label[for="collectionOperator"]');
  if(!labelEl){
    const newLabel = document.createElement('label');
    newLabel.htmlFor='collectionOperator';
    newLabel.textContent='Operator';
    parent.insertBefore(newLabel, sel);
  }
  // Outer wrap for input + button
  const outer = document.createElement('div');
  outer.style.position='relative';
  outer.style.width='50%';
  outer.style.minWidth='260px';
  outer.style.marginTop='4px';
  parent.insertBefore(outer, sel);

  const row = document.createElement('div');
  row.style.display='flex';
  row.style.gap='6px';
  outer.appendChild(row);

  const input = document.createElement('input');
  input.type='text';
  input.id='operatorTypeInput';
  input.autocomplete='off';
  input.spellcheck=false;
  input.placeholder='Type';
  Object.assign(input.style,{
    flex:'1',
    height:'44px',
    border:'1px solid var(--border,#cbd5e1)',
    borderRadius:'8px',
    padding:'0 12px',
    fontSize:'0.9rem',
    boxSizing:'border-box'
  });
  row.appendChild(input);

  const btn = document.createElement('button');
  btn.type='button';
  btn.id='operatorListButton';
  btn.textContent='Select'; // Static label; we will not change this after picking an operator
  btn.className='search-btn-small';
  Object.assign(btn.style,{
    flex:'0 0 120px',
    height:'44px',
    display:'flex',
    alignItems:'center',
    justifyContent:'center',
    fontSize:'0.85rem'
  });
  row.appendChild(btn);

  // Suggestion panel (absolute under outer)
  const sug = document.createElement('div');
  Object.assign(sug.style,{
    position:'absolute', left:'0', top:'52px',
    width:'100%', background:'#fff',
    border:'1px solid var(--border, #cbd5e1)', borderRadius:'8px', boxShadow:'0 4px 12px rgba(0,0,0,0.08)',
    padding:'4px 0', maxHeight:'220px', overflowY:'auto', zIndex:'40', display:'none'
  });
  outer.appendChild(sug);

  function relocateSug(){
    // In case layout shifts, keep positioned right below
    sug.style.top = (row.getBoundingClientRect().height + 8) + 'px';
  }
  window.addEventListener('resize', relocateSug);
  setTimeout(relocateSug,0);

  function closeSuggestions(){ sug.style.display='none'; }
  function openSuggestions(){
    // Ensure the dropdown is positioned just below the input row, even if the modal was previously hidden
    relocateSug();
    sug.style.display='block';
  }
  function buildList(filter, forceAll){
    const list = (operatorNames.length?operatorNames:operators);
    let matches = list;
    if(forceAll){ matches = list; }
    else if(filter && filter.length>=2){
      const f=filter.toLowerCase(); matches = list.filter(n=> n.toLowerCase().startsWith(f));
    } else if(filter){ closeSuggestions(); return; } else { closeSuggestions(); return; }
    if(!matches.length){ closeSuggestions(); return; }
  sug.setAttribute('role','listbox');
  sug.innerHTML = matches.map(n=>`<div class="op-sug-item" role="option" tabindex="0" aria-selected="false" data-name="${n}" style="padding:6px 10px;cursor:pointer;font-size:0.85rem;">${n}</div>`).join('');
    openSuggestions();
  }

  input.addEventListener('input', ()=>{
    const val=input.value.trim();
    if(val.length>=2){ buildList(val,false); } else { closeSuggestions(); }
    const list = operatorNames.length?operatorNames:operators;
    if(list.includes(val)) sel.value=val;
  });
  input.addEventListener('focus', ()=>{ const v=input.value.trim(); if(v.length>=2) buildList(v,false); });
  // Toggle full list on button click
  btn.addEventListener('click', ()=>{
    if (sug.style.display === 'block'){
      closeSuggestions();
      input.focus();
    } else {
      buildList('', true);
      input.focus();
    }
  });
  input.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ closeSuggestions(); return; }
    if(e.key==='Enter'){
      const val=input.value.trim(); const list=operatorNames.length?operatorNames:operators;
      if(list.includes(val)){ sel.value=val; closeSuggestions(); } else { toast('Select a valid operator','error'); }
      e.preventDefault();
    }
    if(e.key==='ArrowDown'){
      const first=sug.querySelector('.op-sug-item'); if(first){ first.focus(); e.preventDefault(); }
    }
  });
  sug.addEventListener('mousedown', e=>{
    const item=e.target.closest('.op-sug-item'); if(item){
      const name=item.getAttribute('data-name');
      input.value=name; // show chosen operator in left field
      sel.value=name;
      // keep button label static 'Select'
      closeSuggestions(); e.preventDefault();
    }
  });
  // Keyboard navigation for accessibility (no visual change except focus outline)
  sug.addEventListener('keydown', e=>{
    const items = Array.from(sug.querySelectorAll('.op-sug-item'));
    if(!items.length) return;
    const current = document.activeElement.classList.contains('op-sug-item') ? document.activeElement : null;
    if(e.key==='ArrowDown'){
      e.preventDefault();
      if(!current){ items[0].focus(); return; }
      const idx = items.indexOf(current); const next = items[idx+1] || items[0]; next.focus();
    } else if(e.key==='ArrowUp'){
      e.preventDefault();
      if(!current){ items[items.length-1].focus(); return; }
      const idx = items.indexOf(current); const prev = items[idx-1] || items[items.length-1]; prev.focus();
    } else if(e.key==='Enter'){
  if(current){ const name=current.getAttribute('data-name'); input.value=name; sel.value=name; closeSuggestions(); input.focus(); }
    } else if(e.key==='Escape'){
      closeSuggestions(); input.focus();
    }
  });

  // Removed previous arrow overlay; button now controls full list.

  // Close when clicking anywhere outside this control
  document.addEventListener('click', e=>{ if(!outer.contains(e.target)) closeSuggestions(); });
  operatorInputInitialized = true;
}

// Signature Pad
function toggleSignaturePad(){
  const wrap = document.getElementById('signaturePadWrap');
  if(!wrap) return;
  signature.enabled = !wrap.classList.contains('hidden');
  // Actually toggle visually
  if (wrap.classList.contains('hidden')){
    wrap.classList.remove('hidden');
    resizeSignatureCanvas();
    bindSignatureEvents();
  } else {
    wrap.classList.add('hidden');
  }
}
function resizeSignatureCanvas(){
  const canvas = document.getElementById('signatureCanvas');
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#0f172a';
}
function bindSignatureEvents(){
  const canvas = document.getElementById('signatureCanvas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const getPos = (e)=>{
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const start = (e)=>{ e.preventDefault(); signature.drawing=true; const p=getPos(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); };
  const move = (e)=>{ if(!signature.drawing) return; const p=getPos(e); ctx.lineTo(p.x,p.y); ctx.stroke(); };
  const end = ()=>{ signature.drawing=false; try { signature.dataUrl = canvas.toDataURL('image/png'); } catch(e){} };
  canvas.onmousedown = start; canvas.onmousemove = move; window.onmouseup = end;
  canvas.ontouchstart = start; canvas.ontouchmove = move; window.ontouchend = end;
}
function clearSignature(){
  const canvas = document.getElementById('signatureCanvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  signature.dataUrl = null;
}

// Self-test harness (opt-in via ?selftest=1)
async function maybeRunSelfTest(){
  const params = new URLSearchParams(location.search);
  if (params.get('selftest') !== '1') return;
  const panel = document.getElementById('selfTestPanel'); if (!panel) return;
  const log = (msg)=>{ panel.classList.remove('hidden'); panel.innerHTML += `<div>${msg}</div>`; };
  // Controls
  panel.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <strong>Self-test</strong>
    <span style="margin-left:8px;font-size:12px;opacity:.8">DB-only mode</span>
  </div>`;
  log('Running self-test...');
  // Wait for Supabase to be ready if the loader is present
  try {
    if (window.supabaseReady) { await window.supabaseReady; }
  } catch(e){}
  if (!window.supabase || !window.supabaseCollections){ log('Supabase client not loaded.'); return; }
  try {
    const list1 = await window.supabaseCollections.listActive();
    log('listActive: ' + (list1.success ? `OK (${(list1.data||[]).length})` : `ERR: ${list1.error}`));
    const created = await window.supabaseCollections.create({
      customer:'SelfTest Co', reference:'ST-'+Date.now(), cartons:1, pallets:0,
      contactName:'Tester', contactNumber:'000', email:null, date: new Date().toISOString().slice(0,10)
    });
    log('create: ' + (created.success ? 'OK' : `ERR: ${created.error}`));
    if (created.success){
      const id = created.data.id;
      const upd = await window.supabaseCollections.update(id, { pallets:1 });
      log('update: ' + (upd.success ? 'OK' : `ERR: ${upd.error}`));
      const conf = await window.supabaseCollections.confirm(id, 'Self Tester', 'Operator A', new Date().toISOString(), null);
      log('confirm: ' + (conf.success ? 'OK' : `ERR: ${conf.error}`));
      const listH = await window.supabaseCollections.listHistory(5);
      log('listHistory: ' + (listH.success ? `OK (${(listH.data||[]).length})` : `ERR: ${listH.error}`));
    }
  } catch (e){ log('EXC: ' + e.message); }
}
