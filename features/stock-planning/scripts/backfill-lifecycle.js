#!/usr/bin/env node
'use strict';
/**
 * Marca o ciclo de vida dos SKUs a partir dos sinais que a EMPRESA já deu —
 * não dos que o Cin7 dá.
 *
 *   node features/stock-planning/scripts/backfill-lifecycle.js            # dry-run
 *   node features/stock-planning/scripts/backfill-lifecycle.js --write
 *
 * Quatro fontes, em ordem de confiança. A última a escrever ganha, e por isso
 * a ordem importa: a lista curada de descontinuados vale mais que uma regra
 * de sufixo.
 *
 *   1. -V1 cuja base sem sufixo TAMBÉM está no planejamento  → RUN_OUT
 *      Este é o caso caro: 132 SKUs onde a mesma demanda é contada duas vezes
 *      na mesma família (R-SLGPO2-WH-V1 com Wk/Avg 40 ao lado de
 *      R-SLGPO2-WH com 560).
 *   2. version_code do mapa Sheet1 que está no planejamento → RUN_OUT
 *   3. Notas "Moving to X" das abas de fornecedor            → RUN_OUT
 *   4. Lista curada Discontinued Items.xlsx                  → DISCONTINUED
 *
 * Nunca sobrescreve decisão humana (lifecycle_source='MANUAL').
 */
require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');
const db = require('../lib/sp-db');

const WRITE = process.argv.includes('--write');
const HOME = require('os').homedir();
const DISC_FILE = path.join(HOME, 'Downloads', 'Discontinued Items.xlsx');
const RAPID_FILE = path.join(HOME, 'Downloads', 'Rapid-Inventory SKU 2026.xlsx');
const ACTOR = 'lifecycle-backfill';

const K = (v) => String(v || '').trim().toUpperCase();
const log = (...a) => console.log(...a);

/** A lista curada: a aba Combined tem todos os SKUs que a empresa parou de vender. */
function readDiscontinued() {
  const wb = XLSX.readFile(DISC_FILE, { cellFormula: false });
  const out = new Set();
  const byTab = {};
  for (const name of wb.SheetNames) {
    if (/^(Totals|Combined|SOH |Sheet)/i.test(name) && name !== 'Combined') continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    let n = 0;
    for (const r of rows) {
      // O código do produto fica em A ou B dependendo da aba (Mixed usa layout próprio).
      for (const cell of [r[0], r[1]]) {
        const s = String(cell || '').trim();
        if (!s || /^\d+$/.test(s) || /grand total|^sku$|^product$/i.test(s)) continue;
        if (!/^[A-Za-z0-9][A-Za-z0-9\-_. ]{2,}$/.test(s)) continue;
        out.add(K(s)); n++; break;
      }
    }
    byTab[name] = n;
  }
  return { skus: out, byTab };
}

/**
 * As notas do planejador vivem na coluna B do bloco de cada SKU nas abas de
 * fornecedor. É onde ele escreve "Discontinued" e "Moving to R1155".
 */
const SUPPLIER_SHEETS = ['Aeon','AGC','AOK','CGD','CNEPSO','Cowin','Dolight','E-Lite','ePower',
  'Foshan','General','Huibo','Kinglumi','Mixed','Ottima','LEDLUZ','Relight','Sealite',
  'Senselite','Starlux','Upshine','Xtrack'];

function readSupplierNotes() {
  const wb = XLSX.readFile(RAPID_FILE, { cellFormula: false });
  const disc = new Map(), moving = new Map();
  for (const sheet of SUPPLIER_SHEETS) {
    const ws = wb.Sheets[sheet]; if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = 0; r <= range.e.r; r++) {
      const a = ws['A' + (r + 1)];
      if (!a || String(a.v).trim() !== 'Product SKU') continue;
      const skuCell = ws['B' + (r + 1)];
      const sku = skuCell && skuCell.v != null ? K(skuCell.v) : null;
      if (!sku) continue;
      // Varre as 6 linhas do bloco procurando texto na coluna B ou C.
      for (let d = 1; d <= 6; d++) {
        for (const col of ['B', 'C']) {
          const c = ws[col + (r + 1 + d)];
          const t = c && typeof c.v === 'string' ? c.v.trim() : '';
          if (!t || t.length < 4) continue;
          if (/^input opening/i.test(t)) continue;
          const mv = t.match(/mov(?:e|ing)?\s+(?:to|over to)\s+([A-Za-z0-9][A-Za-z0-9\-_.]*)/i)
                  || t.match(/replaced\s+by\s+([A-Za-z0-9][A-Za-z0-9\-_.]*)/i)
                  || t.match(/superseded\s+by\s+([A-Za-z0-9][A-Za-z0-9\-_.]*)/i);
          if (mv) {
            // "Move to CW?" é pergunta, e CW não é SKU. Marca o fim de vida,
            // mas não inventa um sucessor que ninguém vai conseguir clicar.
            const target = mv[1];
            const plausible = target.length >= 4 && /\d/.test(target) && !/^\d+$/.test(target);
            moving.set(sku, { note: t.slice(0, 200), target: plausible ? target : null });
            continue;
          }
          // "Will move to 52/wk" é ajuste de Wk/Avg, não fim de vida.
          if (/^will move to\s+\d/i.test(t)) continue;
          if (/discontinu/i.test(t)) disc.set(sku, t.slice(0, 200));
        }
      }
    }
  }
  return { disc, moving };
}

