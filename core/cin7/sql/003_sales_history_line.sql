-- ═══════════════════════════════════════════════════════════════════════════
-- cin7_mirror.sales_history_line — venda POR LINHA, vinda do report
-- "Sale Order Details" do Cin7 (Configure Layout: layout por pedido).
--
-- POR QUE UMA TABELA PRÓPRIA E NÃO sale_lines — três razões medidas:
--
--   1. O `Total` do report é BRUTO (com GST). Provado linha a linha em
--      SO-207226 (2026-08-27): CSV 1758.90 = mirror total 1599.00 + tax 159.90,
--      nos 13 itens do pedido. `sale_lines.total` é LÍQUIDO. Misturar bruto e
--      líquido na mesma coluna envenena todo consumidor a jusante.
--      Guardar o bruto como veio é sem perda; converter não é (16 linhas em
--      52.909 desde 2025-08 têm alíquota fora dos 10%).
--
--   2. A ordem das linhas do CSV NÃO é a ordem do line_no da API. No mesmo
--      SO-207226 o CSV começa em R2332 e o mirror em R1021. sale_lines é
--      UNIQUE(order_number, line_no) — importar por cima duplicaria a linha de
--      todo pedido de junho/2026 em diante, que é o dado que o chase, o board
--      do Home e o Open Orders leem todo dia.
--
--   3. O report traz o que sale_lines NÃO tem: sales_rep, customer,
--      invoice_status e um `status` com 10 valores (Backordered, Picking,
--      Packing…) contra os 4 que o poller filtra.
--
-- RECONCILIAÇÃO medida em agosto/2026: mirror 13.202 linhas − 170 de status que
-- o report não traz (ESTIMATING/ORDERING/VOIDED/DRAFT/ESTIMATED) = 13.032,
-- contra 13.020 do CSV. Diferença de 12 linhas (0,09%).
--
-- Aditivo: nenhuma tabela existente é tocada. Colar no SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cin7_mirror.sales_history_line (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Do metadado "From:"/"To:" do próprio arquivo — é o lineage do período.
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,

  order_number   TEXT NOT NULL,
  row_seq        INT  NOT NULL,          -- posição da linha DENTRO do pedido, no arquivo.
                                         -- Não é o line_no da API e não deve ser
                                         -- comparado com ele. Existe só para dar
                                         -- unicidade a linhas repetidas do mesmo SKU
                                         -- (60 pares (pedido,SKU) repetidos em agosto).
  order_date     DATE,
  customer       TEXT,
  rapid_code     TEXT,                   -- "Product additional attribute 1"
  sku            TEXT NOT NULL,
  sku_key        TEXT NOT NULL,          -- upper(btrim(sku)) — a chave de join
  product_name   TEXT,
  uom            TEXT,
  invoice_number TEXT,
  invoice_date   DATE,
  invoice_status TEXT,
  sales_rep      TEXT,                   -- ⭐ não existe em sale_lines
  status         TEXT,                   -- Invoiced|Backordered|Ordered|Credited|…
  location_name  TEXT,

  quantity       NUMERIC NOT NULL DEFAULT 0,

  -- ⚠️ BRUTO, COM GST — o nome carrega o aviso. Ver razão 1 no cabeçalho.
  total_gross    NUMERIC NOT NULL DEFAULT 0,

  source_file    TEXT,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (period_start, order_number, row_seq)
);

CREATE INDEX IF NOT EXISTS idx_shl_skukey   ON cin7_mirror.sales_history_line (sku_key);
CREATE INDEX IF NOT EXISTS idx_shl_date     ON cin7_mirror.sales_history_line (order_date);
CREATE INDEX IF NOT EXISTS idx_shl_rep      ON cin7_mirror.sales_history_line (sales_rep);
CREATE INDEX IF NOT EXISTS idx_shl_loc      ON cin7_mirror.sales_history_line (location_name);
CREATE INDEX IF NOT EXISTS idx_shl_order    ON cin7_mirror.sales_history_line (order_number);
CREATE INDEX IF NOT EXISTS idx_shl_status   ON cin7_mirror.sales_history_line (status);

COMMENT ON TABLE cin7_mirror.sales_history_line IS
  'Venda por linha do report Sale Order Details do Cin7. Complementa sale_lines, '
  'não a substitui: total_gross INCLUI GST e row_seq NÃO é o line_no da API.';

