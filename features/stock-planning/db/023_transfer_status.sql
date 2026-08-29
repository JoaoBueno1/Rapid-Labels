-- ============================================================================
-- 023 — O status de verdade da transferência, e não o que gravamos ao criar.
--
-- Achado ao conferir a TR-50193, que a tela mostrava como ORDERED: no Cin7 ela
-- está VOIDED. E não era só ela — as SEIS transferências que este módulo criou
-- estavam VOIDED, canceladas à mão depois dos testes, e a tela mostrava as
-- seis como ORDERED.
--
-- A causa é simples e a lição é geral: `status` guardava o que ESCREVEMOS no
-- momento da criação. Nunca voltamos a perguntar. Um campo assim não é o
-- estado do pedido, é o registro de uma intenção antiga — e quanto mais tempo
-- passa, mais ele mente.
--
-- Por isso as colunas novas são separadas de `status` em vez de sobrescrevê-lo:
--   status       o que NÓS pedimos ao criar. Não muda. É o registro do ato.
--   cin7_status  o que o Cin7 diz HOJE. Muda, e por isso carrega a hora em que
--                foi lido — um status sem data de leitura é a mesma armadilha
--                de novo, só que mais convincente.
-- ============================================================================

ALTER TABLE rapid_inv.replenishment_order
  ADD COLUMN IF NOT EXISTS cin7_status     text,
  ADD COLUMN IF NOT EXISTS cin7_status_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cin7_completed  date;

COMMENT ON COLUMN rapid_inv.replenishment_order.status IS
  'O que NOS pedimos ao criar. Nao muda depois. Para o estado atual, use cin7_status.';
COMMENT ON COLUMN rapid_inv.replenishment_order.cin7_status IS
  'O que o Cin7 respondeu na ultima leitura. Sempre acompanhado de cin7_status_at.';

CREATE INDEX IF NOT EXISTS ix_repl_order_task
  ON rapid_inv.replenishment_order (cin7_task_id) WHERE cin7_task_id IS NOT NULL;
