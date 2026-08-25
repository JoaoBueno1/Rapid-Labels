-- =====================================================================
-- Analytics · 001 · O RELATÓRIO MENSAL, AO VIVO
-- ---------------------------------------------------------------------
-- Sete apresentações mensais (dez/25 → jul/26) montadas à mão: export do
-- Cin7 → colado no Excel → printado dentro do PowerPoint. Dez, janeiro,
-- fev-março e abril não têm um único gráfico nativo — são 19 a 35 imagens.
--
-- E o deck não é limitado por dado. cin7_mirror.sales_orders tem 78.256
-- pedidos desde 2021, com local, data de fatura, imposto, COGS e vendedor.
-- stock_snapshot tem SOH por local para todas as filiais. Faltava a tela.
--
-- Onze análises aparecem nos SETE meses — essa é a espinha dorsal, e sete
-- delas são reproduzíveis com o dado que já está aqui.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Locais, classificados. 'Ghost', 'Faulty Warehouse' e 'Damaged Goods'
-- são locais REAIS no Cin7, não erro de dado — e é justamente o que o deck
-- reporta todo mês.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_location_kind AS
SELECT DISTINCT location_name,
       CASE
         WHEN location_name IN ('Ghost','Faulty Warehouse','Damaged Goods') THEN 'QUARANTINE'
         WHEN location_name ILIKE '%project%'                               THEN 'PROJECT'
         ELSE 'BRANCH'
       END AS kind
  FROM cin7_mirror.stock_snapshot
 WHERE location_name IS NOT NULL;

-- ---------------------------------------------------------------------
-- 1. VENDA MENSAL POR FILIAL, com o mesmo mês do ano passado.
-- Líquido de imposto, que é como o deck reporta.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_monthly_sales AS
WITH m AS (
  SELECT date_trunc('month', invoice_date)::DATE          AS mth,
         COALESCE(location_name, '(no location)')         AS wh,
         sum(invoice_amount - COALESCE(tax_amount, 0))    AS sales,
         sum(COALESCE(cogs_amount, 0))                    AS cogs,
         count(*)::INT                                    AS orders
    FROM cin7_mirror.sales_orders
   WHERE invoice_date IS NOT NULL
   GROUP BY 1, 2
)
SELECT c.mth, c.wh,
       round(c.sales)                                        AS sales,
       round(c.cogs)                                         AS cogs,
       round(c.sales - c.cogs)                               AS gross_profit,
       round(100 * (c.sales - c.cogs) / NULLIF(c.sales, 0), 1) AS gp_pct,
       c.orders,
       round(p.sales)                                        AS sales_ly,
       round(100 * (c.sales - p.sales) / NULLIF(p.sales, 0), 1) AS growth_pct
  FROM m c
  LEFT JOIN m p ON p.wh = c.wh AND p.mth = c.mth - INTERVAL '1 year';

-- ---------------------------------------------------------------------
-- 2. ESTOQUE POR FILIAL E MESES DE COBERTURA
--
-- O denominador é COGS, não faturamento. Usar faturamento reproduz o erro
-- que entrou no deck em abril e infla a cobertura pela margem inteira.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_stock_by_warehouse AS
WITH soh AS (
  SELECT s.location_name AS wh,
         sum(s.on_hand)                        AS units,
         sum(s.on_hand * p.average_cost)       AS soh_value,
         count(DISTINCT s.sku)::INT            AS skus
    FROM cin7_mirror.stock_snapshot s
    JOIN cin7_mirror.products p ON p.sku = s.sku
   WHERE s.on_hand > 0
   GROUP BY 1
), cogs AS (
  SELECT location_name AS wh, sum(COALESCE(cogs_amount, 0)) AS cogs_mth
    FROM cin7_mirror.sales_orders
   WHERE invoice_date >= date_trunc('month', now()) - INTERVAL '1 month'
     AND invoice_date <  date_trunc('month', now())
   GROUP BY 1
)
SELECT soh.wh, k.kind,
       soh.skus, round(soh.units) AS units,
       round(soh.soh_value)       AS soh_value,
       round(cogs.cogs_mth)       AS mth_cogs,
       round((soh.soh_value / NULLIF(cogs.cogs_mth, 0))::NUMERIC, 2) AS months_stock
  FROM soh
  LEFT JOIN cogs USING (wh)
  LEFT JOIN rapid_inv.v_an_location_kind k ON k.location_name = soh.wh;

