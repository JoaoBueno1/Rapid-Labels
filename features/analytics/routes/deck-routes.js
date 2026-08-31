'use strict';
/**
 * O Inventory Report mensal, gerado.
 *
 * A tela anterior era uma central de análises que eu inventei: quatro abas
 * ("The Month", "Money Sitting Still", "Operations", "Release Now") com
 * cortes que ninguém pediu. O relatório de verdade já existe há sete meses,
 * tem 33 slides numa ordem estabelecida, e é montado à mão: export do Cin7 →
 * colado no Excel → printado no PowerPoint. Nos sete decks há 19 a 34 imagens
 * coladas contra 0 a 4 gráficos nativos.
 *
 * Então este arquivo não propõe análise nenhuma. Ele reproduz o deck, bloco a
 * bloco, na ordem dele — e diz, em cada bloco, se o número saiu do banco ou
 * se ainda não há de onde tirá-lo.
 *
 * OS QUATRO ESTADOS, decididos medindo os dados e não estimando:
 *   READY    o dado está no banco e o bloco monta agora
 *   CONNECT  existe no Cin7, num arquivo ou no TMS, falta sincronizar
 *   BUILD    ninguém registra isso; é preciso passar a capturar
 *   MANUAL   é julgamento de pessoa e vai continuar sendo
 *
 * Os rótulos ficam em inglês porque a tela é lida em inglês. Os comentários
 * seguem em português, que é a língua de quem mantém isto.
 *
 * TRÊS RÉGUAS QUE TIVE DE FIXAR, porque o próprio deck usa as duas versões em
 * tabelas diferentes e a diferença é de 10%:
 *
 *   GST — tudo aqui é EX-GST. Medido: o top-10 de SKU do deck de julho é
 *   ex-GST (DEK-ALBANY48-WH sai $34.433,30, que é $37.876,63 ÷ 1,1 exato) e a
 *   tabela de categoria do mesmo slide parece inc-GST. Escolher uma e dizer
 *   qual é melhor que herdar a inconsistência — e receita se reporta ex-GST.
 *
 *   OPEN ORDERS — vem de rapid_inv.v_sp_lines. A alternativa
 *   (cin7_mirror.sales_orders) está sincronizada de hoje, mas usa outro
 *   conjunto de nomes de vendedor; a v_sp_lines usa os nomes curtos do deck
 *   (Aaron, Adam, Alex) e casa linha a linha. O preço é que ela só atualiza
 *   quando alguém importa o Excel — então a idade do import vai NA TELA.
 *   Número velho e rotulado é melhor que número fresco que não bate.
 *
 *   PROJETOS — location_name ILIKE '%project%', que cobre Project Warehouse,
 *   BNE/CNS/SYD Project e SC- Project Warehouse.
 */
const db = require('../../stock-planning/lib/sp-db');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error('[deck]', req.path, e.message); res.status(500).json({ error: e.message }); }
};

// Ex-GST. Uma constante e não um número solto em oito queries: mudar de régua
// tem de ser uma edição, não oito.
const EXGST = 1.1;

