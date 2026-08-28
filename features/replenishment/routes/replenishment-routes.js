/**
 * Branch Replenishment — colocar o pedido no Cin7.
 *
 * Esta é a primeira escrita do módulo num ERP de produção, e a ordem das
 * operações importa mais que o código:
 *
 *   1. grava a INTENÇÃO no banco, com uma chave derivada do conteúdo do plano;
 *   2. só então chama o Cin7;
 *   3. grava o TaskID no instante em que ele volta, antes de qualquer outra coisa.
 *
 * O que isso protege: o duplo clique, o refresh no meio da chamada, e o timeout
 * que devolve erro DEPOIS de o Cin7 já ter criado o TR. Nos três a tela tenta de
 * novo — e sem a chave a segunda tentativa cria um segundo TR que ninguém pediu.
 *
 * Cria com Status ORDERED: a ordem existe, o estoque NÃO se move. É reversível,
 * dá para apagar no Cin7 sem acerto de inventário.
 */
'use strict';

const crypto = require('crypto');

const CIN7 = 'https://inventory.dearsystems.com/ExternalApi/v2';

// Local de propósito: o stock-planning tem a sua, e importar de lá acoplaria
// dois módulos por causa de quatro linhas.
const asInt = (v, d, min, max) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? d : Math.min(Math.max(n, min), max);
};

