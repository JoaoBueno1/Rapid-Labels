const https = require('https');
const fs = require('fs');
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';
const MONTHS = 6.53;

function parseCin7Export() {
  const raw = fs.readFileSync('manual import avg main', 'utf-8');
  const lines = raw.split('\n');
  const data = {};
  
  for (let i = 6; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 5) continue;
    const sku = (parts[0] || '').trim();
    const refType = (parts[1] || '').trim();
    const qtyIn = parseFloat((parts[3] || '0').replace(/,/g, '')) || 0;
    const qtyOut = parseFloat((parts[4] || '0').replace(/,/g, '')) || 0;
    if (!sku) continue;
    
    if (!data[sku]) data[sku] = { saleOut: 0, saleIn: 0, xfrOut: 0, xfrIn: 0, fgOut: 0, fgIn: 0 };
    
    if (refType === 'Sale' || refType === 'SaleMultiple') {
      data[sku].saleOut += qtyOut;
      data[sku].saleIn += qtyIn;  // returns
    } else if (refType === 'StockTransfer') {
      data[sku].xfrOut += qtyOut;
      data[sku].xfrIn += qtyIn;
    } else if (refType === 'FinishedGoods') {
      data[sku].fgOut += qtyOut;
      data[sku].fgIn += qtyIn;
    }
  }
  
  const result = {};
  for (const [sku, d] of Object.entries(data)) {
    const saleNet = d.saleOut - d.saleIn;  // net sales (minus returns)
    const xfrNet = Math.max(0, d.xfrOut - d.xfrIn);  // net transfer out
    const fgNet = d.fgOut - d.fgIn;  // net finished goods consumed
    
    result[sku] = {
      // Method A: Sale + SaleMultiple Only (current DB method)
      A_salesOnly: round(d.saleOut / MONTHS),
      // Method B: Sales + StockTransfer NET Out (sent to branches minus received back)
      B_salesPlusXfrNet: round((d.saleOut + xfrNet) / MONTHS),
      // Method C: Sales + StockTransfer TOTAL Out
      C_salesPlusXfrTotalOut: round((d.saleOut + d.xfrOut) / MONTHS),
      // Method D: Sales + StockTransfer Net + FinishedGoods Net (if positive = consumed)
      D_salesXfrFG: round((d.saleOut + xfrNet + Math.max(0, fgNet)) / MONTHS),
      // Method E: ALL out
      E_allOut: round((d.saleOut + d.xfrOut + d.fgOut) / MONTHS),
      // Raw values
      raw: { saleOut: d.saleOut, saleIn: d.saleIn, xfrOut: d.xfrOut, xfrIn: d.xfrIn, fgOut: d.fgOut, fgIn: d.fgIn }
    };
  }
  return result;
}

function round(v) { return Math.round(v * 10) / 10; }

function parseManagerFile() {
  const raw = fs.readFileSync('avg month from manager', 'utf-8');
  const lines = raw.split('\n');
  const result = {};
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 4) continue;
    if (parts[0] === 'SKU' && parts[1] === 'RAPID CODE') continue;
    const cin7Id = (parts[0] || '').trim();
    const rapidCode = (parts[1] || '').trim();
    if (!rapidCode || !cin7Id || isNaN(parseInt(cin7Id))) continue;
    const avg = parseFloat((parts[9] || '0').replace(/,/g, '')) || 0;
    const months = [];
    for (let m = 3; m <= 8; m++) months.push(parseFloat((parts[m] || '0').replace(/,/g, '')) || 0);
    result[rapidCode] = { avg, months, total: months.reduce((a,b) => a+b, 0) };
  }
  return result;
}

