-- ============================================================
-- Replenishment — as leituras como funções do banco
-- ============================================================
-- POR QUE ISTO EXISTE
--
-- As rotas de replenishment nasceram falando DIRETO com o Postgres, o que
-- exige SUPABASE_DB_PASSWORD. Toda máquina nova precisa da senha, a Vercel
-- precisa da senha, e sem ela a tela quebra em silêncio (a UI troca a régua do
-- rep pela do local no `catch`). Foi assim que 31/08 pareceu uma regressão do
-- fim de semana: era só a variável faltando no PC.
--
-- O motivo registrado no server.js — "o schema rapid_inv não é exposto via
-- PostgREST" — está errado. Está exposto: `rapid_inv.sales_rep_branch` e
-- `cin7_mirror.v_sales_demand_line` respondem hoje com a chave que o repo já
-- tem. O que a API REST não faz é AGREGAR: `qty_signed.sum()` volta
-- `PGRST123: Use of aggregate functions is not allowed`.
--
-- Então a agregação desce para cá. É exatamente o que
-- features/excel-sync/db/006_restock_suggestion.sql já faz há semanas, e é por
-- isso que a aba de Restock do Excel funciona de qualquer máquina sem
-- configurar nada.
--
-- Depois disto, replenishment não precisa de senha em lugar nenhum.
--
-- O SQL abaixo nasceu IDÊNTICO ao que estava embutido em
-- replenishment-routes.js — janela móvel, HAVING, LIMIT e ordenação — para que
-- a tela não mudasse de resposta junto com o transporte. Uma coisa de cada vez.
--
-- 2026-08-31: o LIMIT 4000 de replenishment_averages foi removido, com
-- desempate na ordenação. Ele vinha do código antigo e era o próprio rótulo da
-- tela ("4,000 SKUs"); o real é 8.600 pares em 6 meses. O porquê completo está
-- na função. O motor de sugestão NÃO lê este endpoint (usa
-- branch_avg_monthly_sales e /branch-averages), então nenhum TR mudou — o que
-- mudou é a aba de conferência parar de mentir.
--
-- COMO APLICAR: colar no SQL Editor do Supabase (o projeto do Labels) e rodar.
-- É idempotente — CREATE OR REPLACE, pode rodar de novo sem medo.
-- ============================================================

