const https = require('https');
const fs = require('fs');
const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

// ============================================================
// SOURCE 1: "manual import avg main" (Cin7 Stock Movement export)
// Period: 10-Aug-2025 to 25-Feb-2026 = 199 days = 6.53 months
// Method: Sale + SaleMultiple Qty Out / 6.53
// ============================================================
function parseCin7Export() {
  const raw = fs.readFileSync('manual import avg main', 'utf-8');
  const lines = raw.split('\n');
  const data = {};  // SKU -> { salesOut, transferIn, transferOut, references: Set }
  
  for (let i = 6; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 5) continue;
    const sku = (parts[0] || '').trim();
    const refType = (parts[1] || '').trim();
    const qtyIn = parseFloat((parts[3] || '0').replace(/,/g, '')) || 0;
    const qtyOut = parseFloat((parts[4] || '0').replace(/,/g, '')) || 0;
    if (!sku) continue;
    
    if (!data[sku]) data[sku] = { salesOut: 0, transferOut: 0, transferIn: 0, totalOut: 0, references: new Set() };
    data[sku].references.add(refType);
    
    if (refType === 'Sale' || refType === 'SaleMultiple') {
      data[sku].salesOut += qtyOut;
    } else if (refType === 'StockTransfer') {
      data[sku].transferOut += qtyOut;
      data[sku].transferIn += qtyIn;
    }
    data[sku].totalOut += qtyOut;
  }
  
  const months = 6.53;
  const result = {};
  for (const [sku, d] of Object.entries(data)) {
    result[sku] = {
      avgMthSalesOnly: Math.round(d.salesOut / months * 10) / 10,
      avgMthSalesAndTransfer: Math.round((d.salesOut + Math.max(0, d.transferOut - d.transferIn)) / months * 10) / 10,
      avgMthTotalOut: Math.round(d.totalOut / months * 10) / 10,
      salesOut: d.salesOut,
      transferOut: d.transferOut,
      transferIn: d.transferIn,
      hasTransfer: d.references.has('StockTransfer')
    };
  }
  return result;
}

// ============================================================
// SOURCE 2: "avg month from manager" (Manager's report)
// Has JUL-DEC monthly data + AVG column
// ============================================================
function parseManagerFile() {
  const raw = fs.readFileSync('avg month from manager', 'utf-8');
  const lines = raw.split('\n');
  const result = {};
  
  // Detect header
  let hasStockTransfer = false;
  let headerCols = [];
  
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 4) continue;
    
    // Check header line
    if (parts[0] === 'SKU' && parts[1] === 'RAPID CODE') {
      headerCols = parts.map(p => p.trim());
      continue;
    }
    
    const cin7Id = (parts[0] || '').trim();
    const rapidCode = (parts[1] || '').trim();
    const desc = (parts[2] || '').trim();
    
    if (!rapidCode || !cin7Id || isNaN(parseInt(cin7Id))) continue;
    
    // Monthly values: JUL=3, AUG=4, SEP=5, OCT=6, NOV=7, DEC=8, AVG=9
    const months = [];
    for (let m = 3; m <= 8; m++) {
      const v = parseFloat((parts[m] || '0').replace(/,/g, '')) || 0;
      months.push(v);
    }
    const avg = parseFloat((parts[9] || '0').replace(/,/g, '')) || 0;
    const total = months.reduce((a, b) => a + b, 0);
    const calcAvg = Math.round(total / 6 * 10) / 10;
    
    // Check for negative values (returns/credits)
    const hasNegative = months.some(m => m < 0);
    
    result[rapidCode] = {
      cin7Id,
      desc,
      months,
      avg,          // AVG from file
      calcAvg,      // calculated avg
      total,
      hasNegative,
      avgMatch: Math.abs(avg - calcAvg) < 2
    };
  }
  
  return result;
}