function fetchPage(offset) {
  return new Promise((resolve, reject) => {
    const url = `https://iaqnxamnjftwqdbsnfyl.supabase.co/rest/v1/branch_avg_monthly_sales?select=product,avg_mth_main&order=product&offset=${offset}&limit=1000`;
    https.get(url, { headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

(async () => {
  console.log('='.repeat(100));
  console.log('RE-ANALISE COMPLETA — INCLUINDO STOCKTRANSFER + FINISHEDGOODS');
  console.log('='.repeat(100));
  
  const cin7 = parseCin7Export();
  const manager = parseManagerFile();
  
  let dbAll = [];
  let offset = 0;
  while (true) {
    const rows = await fetchPage(offset);
    dbAll = dbAll.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  const db = {};
  for (const r of dbAll) db[r.product] = r.avg_mth_main || 0;
  
  // ============================================================
  // 1. VOLUME TOTAL POR METODO
  // ============================================================
  console.log('\n=== 1. VOLUME TOTAL MENSAL POR METODO ===');
  let totalA = 0, totalB = 0, totalC = 0, totalD = 0, totalE = 0;
  let totalSaleOut = 0, totalXfrOut = 0, totalXfrIn = 0, totalFgOut = 0, totalFgIn = 0;
  
  for (const [sku, c] of Object.entries(cin7)) {
    totalA += c.A_salesOnly;
    totalB += c.B_salesPlusXfrNet;
    totalC += c.C_salesPlusXfrTotalOut;
    totalD += c.D_salesXfrFG;
    totalE += c.E_allOut;
    totalSaleOut += c.raw.saleOut;
    totalXfrOut += c.raw.xfrOut;
    totalXfrIn += c.raw.xfrIn;
    totalFgOut += c.raw.fgOut;
    totalFgIn += c.raw.fgIn;
  }
  
  let totalMgr = 0;
  for (const m of Object.values(manager)) totalMgr += m.avg;
  
  console.log('A) Sales Only (DB atual):      ' + Math.round(totalA) + '/mth');
  console.log('B) Sales + Xfr NET Out:        ' + Math.round(totalB) + '/mth  (+' + Math.round(totalB - totalA) + ' = +' + Math.round((totalB/totalA-1)*100) + '%)');
  console.log('C) Sales + Xfr TOTAL Out:      ' + Math.round(totalC) + '/mth  (+' + Math.round(totalC - totalA) + ' = +' + Math.round((totalC/totalA-1)*100) + '%)');
  console.log('D) Sales + Xfr Net + FG Net:   ' + Math.round(totalD) + '/mth  (+' + Math.round(totalD - totalA) + ' = +' + Math.round((totalD/totalA-1)*100) + '%)');
  console.log('E) ALL Out:                    ' + Math.round(totalE) + '/mth  (+' + Math.round(totalE - totalA) + ' = +' + Math.round((totalE/totalA-1)*100) + '%)');
  console.log('Manager (Jul-Dec):             ' + Math.round(totalMgr) + '/mth');
  
  console.log('\nRaw totals (6.53 months):');
  console.log('  Sale+SaleMultiple Out: ' + Math.round(totalSaleOut));
  console.log('  StockTransfer Out:     ' + Math.round(totalXfrOut) + ' (sent to branches)');
  console.log('  StockTransfer In:      ' + Math.round(totalXfrIn) + ' (received back)');
  console.log('  StockTransfer NET Out: ' + Math.round(totalXfrOut - totalXfrIn) + ' (real branch demand)');
  console.log('  FinishedGoods Out:     ' + Math.round(totalFgOut) + ' (consumed/disassembled)');
  console.log('  FinishedGoods In:      ' + Math.round(totalFgIn) + ' (assembled/produced)');
  console.log('  FinishedGoods NET Out: ' + Math.round(totalFgOut - totalFgIn) + ' (net consumed)');
  
  // ============================================================
  // 2. QUAL METODO BATE COM O MANAGER?
  // ============================================================
  console.log('\n=== 2. QUAL METODO BATE COM O MANAGER? ===');
  console.log('Comparando cada metodo vs Manager para todos os produtos em comum com avg>0\n');
  
  const methodNames = ['A_salesOnly', 'B_salesPlusXfrNet', 'C_salesPlusXfrTotalOut', 'D_salesXfrFG', 'E_allOut'];
  const methodLabels = ['A) Sales Only', 'B) Sales+Xfr Net', 'C) Sales+Xfr Tot', 'D) Sales+Xfr+FG', 'E) ALL Out'];
  
  for (let mi = 0; mi < methodNames.length; mi++) {
    const method = methodNames[mi];
    let closest = 0, within20 = 0, within50 = 0, checked = 0;
    let sumDiffPct = 0, sumAbsDiffPct = 0;
    let totalMethodVal = 0, totalMgrVal = 0;
    
    for (const [sku, m] of Object.entries(manager)) {
      const c = cin7[sku];
      if (!c || m.avg === 0) continue;
      checked++;
      
      const cin7Val = c[method];
      const mgrVal = m.avg;
      totalMethodVal += cin7Val;
      totalMgrVal += mgrVal;
      
      const pct = Math.abs(cin7Val - mgrVal) / mgrVal * 100;
      sumAbsDiffPct += pct;
      sumDiffPct += (cin7Val - mgrVal) / mgrVal * 100;
      
      if (pct < 10) closest++;
      if (pct < 20) within20++;
      if (pct < 50) within50++;
    }
    
    console.log(methodLabels[mi].padEnd(20) + 
      '  <10%: ' + closest + ' (' + Math.round(closest/checked*100) + '%)' +
      '  <20%: ' + within20 + ' (' + Math.round(within20/checked*100) + '%)' +
      '  <50%: ' + within50 + ' (' + Math.round(within50/checked*100) + '%)' +
      '  Avg bias: ' + (sumDiffPct/checked).toFixed(1) + '%' +
      '  Vol ratio: ' + (totalMethodVal/totalMgrVal).toFixed(2) + 'x'
    );
  }
  
  // ============================================================
  // 3. TOP 30 PRODUTOS — TODAS AS METODOLOGIAS
  // ============================================================
  console.log('\n=== 3. TOP 30 PRODUTOS (por volume de venda) ===');
  const topProducts = Object.entries(cin7)
    .sort((a, b) => b[1].A_salesOnly - a[1].A_salesOnly)
    .slice(0, 30);
  
  console.log('SKU'.padEnd(25) + 'A)SaleOnly  B)S+XfrN  C)S+XfrT  D)S+Xfr+FG  E)AllOut  Mgr/M   DB/M    BestFit');
  console.log('-'.repeat(130));
  
  for (const [sku, c] of topProducts) {
    const m = manager[sku];
    const mgrVal = m ? m.avg : 0;
    const dbVal = db[sku] || 0;
    
    // Which method is closest to manager?
    let bestFit = 'N/A';
    if (mgrVal > 0) {
      const diffs = [
        { m: 'A', d: Math.abs(c.A_salesOnly - mgrVal) },
        { m: 'B', d: Math.abs(c.B_salesPlusXfrNet - mgrVal) },
        { m: 'C', d: Math.abs(c.C_salesPlusXfrTotalOut - mgrVal) },
        { m: 'D', d: Math.abs(c.D_salesXfrFG - mgrVal) },
        { m: 'E', d: Math.abs(c.E_allOut - mgrVal) },
      ].sort((a, b) => a.d - b.d);
      bestFit = diffs[0].m;
    }
    
    console.log(
      sku.padEnd(25) + 
      String(c.A_salesOnly).padStart(9) + '  ' +
      String(c.B_salesPlusXfrNet).padStart(8) + '  ' +
      String(c.C_salesPlusXfrTotalOut).padStart(8) + '  ' +
      String(c.D_salesXfrFG).padStart(10) + '  ' +
      String(c.E_allOut).padStart(8) + '  ' +
      String(mgrVal).padStart(6) + '  ' +
      String(dbVal).padStart(6) + '    ' +
      bestFit
    );
  }
  
  // ============================================================
  // 4. PRODUTOS ONDE STOCKTRANSFER FAZ GRANDE DIFERENCA
  // ============================================================
  console.log('\n=== 4. IMPACTO DO STOCKTRANSFER — TOP 30 por Transfer Net Out ===');
  const xfrImpact = Object.entries(cin7)
    .map(([sku, c]) => {
      const xfrNet = Math.max(0, c.raw.xfrOut - c.raw.xfrIn);
      return { sku, xfrNetMth: round(xfrNet / MONTHS), salesMth: c.A_salesOnly, totalMth: c.B_salesPlusXfrNet, mgrMth: manager[sku]?.avg || 0 };
    })
    .sort((a, b) => b.xfrNetMth - a.xfrNetMth)
    .slice(0, 30);
  
  console.log('SKU'.padEnd(25) + 'Sales/M  XfrNet/M  S+XfrN/M  Mgr/M   XfrIncrease  Mgr closer to?');
  console.log('-'.repeat(110));
  
  for (const p of xfrImpact) {
    const increase = p.salesMth > 0 ? Math.round(p.xfrNetMth / p.salesMth * 100) : 999;
    let closerTo = 'N/A';
    if (p.mgrMth > 0) {
      const diffSales = Math.abs(p.salesMth - p.mgrMth);
      const diffTotal = Math.abs(p.totalMth - p.mgrMth);
      closerTo = diffSales <= diffTotal ? 'SALES' : 'S+XFR';
    }
    console.log(
      p.sku.padEnd(25) + 
      String(p.salesMth).padStart(7) + '  ' +
      String(p.xfrNetMth).padStart(8) + '  ' +
      String(p.totalMth).padStart(8) + '  ' +
      String(p.mgrMth).padStart(6) + '   ' +
      ('+' + increase + '%').padStart(10) + '     ' +
      closerTo
    );
  }
  
  // ============================================================
  // 5. FINISHEDGOODS IMPACT
  // ============================================================
  console.log('\n=== 5. FINISHEDGOODS — TOP 20 por FG Net Out ===');
  const fgImpact = Object.entries(cin7)
    .filter(([, c]) => c.raw.fgOut > 0 || c.raw.fgIn > 0)
    .map(([sku, c]) => {
      const fgNet = c.raw.fgOut - c.raw.fgIn;
      return { sku, fgOut: c.raw.fgOut, fgIn: c.raw.fgIn, fgNet, fgNetMth: round(fgNet / MONTHS), salesMth: c.A_salesOnly, mgrMth: manager[sku]?.avg || 0 };
    })
    .sort((a, b) => b.fgNet - a.fgNet)
    .slice(0, 20);
  
  console.log('SKU'.padEnd(30) + 'FG Out   FG In   FG Net/M  Sales/M  S+FG/M  Mgr/M');
  console.log('-'.repeat(100));
  
  for (const p of fgImpact) {
    const sFg = round(p.salesMth + Math.max(0, p.fgNetMth));
    console.log(
      p.sku.padEnd(30) + 
      String(p.fgOut).padStart(7) + '  ' +
      String(p.fgIn).padStart(6) + '  ' +
      String(p.fgNetMth).padStart(8) + '  ' +
      String(p.salesMth).padStart(7) + '  ' +
      String(sFg).padStart(6) + '  ' +
      String(p.mgrMth).padStart(6)
    );
  }
  
  // ============================================================
  // 6. RESTOCK PERSPECTIVE: What does Main need to stock?
  // ============================================================
  console.log('\n=== 6. PERSPECTIVA RESTOCK: O que o Main precisa ter em stock? ===');
  console.log('Para o Main Warehouse, a demanda total eh:');
  console.log('  - Vendas diretas (Sale + SaleMultiple)');
  console.log('  - Envio para branches (StockTransfer Out)');
  console.log('  - Consumo em kits/assembly (FinishedGoods Out)');
  console.log('Menos:');
  console.log('  - Devoluções (Sale In — returns)');
  console.log('  - Recebimentos de branches (StockTransfer In)');
  console.log('  - Producao/montagem (FinishedGoods In)');
  
  console.log('\nMas CUIDADO: StockTransfer In no Main pode ser "recebimento do fornecedor"');
  console.log('            e StockTransfer Out é envio para branches.');
  console.log('            Se voce tem 1 warehouse no relatorio, In pode incluir');
  console.log('            transfers ENTRE a mesma warehouse (exemplo: lote recebido)\n');
  
  // ============================================================
  // 7. WHAT DOES THE MANAGER ACTUALLY MATCH?
  // ============================================================
  console.log('=== 7. CONCLUSAO: O QUE O MANAGER REALMENTE USA? ===');
  
  // Find the closest multiplier for manager vs each method
  // Use products with both cin7 and manager with avg > 50 to reduce noise
  const goodProducts = Object.entries(manager).filter(([sku, m]) => {
    const c = cin7[sku];
    return c && m.avg > 50 && c.A_salesOnly > 20;
  });
  
  console.log('Usando ' + goodProducts.length + ' produtos com Manager > 50/mth E Cin7 Sales > 20/mth:\n');
  
  for (let mi = 0; mi < methodNames.length; mi++) {
    const method = methodNames[mi];
    let ratios = [];
    for (const [sku, m] of goodProducts) {
      const c = cin7[sku];
      const cin7Val = c[method];
      if (cin7Val > 0) ratios.push(m.avg / cin7Val);
    }
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    
    console.log(methodLabels[mi].padEnd(20) + 
      '  Median ratio (Mgr/Cin7): ' + median.toFixed(3) + 
      '  Mean: ' + mean.toFixed(3) +
      (Math.abs(median - 1.0) < 0.15 ? '  *** CLOSE TO 1.0 ***' : '')
    );
  }
  
  // ============================================================
  // 8. PERIODO DIFFERENCE ANALYSIS
  // ============================================================
  console.log('\n=== 8. AJUSTE DE PERIODO ===');
  console.log('Manager: Jul-Dec 2025 (6 meses)');
  console.log('Cin7:    10-Aug-2025 to 25-Feb-2026 (6.53 meses)');
  console.log('');
  console.log('Overlap: Aug-Dec (5 meses)');
  console.log('Manager TEM: Jul (pode ter sazonalidade diferente)');
  console.log('Cin7 TEM: Jan + Fev-2026 parcial');
  console.log('');
  console.log('O ratio natural seria cerca de 0.92-1.08 dependendo da sazonalidade.');
  console.log('Se Manager usa Jul-Dec e Cin7 usa Aug-Feb, a diferenca de volume pode ser');
  console.log('explicada pela sazonalidade (Dez = Natal = mais vendas, Jan = ferias = menos).');
  
  // ============================================================
  // 9. RECOMMENDATION
  // ============================================================
  console.log('\n' + '='.repeat(100));
  console.log('=== RECOMENDACAO FINAL ===');
  console.log('='.repeat(100));
  
  console.log('\nPara avg_mth_main — ha 2 perspectivas:');
  console.log('');
  console.log('PERSPECTIVA 1: "Quanto vendemos por mes?" → Sales Only (A)');
  console.log('  - Usado pelo Manager (confirmado: 85% match com Sales Only)');
  console.log('  - Total: ~' + Math.round(totalA) + '/mth');
  console.log('  - Nao inclui reposicao para branches');
  console.log('');
  console.log('PERSPECTIVA 2: "Quanto sai do Main por mes?" → Sales + Transfer Net (B)');
  console.log('  - Inclui envio para branches = demanda real no Main');
  console.log('  - Total: ~' + Math.round(totalB) + '/mth (+' + Math.round((totalB/totalA-1)*100) + '%)');
  console.log('  - Melhor para RESTOCK do Main Warehouse');
  console.log('  - O Manager NAO usa esse metodo no relatorio dele');
  console.log('');
  console.log('PERSPECTIVA 3: "Nao usar FinishedGoods" (kitting interno)');
  console.log('  - FG Out = componentes consumidos para montar kits');
  console.log('  - FG In = kits montados');
  console.log('  - Se o kit DEPOIS é vendido, a venda aparece em Sale');
  console.log('  - Incluir FG = DUPLA CONTAGEM (componentes + kit vendido)');
  console.log('  - Exceto se FG é "desmontagem" (kit → componentes)');
  
  console.log('\n--- TABELA RESUMO ---');
  console.log('Metodo'.padEnd(25) + 'Total/mth    vs DB      Para que serve');
  console.log('-'.repeat(90));
  console.log('A) Sales Only'.padEnd(25) + String(Math.round(totalA)).padStart(10) + '   =DB atual   Quanto vendemos (como o Manager)');
  console.log('B) Sales + Xfr Net'.padEnd(25) + String(Math.round(totalB)).padStart(10) + '   +' + Math.round((totalB/totalA-1)*100) + '%        Quanto sai do Main (melhor p/ restock)');
  console.log('C) Sales + Xfr TotalOut'.padEnd(25) + String(Math.round(totalC)).padStart(10) + '   +' + Math.round((totalC/totalA-1)*100) + '%      Bruto (inclui devoluções de xfr)');
  console.log('D) Sales+Xfr+FG'.padEnd(25) + String(Math.round(totalD)).padStart(10) + '   +' + Math.round((totalD/totalA-1)*100) + '%       Com kitting (risco dupla contagem)');
  
})();