-- ============================================================
-- 2026-09-02 — A DEMANDA PASSOU A LER O MIRROR AO VIVO (automático)
--
-- Até aqui a demanda vinha SÓ de cin7_mirror.v_sales_demand_line, que lê a
-- tabela sales_history_line: um IMPORT MANUAL do report "Sale Order Details" do
-- Cin7 (core/cin7/import-sale-order-details.js, que ainda precisa de
-- SUPABASE_DB_PASSWORD). Import manual não é automático — alguém tem de baixar o
-- arquivo e rodar o script. Resultado medido: a janela era dinâmica, mas o DADO
-- congelou no último import (27/08), perdendo ~27.581 unidades de venda de 28/08
-- a 02/09 que a reposição nem via.
--
-- v_rp_demand é a fonte AUTOMÁTICA. Ela é uma UNION de duas metades, com uma
-- costura em 2026-07-01, e a costura NÃO é estética — é medida:
--
--   O sale_lines do mirror só passou a ser capturado DENSO a partir de jun/2026.
--   Antes disso o pedido tem cabeçalho (sales_orders — daí location_name e
--   sales_rep darem 100%) mas quase nenhuma LINHA. Medido em 02/09, por mês,
--   unidades history × mirror:
--     dez/25  87.004 × 6.726  (-92%)      abr/26 141.255 × 58.992  (-58%)
--     jan/26 116.991 × 14.470 (-88%)      mai/26 152.622 × 61.083  (-60%)
--     fev/26 142.478 × 36.667 (-74%)      jun/26 183.397 × 173.440  (-5%)  ok
--     mar/26 143.265 × 35.283 (-75%)      jul/26 154.198 × 160.230  (+4%)  ok
--   Puxar 6 ou 12 meses direto do mirror subcontaria abr–mai pela metade, calado.
--
--   • order_date <  2026-07-01  → v_sales_demand_line (history importada).
--     É densa e CONGELADA: mês velho não muda mais, então não precisa
--     reimportar nunca. Foi para ISTO que o import existiu — backfill histórico,
--     uma vez, para construir o sistema. Não é dependência contínua.
--   • order_date >= 2026-07-01  → mirror ao vivo (sale_lines ⋈ sales_orders),
--     que sincroniza sozinho a cada ~2h. É a metade que muda: recupera 28/08–
--     02/09 e capta TODO pedido novo, para sempre. Conferida contra a history
--     nos dias que as duas têm: jul +4%, ago 1–27 +1,7% (o +10% do agosto cheio
--     é só os dias 28–31 que a history não tinha — dado novo, correto).
--   As duas metades são disjuntas por data: zero risco de contar o mesmo pedido
--   duas vezes. Com o tempo a metade viva engole a janela e a history vira só
--   cauda de +12 meses; a costura em jul/2026 continua correta para sempre.
--
-- ISOLADO DE PROPÓSITO: só as RPCs da reposição apontam para v_rp_demand.
-- v_sales_demand_line NÃO é redefinida; o stock-planning segue lendo ela até
-- aquele chat decidir migrar para cá também.
--
-- FIDELIDADE ao report (regras medidas em 003_sales_history_line.sql), na
-- metade VIVA — a history já as aplica na sua:
--   • universo = os 10 status que o report emite; exclui ESTIMATING/ESTIMATED/
--     ORDERING/VOIDED/DRAFT. Filtro POSITIVO: status novo do Cin7 fica de fora
--     até ser conferido, em vez de entrar mudo.
--   • Credited entra NEGATIVO — é devolução, não demanda.
--   • valor não existe aqui: o report traz bruto com GST e a demanda usa
--     quantidade; nenhuma RPC lê valor.
--   • linha sem SKU (frete/serviço) fica de fora: não se repõe SKU vazio, e a
--     history nunca teve sku nulo (coluna NOT NULL lá).
--   • order_date futura fica de fora: numa fonte VIVA um pedido pós-datado não é
--     demanda de hoje e não pode empurrar a âncora da janela. O "+ 1 day" cobre
--     o descasamento UTC↔Brisbane (o banco é UTC).
--
-- RISCO CONHECIDO (pré-existente do mirror, não introduzido aqui): sale_lines é
-- upsert em (order_number,line_no) SEM delete, e a poda (pruneStaleLines) só
-- roda no backfill detail-month, que hoje alcança o mês corrente + 1 anterior.
-- Se o Cin7 encolhe/reordena as linhas de um pedido reenviado, linhas órfãs
-- sobram e inflam a demanda DAQUELE SKU na metade viva (ex. catalogado
-- SO-281413: 149 linhas/491un no mirror vs 100/349 no Cin7). É por-SKU e
-- limitado — o agregado bate com a history em +1,7–4% —, mas a metade history
-- (report deduplicado) não tem isso, então as duas metades podem divergir num
-- SKU pontual. Conserto DE VERDADE é na camada de sync (podar em todo caminho
-- de escrita de sale_lines, ou subir DETAIL_MONTH_BACK para cobrir a janela),
-- não nesta view — que não tem como distinguir a linha viva da órfã.
-- ============================================================
CREATE OR REPLACE VIEW cin7_mirror.v_rp_demand AS
  -- ── cauda ANTIGA: history importada, densa e congelada ──────────────────
  SELECT order_number, order_date, sales_rep, location_name, status,
         sku, sku_key, product_name, quantity, demanda_classe, qty_signed
    FROM cin7_mirror.v_sales_demand_line
   WHERE order_date < DATE '2026-07-01'
UNION ALL
  -- ── metade VIVA: mirror que sincroniza sozinho a cada ~2h ───────────────
  SELECT sl.order_number, so.order_date, so.sales_rep, so.location_name, so.status,
         sl.sku, upper(btrim(sl.sku)) AS sku_key, sl.product_name, sl.quantity,
         CASE
           WHEN upper(so.status) IN ('INVOICED','COMPLETED','CLOSED')             THEN 'consumada'
           WHEN upper(so.status) IN ('ORDERED','BACKORDERED','PICKING','PICKED',
                                     'PACKING','INVOICING')                       THEN 'aberta'
           WHEN upper(so.status) = 'CREDITED'                                     THEN 'devolucao'
           ELSE 'outro'
         END                                                                     AS demanda_classe,
         CASE WHEN upper(so.status)='CREDITED' THEN -sl.quantity ELSE sl.quantity END AS qty_signed
    FROM cin7_mirror.sale_lines   sl
    JOIN cin7_mirror.sales_orders so ON so.order_number = sl.order_number
   WHERE so.order_date >= DATE '2026-07-01'
     AND so.order_date <= CURRENT_DATE + INTERVAL '1 day'
     AND upper(so.status) IN ('INVOICED','COMPLETED','CLOSED','ORDERED','BACKORDERED',
                              'PICKING','PICKED','PACKING','INVOICING','CREDITED')
     AND coalesce(btrim(sl.sku), '') <> '';

