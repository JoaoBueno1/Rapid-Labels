-- ═══════════════════════════════════════════════════════════════════════════
-- 002b — preenche occurred_at nas linhas que já existem. RODAR DEPOIS do 002a.
--
-- Separado da DDL porque o SQL Editor do Supabase executa o script inteiro em
-- uma transação: um cast que estoure aqui abortaria os CREATE TABLE do 002a.
--
-- Medido em 2026-08-26: 66.145 linhas em stock_movements, 36.732 com a chave
-- ship_date em raw_data, 36.702 não-nulas.
--
-- Em lotes de 10.000 para não segurar lock longo numa tabela que o webhook
-- escreve o tempo todo. Rode até imprimir 0.
-- ═══════════════════════════════════════════════════════════════════════════
WITH alvo AS (
  SELECT id FROM cin7_mirror.stock_movements
   WHERE occurred_at IS NULL
   LIMIT 10000
   FOR UPDATE SKIP LOCKED
)
UPDATE cin7_mirror.stock_movements m
   SET occurred_at = COALESCE(
         -- a guarda de formato é gratuita e elimina a única forma de o cast
         -- derrubar o lote: um ship_date que não seja ISO.
         CASE WHEN m.raw_data->>'ship_date' ~ '^\d{4}-\d{2}-\d{2}'
              THEN (m.raw_data->>'ship_date')::timestamptz END,
         m.detected_at)
  FROM alvo WHERE m.id = alvo.id;

-- Quantas faltam. Repita o script acima enquanto isto for > 0.
SELECT count(*) AS ainda_nulas FROM cin7_mirror.stock_movements WHERE occurred_at IS NULL;
