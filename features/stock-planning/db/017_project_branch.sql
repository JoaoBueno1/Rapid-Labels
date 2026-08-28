-- ============================================================================
-- 017 — De qual filial é cada projeto.
--
-- O pedido era filtrar projetos por filial, com a filial vindo do pedido de
-- venda e não editável. Ao medir, o campo óbvio não serve:
--
--   projects.warehouse_code       vazio nos 1.939
--   order_pipeline.from_location  casa 175 (e o número do pedido lá é 'SO-…',
--                                 enquanto em projects é '208233' cru)
--   sales_history_line            casa 1.000 — mas 771 dizem "Project
--                                 Warehouse", que é área de separação e não
--                                 filial. Restam 199 com filial de verdade.
--
-- 199 de 1.939 é filtro que não filtra. O segundo caminho é o rep, pelo mapa
-- rep→filial que já foi decidido: cobre mais 1.468. Só que rep é inferência e
-- pedido é fato, e misturar os dois calado seria vender um palpite como dado.
-- Por isso sai `branch_source` junto, e a tela mostra qual foi.
--
-- Cobertura final: 199 do pedido + 1.468 do rep = 1.667 de 1.939 (86%).
-- Os 272 restantes ficam como "sem origem" e aparecem assim — não somem.
-- ============================================================================

DROP VIEW IF EXISTS rapid_inv.v_sp_project_branch CASCADE;
CREATE VIEW rapid_inv.v_sp_project_branch AS
WITH ord AS (
  -- O prefixo 'SO-' é a razão de este join dar zero na primeira tentativa.
  SELECT p.id, max(s.location_name) AS loc
    FROM rapid_inv.projects p
    JOIN cin7_mirror.sales_history_line s ON s.order_number = 'SO-' || p.sales_order
   GROUP BY 1),
rep AS (
  -- projects.rep guarda só o primeiro nome ("Alex"), o mapa guarda o nome
  -- inteiro ("Alex Cordeiro"). E quando o primeiro nome pertence a duas
  -- pessoas de filiais diferentes — Chris Capper/CNS e Chris Ryan/CFS, 3
  -- projetos — o certo é não escolher: count(distinct) = 1 devolve NULL e a
  -- linha cai em 'ambiguous'.
  SELECT p.id,
         CASE WHEN count(DISTINCT m.branch_code) = 1 THEN max(m.branch_code) END AS b,
         count(DISTINCT m.branch_code)                                          AS n
    FROM rapid_inv.projects p
    JOIN rapid_inv.sales_rep_branch m
      ON upper(split_part(btrim(m.sales_rep), ' ', 1)) = upper(btrim(p.rep))
   WHERE m.branch_code IS NOT NULL
   GROUP BY 1)
SELECT p.id AS project_id, p.sales_order, p.rep,
  CASE
    WHEN b.code IS NOT NULL THEN b.code
    WHEN r.b    IS NOT NULL THEN r.b
  END AS branch_code,
  CASE
    WHEN b.code IS NOT NULL THEN 'order'       -- veio do pedido: é fato
    WHEN r.b    IS NOT NULL THEN 'rep'         -- veio do rep: é inferência
    WHEN r.n    > 1         THEN 'ambiguous'   -- o primeiro nome é de duas pessoas
    WHEN o.loc  IS NOT NULL THEN 'project_area'-- o pedido só diz "Project Warehouse"
    ELSE 'unknown'
  END AS branch_source,
  o.loc AS order_location
FROM rapid_inv.projects p
LEFT JOIN ord o ON o.id = p.id
LEFT JOIN rep r ON r.id = p.id
-- O nome do depósito vira código pela TABELA de filiais, não por um CASE
-- escrito aqui. Escrevi o CASE primeiro e ele devolveu 'SSC' para Sunshine
-- Coast enquanto o resto do sistema usa 'SCS' — o filtro teria partido a
-- filial em duas e cada metade pareceria completa. Ler da tabela não corrige
-- só este caso: impede o próximo.
-- "Project Warehouse" não está lá de propósito: é onde o projeto é montado,
-- não de quem ele é, e por isso cai em 'project_area'.
LEFT JOIN rapid_inv.warehouses b ON b.cin7_location_name = o.loc;

GRANT SELECT ON rapid_inv.v_sp_project_branch TO anon, authenticated, service_role;

COMMENT ON VIEW rapid_inv.v_sp_project_branch IS
  'Filial de cada projeto. branch_source diz se veio do pedido (fato) ou do rep (inferencia).';
