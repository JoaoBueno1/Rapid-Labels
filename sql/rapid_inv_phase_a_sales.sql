-- =================================================================
--  RAPID INVENTORY SKU — Fase A: Sales históricos (cache + index)
-- -----------------------------------------------------------------
--  Objetivo: popular rapid_inv.weekly_sales com os sales completados
--  dos últimos N semanas (extraídos do Cin7 /sale/{id} endpoint).
--
--  Esta tabela é apenas CACHE local: marca quais SOs já tiveram
--  suas linhas baixadas, para o sync incremental ser super rápido
--  (depois da primeira run).
-- =================================================================

CREATE TABLE IF NOT EXISTS rapid_inv._sales_processed_orders (
  sale_id        TEXT PRIMARY KEY,           -- Cin7 SaleID (UUID ou número)
  sale_number    TEXT,                       -- ex: SO-248253
  completed_at   TIMESTAMPTZ,                -- da Cin7
  items_count    INT,                        -- nº de linhas extraídas
  total_qty      NUMERIC,                    -- soma das qtys (sanity)
  processed_at   TIMESTAMPTZ DEFAULT now(),  -- quando o script processou
  cin7_modified  TIMESTAMPTZ                 -- last_modified vindo do Cin7
);
CREATE INDEX IF NOT EXISTS idx_spo_completed  ON rapid_inv._sales_processed_orders(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_spo_processed  ON rapid_inv._sales_processed_orders(processed_at DESC);

-- Garantir que weekly_sales tem índice para upsert rápido
CREATE INDEX IF NOT EXISTS idx_weekly_sales_uniq ON rapid_inv.weekly_sales(week_start, sku);

-- View de status — quanto já processamos / pendente
CREATE OR REPLACE VIEW rapid_inv.v_sales_sync_status AS
SELECT
  (SELECT COUNT(*) FROM rapid_inv._sales_processed_orders)        AS processed_sos,
  (SELECT COUNT(*) FROM cin7_mirror.order_pipeline
     WHERE type = 'SO' AND status IN ('COMPLETED','CLOSED'))      AS total_completed_sos_in_mirror,
  (SELECT COUNT(*) FROM rapid_inv.weekly_sales)                   AS weekly_sales_rows,
  (SELECT MIN(week_start) FROM rapid_inv.weekly_sales)            AS oldest_week,
  (SELECT MAX(week_start) FROM rapid_inv.weekly_sales)            AS newest_week,
  (SELECT MAX(processed_at) FROM rapid_inv._sales_processed_orders) AS last_sync_at;

GRANT SELECT ON rapid_inv._sales_processed_orders TO anon, authenticated;
GRANT SELECT ON rapid_inv.v_sales_sync_status     TO anon, authenticated;

DO $$
DECLARE v_completed INT;
BEGIN
  SELECT COUNT(*) INTO v_completed FROM cin7_mirror.order_pipeline
   WHERE type='SO' AND status IN ('COMPLETED','CLOSED');
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  Fase A — Cache criado ✅';
  RAISE NOTICE '  Cin7 mirror tem % SOs completados (a serem processados)', v_completed;
  RAISE NOTICE '  Tempo estimado da 1ª run: ~% min (a 50 calls/min)',
               GREATEST((v_completed/50)::int, 1);
  RAISE NOTICE '======================================================';
END $$;
