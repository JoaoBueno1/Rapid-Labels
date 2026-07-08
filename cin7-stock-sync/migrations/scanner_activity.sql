-- Scanner activity: Cin7 InventoryWarehouseDetails report → SO -> operator/time.
-- Durable store for the Pick Productivity page (replaces the gitignored local
-- data/scanner_activity.json so the data survives restarts/redeploys).
--
-- SECURITY: contains employee names. RLS is enabled with NO policies, so anon /
-- authenticated clients get NOTHING. Only the server (service_role, which
-- bypasses RLS) reads/writes it, via the same-origin /api/scanner-activity
-- endpoints. Never add an anon SELECT policy here.
--
-- Apply in the Rapid-Labels Supabase SQL Editor (this project has no exec_sql).

create table if not exists public.scanner_activity (
  order_number text primary key,
  op           text,
  scan_date    date,
  skus         numeric,
  minutes      numeric,
  updated_at   timestamptz not null default now()
);

create index if not exists scanner_activity_scan_date_idx on public.scanner_activity (scan_date);

alter table public.scanner_activity enable row level security;

comment on table public.scanner_activity is
  'Cin7 scanner report SO->operator/time for Pick Productivity. RLS locked; server-only (service_role). Contains employee names — never expose to anon.';
