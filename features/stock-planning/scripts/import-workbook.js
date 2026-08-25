#!/usr/bin/env node
'use strict';
/**
 * Carrega o Rapid-Inventory SKU 2026.xlsx para o schema rapid_inv.
 *
 *   node features/stock-planning/scripts/import-workbook.js                  # dry-run
 *   node features/stock-planning/scripts/import-workbook.js --write
 *   node features/stock-planning/scripts/import-workbook.js --write --skip-completed
 *   node features/stock-planning/scripts/import-workbook.js --only=pos,stock
 *
 * SEGURO POR PADRÃO: sem --write nada é gravado.
 *
 * Idempotente: cada rodada apaga o que a rodada anterior escreveu com
 * source='EXCEL_IMPORT' e regrava. As 3.783 linhas do import de junho/2026
 * não são apagadas — são marcadas is_void, ficam fora das views e podem
 * voltar se alguém precisar.
 */
require('dotenv').config();
const { parseWorkbook, DEFAULT_FILE } = require('../lib/excel-import');
const db = require('../lib/sp-db');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const SKIP_COMPLETED = args.includes('--skip-completed');
const FILE = (args.find((a) => a.startsWith('--file=')) || '').slice(7) || DEFAULT_FILE;
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const ACTOR = (args.find((a) => a.startsWith('--as=')) || '').slice(5) || 'excel-import';
const want = (kind) => ONLY.length === 0 || ONLY.includes(kind);

const TODAY = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(...a);

