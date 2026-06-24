-- =====================================================================
-- CONTAINER CHECK — QC de recebimento (inbound) — TABELA
-- File: features/container-check/migrations/001_create_container_checks.sql
-- Idempotente (IF NOT EXISTS). Aditivo — nunca dropa dados.
-- Aplicar: python scripts/apply_sql.py <este arquivo>  (ou SQL Editor)
-- Storage (bucket de fotos) está em 002_container_check_storage.sql.
--
-- Sem trigger/função aqui de propósito: o apply_sql.py do TMS faz split
-- ingênuo por ';' e não entende corpo de função $$...$$. O updated_at é
-- bumpado pelo engine no PUT.
-- =====================================================================

CREATE TABLE IF NOT EXISTS cin7_mirror.container_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  five_dc         TEXT,
  rapid_code      TEXT NOT NULL,
  qty             NUMERIC,
  po              TEXT,
  ocl             TEXT CHECK (ocl IN ('OK','Wrong','Missing','N/A')),
  icl             TEXT CHECK (icl IN ('OK','Wrong','Missing','N/A')),
  bar             TEXT CHECK (bar IN ('OK','Wrong','Missing','N/A')),
  photos          JSONB NOT NULL DEFAULT '[]',
  inventory_notes TEXT,
  reviewer_notes  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('green','red','orange','pending')),
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_date   ON cin7_mirror.container_checks (check_date DESC);
CREATE INDEX IF NOT EXISTS idx_cc_status ON cin7_mirror.container_checks (status);
CREATE INDEX IF NOT EXISTS idx_cc_code   ON cin7_mirror.container_checks (rapid_code);

ALTER TABLE cin7_mirror.container_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cc read"  ON cin7_mirror.container_checks;
DROP POLICY IF EXISTS "cc write" ON cin7_mirror.container_checks;
CREATE POLICY "cc read"  ON cin7_mirror.container_checks FOR SELECT USING (true);
CREATE POLICY "cc write" ON cin7_mirror.container_checks FOR ALL USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON cin7_mirror.container_checks TO anon, authenticated;
GRANT ALL ON cin7_mirror.container_checks TO service_role;
