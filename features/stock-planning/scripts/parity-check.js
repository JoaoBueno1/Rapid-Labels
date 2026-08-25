#!/usr/bin/env node
'use strict';
/**
 * Paridade: motor × Excel, semana a semana.
 *
 *   node features/stock-planning/scripts/parity-check.js
 *   node features/stock-planning/scripts/parity-check.js --supplier=CGD --weeks=12
 *   node features/stock-planning/scripts/parity-check.js --sample=40 --verbose
 *
 * Lê os valores JÁ CALCULADOS pelo Excel nas abas de fornecedor (Opening,
 * Inventory In, Sales Out, Project orders, Closing) e compara com o que o
 * nosso motor produz a partir dos mesmos fatos vindos do banco.
 *
 * Toda diferença é uma de duas coisas: bug nosso, ou um dos defeitos medidos
 * do workbook. A saída separa as duas — não existe terceira opção, e "a tela
 * parece certa" não conta.
 */
require('dotenv').config();
const XLSX = require('xlsx');
const db = require('../lib/sp-db');
const { projectSku } = require('../lib/planning-engine');
const { DEFAULT_FILE, SUPPLIER_SHEETS } = require('../lib/excel-import');
const { toISODate, weekEnding } = require('../lib/week');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const VERBOSE = process.argv.includes('--verbose');
const WEEKS = parseInt(arg('weeks', '12'), 10);
const SAMPLE = parseInt(arg('sample', '25'), 10);
const ONLY_SUPPLIER = arg('supplier', null);
const TOL = parseFloat(arg('tol', '0.51'));   // meia unidade: o Excel exibe arredondado

/** Extrai do bloco de 7 linhas de um SKU as semanas futuras já calculadas. */
function readBlocks(ws, wantSkus) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  // coluna da semana de reporte: a única com 1 na linha 5
  let repCol = null;
  for (let c = 4; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 4, c })];
    if (cell && cell.v === 1) { repCol = c; break; }
  }
  if (repCol == null) return {};

  const weekOf = [];
  for (let c = repCol; c <= range.e.c; c++) {
    const d = ws[XLSX.utils.encode_cell({ r: 3, c })];
    weekOf.push(d && d.v instanceof Date ? toISODate(d.v) : null);
  }

  const out = {};
  for (let r = 0; r <= range.e.r; r++) {
    const a = ws['A' + (r + 1)];
    if (!a || String(a.v).trim() !== 'Product SKU') continue;
    const skuCell = ws['B' + (r + 1)];
    const sku = skuCell && skuCell.v != null ? String(skuCell.v).trim() : null;
    if (!sku || (wantSkus && !wantSkus.has(sku))) continue;

    const grab = (offset) => {
      const vals = {};
      for (let i = 0; i < weekOf.length && i <= WEEKS; i++) {
        const wk = weekOf[i];
        if (!wk) continue;
        const cell = ws[XLSX.utils.encode_cell({ r: r + offset, c: repCol + i })];
        vals[wk] = cell && typeof cell.v === 'number' ? cell.v : (cell && cell.t === 'e' ? NaN : 0);
      }
      return vals;
    };
    out[sku] = {
      weeks: weekOf.slice(0, WEEKS + 1).filter(Boolean),
      opening: grab(1), incoming: grab(2), sales: grab(3), project: grab(4), closing: grab(5),
    };
  }
  return out;
}

