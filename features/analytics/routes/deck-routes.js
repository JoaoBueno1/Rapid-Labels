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
 *   PRONTO     o dado está no banco e o bloco monta agora
 *   CONECTAR   existe no Cin7, num arquivo ou no TMS, falta sincronizar
 *   CONSTRUIR  ninguém registra isso; é preciso passar a capturar
 *   MANUAL     é julgamento de pessoa e vai continuar sendo
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
    add({ n: 2, titulo: 'PROJECTS — Sales', estado: 'PRONTO', tipo: 'kpi+tabelas',
          kpi: { rotulo: `Vendas de projeto · ${rotulo}`, valor: proj.venda, sub: `${proj.pedidos} pedidos · ex-GST` },
          tabelas: [
            { titulo: '% do total de cada rep vindo de projeto', cols: ['Rep', '%', 'Venda PR'], linhas: freq.map((r) => [r.rep, r.pct == null ? '—' : r.pct + '%', r.venda_pr]) },
            { titulo: 'Top 10 categorias', cols: ['Categoria', 'Venda'], linhas: cats.map((r) => [r.categoria, r.venda]) },
            { titulo: 'Top 10 SKUs', cols: ['SKU', 'Qty', 'Venda'], linhas: skus.map((r) => [r.sku, r.qty, r.venda]) },
          ] });

    add({ n: '2b', titulo: 'Crescimento contra o mesmo mês do ano passado', estado: 'CONECTAR',
          nota: 'cin7_mirror.sales_history_line começa em agosto/2025 — julho/2025 não existe. Faltam os 12 exports "Sale Order Details" anteriores.' });

    /* ── 3 · PROJECTS — Open Orders ───────────────────────────────── */
    const [abertos, idade] = await Promise.all([
      db.query(`SELECT coalesce(nullif(btrim(rep),''), '(sem rep)') rep,
                       count(DISTINCT sales_order)::int pedidos,
                       round(sum(qty * coalesce(unit_price,0))::numeric, 2) valor,
                       round(sum(coalesce(qty_inv,0) * coalesce(unit_price,0))::numeric, 2) faturado,
                       round(sum(coalesce(qty_to_pick,0) * coalesce(unit_price,0))::numeric, 2) restante
                  FROM rapid_inv.v_sp_lines WHERE project_status = 'ACTIVE'
                 GROUP BY 1 ORDER BY 3 DESC`),
      db.one(`SELECT max(imported_at) AS quando,
                     (current_date - max(imported_at)::date)::int AS dias
                FROM rapid_inv.import_batches`).catch(() => ({ quando: null, dias: null })),
    ]);
    add({ n: 3, titulo: 'PROJECTS — Open Orders', estado: 'PRONTO', tipo: 'tabela',
          // A idade do import fica na tela. É a única ressalva desta fonte, e
          // escondê-la faria um número de agosto passar por número de hoje.
          aviso: idade && idade.dias != null
            ? `Vem do arquivo de planejamento, importado há ${idade.dias} dia(s). Sem um import novo, este número não anda.`
            : null,
          kpi: { rotulo: 'Total de pedidos em aberto', valor: abertos.reduce((a, r) => a + r.pedidos, 0), formato: 'int' },
          tabelas: [{ cols: ['Rep', 'Pedidos', '$ Pedido', "$ Faturado", '$ Restante'],
                      linhas: abertos.map((r) => [r.rep, r.pedidos, r.valor, r.faturado, r.restante]) }] });

    add({ n: '3b', titulo: 'Variação contra o mês anterior', estado: 'CONSTRUIR',
          nota: 'A captura mensal foi ligada em 29/08/2026. A primeira comparação sai no fechamento seguinte — é subtração entre duas fotos, e só existe a primeira.' });

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
    add({ n: 4, titulo: 'PROJECTS — Top 10 Pack & Hold por custo', estado: 'PRONTO', tipo: 'tabela',
          tabelas: [{ cols: ['SKU', 'Unidades', 'Custo'], linhas: ph.map((r) => [r.sku, r.qty, r.custo]) }] });
    add({ n: 5, titulo: 'PROJECTS — Pack and Hold Analysis', estado: 'PRONTO', tipo: 'tabela',
          nota: 'A coluna "Stock Type" (Indent / Stock / Disc.) do deck é classificação de pessoa e continua sendo digitada.',
          tabelas: [{ cols: ['Cliente', 'Obra', 'Média de dias', 'Unidades'],
                      linhas: phJobs.map((r) => [`${r.customer || ''}${r.rep ? ' — ' + r.rep : ''}`, r.job || '—', r.dias, r.qty]) }] });

    /* ── 7 · Container pipeline ───────────────────────────────────── */
    const pipe = await db.query(
      `SELECT due_date eta, coalesce(nullif(btrim(vessel),''), '(sem navio)') navio,
              string_agg(DISTINCT supplier_code, ', ') fornecedores,
              count(*)::int linhas, sum(qty)::int unidades,
              round(sum(value_aud)::numeric, 0) valor
         FROM rapid_inv.po_lines
        WHERE NOT coalesce(is_received, false) AND due_date IS NOT NULL
        GROUP BY 1, 2 ORDER BY 1 LIMIT 20`);
    add({ n: 7, titulo: 'CONTAINER PIPELINE — ETA', estado: 'PRONTO', tipo: 'tabela',
          nota: 'O campo "vessel" é texto livre: 108 valores distintos, incluindo "Rushed 21-Jul, was 30th Aug" e números de rastreio. Contar contêineres exige normalizar isso.',
          tabelas: [{ cols: ['ETA', 'Navio', 'Fornecedores', 'Linhas', 'Unidades', 'Valor'],
                      linhas: pipe.map((r) => [r.eta, r.navio, r.fornecedores, r.linhas, r.unidades, r.valor]) }] });

    /* ── 11 · Cost Out por armazém ────────────────────────────────── */
    const cogs = await db.query(
      `SELECT coalesce(location_name, '(sem local)') armazem,
              round(sum(cogs_amount)::numeric, 2) custo, count(*)::int pedidos
         FROM cin7_mirror.sales_orders
        WHERE invoice_date BETWEEN $1 AND $2 AND cogs_amount IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC NULLS LAST`, [ini, fim]);
    add({ n: 11, titulo: 'COST OUT por armazém', estado: 'PRONTO', tipo: 'tabela',
          nota: 'COGS real do ERP, não derivado de custo médio. Só existe de junho/2026 em diante.',
          tabelas: [{ cols: ['Armazém', 'Custo de saída', 'Pedidos'], linhas: cogs.map((r) => [r.armazem, r.custo, r.pedidos]) }] });

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
    add({ n: 16, titulo: 'PICK ANOMALIES — detecção', estado: 'PRONTO', tipo: 'kpi+serie',
          kpis: [
            { rotulo: 'Ordens analisadas', valor: pa.ordens, formato: 'int' },
            { rotulo: 'Taxa de anomalia', valor: pa.taxa, formato: 'pct' },
            { rotulo: 'Picks com anomalia', valor: pa.anomalias, formato: 'int' },
          ],
          serie: { titulo: 'Anomalias por semana', pontos: paSem.map((r) => ({ x: r.semana, y: r.anomalias })) } });
    add({ n: 17, titulo: 'PICK CORRECTIONS', estado: 'PRONTO', tipo: 'kpi',
          nota: 'O "85% auto-corrigido" do deck não reproduz: não existe marca de automático contra manual nas 795 correções — todas têm o mesmo user_email.',
          kpis: [
            { rotulo: 'Correções feitas', valor: corr.correcoes, formato: 'int' },
            { rotulo: 'Ordens corrigidas', valor: corr.ordens, formato: 'int' },
            { rotulo: 'SKUs envolvidos', valor: corr.skus, formato: 'int' },
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
    add({ n: 19, titulo: 'Stock on Hand por armazém', estado: 'PRONTO', tipo: 'tabela',
          nota: 'O valor vem da captura diária, com o custo congelado no dia. A venda é ex-GST.',
          tabelas: [{ cols: ['Armazém', 'Valor do estoque', 'Venda do mês', 'Meses de estoque'],
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
    add({ n: 21, titulo: 'Ghost Warehouse', estado: 'PRONTO', tipo: 'tabela',
          nota: 'Movimento só existe de 09/06/2026 em diante. A filial vem do bin, que é onde o Ghost guarda essa informação.',
          kpi: { rotulo: 'Ghost — total da empresa', valor: ghostTot ? ghostTot.valor : 0,
                 sub: ghostTot ? `${ghostTot.qty} unidades` : '' },
          tabelas: [{ cols: ['Filial', 'Qty in', 'Qty out', 'Custo in', 'Custo out', 'Qty total', 'Valor'],
                      linhas: ghost.map((r) => [r.filial, r.qty_in, r.qty_out, r.custo_in, r.custo_out, r.total_qty, r.valor]) }] });

    /* ── 24 e 25 · Produtos novos ─────────────────────────────────── */
    const [chegando, pedidos] = await Promise.all([
      db.query(`SELECT sku, po_number, finish_date, due_date, supplier_code
                  FROM rapid_inv.po_lines
                 WHERE vessel ILIKE 'NEW%' AND NOT coalesce(is_received,false)
                 ORDER BY finish_date NULLS LAST, sku LIMIT 30`),
      db.query(`SELECT sku, po_number, po_date, qty
                  FROM rapid_inv.po_lines
                 WHERE vessel ILIKE 'NEW%' AND po_date BETWEEN $1 AND $2
                 ORDER BY po_date, sku`, [ini, fim]),
    ]);
    add({ n: 24, titulo: 'New Products — a caminho', estado: 'PRONTO', tipo: 'tabela',
          nota: '"NEW" é convenção escrita à mão na coluna de navio. O mês que o deck publica é palpite do comprador — não é o finish_date nem o due_date.',
          tabelas: [{ cols: ['Produto', 'PO', 'Finish', 'Due', 'Fornecedor'],
                      linhas: chegando.map((r) => [r.sku, r.po_number, r.finish_date, r.due_date, r.supplier_code]) }] });
    add({ n: 25, titulo: `New Products — pedidos em ${rotulo}`, estado: 'PRONTO', tipo: 'tabela',
          tabelas: [{ cols: ['Produto', 'PO', 'Data', 'Qty'],
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
    add({ n: '27-30', titulo: 'Discontinued Items', estado: 'PRONTO', tipo: 'tabela',
          nota: 'O total do deck usa a lista de Excel do time, que é outra definição — combine qual vale antes de comparar. O "Value Cleared" mês a mês precisa da captura, que começou agora.',
          kpi: { rotulo: 'Descontinuado com estoque', valor: descTot ? descTot.valor : 0,
                 sub: descTot ? `${descTot.skus} SKUs` : '' },
          tabelas: [{ cols: ['Categoria', 'SKUs', 'Valor'], linhas: desc.map((r) => [r.categoria, r.skus, r.valor]) }] });

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
    add({ n: 31, titulo: 'Collections Collected', estado: 'PRONTO', tipo: 'tabela',
          nota: 'O "não faturado" é recalculado agora: pedido faturado depois deixa de contar, então ele muda com o tempo. Para o KPI ser estável precisa ser congelado no fechamento.',
          tabelas: [{ cols: ['Mês', 'Coletados', 'Sem fatura', '%'],
                      linhas: col.map((r) => [r.mes, r.total, r.sem_fatura,
                        r.total ? (100 * r.sem_fatura / r.total).toFixed(2) + '%' : '—']) }] });

    /* ── Os que ainda não têm de onde sair ────────────────────────── */
    const pendentes = [
      { n: 6,  titulo: 'CONTAINERS — recebidos vs reservados', estado: 'CONSTRUIR', nota: 'Ninguém registra a chegada. rapid_inv.container_plan tem o formato certo e está vazia; po_lines.is_received nunca foi marcado em 1.466 linhas.' },
      { n: 8,  titulo: 'MOVEMENT — Main ↔ Gateway', estado: 'CONSTRUIR', nota: 'A tabela public.gateway_daily existe e a digitação parou em 29/01/2026. Retomar o registro e guardar a tarifa por palete.' },
      { n: 9,  titulo: 'COST IN por armazém', estado: 'CONECTAR', nota: 'Precisa do relatório "Stock Movement Summary" do Cin7. Ele está solto na raiz do repo e o loader descartou as colunas de custo.' },
      { n: 10, titulo: 'COST IN — tendência do ano', estado: 'CONECTAR', nota: 'Sete exports mensais do mesmo relatório. stock_movements só começa em 09/06/2026.' },
      { n: 12, titulo: 'COST OUT — tendência do ano', estado: 'CONECTAR', nota: 'cogs_amount existe no ERP desde sempre; o espelho só puxou de junho. Backfill via API.' },
      { n: 13, titulo: 'BRANCH TRANSFERS — frete', estado: 'CONECTAR', nota: 'Custo de frete é do TMS, outro projeto Supabase. O espelho de transferências tem 6.722 de 50.210 linhas.' },
      { n: 14, titulo: 'NEW CARRIER — XFM', estado: 'CONECTAR', nota: 'Não existe transportadora em lugar nenhum deste banco. Nem o Cin7 traz: /saleList não tem campo de carrier nem de custo.' },
      { n: 15, titulo: 'NEW CARRIER — AusPost / StarTrack', estado: 'CONECTAR', nota: 'Mesma ligação do 14. public.deliveries_daily não separa transferência de filial e parou em 01/06/2026.' },
      { n: 18, titulo: 'Monthly Sales — este ano vs o anterior', estado: 'CONECTAR', nota: 'A coluna deste ano sai hoje; a do ano passado precisa dos CSVs anteriores a agosto/2025.' },
      { n: 20, titulo: 'Damaged / Faulty — abertura e fechamento', estado: 'CONSTRUIR', nota: 'O fechamento sai hoje. A abertura precisa da foto do dia anterior — a captura começou em 29/08/2026.' },
      { n: 22, titulo: 'Top 10 em estoque baixo em 6 meses', estado: 'CONSTRUIR', nota: 'Precisa de seis meses de saldo diário. A captura começou em 29/08/2026, então este slide existe a partir de fevereiro de 2027.' },
      { n: 23, titulo: 'Faulty — valor reclamado', estado: 'CONSTRUIR', nota: 'Não há tabela nem coluna de claim de garantia nos três schemas. "Value into Faulty" já sai; "Value Claimed" não.' },
      { n: 26, titulo: 'Weekly File', estado: 'CONECTAR', nota: 'É curadoria humana, não filtro: o proxy por SLA dá 379 onde o deck traz 77. Ou importa a planilha, ou escreve a regra com quem a preenche.' },
      { n: 32, titulo: 'Faulty WH — claims por fornecedor', estado: 'MANUAL', nota: 'Narrativa escrita. Sem tabela de claims, não há o que automatizar.' },
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
