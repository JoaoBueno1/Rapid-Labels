/**
 * NOVO SISTEMA DE UPLOAD - VERSÃO SIMPLIFICADA E ROBUSTA
 * Este arquivo substitui a lógica de upload problemática
 */

// Função principal de upload
window.handleReportUploadNew = async function() {
  try {
    console.log('🚀 NOVO SISTEMA DE UPLOAD INICIADO');
    
    const stockFile = window.stockAvailabilityFileData;
    const salesFile = window.salesOrdersFileData;
    
    if (!stockFile || !salesFile) {
      alert('⚠️ Por favor, faça upload dos 2 arquivos');
      return;
    }
    
    console.log('📁 Arquivos recebidos:');
    console.log('  Stock:', stockFile.name);
    console.log('  Sales:', salesFile.name);
    
    // Parsear Stock Availability
    console.log('\n📊 Parseando Stock Availability...');
    const stockData = await parseStockFile(stockFile);
    console.log(`✅ ${stockData.length} registros de stock parseados`);
    console.log('Amostra:', stockData.slice(0, 3));
    
    if (stockData.length === 0) {
      throw new Error('Nenhum dado de stock foi encontrado no arquivo. Verifique o formato do Excel.');
    }
    
    // Parsear Sales Orders
    console.log('\n📦 Parseando Sales Orders...');
    const salesData = await parseSalesFile(salesFile);
    console.log(`✅ ${salesData.length} linhas de pedidos parseadas`);
    
    // Buscar produtos e warehouses do banco
    console.log('\n🗃️ Buscando dados do banco...');
    const { data: products } = await window.supabase
      .from('audit_products')
      .select('*')
      .eq('is_active', true);
    
    const { data: warehouses } = await window.supabase
      .from('audit_warehouses')
      .select('*');
    
    console.log(`✅ ${products.length} produtos, ${warehouses.length} warehouses`);
    
    // Criar warehouse map
    const whMap = {};
    warehouses.forEach(wh => {
      const key = (wh.cin7_location || wh.name).toLowerCase().trim();
      whMap[key] = wh;
      console.log(`  WH Map: "${key}" -> ${wh.name}`);
    });
    
    console.log('\n🔍 Warehouse map criado:', Object.keys(whMap));
    
    // Criar stock lookup
    const stockLookup = {};
    stockData.forEach(s => {
      const key = `${s.sku}|${s.location.toLowerCase().trim()}`;
      stockLookup[key] = s;
    });
    
    console.log(`\n📦 Stock lookup: ${Object.keys(stockLookup).length} entradas`);
    console.log('Amostra de keys:', Object.keys(stockLookup).slice(0, 5));
    
    // Criar novo run
    console.log('\n🎯 Criando novo run...');
    const { data: newRun, error: runError } = await window.supabase
      .from('audit_runs')
      .insert({
        started_at: new Date().toISOString(),
        period_start_date: new Date().toISOString(),
        period_end_date: new Date().toISOString()
      })
      .select()
      .single();
    
    if (runError) throw runError;
    console.log(`✅ Run criado: ${newRun.id}`);
    
    // Criar registros de análise
    console.log('\n📝 Criando registros de análise...');
    const records = [];
    let matchCount = 0;
    let zeroCount = 0;
    
    products.forEach(product => {
      warehouses.forEach(warehouse => {
        const whKey = (warehouse.cin7_location || warehouse.name).toLowerCase().trim();
        const stockKey = `${product.sku_code}|${whKey}`;
        const stock = stockLookup[stockKey];
        
        const qty = stock ? stock.onHand : 0;
        
        if (qty > 0) matchCount++;
        else zeroCount++;
        
        // Debug primeiro produto
        if (product.sku_code === '90301' && warehouse.name.includes('Sydney')) {
          console.log(`\n🔍 DEBUG 90301 @ Sydney:`);
          console.log('  Warehouse key:', whKey);
          console.log('  Stock key:', stockKey);
          console.log('  Stock found:', !!stock);
          console.log('  Quantity:', qty);
        }
        
        records.push({
          run_id: newRun.id,
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
    
    console.log(`\n📊 Estatísticas:`);
    console.log(`  Total de registros: ${records.length}`);
    console.log(`  Com stock (qty > 0): ${matchCount}`);
    console.log(`  Sem stock (qty = 0): ${zeroCount}`);
    
    if (matchCount === 0) {
      throw new Error('NENHUM MATCH! Verifique os nomes dos warehouses no Excel vs banco de dados.');
    }
    
    // Inserir em lotes
    console.log('\n💾 Salvando no banco...');
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error } = await window.supabase
        .from('audit_stock_analysis')
        .insert(batch);
      
      if (error) throw error;
      console.log(`  ✅ Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(records.length/batchSize)}`);
    }
    
    console.log('\n🎉 UPLOAD COMPLETO!');
    alert(`✅ Upload concluído!\n\n${matchCount} registros com stock\n${zeroCount} registros sem stock\n\nA página vai recarregar.`);
    
    // Fechar modal e recarregar
    if (typeof closeUploadReportsModal === 'function') {
      closeUploadReportsModal();
    }
    window.location.reload();
    
  } catch (error) {
    console.error('❌ ERRO:', error);
    alert('❌ Erro no upload:\n\n' + error.message);
  }
};

// Parser de Stock File SIMPLIFICADO
async function parseStockFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        console.log('📖 Lendo arquivo Excel...');
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        
        console.log(`  ${rows.length} linhas lidas`);
        
        // Detectar formato: verificar se é formato CIN7 multi-warehouse
        const row0 = rows[0] || [];
        const row1 = rows[1] || [];
        
        console.log('  Primeiras células Row 0:', row0.slice(0, 5));
        console.log('  Primeiras células Row 1:', row1.slice(0, 5));
        
        // Tentar encontrar coluna SKU
        let skuCol = -1;
        for (let i = 0; i < row1.length; i++) {
          const cell = String(row1[i] || '').toLowerCase().trim();
          if (cell === 'sku' || cell === 'code') {
            skuCol = i;
            break;
          }
        }
        
        if (skuCol === -1) {
          // Tentar formato simples: SKU, Location, OnHand
          console.log('  Tentando formato simples...');
          return resolve(parseSimpleFormat(rows));
        }
        
        console.log(`  Coluna SKU: ${skuCol}`);
        
        // Formato CIN7 multi-warehouse
        console.log('  Detectado: Formato CIN7 multi-warehouse');
        
        // Mapear warehouses e colunas OnHand
        const whColumns = {}; // { 'Main Warehouse': 3, 'Sydney': 7, ... }
        
        for (let col = skuCol + 1; col < row0.length; col++) {
          const location = String(row0[col] || '').trim();
          const colType = String(row1[col] || '').toLowerCase().trim();
          
          if (location && (colType === 'onhand' || colType === 'on hand' || colType === 'quantity on hand')) {
            whColumns[location] = col;
            console.log(`    ${location} -> col ${col}`);
          }
        }
        
        console.log(`  ${Object.keys(whColumns).length} warehouses encontrados`);
        
        // Parsear dados
        const result = [];
        for (let r = 2; r < rows.length; r++) {
          const row = rows[r];
          const sku = String(row[skuCol] || '').trim();
          
          if (!sku) continue;
          
          // Para cada warehouse, pegar OnHand
          for (const [location, col] of Object.entries(whColumns)) {
            const onHand = parseFloat(row[col]) || 0;
            
            if (onHand > 0) { // Só adicionar se tiver stock
              result.push({
                sku,
                location,
                onHand
              });
            }
          }
        }
        
        resolve(result);
        
      } catch (error) {
        console.error('❌ Erro ao parsear:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Erro ao ler arquivo'));
    reader.readAsArrayBuffer(file);
  });
}

// Parser formato simples (fallback)
function parseSimpleFormat(rows) {
  console.log('  Usando parser simples...');
  const headers = rows[0].map(h => String(h || '').toLowerCase().trim());
  const skuIdx = headers.findIndex(h => h === 'sku' || h === 'code');
  const locIdx = headers.findIndex(h => h === 'location' || h === 'warehouse');
  const qtyIdx = headers.findIndex(h => h === 'onhand' || h === 'quantity' || h === 'qty');
  
  if (skuIdx === -1 || locIdx === -1 || qtyIdx === -1) {
    throw new Error('Colunas não encontradas. Esperado: SKU, Location, OnHand');
  }
  
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sku = String(row[skuIdx] || '').trim();
    const location = String(row[locIdx] || '').trim();
    const onHand = parseFloat(row[qtyIdx]) || 0;
    
    if (sku && location && onHand > 0) {
      result.push({ sku, location, onHand });
    }
  }
  
  return result;
}

// Parser de Sales (simplificado - pode retornar vazio por enquanto)
async function parseSalesFile(file) {
  return []; // Por enquanto ignorar sales
}

console.log('✅ Novo sistema de upload carregado');
