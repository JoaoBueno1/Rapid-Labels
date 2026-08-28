-- ============================================================================
-- 015 — Master Stock: um item por linha, com a ORIGEM de cada valor.
--
-- A regra que o usuário pediu, e que decide o desenho inteiro:
--   os dois concordam        → um valor, sem cor
--   só o Cin7 tem            → cor de Cin7
--   só o arquivo tem         → cor de arquivo
--   só o Re-Stock tem        → cor de Re-Stock
--   os dois têm e DIVERGEM   → os DOIS valores, cada um com sua fonte
--
-- O sistema não escolhe em silêncio quando há divergência. O objetivo é ele ver
-- a diferença e corrigir a origem — no Excel ou no Cin7 —, e escolher por trás
-- apagaria justamente a informação que ele quer.
--
-- Medido no cruzamento: length diverge em 1.230 SKUs contra 2 iguais; height
-- em 1.209 contra 154; custo em 1.178; pickface em 675. Não é ruído de
-- arredondamento, é a planilha e o ERP contando histórias diferentes.
-- ============================================================================

-- DROP antes do CREATE: o CREATE OR REPLACE não reordena nem renomeia coluna,
-- e esta view ganhou campos no meio. Nada depende dela ainda, então recriar é
-- seguro — se um dia depender, a alternativa é acrescentar no fim.
-- CASCADE porque v_sp_cube (021) foi construída sobre esta. Sem ele o DROP
-- falha e a migração inteira aborta; com ele, 021 tem que rodar em seguida —
-- é a ordem que apply-db já garante pelo número.
DROP VIEW IF EXISTS rapid_inv.v_master_stock CASCADE;
CREATE VIEW rapid_inv.v_master_stock AS
WITH soh AS (
  SELECT upper(btrim(sku)) AS k,
         sum(available)                                   AS total,
         sum(available) FILTER (WHERE location_name = 'Main Warehouse') AS main,
         count(DISTINCT location_name)                    AS locations
    FROM cin7_mirror.stock_snapshot GROUP BY 1),
-- ATENÇÃO À NOMENCLATURA: nestas duas tabelas a coluna chamada `sku` guarda o
-- 5DC e a chamada `product` guarda o SKU real. Juntar pela coluna `sku` casa
-- mais linhas (2.276 ativos contra 1.772) e está ERRADO: um 5DC cobre o produto
-- base e a variante -CartonNN, e a quantidade por pallet de uma caixa de 26 não
-- é a mesma de uma unidade. O join correto é por `product`.
pal AS (SELECT upper(btrim(product)) AS k, max(qty_pallet)::numeric AS qty
          FROM public.pallet_capacity_rules WHERE coalesce(qty_pallet,0) > 0 GROUP BY 1),
bom AS (SELECT parent_key AS k, count(*)::int AS n_comp, min(quantity) AS first_qty
          FROM rapid_inv.product_bom GROUP BY 1),
rst AS (SELECT upper(btrim(product)) AS k, max(qty_per_pallet)::numeric AS qty,
               max(pickface_location) AS pickface, max(pickface_qty)::numeric AS pickface_qty,
               max(qty_per_ctn)::numeric AS ctn
          FROM public.restock_setup GROUP BY 1)
