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

  console.log('✅ Branch Replenishment routes registered (Cin7 write: ORDERED only)');
}

module.exports = { register };
