-- ═══════════════════════════════════════════════════════════════
-- Returns — align to the client spec (John's email). Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- 1) Return number format: RT-000001 (RT- + 6 digits).
--    No real returns exist yet, so restart the sequence at 1.
alter sequence returns_seq restart with 1;
alter table public.returns_active
  alter column return_no set default ('RT-' || lpad(nextval('returns_seq')::text, 6, '0'));

-- 2) Per-line warehouse assessment (spec):
--    Condition = internal-only (never on the customer copy)
--    Return Status = printed on the customer receipt
alter table public.returns_lines
  add column if not exists condition     text,   -- Resaleable / Not Resaleable / Faulty
  add column if not exists return_status text;   -- Accepted for Credit Assessment / Accepted for Warranty Assessment / Return Not Accepted

-- 3) Primary contact (person) — distinct from the Business name
alter table public.returns_active
  add column if not exists contact_name text;