(async () => {
  log(`\n${WRITE ? '✍️  Gravando' : '🔍 DRY-RUN —  nada será gravado'}\n`);

  const planned = await db.query(
    `SELECT sku_key, sku, wk_avg, lifecycle_status, lifecycle_source FROM rapid_inv.sku_settings WHERE is_planned`);
  const plannedSet = new Set(planned.map((r) => r.sku_key));
  const all = await db.query(`SELECT sku_key FROM rapid_inv.sku_settings`);
  const allSet = new Set(all.map((r) => r.sku_key));

  const plan = new Map();   // sku_key → { status, superseded_by, note, source }
  const put = (key, v) => { if (allSet.has(key)) plan.set(key, v); };

  // 1 · -V1 cuja base também é planejada.
  // Só -V1, de propósito: nele a relação é conhecida (o -V1 é o antigo, a base
  // é a que se planeja). Para -V2 e -V3 a direção é ambígua — quem decide é o
  // mapa do Sheet1, no passo 2. Na dúvida, não decide.
  let vCases = 0;
  for (const key of allSet) {
    const m = key.match(/^(.*?)[-_]V(1)$/i);
    if (!m) continue;
    const base = m[1];
    if (!plannedSet.has(base)) continue;
    vCases++;
    put(key, { status: 'RUN_OUT', superseded_by: base, source: 'RULE',
               note: `Version suffix -V${m[2]}; base SKU ${base} is the one that is planned` });
  }

  // 2 · version_code do mapa Sheet1
  const vers = await db.query(
    `SELECT v.version_code, v.current_sku FROM rapid_inv.sku_versions v
      WHERE upper(btrim(v.version_code)) <> upper(btrim(v.current_sku))`);
  let versCases = 0;
  for (const v of vers) {
    const key = K(v.version_code);
    if (!allSet.has(key) || !allSet.has(K(v.current_sku))) continue;
    versCases++;
    put(key, { status: 'RUN_OUT', superseded_by: v.current_sku, source: 'EXCEL_IMPORT',
               note: 'Version map (Sheet1) points to the current code' });
  }

  // 3 · notas das abas de fornecedor
  const notes = readSupplierNotes();
  let movingCases = 0, noteDisc = 0;
  let movingResolved = 0;
  for (const [sku, v] of notes.moving) {
    if (!allSet.has(sku)) continue;
    movingCases++;
    const sup = v.target && allSet.has(K(v.target)) ? v.target : null;
    if (sup) movingResolved++;
    put(sku, { status: 'RUN_OUT', superseded_by: sup, source: 'EXCEL_IMPORT', note: v.note });
  }
  for (const [sku, t] of notes.disc) { if (allSet.has(sku)) { noteDisc++;
    put(sku, { status: 'DISCONTINUED', superseded_by: null, source: 'EXCEL_IMPORT', note: t }); } }

  // 4 · a lista curada (a mais forte, escreve por último)
  const { skus: discSkus, byTab } = readDiscontinued();
  let listCases = 0;
  for (const sku of discSkus) { if (allSet.has(sku)) { listCases++;
    put(sku, { status: 'DISCONTINUED', superseded_by: null, source: 'EXCEL_IMPORT',
               note: 'On the Discontinued Items workbook' }); } }

  const rows = [...plan.entries()].map(([sku_key, v]) => ({ sku_key, ...v }));
  const inPlanning = rows.filter((r) => plannedSet.has(r.sku_key));

  log('─── Sinais encontrados ─────────────────────────────────────');
  log(`  Sufixo -V com base planejada        ${vCases}`);
  log(`  Mapa de versão (Sheet1)             ${versCases}`);
  log(`  Notas "Moving to X"                 ${movingCases}  (${movingResolved} com sucessor que existe)`);
  log(`  Notas "Discontinued"                ${noteDisc}`);
  log(`  Lista Discontinued Items.xlsx       ${listCases} de ${discSkus.size} lidos`);
  log(`    por aba: ${Object.entries(byTab).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  log('');
  log(`  Total de SKUs a marcar              ${rows.length}`);
  log(`    RUN_OUT                           ${rows.filter((r) => r.status === 'RUN_OUT').length}`);
  log(`    DISCONTINUED                      ${rows.filter((r) => r.status === 'DISCONTINUED').length}`);
  log(`  Dentre os 1.951 do planejamento     ${inPlanning.length}`);
  log('');

  const keys = inPlanning.map((r) => r.sku_key);
  if (keys.length) {
    const [impact] = await db.query(`
      SELECT count(*) FILTER (WHERE wk_avg > 0)::int still_forecast,
             round(sum(wk_avg) FILTER (WHERE wk_avg > 0)::numeric, 0) phantom_per_week,
             round(sum(GREATEST(COALESCE(target_qty,0) - soh_available, 0))::numeric, 0) phantom_buy,
             round(sum(stock_value_aud)::numeric, 0) dead_value
        FROM rapid_inv.v_sp_sku_value WHERE sku_key = ANY($1)`, [keys]);
    log('─── O que isso corrige ─────────────────────────────────────');
    log(`  SKUs mortos ainda com Wk/Avg        ${impact.still_forecast}`);
    log(`  Demanda fantasma por semana         ${impact.phantom_per_week} un`);
    log(`  Compra fantasma que a grade pede    ${impact.phantom_buy} un`);
    log(`  Valor parado nesses SKUs            A$${Number(impact.dead_value).toLocaleString('en-AU')}`);
    log('');
  }

  if (!WRITE) { log('Rode com --write para gravar.\n'); await db.close(); return; }

  const n = await db.tx(async (c) => {
    let k = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params = [];
      const tuples = chunk.map((r) => {
        params.push(r.sku_key, r.status, r.superseded_by, r.note, r.source);
        const b = params.length;
        return `($${b - 4},$${b - 3},$${b - 2},$${b - 1},$${b})`;
      });
      const res = await c.query(`
        UPDATE rapid_inv.sku_settings s
           SET lifecycle_status = v.status, superseded_by = v.sup,
               lifecycle_note = v.note, lifecycle_source = v.src,
               lifecycle_set_at = now(), lifecycle_set_by = '${ACTOR}'
          FROM (VALUES ${tuples.join(',')}) AS v(key, status, sup, note, src)
         WHERE s.sku_key = v.key
           AND s.lifecycle_source IS DISTINCT FROM 'MANUAL'`, params);
      k += res.rowCount;
    }
    return k;
  }, ACTOR);

  // Guarda: marcar DISCONTINUED zera a venda na projeção. Se o SKU AINDA vende,
  // isso faria a grade dizer que ele nunca acaba. Quem ainda gira fica RUN_OUT:
  // para de ser comprado, mas continua consumindo o estoque de verdade.
  const guarded = await db.tx(async (c) => (await c.query(`
    UPDATE rapid_inv.sku_settings s
       SET lifecycle_status = 'RUN_OUT',
           lifecycle_note = COALESCE(s.lifecycle_note,'') || ' · kept as run-out because it is still selling',
           lifecycle_set_at = now(), lifecycle_set_by = '${ACTOR}'
      FROM rapid_inv.v_sp_actual_weekly a
     WHERE a.sku_key = s.sku_key AND s.is_planned
       AND s.lifecycle_status = 'DISCONTINUED'
       AND s.lifecycle_source IS DISTINCT FROM 'MANUAL'
       AND a.actual_wk > 0`)).rowCount, ACTOR);

  log(`✓ ${n} SKUs marcados; ${guarded} rebaixados para RUN_OUT por ainda estarem vendendo.\n`);
  const totals = await db.query(`SELECT * FROM rapid_inv.v_sp_dead_stock_totals ORDER BY 1`);
  log('─── Estoque morto agora ────────────────────────────────────');
  for (const t of totals)
    log(`  ${t.lifecycle_status.padEnd(14)} ${String(t.skus).padStart(4)} SKUs · ${String(t.with_stock).padStart(4)} com estoque · ` +
        `${Number(t.units || 0).toLocaleString('en-AU').padStart(9)} un · A$${Number(t.value_aud || 0).toLocaleString('en-AU')}` +
        (t.still_forecast ? ` · ${t.still_forecast} ainda com Wk/Avg` : ''));
  log('');
  await db.close();
})().catch(async (e) => { console.error('❌', e.message, '\n', e.stack.split('\n')[1]); await db.close(); process.exit(1); });
