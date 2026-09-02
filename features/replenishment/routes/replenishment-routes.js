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

  // ── Leitura sem senha de banco ──────────────────────────────────────────
  // Estas rotas nasceram falando direto com o Postgres, o que exigia
  // SUPABASE_DB_PASSWORD em cada máquina e na Vercel — e sem a variável a tela
  // caía no `catch` e trocava a régua do rep pela do local em silêncio.
  //
  // A agregação virou função no banco (features/replenishment/db/
  // 001_replenishment_rpc.sql) e a leitura passa por aqui, com a chave que o
  // repo já tem. Mesmo padrão do excel-sync, que funciona de qualquer máquina.
  const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

  const sbH = (schema, extra) => Object.assign(
    { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    schema ? { 'Accept-Profile': schema, 'Content-Profile': schema } : {}, extra || {});

  // O PostgREST devolve NO MÁXIMO 1000 linhas e NÃO avisa que cortou: a
  // resposta truncada é indistinguível de um resultado pequeno. branch-averages
  // do Sydney bate nesse teto hoje. Paginar aqui não é otimização, é correção —
  // e é o mesmo erro que já custou uma análise inteira no excel-sync.
  const PAGE = 1000;

  async function sbGet(path, schema) {
    const r = await fetch(`${SB}/rest/v1/${path}`,
      { headers: sbH(schema), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async function sbAll(path, schema) {
    const out = [];
    for (let off = 0; ; off += PAGE) {
      const sep = path.includes('?') ? '&' : '?';
      const b = await sbGet(`${path}${sep}limit=${PAGE}&offset=${off}`, schema);
      out.push(...b);
      if (b.length < PAGE) return out;
    }
  }

  async function sbRpc(fn, args) {
    const out = [];
    for (let off = 0, guarda = 0; guarda < 60; off += PAGE, guarda++) {
      const r = await fetch(`${SB}/rest/v1/rpc/${fn}?limit=${PAGE}&offset=${off}`,
        { method: 'POST', headers: sbH(null), body: JSON.stringify(args || {}),
          signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`Supabase rpc ${fn} ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const b = await r.json();
      if (!Array.isArray(b)) return b;
      out.push(...b);
      if (b.length < PAGE) return out;
    }
    return out;
  }

  async function sbPatch(path, schema, body) {
    const r = await fetch(`${SB}/rest/v1/${path}`,
      { method: 'PATCH', headers: sbH(schema, { Prefer: 'return=minimal' }),
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Supabase patch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

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
    /* LÊ DO ESPELHO, não do Cin7.
       O Cin7 Core não tem webhook de transferência — confirmado na conta (9
       webhooks registrados, nenhum de transfer) e na taxonomia da API. Por isso
       existe .github/workflows/cin7-transfers-sync.yml, que já traz OPEN +
       recém-modificadas para cin7_mirror.stock_transfers de 2 em 2 horas.
       Perguntar ao Cin7 aqui gastava cota — 60/min para a aplicação inteira —
       para obter o que já estava em casa, e só quando alguém abria a tela.

       E lia `Page=1&Limit=100`: uma transferência aberta que saísse das 100 mais
       recentes nunca mais era relida, e o status dela congelava para sempre.
       O espelho não tem essa borda — a consulta é por TaskID. */
    let lista;
    try {
      const ids = abertos.map((r) => `"${String(r.cin7_task_id).replace(/"/g, '')}"`).join(',');
      lista = await sbAll(`stock_transfers?select=task_id,number,status,completion_date,synced_at`
        + `&task_id=in.(${ids})`, 'cin7_mirror');
    } catch (e) {
      // Falhar aqui NÃO pode esconder o histórico. Devolve o que há em banco,
      // e cada linha diz quando foi lida pela última vez — que é o que impede
      // um status velho de passar por atual.
      return rows.map((r) => ({ ...r, cin7_refresh_error: e.message }));
    }
    const porTask = lista.reduce((m, t) => (m[String(t.task_id).toLowerCase()] =
      { Status: t.status, CompletionDate: t.completion_date, SyncedAt: t.synced_at }, m), {});
    const mudou = [];
    for (const r of abertos) {
      const t = porTask[String(r.cin7_task_id).toLowerCase()];
      if (!t || t.Status === r.cin7_status) continue;
      mudou.push({ id: r.id, status: t.Status, done: t.CompletionDate ? String(t.CompletionDate).slice(0, 10) : null,
                   at: t.SyncedAt || new Date().toISOString() });
    }
    if (mudou.length) {
      for (const m of mudou) {
        /* O carimbo e o synced_at do ESPELHO, nao a hora em que esta pagina o
           leu. Carimbar `agora` diria "lido agora" para um dado que pode ter
           duas horas — que e exatamente a armadilha que esta coluna existe para
           impedir (ver db/023_transfer_status.sql). */
        await sbPatch(`replenishment_order?id=eq.${encodeURIComponent(m.id)}`, 'rapid_inv',
          { cin7_status: m.status, cin7_status_at: m.at, cin7_completed: m.done });
      }
    }
    // Carimba a hora da leitura em TODAS as que foram consultadas, inclusive
    // as que não mudaram: "lido agora e continua ORDERED" é informação, e sem
    // o carimbo ela ficaria indistinguível de "nunca foi lido".
    for (const r of abertos) {
      const t = porTask[String(r.cin7_task_id).toLowerCase()];
      if (!t || !t.SyncedAt || t.SyncedAt === r.cin7_status_at) continue;
      await sbPatch(`replenishment_order?id=eq.${encodeURIComponent(r.id)}&cin7_status=not.is.null`, 'rapid_inv',
        { cin7_status_at: t.SyncedAt });
    }
    const idx = mudou.reduce((m, x) => (m[x.id] = x, m), {});
    return rows.map((r) => {
      const t = porTask[String(r.cin7_task_id || '').toLowerCase()];
      if (!t) return r;
      return { ...r, cin7_status: idx[r.id] ? idx[r.id].status : (r.cin7_status || t.Status),
               cin7_completed: t.CompletionDate ? String(t.CompletionDate).slice(0, 10) : r.cin7_completed,
               cin7_status_at: t.SyncedAt || r.cin7_status_at };
    });
  }

  app.get(`${R}/orders`, wrap(async (req, res) => {
    const f = [];
    if (req.query.branch) f.push(`branch_code=eq.${encodeURIComponent(req.query.branch)}`);
    if (req.query.mode) f.push(`mode=eq.${encodeURIComponent(req.query.mode)}`);
    let rows = await sbGet(
      'replenishment_order?select=id,op_key,branch_code,branch_name,mode,week_ending,total_units,'
      + 'line_count,from_location,to_location,status,cin7_task_id,cin7_number,error,'
      + 'cin7_status,cin7_status_at,cin7_completed,created_by,created_at,ordered_at,lines'
      + (f.length ? '&' + f.join('&') : '')
      + '&order=created_at.desc&limit=200', 'rapid_inv');

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
   * Fonte: cin7_mirror.v_rp_demand (via as RPCs), uma UNION medida em 02/09:
   * history importada para order_date < 2026-07-01 (densa e congelada) e mirror
   * ao vivo (sale_lines ⋈ sales_orders) de lá para cá. A costura existe porque
   * o location_name/sales_rep do mirror hoje é 100% (o viés cronológico que
   * antes desaconselhava este caminho foi corrigido no mirror), mas o sale_lines
   * só ficou DENSO a partir de jun/2026 — puxar 6/12 meses direto do mirror
   * subcontaria abr–mai pela metade. Ver o cabeçalho de db/001 para os números.
   *
   * Devolve a cobertura junto do número de propósito: sem ela o planejador lê
   * uma média de agosto como mês cheio quando o mês ainda está correndo.
   */
  app.get(`${R}/averages`, wrap(async (req, res) => {
    const months = asInt(req.query.months, 6, 1, 13);
    const location = (req.query.location || '').trim();
    const [rows, cover, spanRows] = await Promise.all([
      sbRpc('replenishment_averages', { p_months: months, p_location: location || null }),
      sbGet('v_cin7_sales_history_coverage?select=ym,linhas,pedidos,skus,reps,qty'
            + '&order=ym.desc&limit=13', 'public'),
      sbRpc('replenishment_span', {}),
    ]);
    const span = spanRows[0] || {};

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
    const rows = await sbRpc('replenishment_reps', { p_months: months });

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
    const saved = await sbAll('sales_rep_branch?select=*', 'rapid_inv');
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

    /* Tudo numa ida só: a tela desenha o painel das duas réguas antes da
       primeira linha da grade, e não pode pagar três round-trips para isso.

       `quebra` é o que torna a régua do rep AUDITÁVEL. Dizer "pelos reps desta
       filial dá 18.900" sem dizer QUAIS reps somaram isso é pedir para o
       usuário confiar num número que ele não pode conferir — e ele é a única
       pessoa que sabe se falta alguém na lista.

       `orfaos` devolve zero hoje (a alocação foi fechada em 28/08/2026). Está
       aqui para o dia em que entrar gente nova: rep não alocado some da régua
       da filial em silêncio, e a soma encolhe sem motivo visível. */
    const [rows, quebra, orfaos, spanRows] = await Promise.all([
      // O FULL OUTER JOIN vive na função do banco agora. O `for` que reinseria
      // os SKUs que a filial vendeu pelo local sem nenhum rep dela ter tocado
      // virou parte do JOIN: mesma resposta, uma volta a menos, e a regra deixa
      // de estar escrita em dois lugares.
      sbRpc('replenishment_branch_averages',
        { p_branch: branch, p_months: months, p_location: location || null }),
      sbRpc('replenishment_branch_reps', { p_branch: branch, p_months: months }),
      sbRpc('replenishment_reps_orphan', { p_months: months }),
      // Janela de datas destas médias, para o user conferir no Cin7. Falhar aqui NÃO derruba
      // o endpoint (a tela só não mostra o range) — por isso o .catch.
      sbRpc('replenishment_span').catch(() => null),
    ]);
    /* _rp_window(months) = date_trunc('month', última venda) - (months-1) meses, ATÉ a última
       venda. Reproduzido em aritmética de string (sem Date) para não escorregar de fuso — a
       regra do repo é não deixar o fuso mexer numa data-calendário. */
    let windowObj = null;
    const span = spanRows && spanRows[0];
    if (span && span.last_day) {
      const to = String(span.last_day).slice(0, 10);
      const [y, m] = to.split('-').map(Number);
      const idx = (y * 12 + (m - 1)) - (Math.max(months, 1) - 1);
      windowObj = { from: `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`, to };
    }

    /* Os dois totais somados AQUI e não no navegador, pelo mesmo motivo de
       sempre: se a tela somar o que recebeu, ela mede a página e chama de
       total. Aqui `rows` é o conjunto inteiro, então a soma é a soma. */
    const soma = (campo) => rows.reduce((a, r) => a + Number(r[campo] || 0), 0);
    const conta = (campo) => rows.filter((r) => Number(r[campo] || 0) > 0).length;

    res.json({
      branch, months, location: location || null,
      window: windowObj,
      rep_count: quebra.length,
      reps: quebra.map((r) => r.sales_rep),      // compatível com quem já lia
      rep_breakdown: quebra,
      orphans: orfaos,
      totals: {
        loc_skus: conta('loc_avg'), loc_units: Math.round(soma('loc_avg')),
        rep_skus: conta('rep_avg'), rep_units: Math.round(soma('rep_avg')),
      },
      rows,
    });
  }));

  /** TODAS as filiais num passe só — a régua (loc_avg + rep_avg) de cada filial,
   *  para os cartões da tela inicial. Uma chamada em vez de sete: a mesma
   *  atribuição da por-filial (rep→filial via sales_rep_branch, local→filial via
   *  warehouses), agregada de uma vez na função do banco. NÃO traz breakdown de
   *  reps, órfãos nem janela — isso é da tela da filial aberta, que recarrega a
   *  sua sozinha. Medido: 1 chamada (~1,1s, todas) contra 7 concorrentes (~5,3s). */
  app.get(`${R}/all-branch-averages`, wrap(async (req, res) => {
    const months = asInt(req.query.months, 6, 1, 13);
    // db.query (sp_exec: UMA chamada, jsonb_agg) e NÃO sbRpc: o sbRpc pagina de
    // 1000 em 1000 e o PostgREST RE-EXECUTA a função inteira a cada página —
    // 9.399 linhas = 10 páginas = ~12s. Uma chamada só resolve em ~1s.
    const rows = await db.query('SELECT * FROM public.replenishment_all_branch_averages($1)', [months]);
    res.json({ months, rows: rows || [] });
  }));

  /** BOM: os componentes de cada assembly (bom_type='Assembly'), para a UI
   *  desenhar as sub-linhas e o export mandar componentes em vez do montado.
   *  Lê rapid_inv.product_bom via sp-db (rapid_inv NÃO é exposto no PostgREST —
   *  mesma ponte que o stock-planning usa). Só a ESTRUTURA (pai→componente×qtd);
   *  a UI enriquece com estoque/avg/locator que já tem carregado. Carton sai
   *  aqui (o grosso); os poucos ctn/pk a UI corta com isPackSku. */
  app.get(`${R}/bom-map`, wrap(async (req, res) => {
    const rows = await db.query(
      `SELECT parent_key, component_key, component_sku, quantity
         FROM rapid_inv.product_bom
        WHERE bom_type = 'Assembly'
          AND parent_sku !~* 'carton'
        ORDER BY parent_key, component_key`, []);
    res.json({ rows: rows || [] });
  }));

  /** O detalhe de um SKU numa filial: quem vendeu, quanto, e por qual local. */
  app.get(`${R}/sku-detail`, wrap(async (req, res) => {
    const sku = (req.query.sku || '').trim().toUpperCase();
    const branch = (req.query.branch || '').trim().toUpperCase();
    const months = asInt(req.query.months, 6, 1, 13);
    if (!sku) return res.status(400).json({ error: 'sku é obrigatório' });
    const [byRep, byLoc] = await Promise.all([
      sbRpc('replenishment_sku_by_rep', { p_sku: sku, p_months: months }),
      sbRpc('replenishment_sku_by_location', { p_sku: sku, p_months: months }),
    ]);
    res.json({ sku, branch, months, by_rep: byRep, by_location: byLoc });
  }));

  /** Gravar a alocação. Um rep por chamada — é decisão, não importação. */
  app.put(`${R}/reps/:rep`, wrap(async (req, res) => {
    const rep = req.params.rep;
    const { branch_code, note, is_active, inferred } = req.body || {};
    const actor = (req.get('x-sp-user') || req.body?._as || 'anon').toString().slice(0, 120);
    // Um upsert do PostgREST (Prefer: resolution=merge-duplicates) substitui a
    // LINHA INTEIRA, e o SQL original de propósito não fazia isso: no conflito
    // ele mexe em cinco colunas e deixa inferred_branch/pct/orders como
    // estavam. Sobrescrever apagaria a inferência que a tela mostra ao lado da
    // decisão humana — justamente o par que permite ver quando discordam.
    // Por isso: PATCH se já existe, POST se é a primeira vez.
    const chave = `sales_rep=eq.${encodeURIComponent(rep)}`;
    const existe = await sbGet(`sales_rep_branch?select=sales_rep&${chave}`, 'rapid_inv');
    const decisao = {
      branch_code: branch_code || null,
      note: note || null,
      is_active: typeof is_active === 'boolean' ? is_active : true,
      decided_by: actor,
      decided_at: new Date().toISOString(),
    };
    if (existe.length) {
      await sbPatch(`sales_rep_branch?${chave}`, 'rapid_inv', decisao);
    } else {
      const r = await fetch(`${SB}/rest/v1/sales_rep_branch`, {
        method: 'POST',
        headers: sbH('rapid_inv', { Prefer: 'return=minimal' }),
        body: JSON.stringify(Object.assign({ sales_rep: rep }, decisao, {
          inferred_branch: (inferred && inferred.branch) || null,
          inferred_pct: (inferred && inferred.pct) || null,
          inferred_orders: (inferred && inferred.orders) || null,
        })),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Supabase insert ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const [row] = await sbGet(`sales_rep_branch?select=*&${chave}`, 'rapid_inv');
    res.json({ ok: true, row });
  }));

  /* AVISO ALTO no boot, e não um erro por requisição.
     As duas réguas da tela saem daqui agora. Sem SUPABASE_URL ou sem chave,
     TODAS as médias vêm vazias — e uma filial sem média nenhuma parece "não há
     o que repor", que é indistinguível de estar tudo abastecido. Foi assim que
     uma máquina sem variável de ambiente passou por regressão de código.
     Falhar na inicialização, visível, é o único jeito de isso não voltar. */
  if (!SB || !SB_KEY) {
    console.warn('\n⚠️  Branch Replenishment: falta ' +
      [!SB && 'SUPABASE_URL', !SB_KEY && 'SUPABASE_SERVICE_KEY (ou SUPABASE_ANON_KEY)']
        .filter(Boolean).join(' e ') +
      '.\n    As médias por filial e por rep vão vir VAZIAS nesta máquina, e a tela\n' +
      '    vai parecer que não há nada a repor. Copie o .env antes de usar.\n');
  }

  console.log('✅ Branch Replenishment routes registered (Cin7 write: ORDERED only)'
    + (SB && SB_KEY ? '' : ' — SEM CREDENCIAL: médias vazias'));
}

module.exports = { register };
