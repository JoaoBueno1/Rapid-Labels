#!/usr/bin/env node
'use strict';
/**
 * core/cin7/import-sale-order-details.js
 *
 * Importa o report "Sale Order Details" do Cin7 (layout por pedido) para
 * cin7_mirror.sales_history_line.
 *
 * POR QUE ISTO EXISTE: o backfill equivalente por API custa 62.432 chamadas
 * `sale?ID=` e ~43 h de dreno. Este caminho custa um download por período.
 * Medido e reconciliado contra o mirror em 2026-08-27 (agosto/2026):
 * 13.020 linhas no CSV contra 13.032 no mirror descontando os status que o
 * report não traz — 0,09% de diferença.
 *
 * O LAYOUT NO CIN7 (Reports → Sale Order Details → Configure Layout):
 *   Order # · Order date · Customer · Product additional attribute 1 · SKU ·
 *   Product · Unit · Invoice # · Invoice date · Invoice status ·
 *   Sales representative · Status · Location · Total · Quantity
 *
 * Uso:
 *   node core/cin7/import-sale-order-details.js <arquivo.xlsx> [--dry-run]
 *   node core/cin7/import-sale-order-details.js ~/Downloads --all [--dry-run]
 *
 * --dry-run  lê, valida e reporta. Não escreve nada.
 * --all      processa todo "Sale Order Details*.xlsx" do diretório.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => +v);
types.setTypeParser(1700, (v) => +v);

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const ALL = ARGS.includes('--all');
const TARGET = ARGS.find((a) => !a.startsWith('--'));

if (!TARGET) {
  console.error('uso: import-sale-order-details.js <arquivo.xlsx|dir --all> [--dry-run]');
  process.exit(2);
}

// ── Leitura do arquivo ──────────────────────────────────────────────────────

// dd-Mon-yyyy → Date. O report mistura formatos NO MESMO ARQUIVO: `Order date`
// vem como texto ("14-Aug-2026") e `Invoice date` como serial do Excel (46248).
// Tratar só um dos dois envenena um mês inteiro em silêncio.
const MON = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    // serial do Excel: dias desde 1899-12-30, em UTC para não escorregar de fuso
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return isNaN(d) ? null : d;
  }
  const s = String(v).trim();
  let m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

function num(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const n = +String(v).replace(/[$,\s]/g, '');
  return Number.isFinite(n) ? n : 0;
}
const txt = (v) => (v == null || v === '' ? null : String(v).trim());

/**
 * Encontra o header pelo NOME, nunca por índice fixo. O Cin7 já mudou a
 * posição: com `Quantity` adicionada, uma linha "Grand Total" apareceu e o
 * header desceu da linha 4 para a 5. Um parser por índice teria lido a linha
 * errada e importado lixo sem reclamar.
 */
function parseWorkbook(file) {
  const wb = XLSX.readFile(file, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  const hi = rows.findIndex((r) => Array.isArray(r) && r.some((c) => txt(c) === 'Order #'));
  if (hi < 0) throw new Error('header não encontrado: nenhuma linha tem a coluna "Order #"');

  const H = rows[hi];
  const col = {};
  H.forEach((h, i) => { const k = txt(h); if (k) col[k] = i; });

  const REQ = ['Order #', 'SKU', 'Quantity', 'Total', 'Order date', 'Location', 'Status'];
  const falta = REQ.filter((k) => col[k] === undefined);
  if (falta.length) {
    throw new Error(
      `colunas ausentes: ${falta.join(', ')}\n` +
      `   presentes: ${Object.keys(col).join(' | ')}\n` +
      `   → Cin7 → Reports → Sale Order Details → Configure Layout, e adicione as que faltam.`);
  }

  // Período: vem do metadado "From:"/"To:" do próprio arquivo — nunca do nome
  // do arquivo nem da data de hoje. É o lineage do que foi importado.
  const meta = rows.slice(0, hi).map((r) => txt(r && r[0]) || '').join('\n');
  const mf = /From:\s*(.+)/i.exec(meta);
  const mt = /To:\s*(.+)/i.exec(meta);
  const period_start = toDate(mf && mf[1]);
  const period_end = toDate(mt && mt[1]);
  if (!period_start || !period_end) {
    throw new Error('não achei "From:"/"To:" no cabeçalho do arquivo — exporte pelo Cin7, sem editar');
  }

  const seqPorPedido = new Map();
  const out = [];
  for (const r of rows.slice(hi + 1)) {
    if (!Array.isArray(r)) continue;
    const order_number = txt(r[col['Order #']]);
    const sku = txt(r[col['SKU']]);
    if (!order_number || !sku) continue;              // linha de total/rodapé

    const seq = (seqPorPedido.get(order_number) || 0);
    seqPorPedido.set(order_number, seq + 1);

    out.push({
      period_start: iso(period_start),
      period_end: iso(period_end),
      order_number,
      row_seq: seq,
      order_date: iso(toDate(r[col['Order date']])),
      customer: txt(r[col['Customer']]),
      rapid_code: txt(r[col['Product additional attribute 1']]),
      sku,
      sku_key: sku.trim().toUpperCase(),
      product_name: txt(r[col['Product']]),
      uom: txt(r[col['Unit']]),
      invoice_number: txt(r[col['Invoice #']]),
      invoice_date: iso(toDate(r[col['Invoice date']])),
      invoice_status: txt(r[col['Invoice status']]),
      sales_rep: txt(r[col['Sales representative']]),
      status: txt(r[col['Status']]),
      location_name: txt(r[col['Location']]),
      quantity: num(r[col['Quantity']]),
      total_gross: num(r[col['Total']]),
      source_file: path.basename(file),
    });
  }
  return { rows: out, period_start: iso(period_start), period_end: iso(period_end), headerRow: hi };
}

// ── Escrita ─────────────────────────────────────────────────────────────────

const COLS = ['period_start','period_end','order_number','row_seq','order_date','customer',
  'rapid_code','sku','sku_key','product_name','uom','invoice_number','invoice_date',
  'invoice_status','sales_rep','status','location_name','quantity','total_gross','source_file'];

/**
 * Idempotente por PERÍODO: apaga o que já existe daquele período e reinsere.
 * Reimportar o mesmo mês (ou um re-export com linhas em ordem diferente) dá o
 * mesmo resultado, sem duplicar. É por isso que row_seq não precisa ser estável
 * entre exports — só dentro de um.
 */
async function write(pool, parsed) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const del = await c.query(
      'DELETE FROM cin7_mirror.sales_history_line WHERE period_start=$1 AND period_end=$2',
      [parsed.period_start, parsed.period_end]);

    let ins = 0;
    const CHUNK = 500;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const batch = parsed.rows.slice(i, i + CHUNK);
      const ph = [], vals = [];
      batch.forEach((r, j) => {
        ph.push(`(${COLS.map((_, k) => `$${j * COLS.length + k + 1}`).join(',')})`);
        COLS.forEach((k) => vals.push(r[k]));
      });
      await c.query(
        `INSERT INTO cin7_mirror.sales_history_line (${COLS.join(',')}) VALUES ${ph.join(',')}`, vals);
      ins += batch.length;
      process.stdout.write(`\r   gravando… ${ins}/${parsed.rows.length}`);
    }
    await c.query('COMMIT');
    process.stdout.write('\r');
    return { deleted: del.rowCount, inserted: ins };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

