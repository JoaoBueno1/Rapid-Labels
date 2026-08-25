'use strict';
/**
 * Analytics — o relatório mensal, ao vivo.
 *
 * Sete decks mensais montados à mão: export do Cin7 → colado no Excel →
 * printado no PowerPoint. Dezembro a abril não têm um único gráfico nativo.
 * E o dado sempre esteve aqui: 78.256 pedidos desde 2021, com local, data de
 * fatura, imposto, COGS e vendedor. Faltava a tela.
 *
 * Todo SQL pesado mora em views (db/001). A rota junta e devolve.
 */
const db = require('../../stock-planning/lib/sp-db');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error('[analytics]', req.path, e.message); res.status(500).json({ error: e.message }); }
};
const asInt = (v, d, min, max) => { const n = parseInt(v, 10); return isNaN(n) ? d : Math.min(Math.max(n, min), max); };

function register(app) {
  const R = '/api/analytics';

  /** O mês em uma tela: venda, margem, estoque, cobertura — por filial. */
  app.get(`${R}/monthly`, wrap(async (req, res) => {
    const t0 = Date.now();
    const months = asInt(req.query.months, 13, 2, 60);
    const [sales, byWarehouse, totals] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_an_monthly_sales
                 WHERE mth >= date_trunc('month', now()) - ($1 || ' months')::interval
                 ORDER BY mth DESC, sales DESC NULLS LAST`, [months]),
      db.query(`SELECT * FROM rapid_inv.v_an_stock_by_warehouse ORDER BY soh_value DESC NULLS LAST`),
      db.query(`SELECT mth, round(sum(sales)) AS sales, round(sum(cogs)) AS cogs,
                       round(sum(sales) - sum(cogs)) AS gross_profit,
                       round(100*(sum(sales)-sum(cogs))/NULLIF(sum(sales),0),1) AS gp_pct,
                       round(sum(sales_ly)) AS sales_ly
                  FROM rapid_inv.v_an_monthly_sales
                 WHERE mth >= date_trunc('month', now()) - ($1 || ' months')::interval
                 GROUP BY 1 ORDER BY 1`, [months]),
    ]);
    res.json({ sales, byWarehouse, totals, ms: Date.now() - t0 });
  }));

  /** Dinheiro parado: quarentena, e o cruzamento que dói. */
  app.get(`${R}/stuck-money`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [quarantine, byBin, topSkus, cross, dead] = await Promise.all([
      db.query(`SELECT location, sum(skus)::int skus, round(sum(units)) AS units,
                       round(sum(value_aud)) AS value_aud
                  FROM rapid_inv.v_an_quarantine GROUP BY 1 ORDER BY 4 DESC`),
      db.query(`SELECT location, bin, skus, units, value_aud FROM rapid_inv.v_an_quarantine
                 ORDER BY value_aud DESC LIMIT 40`),
      db.query(`SELECT * FROM rapid_inv.v_an_quarantine_sku ORDER BY value_aud DESC LIMIT 60`),
      db.query(`SELECT * FROM rapid_inv.v_an_backorder_in_quarantine
                 ORDER BY only_in_quarantine DESC, value_aud DESC LIMIT 80`),
      db.query(`SELECT * FROM rapid_inv.v_sp_dead_stock_totals ORDER BY 1`),
    ]);
    const [crossTotal] = await db.query(
      `SELECT count(*)::int skus, round(sum(value_aud)) AS value_aud,
              count(*) FILTER (WHERE only_in_quarantine)::int only_here
         FROM rapid_inv.v_an_backorder_in_quarantine`);
    res.json({ quarantine, byBin, topSkus, cross, crossTotal, dead, ms: Date.now() - t0 });
  }));

  /** A malha interna: transferência, despacho, o que está preso. */
  app.get(`${R}/operations`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [transfer, stuck, sla, stuckTotal] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_an_transfer_leadtime ORDER BY transfers DESC`),
      db.query(`SELECT * FROM rapid_inv.v_an_stuck_transfers ORDER BY days_open DESC LIMIT 60`),
      db.query(`SELECT * FROM rapid_inv.v_an_dispatch_sla WHERE orders >= 20 ORDER BY orders DESC`),
      db.one(`SELECT count(*)::int n, max(days_open)::int worst FROM rapid_inv.v_an_stuck_transfers`),
    ]);
    res.json({ transfer, stuck, sla, stuckTotal, ms: Date.now() - t0 });
  }));

  /**
   * O que dá para liberar hoje. Pedido em backorder cujo SKU já tem estoque
   * vendável — cliente esperando enquanto a peça está no prédio.
   *
   * Devolve filial e obra SEPARADOS de propósito: a tela de Open Orders filtra
   * armazém de projeto, e com isso esconde a parte MAIOR do backorder da
   * empresa. Esconder não é a mesma coisa que decidir.
   */
  app.get(`${R}/releasable`, wrap(async (req, res) => {
    const t0 = Date.now();
    const kind = (req.query.kind || '').toUpperCase();
    const where = ['fully_releasable'], p = [];
    if (kind === 'BRANCH' || kind === 'PROJECT') { p.push(kind); where.push(`branch_kind = $${p.length}`); }
    const [rows, summary] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_an_releasable WHERE ${where.join(' AND ')}
                 ORDER BY age_days DESC LIMIT ${asInt(req.query.limit, 200, 1, 1000)}`, p),
      db.query(`SELECT branch_kind,
                       count(*) FILTER (WHERE fully_releasable)::int orders,
                       round(sum(order_value) FILTER (WHERE fully_releasable)) AS value_aud,
                       round(avg(age_days) FILTER (WHERE fully_releasable))::int avg_age,
                       max(age_days) FILTER (WHERE fully_releasable)::int worst_age,
                       count(*)::int backordered_orders
                  FROM rapid_inv.v_an_releasable GROUP BY 1 ORDER BY 3 DESC NULLS LAST`),
    ]);
    res.json({ rows, summary, ms: Date.now() - t0 });
  }));

  app.get(`${R}/releasable/:order/lines`, wrap(async (req, res) => {
    res.json(await db.query(
      `SELECT * FROM rapid_inv.v_an_releasable_lines WHERE order_number = $1 ORDER BY coverable DESC, line_value DESC`,
      [req.params.order]));
  }));

  console.log('✅ Analytics routes registered: /api/analytics/*');
}

module.exports = { register };
