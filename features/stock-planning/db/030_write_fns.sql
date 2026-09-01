-- 029_write_fns.sql — dedicated rapid_inv.* functions for the multi-statement / locking writes.
-- Companion to 028_sp_exec.sql: these move each atomic write off a JS-side transaction into a
-- single plpgsql function, so the same endpoints work over the service-key transport (no DB
-- password) AND keep atomicity + row locks + the audit actor. Each is SECURITY DEFINER with a
-- pinned search_path and sets rapid_inv.user_email (the GUC the audit trigger reads) first.
-- Run once in the Supabase SQL Editor, after 028. Idempotent (CREATE OR REPLACE).


-- ============================================================================
-- 029 (draws group) — add_manual_draw
-- Replaces the multi-statement db.tx block at
-- features/stock-planning/routes/stock-planning-routes.js:283 (POST /lines/:id/draws).
-- Reproduces the original EXACTLY:
--   seq = COALESCE(max(seq),0)+1 over the same line_id, source='MANUAL',
--   status/created_at/updated_at fall to their table DEFAULTS ('PLANNED', now(), now()).
-- The qty>0 (400) guard stays in the ROUTE (it is a body check, not a DB read).
-- No line-existence 404 in the original: a bad line_id violates the FK -> error -> 500,
-- which this function reproduces (FK raise propagates).
-- ============================================================================
CREATE OR REPLACE FUNCTION rapid_inv.add_manual_draw(
  p_line_id      bigint,
  p_qty          numeric,
  p_planned_date date,
  p_note         text,
  p_actor        text
)
RETURNS SETOF rapid_inv.project_draws
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
BEGIN
  -- WHO: the AFTER-row audit trigger (tg_sp_draws_audit) reads this GUC. is_local=true is
  -- transaction-scoped; this function is one transaction, so the trigger sees it.
  PERFORM set_config('rapid_inv.user_email', p_actor, true);

  RETURN QUERY
  INSERT INTO rapid_inv.project_draws (line_id, seq, qty, planned_date, note, source, updated_by)
  VALUES (
    p_line_id,
    (SELECT COALESCE(max(seq), 0) + 1 FROM rapid_inv.project_draws WHERE line_id = p_line_id),
    p_qty,
    p_planned_date,
    p_note,
    'MANUAL',
    p_actor
  )
  RETURNING *;
END;
$fn$;

REVOKE ALL     ON FUNCTION rapid_inv.add_manual_draw(bigint, numeric, date, text, text) FROM public;
GRANT  EXECUTE ON FUNCTION rapid_inv.add_manual_draw(bigint, numeric, date, text, text) TO service_role, postgres;

