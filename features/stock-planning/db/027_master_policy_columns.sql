-- ============================================================================
-- 027 — A política aparece na GRADE do Master Stock, não só no painel.
--
-- O painel já grava lifecycle, os três usos e a nota. Mas para achar o que
-- está configurado era preciso abrir SKU por SKU: 11.259 linhas, e a decisão
-- invisível até você clicar. Uma configuração que não se vê de fora é uma
-- configuração que ninguém confere.
--
-- Só colunas — nenhuma regra nova. `policy_flag` repete a lógica de
-- v_sp_planning_skus de propósito: as duas telas têm de desenhar a MESMA
-- bandeira, e a única forma de garantir isso é a regra estar escrita igual
-- nos dois lugares que a leem.
--
-- CREATE OR REPLACE só anexa coluna no fim; por isso as 63 de hoje ficam na
-- ordem exata e o que é novo entra depois delas.
-- ============================================================================

CREATE OR REPLACE VIEW rapid_inv.v_master_stock AS
 WITH soh AS (
         SELECT upper(btrim(stock_snapshot.sku)) AS k,
            sum(stock_snapshot.available) AS total,
            sum(stock_snapshot.available) FILTER (WHERE stock_snapshot.location_name = 'Main Warehouse'::text) AS main,
            count(DISTINCT stock_snapshot.location_name) AS locations
           FROM cin7_mirror.stock_snapshot
          GROUP BY (upper(btrim(stock_snapshot.sku)))
        ), pal AS (
         SELECT upper(btrim(pallet_capacity_rules.product)) AS k,
            max(pallet_capacity_rules.qty_pallet)::numeric AS qty
           FROM pallet_capacity_rules
          WHERE COALESCE(pallet_capacity_rules.qty_pallet, 0) > 0
          GROUP BY (upper(btrim(pallet_capacity_rules.product)))
        ), bom AS (
         SELECT product_bom.parent_key AS k,
            count(*)::integer AS n_comp,
            min(product_bom.quantity) AS first_qty
           FROM rapid_inv.product_bom
          GROUP BY product_bom.parent_key
        ), rst AS (
         SELECT upper(btrim(restock_setup.product)) AS k,
            max(restock_setup.qty_per_pallet)::numeric AS qty,
            max(restock_setup.pickface_location) AS pickface,
            max(restock_setup.pickface_qty)::numeric AS pickface_qty,
            max(restock_setup.qty_per_ctn)::numeric AS ctn
           FROM restock_setup
          GROUP BY (upper(btrim(restock_setup.product)))
        )
 SELECT COALESCE(c.k, f.sku_key) AS sku_key,
    COALESCE(c.sku, f.sku) AS sku,
    COALESCE(c.attribute1, f.dc) AS dc,
    COALESCE(c.name, f.description) AS name,
    COALESCE(c.status, 'Not in Cin7'::text) AS status,
    c.category,
    c.brand,
    c.uom,
    c.barcode,
    c.k IS NOT NULL AS in_cin7,
    COALESCE(s.total, 0::numeric) AS soh_total,
    COALESCE(s.main, 0::numeric) AS soh_main,
    COALESCE(s.locations, 0::bigint) AS locations,
    NULLIF(c.length, 0::numeric) AS cin7_length,
    f.length_mm AS file_length,
    NULLIF(c.width, 0::numeric) AS cin7_width,
    f.width_mm AS file_width,
    NULLIF(c.height, 0::numeric) AS cin7_height,
    f.height_mm AS file_height,
    NULLIF(c.carton_quantity, 0::numeric) AS cin7_carton,
    f.carton_qty AS file_carton,
    NULLIF(c.average_cost, 0::numeric) AS cin7_cost,
    f.avg_cost AS file_cost,
    NULLIF(btrim(c.stock_locator), ''::text) AS cin7_pick,
    f.pickbay AS file_pick,
    f.cbm,
    f.each_volume,
    f.ctn_volume,
    f.freight_each,
    f.cost_usd,
    f.cost_aud,
    f.supplier AS file_supplier,
    pal.qty AS pallet_rules,
    rst.qty AS pallet_restock,
    rst.pickface AS restock_pickface,
    rst.pickface_qty AS restock_pickface_qty,
    rst.ctn AS restock_carton,
    f.sku_key IS NOT NULL AS in_file,
    f.source_sheets,
    NULLIF(c.length, 0::numeric) IS NULL AND f.length_mm IS NULL OR NULLIF(c.width, 0::numeric) IS NULL AND f.width_mm IS NULL OR NULLIF(c.height, 0::numeric) IS NULL AND f.height_mm IS NULL AS missing_dims,
    COALESCE(c.weight, 0::numeric) = 0::numeric AS missing_weight,
    NULLIF(btrim(COALESCE(c.stock_locator, ''::text)), ''::text) IS NULL AND NULLIF(btrim(COALESCE(f.pickbay, ''::text)), ''::text) IS NULL AS missing_pick,
    NULLIF(c.carton_quantity, 0::numeric) IS NULL AND f.carton_qty IS NULL AS missing_carton,
    COALESCE(pal.qty, rst.qty) IS NULL AS missing_pallet,
    GREATEST(COALESCE(NULLIF(c.length, 0::numeric), 0::numeric), COALESCE(NULLIF(c.width, 0::numeric), 0::numeric), COALESCE(NULLIF(c.height, 0::numeric), 0::numeric)) > 100::numeric AS flag_dim_unit,
    COALESCE(c.weight, 0::numeric) > 0::numeric AND c.weight < 100::numeric AS flag_weight_kg,
    COALESCE(c.weight, 0::numeric) >= 100::numeric AS flag_weight_g,
    c.sku ~* 'carton[0-9]*$'::text AND COALESCE(c.carton_quantity, 0::numeric) = 0::numeric AS flag_pack_sku,
    btrim(COALESCE(c.stock_locator, ''::text)) = '0'::text OR (upper(btrim(COALESCE(c.stock_locator, ''::text))) = ANY (ARRAY['BOM'::text, 'PRODUCTION'::text, 'STRIP CUT'::text])) AS flag_locator_junk,
    GREATEST(f.length_mm, f.width_mm, f.height_mm) > 100::numeric AS flag_file_dim_unit,
    f.each_volume = 0.110592 AS flag_volume_default,
    f.cbm IS NOT NULL AND GREATEST(f.length_mm, f.width_mm, f.height_mm) <= 100::numeric AND COALESCE(f.each_volume, 0::numeric) <> 0.110592 AS cube_trustworthy,
    COALESCE(st.lifecycle_status, 'ACTIVE'::text) AS lifecycle_status,
    COALESCE(st.use_in_replenishment, true) AS use_in_replenishment,
    st.replenishment_note,
    st.sku_key IS NOT NULL AS has_settings,
    st.is_planned,
    bom.n_comp AS bom_components,
    bom.first_qty AS bom_first_qty,
    c.sku ~* 'carton[0-9]*$'::text AND COALESCE(c.carton_quantity, 0::numeric) = 0::numeric AND bom.n_comp = 1 AS carton_qty_in_bom,
    c.sku ~ '[Cc]arton[0-9]+$'::text AND bom.n_comp = 1 AND (regexp_match(c.sku, '[Cc]arton([0-9]+)$'::text))[1]::numeric <> bom.first_qty AS flag_carton_name_mismatch,
    COALESCE(s.total, 0::numeric) <> 0::numeric AND NULLIF(c.length, 0::numeric) IS NULL AND f.length_mm IS NULL AS flag_stock_no_dim,
    COALESCE(st.use_in_planning, true) AS use_in_planning,
    COALESCE(st.use_in_gateway, true) AS use_in_gateway,
    st.policy_note,
    st.settings_updated_at,
    st.settings_updated_by,
    -- "alguém decidiu isto" — settings_updated_at só é gravado quando o painel
    -- é salvo. Linha sem carimbo é default, não decisão.
    (st.settings_updated_at IS NOT NULL) AS policy_decided,
    -- As duas discordâncias com o Cin7, prontas para virar filtro.
    (c.status = 'Deprecated' AND COALESCE(st.lifecycle_status, 'ACTIVE') = 'ACTIVE') AS cin7_dead_we_alive,
    (c.status = 'Active' AND COALESCE(st.lifecycle_status, 'ACTIVE') = 'DISCONTINUED') AS cin7_alive_we_dead,
    -- Uma coluna com a bandeira que a grade desenha, para a regra morar num
    -- lugar só e não em quatro ifs no navegador.
    CASE WHEN COALESCE(st.lifecycle_status, 'ACTIVE') = 'DISCONTINUED' THEN 'DISCONTINUED'
         WHEN COALESCE(st.lifecycle_status, 'ACTIVE') = 'RUN_OUT'      THEN 'RUN_OUT'
         WHEN NOT COALESCE(st.use_in_replenishment, true) THEN 'NO_BRANCH'
         WHEN NOT COALESCE(st.use_in_planning, true)      THEN 'NO_PLANNING'
         WHEN NOT COALESCE(st.use_in_gateway, true)       THEN 'NO_GATEWAY'
    END AS policy_flag
   FROM ( SELECT upper(btrim(products.sku)) AS k,
            products.id,
            products.sku,
            products.name,
            products.barcode,
            products.category,
            products.brand,
            products.type,
            products.status,
            products.uom,
            products.costing_method,
            products.weight,
            products.weight_units,
            products.default_location,
            products.minimum_before_reorder,
            products.reorder_quantity,
            products.average_cost,
            products.stock_locator,
            products.pick_zones,
            products.sellable,
            products.last_modified_on,
            products.synced_at,
            products.attribute1,
            products.attribute2,
            products.length,
            products.width,
            products.height,
            products.dimensions_units,
            products.carton_length,
            products.carton_width,
            products.carton_height,
            products.carton_quantity,
            products.carton_inner_quantity,
            products.price_tier1,
            products.price_tiers,
            products.warranty_name,
            products.tags
           FROM cin7_mirror.products) c
     FULL JOIN rapid_inv.product_file f ON f.sku_key = c.k
     LEFT JOIN soh s ON s.k = COALESCE(c.k, f.sku_key)
     LEFT JOIN pal ON pal.k = COALESCE(c.k, f.sku_key)
     LEFT JOIN rst ON rst.k = COALESCE(c.k, f.sku_key)
     LEFT JOIN bom ON bom.k = COALESCE(c.k, f.sku_key)
     LEFT JOIN rapid_inv.sku_settings st ON st.sku_key = COALESCE(c.k, f.sku_key);
