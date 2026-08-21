-- 006_returns_void_attribution.sql — record WHO voided a return, and why.
--
-- The void modal already asks for a name and a reason and writes them, but the
-- columns were never created: returns_active has no voided_by / voided_at /
-- void_reason. Every void therefore fails with
--   "column returns_active.voided_by does not exist"
-- and the return is NOT voided — the write is rejected whole, so nothing is
-- half-applied, but the button simply does not work until this runs.
--
-- Why a name at all, when the action is already behind a password: the void
-- password is shared by the team. It proves the action was permitted; it says
-- nothing about who performed it, and "who voided this return" is exactly what
-- gets asked afterwards.
--
-- Reads are already null-safe (History and the detail view fall back to
-- updated_at), so this is purely additive. Safe to re-run.

ALTER TABLE public.returns_active
  ADD COLUMN IF NOT EXISTS voided_by   TEXT,
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Backfill the stamp for returns voided before this existed, so the History
-- column is not blank for them. The name is unknowable and stays NULL —
-- inventing one would be worse than an honest gap.
UPDATE public.returns_active
   SET voided_at = updated_at
 WHERE status = 'void' AND voided_at IS NULL;

SELECT count(*) AS voided_returns_backfilled
  FROM public.returns_active
 WHERE status = 'void' AND voided_by IS NULL;
