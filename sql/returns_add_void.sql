-- Returns: Void (soft-cancel). A return is never hard-deleted (audit-safe) —
-- voiding sets status='void', keeps the record, drops it from Active, and
-- shows it in History tagged "Voided". Reuses the existing status column.
alter table public.returns_active
  add column if not exists void_reason text,
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by    text;
