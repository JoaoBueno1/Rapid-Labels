-- Returns: allow line-level edits (replace lines on Edit / Treatment).
-- The RETURN itself (returns_active) stays delete-blocked — a return document is never deleted.
-- These policies only let the app replace the *lines* of a return (edit stage 1 while pending,
-- and rewrite the finance credit/disposition lines during treatment).

-- Stage-1 lines: needed so "Edit" (pending only) can rewrite the product lines.
drop policy if exists returns_lines_delete on public.returns_lines;
create policy returns_lines_delete on public.returns_lines
  for delete to anon, authenticated using (true);

-- Treatment (credit / disposition) lines: needed so saving/completing a treatment
-- can rewrite the finance lines (edit qty/value, split, remove, zero).
drop policy if exists returns_treatment_lines_delete on public.returns_treatment_lines;
create policy returns_treatment_lines_delete on public.returns_treatment_lines
  for delete to anon, authenticated using (true);

-- NOTE: no delete policy on public.returns_active — returns are never deleted from the app.
