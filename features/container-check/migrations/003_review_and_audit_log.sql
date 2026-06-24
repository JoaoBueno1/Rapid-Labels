-- =====================================================================
-- CONTAINER CHECK — 003: review stamps + audit log
-- Aditivo/idempotente. Cole no Supabase SQL Editor (projeto do Rapid-Labels).
-- A feature funciona sem isto (o engine degrada com elegância); rodar isto
-- liga (a) quem/quando revisou e (b) o LOG de histórico de tudo.
-- =====================================================================

-- (a) quem revisou e quando
ALTER TABLE cin7_mirror.container_checks ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE cin7_mirror.container_checks ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- (b) LOG de auditoria — 1 linha por ação (criar / editar / revisar / apagar /
--     foto adicionada/removida). Nunca é apagado quando o registro é apagado
--     (record_id sem FK de propósito — o histórico sobrevive).
CREATE TABLE IF NOT EXISTS cin7_mirror.container_check_log (
  id          BIGSERIAL PRIMARY KEY,
  record_id   UUID,                     -- aponta pro container_checks.id (sem FK: log sobrevive ao delete)
  rapid_code  TEXT,                     -- snapshot, pra ler o log mesmo após delete
  action      TEXT NOT NULL,            -- created | updated | reviewed | deleted
  actor       TEXT,                     -- nome do localStorage
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cclog_record ON cin7_mirror.container_check_log (record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cclog_time   ON cin7_mirror.container_check_log (created_at DESC);

ALTER TABLE cin7_mirror.container_check_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cclog read"  ON cin7_mirror.container_check_log;
DROP POLICY IF EXISTS "cclog write" ON cin7_mirror.container_check_log;
CREATE POLICY "cclog read"  ON cin7_mirror.container_check_log FOR SELECT USING (true);
CREATE POLICY "cclog write" ON cin7_mirror.container_check_log FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON cin7_mirror.container_check_log TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE cin7_mirror.container_check_log_id_seq TO anon, authenticated;
GRANT ALL ON cin7_mirror.container_check_log TO service_role;
