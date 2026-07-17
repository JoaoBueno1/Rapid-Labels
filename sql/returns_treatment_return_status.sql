-- Returns: Return Status moved to the office stage (Action / treatment).
-- The warehouse can't decide credit vs warranty at intake — the office does it
-- per credit line while processing. So the status lives on the treatment lines.
alter table public.returns_treatment_lines
  add column if not exists return_status text;   -- Accepted for Credit Assessment / Accepted for Warranty Assessment / Return Not Accepted

-- (returns_lines.return_status is now unused — left in place, harmless.)