async function bulk(client, table, cols, rows, chunkSize = 400) {
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    const tuples = chunk.map((row) => {
      const ph = cols.map((c) => { params.push(row[c] === undefined ? null : row[c]); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    const res = await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`,
      params
    );
    written += res.rowCount;
  }
  return written;
}

(async () => {
  log(`\n📖  Lendo ${FILE}`);
  const t0 = Date.now();
  const data = parseWorkbook(FILE);
  log(`    ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const activeLines = data.projects.lines.filter((l) => l.status === 'ACTIVE');
  const completedLines = SKIP_COMPLETED ? [] : data.projects.lines.filter((l) => l.status === 'COMPLETED');
  const lines = [...activeLines, ...completedLines];
  const s = data.summary;

  log('─── O que o workbook tem ───────────────────────────────────');
  log(`  Projetos (Sales Orders)      ${s.projects}`);
  log(`  Linhas ativas                ${s.activeLines}`);
  log(`  Linhas concluídas            ${SKIP_COMPLETED ? '0 (--skip-completed)' : s.completedLines}`);
  log(`  Draws                        ${s.draws}  (${s.undatedDraws} sem data = TBA)`);
  log(`  Linhas de PO                 ${s.poLines} em ${s.poCount} POs`);
  log(`  SOH / commitment / filial    ${s.sohRows} / ${s.commitmentRows} / ${s.branchRows}`);
  log(`  Vendas da semana             ${s.weeklySalesRows}  (${s.salesPeriod.from} → ${s.salesPeriod.to})`);
  log(`  Parâmetros de SKU            ${s.skuSettings.total}  (${s.skuSettings.withWkAvg} com Wk/Avg, ${s.skuSettings.withTarget} com meta)`);
  log(`  Versões de SKU               ${s.versionRows}`);
  log(`  Metas de cobertura           ${JSON.stringify(s.skuSettings.targets)}`);
  log('');
  log('─── Defeitos do Excel que o import corrige ────────────────');
  log(`  Pick dates fora do domingo   ${s.activeOffGrid}  → passam a cair na semana delas`);
  log(`  PO due dates fora do domingo ${s.poOffGrid}  → idem`);
  log(`  Câmbios distintos em uso     ${JSON.stringify(data.pos.stats.fxValues)}  → viram fx_used por linha`);
  log(`  Custos unitários recuperados ${data.pos.stats.withCost} de ${s.poLines}  → saem da fórmula, viram campo`);
  log('');

  if (!WRITE) {
    log('🔍  DRY-RUN. Nada foi gravado. Rode com --write para valer.\n');
    await db.close();
    return;
  }

  log('✍️   Gravando…\n');
  const counts = {};

  await db.tx(async (c) => {
    // ── Projetos, linhas e draws ─────────────────────────────────────
    if (want('projects')) {
      await c.query(`
        UPDATE rapid_inv.project_lines
           SET is_void = true, source = 'LEGACY_2026_06'
         WHERE project_id IS NULL AND source <> 'LEGACY_2026_06'`);

      await c.query(`DELETE FROM rapid_inv.projects WHERE source = 'EXCEL_IMPORT'`); // cascata leva linhas e draws

      const projects = [...data.projects.projects.values()];
      counts.projects = await bulk(c, 'rapid_inv.projects',
        ['sales_order','order_date','customer','reference','rep','warehouse_note','status','finish_date','source','updated_by'],
        projects.map((p) => ({ ...p, updated_by: ACTOR })));

      const pmap = new Map(
        (await c.query(`SELECT id, upper(btrim(sales_order)) k FROM rapid_inv.projects WHERE source='EXCEL_IMPORT'`)).rows
          .map((r) => [r.k, r.id])
      );

      const lineRows = lines
        .map((l) => ({ ...l, project_id: pmap.get(l.project_key) }))
        .filter((l) => l.project_id);

      counts.lines = await bulk(c, 'rapid_inv.project_lines',
        ['project_id','line_no','date_opened','sku','qty','type','unit_price','po_ref','po_due_date',
         'pick_date','qty_held','date_packed','qty_inv','required_text','warehouse','comments',
         'finish_date','source','updated_by'],
        lineRows.map((l) => ({
          project_id: l.project_id, line_no: l.line_no, date_opened: l.date_opened || TODAY,
          sku: l.sku, qty: l.qty, type: l.type, unit_price: l.unit_price, po_ref: l.po_ref,
          po_due_date: l.po_due_date, pick_date: l.pick_date, qty_held: l.qty_held,
          date_packed: l.date_packed, qty_inv: l.qty_inv, required_text: l.required_text,
          warehouse: l.warehouse, comments: l.comments && l.comments.length ? l.comments : null,
          finish_date: l.finish_date, source: 'EXCEL_IMPORT', updated_by: ACTOR,
        })), 300);

      const lmap = new Map(
        (await c.query(`SELECT id, project_id, line_no FROM rapid_inv.project_lines WHERE source='EXCEL_IMPORT'`)).rows
          .map((r) => [`${r.project_id}|${r.line_no}`, r.id])
      );

      const drawRows = [];
      for (const l of lineRows) {
        if (!l.draw) continue;
        const id = lmap.get(`${l.project_id}|${l.line_no}`);
        if (!id) continue;
        drawRows.push({
          line_id: id, seq: 1, qty: l.draw.qty, planned_date: l.draw.planned_date,
          status: l.status === 'COMPLETED' ? 'INVOICED' : 'PLANNED',
          note: null, source: 'EXCEL_IMPORT', updated_by: ACTOR,
        });
      }
      counts.draws = await bulk(c, 'rapid_inv.project_draws',
        ['line_id','seq','qty','planned_date','status','note','source','updated_by'], drawRows);
    }

    // ── Ordens de compra ─────────────────────────────────────────────
    if (want('pos')) {
      await c.query(`DELETE FROM rapid_inv.po_lines WHERE source = 'EXCEL_IMPORT'`);
      const alias = new Map(
        (await c.query(`SELECT alias, supplier_code FROM rapid_inv.supplier_aliases`)).rows
          .map((r) => [r.alias, r.supplier_code])
      );
      const unknown = new Set();
      const rows = data.pos.lines.map((p) => {
        const code = p.supplier_raw ? alias.get(p.supplier_raw) || null : null;
        if (p.supplier_raw && !code) unknown.add(p.supplier_raw);
        return {
          po_number: p.po_number, line_no: p.line_no, po_date: p.po_date || TODAY,
          supplier_code: code, sku: p.sku, qty: p.qty, finish_date: p.finish_date,
          date_checked: p.date_checked, due_date: p.due_date, require_status: p.finish_note,
          vessel: p.vessel, value_usd: p.value_usd, value_aud: p.value_aud,
          unit_cost_usd: p.unit_cost_usd, fx_used: p.fx_used, source: 'EXCEL_IMPORT', updated_by: ACTOR,
        };
      });
      counts.po_lines = await bulk(c, 'rapid_inv.po_lines',
        ['po_number','line_no','po_date','supplier_code','sku','qty','finish_date','date_checked',
         'due_date','require_status','vessel','value_usd','value_aud','unit_cost_usd','fx_used','source','updated_by'], rows);
      if (unknown.size) counts.unknown_suppliers = [...unknown];
    }

    // ── Estoques ─────────────────────────────────────────────────────
    if (want('stock')) {
      await c.query(`UPDATE rapid_inv.soh_snapshot SET is_current = false WHERE is_current`);
      await c.query(`DELETE FROM rapid_inv.soh_snapshot WHERE source='EXCEL_IMPORT' AND snapshot_date::date = $1`, [TODAY]);
      counts.soh = await bulk(c, 'rapid_inv.soh_snapshot',
        ['snapshot_date','sku','warehouse','qty_on_hand','allocated','on_order','is_current','source'],
        data.stock.soh.map((r) => ({ snapshot_date: TODAY, sku: r.sku, warehouse: 'ALL',
          qty_on_hand: r.qty_on_hand, allocated: r.allocated, on_order: r.on_order, is_current: true, source: 'EXCEL_IMPORT' })));

      await c.query(`DELETE FROM rapid_inv.project_commitment WHERE snapshot_date = $1`, [TODAY]);
      counts.commitment = await bulk(c, 'rapid_inv.project_commitment',
        ['snapshot_date','sku','qty_on_hand','allocated','on_order','source'],
        data.stock.commitment.map((r) => ({ snapshot_date: TODAY, ...r, source: 'EXCEL_IMPORT' })));

      await c.query(`DELETE FROM rapid_inv.branch_soh WHERE snapshot_date = $1`, [TODAY]);
      counts.branch = await bulk(c, 'rapid_inv.branch_soh',
        ['snapshot_date','branch_code','sku','qty_on_hand','allocated','on_order','source'],
        data.stock.branch.map((r) => ({ snapshot_date: TODAY, ...r, source: 'EXCEL_IMPORT' })));

      const ps = data.stock.sales_period;
      const wkStart = ps.from ? new Date(ps.from + ' UTC').toISOString().slice(0, 10) : null;
      if (wkStart) {
        await c.query(`DELETE FROM rapid_inv.weekly_sales WHERE week_start = $1`, [wkStart]);
        counts.weekly_sales = await bulk(c, 'rapid_inv.weekly_sales',
          ['week_start','sku','qty','sale_value','cogs','invoice_value','profit'],
          data.stock.weekly_sales.map((r) => ({ week_start: wkStart, ...r })));
      }
    }

    // ── Parâmetros por SKU ───────────────────────────────────────────
    if (want('skus')) {
      const rows = data.skus.settings.map((x) => ({
        sku: x.sku,
        supplier_code: x.supplier_code,
        legacy_code: x.legacy_code,
        wk_avg: x.wk_avg,
        wk_avg_source: 'EXCEL_IMPORT',
        target_cover_weeks: x.target_cover_weeks == null ? 7 : x.target_cover_weeks,
        comments: x.comments || null,
        // A grade de planejamento é a lista curada do Analysis (1.988 SKUs).
        // O resto fica cadastrado mas fora da tela até alguém marcar.
        is_planned: !!x.in_analysis,
        updated_by: ACTOR,
      }));
      let n = 0;
      for (let i = 0; i < rows.length; i += 300) {
        const chunk = rows.slice(i, i + 300);
        const params = [];
        const tuples = chunk.map((r) => {
          const ph = ['sku','supplier_code','legacy_code','wk_avg','wk_avg_source','target_cover_weeks','comments','is_planned','updated_by']
            .map((k) => { params.push(r[k] === undefined ? null : r[k]); return `$${params.length}`; });
          return `(${ph.join(',')})`;
        });
        const res = await c.query(`
          INSERT INTO rapid_inv.sku_settings
            (sku,supplier_code,legacy_code,wk_avg,wk_avg_source,target_cover_weeks,comments,is_planned,updated_by)
          VALUES ${tuples.join(',')}
          ON CONFLICT (sku) DO UPDATE SET
            supplier_code=EXCLUDED.supplier_code, legacy_code=EXCLUDED.legacy_code,
            wk_avg=EXCLUDED.wk_avg, wk_avg_source=EXCLUDED.wk_avg_source,
            target_cover_weeks=EXCLUDED.target_cover_weeks,
            comments=COALESCE(EXCLUDED.comments, rapid_inv.sku_settings.comments),
            is_planned=EXCLUDED.is_planned, updated_by=EXCLUDED.updated_by, updated_at=now()`, params);
        n += res.rowCount;
      }
      counts.sku_settings = n;
    }

    // ── Versões de SKU ───────────────────────────────────────────────
    if (want('versions')) {
      let n = 0;
      for (let i = 0; i < data.versions.length; i += 300) {
        const chunk = data.versions.slice(i, i + 300);
        const params = [];
        const tuples = chunk.map((r) => {
          const ph = ['version_code','current_sku','resolved'].map((k) => { params.push(r[k]); return `$${params.length}`; });
          return `(${ph.join(',')})`;
        });
        const res = await c.query(`
          INSERT INTO rapid_inv.sku_versions (version_code,current_sku,resolved) VALUES ${tuples.join(',')}
          ON CONFLICT (version_code) DO UPDATE SET
            current_sku=EXCLUDED.current_sku, resolved=EXCLUDED.resolved, updated_at=now()`, params);
        n += res.rowCount;
      }
      counts.sku_versions = n;
    }

    await c.query(`
      INSERT INTO rapid_inv.import_batches (source_file, kind, rows_in, rows_written, finished_at, ok, detail, run_by)
      VALUES ($1,$2,$3,$4,now(),true,$5,$6)`,
      [FILE, ONLY.length ? ONLY.join('+') : 'FULL', lines.length, JSON.stringify(counts).length, JSON.stringify(counts), ACTOR]);
  }, ACTOR);

  log('─── Gravado ───────────────────────────────────────────────');
  for (const [k, v] of Object.entries(counts)) log(`  ${k.padEnd(20)} ${Array.isArray(v) ? v.join(', ') : v}`);
  log('');
  await db.close();
})().catch(async (e) => {
  console.error('\n❌ ', e.message);
  console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  await db.close();
  process.exit(1);
});
