-- ============================================================================
-- 019 — O carrinho de compra.
--
-- Hoje o Buy é relatório: calcula bem e não guarda nada. Quem compra anota o
-- que aceitou noutro lugar, e o que foi decidido morre quando a aba fecha.
--
-- UM CARRINHO ABERTO POR FORNECEDOR, e ele é COMPARTILHADO. Não é descuido
-- com concorrência — é o contrário. O pedido de um fornecedor é um só; se
-- cada pessoa tivesse o seu, duas montariam metade do mesmo contêiner sem se
-- ver. Compartilhado, quem entra depois encontra o trabalho de quem já estava
-- e a linha diz quem a colocou.
--
-- A quantidade nasce da sugestão mas não fica presa a ela: qty_suggested
-- guarda o que o motor disse e qty guarda o que a pessoa decidiu. Sem os dois
-- não dá para saber depois se o pedido seguiu ou contrariou o cálculo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.buy_cart (
  id            bigserial PRIMARY KEY,
  supplier_code text NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  scope         text,             -- o escopo de previsão em que foi montado
  note          text,
  po_number     text,             -- preenchido ao confirmar
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  confirmed_by  text
);

-- Um só carrinho ABERTO por fornecedor. O índice parcial é o que garante isso
-- no banco: garantir na aplicação deixaria a corrida de dois cliques
-- simultâneos criar dois.
CREATE UNIQUE INDEX IF NOT EXISTS ux_buy_cart_open
  ON rapid_inv.buy_cart (supplier_code) WHERE status = 'DRAFT';

CREATE TABLE IF NOT EXISTS rapid_inv.buy_cart_line (
  id             bigserial PRIMARY KEY,
  cart_id        bigint NOT NULL REFERENCES rapid_inv.buy_cart(id) ON DELETE CASCADE,
  sku_key        text NOT NULL,
  sku            text NOT NULL,
  qty            numeric NOT NULL CHECK (qty > 0),
  qty_suggested  numeric,          -- o que o motor calculou, para comparar depois
  carton_qty     numeric,
  unit_cost_aud  numeric,
  source         text NOT NULL DEFAULT 'suggested'
                   CHECK (source IN ('suggested','manual')),
  note           text,
  added_by       text,
  added_at       timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text,
  UNIQUE (cart_id, sku_key)        -- o mesmo SKU duas vezes é edição, não linha nova
);

CREATE INDEX IF NOT EXISTS ix_buy_cart_line_cart ON rapid_inv.buy_cart_line (cart_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.buy_cart, rapid_inv.buy_cart_line
  TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rapid_inv.buy_cart_id_seq, rapid_inv.buy_cart_line_id_seq
  TO anon, authenticated, service_role;

COMMENT ON INDEX rapid_inv.ux_buy_cart_open IS
  'Um carrinho aberto por fornecedor. No banco, nao na aplicacao: dois cliques simultaneos criariam dois.';
COMMENT ON COLUMN rapid_inv.buy_cart_line.qty_suggested IS
  'O que o motor calculou. Guardado ao lado do decidido para se saber depois se o pedido seguiu ou contrariou o calculo.';
