// Cyclic Count Management System

// FIXED PRODUCT ORDER - This is the master order used everywhere
const CUSTOM_PRODUCT_ORDER = [
  'DEK-ALBANY48-WH', 'DEK-ALBANY48-BK', 'DEK-ALBANY48-L-BK', 'DEK-ALBANY48-L-WH',
  'DEK-ALBANY52-BK', 'DEK-ALBANY52-L-BK', 'DEK-ALBANY52-L-WH', 'DEK-ALBANY52-WH',
  'DEK-EVOII50-BK', 'DEK-EVOII50-BK-DC', 'DEK-EVOII50-L-WH', 'DEK-EVOII50-L-WH-DC',
  'DEK-EVOII50-L-BK-DC', 'DEK-EVOII50-WH', 'DEK-EVOII50-WH-DC', 'DEK-EVOII58-BK',
  'DEK-EVOII58-BK-DC', 'DEK-EVOII58-L-BK', 'DEK-EVOII58-WH', 'DEK-EVOII58-WH-DC',
  'EP-HYB-240-RF-10', 'EP-HYB-RF-MOD', 'EP-RANG-RF-10', 'EP-SA-CONT-RF',
  'EP-VC-240-1', 'EP-VC-240-10', 'EP-VC-RF-MOD', 'DEK-HAWK48-L-WH',
  'DEK-HAWK48-L-WH-DC', 'DEK-HAWK48-WH', 'DEK-HAWK48-WH-DC', 'DEK-INGRAM-BK-DC',
  'DEK-INGRAM-L-BK', 'DEK-INGRAM-L-BK-DC', 'DEK-INGRAM-L-WH', 'DEK-INGRAM-L-WH-DC',
  'DEK-INGRAM-WH', 'DEK-INGRAM-WH-DC', 'DEK-RONDO52-L-BK', 'DEK-RONDO58-L-BK',
  'DEK-RONDOII52-L-WH', 'DEK-RONDOII52-L-BK', 'DEK-RONDOII52-WH', 'DEK-RONDOII58-BK',
  'DEK-RONDOII58-L-WH', 'DEK-RUSSELL-BK-DC', 'DEK-RUSSELL-L-BK-DC', 'DEK-RUSSELL-L-BK',
  'DEK-RUSSELL-L-WH', 'DEK-RUSSELL-L-WH-DC', 'DEK-RUSSELL-WH', 'DEK-RUSSELL-WH-DC',
  'R10', 'R10RF', 'R10RFB', 'R10RFP', 'R240', 'R240ACB', 'R240B', 'R240RC', 'R240RCB',
  'RAC', 'RAC240', 'RFMDUAL', 'RFMOD', 'RHA10RF', 'RHA240SL', 'RSDUALP', 'RSG4',
  'RWB', 'RWB2', 'RWBB', 'R360-SIMPLICITY-WH', 'VEN-DC31203-L-WH', 'VEN-DC31203-WH',
  'VEN-GLA1203-L-BK', 'VEN-GLA1203-L-WH', 'VEN-GLA1203-WH', 'VEN-GLA1303-BK',
  'VEN-GLA1303-L-WH', 'VEN-GLA1303-WH', 'VEN-SKY1203WH', 'VEN-SKY1203WH-L',
  'VEN-SKY1303BL', 'VEN-SKY1303-WH', 'VEN-SKY1303-WH-L', 'VEN-SKY1503-BL',
  'VEN-SKY1503-WH', 'VEN-SKY1503-WH-L', 'VEN-SPY0903-WH', 'VEN-SPY1253-L-WH',
  'VEN-SPY1253-WH', 'VEN-SPY1573-BK'
];

// Fast lookup map
let PRODUCT_ORDER_MAP = {};
CUSTOM_PRODUCT_ORDER.forEach((name, index) => {
  PRODUCT_ORDER_MAP[name] = index;
});

