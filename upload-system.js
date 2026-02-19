/**
 * SISTEMA DE UPLOAD SIMPLIFICADO E FUNCIONAL
 * Reescrito do zero para garantir funcionamento correto
 */

// Global state
let uploadedStockFile = null;
let uploadedSalesFile = null;

/**
 * PASSO 1: Processar arquivo Stock Availability (formato simples CSV/Excel)
 */
async function parseStockFile(file) {
  console.log('📊 Parsing Stock Availability file:', file.name);
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        // Ler Excel
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        console.log(`✅ File read: ${rows.length} rows`);
        console.log('First 3 rows:', rows.slice(0, 3));
        
        // FORMATO ESPERADO DO CIN7:
        // Row 0: Headers repetidos com nomes de warehouse
        // Row 1: Tipos de colunas (Available, OnHand, Allocated, etc)
        // Row 2+: Dados
        
        const stockData = [];
        
        // Detectar formato automaticamente
        const row0 = rows[0] || [];
        const row1 = rows[1] || [];
        
        // Verificar se é formato multi-warehouse (CIN7 padrão)
        const isMultiWarehouse = row0.some(cell => 
          String(cell || '').toLowerCase().includes('warehouse') ||
          String(cell || '').toLowerCase().includes('main') ||
          String(cell || '').toLowerCase().includes('sydney')
        );
        
        if (isMultiWarehouse) {
          console.log('📋 Detected multi-warehouse format (CIN7)');
          stockData.push(...parseMultiWarehouseFormat(rows));
        } else {
          console.log('📋 Detected simple format');
          stockData.push(...parseSimpleFormat(rows));
        }
        
        console.log(`✅ Parsed ${stockData.length} stock records`);
        if (stockData.length > 0) {
          console.log('Sample:', stockData.slice(0, 3));
        }
        
        resolve(stockData);
      } catch (error) {
        console.error('❌ Parse error:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Parse formato multi-warehouse do CIN7
 */
function parseMultiWarehouseFormat(rows) {
  const locationRow = rows[0];
  const headerRow = rows[1];
  const stockData = [];
  
  // Encontrar coluna SKU
  let skuCol = -1;
  for (let i = 0; i < headerRow.length; i++) {
    const val = String(headerRow[i] || '').toLowerCase().trim();
    if (val === 'sku' || val === 'code') {
      skuCol = i;
      break;
    }
  }
  
  if (skuCol === -1) {
    throw new Error('SKU column not found in row 1');
  }
  
  console.log(`✅ SKU at column ${skuCol}`);
  
  // Mapear warehouses e suas colunas OnHand
  const warehouseColumns = {};
  for (let i = skuCol + 1; i < locationRow.length; i++) {
    const location = String(locationRow[i] || '').trim();
    const colType = String(headerRow[i] || '').toLowerCase().trim();
    
    if (location && (colType === 'onhand' || colType === 'on hand')) {
      warehouseColumns[location] = i;
    }
  }
  
  console.log('✅ Warehouses found:', Object.keys(warehouseColumns));
  
  // Parse dados (começando da linha 2)
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= skuCol) continue;
    
    const sku = String(row[skuCol] || '').trim();
    if (!sku) continue;
    
    // Extrair OnHand de cada warehouse
    for (const [location, colIdx] of Object.entries(warehouseColumns)) {
      const onHand = parseFloat(row[colIdx]) || 0;
      
      stockData.push({
        sku: sku,
        location: location,
        onHand: onHand
      });
    }
  }
  
  return stockData;
}

/**
 * Parse formato simples (SKU, Location, OnHand)
 */
function parseSimpleFormat(rows) {
  const headerRow = rows[0];
  const stockData = [];
  
  // Encontrar colunas
  const cols = {
    sku: -1,
    location: -1,
    onHand: -1
  };
  
  for (let i = 0; i < headerRow.length; i++) {
    const val = String(headerRow[i] || '').toLowerCase().trim();
    
    if (val === 'sku' || val === 'code') cols.sku = i;
    if (val === 'location' || val === 'warehouse') cols.location = i;
    if (val === 'onhand' || val === 'on hand' || val === 'qty') cols.onHand = i;
  }
  
  if (cols.sku === -1 || cols.location === -1 || cols.onHand === -1) {
    throw new Error('Required columns not found (need: SKU, Location, OnHand)');
  }
  
  // Parse dados
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length <= Math.max(cols.sku, cols.location, cols.onHand)) continue;
    
    const sku = String(row[cols.sku] || '').trim();
    const location = String(row[cols.location] || '').trim();
    const onHand = parseFloat(row[cols.onHand]) || 0;
    
    if (sku && location) {
      stockData.push({ sku, location, onHand });
    }
  }
  
  return stockData;
}

/**
 * PASSO 2: Processar arquivo Sales Orders (formato simples)
 */