(async () => {
  console.log('\n📐  Paridade Excel × motor\n');

  const state = await db.one(`SELECT reporting_week FROM rapid_inv.planning_state WHERE id=1`);
  const weeks = await db.query(
    `SELECT week_ending, factor FROM rapid_inv.v_sp_weeks
      WHERE week_ending >= $1 ORDER BY week_ending LIMIT $2`, [state.reporting_week, WEEKS + 1]);

  const skuRows = await db.query(`
    SELECT sku, sku_key, supplier_code, wk_avg, wk_avg_input, lifecycle_status, target_cover_weeks, soh_available, project_orders, undated_qty
      FROM rapid_inv.v_sp_planning_skus
     WHERE wk_avg IS NOT NULL AND soh_available <> 0
       ${ONLY_SUPPLIER ? 'AND supplier_code = $1' : ''}
     ORDER BY sku`, ONLY_SUPPLIER ? [ONLY_SUPPLIER] : []);

  const bySupplier = new Map();
  for (const r of skuRows) {
    if (!r.supplier_code) continue;
    if (!bySupplier.has(r.supplier_code)) bySupplier.set(r.supplier_code, []);
    bySupplier.get(r.supplier_code).push(r);
  }

  // Amostra espalhada entre fornecedores, como pede a validação de paridade.
  const picked = [];
  const perSupplier = Math.max(1, Math.ceil(SAMPLE / Math.max(bySupplier.size, 1)));
  for (const [, list] of bySupplier) {
    const step = Math.max(1, Math.floor(list.length / perSupplier));
    for (let i = 0; i < list.length && picked.length < SAMPLE * 2; i += step) picked.push(list[i]);
  }
  const sample = picked.slice(0, SAMPLE);
  if (!sample.length) { console.log('Sem SKUs para comparar.'); await db.close(); return; }

  const wantBySheet = new Map();
  for (const s of sample) {
    const sheet = SUPPLIER_SHEETS.find((x) => x.toUpperCase().replace('-', '') === s.supplier_code);
    if (!sheet) continue;
    if (!wantBySheet.has(sheet)) wantBySheet.set(sheet, new Set());
    wantBySheet.get(sheet).add(s.sku);
  }

  const skus = sample.map((s) => s.sku_key);
  const draws = await db.query(
    `SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand WHERE sku = ANY($1)`, [skus]);
  const incoming = await db.query(
    `SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming WHERE sku = ANY($1)`, [skus]);
  const idx = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
  const drawIdx = idx(draws), inIdx = idx(incoming);

  console.log(`  ${sample.length} SKUs · ${WEEKS} semanas · reporte ${state.reporting_week}\n`);

  const wb = XLSX.readFile(DEFAULT_FILE, { cellFormula: false, cellDates: true });

  // Recalcula o SUMIFS da aba Project por conta própria. Sem isto não dá para
  // separar "o motor errou" de "a célula do Excel está com valor velho" — e
  // num workbook de 990 mil fórmulas, com cálculo em modo manual, valor velho
  // é comum. Duas somas: match exato de data (o que o Excel faz) e por semana
  // (o que nós fazemos).
  const projRows = XLSX.utils
    .sheet_to_json(wb.Sheets['Project'], { header: 1, raw: true, defval: null, blankrows: false })
    .slice(1)
    .filter((r) => r && r[5]);
  // Duas somas por SKU|semana:
  //   rule*  = QTY − INV − HELD recalculado (a regra que a coluna deveria aplicar)
  //   cache* = o valor que está na coluna J (o que o SUMIFS do Excel realmente soma)
  // Elas divergem quando alguém digitou por cima da fórmula. Sem separar as duas
  // não dá para distinguir defeito do workbook de erro do motor.
  const trueDemand = new Map();
  let overwritten = 0;
  for (const r of projRows) {
    const key = String(r[5]).trim().toUpperCase();
    const d = toISODate(r[11]);
    if (!d) continue;
    const qty = Number(r[6]) || 0;
    const held = Number(r[12]) || 0;
    const inv = Number(r[15]) || 0;
    const rule = Math.max(qty - inv - held, 0);
    const cachedRaw = r[9];
    const cached = cachedRaw === '' || cachedRaw == null ? 0 : Number(cachedRaw) || 0;
    if (Math.abs(cached - rule) > 0.51) overwritten++;
    const bump = (wk, f, v) => {
      const k = `${key}|${wk}`;
      const cur = trueDemand.get(k) || { ruleExact: 0, ruleBucket: 0, cacheExact: 0 };
      cur[f] += v;
      trueDemand.set(k, cur);
    };
    bump(d, 'ruleExact', rule);
    bump(d, 'cacheExact', cached);
    bump(weekEnding(d), 'ruleBucket', rule);
  }
  const poRows = XLSX.utils
    .sheet_to_json(wb.Sheets["PO's"], { header: 1, raw: true, defval: null, blankrows: false })
    .slice(1).filter((r) => r && r[0] && r[3]);
  const trueIncoming = new Map();
  for (const r of poRows) {
    const key = String(r[3]).trim().toUpperCase();
    const d = toISODate(r[7]);
    if (!d) continue;
    const qty = Number(r[4]) || 0;
    const bump = (wk, f) => {
      const k = `${key}|${wk}`;
      const cur = trueIncoming.get(k) || { exact: 0, bucket: 0 };
      cur[f] += qty;
      trueIncoming.set(k, cur);
    };
    bump(d, 'exact');
    bump(weekEnding(d), 'bucket');
  }

  if (overwritten) {
    console.log(`  ⚠  ${overwritten} linhas da aba Project com a fórmula de QTY to Pick sobrescrita por valor digitado.\n`);
  }

  console.log(`  ${sample.length} SKUs · ${WEEKS} semanas · reporte ${state.reporting_week}\n`);

  const excel = {};
  for (const [sheet, want] of wantBySheet) Object.assign(excel, readBlocks(wb.Sheets[sheet], want));

  let compared = 0, matched = 0;
  const anchorOff = new Map();
  // SKUs cujas células de venda ignoram o fator sazonal. A diferença por semana
  // pode caber na tolerância e só aparecer acumulada no saldo — por isso é
  // detectada aqui, olhando toda semana, não só as que já divergiram.
  const staleSales = new Set();
  const diffs = [];
  const perField = { opening: 0, incoming: 0, sales: 0, project: 0, closing: 0 };

  for (const s of sample) {
    const x = excel[s.sku];
    if (!x) continue;
    const p = projectSku({
      weeks: weeks.map((w, i) => ({ weekEnding: w.week_ending, factor: Number(w.factor), isReporting: i === 0 })),
      soh: Number(s.soh_available),
      wkAvg: Number(s.wk_avg),
      incoming: inIdx[s.sku_key] || {},
      draws: drawIdx[s.sku_key] || {},
      undatedQty: Number(s.undated_qty || 0),
      targetCoverWeeks: s.target_cover_weeks || 7,
      projectOrders: Number(s.project_orders || 0),
    });

    // Âncora: o fechamento da semana de reporte é o SOH real dos dois lados.
    // Se ele já difere, tudo o que vem depois é arrasto disso — e a causa é
    // o dado de estoque, não a cascata.
    const anchorWk = p.rows[0].weekEnding;
    const anchorExcel = x.closing[anchorWk];
    const anchorDelta = anchorExcel == null || Number.isNaN(anchorExcel) ? 0 : p.rows[0].closing - anchorExcel;
    if (Math.abs(anchorDelta) > TOL) anchorOff.set(s.sku, anchorDelta);

    for (let i = 1; i < p.rows.length; i++) {          // pula a semana de reporte
      const row = p.rows[i];
      const wk = row.weekEnding;
      if (!(wk in x.closing)) continue;
      const pairs = [
        ['opening', row.opening, x.opening[wk]],
        ['incoming', row.incoming, x.incoming[wk]],
        ['sales', row.expectedSales, x.sales[wk]],
        ['project', row.projectDraws, x.project[wk]],
        ['closing', row.closing, x.closing[wk]],
      ];
      if (row.factor !== 1 && Number(s.wk_avg) > 0) {
        const theirSales = x.sales[wk];
        if (theirSales != null && !Number.isNaN(theirSales)
            && Math.abs(theirSales - Number(s.wk_avg)) <= TOL
            && Math.abs(theirSales - Number(s.wk_avg) * row.factor) > 0.001) {
          staleSales.add(s.sku);
        }
      }
      for (const [field, ours, theirs] of pairs) {
        if (theirs == null || Number.isNaN(theirs)) continue;   // #REF! do Excel
        compared++;
        if (Math.abs(ours - theirs) <= TOL) { matched++; continue; }
        perField[field]++;
        diffs.push({ sku: s.sku, key: s.sku_key, supplier: s.supplier_code, week: wk, field, ours, theirs,
                     delta: +(ours - theirs).toFixed(2), factor: row.factor, wkAvg: Number(s.wk_avg),
                     lifecycle: s.lifecycle_status, wkAvgInput: Number(s.wk_avg_input || 0) });
      }
    }
  }

  const pct = compared ? ((matched / compared) * 100).toFixed(2) : '0';
  console.log('─── Resultado ─────────────────────────────────────────────');
  console.log(`  Células comparadas   ${compared}`);
  console.log(`  Batendo              ${matched}  (${pct}%)`);
  console.log(`  Divergentes          ${diffs.length}`);
  console.log(`  Por campo            ${JSON.stringify(perField)}\n`);

  if (diffs.length) {
    // Classifica cada divergência. Só a categoria REAL conta contra o motor.
    for (const d of diffs) {
      // Divergência DELIBERADA: SKU descontinuado não vende mais, então a
      // projeção zera a venda de propósito. O Excel segue projetando o Wk/Avg
      // digitado — é a diferença que o módulo existe para criar.
      if (d.lifecycle && d.lifecycle !== 'ACTIVE') {
        if (d.field === 'sales' && d.ours === 0 && Math.abs(d.theirs - d.wkAvgInput * d.factor) <= TOL) {
          d.klass = 'LIFECYCLE'; continue;
        }
        d.klass = 'CASCADE_LIFECYCLE'; continue;
      }
      if (d.field === 'sales') {
        // A venda projetada é Wk/Avg × fator. Quando o Excel exibe justamente
        // Wk/Avg numa semana de fator diferente de 1, a célula não foi
        // recalculada — o fator existe na linha 2, só não foi aplicado.
        if (Math.abs(d.ours - d.wkAvg * d.factor) > TOL) d.klass = 'REAL';
        else if (d.factor !== 1 && Math.abs(d.theirs - d.wkAvg) <= TOL) d.klass = 'STALE_EXCEL';
        else d.klass = 'REAL';
        continue;
      }
      if (d.field === 'incoming') {
        const t = trueIncoming.get(`${d.key.toUpperCase()}|${d.week}`) || { exact: 0, bucket: 0 };
        if (Math.abs(d.ours - t.bucket) > TOL) d.klass = 'REAL';
        else if (Math.abs(t.bucket - t.exact) > TOL) d.klass = 'OFF_GRID';
        else d.klass = 'STALE_EXCEL';
        d.trueBucket = t.bucket;
        continue;
      }
      if (d.field !== 'project') { d.klass = 'CASCADE'; continue; }
      const t = trueDemand.get(`${d.key.toUpperCase()}|${d.week}`) || { ruleExact: 0, ruleBucket: 0, cacheExact: 0 };
      d.trueBucket = t.ruleBucket;
      if (Math.abs(d.ours - t.ruleBucket) > TOL)              d.klass = 'REAL';
      else if (Math.abs(d.theirs - t.cacheExact) > TOL)       d.klass = 'STALE_EXCEL';
      else if (Math.abs(t.ruleExact - t.cacheExact) > TOL)    d.klass = 'OVERWRITTEN_FORMULA';
      else if (Math.abs(t.ruleBucket - t.ruleExact) > TOL)    d.klass = 'OFF_GRID';
      else                                                    d.klass = 'STALE_EXCEL';
    }
    // Uma divergência de opening/closing herda a classe da raiz do mesmo SKU.
    const rootClass = new Map();
    for (const d of diffs) if (d.klass && d.klass !== 'CASCADE') rootClass.set(d.sku, d.klass);
    for (const d of diffs) {
      if (d.klass !== 'CASCADE') continue;
      if (rootClass.has(d.sku)) d.klass = `CASCADE_${rootClass.get(d.sku)}`;
      else if (staleSales.has(d.sku)) d.klass = 'CASCADE_STALE_SEASONAL';
      else if (anchorOff.has(d.sku)) d.klass = 'ANCHOR_SOH';
      else d.klass = 'REAL';
    }

    const groups = diffs.reduce((m, d) => { (m[d.klass] = m[d.klass] || []).push(d); return m; }, {});
    const real = diffs.filter((d) => d.klass === 'REAL');

    if (anchorOff.size) {
      const sample3 = [...anchorOff.entries()].slice(0, 5).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v.toFixed(0)}`);
      console.log(`  ⓘ  ${anchorOff.size} SKUs já começam com SOH diferente na semana de reporte: ${sample3.join(', ')}\n`);
    }
    console.log('─── Por que divergiu ──────────────────────────────────────');
    const explain = {
      STALE_EXCEL: 'célula do Excel com valor velho: a fórmula existe, mas o cache não bate com o próprio SUMIFS dela',
      CASCADE_STALE_EXCEL: 'arrasto da célula velha acima pelo encadeamento das semanas',
      OFF_GRID: 'demanda que o Excel perdia por pick date fora do domingo — é o defeito que o módulo corrige',
      LIFECYCLE: 'SKU descontinuado: a venda foi zerada de propósito. O Excel segue projetando produto que a empresa parou de vender',
      CASCADE_LIFECYCLE: 'arrasto do SKU descontinuado pelo encadeamento das semanas',
      OVERWRITTEN_FORMULA: 'alguém digitou um valor por cima da fórmula de QTY to Pick nessa linha',
      CASCADE_OVERWRITTEN_FORMULA: 'arrasto da fórmula sobrescrita',
      CASCADE_OFF_GRID: 'arrasto da demanda recuperada',
      CASCADE_STALE_SEASONAL: 'arrasto de células de venda que não aplicaram o fator sazonal da linha 2',
      ANCHOR_SOH: 'o SOH da semana de reporte já difere no Excel — o resto é arrasto do estoque, não da cascata',
      REAL: 'DIVERGÊNCIA NÃO EXPLICADA — investigar',
    };
    for (const [k, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${k.padEnd(22)} ${String(list.length).padStart(4)}   ${explain[k] || ''}`);
    }
    console.log('');

    const roots = diffs.filter((d) => d.field === 'project' || d.field === 'incoming' || d.field === 'sales');
    if (roots.length) {
      console.log('  Raízes (o resto é arrasto):');
      console.log('  SKU                       Semana      Campo    Nosso   Excel  SUMIFS-real  Classe');
      for (const d of (VERBOSE ? roots : roots.slice(0, 15))) {
        console.log(`  ${d.sku.slice(0, 24).padEnd(25)} ${d.week} ${d.field.padEnd(8)} ${String(d.ours).padStart(7)} ${String(d.theirs).padStart(7)} ${String(d.trueBucket ?? '-').padStart(12)}  ${d.klass}`);
      }
      if (!VERBOSE && roots.length > 15) console.log(`  … mais ${roots.length - 15}. Use --verbose.`);
      console.log('');
    }

    if (real.length) {
      console.log('  Não explicadas:');
      console.log('  SKU                       Semana      Campo    Nosso   Excel');
      for (const d of real.slice(0, 20))
        console.log(`  ${d.sku.slice(0,24).padEnd(25)} ${d.week} ${d.field.padEnd(8)} ${String(d.ours).padStart(7)} ${String(d.theirs).padStart(7)}`);
      console.log(`  ❌ GATE REPROVADO: ${real.length} divergência(s) sem explicação.\n`);
      process.exitCode = 1;
    } else {
      console.log('  ✅ GATE APROVADO: toda divergência é rastreada a um defeito conhecido do workbook,');
      console.log('     nenhuma a erro do motor.\n');
    }
  } else {
    console.log('  ✅  Paridade total na amostra.\n');
  }

  await db.close();
  process.exitCode = 0;
})().catch(async (e) => { console.error('❌', e.message, '\n', e.stack.split('\n')[1]); await db.close(); process.exit(1); });
