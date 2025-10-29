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
  onlyFavorites: false, // show only favorited items
     onlyReserveInfo: false, // show only rows where the (i) info badge would appear
  page: 1,
  perPage: 30,
  };

  // Favorites persistence (by SKU)
  const FAVORITES_KEY = 'restock_favorites_skus';
  const favorites = new Set();
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (raw) JSON.parse(raw).forEach((s) => favorites.add(String(s)));
  } catch {}

  function persistFavorites() {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favorites))); } catch {}
  }

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

  function statusChip(status, setupInfo = null) {
    const s = String(status || '').toLowerCase();
    
    // For configure status, add tooltip with diagnostic info
    if (s === 'configure' && setupInfo) {
      const { sku, hasSetup, min, med, max } = setupInfo;
      let tooltip = 'Needs setup: ';
      if (!hasSetup) {
        tooltip += 'No configuration found for this SKU';
      } else {
        const issues = [];
        if (!Number.isFinite(min)) issues.push('min capacity not set');
        if (!Number.isFinite(med)) issues.push('med capacity not set');
        if (!Number.isFinite(max)) issues.push('max capacity not set');
        tooltip += issues.length > 0 ? issues.join(', ') : 'Invalid capacity values';
      }
      
      return `<span title="${escapeHtml(tooltip)}" style="cursor: help; border-bottom: 1px dotted #999">${escapeHtml(s)}</span>`;
    }
    
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
      setTbody('<tr><td colspan="10" style="text-align:center;opacity:.7">No results</td></tr>');
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
  const status = (r.__norm_status || r.status || 'configure').toLowerCase();
        const reserveQty = Number(r.__reserve_total ?? 0);
        const restock = r.restock_qty ?? '';
        let reserveCellHtml = formatReserveCell(reserveQty);
        const restockNum = Number(restock);
        const showInfo = Number.isFinite(restockNum) && reserveQty > 1 && reserveQty < restockNum;
        if (showInfo) {
          const locs = (Array.isArray(r.__reserve_locations) ? r.__reserve_locations : [])
            .filter(x => x && x.location && Number(x.qty) > 0)
            .map(x => ({ location: String(x.location), qty: Number(x.qty) }));
          let chosen = [];
          const exact = locs.find(x => x.qty === restockNum);
          if (exact) {
            chosen = [exact];
          } else {
            locs.sort((a,b)=> b.qty - a.qty);
            let sum = 0;
            for (const x of locs){
              if (sum + x.qty <= restockNum){ chosen.push(x); sum += x.qty; }
            }
            if (chosen.length === 0) {
              const under = locs.filter(x => x.qty < restockNum).sort((a,b)=> b.qty - a.qty)[0];
              if (under) chosen = [under];
            }
          }
          const lines = chosen.map(x => `SKU: ${sku} — Product: ${product} — Location: ${escapeHtml(x.location)} — QTY: ${escapeHtml(x.qty)}`);
          const popHtml = lines.length ? `<div class="reserve-pop">${lines.map(l=>`<span class="line">${l}</span>`).join('')}</div>` : '';
          reserveCellHtml = `<span class="reserve-cell">${reserveCellHtml}<button type="button" class="info-badge" aria-label="Reserve locations" onclick="restockToggleReserveInfo(this)">i</button>${popHtml}</span>`;
        }
        // Compute up to two nearest reserve locations and format lines with QTY
        const nearestLines = computeNearestReserveLines(r.stock_locator, r.__reserve_locations);
        const nearestHtml = nearestLines.length
          ? nearestLines.map(l => `<div>${escapeHtml(l)}</div>`).join('')
          : '';
        const favOn = favorites.has(String(r.sku));
        const star = `<button type="button" class="fav-btn" aria-label="Toggle favorite" data-sku="${sku}" onclick="restockToggleFavorite('${sku}')" title="${favOn ? 'Unfavorite' : 'Favorite'}" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1">${favOn ? '★' : '☆'}</button>`;
        return `
          <tr>
            <td>${star}</td>
            <td>${sku}</td>
            <td>${product}</td>
            <td>${pickface}</td>
            <td>${onHand}</td>
            <td>${capacity}</td>
            <td>${statusChip(status, r.__setup_info)}</td>
            <td>${reserveCellHtml}</td>
            <td>${restock}</td>
            <td class="print-only">${nearestHtml}</td>
          </tr>`;
      }).join('');
      chunks.push(rowsHtml);
      if (i + 30 < limited.length) {
        chunks.push('<tr class="print-break"><td colspan="10"></td></tr>');
      }
    }
    const html = chunks.join('');

    setTbody(html);
    if (window.styleRestockStatuses) setTimeout(window.styleRestockStatuses, 0);
  }

  // Parse location codes like MA-A-01-L1 or MA-B-08-L2-P1 into comparable parts
  function parseLocation(code){
    if (!code) return null;
    const s = String(code).trim();
    // Pattern: SITE-AREA-ROW-LLEVEL(-Ppos)? e.g., MA-A-01-L1-P1
    const m = s.match(/^([A-Z]{2})-([A-Z])-([0-9]{2})-L(\d)(?:-P(\d))?$/i);
    if (!m) return null;
    return {
      site: m[1].toUpperCase(),
      area: m[2].toUpperCase(),
      row: parseInt(m[3], 10),
      level: parseInt(m[4], 10),
      pos: m[5] ? parseInt(m[5], 10) : 0,
      raw: s,
    };
  }

  // Heuristic distance between two parsed locations: prioritize area match, then row diff, level diff, pos diff
  function locationDistance(a, b){
    if (!a || !b) return Infinity;
    if (a.site !== b.site) return 100000; // different site very far
    let score = 0;
    if (a.area !== b.area) score += 10000; // different area is far
    score += Math.abs(a.row - b.row) * 100; // each row ~100
    score += Math.abs(a.level - b.level) * 10; // level less weight
    score += Math.abs(a.pos - b.pos);
    return score;
  }

  // Compute up to three nearest reserve locations; also append any from MA-RETURNS, MA-GA, MA-SAMPLES, MA-DOCK; show only '(Same Lane)' when applicable
  function computeNearestReserveLines(pickface, reserveLocs){
    const p = parseLocation(pickface);
    if (!p || !Array.isArray(reserveLocs) || reserveLocs.length === 0) return [];
    const scored = [];
    for (const r of reserveLocs){
      if (!r || !r.location || !Number.isFinite(r.qty) || r.qty <= 0) continue;
      const q = parseLocation(r.location);
      if (!q) continue;
      const dist = locationDistance(p, q);
      const sameLane = (p.site === q.site && p.area === q.area && p.row === q.row);
      scored.push({ location: String(r.location), qty: r.qty, dist, sameLane });
    }
    scored.sort((a,b)=> a.dist - b.dist);
    const top = scored.slice(0, 3);

    // Append special zones (case-insensitive) directly from original reserveLocs, even if code doesn't match parse pattern
    const specials = ['MA-RETURNS','MA-GA','MA-SAMPLES','MA-DOCK'];
    const setIncluded = new Set(top.map(x => x.location.toUpperCase()));
    const extras = [];
    // Group extras by zone to keep a stable order within each group; sort by qty desc
    for (const zone of specials){
      const zoneUpper = zone.toUpperCase();
      const candidates = [];
      for (const r of reserveLocs){
        if (!r || !r.location || !Number.isFinite(r.qty) || r.qty <= 0) continue;
        const locUp = String(r.location).toUpperCase();
        if (locUp.startsWith(zoneUpper)){
          const key = locUp;
          if (setIncluded.has(key)) continue; // already in top
          candidates.push({ location: String(r.location), qty: Number(r.qty), dist: Number.MAX_SAFE_INTEGER, sameLane: false });
        }
      }
      // Prefer higher qty first if multiple in the same zone
      candidates.sort((a,b)=> b.qty - a.qty);
      for (const c of candidates){
        if (extras.length >= 50) break; // safety cap
        const key = c.location.toUpperCase();
        if (!setIncluded.has(key)){
          extras.push(c);
          setIncluded.add(key);
        }
      }
    }

    const combined = top.concat(extras);
    return combined.map(item => `${item.location}${item.sameLane ? ' (Same Lane)' : ''}  •  QTY = ${item.qty}`);
  }

  // Apply status filter only; other toggles handled separately
  function applyStatusFilter(rows) {
    let filtered = Array.isArray(rows) ? rows.slice() : [];
    if (state.statusFilter && state.statusFilter !== 'ALL') {
      filtered = filtered.filter(r => String((r.__norm_status || r.status || '')).toUpperCase() === state.statusFilter);
    }
    return filtered;
  }

  function applyFavoritesFilter(rows) {
    if (!state.onlyFavorites) return rows;
    return rows.filter(r => favorites.has(String(r.sku)));
  }

    function hasReserveInfoBadge(r) {
      const reserveQty = Number(r.__reserve_total || 0);
      const restock = Number(r.restock_qty);
      return Number.isFinite(restock) && reserveQty > 1 && reserveQty < restock;
    }

    function applyOnlyReserveInfoFilter(rows){
      if (!state.onlyReserveInfo) return rows;
      return rows.filter(hasReserveInfoBadge);
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
      // Sort within each bucket by Pickface (site, area, row, level, pos),
      // then by Restock desc, and finally by SKU as tiebreaker
      const sortInner = (a, b) => {
        const pa = parseLocation(a.stock_locator) || { site:'', area:'', row:0, level:0, pos:0, raw: String(a.stock_locator||'') };
        const pb = parseLocation(b.stock_locator) || { site:'', area:'', row:0, level:0, pos:0, raw: String(b.stock_locator||'') };
        if (pa.site !== pb.site) return pa.site.localeCompare(pb.site);
        if (pa.area !== pb.area) return pa.area.localeCompare(pb.area);
        if (pa.row !== pb.row) return pa.row - pb.row;
        if (pa.level !== pb.level) return pa.level - pb.level;
        if (pa.pos !== pb.pos) return pa.pos - pb.pos;
        // If pickface equal, sort by restock desc
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

  // Debug function to check reserve calculation for a SKU
  window.debugSkuReserve = function(sku) {
    console.log(`=== DEBUG SKU ${sku} RESERVE CALCULATION ===`);
    
    // Find the row
    const row = state.allRows.find(r => String(r.sku) === String(sku));
    if (!row) {
      console.log('SKU not found');
      return;
    }
    
    console.log('Row data:', {
      sku: row.sku,
      pickface: row.stock_locator,
      on_hand: row.on_hand,
      reserve_total: row.__reserve_total,
      reserve_locations: row.__reserve_locations
    });
    
    // Check raw data from restock_report for this SKU
    window.supabase
      .from('restock_report')
      .select('sku, location, on_hand')
      .eq('sku', sku)
      .then(({ data, error }) => {
        if (error) {
          console.error('Error fetching raw data:', error);
          return;
        }
        
        console.log(`Raw data from restock_report for SKU ${sku}:`);
        data?.forEach((rec, i) => {
          console.log(`  Record ${i+1}:`, {
            location: rec.location,
            on_hand: rec.on_hand,
            is_pickface: rec.location === row.stock_locator,
            normalized_pickface: normalizeLocation(rec.location),
            normalized_row_pickface: normalizeLocation(row.stock_locator),
            matches_pickface: normalizeLocation(rec.location) === normalizeLocation(row.stock_locator)
          });
        });
        
        // Manual reserve calculation
        const pickfaceNormalized = normalizeLocation(row.stock_locator);
        let manualTotal = 0;
        const manualLocations = [];
        
        data?.forEach(rec => {
          const oh = Number(rec.on_hand) || 0;
          if (normalizeLocation(rec.location) !== pickfaceNormalized) {
            manualTotal += oh;
            if (oh > 0) {
              manualLocations.push({ location: rec.location, qty: oh });
            }
          }
        });
        
        console.log('Manual calculation:', {
          total: manualTotal,
          locations: manualLocations,
          system_total: row.__reserve_total,
          system_locations: row.__reserve_locations
        });
      });
    
    return row;
  };
  window.debugSkuLocations = function(sku) {
    console.log(`=== DEBUG SKU ${sku} LOCATIONS ===`);
    
    // Check in current allRows
    const rows = state.allRows.filter(r => String(r.sku) === String(sku));
    console.log(`Found ${rows.length} rows for SKU ${sku}:`);
    rows.forEach((row, i) => {
      console.log(`  Row ${i+1}:`, {
        sku: row.sku,
        product: row.product,
        location: row.stock_locator,
        on_hand: row.on_hand,
        status: row.__norm_status || row.status
      });
    });
    
    return rows;
  };

  // Debug function to investigate why a SKU has "needs setup" status
  window.debugSkuStatus = function(sku) {
    console.log(`=== DEBUG SKU ${sku} ===`);
    
    // Find the row in current data
    const row = state.allRows.find(r => String(r.sku) === String(sku));
    if (!row) {
      console.log('SKU not found in current data');
      return;
    }
    
    console.log('Row data:', {
      sku: row.sku,
      product: row.product,
      stock_locator: row.stock_locator,
      on_hand: row.on_hand,
      pickface_space: row.pickface_space,
      status: row.status,
      __norm_status: row.__norm_status,
      __setup_info: row.__setup_info
    });
    
    // Check setup info if available
    if (row.__setup_info) {
      console.log('Setup diagnostic:', row.__setup_info);
    }
    
    return row;
  };

  // New function to analyze all "needs setup" cases
  window.analyzeNeedsSetup = function() {
    console.log('=== ANALYZING ALL NEEDS SETUP CASES ===');
    
    const needsSetup = state.allRows.filter(r => 
      (r.__norm_status || '').toLowerCase() === 'configure'
    );
    
    console.log(`Total "needs setup" items: ${needsSetup.length}`);
    
    // Group by reason
    const reasons = {
      noSetupRecord: 0,
      invalidMin: 0,
      invalidMed: 0,
      invalidMax: 0,
      allInvalid: 0
    };
    
    const samples = {
      noSetupRecord: [],
      invalidValues: []
    };
    
    needsSetup.forEach(row => {
      const info = row.__setup_info;
      if (!info) return;
      
      if (!info.hasSetup) {
        reasons.noSetupRecord++;
        if (samples.noSetupRecord.length < 5) {
          samples.noSetupRecord.push({
            sku: row.sku,
            product: row.product
          });
        }
      } else {
        // Has setup record but values are invalid
        if (!Number.isFinite(info.min)) reasons.invalidMin++;
        if (!Number.isFinite(info.med)) reasons.invalidMed++;
        if (!Number.isFinite(info.max)) reasons.invalidMax++;
        
        if (samples.invalidValues.length < 5) {
          samples.invalidValues.push({
            sku: row.sku,
            product: row.product,
            min: info.min,
            med: info.med,
            max: info.max
          });
        }
      }
    });
    
    console.log('Breakdown of issues:');
    console.log('- No setup record:', reasons.noSetupRecord);
    console.log('- Invalid min values:', reasons.invalidMin);
    console.log('- Invalid med values:', reasons.invalidMed);
    console.log('- Invalid max values:', reasons.invalidMax);
    
    console.log('\nSample SKUs with no setup record:', samples.noSetupRecord);
    console.log('Sample SKUs with invalid values:', samples.invalidValues);
    
    return {
      total: needsSetup.length,
      reasons,
      samples
    };
  };

  // Helper function to normalize location strings for comparison (ignore spaces, case)
  function normalizeLocation(loc) {
    return String(loc || '').replace(/\s+/g, '').toUpperCase();
  }

  async function computeReserveTotals(rows){
    try{
      await window.supabaseReady;
      const mapPick = {};
      const skuSet = new Set();
      for (const r of rows){
        if (!r || !r.sku) continue;
        if (!(r.sku in mapPick)) mapPick[r.sku] = normalizeLocation(r.stock_locator);
        skuSet.add(r.sku);
      }
      const skuList = Array.from(skuSet);
      if (skuList.length === 0) return { totals: {}, bySkuLocations: {} };
      
      console.log('=== COMPUTE RESERVE TOTALS DEBUG ===');
      console.log('SKUs to lookup:', skuList.length);
      console.log('33994 pickface mapping:', mapPick['33994']);
      console.log('SKU list sample:', skuList.slice(0, 10));
      console.log('SKU 33994 in list?:', skuList.includes('33994'));
      console.log('SKU 33994 position in list:', skuList.indexOf('33994'));
      console.log('Processing SKUs in chunks of 500...');
      console.log('SKU types in list:', skuList.slice(0, 5).map(s => typeof s + ':' + s));
      
      // Process SKUs in chunks to avoid Supabase .in() limits
      const chunkSize = 500;
      const allData = [];
      
      for (let i = 0; i < skuList.length; i += chunkSize) {
        const chunk = skuList.slice(i, i + chunkSize);
        console.log(`Fetching chunk ${Math.floor(i/chunkSize) + 1}/${Math.ceil(skuList.length/chunkSize)}: ${chunk.length} SKUs`);
        
        const { data: chunkData, error: chunkError } = await window.supabase
          .from('restock_report')
          .select('sku, location, on_hand')
          .in('sku', chunk);
          
        if (chunkError) {
          console.error('Chunk error:', chunkError);
          continue;
        }
        
        allData.push(...(chunkData || []));
      }
      
      const data = allData;
      
      console.log('Total raw data received:', data?.length || 0);
      
      const totals = {};
      const bySkuLocations = {};
      for (const rec of data || []){
        const sku = rec.sku;
        const loc = rec.location;
        const oh = Number(rec.on_hand) || 0;
        if (!sku || !Number.isFinite(oh)) continue;
        
        // Compare normalized locations to ignore spaces and case differences
        if (normalizeLocation(loc) === mapPick[sku]) continue; // exclude pickface
        totals[sku] = (totals[sku] || 0) + oh;
        if (!bySkuLocations[sku]) bySkuLocations[sku] = [];
        bySkuLocations[sku].push({ location: loc, qty: oh });
      }
      
      console.log('Reserve calculation completed successfully');
      
      return { totals, bySkuLocations };
    } catch(e){
      console.warn('reserve totals error', e);
      return { totals: {}, bySkuLocations: {} };
    }
  }

  async function fetchData() {
    if (!window.supabase || !window.supabaseReady) {
      setTbody('<tr><td colspan="9" style="text-align:center;color:#b91c1c">Supabase not initialized</td></tr>');
      return;
    }

    state.loading = true;
  setTbody('<tr><td colspan="9" style="text-align:center;opacity:.7">Loading…</td></tr>');

    try {
      await window.supabaseReady;

  // Base query
  // Join setup to compute thresholds client-side
  let qSetup = window.supabase
    .from('restock_setup')
    .select('sku, cap_min, cap_med, cap_max')
    .order('sku')
    .limit(10000); // Force high limit to get all records

  // Build view query
  let qView = window.supabase
    .from('restock_view')
    .select('sku, product, stock_locator, on_hand, pickface_space, restock_qty')
    .order('sku');

  const q = (state.q || '').trim();
  if (q) {
    // Case-insensitive partial match on common columns
    const pattern = `%${q}%`;
    qView = qView.or(
      [
        `sku.ilike.${pattern}`,
        `product.ilike.${pattern}`,
        `stock_locator.ilike.${pattern}`,
      ].join(',')
    );
  }

  // Apply search filter if exists
  if (state.searchTerm && state.searchTerm.trim()) {
    const searchTerm = state.searchTerm.trim();
    if (/^\d+$/.test(searchTerm)) {
      qView = qView.eq('sku', searchTerm);
    } else {
      qView = qView.or(
        `product.ilike.%${searchTerm}%,sku.ilike.%${searchTerm}%`
      );
    }
  }
  
  const viewPromise = qView.limit(5000); // Increased limit
  
  // Fetch setup data in chunks to avoid Supabase limits
  console.log('Fetching setup data in chunks...');
  const allSetupData = [];
  const setupChunkSize = 1000;
  let setupOffset = 0;
  
  while (true) {
    console.log(`Fetching setup chunk starting at ${setupOffset}...`);
    const { data: setupChunk, error: setupChunkError } = await window.supabase
      .from('restock_setup')
      .select('sku, cap_min, cap_med, cap_max')
      .order('sku')
      .range(setupOffset, setupOffset + setupChunkSize - 1);
    
    if (setupChunkError) {
      console.error('Setup chunk error:', setupChunkError);
      break;
    }
    
    if (!setupChunk || setupChunk.length === 0) {
      console.log('No more setup data, stopping...');
      break;
    }
    
    console.log(`Loaded ${setupChunk.length} setup records from chunk`);
    allSetupData.push(...setupChunk);
    
    if (setupChunk.length < setupChunkSize) {
      console.log('Last chunk (partial), stopping...');
      break;
    }
    
    setupOffset += setupChunkSize;
  }
  
  console.log(`Total setup records loaded: ${allSetupData.length}`);
  const [{ data: viewRows, error: vErr }] = await Promise.all([viewPromise]);
  const setupRows = allSetupData;
  const sErr = null;
      if (vErr) throw vErr;
      if (sErr) throw sErr;

      let rows = Array.isArray(viewRows) ? viewRows.slice() : [];
      const setupBySku = Object.create(null);
      
      console.log('=== SETUP DATA DEBUG ===');
      console.log('Setup rows received:', setupRows?.length || 0);
      
      // Check if we're hitting limits
      if (setupRows?.length === 1000) {
        console.warn('⚠️ Setup data may be truncated at 1000 rows - some SKUs might be missing');
      }
      
      for (const s of setupRows || []){
        setupBySku[s.sku] = { min: Number(s.cap_min), med: Number(s.cap_med), max: Number(s.cap_max) };
        
        // Debug specific SKUs
        if (String(s.sku) === '31328' || String(s.sku) === '41161') {
          console.log(`Setup data for SKU ${s.sku}:`, {
            sku: s.sku,
            cap_min: s.cap_min,
            cap_med: s.cap_med,
            cap_max: s.cap_max,
            converted: setupBySku[s.sku]
          });
        }
      }
      
      // Make available for debugging
      window.debugSetupBySku = setupBySku;
      window.debugViewRows = rows;
      
      console.log('Setup lookup map size:', Object.keys(setupBySku).length);
      console.log('31328 in setupBySku?:', '31328' in setupBySku, setupBySku['31328']);
      console.log('41161 in setupBySku?:', '41161' in setupBySku, setupBySku['41161']);
      
      // Show some examples of what's in the setup map
      const setupSamples = Object.keys(setupBySku).slice(0, 10);
      console.log('Sample SKUs in setup map:', setupSamples);
      setupSamples.forEach(sku => {
        console.log(`  ${sku}:`, setupBySku[sku]);
      });
      
      // Debug types immediately
      console.log('=== TYPE DEBUGGING ===');
      console.log('Setup map keys sample types:', Object.keys(setupBySku).slice(0,5).map(k => typeof k + ':' + k));
      console.log('View data SKUs sample types:', rows.slice(0,5).map(r => typeof r.sku + ':' + r.sku));
  // Compute normalized status based on thresholds for all rows
  for (const r of rows){
        const t = setupBySku[r.sku];
        const isDebugSku = String(r.sku) === '31328';
        
        if (isDebugSku) {
          console.log(`=== DEBUG SKU 31328 Status Calculation ===`);
          console.log('r.sku:', r.sku, typeof r.sku);
          console.log('Lookup result t:', t);
          console.log('Direct lookup test:', setupBySku['31328']);
          console.log('Row data:', { sku: r.sku, on_hand: r.on_hand, pickface_space: r.pickface_space });
        }
        
        if (!t || !Number.isFinite(t.min) || !Number.isFinite(t.med) || !Number.isFinite(t.max)){
          r.__norm_status = 'CONFIGURE';
          // Store setup diagnostics for tooltip
          r.__setup_info = {
            sku: r.sku,
            hasSetup: !!t,
            min: t ? t.min : undefined,
            med: t ? t.med : undefined,
            max: t ? t.max : undefined
          };
          if (isDebugSku) {
            console.log('31328 set to CONFIGURE due to missing/invalid setup:', {
              t_exists: !!t,
              t_value: t,
              min_finite: t ? Number.isFinite(t.min) : false,
              med_finite: t ? Number.isFinite(t.med) : false,
              max_finite: t ? Number.isFinite(t.max) : false,
              setup_info: r.__setup_info
            });
          }
          continue;
        }
        const on = Number(r.on_hand) || 0;
        if (isDebugSku) {
          console.log('31328 thresholds:', { min: t.min, med: t.med, max: t.max, on_hand: on });
        }
        if (on < t.min) r.__norm_status = 'LOW';
        else if (on >= t.min && on < t.med) r.__norm_status = 'MEDIUM';
        else if (on >= t.med && on <= t.max) r.__norm_status = 'FULL';
        else if (on > t.max) r.__norm_status = 'OVER';
        else r.__norm_status = 'CONFIGURE';
        
        if (isDebugSku) {
          console.log('31328 final status:', r.__norm_status);
        }
      }
  // Compute reserve totals and annotate
  const reserveCtx = await computeReserveTotals(rows);
  rows.forEach(r => {
    r.__reserve_total = (reserveCtx.totals && reserveCtx.totals[r.sku]) || 0;
    r.__reserve_locations = (reserveCtx.bySkuLocations && reserveCtx.bySkuLocations[r.sku]) || [];
  });
  // Save annotated rows
  state.allRows = rows.slice();
  // Apply current filters locally now
  let filtered = applyStatusFilter(rows);
  filtered = applyFavoritesFilter(filtered);
    filtered = applyOnlyReserveInfoFilter(filtered);
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
  setTbody('<tr><td colspan="9" style="text-align:center;color:#b91c1c">Failed to load data</td></tr>');
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
  // Helpers to manage Last report stamp
  function setLastReportStampText(stamp){
    const el = document.getElementById('lastReportStamp');
    if (el) el.textContent = `Last report: ${stamp}`;
    try{ localStorage.setItem('restock_last_report', stamp); } catch{}
  }
  function formatStampFromDate(d){
    const pad = (n)=> String(n).padStart(2,'0');
    const dd = pad(d.getDate());
    const mm = pad(d.getMonth()+1);
    const yyyy = d.getFullYear();
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  }
  async function updateLastReportFromDB(){
    try{
      await window.supabaseReady;
      const { data, error } = await window.supabase
        .from('restock_report')
        .select('location')
        .eq('sku','__last_report__')
        .single();
      if (!error && data && data.location){
        const d = new Date(data.location);
        if (!isNaN(d)) setLastReportStampText(formatStampFromDate(d));
        return;
      }
    } catch {}
    // Fallback to localStorage
    try{
      const saved = localStorage.getItem('restock_last_report');
      if (saved) setLastReportStampText(saved);
    } catch {}
  }
  updateLastReportFromDB();

  // Pager controls
  window.restockPrevPage = function(){ if (state.page > 1) { state.page -= 1; render(state.rows); } };
  window.restockNextPage = function(){ const totalPages = Math.max(1, Math.ceil(state.rows.length / state.perPage)); if (state.page < totalPages) { state.page += 1; render(state.rows); } };

  // Print tweaks: sort by Pickface only the current page and restore after
  let __beforePrintCache = null;
  window.restockPreparePrintView = function(){
    try{
      // Cache current rows and pagination
      __beforePrintCache = { rows: state.rows.slice(), page: state.page, perPage: state.perPage };
      // Current page slice
      const start = (state.page - 1) * state.perPage;
      const end = start + state.perPage;
      const subset = state.rows.slice(start, end);
      // Sort by pickface logical order: site, area, row, level, pos
      const sorter = (a, b) => {
        const pa = parseLocation(a.stock_locator) || {site:'',area:'',row:0,level:0,pos:0};
        const pb = parseLocation(b.stock_locator) || {site:'',area:'',row:0,level:0,pos:0};
        if (pa.site !== pb.site) return pa.site.localeCompare(pb.site);
        if (pa.area !== pb.area) return pa.area.localeCompare(pb.area);
        if (pa.row !== pb.row) return pa.row - pb.row;
        if (pa.level !== pb.level) return pa.level - pb.level;
        return pa.pos - pb.pos;
      };
      const sortedSubset = subset.slice().sort(sorter);
      const prevPerPage = state.perPage;
      state.page = 1;
      state.perPage = sortedSubset.length; // ensure we print exactly this page
      render(sortedSubset);
      // Restore perPage immediately so afterprint we can render normally
      state.perPage = prevPerPage;
    } catch{}
  };
  window.restockRestoreView = function(){
    try{
      if (__beforePrintCache){
        state.page = __beforePrintCache.page;
        state.perPage = __beforePrintCache.perPage;
        render(__beforePrintCache.rows);
      }
      __beforePrintCache = null;
    } catch{}
  };

  // Expose filter controls for HTML buttons
  window.restockSetStatusFilter = function(val){
    state.statusFilter = String(val||'ALL').toUpperCase();
  // Rebuild view from annotated allRows
  state.page = 1;
  let rows = applyStatusFilter(state.allRows);
  rows = applyFavoritesFilter(rows);
    rows = applyOnlyReserveInfoFilter(rows);
  const arranged = stableSortByBusinessRules(rows);
  let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
  if (state.onlyNeedsAdjustment) {
    visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
  }
  state.rows = visible;
  render(visible);
  };

  // Helper function for locations modal
  window.restockGetAllRows = function(){
    return state.allRows || [];
  };
  window.restockToggleHideNoReserve = function(flag){
    state.hideNoReserve = !!flag;
  state.page = 1;
  let rows = applyStatusFilter(state.allRows);
  rows = applyFavoritesFilter(rows);
    rows = applyOnlyReserveInfoFilter(rows);
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
    rows = applyFavoritesFilter(rows);
    rows = applyOnlyReserveInfoFilter(rows);
    const arranged = stableSortByBusinessRules(rows);
    let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
    if (state.onlyNeedsAdjustment) {
      visible = visible.filter(r => {
        // Include items that need adjustment: zero on hand with reserve OR needs config
        const needsAdjustment = (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0);
        const needsConfig = (r.__norm_status || r.status || '').toLowerCase() === 'configure';
        return needsAdjustment || needsConfig;
      });
    }
    state.rows = visible;
    render(visible);
  };

  // Favorites APIs
  window.restockToggleFavorite = function(sku){
    const key = String(sku);
    if (favorites.has(key)) favorites.delete(key); else favorites.add(key);
    persistFavorites();
    // If filtering by favorites, re-apply; otherwise update stars only
    if (state.onlyFavorites) {
      state.page = 1;
      let rows = applyStatusFilter(state.allRows);
      rows = applyFavoritesFilter(rows);
      rows = applyOnlyReserveInfoFilter(rows);
      const arranged = stableSortByBusinessRules(rows);
      let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
      if (state.onlyNeedsAdjustment) {
        visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
      }
      state.rows = visible;
      render(visible);
    } else {
      // Update stars in-place
      const tbody = document.getElementById('restockTbody');
      if (!tbody) return;
      [...tbody.querySelectorAll('button.fav-btn')].forEach(btn => {
        const skuAttr = btn.getAttribute('data-sku');
        const on = favorites.has(String(skuAttr));
        btn.textContent = on ? '★' : '☆';
        btn.title = on ? 'Unfavorite' : 'Favorite';
      });
    }
  };

  window.restockToggleOnlyFavorites = function(flag){
    state.onlyFavorites = !!flag;
    state.page = 1;
    let rows = applyStatusFilter(state.allRows);
    rows = applyFavoritesFilter(rows);
    rows = applyOnlyReserveInfoFilter(rows);
    const arranged = stableSortByBusinessRules(rows);
    let visible = state.hideNoReserve ? arranged.filter(r => Number(r.__reserve_total||0) > 0) : arranged;
    if (state.onlyNeedsAdjustment) {
      visible = visible.filter(r => (Number(r.on_hand) === 0) && (Number(r.__reserve_total || 0) > 0));
    }
    state.rows = visible;
    render(visible);
  };

  // Toggle small tooltip on the reserve info badge
  window.restockToggleReserveInfo = function(btn){
    try{
      const wrap = btn && btn.closest('.reserve-cell');
      if (!wrap) return;
      wrap.classList.toggle('show');
    } catch {}
  };

    // Toggle Only opportunities (i)
    window.restockToggleOnlyReserveInfo = function(flag){
      state.onlyReserveInfo = !!flag;
      state.page = 1;
      let rows = applyStatusFilter(state.allRows);
      rows = applyFavoritesFilter(rows);
      rows = applyOnlyReserveInfoFilter(rows);
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
      prod_attr_1: find('product additional attribute 1'), // 5-digit SKU
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

      // Insert/update sentinel row with last import timestamp
      try{
        const nowIso = new Date().toISOString();
        const sentinel = { sku: '__last_report__', product: '__meta__', location: nowIso, on_hand: 0 };
        const { error: metaErr } = await window.supabase.from('restock_report').insert(sentinel);
        if (metaErr) {
          // If insert conflict due to PK, try upsert
          await window.supabase.from('restock_report').upsert(sentinel, { onConflict: 'sku' });
        }
      } catch {}

      // Close modal and refresh list
      if (typeof window.closeImportModal === 'function') window.closeImportModal();
      window.__restock_import_preview = null;
      importSummary.textContent = '';
      confirmImportBtn.disabled = true;
      // Set Last report timestamp on successful import
      try{
        setLastReportStampText(formatStampFromDate(new Date()));
      } catch{}
      fetchData();
    } catch(e){
      importSummary.textContent = `Error importing: ${e.message || e}`;
    }
  };
})();