function register(app, db) {
  const R = '/api/replenishment';

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      console.error('[replenishment]', req.method, req.path, e.message);
      res.status(500).json({ error: e.message });
    }
  };

  const headers = () => ({
    'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
    'api-auth-applicationkey': process.env.CIN7_API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });

  /**
   * O armazém de verdade é o de nível raiz. Medido: são 1.420 locais, e nomes
   * como "Sydney" e "Melbourne" existem DUAS vezes — uma no topo e outra como
   * filho do armazém "Ghost". Escolher pelo nome sem olhar o pai mandaria a
   * transferência para o lugar errado.
   */
  let locCache = null;
  async function locations() {
    if (locCache) return locCache;
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const r = await fetch(`${CIN7}/ref/location?Page=${page}&Limit=500`, { headers: headers() });
      if (!r.ok) throw new Error(`ref/location HTTP ${r.status}`);
      const list = (await r.json()).LocationList || [];
      all.push(...list);
      if (list.length < 500) break;
      await new Promise((s) => setTimeout(s, 1100));
    }
    locCache = all;
    return all;
  }
  async function resolveLocation(name) {
    const all = await locations();
    const exact = all.filter((l) => l.Name === name);
    const top = exact.filter((l) => !l.ParentID);
    if (top.length === 1) return top[0];
    if (exact.length === 1) return exact[0];
    // Ambíguo é erro, nunca um palpite: um palpite errado aqui move estoque.
    throw new Error(`Local "${name}" resolve para ${exact.length} lugares (${top.length} de nível raiz) — recuso escrever sem certeza.`);
  }

  /** Onde o plano vira um TR. */
  app.post(`${R}/place`, wrap(async (req, res) => {
    const { branch_code, branch_name, mode, week_ending, lines, from_location } = req.body || {};
    const actor = (req.get('x-sp-user') || req.body?._as || 'anon').toString().slice(0, 120);

    if (!branch_code || !branch_name) return res.status(400).json({ error: 'branch_code e branch_name são obrigatórios' });
    if (mode !== 'weekly' && mode !== 'daily') return res.status(400).json({ error: 'mode tem de ser weekly ou daily' });

    // Só linhas com quantidade. Uma linha zerada no ERP é ruído que alguém vai
    // ter de limpar à mão depois.
    const clean = (Array.isArray(lines) ? lines : [])
      .map((l) => ({ sku: String(l.sku || '').trim(), qty: Math.round(Number(l.qty) || 0) }))
      .filter((l) => l.sku && l.qty > 0);
    if (!clean.length) return res.status(400).json({ error: 'nenhuma linha com quantidade' });

    const from = from_location || 'Main Warehouse';
    const opKey = crypto.createHash('sha256')
      .update(JSON.stringify([branch_code, mode, week_ending || '', clean.map((l) => [l.sku.toUpperCase(), l.qty]).sort()]))
      .digest('hex').slice(0, 40);

    // PASSO 1 — a intenção primeiro. ON CONFLICT DO NOTHING é o que transforma
    // o duplo clique num no-op em vez de num segundo TR.
    const totalUnits = clean.reduce((n, l) => n + l.qty, 0);
    const ins = await db.query(
      `INSERT INTO rapid_inv.replenishment_order
         (op_key, branch_code, branch_name, mode, week_ending, lines, total_units, line_count, from_location, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT (op_key) DO NOTHING
       RETURNING *`,
      [opKey, branch_code, branch_name, mode, week_ending || null, JSON.stringify(clean), totalUnits, clean.length, from, actor]);

    let row = ins[0];
    if (!row) {
      // Já existia. Se o Cin7 confirmou, devolve o mesmo TR e pronto.
      row = await db.one(`SELECT * FROM rapid_inv.replenishment_order WHERE op_key=$1`, [opKey]);
      if ((row.status === 'ORDERED' || row.status === 'DRAFT') && row.cin7_number) {
        return res.json({ ok: true, already: true, number: row.cin7_number, task_id: row.cin7_task_id, order_id: row.id });
      }
      // PENDING de uma tentativa que morreu no meio: se tem TaskID, o TR existe.
      if (row.cin7_task_id) {
        const g = await fetch(`${CIN7}/stockTransfer?TaskID=${row.cin7_task_id}`, { headers: headers() });
        if (g.ok) {
          const t = await g.json();
          await db.query(`UPDATE rapid_inv.replenishment_order SET status='ORDERED', cin7_number=$2, ordered_at=now() WHERE id=$1`,
            [row.id, t.Number || null]);
          return res.json({ ok: true, already: true, recovered: true, number: t.Number, task_id: row.cin7_task_id, order_id: row.id });
        }
      }
    }

    try {
      const [fromLoc, toLoc] = await Promise.all([resolveLocation(from), resolveLocation(branch_name)]);

      // ProductID vem do espelho. sku_key porque a aba PO's usa maiúsculas e as
      // outras minúsculas — casar com "=" já custou 312 unidades neste projeto.
      const keys = clean.map((l) => l.sku.toUpperCase());
      const prods = await db.query(
        `SELECT upper(btrim(sku)) AS k, id, sku FROM cin7_mirror.products WHERE upper(btrim(sku)) = ANY($1)`, [keys]);
      const byKey = prods.reduce((m, p) => (m[p.k] = p, m), {});
      const missing = clean.filter((l) => !byKey[l.sku.toUpperCase()]).map((l) => l.sku);
      if (missing.length) throw new Error(`SKU sem ProductID no espelho: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''}`);

      // TRAVA DE ESTOQUE. A quantidade é sempre em UNIDADES, e sai do Main:
      // pedir o que o Main não tem cria um TR que morre na separação e alguém
      // limpa à mão. Recusar aqui é mais barato que descobrir no galpão.
      const soh = await db.query(
        `SELECT upper(btrim(sku)) AS k, sum(available) AS qty
           FROM cin7_mirror.stock_snapshot
          WHERE location_name = $2 AND upper(btrim(sku)) = ANY($1)
          GROUP BY 1`, [keys, from]);
      const sohBy = soh.reduce((m, r) => (m[r.k] = Number(r.qty) || 0, m), {});
      const short = clean
        .map((l) => ({ sku: l.sku, want: l.qty, have: sohBy[l.sku.toUpperCase()] || 0 }))
        .filter((x) => x.want > x.have);
      if (short.length) {
        throw new Error(`${from} não tem o suficiente: `
          + short.slice(0, 5).map((x) => `${x.sku} pede ${x.want}, tem ${Math.floor(x.have)}`).join('; ')
          + (short.length > 5 ? ` (+${short.length - 5})` : ''));
      }

      // ProductID sempre, e SKU junto só como conferência legível: o match por
      // SKU do Cin7 é comprovadamente aproximado em pelo menos um endpoint
      // (?Sku=R-GPO2-WH devolve também R-GPO2-WH-V1), e isto é escrita em ERP.
      // Não existe campo de bin na linha — em nenhum dos dois estágios. Quando
      // alguém precisa registrar o bin, ele vai como texto em Comments, que é
      // convenção humana e o Cin7 não lê.
      const cin7Lines = clean.map((l) => ({
        ProductID: byKey[l.sku.toUpperCase()].id,
        SKU: byKey[l.sku.toUpperCase()].sku,
        TransferQuantity: l.qty,
        Comments: '',
      }));
      const reference = `Branch replenishment | ${branch_name} | ${mode}${week_ending ? ' | wk ' + week_ending : ''}`;

      await db.query(`UPDATE rapid_inv.replenishment_order
                         SET from_location_id=$2, to_location=$3, to_location_id=$4 WHERE id=$1`,
        [row.id, fromLoc.ID, toLoc.Name, toLoc.ID]);

      // PASSO 2 — o cabeçalho, VAZIO, com o estágio de pedido LIGADO.
      //
      // O array `Lines` do cabeçalho é a separação FÍSICA: é ele que faz o Cin7
      // validar disponibilidade contra o GUID exato do From, e a raiz do Main
      // tem 0 porque 406.569 das suas unidades estão em bins. Foi esse array
      // que produziu "Available quantity ... is 0, cannot transfer 10".
      //
      // SkipOrder tem default TRUE, e true significa "pule o pedido, vá direto
      // para a separação" — exatamente o caminho que quebra. Com false o
      // documento ganha o estágio de ordem, que aceita as linhas sem exigir
      // que o estoque esteja no nível do armazém. Medido: 7 de 7 transferências
      // ORDERED desta conta têm SkipOrder=false.
      const head = { Status: 'DRAFT', From: fromLoc.ID, To: toLoc.ID,
        CostDistributionType: 'Cost', InTransitAccount: '609',
        Reference: reference, SkipOrder: false, Lines: [] };
      let r = await fetch(`${CIN7}/stockTransfer`, { method: 'POST', headers: headers(), body: JSON.stringify(head) });
      let body = await r.text();
      if (!r.ok && /Lines/i.test(body)) {
        // Escada de fallback: a doc marca Lines como obrigatório, mas as
        // transferências reais têm []. Se o validador reclamar, some com a chave.
        delete head.Lines;
        r = await fetch(`${CIN7}/stockTransfer`, { method: 'POST', headers: headers(), body: JSON.stringify(head) });
        body = await r.text();
      }
      if (!r.ok) throw new Error(`Cin7 stockTransfer HTTP ${r.status}: ${body.slice(0, 300)}`);
      const out = JSON.parse(body);

      // PASSO 3 — o TaskID entra no banco IMEDIATAMENTE, antes da segunda
      // chamada. É o ponto de retomada: se o processo morrer entre as duas, a
      // próxima tentativa encontra o cabeçalho e não cria um TR órfão.
      await db.query(`UPDATE rapid_inv.replenishment_order
                         SET cin7_task_id=$2, cin7_number=$3, status='DRAFT', error=NULL
                       WHERE id=$1`, [row.id, out.TaskID || null, out.Number || null]);

      // PASSO 4 — as linhas, todas de uma vez, no estágio de pedido.
      // AUTHORISED é o que faz o cabeçalho virar ORDERED. Note que ORDERED
      // nunca é escrito: ele é o estado que o documento ASSUME quando a ordem
      // está autorizada e nada foi separado ainda. Medido nesta conta: uma
      // ordem chega a ter 66 linhas, então 46 cabem sem problema.
      const ord = await fetch(`${CIN7}/stockTransfer/order`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ TaskID: out.TaskID, Status: 'AUTHORISED', Lines: cin7Lines }),
      });
      const ordBody = await ord.text();
      if (!ord.ok) throw new Error(`Cin7 stockTransfer/order HTTP ${ord.status}: ${ordBody.slice(0, 300)} (cabeçalho ${out.Number} ficou criado — apagar no Cin7)`);

      // PASSO 5 — confere no próprio Cin7 em vez de assumir. ORDERED exige as
      // DUAS condições: ordem autorizada E nada separado. Só Order.Status não
      // basta — existem transferências IN TRANSIT e COMPLETED com AUTHORISED.
      const chk = await fetch(`${CIN7}/stockTransfer?TaskID=${out.TaskID}`, { headers: headers() });
      const fin = chk.ok ? await chk.json() : {};
      const status = fin.Status || 'DRAFT';

      await db.query(`UPDATE rapid_inv.replenishment_order
                         SET status=$2, ordered_at=now() WHERE id=$1`, [row.id, status]);

      res.json({ ok: true, number: out.Number, task_id: out.TaskID, cin7_status: status,
                 order_status: (fin.Order || {}).Status || null,
                 order_lines: ((fin.Order || {}).Lines || []).length,
                 pick_lines: (fin.Lines || []).length,
                 order_id: row.id, lines: clean.length, units: totalUnits });
    } catch (e) {
      await db.query(`UPDATE rapid_inv.replenishment_order SET status='FAILED', error=$2 WHERE id=$1`,
        [row.id, String(e.message).slice(0, 800)]);
      res.status(502).json({ error: e.message, order_id: row.id });
    }
  }));

  /** O histórico. Lê o snapshot gravado, nunca recalcula a partir do estoque de hoje. */
  app.get(`${R}/orders`, wrap(async (req, res) => {
    const p = [], where = ['1=1'];
    if (req.query.branch) { p.push(req.query.branch); where.push(`branch_code = $${p.length}`); }
    if (req.query.mode) { p.push(req.query.mode); where.push(`mode = $${p.length}`); }
    const rows = await db.query(
      `SELECT id, op_key, branch_code, branch_name, mode, week_ending, total_units, line_count,
              from_location, to_location, status, cin7_task_id, cin7_number, error,
              created_by, created_at, ordered_at, lines
         FROM rapid_inv.replenishment_order
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT 200`, p);
    res.json({ rows });
  }));

  /**
   * As médias, calculadas na janela que o usuário escolher.
   *
   * Fonte: cin7_mirror.v_sales_demand_line — 170.672 linhas, 13 meses
   * contíguos, sales_rep e location_name em 100%. NÃO usa sale_lines +
   * sales_orders: ali o location_name existe em 27,5% dos pedidos e o viés é
   * CRONOLÓGICO (0,9% em ago/25 contra 99,4% em jul/26), então uma "média de 6
   * meses" por aquele caminho seria "jun–ago/26" disfarçada.
   *
   * Devolve a cobertura junto do número de propósito: sem ela o planejador lê
   * uma média de agosto como mês cheio quando o mês ainda está correndo.
   */
  app.get(`${R}/averages`, wrap(async (req, res) => {
    const months = asInt(req.query.months, 6, 1, 13);
    const location = (req.query.location || '').trim();
    const p = [months];
    let where = `order_date >= (date_trunc('month', (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                                - ($1::int - 1) * interval '1 month')`;
    if (location) { p.push(location); where += ` AND location_name = $${p.length}`; }

    const [rows, cover, span] = await Promise.all([
      db.query(`
        SELECT sku_key, min(sku) AS sku, min(product_name) AS name,
               location_name,
               sum(qty_signed)                       AS qty,
               round(sum(qty_signed) / $1::numeric, 2) AS avg_month,
               count(DISTINCT order_number)          AS orders,
               count(DISTINCT to_char(order_date, 'YYYY-MM')) AS months_with_sales
          FROM cin7_mirror.v_sales_demand_line
         WHERE ${where}
         GROUP BY sku_key, location_name
        HAVING sum(qty_signed) <> 0
         ORDER BY sum(qty_signed) DESC
         LIMIT 4000`, p),
      db.query(`SELECT ym, linhas, pedidos, skus, reps, qty FROM public.v_cin7_sales_history_coverage
                 ORDER BY ym DESC LIMIT 13`),
      db.one(`SELECT min(order_date)::text AS first_day, max(order_date)::text AS last_day,
                     count(DISTINCT to_char(order_date,'YYYY-MM')) AS months
                FROM cin7_mirror.v_sales_demand_line`),
    ]);

    // O mês corrente quase nunca está fechado. Incluí-lo como mês cheio puxa a
    // média para baixo, e é o tipo de erro que ninguém percebe.
    const last = span.last_day || '';
    const partial = last.slice(0, 7) === new Date().toISOString().slice(0, 7);

    res.json({ months, location: location || null, rows, coverage: cover,
               span: { ...span, partial_month: partial, last_day: last } });
  }));

  /**
   * Qual filial cada sales rep atende.
   *
   * Não existe cadastro disso em lugar nenhum do banco — foi procurado, só há
   * colunas de texto livre. Tudo aqui é INFERIDO da venda, e por isso vem com
   * a segunda colocada e a contagem: mostrar só a primeira transforma um
   * 53% × 44% em fato.
   *
   * E um limite que vale para a coluna inteira: location_name é de onde a
   * mercadoria SAIU, não a filial do rep. 42,6% do despacho dos reps de Sydney
   * sai do Main — por isso todo rep de filial tem cauda em Main.
   */
  app.get(`${R}/reps`, wrap(async (req, res) => {
    const months = asInt(req.query.months, 13, 1, 13);
    const rows = await db.query(`
      WITH base AS (
        SELECT sales_rep, location_name, count(DISTINCT order_number) AS orders,
               max(order_date) AS last_order
          FROM cin7_mirror.v_sales_demand_line
         WHERE order_date >= (date_trunc('month', (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                              - ($1::int - 1) * interval '1 month')
         GROUP BY 1, 2),
      tot AS (SELECT sales_rep, sum(orders) AS total, max(last_order) AS last_order FROM base GROUP BY 1),
      rk AS (SELECT b.*, t.total, t.last_order AS rep_last,
                    row_number() OVER (PARTITION BY b.sales_rep ORDER BY b.orders DESC) AS pos
               FROM base b JOIN tot t ON t.sales_rep = b.sales_rep)
      SELECT r1.sales_rep AS rep, r1.location_name AS branch_1, r1.orders AS orders_1,
             round(100.0 * r1.orders / r1.total, 1) AS pct_1,
             r2.location_name AS branch_2, r2.orders AS orders_2,
             round(100.0 * COALESCE(r2.orders, 0) / r1.total, 1) AS pct_2,
             r1.total AS orders_total, r1.rep_last::date::text AS last_order
        FROM rk r1 LEFT JOIN rk r2 ON r2.sales_rep = r1.sales_rep AND r2.pos = 2
       WHERE r1.pos = 1
       ORDER BY r1.location_name, r1.total DESC`, [months]);

    // O limite inferior de Wilson a 95%. Sem ele, "54% de 144 pedidos" parece
    // uma alocação e é empate. O piso muda com a vantagem: 100% precisa de 6
    // pedidos, 60% precisa de 114.
    const wilson = (k, n) => {
      if (!n) return 0;
      const z = 1.96, ph = k / n;
      const d = 1 + z * z / n;
      const c = ph + z * z / (2 * n);
      const m = z * Math.sqrt((ph * (1 - ph) + z * z / (4 * n)) / n);
      return Math.max(0, (c - m) / d);
    };
    const today = new Date();
    const out = rows.map((r) => {
      const lb = wilson(Number(r.orders_1), Number(r.orders_total));
      const daysIdle = r.last_order ? Math.round((today - new Date(r.last_order)) / 864e5) : null;
      const notPerson = /^(api|rapid led|test)/i.test(r.rep) || !/\s/.test(String(r.rep).trim());
      const conf = notPerson ? 'not_a_person'
        : daysIdle != null && daysIdle > 120 ? 'inactive'
        : lb >= 0.5 && Number(r.orders_total) >= 30 ? 'high'
        : lb >= 0.5 ? 'medium' : 'low';
      return { ...r, wilson_lb: Math.round(lb * 1000) / 10, days_idle: daysIdle, confidence: conf };
    });
    res.json({ months, rows: out });
  }));

  console.log('✅ Branch Replenishment routes registered (Cin7 write: ORDERED only)');
}

module.exports = { register };
