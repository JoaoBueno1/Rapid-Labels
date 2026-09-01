-- ============================================================================
-- 032 — sp_exec devolvia VAZIO para toda consulta que começa com comentário.
--
-- ── O DEFEITO ──────────────────────────────────────────────────────────────
--
-- A 028 decide se a instrução devolve linhas assim:
--
--     returns_rows := sql ~* '<palavra de retorno>' or sql ~* '^\s*(select|with)\M';
--
-- `^\s*` aceita espaço e quebra de linha antes do SELECT — mas não aceita
-- COMENTÁRIO. E boa parte das consultas deste módulo começa exatamente com um:
-- o estilo da casa é explicar a consulta na linha de cima.
--
-- Quando a detecção erra, sp_exec cai no ramo de escrita: roda o SELECT,
-- descarta o resultado e devolve `[]`. Sem erro. Sem log. A rota recebe zero
-- linhas e conclui que não há dado.
--
-- MEDIDO, contra o banco de produção, pelo transporte rpc:
--
--     select 42 as x                        →  [{"x":42}]      certo
--     -- comentario\n select 42 as x        →  []              ERRADO
--     -- comentario\n with a as (...) ...   →  []              ERRADO
--
-- E o efeito visível: GET /buy-recommendation devolvia `{"rows":[],"total":0}`
-- em qualquer máquina sem SUPABASE_DB_PASSWORD — a lista de compra da empresa,
-- vazia, em silêncio. A consulta de candidatos existe, roda em SQL e devolve
-- 1.017 SKUs; ela só começa com um comentário de nove linhas explicando por que
-- o `hist` é MATERIALIZED.
--
-- Isso é pior que um erro: um erro para a tela e alguém investiga. Zero linhas
-- parece uma resposta.
--
-- ── O CONSERTO ────────────────────────────────────────────────────────────
--
-- A pergunta continua a mesma; muda o texto sobre o qual ela é feita. Uma CÓPIA
-- da instrução perde os comentários, e é essa cópia que responde "começa com
-- select?". A instrução EXECUTADA não é tocada — comentário dentro dela é
-- inofensivo, e reescrever SQL para rodar seria trocar um defeito por outro.
--
-- Um `--` dentro de literal de texto ('--isto não é comentário') também some da
-- cópia. Não muda o veredito em nenhum caso real: a instrução que carrega esse
-- literal é um INSERT/UPDATE, e depois do corte ela continua não começando com
-- select. A cópia serve só para classificar.
--
-- `table` e `values` entram na lista porque também devolvem linhas, e um
-- `VALUES (...)` classificado como escrita teria o mesmo silêncio.
--
-- Rodar uma vez no Supabase SQL Editor, ou:
--   node features/stock-planning/scripts/apply-db.js --only=032 --write
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
  -- SEM btrim, e isso custou uma rodada: btrim apara ESPAÇO, não quebra de
  -- linha. Depois de tirar o comentário sobra uma quebra de linha à frente do
  -- SELECT, e um `^` seco não casava com ela — o conserto rodava e o defeito
  -- continuava de pé. Quem apara é o `^\s*` do teste abaixo, que aceita os dois.
  probe := regexp_replace(
             regexp_replace(sql, '/\*.*?\*/', ' ', 'g'),
             '--.*$', ' ', 'ng');

  -- Devolve linhas (SELECT / WITH / TABLE / VALUES, ou uma escrita com a
  -- cláusula de retorno) → agrega num array jsonb.
  -- INSERT/UPDATE/DELETE sem cláusula de retorno → roda e devolve [].
  --
  -- O padrão vai partido em duas metades DE PROPÓSITO, e este é o único lugar
  -- do repositório onde isso se justifica: esta migração conserta o sp_exec e
  -- precisa ser instalável PELO sp_exec defeituoso. O defeituoso classifica
  -- qualquer texto que contenha a palavra inteira como consulta de leitura, e
  -- envolveria este arquivo — que é DDL — num `with _r as (...)`, morrendo em
  -- erro de sintaxe. Escrita assim, a migração se aplica sozinha em qualquer
  -- máquina. Depois deste conserto, nada mais precisa desse cuidado.
  returns_rows := sql ~* ('\mretur' || 'ning\M')
               or probe ~* '^\s*(select|with|table|values)\M';
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
