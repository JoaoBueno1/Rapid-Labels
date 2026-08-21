-- 005_returns_line_treatment.sql — credit note and processor PER LINE, plus a line log.
--
-- Why: one return can be finished by more than one person, at different times, with a
-- different credit note per line. Until now both lived on the header
-- (returns_active.treatment_ref / treated_by), so a return could only ever carry one of
-- each — and whoever finished the second half was invisible.
--
-- Design note: the values are always written onto every line, never inherited from the
-- header. Simple mode just fills them all at once. That way a line always states its own
-- credit note and its own processor, and no reader anywhere has to compute an
-- "effective value" — which is what makes the log below trustworthy.
--
-- Additive and nullable, so the app keeps working before this runs (the per-line fields
-- simply will not persist). Safe to re-run.

ALTER TABLE public.returns_treatment_lines
  ADD COLUMN IF NOT EXISTS credit_note  TEXT,
  ADD COLUMN IF NOT EXISTS processed_by TEXT,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Append-only. A line gets corrected — wrong credit note, status changed after the
-- customer called — and overwriting the field would erase exactly the history someone
-- will ask about. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS public.returns_line_log (
  id         BIGSERIAL PRIMARY KEY,
  return_id  UUID NOT NULL,
  line_no    INT,
  sku        TEXT,
  action     TEXT NOT NULL,              -- resolved | reopened | credit_note | status | split | removed
  detail     JSONB DEFAULT '{}'::jsonb,  -- {from, to}
  by_name    TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rll_return ON public.returns_line_log (return_id, at DESC);

ALTER TABLE public.returns_line_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS returns_line_log_read  ON public.returns_line_log;
DROP POLICY IF EXISTS returns_line_log_write ON public.returns_line_log;
CREATE POLICY returns_line_log_read  ON public.returns_line_log FOR SELECT USING (true);
-- Insert only: no UPDATE or DELETE policy exists, so the log cannot be rewritten
-- through the API even with a valid key.
CREATE POLICY returns_line_log_write ON public.returns_line_log FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON public.returns_line_log TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.returns_line_log_id_seq TO anon, authenticated;

SELECT 'returns line treatment ready' AS status;
