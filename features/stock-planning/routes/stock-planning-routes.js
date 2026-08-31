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
/* A aba de contêiner é a exceção deliberada ao MAX_PAGE: ela não pagina, ela
   PLANEJA — o usuário arrasta linhas para dentro de um navio, e um livro
   cortado em 500 de 1.466 produz um plano que não cabe na realidade. Constante
   própria de propósito: subir o MAX_PAGE compartilhado mudaria de uma vez o
   teto de todas as rotas paginadas, que é outra decisão. */
const MAX_CONTAINER_LINES = 3000;

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

/**
 * O selo de status da linha.
 *
 * A tentação é renderizar a severidade que já viaja no payload. Medido, isso
 * daria CRITICAL em 145 de 300 linhas: 48% da grade em vermelho, e vermelho que
 * aparece em metade das linhas não ordena mais nada. Pior, dos 51 SKUs com
 * SOH<=0 e Wk/Avg>0 do CGD, 50 nunca venderam uma unidade — o vermelho de hoje
 * aponta, na quase totalidade da massa, para demanda que nunca existiu.
 *
 * A régua também não pode ser `soh + project_orders + incoming_no_lead`:
 * `projectOrders` NUNCA entra na cascata do motor (planning-engine.js:55-108),
 * então somá-lo a uma posição derivada das células conta a mesma obrigação duas
 * vezes — 109.021 unidades, e 120 de 201 "críticos" sem ruptura alguma.
 *
 * O instrumento certo é a cascata que a tela já desenha. Ela é sensível ao
 * tempo (um PO que chega na semana 15 não vira prateleira hoje) e não duplica
 * nada. Onde a taxa manual diverge da venda medida, roda-se a MESMA cascata com
 * a taxa realizada — sem fórmula nova, sem outro instrumento.
 */
