#!/usr/bin/env node
/**
 * A captura diária que o Inventory Report mensal precisa.
 *
 *   node features/stock-planning/scripts/capture-monthly.js            (dry-run)
 *   node features/stock-planning/scripts/capture-monthly.js --write
 *   node ... --write --date=2026-08-29     (regravar um dia específico)
 *
 * POR QUE ISTO EXISTE. Ao mapear os 33 slides do relatório contra os dados,
 * seis eram impossíveis — não por falta de código, mas porque ninguém guardou
 * o histórico. O sync do Cin7 faz TRUNCATE e reescreve; o saldo de julho já
 * não existe em lugar nenhum, e o Cin7 não vende saldo em data passada.
 *
 * Isso torna este script urgente de um jeito que quase nada é: o slide "Top 10
 * em estoque baixo nos últimos 6 meses" existe seis meses depois de ligar isto,
 * e não antes. Cada dia sem rodar é um dia que não volta.
 *
 * IDEMPOTENTE por (dia, sku, local): rodar duas vezes no mesmo dia reescreve,
 * não duplica. É de propósito — um cron que falha e é reexecutado à mão não
 * pode estragar o dia.
 */
'use strict';
require('dotenv').config();
const db = require('../lib/sp-db');

const WRITE = process.argv.includes('--write');
const DIA = (process.argv.find((a) => a.startsWith('--date=')) || '').slice(7) || null;

async function soh(dia) {
  /* O custo vem de products.average_cost e é gravado JUNTO. Um LEFT JOIN, e
     não um lookup depois: se o produto não tiver custo, a linha entra com
     quantidade e sem valor — perder a quantidade por falta de custo seria
     jogar fora o dado factual por causa do derivado. */
  const [r] = await db.query(
    `SELECT count(*)::int linhas,
            count(*) FILTER (WHERE p.average_cost > 0)::int com_custo,
            count(DISTINCT s.location_name)::int locais,
            round(sum(s.on_hand * coalesce(p.average_cost,0))::numeric, 2) valor
       FROM cin7_mirror.stock_snapshot s
       LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = upper(btrim(s.sku))
      WHERE s.on_hand <> 0`);
  console.log(`  SOH: ${r.linhas} linhas em ${r.locais} locais · ${r.com_custo} com custo · ${fmt(r.valor)}`);
  if (!WRITE) return r;

  const n = await db.tx(async (c) => {
    const q = await c.query(
      `INSERT INTO rapid_inv.mr_soh_daily
         (snapshot_date, sku_key, sku, location, on_hand, allocated, available, in_transit, unit_cost)
       /* AGREGADO por (sku, local), e não linha a linha.
          cin7_mirror.stock_snapshot tem bin e batch: o mesmo SKU ocupa vários
          bins no mesmo depósito, então a fonte traz a dupla repetida e o
          ON CONFLICT recusa com "cannot affect row a second time". O relatório
          fala de depósito, não de posição — a soma é a resposta certa, não um
          contorno para o erro. */
       SELECT $1::date, upper(btrim(s.sku)), min(s.sku), s.location_name,
              sum(s.on_hand), sum(s.allocated), sum(s.available), sum(s.in_transit),
              max(p.average_cost)
         FROM cin7_mirror.stock_snapshot s
         LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = upper(btrim(s.sku))
        WHERE s.sku IS NOT NULL AND s.location_name IS NOT NULL
        GROUP BY upper(btrim(s.sku)), s.location_name
       HAVING sum(s.on_hand) <> 0
       ON CONFLICT (snapshot_date, sku_key, location) DO UPDATE
         SET on_hand = EXCLUDED.on_hand, allocated = EXCLUDED.allocated,
             available = EXCLUDED.available, in_transit = EXCLUDED.in_transit,
             unit_cost = EXCLUDED.unit_cost, captured_at = now()`,
      [dia]);
    return q.rowCount;
  }, 'capture-soh');
  console.log(`  ✓ ${n} linhas gravadas em ${dia}`);
  return r;
}

async function openOrders(fimDoMes) {
  /* A mesma conta do slide 3: por rep, quantos pedidos em aberto, quanto vale
     o pedido, quanto já foi faturado e quanto falta. */
  const linhas = await db.query(
    `SELECT coalesce(nullif(btrim(rep), ''), '(sem rep)') AS rep,
            count(DISTINCT sales_order)::int AS orders,
            round(sum(qty * coalesce(unit_price,0))::numeric, 2)                          AS value_open,
            round(sum(coalesce(qty_inv,0) * coalesce(unit_price,0))::numeric, 2)          AS value_invoiced,
            round(sum(coalesce(qty_to_pick,0) * coalesce(unit_price,0))::numeric, 2)      AS value_left
       FROM rapid_inv.v_sp_lines
      WHERE project_status = 'ACTIVE'
      GROUP BY 1 ORDER BY 3 DESC`);
  const tot = linhas.reduce((a, r) => a + Number(r.value_open), 0);
  console.log(`  Open orders: ${linhas.length} reps · ${fmt(tot)} em aberto`);
  if (!WRITE) return linhas;

  await db.tx(async (c) => {
    for (const l of linhas) {
      await c.query(
        `INSERT INTO rapid_inv.mr_open_orders_monthly
           (month_end, rep, orders, value_open, value_invoiced, value_left)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (month_end, rep) DO UPDATE
           SET orders = EXCLUDED.orders, value_open = EXCLUDED.value_open,
               value_invoiced = EXCLUDED.value_invoiced, value_left = EXCLUDED.value_left,
               captured_at = now()`,
        [fimDoMes, l.rep, l.orders, l.value_open, l.value_invoiced, l.value_left]);
    }
  }, 'capture-open-orders');
  console.log(`  ✓ ${linhas.length} reps gravados em ${fimDoMes}`);
  return linhas;
}

const fmt = (v) => 'A$' + Number(v || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });

async function main() {
  // NULL e não string vazia: o Postgres tenta converter '' para date antes de
  // o coalesce agir, e falha ali.
  const [{ hoje, fimMes }] = await db.query(
    `SELECT coalesce($1::date, current_date) AS hoje,
            (date_trunc('month', coalesce($1::date, current_date))
              + interval '1 month - 1 day')::date AS "fimMes"`, [DIA]);
  console.log(`\n  dia ${hoje} · mês fechando em ${fimMes}${WRITE ? '' : '   (dry-run)'}\n`);
  await soh(hoje);
  await openOrders(fimMes);

  if (WRITE) {
    const [c] = await db.query(
      `SELECT count(DISTINCT snapshot_date)::int dias, min(snapshot_date) de, max(snapshot_date) ate,
              count(*)::int linhas FROM rapid_inv.mr_soh_daily`);
    console.log(`\n  série acumulada: ${c.dias} dia(s), de ${c.de} a ${c.ate}, ${c.linhas} linhas`);
    // O slide de 6 meses precisa de 6 meses. Dizer quanto falta é mais útil
    // que dizer que gravou.
    const faltam = Math.max(0, 183 - c.dias);
    if (faltam) console.log(`  faltam ~${faltam} dias para o slide "estoque baixo em 6 meses" existir\n`);
  } else {
    console.log('\n  (dry-run — rode com --write para gravar)\n');
  }
  await db.close();
}
main().catch((e) => { console.error('  ERRO:', e.message); process.exit(1); });
