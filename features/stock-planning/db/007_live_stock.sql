-- =====================================================================
-- Stock Planning · 007 · ESTOQUE VIVO DO CIN7
-- ---------------------------------------------------------------------
-- Troca o snapshot colado do Excel pelo espelho do Cin7, sem tocar em
-- v_sp_planning_skus: as views v_sp_soh e v_sp_branch viram DESPACHANTES
-- que leem planning_state.soh_source. Voltar atrás é um UPDATE de uma célula.
--
-- ── A armadilha, medida ────────────────────────────────────────────────
-- SELECT sum(available) FROM cin7_mirror.stock_snapshot GROUP BY sku, sem
-- filtro de local, dá 493.922 unidades para os SKUs de planejamento. A conta
-- certa dá 598.478. São 104.556 unidades a menos — 13% do estoque da empresa
-- evaporando em silêncio — porque 'Project Warehouse' sozinho carrega
-- available = −168.735.
--
-- Os locais de projeto ficam de fora porque o allocated deles é compromisso
-- de obra, não indisponibilidade: o módulo já carrega isso à parte em
-- project_commitment, e v_sp_planning_skus SOMA project_orders em vez de
-- subtrair. Quarentena fica de fora porque a peça existe e não pode ser vendida.
--
-- ── E não confie em locations.parent_id ───────────────────────────────
-- Melbourne aparece na árvore de locais pendurado em 'Ghost', mas no
-- stock_snapshot é armazém de primeira classe com 798 SKUs e 18.914 unidades.
-- Filtrar por parent_id IS NULL faria Melbourne evaporar. Por isso o de-para
-- é explícito, via warehouses.cin7_location_name.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Os corpos atuais, renomeados. Nada mudou neles.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh_snapshot AS
SELECT sku_key AS sku,
       sum(qty_on_hand) AS qty_on_hand,
       sum(allocated)   AS allocated,
       sum(on_order)    AS on_order,
       sum(available)   AS available
  FROM rapid_inv.soh_snapshot
 WHERE is_current
 GROUP BY sku_key;

CREATE OR REPLACE VIEW rapid_inv.v_sp_branch_snapshot AS
SELECT DISTINCT ON (branch_code, sku_key)
       branch_code, sku_key AS sku, qty_on_hand, allocated, on_order, available, snapshot_date
  FROM rapid_inv.branch_soh
 ORDER BY branch_code, sku_key, snapshot_date DESC;

-- ---------------------------------------------------------------------
-- As versões vivas. O de-para de local sai de warehouses.cin7_location_name,
-- que existe justamente para isto — nada de lista cravada em SQL.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh_live AS
SELECT upper(btrim(ss.sku)) AS sku,
       sum(ss.on_hand)      AS qty_on_hand,
       sum(ss.allocated)    AS allocated,
       sum(ss.on_order)     AS on_order,
       sum(ss.available)    AS available
  FROM cin7_mirror.stock_snapshot ss
  JOIN rapid_inv.warehouses w
    ON w.cin7_location_name = ss.location_name
   AND w.is_active AND (w.is_branch OR w.is_hub)
 GROUP BY 1;

CREATE OR REPLACE VIEW rapid_inv.v_sp_branch_live AS
SELECT w.code                AS branch_code,
       upper(btrim(ss.sku))  AS sku,
       sum(ss.on_hand)       AS qty_on_hand,
       sum(ss.allocated)     AS allocated,
       sum(ss.on_order)      AS on_order,
       sum(ss.available)     AS available,
       max(ss.synced_at)::DATE AS snapshot_date
  FROM cin7_mirror.stock_snapshot ss
  JOIN rapid_inv.warehouses w
    ON w.cin7_location_name = ss.location_name
   AND w.is_active AND (w.is_branch OR w.is_hub)
 GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- Os despachantes. Mesma assinatura de colunas de antes, então
-- v_sp_planning_skus não muda uma linha.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh AS
SELECT * FROM rapid_inv.v_sp_soh_snapshot
 WHERE (SELECT soh_source FROM rapid_inv.planning_state WHERE id = 1) = 'SNAPSHOT'
UNION ALL
SELECT * FROM rapid_inv.v_sp_soh_live
 WHERE (SELECT soh_source FROM rapid_inv.planning_state WHERE id = 1) = 'CIN7_LIVE';

CREATE OR REPLACE VIEW rapid_inv.v_sp_branch AS
SELECT * FROM rapid_inv.v_sp_branch_snapshot
 WHERE (SELECT soh_source FROM rapid_inv.planning_state WHERE id = 1) = 'SNAPSHOT'
UNION ALL
SELECT * FROM rapid_inv.v_sp_branch_live
 WHERE (SELECT soh_source FROM rapid_inv.planning_state WHERE id = 1) = 'CIN7_LIVE';

-- ---------------------------------------------------------------------
-- Comparação lado a lado das duas fontes.
--
-- Existe porque trocar a fonte muda o SOH de metade dos SKUs — e, mais
-- importante, faz 26 deles cruzarem o limiar de recompra. Se isso aparecer
-- sem aviso, o time vê a lista de compras mudar sozinha e perde a confiança
-- na ferramenta. Esta view é o aviso.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh_compare AS
SELECT s.sku,
       s.supplier_code,
       s.wk_avg,
       s.threshold_red,
       COALESCE(x.available, 0)                        AS soh_snapshot,
       COALESCE(l.available, 0)                        AS soh_live,
       COALESCE(l.available, 0) - COALESCE(x.available, 0) AS delta,
       CASE WHEN COALESCE(x.available, 0) <> 0
            THEN round((100.0 * (COALESCE(l.available,0) - COALESCE(x.available,0))
                        / abs(x.available))::NUMERIC, 1) END AS delta_pct,
       CASE WHEN COALESCE(s.wk_avg, 0) > 0
            THEN round(((COALESCE(x.available,0) + COALESCE(cm.available,0)) / (s.wk_avg*52/12))::NUMERIC, 2) END AS mths_snapshot,
       CASE WHEN COALESCE(s.wk_avg, 0) > 0
            THEN round(((COALESCE(l.available,0) + COALESCE(cm.available,0)) / (s.wk_avg*52/12))::NUMERIC, 2) END AS mths_live
  FROM rapid_inv.sku_settings s
  LEFT JOIN rapid_inv.v_sp_soh_snapshot x  ON x.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_soh_live     l  ON l.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_commitment   cm ON cm.sku = s.sku_key
 WHERE s.is_planned;

-- Só quem muda de cor. É a lista que o planejador precisa ver antes da troca.
CREATE OR REPLACE VIEW rapid_inv.v_sp_soh_compare_flips AS
SELECT *,
       CASE WHEN mths_snapshot < threshold_red AND mths_live >= threshold_red THEN 'leaves red'
            WHEN mths_snapshot >= threshold_red AND mths_live < threshold_red THEN 'enters red'
       END AS flip
  FROM rapid_inv.v_sp_soh_compare
 WHERE mths_snapshot IS NOT NULL AND mths_live IS NOT NULL
   AND (mths_snapshot < threshold_red) <> (mths_live < threshold_red);

DO $$ BEGIN RAISE NOTICE '007: estoque vivo pronto (fonte segue em planning_state.soh_source)'; END $$;