GRANT SELECT ON cin7_mirror.v_rp_demand TO anon, authenticated, service_role;

-- A janela móvel, num lugar só. Ela ancora no último mês COM DADO, não em
-- now(): ancorar no relógio faz a média encolher sozinha quando o sync atrasa.
-- SECURITY DEFINER também aqui: ela é chamada de dentro das outras e lê
-- cin7_mirror. Deixá-la INVOKER faria a permissão depender de quem chama.
CREATE OR REPLACE FUNCTION public._rp_window(p_months INT)
RETURNS DATE
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror
AS $$
  -- Âncora no último mês COM DADO, mas NUNCA à frente do mês corrente. A metade
  -- viva de v_rp_demand admite order_date até hoje+1 (buffer UTC↔Brisbane); no
  -- último dia do mês, um pedido pós-datado no 1º do mês seguinte faria max()
  -- pular de mês e deslizar a janela para a frente, desinflando a média naquele
  -- dia (o denominador continua p_months). O LEAST com CURRENT_DATE trava isso
  -- SEM reancorar no relógio: se max estiver no PASSADO por atraso de sync, ele
  -- continua valendo — que é a defesa contra a média encolher sozinha.
  SELECT (date_trunc('month', LEAST((SELECT max(order_date) FROM cin7_mirror.v_rp_demand),
                                    CURRENT_DATE))
          - (GREATEST(p_months, 1) - 1) * interval '1 month')::DATE;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 1) MÉDIAS por SKU × local, na janela escolhida.  (endpoint /averages)
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replenishment_averages(
  p_months INT DEFAULT 6,
  p_location TEXT DEFAULT NULL
)
RETURNS TABLE (
  sku_key TEXT, sku TEXT, name TEXT, location_name TEXT,
  qty NUMERIC, avg_month NUMERIC, orders BIGINT, months_with_sales BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  SELECT d.sku_key::TEXT, min(d.sku)::TEXT, min(d.product_name)::TEXT, d.location_name::TEXT,
         sum(d.qty_signed)::NUMERIC,
         round(sum(d.qty_signed) / GREATEST(p_months, 1)::NUMERIC, 2),
         count(DISTINCT d.order_number),
         count(DISTINCT to_char(d.order_date, 'YYYY-MM'))
    FROM cin7_mirror.v_rp_demand d
   WHERE d.order_date >= (SELECT public._rp_window(p_months))
     AND (p_location IS NULL OR p_location = '' OR d.location_name = p_location)
   GROUP BY d.sku_key, d.location_name
  HAVING sum(d.qty_signed) <> 0
   -- O LIMIT 4000 saiu daqui, e o desempate entrou no mesmo gesto.
   --
   -- O teto era o próprio rótulo da tela: "4,000 SKUs · 6m · all branches" era
   -- o LIMIT, não a medição. Reais: 8.600 pares SKU×local em 6m (6.559 em 3m,
   -- 11.028 em 12m — as TRÊS janelas da aba passavam do teto). Contando SKU
   -- distinto, que é o que o rótulo alega: 1.643 devolvidos contra 3.065.
   -- O piso da resposta era 10 unidades em 6 meses, e os 114 pares de saldo
   -- negativo (devolução, crédito) ficavam 100% de fora. Reproduzido:
   -- R-SM35 / Main Warehouse tem 40 pedidos em 6 meses e não aparecia — quem
   -- filtrasse "R-SM35" via só Sunshine Coast e concluía que o Main não vende.
   --
   -- O desempate NÃO é opcional. Sem o teto a rota emenda 9-12 páginas em vez
   -- de 4, e as fronteiras caem dentro de grupos empatados de 12, 26, 71 e 214
   -- linhas: ordem instável entre páginas perde linha em silêncio. É
   -- exatamente o bug dos 37 SKUs de Sydney, com mais páginas para errar.
   --
   -- E ordenar por sku_key em vez do volume seria REGRESSÃO, não conserto:
   -- trocaria os 4.000 de maior volume pelos 4.000 primeiros do alfabeto numa
   -- tela cujo assunto é volume.
   ORDER BY sum(d.qty_signed) DESC, d.sku_key, d.location_name;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 2) A EXTENSÃO do histórico. A tela mostra isto junto da média porque um mês
