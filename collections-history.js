(function(){
  let fullHistory = [];
  let currentPage = 1;
  const PAGE_SIZE = 30;
  let lastFiltered = [];

  function formatDT(dt){
    try{ const d=new Date(dt); return d.toLocaleString(); } catch { return dt||''; }
  }

  function setMsg(msg){
    const tb=document.getElementById('historyTbody');
    if(tb) tb.innerHTML = `<tr><td colspan="11" style="text-align:center;opacity:.6">${msg}</td></tr>`;
  }

  function normalize(rows){
    return (rows||[]).map(r=>({
      id: r.id,
      customer: r.customer,
      reference: r.reference,
      cartons: r.cartons,
      pallets: r.pallets,
      tubes: r.tubes,
      invoice: r.invoice || '',
      salesRep: r.sales_rep || '',
  _contactName: r.contact_name,
  _contactNumber: r.contact_number,
  _email: r.email,
      collectedBy: r.collected_by,
      operator: r.operator,
      collectedAt: r.collected_at,
      signature: r.signature || r.signature_data || null
    }));
  }

  function applyFilters(){
    let rows = [...fullHistory];
    const q = (document.getElementById('historySearch')?.value||'').trim().toLowerCase();
    const from = document.getElementById('historyFrom')?.value || '';
    const to = document.getElementById('historyTo')?.value || '';

    // Date range filtering + 60 day validation
    if(from){
      const f=new Date(from);
      rows = rows.filter(r=> new Date(r.collectedAt) >= f);
    }
    if(to){
      const t=new Date(to); t.setHours(23,59,59,999);
      rows = rows.filter(r=> new Date(r.collectedAt) <= t);
    }
    if(from && to){
      const diffDays = (new Date(to)-new Date(from))/(1000*60*60*24);
      const notice=document.getElementById('historyNotice');
      if(diffDays > 60){
        if(notice){ notice.textContent='Range exceeds 60 days. Please adjust.'; notice.style.color='#b91c1c'; }
        return [];
      } else if(notice){
        notice.textContent='History stored for up to 2 years. Date range filter limited to 60 days.';
        notice.style.color='';
      }
    }

    if(q){
      rows = rows.filter(r=>[
        r.customer,r.reference,r.invoice,r.salesRep,r._contactName,r._contactNumber,r._email,r.collectedBy,r.id
      ].some(v => (v||'').toString().toLowerCase().includes(q)));
    }

    rows.sort((a,b)=> new Date(b.collectedAt||0) - new Date(a.collectedAt||0));
    lastFiltered = rows;
    return rows;
  }

  function updatePaginationControls(total){
    const info = document.getElementById('histPageInfo');
    const prev = document.getElementById('histPrevPage');
    const next = document.getElementById('histNextPage');
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if(currentPage > totalPages) currentPage = totalPages;
    if(info) info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${currentPage} / ${totalPages}`;
    if(prev) prev.dataset.disabled = currentPage <= 1 ? '1':'0';
    if(next) next.dataset.disabled = currentPage >= totalPages ? '1':'0';
    // Optional visual (no design overhaul): light opacity when disabled
    [prev,next].forEach(btn=>{ if(!btn) return; if(btn.dataset.disabled==='1'){ btn.style.opacity='.45'; btn.style.pointerEvents='none'; } else { btn.style.opacity='1'; btn.style.pointerEvents='auto'; } });
  }

  function cleanSignature(sig){
    if(!sig) return null;
    try{
      // If object serialized as JSON with { dataUrl: '...' }
      if(typeof sig === 'string' && sig.trim().startsWith('{')){
        const obj = JSON.parse(sig);
        if(obj && typeof obj.dataUrl === 'string') sig = obj.dataUrl;
      }
    } catch(e){}
    if(typeof sig !== 'string') return null;
    const s = sig.trim();
    if(!s) return null;
    if(s.startsWith('data:image')) return s;
    // Accept plain base64 PNG, or already full https URL
    if(/^https?:\/\//i.test(s)) return s;
    // If it looks base64-ish, prefix as PNG
    if(/^[A-Za-z0-9+/=]+$/.test(s)) return 'data:image/png;base64,'+s;
    return null;
  }

  function render(rows){
    const tbody=document.getElementById('historyTbody');
    if(!tbody) return;
    if(!rows.length){
      tbody.innerHTML='<tr><td colspan="11" style="text-align:center;opacity:.6">No history</td></tr>';
      updatePaginationControls(0);
      return;
    }
    // Pagination slice
    const total = rows.length;
    const start = (currentPage-1)*PAGE_SIZE;
    const pageRows = rows.slice(start, start+PAGE_SIZE);
    updatePaginationControls(total);

    const q = (document.getElementById('historySearch')?.value||'').trim().toLowerCase();
    tbody.innerHTML = pageRows.map(o=>{
      const sig = cleanSignature(o.signature);
      const sigCell = sig
        ? `<img class="sig-thumb" src="${sig}" alt="signature" style="height:28px;max-width:140px;object-fit:contain;border:1px solid #e2e8f0;border-radius:6px;background:#fff"/>`
        : '<span style="opacity:.5">—</span>';
      const highlight = q && [o.customer,o.reference,o.invoice,o.salesRep,o._contactName,o._contactNumber,o._email,o.collectedBy,o.id].some(v => (v||'').toString().toLowerCase().includes(q));
      return `<tr>
        <td${highlight?' style="background:#fffbe6"':''}>${o.customer||''}</td>
        <td>${o.reference||''}</td>
  <td class="col-small-num">${o.cartons||0}</td>
  <td class="col-small-num">${o.pallets||0}</td>
  <td class="col-small-num">${o.tubes||0}</td>
        <td>${o.invoice||''}</td>
        <td>${o.salesRep||''}</td>
        <td>${o.collectedBy||''}</td>
        <td>${o.operator||''}</td>
        <td>${o.collectedAt?formatDT(o.collectedAt):''}</td>
  <td>${sigCell}${(o._contactName||o._contactNumber||o._email)?`, <button type="button" class="btn-mini" style="vertical-align:middle" title="Detalhes" onclick="openHistoryMessage('${o.id}')">💬</button>`:''}</td>
      </tr>`;}).join('');
  }

  async function loadHistory(){
    if(!window.supabaseCollections){ setMsg('Supabase not ready'); return; }
    setMsg('Loading…');
    try{
      const res = await supabaseCollections.listHistory(500);
      console.log('[history] fetched:', res);
      if(!res.success){ setMsg('Load error'); return; }
      fullHistory = normalize(res.data);
      render(applyFilters());
    }catch(e){
      console.error('[history] error', e); setMsg('Unexpected error');
    }
  }

  function runFilter(){
    currentPage = 1;
    const rows = applyFilters();
    if(rows.length === 0){
      const q = (document.getElementById('historySearch')?.value||'').trim();
      const tbody=document.getElementById('historyTbody');
  if(tbody && q){ tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;opacity:.6">Order not found</td></tr>'; updatePaginationControls(0); return; }
    }
    render(rows);
  }

  function resetFilters(){
    const searchEl = document.getElementById('historySearch'); if(searchEl) searchEl.value='';
    const fromEl = document.getElementById('historyFrom'); if(fromEl) fromEl.value='';
    const toEl = document.getElementById('historyTo'); if(toEl) toEl.value='';
    const notice=document.getElementById('historyNotice'); if(notice){ notice.textContent='History stored for up to 2 years. Range limit 60 days.'; notice.style.color=''; }
    currentPage = 1;
    const rows = applyFilters();
    render(rows);
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    loadHistory();
    document.getElementById('historyApplyBtn')?.addEventListener('click', runFilter);
    document.getElementById('historySearch')?.addEventListener('keydown', e=>{ if(e.key==='Enter') runFilter(); });
  document.getElementById('histPrevPage')?.addEventListener('click', ()=>{ if(currentPage>1){ currentPage--; render(lastFiltered.length?lastFiltered:applyFilters()); }});
  document.getElementById('histNextPage')?.addEventListener('click', ()=>{ const total=lastFiltered.length; const max=Math.max(1, Math.ceil(total/PAGE_SIZE)); if(currentPage<max){ currentPage++; render(lastFiltered); }});
  document.getElementById('historyResetBtn')?.addEventListener('click', resetFilters);
  });

  function openSignatureFromSrc(src){
    if(!src) return;
    const modal = document.getElementById('signatureModal');
    const img = document.getElementById('signatureModalImg');
    if(modal && img){ img.src = src; modal.classList.remove('hidden'); }
  }
  document.addEventListener('click', e=>{
    if(e.target.classList?.contains('sig-thumb')){
      openSignatureFromSrc(e.target.src);
    }
  });
  document.addEventListener('keydown', e=>{
    if((e.key==='Enter' || e.key===' ') && e.target.classList?.contains('sig-thumb')){
      e.preventDefault();
      openSignatureFromSrc(e.target.src);
    }
  });

  window.openHistoryMessage = function(id){
    const row = fullHistory.find(r=>String(r.id)===String(id));
    if(!row) return;
    const modal = document.getElementById('historyMessageModal');
    const body = document.getElementById('historyMessageBody');
    if(!modal || !body) return;
    body.innerHTML = `
      <div><strong>Customer:</strong> ${escapeHtml(row.customer||'')}</div>
      <div><strong>Reference:</strong> ${escapeHtml(row.reference||'')}</div>
      <div><strong>Invoice:</strong> ${escapeHtml(row.invoice||'')}</div>
      <div><strong>Sales Rep:</strong> ${escapeHtml(row.salesRep||'')}</div>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:6px 0" />
      <div><strong>Contact name:</strong> ${escapeHtml(row._contactName||'')}</div>
      <div><strong>Contact number:</strong> ${escapeHtml(row._contactNumber||'')}</div>
      <div><strong>Email:</strong> ${escapeHtml(row._email||'')}</div>
      <div><strong>Date:</strong> ${escapeHtml(row.collectedAt?formatDT(row.collectedAt):'')}</div>
    `;
    modal.classList.remove('hidden');
  };
  window.closeHistoryMessageModal = function(){ const m=document.getElementById('historyMessageModal'); if(m) m.classList.add('hidden'); };
  function escapeHtml(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

  // Realtime updates on new history rows
  (function initRealtime(){
    if(window.supabase && !window.historyRealtimeChannel){
      window.historyRealtimeChannel = supabase
        .channel('realtime:collections_history')
        .on('postgres_changes',{event:'INSERT',schema:'public',table:'collections_history'}, ()=> loadHistory())
        .subscribe();
    }
  })();

  // Debug helpers
  window.reloadHistory = loadHistory;
  window.filterHistory = runFilter;
  window.resetHistoryFilters = resetFilters;
  window.closeSignatureModal = function(){ const m=document.getElementById('signatureModal'); if(m) m.classList.add('hidden'); };
})();