// Load product order from database - validates against master list
async function loadProductOrder() {
  try {
    await window.supabaseReady;
    
    // Get all active products
    const { data: products, error } = await window.supabase
      .from('audit_products')
      .select('product_name, sku_code')
      .eq('is_active', true);
    
    if (error) throw error;
    
    // Check for new products not in master list
    const newProducts = products.filter(p => !PRODUCT_ORDER_MAP.hasOwnProperty(p.product_name));
    
    if (newProducts.length > 0) {
      console.warn(`⚠️ ${newProducts.length} new product(s) not in master order (will appear at end):`);
      newProducts.forEach(p => console.warn(`   - ${p.sku_code}: ${p.product_name}`));
      
      // Add new products to the end
      newProducts.forEach(p => {
        CUSTOM_PRODUCT_ORDER.push(p.product_name);
        PRODUCT_ORDER_MAP[p.product_name] = CUSTOM_PRODUCT_ORDER.length - 1;
      });
    }
    
    console.log(`%c✅ Product order ready: ${CUSTOM_PRODUCT_ORDER.length} products (${products.length} active in DB)`, 'background: #22c55e; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
    console.log(`%cPosição 47 = ${CUSTOM_PRODUCT_ORDER[46]}`, 'background: #3b82f6; color: white; padding: 4px 8px; border-radius: 4px;');
    
    // Check if DEK-RUSSELL-L-BK-DC (SKU 94083) is in active products
    const dek94083 = products.find(p => p.sku_code === '94083' || p.product_name === 'DEK-RUSSELL-L-BK-DC');
    if (dek94083) {
      console.log(`%c✅ 94083 DEK-RUSSELL-L-BK-DC encontrado no banco!`, 'background: #10b981; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
    } else {
      console.error(`%c❌ 94083 DEK-RUSSELL-L-BK-DC NÃO encontrado no banco!`, 'background: #ef4444; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Error validating product order:', error);
    console.warn('⚠️ Using master order only');
    return false;
  }
}

// Sort products by custom order (fast lookup using map)
function sortProductsByOrder(products) {
  return products.sort((a, b) => {
    const orderA = PRODUCT_ORDER_MAP[a.product_name] ?? 9999;
    const orderB = PRODUCT_ORDER_MAP[b.product_name] ?? 9999;
    return orderA - orderB;
  });
}

// State management
const state = {
  warehouse: 'all',
  showCompletedOnly: false,
  showPendingOnly: false,
  page: 1,
  perPage: 100,
  allRows: [],
  rows: []
};

// Warehouse configuration
const warehouses = {
  'all': 'All Warehouses',
  'main': 'Main Warehouse',
  'sydney': 'Sydney',
  'melbourne': 'Melbourne',
  'sunshine-coast': 'Sunshine Coast',
  'hobart': 'Hobart',
  'cairns': 'Cairns',
  'coffs-harbour': 'Coffs Harbour',
  'brisbane': 'Brisbane'
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
  console.log('🔄 Cyclic Count page loading...');
  
  // Check PIN authentication
  if (!checkPinAuth()) {
    document.getElementById('pinInput').focus();
    return;
  }
  
  // Load product order from database FIRST
  await loadProductOrder();
  
  // Initialize sync status
  updateSyncStatus();
  
  await loadData();
  loadActiveSessions();
});

// PIN Authentication
const CORRECT_PIN = '4209';
const PIN_STORAGE_KEY = 'cyclicCountPinAuth';
const PIN_EXPIRY_HOURS = 24;

function checkPinAuth() {
  const stored = localStorage.getItem(PIN_STORAGE_KEY);
  if (stored) {
    const { timestamp } = JSON.parse(stored);
    const hoursSince = (Date.now() - timestamp) / (1000 * 60 * 60);
    if (hoursSince < PIN_EXPIRY_HOURS) {
      document.getElementById('pinModal').style.display = 'none';
      return true;
    }
  }
  return false;
}

window.validatePin = function() {
  const input = document.getElementById('pinInput');
  const error = document.getElementById('pinError');
  
  if (input.value === CORRECT_PIN) {
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({ timestamp: Date.now() }));
    document.getElementById('pinModal').style.display = 'none';
    error.style.display = 'none';
    loadData();
    loadActiveSessions();
  } else {
    error.style.display = 'block';
    input.value = '';
    input.focus();
  }
};

// Select warehouse
window.selectWarehouse = function(warehouse) {
  state.warehouse = warehouse;
  state.page = 1;
  
  // Store current warehouse globally for confirmation system
  window.currentWarehouse = warehouse;
  
  // Update button states
  document.querySelectorAll('.warehouse-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelector(`[data-warehouse="${warehouse}"]`).classList.add('active');
  
  // Show/hide sync banner - only in All Warehouses (if it exists)
  const syncBanner = document.getElementById('syncStatusBanner');
  if (syncBanner) {
    if (warehouse === 'all') {
      syncBanner.style.display = 'flex';
    } else {
      syncBanner.style.display = 'none';
    }
  }
  
  // Show/hide header action buttons
  const syncBtn = document.getElementById('syncBtn');
  const manageBtn = document.querySelector('[onclick="manageProducts()"]');
  const exportBtn = document.querySelector('[onclick="exportAnalysis()"]');
  const historyBtn = document.querySelector('[onclick="viewHistory()"]');
  
  if (warehouse === 'all') {
    // Show management buttons in All Warehouses view
    if (syncBtn) syncBtn.style.display = 'inline-block';
    if (manageBtn) manageBtn.style.display = 'inline-block';
    if (exportBtn) exportBtn.style.display = 'inline-block';
    if (historyBtn) historyBtn.style.display = 'inline-block';
  } else {
    // Hide management buttons in specific warehouse views
    if (syncBtn) syncBtn.style.display = 'none';
    if (manageBtn) manageBtn.style.display = 'none';
    if (exportBtn && syncBtn) exportBtn.style.display = 'none';
    if (historyBtn) historyBtn.style.display = 'none';
  }
  
  // Show/hide confirmation buttons based on view
  const confirmBtn = document.getElementById('confirmWarehouseBtn');
  const finalizeBtn = document.getElementById('finalizeCyclicBtn');
  
  if (warehouse === 'all') {
    // All Warehouses view: show Finalize button, hide Confirm button
    if (confirmBtn) confirmBtn.style.display = 'none';
    if (finalizeBtn) {
      finalizeBtn.style.display = 'inline-block';
      // Update finalize button state based on confirmation status
      if (typeof updateWarehouseVisualStatus === 'function') {
        updateWarehouseVisualStatus();
      }
    }
  } else {
    // Individual warehouse view: show Confirm button (if not confirmed), hide Finalize button
    if (finalizeBtn) finalizeBtn.style.display = 'none';
    if (confirmBtn) {
      // Check if this warehouse is already confirmed
      const isConfirmed = typeof isWarehouseConfirmed === 'function' ? isWarehouseConfirmed(warehouse) : false;
      if (isConfirmed) {
        confirmBtn.style.display = 'none';
      } else {
        confirmBtn.style.display = 'inline-block';
      }
    }
  }
  
  // Show/hide count link section
  const countLinkSection = document.getElementById('countLinkSection');
  if (warehouse !== 'all') {
    countLinkSection.style.display = 'block';
    // Clear previous link info when switching warehouses
    document.getElementById('countLinkInfo').style.display = 'none';
    loadActiveSessions();
  } else {
    countLinkSection.style.display = 'none';
    document.getElementById('countLinkInfo').style.display = 'none';
  }
  
  filterAndRender();
};

// Toggle filters
window.toggleCompletedOnly = function(checked) {
  state.showCompletedOnly = checked;
  if (checked) state.showPendingOnly = false;
  document.getElementById('showPendingOnly').checked = false;
  state.page = 1;
  filterAndRender();
};

window.togglePendingOnly = function(checked) {
  state.showPendingOnly = checked;
  if (checked) state.showCompletedOnly = false;
  document.getElementById('showCompletedOnly').checked = false;
  state.page = 1;
  filterAndRender();
};

// Load data from Supabase
async function loadData() {
  try {
    await window.supabaseReady;
    
    // Get latest audit run
    const { data: latestRun, error: runError } = await window.supabase
      .from('audit_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(1)
      .single();

    if (runError) {
      if (runError.code === 'PGRST116') {
        // No runs found - but we still need to show all products!
        console.log('ℹ️ No audit runs found - loading products only');
        
        // Load all products anyway
        const { data: products, error: prodError } = await window.supabase
          .from('audit_products')
          .select('*')
          .eq('is_active', true);
        
        if (prodError) throw prodError;
        
        if (!products || products.length === 0) {
          console.error('❌ No products found in audit_products table!');
          state.allRows = [];
          filterAndRender();
          return;
        }
        
        console.log(`%c📊 LOADED ${products.length} products (no runs yet)`, 'background: #8b5cf6; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
        
        // Sort products
        sortProductsByOrder(products);
        
        // Map products with no data
        const mappedData = products.map(product => {
          const sku = product.display_code || product.sku_code;
          return {
            sku: sku,
            product_name: product.product_name,
            product_id: product.id,
            total_system: 0,
            total_physical: 0,
            total_variance: 0,
            warehouses: {},
            worst_anomaly: 'none',
            last_updated: null,
            status: 'pending'
          };
        });
        
        console.log(`✅ Mapped ${mappedData.length} products (no analysis data)`);
        state.allRows = mappedData;
        filterAndRender();
        return;
      }
      throw runError;
    }

    console.log('📊 Loading audit data for run:', latestRun.id);
    state.currentRunId = latestRun.id; // Store for modal queries

    // Get analysis data
    const { data: analysisData, error: analysisError } = await window.supabase
      .from('audit_stock_analysis')
      .select('*')
      .eq('run_id', latestRun.id);

    if (analysisError) {
      console.error('Analysis error:', analysisError);
      throw analysisError;
    }

    console.log(`📦 Found ${analysisData?.length || 0} analysis records`);

    // Get all active products ALWAYS - this is the master list
    const { data: products, error: prodError } = await window.supabase
      .from('audit_products')
      .select('*')
      .eq('is_active', true);

    if (prodError) throw prodError;
    
    if (!products || products.length === 0) {
      console.error('❌ No products found in audit_products table!');
      state.allRows = [];
      filterAndRender();
      return;
    }
    
    console.log(`%c📊 LOADED ${products.length} active products from DB`, 'background: #8b5cf6; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
    
    // Check if 94083 is in the loaded products
    const dek94083 = products.find(p => p.sku_code === '94083');
    if (dek94083) {
      console.log(`%c✅ 94083 found: ${dek94083.product_name}`, 'background: #10b981; color: white; padding: 4px 8px; border-radius: 4px;');
    } else {
      console.error(`%c❌ 94083 NOT in loaded products!`, 'background: #ef4444; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
    }
    
    // Sort products by custom order using fast lookup
    sortProductsByOrder(products);
    
    console.log(`%c📋 After sort, first product: ${products[0]?.product_name}, position 47: ${products[46]?.product_name}`, 'background: #3b82f6; color: white; padding: 4px 8px; border-radius: 4px;');

    // Get all warehouses
    const { data: warehouses, error: whError } = await window.supabase
      .from('audit_warehouses')
      .select('*');

    if (whError) throw whError;

    // Create lookup maps
    const productLookup = {};
    products.forEach(p => productLookup[p.id] = p);
    
    const warehouseLookup = {};
    warehouses.forEach(w => warehouseLookup[w.id] = w);

    // Initialize productMap with ALL 93 products (even if no analysis data)
    const productMap = {};
    
    // FIRST: Create entries for ALL active products
    console.log(`📦 Initializing ALL ${products.length} products...`);
    products.forEach(product => {
      const sku = product.display_code || product.sku_code;
      productMap[sku] = {
        sku: sku,
        product_name: product.product_name,
        product_id: product.id,
        total_system: 0,
        total_physical: 0,
        total_variance: 0,
        warehouses: {},
        worst_anomaly: 'none',
        last_updated: null
      };
    });
    
    console.log(`✅ Initialized ${Object.keys(productMap).length} products in map`);
    console.log('🔍 Processing analysis data...');
    console.log('Products available:', products?.length);
    console.log('Warehouses available:', warehouses?.length);
    console.log('Analysis records:', analysisData?.length || 0);
    
    // SECOND: Update with analysis data (if exists)
    if (analysisData && analysisData.length > 0) {
      analysisData.forEach((row, index) => {
      const product = productLookup[row.product_id];
      const warehouse = warehouseLookup[row.warehouse_id];
      
      if (!product) {
        console.warn(`Product not found for ID: ${row.product_id}`);
        return;
      }
      
      if (!warehouse) {
        console.warn(`Warehouse not found for ID: ${row.warehouse_id}`);
        return;
      }
      
      const sku = product?.display_code || product?.sku_code || 'Unknown';
      
      if (index < 3) {
        console.log(`Sample row ${index}:`, {
          sku,
          product_name: product?.product_name,
          warehouse: warehouse?.name,
          qty: row.actual_qty_on_hand
        });
      }
      
      // Product already exists in map, just update values
      if (productMap[sku]) {
        // Aggregate totals (use expected_qty_on_hand as system count)
        productMap[sku].total_system += row.expected_qty_on_hand || 0;
        productMap[sku].total_physical += row.actual_qty_on_hand || 0;
        productMap[sku].total_variance += row.diff_qty || 0;
        productMap[sku].last_updated = row.created_at;
        
        // Store warehouse details for modal
        productMap[sku].warehouses[warehouse?.code || 'unknown'] = {
          name: warehouse?.name || 'Unknown',
          system_count: row.expected_qty_on_hand || 0,
          physical_count: row.actual_qty_on_hand,
          variance: row.diff_qty || 0,
          anomaly_level: row.anomaly_level,
          reason_guess: row.reason_guess,
          analysis_id: row.id
        };
        
        // Track worst anomaly
        if (!productMap[sku].worst_anomaly || 
            (row.anomaly_level === 'critical') ||
            (row.anomaly_level === 'warning' && productMap[sku].worst_anomaly !== 'critical')) {
          productMap[sku].worst_anomaly = row.anomaly_level;
        }
      }
      });
    } else {
      console.log('⚠️ No analysis data - all products will show as pending with 0 quantities');
    }
    
    // Convert to array and determine status
    const mappedData = Object.values(productMap).map(item => {
      let status = 'pending';
      
      // If has warehouse data, determine status based on anomaly
      if (Object.keys(item.warehouses).length > 0) {
        if (item.worst_anomaly === 'critical') {
          status = 'completed'; // Red flag
        } else if (item.worst_anomaly === 'warning') {
          status = 'in-progress'; // Yellow flag
        } else {
          status = 'completed'; // Green - normal
        }
      }
      // If no warehouse data, stays as 'pending'
      
      return {
        ...item,
        status: status
      };
    });
    
    console.log(`✅ Mapped ${mappedData.length} products (ALL products from audit_products)`);
    console.log('Sample mapped data:', mappedData.slice(0, 2));
    
    // Count products with data vs without data
    const withData = mappedData.filter(p => Object.keys(p.warehouses).length > 0).length;
    const withoutData = mappedData.length - withData;
    console.log(`📊 ${withData} products with warehouse data`);
    console.log(`⚠️  ${withoutData} products without data (will show as pending with 0 quantities)`);
    
    // Sort mapped data by custom order
    mappedData.sort((a, b) => {
      const indexA = CUSTOM_PRODUCT_ORDER.indexOf(a.product_name);
      const indexB = CUSTOM_PRODUCT_ORDER.indexOf(b.product_name);
      const orderA = indexA >= 0 ? indexA : 9999;
      const orderB = indexB >= 0 ? indexB : 9999;
      return orderA - orderB;
    });
    
    console.log(`✅ Final: ${mappedData.length} products ready to display`);
    
    state.allRows = mappedData;
    filterAndRender();
    
  } catch (error) {
    console.error('❌ Error loading cyclic count data:', error);
    console.error('Error details:', error);
    setTableError('Failed to load data: ' + error.message);
  }
}

// Mock data function removed - now using real Supabase data

// Filter and render
function filterAndRender() {
  let filtered;
  
  console.log(`%c🎯 filterAndRender called - state.allRows has ${state.allRows.length} products`, 'background: #6366f1; color: white; padding: 4px 8px; border-radius: 4px;');
  
  // Check for DEK-RUSSELL-L-BK-DC in allRows
  const dek = state.allRows.find(p => p.product_name === 'DEK-RUSSELL-L-BK-DC');
  if (dek) {
    console.log(`%c✅ DEK-RUSSELL-L-BK-DC found in allRows (SKU: ${dek.sku})`, 'background: #10b981; color: white; padding: 4px 8px; border-radius: 4px;');
  } else {
    console.error(`%c❌ DEK-RUSSELL-L-BK-DC NOT in allRows!`, 'background: #ef4444; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
  }
  
  // Different logic for "all" vs individual warehouse
  if (state.warehouse === 'all') {
    // Use aggregated product view (already in state.allRows)
    filtered = state.allRows;
  } else {
    // Expand to individual warehouse rows
    filtered = [];
    state.allRows.forEach(product => {
      const wh = product.warehouses[state.warehouse];
      if (wh) {
        filtered.push({
          sku: product.sku,
          product_name: product.product_name,
          warehouse: state.warehouse,
          warehouse_name: wh.name,
          system_count: wh.system_count,
          physical_count: wh.physical_count,
          variance: wh.variance,
          anomaly_level: wh.anomaly_level,
          status: wh.physical_count === null || wh.physical_count === undefined ? 'pending' :
                  wh.anomaly_level === 'critical' ? 'completed' : 
                  wh.anomaly_level === 'warning' ? 'in-progress' : 'completed',
          reason_guess: wh.reason_guess,
          analysis_id: wh.analysis_id,
          last_updated: product.last_updated
        });
      }
    });
    
    console.log(`🔍 Filtered ${filtered.length} products for warehouse: ${state.warehouse}`);
    console.log('Available warehouses:', state.allRows[0] ? Object.keys(state.allRows[0].warehouses) : 'none');
  }
  
  // Filter by status
  if (state.showCompletedOnly) {
    filtered = filtered.filter(r => r.status === 'completed');
  } else if (state.showPendingOnly) {
    filtered = filtered.filter(r => r.status === 'pending');
  }
  
  state.rows = filtered;
  render(filtered);
}

// Render table
function render(rows) {
  const tbody = document.getElementById('cyclicCountBody');
  const thead = document.getElementById('cyclicCountHead');
  
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:60px;">
      <div style="color:#64748b;font-size:18px;margin-bottom:12px">📤 No data available</div>
      <div style="color:#94a3b8;font-size:14px">Click "📤 Upload Reports" button above to import CIN7 data</div>
    </td></tr>`;
    updateProductCount(0);
    return;
  }
  
  // Update table header based on mode
  if (state.warehouse === 'all') {
    // Compact header for overview mode
    thead.innerHTML = `
      <tr>
        <th>SKU</th>
        <th>Product</th>
        <th style="text-align:center">Total System</th>
        <th style="text-align:center">Total Physical</th>
        <th style="text-align:center">Variance</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    `;
  } else {
    // Detailed header for individual warehouse mode
    thead.innerHTML = `
      <tr>
        <th>SKU</th>
        <th>Product</th>
        <th>Warehouse</th>
        <th style="text-align:center">System Count</th>
        <th style="text-align:center">Physical Count</th>
        <th style="text-align:center">Variance</th>
        <th>Status</th>
        <th>Last Updated</th>
        <th>Actions</th>
      </tr>
    `;
  }
  
  // Pagination
  const start = (state.page - 1) * state.perPage;
  const end = start + state.perPage;
  const pageRows = rows.slice(start, end);
  
  const html = pageRows.map(row => renderRow(row)).join('');
  tbody.innerHTML = html;
  
  updateProductCount(rows.length);
  updatePagination(rows.length);
}

// Render single row - different format based on mode
function renderRow(row) {
  const statusClass = row.status;
  const statusLabel = {
    'pending': 'Pending',
    'in-progress': 'In Progress',
    'completed': 'Completed'
  }[row.status] || row.status;
  
  // Overview mode (All Warehouses) - compact view
  if (state.warehouse === 'all') {
    const varianceColor = row.total_variance === 0 ? '#64748b' : 
                         row.total_variance > 0 ? '#16a34a' : '#dc2626';
    
    const varianceDisplay = row.total_variance > 0 ? `+${row.total_variance}` : row.total_variance;
    
    return `
      <tr>
        <td><strong>${escapeHtml(row.sku)}</strong></td>
        <td>${escapeHtml(row.product_name)}</td>
        <td style="text-align:center;font-weight:500">${row.total_system}</td>
        <td style="text-align:center;font-weight:500">${row.total_physical || '—'}</td>
        <td style="text-align:center;color:${varianceColor};font-weight:600">${varianceDisplay}</td>
        <td><span class="count-status ${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="search-btn-small" onclick="openDetailsModal('${escapeHtml(row.sku)}')">
            📊 View Details
          </button>
        </td>
      </tr>
    `;
  } else {
    // Individual warehouse mode - detailed view
    const varianceColor = row.variance === 0 ? '#64748b' : 
                         row.variance > 0 ? '#16a34a' : 
                         row.variance < 0 ? '#dc2626' : '#64748b';
    
    const varianceDisplay = row.variance > 0 ? `+${row.variance}` : row.variance;
    
    return `
      <tr>
        <td><strong>${escapeHtml(row.sku)}</strong></td>
        <td>${escapeHtml(row.product_name)}</td>
        <td>${escapeHtml(row.warehouse_name)}</td>
        <td style="text-align:center">${row.system_count}</td>
        <td class="editable-cell" style="text-align:center;cursor:pointer" onclick="editPhysicalCount(this, '${row.analysis_id}', ${row.physical_count})">
          <span class="physical-count-value">${row.physical_count !== null ? row.physical_count : '—'}</span>
        </td>
        <td style="text-align:center;color:${varianceColor};font-weight:500">${varianceDisplay}</td>
        <td><span class="count-status ${statusClass}">${statusLabel}</span></td>
        <td style="font-size:0.85em;color:#64748b">${formatDate(row.last_updated)}</td>
        <td>
          <button class="search-btn-small" onclick="openDetailsModal('${escapeHtml(row.sku)}')">
            📊 View
          </button>
        </td>
      </tr>
    `;
  }
}

// Helper functions
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-AU', { 
    day: '2-digit', 
    month: 'short', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function updateProductCount(count) {
  console.log(`%c🔢 Updating product count display: ${count}`, 'background: #f59e0b; color: white; padding: 4px 8px; border-radius: 4px; font-weight: bold;');
  document.getElementById('productCount').textContent = `${count} product${count !== 1 ? 's' : ''}`;
}

function updatePagination(totalRows) {
  const totalPages = Math.ceil(totalRows / state.perPage);
  document.getElementById('pageInfo').textContent = `Page ${state.page} of ${totalPages}`;
  document.getElementById('prevPage').disabled = state.page === 1;
  document.getElementById('nextPage').disabled = state.page >= totalPages;
}

function setTableError(message) {
  const tbody = document.getElementById('cyclicCountBody');
  tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;color:#dc2626">${message}</td></tr>`;
}

// Pagination controls
window.prevPage = function() {
  if (state.page > 1) {
    state.page--;
    filterAndRender();
  }
};

window.nextPage = function() {
  const totalPages = Math.ceil(state.rows.length / state.perPage);
  if (state.page < totalPages) {
    state.page++;
    filterAndRender();
  }
};

// Action handlers
window.createNewCount = async function() {
  if (!confirm('This will trigger a new weekly stock audit run.\n\nThis process may take several minutes as it syncs CIN7 data and generates analysis.\n\nContinue?')) {
    return;
  }

  try {
    console.log('🔄 Triggering new audit run...');
    
    // Calculate current week dates
    const today = new Date();
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const periodStart = monday.toISOString().split('T')[0];
    const periodEnd = sunday.toISOString().split('T')[0];

    // Show loading state
    const originalText = document.querySelector('.page-header h1').textContent;
    document.querySelector('.page-header h1').textContent = 'Running Audit... Please wait';
    
    // Call backend API
    const response = await fetch('/api/audit/run-weekly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periodStart, periodEnd })
    });

    const result = await response.json();
    
    // Restore header
    document.querySelector('.page-header h1').textContent = originalText;

    if (response.ok && result.success) {
      alert(`✅ Audit completed successfully!\n\nRun ID: ${result.run_id}\nPeriod: ${result.period_start} to ${result.period_end}\nAnalysis records: ${result.analysis_records}\n\nReloading data...`);
      await loadData(); // Reload data
    } else {
      throw new Error(result.error || 'Unknown error');
    }

  } catch (error) {
    console.error('❌ Error creating new count:', error);
    
    // Restore header
    const header = document.querySelector('.page-header h1');
    if (header.textContent.includes('Running')) {
      header.textContent = 'Cyclic Count Management';
    }
    
    let errorMsg = error.message;
    
    // Provide helpful error messages
    if (errorMsg.includes('fetch') || errorMsg.includes('NetworkError')) {
      errorMsg = 'Cannot connect to backend server. Make sure the server is running (npm start).';
    } else if (errorMsg.includes('Backend Supabase not configured')) {
      errorMsg = 'Backend not configured. Please set SUPABASE_SERVICE_KEY in .env file.\n\nAlternatively, run: npm run audit';
    }
    
    alert('Failed to create new count session:\n\n' + errorMsg + '\n\nYou can also run manually:\nnpm run audit');
  }
};

window.exportReport = function() {
  try {
    if (!state.rows || state.rows.length === 0) {
      alert('No data to export');
      return;
    }

    // Build CSV header
    const headers = [
      'Session ID',
      'SKU',
      'Product Name',
      'Warehouse',
      'System Count',
      'Physical Count',
      'Variance',
      'Status',
      'Last Updated'
    ];

    // Build CSV rows
    const csvRows = [headers.join(',')];

    for (const row of state.rows) {
      const csvRow = [
        escapeCSV(row.session_id),
        escapeCSV(row.sku),
        escapeCSV(row.product_name),
        escapeCSV(warehouses[row.warehouse] || row.warehouse),
        row.system_count || 0,
        row.physical_count !== null ? row.physical_count : '',
        row.variance || 0,
        escapeCSV(row.status),
        escapeCSV(formatDate(row.last_updated))
      ];
      csvRows.push(csvRow.join(','));
    }

    // Create CSV blob and download
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    
    const timestamp = new Date().toISOString().split('T')[0];
    const warehouseName = state.warehouse === 'all' ? 'All-Warehouses' : warehouses[state.warehouse] || state.warehouse;
    link.download = `cyclic-count-${warehouseName}-${timestamp}.csv`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    console.log(`✅ Exported ${state.rows.length} rows to CSV`);

  } catch (error) {
    console.error('❌ Error exporting report:', error);
    alert('Failed to export report: ' + error.message);
  }
};

function escapeCSV(str) {
  if (str === null || str === undefined) return '';
  const stringValue = String(str);
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

// Modal functions
window.openDetailsModal = async function(sku) {
  try {
    // Find product in current data
    const product = state.allRows.find(r => r.sku === sku);
    
    if (!product) {
      alert('Product not found');
      return;
    }

    // Set modal title
    const warehouseContext = state.warehouse === 'all' ? 'All Warehouses' : warehouses[state.warehouse] || state.warehouse;
    document.getElementById('modalProductTitle').textContent = `${sku} - ${product.product_name} [${warehouseContext}]`;
    
    // Show modal
    document.getElementById('detailsModal').style.display = 'flex';
    
    // Populate warehouse breakdown
    const warehouseBreakdown = document.getElementById('warehouseBreakdown');
    
    // Filter warehouses based on current selection
    let warehouseEntries;
    if (state.warehouse === 'all') {
      // Show all warehouses
      warehouseEntries = Object.entries(product.warehouses);
    } else {
      // Show only the selected warehouse
      const selectedWh = product.warehouses[state.warehouse];
      if (selectedWh) {
        warehouseEntries = [[state.warehouse, selectedWh]];
      } else {
        warehouseEntries = [];
      }
    }
    
    if (warehouseEntries.length === 0) {
      warehouseBreakdown.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b">No warehouse data</td></tr>';
    } else {
      warehouseBreakdown.innerHTML = warehouseEntries.map(([code, wh]) => {
        const varianceColor = wh.variance === 0 ? '#64748b' : 
                             wh.variance > 0 ? '#16a34a' : '#dc2626';
        const statusClass = wh.anomaly_level === 'critical' ? 'completed' : 
                           wh.anomaly_level === 'warning' ? 'in-progress' : 'completed';
        const statusLabel = wh.anomaly_level === 'critical' ? 'Critical' : 
                           wh.anomaly_level === 'warning' ? 'Warning' : 'OK';
        
        return `
          <tr>
            <td><strong>${wh.name}</strong></td>
            <td style="text-align:center">${wh.system_count}</td>
            <td style="text-align:center">${wh.physical_count || '—'}</td>
            <td style="text-align:center;color:${varianceColor};font-weight:600">
              ${wh.variance > 0 ? '+' : ''}${wh.variance}
            </td>
            <td>
              <span class="count-status ${statusClass}">${statusLabel}</span>
            </td>
          </tr>
        `;
      }).join('');
    }
    
    // Load special locations (filtered by warehouse if individual mode)
    await loadSpecialLocations(sku);
    
    // Load problematic orders (filtered by warehouse if individual mode)
    await loadProblematicOrders(sku, product.product_id);

  } catch (error) {
    console.error('❌ Error opening details modal:', error);
    alert('Failed to load details: ' + error.message);
  }
};

window.closeDetailsModal = function() {
  document.getElementById('detailsModal').style.display = 'none';
};

async function loadSpecialLocations(sku) {
  const container = document.getElementById('specialLocations');
  container.innerHTML = '<div style="color:#64748b;padding:12px">Loading special locations...</div>';
  
  try {
    await window.supabaseReady;
    
    // Query core_availability_snap for special locations
    const { data, error } = await window.supabase
      .from('core_availability_snap')
      .select('Location, Available')
      .eq('SKU', sku)
      .in('Location', ['GHOST', 'FAULTY', 'DAMAGED', 'RETURN', 'QUARANTINE']);
    
    if (error) {
      console.error('[loadSpecialLocations] Error:', error);
      container.innerHTML = '<div style="color:#ef4444;padding:12px">Error loading special locations</div>';
      return;
    }
    
    if (!data || data.length === 0) {
      container.innerHTML = '<div style="color:#64748b;padding:12px">No stock found in special locations (Ghost, Faulty, etc.)</div>';
      return;
    }
    
    // Group by location
    const locationTotals = {};
    data.forEach(row => {
      const loc = row.Location || 'UNKNOWN';
      locationTotals[loc] = (locationTotals[loc] || 0) + (row.Available || 0);
    });
    
    container.innerHTML = Object.entries(locationTotals).map(([location, qty]) => `
      <div class="location-card">
        <div class="location-card-title">${location}</div>
        <div class="location-card-value">${qty}</div>
      </div>
    `).join('');
    
  } catch (err) {
    console.error('[loadSpecialLocations] Unexpected error:', err);
    container.innerHTML = '<div style="color:#ef4444;padding:12px">Unexpected error</div>';
  }
}

async function loadProblematicOrders(sku, productId) {
  const container = document.getElementById('problematicOrders');
  container.innerHTML = '<div style="color:#64748b;padding:12px">Loading problematic orders...</div>';
  
  try {
    await window.supabaseReady;
    
    // Build query - filter by warehouse if in individual mode
    let query = window.supabase
      .from('audit_order_aggregates')
      .select(`
        *,
        audit_warehouses:warehouse_id (code, name)
      `)
      .eq('run_id', state.currentRunId)
      .eq('product_id', productId);
    
    // If not in "all" mode, filter by specific warehouse
    if (state.warehouse !== 'all') {
      // Get warehouse_id from product data
      const product = state.allRows.find(r => r.sku === sku);
      const whData = product?.warehouses[state.warehouse];
      if (whData && whData.analysis_id) {
        // Need to get warehouse_id - query analysis record
        const { data: analysisData } = await window.supabase
          .from('audit_stock_analysis')
          .select('warehouse_id')
          .eq('product_id', productId)
          .eq('run_id', state.currentRunId)
          .limit(1)
          .single();
        
        if (analysisData) {
          // Get all warehouse IDs for this warehouse code
          const { data: whIds } = await window.supabase
            .from('audit_warehouses')
            .select('id')
            .eq('code', state.warehouse);
          
          if (whIds && whIds.length > 0) {
            query = query.eq('warehouse_id', whIds[0].id);
          }
        }
      }
    }
    
    // Apply volume filter
    query = query.or('total_quantity.gt.50,order_count.gt.5');
    
    const { data, error } = await query;
    
    if (error) {
      console.error('[loadProblematicOrders] Error:', error);
      container.innerHTML = '<div style="color:#ef4444;padding:12px">Error loading orders</div>';
      return;
    }
    
    if (!data || data.length === 0) {
      container.innerHTML = '<div style="color:#64748b;padding:12px">✅ No problematic orders detected</div>';
      return;
    }
    
    container.innerHTML = data.map(order => {
      const reasons = [];
      if (order.total_quantity > 50) {
        reasons.push(`High volume: ${order.total_quantity} units ordered`);
      }
      if (order.order_count > 5) {
        reasons.push(`High frequency: ${order.order_count} orders`);
      }
      
      const reasonText = reasons.join('; ');
      const warehouseName = order.audit_warehouses?.name || 'Unknown Warehouse';
      
      return `
        <div class="order-issue-card">
          <div class="order-issue-header">
            <span class="order-issue-id">📍 ${warehouseName}</span>
            <span class="order-issue-date">${new Date(order.period_start).toLocaleDateString('en-AU')} - ${new Date(order.period_end).toLocaleDateString('en-AU')}</span>
          </div>
          <div style="display:flex;gap:16px;margin-top:8px;font-size:0.9em">
            <div><strong>Orders:</strong> ${order.order_count}</div>
            <div><strong>Total Qty:</strong> ${order.total_quantity}</div>
            <div><strong>Avg/Order:</strong> ${order.avg_quantity_per_order?.toFixed(1) || 'N/A'}</div>
          </div>
          <div class="order-issue-reason">
            <strong>⚠️ Probable Cause:</strong> ${reasonText}
          </div>
        </div>
      `;
    }).join('');
    
  } catch (err) {
    console.error('[loadProblematicOrders] Unexpected error:', err);
    container.innerHTML = '<div style="color:#ef4444;padding:12px">Unexpected error</div>';
  }
}

// Close modal on background click
document.addEventListener('click', function(e) {
  const modal = document.getElementById('detailsModal');
  if (e.target === modal) {
    closeDetailsModal();
  }
});

// Count Link Generator Functions
window.openGenerateLinkModal = function() {
  if (state.warehouse === 'all') {
    alert('⚠️ Please select a specific warehouse first');
    return;
  }
  document.getElementById('generateLinkModal').style.display = 'flex';
  document.getElementById('linkWarehouseSelect').value = state.warehouse;
};

window.closeGenerateLinkModal = function() {
  document.getElementById('generateLinkModal').style.display = 'none';
};

window.createCountSession = async function() {
  const warehouseCode = document.getElementById('linkWarehouseSelect').value;
  const expiresHours = parseInt(document.getElementById('linkExpiresSelect').value);
  
  if (!warehouseCode) {
    alert('Please select a warehouse');
    return;
  }
  
  try {
    await window.supabaseReady;
    
    // Get warehouse ID
    const { data: warehouse } = await window.supabase
      .from('audit_warehouses')
      .select('id, name')
      .eq('code', warehouseCode)
      .single();
    
    if (!warehouse) {
      alert('Warehouse not found');
      return;
    }
    
    // Generate unique token
    const token = `${warehouseCode.toUpperCase()}-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`.toUpperCase();
    
    // Create session
    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000);
    
    const { data: session, error } = await window.supabase
      .from('count_sessions')
      .insert({
        warehouse_id: warehouse.id,
        run_id: state.currentRunId,
        session_token: token,
        status: 'pending',
        expires_at: expiresAt.toISOString()
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Create session items
    const products = state.allRows
      .filter(p => p.warehouses[warehouseCode])
      .map(p => {
        const wh = p.warehouses[warehouseCode];
        return {
          session_id: session.id,
          product_id: p.product_id,
          system_count: wh.system_count,
          physical_count: null
        };
      });
    
    await window.supabase
      .from('count_session_items')
      .insert(products);
    
    // Show link
    const url = `${window.location.origin}/count-form.html?token=${token}`;
    document.getElementById('generatedLink').value = url;
    document.getElementById('linkWarehouse').textContent = warehouse.name;
    document.getElementById('linkCreated').textContent = new Date().toLocaleString('en-AU');
    document.getElementById('linkExpires').textContent = expiresAt.toLocaleString('en-AU');
    document.getElementById('linkStatus').textContent = 'Awaiting Count';
    document.getElementById('linkStatus').className = 'count-status pending';
    document.getElementById('countLinkInfo').style.display = 'block';
    document.getElementById('countLinkSection').style.display = 'block';
    
    closeGenerateLinkModal();
    
    alert('✅ Count link generated successfully!');
    
  } catch (error) {
    console.error('Error creating count session:', error);
    alert('Error creating count session: ' + error.message);
  }
};

window.copyCountLink = function() {
  const input = document.getElementById('generatedLink');
  input.select();
  document.execCommand('copy');
  alert('✅ Link copied to clipboard!');
};

async function loadActiveSessions() {
  try {
    await window.supabaseReady;
    
    // Get latest session for current warehouse
    if (state.warehouse === 'all') return;
    
    const { data: warehouse } = await window.supabase
      .from('audit_warehouses')
      .select('id, name')
      .eq('code', state.warehouse)
      .single();
    
    if (!warehouse) return;
    
    const { data: session } = await window.supabase
      .from('count_sessions')
      .select('*')
      .eq('warehouse_id', warehouse.id)
      .eq('run_id', state.currentRunId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (session) {
      const url = `${window.location.origin}/count-form.html?token=${session.session_token}`;
      document.getElementById('generatedLink').value = url;
      document.getElementById('linkWarehouse').textContent = warehouse.name;
      document.getElementById('linkCreated').textContent = new Date(session.created_at).toLocaleString('en-AU');
      document.getElementById('linkExpires').textContent = new Date(session.expires_at).toLocaleString('en-AU');
      
      const statusMap = {
        'pending': { text: 'Awaiting Count', class: 'pending' },
        'submitted': { text: 'Completed ✓', class: 'completed' }
      };
      const status = statusMap[session.status] || statusMap['pending'];
      document.getElementById('linkStatus').textContent = status.text;
      document.getElementById('linkStatus').className = `count-status ${status.class}`;
      
      document.getElementById('countLinkInfo').style.display = 'block';
      document.getElementById('countLinkSection').style.display = 'block';
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
  }
}

// Inline editing for Physical Count
window.editPhysicalCount = function(cell, analysisId, currentValue) {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = currentValue !== null && currentValue !== undefined ? currentValue : '';
  input.className = 'editable-cell-input';
  input.style.width = '80px';
  input.style.padding = '4px 8px';
  input.style.border = '2px solid #4f46e5';
  input.style.borderRadius = '4px';
  input.style.textAlign = 'center';
  
  const originalContent = cell.innerHTML;
  cell.innerHTML = '';
  cell.appendChild(input);
  input.focus();
  input.select();
  
  const saveEdit = async () => {
    const newValue = input.value.trim() === '' ? null : parseInt(input.value);
    
    try {
      await window.supabaseReady;
      
      const { error } = await window.supabase
        .from('audit_stock_analysis')
        .update({ 
          physical_count: newValue,
          updated_at: new Date().toISOString()
        })
        .eq('id', analysisId);
      
      if (error) throw error;
      
      // Update cell display
      cell.innerHTML = originalContent;
      cell.querySelector('.physical-count-value').textContent = newValue !== null ? newValue : '—';
      cell.onclick = function() { editPhysicalCount(cell, analysisId, newValue); };
      
      console.log(`✅ Updated physical count for ${analysisId}: ${newValue}`);
      
      // Reload data to update variance
      setTimeout(() => loadData(), 300);
      
    } catch (error) {
      console.error('Error updating physical count:', error);
      alert('Error saving: ' + error.message);
      cell.innerHTML = originalContent;
    }
  };
  
  const cancelEdit = () => {
    cell.innerHTML = originalContent;
    cell.onclick = function() { editPhysicalCount(cell, analysisId, currentValue); };
  };
  
  input.addEventListener('blur', saveEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
};

// ==========================================
// NEW FEATURES: Sync, Product Management, Analysis, History
// ==========================================

// Manual Sync with Daily Limit
window.manualSync = async function() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const syncKey = `cyclicCountSync_${today}`;
    const syncData = JSON.parse(localStorage.getItem(syncKey) || '{"count":0}');
    
    if (syncData.count >= 3) {
      alert('❌ Daily sync limit reached (3/3). Try again tomorrow.');
      return;
    }
    
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing...';
    
    await window.supabaseReady;
    
    // Just reload the latest data - sync happens automatically via triggers or manual backend runs
    // This button is just to refresh the view
    await loadData();
    
    // Update sync counter
    syncData.count++;
    syncData.lastSync = new Date().toISOString();
    localStorage.setItem(syncKey, JSON.stringify(syncData));
    
    updateSyncStatus();
    
    alert(`✅ Data refreshed successfully!`);
    
    btn.textContent = '🔄 Manual Sync';
    btn.disabled = syncData.count >= 3;
    if (btn.disabled) btn.style.opacity = '0.5';
    
  } catch (error) {
    console.error('Sync error:', error);
    alert('❌ Refresh failed: ' + error.message);
    const btn = document.getElementById('syncBtn');
    btn.textContent = '🔄 Manual Sync';
    btn.disabled = false;
  }
};

function updateSyncStatus() {
  const banner = document.getElementById('syncStatusBanner');
  if (!banner) {
    console.warn('⚠️ syncStatusBanner element not found');
    return;
  }
  
  const today = new Date().toISOString().split('T')[0];
  const syncKey = `cyclicCountSync_${today}`;
  const syncData = JSON.parse(localStorage.getItem(syncKey) || '{"count":0}');
  
  banner.style.display = 'flex';
  
  const lastSyncTime = document.getElementById('lastSyncTime');
  if (lastSyncTime && syncData.lastSync) {
    lastSyncTime.textContent = new Date(syncData.lastSync).toLocaleString('en-AU');
  }
  
  const syncCount = document.getElementById('syncCount');
  if (syncCount) {
    syncCount.textContent = `${syncData.count}/3`;
  }
  
  const btn = document.getElementById('syncBtn');
  if (btn && syncData.count >= 3) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.textContent = '✓ Synced Today';
  }
}

// Manage Products Modal
window.manageProducts = function() {
  document.getElementById('manageProductsModal').style.display = 'flex';
  document.getElementById('productSearchInput').value = '';
  document.getElementById('searchResults').style.display = 'none';
  loadProductsList();
};

window.closeManageProductsModal = function() {
  document.getElementById('manageProductsModal').style.display = 'none';
};

// Search available products from audit_products AND Products table
window.searchAvailableProducts = async function() {
  const searchTerm = document.getElementById('productSearchInput').value.trim().toUpperCase();
  
  if (!searchTerm || searchTerm.length < 2) {
    document.getElementById('searchResults').style.display = 'none';
    return;
  }
  
  try {
    await window.supabaseReady;
    
    // Get products already in audit list
    const { data: auditProducts } = await window.supabase
      .from('audit_products')
      .select('sku_code, display_code')
      .eq('is_active', true);
    
    const activeAuditSkus = new Set();
    auditProducts?.forEach(p => {
      if (p.sku_code) activeAuditSkus.add(p.sku_code.toUpperCase());
      if (p.display_code) activeAuditSkus.add(p.display_code.toUpperCase());
    });
    
    // Search ONLY in Products table for products not yet in audit
    const { data: productsTable, error: prodError } = await window.supabase
      .from('Products')
      .select('*')
      .or(`SKU.ilike.%${searchTerm}%,Code.ilike.%${searchTerm}%`)
      .limit(50);
    
    if (prodError) throw prodError;
    
    const resultsDiv = document.getElementById('searchResultsList');
    const searchResultsContainer = document.getElementById('searchResults');
    
    // Filter out products already in audit
    const availableProducts = [];
    if (productsTable) {
      productsTable.forEach(p => {
        const sku = p.SKU;
        if (sku && !activeAuditSkus.has(sku.toUpperCase())) {
          availableProducts.push({
            sku: p.SKU,
            name: p.Code,
            source: 'products'
          });
        }
      });
    }
    
    if (availableProducts.length === 0) {
      resultsDiv.innerHTML = '<div style="text-align:center;color:#64748b;padding:12px">No products found or all matching products are already in audit list</div>';
    } else {
      resultsDiv.innerHTML = availableProducts.map(p => {
        return `
          <div class="product-item" style="margin-bottom:8px">
            <div>
              <span style="font-weight:600">${p.sku || 'N/A'}</span>
              <span style="margin-left:12px;color:#64748b">${p.name || 'N/A'}</span>
            </div>
            <button class="search-btn-small" onclick="addProductToAudit(null, '${p.sku || ''}', '${(p.name || '').replace(/'/g, "\\'")}', '${p.source}')">➕ Add</button>
          </div>
        `;
      }).join('');
    }
    
    searchResultsContainer.style.display = 'block';
    
  } catch (error) {
    console.error('Error searching products:', error);
    alert('Error searching: ' + error.message);
  }
};

// Add product to audit list (reactivate existing or create new from Products table)
window.addProductToAudit = async function(productId, sku, name, source) {
  if (!confirm(`Add ${sku || name} to audit list?`)) return;
  
  try {
    await window.supabaseReady;
    
    // Check if product already exists (and is active)
    const { data: existing } = await window.supabase
      .from('audit_products')
      .select('id, is_active')
      .eq('sku_code', sku)
      .single();
    
    if (existing && existing.is_active) {
      alert('⚠️ This product is already in the audit list');
      document.getElementById('productSearchInput').value = '';
      document.getElementById('searchResults').style.display = 'none';
      return;
    }
    
    // If exists but inactive, reactivate instead of inserting
    if (existing && !existing.is_active) {
      const { error: updateError } = await window.supabase
        .from('audit_products')
        .update({ is_active: true })
        .eq('id', existing.id);
      
      if (updateError) {
        console.error('Reactivate error:', updateError);
        throw updateError;
      }
      
      alert(`✅ ${sku || name} reactivated in audit list!`);
      
      // Clear search
      document.getElementById('productSearchInput').value = '';
      document.getElementById('searchResults').style.display = 'none';
      
      // Reload lists
      await loadProductsList();
      await loadData();
      return;
    }
    
    // Insert new product
    const { error } = await window.supabase
      .from('audit_products')
      .insert({
        sku_code: sku || null,
        display_code: sku || null,
        product_name: name || null,
        is_active: true
      });
    
    if (error) {
      console.error('Insert error:', error);
      throw error;
    }
    
    alert(`✅ ${sku || name} added to audit list!`);
    
    // Clear search
    document.getElementById('productSearchInput').value = '';
    document.getElementById('searchResults').style.display = 'none';
    
    // Reload lists
    await loadProductsList();
    await loadData();
    
  } catch (error) {
    console.error('Error adding product:', error);
    alert('❌ Error: ' + error.message + '\n\nCheck browser console for details.');
  }
};

async function loadProductsList() {
  try {
    await window.supabaseReady;
    
    const { data: products, error } = await window.supabase
      .from('audit_products')
      .select('*')
      .eq('is_active', true);
    
    if (error) throw error;
    
    // Sort products by custom order using fast lookup
    sortProductsByOrder(products);
    
    const container = document.getElementById('productsList');
    const countSpan = document.getElementById('auditProductCount');
    
    if (countSpan) countSpan.textContent = products?.length || 0;
    
    if (!products || products.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#64748b;padding:20px">No products in audit list. Use search above to add products.</div>';
      return;
    }
    
    container.innerHTML = products.map(p => {
      const sku = escapeHtml(p.display_code || p.sku_code || 'N/A');
      const name = escapeHtml(p.product_name || 'N/A');
      return `
        <div class="product-item">
          <div>
            <span style="font-weight:600">${sku}</span>
            <span style="margin-left:12px;color:#64748b">${name}</span>
          </div>
          <button class="search-btn-small secondary" onclick="removeProductFromAudit('${p.id}', '${(p.display_code || p.sku_code || 'N/A').replace(/'/g, "\\'")}')" style="padding:4px 12px">🗑️ Remove</button>
        </div>
      `;
    }).join('');
    
  } catch (error) {
    console.error('Error loading products:', error);
  }
}

// Remove product from audit list (soft delete - preserves history)
window.removeProductFromAudit = async function(productId, sku) {
  const choice = confirm(`Remove ${sku} from audit list?\n\nThe product will be hidden but historical data is preserved.\nYou can add it back later.\n\nClick OK to REMOVE`);
  
  if (!choice) return;
  
  try {
    await window.supabaseReady;
    
    // Soft delete: set is_active = false (preserves foreign key relationships)
    const { error } = await window.supabase
      .from('audit_products')
      .update({ is_active: false })
      .eq('id', productId);
    
    if (error) {
      console.error('Remove error:', error);
      throw error;
    }
    
    alert(`✅ ${sku} removed from audit list`);
    
    // Reload data
    await loadProductsList();
    await loadData();
    
  } catch (error) {
    console.error('Error removing product:', error);
    alert('❌ Error: ' + error.message + '\n\nCheck browser console for details.');
  }
};

// Export Analysis for Friday Review
window.exportAnalysis = async function() {
  if (state.warehouse !== 'all') {
    alert('⚠️ Please switch to "All Warehouses" view to export analysis');
    return;
  }
  
  try {
    await window.supabaseReady;
    
    // Get current run ID
    if (!state.currentRunId) {
      alert('⚠️ No audit run available. Please upload reports or create a new count first.');
      return;
    }
    
    // Get current run data with analysis
    const { data: analysis, error } = await window.supabase
      .from('audit_stock_analysis')
      .select(`
        *,
        audit_products!inner(sku_code, display_code, product_name),
        audit_warehouses!inner(name, code)
      `)
      .eq('run_id', state.currentRunId)
      .order('diff_qty', { ascending: false });
    
    if (error) {
      console.error('Query error:', error);
      throw error;
    }
    
    if (!analysis || analysis.length === 0) {
      alert('⚠️ No analysis data available for export. Please complete physical counts first.');
      return;
    }
    
    console.log(`📊 Exporting ${analysis.length} analysis records`);
    
    // Generate intelligent analysis
    let report = `CYCLIC COUNT WEEKLY ANALYSIS\n`;
    report += `Generated: ${new Date().toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n`;
    report += `${'='.repeat(80)}\n\n`;
    
    // 1. Executive Summary
    report += `📊 EXECUTIVE SUMMARY\n`;
    report += `${'-'.repeat(80)}\n`;
    const totalProducts = new Set(analysis.map(a => a.product_id)).size;
    const totalVariance = analysis.reduce((sum, a) => sum + Math.abs(a.diff_qty || 0), 0);
    const criticalItems = analysis.filter(a => Math.abs(a.diff_qty || 0) > 10).length;
    const countedItems = analysis.filter(a => a.actual_qty_on_hand !== null).length;
    
    report += `Total Products Monitored: ${totalProducts}\n`;
    report += `Total Records: ${analysis.length}\n`;
    report += `Items Counted: ${countedItems} (${((countedItems/analysis.length)*100).toFixed(1)}%)\n`;
    report += `Total Variance Units: ${totalVariance}\n`;
    report += `Critical Variance Items (>10 units): ${criticalItems}\n\n`;
    
    // 2. Top Discrepancies
    report += `⚠️ TOP 10 DISCREPANCIES (Highest Variance)\n`;
    report += `${'-'.repeat(80)}\n`;
    const topIssues = analysis
      .filter(a => a.diff_qty !== 0 && a.actual_qty_on_hand !== null)
      .sort((a, b) => Math.abs(b.diff_qty || 0) - Math.abs(a.diff_qty || 0))
      .slice(0, 10);
    
    if (topIssues.length === 0) {
      report += `✅ No discrepancies detected - all counts match system!\n\n`;
    } else {
      topIssues.forEach((item, i) => {
        const sku = item.audit_products.display_code || item.audit_products.sku_code;
        const name = item.audit_products.product_name;
        const whName = item.audit_warehouses.name;
        report += `${i+1}. ${sku} - ${name}\n`;
        report += `   Warehouse: ${whName} | System: ${item.expected_qty_on_hand || 0} | Physical: ${item.actual_qty_on_hand} | Variance: ${item.diff_qty}\n`;
        if (item.reason_guess) {
          report += `   💡 Possible reason: ${item.reason_guess}\n`;
        }
        report += `\n`;
      });
    }
    
    // 3. Warehouse Performance
    report += `🏢 WAREHOUSE STOCK ACCURACY\n`;
    report += `${'-'.repeat(80)}\n`;
    const warehouseStats = {};
    analysis.forEach(a => {
      const whName = a.audit_warehouses.name;
      if (!warehouseStats[whName]) {
        warehouseStats[whName] = { total: 0, counted: 0, accurate: 0, variance: 0 };
      }
      warehouseStats[whName].total++;
      if (a.actual_qty_on_hand !== null) {
        warehouseStats[whName].counted++;
        if (a.diff_qty === 0) warehouseStats[whName].accurate++;
      }
      warehouseStats[whName].variance += Math.abs(a.diff_qty || 0);
    });
    
    Object.entries(warehouseStats).forEach(([name, stats]) => {
      const countProgress = stats.counted > 0 ? `${((stats.counted/stats.total)*100).toFixed(1)}%` : '0%';
      const accuracy = stats.counted > 0 ? ((stats.accurate / stats.counted) * 100).toFixed(1) : '0';
      report += `${name}:\n`;
      report += `  Count Progress: ${countProgress} (${stats.counted}/${stats.total} items counted)\n`;
      report += `  Accuracy: ${accuracy}% (${stats.accurate}/${stats.counted} items match)\n`;
      report += `  Total Variance: ${stats.variance} units\n\n`;
    });
    
    // 4. Products Needing Attention
    report += `🔍 PRODUCTS REQUIRING IMMEDIATE ATTENTION\n`;
    report += `${'-'.repeat(80)}\n`;
    const needsAttention = analysis.filter(a => 
      Math.abs(a.diff_qty || 0) > 5 && a.actual_qty_on_hand !== null
    );
    
    if (needsAttention.length === 0) {
      report += `✅ No critical issues detected!\n\n`;
    } else {
      needsAttention.slice(0, 15).forEach(item => {
        const sku = item.audit_products.display_code || item.audit_products.sku_code;
        const whName = item.audit_warehouses.name;
        report += `• ${sku} (${whName})\n`;
        report += `  - Variance: ${item.diff_qty} units (System: ${item.expected_qty_on_hand}, Physical: ${item.actual_qty_on_hand})\n`;
        if (item.reason_guess) {
          report += `  - Possible reason: ${item.reason_guess}\n`;
        }
      });
      report += `\n`;
    }
    
    // 5. Recommendations
    report += `💡 RECOMMENDATIONS\n`;
    report += `${'-'.repeat(80)}\n`;
    if (countedItems < analysis.length * 0.5) {
      report += `• URGENT: Only ${countProgress}% of items have been counted - continue physical counts\n`;
    }
    if (criticalItems > 0) {
      report += `• Conduct recount for ${criticalItems} items with high variance (>10 units)\n`;
    }
    if (Object.values(warehouseStats).some(s => s.counted > 0 && (s.accurate/s.counted) < 0.8)) {
      report += `• Some warehouses show <80% accuracy - review counting procedures\n`;
    }
    if (totalVariance > 100) {
      report += `• High total variance detected (${totalVariance} units) - investigate system vs physical discrepancies\n`;
    }
    report += `• Continue weekly monitoring for trend analysis\n`;
    report += `• Review and update stock levels in system based on physical counts\n`;
    
    // Download as text file
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cyclic-count-analysis-${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('✅ Analysis report exported');
    alert('✅ Analysis report exported successfully!');
    
  } catch (error) {
    console.error('Error exporting analysis:', error);
    alert('❌ Error generating report: ' + error.message);
  }
};

// View History
window.viewHistory = async function() {
  document.getElementById('historyModal').style.display = 'flex';
  filterHistory('week');
};

window.closeHistoryModal = function() {
  document.getElementById('historyModal').style.display = 'none';
};

window.filterHistory = async function(period) {
  // Update button states
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  event.target.classList.add('active');
  
  try {
    await window.supabaseReady;
    
    // Calculate date range
    let startDate = new Date();
    if (period === 'week') startDate.setDate(startDate.getDate() - 7);
    else if (period === 'month') startDate.setMonth(startDate.getMonth() - 1);
    else if (period === 'quarter') startDate.setMonth(startDate.getMonth() - 3);
    else startDate = new Date('2000-01-01');
    
    // Fetch historical runs
    const { data: runs, error } = await window.supabase
      .from('audit_runs')
      .select(`
        id,
        created_at,
        sales_orders_count,
        products_analyzed
      `)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    const container = document.getElementById('historyContent');
    
    if (!runs || runs.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#64748b;padding:40px">No data for this period</div>';
      return;
    }
    
    // Group by week
    const weeklyData = {};
    runs.forEach(run => {
      const date = new Date(run.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      
      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { runs: [], totalOrders: 0, totalProducts: 0 };
      }
      weeklyData[weekKey].runs.push(run);
      weeklyData[weekKey].totalOrders += run.sales_orders_count || 0;
      weeklyData[weekKey].totalProducts += run.products_analyzed || 0;
    });
    
    container.innerHTML = Object.entries(weeklyData)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([weekStart, data]) => {
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        
        return `
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <h3 style="margin:0">📅 Week of ${new Date(weekStart).toLocaleDateString('en-AU')}</h3>
              <span style="color:#64748b;font-size:0.9em">${data.runs.length} run(s)</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
              <div>
                <div style="font-size:0.85em;color:#64748b;margin-bottom:4px">Total Orders Analyzed</div>
                <div style="font-size:1.5em;font-weight:600">${data.totalOrders.toLocaleString()}</div>
              </div>
              <div>
                <div style="font-size:0.85em;color:#64748b;margin-bottom:4px">Products Tracked</div>
                <div style="font-size:1.5em;font-weight:600">${data.totalProducts}</div>
              </div>
              <div>
                <div style="font-size:0.85em;color:#64748b;margin-bottom:4px">Avg Orders/Run</div>
                <div style="font-size:1.5em;font-weight:600">${Math.round(data.totalOrders / data.runs.length).toLocaleString()}</div>
              </div>
            </div>
            <div style="margin-top:12px">
              <button class="search-btn-small secondary" onclick="viewRunDetails('${data.runs[0].id}')">View Details</button>
            </div>
          </div>
        `;
      }).join('');
    
  } catch (error) {
    console.error('Error loading history:', error);
    document.getElementById('historyContent').innerHTML = '<div style="text-align:center;color:#ef4444;padding:40px">Error loading history</div>';
  }
};

window.viewRunDetails = async function(runId) {
  // Load specific run details (can expand this later)
  alert(`Loading details for run ${runId}...`);
};

// ==========================================
// Table Search/Filter Functions
// ==========================================

window.filterTable = function() {
  const searchInput = document.getElementById('tableSearchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  const searchTerm = searchInput.value.toLowerCase().trim();
  
  // Show/hide clear button
  if (searchTerm) {
    clearBtn.style.display = 'block';
  } else {
    clearBtn.style.display = 'none';
  }
  
  // Get all table rows
  const table = document.getElementById('analysisTable');
  if (!table) return;
  
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  
  const rows = tbody.querySelectorAll('tr');
  let visibleCount = 0;
  
  rows.forEach(row => {
    if (!searchTerm) {
      row.style.display = '';
      visibleCount++;
      return;
    }
    
    // Get all text content from the row
    const rowText = row.textContent.toLowerCase();
    
    if (rowText.includes(searchTerm)) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });
  
  // Show "no results" message if needed
  let noResultsRow = tbody.querySelector('.no-results-row');
  if (visibleCount === 0 && searchTerm) {
    if (!noResultsRow) {
      noResultsRow = document.createElement('tr');
      noResultsRow.className = 'no-results-row';
      noResultsRow.innerHTML = `
        <td colspan="100%" style="text-align:center;padding:40px;color:#64748b">
          <div style="font-size:1.2em;margin-bottom:8px">🔍</div>
          <div>No products found matching "${searchTerm}"</div>
          <button class="search-btn-small" onclick="clearTableSearch()" style="margin-top:12px">Clear Search</button>
        </td>
      `;
      tbody.appendChild(noResultsRow);
    }
  } else if (noResultsRow) {
    noResultsRow.remove();
  }
};

window.clearTableSearch = function() {
  const searchInput = document.getElementById('tableSearchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  
  searchInput.value = '';
  clearBtn.style.display = 'none';
  
  filterTable();
};

// ═══════════════════════════════════════════════════════════════
// 🔄 SYNC SYSTEM
// ═══════════════════════════════════════════════════════════════

/**
 * Load and display sync status
 */

// Removed sync/upload functions - keeping only core cyclic count

// ═══════════════════════════════════════════════════════════════
// 📤 UPLOAD REPORTS SYSTEM
// ═══════════════════════════════════════════════════════════════

/**
 * Process uploaded CIN7 reports (Sales Orders + Stock Availability)
 * This function:
 * 1. Parses both CSV files
 * 2. Creates a new audit run
 * 3. Creates analysis records for all products
 * 4. Reloads the page to show new data
 */
window.handleReportUpload = async function() {
  try {
    console.log('🚀 JS: handleReportUpload called');
    
    // Check if files are available (from HTML global variables)
    if (!window.salesOrdersFileData || !window.stockAvailabilityFileData) {
      console.error('❌ Files not found in window object');
      alert('⚠️ Please upload both reports (Sales Orders + Stock Availability)');
      return;
    }
    
    console.log('✅ Files found:', {
      salesOrders: window.salesOrdersFileData.name,
      stockAvailability: window.stockAvailabilityFileData.name
    });
    console.log('🚀 Starting report processing...');
    
    // Show loading state
    const processBtn = document.getElementById('processReportsBtn');
    const originalText = processBtn.textContent;
    processBtn.disabled = true;
    processBtn.textContent = '⏳ Processing...';
    
    await window.supabaseReady;
    
    // Parse Stock Availability CSV
    console.log('📊 Parsing Stock Availability CSV...');
    const stockData = await parseStockAvailabilityCSV(window.stockAvailabilityFileData);
    console.log(`✅ Parsed ${stockData.length} stock records`);
    
    // Parse Sales Orders CSV
    console.log('📦 Parsing Sales Orders CSV...');
    const salesData = await parseSalesOrdersCSV(window.salesOrdersFileData);
    console.log(`✅ Parsed ${salesData.length} sales order lines`);
    
    // Get all products and warehouses
    console.log('📋 Loading products and warehouses...');
    const { data: products, error: prodError } = await window.supabase
      .from('audit_products')
      .select('*')
      .eq('is_active', true);
    
    if (prodError) throw prodError;
    
    const { data: warehouses, error: whError } = await window.supabase
      .from('audit_warehouses')
      .select('*');
    
    if (whError) throw whError;
    
    console.log(`✅ Loaded ${products.length} products and ${warehouses.length} warehouses`);
    
    // Create new audit run
    console.log('🎯 Creating new audit run...');
    const now = new Date();
    const { data: newRun, error: runError } = await window.supabase
      .from('audit_runs')
      .insert([{
        started_at: now.toISOString(),
        period_start_date: now.toISOString(),
        period_end_date: now.toISOString()
      }])
      .select()
      .single();
    
    if (runError) {
      console.error('❌ Failed to create audit run:', runError);
      
      // Check if it's RLS error
      if (runError.code === '42501' || runError.message?.includes('row-level security')) {
        throw new Error(
          'Row-Level Security (RLS) is blocking the upload.\n\n' +
          'To fix this, you need to disable RLS for these tables in Supabase:\n' +
          '1. Go to: https://supabase.com/dashboard\n' +
          '2. Select your project → Table Editor\n' +
          '3. For tables: audit_runs, audit_stock_analysis\n' +
          '4. Click "..." → Edit Table → Disable RLS\n\n' +
          'Alternative: Use the backend API endpoint instead of direct upload.'
        );
      }
      
      throw runError;
    }
    console.log(`✅ Created audit run: ${newRun.id}`);
    
    // Prepare analysis records
    console.log('📝 Preparing analysis records...');
    const analysisRecords = await prepareAnalysisRecords(newRun.id, products, warehouses, stockData, salesData);
    console.log(`✅ Prepared ${analysisRecords.length} analysis records`);
    
    // Batch insert analysis records
    console.log('💾 Saving to database...');
    const batchSize = 100;
    for (let i = 0; i < analysisRecords.length; i += batchSize) {
      const batch = analysisRecords.slice(i, i + batchSize);
      const { error: insertError } = await window.supabase
        .from('audit_stock_analysis')
        .insert(batch);
      
      if (insertError) {
        console.error('Insert error:', insertError);
        throw insertError;
      }
      console.log(`✅ Saved batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(analysisRecords.length / batchSize)}`);
    }
    
    // Mark run as completed (no completed_at field in table)
    console.log('✅ Upload complete - run marked as done');
    
    console.log('✅ Upload complete!');
    
    // Close modal
    if (typeof closeUploadReportsModal === 'function') {
      closeUploadReportsModal();
    }
    
    // Show success message
    alert('✅ Reports uploaded successfully!\n\nThe page will reload to show the new data.');
    
    // Reload page to show new data
    window.location.reload();
    
  } catch (error) {
    console.error('❌ Error processing reports:', error);
    alert('❌ Error processing reports:\n\n' + error.message);
    
    // Reset button
    const processBtn = document.getElementById('processReportsBtn');
    if (processBtn) {
      processBtn.disabled = false;
      processBtn.textContent = '🚀 Process Reports';
    }
  }
};

/**
 * Parse Stock Availability CSV or Excel
 * Expected columns: SKU, Location, OnHand, Available, Allocated, OnOrder
 */
async function parseStockAvailabilityCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        let rows = [];
        
        // Check if file is Excel (.xlsx/.xls) or CSV
        if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
          console.log('📊 Detected Excel file, using XLSX parser...');
          
          // Parse Excel file
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          
          // Get first sheet
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          
          // Convert to array of arrays
          rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          console.log(`✅ Excel parsed: ${rows.length} rows`);
          
        } else {
          console.log('📄 Detected CSV file, using text parser...');
          
          // Parse CSV
          const text = e.target.result;
          const lines = text.split('\n').filter(line => line.trim());
          rows = lines.map(line => line.split(',').map(v => v.trim().replace(/"/g, '')));
        }
        
        if (rows.length === 0) {
          throw new Error('File is empty');
        }
        
        // CIN7 Stock report has a special format:
        // Row 0: Warehouse names repeated (locations)
        // Row 1: Column headers (Available, Allocated, OnHand, OnOrder) repeated for each warehouse
        // Row 2+: Data with SKU in first column
        
        // Get warehouse locations from row 0 (skipping first 2 columns: SKU, Product Name)
        const locationRow = rows[0];
        const columnHeaders = rows[1];
        
        console.log('📋 Stock file structure:');
        console.log('  Total rows:', rows.length);
        console.log('  Row 0 (locations):', locationRow);
        console.log('  Row 1 (headers):', columnHeaders);
        console.log('  Row 2 (first data):', rows[2]);
        
        // Find SKU column (should be first column with "SKU" in row 1)
        const skuIdx = columnHeaders.findIndex((h, idx) => 
          String(h || '').trim().toLowerCase() === 'sku' ||
          String(h || '').trim().toLowerCase() === 'code'
        );
        
        if (skuIdx === -1) {
          throw new Error('SKU column not found');
        }
        
        console.log(`✅ SKU column at index: ${skuIdx}`);
        
        // Build location-to-column mapping
        // For each warehouse, we need to find OnHand column
        const locationMap = {}; // { 'Main Warehouse': { onHandIdx: 66, availableIdx: 65, ... }, ... }
        
        for (let i = skuIdx + 1; i < locationRow.length; i++) {
          const location = String(locationRow[i] || '').trim();
          const columnType = String(columnHeaders[i] || '').trim().toLowerCase();
          
          if (!location) continue;
          
          if (!locationMap[location]) {
            locationMap[location] = {};
          }
          
          // Match OnHand with variations
          if (columnType === 'onhand' || 
              columnType === 'on hand' || 
              columnType === 'quantity on hand' ||
              columnType === 'stock on hand') {
            locationMap[location].onHandIdx = i;
          } else if (columnType === 'available') {
            locationMap[location].availableIdx = i;
          } else if (columnType === 'allocated') {
            locationMap[location].allocatedIdx = i;
          } else if (columnType === 'onorder' || 
                     columnType === 'on order' || 
                     columnType === 'in transit') {
            locationMap[location].onOrderIdx = i;
          }
        }
        
        console.log(`✅ Found ${Object.keys(locationMap).length} locations:`, Object.keys(locationMap));
        
        // Verify we have OnHand for at least some locations
        const locationsWithOnHand = Object.entries(locationMap).filter(([_, cols]) => cols.onHandIdx !== undefined);
        if (locationsWithOnHand.length === 0) {
          throw new Error('No OnHand columns found for any location');
        }
        
        console.log(`✅ ${locationsWithOnHand.length} locations have OnHand data`);
        
        // Now we don't need these old variables
        const locationIdx = -1; // Not used
        const onHandIdx = -1; // Not used
        const availableIdx = -1; // Not used
        const allocatedIdx = -1; // Not used
        const onOrderIdx = -1; // Not used
        
        // Parse data rows (starting from row 2, since 0=locations, 1=headers)
        const data = [];
        for (let i = 2; i < rows.length; i++) {
          const values = rows[i];
          if (!values || values.length < skuIdx + 1) continue; // Skip incomplete rows
          
          const sku = String(values[skuIdx] || '').trim();
          if (!sku) continue; // Skip rows without SKU
          
          // Extract data for each location
          for (const [location, cols] of Object.entries(locationMap)) {
            if (cols.onHandIdx === undefined) continue; // Skip locations without OnHand
            
            const onHand = parseFloat(values[cols.onHandIdx]) || 0;
            const available = cols.availableIdx !== undefined ? parseFloat(values[cols.availableIdx]) || 0 : onHand;
            const allocated = cols.allocatedIdx !== undefined ? parseFloat(values[cols.allocatedIdx]) || 0 : 0;
            const onOrder = cols.onOrderIdx !== undefined ? parseFloat(values[cols.onOrderIdx]) || 0 : 0;
            
            // Only add if there's any stock data
            if (onHand !== 0 || available !== 0 || allocated !== 0 || onOrder !== 0) {
              data.push({
                sku,
                location,
                onHand,
                available,
                allocated,
                onOrder
              });
            }
          }
        }
        
        console.log(`✅ Parsed ${data.length} stock records`);
        
        if (data.length === 0) {
          alert('⚠️ AVISO: Nenhum dado de stock foi encontrado!\n\nVerifique se o arquivo Excel tem o formato correto do CIN7:\n- Row 0: Nomes dos warehouses\n- Row 1: Cabeçalhos (OnHand, Available, etc)\n- Row 2+: Dados dos produtos\n\nVeja o Console (F12) para detalhes.');
        }
        
        resolve(data);
      } catch (error) {
        console.error('❌ Error parsing stock file:', error);
        alert('❌ Erro ao processar arquivo de Stock:\n\n' + error.message);
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read Stock Availability file'));
    
    // Read as array buffer for Excel, text for CSV
    if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  });
}

/**
 * Parse Sales Orders CSV or Excel
 * Expected: Header at line 5 for CSV (lines 1-4 are metadata), or first row for Excel
 * Required columns: SKU, Quantity, Status
 */
async function parseSalesOrdersCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        let rows = [];
        let headerLine = 0;
        
        // Check if file is Excel (.xlsx/.xls) or CSV
        if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
          console.log('📦 Detected Excel file, using XLSX parser...');
          
          // Parse Excel file
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          
          // Get first sheet
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          
          // Convert to array of arrays
          rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          console.log(`✅ Excel parsed: ${rows.length} rows`);
          
          // For Excel, header is usually at first row
          headerLine = 0;
          
        } else {
          console.log('📄 Detected CSV file, using text parser...');
          
          // Parse CSV
          const text = e.target.result;
          const lines = text.split('\n').filter(line => line.trim());
          rows = lines.map(line => line.split(',').map(v => v.trim().replace(/"/g, '')));
          
          // For CIN7 CSV, header is at line 5 (0-indexed = 4)
          headerLine = Math.min(4, rows.length - 1);
        }
        
        if (rows.length <= headerLine) {
          throw new Error('File is too short or empty');
        }
        
        // For Excel files, CIN7 may have metadata rows at the top
        // Auto-detect the header row by looking for "SKU" column
        let actualHeaderLine = headerLine;
        let headers = [];
        let skuIdx = -1;
        
        // Search for header row (max 10 rows)
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          
          const testHeaders = row.map(h => String(h || '').trim());
          const testSkuIdx = testHeaders.findIndex(h => h.toLowerCase() === 'sku' || h.toLowerCase() === 'product sku');
          
          if (testSkuIdx !== -1) {
            actualHeaderLine = i;
            headers = testHeaders;
            skuIdx = testSkuIdx;
            console.log(`✅ Found header row at line ${i}:`, headers.slice(0, 10));
            break;
          }
        }
        
        if (skuIdx === -1) {
          console.error('📋 Sales file first 5 rows:');
          rows.slice(0, 5).forEach((row, i) => {
            console.error(`  Row ${i}:`, row.slice(0, 5));
          });
          throw new Error('SKU column not found in first 10 rows');
        }
        
        // Find other column indices (case-insensitive, flexible matching)
        const qtyIdx = headers.findIndex(h => {
          const lower = h.toLowerCase();
          return lower.includes('quantity') || lower === 'qty' || lower.includes('qty ordered');
        });
        const statusIdx = headers.findIndex(h => h.toLowerCase().includes('status'));
        
        if (qtyIdx === -1) {
          console.error('📋 Available columns:', headers);
          throw new Error('Quantity column not found. Available columns logged to console.');
        }
        
        console.log(`✅ Column mapping: SKU=${skuIdx}, Quantity=${qtyIdx}, Status=${statusIdx}`);
        
        // Parse data rows (start after actual header line)
        const data = [];
        for (let i = actualHeaderLine + 1; i < rows.length; i++) {
          const values = rows[i];
          if (!values || values.length < 2) continue; // Skip incomplete rows
          
          const sku = String(values[skuIdx] || '').trim();
          const quantity = parseFloat(values[qtyIdx]) || 0;
          const status = statusIdx !== -1 ? String(values[statusIdx] || '').trim() : '';
          
          // Only include Authorised/Pending orders (or if no status column)
          if (sku && quantity > 0 && 
              (!status || status.toLowerCase() === 'authorised' || status.toLowerCase() === 'pending')) {
            data.push({
              sku,
              quantity,
              status
            });
          }
        }
        
        console.log(`✅ Parsed ${data.length} sales order lines`);
        resolve(data);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read Sales Orders file'));
    
    // Read as array buffer for Excel, text for CSV
    if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
      reader.readAsArrayBuffer(file);
    } else {
      reader.readAsText(file);
    }
  });
}

/**
 * Prepare analysis records for database insertion
 * Combines stock data with sales order data for all products in audit_products
 */
async function prepareAnalysisRecords(runId, products, warehouses, stockData, salesData) {
  console.log('🔄 prepareAnalysisRecords starting...');
  console.log('📦 Sample product:', products[0]);
  console.log('🏢 Sample warehouse:', warehouses[0]);
  
  // Create lookup maps
  const productMap = {};
  products.forEach(p => {
    productMap[p.sku_code] = p;
    if (p.display_code) productMap[p.display_code] = p;
  });
  
  const warehouseMap = {};
  warehouses.forEach(w => {
    // Map CIN7 location name to warehouse (this is the key field!)
    const cin7Location = (w.cin7_location || w.name || '').toLowerCase();
    if (cin7Location) {
      warehouseMap[cin7Location] = w;
    }
    // Also map by code
    const warehouseCode = w.code;
    if (warehouseCode) {
      warehouseMap[warehouseCode] = w;
    }
  });
  
  console.log('🏢 Warehouse map keys:', Object.keys(warehouseMap));
  console.log('📍 Sample stock locations:', [...new Set(stockData.map(s => s.location))].slice(0, 10));
  console.log('📦 Stock data samples:', stockData.slice(0, 3).map(s => ({ sku: s.sku, location: s.location, onHand: s.onHand })));
  
  // Calculate allocated quantities per SKU (from sales orders)
  const allocatedMap = {};
  salesData.forEach(order => {
    if (!allocatedMap[order.sku]) allocatedMap[order.sku] = 0;
    allocatedMap[order.sku] += order.quantity;
  });
  
  // Create stock lookup by SKU + Location
  const stockLookup = {};
  stockData.forEach(stock => {
    const key = `${stock.sku}|${stock.location.toLowerCase()}`;
    stockLookup[key] = stock;
  });
  
  console.log(`📊 Stock lookup: ${Object.keys(stockLookup).length} entries`);
  console.log(`📦 Allocated map: ${Object.keys(allocatedMap).length} SKUs with orders`);
  
  // Prepare analysis records for ALL products × ALL warehouses
  const analysisRecords = [];
  let matchedCount = 0;
  let missingCount = 0;
  
  products.forEach(product => {
    warehouses.forEach(warehouse => {
      // Use CIN7 location name for matching (this is what's in the Excel file)
      const cin7Location = (warehouse.cin7_location || warehouse.name || '').toLowerCase();
      const key = `${product.sku_code}|${cin7Location}`;
      const altKey = product.display_code ? `${product.display_code}|${cin7Location}` : null;
      
      const stock = stockLookup[key] || (altKey ? stockLookup[altKey] : null);
      const allocated = allocatedMap[product.sku_code] || allocatedMap[product.display_code] || 0;
      
      // Debug first product to see what's happening
      if (product.sku_code === '90301' && warehouse.name === 'Main Warehouse') {
        console.log('🔍 DEBUG 90301 @ Main Warehouse:');
        console.log('   key:', key);
        console.log('   altKey:', altKey);
        console.log('   stock found:', !!stock);
        console.log('   stock value:', stock);
        console.log('   Available keys in stockLookup:', Object.keys(stockLookup).slice(0, 5));
      }
      
      if (stock) {
        matchedCount++;
        // Has stock data from CIN7
        analysisRecords.push({
          run_id: runId,
          product_id: product.id,
          warehouse_id: warehouse.id,
          previous_qty_on_hand: stock.onHand || 0,
          expected_qty_on_hand: stock.onHand || 0,
          actual_qty_on_hand: null, // Will be filled during physical count
          diff_qty: 0,
          anomaly_level: 'none',
          reason_guess: null
        });
      } else {
        missingCount++;
        // No stock data - create with 0
        analysisRecords.push({
          run_id: runId,
          product_id: product.id,
          warehouse_id: warehouse.id,
          previous_qty_on_hand: 0,
          expected_qty_on_hand: 0,
          actual_qty_on_hand: null, // Will be filled during physical count
          diff_qty: 0,
          anomaly_level: 'none',
          reason_guess: null
        });
      }
    });
  });
  
  console.log(`✅ Created ${analysisRecords.length} analysis records`);
  console.log(`   📊 ${matchedCount} with CIN7 data`);
  console.log(`   ⚠️  ${missingCount} without data (set to 0)`);
  
  return analysisRecords;
}

console.log('✅ Cyclic Count system loaded (with upload reports)');

