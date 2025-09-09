(function(){
  let fullHistory = [];
  let currentPage = 1;
  const PAGE_SIZE = 50;
  let lastFiltered = [];

  function formatDT(dt){
    try{ const d=new Date(dt); return d.toLocaleString(); } catch { return dt||''; }
  }

  function setMsg(msg){
    const tb=document.getElementById('historyTbody');
    if(tb) tb.innerHTML = `<tr><td colspan="12" style="text-align:center;opacity:.6">${msg}</td></tr>`;
  }

  function normalize(rows){
    return (rows||[]).map(r=>({
      id: r.id,
      customer: r.customer,
      reference: r.reference,
      cartons: r.cartons,
      pallets: r.pallets,
      tubes: r.tubes,
      contactName: r.contact_name,
      contactNumber: r.contact_number,
      email: r.email,
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
        r.customer,r.reference,r.contactName,r.contactNumber,r.collectedBy,r.id
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

  function render(rows){
    const tbody=document.getElementById('historyTbody');
    if(!tbody) return;
    if(!rows.length){
      tbody.innerHTML='<tr><td colspan="12" style="text-align:center;opacity:.6">No history</td></tr>';
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
      let sig = o.signature;
      if(sig && !sig.startsWith('data:image')) sig='data:image/png;base64,'+sig;
      const sigCell = sig ? `<img class="sig-thumb" src="${sig}" alt="signature" style="height:28px;max-width:140px;object-fit:contain;border:1px solid #e2e8f0;border-radius:6px;background:#fff"/>` : '<span style="opacity:.5">—</span>';
      const highlight = q && [o.customer,o.reference,o.contactName,o.contactNumber,o.collectedBy,o.id].some(v => (v||'').toString().toLowerCase().includes(q));
      return `<tr>
        <td${highlight?' style="background:#fffbe6"':''}>${o.customer||''}</td>
        <td>${o.reference||''}</td>
        <td>${o.cartons||0}</td>
        <td>${o.pallets||0}</td>
        <td>${o.tubes||0}</td>
        <td>${o.contactName||''}</td>
        <td>${o.contactNumber||''}</td>
        <td>${o.email||''}</td>
        <td>${o.collectedBy||''}</td>
        <td>${o.operator||''}</td>
        <td>${o.collectedAt?formatDT(o.collectedAt):''}</td>
        <td>${sigCell}</td>
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
      if(tbody && q){ tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;opacity:.6">Order not found</td></tr>'; updatePaginationControls(0); return; }
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

  document.addEventListener('click', e=>{
    if(e.target.classList?.contains('sig-thumb')){
      const src = e.target.src;
      const modal = document.getElementById('signatureModal');
      const img = document.getElementById('signatureModalImg');
      if(modal && img){ img.src = src; modal.classList.remove('hidden'); }
    }
  });

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
