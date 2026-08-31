-- ============================================================================
-- 002 — Quem é o "rep desta filial", com nome e número.
--
-- A tela vai mostrar as duas réguas uma embaixo da outra, e a de baixo precisa
-- ser AUDITÁVEL: não adianta dizer "pelos reps da filial dá 18.900" sem dizer
-- QUAIS reps somaram isso. Sem os nomes, um rep que ninguém alocou é uma
-- diferença silenciosa entre as duas linhas — e é exatamente o caso que o
-- usuário quer enxergar para corrigir a alocação.
--
-- Duas funções, de propósito:
--   ..._branch_reps  os reps DESTA filial, com o que cada um vendeu
--   ..._reps_orphan  os reps que vendem e não estão em filial nenhuma
--
-- A segunda devolve zero linhas hoje (a alocação foi fechada em 28/08/2026).
-- Ela existe para o dia em que entrar gente nova: um rep novo não alocado
-- some da régua da filial sem avisar, e a soma fica menor sem motivo visível.
--
-- SECURITY DEFINER como as irmãs: elas leem cin7_mirror e rapid_inv, e o
-- navegador não tem permissão em nenhum dos dois.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.replenishment_branch_reps(
  p_branch TEXT,
  p_months INT DEFAULT 6
)
RETURNS TABLE (
  sales_rep TEXT, units NUMERIC, units_month NUMERIC, orders BIGINT, skus BIGINT, note TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  SELECT b.sales_rep::TEXT,
         -- LEFT JOIN e coalesce: o rep alocado que NÃO vendeu na janela tem de
         -- aparecer com zero. Sumir da lista faria parecer que ele não está
         -- alocado, que é o problema oposto do que esta tela existe para achar.
         coalesce(sum(d.qty_signed), 0)::NUMERIC,
         round(coalesce(sum(d.qty_signed), 0) / GREATEST(p_months, 1)::NUMERIC, 2),
         count(DISTINCT d.order_number),
         count(DISTINCT d.sku_key),
         b.note::TEXT
    FROM rapid_inv.sales_rep_branch b
    LEFT JOIN cin7_mirror.v_sales_demand_line d
           ON d.sales_rep = b.sales_rep
          AND d.order_date >= public._rp_window(p_months)
   WHERE b.branch_code = upper(p_branch) AND b.is_active
   GROUP BY b.sales_rep, b.note
   -- Desempate por nome: sem ele, dois reps com o mesmo volume trocam de lugar
   -- entre duas leituras e a lista parece instável.
   ORDER BY 2 DESC, 1;
$$;

COMMENT ON FUNCTION public.replenishment_branch_reps IS
  'Os reps de uma filial e o que cada um vendeu na janela. Rep alocado sem venda aparece com zero, de propósito.';

CREATE OR REPLACE FUNCTION public.replenishment_reps_orphan(
  p_months INT DEFAULT 6
)
RETURNS TABLE (
  sales_rep TEXT, units NUMERIC, orders BIGINT, top_location TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, cin7_mirror, rapid_inv
AS $$
  WITH vendas AS (
    SELECT d.sales_rep, sum(d.qty_signed) AS units,
           count(DISTINCT d.order_number) AS orders
      FROM cin7_mirror.v_sales_demand_line d
     WHERE d.order_date >= public._rp_window(p_months)
       AND coalesce(btrim(d.sales_rep), '') <> ''
       AND NOT EXISTS (SELECT 1 FROM rapid_inv.sales_rep_branch b
                        WHERE b.sales_rep = d.sales_rep AND b.is_active)
     GROUP BY d.sales_rep
  ),
  -- De onde ele mais despacha: é a pista de qual filial ele deveria estar.
  onde AS (
    SELECT DISTINCT ON (d.sales_rep) d.sales_rep, d.location_name
      FROM cin7_mirror.v_sales_demand_line d
      JOIN vendas v ON v.sales_rep = d.sales_rep
     WHERE d.order_date >= public._rp_window(p_months)
     GROUP BY d.sales_rep, d.location_name
     ORDER BY d.sales_rep, sum(d.qty_signed) DESC, d.location_name
  )
  SELECT v.sales_rep::TEXT, v.units::NUMERIC, v.orders, o.location_name::TEXT
    FROM vendas v LEFT JOIN onde o ON o.sales_rep = v.sales_rep
   ORDER BY v.units DESC NULLS LAST, v.sales_rep;
$$;

COMMENT ON FUNCTION public.replenishment_reps_orphan IS
  'Reps que vendem e não estão alocados a filial nenhuma. Zero linhas é o estado saudável.';

GRANT EXECUTE ON FUNCTION public.replenishment_branch_reps(TEXT, INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.replenishment_reps_orphan(INT)      TO anon, authenticated, service_role;
