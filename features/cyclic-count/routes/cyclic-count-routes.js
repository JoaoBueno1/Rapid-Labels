'use strict';
/**
 * API do Cyclic Count.
 *
 * Duas audiencias, dois regimes:
 *
 *   /api/cyclic-count/*        gestao. Roda no servidor com a service key.
 *   /api/cyclic-count/form/*   a filial, autenticada SO pelo token do link.
 *                              Nunca devolve nada de outra rodada.
 *
 * Escrita multi-statement vai para as funcoes rapid_inv.cc_* (migration 004):
 * o transporte sp_exec executa UMA statement por transacao, entao congelar
 * uma rodada aqui fora deixaria linha sem status ou status sem linha.
 */

const db = require('../../stock-planning/lib/sp-db');
const mailer = require('../lib/mailer');

/** Quem esta mexendo. Ainda nao ha login; o nome vai para o audit_log. */
const actorOf = (req) =>
  (req.get('x-sp-user') || req.query.as || req.body?._as || 'anon').toString().slice(0, 120);

const asInt = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? d : Math.min(Math.max(n, min), max);
};

/**
 * Qualquer data vira a SEGUNDA da sua semana.
 *
 * Aritmetica em UTC sobre 'YYYY-MM-DD' de proposito. Passar por Date local
 * em AEST (+10) recua um dia e transforma toda segunda em domingo — o mesmo
 * erro que ja colocou data errada no banco deste repo antes.
 */
function mondayOf(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay();          // 0=dom … 6=sab
  const back = (dow + 6) % 7;                   // segunda = 0
  return new Date(t - back * 86400000).toISOString().slice(0, 10);
}

/** A semana corrente, no relogio de Brisbane e nao no do servidor. */
function currentWeek() {
  const bne = new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
  return mondayOf(bne);
}