-- ---------------------------------------------------------------------
-- 3. O LIVRO-RAZÃO DA QUARENTENA — Ghost, Faulty e Damaged
--
-- São três locais que só ENCHEM. Medido em 10 semanas de log de movimento:
-- Ghost entrou 2.662 e saiu 1.003. E mais da metade do que está lá chegou
-- antes de o log existir e nunca saiu.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_quarantine AS
SELECT s.location_name AS location,
       COALESCE(NULLIF(btrim(s.bin), ''), '(no bin)') AS bin,
       count(DISTINCT s.sku)::INT           AS skus,
       round(sum(s.on_hand))                AS units,
       round(sum(s.on_hand * p.average_cost)::NUMERIC, 2) AS value_aud
  FROM cin7_mirror.stock_snapshot s
  LEFT JOIN cin7_mirror.products p ON p.sku = s.sku
 WHERE s.location_name IN ('Ghost','Faulty Warehouse','Damaged Goods')
   AND s.on_hand > 0
 GROUP BY 1, 2;

CREATE OR REPLACE VIEW rapid_inv.v_an_quarantine_sku AS
SELECT s.location_name AS location, s.sku,
       COALESCE(NULLIF(btrim(s.bin), ''), '(no bin)') AS bin,
       round(sum(s.on_hand))                                AS units,
       round(sum(s.on_hand * p.average_cost)::NUMERIC, 2)   AS value_aud,
       p.name AS product, p.status AS cin7_status
  FROM cin7_mirror.stock_snapshot s
  LEFT JOIN cin7_mirror.products p ON p.sku = s.sku
 WHERE s.location_name IN ('Ghost','Faulty Warehouse','Damaged Goods')
   AND s.on_hand > 0
 GROUP BY 1, 2, 3, 6, 7;

-- ---------------------------------------------------------------------
-- 4. O CRUZAMENTO QUE DÓI
-- SKU que está em backorder num pedido aberto AGORA e tem unidades paradas
-- em quarentena. O cliente espera enquanto a peça está no prédio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_backorder_in_quarantine AS
WITH bo AS (
  SELECT DISTINCT upper(btrim(sl.sku)) AS sku_key, sl.sku
    FROM cin7_mirror.sale_lines sl
    JOIN cin7_mirror.sales_orders o ON o.order_number = sl.order_number
   WHERE COALESCE(sl.backorder_quantity, 0) > 0
     AND o.order_status = 'AUTHORISED'
), q AS (
  SELECT upper(btrim(sku)) AS sku_key,
         sum(units) AS units, sum(value_aud) AS value_aud,
         string_agg(DISTINCT location, ', ') AS locations
    FROM rapid_inv.v_an_quarantine_sku GROUP BY 1
), avail AS (
  SELECT upper(btrim(s.sku)) AS sku_key, sum(s.available) AS sellable
    FROM cin7_mirror.stock_snapshot s
    JOIN rapid_inv.v_an_location_kind k ON k.location_name = s.location_name AND k.kind = 'BRANCH'
   GROUP BY 1
)
SELECT bo.sku, bo.sku_key, q.units, q.value_aud, q.locations,
       COALESCE(a.sellable, 0) AS sellable_elsewhere,
       (COALESCE(a.sellable, 0) <= 0) AS only_in_quarantine
  FROM bo JOIN q ON q.sku_key = bo.sku_key
  LEFT JOIN avail a ON a.sku_key = bo.sku_key;

-- ---------------------------------------------------------------------
-- 5. TRANSFERÊNCIA ENTRE FILIAIS — tempo real de trânsito
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_transfer_leadtime AS
SELECT t.to_location AS branch,
       count(*)::INT AS transfers,
       round(avg(t.completion_date::DATE - t.departure_date::DATE)::NUMERIC, 2) AS avg_days,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (t.completion_date::DATE - t.departure_date::DATE))::NUMERIC, 1) AS median_days,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY (t.completion_date::DATE - t.departure_date::DATE))::NUMERIC, 1) AS p90_days,
       max(t.completion_date::DATE - t.departure_date::DATE) AS worst_days,
       count(*) FILTER (WHERE (t.completion_date::DATE - t.departure_date::DATE) > 5)::INT AS over_5_days
  FROM cin7_mirror.stock_transfers t
  JOIN rapid_inv.v_an_location_kind k ON k.location_name = t.to_location AND k.kind = 'BRANCH'
 WHERE t.departure_date IS NOT NULL AND t.completion_date IS NOT NULL
   AND t.completion_date >= now() - INTERVAL '90 days'
 GROUP BY 1;

-- Transferências presas: saiu e não chegou, ou foi criada e nunca saiu.
CREATE OR REPLACE VIEW rapid_inv.v_an_stuck_transfers AS
SELECT t.number AS transfer_number, t.from_location, t.to_location, t.status,
       t.reference, t.line_count, t.total_qty,
       t.departure_date::DATE                                             AS departed,
       (CURRENT_DATE - COALESCE(t.departure_date, t.cin7_updated)::DATE)  AS days_open,
       (CURRENT_DATE - t.cin7_updated::DATE)                              AS days_quiet
  FROM cin7_mirror.stock_transfers t
 WHERE t.completion_date IS NULL
   AND COALESCE(t.status,'') NOT IN ('COMPLETED','VOIDED','CANCELLED')
   AND (CURRENT_DATE - COALESCE(t.departure_date, t.cin7_updated)::DATE) > 3;