// ============================================================
// SOURCE 3: Chat data (Wk/Avg targets)  
// Already in _analyze_wkavg.js — load from memory
// ============================================================
function parseChatData() {
  // This is the Wk/Avg data user pasted in chat
  // Read from our analysis file
  const raw = fs.readFileSync('_analyze_wkavg.js', 'utf-8');
  
  // Extract data between backtick template literals
  const match = raw.match(/const rawData = `([\s\S]*?)`;/);
  if (!match) return {};
  
  const lines = match[1].split('\n');
  const result = {};
  
  for (const line of lines) {
    const parts = line.split('\t');
    const sku = (parts[0] || '').trim();
    const valStr = (parts[1] || '').trim();
    if (!sku) continue;
    if (valStr === '#N/A' || valStr === '') continue;
    const wkAvg = parseFloat(valStr);
    if (isNaN(wkAvg)) continue;
    result[sku] = {
      wkAvg,
      mthAvg: Math.round(wkAvg * 4.33 * 10) / 10
    };
  }
  return result;
}

// ============================================================
// FETCH DB data
// ============================================================
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
  console.log('Parsing 3 sources...\n');
  
  const cin7 = parseCin7Export();
  const manager = parseManagerFile();
  const chat = parseChatData();
  
  // Fetch DB
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
  
  console.log('=== CONTAGEM DE SKUs POR FONTE ===');
  console.log('1. Cin7 Export (manual import avg main): ' + Object.keys(cin7).length + ' SKUs');
  console.log('2. Manager File (avg month from manager): ' + Object.keys(manager).length + ' SKUs');
  console.log('3. Chat Data (Wk/Avg targets): ' + Object.keys(chat).length + ' SKUs');
  console.log('4. DB atual: ' + dbAll.length + ' SKUs');
  
  // ============================================================
  // ANALYSIS 1: What period does the manager file cover?
  // ============================================================
  console.log('\n=== ANALISE 1: PERIODO DO MANAGER ===');
  console.log('Colunas: JUL, AUG, SEP, OCT, NOV, DEC');
  console.log('Provavelmente Jul-2025 a Dec-2025 = 6 meses');
  console.log('Cin7 export: 10-Aug-2025 a 25-Feb-2026 = 6.53 meses');
  
  // ============================================================
  // ANALYSIS 2: Does manager include Stock Transfer?
  // ============================================================
  console.log('\n=== ANALISE 2: MANAGER INCLUI STOCK TRANSFER? ===');
  // Compare manager AVG with cin7 sales-only vs cin7 sales+transfer
  let salesOnlyCloser = 0, salesTransferCloser = 0, totalOutCloser = 0, checked = 0;
  let sampleProducts = [];
  
  const keySkus = ['R1021-WH-TRI', 'RQC', 'R1031-WH-TRI', 'RSS', 'R1060-WH-TRI', 
    'R3206-TRI', 'R3540-TRI', 'R1055-WH-TRI', 'R2384-AL-2M', 'R2341-WW',
    'R9991-WH', 'R9992-WH', 'R3570-TRI', 'R3580', 'R3118', 'RSSM',
    'R2321-WW', 'R2332-WW-V2', 'R2333-WW', 'R2382-AL-2M',
    'R107M-12W-WW-60', 'R1072-WH', 'R1071-WH-WW-60', 'R-GPO2-WH',
    'R-HMB', 'R-PMB', 'R-SW1-WH', 'R-SLGPO2-WH'];
  
  console.log('\n' + 'SKU'.padEnd(25) + 'Manager/M  Cin7Sale  Cin7+Xfr  Cin7TotO  Chat/M    DB/M      Best Match');
  console.log('-'.repeat(120));
  
  for (const sku of keySkus) {
    const m = manager[sku];
    const c = cin7[sku];
    const ch = chat[sku];
    
    if (!m || !c) continue;
    
    const mgrAvg = m.avg;
    const cin7Sales = c.avgMthSalesOnly;
    const cin7SalesXfr = c.avgMthSalesAndTransfer;
    const cin7Total = c.avgMthTotalOut;
    const chatMth = ch ? ch.mthAvg : 0;
    const dbVal = db[sku] || 0;
    
    const diffSales = Math.abs(mgrAvg - cin7Sales);
    const diffXfr = Math.abs(mgrAvg - cin7SalesXfr);
    const diffTotal = Math.abs(mgrAvg - cin7Total);
    
    let bestMatch = 'SALES ONLY';
    if (diffXfr < diffSales && diffXfr < diffTotal) bestMatch = 'SALES+XFR';
    if (diffTotal < diffSales && diffTotal < diffXfr) bestMatch = 'TOTAL OUT';
    
    if (diffSales <= diffXfr && diffSales <= diffTotal) salesOnlyCloser++;
    else if (diffXfr < diffTotal) salesTransferCloser++;
    else totalOutCloser++;
    
    checked++;
    
    console.log(
      sku.padEnd(25) + 
      String(mgrAvg).padStart(8) + '  ' +
      String(cin7Sales).padStart(8) + '  ' +
      String(cin7SalesXfr).padStart(8) + '  ' +
      String(cin7Total).padStart(8) + '  ' +
      String(chatMth).padStart(8) + '  ' +
      String(dbVal).padStart(8) + '  ' +
      bestMatch
    );
  }
  
  // Now do broader comparison
  let broadSalesCloser = 0, broadXfrCloser = 0, broadTotalCloser = 0, broadChecked = 0;
  for (const [sku, m] of Object.entries(manager)) {
    const c = cin7[sku];
    if (!c || m.avg === 0) continue;
    
    const diffSales = Math.abs(m.avg - c.avgMthSalesOnly);
    const diffXfr = Math.abs(m.avg - c.avgMthSalesAndTransfer);
    const diffTotal = Math.abs(m.avg - c.avgMthTotalOut);
    
    if (diffSales <= diffXfr && diffSales <= diffTotal) broadSalesCloser++;
    else if (diffXfr < diffTotal) broadXfrCloser++;
    else broadTotalCloser++;
    broadChecked++;
  }
  
  console.log('\n--- Conclusao Broad (todos com avg > 0): ' + broadChecked + ' produtos ---');
  console.log('Manager mais proximo de Sales Only: ' + broadSalesCloser + ' (' + Math.round(broadSalesCloser / broadChecked * 100) + '%)');
  console.log('Manager mais proximo de Sales+Transfer: ' + broadXfrCloser + ' (' + Math.round(broadXfrCloser / broadChecked * 100) + '%)');
  console.log('Manager mais proximo de Total Out: ' + broadTotalCloser + ' (' + Math.round(broadTotalCloser / broadChecked * 100) + '%)');
  
  // ============================================================
  // ANALYSIS 3: Chat vs Manager vs Cin7 vs DB
  // ============================================================
  console.log('\n=== ANALISE 3: CHAT (Wk/Avg) vs MANAGER vs CIN7 vs DB ===');
  
  // What is the Chat data? Compare it to manager
  let chatVsMgr_close = 0, chatVsMgr_far = 0, chatVsMgr_checked = 0;
  let chatSamples = [];
  for (const [sku, ch] of Object.entries(chat)) {
    const m = manager[sku];
    if (!m || m.avg === 0) continue;
    
    const chatMth = ch.mthAvg;
    const mgrMth = m.avg;
    const diff = chatMth - mgrMth;
    const pct = Math.round(diff / mgrMth * 100);
    
    chatVsMgr_checked++;
    if (Math.abs(pct) < 20) chatVsMgr_close++;
    else chatVsMgr_far++;
    
    if (Math.abs(diff) > 100) {
      chatSamples.push({ sku, chatWk: ch.wkAvg, chatMth, mgrMth, diff: Math.round(diff), pct });
    }
  }
  
  console.log('Chat vs Manager comparison (' + chatVsMgr_checked + ' SKUs com avg>0):');
  console.log('  Proximos (< 20% diff): ' + chatVsMgr_close);
  console.log('  Distantes (>= 20% diff): ' + chatVsMgr_far);
  
  // Chat Wk/Avg: does Wk/Avg match Manager/4.33?
  console.log('\n--- Chat Wk/Avg vs Manager AVG / 4.33 ---');
  let wkMatchCount = 0, wkTotalChecked = 0;
  for (const [sku, ch] of Object.entries(chat)) {
    const m = manager[sku];
    if (!m || m.avg === 0) continue;
    wkTotalChecked++;
    const mgrWk = m.avg / 4.33;
    const diff = Math.abs(ch.wkAvg - mgrWk);
    const pct = Math.abs(diff / mgrWk * 100);
    if (pct < 15) wkMatchCount++;
  }
  console.log('Chat Wk matches Manager/4.33 within 15%: ' + wkMatchCount + '/' + wkTotalChecked + ' (' + Math.round(wkMatchCount / wkTotalChecked * 100) + '%)');
  
  // Chat ratio vs Manager
  let chatTotalMth = 0, mgrTotalMth = 0;
  for (const [sku, ch] of Object.entries(chat)) {
    const m = manager[sku];
    if (!m) continue;
    chatTotalMth += ch.mthAvg;
    mgrTotalMth += m.avg;
  }
  console.log('\nTotal mensal Chat (correspondentes): ' + Math.round(chatTotalMth));
  console.log('Total mensal Manager (correspondentes): ' + Math.round(mgrTotalMth));
  console.log('Ratio Chat/Manager: ' + (chatTotalMth / mgrTotalMth).toFixed(2) + 'x');
  
  // ============================================================
  // ANALYSIS 4: Product renames / versions
  // ============================================================
  console.log('\n=== ANALISE 4: PRODUTOS COM RENAMING (ex: 12W removido) ===');
  
  // Find cases where old SKU has history but new SKU has 0 or vice versa
  const renamePatterns = [
    // Old format had "12W" in the name, new doesn't
    { old: 'R1071-WH-12W-WW-60', new: 'R1071-WH-WW-60', desc: 'R1071 WH WW 60' },
    { old: 'R1071-WH-12W-CW-60', new: 'R1071-WH-CW-60', desc: 'R1071 WH CW 60' },
    { old: 'R1071-A-WH-12W-WW-60', new: 'R1071-A-WH-WW-60', desc: 'R1071-A WH WW 60' },
    { old: 'R1071-A-WH-12W-CW-60', new: 'R1071-A-WH-CW-60', desc: 'R1071-A WH CW 60' },
    { old: 'R1073-WH-12W-CW-60', new: 'R1073-WH-CW-60', desc: 'R1073 WH CW 60' },
    { old: 'R1073-WH-12W-WW-60', new: 'R1073-WH-WW-60', desc: 'R1073 WH WW 60' },
    { old: 'R1079-WH-12W-CW-60', new: 'R1079-WH-CW-60', desc: 'R1079 WH CW 60' },
    { old: 'R1079-WH-12W-WW-60', new: 'R1079-WH-WW-60', desc: 'R1079 WH WW 60' },
    { old: 'R107M-WW-60', new: 'R107M-12W-WW-60', desc: 'R107M WW 60 (reverse - old short, new long)' },
    { old: 'R0001-RF', new: 'R0001-RF-V2', desc: 'Smoke Alarm V2' },
  ];
  
  // Try to automatically detect 12W removals
  const allSkus = new Set([...Object.keys(cin7), ...Object.keys(manager), ...Object.keys(chat)]);
  const possibleRenames = [];
  
  for (const sku of allSkus) {
    if (sku.includes('-12W-') || sku.includes('-12w-')) {
      const withoutW = sku.replace(/-12[Ww]-/, '-');
      if (allSkus.has(withoutW)) {
        possibleRenames.push({ old: sku, new: withoutW });
      }
    }
    // V1/V2 transitions
    if (sku.endsWith('-V1')) {
      const base = sku.slice(0, -3);
      if (allSkus.has(base)) {
        possibleRenames.push({ old: sku, new: base, type: 'V1->base' });
      }
      const v2 = base + '-V2';
      if (allSkus.has(v2)) {
        possibleRenames.push({ old: sku, new: v2, type: 'V1->V2' });
      }
    }
  }
  
  // Deduplicate
  const renameMap = {};
  for (const r of possibleRenames) {
    const key = r.old + '|' + r.new;
    renameMap[key] = r;
  }
  
  const detectedRenames = Object.values(renameMap).filter(r => {
    const cin7Old = cin7[r.old];
    const cin7New = cin7[r.new];
    const mgrOld = manager[r.old];
    const mgrNew = manager[r.new];
    // At least one has significant sales
    return (cin7Old && cin7Old.avgMthSalesOnly > 5) || (cin7New && cin7New.avgMthSalesOnly > 5) ||
           (mgrOld && mgrOld.avg > 5) || (mgrNew && mgrNew.avg > 5);
  });
  
  console.log('Detected ' + detectedRenames.length + ' potential renames with sales > 5/mth:');
  console.log('OLD SKU'.padEnd(30) + 'NEW SKU'.padEnd(30) + 'Cin7Old  Cin7New  MgrOld  MgrNew  ChatOld  ChatNew  Combined');
  console.log('-'.repeat(140));
  
  for (const r of detectedRenames) {
    const c7o = cin7[r.old] ? cin7[r.old].avgMthSalesOnly : 0;
    const c7n = cin7[r.new] ? cin7[r.new].avgMthSalesOnly : 0;
    const mo = manager[r.old] ? manager[r.old].avg : 0;
    const mn = manager[r.new] ? manager[r.new].avg : 0;
    const cho = chat[r.old] ? chat[r.old].mthAvg : 0;
    const chn = chat[r.new] ? chat[r.new].mthAvg : 0;
    const combined = c7o + c7n;
    
    console.log(
      r.old.padEnd(30) + r.new.padEnd(30) + 
      String(c7o).padStart(7) + '  ' + String(c7n).padStart(7) + '  ' +
      String(mo).padStart(6) + '  ' + String(mn).padStart(6) + '  ' +
      String(cho).padStart(7) + '  ' + String(chn).padStart(7) + '  ' +
      String(combined).padStart(8)
    );
  }
  
  // ============================================================
  // ANALYSIS 5: Specific high-diff investigation  
  // ============================================================
  console.log('\n=== ANALISE 5: INVESTIGACAO DOS MAIORES DIFFS ===');
  console.log('Investigando por que Chat/Wk*4.33 é ~2.24x maior que DB...\n');
  
  const investigate = ['R1021-WH-TRI', 'RQC', 'R1031-WH-TRI', 'RSS', 'R-GPO2-WH',
    'R1060-WH-TRI', 'R0001-RF', 'R3206-TRI', 'R1055-WH-TRI', 'R107M-12W-WW-60',
    'R3540-TRI', 'R1071-WH-WW-60', 'R107M-WW-60', 'R1053-WH-TRI', 'R3580',
    'R-GPO2-WH-V1', 'R3542-TRI', 'R1072-WH', 'R-HMB', 'R-PMB',
    'RSSM', 'R3118', 'R3570-TRI', 'R9991-WH'];
  
  console.log('SKU'.padEnd(25) + ' Chat/Wk  Chat/M  Mgr/M  Cin7/M  DB/M    Chat vs Mgr  Cin7 vs Mgr  Recommend');
  console.log('-'.repeat(130));
  
  for (const sku of investigate) {
    const ch = chat[sku];
    const m = manager[sku];
    const c = cin7[sku];
    
    const chatWk = ch ? ch.wkAvg : '-';
    const chatMth = ch ? ch.mthAvg : 0;
    const mgrMth = m ? m.avg : 0;
    const cin7Mth = c ? c.avgMthSalesOnly : 0;
    const dbMth = db[sku] || 0;
    
    const chatVsMgr = mgrMth > 0 ? (chatMth / mgrMth * 100 - 100).toFixed(0) + '%' : 'N/A';
    const cin7VsMgr = mgrMth > 0 ? (cin7Mth / mgrMth * 100 - 100).toFixed(0) + '%' : 'N/A';
    
    // What to recommend?
    let recommend = '';
    if (mgrMth > 0 && cin7Mth > 0) {
      const ratio = cin7Mth / mgrMth;
      if (ratio > 0.7 && ratio < 1.3) recommend = 'CIN7=MGR OK';
      else if (ratio > 1.3) recommend = 'CIN7 HIGHER';
      else recommend = 'MGR HIGHER';
    } else if (cin7Mth > 0 && mgrMth === 0) {
      recommend = 'USE CIN7';
    } else if (mgrMth > 0 && cin7Mth === 0) {
      recommend = 'USE MGR';
    }
    
    console.log(
      sku.padEnd(25) + 
      String(chatWk).padStart(7) + '  ' +
      String(chatMth).padStart(6) + '  ' +
      String(mgrMth).padStart(6) + '  ' +
      String(cin7Mth).padStart(6) + '  ' +
      String(dbMth).padStart(6) + '    ' +
      chatVsMgr.padStart(8) + '    ' +
      cin7VsMgr.padStart(8) + '    ' +
      recommend
    );
  }
  
  // ============================================================
  // ANALYSIS 6: Coverage comparison
  // ============================================================
  console.log('\n=== ANALISE 6: COBERTURA ===');
  
  const cin7Skus = new Set(Object.keys(cin7));
  const mgrSkus = new Set(Object.keys(manager));
  const chatSkus = new Set(Object.keys(chat));
  const dbSkus = new Set(Object.keys(db));
  
  const inMgrNotCin7 = [...mgrSkus].filter(s => !cin7Skus.has(s));
  const inCin7NotMgr = [...cin7Skus].filter(s => !mgrSkus.has(s));
  const inChatNotMgr = [...chatSkus].filter(s => !mgrSkus.has(s));
  const inMgrNotChat = [...mgrSkus].filter(s => !chatSkus.has(s));
  
  console.log('No Manager mas NAO no Cin7: ' + inMgrNotCin7.length);
  console.log('No Cin7 mas NAO no Manager: ' + inCin7NotMgr.length);
  console.log('No Chat mas NAO no Manager: ' + inChatNotMgr.length);
  console.log('No Manager mas NAO no Chat: ' + inMgrNotChat.length);
  
  // Products with sales in Manager but missing from Cin7
  const mgrWithSalesNotCin7 = inMgrNotCin7.filter(s => manager[s].avg > 0);
  if (mgrWithSalesNotCin7.length > 0) {
    console.log('\nProducts with avg>0 in Manager but NOT in Cin7 export (top 20):');
    mgrWithSalesNotCin7.sort((a, b) => manager[b].avg - manager[a].avg);
    for (const s of mgrWithSalesNotCin7.slice(0, 20)) {
      console.log('  ' + s.padEnd(35) + ' MgrAvg: ' + manager[s].avg + '  Desc: ' + (manager[s].desc || '').substring(0, 50));
    }
  }
  
  // Products with sales in Cin7 but 0 in Manager
  const cin7WithSalesNotMgr = [...cin7Skus].filter(s => cin7[s].avgMthSalesOnly > 10 && manager[s] && manager[s].avg === 0);
  if (cin7WithSalesNotMgr.length > 0) {
    cin7WithSalesNotMgr.sort((a, b) => cin7[b].avgMthSalesOnly - cin7[a].avgMthSalesOnly);
    console.log('\nProducts with Cin7 sales > 10/mth but Manager = 0 (top 20):');
    for (const s of cin7WithSalesNotMgr.slice(0, 20)) {
      console.log('  ' + s.padEnd(35) + ' Cin7: ' + cin7[s].avgMthSalesOnly + '/mth  Transfer: ' + (cin7[s].hasTransfer ? 'YES' : 'NO'));
    }
  }
  
  // ============================================================
  // ANALYSIS 7: Manager period validation
  // ============================================================
  console.log('\n=== ANALISE 7: VALIDACAO DO PERIODO DO MANAGER ===');
  console.log('Cin7 = 10-Aug-2025 a 25-Feb-2026 (6.53 meses, inclui Aug parcial)');
  console.log('Manager = JUL a DEC (6 meses completos)');
  console.log('OVERLAP: Aug-Dec (5 meses)');
  console.log('Manager TEM Jul (Cin7 nao tem)');  
  console.log('Cin7 TEM Jan+Feb-2026 (Manager nao tem)\n');
  
  // Check if sums match for the overlap period
  // Manager months[0]=JUL, months[1]=AUG, ... months[5]=DEC
  // Cin7 has Aug-Feb... we can't split months from Cin7 
  // But we can compare total ratios
  
  // Overall volume comparison
  let cin7TotalSales = 0, mgrTotalAvg = 0;
  let cin7ActiveSkus = 0;
  for (const [sku, c] of Object.entries(cin7)) {
    if (c.avgMthSalesOnly > 0) cin7ActiveSkus++;
    cin7TotalSales += c.avgMthSalesOnly;
  }
  for (const [sku, m] of Object.entries(manager)) {
    mgrTotalAvg += m.avg;
  }
  
  console.log('Cin7 total avg mensal (Sales Only): ' + Math.round(cin7TotalSales) + ' (' + cin7ActiveSkus + ' active SKUs)');
  console.log('Manager total avg mensal: ' + Math.round(mgrTotalAvg) + ' (' + [...mgrSkus].filter(s => manager[s].avg > 0).length + ' active SKUs)');
  console.log('Ratio Cin7/Manager: ' + (cin7TotalSales / mgrTotalAvg).toFixed(2) + 'x');
  
  // ============================================================
  // ANALYSIS 8: What does manager really include?
  // ============================================================
  console.log('\n=== ANALISE 8: O QUE O MANAGER REALMENTE INCLUI? ===');
  
  // For products with high transfer activity, compare
  const transferProducts = Object.entries(cin7)
    .filter(([, c]) => c.hasTransfer && c.transferOut > 50)
    .sort((a, b) => b[1].transferOut - a[1].transferOut)
    .slice(0, 30);
  
  console.log('SKU'.padEnd(25) + 'Cin7Sale  Cin7Xfr  Cin7TotO  Mgr/M   Sale=Mgr?  TotO=Mgr?');
  console.log('-'.repeat(100));
  
  let mgrMatchesSale = 0, mgrMatchesTotal = 0, mgrMatchesNeither = 0;
  for (const [sku, c] of transferProducts) {
    const m = manager[sku];
    if (!m) continue;
    
    const diffSale = Math.abs(c.avgMthSalesOnly - m.avg);
    const diffTotal = Math.abs(c.avgMthTotalOut - m.avg);
    
    let match = '';
    if (diffSale < diffTotal && diffSale < m.avg * 0.5) { match = 'SALE'; mgrMatchesSale++; }
    else if (diffTotal < diffSale && diffTotal < m.avg * 0.5) { match = 'TOTAL'; mgrMatchesTotal++; }
    else { match = '???'; mgrMatchesNeither++; }
    
    console.log(
      sku.padEnd(25) + 
      String(c.avgMthSalesOnly).padStart(8) + '  ' +
      String(Math.round(c.transferOut / 6.53)).padStart(7) + '  ' +
      String(c.avgMthTotalOut).padStart(8) + '  ' +
      String(m.avg).padStart(6) + '   ' +
      (diffSale < 20 ? 'YES' : 'NO (' + Math.round(diffSale) + ')').padStart(10) + '  ' +
      (diffTotal < 20 ? 'YES' : 'NO (' + Math.round(diffTotal) + ')').padStart(10) + '  ' +
      match
    );
  }
  
  console.log('\nProdutos com transfer alto: Sale closer=' + mgrMatchesSale + ', Total closer=' + mgrMatchesTotal + ', Neither=' + mgrMatchesNeither);
  
  // ============================================================
  // FINAL RECOMMENDATION
  // ============================================================
  console.log('\n' + '='.repeat(80));
  console.log('=== RESUMO FINAL ===');
  console.log('='.repeat(80));
  console.log('\n1. FONTE CHAT (Wk/Avg): Targets de restock manuais, ~2.24x DB');
  console.log('   - Valores "redondos", nao baseados em dados puros');
  console.log('   - Inclui margem de seguranca/buffer do gerente');
  console.log('   - 1,859 SKUs');
  console.log('\n2. FONTE MANAGER (Jul-Dec 2025): Dados mensais por produto');
  console.log('   - ' + Object.keys(manager).length + ' SKUs');
  console.log('   - Periodo: 6 meses completos');
  console.log('   - Total mensal: ~' + Math.round(mgrTotalAvg));
  console.log('\n3. FONTE CIN7 (10-Aug-25 to 25-Feb-26): Stock movements export');
  console.log('   - ' + Object.keys(cin7).length + ' SKUs (Sale+SaleMultiple only)');
  console.log('   - Periodo: 6.53 meses');
  console.log('   - JA IMPORTADO para o DB');
  console.log('   - Total mensal: ~' + Math.round(cin7TotalSales));
  console.log('\n4. DB ATUAL: ' + dbAll.length + ' SKUs, avg_mth_main baseado no Cin7 export');
  
})();
