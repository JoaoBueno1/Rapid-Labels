#!/usr/bin/env node
/**
 * Importa o "Product Stock File" para rapid_inv.product_file.
 *
 *   node features/stock-planning/scripts/import-product-file.js            (dry-run)
 *   node features/stock-planning/scripts/import-product-file.js --write
 *   node ... --file="/caminho/outro.xlsx"
 *
 * TRÊS ABAS, TRÊS CHAVES — medido, e errar aqui dá zero silencioso:
 *   Product Summary   RAPID CODE → sku      1.998 de 2.032 casam
 *   Stock Volume      Item No.   → 5DC      3.710 de 3.928 casam
 *   Pickaybay space   SKU        → sku      1.324 de 1.340 casam
 *
 * Na primeira tentativa juntei Stock Volume por SKU e casou UMA linha em 3.928,
 * sem erro nenhum — só um campo que ficava vazio para sempre.
 *
 * O arquivo é STAGING: entra como está. Nenhuma decisão de qual fonte vale é
 * tomada aqui; isso é da view de reconciliação, que mostra as duas quando
 * discordam para o usuário corrigir a origem.
 */
'use strict';

require('dotenv').config();   // como os outros scripts do módulo
const path = require('path');
const XLSX = require('xlsx');
const db = require('../lib/sp-db');

const WRITE = process.argv.includes('--write');
const FILE = (process.argv.find((a) => a.startsWith('--file=')) || '').slice(7)
  || path.join(process.env.HOME || '', 'Downloads', 'Product Stock File - 2024.xlsx');

const K = (s) => String(s == null ? '' : s).trim().toUpperCase();
// Zero e vazio são a mesma coisa aqui: o arquivo usa 0 como "não preenchido"
// em dimensão e custo, e importar 0 como medida faria o packer acreditar nela.
const num = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) && n !== 0 ? n : null;
};

async function main() {
  console.log(`\n  arquivo: ${FILE}`);
  const wb = XLSX.readFile(FILE);
  const has = (n) => wb.SheetNames.includes(n);
  const rows = {};
  const touch = (k, sheet) => {
    if (!rows[k]) rows[k] = { sku_key: k, source_sheets: [] };
    if (!rows[k].source_sheets.includes(sheet)) rows[k].source_sheets.push(sheet);
    return rows[k];
  };

  // ── Product Summary: dimensões, CBM, custo, fornecedor ──
  let ps = [];
  if (has('Product Summary')) {
    // range:1 porque a linha 1 do arquivo carrega o cabeçalho de câmbio
    // ("USD rate", "0.65") e os títulos reais estão na linha 2.
    ps = XLSX.utils.sheet_to_json(wb.Sheets['Product Summary'], { defval: null, range: 1 });
    for (const r of ps) {
      const k = K(r['RAPID CODE']); if (!k) continue;
      const o = touch(k, 'Product Summary');
      o.sku = String(r['RAPID CODE']).trim();
      o.description = r['Description'] || null;
      o.supplier = r['Supplier'] || null;
      o.length_mm = num(r['LENGTH']); o.width_mm = num(r['WIDTH']); o.height_mm = num(r['HEIGHT']);
      o.cbm = num(r['CBM']);
      o.cost_usd = num(r['Cost USD']); o.cost_aud = num(r['Cost AUD']);
      o.avg_cost = num(r['Current Avg Cost']); o.freight_each = num(r['Freight Cost each']);
      o.unit_price = num(r['Unit Price']); o.sell_price = num(r['Unit Sell Price']);
    }
  }

  // ── Pickaybay space: o espaço de separação, por SKU ──
  let pb = [];
  if (has('Pickaybay space (Container ch)')) {
    pb = XLSX.utils.sheet_to_json(wb.Sheets['Pickaybay space (Container ch)'], { defval: null });
    for (const r of pb) {
      const k = K(r['SKU']); if (!k) continue;
      const o = touch(k, 'Pickaybay space');
      o.pickbay = r['Pickbay'] == null ? null : String(r['Pickbay']).trim();
      if (r['5DC'] != null) o.dc = K(r['5DC']);
    }
  }

  // ── Stock Volume: casa pelo 5DC, e o 5DC vem do espelho do Cin7 ──
  let sv = [], viaDc = 0;
  if (has('Stock Volume')) {
    sv = XLSX.utils.sheet_to_json(wb.Sheets['Stock Volume'], { defval: null });
    const map = await db.query(
      `SELECT upper(btrim(attribute1)) AS dc, upper(btrim(sku)) AS sku
         FROM cin7_mirror.products WHERE attribute1 IS NOT NULL AND btrim(attribute1) <> ''`);
    const byDc = map.reduce((m, r) => ((m[r.dc] = m[r.dc] || []).push(r.sku), m), {});
    for (const r of sv) {
      const dc = K(r['Item No.']); if (!dc) continue;
      for (const sku of (byDc[dc] || [])) {
        const o = touch(sku, 'Stock Volume');
        o.dc = o.dc || dc;
        o.carton_qty = num(r['CTN QTY']);
        o.each_volume = num(r['EACH VOLUME']); o.ctn_volume = num(r['CTN VOLUME']);
        viaDc++;
      }
    }
  }

  const list = Object.values(rows);
  console.log(`\n  Product Summary  ${ps.length} linhas do arquivo`);
  console.log(`  Pickaybay space  ${pb.length}`);
  console.log(`  Stock Volume     ${sv.length} → ${viaDc} ligações por 5DC`);
  console.log(`\n  SKUs montados    ${list.length}`);
  for (const f of ['length_mm', 'width_mm', 'height_mm', 'cbm', 'carton_qty', 'each_volume', 'pickbay', 'avg_cost', 'supplier']) {
    console.log(`    ${f.padEnd(14)} ${list.filter((r) => r[f] != null && r[f] !== '').length}`);
  }

  if (!WRITE) { console.log('\n  (dry-run — rode com --write para gravar)\n'); await db.close(); return; }

  await db.tx(async (c) => {
    // Substituição inteira: o arquivo é a verdade dele mesmo, e um merge
    // deixaria linha velha de uma importação anterior fingindo estar atual.
    await c.query('TRUNCATE rapid_inv.product_file');
    const cols = ['sku_key', 'sku', 'dc', 'description', 'supplier', 'length_mm', 'width_mm', 'height_mm',
      'cbm', 'each_volume', 'ctn_volume', 'carton_qty', 'cost_usd', 'cost_aud', 'avg_cost',
      'freight_each', 'unit_price', 'sell_price', 'pickbay', 'source_sheets', 'source_file'];
    for (let i = 0; i < list.length; i += 400) {
      const chunk = list.slice(i, i + 400);
      const vals = [], ph = [];
      chunk.forEach((r, n) => {
        ph.push('(' + cols.map((_, j) => `$${n * cols.length + j + 1}`).join(',') + ')');
        cols.forEach((cn) => vals.push(cn === 'source_file' ? path.basename(FILE) : (r[cn] === undefined ? null : r[cn])));
      });
      await c.query(`INSERT INTO rapid_inv.product_file (${cols.join(',')}) VALUES ${ph.join(',')}`, vals);
    }
  }, 'import-product-file');

  const [{ n }] = await db.query('SELECT count(*)::int n FROM rapid_inv.product_file');
  console.log(`\n  ✓ gravados ${n} SKUs\n`);
  await db.close();
}

main().catch((e) => { console.error('  ERRO:', e.message); process.exit(1); });