--    correndo lido como mês cheio puxa a média para baixo sem ninguém ver.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replenishment_span()
RETURNS TABLE (first_day TEXT, last_day TEXT, months BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror
AS $$
  SELECT min(order_date)::TEXT, max(order_date)::TEXT,
         count(DISTINCT to_char(order_date, 'YYYY-MM'))
    FROM cin7_mirror.v_rp_demand;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 3) A RÉGUA DO REP contra a do local.  (endpoint /branch-averages)
--
--    A régua do rep é a demanda da filial; a do local é o despacho. Quando a
--    filial está sem estoque o pedido sai do Main e a venda some da conta dela
--    — medido em 6 meses, Brisbane vende 113.742 pela régua do rep contra
--    41.307 pela do local.
--
--    O FULL OUTER JOIN não é enfeite: ele preserva o SKU que a filial vendeu
--    pelo local sem nenhum rep dela ter tocado. Era o `for` que a UI fazia
--    depois do map, e sem ele a régua do rep pareceria sempre maior.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replenishment_branch_averages(
  p_branch TEXT,
  p_months INT DEFAULT 6,
  p_location TEXT DEFAULT NULL
)
RETURNS TABLE (
  sku_key TEXT, rep_avg NUMERIC, loc_avg NUMERIC, orders BIGINT, reps BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  WITH nomes AS (
    SELECT sales_rep FROM rapid_inv.sales_rep_branch
     WHERE branch_code = upper(p_branch) AND is_active
  ),
  por_rep AS (
    SELECT d.sku_key, sum(d.qty_signed) AS qty,
           count(DISTINCT d.order_number) AS orders,
           count(DISTINCT d.sales_rep)    AS reps
      FROM cin7_mirror.v_rp_demand d
     WHERE d.order_date >= (SELECT public._rp_window(p_months))
       AND d.sales_rep IN (SELECT sales_rep FROM nomes)
     GROUP BY d.sku_key
  ),
  por_local AS (
    SELECT d.sku_key, sum(d.qty_signed) AS qty
      FROM cin7_mirror.v_rp_demand d
     WHERE d.order_date >= (SELECT public._rp_window(p_months))
       AND p_location IS NOT NULL AND p_location <> ''
       AND d.location_name = p_location
     GROUP BY d.sku_key
  )
  SELECT COALESCE(r.sku_key, l.sku_key)::TEXT,
         round(COALESCE(r.qty, 0) / GREATEST(p_months, 1)::NUMERIC, 2),
         round(COALESCE(l.qty, 0) / GREATEST(p_months, 1)::NUMERIC, 2),
         COALESCE(r.orders, 0),
         COALESCE(r.reps, 0)
    FROM por_rep r FULL OUTER JOIN por_local l ON l.sku_key = r.sku_key
   /* ORDER BY obrigatório, e não estético.
      A rota lê em páginas de 1000 (limit/offset) e Sydney devolve 1.238
      linhas — duas páginas. Sem ordenação, o Postgres não promete a mesma
      sequência entre as duas execuções: se o plano mudar entre a página 1 e a
      página 2, a emenda repete linhas e perde outras. Medido forçando planos
      diferentes: 37 SKUs de Sydney somem. E somem em SILÊNCIO — a tela mostra
      1.201 linhas com cara de completa.
      Em 12 execuções seguidas não disparou, que é exatamente o que torna esse
      tipo de defeito caro: ele espera a tabela crescer ou a estatística virar. */
  ORDER BY 1;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 4) QUAL FILIAL cada rep atende — inferido da venda.  (endpoint /reps)
