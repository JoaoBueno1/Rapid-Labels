-- ============================================================================
-- 016 — Bill of Materials: o que compõe cada produto montado.
--
-- Medido no Cin7 antes de escrever isto:
--   • não existe endpoint /bom, /productBOM nem /ref/bom — os três devolvem a
--     página 404 de HTML, o que é pior que um 404 honesto porque um cliente
--     descuidado guardaria o HTML achando que era resposta.
--   • o BOM vem dentro do próprio produto, em BillOfMaterialsProducts[], e a
--     LISTA paginada já traz o array inteiro. Isso muda o custo do sync de
--     ~700 chamadas (uma por pai) para ~86 (uma por página).
--
-- E a descoberta que importa para o estoque: os pais com BOM são os
-- `-CartonNN`. `12v-IP20-030w-Carton26` é 26 × `12v-IP20-030w`. Ou seja, o
-- tamanho do pacote — que em 651 dos 654 SKUs de caixa está com
-- carton_quantity = 0 — está gravado aqui o tempo todo, na quantidade do
-- componente. Esta tabela é a fonte que faltava para aquela bandeira.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.product_bom (
  parent_key      text NOT NULL,          -- upper(btrim(sku)) do produto montado
  component_key   text NOT NULL,          -- upper(btrim(sku)) do componente
  parent_sku      text,
  component_sku   text,
  component_name  text,
  quantity        numeric NOT NULL,       -- quantos componentes por unidade do pai
  wastage_pct     numeric,
  bom_type        text,                   -- 'Assembly' | 'Disassembly' | 'Auto…'
  auto_assembly   boolean,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_key, component_key)
);

CREATE INDEX IF NOT EXISTS ix_bom_comp ON rapid_inv.product_bom (component_key);

COMMENT ON TABLE rapid_inv.product_bom IS
  'Componentes por produto montado, do Cin7. A lista paginada de produtos ja traz BillOfMaterialsProducts[].';
COMMENT ON COLUMN rapid_inv.product_bom.quantity IS
  'Quantidade do componente por unidade do pai. Nos SKUs -CartonNN e o tamanho da caixa, que carton_quantity nao tem.';

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.product_bom TO anon, authenticated, service_role;

-- ── A view que a tela usa ──
-- Junta o componente ao seu estoque e à sua média, porque a pergunta real de
-- quem olha um produto montado não é "do que ele é feito" — é "eu consigo
-- montar?". Sem o estoque do componente ao lado, a lista é enciclopédia.
DROP VIEW IF EXISTS rapid_inv.v_bom_expanded CASCADE;
CREATE VIEW rapid_inv.v_bom_expanded AS
WITH soh AS (
  SELECT upper(btrim(sku)) AS k,
         sum(available)::numeric                                              AS total,
         sum(available) FILTER (WHERE location_name = 'Main Warehouse')::numeric AS main
    FROM cin7_mirror.stock_snapshot GROUP BY 1
)
SELECT b.parent_key, b.parent_sku, b.component_key, b.component_sku, b.component_name,
       b.quantity, b.bom_type,
       coalesce(cs.total, 0)  AS comp_soh,
       coalesce(cs.main, 0)   AS comp_main,
       coalesce(ps.total, 0)  AS parent_soh,
       c.lifecycle_status     AS comp_lifecycle,
       -- Quantos pais dá para montar com o que existe do componente hoje.
       -- Com vários componentes o gargalo é o menor; o menor sai no group by
       -- de quem consome, não aqui, para a view seguir sendo por linha.
       --
       -- O greatest(...,0) não é defensivo por hábito: 439 dos 6.761
       -- componentes estão com Main NEGATIVO, e sem isto floor(-8/2) devolvia
       -- "-4 montagens" — um número que a tela mostrava como se fosse resposta.
       -- Estoque negativo significa que não dá para montar nenhum, e é essa a
       -- resposta. Que ele esteja negativo é outro problema, e vai sinalizado.
       CASE WHEN b.quantity > 0
            THEN floor(greatest(coalesce(cs.main, 0), 0) / b.quantity) END AS can_build_main,
       (coalesce(cs.main, 0) < 0) AS comp_main_negative
  FROM rapid_inv.product_bom b
  LEFT JOIN soh cs ON cs.k = b.component_key
  LEFT JOIN soh ps ON ps.k = b.parent_key
  LEFT JOIN rapid_inv.sku_settings c ON c.sku_key = b.component_key;

GRANT SELECT ON rapid_inv.v_bom_expanded TO anon, authenticated, service_role;