function register(app) {
  const R = '/api/cyclic-count';

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const msg = String(e.message || e);
      console.error('[cyclic-count]', req.method, req.path, msg);
      // As funcoes do banco levantam P0001 com mensagem escrita para gente ler
      // ("Faltam 3 de 44 itens sem contagem"). Devolver 500 com ela escondida
      // faria a tela dizer "erro inesperado" para uma regra de negocio comum.
      const isRule = /^(Rodada|Lista|Link|Esta contagem|Faltam|snapshot_source)/.test(msg);
      res.status(isRule ? 409 : 500).json({ error: msg });
    }
  };

  // ══ leitura de apoio ═════════════════════════════════════════════════

  app.get(`${R}/bootstrap`, wrap(async (req, res) => {
    const [branches, lists, fresh] = await Promise.all([
      db.query(`SELECT code, name FROM rapid_inv.warehouses WHERE cc_enabled ORDER BY name`, []),
      db.query(`SELECT l.id, l.code, l.name, l.is_active, l.notes, count(i.id)::int AS items
                  FROM rapid_inv.cc_list l
                  LEFT JOIN rapid_inv.cc_list_item i ON i.list_id = l.id
                 GROUP BY l.id ORDER BY l.is_active DESC, l.code`, []),
      db.query(`SELECT max(synced_at) AS synced_at FROM cin7_mirror.stock_snapshot`, []),
    ]);
    const syncedAt = fresh[0] && fresh[0].synced_at;
    res.json({
      branches, lists,
      week: currentWeek(),
      stock: freshness(syncedAt),
      mail: mailer.status(),
      refresh_available: ghReady(),
    });
  }));

  function freshness(syncedAt) {
    if (!syncedAt) return { synced_at: null, age_min: null };
    const age = Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000);
    return { synced_at: syncedAt, age_min: age };
  }

  app.get(`${R}/stock-freshness`, wrap(async (req, res) => {
    const r = await db.query(`SELECT max(synced_at) AS synced_at FROM cin7_mirror.stock_snapshot`, []);
    res.json(freshness(r[0] && r[0].synced_at));
  }));

  // ── Refresh do estoque, pelo caminho que ja existe ────────────────────
  //
  // O disparo precisa do numero do Cin7 no momento. Mas a chave do Cin7 e
  // COMPARTILHADA com o TMS, e o sync deste repo roda a 2,5s entre chamadas
  // com circuit breaker em 429 exatamente para proteger o TMS. Abrir um
  // segundo chamador aqui e o caminho para o 429 que derruba os dois.
  //
  // Alem disso, `vercel.json` limita esta funcao a 60s e um pull completo e
  // ~16 paginas x 2,5s = ~40s antes de escrever no banco. Nao cabe.
  //
  // Entao nao puxamos: pedimos ao workflow que ja faz isso de hora em hora
  // (cin7-sync.yml, que aceita workflow_dispatch) para rodar agora, e a tela
  // acompanha a idade do espelho ate cair.
  const GH_REPO = process.env.CC_GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const GH_TOKEN = process.env.CC_GH_TOKEN || process.env.GH_TOKEN || '';
  const GH_WORKFLOW = process.env.CC_GH_WORKFLOW || 'cin7-sync.yml';
  const GH_REF = process.env.CC_GH_REF || 'main';
  const ghReady = () => Boolean(GH_REPO && GH_TOKEN);

  app.post(`${R}/stock-refresh`, wrap(async (req, res) => {
    if (!ghReady()) {
      return res.status(503).json({
        triggered: false,
        error: 'Refresh sob demanda nao configurado: faltam CC_GH_REPO e CC_GH_TOKEN.',
      });
    }
    const r = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: GH_REF }),
        signal: AbortSignal.timeout(15000),
      });
    if (r.status !== 204) {
      const t = await r.text();
      return res.status(502).json({ triggered: false, error: `GitHub ${r.status}: ${t.slice(0, 200)}` });
    }
    res.json({ triggered: true, workflow: GH_WORKFLOW });
  }));

  app.get(`${R}/skus`, wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const rows = await db.query(
      `SELECT upper(btrim(sku)) AS sku, name AS product_name, attribute1 AS sku_code,
              average_cost AS unit_cost_aud
         FROM cin7_mirror.products
        WHERE sku ILIKE $1 OR name ILIKE $1 OR attribute1 = $2
        ORDER BY (upper(btrim(sku)) = upper($2)) DESC, sku
        LIMIT 25`, [`%${q}%`, q]);
    res.json(rows);
  }));

  // ══ rodadas ══════════════════════════════════════════════════════════

  app.get(`${R}/rounds`, wrap(async (req, res) => {
    const week = req.query.week ? mondayOf(req.query.week) : null;
    const status = req.query.status ? String(req.query.status) : null;
    const branch = req.query.branch ? String(req.query.branch) : null;
    const limit = asInt(req.query.limit, 200, 1, 1000);
    const rows = await db.query(
      `SELECT * FROM rapid_inv.v_cc_round_summary
        WHERE ($1::date IS NULL OR week_start = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR branch_code = $3)
        ORDER BY week_start DESC, branch_name
        LIMIT $4`, [week, status, branch, limit]);
    res.json({ week, rounds: rows });
  }));

  app.get(`${R}/rounds/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const head = await db.one(`SELECT * FROM rapid_inv.v_cc_round_summary WHERE round_id = $1`, [id]);
    if (!head) return res.status(404).json({ error: 'Rodada nao encontrada' });
    const lines = await db.query(
      `SELECT id, sku, sku_code, product_name, sort_order, system_qty, unit_cost_aud,
              counted_qty, counted_at, explain_qty, explain_location, explain_ref,
              action, note, variance_qty, variance_value, unexplained_qty, unexplained_value
         FROM rapid_inv.cc_round_line WHERE round_id = $1 ORDER BY sort_order, sku`, [id]);
    const emails = await db.query(
      `SELECT kind, to_emails, status, error, sent_at, sent_by
         FROM rapid_inv.cc_email_log WHERE round_id = $1 ORDER BY sent_at DESC LIMIT 20`, [id]);
    res.json({ round: head, lines, emails });
  }));

  app.post(`${R}/rounds`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const week = mondayOf(req.body && req.body.week_start);
    const listId = asInt(req.body && req.body.list_id, 0, 1, 1e12);
    const due = req.body && req.body.due_date ? String(req.body.due_date).slice(0, 10) : null;
    const branches = Array.isArray(req.body && req.body.branches) && req.body.branches.length
      ? req.body.branches.map((b) => String(b).toUpperCase()) : null;
    if (!week) return res.status(400).json({ error: 'week_start invalido' });
    if (!listId) return res.status(400).json({ error: 'list_id obrigatorio' });

    const r = await db.one(
      `SELECT rapid_inv.cc_create_rounds($1::date, $2::bigint, $3::text[], $4::date, $5::text) AS r`,
      [week, listId, branches, due, actor], actor);
    res.json(Object.assign({ week_start: week }, r.r));
  }));

  // ── O DISPARO ─────────────────────────────────────────────────────────
  //
  // Congela, e so entao manda o e-mail. A ordem importa: se o e-mail falhar,
  // a folha ja existe e a filial ainda pode contar pelo link. Sao dois fatos
  // separados no board — status 'sent' e a coluna Emailed.
  const MAX_AGE = asInt(process.env.CC_MAX_SNAPSHOT_AGE_MIN, 90, 5, 1440);

  app.post(`${R}/rounds/:id/dispatch`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const force = Boolean(req.body && req.body.force);

    const fr = await db.query(`SELECT max(synced_at) AS synced_at FROM cin7_mirror.stock_snapshot`, []);
    const f = freshness(fr[0] && fr[0].synced_at);

    // Sem espelho nao ha snapshot. Disparar assim gravaria zero em tudo, e
    // uma rodada inteira de "faltou tudo" e pior que nao disparar.
    if (f.age_min == null) {
      return res.status(409).json({ error: 'Sem estoque no espelho do Cin7. Rode o sync antes.', stock: f });
    }
    if (f.age_min > MAX_AGE && !force) {
      return res.status(409).json({
        error: 'stale_stock', stock: f, max_age_min: MAX_AGE,
        message: `O estoque do espelho tem ${f.age_min} min. Atualize do Cin7 ou confirme o envio assim mesmo.`,
      });
    }

    const source = f.age_min <= MAX_AGE ? 'CIN7_REFRESH' : 'MIRROR';
    const d = await db.one(
      `SELECT rapid_inv.cc_dispatch_round($1::bigint, $2::text, $3::int, $4::text) AS r`,
      [id, source, f.age_min, actor], actor);

    const mail = await sendForRound(id, actor, 'DISPATCH');
    res.json({ dispatch: d.r, stock: f, mail });
  }));

  app.post(`${R}/rounds/:id/resend`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const st = await db.one(`SELECT status FROM rapid_inv.cc_round WHERE id = $1`, [id]);
    if (!st) return res.status(404).json({ error: 'Rodada nao encontrada' });
    if (st.status !== 'sent') {
      return res.status(409).json({ error: `Rodada esta em "${st.status}": so reenvia contagem aberta` });
    }
    res.json({ mail: await sendForRound(id, actor, 'REMINDER') });
  }));

  /**
   * Manda e registra. NUNCA lanca: a falha de e-mail vira linha em
   * cc_email_log e coluna vermelha no board, nao um 500 que faz o operador
   * disparar de novo e congelar a rodada duas vezes.
   */
  async function sendForRound(roundId, actor, kind) {
    let log = { ok: false, error: 'nao tentado' };
    try {
      const r = await db.one(
        `SELECT r.token, r.week_start, r.due_date, r.snapshot_at, r.branch_code,
                w.name AS branch_name, l.name AS list_name,
                (SELECT count(*) FROM rapid_inv.cc_round_line li WHERE li.round_id = r.id) AS lines
           FROM rapid_inv.cc_round r
           JOIN rapid_inv.cc_list l ON l.id = r.list_id
           LEFT JOIN rapid_inv.warehouses w ON w.code = r.branch_code
          WHERE r.id = $1`, [roundId]);
      if (!r) return { ok: false, error: 'Rodada nao encontrada' };

      const to = (await db.query(
        `SELECT email FROM rapid_inv.cc_recipient
          WHERE branch_code = $1 AND is_active ORDER BY email`, [r.branch_code])).map((x) => x.email);

      if (!to.length) {
        log = { ok: false, error: `Nenhum destinatario ativo para ${r.branch_code}` };
      } else {
        const msg = mailer.dispatchEmail({
          branchName: r.branch_name || r.branch_code,
          weekLabel: dmy(r.week_start),
          listName: r.list_name,
          lines: Number(r.lines) || 0,
          dueLabel: r.due_date ? dmy(r.due_date) : null,
          url: `${baseUrl()}/count/${r.token}`,
          snapshotLabel: bneStamp(r.snapshot_at),
        });
        log = await mailer.send({ to, subject: msg.subject, text: msg.text, html: msg.html });
        log.subject = msg.subject;
      }

      await db.query(
        `INSERT INTO rapid_inv.cc_email_log (round_id, kind, to_emails, subject, status, provider_id, error, sent_by)
         VALUES ($1, $2, $3::text[], $4, $5, $6, $7, $8)`,
        [roundId, kind, log.to || to || [], log.subject || null,
          log.ok ? 'SENT' : 'FAILED', log.providerId || null, log.ok ? null : String(log.error).slice(0, 500), actor],
        actor);

      if (log.ok) {
        await db.query(
          `UPDATE rapid_inv.cc_round SET sent_at = now(), sent_to = $2::text[] WHERE id = $1`,
          [roundId, log.to], actor);
      }
    } catch (e) {
      log = { ok: false, error: String(e.message || e) };
    }
    return log;
  }

  const BASE = (process.env.CC_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const baseUrl = () => BASE || 'https://rapid-labels.vercel.app';

  const dmy = (d) => {
    const s = String(d || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : s;
  };

  /** Hora de Brisbane COM o sufixo. Hora sem fuso numa rede de 3 fusos e adivinhacao. */
  const bneStamp = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const p = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} AEST`;
  };

  app.post(`${R}/rounds/:id/cancel`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const r = await db.one(
      `UPDATE rapid_inv.cc_round SET status = 'cancelled', updated_by = $2
        WHERE id = $1 AND status IN ('draft','dispatching','sent') RETURNING id, status`,
      [id, actor], actor);
    if (!r) return res.status(409).json({ error: 'So rascunho ou contagem aberta pode ser cancelada' });
    res.json(r);
  }));

  app.post(`${R}/rounds/:id/close`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const r = await db.one(`SELECT rapid_inv.cc_close_round($1::bigint, $2::text) AS r`, [id, actor], actor);
    res.json(r.r);
  }));

  /** A tratativa: as colunas Ghost / Movement / Action do workbook. */
  app.patch(`${R}/lines/:id`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const b = req.body || {};
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const txt = (v, n) => (v === '' || v == null ? null : String(v).slice(0, n));
    const act = txt(b.action, 32);
    if (act && !['MOVE_TO_GHOST', 'MOVE_FROM_GHOST', 'ADD_TO_STOCK', 'NONE'].includes(act)) {
      return res.status(400).json({ error: 'action invalida' });
    }
    const q = num(b.explain_qty);
    if (q != null && (isNaN(q) || q < 0)) {
      return res.status(400).json({ error: 'explain_qty e magnitude: nao aceita negativo' });
    }
    const r = await db.one(
      `UPDATE rapid_inv.cc_round_line li
          SET explain_qty = $2, explain_location = $3, explain_ref = $4,
              action = $5, note = $6, updated_by = $7
         FROM rapid_inv.cc_round r
        WHERE li.id = $1 AND r.id = li.round_id AND r.status IN ('submitted','review')
        RETURNING li.id, li.explain_qty, li.explain_location, li.explain_ref, li.action, li.note,
                  li.variance_qty, li.variance_value, li.unexplained_qty, li.unexplained_value`,
      [id, q, txt(b.explain_location, 60), txt(b.explain_ref, 60), act, txt(b.note, 500), actor], actor);
    if (!r) return res.status(409).json({ error: 'A tratativa so vale em rodada entregue ou em revisao' });
    res.json(r);
  }));

  // ══ listas ═══════════════════════════════════════════════════════════

  app.get(`${R}/lists`, wrap(async (req, res) => {
    res.json(await db.query(
      `SELECT l.id, l.code, l.name, l.notes, l.is_active, l.updated_at, l.updated_by,
              count(i.id)::int AS items
         FROM rapid_inv.cc_list l
         LEFT JOIN rapid_inv.cc_list_item i ON i.list_id = l.id
        GROUP BY l.id ORDER BY l.is_active DESC, l.code`, []));
  }));

  app.get(`${R}/lists/:id`, wrap(async (req, res) => {
    const id = asInt(req.params.id, 0, 1, 1e12);
    const list = await db.one(`SELECT * FROM rapid_inv.cc_list WHERE id = $1`, [id]);
    if (!list) return res.status(404).json({ error: 'Lista nao encontrada' });
    const items = await db.query(
      `SELECT i.id, i.sku, i.sku_code, i.sort_order, p.name AS product_name, c.unit_cost_aud
         FROM rapid_inv.cc_list_item i
         LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = upper(btrim(i.sku))
         LEFT JOIN rapid_inv.v_cc_sku_cost c ON c.sku = upper(btrim(i.sku))
        WHERE i.list_id = $1 ORDER BY i.sort_order, i.sku`, [id]);
    res.json({ list, items });
  }));

  app.post(`${R}/lists`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase().slice(0, 40);
    const name = String(b.name || '').trim().slice(0, 120);
    if (!code || !name) return res.status(400).json({ error: 'code e name sao obrigatorios' });
    const r = await db.one(
      `INSERT INTO rapid_inv.cc_list (code, name, notes, updated_by)
       VALUES ($1, $2, $3, $4) RETURNING id, code, name`,
      [code, name, String(b.notes || '').slice(0, 500) || null, actor], actor);
    res.json(r);
  }));

  app.patch(`${R}/lists/:id`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const b = req.body || {};
    const r = await db.one(
      `UPDATE rapid_inv.cc_list
          SET name = COALESCE($2, name), notes = COALESCE($3, notes),
              is_active = COALESCE($4, is_active), updated_by = $5
        WHERE id = $1 RETURNING id, code, name, notes, is_active`,
      [id, b.name ? String(b.name).slice(0, 120) : null,
        b.notes != null ? String(b.notes).slice(0, 500) : null,
        typeof b.is_active === 'boolean' ? b.is_active : null, actor], actor);
    if (!r) return res.status(404).json({ error: 'Lista nao encontrada' });
    res.json(r);
  }));

  app.post(`${R}/lists/:id/items`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const skus = (Array.isArray(req.body && req.body.skus) ? req.body.skus : [])
      .map((s) => String(s || '').trim().toUpperCase()).filter(Boolean).slice(0, 500);
    if (!skus.length) return res.status(400).json({ error: 'skus vazio' });
    // O "5DC" do workbook e products.attribute1 no Cin7 -- conferido: para
    // CAL-CLA348-L-WH o Excel traz 96853 e attribute1 traz 96853. NAO e o
    // barcode, que ali e o EAN (9349819011809). Vem do mirror porque digitar
    // 44 codigos a mao e onde nasce o codigo errado.
    const rows = await db.query(
      `INSERT INTO rapid_inv.cc_list_item (list_id, sku, sku_code, sort_order, updated_by)
       SELECT $1, s.sku, p.attribute1,
              COALESCE((SELECT max(sort_order) FROM rapid_inv.cc_list_item WHERE list_id = $1), 0)
                + row_number() OVER (ORDER BY s.ord),
              $3
         FROM unnest($2::text[]) WITH ORDINALITY AS s(sku, ord)
         LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = s.sku
       ON CONFLICT DO NOTHING
       RETURNING id, sku, sku_code, sort_order`, [id, skus, actor], actor);
    res.json({ added: rows.length, items: rows });
  }));

  app.delete(`${R}/lists/:id/items/:itemId`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const r = await db.one(
      `DELETE FROM rapid_inv.cc_list_item WHERE id = $1 AND list_id = $2 RETURNING id, sku`,
      [asInt(req.params.itemId, 0, 1, 1e12), asInt(req.params.id, 0, 1, 1e12)], actor);
    if (!r) return res.status(404).json({ error: 'Item nao encontrado' });
    res.json(r);
  }));

  app.post(`${R}/lists/:id/reorder`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const id = asInt(req.params.id, 0, 1, 1e12);
    const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
    if (!order.length) return res.status(400).json({ error: 'order vazio' });
    const r = await db.one(
      `SELECT rapid_inv.cc_reorder_list($1::bigint, $2::jsonb, $3::text) AS r`,
      [id, JSON.stringify(order), actor], actor);
    res.json(r.r);
  }));

  // ══ destinatarios ════════════════════════════════════════════════════

  app.get(`${R}/recipients`, wrap(async (req, res) => {
    res.json(await db.query(
      `SELECT r.id, r.branch_code, w.name AS branch_name, r.email, r.name, r.is_active
         FROM rapid_inv.cc_recipient r
         LEFT JOIN rapid_inv.warehouses w ON w.code = r.branch_code
        ORDER BY w.name, r.email`, []));
  }));

  app.post(`${R}/recipients`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body || {};
    const branch = String(b.branch_code || '').trim().toUpperCase();
    const email = String(b.email || '').trim().toLowerCase();
    if (!branch) return res.status(400).json({ error: 'branch_code obrigatorio' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'e-mail invalido' });
    const r = await db.one(
      `INSERT INTO rapid_inv.cc_recipient (branch_code, email, name, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (branch_code, lower(btrim(email)))
       DO UPDATE SET is_active = true, name = COALESCE(EXCLUDED.name, rapid_inv.cc_recipient.name),
                     updated_by = $4
       RETURNING id, branch_code, email, name, is_active`,
      [branch, email, String(b.name || '').slice(0, 120) || null, actor], actor);
    res.json(r);
  }));

  app.patch(`${R}/recipients/:id`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const b = req.body || {};
    const r = await db.one(
      `UPDATE rapid_inv.cc_recipient
          SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_by = $4
        WHERE id = $1 RETURNING id, branch_code, email, name, is_active`,
      [asInt(req.params.id, 0, 1, 1e12), b.name != null ? String(b.name).slice(0, 120) : null,
        typeof b.is_active === 'boolean' ? b.is_active : null, actor], actor);
    if (!r) return res.status(404).json({ error: 'Destinatario nao encontrado' });
    res.json(r);
  }));

  app.delete(`${R}/recipients/:id`, wrap(async (req, res) => {
    const actor = actorOf(req);
    const r = await db.one(`DELETE FROM rapid_inv.cc_recipient WHERE id = $1 RETURNING id, email`,
      [asInt(req.params.id, 0, 1, 1e12)], actor);
    if (!r) return res.status(404).json({ error: 'Destinatario nao encontrado' });
    res.json(r);
  }));

  // ══ historico — o que era o Stock Count Summary ═══════════════════════

  app.get(`${R}/history`, wrap(async (req, res) => {
    const branch = req.query.branch ? String(req.query.branch).toUpperCase() : null;
    const sku = req.query.sku ? String(req.query.sku).toUpperCase() : null;
    const from = req.query.from ? String(req.query.from).slice(0, 10) : null;
    const limit = asInt(req.query.limit, 2000, 1, 20000);
    res.json(await db.query(
      `SELECT branch_code, branch_name, week_start, list_code, sku, sku_code, product_name,
              system_qty, counted_qty, variance_qty, variance_value,
              explain_qty, explain_location, explain_ref, action,
              unexplained_qty, unexplained_value, status
         FROM rapid_inv.v_cc_sku_history
        WHERE ($1::text IS NULL OR branch_code = $1)
          AND ($2::text IS NULL OR upper(btrim(sku)) = $2)
          AND ($3::date IS NULL OR week_start >= $3)
        ORDER BY week_start DESC, branch_name, sku
        LIMIT $4`, [branch, sku, from, limit]));
  }));

  // ══ a filial, pelo token ═════════════════════════════════════════════
  //
  // Sem login de proposito: quem conta esta no armazem com o celular, e
  // exigir senha e o que faz a contagem parar. O token tem 128 bits.

  app.get(`${R}/form/:token`, wrap(async (req, res) => {
    const token = String(req.params.token || '').slice(0, 64);
    const r = await db.one(
      `SELECT r.id, r.status, r.week_start, r.due_date, r.snapshot_at, r.submitted_at, r.submitted_by,
              r.branch_code, w.name AS branch_name, l.name AS list_name, l.code AS list_code
         FROM rapid_inv.cc_round r
         JOIN rapid_inv.cc_list l ON l.id = r.list_id
         LEFT JOIN rapid_inv.warehouses w ON w.code = r.branch_code
        WHERE r.token = $1`, [token]);
    if (!r) return res.status(404).json({ error: 'Link invalido ou expirado' });

    // A filial NAO ve variancia nem dinheiro: ela ve o que o sistema tem e
    // digita o que contou. Comparar e decidir e trabalho de quem trata.
    const lines = await db.query(
      `SELECT id, sku, sku_code, product_name, sort_order, system_qty, counted_qty
         FROM rapid_inv.cc_round_line WHERE round_id = $1 ORDER BY sort_order, sku`, [r.id]);

    res.json({
      round: {
        status: r.status, week_start: r.week_start, due_date: r.due_date,
        branch_name: r.branch_name || r.branch_code, list_name: r.list_name, list_code: r.list_code,
        snapshot_at: r.snapshot_at, snapshot_label: bneStamp(r.snapshot_at),
        submitted_at: r.submitted_at, submitted_by: r.submitted_by,
        editable: r.status === 'sent',
      },
      lines,
    });
  }));

  app.post(`${R}/form/:token/save`, wrap(async (req, res) => {
    const token = String(req.params.token || '').slice(0, 64);
    const by = String((req.body && req.body.by) || '').slice(0, 120) || null;
    const counts = (req.body && req.body.counts) || {};
    if (typeof counts !== 'object' || Array.isArray(counts)) {
      return res.status(400).json({ error: 'counts invalido' });
    }
    const clean = {};
    for (const [k, v] of Object.entries(counts).slice(0, 1000)) {
      if (v === null || v === '') { clean[k] = null; continue; }
      const n = Number(v);
      if (!isFinite(n) || n < 0) return res.status(400).json({ error: `Quantidade invalida em ${k}` });
      clean[k] = n;
    }
    const r = await db.one(`SELECT rapid_inv.cc_save_counts($1::text, $2::jsonb, $3::text) AS r`,
      [token, JSON.stringify(clean), by], by || 'branch');
    res.json(r.r);
  }));

  app.post(`${R}/form/:token/submit`, wrap(async (req, res) => {
    const token = String(req.params.token || '').slice(0, 64);
    const by = String((req.body && req.body.by) || '').trim().slice(0, 120);
    if (!by) return res.status(400).json({ error: 'Diga quem contou antes de entregar' });
    const r = await db.one(`SELECT rapid_inv.cc_submit_round($1::text, $2::text) AS r`, [token, by], by);
    res.json(r.r);
  }));

  console.log('✅ Cyclic Count routes registered');
}

module.exports = { register, mondayOf, currentWeek };