function badgeFor(s, proj, alerts, ctx) {
  const wkAvg = Number(s.wk_avg) || 0;
  const sold13 = Number(ctx.sold && ctx.sold.sold13) || 0;
  const sold52 = Number(ctx.sold && ctx.sold.sold52) || 0;
  const lw = ctx.lead ? Number(ctx.lead.lead_weeks) : null;
  const rw = ctx.lead ? Number(ctx.lead.review_weeks) : null;
  // Sem lead medido não há janela de pedido: cai no horizonte compartilhado.
  const thr = lw == null ? HORIZON_WEEKS : Math.ceil(lw + (rw || 0));

  // Venda realizada manda. O Wk/Avg só é piso para item VIVO: em RUN_OUT e
  // DISCONTINUED, preservar o número digitado ressuscitava 11 falsos críticos.
  const rate = sold13 > 0
    ? (s.lifecycle_status === 'ACTIVE' ? Math.max(wkAvg, sold13 / 13) : sold13 / 13)
    : wkAvg;

  // A cascata-sombra: só roda quando a taxa diverge do que a grade desenhou.
  // Sempre reprojeta na régua do selo. Reaproveitar proj.summary faria o selo
  // herdar o dropdown da tela: sete selos mudavam entre 12 e 26 semanas.
  const horizon = Math.max(HORIZON_WEEKS, thr);
  const wts = projectSku({
        weeks: ctx.badgeWeeks,
        soh: Number(s.soh_available), wkAvg: rate,
        incoming: ctx.incoming, draws: ctx.draws,
        undatedQty: Number(s.undated_qty || 0),
        targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      }).summary.weeksToStockout;

  // /buy-recommendation exige ACTIVE + wk_avg>0. Fora disso a Buy nunca
  // dimensiona o pedido: a ação é corrigir o cadastro, não emitir ordem.
  const semRota = !(s.lifecycle_status === 'ACTIVE' && wkAvg > 0);
  const inbound = Number(s.soh_on_order) > 0
               || alerts.some((a) => a.code === 'PO_AFTER_STOCKOUT');

  let badge = null;
  if (sold13 > 0 && wts != null && wts <= thr) {
    badge = semRota ? 'NO FORECAST' : inbound ? 'CHASE PO' : 'ORDER NOW';
  } else if (sold13 > 0 && wts != null && wts <= horizon) {
    badge = 'ORDER SOON';
  } else if (sold13 === 0 && wkAvg > 0 && s.lifecycle_status === 'ACTIVE') {
    // Só para item VIVO. Em RUN_OUT e DISCONTINUED, não vender é o comportamento
    // esperado — não erro de cadastro. Sem esta guarda o selo aparecia em 88 de
    // 300 linhas do CGD, quase todas o mesmo bloco de run-out com o Wk/Avg 42 de
    // enchimento, e dominava a tela mais que os dois casos urgentes do topo.
    badge = 'FIX FORECAST';
  }
  // Quando a taxa medida diverge da digitada, a cascata-sombra vê ruptura onde
  // a grade não vê — 115 linhas medidas, e em TODAS o selo está certo e a grade
  // é que está cega (86 com Wk/Avg zerado vendendo de verdade, 29 vendendo
  // várias vezes o digitado). Contradição sem explicação destrói a confiança na
  // tela; por isso a linha carrega o motivo e a UI aponta para a célula que
  // causa a divergência, que é onde está o conserto.
  const drift = sold13 > 0 && (wkAvg === 0 || rate >= wkAvg * 1.5);
  const why = !badge ? null
    : wkAvg === 0 && sold13 > 0
      ? `Wk/Avg está em branco e este SKU vendeu ${Math.round(sold13)} un em 13 semanas (${(sold13 / 13).toFixed(1)}/sem). A projeção acima usa o Wk/Avg, por isso não mostra ruptura.`
    : drift
      ? `Wk/Avg digitado é ${wkAvg}; a venda medida é ${(sold13 / 13).toFixed(1)}/sem. O selo usa a medida, a projeção acima usa a digitada.`
      : null;

  // SKU mudo (sem venda e sem previsão) fica sem selo de propósito: carimbar
  // "sem demanda" nele marcaria 30,7% da grade e erraria justamente nos que o
  // selo existe para achar.
  return { badge, badge_why: why, badge_drift: drift, sold13, sold52,
           badge_rate: rate, badge_wts: wts, lead_weeks: lw };
}


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
    // A filial do projeto não é coluna: sai de v_sp_project_branch, que a
    // deriva do pedido quando existe e do rep quando não. O IN por subconsulta
    // evita juntar a view e multiplicar a linha.
    if (req.query.branch) add(
      `project_id IN (SELECT project_id FROM rapid_inv.v_sp_project_branch WHERE branch_code = ?)`,
      req.query.branch.toUpperCase());
    if (req.query.branch === '__none')
      where.push(`project_id IN (SELECT project_id FROM rapid_inv.v_sp_project_branch WHERE branch_code IS NULL)`);

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
    // A filial e — igualmente importante — DE ONDE ela veio. 1.468 das 1.667
    // são inferidas do rep, e mostrar isso como se fosse o pedido seria vender
    // palpite como dado.
    const pids = [...new Set(rows.map((r) => r.project_id).filter(Boolean))];
    const br = pids.length ? await db.query(
      `SELECT project_id, branch_code, branch_source FROM rapid_inv.v_sp_project_branch
        WHERE project_id = ANY($1)`, [pids]) : [];
    const brIdx = br.reduce((m, b) => (m[b.project_id] = b, m), {});
    res.json({ total, limit, offset, rows: rows.map((r) => ({
      ...r, draws: byLine[r.id] || [],
      branch_code: (brIdx[r.project_id] || {}).branch_code || null,
      branch_source: (brIdx[r.project_id] || {}).branch_source || null,
    })) });
  }));

  app.get(`${R}/filters`, wrap(async (req, res) => {
    const [reps, customers] = await Promise.all([
      db.query(`SELECT DISTINCT rep FROM rapid_inv.projects WHERE rep IS NOT NULL ORDER BY 1`),
      db.query(`SELECT customer, count(*)::int n FROM rapid_inv.projects
                 WHERE customer IS NOT NULL AND status='ACTIVE' GROUP BY 1 ORDER BY 2 DESC LIMIT 200`),
    ]);
    const branches = await db.query(
      `SELECT b.branch_code, w.name, count(*)::int n
         FROM rapid_inv.v_sp_project_branch b
         JOIN rapid_inv.projects p ON p.id = b.project_id AND p.status = 'ACTIVE'
         LEFT JOIN rapid_inv.warehouses w ON w.code = b.branch_code
        WHERE b.branch_code IS NOT NULL
        GROUP BY 1, 2 ORDER BY 3 DESC`);
    // As linhas de produto, contadas DENTRO do arquivo de planejamento — a
    // contagem do catálogo inteiro faria o usuário escolher uma linha de 3.094
    // e receber 513.
    const lines = await db.query(
      `SELECT p.category AS line, count(*)::int n
         FROM rapid_inv.v_sp_planning_skus v
         JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = v.sku_key
        WHERE p.category IS NOT NULL AND btrim(p.category) <> ''
        GROUP BY 1 ORDER BY 2 DESC`);
    res.json({ reps: reps.map((r) => r.rep), customers: customers.map((c) => c.customer), branches, lines });
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

  /* ── ESCOPO DA PREVISÃO ──────────────────────────────────────────────
     Para quem esta projeção está sendo feita. O padrão ('') é o de sempre: a
     média digitada no arquivo de planejamento e o estoque somado — a régua de
     compra. Os outros trocam DUAS coisas ao mesmo tempo, e trocar só uma seria
     pior que não trocar nenhuma: a demanda daquele conjunto e o estoque dele.

     'Sydney network' são as filiais que o eixo de Sydney atende. Coffs sai à
     parte porque fica no meio do caminho para Brisbane e a resposta muda:
     medido em 6 meses, a rede de Sydney vende 124.689 e com Coffs vai a
     159.792 — 28% a mais decidindo sobre o mesmo estoque. */
  const SCOPES = {
    MAIN:          { label: 'Main Warehouse',        codes: ['MAIN'] },
    SYD:           { label: 'Sydney',                codes: ['SYD'] },
    BNE:           { label: 'Brisbane',              codes: ['BNE'] },
    MEL:           { label: 'Melbourne',             codes: ['MEL'] },
    CNS:           { label: 'Cairns',                codes: ['CNS'] },
    CFS:           { label: 'Coffs Harbour',         codes: ['CFS'] },
    HBA:           { label: 'Hobart',                codes: ['HBA'] },
    SCS:           { label: 'Sunshine Coast',        codes: ['SCS'] },
    'SYD-NET':     { label: 'Sydney network',        codes: ['SYD', 'MEL', 'HBA'] },
    'SYD-NET-CFS': { label: 'Sydney network + Coffs', codes: ['SYD', 'MEL', 'HBA', 'CFS'] },
    NETWORK:       { label: 'Every branch',          codes: ['SYD', 'BNE', 'MEL', 'CNS', 'CFS', 'HBA', 'SCS'] },
  };

  /** Demanda e estoque de um conjunto de filiais, para os SKUs pedidos. */
  async function scopeFacts(codes, keys, months) {
    const win = `order_date >= (date_trunc('month',
                   (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                 - ($3::int - 1) * interval '1 month')`;
    const [dem, stk] = await Promise.all([
      // A linha conta se o LOCAL é da filial OU o REP é dela. É união de
      // linhas, não soma de dois totais: somar contaria duas vezes toda venda
      // em que o rep da filial vendeu do próprio depósito.
      db.query(`SELECT sku_key, sum(qty_signed)::numeric qty,
                       count(*) FILTER (WHERE location_branch = ANY($2))::int by_loc,
                       -- IS DISTINCT FROM ANY nao existe: ANY e comparador,
                       -- nao conjunto. O certo e <> ALL, e o coalesce importa
                       -- porque location_branch e NULL em toda venda de
                       -- "Project Warehouse" -- sem ele a linha sumia dos dois
                       -- lados da conta.
                       count(*) FILTER (WHERE coalesce(location_branch, '') <> ALL($2)
                                          AND rep_branch = ANY($2))::int by_rep
                  FROM rapid_inv.v_sp_demand_scope
                 WHERE sku_key = ANY($1) AND ${win}
                   AND (location_branch = ANY($2) OR rep_branch = ANY($2))
                 GROUP BY 1`, [keys, codes, months]),
      db.query(`SELECT upper(btrim(s.sku)) k, sum(s.available)::numeric qty
                  FROM cin7_mirror.stock_snapshot s
                  JOIN rapid_inv.warehouses w ON w.cin7_location_name = s.location_name
                 WHERE upper(btrim(s.sku)) = ANY($1) AND w.code = ANY($2)
                 GROUP BY 1`, [keys, codes]),
    ]);
    const weeksInWindow = (months * 52) / 12;
    return {
      demand: dem.reduce((m, r) => (m[r.sku_key] = {
        wk: Number(r.qty) / weeksInWindow, by_loc: r.by_loc, by_rep: r.by_rep }, m), {}),
      stock: stk.reduce((m, r) => (m[r.k] = Number(r.qty), m), {}),
    };
  }

  /* De onde vem a média deste SKU, filial por filial.
     A tela mostra um número por semana e o planejador tem que confiar nele. A
     pergunta que ele faz antes de confiar é sempre a mesma — "isso é venda de
     quem?" — e sem resposta ele volta para a planilha. Sai a conta pelos DOIS
     caminhos, porque a diferença entre eles é a informação: onde a venda por
     rep é muito maior que a por local, aquela filial está sendo atendida do
     Main e a conta por local a subestima. */
  app.get(`${R}/planning/:sku/demand`, wrap(async (req, res) => {
    const key = String(req.params.sku || '').trim().toUpperCase();
    const months = asInt(req.query.months, 6, 1, 13);
    const win = `order_date >= (date_trunc('month',
                   (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                 - ($2::int - 1) * interval '1 month')`;
    const rows = await db.query(
      `SELECT coalesce(w.code, b.branch_code) AS code, w.name,
              sum(d.qty_signed) FILTER (WHERE d.location_branch = coalesce(w.code, b.branch_code))::numeric AS by_loc,
              sum(d.qty_signed) FILTER (WHERE coalesce(d.location_branch,'') <> coalesce(w.code, b.branch_code)
                                          AND d.rep_branch = coalesce(w.code, b.branch_code))::numeric AS by_rep,
              count(DISTINCT d.sales_rep) FILTER (WHERE d.rep_branch = coalesce(w.code, b.branch_code))::int AS reps
         FROM rapid_inv.v_sp_demand_scope d
         -- DISTINCT, e nao e detalhe: quando o local e o rep sao a MESMA
         -- filial -- que e o caso comum -- o unnest devolvia a filial duas
         -- vezes e a quantidade entrava dobrada. O SKU R2353-WW aparecia com
         -- 365 contra 288 de venda real, e nada na tela denunciava.
         CROSS JOIN LATERAL (SELECT DISTINCT unnest(ARRAY[d.location_branch, d.rep_branch]) AS branch_code) b
         LEFT JOIN rapid_inv.warehouses w ON w.code = b.branch_code
        WHERE d.sku_key = $1 AND ${win} AND b.branch_code IS NOT NULL
        GROUP BY 1, 2`, [key, months]);
    // O que não caiu em filial nenhuma. Some se não for dito: são as vendas de
    // "Project Warehouse" e as de rep sem alocação, e elas existem.
    const [orfas] = await db.query(
      `SELECT sum(qty_signed)::numeric qty, count(*)::int linhas
         FROM rapid_inv.v_sp_demand_scope
        WHERE sku_key = $1 AND ${win}
          AND location_branch IS NULL AND rep_branch IS NULL`, [key, months]);
    // O total de verdade. As linhas por filial ainda podem somar mais que ele
    // de forma legitima: uma venda cujo rep e de Sydney e cujo deposito e o
    // Main pertence as duas, e e essa sobreposicao que interessa ver.
    const [tudo] = await db.query(
      `SELECT sum(qty_signed)::numeric qty FROM rapid_inv.v_sp_demand_scope
        WHERE sku_key = $1 AND ${win}`, [key, months]);
    const weeks = (months * 52) / 12;
    res.json({
      sku_key: key, months, weeks,
      total: Number(tudo.qty || 0),
      rows: rows.map((r) => ({
        code: r.code, name: r.name,
        by_loc: Number(r.by_loc || 0), by_rep: Number(r.by_rep || 0),
        total: Number(r.by_loc || 0) + Number(r.by_rep || 0),
        wk: (Number(r.by_loc || 0) + Number(r.by_rep || 0)) / weeks,
        reps: r.reps,
      })).filter((r) => r.total !== 0).sort((a, b) => b.total - a.total),
      unassigned: { qty: Number(orfas.qty || 0), lines: orfas.linhas },
    });
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
        WHERE week_ending >= $1 ORDER BY week_ending LIMIT $2`,
      // Busca o maior entre o horizonte pedido e o do selo: o selo NÃO pode
      // mudar porque o usuário trocou o dropdown de 26 para 12 semanas.
      [state.reporting_week, Math.max(horizon, HORIZON_WEEKS) + 1]);

    const where = ['1=1'], p = [];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`sku ILIKE $${p.length}`); }
    if (req.query.only === 'risk') where.push(`(soh_nonpositive OR mths_stock < 1)`);
    if (req.query.lifecycle) { p.push(req.query.lifecycle); where.push(`lifecycle_status = $${p.length}`); }
    /* Os modos de visão. Cada um é uma pergunta inteira que hoje exige varrer
       a lista à mão, e o número ao lado é o que ele devolve hoje:

         bom       montados, com os componentes por baixo            225
         coming    tem PO a caminho — é onde "esperar" é resposta    599
         special   sem média: o motor não projeta, e some da conta   647
         project   tem demanda de projeto presa                      261

       'special' importa mais do que parece: 647 dos 1.951 não têm média, e em
       toda tela ordenada por risco eles caem para o fim porque mths_stock é
       NULL. Sem um modo que os isole, um terço do arquivo é invisível. */
    const VIEWS = {
      bom:     `EXISTS (SELECT 1 FROM rapid_inv.product_bom b WHERE b.parent_key = sku_key)`,
      coming:  `soh_on_order > 0`,
      special: `coalesce(wk_avg, 0) = 0`,
      project: `(project_orders > 0 OR undated_qty > 0)`,
    };
    if (VIEWS[req.query.view]) where.push(VIEWS[req.query.view]);
    // A linha de produto vem do Cin7 e não está na view de planejamento.
    if (req.query.line) {
      p.push(req.query.line);
      where.push(`sku_key IN (SELECT upper(btrim(sku)) FROM cin7_mirror.products WHERE category = $${p.length})`);
    }
    const w = where.join(' AND ');

    const [{ total }] = await db.query(`SELECT count(*)::int total FROM rapid_inv.v_sp_planning_skus WHERE ${w}`, p);
    const skus = await db.query(
      `SELECT * FROM rapid_inv.v_sp_planning_skus WHERE ${w}
        ORDER BY (mths_stock IS NULL), mths_stock NULLS LAST, sku
        LIMIT ${limit} OFFSET ${offset}`, p);

    // Dois SELECTs para o conjunto inteiro. Nada de uma consulta por linha.
    const keys = skus.map((s) => s.sku_key);
    const lastWeek = weeks.length ? weeks[weeks.length - 1].week_ending : state.reporting_week;
    const [draws, incoming, sold, lead] = keys.length ? await Promise.all([
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_draw_demand
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
      db.query(`SELECT sku, week_ending, qty FROM rapid_inv.v_sp_incoming
                 WHERE sku = ANY($1) AND week_ending BETWEEN $2 AND $3`, [keys, state.reporting_week, lastWeek]),
      // Venda REALIZADA. O selo não pode confiar só no Wk/Avg, que é entrada
      // manual do planejador: 27 SKUs sem uma venda em 52 semanas recebiam
      // sugestão de compra por causa de um número digitado numa célula.
      db.query(`SELECT sku_key,
                       sum(sold_qty) FILTER (WHERE week_ending > $2::date - 91) AS sold13,
                       sum(sold_qty) AS sold52
                  FROM rapid_inv.v_sp_history_week
                 WHERE sku_key = ANY($1) AND week_ending > $2::date - 364
                 GROUP BY 1`, [keys, state.reporting_week]),
      db.query(`SELECT sku_key, lead_weeks, review_weeks FROM rapid_inv.v_sp_sku_leadtime
                 WHERE sku_key = ANY($1)`, [keys]),
    ]) : [[], [], [], []];
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);

    // O escopo, quando pedido. Fora dele nada muda: a régua padrão continua
    // sendo a média digitada e o estoque somado.
    const scopeKey = String(req.query.scope || '').toUpperCase();
    const scope = SCOPES[scopeKey] || null;
    const scopeMonths = asInt(req.query.scope_months, 6, 1, 13);
    const sf = (scope && keys.length) ? await scopeFacts(scope.codes, keys, scopeMonths) : null;
    const soldIdx = sold.reduce((m, r) => (m[r.sku_key] = r, m), {});
    const leadIdx = lead.reduce((m, r) => (m[r.sku_key] = r, m), {});

    const allWeeks = weeks.map((wk, i) => ({ weekEnding: wk.week_ending, factor: Number(wk.factor), isReporting: i === 0 }));
    // A grade desenha o que o usuário pediu; o selo julga sempre na mesma régua.
    const engineWeeks = allWeeks.slice(0, horizon + 1);
    const badgeWeeks = allWeeks.slice(0, HORIZON_WEEKS + 1);
    const today = weekEnding(new Date());

    const rows = skus.map((s) => {
      // Dentro de um escopo a régua é a venda MEDIDA daquele conjunto, não a
      // média digitada — que é do arquivo inteiro e não sabe de filial.
      const sd = sf ? sf.demand[s.sku_key] : null;
      const sqty = sf ? (sf.stock[s.sku_key] || 0) : null;
      const proj = projectSku({
        weeks: engineWeeks,
        soh: sf ? sqty : Number(s.soh_available),
        wkAvg: sf ? (sd ? sd.wk : 0)
                  : (s.wk_avg == null ? null : Number(s.wk_avg)),
        incoming: inIdx[s.sku_key] || {},
        draws: drawIdx[s.sku_key] || {},
        undatedQty: Number(s.undated_qty || 0),
        targetCoverWeeks: s.target_cover_weeks || 7,
        projectOrders: Number(s.project_orders || 0),
      });
      const alerts = buildAlerts(s.sku, proj, { todayWeek: today });
      return {
        sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code,
        wk_avg: s.wk_avg, target_cover_weeks: s.target_cover_weeks,
        lifecycle_status: s.lifecycle_status, superseded_by: s.superseded_by,
        lifecycle_note: s.lifecycle_note, cin7_status: s.cin7_status, wk_avg_input: s.wk_avg_input,
        // A política do Master Stock viaja com a linha. O planejador precisa
        // ver que este SKU está fora da reposição de filial ANTES de decidir
        // comprar para ela.
        use_in_replenishment: s.use_in_replenishment !== false,
        policy_flag: s.policy_flag || null, policy_note: s.policy_note || null,
        soh: sf ? sqty : Number(s.soh_available), on_order: Number(s.soh_on_order),
        // O que o escopo trocou, dito por linha — para a tela poder mostrar o
        // número do arquivo ao lado e o planejador ver a diferença.
        ...(sf ? {
          scope_wk: sd ? Math.round(sd.wk * 100) / 100 : 0,
          scope_soh: sqty,
          scope_by_loc: sd ? sd.by_loc : 0,
          scope_by_rep: sd ? sd.by_rep : 0,
          file_wk: s.wk_avg == null ? null : Number(s.wk_avg),
          file_soh: Number(s.soh_available),
        } : {}),
        project_orders: Number(s.project_orders), main_soh: Number(s.main_soh),
        gateway_soh: Number(s.gateway_soh), comments: s.comments,
        cells: proj.rows.map((r) => ({
          w: r.weekEnding, o: r.opening, i: r.incoming, s: r.expectedSales,
          d: r.projectDraws, c: r.closing, neg: r.belowZero, low: r.belowTarget,
        })),
        summary: proj.summary,
        alerts,
        ...badgeFor(s, proj, alerts, {
          sold: soldIdx[s.sku_key], lead: leadIdx[s.sku_key],
          badgeWeeks, incoming: inIdx[s.sku_key] || {}, draws: drawIdx[s.sku_key] || {},
        }),
      };
    });

    // Ordenar por risco só é possível AQUI: o selo nasce em Node, depois da
    // cascata, então nenhum ORDER BY do SQL alcança. Sem isso, a mediana de
    // posição das linhas vermelhas era 211 de 300 — o selo existia e ninguém via.
    if (req.query.sort === 'risk') {
      const RANK = { 'ORDER NOW': 5, 'CHASE PO': 4, 'NO FORECAST': 3, 'ORDER SOON': 2, 'FIX FORECAST': 1 };
      rows.sort((a, b) => (RANK[b.badge] || 0) - (RANK[a.badge] || 0)
        || (a.badge_wts ?? 999) - (b.badge_wts ?? 999)
        || a.sku.localeCompare(b.sku));
    }
    // Os componentes vêm no MESMO payload, em um SELECT para o conjunto todo.
    // Buscar por linha seria N+1 numa tela que abre 300 linhas de uma vez.
    // Vêm sempre, não só no modo BOM: um produto montado no meio da lista geral
    // também precisa dizer que é montado.
    const bom = keys.length ? await db.query(
      `SELECT parent_key, component_sku, component_name, quantity, comp_soh, comp_main,
              can_build_main, comp_lifecycle, comp_main_negative
         FROM rapid_inv.v_bom_expanded WHERE parent_key = ANY($1) ORDER BY parent_key, component_sku`,
      [keys]) : [];
    const bomIdx = bom.reduce((m, b) => ((m[b.parent_key] = m[b.parent_key] || []).push(b), m), {});
    const cats = keys.length ? await db.query(
      `SELECT upper(btrim(sku)) k, category FROM cin7_mirror.products
        WHERE upper(btrim(sku)) = ANY($1) AND category IS NOT NULL`, [keys]) : [];
    const catIdx = cats.reduce((m, c) => (m[c.k] = c.category, m), {});
    rows.forEach((r) => { r.line = catIdx[r.sku_key] || null; });
    rows.forEach((r) => {
      const cs = bomIdx[r.sku_key];
      if (!cs) return;
      r.bom = cs.map((c) => ({
        sku: c.component_sku, name: c.component_name, qty: Number(c.quantity),
        soh: Number(c.comp_soh), main: Number(c.comp_main),
        build: c.can_build_main == null ? null : Number(c.can_build_main),
        life: c.comp_lifecycle, neg: c.comp_main_negative === true,
      }));
      // Com vários componentes quem manda é o mais escasso. Mostrar a média ou
      // o maior faria a tela prometer uma montagem que o gargalo não permite.
      const builds = r.bom.map((c) => c.build).filter((v) => v != null);
      r.bom_build = builds.length ? Math.min(...builds) : null;
    });

    // O modo BOM mostra só os montados que estão no arquivo de planejamento
    // (is_planned). Dizer 225 sem dizer de quantos seria truncar em silêncio.
    const bomAll = req.query.view === 'bom'
      ? (await db.query('SELECT count(DISTINCT parent_key)::int n FROM rapid_inv.product_bom'))[0].n
      : null;

    res.json({
      bom_universe: bomAll,
      scope: scope ? {
        key: scopeKey, label: scope.label, codes: scope.codes, months: scopeMonths,
        // O PO chega no Main e é distribuído depois — não há uma única alocação
        // de PO por filial gravada (medido: 0 de 1.466 linhas em aberto). Então
        // no escopo de filial a coluna Incoming é do Main, e dizer isso é o que
        // impede o planejador de contar como se já fosse dele.
        incoming_is_main: scopeKey !== 'MAIN' && scopeKey !== 'NETWORK',
      } : null,
      scopes: Object.entries(SCOPES).map(([k, v]) => ({ key: k, label: v.label })),
      reporting_week: state.reporting_week,
      weeks: weeks.slice(0, horizon + 1).map((w) => ({ ...w, label: shortLabel(w.week_ending) })),
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

    // O modo BOM mostra só os montados que estão no arquivo de planejamento
    // (is_planned). Dizer 225 sem dizer de quantos seria truncar em silêncio.
    const bomAll = req.query.view === 'bom'
      ? (await db.query('SELECT count(DISTINCT parent_key)::int n FROM rapid_inv.product_bom'))[0].n
      : null;

    res.json({
      bom_universe: bomAll,
      scope: scope ? {
        key: scopeKey, label: scope.label, codes: scope.codes, months: scopeMonths,
        // O PO chega no Main e é distribuído depois — não há uma única alocação
        // de PO por filial gravada (medido: 0 de 1.466 linhas em aberto). Então
        // no escopo de filial a coluna Incoming é do Main, e dizer isso é o que
        // impede o planejador de contar como se já fosse dele.
        incoming_is_main: scopeKey !== 'MAIN' && scopeKey !== 'NETWORK',
      } : null,
      scopes: Object.entries(SCOPES).map(([k, v]) => ({ key: k, label: v.label })),
      reporting_week: state.reporting_week,
      weeks: weeks.map((w) => ({ week_ending: w.week_ending, label: shortLabel(w.week_ending) })),
      rows, coverage: cov, ms: Date.now() - t0,
    });
  }));


  /**
   * Master Stock: um item por linha, com TUDO o que existe sobre ele.
   *
   * Devolve os dois lados de cada campo — Cin7 e arquivo — sem escolher. A tela
   * pinta: iguais sem cor, só-uma-fonte na cor da fonte, divergentes com os
   * dois valores. Escolher aqui apagaria justamente o que o usuário quer ver.
   *
   * Traz TODOS os status, inclusive Deprecated e os 48 que só existem no
   * arquivo: ele pediu a lista inteira "mesmo que não usemos".
   */
  app.get(`${R}/master-stock`, wrap(async (req, res) => {
    const t0 = Date.now();
    const p = [], where = ['1=1'];
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`(sku ILIKE $${p.length} OR name ILIKE $${p.length} OR dc ILIKE $${p.length})`); }
    if (req.query.status) { p.push(req.query.status); where.push(`status = $${p.length}`); }
    // Os filtros de trabalho. Cada um responde "o que falta para eu conseguir
    // fazer X" — e por isso vêm com a contagem, senão o usuário não sabe se
    // vale abrir.
    const GAPS = { dims: 'missing_dims', weight: 'missing_weight', pick: 'missing_pick',
                   carton: 'missing_carton', pallet: 'missing_pallet',
                   // Bandeiras de qualidade: o dado existe mas está suspeito.
                   // São filtros de LIMPEZA, não de falta.
                   dimunit: 'flag_dim_unit', packsku: 'flag_pack_sku',
                   locator: 'flag_locator_junk', stocknodim: 'flag_stock_no_dim',
                   bom: 'bom_components IS NOT NULL',
                   cartonfix: 'carton_qty_in_bom',
                   cartonbad: 'flag_carton_name_mismatch',
                   filedim: 'flag_file_dim_unit', voldefault: 'flag_volume_default',
                   cube: 'cube_trustworthy',
                   /* A política, como filtro. Sem isto ela só existia dentro do
                      painel: para achar o que alguém configurou era preciso
                      abrir SKU por SKU em 11.259 linhas. Configuração que não
                      se vê de fora é configuração que ninguém confere. */
                   decided:  'policy_decided',
                   nobranch: 'NOT use_in_replenishment',
                   noplan:   'NOT use_in_planning',
                   nogw:     'NOT use_in_gateway',
                   disc:     `lifecycle_status = 'DISCONTINUED'`,
                   runout:   `lifecycle_status = 'RUN_OUT'`,
                   // As duas discordâncias com o Cin7. A primeira é a que
                   // importa: 2.507 SKUs que o ERP dá como mortos e a empresa
                   // ainda vende.
                   cin7dead: 'cin7_dead_we_alive',
                   cin7live: 'cin7_alive_we_dead' };
    if (GAPS[req.query.gap]) where.push(`${GAPS[req.query.gap]}`);
    if (req.query.conflict === '1') {
      where.push(`((cin7_length IS NOT NULL AND file_length IS NOT NULL AND abs(cin7_length - file_length) / greatest(cin7_length, 1) > 0.02)
               OR (cin7_cost   IS NOT NULL AND file_cost   IS NOT NULL AND abs(cin7_cost - file_cost) / greatest(cin7_cost, 0.01) > 0.05)
               OR (cin7_pick   IS NOT NULL AND file_pick   IS NOT NULL AND upper(btrim(cin7_pick)) <> upper(btrim(file_pick)))
               OR (cin7_carton IS NOT NULL AND file_carton IS NOT NULL AND cin7_carton <> file_carton))`);
    }
    const w = where.join(' AND ');
    const limit = asInt(req.query.limit, 300, 1, 2000);
    const offset = asInt(req.query.offset, 0, 0, 1e6);

    const [rows, tot, counts] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_master_stock WHERE ${w}
                 ORDER BY (status = 'Active') DESC, soh_total DESC NULLS LAST, sku
                 LIMIT ${limit} OFFSET ${offset}`, p),
      db.one(`SELECT count(*)::int n FROM rapid_inv.v_master_stock WHERE ${w}`, p),
      db.one(`SELECT count(*)::int total,
                     count(*) FILTER (WHERE status='Active')::int active,
                     count(*) FILTER (WHERE status='Deprecated')::int deprecated,
                     count(*) FILTER (WHERE NOT in_cin7)::int file_only,
                     count(*) FILTER (WHERE NOT in_file)::int cin7_only,
                     count(*) FILTER (WHERE missing_dims)::int gap_dims,
                     count(*) FILTER (WHERE missing_weight)::int gap_weight,
                     count(*) FILTER (WHERE missing_pick)::int gap_pick,
                     count(*) FILTER (WHERE missing_carton)::int gap_carton,
                     count(*) FILTER (WHERE missing_pallet)::int gap_pallet,
                     count(*) FILTER (WHERE flag_dim_unit)::int flag_dimunit,
                     count(*) FILTER (WHERE flag_pack_sku)::int flag_packsku,
                     count(*) FILTER (WHERE flag_locator_junk)::int flag_locator,
                     count(*) FILTER (WHERE flag_stock_no_dim)::int flag_stocknodim,
                     count(*) FILTER (WHERE bom_components IS NOT NULL)::int flag_bom,
                     count(*) FILTER (WHERE carton_qty_in_bom)::int flag_cartonfix,
                     count(*) FILTER (WHERE flag_carton_name_mismatch)::int flag_cartonbad,
                     count(*) FILTER (WHERE flag_file_dim_unit)::int flag_filedim,
                     count(*) FILTER (WHERE flag_volume_default)::int flag_voldefault,
                     count(*) FILTER (WHERE cube_trustworthy)::int flag_cube,
                     count(*) FILTER (WHERE policy_decided)::int pol_decided,
                     count(*) FILTER (WHERE NOT use_in_replenishment)::int pol_nobranch,
                     count(*) FILTER (WHERE NOT use_in_planning)::int pol_noplan,
                     count(*) FILTER (WHERE NOT use_in_gateway)::int pol_nogw,
                     count(*) FILTER (WHERE lifecycle_status = 'DISCONTINUED')::int pol_disc,
                     count(*) FILTER (WHERE lifecycle_status = 'RUN_OUT')::int pol_runout,
                     count(*) FILTER (WHERE cin7_dead_we_alive)::int pol_cin7dead,
                     count(*) FILTER (WHERE cin7_alive_we_dead)::int pol_cin7live,
                     -- O "as fontes discordam" é o único filtro sem contagem
                     -- no menu, e filtro sem número obriga a abrir para saber
                     -- se vale. Mesma expressão do WHERE, ou os dois mentem.
                     count(*) FILTER (WHERE
                       (cin7_length IS NOT NULL AND file_length IS NOT NULL AND abs(cin7_length - file_length) / greatest(cin7_length, 1) > 0.02)
                    OR (cin7_cost   IS NOT NULL AND file_cost   IS NOT NULL AND abs(cin7_cost - file_cost) / greatest(cin7_cost, 0.01) > 0.05)
                    OR (cin7_pick   IS NOT NULL AND file_pick   IS NOT NULL AND upper(btrim(cin7_pick)) <> upper(btrim(file_pick)))
                    OR (cin7_carton IS NOT NULL AND file_carton IS NOT NULL AND cin7_carton <> file_carton))::int conflict_n
                FROM rapid_inv.v_master_stock`),
    ]);
    res.json({ rows, total: tot.n, counts, limit, offset, ms: Date.now() - t0 });
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
  /* ── CARRINHO DE COMPRA ──────────────────────────────────────────────
     Um carrinho aberto por fornecedor, compartilhado. Ver 019_buy_cart.sql
     para o porquê de ser compartilhado e não por pessoa. */

  const cartOf = async (c, supplier, actor, scope) => {
    // ON CONFLICT sobre o índice parcial: dois cliques simultâneos no mesmo
    // fornecedor acabam no MESMO carrinho em vez de criarem dois.
    const r = await c.query(
      `INSERT INTO rapid_inv.buy_cart (supplier_code, created_by, scope) VALUES ($1,$2,$3)
       ON CONFLICT (supplier_code) WHERE status = 'DRAFT'
       DO UPDATE SET updated_at = now()
       RETURNING *`, [supplier, actor, scope || null]);
    return r.rows[0];
  };

  /** O carrinho de um fornecedor, com o que a tela precisa para decidir. */
  app.get(`${R}/cart`, wrap(async (req, res) => {
    const supplier = String(req.query.supplier || '').trim();
    const carts = await db.query(
      `SELECT c.*, count(l.id)::int lines, coalesce(sum(l.qty),0)::numeric units,
              coalesce(sum(l.qty * coalesce(l.unit_cost_aud,0)),0)::numeric value_aud
         FROM rapid_inv.buy_cart c
         LEFT JOIN rapid_inv.buy_cart_line l ON l.cart_id = c.id
        WHERE c.status = 'DRAFT' ${supplier ? 'AND c.supplier_code = $1' : ''}
        GROUP BY c.id ORDER BY c.updated_at DESC`, supplier ? [supplier] : []);
    const ids = carts.map((c) => c.id);
    const lines = ids.length ? await db.query(
      `SELECT * FROM rapid_inv.buy_cart_line WHERE cart_id = ANY($1) ORDER BY sku`, [ids]) : [];
    const byCart = lines.reduce((m, l) => ((m[l.cart_id] = m[l.cart_id] || []).push(l), m), {});
    res.json({ carts: carts.map((c) => ({ ...c, lines: byCart[c.id] || [] })) });
  }));

  /** Põe uma ou muitas linhas no carrinho. O mesmo SKU de novo é EDIÇÃO. */
  app.post(`${R}/cart/lines`, wrap(async (req, res) => {
    const supplier = String(req.body.supplier || '').trim();
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!supplier) return res.status(400).json({ error: 'supplier is required' });
    if (!lines.length) return res.status(400).json({ error: 'send at least one line' });
    const actor = actorOf(req);
    if (db.mode() === 'rpc') return res.status(501).json({ error: 'Escrita com transação ainda não habilitada no transporte por service key — rode a migration 029 (função rapid_inv dedicada). Máquinas com SUPABASE_DB_PASSWORD já fazem esta ação.' });
    const out = await db.tx(async (c) => {
      const cart = await cartOf(c, supplier, actor, req.body.scope);
      const feitas = [];
      for (const l of lines) {
        const key = String(l.sku_key || l.sku || '').trim().toUpperCase();
        const qty = Number(l.qty);
        if (!key || !isFinite(qty) || qty <= 0) continue;
        // Somar em vez de sobrescrever: quem clica "adicionar" duas vezes quer
        // duas, e quem edita usa o PATCH. Sobrescrever aqui perderia a
        // quantidade que outra pessoa acabou de pôr.
        const r = await c.query(
          `INSERT INTO rapid_inv.buy_cart_line
             (cart_id, sku_key, sku, qty, qty_suggested, carton_qty, unit_cost_aud, source, note, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (cart_id, sku_key) DO UPDATE
             SET qty = rapid_inv.buy_cart_line.qty + EXCLUDED.qty,
                 updated_at = now(), updated_by = EXCLUDED.added_by
           RETURNING *`,
          [cart.id, key, l.sku || key, qty, l.qty_suggested ?? null, l.carton_qty ?? null,
           l.unit_cost_aud ?? null, l.source === 'manual' ? 'manual' : 'suggested',
           l.note || null, actor]);
        feitas.push(r.rows[0]);
      }
      await c.query('UPDATE rapid_inv.buy_cart SET updated_at = now() WHERE id = $1', [cart.id]);
      return { cart_id: cart.id, lines: feitas };
    }, actor);
    res.json(out);
  }));

  app.patch(`${R}/cart/lines/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const qty = Number(req.body.qty);
    const actor = actorOf(req);
    if (req.body.qty !== undefined && (!isFinite(qty) || qty <= 0))
      return res.status(400).json({ error: 'qty must be above zero — remove the line instead' });
    const row = await db.tx(async (c) => (await c.query(
      `UPDATE rapid_inv.buy_cart_line
          SET qty = COALESCE($1, qty), note = COALESCE($2, note),
              updated_at = now(), updated_by = $3
        WHERE id = $4 RETURNING *`,
      [req.body.qty === undefined ? null : qty, req.body.note ?? null, actor, id])).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'line not found' });
    res.json(row);
  }));

  app.delete(`${R}/cart/lines/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const actor = actorOf(req);
    const row = await db.tx(async (c) => (await c.query(
      'DELETE FROM rapid_inv.buy_cart_line WHERE id = $1 RETURNING id, cart_id', [id])).rows[0], actor);
    if (!row) return res.status(404).json({ error: 'line not found' });
    res.json({ ok: true, ...row });
  }));

  app.delete(`${R}/cart/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const actor = actorOf(req);
    await db.tx(async (c) => c.query(
      `UPDATE rapid_inv.buy_cart SET status='CANCELLED', updated_at=now() WHERE id=$1 AND status='DRAFT'`,
      [id]), actor);
    res.json({ ok: true });
  }));

  /** Confirma: o carrinho vira PO local e aparece na aba Purchase Orders. */
  app.post(`${R}/cart/:id/confirm`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const actor = actorOf(req);
    const poNumber = String(req.body.po_number || '').trim();
    if (!poNumber) return res.status(400).json({ error: 'po_number is required' });
    const out = await db.tx(async (c) => {
      const cart = (await c.query(
        `SELECT * FROM rapid_inv.buy_cart WHERE id=$1 AND status='DRAFT' FOR UPDATE`, [id])).rows[0];
      if (!cart) throw new Error('cart is not open — it may already be confirmed');
      const lines = (await c.query(
        'SELECT * FROM rapid_inv.buy_cart_line WHERE cart_id=$1 ORDER BY sku', [id])).rows;
      if (!lines.length) throw new Error('the cart is empty');
      // O número de PO já existir é erro de quem digitou, não algo a contornar
      // inventando um sufixo: duas POs com o mesmo número é o que estraga a
      // conferência na chegada do contêiner.
      const [{ n }] = (await c.query(
        'SELECT count(*)::int n FROM rapid_inv.po_lines WHERE po_number=$1', [poNumber])).rows;
      if (n > 0) throw new Error(`PO ${poNumber} already exists with ${n} lines`);
      let seq = 0;
      for (const l of lines) {
        seq += 1;
        await c.query(
          // sku_key NÃO entra: em po_lines ela é GENERATED ALWAYS a partir de
          // sku, e o Postgres recusa a inserção inteira se ela vier na lista.
          `INSERT INTO rapid_inv.po_lines
             (po_number, line_no, po_date, supplier_code, sku, qty, due_date,
              value_aud, is_received, source, updated_by)
           VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,false,'buy_cart',$8)`,
          [poNumber, seq, cart.supplier_code, l.sku, l.qty,
           toISODate(req.body.due_date) || null,
           l.unit_cost_aud ? Number(l.unit_cost_aud) * Number(l.qty) : null, actor]);
      }
      await c.query(
        `UPDATE rapid_inv.buy_cart SET status='CONFIRMED', po_number=$1,
                confirmed_at=now(), confirmed_by=$2, updated_at=now() WHERE id=$3`,
        [poNumber, actor, id]);
      return { po_number: poNumber, lines: lines.length };
    }, actor);
    res.json(out);
  }));

  /* Limpeza do teste ponta a ponta.
     O teste do carrinho grava numa PO de verdade, no banco de produção — é o
     único jeito de provar que o confirmado aparece mesmo em Purchase Orders.
     Então ele precisa saber se limpar, e o prefixo é fixo aqui e não vem do
     cliente: um DELETE com prefixo livre seria uma porta para apagar POs de
     verdade. */
  app.post(`${R}/cart/test-cleanup`, wrap(async (req, res) => {
    const PREFIXO = 'TEST-CART-';
    if (String(req.body.prefix || '') !== PREFIXO)
      return res.status(400).json({ error: 'this endpoint only removes the end-to-end test fixtures' });
    if (db.mode() === 'rpc') return res.status(501).json({ error: 'Escrita com transação ainda não habilitada no transporte por service key — rode a migration 029.' });
    const out = await db.tx(async (c) => {
      const a = await c.query(`DELETE FROM rapid_inv.po_lines WHERE po_number LIKE $1 RETURNING id`, [PREFIXO + '%']);
      const b = await c.query(`DELETE FROM rapid_inv.buy_cart WHERE supplier_code = 'TESTE' RETURNING id`);
      return { po_lines: a.rowCount, carts: b.rowCount };
    }, 'test-cleanup');
    res.json(out);
  }));

  /* ── AS TRÊS ABAS DE PURCHASE ORDERS ─────────────────────────────────
     A tela saiu de dentro do Stock Planning e ganhou três perguntas
     separadas: o que está em aberto, para quem vai, e como isso vira carga. */

  /** Aba 2 — alocação: uma linha por linha de PO, com o que já foi repartido. */
  /* ── A POLÍTICA DE UM PRODUTO ────────────────────────────────────────
   * O Master Stock é uma camada NOSSA: diz como o produto se comporta dentro
   * do Inventory Management e nunca escreve no Cin7. Por isso ele pode
   * discordar do ERP de propósito — o Cin7 diz o que o produto é, isto diz o
   * que a gente faz com ele.
   *
   * GRAVA TUDO DE UMA VEZ, com botão. A versão anterior salvava a cada
   * clique de checkbox: três decisões viravam três gravações, três linhas de
   * auditoria e nenhum momento em que o usuário pudesse desistir. Uma
   * política é um conjunto, e se grava como conjunto.
   */
  app.get(`${R}/sku-policy/:sku`, wrap(async (req, res) => {
    const key = String(req.params.sku || '').trim().toUpperCase();
    const [pol, hist] = await Promise.all([
      db.one(`SELECT * FROM rapid_inv.v_sku_policy WHERE sku_key = $1`, [key]),
      // O histórico vem do audit_log, que só voltou a gravar em 025 — antes
      // disso um EXCEPTION engolia o erro e o log ficou vazio desde que
      // nasceu. Um SKU sem histórico aqui pode ser "nunca mudou" OU "mudou
      // antes do conserto", e a tela diz isso em vez de fingir que é o
      // primeiro caso.
      db.query(
        `SELECT changed_at, action, user_email,
                old_value, new_value
           FROM rapid_inv.audit_log
          WHERE table_name = 'sku_settings' AND record_id = $1
          ORDER BY changed_at DESC LIMIT 40`, [key]),
    ]);
    if (!pol) return res.status(404).json({ error: 'SKU não existe no catálogo do Cin7' });

    /* O histórico só interessa nos campos de política. Um diff cru de
       to_jsonb traz updated_at e wk_avg junto, e aí ninguém lê o log. */
    const CAMPOS = {
      lifecycle_status: 'Lifecycle',
      use_in_replenishment: 'Branch Replenishment',
      use_in_planning: 'Stock Planning',
      use_in_gateway: 'Gateway',
      policy_note: 'Note',
      replenishment_note: 'Replenishment note',
    };
    const mudancas = hist.map((h) => {
      const a = h.old_value || {}, b = h.new_value || {};
      const campos = Object.keys(CAMPOS)
        .filter((k) => String(a[k] ?? '') !== String(b[k] ?? ''))
        .map((k) => ({ campo: CAMPOS[k], de: a[k], para: b[k] }));
      return { quando: h.changed_at, quem: h.user_email || 'desconhecido', acao: h.action, campos };
    }).filter((m) => m.campos.length || m.acao === 'INSERT');

    res.json({ policy: pol, historico: mudancas, historico_desde: '2026-08-31' });
  }));

  app.put(`${R}/sku-policy/:sku`, wrap(async (req, res) => {
    const key = String(req.params.sku || '').trim().toUpperCase();
    if (!key) return res.status(400).json({ error: 'sku is required' });
    const actor = actorOf(req);

    const b = req.body || {};
    const campos = {};
    for (const f of ['use_in_replenishment', 'use_in_planning', 'use_in_gateway']) {
      if (f in b) campos[f] = !!b[f];
    }
    if ('lifecycle_status' in b) {
      const v = String(b.lifecycle_status || '').toUpperCase();
      if (!['ACTIVE', 'RUN_OUT', 'DISCONTINUED'].includes(v))
        return res.status(400).json({ error: 'lifecycle_status must be ACTIVE, RUN_OUT or DISCONTINUED' });
      campos.lifecycle_status = v;
    }
    if ('policy_note' in b) campos.policy_note = b.policy_note || null;
    if (!Object.keys(campos).length) return res.status(400).json({ error: 'nothing to save' });

    const row = await db.tx(async (c) => {
      // Sem isto o audit_log grava user_email nulo e o histórico não diz quem.
      await c.query(`SELECT set_config('rapid_inv.user_email', $1, true)`, [actor]);

      const [p] = (await c.query(
        `SELECT sku FROM cin7_mirror.products WHERE upper(btrim(sku)) = $1 LIMIT 1`, [key])).rows;
      if (!p) throw new Error('SKU não existe no catálogo do Cin7');

      /* is_planned = FALSE na inserção. Ela tem default true e é o WHERE de
         v_sp_planning_skus: sem cravar, configurar a política de um SKU
         qualquer o ADICIONA ao arquivo de compra — duas decisões opostas pelo
         mesmo clique. No UPDATE não se mexe, porque quem já está deve ficar. */
      const cols = ['sku', 'is_planned', ...Object.keys(campos), 'settings_updated_at', 'settings_updated_by'];
      const vals = [p.sku, false, ...Object.values(campos)];
      const ph = vals.map((_, i) => `$${i + 1}`).concat(['now()', `$${vals.length + 1}`]);
      const set = [...Object.keys(campos).map((k, i) => `${k} = $${i + 3}`),
                   'settings_updated_at = now()', `settings_updated_by = $${vals.length + 1}`];
      if (campos.lifecycle_status) set.push(`lifecycle_source = 'MANUAL'`, 'lifecycle_set_at = now()');

      await c.query(
        `INSERT INTO rapid_inv.sku_settings (${cols.join(',')}) VALUES (${ph.join(',')})
         ON CONFLICT (sku_key) DO UPDATE SET ${set.join(', ')}`, [...vals, actor]);
      return (await c.query(`SELECT * FROM rapid_inv.v_sku_policy WHERE sku_key = $1`, [key])).rows[0];
    }, actor);
    res.json(row);
  }));

  /** Quais SKUs NÃO devem ser sugeridos na reposição de filial.
   *
   * Existe porque a tela de reposição lê cin7_mirror.products direto do
   * navegador pelo PostgREST, e o schema rapid_inv não é exposto lá — uma
   * coluna em sku_settings é invisível para ela sem um endpoint. Devolve só a
   * lista de chaves, que é pequena e cabe num payload. */
  /* A política do Master Stock, na forma que a Branch Replenishment consome.
     Um fetch só: a tela carrega isto junto do resto e não pode pagar três
     idas ao servidor para desenhar a primeira linha.

     `allow` merece explicação. O Cin7 marca 2.744 SKUs como Deprecated e a
     reposição os esconde — o que está certo por padrão e errado quando a
     empresa ainda vende o item e o ERP é que está atrasado. A marca do usuário
     tem de poder vencer o ERP, senão o painel só sabe dizer "não". O critério
     de "o usuário decidiu" é settings_updated_at: ele só é gravado quando
     alguém abre o painel e clica em Save. Default nenhum entra aqui. */
  app.get(`${R}/replenishment-blocked`, wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT sku_key, replenishment_note, policy_note, lifecycle_status,
              use_in_replenishment, use_in_gateway,
              (settings_updated_at IS NOT NULL) AS decidido
         FROM rapid_inv.sku_settings
        WHERE NOT use_in_replenishment
           OR NOT use_in_gateway
           OR lifecycle_status IN ('DISCONTINUED', 'RUN_OUT')
           OR settings_updated_at IS NOT NULL`);
    const keys = [], allow = [], gatewayOff = [], notes = {}, flags = {};
    for (const r of rows) {
      if (!r.use_in_replenishment) {
        keys.push(r.sku_key);
        const n = r.replenishment_note || r.policy_note;
        if (n) notes[r.sku_key] = n;
      } else if (r.decidido) {
        allow.push(r.sku_key);              // vence o Deprecated do Cin7
      }
      if (!r.use_in_gateway) gatewayOff.push(r.sku_key);
      if (r.lifecycle_status === 'DISCONTINUED' || r.lifecycle_status === 'RUN_OUT')
        flags[r.sku_key] = r.lifecycle_status;
    }
    res.json({ keys, notes, allow, gateway_off: gatewayOff, flags });
  }));

  app.get(`${R}/pos/allocations`, wrap(async (req, res) => {
    const t0 = Date.now();
    const p = [], where = ['1=1'];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`supplier_code = $${p.length}`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`(po_number ILIKE $${p.length} OR sku ILIKE $${p.length})`); }
    // Só o que ainda não chegou: alocar o que já foi recebido não muda nada.
    if (req.query.only !== 'all')
      where.push(`po_line_id IN (SELECT id FROM rapid_inv.po_lines WHERE NOT coalesce(is_received,false))`);
    if (req.query.only === 'pending') where.push(`unallocated_qty > 0`);
    if (req.query.only === 'over')    where.push(`over_allocated`);
    const w = where.join(' AND ');
    const limit = asInt(req.query.limit, 300, 1, MAX_PAGE);
    // OFFSET existe agora. Sem ele a grade parava em 300 de 1.466 e o estado
    // vazio ainda afirmava "Every open line matching these filters already has
    // a branch" — completude declarada sobre uma página.
    const offset = asInt(req.query.offset, 0, 0, 1e6);
    const [rows, counts, [filtered]] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_po_allocation
                 WHERE ${w} ORDER BY due_date NULLS LAST, po_number, line_no
                 LIMIT ${limit} OFFSET ${offset}`, p),
      db.one(`SELECT count(*)::int total,
                     count(*) FILTER (WHERE unallocated_qty > 0)::int pending,
                     -- "over" e palavra reservada (funcao de janela); o alias
                     -- precisa de outro nome ou o parser quebra na virgula.
                     count(*) FILTER (WHERE over_allocated)::int over_count,
                     coalesce(sum(unallocated_qty) FILTER (WHERE unallocated_qty > 0), 0)::numeric units_pending
                FROM rapid_inv.v_sp_po_allocation
               WHERE po_line_id IN (SELECT id FROM rapid_inv.po_lines WHERE NOT coalesce(is_received,false))`),
      // O total do MESMO filtro que a grade está mostrando. Os quatro cartões
      // acima ignoram supplier/q/only de propósito (são o retrato do livro
      // aberto); sem este número separado, filtrar por um fornecedor deixava a
      // grade em 300 e o cartão em 1.466, e os dois pareciam a mesma coisa.
      db.query(`SELECT count(*)::int n FROM rapid_inv.v_sp_po_allocation WHERE ${w}`, p),
    ]);
    // As alocações existentes de cada linha da página, num SELECT só.
    const ids = rows.map((r) => r.po_line_id);
    const al = ids.length ? await db.query(
      `SELECT a.po_line_id, a.branch_code, a.qty, a.eta_date, w.name AS branch_name
         FROM rapid_inv.po_line_allocations a
         LEFT JOIN rapid_inv.warehouses w ON w.code = a.branch_code
        WHERE a.po_line_id = ANY($1) AND a.status <> 'CANCELLED'
        ORDER BY a.po_line_id, a.seq`, [ids]) : [];
    const byLine = al.reduce((m, a) => ((m[a.po_line_id] = m[a.po_line_id] || []).push(a), m), {});
    res.json({ rows: rows.map((r) => ({ ...r, allocations: byLine[r.po_line_id] || [] })),
               counts: { ...counts, filtered: Number(filtered.n) },
               limit, offset, ms: Date.now() - t0 });
  }));

  /** Quem está esperando esta PO.
   *
   * O elo óbvio seria project_lines.po_ref → po_lines.po_number, e ele não
   * existe: das 1.442 linhas com po_ref, ZERO casam, nem pelos dígitos.
   * Olhando os valores, po_ref guarda nome de gente ("SONIA", "WILL", "Rod"),
   * nota ("Airfreight", "Will ordered") e algum número solto. É um campo de
   * "quem pediu", não de referência de compra. Uma tela que ligasse por ele
   * mostraria sempre vazio e pareceria bug.
   *
   * O elo de verdade é o SKU: a PO traz o produto que o projeto espera. Não é
   * reserva — ninguém amarrou aquela carga àquele pedido — e por isso a tela
   * diz "esperando este produto" e não "reservado para".
   */
  app.get(`${R}/pos/:po_number/projects`, wrap(async (req, res) => {
    const po = String(req.params.po_number || '').trim();
    if (!po) return res.status(400).json({ error: 'po_number is required' });
    const rows = await db.query(
      `WITH po AS (
         SELECT sku_key, sku, sum(qty)::numeric qty, min(due_date) due_date
           FROM rapid_inv.po_lines WHERE upper(btrim(po_number)) = upper(btrim($1))
          GROUP BY 1, 2)
       SELECT l.id, l.sales_order, l.customer, l.reference, l.sku, l.rep,
              l.qty, l.qty_to_pick, l.project_status,
              po.qty AS po_qty, po.due_date
         FROM rapid_inv.v_sp_lines l
         JOIN po ON po.sku_key = l.sku_key
        WHERE l.project_status = 'ACTIVE' AND coalesce(l.qty_to_pick, 0) > 0
        ORDER BY l.sales_order, l.sku`, [po]);
    res.json({ po_number: po, rows,
      linked_by: 'sku',
      units: rows.reduce((a, r) => a + Number(r.qty_to_pick || 0), 0),
      orders: new Set(rows.map((r) => r.sales_order)).size });
  }));

  /** Aba 3 — o cubo das linhas em aberto, e os tipos de contêiner. */
  app.get(`${R}/containers/lines`, wrap(async (req, res) => {
    const t0 = Date.now();
    const p = [], where = ['NOT coalesce(pl.is_received,false)'];
    if (req.query.supplier) { p.push(req.query.supplier); where.push(`pl.supplier_code = $${p.length}`); }
    if (req.query.q) { p.push(`%${req.query.q}%`); where.push(`(pl.po_number ILIKE $${p.length} OR pl.sku ILIKE $${p.length})`); }
    const rows = await db.query(
      `SELECT pl.id, pl.po_number, pl.line_no, pl.supplier_code, pl.sku, pl.qty, pl.due_date, pl.vessel,
              c.cbm_carton, c.carton_qty, c.cube_source, c.cube_basis, c.cube_disputed,
              c.kg_unit, c.weight_ambiguous, c.carton_l, c.carton_w, c.carton_h,
              -- Caixas inteiras: meia caixa não entra em contêiner.
              CASE WHEN c.cbm_carton IS NOT NULL AND c.carton_qty > 0
                   THEN ceil(pl.qty / c.carton_qty) END                       AS cartons,
              CASE WHEN c.cbm_carton IS NOT NULL AND c.carton_qty > 0
                   THEN round((ceil(pl.qty / c.carton_qty) * c.cbm_carton)::numeric, 3) END AS cbm,
              CASE WHEN c.kg_unit IS NOT NULL THEN round((pl.qty * c.kg_unit)::numeric, 1) END AS kg,
              cm.qty_planned, cm.plan_names
         FROM rapid_inv.po_lines pl
         LEFT JOIN rapid_inv.v_sp_cube c        ON c.sku_key = pl.sku_key
         LEFT JOIN rapid_inv.v_sp_po_committed cm ON cm.po_line_id = pl.id
        WHERE ${where.join(' AND ')}
        ORDER BY pl.due_date NULLS LAST, pl.po_number, pl.line_no
        LIMIT ${asInt(req.query.limit, MAX_CONTAINER_LINES, 1, MAX_CONTAINER_LINES)}`, p);
    const types = await db.query(
      `SELECT * FROM rapid_inv.container_type WHERE is_active ORDER BY sort_order`);
    /* O resumo é do LIVRO INTEIRO, não da página.
       Ele era somado em JS sobre as linhas devolvidas, e as linhas paravam em
       500 de 1.466: a aba anunciava 588,8 m³ ≈ 10 contêineres quando o livro
       aberto tem 1.692,6 m³ ≈ 29. O corte era por data — outubro e novembro
       sumiam inteiros. Quem planeja espaço em navio decidia sobre um terço
       da carga achando que via tudo.
       Agora a soma desce para o SQL, sobre o mesmo WHERE e sem LIMIT. */
    const [tot] = await db.query(
      `WITH l AS (
         SELECT CASE WHEN c.cbm_carton IS NOT NULL AND c.carton_qty > 0
                     THEN round((ceil(pl.qty / c.carton_qty) * c.cbm_carton)::numeric, 3) END AS cbm,
                CASE WHEN c.kg_unit IS NOT NULL THEN pl.qty * c.kg_unit END AS kg,
                c.cube_basis, c.cube_disputed
           FROM rapid_inv.po_lines pl
           LEFT JOIN rapid_inv.v_sp_cube c ON c.sku_key = pl.sku_key
          WHERE ${where.join(' AND ')})
       SELECT count(*)::int lines,
              count(*) FILTER (WHERE cbm IS NOT NULL)::int cubed,
              coalesce(sum(cbm), 0)::numeric cbm,
              count(*) FILTER (WHERE cbm IS NOT NULL AND cube_basis = 'measured')::int measured,
              coalesce(sum(cbm) FILTER (WHERE cube_basis = 'measured'), 0)::numeric measured_cbm,
              count(*) FILTER (WHERE cbm IS NOT NULL AND cube_disputed)::int disputed,
              count(*) FILTER (WHERE cbm IS NULL)::int no_cube,
              count(*) FILTER (WHERE kg IS NULL)::int no_weight
         FROM l`, p);
    const r1 = (v) => Math.round(Number(v) * 10) / 10;
    res.json({
      rows, types, ms: Date.now() - t0,
      summary: {
        lines: Number(tot.lines), cubed: Number(tot.cubed), cbm: r1(tot.cbm),
        measured: Number(tot.measured), measured_cbm: r1(tot.measured_cbm),
        disputed: Number(tot.disputed),
        no_cube: Number(tot.no_cube), no_weight: Number(tot.no_weight),
        // Quantas linhas o navegador realmente recebeu. Se for menos que
        // `lines`, a tela tem de dizer isso — e não somar por cima.
        rows_returned: rows.length,
      },
    });
  }));

  /* ── PLANOS DE CONTÊINER ─────────────────────────────────────────────
     Montar carga leva horas e envolve mais de uma pessoa: quem compra escolhe
     o que entra, quem embarca confere se fecha. Um plano que só existe na aba
     aberta morre no primeiro F5 e a conversa recomeça. */

  app.get(`${R}/container-plans`, wrap(async (req, res) => {
    const plans = await db.query(
      `SELECT p.*, t.name AS container_name, t.cbm_internal, t.usable_pct, t.payload_kg,
              count(l.id)::int lines,
              coalesce(sum(l.cbm_at_plan), 0)::numeric cbm,
              coalesce(sum(l.kg_at_plan), 0)::numeric kg,
              count(*) FILTER (WHERE l.cube_source <> 'carton')::int assumed
         FROM rapid_inv.container_plan p
         JOIN rapid_inv.container_type t ON t.code = p.container_code
         LEFT JOIN rapid_inv.container_plan_line l ON l.plan_id = p.id
        WHERE p.status <> 'CANCELLED'
        GROUP BY p.id, t.name, t.cbm_internal, t.usable_pct, t.payload_kg
        ORDER BY p.updated_at DESC LIMIT 50`);
    res.json({ plans });
  }));

  app.get(`${R}/container-plans/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const plan = await db.one(
      `SELECT p.*, t.name AS container_name, t.cbm_internal, t.usable_pct, t.payload_kg
         FROM rapid_inv.container_plan p JOIN rapid_inv.container_type t ON t.code = p.container_code
        WHERE p.id = $1`, [id]);
    if (!plan) return res.status(404).json({ error: 'plan not found' });
    const lines = await db.query(
      `SELECT l.*, pl.po_number, pl.supplier_code, pl.due_date, pl.qty AS po_qty
         FROM rapid_inv.container_plan_line l
         LEFT JOIN rapid_inv.po_lines pl ON pl.id = l.po_line_id
        WHERE l.plan_id = $1 ORDER BY l.sku`, [id]);
    res.json({ plan, lines });
  }));

  app.post(`${R}/container-plans`, wrap(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.container_code || '').trim().toUpperCase();
    const ids = Array.isArray(req.body.po_line_ids) ? req.body.po_line_ids.map(Number).filter(Boolean) : [];
    if (!name) return res.status(400).json({ error: 'give the plan a name' });
    if (!code) return res.status(400).json({ error: 'container type is required' });
    if (!ids.length) return res.status(400).json({ error: 'pick at least one line' });
    const actor = actorOf(req);
    const out = await db.tx(async (c) => {
      const t = (await c.query('SELECT 1 FROM rapid_inv.container_type WHERE code=$1', [code])).rowCount;
      if (!t) throw new Error(`unknown container type ${code}`);
      const plan = (await c.query(
        `INSERT INTO rapid_inv.container_plan (name, container_code, supplier_code, eta_date, vessel, note, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
        [name, code, req.body.supplier_code || null, toISODate(req.body.eta_date) || null,
         req.body.vessel || null, req.body.note || null, actor])).rows[0];
      // O cubo e o peso são CONGELADOS aqui. A dimensão muda no Cin7 e um
      // plano fechado semana passada não pode se reescrever: quem embarcou
      // precisa ver o número em que baseou a decisão.
      const src = await c.query(
        `SELECT pl.id, pl.sku, pl.sku_key, pl.qty, cb.cbm_carton, cb.carton_qty, cb.kg_unit, cb.cube_source
           FROM rapid_inv.po_lines pl
           LEFT JOIN rapid_inv.v_sp_cube cb ON cb.sku_key = pl.sku_key
          WHERE pl.id = ANY($1)`, [ids]);
      let n = 0;
      for (const l of src.rows) {
        const cartons = (l.cbm_carton != null && l.carton_qty > 0)
          ? Math.ceil(Number(l.qty) / Number(l.carton_qty)) : null;
        await c.query(
          `INSERT INTO rapid_inv.container_plan_line
             (plan_id, po_line_id, sku_key, sku, qty, cbm_at_plan, kg_at_plan, cube_source, added_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (plan_id, po_line_id) DO NOTHING`,
          [plan.id, l.id, l.sku_key, l.sku, l.qty,
           cartons != null ? cartons * Number(l.cbm_carton) : null,
           l.kg_unit != null ? Number(l.qty) * Number(l.kg_unit) : null,
           l.cube_source || null, actor]);
        n += 1;
      }
      return { ...plan, lines: n };
    }, actor);
    res.json(out);
  }));

  app.delete(`${R}/container-plans/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const actor = actorOf(req);
    await db.tx(async (c) => c.query(
      `UPDATE rapid_inv.container_plan SET status='CANCELLED', updated_at=now(), updated_by=$2
        WHERE id=$1 AND status='DRAFT'`, [id, actor]), actor);
    res.json({ ok: true });
  }));

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

    if (db.mode() === 'rpc') return res.status(501).json({ error: 'Import de pedido ainda não habilitado no transporte por service key — rode a migration 029 (função rapid_inv dedicada). Máquinas com SUPABASE_DB_PASSWORD já fazem esta ação.' });
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
    // O selo tem de ser o MESMO das duas telas: quando elas discordam, a mesma
    // linha ganha aviso de compra numa e silêncio na outra.
    const [sold, lead] = await Promise.all([
      db.query(`SELECT sku_key,
                       sum(sold_qty) FILTER (WHERE week_ending > $2::date - 91) AS sold13,
                       sum(sold_qty) AS sold52
                  FROM rapid_inv.v_sp_history_week
                 WHERE sku_key = ANY($1) AND week_ending > $2::date - 364
                 GROUP BY 1`, [keys, state.reporting_week]),
      db.query(`SELECT sku_key, lead_weeks, review_weeks FROM rapid_inv.v_sp_sku_leadtime
                 WHERE sku_key = ANY($1)`, [keys]),
    ]);
    const soldIdx = sold.reduce((m, r) => (m[r.sku_key] = r, m), {});
    const leadIdx = lead.reduce((m, r) => (m[r.sku_key] = r, m), {});
    const index = (rows) => rows.reduce((m, r) => { (m[r.sku] = m[r.sku] || {})[r.week_ending] = Number(r.qty); return m; }, {});
    const drawIdx = index(draws), inIdx = index(incoming);

    // O escopo, quando pedido. Fora dele nada muda: a régua padrão continua
    // sendo a média digitada e o estoque somado.
    const scopeKey = String(req.query.scope || '').toUpperCase();
    const scope = SCOPES[scopeKey] || null;
    const scopeMonths = asInt(req.query.scope_months, 6, 1, 13);
    const sf = (scope && keys.length) ? await scopeFacts(scope.codes, keys, scopeMonths) : null;
    const allWeeks = weeks.map((wk, i) => ({ weekEnding: wk.week_ending, factor: Number(wk.factor), isReporting: i === 0 }));
    // A grade desenha o que o usuário pediu; o selo julga sempre na mesma régua.
    const engineWeeks = allWeeks.slice(0, horizon + 1);
    const badgeWeeks = allWeeks.slice(0, HORIZON_WEEKS + 1);
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
      const bd = badgeFor(s, proj, list, {
        sold: soldIdx[s.sku_key], lead: leadIdx[s.sku_key],
        badgeWeeks, incoming: inIdx[s.sku_key] || {}, draws: drawIdx[s.sku_key] || {},
      });
      // O corte MUDO: casca vazia, sem estoque, sem previsão, sem venda em 52
      // semanas, sem PO e sem draw. Validado campo a campo: 243 SKUs, ZERO
      // falso positivo. Note que ele NÃO pergunta o ciclo de vida — 125 dos 243
      // estão marcados ACTIVE, então filtrar por lifecycle erraria mais da
      // metade e ainda esconderia 29 SKUs que venderam de verdade.
      const muted = Number(s.soh_available) === 0 && !(Number(s.wk_avg) > 0)
                 && bd.sold52 === 0 && !proj.summary.totalIncoming
                 && !proj.summary.totalDraws && !Number(s.undated_qty || 0);
      bySku.set(s.sku_key, { ...facts, ...bd, muted,
        // Cada nome diz o que fazer. "Top up" é abaixo do alvo SEM zerar no
        // horizonte — chamá-lo de "nunca chega a zerar" seria falso, porque
        // parte dele zera logo depois da borda.
        segment: muted ? 'Dead SKUs'
               : bd.badge === 'ORDER NOW' || bd.badge === 'CHASE PO' ? 'Buy now'
               : bd.badge === 'NO FORECAST'  ? 'No forecast'
               : bd.badge === 'ORDER SOON'   ? 'Order soon'
               : bd.badge === 'FIX FORECAST' ? 'Fix record'
               // Vende e não zera no horizonte: é reposição de buffer, não compra.
               : bd.sold13 > 0 ? 'Top up'
               // Sem venda no trimestre com previsão viva, mas fora do ACTIVE:
               // o cadastro é que está desencontrado, não o estoque.
               : Number(s.wk_avg) > 0 ? 'Fix record'
               : 'Review',
        rank: Math.max(...list.map((a) => a.rank)), alerts: list });
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
    // Contado sobre o conjunto INTEIRO, antes de qualquer slice. O rodapé
    // dizia "and 400 more" quando faltavam 778.
    const bySegment = {};
    for (const s of skuList) bySegment[s.segment] = (bySegment[s.segment] || 0) + 1;
    const visible = skuList.filter((s) => !s.muted);
    res.json({
      total: all.length, skus: skuList.length, bySeverity, byCode,
      bySegment, muted_count: skuList.length - visible.length, visible_count: visible.length,
      bySupplier: Object.values(bySupplier).sort((a, b) => b.critical - a.critical || b.skus - a.skus),
      /* DOIS cortes, DOIS parâmetros. Eram um só: a tela pedia limit=1200
         para a lista de SKUs e com isso cortava também os alertas em 1.200 de
         3.479 — e como o corte é por rank decrescente, os 2.192 MEDIUM
         inteiros ficavam de fora. Os tiles (`byCode`) são somados sobre o
         conjunto INTEIRO e o filtro roda no navegador sobre a fatia: clicar em
         "Undated demand · 194" caía em "Nothing matches". */
      alerts: all.slice(0, asInt(req.query.alert_limit || req.query.limit, 4000, 1, 8000)),
      alerts_returned: Math.min(all.length, asInt(req.query.alert_limit || req.query.limit, 4000, 1, 8000)),
      // O mudo sai da LISTA, nunca da contagem: quem confere o número uma vez
      // e não fecha, para de confiar na tela.
      skuList: (req.query.muted === '1' ? skuList : visible).slice(0, asInt(req.query.limit, 3000, 1, 6000)),
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

    // O escopo, quando pedido. Fora dele nada muda: a régua padrão continua
    // sendo a média digitada e o estoque somado.
    const scopeKey = String(req.query.scope || '').toUpperCase();
    const scope = SCOPES[scopeKey] || null;
    const scopeMonths = asInt(req.query.scope_months, 6, 1, 13);
    const sf = (scope && keys.length) ? await scopeFacts(scope.codes, keys, scopeMonths) : null;
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
    const [byWeek, bySupplier, overdue, overdueTotal] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_week ORDER BY week_ending`),
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_supplier ORDER BY value_aud DESC NULLS LAST`),
      // 87 linhas atrasadas hoje, e o cartão logo acima da tabela diz "87".
      // Com LIMIT 60 as duas coisas na MESMA tela discordavam.
      db.query(`SELECT * FROM rapid_inv.v_sp_inbound_overdue ORDER BY due_date, po_number, sku LIMIT 400`),
      db.one(`SELECT count(*)::int n FROM rapid_inv.v_sp_inbound_overdue`),
    ]);
    res.json({ byWeek, bySupplier, overdue, overdue_total: Number(overdueTotal.n), ms: Date.now() - t0 });
  }));

  app.get(`${R}/overview/demand-book`, wrap(async (req, res) => {
    const t0 = Date.now();
    const [byWeek, tba, held, undated] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_demand_week ORDER BY week_ending LIMIT 60`),
      // 84 clientes com data por confirmar. LIMIT 40 escondia metade da
      // pergunta que a aba existe para responder.
      db.query(`SELECT * FROM rapid_inv.v_sp_tba_customer ORDER BY tba_units DESC, customer LIMIT 200`),
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
      /* `, sku_key` no ORDER BY não é enfeite: as linhas 120 e 121 empatam em
         abs(gap)=14,78, e sem desempate a mesma consulta pode devolver uma ou
         outra. Ordenar por abs(gap) também apagava uma classe inteira de
         veredito — "runs out earlier than the grid says" tem 53 linhas e só 2
         sobreviviam nas 120 primeiras. Por isso o default sobe para o
         conjunto todo (776 hoje) e o total viaja junto. */
      db.query(`SELECT * FROM rapid_inv.v_sp_wkavg_drift
                 WHERE typed > 0 AND reading IS NOT NULL AND reading <> 'in line'
                 ORDER BY abs(gap) DESC NULLS LAST, sku_key LIMIT $1`,
               [asInt(req.query.limit, 1000, 1, 3000)]),
    ]);
    const [age] = await db.query(`
      SELECT count(*) FILTER (WHERE days_since_touched > 180)::int stale_180,
             count(*) FILTER (WHERE days_since_touched > 365)::int stale_365,
             count(*) FILTER (WHERE reading IS NOT NULL AND reading <> 'in line')::int drift_total,
             round(avg(days_since_touched))::int avg_days
        FROM rapid_inv.v_sp_wkavg_drift WHERE typed > 0`);
    res.json({ summary, rows, total: Number(age.drift_total), age, window_weeks: 9, ms: Date.now() - t0 });
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
      // 280 linhas com dinheiro parado. Mostrar 150 sem dizer de quantas é
      // esconder metade do dinheiro numa tela cujo assunto é o dinheiro.
      db.query(`SELECT * FROM rapid_inv.v_sp_dead_stock
                 WHERE soh_available > 0 ORDER BY stock_value_aud DESC, sku LIMIT $1`,
               [asInt(req.query.limit, 400, 1, 1500)]),
      db.query(`SELECT * FROM rapid_inv.v_sp_lifecycle_conflicts ORDER BY conflict, sku LIMIT 100`),
    ]);
    const [supplier] = [await db.query(`
      SELECT supplier_code, count(*)::int skus, sum(soh_available) units,
             round(sum(stock_value_aud)::numeric,0) value_aud
        FROM rapid_inv.v_sp_dead_stock WHERE soh_available > 0 AND supplier_code IS NOT NULL
       GROUP BY 1 ORDER BY value_aud DESC`)];
    const [{ total }] = await db.query(
      `SELECT count(*)::int total FROM rapid_inv.v_sp_dead_stock WHERE soh_available > 0`);
    res.json({ totals, rows, total, conflicts, supplier, ms: Date.now() - t0 });
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
      -- A venda REALIZADA entra na regra de compra: sem ela, a única coisa entre
      -- um SKU morto e um pedido de A$21.863 era alguém ter digitado 42 numa
      -- célula de Wk/Avg.
      --
      -- MATERIALIZED de propósito. Como LATERAL por linha, esta agregação rodava
      -- a v_sp_history_week (um FULL OUTER JOIN de três views) uma vez por SKU e
      -- a rota ia de 0,45 s para 15,7 s. É a mesma armadilha que já levou uma
      -- view deste módulo de 18,6 s para 276 ms.
      WITH hist AS MATERIALIZED (
        SELECT sku_key,
               sum(sold_qty) FILTER (WHERE week_ending > $${p.length + 1}::date - 91) AS sold13,
               sum(sold_qty) AS sold52
          FROM rapid_inv.v_sp_history_week
         WHERE week_ending > $${p.length + 1}::date - 364
         GROUP BY 1
      )
      SELECT s.*, lt.lead_weeks, lt.lead_source, lt.sd_weeks, lt.review_weeks,
             lt.moq_units, lt.carton_qty, v.unit_cost_aud,
             COALESCE(h.sold13, 0) AS sold13, COALESCE(h.sold52, 0) AS sold52
        FROM rapid_inv.v_sp_planning_skus s
        JOIN rapid_inv.v_sp_sku_leadtime lt ON lt.sku_key = s.sku_key
        LEFT JOIN rapid_inv.v_sp_sku_cost v ON v.sku_key = s.sku_key
        LEFT JOIN hist h ON h.sku_key = s.sku_key
       WHERE ${where.join(' AND ')}`, [...p, state.reporting_week]);
    if (!skus.length) return res.json({ rows: [], total: 0, ms: Date.now() - t0 });

    // O horizonte agora é DECISÃO, não resíduo. Antes ele saía deste max() sobre
    // todos os candidatos, o que dava 28 — e quem fixava esse 28 era um SKU só.
    // Se a mediana de lead daquele fornecedor andasse duas semanas, dentro do
    // desvio dela, 74 SKUs mudariam de segmento sem que nada tivesse mudado
    // neles. Pior: a grade e os alertas usavam 26, e o descasamento produzia 45
    // linhas com aviso de compra ao lado de "not in horizon" em verde.
    const skipped = [];
    const todayWk = weekEnding(new Date());
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

    // O escopo, quando pedido. Fora dele nada muda: a régua padrão continua
    // sendo a média digitada e o estoque somado.
    const scopeKey = String(req.query.scope || '').toUpperCase();
    const scope = SCOPES[scopeKey] || null;
    const scopeMonths = asInt(req.query.scope_months, 6, 1, 13);
    const sf = (scope && keys.length) ? await scopeFacts(scope.codes, keys, scopeMonths) : null;
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

      // REGRA 0 — nada de comprar o que não vende. Medido: 27 SKUs sem uma
      // única venda em 52 semanas recebiam sugestão, A$46.602, sendo A$21.863
      // num só (R1076-BK-15W-CW-24: Wk/Avg 42 digitado, zero venda em toda a
      // série). Eles saem da lista de compra e viram problema de cadastro.
      const neverSold = Number(s.sold52) === 0;
      // GATE do erro de digitação. O motor já detecta draw absurdo (LARGE_DRAW),
      // mas a regra de compra vencia esse detector em 15 linhas, A$74.268 —
      // R2352-WW-V2 tem Wk/Avg 0,25, vendeu 6 unidades em 52 semanas, carrega
      // 208 de draw (832× a média) e o motor pedia 199. Aqui o detector vence:
      // o pedido é calculado sobre um número que ninguém conferiu.
      const suspectDraw = buildAlerts(s.sku, proj, { todayWeek: todayWk })
        .some((a) => a.code === 'LARGE_DRAW');

      const val = Math.round(suggested * Number(s.unit_cost_aud || 0));
      if (neverSold)    { skipped.push({ sku: s.sku, why: 'never_sold',   qty: suggested, value: val }); continue; }
      if (suspectDraw)  { skipped.push({ sku: s.sku, why: 'suspect_draw', qty: suggested, value: val }); continue; }
      rows.push({
        sku: s.sku, sku_key: s.sku_key, supplier: s.supplier_code,
        sold13: Number(s.sold13), sold52: Number(s.sold52),
        soh: sf ? sqty : Number(s.soh_available), on_order: Number(s.soh_on_order),
        // O que o escopo trocou, dito por linha — para a tela poder mostrar o
        // número do arquivo ao lado e o planejador ver a diferença.
        ...(sf ? {
          scope_wk: sd ? Math.round(sd.wk * 100) / 100 : 0,
          scope_soh: sqty,
          scope_by_loc: sd ? sd.by_loc : 0,
          scope_by_rep: sd ? sd.by_rep : 0,
          file_wk: s.wk_avg == null ? null : Number(s.wk_avg),
          file_soh: Number(s.soh_available),
        } : {}),
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
    // O modo BOM mostra só os montados que estão no arquivo de planejamento
    // (is_planned). Dizer 225 sem dizer de quantos seria truncar em silêncio.
    const bomAll = req.query.view === 'bom'
      ? (await db.query('SELECT count(DISTINCT parent_key)::int n FROM rapid_inv.product_bom'))[0].n
      : null;

    res.json({
      bom_universe: bomAll,
      scope: scope ? {
        key: scopeKey, label: scope.label, codes: scope.codes, months: scopeMonths,
        // O PO chega no Main e é distribuído depois — não há uma única alocação
        // de PO por filial gravada (medido: 0 de 1.466 linhas em aberto). Então
        // no escopo de filial a coluna Incoming é do Main, e dizer isso é o que
        // impede o planejador de contar como se já fosse dele.
        incoming_is_main: scopeKey !== 'MAIN' && scopeKey !== 'NETWORK',
      } : null,
      scopes: Object.entries(SCOPES).map(([k, v]) => ({ key: k, label: v.label })),
      reporting_week: state.reporting_week, horizon_weeks: maxWeeks, uncovered_skus: uncovered,
      // Barrar em silêncio é o mesmo pecado do truncamento: o total tem de
      // aparecer, com o motivo e o dinheiro que ele representa.
      skipped: skipped.sort((a, b) => b.value - a.value),
      skipped_value: skipped.reduce((n, x) => n + x.value, 0),
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
    // Teto e total juntos. Um LIMIT sem o total ao lado é uma lista que se
    // apresenta como completa — 1.330 linhas hoje contra teto de 2.000, e no
    // dia em que passar ninguém fica sabendo.
    const [rows, [{ total }]] = await Promise.all([
      db.query(`SELECT * FROM rapid_inv.v_sp_incoming_branch ${w}
                 ORDER BY week_ending, branch_code, sku LIMIT 2000`, p),
      db.query(`SELECT count(*)::int total FROM rapid_inv.v_sp_incoming_branch ${w}`, p),
    ]);
    // Array quando cabe inteiro: os consumidores de hoje esperam array e não
    // podem quebrar. Passando do teto, vira objeto e quem ler `.length` recebe
    // undefined em vez de um número errado — falha alto, não em silêncio.
    res.json(rows.length < 2000 ? rows : { rows, total, truncated: true });
  }));

  console.log('✅ Stock Planning routes montadas em /api/stock-planning');
}

module.exports = { register };