-- ───────────────────────────────────────────────────────────────────────────
-- O QUE CONTA COMO DEMANDA — a decisão de negócio, num lugar só.
--
-- Medido em agosto/2026: Credited traz quantidade POSITIVA (nenhuma linha
-- negativa no arquivo inteiro), então devolução precisa ser subtraída de
-- propósito — somar tudo infla a demanda.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cin7_mirror.v_sales_demand_line AS
SELECT h.*,
       CASE
         -- saída consumada: o estoque de fato saiu
         WHEN upper(h.status) IN ('INVOICED','COMPLETED','CLOSED')        THEN 'consumada'
         -- demanda em aberto: pedida, ainda não saiu
         WHEN upper(h.status) IN ('ORDERED','BACKORDERED','PICKING',
                                  'PICKED','PACKING','INVOICING')          THEN 'aberta'
         -- devolução: entra com quantidade positiva, mas é demanda NEGATIVA
         WHEN upper(h.status) = 'CREDITED'                                 THEN 'devolucao'
         ELSE 'outro'
       END AS demanda_classe,
       CASE WHEN upper(h.status) = 'CREDITED' THEN -h.quantity ELSE h.quantity END AS qty_signed
  FROM cin7_mirror.sales_history_line h;

-- ───────────────────────────────────────────────────────────────────────────
-- COBERTURA — qual período já entrou. O "terminou?" desta via.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cin7_sales_history_coverage AS
SELECT to_char(period_start,'YYYY-MM')  AS ym,
       count(*)                          AS linhas,
       count(DISTINCT order_number)      AS pedidos,
       count(DISTINCT sku_key)           AS skus,
       count(DISTINCT sales_rep)         AS reps,
       round(sum(quantity),1)            AS qty,
       round(sum(total_gross))           AS valor_bruto,
       max(imported_at)                  AS importado_em,
       max(source_file)                  AS arquivo
  FROM cin7_mirror.sales_history_line
 GROUP BY 1 ORDER BY 1;

-- ───────────────────────────────────────────────────────────────────────────
-- DEMANDA SEMANAL COM JANELA LONGA — a razão de tudo isto.
--
-- rapid_inv.v_sp_actual_weekly (006_overview_views.sql:198) faz
-- sum(quantity)/9.0 numa janela de 9 semanas, e o comentário dela diz:
-- "dá para ver viés, não dá para ver sazonalidade nem tendência anual".
-- Esta função é a resposta: mesma unidade (unidades por semana), janela de N
-- meses. NÃO substitui a original — fica ao lado.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cin7_mirror.sales_wk_avg(
  p_months   INT  DEFAULT 12,
  p_location TEXT DEFAULT NULL          -- NULL = todos os armazéns
) RETURNS TABLE (sku_key TEXT, wk_avg NUMERIC, unidades NUMERIC, semanas NUMERIC, desde DATE)
LANGUAGE sql STABLE AS $$
  WITH win AS (
    SELECT (date_trunc('month', CURRENT_DATE) - (p_months || ' months')::interval)::date AS d0,
           (date_trunc('month', CURRENT_DATE) - interval '1 day')::date                  AS d1
  ), base AS (
    SELECT v.sku_key,
           sum(v.qty_signed) AS unidades,
           min(v.order_date) AS desde
      FROM cin7_mirror.v_sales_demand_line v CROSS JOIN win
     WHERE v.order_date BETWEEN win.d0 AND win.d1
       AND v.demanda_classe IN ('consumada','devolucao')   -- saída líquida real
       AND (p_location IS NULL OR v.location_name = p_location)
     GROUP BY 1
  )
  SELECT b.sku_key,
         round((b.unidades / GREATEST((SELECT (d1-d0)::numeric FROM win)/7.0, 1))::numeric, 2) AS wk_avg,
         round(b.unidades,2),
         round((SELECT (d1-d0)::numeric FROM win)/7.0, 1),
         b.desde
    FROM base b WHERE b.unidades <> 0;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- POR VENDEDOR — o que o dono pediu para o branch replenishment.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW cin7_mirror.v_sales_by_rep_month AS
SELECT to_char(order_date,'YYYY-MM')            AS ym,
       sales_rep,
       location_name,
       count(DISTINCT order_number)             AS pedidos,
       count(*)                                 AS linhas,
       round(sum(qty_signed),1)                 AS qty_liquida,
       round(sum(CASE WHEN demanda_classe='devolucao' THEN quantity ELSE 0 END),1) AS qty_devolvida,
       round(sum(CASE WHEN demanda_classe='consumada' THEN total_gross ELSE 0 END)) AS valor_bruto
  FROM cin7_mirror.v_sales_demand_line
 WHERE order_date IS NOT NULL
 GROUP BY 1,2,3;

ALTER TABLE cin7_mirror.sales_history_line ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS shl_read ON cin7_mirror.sales_history_line;
CREATE POLICY shl_read ON cin7_mirror.sales_history_line FOR SELECT USING (true);
GRANT SELECT ON cin7_mirror.sales_history_line          TO anon, authenticated;
GRANT ALL    ON cin7_mirror.sales_history_line          TO service_role;
GRANT SELECT ON cin7_mirror.v_sales_demand_line,
                cin7_mirror.v_sales_by_rep_month,
                public.v_cin7_sales_history_coverage    TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION cin7_mirror.sales_wk_avg(INT,TEXT) TO anon, authenticated, service_role;

SELECT 'sales_history_line' AS t, count(*) FROM cin7_mirror.sales_history_line;
