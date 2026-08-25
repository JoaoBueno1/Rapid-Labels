-- =====================================================================
-- Stock Planning · 010 · DERIVA DO Wk/Avg
-- ---------------------------------------------------------------------
-- O Wk/Avg é entrada manual — 837 blocos conferidos no workbook, nem uma
-- fórmula. Ele comanda toda a compra da empresa e nunca foi medido contra
-- nada, nem tem sinal de quando envelheceu.
--
-- Um parâmetro manual sem monitor de deriva é o único ponto de falha de uma
-- decisão que é humana de propósito. Isto NÃO sobrescreve nada: mostra o
-- realizado ao lado, o desvio, e há quanto tempo ninguém toca no número.
-- =====================================================================

CREATE OR REPLACE VIEW rapid_inv.v_sp_wkavg_drift AS
SELECT v.sku, v.sku_key, v.supplier_code,
       v.wk_avg                                              AS typed,
       round(COALESCE(a.actual_wk, 0)::NUMERIC, 2)           AS actual,
       round((COALESCE(a.actual_wk,0) - v.wk_avg)::NUMERIC, 2) AS gap,
       round((100.0 * (COALESCE(a.actual_wk,0) - v.wk_avg) / NULLIF(v.wk_avg,0))::NUMERIC, 0) AS gap_pct,
       s.wk_avg_source,
       s.updated_at                                          AS last_touched,
       (CURRENT_DATE - s.updated_at::DATE)                   AS days_since_touched,
       s.updated_by                                          AS touched_by,
       round(v.stock_value_aud::NUMERIC, 0)                  AS stock_value_aud,
       v.lifecycle_status,
       -- O que fazer, dito em palavras. Uma coluna de percentual sozinha
       -- não move ninguém.
       CASE
         WHEN v.wk_avg > 0 AND COALESCE(a.actual_wk,0) = 0            THEN 'buying cover for demand that is not arriving'
         WHEN COALESCE(v.wk_avg,0) = 0 AND a.actual_wk > 0            THEN 'selling with no forecast — invisible to the grid'
         WHEN v.wk_avg > 0 AND a.actual_wk > v.wk_avg * 1.5           THEN 'runs out earlier than the grid says'
         WHEN v.wk_avg > 0 AND a.actual_wk < v.wk_avg * 0.5           THEN 'buying to a number the sales do not support'
         WHEN v.wk_avg > 0 AND a.actual_wk IS NOT NULL                THEN 'in line'
       END                                                   AS reading
  FROM rapid_inv.v_sp_sku_value v
  JOIN rapid_inv.sku_settings s ON s.sku_key = v.sku_key
  LEFT JOIN rapid_inv.v_sp_actual_weekly a ON a.sku_key = v.sku_key
 WHERE v.lifecycle_status = 'ACTIVE';

DO $$ BEGIN RAISE NOTICE '010: monitor de deriva do Wk/Avg pronto'; END $$;
