-- =================================================================
--  RAPID INVENTORY SKU — Forecast RPC (alta performance)
-- -----------------------------------------------------------------
--  A view v_forecast funciona, mas timeouts em 500 quando filtra
--  supplier_code porque a CROSS JOIN gera ~3 milhões de linhas
--  ANTES do filtro. Esta RPC empurra os filtros pra DENTRO das CTEs,
--  reduzindo o conjunto inicial para ~1k linhas.
--
--  Uso JS:
--    await supabase.schema('rapid_inv').rpc('get_forecast', {
--      p_supplier: 'UPSHINE', p_sku_like: null, p_weeks: 26
--    });
-- =================================================================

CREATE OR REPLACE FUNCTION rapid_inv.get_forecast(
  p_supplier  TEXT DEFAULT NULL,
  p_sku_like  TEXT DEFAULT NULL,
  p_weeks     INT  DEFAULT 26
)
RETURNS TABLE (
  sku                TEXT,
  supplier_code      TEXT,
  week_start         DATE,
  is_past            BOOLEAN,
  project_draws      NUMERIC,
  incoming           NUMERIC,
  sold_actual        NUMERIC,
  wk_avg             NUMERIC,
  outflow            NUMERIC,
  projected_balance  NUMERIC,
  current_soh        NUMERIC,
  opening_inventory  NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH filtered_skus AS (
    SELECT s.sku, s.supplier_hint
    FROM rapid_inv.v_skus_live s
    WHERE s.is_active = true
      AND (p_supplier IS NULL OR s.supplier_hint = p_supplier)
      AND (p_sku_like IS NULL OR s.sku ILIKE '%' || p_sku_like || '%')
  ),
  filtered_weeks AS (
    SELECT
      c.week_start,
      (c.week_start < CURRENT_DATE) AS is_past
    FROM rapid_inv.week_calendar c
    WHERE c.week_start BETWEEN
            CURRENT_DATE - INTERVAL '2 weeks'
        AND CURRENT_DATE + (GREATEST(p_weeks, 1) * INTERVAL '7 days')
  ),
  project_by_week AS (
    SELECT pl.sku, pl.pick_date AS week_start, SUM(pl.qty_to_pick) AS draws
    FROM rapid_inv.project_lines pl
    WHERE pl.finish_date IS NULL
      AND pl.pick_date IS NOT NULL
      AND pl.sku IN (SELECT sku FROM filtered_skus)
    GROUP BY pl.sku, pl.pick_date
  ),
  incoming_by_week AS (
    SELECT po.sku, po.due_date AS week_start, SUM(po.qty) AS incoming
    FROM rapid_inv.po_lines po
    WHERE po.is_received = false
      AND po.due_date IS NOT NULL
      AND po.sku IN (SELECT sku FROM filtered_skus)
    GROUP BY po.sku, po.due_date
  ),
  sales_by_week AS (
    SELECT ws.sku, ws.week_start, ws.qty AS sold
    FROM rapid_inv.weekly_sales ws
    WHERE ws.sku IN (SELECT sku FROM filtered_skus)
  ),
  soh_now AS (
    SELECT sm.sku, sm.available
    FROM rapid_inv.v_soh_main sm
    WHERE sm.sku IN (SELECT sku FROM filtered_skus)
  ),
  base AS (
    SELECT
      fs.sku,
      fs.supplier_hint                AS supplier_code,
      fw.week_start,
      fw.is_past,
      COALESCE(p.draws,    0)         AS project_draws,
      COALESCE(i.incoming, 0)         AS incoming,
      COALESCE(sl.sold,    0)         AS sold_actual,
      COALESCE(wa.wk_avg,  0)         AS wk_avg,
      COALESCE(soh.available, 0)      AS current_soh_val
    FROM filtered_skus fs
    CROSS JOIN filtered_weeks fw
    LEFT JOIN project_by_week  p  ON p.sku  = fs.sku AND p.week_start  = fw.week_start
    LEFT JOIN incoming_by_week i  ON i.sku  = fs.sku AND i.week_start  = fw.week_start
    LEFT JOIN sales_by_week    sl ON sl.sku = fs.sku AND sl.week_start = fw.week_start
    LEFT JOIN rapid_inv.v_wk_avg wa ON wa.sku = fs.sku
    LEFT JOIN soh_now soh ON soh.sku = fs.sku
  )
  SELECT
    b.sku,
    b.supplier_code,
    b.week_start,
    b.is_past,
    b.project_draws,
    b.incoming,
    b.sold_actual,
    b.wk_avg,
    CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg END AS outflow,
    b.current_soh_val +
      SUM(b.incoming - b.project_draws
          - (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg END))
        OVER (PARTITION BY b.sku ORDER BY b.week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS projected_balance,
    b.current_soh_val AS current_soh,
    b.current_soh_val +
      COALESCE(SUM(b.incoming - b.project_draws
                   - (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg END))
        OVER (PARTITION BY b.sku ORDER BY b.week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_inventory
  FROM base b
  ORDER BY b.sku, b.week_start;
$$;

GRANT EXECUTE ON FUNCTION rapid_inv.get_forecast(TEXT, TEXT, INT) TO anon, authenticated;

-- =================================================================
-- VERIFICAÇÃO
-- =================================================================
DO $$
DECLARE
  v_rows INT;
BEGIN
  -- Teste rápido pra garantir que a função compila e roda
  SELECT COUNT(*) INTO v_rows
    FROM rapid_inv.get_forecast(NULL, 'R3206', 4);
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  rapid_inv.get_forecast() criada ✅';
  RAISE NOTICE '  Teste (R3206, 4 semanas): % linhas', v_rows;
  RAISE NOTICE '======================================================';
END $$;
