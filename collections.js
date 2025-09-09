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
  const todayStr = new Date().toISOString().slice(0,10);
  const orderDate = document.getElementById('orderDate'); if (orderDate) orderDate.value = todayStr;
  const cDate = document.getElementById('collectionDate'); if (cDate) cDate.value = todayStr;
  const cTime = document.getElementById('collectionTime'); if (cTime) cTime.value = new Date().toTimeString().slice(0,5);
  try {
    if (dbIsEnabled()){
      const res = await window.supabaseCollections.listActive();
      if (res.success){
        collectionsActive = (res.data || []).map(mapDbToUi);
      } else {
        console.error('Supabase listActive error:', res.error);
        handleDbError('listActive', res.error);
      }
    } else {
      toast('Database not initialised','error');
    }
  } catch(e){ reportError('init:listActive', e); }
  renderCollections();
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
  const addModal = document.getElementById('addOrderModal');
  // Ensure placeholder present immediately (in case JS execution later fails)
  const wrap = document.getElementById('parcelDraftList');
  if(wrap){ wrap.innerHTML = 'No parcels added yet.'; wrap.classList.add('field-error-msg'); wrap.style.color = '#dc2626'; }
  // Clear input fields
  if(addModal){
    addModal.querySelectorAll('input').forEach(inp=>{
      if(inp.id !== 'orderDate') inp.value='';
      inp.classList.remove('error');
      inp.removeAttribute('aria-invalid');
      if(inp.dataset && inp.dataset.phOrig){ inp.setAttribute('placeholder', inp.dataset.phOrig); }
    });
    addModal.querySelectorAll('.field-error-msg').forEach(el=>{
      // keep the parcelDraftList message; remove only those next to inputs
      if(el.id !== 'parcelDraftList') el.remove();
    });
  }
  const today = new Date().toISOString().slice(0,10);
  const dateEl = document.getElementById('orderDate'); if (dateEl) dateEl.value = today;
  // Re-render parcel UI after a tick (ensures DOM ready)
  setTimeout(()=>{ try { updateParcelDraftUI(); } catch(e){ console.error('[AddOrder] updateParcelDraftUI after open failed', e); } }, 0);
}
function closeAddOrderModal(){ document.getElementById('addOrderModal').classList.add('hidden'); }

function showModal(id){ const el=document.getElementById(id); if(el) el.classList.remove('hidden'); }
function hideModal(id){ const el=document.getElementById(id); if(el) el.classList.add('hidden'); }

function addParcelToDraft(){
  console.log('[AddOrder] addParcelToDraft click');
  const type = document.getElementById('parcelType').value;
  const qty = parseInt(document.getElementById('parcelQty').value||'0',10);
  if(!qty||qty<1){ toast('Enter a valid quantity','error'); return; }
  draftParcels.push({type,qty});
  console.log('[AddOrder] parcels now:', draftParcels);
  document.getElementById('parcelQty').value='';
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

// Save & immediately print labels based on total parcels (cartons + pallets + tubes)
async function confirmAddOrderAndPrint(){
  await confirmAddOrderInternal(true);
}

// Extract shared logic so we can branch for print
async function confirmAddOrderInternal(shouldPrint){
  // Sanitize textual fields (no layout/UI change)
  const customer = sanitizeText(document.getElementById('orderCustomer').value, 80);
  const reference = sanitizeText(document.getElementById('orderReference').value, 80);
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
    contactName, contactNumber, email, date
  });
  if(!createRes.success){
    handleDbError('create', createRes.error);
    toast('Create failed','error');
    return;
  }
  const order = mapDbToUi(createRes.data);
  collectionsActive.unshift(order);
  toast('Order added','success');
  closeAddOrderModal();
  renderCollections();
  ['orderCustomer','orderReference','orderContactName','orderContactNumber','orderEmail']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
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
        <div class="info-line"><span class="section-label">CONTACT:</span><span>${safe(order.contactName)}${order.contactNumber?` - ${safe(order.contactNumber)}`:''}</span></div>
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
    .filter(o=>{ if(!q) return true; return [o.customer,o.reference,o.contactName,o.email,o.id].some(v=>(v||'').toLowerCase().includes(q)); });
  const tbody=document.getElementById('collectionsTbody');
  if (!tbody) return;
  if (rows.length === 0){
    if(q){ tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;opacity:.7">Order not found</td></tr>'; }
    else { tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;opacity:.7">No data</td></tr>'; }
    return;
  }
  tbody.innerHTML = rows.map(o=>{
    const highlight = q && [o.customer,o.reference,o.contactName,o.email,o.id].some(v => (v||'').toLowerCase().includes(q));
    const hlAttr = highlight ? ' style="background:#fffbe6"' : '';
    return `<tr>
      <td${hlAttr}>${o.customer}</td>
      <td>${o.reference}</td>
      <td>${o.cartons||0}</td>
      <td>${o.pallets||0}</td>
      <td>${o.tubes||0}</td>
      <td>${o.contactName}</td>
      <td>${o.contactNumber}</td>
      <td>${o.email||''}</td>
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
  ['Customer','Reference','ContactName','ContactNumber','Email'].forEach(k=>{
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
  document.getElementById('collectionDate').value=today.toISOString().slice(0,10);
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
    // Validate operator must exist in loaded list (or fallback if DB not loaded yet)
    const validList = operatorNames.length ? operatorNames : operators;
    if (!validList.includes(operator)){
      toast('Select a valid operator','error');
      return;
    }
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
      order.id, collectedBy, operator, iso, sigPayload
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
  toast('Message action coming soon','warn');
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
  function openSuggestions(){ sug.style.display='block'; }
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
  btn.addEventListener('click', ()=>{ buildList('', true); input.focus(); });
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

  document.addEventListener('click', e=>{ if(!parent.contains(e.target)) closeSuggestions(); });
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
