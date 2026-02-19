// stock-anomalies.js
// Purpose: Stock Anomaly Checker - analyzes pickface and bin/shelf stock anomalies
// This is a NEW file and does NOT modify any existing Restock code.

(function () {
  'use strict';

  // ============================================
  // STATE
  // ============================================
  const state = {
    anomalies: [],         // All anomaly rows
    filteredAnomalies: [], // After filters applied
    typeFilter: 'ALL',     // ALL | PICKFACE | BIN
    anomalyFilter: 'ALL',  // ALL | OVER | UNDER | NEGATIVE
    searchTerm: '',
    page: 1,
    perPage: 50,
    lastReportTime: null,
    loading: false,
    onlyFavorites: false,  // Show only favorited items
    // Counts for badges
    counts: {
      all: 0,
      pickface: 0,
      bin: 0,
      over: 0,
      under: 0,
      negative: 0
    }
  };

  // ============================================
  // FAVORITES (using user_favorites table)
  // ============================================
  const FAVORITES_KEY = 'stock_anomalies_favorites_skus';
  const favorites = new Set();

  // Load favorites from database
  async function loadFavoritesFromDB() {
    try {
      await window.supabaseReady;
      
      const { data, error } = await window.supabase
        .from('user_favorites')
        .select('sku');
        
      if (error) {
        console.error('❌ Error loading favorites from database:', error);
        return loadFavoritesFromLocalStorage();
      }
      
      favorites.clear();
      if (data) {
        data.forEach(row => favorites.add(String(row.sku)));
      }
      
      console.log(`✅ Loaded ${favorites.size} favorites from database`);
      return true;
    } catch (error) {
      console.error('❌ Error loading favorites:', error);
      return loadFavoritesFromLocalStorage();
    }
  }

  // Fallback: Load from localStorage
  function loadFavoritesFromLocalStorage() {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) {
        JSON.parse(raw).forEach((s) => favorites.add(String(s)));
        console.log(`ℹ️ Loaded ${favorites.size} favorites from localStorage (fallback)`);
      }
      return true;
    } catch (error) {
      console.error('❌ Error loading from localStorage:', error);
      return false;
    }
  }

  // Add favorite to database
  async function addFavoriteToDB(sku) {
    try {
      await window.supabaseReady;
      
      const { error } = await window.supabase
        .from('user_favorites')
        .upsert(
          { sku: String(sku) },
          { onConflict: 'sku' }
        );
        
      if (error) {
        console.error('❌ Error adding favorite to database:', error);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error adding favorite:', error);
      return false;
    }
  }

  // Remove favorite from database
  async function removeFavoriteFromDB(sku) {
    try {
      await window.supabaseReady;
      
      const { error } = await window.supabase
        .from('user_favorites')
        .delete()
        .eq('sku', String(sku));
        
      if (error) {
        console.error('❌ Error removing favorite from database:', error);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('❌ Error removing favorite:', error);
      return false;
    }
  }

  // Toggle favorite
  async function toggleFavorite(sku) {
    const skuStr = String(sku);
    const isAdding = !favorites.has(skuStr);
    
    if (isAdding) {
      favorites.add(skuStr);
      await addFavoriteToDB(skuStr);
    } else {
      favorites.delete(skuStr);
      await removeFavoriteFromDB(skuStr);
    }
    
    // Backup to localStorage
    try { 
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favorites))); 
    } catch {}
    
    // Re-render to update star state
    render();
  }

  // Toggle only favorites filter
  window.toggleOnlyFavorites = function(flag) {
    state.onlyFavorites = flag;
    applyFilters();
  };

  // ============================================
  // DOM ELEMENTS
  // ============================================
  const tbody = document.getElementById('anomalyTbody');
  const searchInput = document.getElementById('anomalySearch');

  // ============================================
  // UTILITY FUNCTIONS
  // ============================================
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatTimestamp(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function setTbody(html) {
    if (tbody) tbody.innerHTML = html;
  }

  // ============================================
  // MODAL FUNCTIONS
  // ============================================
  function openGenerationModal() {
    const modal = document.getElementById('generationModal');
    if (modal) {
      modal.classList.remove('hidden');
      document.getElementById('modalTitle').textContent = '🔄 Generating Report...';
      document.getElementById('modalSpinner').style.display = 'block';
      document.getElementById('modalStatus').textContent = 'Loading data...';
      document.getElementById('modalProgressBar').style.width = '0%';
      document.getElementById('modalSummary').style.display = 'none';
      document.getElementById('modalCloseBtn').style.display = 'none';
    }
  }

  function updateModalProgress(percent, status) {
    document.getElementById('modalProgressBar').style.width = percent + '%';
    document.getElementById('modalStatus').textContent = status;
  }

  function showModalSummary(total, pickface, bin) {
    document.getElementById('modalTitle').textContent = '✅ Report Complete';
    document.getElementById('modalSpinner').style.display = 'none';
    document.getElementById('modalStatus').textContent = 'Analysis complete!';
    document.getElementById('modalProgressBar').style.width = '100%';
    document.getElementById('summaryTotal').textContent = total;
    document.getElementById('summaryPickface').textContent = pickface;
    document.getElementById('summaryBin').textContent = bin;
    document.getElementById('modalSummary').style.display = 'block';
    document.getElementById('modalCloseBtn').style.display = 'inline-block';
  }

  window.closeGenerationModal = function () {
    const modal = document.getElementById('generationModal');
    if (modal) modal.classList.add('hidden');
  };

  // ============================================
  // DATA FETCHING (Read-Only from existing tables)
  // ============================================
  
  /**
   * Fetch pickface capacity rules from restock_setup (existing table)
   * Returns: { sku: { min, med, max } }
   */
  async function fetchPickfaceCapacity() {
    await window.supabaseReady;
    
    const allData = [];
    const chunkSize = 1000;
    let offset = 0;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('restock_setup')
        .select('sku, cap_min, cap_med, cap_max')
        .order('sku')
        .range(offset, offset + chunkSize - 1);
      
      if (error) {
        console.error('Error fetching pickface capacity:', error);
        break;
      }
      
      if (!data || data.length === 0) break;
      allData.push(...data);
      
      if (data.length < chunkSize) break;
      offset += chunkSize;
    }
    
    // Build lookup map
    const capacityMap = {};
    for (const row of allData) {
      if (row.sku && Number.isFinite(Number(row.cap_max))) {
        capacityMap[String(row.sku)] = {
          min: Number(row.cap_min) || 0,
          med: Number(row.cap_med) || 0,
          max: Number(row.cap_max) || 0
        };
      }
    }
    
    console.log(`✅ Loaded ${Object.keys(capacityMap).length} pickface capacity rules`);
    return capacityMap;
  }

  /**
   * Fetch pallet capacity rules from pallet_capacity_rules (NEW table)
   * Returns: { palletMap: { sku: qty_pallet }, palletProductMap: { sku: product_name } }
   */
  async function fetchPalletCapacityRules() {
    await window.supabaseReady;
    
    // Fetch ALL records (Supabase limits to 1000 by default)
    const allData = [];
    const chunkSize = 1000;
    let offset = 0;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('pallet_capacity_rules')
        .select('product, sku, qty_pallet')
        .order('sku')
        .range(offset, offset + chunkSize - 1);
      
      if (error) {
        console.error('Error fetching pallet capacity rules:', error);
        break;
      }
      
      if (!data || data.length === 0) break;
      allData.push(...data);
      
      if (data.length < chunkSize) break;
      offset += chunkSize;
    }
    
    // Build lookup maps
    const palletMap = {};
    const palletProductMap = {};
    for (const row of allData) {
      if (row.sku && Number.isFinite(Number(row.qty_pallet)) && Number(row.qty_pallet) > 0) {
        palletMap[String(row.sku)] = Number(row.qty_pallet);
        if (row.product) {
          palletProductMap[String(row.sku)] = String(row.product);
        }
      }
    }
    
    console.log(`✅ Loaded ${Object.keys(palletMap).length} pallet capacity rules`);
    return { palletMap, palletProductMap };
  }

  /**
   * Fetch stock by location from restock_report (existing table)
   * Returns: [{ sku, location, on_hand }]
   */
  async function fetchStockByLocation() {
    await window.supabaseReady;
    
    const allData = [];
    const chunkSize = 1000;
    let offset = 0;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('restock_report')
        .select('sku, location, on_hand')
        .order('sku')
        .range(offset, offset + chunkSize - 1);
      
      if (error) {
        console.error('Error fetching stock by location:', error);
        break;
      }
      
      if (!data || data.length === 0) break;
      allData.push(...data);
      
      if (data.length < chunkSize) break;
      offset += chunkSize;
    }
    
    console.log(`✅ Loaded ${allData.length} stock location records`);
    return allData;
  }

  /**
   * Fetch product info from restock_view (for product names)
   * Returns: { sku: product_name }
   */
  async function fetchProductNames() {
    await window.supabaseReady;
    
    const allData = [];
    const chunkSize = 1000;
    let offset = 0;
    
    while (true) {
      const { data, error } = await window.supabase
        .from('restock_view')
        .select('sku, product, stock_locator')
        .order('sku')
        .range(offset, offset + chunkSize - 1);
      
      if (error) {
        console.error('Error fetching product names:', error);
        break;
      }
      
      if (!data || data.length === 0) break;
      allData.push(...data);
      
      if (data.length < chunkSize) break;
      offset += chunkSize;
    }
    
    // Build lookup maps
    const productMap = {};
    const pickfaceLocationMap = {}; // sku -> pickface_location
    
    for (const row of allData) {
      if (row.sku) {
        productMap[String(row.sku)] = row.product || '';
        if (row.stock_locator) {
          pickfaceLocationMap[String(row.sku)] = normalizeLocation(row.stock_locator);
        }
      }
    }
    
    console.log(`✅ Loaded ${Object.keys(productMap).length} product names`);
    return { productMap, pickfaceLocationMap };
  }

  /**
   * Normalize location string for comparison
   */
  function normalizeLocation(loc) {
    return String(loc || '').replace(/\s+/g, '').toUpperCase();
  }

  // ============================================
  // ANOMALY DETECTION LOGIC
  // ============================================
  
  /**
   * Main function to generate anomaly report
   */
  async function generateAnomalyReport() {
    if (state.loading) return;
    state.loading = true;
    
    const generateBtn = document.getElementById('generateBtn');
    if (generateBtn) generateBtn.disabled = true;
    
    openGenerationModal();
    
    try {
      // Step 1: Fetch all data
      updateModalProgress(10, 'Fetching pickface capacity rules...');
      const pickfaceCapacity = await fetchPickfaceCapacity();
      
      updateModalProgress(25, 'Fetching pallet capacity rules...');
      const { palletMap: palletCapacity, palletProductMap } = await fetchPalletCapacityRules();
      
      updateModalProgress(40, 'Fetching stock by location...');
      const stockByLocation = await fetchStockByLocation();
      
      updateModalProgress(55, 'Fetching product information...');
      const { productMap, pickfaceLocationMap } = await fetchProductNames();
      
      // Merge palletProductMap into productMap (for SKUs not in restock_view)
      for (const [sku, name] of Object.entries(palletProductMap)) {
        if (!productMap[sku]) {
          productMap[sku] = name;
        }
      }
      
      updateModalProgress(70, 'Analyzing anomalies...');
      
      // Step 2: Analyze anomalies
      const anomalies = [];
      
      // Build a set of SKUs that have pickface capacity configured
      const skusWithPickfaceCapacity = new Set(Object.keys(pickfaceCapacity));
      
      // Build a set of SKUs that have pallet capacity configured
      const skusWithPalletCapacity = new Set(Object.keys(palletCapacity));
      
      // Process each stock-by-location record
      for (const record of stockByLocation) {
        const sku = String(record.sku || '');
        const location = String(record.location || '');
        const qty = Number(record.on_hand) || 0;
        const normalizedLocation = normalizeLocation(location);
        
        // Skip if qty is 0 (ignore zero stock)
        if (qty === 0) continue;
        
        // Determine if this location is a pickface for this SKU
        const skuPickfaceLocation = pickfaceLocationMap[sku];
        const isPickfaceLocation = skuPickfaceLocation && normalizedLocation === skuPickfaceLocation;
        
        if (isPickfaceLocation) {
          // ===== PICKFACE ANOMALY CHECK =====
          // Only check if SKU has pickface capacity configured
          if (skusWithPickfaceCapacity.has(sku)) {
            const capacity = pickfaceCapacity[sku].max;
            
            // Check for anomalies
            if (qty < 0) {
              // Negative stock
              anomalies.push({
                sku,
                product: productMap[sku] || '',
                type: 'PICKFACE',
                location,
                qty,
                expected: capacity,
                diff: qty, // Show the negative value
                description: 'Pickface negative stock',
                anomalyType: 'NEGATIVE'
              });
            } else if (qty > capacity) {
              // Over capacity
              anomalies.push({
                sku,
                product: productMap[sku] || '',
                type: 'PICKFACE',
                location,
                qty,
                expected: capacity,
                diff: qty - capacity,
                description: 'Pickface above capacity',
                anomalyType: 'OVER'
              });
            }
            // Note: qty between 1 and capacity is NORMAL - not reported
          }
        } else {
          // ===== BIN/SHELF ANOMALY CHECK =====
          // Only check if SKU has pallet capacity configured
          if (skusWithPalletCapacity.has(sku)) {
            const expectedQty = palletCapacity[sku];
            
            // Check for anomalies
            if (qty < 0) {
              // Negative stock
              anomalies.push({
                sku,
                product: productMap[sku] || '',
                type: 'BIN',
                location,
                qty,
                expected: expectedQty,
                diff: qty,
                description: 'Bin/Shelf negative stock',
                anomalyType: 'NEGATIVE'
              });
            } else if (qty !== expectedQty) {
              // Qty not equal to expected
              const diff = qty - expectedQty;
              anomalies.push({
                sku,
                product: productMap[sku] || '',
                type: 'BIN',
                location,
                qty,
                expected: expectedQty,
                diff,
                description: diff > 0 
                  ? 'Bin/Shelf qty above expected pallet qty'
                  : 'Bin/Shelf qty below expected pallet qty',
                anomalyType: diff > 0 ? 'OVER' : 'UNDER'
              });
            }
            // Note: qty === expectedQty is NORMAL - not reported
          }
        }
      }
      
      updateModalProgress(85, 'Sorting results...');
      
      // Step 3: Sort anomalies
      // Primary: ABS(diff) DESC, Secondary: SKU ASC, Tertiary: Type
      anomalies.sort((a, b) => {
        const absDiffA = Math.abs(a.diff);
        const absDiffB = Math.abs(b.diff);
        
        if (absDiffB !== absDiffA) return absDiffB - absDiffA;
        if (a.sku !== b.sku) return a.sku.localeCompare(b.sku);
        return a.type.localeCompare(b.type);
      });
      
      updateModalProgress(95, 'Rendering report...');
      
      // Step 4: Update state and render
      state.anomalies = anomalies;
      state.lastReportTime = new Date();
      state.page = 1;
      
      // Calculate counts
      updateCounts();
      
      // Apply filters and render
      applyFilters();
      
      // Update last report timestamp
      const stampEl = document.getElementById('lastReportStamp');
      if (stampEl) {
        stampEl.textContent = `Last report: ${formatTimestamp(state.lastReportTime)}`;
      }
      
      // Show summary cards
      document.getElementById('summaryCards').style.display = 'flex';
      document.getElementById('totalAnomalies').textContent = state.counts.all;
      document.getElementById('pickfaceAnomalies').textContent = state.counts.pickface;
      document.getElementById('binAnomalies').textContent = state.counts.bin;
      
      // Generate AI Insights
      generateAiInsights(anomalies, pickfaceCapacity, palletCapacity, stockByLocation, productMap, pickfaceLocationMap);
      
      // Close the loading modal (don't show summary - it's distracting)
      closeGenerationModal();
      
      console.log(`✅ Report generated: ${anomalies.length} anomalies found`);
      
    } catch (error) {
      console.error('Error generating report:', error);
      setTbody(`<tr><td colspan="8" style="text-align:center;color:#dc2626">Error generating report: ${escapeHtml(error.message)}</td></tr>`);
      closeGenerationModal();
    } finally {
      state.loading = false;
      if (generateBtn) generateBtn.disabled = false;
    }
  }

  // ============================================
  // AI INSIGHTS GENERATION
  // ============================================
  
  function generateAiInsights(anomalies, pickfaceCapacity, palletCapacity, stockByLocation, productMap, pickfaceLocationMap) {
    const insightsContainer = document.getElementById('aiInsightsContent');
    const insightsSection = document.getElementById('aiInsightsSection');
    
    if (!insightsContainer || !insightsSection) return;
    
    // Group anomalies by SKU
    const skuAnomalies = {};
    for (const a of anomalies) {
      if (!skuAnomalies[a.sku]) {
        skuAnomalies[a.sku] = { pickface: [], bins: [], product: a.product };
      }
      if (a.type === 'PICKFACE') {
        skuAnomalies[a.sku].pickface.push(a);
      } else {
        skuAnomalies[a.sku].bins.push(a);
      }
    }
    
    // Group stock by SKU for complete analysis
    const stockBySku = {};
    for (const s of stockByLocation) {
      const sku = String(s.sku || '');
      if (!stockBySku[sku]) stockBySku[sku] = [];
      stockBySku[sku].push(s);
    }
    
    // =============================================
    // INSIGHT TYPE 1: REDISTRIBUTE (Pickface OVER + Bins UNDER)
    // =============================================
    const redistributeInsights = [];
    
    for (const [sku, data] of Object.entries(skuAnomalies)) {
      const pickfaceOver = data.pickface.find(p => p.anomalyType === 'OVER');
      const binsUnder = data.bins.filter(b => b.anomalyType === 'UNDER');
      
      const skuStock = stockBySku[sku] || [];
      const pickfaceLoc = pickfaceLocationMap[sku];
      const binLocations = skuStock.filter(s => {
        const loc = normalizeLocation(s.location);
        return loc !== pickfaceLoc;
      });
      
      if (!pickfaceLoc || binLocations.length < 3) continue;
      
      if (pickfaceOver && binsUnder.length > 0) {
        const excessInPickface = pickfaceOver.diff;
        const totalMissingInBins = binsUnder.reduce((sum, b) => sum + Math.abs(b.diff), 0);
        const palletQty = palletCapacity[sku] || 0;
        
        const binsToComplete = binsUnder
          .map(b => ({ location: b.location, missing: Math.abs(b.diff), current: b.qty }))
          .sort((a, b) => a.missing - b.missing);
        
        let remaining = excessInPickface;
        const completable = [];
        
        for (const bin of binsToComplete) {
          if (remaining >= bin.missing) {
            completable.push(bin);
            remaining -= bin.missing;
          }
        }
        
        if (completable.length > 0) {
          redistributeInsights.push({
            sku,
            product: data.product || productMap[sku] || '',
            pickfaceExcess: excessInPickface,
            totalMissing: totalMissingInBins,
            palletQty,
            completableBins: completable,
            remainingExcess: remaining,
            incompleteBins: binsUnder.length - completable.length
          });
        }
      }
    }
    
    // =============================================
    // INSIGHT TYPE 2: GHOST PALLETS (Bins with very low qty - NOT pickface)
    // =============================================
    const ghostInsights = [];
    
    for (const [sku, data] of Object.entries(skuAnomalies)) {
      const palletQty = palletCapacity[sku] || 0;
      if (palletQty === 0) continue;
      
      // Only check bins, not pickface
      const ghostBins = data.bins.filter(b => {
        // Ghost = has less than 30% of expected pallet OR less than 20 units
        const threshold = Math.min(palletQty * 0.3, 20);
        return b.qty > 0 && b.qty <= threshold && b.anomalyType === 'UNDER';
      });
      
      if (ghostBins.length > 0) {
        // Find other incomplete bins that could absorb these
        const otherIncompleteBins = data.bins.filter(b => {
          const threshold = Math.min(palletQty * 0.3, 20);
          return b.qty > threshold && b.anomalyType === 'UNDER';
        });
        
        ghostInsights.push({
          sku,
          product: data.product || productMap[sku] || '',
          palletQty,
          ghostBins: ghostBins.map(b => ({
            location: b.location,
            qty: b.qty,
            missing: Math.abs(b.diff)
          })),
          potentialTargets: otherIncompleteBins.slice(0, 3).map(b => ({
            location: b.location,
            qty: b.qty,
            canReceive: Math.abs(b.diff)
          })),
          totalGhostQty: ghostBins.reduce((sum, b) => sum + b.qty, 0)
        });
      }
    }
    
    // =============================================
    // INSIGHT TYPE 3: CONSOLIDATION (2+ partial bins that could become 1 complete)
    // =============================================
    const consolidateInsights = [];
    
    for (const [sku, data] of Object.entries(skuAnomalies)) {
      const palletQty = palletCapacity[sku] || 0;
      if (palletQty === 0) continue;
      
      // Get all incomplete bins (only UNDER, not OVER)
      const incompleteBins = data.bins
        .filter(b => b.anomalyType === 'UNDER' && b.qty > 0)
        .map(b => ({ location: b.location, qty: b.qty }))
        .sort((a, b) => b.qty - a.qty); // Sort by most units first
      
      if (incompleteBins.length < 2) continue;
      
      // Find consolidation opportunities
      const consolidations = [];
      const usedIndexes = new Set();
      
      for (let i = 0; i < incompleteBins.length && consolidations.length < 3; i++) {
        if (usedIndexes.has(i)) continue;
        
        const bin1 = incompleteBins[i];
        const group = [bin1];
        let totalQty = bin1.qty;
        usedIndexes.add(i);
        
        // Try to find other bins that together form at least 1 pallet
        for (let j = i + 1; j < incompleteBins.length; j++) {
          if (usedIndexes.has(j)) continue;
          
          const bin2 = incompleteBins[j];
          if (totalQty + bin2.qty <= palletQty * 1.1) { // Allow 10% tolerance
            group.push(bin2);
            totalQty += bin2.qty;
            usedIndexes.add(j);
            
            // If we have enough for a full pallet, stop
            if (totalQty >= palletQty * 0.95) break;
          }
        }
        
        // Only include if 2+ bins can form ~1 pallet
        if (group.length >= 2 && totalQty >= palletQty * 0.85) {
          consolidations.push({
            bins: group,
            totalQty,
            palletsFormed: Math.floor(totalQty / palletQty),
            locationsFreed: group.length - Math.ceil(totalQty / palletQty)
          });
        }
      }
      
      if (consolidations.length > 0) {
        consolidateInsights.push({
          sku,
          product: data.product || productMap[sku] || '',
          palletQty,
          consolidations,
          totalLocationsCanFree: consolidations.reduce((sum, c) => sum + c.locationsFreed, 0)
        });
      }
    }
    
    // =============================================
    // INSIGHT TYPE 4: MISSING PALLET RULES
    // =============================================
    const missingRulesInsights = [];
    const skusWithBinAnomalies = new Set();
    
    // Collect all SKUs that have bin locations
    for (const s of stockByLocation) {
      const sku = String(s.sku || '');
      const pickfaceLoc = pickfaceLocationMap[sku];
      const loc = normalizeLocation(s.location);
      
      // Is this a bin (not pickface)?
      if (loc !== pickfaceLoc) {
        skusWithBinAnomalies.add(sku);
      }
    }
    
    // Find SKUs without pallet rules
    for (const sku of skusWithBinAnomalies) {
      if (!palletCapacity[sku]) {
        const skuStock = stockBySku[sku] || [];
        const binLocations = skuStock.filter(s => {
          const loc = normalizeLocation(s.location);
          return loc !== pickfaceLocationMap[sku];
        });
        
        if (binLocations.length > 0) {
          // Calculate suggested qty_pallet based on most common quantity
          const quantities = binLocations.map(b => b.on_hand).filter(q => q > 0);
          const suggestedQty = quantities.length > 0 ? Math.max(...quantities) : null;
          
          missingRulesInsights.push({
            sku,
            product: productMap[sku] || '',
            binCount: binLocations.length,
            totalQty: binLocations.reduce((sum, b) => sum + (b.on_hand || 0), 0),
            suggestedPalletQty: suggestedQty,
            sampleLocations: binLocations.slice(0, 3).map(b => ({
              location: b.location,
              qty: b.on_hand
            }))
          });
        }
      }
    }
    
    // =============================================
    // STORE ALL INSIGHTS & UPDATE TABS
    // =============================================
    window.allAiInsights = {
      redistribute: redistributeInsights.sort((a, b) => b.completableBins.length - a.completableBins.length),
      ghost: ghostInsights.sort((a, b) => b.totalGhostQty - a.totalGhostQty),
      consolidate: consolidateInsights.sort((a, b) => b.totalLocationsCanFree - a.totalLocationsCanFree),
      missing: missingRulesInsights.sort((a, b) => b.binCount - a.binCount)
    };
    
    window.currentAiTab = 'redistribute';
    window.aiInsightsPage = 1;
    window.aiInsightsPerPage = 5;
    
    // Update tab counts
    document.getElementById('tabCountRedistribute').textContent = redistributeInsights.length;
    document.getElementById('tabCountGhost').textContent = ghostInsights.length;
    document.getElementById('tabCountConsolidate').textContent = consolidateInsights.length;
    document.getElementById('tabCountMissing').textContent = missingRulesInsights.length;
    
    const totalInsights = redistributeInsights.length + ghostInsights.length + 
                          consolidateInsights.length + missingRulesInsights.length;
    
    if (totalInsights === 0) {
      insightsSection.style.display = 'none';
      return;
    }
    
    insightsSection.style.display = 'block';
    
    // Set active tab to first one with data
    if (redistributeInsights.length > 0) {
      switchAiInsightTab('redistribute');
    } else if (ghostInsights.length > 0) {
      switchAiInsightTab('ghost');
    } else if (consolidateInsights.length > 0) {
      switchAiInsightTab('consolidate');
    } else {
      switchAiInsightTab('missing');
    }
  }
  
  function switchAiInsightTab(tab) {
    window.currentAiTab = tab;
    window.aiInsightsPage = 1;
    
    // Update tab buttons
    document.querySelectorAll('.ai-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    renderAiInsightsPage();
  }
  
  function renderAiInsightsPage() {
    const insightsContainer = document.getElementById('aiInsightsContent');
    if (!insightsContainer || !window.allAiInsights) return;
    
    const tab = window.currentAiTab || 'redistribute';
    const insights = window.allAiInsights[tab] || [];
    const page = window.aiInsightsPage || 1;
    const perPage = window.aiInsightsPerPage || 5;
    const totalPages = Math.ceil(insights.length / perPage);
    
    const startIdx = (page - 1) * perPage;
    const endIdx = Math.min(startIdx + perPage, insights.length);
    const pageInsights = insights.slice(startIdx, endIdx);
    
    let html = '';
    
    if (insights.length === 0) {
      html = `
        <div style="text-align:center;padding:40px;color:#64748b">
          <p>No issues found in this category</p>
        </div>
      `;
      insightsContainer.innerHTML = html;
      return;
    }
    
    // Render based on tab type
    if (tab === 'redistribute') {
      html = renderRedistributeInsights(pageInsights);
    } else if (tab === 'ghost') {
      html = renderGhostInsights(pageInsights);
    } else if (tab === 'consolidate') {
      html = renderConsolidateInsights(pageInsights);
    } else if (tab === 'missing') {
      html = renderMissingRulesInsights(pageInsights);
    }
    
    // Pagination controls
    if (totalPages > 1) {
      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-top:1px solid #e0f2fe;margin-top:8px">
          <span style="font-size:13px;color:#64748b">
            Showing ${startIdx + 1}-${endIdx} of ${insights.length} insights
          </span>
          <div style="display:flex;align-items:center;gap:8px">
            <button onclick="changeAiInsightsPage(-1)" class="pages-btn" ${page <= 1 ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>‹</button>
            <span style="font-size:13px;color:#475569">Page ${page} / ${totalPages}</span>
            <button onclick="changeAiInsightsPage(1)" class="pages-btn" ${page >= totalPages ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}>›</button>
          </div>
        </div>
      `;
    } else if (insights.length > 0) {
      html += `
        <div style="text-align:center;padding:8px 0;font-size:13px;color:#64748b;border-top:1px solid #e0f2fe;margin-top:8px">
          ${insights.length} insight${insights.length > 1 ? 's' : ''} found
        </div>
      `;
    }
    
    insightsContainer.innerHTML = html;
  }
  
  function renderRedistributeInsights(insights) {
    let html = '';
    for (const insight of insights) {
      const totalToMove = insight.completableBins.reduce((sum, b) => sum + b.missing, 0);
      
      html += `
        <div class="ai-insight-card action">
          <div class="ai-insight-title">
            <strong>${escapeHtml(insight.sku)}</strong> - ${escapeHtml(insight.product)}
          </div>
          <div class="ai-insight-text">
            <strong>Issue:</strong> Pickface has <strong>+${insight.pickfaceExcess}</strong> excess units. 
            ${insight.completableBins.length + insight.incompleteBins} bin locations have incomplete pallets (expected ${insight.palletQty} each).
          </div>
          <div class="ai-insight-text" style="margin-top:8px;color:#059669">
            <strong>Suggestion:</strong> Move <strong>${totalToMove} units</strong> from pickface to complete <strong>${insight.completableBins.length} bins</strong>:
          </div>
          <div class="ai-location-list">
            ${insight.completableBins.map(b => 
              `<span class="ai-location-tag">${escapeHtml(b.location)} (+${b.missing})</span>`
            ).join('')}
          </div>
          ${insight.remainingExcess > 0 ? `
            <div class="ai-insight-text" style="margin-top:8px;font-size:12px;color:#6b7280">
              After redistribution: <strong>${insight.remainingExcess} units</strong> will remain in pickface excess.
              ${insight.incompleteBins > 0 ? `${insight.incompleteBins} bins still incomplete.` : ''}
            </div>
            ${insight.palletQty > 0 && insight.remainingExcess >= insight.palletQty ? `
              <div class="ai-insight-text" style="margin-top:8px;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;color:#991b1b;font-size:12px">
                <strong>Physical Verification Required:</strong> The remaining excess of <strong>${insight.remainingExcess} units</strong> 
                (approx. ${Math.round(insight.remainingExcess / insight.palletQty)} full pallet${Math.round(insight.remainingExcess / insight.palletQty) > 1 ? 's' : ''}) 
                suggests a possible system/physical stock mismatch. Please verify stock on-site.
              </div>
            ` : ''}
          ` : `
            <div class="ai-insight-text" style="margin-top:8px;font-size:12px;color:#059669">
              This will fully resolve the pickface overflow and complete all incomplete bins.
            </div>
          `}
        </div>
      `;
    }
    return html;
  }
  
  function renderGhostInsights(insights) {
    let html = '';
    for (const insight of insights) {
      html += `
        <div class="ai-insight-card ghost">
          <div class="ai-insight-title">
            <strong>${escapeHtml(insight.sku)}</strong> - ${escapeHtml(insight.product)}
          </div>
          <div class="ai-insight-text">
            <strong>Issue:</strong> ${insight.ghostBins.length} bin location${insight.ghostBins.length > 1 ? 's have' : ' has'} 
            very low quantities (ghost pallets). Expected: <strong>${insight.palletQty}</strong> per pallet.
          </div>
          <div class="ai-insight-text" style="margin-top:8px">
            <strong>Ghost Locations:</strong> (total: ${insight.totalGhostQty} units)
          </div>
          <div class="ai-location-list">
            ${insight.ghostBins.map(b => 
              `<span class="ai-location-tag" style="background:#f5f3ff;color:#6d28d9">${escapeHtml(b.location)}: ${b.qty} units</span>`
            ).join('')}
          </div>
          ${insight.potentialTargets.length > 0 ? `
            <div class="ai-insight-text" style="margin-top:12px;color:#059669">
              <strong>Suggestion:</strong> Transfer these units to incomplete bins:
            </div>
            <div class="ai-location-list">
              ${insight.potentialTargets.map(t => 
                `<span class="ai-location-tag">${escapeHtml(t.location)} (has ${t.qty}, can receive ${t.canReceive})</span>`
              ).join('')}
            </div>
            <div class="ai-insight-text" style="margin-top:8px;font-size:12px;color:#059669">
              This will free up ${insight.ghostBins.length} location${insight.ghostBins.length > 1 ? 's' : ''}.
            </div>
          ` : `
            <div class="ai-insight-text" style="margin-top:8px;padding:10px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#92400e;font-size:12px">
              <strong>Manual Review:</strong> No incomplete bins available to absorb these units. 
              Consider transferring to pickface or verify physical stock count.
            </div>
          `}
        </div>
      `;
    }
    return html;
  }
  
  function renderConsolidateInsights(insights) {
    let html = '';
    for (const insight of insights) {
      html += `
        <div class="ai-insight-card consolidate">
          <div class="ai-insight-title">
            <strong>${escapeHtml(insight.sku)}</strong> - ${escapeHtml(insight.product)}
          </div>
          <div class="ai-insight-text">
            <strong>Opportunity:</strong> Multiple partial bins can be consolidated. 
            Pallet capacity: <strong>${insight.palletQty}</strong> units.
          </div>
          ${insight.consolidations.map((c, idx) => `
            <div style="margin-top:12px;padding:10px;background:rgba(14,165,233,0.1);border-radius:6px">
              <div class="ai-insight-text" style="color:#0369a1;font-weight:600">
                Consolidation ${idx + 1}: Merge ${c.bins.length} bins into ${c.palletsFormed} full pallet${c.palletsFormed > 1 ? 's' : ''}
              </div>
              <div class="ai-location-list" style="margin-top:6px">
                ${c.bins.map(b => 
                  `<span class="ai-location-tag">${escapeHtml(b.location)}: ${b.qty}</span>`
                ).join(' + ')}
                <span style="color:#0369a1;font-weight:600"> = ${c.totalQty} units</span>
              </div>
              ${c.locationsFreed > 0 ? `
                <div class="ai-insight-text" style="margin-top:6px;font-size:12px;color:#059669">
                  Frees up ${c.locationsFreed} location${c.locationsFreed > 1 ? 's' : ''}
                </div>
              ` : ''}
            </div>
          `).join('')}
          <div class="ai-insight-text" style="margin-top:12px;font-size:13px;color:#0369a1;font-weight:600">
            Total potential: Free ${insight.totalLocationsCanFree} location${insight.totalLocationsCanFree > 1 ? 's' : ''}
          </div>
        </div>
      `;
    }
    return html;
  }
  
  function renderMissingRulesInsights(insights) {
    let html = `
      <div class="ai-insight-card missing" style="border-left-color:#f59e0b;background:#fffbeb">
        <div class="ai-insight-title">
          <strong>Action Required: Configure Pallet Rules</strong>
        </div>
        <div class="ai-insight-text">
          The following ${insights.length} SKU${insights.length > 1 ? 's have' : ' has'} stock in bin locations but no pallet capacity rule defined.
          Without this data, we cannot detect bin anomalies accurately.
        </div>
        <div class="ai-insight-text" style="margin-top:8px;font-size:12px;color:#92400e">
          <strong>How to fix:</strong> Add entries to the <code>pallet_capacity_rules</code> table with the correct <code>qty_pallet</code> for each SKU.
        </div>
      </div>
    `;
    
    for (const insight of insights) {
      html += `
        <div class="ai-insight-card" style="border-left-color:#ef4444">
          <div class="ai-insight-title">
            <strong>${escapeHtml(insight.sku)}</strong> - ${escapeHtml(insight.product || 'Unknown Product')}
          </div>
          <div class="ai-insight-text">
            Found in <strong>${insight.binCount} bin location${insight.binCount > 1 ? 's' : ''}</strong> 
            with total <strong>${insight.totalQty} units</strong>.
          </div>
          <div class="ai-location-list" style="margin-top:8px">
            ${insight.sampleLocations.map(s => 
              `<span class="ai-location-tag" style="background:#fee2e2;color:#991b1b">${escapeHtml(s.location)}: ${s.qty}</span>`
            ).join('')}
            ${insight.binCount > 3 ? `<span style="color:#6b7280;font-size:12px">... +${insight.binCount - 3} more</span>` : ''}
          </div>
          ${insight.suggestedPalletQty ? `
            <div class="ai-insight-text" style="margin-top:10px;padding:8px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:6px;color:#065f46;font-size:12px">
              <strong>Suggested qty_pallet:</strong> ${insight.suggestedPalletQty} 
              (based on max quantity found in bins)
            </div>
          ` : ''}
        </div>
      `;
    }
    return html;
  }
  
  function changeAiInsightsPage(delta) {
    const tab = window.currentAiTab || 'redistribute';
    const insights = window.allAiInsights?.[tab] || [];
    const totalPages = Math.ceil(insights.length / (window.aiInsightsPerPage || 5));
    const newPage = (window.aiInsightsPage || 1) + delta;
    
    if (newPage >= 1 && newPage <= totalPages) {
      window.aiInsightsPage = newPage;
      renderAiInsightsPage();
    }
  }

  // ============================================
  // COUNTS & FILTERS
  // ============================================
  
  function updateCounts() {
    const anomalies = state.anomalies;
    
    state.counts = {
      all: anomalies.length,
      pickface: anomalies.filter(a => a.type === 'PICKFACE').length,
      bin: anomalies.filter(a => a.type === 'BIN').length,
      over: anomalies.filter(a => a.anomalyType === 'OVER').length,
      under: anomalies.filter(a => a.anomalyType === 'UNDER').length,
      negative: anomalies.filter(a => a.anomalyType === 'NEGATIVE').length
    };
    
    // Update badge counts in UI
    document.getElementById('countAll').textContent = state.counts.all;
    document.getElementById('countPickface').textContent = state.counts.pickface;
    document.getElementById('countBin').textContent = state.counts.bin;
    document.getElementById('countOver').textContent = state.counts.over;
    document.getElementById('countUnder').textContent = state.counts.under;
    document.getElementById('countNegative').textContent = state.counts.negative;
  }

  function applyFilters() {
    let filtered = state.anomalies.slice();
    
    // Apply type filter
    if (state.typeFilter !== 'ALL') {
      filtered = filtered.filter(a => a.type === state.typeFilter);
    }
    
    // Apply anomaly filter
    if (state.anomalyFilter !== 'ALL') {
      filtered = filtered.filter(a => a.anomalyType === state.anomalyFilter);
    }
    
    // Apply favorites filter
    if (state.onlyFavorites) {
      filtered = filtered.filter(a => favorites.has(String(a.sku)));
    }
    
    // Apply search
    const searchTerm = (searchInput?.value || '').trim().toLowerCase();
    if (searchTerm) {
      filtered = filtered.filter(a => 
        a.sku.toLowerCase().includes(searchTerm) ||
        a.location.toLowerCase().includes(searchTerm) ||
        (a.product || '').toLowerCase().includes(searchTerm)
      );
    }
    
    state.filteredAnomalies = filtered;
    state.page = 1;
    render();
  }

  // ============================================
  // FILTER BUTTON HANDLERS
  // ============================================
  
  window.setTypeFilter = function (filter, el) {
    state.typeFilter = filter;
    
    // Update active state
    document.querySelectorAll('[data-type-filter]').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');
    
    applyFilters();
  };

  window.setAnomalyFilter = function (filter, el) {
    state.anomalyFilter = filter;
    
    // Update active state
    document.querySelectorAll('[data-anomaly-filter]').forEach(btn => btn.classList.remove('active'));
    if (el) el.classList.add('active');
    
    applyFilters();
  };

  window.applyFilters = applyFilters;

  // ============================================
  // RENDERING
  // ============================================
  
  function updatePager() {
    const total = state.filteredAnomalies.length;
    const totalPages = Math.max(1, Math.ceil(total / state.perPage));
    
    if (state.page > totalPages) state.page = totalPages;
    if (state.page < 1) state.page = 1;
    
    const info = document.getElementById('anomalyPageInfo');
    if (info) {
      info.textContent = total === 0 ? 'Page 0 / 0' : `Page ${state.page} / ${totalPages}`;
    }
    
    const prevBtn = document.getElementById('anomalyPrevPage');
    const nextBtn = document.getElementById('anomalyNextPage');
    
    if (prevBtn) {
      prevBtn.disabled = state.page <= 1;
      prevBtn.style.opacity = state.page <= 1 ? '0.45' : '1';
    }
    if (nextBtn) {
      nextBtn.disabled = state.page >= totalPages;
      nextBtn.style.opacity = state.page >= totalPages ? '0.45' : '1';
    }
  }

  function render() {
    const rows = state.filteredAnomalies;
    
    if (!rows || rows.length === 0) {
      if (state.anomalies.length === 0) {
        setTbody('<tr><td colspan="9" style="text-align:center;opacity:.7">Click "Generate Report" to analyze stock anomalies</td></tr>');
      } else {
        setTbody('<tr><td colspan="9" style="text-align:center;opacity:.7">No anomalies match the current filters</td></tr>');
      }
      updatePager();
      return;
    }
    
    const start = (state.page - 1) * state.perPage;
    const pageRows = rows.slice(start, start + state.perPage);
    
    const html = pageRows.map(row => {
      const sku = escapeHtml(row.sku);
      const product = escapeHtml(row.product);
      const typeBadgeClass = row.type === 'PICKFACE' ? 'pickface' : 'bin';
      const typeLabel = row.type === 'PICKFACE' ? 'Pickface' : 'Bin/Shelf';
      const location = escapeHtml(row.location);
      const qty = row.qty;
      const expected = row.expected;
      const diff = row.diff;
      const diffClass = diff > 0 ? 'diff-positive' : 'diff-negative';
      const diffSign = diff > 0 ? '+' : '';
      const description = escapeHtml(row.description);
      
      // Favorite star
      const isFav = favorites.has(String(row.sku));
      const favClass = isFav ? 'active' : '';
      const favStar = `<button class="fav-btn ${favClass}" onclick="window.toggleFavoriteSku('${escapeHtml(row.sku)}')" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}">★</button>`;
      
      return `
        <tr>
          <td style="text-align:center">${favStar}</td>
          <td style="font-weight:600">${sku}</td>
          <td>${product}</td>
          <td><span class="type-badge ${typeBadgeClass}">${typeLabel}</span></td>
          <td>${location}</td>
          <td style="text-align:right;font-weight:600">${qty}</td>
          <td style="text-align:right">${expected}</td>
          <td style="text-align:right" class="${diffClass}">${diffSign}${diff}</td>
          <td class="description-cell">${description}</td>
        </tr>
      `;
    }).join('');
    
    setTbody(html);
    updatePager();
  }

  // Expose toggle favorite function globally
  window.toggleFavoriteSku = async function(sku) {
    await toggleFavorite(sku);
  };

  // ============================================
  // PAGINATION
  // ============================================
  
  window.prevPage = function () {
    if (state.page > 1) {
      state.page--;
      render();
    }
  };

  window.nextPage = function () {
    const totalPages = Math.ceil(state.filteredAnomalies.length / state.perPage);
    if (state.page < totalPages) {
      state.page++;
      render();
    }
  };

  // ============================================
  // PRINT FUNCTION
  // ============================================
  
  window.printAnomalies = function () {
    const stamp = formatTimestamp(new Date());
    const ph = document.getElementById('anomalyPrintHeader');
    if (ph) ph.textContent = `Stock Anomaly Report — ${stamp}`;
    
    const prevTitle = document.title;
    document.title = `Stock Anomalies ${stamp.replace(/[/:]/g, '-')}`;
    
    const restore = () => {
      document.title = prevTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    
    setTimeout(() => window.print(), 0);
  };

  // ============================================
  // INITIALIZATION
  // ============================================
  
  // Expose functions globally
  window.generateAnomalyReport = generateAnomalyReport;
  window.switchAiInsightTab = switchAiInsightTab;
  window.changeAiInsightsPage = changeAiInsightsPage;

  // Event listener for search input
  if (searchInput) {
    searchInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        applyFilters();
      }
    });
  }

  // Initialize on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', async () => {
    console.log('📊 Stock Anomaly Checker initialized');
    
    // Load favorites from database
    await loadFavoritesFromDB();
    
    // Set default active states
    const allTypeBtn = document.querySelector('[data-type-filter="ALL"]');
    const allAnomalyBtn = document.querySelector('[data-anomaly-filter="ALL"]');
    if (allTypeBtn) allTypeBtn.classList.add('active');
    if (allAnomalyBtn) allAnomalyBtn.classList.add('active');
    
    // Auto-load report using existing data from restock_report
    // The data is already available from when user generates report in Restock page
    await generateAnomalyReport();
  });

})();
