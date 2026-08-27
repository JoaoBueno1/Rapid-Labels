'use strict';
/**
 * API do Stock Planning.
 *
 * Todo o cálculo semanal roda aqui, no servidor, com planning-engine.js.
 * O navegador recebe números prontos: a grade não recalcula nada, e por isso
 * não importa se o time abrir 1.300 SKUs de uma vez.
 *
 * Nenhuma rota chama o Cin7 em tempo real. O finder de Sales Order lê
 * cin7_mirror, que já é sincronizado pelo app — não é integração nova.
 */
const db = require('../lib/sp-db');
const { projectSku, buildAlerts } = require('../lib/planning-engine');
const { weekEnding, shortLabel, toISODate } = require('../lib/week');

const MAX_PAGE = 500;

// O horizonte de planejamento, em semanas. UMA fonte para /planning, /alerts e
// /buy-recommendation: quando eles discordam, a mesma linha ganha aviso de
// compra numa tela e "não falta no horizonte" na outra, e o planejador para de
// confiar nas duas. 28 cobre o SKU mais lento medido (lead 16,6 + review 1 +
// cover 8 = 25,6) com folga de duas semanas.
const HORIZON_WEEKS = 28;

/** Quem está editando. Ainda não há login; o nome vai para o audit_log. */
const actorOf = (req) =>
  (req.get('x-sp-user') || req.query.as || req.body?._as || 'anon').toString().slice(0, 120);

const asInt = (v, d, min, max) => {
  const n = parseInt(v, 10);
  if (isNaN(n)) return d;
  return Math.min(Math.max(n, min), max);
};

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error('[stock-planning]', req.method, req.path, e.message);
    res.status(500).json({ error: e.message });
  }
};

