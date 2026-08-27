-- ============================================================================
-- 012 — Os pedidos de transferência colocados no Cin7, e a garantia de que
--       cada plano vira UM TR e não dois.
--
-- Esta é a primeira escrita do módulo num ERP de produção. O risco não é o
-- caminho feliz: é o duplo clique, o refresh no meio da chamada e o timeout
-- que devolve erro depois do Cin7 já ter criado. Em todos esses a tela tenta
-- de novo, e sem uma chave de idempotência a segunda tentativa cria um
-- segundo TR que ninguém pediu.
--
-- Por isso o op_key é UNIQUE e derivado do CONTEÚDO do plano (filial + modo +
-- semana + linhas). Duas chamadas com o mesmo plano colidem na inserção; a
-- segunda lê a linha existente e devolve o mesmo número de TR.
--
-- O ponto de retomada é o cin7_task_id: ele é gravado assim que o Cin7
-- responde, ANTES de qualquer outra coisa. Se o processo morrer depois disso,
-- a próxima tentativa encontra o TaskID e consulta o Cin7 em vez de criar.
--
-- Status ORDERED de propósito: cria a ordem sem mover estoque. É reversível —
-- dá para apagar no Cin7 sem acerto de inventário.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.replenishment_order (
  id             bigserial PRIMARY KEY,
  op_key         text        NOT NULL UNIQUE,
  branch_code    text        NOT NULL,
  branch_name    text,
  mode           text        NOT NULL CHECK (mode IN ('weekly', 'daily')),
  week_ending    date,
  -- O plano exatamente como foi enviado. É o snapshot imutável que o History
  -- lê: reconstruir depois a partir do estoque de hoje daria outro número.
  lines          jsonb       NOT NULL,
  total_units    numeric     NOT NULL DEFAULT 0,
  line_count     int         NOT NULL DEFAULT 0,
  from_location  text,
  from_location_id text,
  to_location    text,
  to_location_id text,
  -- PENDING enquanto a chamada não voltou; ORDERED quando o Cin7 confirmou;
  -- FAILED com a razão, para a tela poder mostrar o que houve.
  status         text        NOT NULL DEFAULT 'PENDING',
  cin7_task_id   text,
  cin7_number    text,
  error          text,
  created_by     text        NOT NULL DEFAULT 'anon',
  created_at     timestamptz NOT NULL DEFAULT now(),
  ordered_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ix_rp_order_branch ON rapid_inv.replenishment_order (branch_code, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_rp_order_number ON rapid_inv.replenishment_order (cin7_number);

COMMENT ON COLUMN rapid_inv.replenishment_order.op_key IS
  'Hash do conteúdo do plano. UNIQUE — é o que impede o duplo clique de virar dois TRs.';
COMMENT ON COLUMN rapid_inv.replenishment_order.lines IS
  'Snapshot imutável das linhas no momento do envio. O History lê daqui, nunca recalcula.';

GRANT SELECT, INSERT, UPDATE ON rapid_inv.replenishment_order TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rapid_inv.replenishment_order_id_seq TO anon, authenticated, service_role;