SELECT
  -- FULL OUTER: o usuário foi explícito em não perder nenhuma informação, e
  -- partir do Cin7 descartava em silêncio os 34 SKUs que só existem no arquivo.
  -- A view traz TUDO — inclusive os 2.744 Deprecated —, e quem filtra é a tela.
  coalesce(c.k, f.sku_key)                   AS sku_key,
  coalesce(c.sku, f.sku)                     AS sku,
  coalesce(c.attribute1, f.dc)               AS dc,
  coalesce(c.name, f.description)            AS name,
  coalesce(c.status, 'Not in Cin7')          AS status,
  c.category, c.brand, c.uom, c.barcode,
  (c.k IS NOT NULL)                          AS in_cin7,
  -- ── estoque, só do Cin7: não há segunda fonte e nem deveria haver ──
  coalesce(s.total, 0)  AS soh_total,
  coalesce(s.main, 0)   AS soh_main,
  coalesce(s.locations, 0) AS locations,
  -- ── cada campo com os DOIS lados, para a tela decidir a cor ──
  nullif(c.length, 0)  AS cin7_length,  f.length_mm AS file_length,
  nullif(c.width, 0)   AS cin7_width,   f.width_mm  AS file_width,
  nullif(c.height, 0)  AS cin7_height,  f.height_mm AS file_height,
  nullif(c.carton_quantity, 0) AS cin7_carton, f.carton_qty AS file_carton,
  nullif(c.average_cost, 0)    AS cin7_cost,   f.avg_cost   AS file_cost,
  nullif(btrim(c.stock_locator), '') AS cin7_pick,   f.pickbay    AS file_pick,
  -- Só o arquivo tem: volume, CBM e frete rateado não existem no ERP.
  f.cbm, f.each_volume, f.ctn_volume, f.freight_each, f.cost_usd, f.cost_aud,
  f.supplier AS file_supplier,
  -- Só o Re-Stock tem: pallet, pickface e a caixa operacional.
  -- pallet_capacity_rules cobre mais (1.772 ativos) mas está PARADA desde
  -- 06/03/2026; restock_setup cobre menos e foi atualizada em 24/08. A tela
  -- mostra as duas e diz qual é qual — escolher em silêncio esconderia que a
  -- de maior cobertura é a mais velha.
  pal.qty AS pallet_rules, rst.qty AS pallet_restock,
  rst.pickface AS restock_pickface, rst.pickface_qty AS restock_pickface_qty,
  rst.ctn AS restock_carton,
  -- ── de onde a linha existe ──
  (f.sku_key IS NOT NULL) AS in_file,
  f.source_sheets,
  -- ── o que falta, para os filtros de trabalho ──
  -- ZERO é ausência, não medida. O Cin7 grava 0 em dimensão e carton quando
  -- ninguém preencheu, então um coalesce ingênuo dava "0 SKUs sem dimensão"
  -- num catálogo em que só 35,8% têm — um filtro que devolve zero não serve
  -- para trabalhar, e ainda faz parecer que o cadastro está completo.
  (nullif(c.length, 0) IS NULL AND f.length_mm IS NULL)
    OR (nullif(c.width, 0) IS NULL AND f.width_mm IS NULL)
    OR (nullif(c.height, 0) IS NULL AND f.height_mm IS NULL) AS missing_dims,
  (coalesce(c.weight, 0) = 0)                    AS missing_weight,
  (nullif(btrim(coalesce(c.stock_locator, '')), '') IS NULL
    AND nullif(btrim(coalesce(f.pickbay, '')), '') IS NULL) AS missing_pick,
  (nullif(c.carton_quantity, 0) IS NULL AND f.carton_qty IS NULL) AS missing_carton,
  (coalesce(pal.qty, rst.qty) IS NULL)           AS missing_pallet,

  -- ── SINALIZAÇÃO DE QUALIDADE ──
  -- O dado fica como está; o que muda é ele parar de passar despercebido.
  -- Nada aqui corrige nem esconde: são bandeiras para o trabalho de limpeza.

  -- Dimensão em milímetro carimbada como centímetro. A mediana da maior
  -- dimensão de produto é 20,5 cm; 200 ativos passam de 200 e 217 ficam entre
  -- 100 e 200. R6334-1000-25W-CW está gravado como 1000x180x180 "cm".
  -- Sem isto o packer acredita e monta um contêiner impossível.
  (greatest(coalesce(nullif(c.length,0),0), coalesce(nullif(c.width,0),0),
            coalesce(nullif(c.height,0),0)) > 100)            AS flag_dim_unit,

  -- Peso: os valores são gramas de verdade (mediana 800, p25 300), mas
  -- weight_units é fabricado pelo sync e diz 'g' para 8.513 ativos. Os poucos
  -- abaixo de 100 já estão em kg — esses são o caso ambíguo, não a regra.
  (coalesce(c.weight,0) > 0 AND c.weight < 100)                AS flag_weight_kg,
  (coalesce(c.weight,0) >= 100)                                AS flag_weight_g,

  -- SKU de embalagem com caixa zerada: 651 dos 654 -CartonNN. O tamanho do
  -- pacote está só no nome da UOM, e sem tratar isso o estoque conta duas vezes.
  (c.sku ~* 'carton[0-9]*$' AND coalesce(c.carton_quantity,0) = 0) AS flag_pack_sku,

  -- stock_locator são TRÊS populações no mesmo campo: 2.934 são a string '0',
  -- 2.148 são palavra de processo (BOM, PRODUCTION), e só 2.590 têm forma de
  -- bin. Usar cru é erro.
  (btrim(coalesce(c.stock_locator,'')) = '0'
    OR upper(btrim(coalesce(c.stock_locator,''))) IN ('BOM','PRODUCTION','STRIP CUT')) AS flag_locator_junk,

  -- ── O ARQUIVO TAMBÉM PRECISA SER SINALIZADO ──
  -- Medido: das 1.339 linhas do arquivo com dimensão, 1.284 têm a maior
  -- medida acima de 100 e a mediana é 400. Isso é milímetro. Mas a coluna CBM
  -- do arquivo é exatamente L*W*H/1e6, conta que só fecha se forem
  -- centímetros — logo o CBM está 1000x maior nessas linhas. E não dá para
  -- corrigir com um fator único, porque há linhas em centímetro de verdade
  -- (R3041-300, 32x44x13, CBM 0,0183 — uma caixa plausível).
  (greatest(f.length_mm, f.width_mm, f.height_mm) > 100)   AS flag_file_dim_unit,

  -- 1.927 dos 3.829 volumes do arquivo são o MESMO número, 0,110592, que é
  -- 48x48x48 cm. É a caixa padrão preenchida quando ninguém mediu, e ela
  -- aparece igual num produto 32x44x13 e num 37x48x40. Usar isso para montar
  -- contêiner é empilhar suposição.
  (f.each_volume = 0.110592)                               AS flag_volume_default,

  -- A soma das duas: dá para calcular o cubo deste SKU sem inventar nada?
  (f.cbm IS NOT NULL
    AND greatest(f.length_mm, f.width_mm, f.height_mm) <= 100
    AND coalesce(f.each_volume, 0) <> 0.110592)            AS cube_trustworthy,

  -- ── AS DECISÕES POR PRODUTO ──
  -- A view nunca tocou em sku_settings, e é por isso que este join entra:
  -- sem ele, o controle na tela grava numa tabela que não tem a linha e
  -- devolve 404 na maioria dos SKUs — v_master_stock cobre 11.307 do
  -- catálogo e sku_settings tem 3.634.
  coalesce(st.lifecycle_status, 'ACTIVE')        AS lifecycle_status,
  -- O default é TRUE quando não há linha: um produto que ninguém configurou
  -- pode ser reposto. Marcá-lo como bloqueado por ausência de registro
  -- esconderia 7.673 SKUs por engano.
  coalesce(st.use_in_replenishment, true)        AS use_in_replenishment,
  st.replenishment_note,
  (st.sku_key IS NOT NULL)                       AS has_settings,
  st.is_planned,

  -- Montado, e QUANTOS componentes. A pergunta "isto é feito de quê" só existe
  -- para 2.786 SKUs, e a coluna deixa o filtro possível sem juntar a tabela.
  bom.n_comp                                     AS bom_components,
  bom.first_qty                                  AS bom_first_qty,

  -- O SKU de caixa cujo tamanho de pacote SÓ existe no BOM. Medido: dos 651
  -- -CartonNN com carton_quantity = 0, o BOM cobre 649. Ou seja, a bandeira
  -- flag_pack_sku tem conserto, e o conserto já está no banco.
  (c.sku ~* 'carton[0-9]*$' AND coalesce(c.carton_quantity,0) = 0
    AND bom.n_comp = 1)                          AS carton_qty_in_bom,

  -- O nome promete um número e o BOM diz outro. São poucos — 6 em 650 — e é
  -- exatamente por serem poucos que passariam despercebidos para sempre.
  (c.sku ~ '[Cc]arton[0-9]+$' AND bom.n_comp = 1
    AND (regexp_match(c.sku, '[Cc]arton([0-9]+)$'))[1]::numeric <> bom.first_qty) AS flag_carton_name_mismatch,

  -- O produto tem estoque em algum lugar mas nenhuma dimensão em fonte alguma:
  -- é o que trava a montagem de contêiner na prática.
  (coalesce(s.total,0) <> 0
    AND nullif(c.length,0) IS NULL AND f.length_mm IS NULL)    AS flag_stock_no_dim
FROM (SELECT upper(btrim(sku)) AS k, * FROM cin7_mirror.products) c
FULL OUTER JOIN rapid_inv.product_file f ON f.sku_key = c.k
LEFT JOIN soh s  ON s.k  = coalesce(c.k, f.sku_key)
LEFT JOIN pal    ON pal.k = coalesce(c.k, f.sku_key)
LEFT JOIN rst    ON rst.k = coalesce(c.k, f.sku_key)
LEFT JOIN bom    ON bom.k = coalesce(c.k, f.sku_key)
LEFT JOIN rapid_inv.sku_settings st ON st.sku_key = coalesce(c.k, f.sku_key);

GRANT SELECT ON rapid_inv.v_master_stock TO anon, authenticated, service_role;