-- ---------------------------------------------------------------------
-- 6. PEDIDO → DESPACHO, por filial. É o único SLA mensurável hoje: a data
-- prometida (ship_by) só existe em 1,7% dos pedidos, então o que dá para
-- medir é o tempo que a casa leva, não o que ela prometeu.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_dispatch_sla AS
SELECT COALESCE(o.location_name, '(no location)') AS branch,
       count(*)::INT                                                              AS orders,
       round(avg(o.ship_date::DATE - o.order_date::DATE)::NUMERIC, 2)             AS avg_days,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (o.ship_date::DATE - o.order_date::DATE))::NUMERIC, 1) AS median_days,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY (o.ship_date::DATE - o.order_date::DATE))::NUMERIC, 1) AS p90_days,
       round(100.0 * count(*) FILTER (WHERE (o.ship_date::DATE - o.order_date::DATE) <= 1) / count(*), 1) AS same_next_day_pct,
       count(*) FILTER (WHERE (o.ship_date::DATE - o.order_date::DATE) > 5)::INT  AS over_5_days
  FROM cin7_mirror.sales_orders o
 WHERE o.ship_date IS NOT NULL AND o.order_date IS NOT NULL
   AND o.ship_date >= now() - INTERVAL '90 days'
   AND o.ship_date >= o.order_date
 GROUP BY 1;

-- ---------------------------------------------------------------------
-- 7. O QUE DÁ PARA LIBERAR HOJE
--
-- Pedido em backorder cujo SKU JÁ TEM estoque vendável. É a análise que
-- vale dinheiro imediato: cliente esperando enquanto a peça está no prédio.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_an_releasable AS
WITH sellable AS (
  SELECT upper(btrim(s.sku)) AS sku_key, sum(s.available) AS available
    FROM cin7_mirror.stock_snapshot s
    JOIN rapid_inv.v_an_location_kind k ON k.location_name = s.location_name AND k.kind = 'BRANCH'
   GROUP BY 1
), bo AS (
  SELECT sl.order_number, sl.sku, upper(btrim(sl.sku)) AS sku_key,
         sum(sl.backorder_quantity) AS bo_qty, sum(sl.total) AS line_value
    FROM cin7_mirror.sale_lines sl
   WHERE COALESCE(sl.backorder_quantity, 0) > 0
   GROUP BY 1, 2, 3
)
SELECT o.order_number, o.customer, o.location_name AS branch, o.order_date,
       (CURRENT_DATE - o.order_date::DATE)               AS age_days,
       count(*)::INT                                     AS bo_lines,
       count(*) FILTER (WHERE COALESCE(s.available,0) >= bo.bo_qty)::INT AS lines_coverable,
       round(sum(bo.line_value)::NUMERIC, 2)             AS order_value,
       bool_and(COALESCE(s.available, 0) >= bo.bo_qty)   AS fully_releasable,
       COALESCE(max(k.kind), 'BRANCH')                   AS branch_kind
  FROM bo
  JOIN cin7_mirror.sales_orders o ON o.order_number = bo.order_number
  LEFT JOIN sellable s ON s.sku_key = bo.sku_key
  LEFT JOIN rapid_inv.v_an_location_kind k ON k.location_name = o.location_name
 WHERE o.order_status = 'AUTHORISED'
   AND COALESCE(o.shipping_status,'') <> 'SHIPPED'
 GROUP BY 1,2,3,4,5;

CREATE OR REPLACE VIEW rapid_inv.v_an_releasable_lines AS
WITH sellable AS (
  SELECT upper(btrim(s.sku)) AS sku_key, sum(s.available) AS available,
         string_agg(DISTINCT s.location_name, ', ' ORDER BY s.location_name)
           FILTER (WHERE s.available > 0) AS where_it_is
    FROM cin7_mirror.stock_snapshot s
    JOIN rapid_inv.v_an_location_kind k ON k.location_name = s.location_name AND k.kind = 'BRANCH'
   GROUP BY 1
)
SELECT sl.order_number, sl.sku, sl.product_name,
       sum(sl.backorder_quantity)          AS bo_qty,
       max(COALESCE(s.available, 0))       AS available,
       max(s.where_it_is)                  AS where_it_is,
       round(sum(sl.total)::NUMERIC, 2)    AS line_value,
       (max(COALESCE(s.available,0)) >= sum(sl.backorder_quantity)) AS coverable
  FROM cin7_mirror.sale_lines sl
  LEFT JOIN sellable s ON s.sku_key = upper(btrim(sl.sku))
 WHERE COALESCE(sl.backorder_quantity, 0) > 0
 GROUP BY 1, 2, 3;

DO $$ BEGIN RAISE NOTICE 'analytics 001: views do relatório mensal prontas'; END $$;
