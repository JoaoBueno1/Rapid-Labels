// restock.js
// Purpose: Load data from Supabase view `restock_view` and render it into the table in restock.html.
// Scope: Only used by restock.html. No changes to other pages or global behaviors.

(function () {
  // Tiny debounce to avoid flooding queries while typing
  function debounce(fn, delay) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), delay);
    };
  }

  const state = {
    q: '',
    loading: false,
  rows: [],
  allRows: [], // annotated rows with __reserve_total
    statusFilter: 'ALL', // ALL | LOW | MEDIUM | FULL | OVER
    hideNoReserve: false,
  onlyNeedsAdjustment: false, // new: show only rows where on_hand == 0 and reserve > 0
  page: 1,
  perPage: 30,
  };

  const tbody = document.getElementById('restockTbody');
  const input = document.getElementById('restockSearch');

  function setTbody(html) {
    if (!tbody) return;
    tbody.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function statusChip(status) {
    const s = String(status || '').toLowerCase();
    return `<span>${escapeHtml(s)}</span>`; // styled later by styleRestockStatuses
  }

  function formatReserveCell(extra) {
    const n = Number(extra);
    if (!Number.isFinite(n) || n <= 0) {
      return '<span class="reserve-none">No reserve</span>';
    }
    return escapeHtml(n);
  }

  function updatePager(total) {
    const prevBtn = document.getElementById('restockPrevPage');
    const nextBtn = document.getElementById('restockNextPage');
    const info = document.getElementById('restockPageInfo');
    if (!info) return;
    const totalPages = Math.max(1, Math.ceil(total / state.perPage));
    if (state.page > totalPages) state.page = totalPages;
    info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${state.page} / ${totalPages}`;
    const setBtnState = (btn, disabled) => {
      if (!btn) return;
      btn.dataset.disabled = disabled ? '1' : '0';
      btn.style.opacity = disabled ? '.45' : '1';
      btn.style.pointerEvents = disabled ? 'none' : 'auto';
    };
    setBtnState(prevBtn, state.page <= 1);
    setBtnState(nextBtn, state.page >= totalPages);
  }

  function render(rows) {
    if (!rows || rows.length === 0) {
      setTbody('<tr><td colspan="8" style="text-align:center;opacity:.7">No results</td></tr>');
      updatePager(0);
      // Apply styling hook if present
      if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
      return;
    }

  const start = (state.page - 1) * state.perPage;
    const limited = rows.slice(start, start + state.perPage);
    updatePager(rows.length);

    const chunks = [];
    for (let i = 0; i < limited.length; i += 30) {
      const slice = limited.slice(i, i + 30);
      const rowsHtml = slice.map((r) => {
        const sku = escapeHtml(r.sku);
        const product = escapeHtml(r.product);
        const pickface = escapeHtml(r.stock_locator);
  const onHand = r.on_hand ?? '';
        const capacity = r.pickface_space ?? '';
  const status = escapeHtml((r.__norm_status || r.status || 'configure').toLowerCase());
        const reserveQty = Number(r.__reserve_total ?? 0);
        const restock = r.restock_qty ?? '';
        return `
          <tr>
            <td>${sku}</td>
            <td>${product}</td>
            <td>${pickface}</td>
            <td>${onHand}</td>
            <td>${capacity}</td>
            <td>${statusChip(status)}</td>
            <td>${formatReserveCell(reserveQty)}</td>
            <td>${restock}</td>
          </tr>`;
      }).join('');
      chunks.push(rowsHtml);
      if (i + 30 < limited.length) {
        chunks.push('<tr class="print-break"><td colspan="8"></td></tr>');
      }
    }
    const html = chunks.join('');

    setTbody(html);
    if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
  }

  // Apply status filter only; other toggles handled separately
  function applyStatusFilter(rows) {
    let filtered = Array.isArray(rows) ? rows.slice() : [];
    if (state.statusFilter && state.statusFilter !== 'ALL') {
      filtered = filtered.filter(r => String((r.__norm_status || r.status || '')).toUpperCase() === state.statusFilter);
    }
    return filtered;
  }

  function stableSortByBusinessRules(rows) {
    const order = {
      LOW: 0,
      MEDIUM: 1,
      FULL: 2,
      OVER: 3,
      CONFIGURE: 4,
    };

    // Partition by status groups to maintain order and allow secondary sort without mixing groups
    const groups = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const r of rows) {
  const key = order[(r.__norm_status || r.status || '').toUpperCase()] ?? 2;
      groups[key].push(r);
    }

    // Within each group, move items with No reserve to the bottom of that group (but keep group ordering)
    const moveNoReserveDown = (arr) => {
      const withReserve = [];
      const noReserve = [];
      for (const r of arr) {
  const hasReserve = Number(r.__reserve_total || 0) > 0;
        (hasReserve ? withReserve : noReserve).push(r);
      }
      // Secondary sort by restock desc then SKU
      const sortInner = (a, b) => {
        const ra = Number.isFinite(a.restock_qty) ? a.restock_qty : -Infinity;
        const rb = Number.isFinite(b.restock_qty) ? b.restock_qty : -Infinity;
        if (rb !== ra) return rb - ra;
        return String(a.sku).localeCompare(String(b.sku));
      };
      withReserve.sort(sortInner);
      noReserve.sort(sortInner);
      return withReserve.concat(noReserve);
    };

    return []
      .concat(
        moveNoReserveDown(groups[0]),
        moveNoReserveDown(groups[1]),
        moveNoReserveDown(groups[2]),
        moveNoReserveDown(groups[3]),
        moveNoReserveDown(groups[4])
      );
  }

  async function computeReserveTotals(rows){
    try{
      await window.supabaseReady;
      const mapPick = {};
      const skuSet = new Set();
      for (const r of rows){
        if (!r || !r.sku) continue;
        if (!(r.sku in mapPick)) mapPick[r.sku] = r.stock_locator || '';
        skuSet.add(r.sku);
      }
      const skuList = Array.from(skuSet);
      if (skuList.length === 0) return {};
      const { data, error } = await window.supabase
        .from('restock_report')
        .select('sku, location, on_hand')
        .in('sku', skuList)
        .limit(10000);
      if (error) throw error;
      const totals = {};
      for (const rec of data || []){
        const sku = rec.sku;
        const loc = rec.location;
        const oh = Number(rec.on_hand) || 0;
        if (!sku || !Number.isFinite(oh)) continue;
        if (loc === mapPick[sku]) continue; // exclude pickface
        totals[sku] = (totals[sku] || 0) + oh;
      }
      return totals;
    } catch(e){
      console.warn('reserve totals error', e);
      return {};
    }
  }

  async function fetchData() {
    if (!window.supabase || !window.supabaseReady) {
      setTbody('<tr><td colspan="8" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>');
      return;
    }

    state.loading = true;
    setTbody('<tr><td colspan="8" style="text-align:center;opacity:.7">Loading…</td></tr>');

    try {
      await window.supabaseReady;

  // Base query
      // Join setup to compute thresholds client-side
      let qView = window.supabase
        .from('restock_view')
        .select('sku, product, stock_locator, on_hand, pickface_space, status, restock_qty');
      let qSetup = window.supabase
        .from('restock_setup')
        .select('sku, cap_min, cap_med, cap_max');

  const q = (state.q || '').trim();
      if (q) {
        // Case-insensitive partial match on common columns
        // Use ilike for text fields; allow searching numbers as text too
        const pattern = `%${q}%`;
        qView = qView.or(
          [
            `sku.ilike.${pattern}`,
            `product.ilike.${pattern}`,
            `stock_locator.ilike.${pattern}`,
          ].join(',')
        );
      }

  // Fetch view and setup in parallel
  const [{ data: viewRows, error: vErr }, { data: setupRows, error: sErr }] = await Promise.all([
        qView.limit(1000),
        qSetup.limit(10000)
      ]);
      if (vErr) throw vErr;
      if (sErr) throw sErr;

      let rows = Array.isArray(viewRows) ? viewRows.slice() : [];
      const setupBySku = Object.create(null);
      for (const s of setupRows || []){
        setupBySku[s.sku] = { min: Number(s.cap_min), med: Number(s.cap_med), max: Number(s.cap_max) };
      }
  // Compute normalized status based on thresholds for all rows
  for (const r of rows){
        const t = setupBySku[r.sku];
        if (!t || !Number.isFinite(t.min) || !Number.isFinite(t.med) || !Number.isFinite(t.max)){
          r.__norm_status = 'CONFIGURE';
          continue;
        }
        const on = Number(r.on_hand) || 0;
        if (on < t.min) r.__norm_status = 'LOW';
        else if (on >= t.min && on < t.med) r.__norm_status = 'MEDIUM';
        else if (on >= t.med && on <= t.max) r.__norm_status = 'FULL';
        else if (on > t.max) r.__norm_status = 'OVER';
        else r.__norm_status = 'CONFIGURE';
      }
  // Compute reserve totals and annotate
  const reserveTotals = await computeReserveTotals(rows);
  rows.forEach(r => { r.__reserve_total = reserveTotals[r.sku] || 0; });
  // Save annotated rows
  state.allRows = rows.slice();
  // Apply current filters locally now
  let filtered = applyStatusFilter(rows);
  const arranged = stableSortByBusinessRules(filtered);
  let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
  if (state.onlyNeedsAdjustment) {
    visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
  }
  state.rows = visible;
  state.page = 1;
  render(visible);
    } catch (e) {
      console.error('restock fetch error', e);
      setTbody('<tr><td colspan="8" style="text-align:center;color:#b91c1c">Failed to load data</td></tr>');
    } finally {
      state.loading = false;
    }
  }

  // Expose search trigger for the button
  window.runRestockSearch = function runRestockSearch() {
    state.q = (input && input.value) || '';
    fetchData();
  };

  const onInput = debounce(() => {
    state.q = (input && input.value) || '';
    fetchData();
  }, 350);

  if (input) {
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.runRestockSearch();
      }
    });
  }

  // Initial load
  fetchData();
  // Restore Last report from localStorage (persists across reloads)
  try{
    const saved = localStorage.getItem('restock_last_report');
    if (saved) {
      const el = document.getElementById('lastReportStamp');
      if (el) el.textContent = `Last report: ${saved}`;
    }
  } catch {}

  // Pager controls
  window.restockPrevPage = function(){ if (state.page > 1) { state.page -= 1; render(state.rows); } };
  window.restockNextPage = function(){ const totalPages = Math.max(1, Math.ceil(state.rows.length / state.perPage)); if (state.page < totalPages) { state.page += 1; render(state.rows); } };

  // Expose filter controls for HTML buttons
  window.restockSetStatusFilter = function(val){
    state.statusFilter = String(val||'ALL').toUpperCase();
  // Rebuild view from annotated allRows
  state.page = 1;
  let rows = applyStatusFilter(state.allRows);
  const arranged = stableSortByBusinessRules(rows);
  let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
  if (state.onlyNeedsAdjustment) {
    visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
  }
  state.rows = visible;
  render(visible);
  };
  window.restockToggleHideNoReserve = function(flag){
    state.hideNoReserve = !!flag;
  state.page = 1;
  let rows = applyStatusFilter(state.allRows);
  const arranged = stableSortByBusinessRules(rows);
  let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
  if (state.onlyNeedsAdjustment) {
    visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
  }
  state.rows = visible;
  render(visible);
  };

  // Toggle for Only needs adjustment (on_hand == 0 and reserve > 0)
  window.restockToggleOnlyNeedsAdjustment = function(flag){
    state.onlyNeedsAdjustment = !!flag;
    // Reset to page 1 for clarity
    state.page = 1;
    let rows = applyStatusFilter(state.allRows);
    const arranged = stableSortByBusinessRules(rows);
    let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
    if (state.onlyNeedsAdjustment) {
      visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
    }
    state.rows = visible;
    render(visible);
  };

  // Import workflow
  const importFileInput = document.getElementById('importFile');
  const importSummary = document.getElementById('importSummary');
  const confirmImportBtn = document.getElementById('confirmImportBtn');
  const dropZone = document.getElementById('dropZone');
  const previewWrap = document.getElementById('importPreview');
  const previewBody = document.getElementById('importPreviewBody');
  let importOk = false;
  // Always replace existing data for Excel import

  function parseExcel(file){
    return new Promise((resolve, reject) => {
      try{
        const reader = new FileReader();
        reader.onload = (e) => {
          try{
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            resolve({ wb });
          } catch(err){ reject(err); }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
      } catch(err){ reject(err); }
    });
  }

  function mapCsvToRows(headers, rows){
    // Normalize headers for expected Excel fields
    const lowerHeaders = headers.map(h => String(h).toLowerCase());
    const find = (name) => lowerHeaders.indexOf(name);

    // New required headers per user: "Product additional attribute 1", "SKU", "Bin", "Main Warehouse"
    const idx = {
      prod_attr_1: find('product additional attribute 1'), // SKU 5 dígitos
      product_name: find('sku'), // product name column per user text
      bin: find('bin'), // location
      main_wh: find('main warehouse'), // on hand
    };
    if (idx.prod_attr_1<0 || idx.product_name<0 || idx.bin<0 || idx.main_wh<0){
      throw new Error('Excel must include headers: Product additional attribute 1, SKU, Bin, Main Warehouse');
    }
    const out = [];
    for (const r of rows){
      const skuRaw = r[idx.prod_attr_1];
      const prodRaw = r[idx.product_name];
      const binRaw = r[idx.bin];
      const whRaw = r[idx.main_wh];

      const sku = String(skuRaw ?? '').trim();
      const product = String(prodRaw ?? '').trim();
      const location = String(binRaw ?? '').trim();
      // Normalize number: handle comma/dot and spaces
      const norm = String(whRaw ?? '').replace(/\s/g, '').replace(/,/g, '.');
      const parsed = parseFloat(norm);
      if (!sku || !product || !location || !Number.isFinite(parsed)) {
        continue; // skip rows missing any value or invalid number
      }
      const onHand = Math.floor(parsed);
      out.push({ sku, product, location, on_hand: onHand });
    }
    return out;
  }

  function resetDropZoneDefault(){
    if (!dropZone) return;
    dropZone.style.borderColor = '#6366f1';
    dropZone.style.background = '#eef2ff';
    dropZone.dataset.state = '';
    dropZone.title = '';
    dropZone.innerHTML = '<span>Drop Excel or click here</span>';
  }

  function setDropZoneOk(fileName, rowsCount){
    if (!dropZone) return;
    dropZone.style.borderColor = '#16a34a';
    dropZone.style.background = '#ecfdf5';
    dropZone.dataset.state = 'ok';
    dropZone.title = 'File OK';
    const safe = (s)=> String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    dropZone.innerHTML = `<span style="color:#166534">✅ File OK: ${safe(fileName)} — ${rowsCount} rows</span>`;
  }

  function setDropZoneError(msg){
    if (!dropZone) return;
    dropZone.style.borderColor = '#dc2626';
    dropZone.style.background = '#fef2f2';
    dropZone.dataset.state = 'error';
    dropZone.title = msg || 'Invalid file';
    const safe = (s)=> String(s||'').replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
    dropZone.innerHTML = `<span style="color:#991b1b">❌ ${safe(msg||'Invalid file')}</span>`;
  }

  function loadSheet(wb, name, fileName){
    try{
      const ws = wb.Sheets[name];
      const json = XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
      const headers = (json[0]||[]).map(h=>String(h).toLowerCase());
      const rows = (json.slice(1)||[]).filter(r => Array.isArray(r) && r.some(v => String(v).trim().length));
      // Validate headers
      const idxCheck = {
        a: headers.indexOf('product additional attribute 1'),
        b: headers.indexOf('sku'),
        c: headers.indexOf('bin'),
        d: headers.indexOf('main warehouse'),
      };
      const headersOk = idxCheck.a>=0 && idxCheck.b>=0 && idxCheck.c>=0 && idxCheck.d>=0;
      const mapped = mapCsvToRows(headers, rows);
      const skipped = Math.max(0, rows.length - mapped.length);
      if (!headersOk){
        importSummary.textContent = 'File headers are invalid. Required: Product additional attribute 1, SKU, Bin, Main Warehouse.';
        confirmImportBtn.disabled = true;
        window.__restock_import_preview = null;
        importOk = false;
        setDropZoneError('Invalid headers');
      } else if (!mapped.length){
        importSummary.textContent = 'No valid rows found';
        confirmImportBtn.disabled = true;
        window.__restock_import_preview = null;
        importOk = false;
        setDropZoneError('No valid rows');
      } else {
        importSummary.textContent = `${mapped.length} rows ready to import${skipped ? ` (${skipped} skipped)` : ''}`;
        confirmImportBtn.disabled = false;
        window.__restock_import_preview = mapped;
        importOk = true;
        setDropZoneOk(fileName || 'selected.xlsx', mapped.length);
      }
      // Preview top 10
      if (previewWrap && previewBody){
        previewWrap.style.display = mapped.length ? 'block':'none';
        previewBody.innerHTML = (mapped.slice(0,10).map(r=>`<tr><td>${escapeHtml(r.sku)}</td><td>${escapeHtml(r.product)}</td><td>${escapeHtml(r.location)}</td><td>${escapeHtml(r.on_hand)}</td></tr>`).join('')) || '';
      }
    } catch(err){
      importSummary.textContent = `Error: ${err.message}`;
      confirmImportBtn.disabled = true;
      window.__restock_import_preview = null;
      importOk = false;
      if (previewWrap) previewWrap.style.display='none';
      setDropZoneError('Error reading file');
    }
  }

  async function handleWorkbook(wb, fileName){
    try{
      const names = wb.SheetNames || [];
      const name = names[0];
      loadSheet(wb, name, fileName);
    } catch(err){
      importSummary.textContent = `Error: ${err.message}`;
      confirmImportBtn.disabled = true;
      window.__restock_import_preview = null;
      importOk = false;
    }
  }

  if (importFileInput){
    importFileInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f){ importSummary.textContent=''; confirmImportBtn.disabled=true; importOk=false; if (previewWrap) previewWrap.style.display='none'; resetDropZoneDefault(); return; }
      try{
        const { wb } = await parseExcel(f);
        handleWorkbook(wb, f.name);
      } catch(err){
        importSummary.textContent = `Error: ${err.message}`;
        confirmImportBtn.disabled = true;
        window.__restock_import_preview = null;
        importOk = false;
        if (previewWrap) previewWrap.style.display='none';
        setDropZoneError('Error reading file');
      }
    });
  }

  if (dropZone){
    const stop = (e)=>{ e.preventDefault(); e.stopPropagation(); };
    ['dragenter','dragover','dragleave','drop'].forEach(ev=> dropZone.addEventListener(ev, stop));
    dropZone.addEventListener('dragover', ()=>{ dropZone.style.background = '#e0e7ff'; dropZone.style.borderColor = '#4f46e5'; });
    dropZone.addEventListener('dragleave', ()=>{ dropZone.style.background = '#eef2ff'; dropZone.style.borderColor = '#6366f1'; });
    dropZone.addEventListener('drop', async (e)=>{
      dropZone.style.background = '#eef2ff'; dropZone.style.borderColor = '#6366f1';
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      try{
        const { wb } = await parseExcel(f);
        handleWorkbook(wb, f.name);
      } catch(err){
        importSummary.textContent = `Error: ${err.message}`;
        confirmImportBtn.disabled = true;
        window.__restock_import_preview = null;
        importOk = false;
        if (previewWrap) previewWrap.style.display='none';
        setDropZoneError('Error reading file');
      }
    });
  }

  window.restockDownloadSampleCSV = function(){
    // Generate an in-memory Excel workbook with a single sheet
    const aoa = [
      ['Product additional attribute 1','SKU','Bin','Main Warehouse'],
      ['3115','Product E','MA-F-08-L1',41],
      ['1076','Product D','MA-B-08-L2-P1',108],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'report');
    const wbout = XLSX.write(wb, { bookType:'xlsx', type:'array' });
    const blob = new Blob([wbout], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'restock_report_sample.xlsx'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
  };

  window.restockConfirmImport = async function(){
    try{
      await window.supabaseReady;
  if (!importOk) { return; }
  const rows = window.__restock_import_preview || [];
      if (!rows.length){ return; }
      // Replace existing data
      {
        const { error: delErr } = await window.supabase.from('restock_report').delete().neq('sku', '__never__');
        if (delErr) throw delErr;
      }

      // Batch insert in chunks
      const chunkSize = 500;
      for (let i=0; i<rows.length; i+=chunkSize){
        const chunk = rows.slice(i, i+chunkSize);
        const { error: insErr } = await window.supabase.from('restock_report').insert(chunk);
        if (insErr) throw insErr;
      }

      // Close modal and refresh list
      if (typeof window.closeImportModal === 'function') window.closeImportModal();
      window.__restock_import_preview = null;
      importSummary.textContent = '';
      confirmImportBtn.disabled = true;
      // Set Last report timestamp on successful import
      try{
        const stampEl = document.getElementById('lastReportStamp');
        if (stampEl) {
          const d = new Date();
          const pad = (n)=> String(n).padStart(2,'0');
          const dd = pad(d.getDate());
          const mm = pad(d.getMonth()+1);
          const yyyy = d.getFullYear();
          const hh = pad(d.getHours());
          const mi = pad(d.getMinutes());
          const stamp = `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
          stampEl.textContent = `Last report: ${stamp}`;
          try{ localStorage.setItem('restock_last_report', stamp); } catch{}
        }
      } catch{}
      fetchData();
    } catch(e){
      importSummary.textContent = `Error importing: ${e.message || e}`;
    }
  };
})();
