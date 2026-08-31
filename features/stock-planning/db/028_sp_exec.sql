-- 028_sp_exec.sql — service-key transport for Inventory Management (schema rapid_inv).
--
-- WHY: rapid_inv is NOT exposed on PostgREST, so sp-db.js used a DIRECT Postgres
-- connection, which needs SUPABASE_DB_PASSWORD on every machine. This function lets the
-- Node server reach rapid_inv with ONLY the service key (which every machine already has):
-- sp-db.js POSTs to /rest/v1/rpc/sp_exec. Covers all READS + single-statement writes.
-- Multi-statement / locking writes get their own rapid_inv.* functions in migration 029.
--
-- SAFETY: SECURITY DEFINER (runs as owner to reach rapid_inv) with a PINNED search_path,
-- and EXECUTE granted ONLY to service_role (the key is server-side only; a service-key
-- holder already has full DML via PostgREST, so this is not an escalation for them).
-- Values are bound with quote_literal/quote_nullable — only VALUES are interpolated, the
-- statement text comes from our own server code, never from the browser.
--
-- Run this once in the Supabase SQL Editor. Idempotent (CREATE OR REPLACE).

create or replace function public.sp_exec(q text, p jsonb default '[]'::jsonb, actor text default null)
returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  i    int;
  elem jsonb;
  lit  text;
  arr  text;
  sql  text := q;
  result jsonb;
  returns_rows boolean;
begin
  -- WHO did it: the AFTER-row audit trigger reads current_setting('rapid_inv.user_email').
  -- is_local=true is transaction-scoped; over /rest/v1/rpc this whole function is ONE
  -- transaction, so setting it here (right before EXECUTE) is visible to the trigger.
  if actor is not null and actor <> '' then
    perform set_config('rapid_inv.user_email', actor, true);
  end if;

  -- Bind $1..$n (node-pg style) from the jsonb params array. Two passes with control-char
  -- sentinels: pass 1 turns $n into a sentinel (highest index first so $1 can't eat $15),
  -- pass 2 swaps each sentinel for a quoted literal — so an inserted literal can never be
  -- re-scanned. Scalars become UNKNOWN literals ('123','2026-08-30') that Postgres coerces
  -- to the target column type; JS arrays become Postgres array literals for = ANY()/<> ALL().
  if p is not null and jsonb_typeof(p) = 'array' and jsonb_array_length(p) > 0 then
    for i in reverse jsonb_array_length(p)..1 loop
      sql := replace(sql, '$' || i::text, chr(1) || i::text || chr(2));
    end loop;
    for i in 1..jsonb_array_length(p) loop
      elem := p -> (i - 1);
      if elem is null or jsonb_typeof(elem) = 'null' then
        lit := 'NULL';
      elsif jsonb_typeof(elem) = 'array' then
        select '{' || coalesce(string_agg(
                 case
                   when e is null or jsonb_typeof(e) = 'null' then 'NULL'
                   when jsonb_typeof(e) = 'string'
                     then '"' || replace(replace(e #>> '{}', '\', '\\'), '"', '\"') || '"'
                   else e #>> '{}'
                 end, ','), '') || '}'
          into arr
          from jsonb_array_elements(elem) as e;
        lit := quote_literal(arr);
      elsif jsonb_typeof(elem) = 'object' then
        lit := quote_literal(elem::text);             -- jsonb param
      elsif jsonb_typeof(elem) in ('boolean', 'number') then
        lit := elem #>> '{}';                          -- bare true/false/123/19.17
      else
        lit := quote_literal(elem #>> '{}');           -- text -> 'value'
      end if;
      sql := replace(sql, chr(1) || i::text || chr(2), lit);
    end loop;
  end if;

  -- Row-returning (SELECT / WITH / ... RETURNING) → aggregate to a jsonb array.
  -- Bare INSERT/UPDATE/DELETE without RETURNING → just run it, return [].
  returns_rows := sql ~* '\mreturning\M' or sql ~* '^\s*(select|with)\M';
  if returns_rows then
    execute 'with _r as (' || sql || ') select coalesce(jsonb_agg(to_jsonb(_r)), ''[]''::jsonb) from _r'
      into result;
  else
    execute sql;
    result := '[]'::jsonb;
  end if;
  return result;
end;
$fn$;

revoke all on function public.sp_exec(text, jsonb, text) from public;
grant execute on function public.sp_exec(text, jsonb, text) to service_role;

-- Nudge PostgREST to pick up the new function immediately.
notify pgrst, 'reload schema';
