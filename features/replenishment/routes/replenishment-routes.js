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
  /* Relê no Cin7 o estado das transferências que ainda podem mudar.
   *
   * UMA chamada cobre até 100 transferências (stockTransferList devolve
   * TaskID e Status de todas), então perguntar por transferência seria gastar
   * cota compartilhada — 60/min para a aplicação inteira, dividida com o TMS
   * e 16 workflows — para obter a mesma resposta.
   *
   * Só relê o que NÃO está num estado final. COMPLETED e VOIDED não voltam
   * atrás, e reperguntar por elas para sempre é chamada desperdiçada.
   */
  const FINAIS = new Set(['COMPLETED', 'VOIDED']);

  async function refrescarStatus(rows) {
    const abertos = rows.filter((r) => r.cin7_task_id && !FINAIS.has(r.cin7_status || ''));
    if (!abertos.length) return rows;
    let lista;
    try {
      const res = await fetch('https://inventory.dearsystems.com/ExternalApi/v2/stockTransferList?Page=1&Limit=100',
        { headers: headers(), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      lista = j.StockTransferList || j.StockTransfers || j.List || [];
    } catch (e) {
      // Falhar aqui NÃO pode esconder o histórico. Devolve o que há em banco,
      // e cada linha diz quando foi lida pela última vez — que é o que impede
      // um status velho de passar por atual.
      return rows.map((r) => ({ ...r, cin7_refresh_error: e.message }));
    }
    const porTask = lista.reduce((m, t) => (m[String(t.TaskID).toLowerCase()] = t, m), {});
    const mudou = [];
    for (const r of abertos) {
      const t = porTask[String(r.cin7_task_id).toLowerCase()];
      if (!t || t.Status === r.cin7_status) continue;
      mudou.push({ id: r.id, status: t.Status, done: t.CompletionDate ? String(t.CompletionDate).slice(0, 10) : null });
    }
    if (mudou.length) {
      await db.tx(async (c) => {
        for (const m of mudou) {
          await c.query(
            `UPDATE rapid_inv.replenishment_order
                SET cin7_status = $1, cin7_status_at = now(), cin7_completed = $2 WHERE id = $3`,
            [m.status, m.done, m.id]);
        }
      }, 'refresh-transfer-status');
    }
    // Carimba a hora da leitura em TODAS as que foram consultadas, inclusive
    // as que não mudaram: "lido agora e continua ORDERED" é informação, e sem
    // o carimbo ela ficaria indistinguível de "nunca foi lido".
    const idsLidos = abertos.filter((r) => porTask[String(r.cin7_task_id).toLowerCase()]).map((r) => r.id);
    if (idsLidos.length) {
      await db.tx(async (c) => c.query(
        `UPDATE rapid_inv.replenishment_order SET cin7_status_at = now()
          WHERE id = ANY($1) AND cin7_status IS NOT NULL`, [idsLidos]), 'stamp-transfer-read');
    }
    const idx = mudou.reduce((m, x) => (m[x.id] = x, m), {});
    return rows.map((r) => {
      const t = porTask[String(r.cin7_task_id || '').toLowerCase()];
      if (!t) return r;
      return { ...r, cin7_status: idx[r.id] ? idx[r.id].status : (r.cin7_status || t.Status),
               cin7_completed: t.CompletionDate ? String(t.CompletionDate).slice(0, 10) : r.cin7_completed,
               cin7_status_at: new Date().toISOString() };
    });
  }

  app.get(`${R}/orders`, wrap(async (req, res) => {
    const p = [], where = ['1=1'];
    if (req.query.branch) { p.push(req.query.branch); where.push(`branch_code = $${p.length}`); }
    if (req.query.mode) { p.push(req.query.mode); where.push(`mode = $${p.length}`); }
    let rows = await db.query(
      `SELECT id, op_key, branch_code, branch_name, mode, week_ending, total_units, line_count,
              from_location, to_location, status, cin7_task_id, cin7_number, error,
              cin7_status, cin7_status_at, cin7_completed,
              created_by, created_at, ordered_at, lines
         FROM rapid_inv.replenishment_order
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC LIMIT 200`, p);

    // `fresh=0` existe para quem só quer o registro sem gastar a cota do Cin7.
    if (req.query.fresh !== '0') rows = await refrescarStatus(rows);

    // Uma contagem do que foi escondido. Esconder em silêncio faria o usuário
    // procurar um pedido que ele sabe que existe e concluir que a tela perdeu.
    const cancelados = rows.filter((r) => FINAIS.has(r.cin7_status || '') && r.cin7_status === 'VOIDED').length;
    res.json({ rows, voided: cancelados });
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
    // A decisão humana entra por cima. A inferência continua no payload, ao
    // lado, para a tela poder mostrar as duas e sinalizar quando discordam.
    const saved = await db.query(`SELECT * FROM rapid_inv.sales_rep_branch`);
    const byRep = saved.reduce((m, r) => (m[r.sales_rep] = r, m), {});
    const withDecision = out.map((r) => {
      const d = byRep[r.rep];
      return { ...r,
        assigned_branch: d ? d.branch_code : null,
        assigned_note: d ? d.note : null,
        assigned_active: d ? d.is_active : null,
        decided_by: d ? d.decided_by : null,
        decided_at: d ? d.decided_at : null,
        decided: !!d };
    });
    res.json({ months, rows: withDecision, decided: saved.length });
  }));

  /**
   * A média por SKU de uma filial, pelas DUAS réguas, lado a lado.
   *
   *   por LOCAL — de onde a mercadoria saiu.
   *   por REP   — soma de todos os reps alocados àquela filial, sem olhar de
   *               onde saiu.
   *
   * A segunda existe porque a primeira tem um buraco medido: quando a filial
   * está sem estoque, o pedido despacha do Main, e a venda some da conta dela.
   * Medido em 6 meses: Brisbane vende 113.742 pela régua do rep contra 41.307
   * pela do local — +175%. Sydney +80%, Sunshine +50%. Já Cairns (+6%), Coffs
   * (+7%) e Hobart (+12%) quase não mudam, porque ficam longe demais para o
   * Main atender no lugar delas. O padrão é geográfico e confirma a causa.
   *
   * A régua do rep é a demanda da filial; a do local é o despacho. Para decidir
   * reposição, a que importa é a primeira.
   */
  app.get(`${R}/branch-averages`, wrap(async (req, res) => {
    const months = asInt(req.query.months, 6, 1, 13);
    const branch = (req.query.branch || '').trim().toUpperCase();
    const location = (req.query.location || '').trim();
    if (!branch) return res.status(400).json({ error: 'branch é obrigatório' });

    const reps = await db.query(
      `SELECT sales_rep FROM rapid_inv.sales_rep_branch WHERE branch_code = $1 AND is_active`, [branch]);
    const names = reps.map((r) => r.sales_rep);

    const win = `order_date >= (date_trunc('month', (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                                - ($1::int - 1) * interval '1 month')`;
    const [byRep, byLoc] = await Promise.all([
      names.length ? db.query(
        `SELECT sku_key, sum(qty_signed) AS qty, count(DISTINCT order_number) AS orders,
                count(DISTINCT sales_rep) AS reps
           FROM cin7_mirror.v_sales_demand_line
          WHERE ${win} AND sales_rep = ANY($2)
          GROUP BY 1`, [months, names]) : [],
      location ? db.query(
        `SELECT sku_key, sum(qty_signed) AS qty
           FROM cin7_mirror.v_sales_demand_line
          WHERE ${win} AND location_name = $2
          GROUP BY 1`, [months, location]) : [],
    ]);

    const loc = byLoc.reduce((m, r) => (m[r.sku_key] = Number(r.qty), m), {});
    const rows = byRep.map((r) => ({
      sku_key: r.sku_key,
      rep_avg: Math.round((Number(r.qty) / months) * 100) / 100,
      loc_avg: Math.round(((loc[r.sku_key] || 0) / months) * 100) / 100,
      orders: Number(r.orders), reps: Number(r.reps),
    }));
    // SKUs que a filial vendeu pelo local mas nenhum rep dela tocou: o inverso
    // do buraco, e vale aparecer para ninguém achar que a régua do rep é
    // sempre maior.
    for (const [k, q] of Object.entries(loc)) {
      if (!rows.some((x) => x.sku_key === k)) {
        rows.push({ sku_key: k, rep_avg: 0, loc_avg: Math.round((q / months) * 100) / 100, orders: 0, reps: 0 });
      }
    }
    res.json({ branch, months, rep_count: names.length, reps: names, rows });
  }));

  /** O detalhe de um SKU numa filial: quem vendeu, quanto, e por qual local. */
  app.get(`${R}/sku-detail`, wrap(async (req, res) => {
    const sku = (req.query.sku || '').trim().toUpperCase();
    const branch = (req.query.branch || '').trim().toUpperCase();
    const months = asInt(req.query.months, 6, 1, 13);
    if (!sku) return res.status(400).json({ error: 'sku é obrigatório' });
    const win = `order_date >= (date_trunc('month', (SELECT max(order_date) FROM cin7_mirror.v_sales_demand_line))
                                - ($2::int - 1) * interval '1 month')`;
    const [byRep, byLoc] = await Promise.all([
      db.query(`
        SELECT d.sales_rep, COALESCE(a.branch_code, '—') AS branch_code,
               sum(d.qty_signed) AS qty, count(DISTINCT d.order_number) AS orders,
               max(d.order_date)::date::text AS last_order
          FROM cin7_mirror.v_sales_demand_line d
          LEFT JOIN rapid_inv.sales_rep_branch a ON a.sales_rep = d.sales_rep
         WHERE d.sku_key = $1 AND ${win}
         GROUP BY 1, 2 HAVING sum(d.qty_signed) <> 0
         ORDER BY 3 DESC`, [sku, months]),
      db.query(`
        SELECT location_name, sum(qty_signed) AS qty
          FROM cin7_mirror.v_sales_demand_line
         WHERE sku_key = $1 AND ${win}
         GROUP BY 1 HAVING sum(qty_signed) <> 0 ORDER BY 2 DESC`, [sku, months]),
    ]);
    res.json({ sku, branch, months, by_rep: byRep, by_location: byLoc });
  }));

  /** Gravar a alocação. Um rep por chamada — é decisão, não importação. */
  app.put(`${R}/reps/:rep`, wrap(async (req, res) => {
    const rep = req.params.rep;
    const { branch_code, note, is_active, inferred } = req.body || {};
    const actor = (req.get('x-sp-user') || req.body?._as || 'anon').toString().slice(0, 120);
    const row = await db.one(`
      INSERT INTO rapid_inv.sales_rep_branch
        (sales_rep, branch_code, note, is_active, inferred_branch, inferred_pct, inferred_orders, decided_by, decided_at)
      VALUES ($1, $2, $3, COALESCE($4, true), $5, $6, $7, $8, now())
      ON CONFLICT (sales_rep) DO UPDATE
        SET branch_code = EXCLUDED.branch_code, note = EXCLUDED.note,
            is_active = EXCLUDED.is_active, decided_by = EXCLUDED.decided_by,
            decided_at = now()
      RETURNING *`,
      [rep, branch_code || null, note || null,
       typeof is_active === 'boolean' ? is_active : null,
       (inferred && inferred.branch) || null, (inferred && inferred.pct) || null,
       (inferred && inferred.orders) || null, actor]);
    res.json({ ok: true, row });
  }));

  console.log('✅ Branch Replenishment routes registered (Cin7 write: ORDERED only)');
}

module.exports = { register };