async function parseSalesFile(file) {
  console.log('📦 Parsing Sales Orders file:', file.name);
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        console.log(`✅ File read: ${rows.length} rows`);
        
        const salesData = [];
        
        // Encontrar linha de cabeçalho (procurar "SKU")
        let headerRowIdx = 0;
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const row = rows[i];
          if (row.some(cell => String(cell || '').toLowerCase().trim() === 'sku')) {
            headerRowIdx = i;
            break;
          }
        }
        
        const headerRow = rows[headerRowIdx];
        
        // Encontrar colunas
        let skuCol = -1, qtyCol = -1;
        for (let i = 0; i < headerRow.length; i++) {
          const val = String(headerRow[i] || '').toLowerCase().trim();
          if (val === 'sku' || val === 'code') skuCol = i;
          if (val === 'qty' || val === 'quantity') qtyCol = i;
        }
        
        if (skuCol === -1 || qtyCol === -1) {
          console.warn('⚠️ Sales orders columns not found, using empty data');
          resolve([]);
          return;
        }
        
        // Parse dados
        for (let i = headerRowIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length <= Math.max(skuCol, qtyCol)) continue;
          
          const sku = String(row[skuCol] || '').trim();
          const qty = parseFloat(row[qtyCol]) || 0;
          
          if (sku && qty > 0) {
            salesData.push({ sku, quantity: qty });
          }
        }
        
        console.log(`✅ Parsed ${salesData.length} sales orders`);
        resolve(salesData);
      } catch (error) {
        console.error('❌ Parse error:', error);
        // Sales orders são opcionais, então não rejeitar
        resolve([]);
      }
    };
    
    reader.onerror = () => resolve([]); // Não bloquear por erro
    reader.readAsArrayBuffer(file);
  });
}

/**
 * PASSO 3: Processar upload e salvar no banco
 */
async function processUpload() {
  console.log('🚀 Starting upload process...');
  
  if (!uploadedStockFile || !uploadedSalesFile) {
    alert('⚠️ Please upload both files');
    return;
  }
  
  try {
    // Parse arquivos
    const stockData = await parseStockFile(uploadedStockFile);
    const salesData = await parseSalesFile(uploadedSalesFile);
    
    console.log(`📊 Stock: ${stockData.length} records`);
    console.log(`📦 Sales: ${salesData.length} records`);
    
    if (stockData.length === 0) {
      throw new Error('No stock data found. Check file format.');
    }
    
    // Buscar produtos e warehouses do banco
    console.log('📋 Loading database...');
    const { data: products } = await window.supabase
      .from('audit_products')
      .select('*')
      .eq('is_active', true);
    
    const { data: warehouses } = await window.supabase
      .from('audit_warehouses')
      .select('*');
    
    console.log(`✅ DB: ${products.length} products, ${warehouses.length} warehouses`);
    
    // Criar run
    const { data: run, error: runError } = await window.supabase
      .from('audit_runs')
      .insert({
        started_at: new Date().toISOString(),
        period_start_date: new Date().toISOString(),
        period_end_date: new Date().toISOString()
      })
      .select()
      .single();
    
    if (runError) throw runError;
    console.log(`✅ Run created: ${run.id}`);
    
    // Criar mapa de produtos
    const productMap = {};
    products.forEach(p => {
      productMap[p.sku_code] = p;
      if (p.display_code) productMap[p.display_code] = p;
    });
    
    // Criar mapa de warehouses
    const warehouseMap = {};
    warehouses.forEach(w => {
      const key = (w.cin7_location || w.name).toLowerCase();
      warehouseMap[key] = w;
    });
    
    console.log('Warehouse keys:', Object.keys(warehouseMap));
    
    // Criar lookup de stock
    const stockLookup = {};
    stockData.forEach(s => {
      const key = `${s.sku}|${s.location.toLowerCase()}`;
      stockLookup[key] = s.onHand;
    });
    
    console.log(`Stock lookup: ${Object.keys(stockLookup).length} entries`);
    
    // Criar records
    const records = [];
    let matched = 0;
    
    products.forEach(product => {
      warehouses.forEach(warehouse => {
        const whKey = (warehouse.cin7_location || warehouse.name).toLowerCase();
        const stockKey = `${product.sku_code}|${whKey}`;
        const altStockKey = product.display_code ? `${product.display_code}|${whKey}` : null;
        
        const qty = stockLookup[stockKey] || (altStockKey ? stockLookup[altStockKey] : null) || 0;
        
        if (qty > 0) matched++;
        
        records.push({
          run_id: run.id,
          product_id: product.id,
          warehouse_id: warehouse.id,
          previous_qty_on_hand: qty,
          expected_qty_on_hand: qty,
          actual_qty_on_hand: null,
          diff_qty: 0,
          anomaly_level: 'none',
          reason_guess: null
        });
      });
    });
    
    console.log(`📝 Created ${records.length} records (${matched} with stock > 0)`);
    
    // Salvar no banco em lotes
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error } = await window.supabase
        .from('audit_stock_analysis')
        .insert(batch);
      
      if (error) throw error;
      console.log(`✅ Saved batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(records.length/batchSize)}`);
    }
    
    console.log('✅ Upload complete!');
    alert(`✅ Upload successful!\n\n${matched} products with stock data\nReloading page...`);
    window.location.reload();
    
  } catch (error) {
    console.error('❌ Error:', error);
    alert(`❌ Upload failed:\n\n${error.message}\n\nCheck console (F12) for details.`);
  }
}

// Expor funções globalmente
window.uploadStockFile = (file) => {
  uploadedStockFile = file;
  console.log('✅ Stock file loaded:', file.name);
};

window.uploadSalesFile = (file) => {
  uploadedSalesFile = file;
  console.log('✅ Sales file loaded:', file.name);
};

window.processUploadSimple = processUpload;

console.log('✅ Simple upload system loaded');
