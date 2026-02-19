/**
 * Branch Replenishment Planner - Main Page JS
 * Handles overview, snapshot upload, and AVG management
 */

(function() {
  'use strict';

  // ============================================
  // CONSTANTS
  // ============================================
  
  const BRANCHES = [
    { code: 'SYD', name: 'Sydney' },
    { code: 'MEL', name: 'Melbourne' },
    { code: 'BNE', name: 'Brisbane' },
    { code: 'CNS', name: 'Cairns' },
    { code: 'CFS', name: 'Coffs Harbour' },
    { code: 'HBA', name: 'Hobart' },
    { code: 'SCS', name: 'Sunshine Coast' }
  ];

  // Mapping from report column names to warehouse codes
  const WAREHOUSE_MAP = {
    'main warehouse': 'MAIN',
    'main': 'MAIN',
    'sydney': 'SYD',
    'melbourne': 'MEL',
    'brisbane': 'BNE',
    'cairns': 'CNS',
    'coffs harbour': 'CFS',
    'coffs': 'CFS',
    'hobart': 'HBA',
    'sunshine coast warehouse': 'SCS',
    'sunshine coast': 'SCS',
    'sunshine': 'SCS'
  };

  // ============================================
  // STATE
  // ============================================
  
  let state = {
    latestSnapshot: null,
    branchPlans: {},
    parsedData: null,
    avgData: []
  };

  // ============================================
  // INITIALIZATION
  // ============================================
  
  document.addEventListener('DOMContentLoaded', async () => {
    console.log('📦 Branch Replenishment Planner initialized');
    await loadLatestSnapshot();
    await loadBranchStatuses();
    setupDropZone();
  });

  // ============================================
  // LOAD DATA
  // ============================================
  
  async function loadLatestSnapshot() {
    try {
      await window.supabaseReady;
      
      const { data, error } = await window.supabase
        .from('stock_snapshots')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1);
      
      if (error) throw error;
      
      if (data && data.length > 0) {
        state.latestSnapshot = data[0];
        showSnapshotInfo(data[0]);
        document.getElementById('noSnapshotAlert').style.display = 'none';
        document.getElementById('snapshotSection').style.display = 'block';
      } else {
        document.getElementById('noSnapshotAlert').style.display = 'block';
        document.getElementById('snapshotSection').style.display = 'none';
      }
    } catch (err) {
      console.error('Error loading snapshot:', err);
    }
  }

  function showSnapshotInfo(snapshot) {
    const dateEl = document.getElementById('snapshotDate');
    const rowsEl = document.getElementById('snapshotRows');
    const fileEl = document.getElementById('snapshotFilename');
    
    if (dateEl) {
      const date = new Date(snapshot.created_at);
      dateEl.textContent = `Snapshot: ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }
    if (rowsEl) {
      rowsEl.textContent = snapshot.row_count ? `(${snapshot.row_count} rows)` : '';
    }
    if (fileEl) {
      fileEl.textContent = snapshot.original_filename || '';
    }
  }

  async function loadBranchStatuses() {
    const grid = document.getElementById('branchGrid');
    if (!grid) return;
    
    // If no snapshot, show empty cards
    if (!state.latestSnapshot) {
      grid.innerHTML = BRANCHES.map(b => `
        <div class="branch-card">
          <div>
            <div class="branch-name">${escapeHtml(b.name)}</div>
            <div class="branch-code">${escapeHtml(b.code)}</div>
          </div>
          <div>
            <span class="status-badge no_plan">No Snapshot</span>
          </div>
          <button class="search-btn-small secondary" disabled>View</button>
        </div>
      `).join('');
      return;
    }

    try {
      await window.supabaseReady;
      
      // Get plans for latest snapshot
      const { data: plans, error } = await window.supabase
        .from('transfer_plans')
        .select('branch_code, status, created_at')
        .eq('snapshot_id', state.latestSnapshot.id);
      
      if (error) throw error;
      
      const planMap = {};
      for (const p of (plans || [])) {
        planMap[p.branch_code] = p;
      }
      state.branchPlans = planMap;

      grid.innerHTML = BRANCHES.map(b => {
        const plan = planMap[b.code];
        const status = plan ? plan.status : 'no_plan';
        const statusLabel = status === 'no_plan' ? 'No Plan' : status.charAt(0).toUpperCase() + status.slice(1);
        
        return `
          <div class="branch-card">
            <div>
              <div class="branch-name">${escapeHtml(b.name)}</div>
              <div class="branch-code">${escapeHtml(b.code)}</div>
            </div>
            <div>
              <span class="status-badge ${status}">${statusLabel}</span>
            </div>
            <a href="replenishment-branch.html?branch=${b.code}" class="search-btn-small">View</a>
          </div>
        `;
      }).join('');
      
    } catch (err) {
      console.error('Error loading branch statuses:', err);
      grid.innerHTML = '<p style="color:#dc2626">Error loading branches</p>';
    }
  }

  // ============================================
  // UPLOAD MODAL
  // ============================================
  
  window.openUploadModal = function() {
    document.getElementById('uploadModal')?.classList.remove('hidden');
    resetUploadState();
  };

  window.closeUploadModal = function() {
    document.getElementById('uploadModal')?.classList.add('hidden');
    resetUploadState();
  };

  function resetUploadState() {
    state.parsedData = null;
    const dropZone = document.getElementById('dropZone');
    const preview = document.getElementById('uploadPreview');
    const confirmBtn = document.getElementById('confirmUploadBtn');
    
    if (dropZone) {
      dropZone.className = 'drop-zone';
      dropZone.innerHTML = `
        <span style="font-size:32px">📄</span>
        <span>Drop Excel/CSV file here or click to browse</span>
        <span style="font-size:12px;opacity:0.7">Supports .xlsx, .xls, .csv</span>
      `;
    }
    if (preview) preview.style.display = 'none';
    if (confirmBtn) confirmBtn.disabled = true;
  }

  function setupDropZone() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone) return;

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        processFile(files[0]);
      }
    });
  }

  window.handleFileSelect = function(event) {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  };

  async function processFile(file) {
    const dropZone = document.getElementById('dropZone');
    
    try {
      dropZone.innerHTML = '<span>Processing...</span>';
      
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array' });
      
      // Use first sheet
      const sheetName = wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      
      // Parse the wide format report
      const parsed = parseWideReport(json, file.name);
      
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      
      state.parsedData = parsed;
      showUploadPreview(parsed, file.name);
      
    } catch (err) {
      console.error('Error processing file:', err);
      dropZone.className = 'drop-zone error';
      dropZone.innerHTML = `<span>Error: ${escapeHtml(err.message)}</span>`;
    }
  }

  /**
   * Parse the wide stock report format from Cin7
   * The report has Product/SKU column, then repeated column groups per warehouse
   * Uses 'product' as the primary key (matches branch_avg_monthly_sales table)
   */
  function parseWideReport(rows, fileName) {
    if (!rows || rows.length < 2) {
      return { error: 'File appears to be empty' };
    }

    // Find header rows - look for "SKU" or "Product" in first few rows
    let headerRowIdx = -1;
    let warehouseRowIdx = -1;
    
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const row = rows[i].map(c => String(c || '').toLowerCase().trim());
      // Look for header row - could have SKU and/or Product
      if (row.includes('sku') || row.includes('product')) {
        headerRowIdx = i;
        // Warehouse names are usually in the row above
        warehouseRowIdx = i > 0 ? i - 1 : i;
        break;
      }
    }
    
    if (headerRowIdx === -1) {
      return { error: 'Could not find SKU or Product column. Make sure the report has a header row.' };
    }

    const headerRow = rows[headerRowIdx].map(c => String(c || '').toLowerCase().trim());
    const warehouseRow = rows[warehouseRowIdx].map(c => String(c || '').toLowerCase().trim());
    
    // Find Product column (primary key) - prefer "product" over "sku"
    let productColIdx = headerRow.indexOf('product');
    if (productColIdx === -1) productColIdx = headerRow.indexOf('product code');
    if (productColIdx === -1) productColIdx = headerRow.indexOf('sku');  // Fallback to SKU if no Product column
    
    if (productColIdx === -1) {
      return { error: 'Product column not found. Report needs either "Product" or "SKU" column.' };
    }

    // Map warehouse columns - find "available" columns for each warehouse
    const warehouseColumns = {};
    let currentWarehouse = null;
    
    console.log('=== PARSING WAREHOUSE COLUMNS ===');
    console.log('Warehouse row:', warehouseRow.filter(x => x).join(' | '));
    
    for (let i = 0; i < headerRow.length; i++) {
      const warehouseName = warehouseRow[i];
      const colName = headerRow[i];
      
      // Check if this is a warehouse name
      const warehouseCode = WAREHOUSE_MAP[warehouseName];
      if (warehouseCode) {
        currentWarehouse = warehouseCode;
        console.log(`Col ${i}: Found warehouse "${warehouseName}" => ${warehouseCode}`);
      }
      
      // If we have a current warehouse and this is "available" column, store it
      if (currentWarehouse && colName === 'available') {
        console.log(`Col ${i}: Mapped "available" for ${currentWarehouse}`);
        warehouseColumns[currentWarehouse] = {
          available: i,
          onHand: null,
          allocated: null,
          onOrder: null,
          inTransit: null
        };
        
        // Look back for related columns
        for (let j = Math.max(0, i - 6); j < i; j++) {
          const cn = headerRow[j];
          if (cn === 'quantity on hand' || cn === 'on hand') {
            warehouseColumns[currentWarehouse].onHand = j;
          } else if (cn === 'allocated') {
            warehouseColumns[currentWarehouse].allocated = j;
          } else if (cn === 'on order') {
            warehouseColumns[currentWarehouse].onOrder = j;
          } else if (cn === 'in transit') {
            warehouseColumns[currentWarehouse].inTransit = j;
          }
        }
      }
    }
    
    console.log('=== WAREHOUSE COLUMNS MAPPED ===');
    console.log(JSON.stringify(warehouseColumns, null, 2));

    const warehouseCodes = Object.keys(warehouseColumns);
    if (warehouseCodes.length === 0) {
      return { error: 'No warehouse columns found. Make sure the report has warehouse names with "Available" columns.' };
    }

    // Parse data rows
    const dataRows = rows.slice(headerRowIdx + 1);
    const parsedLines = [];
    
    for (const row of dataRows) {
      // Get product code from the identified column
      const product = String(row[productColIdx] || '').trim();
      if (!product) continue;
      
      for (const wcode of warehouseCodes) {
        const cols = warehouseColumns[wcode];
        const available = parseFloat(row[cols.available]) || 0;
        const onHand = cols.onHand !== null ? (parseFloat(row[cols.onHand]) || 0) : null;
        const allocated = cols.allocated !== null ? (parseFloat(row[cols.allocated]) || 0) : null;
        const onOrder = cols.onOrder !== null ? (parseFloat(row[cols.onOrder]) || 0) : null;
        const inTransit = cols.inTransit !== null ? (parseFloat(row[cols.inTransit]) || 0) : null;
        
        parsedLines.push({
          product,  // Primary key - matches branch_avg_monthly_sales
          warehouse_code: wcode,
          qty_available: available,
          qty_on_hand: onHand,
          qty_allocated: allocated,
          qty_on_order: onOrder,
          qty_in_transit: inTransit
        });
      }
    }

    return {
      fileName,
      warehouses: warehouseCodes,
      lines: parsedLines,
      uniqueProducts: new Set(parsedLines.map(l => l.product)).size
    };
  }

  function showUploadPreview(parsed, fileName) {
    const dropZone = document.getElementById('dropZone');
    const preview = document.getElementById('uploadPreview');
    const summary = document.getElementById('uploadSummary');
    const headersRow = document.getElementById('previewHeaders');
    const tbody = document.getElementById('previewBody');
    const confirmBtn = document.getElementById('confirmUploadBtn');
    
    dropZone.className = 'drop-zone success';
    dropZone.innerHTML = `<span>✓ ${escapeHtml(fileName)}</span>`;
    
    summary.innerHTML = `
      <strong>${parsed.uniqueProducts}</strong> unique products across 
      <strong>${parsed.warehouses.length}</strong> warehouses: 
      ${parsed.warehouses.join(', ')}
    `;
    
    // Preview headers
    headersRow.innerHTML = '<th>Product</th><th>Warehouse</th><th>Available</th>';
    
    // Preview first 10 lines
    tbody.innerHTML = parsed.lines.slice(0, 10).map(l => `
      <tr>
        <td>${escapeHtml(l.product)}</td>
        <td>${escapeHtml(l.warehouse_code)}</td>
        <td style="text-align:right">${l.qty_available}</td>
      </tr>
    `).join('');
    
    if (parsed.lines.length > 10) {
      tbody.innerHTML += `<tr><td colspan="3" style="text-align:center;color:#64748b">... and ${parsed.lines.length - 10} more rows</td></tr>`;
    }
    
    preview.style.display = 'block';
    confirmBtn.disabled = false;
  }

  window.confirmUpload = async function() {
    if (!state.parsedData || !state.parsedData.lines.length) {
      alert('No data to upload');
      return;
    }

    const confirmBtn = document.getElementById('confirmUploadBtn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Uploading...';

    try {
      await window.supabaseReady;
      
      // Create snapshot
      const { data: snapshot, error: snapError } = await window.supabase
        .from('stock_snapshots')
        .insert({
          source: 'manual_upload',
          original_filename: state.parsedData.fileName,
          row_count: state.parsedData.lines.length
        })
        .select()
        .single();
      
      if (snapError) throw snapError;

      // Insert lines in batches
      const lines = state.parsedData.lines.map(l => ({
        snapshot_id: snapshot.id,
        ...l
      }));
      
      const batchSize = 500;
      for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize);
        const { error: lineError } = await window.supabase
          .from('stock_snapshot_lines')
          .insert(batch);
        
        if (lineError) throw lineError;
      }

      closeUploadModal();
      await loadLatestSnapshot();
      await loadBranchStatuses();
      
      alert(`Successfully uploaded ${lines.length} stock records!`);
      
    } catch (err) {
      console.error('Upload error:', err);
      alert('Error uploading: ' + err.message);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Upload & Process';
    }
  };

  // ============================================
  // AVG MANAGEMENT MODAL
  // ============================================
  
  window.openAvgManagementModal = async function() {
    document.getElementById('avgModal')?.classList.remove('hidden');
    await loadAvgData();
  };

  window.closeAvgManagementModal = function() {
    document.getElementById('avgModal')?.classList.add('hidden');
  };

  async function loadAvgData() {
    const tbody = document.getElementById('avgTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px">Loading...</td></tr>';

    try {
      await window.supabaseReady;
      
      // Supabase default limit is 1000, we need all records (2660+)
      const { data, error } = await window.supabase
        .from('branch_avg_monthly_sales')
        .select('*')
        .order('product')
        .limit(5000);  // Increase limit to get all products
      
      if (error) throw error;
      
      state.avgData = data || [];
      renderAvgTable(state.avgData);
      
    } catch (err) {
      console.error('Error loading AVG data:', err);
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#dc2626">Error loading data</td></tr>';
    }
  }

  function renderAvgTable(data) {
    const tbody = document.getElementById('avgTableBody');
    if (!tbody) return;
    
    // Update count display
    const countEl = document.getElementById('avgCount');
    if (countEl) {
      countEl.textContent = `Showing ${data.length} of ${state.avgData.length} products`;
    }
    
    if (!data.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#64748b">No data. Upload AVG via Supabase CSV import.</td></tr>';
      return;
    }
    
    tbody.innerHTML = data.map(row => `
      <tr data-product="${escapeHtml(row.product)}">
        <td style="font-weight:600">${escapeHtml(row.product || '')}</td>
        <td class="num">${(row.avg_mth_main || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_sydney || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_melbourne || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_brisbane || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_cairns || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_coffs_harbour || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_hobart || 0).toFixed(1)}</td>
        <td class="num">${(row.avg_mth_sunshine_coast || 0).toFixed(1)}</td>
      </tr>
    `).join('');
  }

  window.filterAvgTable = function() {
    const search = document.getElementById('avgSearchInput')?.value.toLowerCase() || '';
    const filtered = state.avgData.filter(row => {
      return (row.product || '').toLowerCase().includes(search);
    });
    renderAvgTable(filtered);
  };

  // AVG data is read-only (imported via Supabase CSV)
  // No edit/add/delete functions needed

  // ============================================
  // UTILITIES
  // ============================================
  
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

})();
