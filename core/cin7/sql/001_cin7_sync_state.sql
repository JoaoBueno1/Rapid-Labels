-- ═══════════════════════════════════════════════════════════════════════════
-- ops.cin7_sync_state — o estado do backfill vive AQUI, não na conversa.
--
-- Idempotente: pode colar de novo no SQL Editor do Supabase quantas vezes
-- quiser. NÃO vai por apply_sql.py (o Supabase do Labels é separado do TMS).
--
-- Uma linha por (job, chunk). Um chunk é a menor unidade que vale a pena
-- refazer inteira quando algo dá errado: um mês de vendas, uma faixa de
-- páginas de uma lista, um status de PO. O `cursor` é o ponto de retomada
-- DENTRO do chunk, para o caso de o orçamento de tempo acabar no meio.
--
-- Por que uma tabela nova em vez de cin7_mirror.backfill_state:
--   backfill_state tem PK só em `job` (sql/2026-06-17_sales_mirror.sql:133),
--   então não consegue guardar 13 meses de progresso; `done` é gravado ao sair
--   do laço por qualquer motivo (backfill-sales.js:163) e nunca é reposto; e o
--   nome do job não carrega a janela, então um re-run com outro BACKFILL_SINCE
--   retoma em last_page+1 de OUTRO conjunto de resultados e pula tudo em
--   silêncio. Esta tabela é ADITIVA — backfill_state fica intocada.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.cin7_sync_state (
  job           TEXT        NOT NULL,   -- 'sales_detail' | 'po_detail' | 'tr_header' | ...
  chunk_key     TEXT        NOT NULL,   -- '2025-08' | 'page:0019' | 'status:ORDERED'
  seq           INT         NOT NULL,   -- ordem de execução dentro do job (menor primeiro)
  status        TEXT        NOT NULL DEFAULT 'pending',
                -- pending | running | done | failed | blocked | skipped
  cursor        JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- retomada DENTRO do chunk
  target_count  INT,                    -- quantas unidades este chunk deve produzir
  done_count    INT         NOT NULL DEFAULT 0,
  calls_used    INT         NOT NULL DEFAULT 0,
  attempts      INT         NOT NULL DEFAULT 0,
  lease_owner   TEXT,                   -- quem está com o chunk agora
  lease_until   TIMESTAMPTZ,            -- expira sozinho se o processo morrer
  last_error    TEXT,
  first_run_at  TIMESTAMPTZ,
  last_run_at   TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  notes         TEXT,
  PRIMARY KEY (job, chunk_key),
  CONSTRAINT cin7_sync_state_status_ck
    CHECK (status IN ('pending','running','done','failed','blocked','skipped'))
);

CREATE INDEX IF NOT EXISTS idx_css_next
  ON ops.cin7_sync_state (status, seq)
  WHERE status IN ('pending','failed');

