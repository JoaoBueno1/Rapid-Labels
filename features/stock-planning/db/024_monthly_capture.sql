-- ============================================================================
-- 024 — A captura que o relatório mensal precisa e que ninguém faz hoje.
--
-- O Inventory Report é montado à mão todo mês. Ao mapear os 33 slides contra
-- os dados, metade sai do banco hoje. Mas SEIS deles são impossíveis, e não
-- por falta de código: ninguém guardou o histórico.
--
--   "Opening SOH" de Damaged/Faulty      precisa do saldo de ontem
--   "Top 10 em estoque baixo em 6 meses" precisa de seis meses de saldo diário
--   "Value Cleared" dos descontinuados   precisa do valor de cada mês
--   "Decrease in Open Orders by $730k"   precisa do open order do mês passado
--
-- O sync do Cin7 faz TRUNCATE e reescreve: o saldo de julho já não existe em
-- lugar nenhum, e o Cin7 não vende saldo em data passada. Isto é o ponto
-- inteiro deste arquivo: cada dia que passa sem gravar é um dia que não volta.
-- Ligado hoje, o slide de seis meses existe daqui a seis meses. Ligado em
-- fevereiro, existe em agosto.
--
-- CUSTO CONGELADO. A quantidade é factual, o valor não: average_cost muda no
-- Cin7 e recalcular o valor de julho com o custo de dezembro dá outro número
-- — parecido o bastante para ninguém desconfiar. Por isso o custo unitário é
-- gravado JUNTO da quantidade, e o valor de um mês fechado nunca se move.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.mr_soh_daily (
  snapshot_date  date    NOT NULL,
  sku_key        text    NOT NULL,
  sku            text    NOT NULL,
  location       text    NOT NULL,
  on_hand        numeric NOT NULL DEFAULT 0,
  allocated      numeric,
  available      numeric,
  in_transit     numeric,
  -- O custo do DIA. Sem ele o valor histórico é recalculável, e recalculável
  -- quer dizer que muda sozinho.
  unit_cost      numeric,
  value_at_cost  numeric GENERATED ALWAYS AS (on_hand * coalesce(unit_cost, 0)) STORED,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, sku_key, location)
);

-- A consulta que o relatório faz é sempre "este SKU ao longo do tempo" ou
-- "este local neste mês". Os dois índices são esses dois caminhos.
CREATE INDEX IF NOT EXISTS ix_mr_soh_sku  ON rapid_inv.mr_soh_daily (sku_key, snapshot_date);
CREATE INDEX IF NOT EXISTS ix_mr_soh_loc  ON rapid_inv.mr_soh_daily (location, snapshot_date);

COMMENT ON TABLE rapid_inv.mr_soh_daily IS
  'Saldo diario por SKU e local, com o custo do dia congelado. Alimenta os slides de opening/closing, estoque baixo em 6 meses e valor descontinuado.';
COMMENT ON COLUMN rapid_inv.mr_soh_daily.unit_cost IS
  'Custo medio do produto NO DIA da captura. Gravado junto de proposito: recalcular depois muda o valor de um mes ja fechado.';

-- ── Open orders por rep, uma foto por mês ──────────────────────────────
-- O slide diz "Decrease in Open Orders by $730,801.55". Essa frase é a
-- diferença contra o mês anterior, e hoje ela é digitada olhando o Excel do
-- mês passado. Com a foto, ela vira subtração.
CREATE TABLE IF NOT EXISTS rapid_inv.mr_open_orders_monthly (
  month_end      date NOT NULL,
  rep            text NOT NULL,
  orders         int     NOT NULL DEFAULT 0,
  value_open     numeric NOT NULL DEFAULT 0,
  value_invoiced numeric NOT NULL DEFAULT 0,
  value_left     numeric NOT NULL DEFAULT 0,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month_end, rep)
);

COMMENT ON TABLE rapid_inv.mr_open_orders_monthly IS
  'Foto mensal dos pedidos em aberto por rep. A frase "queda de $X" do slide e a diferenca entre duas fotas.';

-- ── E POR QUE NÃO DÁ PARA RECUPERAR O PASSADO ──────────────────────────
-- A tentação óbvia é reconstruir: o saldo de ontem é o de hoje menos o que se
-- moveu, e cin7_mirror.stock_movements tem 67.321 movimentos desde 09/06/2026.
-- Isso daria dois meses e meio de graça. Testei antes de acreditar.
--
-- Primeiro: as colunas quantity_before e quantity_after existem na tabela e
-- estão VAZIAS nas 67.321 linhas. Ninguém as preenche. Elas parecem a resposta
-- e não são.
--
-- Segundo: somando os deltas para trás a partir da foto de 29/08 e comparando
-- com a foto que existe de 25/08 — 2.620 SKUs comparáveis, 1.107 exatos.
--   acerto exato        42%
--   dentro de 5 unidades 65%
--   erro médio          44,7 unidades
--   921 SKUs erram por mais de 5
-- O feed de movimentos não é completo o bastante. Um "Opening SOH" com 42% de
-- acerto num relatório de fechamento é pior que a ausência dele: parece
-- número e não é.
--
-- Então a conclusão medida, e não presumida: a série começa no dia em que
-- a captura for ligada. Não há atalho.

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.mr_soh_daily, rapid_inv.mr_open_orders_monthly
  TO anon, authenticated, service_role;