function register(app) {
  const R = '/api/analytics/deck';

  /** O mês de referência: o último fechado, salvo se pedirem outro. */
  const mesDe = (q) => (/^\d{4}-\d{2}$/.test(q || '') ? `${q}-01` : null);

  app.get(`${R}`, wrap(async (req, res) => {
    const t0 = Date.now();
    const mes = mesDe(req.query.month);
    const [{ ini, fim, rotulo }] = await db.query(
      `SELECT m AS ini, (m + interval '1 month - 1 day')::date AS fim,
              to_char(m, 'FMMonth YYYY') AS rotulo
         FROM (SELECT coalesce($1::date, date_trunc('month', current_date - interval '1 month'))::date m) x`,
      [mes]);

    const blocos = [];
    const add = (o) => blocos.push(o);

    /* ── 2 · PROJECTS — Sales ─────────────────────────────────────── */
    const [proj, cats, skus, freq] = await Promise.all([
      db.one(`SELECT round(sum(total_gross)/${EXGST}::numeric, 2) venda,
                     count(DISTINCT order_number)::int pedidos
                FROM cin7_mirror.sales_history_line
               WHERE location_name ILIKE '%project%' AND invoice_date BETWEEN $1 AND $2`, [ini, fim]),
      db.query(`SELECT coalesce(p.category, '(sem categoria)') categoria,
                       round(sum(s.total_gross)/${EXGST}::numeric, 2) venda
                  FROM cin7_mirror.sales_history_line s
                  LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = s.sku_key
                 WHERE s.location_name ILIKE '%project%' AND s.invoice_date BETWEEN $1 AND $2
                 GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 10`, [ini, fim]),
      db.query(`SELECT sku, sum(quantity)::int qty,
                       round(sum(total_gross)/${EXGST}::numeric, 2) venda
                  FROM cin7_mirror.sales_history_line
                 WHERE location_name ILIKE '%project%' AND invoice_date BETWEEN $1 AND $2
                 GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 10`, [ini, fim]),
      // "% of Total Sales from PR" — por rep, a fatia que veio de projeto.
      db.query(`SELECT sales_rep rep,
                       round(100.0 * sum(total_gross) FILTER (WHERE location_name ILIKE '%project%')
                             / nullif(sum(total_gross), 0), 0)::int pct,
                       round(sum(total_gross) FILTER (WHERE location_name ILIKE '%project%')/${EXGST}::numeric, 0) venda_pr
                  FROM cin7_mirror.sales_history_line
                 WHERE invoice_date BETWEEN $1 AND $2 AND sales_rep IS NOT NULL
                 -- Só quem VENDEU projeto no mês. Sem este filtro entram 26
                 -- linhas, oito delas com traço em tudo — o deck traz 18, e
                 -- uma linha vazia numa tabela de ranking é ruído que faz o
                 -- olho procurar significado onde não há.
                 GROUP BY 1
                HAVING sum(total_gross) > 0
                   AND sum(total_gross) FILTER (WHERE location_name ILIKE '%project%') > 0
                 ORDER BY 2 DESC NULLS LAST`, [ini, fim]),
    ]);
    add({ n: 2, titulo: 'PROJECTS — Sales', estado: 'READY', tipo: 'kpi+tabelas',
          kpi: { rotulo: `Project sales · ${rotulo}`, valor: proj.venda, sub: `${proj.pedidos} orders · ex-GST` },
          tabelas: [
            { titulo: "Each rep's share of sales that came from projects", cols: ['Rep', '%', 'Project sales'], linhas: freq.map((r) => [r.rep, r.pct == null ? '—' : r.pct + '%', r.venda_pr]) },
            { titulo: 'Top 10 categories', cols: ['Category', 'Sales'], linhas: cats.map((r) => [r.categoria, r.venda]) },
            { titulo: 'Top 10 SKUs', cols: ['SKU', 'Qty', 'Sales'], linhas: skus.map((r) => [r.sku, r.qty, r.venda]) },
          ] });

    add({ n: '2b', titulo: 'Growth on the same month last year', estado: 'CONNECT',
          nota: 'The sales history only starts in August 2025, so July 2025 does not exist. It needs the twelve earlier "Sale Order Details" exports.' });

    /* ── 3 · PROJECTS — Open Orders ───────────────────────────────── */
    const [abertos, idade] = await Promise.all([
      db.query(`SELECT coalesce(nullif(btrim(rep),''), '(sem rep)') rep,
                       count(DISTINCT sales_order)::int pedidos,
                       round(sum(qty * coalesce(unit_price,0))::numeric, 2) valor,
                       round(sum(coalesce(qty_inv,0) * coalesce(unit_price,0))::numeric, 2) faturado,
                       round(sum(coalesce(qty_to_pick,0) * coalesce(unit_price,0))::numeric, 2) restante
                  FROM rapid_inv.v_sp_lines WHERE project_status = 'ACTIVE'
                 GROUP BY 1 ORDER BY 3 DESC`),
      // finished_at, não imported_at — a coluna tem outro nome e o catch
      // engolia o erro, então o aviso simplesmente nunca aparecia.
      db.one(`SELECT max(finished_at) AS quando,
                     (current_date - max(finished_at)::date)::int AS dias
                FROM rapid_inv.import_batches WHERE ok`).catch(() => ({ quando: null, dias: null })),
    ]);
    /* As grafias de rep são de gente digitando, e o relatório soma por elas.
       Medido: "ChrisC" e "Chris.C" são Chris Capper; "ChrisR" e "Chris R" são
       Chris Ryan — duas pessoas em quatro linhas. Juntar em silêncio seria
       decidir por quem monta o deck, então a tela AVISA e mantém como está. */
    const grafias = (() => {
      const chave = (r) => String(r.rep).toLowerCase().replace(/[^a-z]/g, '');
      const m = {};
      abertos.forEach((r) => (m[chave(r)] = (m[chave(r)] || []).concat(r.rep)));
      return Object.values(m).filter((v) => v.length > 1);
    })();

    add({ n: 3, titulo: 'PROJECTS — Open Orders', estado: 'READY', tipo: 'tabela',
          nota: grafias.length
            ? `The same person appears under more than one spelling and the totals split across them: ${
                grafias.map((g) => g.join(' / ')).join(' · ')}. Left as typed — merging them is a call for whoever owns the file.`
            : null,
          // A idade do import fica na tela. É a única ressalva desta fonte, e
          // escondê-la faria um número de agosto passar por número de hoje.
          aviso: idade && idade.dias != null
            ? `From the planning file, imported ${idade.dias} day(s) ago. Without a fresh import this number does not move.`
            : null,
          kpi: { rotulo: 'Total open orders', valor: abertos.reduce((a, r) => a + r.pedidos, 0), formato: 'int' },
          tabelas: [{ cols: ['Rep', 'Orders', '$ Ordered', '$ Invoiced', '$ Remaining'],
                      linhas: abertos.map((r) => [r.rep, r.pedidos, r.valor, r.faturado, r.restante]) }] });

    add({ n: '3b', titulo: 'Change against the previous month', estado: 'BUILD',
          nota: 'The monthly capture started on 29 Aug 2026. This is the difference between two snapshots, and only the first one exists so far.' });

    /* ── 4 e 5 · Pack & Hold ──────────────────────────────────────── */
    const [ph, phJobs] = await Promise.all([
      // O coalesce do custo não é opcional: v_sp_sku_cost cobre 393 das 615
      // linhas retidas e o average_cost cobre 602 — sozinha, a primeira
      // derrubaria um terço da tabela.
      db.query(`SELECT l.sku, sum(l.qty_held)::int qty,
                       round(sum(l.qty_held * coalesce(c.unit_cost_aud, p.average_cost, 0))::numeric, 2) custo
                  FROM rapid_inv.v_sp_lines l
                  LEFT JOIN rapid_inv.v_sp_sku_cost c ON c.sku_key = l.sku_key
                  LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = l.sku_key
                 WHERE l.qty_held > 0 GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 10`),
      // qty_held > 0 é obrigatório: sem ele, linha já faturada entra com
      // days_held = 0 e puxa a média do job para baixo.
      db.query(`SELECT customer, rep, reference job,
                       round(avg(days_held))::int dias, sum(qty_held)::int qty
                  FROM rapid_inv.v_sp_lines
                 WHERE qty_held > 0 AND project_status = 'ACTIVE'
                 GROUP BY 1,2,3 ORDER BY 4 DESC NULLS LAST LIMIT 10`),
    ]);
    add({ n: 4, titulo: 'PROJECTS — Top 10 Pack & Hold by cost', estado: 'READY', tipo: 'tabela',
          tabelas: [{ cols: ['SKU', 'Units', 'Cost'], linhas: ph.map((r) => [r.sku, r.qty, r.custo]) }] });
    // "Top 10" no título porque é o que a tabela é. O bloco 4, imediatamente
    // acima e com o mesmo LIMIT 10, já diz — e a diferença entre os dois
    // títulos fazia esta parecer a lista inteira dos 121 jobs.
    add({ n: 5, titulo: 'PROJECTS — Pack and Hold Analysis (top 10 jobs by units)', estado: 'READY', tipo: 'tabela',
          nota: 'The deck\'s "Stock Type" column (Indent / Stock / Disc.) is a human call and stays typed in.',
          tabelas: [{ cols: ['Customer', 'Job', 'Average days', 'Units'],
                      linhas: phJobs.map((r) => [`${r.customer || ''}${r.rep ? ' — ' + r.rep : ''}`, r.job || '—', r.dias, r.qty]) }] });

    /* ── 7 · Container pipeline ───────────────────────────────────── */
    const pipe = await db.query(
      `SELECT due_date eta, coalesce(nullif(btrim(vessel),''), '(sem navio)') navio,
              string_agg(DISTINCT supplier_code, ', ') fornecedores,
              count(*)::int linhas, sum(qty)::int unidades,
              round(sum(value_aud)::numeric, 0) valor
         FROM rapid_inv.po_lines
        WHERE NOT coalesce(is_received, false) AND due_date IS NOT NULL
        -- ORDER BY 1, 2 e sem LIMIT, pelos dois motivos ao mesmo tempo.
        -- O teto de 20 deixava A$5.666.432 de fora: 139 grupos reais contra 20
        -- mostrados, ETA ate dezembro contra 06/set na tela. E ordenar so pela
        -- data empata: ha 20 grupos no MESMO 2026-09-06, e duas execucoes no
        -- mesmo segundo devolveram conjuntos diferentes (134 linhas /
        -- A$698.828 contra 144 / A$584.082). E a classe do bug dos 37 SKUs de
        -- Sydney: sem desempate, o corte escolhe sozinho o que mostrar.
        GROUP BY 1, 2 ORDER BY 1, 2`);
    add({ n: 7, titulo: 'CONTAINER PIPELINE — ETA', estado: 'READY', tipo: 'tabela',
          nota: 'The vessel field is free text — 108 distinct values, including "Rushed 21-Jul, was 30th Aug" and tracking numbers. Counting containers needs that cleaned up first.',
          tabelas: [{ cols: ['ETA', 'Vessel', 'Suppliers', 'Lines', 'Units', 'Value'],
                      linhas: pipe.map((r) => [r.eta, r.navio, r.fornecedores, r.linhas, r.unidades, r.valor]) }] });

    /* ── 11 · Cost Out por armazém ────────────────────────────────── */
    const cogs = await db.query(
      `SELECT coalesce(location_name, '(sem local)') armazem,
              round(sum(cogs_amount)::numeric, 2) custo, count(*)::int pedidos
         FROM cin7_mirror.sales_orders
        WHERE invoice_date BETWEEN $1 AND $2 AND cogs_amount IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, [ini, fim]);
    add({ n: 11, titulo: 'COST OUT by warehouse', estado: 'READY', tipo: 'tabela',
          nota: 'Real COGS from the ERP, not derived from average cost. Only exists from June 2026 onwards.',
          tabelas: [{ cols: ['Warehouse', 'Cost out', 'Orders'], linhas: cogs.map((r) => [r.armazem, r.custo, r.pedidos]) }] });

    /* ── 16 e 17 · Pick anomalies ─────────────────────────────────── */
    const [pa, paSem, corr] = await Promise.all([
      db.one(`SELECT count(*)::int ordens, sum(total_picks)::int picks,
                     sum(anomaly_picks)::int anomalias,
                     count(*) FILTER (WHERE anomaly_picks > 0)::int sinalizadas,
                     round(100.0 * count(*) FILTER (WHERE anomaly_picks > 0) / nullif(count(*),0), 1) taxa
                FROM public.pick_anomaly_orders WHERE order_date BETWEEN $1 AND $2`, [ini, fim]),
      db.query(`SELECT date_trunc('week', order_date)::date semana,
                       count(*)::int ordens, sum(anomaly_picks)::int anomalias
                  FROM public.pick_anomaly_orders WHERE order_date BETWEEN $1 AND $2
                 GROUP BY 1 ORDER BY 1`, [ini, fim]),
      db.one(`SELECT count(*)::int correcoes, count(DISTINCT order_number)::int ordens,
                     count(DISTINCT sku)::int skus
                FROM public.pick_anomaly_corrections
               WHERE corrected_at::date BETWEEN $1 AND $2`, [ini, fim]),
    ]);
    add({ n: 16, titulo: 'PICK ANOMALIES — detection', estado: 'READY', tipo: 'kpi+serie',
          kpis: [
            { rotulo: 'Orders analysed', valor: pa.ordens, formato: 'int' },
            { rotulo: 'Anomaly rate', valor: pa.taxa, formato: 'pct' },
            { rotulo: 'Anomaly picks', valor: pa.anomalias, formato: 'int' },
          ],
          serie: { titulo: 'Anomalies per week', pontos: paSem.map((r) => ({ x: r.semana, y: r.anomalias })) } });
    add({ n: 17, titulo: 'PICK CORRECTIONS', estado: 'READY', tipo: 'kpi',
          nota: 'The deck\'s "85% auto-fixed" cannot be reproduced: nothing marks automatic against manual across the 795 corrections — they all carry the same user.',
          kpis: [
            { rotulo: 'Corrections made', valor: corr.correcoes, formato: 'int' },
            { rotulo: 'Orders corrected', valor: corr.ordens, formato: 'int' },
            { rotulo: 'SKUs involved', valor: corr.skus, formato: 'int' },
          ] });

    /* ── 19 · Stock on Hand por armazém ───────────────────────────── */
    const soh = await db.query(
      `WITH est AS (
         SELECT location, round(sum(value_at_cost)::numeric, 2) valor
           FROM rapid_inv.mr_soh_daily
          WHERE snapshot_date = (SELECT max(snapshot_date) FROM rapid_inv.mr_soh_daily)
          GROUP BY 1),
       vnd AS (
         SELECT location_name location, round(sum(total_gross)/${EXGST}::numeric, 2) venda
           FROM cin7_mirror.sales_history_line
          WHERE invoice_date BETWEEN $1 AND $2 GROUP BY 1)
       SELECT coalesce(e.location, v.location) armazem, e.valor, v.venda,
              round((e.valor / nullif(v.venda, 0))::numeric, 2) meses
         FROM est e FULL OUTER JOIN vnd v ON v.location = e.location
        WHERE coalesce(e.valor, 0) <> 0 OR coalesce(v.venda, 0) <> 0
        ORDER BY e.valor DESC NULLS LAST`, [ini, fim]);
    add({ n: 19, titulo: 'Stock on Hand by warehouse', estado: 'READY', tipo: 'tabela',
          nota: 'Value comes from the daily capture, with the cost frozen on the day. Sales are ex-GST.',
          tabelas: [{ cols: ['Warehouse', 'Stock value', 'Month sales', 'Months of stock'],
                      linhas: soh.map((r) => [r.armazem, r.valor, r.venda, r.meses]) }] });

    /* ── 21 · Ghost Warehouse ─────────────────────────────────────── */
    const ghost = await db.query(
      `WITH mv AS (
         SELECT coalesce(nullif(btrim(to_bin),''), nullif(btrim(from_bin),''), '(sem filial)') filial,
                sum(quantity) FILTER (WHERE to_location = 'Ghost')   qty_in,
                sum(quantity) FILTER (WHERE from_location = 'Ghost') qty_out,
                sum(quantity * coalesce(p.average_cost,0)) FILTER (WHERE to_location = 'Ghost')   custo_in,
                sum(quantity * coalesce(p.average_cost,0)) FILTER (WHERE from_location = 'Ghost') custo_out
           FROM cin7_mirror.stock_movements m
           LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = upper(btrim(m.sku))
          WHERE (m.to_location = 'Ghost' OR m.from_location = 'Ghost')
            AND m.detected_at::date BETWEEN $1 AND $2
          GROUP BY 1)
       SELECT filial, coalesce(qty_in,0)::int qty_in, coalesce(qty_out,0)::int qty_out,
              round(coalesce(custo_in,0)::numeric,2) custo_in,
              round(coalesce(custo_out,0)::numeric,2) custo_out,
              (coalesce(qty_in,0) - coalesce(qty_out,0))::int total_qty,
              round((coalesce(custo_in,0) - coalesce(custo_out,0))::numeric,2) valor
         FROM mv ORDER BY 7 DESC`, [ini, fim]);
    const [ghostTot] = await db.query(
      `SELECT round(sum(on_hand)::numeric,1) qty, round(sum(value_at_cost)::numeric,2) valor
         FROM rapid_inv.mr_soh_daily
        WHERE location = 'Ghost' AND snapshot_date = (SELECT max(snapshot_date) FROM rapid_inv.mr_soh_daily)`);
    add({ n: 21, titulo: 'Ghost Warehouse', estado: 'READY', tipo: 'tabela',
          nota: 'Movements only exist from 9 June 2026 onwards. The branch comes from the bin, which is where Ghost keeps it.',
          kpi: { rotulo: 'Ghost — company wide', valor: ghostTot ? ghostTot.valor : 0,
                 sub: ghostTot ? `${ghostTot.qty} units` : '' },
          tabelas: [{ cols: ['Branch', 'Qty in', 'Qty out', 'Cost in', 'Cost out', 'Total qty', 'Value'],
                      linhas: ghost.map((r) => [r.filial, r.qty_in, r.qty_out, r.custo_in, r.custo_out, r.total_qty, r.valor]) }] });

    /* ── 24 e 25 · Produtos novos ─────────────────────────────────── */
    const [chegando, pedidos] = await Promise.all([
      db.query(`SELECT sku, po_number, finish_date, due_date, supplier_code
                  FROM rapid_inv.po_lines
                 WHERE vessel ILIKE 'NEW%' AND NOT coalesce(is_received,false)
                 -- 60 linhas hoje; o bloco 25 logo abaixo já desenha 53. O
                 -- LIMIT 30 escondia metade dos produtos novos a caminho.
                 ORDER BY finish_date NULLS LAST, sku, po_number`),
      db.query(`SELECT sku, po_number, po_date, qty
                  FROM rapid_inv.po_lines
                 WHERE vessel ILIKE 'NEW%' AND po_date BETWEEN $1 AND $2
                 ORDER BY po_date, sku`, [ini, fim]),
    ]);
    add({ n: 24, titulo: 'New Products — coming', estado: 'READY', tipo: 'tabela',
          nota: '"NEW" is a hand-typed convention in the vessel column. The month the deck publishes is the buyer\'s call — it is neither the finish date nor the due date.',
          tabelas: [{ cols: ['Product', 'PO', 'Finish', 'Due', 'Supplier'],
                      linhas: chegando.map((r) => [r.sku, r.po_number, r.finish_date, r.due_date, r.supplier_code]) }] });
    add({ n: 25, titulo: `New Products — ordered in ${rotulo}`, estado: 'READY', tipo: 'tabela',
          tabelas: [{ cols: ['Product', 'PO', 'Date', 'Qty'],
                      linhas: pedidos.map((r) => [r.sku, r.po_number, r.po_date, r.qty]) }] });

    /* ── 27-30 · Descontinuados ───────────────────────────────────── */
    const [desc, descTot] = await Promise.all([
      db.query(`SELECT coalesce(p.category,'(sem categoria)') categoria,
                       count(DISTINCT d.sku_key)::int skus,
                       round(sum(d.value_at_cost)::numeric,2) valor
                  FROM rapid_inv.mr_soh_daily d
                  JOIN rapid_inv.sku_settings s ON s.sku_key = d.sku_key AND s.lifecycle_status = 'DISCONTINUED'
                  LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = d.sku_key
                 WHERE d.snapshot_date = (SELECT max(snapshot_date) FROM rapid_inv.mr_soh_daily)
                 GROUP BY 1 ORDER BY 3 DESC`),
      db.one(`SELECT count(DISTINCT d.sku_key)::int skus, round(sum(d.value_at_cost)::numeric,2) valor
                FROM rapid_inv.mr_soh_daily d
                JOIN rapid_inv.sku_settings s ON s.sku_key = d.sku_key AND s.lifecycle_status = 'DISCONTINUED'
               WHERE d.snapshot_date = (SELECT max(snapshot_date) FROM rapid_inv.mr_soh_daily)`),
    ]);
    add({ n: '27-30', titulo: 'Discontinued Items', estado: 'READY', tipo: 'tabela',
          nota: 'The deck\'s total uses the team\'s Excel list, which is a different definition — agree which one counts before comparing. The month-by-month "Value Cleared" needs the capture, which has just started.',
          kpi: { rotulo: 'Discontinued, still holding stock', valor: descTot ? descTot.valor : 0,
                 sub: descTot ? `${descTot.skus} SKUs` : '' },
          tabelas: [{ cols: ['Category', 'SKUs', 'Value'], linhas: desc.map((r) => [r.categoria, r.skus, r.valor]) }] });

    /* ── 31 · Collections ─────────────────────────────────────────── */
    const col = await db.query(
      `SELECT to_char(date_trunc('month', c.collected_at), 'Mon YYYY') mes,
              date_trunc('month', c.collected_at)::date ord,
              count(*)::int total,
              count(*) FILTER (WHERE o.order_number IS NOT NULL AND o.invoice_date IS NULL)::int sem_fatura
         FROM public.collections_history c
         LEFT JOIN cin7_mirror.sales_orders o ON upper(c.reference) = o.order_number
        WHERE c.collected_at >= date_trunc('month', current_date) - interval '8 months'
        GROUP BY 1,2 ORDER BY 2`);
    add({ n: 31, titulo: 'Collections Collected', estado: 'READY', tipo: 'tabela',
          nota: 'The uninvoiced count is recalculated live: an order invoiced later stops counting, so the number drifts. To be stable it has to be frozen at month end.',
          tabelas: [{ cols: ['Month', 'Collected', 'Uninvoiced', '%'],
                      linhas: col.map((r) => [r.mes, r.total, r.sem_fatura,
                        r.total ? (100 * r.sem_fatura / r.total).toFixed(2) + '%' : '—']) }] });

    /* ── Os que ainda não têm de onde sair ────────────────────────── */
    const pendentes = [
      { n: 6,  titulo: 'CONTAINERS — received vs booked', estado: 'BUILD', nota: 'Nobody records the arrival. The container plan table has the right shape and is empty, and is_received was never ticked on any of the 1,466 PO lines.' },
      { n: 8,  titulo: 'MOVEMENT — Main ↔ Gateway', estado: 'BUILD', nota: 'The gateway_daily table exists and data entry stopped on 29 Jan 2026. It needs the daily record resumed, and the per-pallet rate stored with it.' },
      { n: 9,  titulo: 'COST IN by warehouse', estado: 'CONNECT', nota: 'Needs the Cin7 "Stock Movement Summary" report. It is sitting loose in the repo root and the loader threw away the cost columns.' },
      { n: 10, titulo: 'COST IN — year to date', estado: 'CONNECT', nota: 'Seven monthly exports of the same report. Stock movements only start on 9 June 2026.' },
      { n: 12, titulo: 'COST OUT — year to date', estado: 'CONNECT', nota: 'COGS has always been in the ERP; the mirror only pulled it from June. Needs a backfill through the API.' },
      { n: 13, titulo: 'BRANCH TRANSFERS — freight', estado: 'CONNECT', nota: 'Freight cost lives in the TMS, a separate Supabase project. The transfer mirror holds 6,722 of 50,210 lines.' },
      { n: 14, titulo: 'NEW CARRIER — XFM', estado: 'CONNECT', nota: 'There is no carrier anywhere in this database, and Cin7 does not carry one either — the sale list has no carrier and no freight cost.' },
      { n: 15, titulo: 'NEW CARRIER — AusPost / StarTrack', estado: 'CONNECT', nota: 'Same connection as XFM. The deliveries table does not separate branch transfers and stopped on 1 June 2026.' },
      { n: 18, titulo: 'Monthly Sales — this year vs last', estado: 'CONNECT', nota: 'This year\'s column comes out today; last year\'s needs the CSV exports from before August 2025.' },
      { n: 20, titulo: 'Damaged / Faulty — opening and closing', estado: 'BUILD', nota: 'Closing comes out today. Opening needs the previous day\'s snapshot, and the capture started on 29 Aug 2026.' },
      { n: 22, titulo: 'Top 10 products on low stock over 6 months', estado: 'BUILD', nota: 'Needs six months of daily stock levels. The capture started on 29 Aug 2026, so this slide exists from February 2027.' },
      { n: 23, titulo: 'Faulty — value claimed', estado: 'BUILD', nota: 'There is no warranty-claim table or column anywhere. "Value into Faulty" already comes out; "Value Claimed" does not.' },
      { n: 26, titulo: 'Weekly File', estado: 'CONNECT', nota: 'This is human curation, not a filter: the closest SLA proxy returns 379 where the deck shows 77. Either import the spreadsheet, or write the rule with whoever fills it in.' },
      { n: 32, titulo: 'Faulty WH — claims by supplier', estado: 'MANUAL', nota: 'Written narrative. With no claims table there is nothing to automate.' },
    ];
    pendentes.forEach(add);

    // Na ordem do deck, sempre. É a ordem que a reunião segue.
    blocos.sort((a, b) => parseInt(String(a.n), 10) - parseInt(String(b.n), 10)
                       || String(a.n).localeCompare(String(b.n)));

    const contagem = blocos.reduce((m, b) => (m[b.estado] = (m[b.estado] || 0) + 1, m), {});
    res.json({ mes: { ini, fim, rotulo }, blocos, contagem, exgst: true, ms: Date.now() - t0 });
  }));
}

module.exports = { register };