function resumo(p) {
  const r = p.rows;
  const n = (x) => x.toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const byStatus = {};
  r.forEach((x) => { const s = x.status || '(vazio)'; byStatus[s] = (byStatus[s] || 0) + 1; });
  const reps = new Set(r.map((x) => x.sales_rep).filter(Boolean));
  const locs = new Set(r.map((x) => x.location_name).filter(Boolean));
  const semData = r.filter((x) => !x.order_date).length;
  const semRep = r.filter((x) => !x.sales_rep).length;

  console.log(`   período      ${p.period_start} → ${p.period_end}   (header na linha ${p.headerRow})`);
  console.log(`   linhas       ${n(r.length)}   pedidos ${n(new Set(r.map((x) => x.order_number)).size)}   SKUs ${n(new Set(r.map((x) => x.sku_key)).size)}`);
  console.log(`   quantidade   ${n(r.reduce((a, x) => a + x.quantity, 0))}`);
  console.log(`   valor bruto  AUD ${n(r.reduce((a, x) => a + x.total_gross, 0))}   (com GST)`);
  console.log(`   vendedores   ${reps.size}   locais ${locs.size}`);
  console.log(`   status       ${Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (semData) console.log(`   ⚠️  ${semData} linha(s) sem Order date`);
  if (semRep) console.log(`   ⚠️  ${semRep} linha(s) sem Sales representative`);
}

(async () => {
  let files;
  if (ALL) {
    const dir = TARGET.replace(/^~/, process.env.HOME);
    files = fs.readdirSync(dir).filter((f) => /^Sale Order Details.*\.xlsx$/i.test(f))
      .map((f) => path.join(dir, f)).sort();
    if (!files.length) throw new Error(`nenhum "Sale Order Details*.xlsx" em ${dir}`);
  } else {
    files = [TARGET.replace(/^~/, process.env.HOME)];
  }

  let pool = null;
  if (!DRY) {
    const m = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase/i);
    if (!m || !process.env.SUPABASE_DB_PASSWORD) {
      throw new Error('faltam SUPABASE_URL / SUPABASE_DB_PASSWORD no .env');
    }
    pool = new Pool({
      host: process.env.SUPABASE_DB_HOST,
      port: +(process.env.SUPABASE_DB_PORT || 5432),
      database: 'postgres',
      user: 'postgres.' + m[1],
      password: process.env.SUPABASE_DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
    });
  }

  let totLinhas = 0, falhas = 0;
  for (const f of files) {
    console.log(`\n▸ ${path.basename(f)}`);
    try {
      const parsed = parseWorkbook(f);
      resumo(parsed);
      if (DRY) { console.log('   (dry-run — nada gravado)'); }
      else {
        const { deleted, inserted } = await write(pool, parsed);
        console.log(`   ✓ ${inserted} gravadas${deleted ? ` (${deleted} do mesmo período substituídas)` : ''}`);
      }
      totLinhas += parsed.rows.length;
    } catch (e) {
      falhas++;
      console.error(`   ✗ ${e.message}`);
    }
  }

  console.log(`\n${files.length} arquivo(s), ${totLinhas.toLocaleString('en-AU')} linha(s)${falhas ? `, ${falhas} com erro` : ''}.`);
  if (pool) await pool.end();
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
