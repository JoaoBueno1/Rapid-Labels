-- ============================================================================
-- 018 — Escopo da previsão: para QUEM esta projeção está sendo feita.
--
-- Hoje a tela tem uma resposta só — o estoque somado e a média digitada no
-- arquivo — e ela serve para comprar. Não serve para perguntar se Sydney tem
-- cobertura, porque mistura o estoque de Cairns com a venda de Sydney.
--
-- Duas coisas mudam junto com o escopo, e mudar só uma seria pior que não
-- mudar nenhuma:
--   a DEMANDA  — quanto aquele conjunto de filiais vende
--   o ESTOQUE  — quanto aquele conjunto de filiais tem
--
-- ATRIBUIÇÃO DA DEMANDA. Uma venda pertence à filial por dois caminhos, e o
-- segundo é o que o usuário apontou: quando a filial não tem o produto, o
-- pedido sai do Main, e a venda fica gravada como Main. Só o rep continua
-- sendo o da filial. Medido antes: por rep, Brisbane sobe +175% sobre a conta
-- por local, Sydney +80%, Sunshine +50% — e Cairns, Coffs e Hobart quase não
-- se mexem, que é o padrão geográfico esperado de quem está longe do Main.
--
-- Por isso a linha conta para a filial se o LOCAL é dela OU o REP é dela. É
-- união de linhas de pedido, não soma de dois totais: somar contaria duas
-- vezes toda venda em que o rep de Sydney vendeu do próprio depósito.
-- ============================================================================

DROP VIEW IF EXISTS rapid_inv.v_sp_demand_scope CASCADE;
CREATE VIEW rapid_inv.v_sp_demand_scope AS
SELECT
  d.sku_key,
  d.order_number, d.row_seq, d.order_date, d.qty_signed,
  d.location_name,
  d.sales_rep,
  w.code       AS location_branch,   -- a filial pelo depósito da venda
  m.branch_code AS rep_branch         -- a filial pelo rep que vendeu
FROM cin7_mirror.v_sales_demand_line d
LEFT JOIN rapid_inv.warehouses w      ON w.cin7_location_name = d.location_name
LEFT JOIN rapid_inv.sales_rep_branch m ON m.sales_rep = d.sales_rep AND m.is_active;

GRANT SELECT ON rapid_inv.v_sp_demand_scope TO anon, authenticated, service_role;

COMMENT ON VIEW rapid_inv.v_sp_demand_scope IS
  'Cada linha de venda com as DUAS filiais possiveis: a do deposito e a do rep. Quem escolhe e o escopo.';

-- Índice do lado que o filtro usa. Sem ele a soma por escopo varre as 170.672
-- linhas a cada troca de modo.
CREATE INDEX IF NOT EXISTS ix_sales_demand_rep
  ON cin7_mirror.sales_history_line (sales_rep) WHERE sales_rep IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sales_demand_loc
  ON cin7_mirror.sales_history_line (location_name) WHERE location_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sales_demand_date
  ON cin7_mirror.sales_history_line (order_date);