function register(app) {
  const R = '/api/stock-planning';

  // ── Estado ──────────────────────────────────────────────────────────
  app.get(`${R}/state`, wrap(async (req, res) => {
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id = 1`);
    const [counts] = await db.query(`
      SELECT
        (SELECT count(*) FROM rapid_inv.projects WHERE status='ACTIVE')::int          AS active_projects,
        (SELECT count(*) FROM rapid_inv.projects WHERE status='COMPLETED')::int       AS completed_projects,
        (SELECT count(*) FROM rapid_inv.v_sp_lines WHERE project_status='ACTIVE')::int AS active_lines,
        (SELECT count(*) FROM rapid_inv.project_draws WHERE status='PLANNED')::int    AS open_draws,
        (SELECT count(*) FROM rapid_inv.project_draws WHERE status='PLANNED' AND planned_date IS NULL)::int AS tba_draws,
        (SELECT count(*) FROM rapid_inv.po_lines WHERE NOT is_received)::int          AS open_po_lines,
        (SELECT count(*) FROM rapid_inv.v_sp_planning_skus)::int                      AS planning_skus,
        (SELECT max(snapshot_date)::text FROM rapid_inv.branch_soh)                   AS stock_as_of,
        (SELECT max(synced_at)::text FROM cin7_mirror.sale_lines)                     AS cin7_lines_synced_at`);
    res.json({ ...state, counts });
  }));

  app.get(`${R}/suppliers`, wrap(async (req, res) => {
    res.json(await db.query(`
      SELECT s.supplier_code AS code,
             count(*)::int                                   AS sku_count,
             count(*) FILTER (WHERE s.mths_stock < 1)::int    AS under_one_month,
             count(*) FILTER (WHERE s.soh_nonpositive)::int   AS out_of_stock
        FROM rapid_inv.v_sp_planning_skus s
       WHERE s.supplier_code IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC`));
  }));

  // ── Grade de projetos ───────────────────────────────────────────────
  app.get(`${R}/lines`, wrap(async (req, res) => {
    const limit = asInt(req.query.limit, 100, 1, MAX_PAGE);
    const offset = asInt(req.query.offset, 0, 0, 1e6);
    const where = [];
    const p = [];
    const add = (sql, val) => { p.push(val); where.push(sql.replace('?', `$${p.length}`)); };

    add(`project_status = ?`, (req.query.status || 'ACTIVE').toUpperCase());
    if (req.query.q) add(
      `(sales_order ILIKE ? OR customer ILIKE ? OR reference ILIKE ? OR sku ILIKE ? OR required_text ILIKE ?)`
        .replace(/\?/g, () => `$${p.length + 1}`), `%${req.query.q}%`);
    if (req.query.rep) add(`rep = ?`, req.query.rep);
    if (req.query.customer) add(`customer = ?`, req.query.customer);
    if (req.query.sku) add(`sku_key = ?`, req.query.sku.toUpperCase());
    if (req.query.sales_order) add(`sales_order = ?`, req.query.sales_order);
    if (req.query.only === 'tba') where.push(`draw_qty_undated > 0`);
    if (req.query.only === 'outstanding') where.push(`qty_to_pick > 0`);
    if (req.query.only === 'over_planned') where.push(`over_planned`);
    if (req.query.only === 'held') where.push(`qty_held > 0`);

    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortable = { order_date: 'order_date', sales_order: 'sales_order', customer: 'customer',
      sku: 'sku', qty: 'qty', qty_to_pick: 'qty_to_pick', pick: 'first_planned_date', days_held: 'days_held' };
    const col = sortable[req.query.sort] || 'order_date';
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const [{ total }] = await db.query(`SELECT count(*)::int total FROM rapid_inv.v_sp_lines ${w}`, p);
    const rows = await db.query(
      `SELECT * FROM rapid_inv.v_sp_lines ${w} ORDER BY ${col} ${dir} NULLS LAST, sales_order, line_no
       LIMIT ${limit} OFFSET ${offset}`, p);

    const ids = rows.map((r) => r.id);
    const draws = ids.length
      ? await db.query(`SELECT id, line_id, seq, qty, planned_date, status, note
                          FROM rapid_inv.project_draws WHERE line_id = ANY($1) ORDER BY line_id, seq`, [ids])
      : [];
    const byLine = draws.reduce((m, d) => { (m[d.line_id] = m[d.line_id] || []).push(d); return m; }, {});
    res.json({ total, limit, offset, rows: rows.map((r) => ({ ...r, draws: byLine[r.id] || [] })) });
  }));

  app.get(`${R}/filters`, wrap(async (req, res) => {
    const [reps, customers] = await Promise.all([
      db.query(`SELECT DISTINCT rep FROM rapid_inv.projects WHERE rep IS NOT NULL ORDER BY 1`),
      db.query(`SELECT customer, count(*)::int n FROM rapid_inv.projects
                 WHERE customer IS NOT NULL AND status='ACTIVE' GROUP BY 1 ORDER BY 2 DESC LIMIT 200`),
    ]);
    res.json({ reps: reps.map((r) => r.rep), customers: customers.map((c) => c.customer) });
  }));

  // ── Edição inline ───────────────────────────────────────────────────
  const LINE_FIELDS = ['qty','type','unit_price','po_ref','po_due_date','qty_held','date_packed',
                       'qty_inv','required_text','warehouse','pick_date'];

  app.patch(`${R}/lines/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const sets = [], p = [];
    for (const f of LINE_FIELDS) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (v === '') v = null;
      if (['po_due_date','date_packed','pick_date'].includes(f)) v = toISODate(v);
      p.push(v); sets.push(`${f} = $${p.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const actor = actorOf(req);
    p.push(actor); sets.push(`updated_by = $${p.length}`);
    p.push(id);
    const row = await db.tx(async (c) =>
      (await c.query(`UPDATE rapid_inv.project_lines SET ${sets.join(', ')} WHERE id = $${p.length} RETURNING id`, p)).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'linha não encontrada' });
    res.json(await db.one(`SELECT * FROM rapid_inv.v_sp_lines WHERE id = $1`, [id]));
  }));

  // ── Draws ───────────────────────────────────────────────────────────
  app.post(`${R}/lines/:id/draws`, wrap(async (req, res) => {
    const lineId = asInt(req.params.id, 0, 1, 1e12);
    const qty = Number(req.body.qty);
    if (!(qty > 0)) return res.status(400).json({ error: 'qty tem que ser maior que zero' });
    const actor = actorOf(req);
    const out = await db.tx(async (c) => {
      const [{ next }] = (await c.query(
        `SELECT COALESCE(max(seq),0)+1 next FROM rapid_inv.project_draws WHERE line_id=$1`, [lineId])).rows;
      return (await c.query(
        `INSERT INTO rapid_inv.project_draws (line_id,seq,qty,planned_date,note,source,updated_by)
         VALUES ($1,$2,$3,$4,$5,'MANUAL',$6) RETURNING *`,
        [lineId, next, qty, toISODate(req.body.planned_date), req.body.note || null, actor])).rows[0];
    }, actor);
    res.status(201).json(out);
  }));

  app.patch(`${R}/draws/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const sets = [], p = [];
    for (const f of ['qty', 'planned_date', 'note', 'status']) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (f === 'planned_date') v = toISODate(v);
      if (v === '') v = null;
      p.push(v); sets.push(`${f} = $${p.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const actor = actorOf(req);
    p.push(actor); sets.push(`updated_by = $${p.length}`);
    p.push(id);
    const row = await db.tx(async (c) =>
      (await c.query(`UPDATE rapid_inv.project_draws SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p)).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'draw não encontrado' });
    res.json(row);
  }));

  app.delete(`${R}/draws/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const actor = actorOf(req);
    await db.tx(async (c) => c.query(`DELETE FROM rapid_inv.project_draws WHERE id=$1`, [id]), actor);
    res.json({ ok: true });
  }));

  /**
   * Split Draw: parte a parcela em duas. É o gesto que hoje obriga o time a
   * duplicar a linha inteira no Excel.
   */
  app.post(`${R}/draws/:id/split`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const qty = Number(req.body.qty);
    const actor = actorOf(req);
    const out = await db.tx(async (c) => {
      const orig = (await c.query(`SELECT * FROM rapid_inv.project_draws WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!orig) return null;
      if (!(qty > 0) || qty >= Number(orig.qty)) throw new Error('a quantidade a separar tem que ser menor que a do draw');
      await c.query(`UPDATE rapid_inv.project_draws SET qty = qty - $1, updated_by=$2 WHERE id=$3`, [qty, actor, id]);
      const [{ next }] = (await c.query(
        `SELECT COALESCE(max(seq),0)+1 next FROM rapid_inv.project_draws WHERE line_id=$1`, [orig.line_id])).rows;
      const created = (await c.query(
        `INSERT INTO rapid_inv.project_draws (line_id,seq,qty,planned_date,note,source,updated_by)
         VALUES ($1,$2,$3,$4,$5,'SPLIT',$6) RETURNING *`,
        [orig.line_id, next, qty, toISODate(req.body.planned_date), req.body.note || null, actor])).rows[0];
      return { original_id: id, created };
    }, actor);
    if (!out) return res.status(404).json({ error: 'draw não encontrado' });
    res.status(201).json(out);
  }));

  // ── Projetos ────────────────────────────────────────────────────────
  app.get(`${R}/projects/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const project = await db.one(`SELECT * FROM rapid_inv.projects WHERE id=$1`, [id]);
    if (!project) return res.status(404).json({ error: 'projeto não encontrado' });
    const lines = await db.query(`SELECT * FROM rapid_inv.v_sp_lines WHERE project_id=$1 ORDER BY line_no`, [id]);
    const draws = await db.query(
      `SELECT d.* FROM rapid_inv.project_draws d
        JOIN rapid_inv.project_lines l ON l.id=d.line_id WHERE l.project_id=$1 ORDER BY d.line_id, d.seq`, [id]);
    const byLine = draws.reduce((m, d) => { (m[d.line_id] = m[d.line_id] || []).push(d); return m; }, {});
    res.json({ project, lines: lines.map((l) => ({ ...l, draws: byLine[l.id] || [] })) });
  }));

  app.patch(`${R}/projects/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const sets = [], p = [];
    for (const f of ['status','customer','reference','rep','warehouse_code','warehouse_note','notes','finish_date','order_date']) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (['finish_date','order_date'].includes(f)) v = toISODate(v);
      if (v === '') v = null;
      p.push(v); sets.push(`${f} = $${p.length}`);
    }
    // Concluir um projeto carimba a data. No Excel isso é recortar e colar
    // linhas — e foi assim que 8.906 registros perderam a data de conclusão.
    if (req.body.status === 'COMPLETED' && !('finish_date' in req.body)) {
      sets.push(`finish_date = COALESCE(finish_date, CURRENT_DATE)`);
    }
    if (req.body.status === 'ACTIVE') sets.push(`finish_date = NULL`);
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const actor = actorOf(req);
    p.push(actor); sets.push(`updated_by = $${p.length}`);
    p.push(id);
    const row = await db.tx(async (c) =>
      (await c.query(`UPDATE rapid_inv.projects SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p)).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'projeto não encontrado' });
    res.json(row);
  }));

  // ── Planejamento semanal ────────────────────────────────────────────
  app.get(`${R}/planning`, wrap(async (req, res) => {
    const t0 = Date.now();
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id=1`);
    const horizon = asInt(req.query.weeks, state.horizon_weeks, 4, 156);
    const limit = asInt(req.query.limit, 150, 1, MAX_PAGE);
    const offset = asInt(req.query.offset, 0, 0, 1e6);

    const weeks = await db.query(
      `SELECT week_ending, factor, factor_reason, is_reporting FROM rapid_inv.v_sp_weeks
        WHERE week_ending >= $1 ORDER BY week_ending LIMIT $2`, [state.reporting_week, horizon + 1]);

    const where = ['1=1'], p = [];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`sku ILIKE $${p.length}`); }
    if (req.query.only === 'risk') where.push(`(soh_nonpositive OR mths_stock < 1)`);
    if (req.query.lifecycle) { p.push(req.query.lifecycle); where.push(`lifecycle_status = $${p.length}`); }
    const w = where.join(' AND ');

    const [{ total }] = await db.query(`SELECT count(*)::int total FROM rapid_inv.v_sp_planning_skus WHERE ${w}`, p);
    const skus = await db.query(
      `SELECT * FROM rapid_inv.v_sp_planning_skus WHERE ${w}
        ORDER BY (mths_stock IS NULL), mths_stock NULLS LAST, sku
        LIMIT ${limit} OFFSET ${offset}`, p);

    // Dois SELECTs para o conjunto inteiro. Nada de uma consulta por linha.
    const keys = skus.map((s) => s.sku_key);
    const lastWeek = weeks.length ? weeks[weeks.length - 1].week_ending : state.reporting_week;
    const [draws, incoming] = keys.length ? await Promise.all([
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
    ]) : [[], []];
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);

    const engineWeeks = weeks.map((wk, i) => ({ weekEnding: wk.week_ending, factor: Number(wk.factor), isReporting: i === 0 }));
    const today = weekEnding(new Date());

    const rows = skus.map((s) => {
      const proj = projectSku({
        weeks: engineWeeks,
        soh: Number(s.soh_available),
        wkAvg: s.wk_avg == null ? null : Number(s.wk_avg),
        incoming: inIdx[s.sku_key] || {},
        draws: drawIdx[s.sku_key] || {},
        undatedQty: Number(s.undated_qty || 0),
        targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      });
      return {
        sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code,
        wk_avg: s.wk_avg, target_cover_weeks: s.target_cover_weeks,
        lifecycle_status: s.lifecycle_status, superseded_by: s.superseded_by,
        lifecycle_note: s.lifecycle_note, cin7_status: s.cin7_status, wk_avg_input: s.wk_avg_input,
        soh: Number(s.soh_available), on_order: Number(s.soh_on_order),
        project_orders: Number(s.project_orders), main_soh: Number(s.main_soh),
        gateway_soh: Number(s.gateway_soh), comments: s.comments,
        cells: proj.rows.map((r) => ({
          w: r.weekEnding, o: r.opening, i: r.incoming, s: r.expectedSales,
          d: r.projectDraws, c: r.closing, neg: r.belowZero, low: r.belowTarget,
        })),
        summary: proj.summary,
        alerts: buildAlerts(s.sku, proj, { todayWeek: today }),
      };
    });

    res.json({
      reporting_week: state.reporting_week,
      weeks: weeks.map((w) => ({ ...w, label: shortLabel(w.week_ending) })),
      total, limit, offset, rows, ms: Date.now() - t0,
    });
  }));

  /**
   * O retrovisor. A grade só sabia olhar para frente; o planejador digita um
   * Wk/Avg e não tinha como conferir contra o que de fato saiu.
   *
   * Devolve APENAS realizado — vendido, recebido e consumido por projeto. Não
   * devolve estoque de fechamento do passado de propósito: isso depende de
   * reconstruir a movimentação para trás, e sem medir o erro contra um snapshot
   * real seria número inventado com cara de dado.
   *
   * As semanas vêm de generate_series e não do que a tabela tem, para que uma
   * semana SEM dado apareça como coluna vazia e não desapareça — sumir faria
   * fevereiro parecer colado em março.
   */
  app.get(`${R}/planning/history`, wrap(async (req, res) => {
    const t0 = Date.now();
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id=1`);
    const back = asInt(req.query.back, 8, 1, 52);
    const limit = asInt(req.query.limit, 150, 1, MAX_PAGE);
    const offset = asInt(req.query.offset, 0, 0, 1e6);

    // Os mesmos filtros de /planning, para o conjunto de SKUs bater linha a linha.
    const where = ['1=1'], p = [];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`sku ILIKE $${p.length}`); }
    if (req.query.only === 'risk') where.push(`(soh_nonpositive OR mths_stock < 1)`);
    if (req.query.lifecycle) { p.push(req.query.lifecycle); where.push(`lifecycle_status = $${p.length}`); }

    const [weeks, skus, coverage] = await Promise.all([
      db.query(
        `SELECT gs::date::text AS week_ending
           FROM generate_series($1::date - ($2::int * 7), $1::date - 7, interval '7 days') gs
          ORDER BY 1`, [state.reporting_week, back]),
      db.query(
        `SELECT sku_key FROM rapid_inv.v_sp_planning_skus WHERE ${where.join(' AND ')}
          ORDER BY (mths_stock IS NULL), mths_stock NULLS LAST, sku
          LIMIT ${limit} OFFSET ${offset}`, p),
      db.query(`SELECT * FROM rapid_inv.v_sp_history_coverage`),
    ]);

    const keys = skus.map((s) => s.sku_key);
    const first = weeks.length ? weeks[0].week_ending : state.reporting_week;
    const last = weeks.length ? weeks[weeks.length - 1].week_ending : state.reporting_week;

    // Um SELECT para o conjunto inteiro, não um por linha.
    const hist = keys.length ? await db.query(
      `SELECT sku_key, week_ending::text AS week_ending, sold_qty, recv_qty, proj_qty,
              has_sales, has_recv, has_proj
         FROM rapid_inv.v_sp_history_week
        WHERE sku_key = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, first, last]) : [];

    const idx = {};
    for (const h of hist) (idx[h.sku_key] = idx[h.sku_key] || {})[h.week_ending] = h;

    const rows = keys.map((k) => ({
      sku_key: k,
      cells: weeks.map((w) => {
        const h = idx[k] && idx[k][w.week_ending];
        return h
          ? { w: w.week_ending, sold: Number(h.sold_qty), recv: Number(h.recv_qty),
              proj: Number(h.proj_qty), hs: h.has_sales, hr: h.has_recv, hp: h.has_proj }
          : { w: w.week_ending, sold: 0, recv: 0, proj: 0, hs: false, hr: false, hp: false };
      }),
    }));

    // A fronteira do que sabemos. A tela pinta o que está fora dela como
    // "sem registro", nunca como zero: num controle de estoque, "não vendeu"
    // e "não sabemos" levam a decisões de compra opostas.
    const cov = coverage.reduce((m, c) => {
      m[c.source] = { first_week: c.first_week, last_week: c.last_week, weeks: c.weeks, skus: c.skus };
      return m;
    }, {});

    res.json({
      reporting_week: state.reporting_week,
      weeks: weeks.map((w) => ({ week_ending: w.week_ending, label: shortLabel(w.week_ending) })),
      rows, coverage: cov, ms: Date.now() - t0,
    });
  }));

  /** O drill-down: por que este número. Sem isto o planejador não confia na tela. */
  app.get(`${R}/planning/:sku/week/:week`, wrap(async (req, res) => {
    const key = req.params.sku.toUpperCase();
    const week = req.params.week;
    const [drawDetail, poDetail, sku] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_draw_detail WHERE sku=$1 AND week_ending=$2 ORDER BY qty DESC`, [key, week]),
      db.query(`SELECT * FROM rapid_inv.v_sp_incoming_detail WHERE sku=$1 AND week_ending=$2 ORDER BY qty DESC`, [key, week]),
      db.one(`SELECT * FROM rapid_inv.v_sp_planning_skus WHERE sku_key=$1`, [key]),
    ]);
    const factor = await db.one(`SELECT factor, factor_reason FROM rapid_inv.v_sp_weeks WHERE week_ending=$1`, [week]);
    res.json({
      sku, week, factor: factor ? Number(factor.factor) : 1, factor_reason: factor ? factor.factor_reason : null,
      expected_sales: sku && sku.wk_avg ? Number(sku.wk_avg) * (factor ? Number(factor.factor) : 1) : 0,
      draws: drawDetail, incoming: poDetail,
    });
  }));

  app.patch(`${R}/skus/:sku`, wrap(async (req, res) => {
    const key = req.params.sku.toUpperCase();
    const sets = [], p = [];
    for (const f of ['wk_avg', 'target_cover_weeks', 'comments', 'supplier_code', 'is_planned']) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (v === '') v = null;
      p.push(v); sets.push(`${f} = $${p.length}`);
    }
    if ('wk_avg' in req.body) sets.push(`wk_avg_source = 'MANUAL'`);
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const actor = actorOf(req);
    p.push(actor); sets.push(`updated_by = $${p.length}`);
    p.push(key);
    const row = await db.tx(async (c) =>
      (await c.query(`UPDATE rapid_inv.sku_settings SET ${sets.join(', ')} WHERE sku_key=$${p.length} RETURNING sku`, p)).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'SKU não encontrado' });
    res.json(await db.one(`SELECT * FROM rapid_inv.v_sp_planning_skus WHERE sku_key=$1`, [key]));
  }));

  // ── Ordens de compra ────────────────────────────────────────────────
  app.get(`${R}/pos`, wrap(async (req, res) => {
    const limit = asInt(req.query.limit, 200, 1, MAX_PAGE);
    const where = ['1=1'], p = [];
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`(po_number ILIKE $${p.length} OR sku ILIKE $${p.length} OR vessel ILIKE $${p.length})`); }
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    if (req.query.only === 'open') where.push(`NOT is_received`);
    res.json(await db.query(
      `SELECT id, po_number, line_no, po_date, supplier_code, sku, qty, finish_date, date_checked,
              due_date, require_status, vessel, unit_cost_usd, fx_used, value_usd, value_aud, is_received
         FROM rapid_inv.po_lines WHERE ${where.join(' AND ')}
        ORDER BY due_date NULLS LAST, po_number, line_no LIMIT ${limit}`, p));
  }));

  /** Cria uma PO inteira de uma vez: cabeçalho + linhas coladas. */
  app.post(`${R}/pos`, wrap(async (req, res) => {
    const { po_number, po_date, supplier_code, due_date, vessel, lines } = req.body;
    if (!po_number || !Array.isArray(lines) || !lines.length)
      return res.status(400).json({ error: 'informe po_number e ao menos uma linha' });
    const actor = actorOf(req);
    const fx = await db.one(
      `SELECT aud_per_usd FROM rapid_inv.fx_rates WHERE effective_from <= COALESCE($1::date, CURRENT_DATE)
        ORDER BY effective_from DESC LIMIT 1`, [toISODate(po_date)]);
    const created = await db.tx(async (c) => {
      const [{ next }] = (await c.query(
        `SELECT COALESCE(max(line_no),0) next FROM rapid_inv.po_lines WHERE po_number=$1`, [po_number])).rows;
      const out = [];
      let n = Number(next);
      for (const l of lines) {
        if (!l.sku || !(Number(l.qty) > 0)) continue;
        const cost = l.unit_cost_usd == null ? null : Number(l.unit_cost_usd);
        const usd = cost == null ? null : cost * Number(l.qty);
        out.push((await c.query(
          `INSERT INTO rapid_inv.po_lines
             (po_number,line_no,po_date,supplier_code,sku,qty,due_date,vessel,unit_cost_usd,fx_used,
              value_usd,value_aud,source,updated_by)
           VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10,$11,$12,'MANUAL',$13)
           RETURNING *`,
          [po_number, ++n, toISODate(po_date), supplier_code || null, l.sku, Number(l.qty),
           toISODate(l.due_date || due_date), l.vessel || vessel || null, cost,
           fx ? Number(fx.aud_per_usd) : null, usd,
           usd != null && fx ? usd / Number(fx.aud_per_usd) : null, actor])).rows[0]);
      }
      return out;
    }, actor);
    res.status(201).json({ created: created.length, lines: created });
  }));

  app.patch(`${R}/po-lines/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const sets = [], p = [];
    for (const f of ['qty','due_date','finish_date','date_checked','vessel','supplier_code',
                     'unit_cost_usd','is_received','require_status','sku']) {
      if (!(f in req.body)) continue;
      let v = req.body[f];
      if (['due_date','finish_date','date_checked'].includes(f)) v = toISODate(v);
      if (v === '') v = null;
      p.push(v); sets.push(`${f} = $${p.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    const actor = actorOf(req);
    p.push(actor); sets.push(`updated_by = $${p.length}`);
    p.push(id);
    const row = await db.tx(async (c) =>
      (await c.query(`UPDATE rapid_inv.po_lines SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p)).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'linha de PO não encontrada' });
    res.json(row);
  }));

  // ── Finders ─────────────────────────────────────────────────────────
  app.get(`${R}/find/skus`, wrap(async (req, res) => {
    const q = `%${(req.query.q || '').trim()}%`;
    if (q.length < 4) return res.json([]);
    res.json(await db.query(`
      SELECT p.sku, p.name, p.category, p.brand,
             (s.sku IS NOT NULL) AS in_planning, s.supplier_code, s.wk_avg
        FROM cin7_mirror.products p
        LEFT JOIN rapid_inv.sku_settings s ON s.sku_key = upper(btrim(p.sku))
       WHERE p.sku ILIKE $1 OR p.name ILIKE $1
       ORDER BY (s.sku IS NOT NULL) DESC, p.sku LIMIT 30`, [q]));
  }));

  app.get(`${R}/find/pos`, wrap(async (req, res) => {
    const q = `%${(req.query.q || '').trim()}%`;
    res.json(await db.query(`
      SELECT po_number, min(po_date) AS po_date, min(supplier_code) AS supplier_code,
             count(*)::int lines, sum(qty) AS qty, min(due_date) AS first_due, max(due_date) AS last_due
        FROM rapid_inv.po_lines WHERE po_number ILIKE $1 OR sku ILIKE $1 OR vessel ILIKE $1
       GROUP BY po_number ORDER BY min(po_date) DESC LIMIT 25`, [q]));
  }));

  /**
   * Finder de Sales Order. Lê cin7_mirror, que o app já sincroniza — não é
   * integração nova, e por isso cabe no MVP. Trocar por uma chamada ao vivo
   * na API do Cin7 depois é substituir só esta consulta.
   */
  app.get(`${R}/find/orders`, wrap(async (req, res) => {
    const raw = (req.query.q || '').trim();
    if (raw.length < 3) return res.json([]);
    const q = `%${raw}%`;
    res.json(await db.query(`
      SELECT o.number, o.order_date, o.customer, o.reference, o.status, o.line_count, o.total_qty,
             (SELECT count(*)::int FROM cin7_mirror.sale_lines sl WHERE sl.order_number = o.number) AS mirrored_lines,
             (SELECT p.id FROM rapid_inv.projects p
               WHERE upper(btrim(p.sales_order)) IN (upper(btrim(o.number)), upper(btrim(replace(o.number,'SO-','')))))
               AS existing_project_id
        FROM cin7_mirror.order_pipeline o
       WHERE o.type = 'SO' AND (o.number ILIKE $1 OR o.customer ILIKE $1 OR o.reference ILIKE $1)
       ORDER BY o.order_date DESC LIMIT 25`, [q]));
  }));

  /** Prévia das linhas antes de importar. O usuário confere e só então grava. */
  app.get(`${R}/find/orders/:number/lines`, wrap(async (req, res) => {
    const number = req.params.number;
    res.json(await db.query(`
      SELECT sl.line_no, sl.sku, sl.product_name, sl.quantity, sl.price, sl.backorder_quantity, sl.synced_at,
             (s.sku IS NOT NULL) AS in_planning
        FROM cin7_mirror.sale_lines sl
        LEFT JOIN rapid_inv.sku_settings s ON s.sku_key = upper(btrim(sl.sku))
       WHERE sl.order_number = $1 ORDER BY sl.line_no`, [number]));
  }));

  /** Importa o SO como projeto. Recusa duplicata — o índice único já garante. */
  app.post(`${R}/projects/import-order`, wrap(async (req, res) => {
    const number = (req.body.sales_order || '').trim();
    if (!number) return res.status(400).json({ error: 'informe o número do Sales Order' });
    const actor = actorOf(req);
    const header = await db.one(
      `SELECT * FROM cin7_mirror.order_pipeline WHERE type='SO' AND number = $1`, [number]);
    const lines = await db.query(
      `SELECT * FROM cin7_mirror.sale_lines WHERE order_number = $1 ORDER BY line_no`, [number]);
    if (!lines.length) return res.status(404).json({ error: `sem linhas sincronizadas para ${number}` });

    try {
      const out = await db.tx(async (c) => {
        const project = (await c.query(
          `INSERT INTO rapid_inv.projects (sales_order,order_date,customer,reference,status,source,cin7_sale_id,updated_by)
           VALUES ($1,$2,$3,$4,'ACTIVE','CIN7',$5,$6) RETURNING *`,
          [number, header ? header.order_date : null, header ? header.customer : null,
           header ? header.reference : (req.body.reference || null), lines[0].sale_id, actor])).rows[0];
        let n = 0;
        for (const l of lines) {
          const line = (await c.query(
            `INSERT INTO rapid_inv.project_lines
               (project_id,line_no,date_opened,sku,qty,unit_price,item_desc,source,updated_by)
             VALUES ($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5,$6,$7,'CIN7',$8) RETURNING id, qty_to_pick`,
            [project.id, ++n, header ? header.order_date : null, l.sku, Number(l.quantity),
             l.price, l.product_name, actor])).rows[0];
          // Nasce como um draw sem data. Um pick date inventado seria pior que
          // TBA: metade da demanda real do workbook é legitimamente sem data.
          if (Number(line.qty_to_pick) > 0) {
            await c.query(
              `INSERT INTO rapid_inv.project_draws (line_id,seq,qty,planned_date,source,updated_by)
               VALUES ($1,1,$2,NULL,'CIN7',$3)`, [line.id, Number(line.qty_to_pick), actor]);
          }
        }
        return { project, lines: n };
      }, actor);
      res.status(201).json(out);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: `${number} já foi importado` });
      throw e;
    }
  }));

  // ── Alertas ─────────────────────────────────────────────────────────
  app.get(`${R}/alerts`, wrap(async (req, res) => {
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id=1`);
    const horizon = asInt(req.query.weeks, HORIZON_WEEKS, 4, 156);
    const weeks = await db.query(
      `SELECT week_ending, factor FROM rapid_inv.v_sp_weeks WHERE week_ending >= $1
        ORDER BY week_ending LIMIT $2`, [state.reporting_week, horizon + 1]);
    const where = ['1=1'], p = [];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    const skus = await db.query(`SELECT * FROM rapid_inv.v_sp_planning_skus WHERE ${where.join(' AND ')}`, p);
    const keys = skus.map((s) => s.sku_key);
    const lastWeek = weeks[weeks.length - 1].week_ending;
    const [draws, incoming] = [
      await db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand
                       WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
      await db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming
                       WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
    ];
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);
    const engineWeeks = weeks.map((wk, i) => ({ weekEnding: wk.week_ending, factor: Number(wk.factor), isReporting: i === 0 }));
    const today = weekEnding(new Date());

    // Cada SKU alertado volta com os NÚMEROS que geraram o alerta. Sem isso a
    // tela obriga a sair dela para decidir qualquer coisa — que era o problema.
    const all = [];
    const bySku = new Map();
    for (const s of skus) {
      const proj = projectSku({
        weeks: engineWeeks, soh: Number(s.soh_available),
        wkAvg: s.wk_avg == null ? null : Number(s.wk_avg),
        incoming: inIdx[s.sku_key] || {}, draws: drawIdx[s.sku_key] || {},
        undatedQty: Number(s.undated_qty || 0), targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      });
      const list = buildAlerts(s.sku, proj, { todayWeek: today });
      if (!list.length) continue;
      const facts = {
        sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code,
        soh: Number(s.soh_available), wk_avg: s.wk_avg == null ? null : Number(s.wk_avg),
        target_cover_weeks: s.target_cover_weeks, target_qty: proj.summary.targetQty,
        mths_stock: proj.summary.mthsStock, undated: proj.summary.undatedQty,
        incoming: proj.summary.totalIncoming, draws: proj.summary.totalDraws,
        first_stockout: proj.summary.firstStockoutWeek, weeks_to_stockout: proj.summary.weeksToStockout,
        min_closing: proj.summary.minClosing, closing_at_horizon: proj.summary.closingAtHorizon,
        project_orders: Number(s.project_orders || 0),
        main_soh: Number(s.main_soh || 0), gateway_soh: Number(s.gateway_soh || 0),
        // A primeira semana com PO chegando: é a resposta para "e se eu esperar?"
        next_incoming: (proj.rows.find((r) => r.weekIndex > 0 && r.incoming > 0) || {}).weekEnding || null,
        next_incoming_qty: (proj.rows.find((r) => r.weekIndex > 0 && r.incoming > 0) || {}).incoming || 0,
      };
      bySku.set(s.sku_key, { ...facts, rank: Math.max(...list.map((a) => a.rank)), alerts: list });
      for (const a of list) all.push({ ...a, supplier: s.supplier_code, soh: facts.soh, wk_avg: facts.wk_avg });
    }
    all.sort((a, b) => b.rank - a.rank || a.sku.localeCompare(b.sku));
    const skuList = [...bySku.values()].sort((a, b) =>
      b.rank - a.rank || b.alerts.length - a.alerts.length || (a.weeks_to_stockout ?? 99) - (b.weeks_to_stockout ?? 99));
    const bySeverity = all.reduce((m, a) => { m[a.severity] = (m[a.severity] || 0) + 1; return m; }, {});
    const byCode = all.reduce((m, a) => { m[a.code] = (m[a.code] || 0) + 1; return m; }, {});
    const bySupplier = {};
    for (const s of skuList) {
      const k = s.supplier || '—';
      bySupplier[k] = bySupplier[k] || { supplier: k, skus: 0, alerts: 0, critical: 0, value_at_risk: 0 };
      bySupplier[k].skus++; bySupplier[k].alerts += s.alerts.length;
      bySupplier[k].critical += s.alerts.filter((a) => a.severity === 'CRITICAL').length;
    }
    res.json({
      total: all.length, skus: skuList.length, bySeverity, byCode,
      bySupplier: Object.values(bySupplier).sort((a, b) => b.critical - a.critical || b.skus - a.skus),
      alerts: all.slice(0, asInt(req.query.limit, 400, 1, 2000)),
      skuList: skuList.slice(0, asInt(req.query.limit, 400, 1, 2000)),
    });
  }));

  // ── Auditoria ───────────────────────────────────────────────────────
  app.get(`${R}/audit`, wrap(async (req, res) => {
    const where = [], p = [];
    if (req.query.table) { p.push(req.query.table); where.push(`table_name = $${p.length}`); }
    if (req.query.record) { p.push(String(req.query.record)); where.push(`record_id = $${p.length}`); }
    if (req.query.user) { p.push(req.query.user); where.push(`user_email = $${p.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json(await db.query(
      `SELECT id, table_name, record_id, action, old_value, new_value, user_email, changed_at
         FROM rapid_inv.audit_log ${w} ORDER BY changed_at DESC LIMIT ${asInt(req.query.limit, 100, 1, 500)}`, p));
  }));

  // ── Rolar a semana ──────────────────────────────────────────────────
  /**
   * Substitui o passo que mais corrompe o workbook: mover o marcador "1" da
   * linha 5 uma coluna à direita, em cada uma das 22 abas, e depois colar
   * valores por cima das fórmulas da coluna que virou passado.
   */
  app.post(`${R}/roll-week`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const out = await db.tx(async (c) => {
      const st = (await c.query(`SELECT * FROM rapid_inv.planning_state WHERE id=1 FOR UPDATE`)).rows[0];
      const to = toISODate(req.body.to) || weekEnding(new Date());
      if (to <= st.reporting_week) throw new Error(`a semana de reporte já é ${st.reporting_week}`);
      await c.query(
        `UPDATE rapid_inv.planning_state SET reporting_week=$1, rolled_at=now(), rolled_by=$2, updated_at=now() WHERE id=1`,
        [to, actor]);
      await c.query(
        `INSERT INTO rapid_inv.planning_roll_log (from_week,to_week,rolled_by,notes) VALUES ($1,$2,$3,$4)`,
        [st.reporting_week, to, actor, req.body.notes || null]);
      return { from: st.reporting_week, to };
    }, actor);
    res.json(out);
  }));

  // ── Overview: cinco análises ────────────────────────────────────────
  // Todo o SQL pesado mora em views (db/006). A rota só junta e devolve.
  app.get(`${R}/overview/stock-health`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [totals, matrix, suppliers] = await Promise.all([
      db.one(`SELECT * FROM rapid_inv.v_sp_stock_totals`),
      db.query(`SELECT * FROM rapid_inv.v_sp_stock_health ORDER BY abc, cover_band`),
      db.query(`SELECT * FROM rapid_inv.v_sp_supplier_health ORDER BY excess_value_aud DESC`),
    ]);
    res.json({ totals, matrix, suppliers, ms: Date.now() - t0 });
  }));

  /**
   * Em que semana cada SKU fica negativo. Roda a mesma cascata do motor —
   * não uma aproximação — para que este número e o da grade nunca discordem.
   */
  app.get(`${R}/overview/coverage-risk`, wrap(async (req, res) => {
    const t0 = Date.now();
    const horizon = asInt(req.query.weeks, 13, 4, 52);
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id=1`);
    const weeks = await db.query(
      `SELECT week_ending, factor FROM rapid_inv.v_sp_weeks WHERE week_ending >= $1
        ORDER BY week_ending LIMIT $2`, [state.reporting_week, horizon + 1]);
    const skus = await db.query(`SELECT * FROM rapid_inv.v_sp_planning_skus`);
    const keys = skus.map((s) => s.sku_key);
    const last = weeks[weeks.length - 1].week_ending;
    const [draws, incoming] = await Promise.all([
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, last]),
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, last]),
    ]);
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);
    const engineWeeks = weeks.map((w, i) => ({ weekEnding: w.week_ending, factor: Number(w.factor), isReporting: i === 0 }));

    const buckets = new Map();
    const rows = [];
    for (const s of skus) {
      const p = projectSku({
        weeks: engineWeeks, soh: Number(s.soh_available),
        wkAvg: s.wk_avg == null ? null : Number(s.wk_avg),
        incoming: inIdx[s.sku_key] || {}, draws: drawIdx[s.sku_key] || {},
        undatedQty: Number(s.undated_qty || 0), targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      });
      const wk = p.summary.weeksToStockout;
      const key = wk == null ? 'none' : String(wk);
      buckets.set(key, (buckets.get(key) || 0) + 1);
      if (wk != null) {
        rows.push({
          sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code, week_index: wk,
          week_ending: p.summary.firstStockoutWeek, shortfall: p.summary.minClosing,
          soh: Number(s.soh_available), wk_avg: s.wk_avg,
          incoming: p.summary.totalIncoming, draws: p.summary.totalDraws,
        });
      }
    }
    rows.sort((a, b) => a.week_index - b.week_index || a.shortfall - b.shortfall);
    res.json({
      horizon, reporting_week: state.reporting_week,
      weeks: weeks.slice(1).map((w, i) => ({
        week_ending: w.week_ending, label: shortLabel(w.week_ending),
        skus: buckets.get(String(i + 1)) || 0,
      })),
      safe: buckets.get('none') || 0,
      exposed: rows.length,
      rows: rows.slice(0, asInt(req.query.limit, 300, 1, 2000)),
      ms: Date.now() - t0,
    });
  }));

  app.get(`${R}/overview/inbound`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [byWeek, bySupplier, overdue] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_week ORDER BY week_ending`),
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_supplier ORDER BY value_aud DESC NULLS LAST`),
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_overdue ORDER BY due_date LIMIT 60`),
    ]);
    res.json({ byWeek, bySupplier, overdue, ms: Date.now() - t0 });
  }));

  app.get(`${R}/overview/demand-book`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [byWeek, tba, held, undated] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_demand_week ORDER BY week_ending LIMIT 60`),
      db.query(`SELECT * FROM rapid_inv.v_sp_tba_customer ORDER BY tba_units DESC LIMIT 40`),
      db.query(`SELECT * FROM rapid_inv.v_sp_held_aging ORDER BY band_order`),
      db.one(`SELECT count(*)::int skus, sum(qty)::numeric units FROM rapid_inv.v_sp_undated_demand`),
    ]);
    res.json({ byWeek, tba, held, undated, ms: Date.now() - t0 });
  }));

  app.get(`${R}/overview/demand-signal`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [summary, rows] = await Promise.all([
      db.query(`SELECT verdict, count(*)::int skus, round(sum(stock_value_aud)::numeric,0) value_aud
                  FROM rapid_inv.v_sp_demand_signal GROUP BY 1 ORDER BY 2 DESC`),
      db.query(`SELECT * FROM rapid_inv.v_sp_wkavg_drift
                 WHERE typed > 0 AND reading IS NOT NULL AND reading <> 'in line'
                 ORDER BY abs(gap) DESC NULLS LAST LIMIT $1`, [asInt(req.query.limit, 120, 1, 500)]),
    ]);
    const [age] = await db.query(`
      SELECT count(*) FILTER (WHERE days_since_touched > 180)::int stale_180,
             count(*) FILTER (WHERE days_since_touched > 365)::int stale_365,
             round(avg(days_since_touched))::int avg_days
        FROM rapid_inv.v_sp_wkavg_drift WHERE typed > 0`);
    res.json({ summary, rows, age, window_weeks: 9, ms: Date.now() - t0 });
  }));

  /**
   * Estoque morto: o que a empresa já decidiu parar de vender e ainda tem
   * dinheiro dentro. Substitui o placar do Discontinued Items.xlsx, cujo
   * total está literalmente #N/A hoje por um VLOOKUP quebrado.
   */
  app.get(`${R}/overview/dead-stock`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [totals, rows, conflicts] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_dead_stock_totals ORDER BY 1`),
      db.query(`SELECT * FROM rapid_inv.v_sp_dead_stock
                 WHERE soh_available > 0 ORDER BY stock_value_aud DESC LIMIT $1`,
               [asInt(req.query.limit, 150, 1, 800)]),
      db.query(`SELECT * FROM rapid_inv.v_sp_lifecycle_conflicts ORDER BY conflict, sku LIMIT 100`),
    ]);
    const [supplier] = [await db.query(`
      SELECT supplier_code, count(*)::int skus, sum(soh_available) units,
             round(sum(stock_value_aud)::numeric,0) value_aud
        FROM rapid_inv.v_sp_dead_stock WHERE soh_available > 0 AND supplier_code IS NOT NULL
       GROUP BY 1 ORDER BY value_aud DESC`)];
    res.json({ totals, rows, conflicts, supplier, ms: Date.now() - t0 });
  }));

  app.patch(`${R}/skus/:sku/lifecycle`, wrap(async (req, res) => {
    const key = req.params.sku.toUpperCase();
    const status = String(req.body.lifecycle_status || '').toUpperCase();
    if (!['ACTIVE', 'RUN_OUT', 'DISCONTINUED'].includes(status))
      return res.status(400).json({ error: 'status must be ACTIVE, RUN_OUT or DISCONTINUED' });
    const actor = actorOf(req);
    // MANUAL, sempre: decisão de gente nunca é desfeita pelo sync do Cin7.
    const row = await db.tx(async (c) => (await c.query(
      `UPDATE rapid_inv.sku_settings
          SET lifecycle_status=$1, superseded_by=$2, lifecycle_note=$3,
              lifecycle_source='MANUAL', lifecycle_set_at=now(), lifecycle_set_by=$4
        WHERE sku_key=$5 RETURNING sku`,
      [status, req.body.superseded_by || null, req.body.lifecycle_note || null, actor, key])).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'SKU not found' });
    res.json(await db.one(`SELECT * FROM rapid_inv.v_sp_planning_skus WHERE sku_key=$1`, [key]));
  }));

  /**
   * QUANTO COMPRAR — o passo que o Excel nunca deu.
   *
   * O ritual semanal terminava em "ler Analysis!F, decidir o que recomprar —
   * e calcular a quantidade fora do Excel". Isto é esse fora-do-Excel.
   *
   * A conta, em uma frase: se eu emitir a PO hoje, ela chega na semana
   * lead + review. Entre agora e essa semana mais a cobertura-alvo, qual é o
   * pior ponto do saldo? Compre o suficiente para esse pior ponto ficar no
   * alvo — arredondado para caixa fechada e respeitando o MOQ.
   *
   * Roda a MESMA cascata da grade, de propósito: a sugestão e o número que o
   * planejador vê na tela não podem discordar.
   */
  app.get(`${R}/buy-recommendation`, wrap(async (req, res) => {
    const t0 = Date.now();
    const state = await db.one(`SELECT * FROM rapid_inv.planning_state WHERE id=1`);

    const where = ['s.lifecycle_status = \'ACTIVE\'', 's.wk_avg > 0'], p = [];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`s.supplier_code = $${p.length}`); }
    const skus = await db.query(`
      SELECT s.*, lt.lead_weeks, lt.lead_source, lt.sd_weeks, lt.review_weeks,
             lt.moq_units, lt.carton_qty, v.unit_cost_aud
        FROM rapid_inv.v_sp_planning_skus s
        JOIN rapid_inv.v_sp_sku_leadtime lt ON lt.sku_key = s.sku_key
        LEFT JOIN rapid_inv.v_sp_sku_cost v ON v.sku_key = s.sku_key
       WHERE ${where.join(' AND ')}`, p);
    if (!skus.length) return res.json({ rows: [], total: 0, ms: Date.now() - t0 });

    // O horizonte agora é DECISÃO, não resíduo. Antes ele saía deste max() sobre
    // todos os candidatos, o que dava 28 — e quem fixava esse 28 era um SKU só.
    // Se a mediana de lead daquele fornecedor andasse duas semanas, dentro do
    // desvio dela, 74 SKUs mudariam de segmento sem que nada tivesse mudado
    // neles. Pior: a grade e os alertas usavam 26, e o descasamento produzia 45
    // linhas com aviso de compra ao lado de "not in horizon" em verde.
    const maxWeeks = HORIZON_WEEKS;
    // Quantos SKUs o horizonte NÃO cobre. Vai no payload em vez de alargar a
    // janela em silêncio: aqui, esticar a janela move linhas entre segmentos.
    const uncovered = skus.filter((s) =>
      Number(s.lead_weeks) + Number(s.review_weeks) + Number(s.target_cover_weeks || 0) > maxWeeks).length;
    const weeks = await db.query(
      `SELECT week_ending, factor FROM rapid_inv.v_sp_weeks WHERE week_ending >= $1
        ORDER BY week_ending LIMIT $2`, [state.reporting_week, maxWeeks + 1]);
    const keys = skus.map((s) => s.sku_key);
    const last = weeks[weeks.length - 1].week_ending;
    const [draws, incoming] = await Promise.all([
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, last]),
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, last]),
    ]);
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);
    const engineWeeks = weeks.map((w, i) => ({ weekEnding: w.week_ending, factor: Number(w.factor), isReporting: i === 0 }));

    const rows = [];
    for (const s of skus) {
      const proj = projectSku({
        weeks: engineWeeks, soh: Number(s.soh_available),
        wkAvg: Number(s.wk_avg), incoming: inIdx[s.sku_key] || {}, draws: drawIdx[s.sku_key] || {},
        undatedQty: Number(s.undated_qty || 0), targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      });
      const lead = Number(s.lead_weeks), review = Number(s.review_weeks);
      const arrival = Math.ceil(lead + review);
      const coverUntil = Math.min(arrival + Number(s.target_cover_weeks || 0), proj.rows.length - 1);
      const window = proj.rows.slice(1, coverUntil + 1);
      if (!window.length) continue;

      let low = window[0];
      for (const r of window) if (r.closing < low.closing) low = r;
      const target = Number(proj.summary.targetQty || 0);
      const rawNeed = Math.max(0, target - low.closing);
      if (rawNeed <= 0) continue;

      // Caixa fechada e MOQ não são refinamento: sem eles o comprador corrige
      // à mão, e a partir daí para de confiar no número.
      const carton = Number(s.carton_qty) > 0 ? Number(s.carton_qty) : 1;
      const cartons = Math.ceil(rawNeed / carton);
      let suggested = cartons * carton;
      const moq = Number(s.moq_units) || 0;
      let moqApplied = false;
      if (moq > 0 && suggested < moq) { suggested = Math.ceil(moq / carton) * carton; moqApplied = true; }

      // Quando pedir: a semana em que o saldo cruza o alvo, menos o lead time.
      const cross = proj.rows.findIndex((r, i) => i > 0 && r.closing < target);
      const orderByWeek = cross > 0 ? proj.rows[Math.max(0, cross - arrival)].weekEnding : proj.rows[0].weekEnding;
      // `<= 0` acusava também quem tem de pedir exatamente esta semana: seis
      // linhas em dia marcadas como atrasadas. O certo é `< 0`.
      const late = cross > 0 && cross - arrival < 0;
      // Só para o title. NÃO vira coluna nem critério de ordenação: 42% das
      // linhas imprimiriam o mesmo "15", porque o número descreve o lead do
      // fornecedor e não o SKU.
      const weeksLate = late ? arrival - cross : 0;

      rows.push({
        sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code,
        soh: Number(s.soh_available), on_order: Number(s.soh_on_order),
        wk_avg: Number(s.wk_avg), target_cover_weeks: s.target_cover_weeks, target_qty: target,
        weeks_late: weeksLate,
        lead_weeks: lead, lead_source: s.lead_source, sd_weeks: s.sd_weeks == null ? null : Number(s.sd_weeks),
        arrival_week_index: arrival, cover_until_index: coverUntil,
        low_point: low.closing, low_week: low.weekEnding,
        raw_need: Math.round(rawNeed), carton_qty: carton, cartons, moq_applied: moqApplied,
        suggested,
        value_aud: s.unit_cost_aud ? Math.round(suggested * Number(s.unit_cost_aud)) : null,
        order_by_week: orderByWeek, already_late: late,
        first_stockout: proj.summary.firstStockoutWeek,
      });
    }
    rows.sort((a, b) => (a.already_late === b.already_late ? 0 : a.already_late ? -1 : 1)
                     || a.order_by_week.localeCompare(b.order_by_week)
                     || (b.value_aud || 0) - (a.value_aud || 0));

    const bySupplier = {};
    for (const r of rows) {
      const k = r.supplier || '—';
      bySupplier[k] = bySupplier[k] || { supplier: k, skus: 0, units: 0, value_aud: 0, late: 0 };
      bySupplier[k].skus++; bySupplier[k].units += r.suggested;
      bySupplier[k].value_aud += r.value_aud || 0;
      if (r.already_late) bySupplier[k].late++;
    }
    res.json({
      reporting_week: state.reporting_week, horizon_weeks: maxWeeks, uncovered_skus: uncovered,
      total: rows.length,
      total_units: rows.reduce((n, r) => n + r.suggested, 0),
      total_value_aud: rows.reduce((n, r) => n + (r.value_aud || 0), 0),
      late: rows.filter((r) => r.already_late).length,
      bySupplier: Object.values(bySupplier).sort((a, b) => b.value_aud - a.value_aud),
      rows: rows.slice(0, asInt(req.query.limit, 300, 1, 2000)),
      ms: Date.now() - t0,
    });
  }));

  app.get(`${R}/leadtime`, wrap(async (req, res) => {
    res.json(await db.query(
      `SELECT * FROM rapid_inv.v_sp_supplier_leadtime ORDER BY median_weeks DESC NULLS LAST`));
  }));

  // ── Filiais e alocação de linha de PO ───────────────────────────────
  app.get(`${R}/branches`, wrap(async (req, res) => {
    res.json(await db.query(`SELECT * FROM rapid_inv.v_sp_branches`));
  }));

  app.get(`${R}/po-lines/:id/allocations`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const [summary, rows] = await Promise.all([
      db.one(`SELECT * FROM rapid_inv.v_sp_po_allocation WHERE po_line_id = $1`, [id]),
      db.query(`SELECT a.*, w.name AS branch_name FROM rapid_inv.po_line_allocations a
                  JOIN rapid_inv.warehouses w ON w.code = a.branch_code
                 WHERE a.po_line_id = $1 ORDER BY w.sort_order, a.seq`, [id]),
    ]);
    if (!summary) return res.status(404).json({ error: 'PO line not found' });
    res.json({ ...summary, allocations: rows });
  }));

  /**
   * Grava a alocação inteira de uma vez: o que a tela mostra é o que fica.
   * Alocar mais que a linha AVISA e não trava — mesma disciplina dos draws.
   * O saldo não alocado fica com o MAIN, e isso aparece como linha na view,
   * para que a soma por filial seja sempre igual ao total da linha.
   */
  app.put(`${R}/po-lines/:id/allocations`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const items = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    const actor = actorOf(req);
    const out = await db.tx(async (c) => {
      const line = (await c.query(`SELECT id, qty FROM rapid_inv.po_lines WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!line) return null;
      await c.query(`DELETE FROM rapid_inv.po_line_allocations WHERE po_line_id = $1`, [id]);
      let seq = 0;
      for (const a of items) {
        const qty = Number(a.qty);
        if (!(qty > 0) || !a.branch_code) continue;
        await c.query(
          `INSERT INTO rapid_inv.po_line_allocations
             (po_line_id, seq, branch_code, qty, eta_date, note, source, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'MANUAL',$7)`,
          [id, ++seq, a.branch_code, qty, toISODate(a.eta_date), a.note || null, actor]);
      }
      return true;
    }, actor);
    if (!out) return res.status(404).json({ error: 'PO line not found' });
    const summary = await db.one(`SELECT * FROM rapid_inv.v_sp_po_allocation WHERE po_line_id = $1`, [id]);
    const rows = await db.query(
      `SELECT a.*, w.name AS branch_name FROM rapid_inv.po_line_allocations a
         JOIN rapid_inv.warehouses w ON w.code = a.branch_code
        WHERE a.po_line_id = $1 ORDER BY w.sort_order, a.seq`, [id]);
    res.json({ ...summary, allocations: rows });
  }));

  app.get(`${R}/incoming-by-branch`, wrap(async (req, res) => {
    const where = [], p = [];
    if (req.query.sku) { p.push(req.query.sku.toUpperCase()); where.push(`sku = $${p.length}`); }
    if (req.query.branch) { p.push(req.query.branch); where.push(`branch_code = $${p.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    res.json(await db.query(
      `SELECT * FROM rapid_inv.v_sp_incoming_branch ${w} ORDER BY week_ending, branch_code LIMIT 2000`, p));
  }));

  console.log('✅ Stock Planning routes montadas em /api/stock-planning');
}

module.exports = { register };