--
--    Devolve a SEGUNDA colocada junto da primeira de propósito. Mostrar só a
--    primeira transforma um 53% × 44% em fato. O limite de Wilson continua
--    sendo calculado no Node, a partir de orders_1 e orders_total daqui.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replenishment_reps(p_months INT DEFAULT 13)
RETURNS TABLE (
  rep TEXT, branch_1 TEXT, orders_1 BIGINT, pct_1 NUMERIC,
  branch_2 TEXT, orders_2 BIGINT, pct_2 NUMERIC,
  orders_total NUMERIC, last_order TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  WITH base AS (
    SELECT d.sales_rep, d.location_name,
           count(DISTINCT d.order_number) AS orders, max(d.order_date) AS last_order
      FROM cin7_mirror.v_rp_demand d
     WHERE d.order_date >= (SELECT public._rp_window(p_months))
     GROUP BY 1, 2
  ),
  tot AS (SELECT sales_rep, sum(orders) AS total, max(last_order) AS last_order FROM base GROUP BY 1),
  rk AS (
    SELECT b.*, t.total, t.last_order AS rep_last,
           row_number() OVER (PARTITION BY b.sales_rep ORDER BY b.orders DESC) AS pos
      FROM base b JOIN tot t ON t.sales_rep = b.sales_rep
  )
  SELECT r1.sales_rep::TEXT, r1.location_name::TEXT, r1.orders,
         round(100.0 * r1.orders / r1.total, 1),
         r2.location_name::TEXT, r2.orders,
         round(100.0 * COALESCE(r2.orders, 0) / r1.total, 1),
         r1.total, r1.rep_last::DATE::TEXT
    FROM rk r1 LEFT JOIN rk r2 ON r2.sales_rep = r1.sales_rep AND r2.pos = 2
   WHERE r1.pos = 1
   ORDER BY r1.location_name, r1.total DESC;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 5) O DETALHE de um SKU: quem vendeu, e por qual local.  (/sku-detail)
--    Dois formatos diferentes, duas funções — mais simples de ler do que um
--    jsonb com duas listas dentro.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.replenishment_sku_by_rep(
  p_sku TEXT, p_months INT DEFAULT 6
)
RETURNS TABLE (sales_rep TEXT, branch_code TEXT, qty NUMERIC, orders BIGINT, last_order TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  SELECT d.sales_rep::TEXT, COALESCE(a.branch_code, '—')::TEXT,
         sum(d.qty_signed)::NUMERIC, count(DISTINCT d.order_number),
         max(d.order_date)::DATE::TEXT
    FROM cin7_mirror.v_rp_demand d
    LEFT JOIN rapid_inv.sales_rep_branch a ON a.sales_rep = d.sales_rep
   WHERE d.sku_key = upper(p_sku) AND d.order_date >= (SELECT public._rp_window(p_months))
   GROUP BY 1, 2
  HAVING sum(d.qty_signed) <> 0
   ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION public.replenishment_sku_by_location(
  p_sku TEXT, p_months INT DEFAULT 6
)
RETURNS TABLE (location_name TEXT, qty NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror
AS $$
  SELECT d.location_name::TEXT, sum(d.qty_signed)::NUMERIC
    FROM cin7_mirror.v_rp_demand d
   WHERE d.sku_key = upper(p_sku) AND d.order_date >= (SELECT public._rp_window(p_months))
   GROUP BY 1
  HAVING sum(d.qty_signed) <> 0
   ORDER BY 2 DESC;
$$;

-- ───────────────────────────────────────────────────────────────────
-- 6) PERMISSÕES — só leitura, e só o que a tela precisa.
-- ───────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public._rp_window(INT)                                   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_averages(INT, TEXT)                 TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_span()                              TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_branch_averages(TEXT, INT, TEXT)    TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_reps(INT)                           TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_sku_by_rep(TEXT, INT)               TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_sku_by_location(TEXT, INT)          TO anon, authenticated, service_role;

-- Prova de vida: se isto voltar com número, a tela funciona sem senha nenhuma.
-- `demanda_ate` é a prova do AUTOMÁTICO: tem de ser a data de HOJE (ou de
-- ontem), não mais o 27/08 congelado do último import manual.
SELECT 'replenishment rpc pronto'                       AS status,
       (SELECT max(order_date) FROM cin7_mirror.v_rp_demand)                    AS demanda_ate,
       (SELECT count(*) FROM public.replenishment_reps(13))                    AS reps,
       (SELECT count(*) FROM public.replenishment_averages(6, 'Sydney'))       AS medias_sydney,
       (SELECT count(*) FROM public.replenishment_branch_averages('SYD', 6, 'Sydney')) AS regua_sydney;
