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
    const horizon = asInt(req.query.weeks, 26, 4, 156);
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
      db.query(`SELECT * FROM rapid_inv.v_sp_demand_signal
                 WHERE wk_avg > 0 AND verdict IS NOT NULL AND verdict <> 'in line'
                 ORDER BY abs(bias_units) DESC NULLS LAST LIMIT $1`, [asInt(req.query.limit, 120, 1, 500)]),
    ]);
    res.json({ summary, rows, window_weeks: 9, ms: Date.now() - t0 });
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
