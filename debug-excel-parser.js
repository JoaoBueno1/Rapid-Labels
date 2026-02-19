/**
 * Debug script to analyze Excel structure
 * Upload a file to see how it's being parsed
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

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

// Get file path from command line
const filePath = process.argv[2];

if (!filePath) {
  console.log('Usage: node debug-excel-parser.js <path-to-excel-file>');
  console.log('Example: node debug-excel-parser.js ~/Downloads/stock-report.xlsx');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error('File not found:', filePath);
  process.exit(1);
}

console.log('=== DEBUG EXCEL PARSER ===\n');
console.log('File:', filePath);

// Read the Excel file
const workbook = XLSX.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

console.log('Sheet:', sheetName);
console.log('Total rows:', rows.length);
console.log('Total columns:', rows[0]?.length || 0);

// Show first 5 rows
console.log('\n=== FIRST 5 ROWS ===');
for (let i = 0; i < Math.min(5, rows.length); i++) {
  const row = rows[i];
  console.log(`\nRow ${i}:`);
  for (let j = 0; j < Math.min(30, row.length); j++) {
    const val = String(row[j] || '').trim();
    if (val) {
      console.log(`  [${j}] "${val}"`);
    }
  }
}

// Find header row
let headerRowIdx = -1;
let warehouseRowIdx = -1;

for (let i = 0; i < Math.min(5, rows.length); i++) {
  const row = rows[i].map(c => String(c || '').toLowerCase().trim());
  if (row.includes('sku') || row.includes('product')) {
    headerRowIdx = i;
    warehouseRowIdx = i > 0 ? i - 1 : i;
    break;
  }
}

console.log('\n=== DETECTED STRUCTURE ===');
console.log('Header row index:', headerRowIdx);
console.log('Warehouse row index:', warehouseRowIdx);

if (headerRowIdx === -1) {
  console.error('ERROR: Could not find header row with SKU or Product column!');
  process.exit(1);
}

const headerRow = rows[headerRowIdx].map(c => String(c || '').toLowerCase().trim());
const warehouseRow = rows[warehouseRowIdx].map(c => String(c || '').toLowerCase().trim());

console.log('\n=== WAREHOUSE ROW (row', warehouseRowIdx, ') ===');
const foundWarehouses = [];
for (let i = 0; i < warehouseRow.length; i++) {
  const val = warehouseRow[i];
  if (val) {
    const code = WAREHOUSE_MAP[val];
    console.log(`  [${i}] "${val}" => ${code || '(not mapped)'}`);
    if (code) foundWarehouses.push({ col: i, name: val, code });
  }
}

console.log('\n=== HEADER ROW (row', headerRowIdx, ') ===');
for (let i = 0; i < headerRow.length; i++) {
  const val = headerRow[i];
  if (val) {
    console.log(`  [${i}] "${val}"`);
  }
}

// Simulate the parsing logic
console.log('\n=== PARSING SIMULATION ===');
const warehouseColumns = {};
let currentWarehouse = null;

for (let i = 0; i < headerRow.length; i++) {
  const warehouseName = warehouseRow[i];
  const colName = headerRow[i];
  
  const warehouseCode = WAREHOUSE_MAP[warehouseName];
  if (warehouseCode) {
    currentWarehouse = warehouseCode;
    console.log(`Col ${i}: Found warehouse "${warehouseName}" => ${warehouseCode}`);
  }
  
  if (currentWarehouse && colName === 'available') {
    console.log(`Col ${i}: Found "available" for ${currentWarehouse}`);
    warehouseColumns[currentWarehouse] = { available: i };
  }
}

console.log('\n=== MAPPED WAREHOUSES ===');
console.log('Warehouses found:', Object.keys(warehouseColumns));

if (Object.keys(warehouseColumns).length === 0) {
  console.error('\nERROR: No warehouses mapped!');
  console.log('\nPossible issues:');
  console.log('1. Warehouse names in the Excel dont match WAREHOUSE_MAP');
  console.log('2. "Available" column is not exactly named "available"');
  console.log('3. Warehouse row is not directly above header row');
} else {
  // Check a sample product
  console.log('\n=== SAMPLE PRODUCT DATA ===');
  const productColIdx = headerRow.indexOf('product') !== -1 ? headerRow.indexOf('product') : headerRow.indexOf('sku');
  console.log('Product column index:', productColIdx);
  
  // Find RQC
  for (let i = headerRowIdx + 1; i < Math.min(headerRowIdx + 100, rows.length); i++) {
    const row = rows[i];
    const product = String(row[productColIdx] || '').trim();
    if (product === 'RQC') {
      console.log('\nFound RQC at row', i);
      for (const [code, cols] of Object.entries(warehouseColumns)) {
        const available = row[cols.available];
        console.log(`  ${code}: available = ${available}`);
      }
      break;
    }
  }
}