-- ============================================================================
-- 029 (draws group) — split_draw
-- Replaces the multi-statement db.tx block at
-- features/stock-planning/routes/stock-planning-routes.js:329 (POST /draws/:id/split).
-- Atomic: SELECT ... FOR UPDATE, guard, UPDATE (qty = qty - p_qty), INSERT the SPLIT half.
--   * missing draw  -> RETURN 0 rows (NEVER a RAISE) so the ROUTE returns 404.
--   * bad quantity  -> RAISE with the ORIGINAL text; the route's wrap() turns it into 500.
-- Return shape { original_id, created } matches the original response exactly.
-- The new SPLIT row uses source='SPLIT'; status/created_at/updated_at take table DEFAULTS.
-- ============================================================================
CREATE OR REPLACE FUNCTION rapid_inv.split_draw(
  p_id           bigint,
  p_qty          numeric,
  p_planned_date date,
  p_note         text,
  p_actor        text
)
RETURNS TABLE (original_id bigint, created jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_orig    rapid_inv.project_draws%ROWTYPE;
  v_created rapid_inv.project_draws%ROWTYPE;
BEGIN
  -- WHO: audit trigger reads this GUC (see add_manual_draw note). MUST be first.
  PERFORM set_config('rapid_inv.user_email', p_actor, true);

  SELECT * INTO v_orig
    FROM rapid_inv.project_draws
   WHERE id = p_id
   FOR UPDATE;

  -- draw inexistente: 0 linhas -> a ROTA (JS) responde 404. Nunca RAISE aqui
  -- (RAISE viraria 500 e mataria o 404 do endpoint).
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Espelha o guard original `!(qty > 0) || qty >= orig.qty` (inclui qty ausente/NaN,
  -- que o transporte entrega como NULL) -> RAISE -> wrap() -> 500. Texto idêntico.
  IF p_qty IS NULL OR p_qty <= 0 OR p_qty >= v_orig.qty THEN
    RAISE EXCEPTION 'a quantidade a separar tem que ser menor que a do draw';
  END IF;

  UPDATE rapid_inv.project_draws
     SET qty = qty - p_qty,
         updated_by = p_actor
   WHERE id = p_id;

  INSERT INTO rapid_inv.project_draws (line_id, seq, qty, planned_date, note, source, updated_by)
  VALUES (
    v_orig.line_id,
    (SELECT COALESCE(max(seq), 0) + 1 FROM rapid_inv.project_draws WHERE line_id = v_orig.line_id),
    p_qty,
    p_planned_date,
    p_note,
    'SPLIT',
    p_actor
  )
  RETURNING * INTO v_created;

  original_id := p_id;
  created     := to_jsonb(v_created);
  RETURN NEXT;
END;
$fn$;

REVOKE ALL     ON FUNCTION rapid_inv.split_draw(bigint, numeric, date, text, text) FROM public;
GRANT  EXECUTE ON FUNCTION rapid_inv.split_draw(bigint, numeric, date, text, text) TO service_role, postgres;

create or replace function rapid_inv.buy_cart_add_lines(
  p_supplier text,
  p_lines    jsonb,
  p_scope    text,
  p_actor    text
) returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_cart_id bigint;
  v_lines   jsonb := '[]'::jsonb;
  elem      jsonb;
  v_key     text;
  v_qty     numeric;
  v_row     rapid_inv.buy_cart_line%rowtype;
begin
  -- WHO: the AFTER-row audit trigger reads this GUC (NOT 'audit_user').
  perform set_config('rapid_inv.user_email', p_actor, true);

  -- cartOf: one open DRAFT cart per supplier (partial unique index target).
  insert into rapid_inv.buy_cart (supplier_code, created_by, scope)
  values (p_supplier, p_actor, p_scope)
  on conflict (supplier_code) where status = 'DRAFT'
  do update set updated_at = now()
  returning id into v_cart_id;

  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    for elem in select * from jsonb_array_elements(p_lines)
    loop
      -- key = String(l.sku_key || l.sku || '').trim().toUpperCase()
      v_key := upper(btrim(coalesce(nullif(elem->>'sku_key', ''), elem->>'sku', '')));
      -- qty = Number(l.qty); the isFinite/>0 guard skips the line otherwise.
      begin
        v_qty := (elem->>'qty')::numeric;
      exception when others then
        v_qty := null;
      end;
      continue when v_key = ''
                 or v_qty is null
                 or v_qty = 'NaN'::numeric
                 or v_qty = 'Infinity'::numeric
                 or v_qty = '-Infinity'::numeric
                 or v_qty <= 0;

      -- Sum, don't overwrite (the PATCH is for edits).
      insert into rapid_inv.buy_cart_line
        (cart_id, sku_key, sku, qty, qty_suggested, carton_qty,
         unit_cost_aud, source, note, added_by)
      values
        (v_cart_id,
         v_key,
         coalesce(nullif(elem->>'sku', ''), v_key),          -- l.sku || key
         v_qty,
         (elem->>'qty_suggested')::numeric,                  -- l.qty_suggested ?? null
         (elem->>'carton_qty')::numeric,                     -- l.carton_qty ?? null
         (elem->>'unit_cost_aud')::numeric,                  -- l.unit_cost_aud ?? null
         case when elem->>'source' = 'manual' then 'manual' else 'suggested' end,
         nullif(elem->>'note', ''),                          -- l.note || null
         p_actor)
      on conflict (cart_id, sku_key) do update
        set qty        = rapid_inv.buy_cart_line.qty + excluded.qty,
            updated_at = now(),
            updated_by = excluded.added_by
      returning * into v_row;

      v_lines := v_lines || to_jsonb(v_row);
    end loop;
  end if;

  update rapid_inv.buy_cart set updated_at = now() where id = v_cart_id;

  return jsonb_build_object('cart_id', v_cart_id, 'lines', v_lines);
end;
$fn$;

revoke all on function rapid_inv.buy_cart_add_lines(text, jsonb, text, text) from public;
grant execute on function rapid_inv.buy_cart_add_lines(text, jsonb, text, text) to service_role;

create or replace function rapid_inv.buy_cart_confirm(
  p_id        bigint,
  p_po_number text,
  p_due_date  date,
  p_actor     text
) returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_cart  rapid_inv.buy_cart%rowtype;
  v_line  rapid_inv.buy_cart_line%rowtype;
  v_n     int;
  v_seq   int := 0;
begin
  perform set_config('rapid_inv.user_email', p_actor, true);

  select * into v_cart
    from rapid_inv.buy_cart
   where id = p_id and status = 'DRAFT'
   for update;
  if not found then
    raise exception 'cart is not open — it may already be confirmed';
  end if;

  perform 1 from rapid_inv.buy_cart_line where cart_id = p_id limit 1;
  if not found then
    raise exception 'the cart is empty';
  end if;

  select count(*)::int into v_n
    from rapid_inv.po_lines where po_number = p_po_number;
  if v_n > 0 then
    raise exception 'PO % already exists with % lines', p_po_number, v_n;
  end if;

  for v_line in
    select * from rapid_inv.buy_cart_line where cart_id = p_id order by sku
  loop
    v_seq := v_seq + 1;
    -- sku_key is GENERATED ALWAYS in po_lines: it must NOT appear in the list.
    insert into rapid_inv.po_lines
      (po_number, line_no, po_date, supplier_code, sku, qty, due_date,
       value_aud, is_received, source, updated_by)
    values
      (p_po_number, v_seq, current_date, v_cart.supplier_code, v_line.sku, v_line.qty,
       p_due_date,
       case when coalesce(v_line.unit_cost_aud, 0) <> 0
            then v_line.unit_cost_aud * v_line.qty else null end,
       false, 'buy_cart', p_actor);
  end loop;

  update rapid_inv.buy_cart
     set status = 'CONFIRMED', po_number = p_po_number,
         confirmed_at = now(), confirmed_by = p_actor, updated_at = now()
   where id = p_id;

  return jsonb_build_object('po_number', p_po_number, 'lines', v_seq);
end;
$fn$;

revoke all on function rapid_inv.buy_cart_confirm(bigint, text, date, text) from public;
grant execute on function rapid_inv.buy_cart_confirm(bigint, text, date, text) to service_role;

notify pgrst, 'reload schema';

-- ============================================================================
-- 029_po_functions.sql  —  PO group. Atomic writes as rapid_inv functions so
-- POST /pos and PUT /po-lines/:id/allocations run over the service-key RPC
-- transport (public.sp_exec) with NO DB password. Idempotent (CREATE OR REPLACE).
-- Run once in the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION rapid_inv.create_po_lines(
  p_actor         text,
  p_po_number     text,
  p_po_date       date,
  p_supplier_code text,
  p_lines         jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_fx      numeric;
  v_line_no integer;
  elem      jsonb;
  v_qty     numeric;
  v_cost    numeric;
  v_usd     numeric;
  v_aud     numeric;
  v_row     jsonb;
  v_out     jsonb := '[]'::jsonb;
BEGIN
  -- WHO: the AFTER-row audit trigger reads current_setting('rapid_inv.user_email').
  PERFORM set_config('rapid_inv.user_email', p_actor, true);

  -- Latest FX at/before the PO date; CURRENT_DATE fallback, exactly like the route.
  SELECT aud_per_usd INTO v_fx
    FROM rapid_inv.fx_rates
   WHERE effective_from <= COALESCE(p_po_date, CURRENT_DATE)
   ORDER BY effective_from DESC
   LIMIT 1;

  -- line_no = COALESCE(max(line_no),0) per po_number, running across the inserts.
  SELECT COALESCE(max(line_no), 0) INTO v_line_no
    FROM rapid_inv.po_lines
   WHERE po_number = p_po_number;

  FOR elem IN SELECT value FROM jsonb_array_elements(p_lines) AS t(value) LOOP
    -- Skip invalid lines exactly like: if (!l.sku || !(Number(l.qty) > 0)) continue;
    -- Guarded casts so a blank/garbage pasted cell falls to NULL (skip/zero) instead of
    -- raising and 500-ing the whole PO — matches the route's lenient Number()/toISODate().
    CONTINUE WHEN COALESCE(elem->>'sku', '') = '';
    BEGIN v_qty := NULLIF(elem->>'qty','')::numeric; EXCEPTION WHEN others THEN v_qty := NULL; END;
    CONTINUE WHEN v_qty IS NULL OR NOT (v_qty > 0);

    BEGIN v_cost := NULLIF(elem->>'unit_cost_usd','')::numeric; EXCEPTION WHEN others THEN v_cost := NULL; END;
    v_usd  := CASE WHEN v_cost IS NULL THEN NULL ELSE v_cost * v_qty END;
    v_aud  := CASE WHEN v_usd IS NOT NULL AND v_fx IS NOT NULL THEN v_usd / v_fx ELSE NULL END;

    v_line_no := v_line_no + 1;                                        -- ++n

    INSERT INTO rapid_inv.po_lines AS ins
      (po_number, line_no, po_date, supplier_code, sku, qty, due_date, vessel,
       unit_cost_usd, fx_used, value_usd, value_aud, source, updated_by)
    VALUES
      (p_po_number, v_line_no, COALESCE(p_po_date, CURRENT_DATE), NULLIF(p_supplier_code,''),
       elem->>'sku', v_qty, NULLIF(elem->>'due_date','')::date, NULLIF(elem->>'vessel',''),
       v_cost, v_fx, v_usd, v_aud, 'MANUAL', p_actor)
    RETURNING to_jsonb(ins) INTO v_row;

    v_out := v_out || v_row;                                           -- append row object
  END LOOP;

  RETURN v_out;
END;
$fn$;

REVOKE ALL ON FUNCTION rapid_inv.create_po_lines(text, text, date, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION rapid_inv.create_po_lines(text, text, date, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION rapid_inv.save_po_allocations(
  p_actor      text,
  p_po_line_id bigint,
  p_items      jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  elem  jsonb;
  v_qty numeric;
  v_seq integer := 0;
BEGIN
  -- WHO: the AFTER-row audit trigger reads current_setting('rapid_inv.user_email').
  PERFORM set_config('rapid_inv.user_email', p_actor, true);

  -- Lock the PO line. Missing -> RETURN false; the ROUTE turns that into a 404.
  -- A RAISE here would surface as a 500. Nothing is deleted/inserted when absent.
  PERFORM 1 FROM rapid_inv.po_lines WHERE id = p_po_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM rapid_inv.po_line_allocations WHERE po_line_id = p_po_line_id;

  v_seq := 0;
  FOR elem IN SELECT value FROM jsonb_array_elements(p_items) AS t(value) LOOP
    -- Guarded cast: a blank/garbage qty falls to NULL (skipped) instead of raising, like Number().
    BEGIN v_qty := NULLIF(elem->>'qty','')::numeric; EXCEPTION WHEN others THEN v_qty := NULL; END;
    -- Skip exactly like: if (!(qty > 0) || !a.branch_code) continue;
    IF COALESCE(v_qty, 0) > 0 AND COALESCE(elem->>'branch_code', '') <> '' THEN
      v_seq := v_seq + 1;                                             -- ++seq
      INSERT INTO rapid_inv.po_line_allocations
        (po_line_id, seq, branch_code, qty, eta_date, note, source, updated_by)
      VALUES
        (p_po_line_id, v_seq, elem->>'branch_code', v_qty,
         NULLIF(elem->>'eta_date','')::date, NULLIF(elem->>'note',''), 'MANUAL', p_actor);
    END IF;
  END LOOP;

  RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION rapid_inv.save_po_allocations(text, bigint, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION rapid_inv.save_po_allocations(text, bigint, jsonb) TO service_role;

-- 029_sku_policy_fn.sql — dedicated write function for PUT /sku-policy/:sku
-- Replaces the multi-statement db.tx(...) block so the endpoint works over the
-- service-key RPC transport (public.sp_exec) with NO DB password.
--
-- Faithful to the original route (stock-planning-routes.js:1178-1201):
--   * DYNAMIC column set — inserts/updates ONLY the fields the caller sent
--     (use_in_replenishment / use_in_planning / use_in_gateway /
--      lifecycle_status / policy_note), carried in p_fields jsonb, keyed by
--     presence (jsonb_object_keys). Unset columns are OMITTED so the TABLE
--     DEFAULT applies — nothing is hardcoded to true/'ACTIVE'.
--   * is_planned = FALSE on INSERT only (never in the UPDATE set).
--   * lifecycle_source='MANUAL' + lifecycle_set_at=now() added ONLY to the
--     UPDATE set when lifecycle_status was sent — exactly like the route, which
--     does NOT put them in the INSERT column list (fresh INSERT leaves both at
--     their table defaults NULL).
--   * settings_updated_at=now() + settings_updated_by=actor on both paths.
--   * sku column gets the CATALOG sku value (p_sku), passed in from the route
--     (the route inserted p.sku, not the uppercased key); sku_key is generated.
--   * Returns rapid_inv.v_sku_policy for the sku.
--
-- The read-only existence check (SKU in cin7_mirror.products) stays in the
-- ROUTE (JS) — NOT a RAISE here, which would surface as a 500 from Postgres.
-- lifecycle_status is validated in the ROUTE (JS keeps the 400); the CHECK
-- constraint is only a backstop here.

create or replace function rapid_inv.save_sku_policy(
  p_sku    text,
  p_fields jsonb,
  p_actor  text
)
returns setof rapid_inv.v_sku_policy
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_key    text := upper(btrim(p_sku));
  k        text;
  ins_cols text := '';
  ins_vals text := '';
  upd_set  text := '';
begin
  -- WHO: the AFTER-row audit trigger on sku_settings reads THIS exact GUC.
  perform set_config('rapid_inv.user_email', p_actor, true);

  -- Only the provided fields, in one pass so each column pairs with its value.
  -- quote_nullable() renders NULL as NULL and 'true'/'false'/text as a quoted
  -- literal that coerces into the boolean/text column (unknown -> target type).
  for k in select jsonb_object_keys(p_fields) loop
    ins_cols := ins_cols || ', ' || quote_ident(k);
    ins_vals := ins_vals || ', ' || quote_nullable(p_fields ->> k);
    upd_set  := upd_set  || quote_ident(k) || ' = ' || quote_nullable(p_fields ->> k) || ', ';
  end loop;

  -- lifecycle changed -> stamp source/date, but ONLY on the UPDATE branch
  -- (matches the route: INSERT omits these, leaving the table defaults).
  if p_fields ? 'lifecycle_status' then
    upd_set := upd_set || 'lifecycle_source = ''MANUAL'', lifecycle_set_at = now(), ';
  end if;

  -- 6 specifiers → 6 args. The INSERT's settings_updated_by (%L) is p_actor too;
  -- upd_set is the DO UPDATE SET body (%s), NOT the INSERT actor.
  execute format(
    'insert into rapid_inv.sku_settings (sku, is_planned%s, settings_updated_at, settings_updated_by) '
    || 'values (%L, false%s, now(), %L) '
    || 'on conflict (sku_key) do update set %ssettings_updated_at = now(), settings_updated_by = %L',
    ins_cols, p_sku, ins_vals, p_actor, upd_set, p_actor);

  return query
    select * from rapid_inv.v_sku_policy where sku_key = v_key;
end;
$fn$;

revoke all on function rapid_inv.save_sku_policy(text, jsonb, text) from public;
grant execute on function rapid_inv.save_sku_policy(text, jsonb, text) to service_role;

notify pgrst, 'reload schema';

-- 029_sp_writes.sql (container group) — dedicated plpgsql for POST /container-plans.
-- Replaces the multi-statement db.tx(...) block at stock-planning-routes.js:1438-1471,
-- which cannot run over the service-key RPC transport (sp-db.tx refuses the 2nd statement).
-- Atomic by construction (a function is one transaction). Run once in the Supabase SQL Editor.

create or replace function rapid_inv.create_container_plan(
  p_name           text,
  p_container_code text,
  p_supplier_code  text,
  p_eta_date       date,
  p_vessel         text,
  p_note           text,
  p_po_line_ids    bigint[],
  p_actor          text
) returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_plan    rapid_inv.container_plan%rowtype;
  r         record;
  v_cartons numeric;
  v_n       int := 0;
begin
  -- WHO did it: the AFTER-row audit trigger reads current_setting('rapid_inv.user_email').
  -- MUST be the first statement. (No audit trigger is attached to container_plan today, so
  -- this is currently inert for this table, but the contract requires it and it is future-safe.)
  perform set_config('rapid_inv.user_email', p_actor, true);

  -- Guard: container type must exist. The original route threw a generic Error INSIDE the tx,
  -- and wrap() maps every thrown Error to HTTP 500 — this was never a 404 path — so a RAISE
  -- here reproduces it exactly (HTTP 500 + identical message text). Do NOT move to the route.
  if not exists (select 1 from rapid_inv.container_type where code = p_container_code) then
    raise exception 'unknown container type %', p_container_code;
  end if;

  insert into rapid_inv.container_plan
    (name, container_code, supplier_code, eta_date, vessel, note, created_by, updated_by)
  values
    (p_name, p_container_code, p_supplier_code, p_eta_date, p_vessel, p_note, p_actor, p_actor)
  returning * into v_plan;

  -- O cubo e o peso sao CONGELADOS aqui (ver 022_container_plan.sql). A dimensao muda no Cin7
  -- e um plano fechado semana passada nao pode se reescrever.
  for r in
    select pl.id, pl.sku, pl.sku_key, pl.qty,
           cb.cbm_carton, cb.carton_qty, cb.kg_unit, cb.cube_source
      from rapid_inv.po_lines pl
      left join rapid_inv.v_sp_cube cb on cb.sku_key = pl.sku_key
     where pl.id = any(p_po_line_ids)
  loop
    if r.cbm_carton is not null and r.carton_qty > 0 then
      v_cartons := ceil(r.qty / r.carton_qty);
    else
      v_cartons := null;
    end if;

    insert into rapid_inv.container_plan_line
      (plan_id, po_line_id, sku_key, sku, qty, cbm_at_plan, kg_at_plan, cube_source, added_by)
    values
      (v_plan.id, r.id, r.sku_key, r.sku, r.qty,
       case when v_cartons is not null then v_cartons * r.cbm_carton end,
       case when r.kg_unit  is not null then r.qty      * r.kg_unit   end,
       nullif(r.cube_source, ''),
       p_actor)
    on conflict (plan_id, po_line_id) do nothing;

    -- Original counts EVERY matched po_line row (loop iterations), not rows actually inserted.
    v_n := v_n + 1;
  end loop;

  -- Same return shape as the route: the full plan row + { lines: n }.
  return to_jsonb(v_plan) || jsonb_build_object('lines', v_n);
end;
$fn$;

revoke all on function rapid_inv.create_container_plan(text,text,text,date,text,text,bigint[],text) from public;
grant execute on function rapid_inv.create_container_plan(text,text,text,date,text,text,bigint[],text)
  to service_role;

notify pgrst, 'reload schema';

-- 029_roll_and_import_fns.sql (part 1/2) — replaces the db.tx() body of POST /roll-week.
-- Atomic (a function body is one transaction). Callable over BOTH transports: pg mode runs
-- `SELECT rapid_inv.roll_week(...)` directly; rpc mode runs it inside public.sp_exec.
-- Sets the audit actor GUC as its FIRST statement, because in pg mode a plain SELECT (not
-- sp-db.tx) never sets it, and the AFTER-row audit trigger reads exactly
-- current_setting('rapid_inv.user_email', true). Idempotent; run once in the SQL Editor.
create or replace function rapid_inv.roll_week(
  p_actor text,
  p_to    date,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_from date;
begin
  perform set_config('rapid_inv.user_email', p_actor, true);

  select reporting_week into v_from
    from rapid_inv.planning_state
   where id = 1
   for update;

  -- Same guard + message as the route. A thrown Error there → wrap() → HTTP 500,
  -- so a RAISE here (propagated as-is by sp_exec/PostgREST) preserves that 500.
  if p_to <= v_from then
    raise exception 'a semana de reporte já é %', v_from;
  end if;

  update rapid_inv.planning_state
     set reporting_week = p_to,
         rolled_at      = now(),
         rolled_by      = p_actor,
         updated_at     = now()
   where id = 1;

  insert into rapid_inv.planning_roll_log (from_week, to_week, rolled_by, notes)
  values (v_from, p_to, p_actor, p_notes);

  -- Exact response shape of the route: { from, to } (dates render as 'YYYY-MM-DD').
  return jsonb_build_object('from', v_from, 'to', p_to);
end;
$fn$;

revoke all on function rapid_inv.roll_week(text, date, text) from public;
grant execute on function rapid_inv.roll_week(text, date, text) to service_role;

notify pgrst, 'reload schema';

-- 029_roll_and_import_fns.sql (part 2/2) — replaces the db.tx() body of POST
-- /projects/import-order (and removes the rpc-mode 501 stub at line 1615).
-- The header + sale_lines reads move INTO the function so the whole import is one atomic
-- transaction. The route KEEPS the read-only 404 pre-check (no synced lines) and the 409
-- mapping of the 23505 unique violation — those stay HTTP-shaped in JS, not RAISEs (a RAISE
-- would be a 500). Sets the audit actor GUC as its FIRST statement (see part 1 rationale).
create or replace function rapid_inv.import_order_project(
  p_actor     text,
  p_number    text,
  p_reference text default null
) returns jsonb
language plpgsql
security definer
set search_path = rapid_inv, cin7_mirror, public
as $fn$
declare
  v_header     cin7_mirror.order_pipeline%rowtype;
  v_has_header boolean;
  v_order_date date;
  v_customer   text;
  v_reference  text;
  v_sale_id    text;
  v_project    rapid_inv.projects%rowtype;
  v_n          int := 0;
  v_line_id    bigint;
  v_qtp        numeric;
  r            record;
begin
  perform set_config('rapid_inv.user_email', p_actor, true);

  -- Header. Mirrors db.one(): first matching row, or none (never throws). SELECT INTO
  -- without STRICT takes the first row and ignores extras, exactly like rows[0].
  select * into v_header
    from cin7_mirror.order_pipeline
   where type = 'SO' and number = p_number;
  v_has_header := found;

  if v_has_header then
    v_order_date := v_header.order_date;
    v_customer   := v_header.customer;
    v_reference  := v_header.reference;
  else
    v_order_date := null;
    v_customer   := null;
    v_reference  := p_reference;              -- header ? header.reference : (req.body.reference || null)
  end if;

  -- cin7_sale_id = lines[0].sale_id (first synced sale line, ORDER BY line_no).
  select sale_id into v_sale_id
    from cin7_mirror.sale_lines
   where order_number = p_number
   order by line_no
   limit 1;

  -- Duplicate SO → ux_sp_projects_so unique violation (SQLSTATE 23505); the route maps → 409.
  insert into rapid_inv.projects
    (sales_order, order_date, customer, reference, status, source, cin7_sale_id, updated_by)
  values
    (p_number, v_order_date, v_customer, v_reference, 'ACTIVE', 'CIN7', v_sale_id, p_actor)
  returning * into v_project;

  for r in
    select sl.sku, sl.quantity, sl.price, sl.product_name
      from cin7_mirror.sale_lines sl
     where sl.order_number = p_number
     order by sl.line_no
  loop
    v_n := v_n + 1;                            -- line_no is the 1-based counter (route's ++n)
    insert into rapid_inv.project_lines
      (project_id, line_no, date_opened, sku, qty, unit_price, item_desc, source, updated_by)
    values
      (v_project.id, v_n, coalesce(v_order_date, current_date),
       r.sku, coalesce(r.quantity, 0), r.price, r.product_name, 'CIN7', p_actor)
    returning id, qty_to_pick into v_line_id, v_qtp;   -- qty_to_pick is a GENERATED column

    -- Born as one undated draw when there is anything to pick (route's Number(qty_to_pick) > 0).
    if v_qtp > 0 then
      insert into rapid_inv.project_draws
        (line_id, seq, qty, planned_date, source, updated_by)
      values
        (v_line_id, 1, v_qtp, null, 'CIN7', p_actor);
    end if;
  end loop;

  -- Exact response shape of the route: { project, lines } (project = the inserted row).
  return jsonb_build_object('project', to_jsonb(v_project), 'lines', v_n);
end;
$fn$;

revoke all on function rapid_inv.import_order_project(text, text, text) from public;
grant execute on function rapid_inv.import_order_project(text, text, text) to service_role;

notify pgrst, 'reload schema';

notify pgrst, 'reload schema';
