-- ============================================================
-- Analytics · 002 · O QUADRO DE TRABALHO DO RELATORIO MENSAL
-- ------------------------------------------------------------
-- O relatorio mensal tem 54 analises distintas (33 no Inventory Report de
-- julho, 21 no Master). 36 delas ja podem sair do PowerPoint com o dado que
-- existe hoje; 14 dependem de historico ou de uma definicao; 4 sao texto.
--
-- Este quadro e onde esse trabalho acontece ao longo do tempo: cada analise
-- tem um estado, uma nota, e um dono. Sem isto, "voltar depois" significa
-- reabrir o PowerPoint e tentar lembrar o que ja tinha sido decidido.
--
-- POR QUE UMA TABELA E NAO localStorage: o Joao trabalha de duas maquinas, e
-- nota que existe so num navegador nao e nota, e rascunho perdido. O mesmo
-- motivo pelo qual a decisao de alocacao de rep foi para rapid_inv em vez de
-- ficar na tela.
--
-- COMO APLICAR: colar no SQL Editor do Supabase (projeto do Labels) e rodar.
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS rapid_inv.review_board (
  slide_key   TEXT PRIMARY KEY,          -- 'jul-09' | 'master-13'
  deck        TEXT NOT NULL,             -- 'jul' | 'master'
  slide_no    INT  NOT NULL,
  title       TEXT NOT NULL,
  -- readiness: o que a ANALISE do dado disse. Nao muda com o trabalho; e o
  -- ponto de partida. 'pronto' = fonte sincronizada e regra ja escrita.
  readiness   TEXT NOT NULL DEFAULT 'parcial'
              CHECK (readiness IN ('pronto', 'parcial', 'manual')),
  -- status: onde o trabalho esta. Este sim muda.
  status      TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'working', 'done')),
  note        TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE rapid_inv.review_board IS
  'Estado e notas de cada analise do relatorio mensal. readiness vem da analise do dado; status vem do trabalho.';

CREATE INDEX IF NOT EXISTS idx_review_board_deck ON rapid_inv.review_board (deck, slide_no);

-- ───────────────────────────────────────────────────────────────────
-- Leitura e escrita pela API REST, com a chave que o repo ja tem.
-- Sem senha de banco: o mesmo caminho que o replenishment passou a usar
-- depois de 31/08, e pelo mesmo motivo -- variavel que so existe numa
-- maquina faz a tela quebrar em silencio na outra.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE rapid_inv.review_board ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_board_read  ON rapid_inv.review_board;
DROP POLICY IF EXISTS review_board_write ON rapid_inv.review_board;

CREATE POLICY review_board_read  ON rapid_inv.review_board FOR SELECT USING (true);
CREATE POLICY review_board_write ON rapid_inv.review_board FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.review_board
  TO anon, authenticated, service_role;

-- Prova de vida.
SELECT 'review_board pronto' AS status,
       (SELECT count(*) FROM rapid_inv.review_board) AS linhas;