-- Log append-only: uma linha por INVOCAÇÃO do driver. É o que a IA lê para
-- saber "o que aconteceu desde a última vez" sem reler o repositório.
CREATE TABLE IF NOT EXISTS ops.cin7_sync_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job         TEXT,
  chunk_key   TEXT,
  outcome     TEXT NOT NULL,           -- progress | complete | failed | blocked | idle | fatal
  calls       INT  DEFAULT 0,
  rows_written INT DEFAULT 0,
  duration_ms INT,
  owner       TEXT,
  message     TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_csl_at ON ops.cin7_sync_log (at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- CLAIM ATÔMICO. É esta função que deixa cron, humano e agente rodarem ao
-- mesmo tempo sem pegar o mesmo chunk. SKIP LOCKED = quem chegou depois pega
-- o próximo em vez de esperar. Um chunk 'running' com lease vencido volta a
-- ser elegível sozinho — processo morto não trava a fila.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cin7_claim_chunk(
  p_owner     TEXT,
  p_lease_min INT  DEFAULT 20,
  p_job       TEXT DEFAULT NULL
) RETURNS SETOF ops.cin7_sync_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ops, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE ops.cin7_sync_state s
     SET status      = 'running',
         attempts    = s.attempts + 1,
         lease_owner = p_owner,
         lease_until = now() + make_interval(mins => p_lease_min),
         last_run_at = now(),
         first_run_at = COALESCE(s.first_run_at, now())
   WHERE (s.job, s.chunk_key) = (
     SELECT c.job, c.chunk_key
       FROM ops.cin7_sync_state c
      WHERE (p_job IS NULL OR c.job = p_job)
        AND (
              c.status IN ('pending','failed')
              OR (c.status = 'running' AND c.lease_until < now())
            )
        AND c.attempts < 6            -- 6 tentativas e vira 'blocked' (ver abaixo)
      -- Desempate por last_run_at: sem ele o claim devolve SEMPRE o mesmo
      -- chunk (ORDER BY seq LIMIT 1) e um chunk que nunca fecha trava a fila.
      ORDER BY c.seq, c.last_run_at ASC NULLS FIRST, c.chunk_key
      FOR UPDATE SKIP LOCKED
      LIMIT 1
   )
  RETURNING s.*;
END $$;

-- Chunk que estourou as tentativas sai da fila e pede humano.
CREATE OR REPLACE FUNCTION public.cin7_block_exhausted()
RETURNS INT LANGUAGE sql SECURITY DEFINER SET search_path = ops, public
AS $$ WITH b AS (
        UPDATE ops.cin7_sync_state SET status = 'blocked'
         WHERE status IN ('pending','failed') AND attempts >= 6
        RETURNING 1)
      SELECT count(*)::INT FROM b; $$;

-- ───────────────────────────────────────────────────────────────────────────
-- A VIEW QUE A IA LÊ. Uma linha por job. É de propósito curta: o loop precisa
-- de ~10 linhas de saída, não de um dump.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cin7_backfill_status AS
SELECT
  s.job,
  count(*)                                                   AS chunks,
  count(*) FILTER (WHERE s.status = 'done')                  AS done,
  count(*) FILTER (WHERE s.status = 'running')               AS running,
  count(*) FILTER (WHERE s.status IN ('pending','failed'))   AS todo,
  count(*) FILTER (WHERE s.status = 'blocked')               AS blocked,
  round(100.0 * count(*) FILTER (WHERE s.status = 'done') / nullif(count(*),0), 1) AS pct,
  sum(s.done_count)                                          AS rows_done,
  sum(s.calls_used)                                          AS calls_used,
  max(s.last_run_at)                                         AS last_run_at,
  min(s.seq) FILTER (WHERE s.status IN ('pending','failed')) AS next_seq,
  (array_agg(s.chunk_key ORDER BY s.seq)
     FILTER (WHERE s.status IN ('pending','failed')))[1]     AS next_chunk,
  (array_agg(s.chunk_key || ': ' || left(coalesce(s.last_error,''), 120)
             ORDER BY s.last_run_at DESC)
     FILTER (WHERE s.status IN ('failed','blocked')))[1]     AS last_problem
FROM ops.cin7_sync_state s
GROUP BY s.job
ORDER BY min(s.seq);

-- ───────────────────────────────────────────────────────────────────────────
-- COBERTURA REAL, mês a mês — a 8ª checagem que falta ao verify-coverage.js.
-- Não olha o checkpoint (que pode mentir); olha o DADO.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_cin7_sales_detail_coverage AS
WITH m AS (
  SELECT to_char(so.order_date, 'YYYY-MM')                        AS ym,
         count(*)                                                  AS orders,
         count(*) FILTER (WHERE so.detail_synced_at IS NOT NULL)   AS detailed,
         count(*) FILTER (WHERE so.detail_synced_at IS NOT NULL
                            AND so.cin7_updated > so.detail_synced_at) AS stale,
         -- EXISTS, nunca JOIN: sale_lines tem N linhas por pedido (média 2,6),
         -- e um LEFT JOIN faz count(*) contar pares pedido×linha. Um mês com
         -- 94,3% real reportava 99,00% — e o chunk fechava como concluído.
         count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM cin7_mirror.sale_lines sl
              WHERE sl.order_number = so.order_number))            AS with_lines,
         -- O buraco que nenhum teste enxergava: detalhado e SEM linha. Já são
         -- 1.248 pedidos, todos nos meses alimentados pelo webhook.
         count(*) FILTER (WHERE so.detail_synced_at IS NOT NULL
                            AND NOT EXISTS (
             SELECT 1 FROM cin7_mirror.sale_lines sl
              WHERE sl.order_number = so.order_number))            AS detailed_no_lines
    FROM cin7_mirror.sales_orders so
   WHERE so.order_date >= DATE '2025-08-01'
     AND coalesce(so.status,'') NOT IN ('VOIDED','CANCELLED')
   GROUP BY 1
)
SELECT ym, orders, detailed, stale, with_lines, detailed_no_lines,
       round(100.0 * detailed / nullif(orders,0), 1)   AS pct_detailed,
       round(100.0 * with_lines / nullif(orders,0), 1) AS pct_with_lines,
       -- 'detalhado' sem linha não conta como coberto. O veredicto olha
       -- pct_with_lines, não pct_detailed: é a linha que o consumidor lê.
       CASE WHEN 100.0 * with_lines / nullif(orders,0) >= 99 THEN 'OK'
            WHEN 100.0 * with_lines / nullif(orders,0) >= 90 THEN 'WARN'
            ELSE 'FAIL' END                            AS verdict
FROM m ORDER BY ym;

-- ───────────────────────────────────────────────────────────────────────────
-- RLS + GRANTS — mesmo padrão do resto do repo.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE ops.cin7_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.cin7_sync_log   ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cin7_sync_state_read ON ops.cin7_sync_state;
CREATE POLICY cin7_sync_state_read ON ops.cin7_sync_state FOR SELECT USING (true);
DROP POLICY IF EXISTS cin7_sync_log_read ON ops.cin7_sync_log;
CREATE POLICY cin7_sync_log_read ON ops.cin7_sync_log FOR SELECT USING (true);

GRANT USAGE  ON SCHEMA ops TO anon, authenticated, service_role;
GRANT SELECT ON ops.cin7_sync_state, ops.cin7_sync_log TO anon, authenticated;
GRANT ALL    ON ops.cin7_sync_state, ops.cin7_sync_log TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO service_role;
GRANT SELECT ON public.v_cin7_backfill_status, public.v_cin7_sales_detail_coverage
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cin7_claim_chunk(TEXT,INT,TEXT)  TO service_role;
GRANT EXECUTE ON FUNCTION public.cin7_block_exhausted()           TO service_role;

-- verificação
SELECT 'ops.cin7_sync_state' AS obj, count(*) AS rows FROM ops.cin7_sync_state;
