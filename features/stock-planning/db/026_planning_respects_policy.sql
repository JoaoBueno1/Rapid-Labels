-- ============================================================================
-- 026 — O Stock Planning passa a obedecer a política do Master Stock.
--
-- Marcar "não usar no Stock Planning" no Master Stock não fazia nada: a
-- v_sp_planning_skus filtrava só por is_planned. Marca que não muda
-- comportamento é pior que marca nenhuma — faz a pessoa acreditar que decidiu.
--
-- DUAS DECISÕES, E OS PORQUÊS:
--
-- 1) use_in_planning EXCLUI a linha. É a única leitura possível de "não usar
--    aqui": o SKU sai da projeção, dos alertas e da sugestão de compra.
--
-- 2) DISCONTINUED **não** exclui. O pedido foi explícito e está certo: o item
--    descontinuado continua no Stock Planning e na reposição, com bandeira.
--    Sumir seria pior — sobra estoque dele, e é sobre essa sobra que alguém
--    precisa decidir. Quem sai da CONTA é a demanda: a 008 já zera wk_avg e
--    target fora de ACTIVE, então ele aparece sem puxar compra.
--
-- `policy_flag` é o que a tela desenha. Uma coluna e não três ifs no front:
-- "por que este SKU está diferente" tem de morar num lugar só.
--
-- CREATE OR REPLACE **não** aceita renomear nem reordenar coluna — só anexar
-- no fim. Por isso as 29 colunas de hoje vão na ordem exata e o que é novo
-- entra depois delas. Dropar com CASCADE levaria junto v_sp_sku_value.
-- ============================================================================

CREATE OR REPLACE VIEW rapid_inv.v_sp_planning_skus AS
SELECT
  s.sku,
  s.sku_key,
  s.supplier_code,
  s.legacy_code,
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 0::numeric ELSE s.wk_avg END AS wk_avg,
  s.wk_avg_source,
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 0::numeric ELSE s.wk_avg END
    * 52::numeric / 12::numeric                                     AS mth_avg,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN s.target_cover_weeks ELSE 0 END AS target_cover_weeks,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN s.wk_avg * s.target_cover_weeks::numeric
       ELSE 0::numeric END                                          AS target_qty,
  s.comments,
  s.threshold_red,
  s.threshold_yel,
  COALESCE(soh.available, 0::numeric)                               AS soh_available,
  COALESCE(soh.qty_on_hand, 0::numeric)                             AS soh_on_hand,
  COALESCE(soh.on_order, 0::numeric)                                AS soh_on_order,
  COALESCE(cm.available, 0::numeric)                                AS project_orders,
  COALESCE(un.qty, 0::numeric)                                      AS undated_qty,
  COALESCE(br_main.available, 0::numeric)                           AS main_soh,
  COALESCE(br_gw.available, 0::numeric)                             AS gateway_soh,
  COALESCE(soh.available, 0::numeric) <= 0::numeric                 AS soh_nonpositive,
  CASE WHEN s.lifecycle_status <> 'DISCONTINUED' AND COALESCE(s.wk_avg, 0::numeric) > 0::numeric
       THEN (COALESCE(soh.available, 0::numeric) + COALESCE(cm.available, 0::numeric))
            / (s.wk_avg * 52::numeric / 12::numeric) END            AS mths_stock,
  CASE WHEN COALESCE(soh.available, 0::numeric) > 0::numeric AND COALESCE(s.wk_avg, 0::numeric) > 0::numeric
       THEN (COALESCE(soh.available, 0::numeric) + COALESCE(cm.available, 0::numeric))
            / (s.wk_avg * 52::numeric / 12::numeric) END            AS mths_stock_excel,
  s.lifecycle_status,
  s.superseded_by,
  s.superseded_by_key,
  s.lifecycle_note,
  s.cin7_status,
  s.wk_avg                                                          AS wk_avg_input,
  s.lifecycle_source,
  -- ── daqui para baixo é novo; anexado no fim porque REPLACE não reordena ──
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 'DISCONTINUED'
       WHEN s.lifecycle_status = 'RUN_OUT'      THEN 'RUN_OUT'
       WHEN NOT COALESCE(s.use_in_replenishment, true) THEN 'NO_BRANCH'
  END                                                               AS policy_flag,
  COALESCE(s.use_in_replenishment, true)                            AS use_in_replenishment,
  COALESCE(s.use_in_gateway, true)                                  AS use_in_gateway,
  s.policy_note
FROM rapid_inv.sku_settings s
  LEFT JOIN rapid_inv.v_sp_soh             soh     ON soh.sku = s.sku_key
  LEFT JOIN rapid_inv.v_sp_commitment      cm      ON cm.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_undated_demand  un      ON un.sku  = s.sku_key
  LEFT JOIN rapid_inv.v_sp_branch          br_main ON br_main.sku = s.sku_key AND br_main.branch_code = 'MAIN'
  LEFT JOIN rapid_inv.v_sp_branch          br_gw   ON br_gw.sku   = s.sku_key AND br_gw.branch_code   = 'GATEWAY'
WHERE s.is_planned
  -- A marca do Master Stock, obedecida. DISCONTINUED continua entrando de
  -- propósito: ver o cabeçalho.
  AND COALESCE(s.use_in_planning, true);

COMMENT ON VIEW rapid_inv.v_sp_planning_skus IS
  'SKUs do plano. Respeita use_in_planning do Master Stock. DISCONTINUED permanece, sinalizado por policy_flag, porque a sobra dele ainda precisa de decisão.';
