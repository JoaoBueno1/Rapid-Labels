-- Pick-error exclusions: rows an operator marked as "not really an error" on the
-- Pick Productivity page. Excluded keys are removed from every count (KPIs, charts,
-- totals) but kept visible (light red) via the "Show excluded" toggle.
--
-- No PII (just order/sku/bin keys), so the page writes it directly with the anon
-- key — RLS is enabled with permissive policies (internal, PIN-gated tool).
--
-- Apply in the Rapid-Labels Supabase SQL Editor (this project has no exec_sql).

create table if not exists public.pick_error_exclusions (
  error_key    text primary key,   -- pick id (e.g. SO-260408-16) or order|sku|bin
  order_number text,
  sku          text,
  from_bin     text,
  op           text,
  reason       text,
  created_at   timestamptz not null default now()
);

alter table public.pick_error_exclusions enable row level security;

drop policy if exists pick_error_exclusions_read   on public.pick_error_exclusions;
drop policy if exists pick_error_exclusions_write  on public.pick_error_exclusions;
drop policy if exists pick_error_exclusions_delete on public.pick_error_exclusions;
create policy pick_error_exclusions_read   on public.pick_error_exclusions for select using (true);
create policy pick_error_exclusions_write  on public.pick_error_exclusions for insert with check (true);
create policy pick_error_exclusions_delete on public.pick_error_exclusions for delete using (true);
