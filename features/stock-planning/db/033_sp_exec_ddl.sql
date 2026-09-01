-- ============================================================================
-- 033 — sp_exec parava de engasgar em DDL.
--
-- ── O QUE SOBROU DA 032 ────────────────────────────────────────────────────
--
-- A 032 consertou metade: consulta que começa com comentário voltou a devolver
-- linhas. A outra metade continuou de pé, e ela é a que impede aplicar
-- migração pelo script.
--
-- O teste era uma OU de duas perguntas independentes:
--
--     devolve_linhas  :=  <o texto contém a palavra de retorno em algum lugar>
--                     OR  <o texto começa com select/with/table/values>
--
-- A primeira pergunta não olha ONDE a palavra está. Um arquivo que DEFINE
-- funções — `030_write_fns.sql` define nove, e sete delas usam a cláusula de
-- retorno dentro do corpo — é DDL puro, mas contém a palavra. sp_exec então
-- embrulhava o arquivo inteiro num `with _r as ( CREATE OR REPLACE FUNCTION … )`
-- e o Postgres respondia `syntax error at or near "CREATE"`.
--
-- Resultado prático: `apply-db.js --write` abortava naquele arquivo, e como ele
-- roda em ordem, TODA migração numerada depois dele também deixava de ser
-- aplicada. Um arquivo que ninguém conseguia instalar bloqueando a fila inteira.
--
-- ── O CONSERTO ────────────────────────────────────────────────────────────
--
-- A cláusula de retorno só significa "devolve linhas" quando pendurada numa
-- ESCRITA. Então ela deixa de ser uma pergunta solta e passa a ser uma condição
-- sobre o começo da instrução:
--
--     começa com select / with / table / values          → devolve linhas
--     começa com insert / update / delete / merge
--         E tem a cláusula de retorno                     → devolve linhas
--     qualquer outra coisa (create, alter, drop, do, …)   → não devolve
--
-- As duas perguntas passam a ser feitas sobre a MESMA cópia sem comentários que
-- a 032 introduziu, e é isso que torna o veredito uma coisa só em vez de duas
-- que podem se contradizer.
--
-- Um `WITH … UPDATE … <retorno>` continua certo: começa com `with`, cai na
-- primeira linha. Um `DO $$ … <retorno> … $$` também: começa com `do`, não é
-- escrita de topo, e um bloco DO de fato não devolve linha nenhuma.
--
-- O padrão continua partido em duas metades porque esta migração ainda é
-- instalada pelo sp_exec ANTERIOR, que ainda faz a pergunta solta. Depois dela,
-- nenhuma migração precisa mais desse cuidado — inclusive esta, se um dia for
-- reaplicada.
--
-- Rodar uma vez, ou:
--   node features/stock-planning/scripts/apply-db.js --only=033 --write
-- ============================================================================

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
  probe text;
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

  -- A CÓPIA sem comentários. Só para classificar — `sql` segue intacto.
  --   1) bloco  /* ... */   sem a flag 'n', o ponto atravessa quebra de linha
  --   2) linha  -- ...      com 'n', o $ passa a valer no fim de CADA linha
  --
  -- SEM btrim: ele apara ESPAÇO, não quebra de linha. Depois de tirar o
  -- comentário sobra uma quebra de linha à frente do SELECT, e um `^` seco não
  -- casava com ela. Quem apara é o `^\s*` dos testes abaixo, que aceita os dois.
  probe := regexp_replace(
             regexp_replace(sql, '/\*.*?\*/', ' ', 'g'),
             '--.*$', ' ', 'ng');

  -- O que devolve linhas, e SÓ isso:
  --   leitura de topo                                  select / with / table / values
  --   escrita de topo COM a cláusula de retorno        insert / update / delete / merge
  -- Tudo o mais — create, alter, drop, grant, do, notify — roda e devolve [].
  --
  -- A segunda linha é o conserto: a cláusula de retorno DENTRO do corpo de uma
  -- função que está sendo criada não faz do CREATE uma consulta. Sobre a mesma
  -- cópia sem comentários, para as duas perguntas não se contradizerem.
  --
  -- O padrão vai partido em duas metades porque esta migração é instalada pelo
  -- sp_exec anterior, que ainda faz a pergunta solta sobre o texto inteiro e
  -- embrulharia este arquivo — que é DDL — num `with _r as (...)`.
  returns_rows :=
        probe ~* '^\s*(select|with|table|values)\M'
     or (probe ~* '^\s*(insert|update|delete|merge)\M'
         and probe ~* ('\mretur' || 'ning\M'));

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
