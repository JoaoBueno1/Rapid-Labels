-- =================================================================
--  RAPID INVENTORY SKU — v_forecast (REVISÃO 2)
-- -----------------------------------------------------------------
--  Esta versão:
--    1. DROP CASCADE preventivo (evita "cannot change view column")
--    2. v_forecast agora lê de v_skus_live (Cin7) — não da tabela vazia
--    3. v_forecast_suppliers mostra TODOS os 23 seeds + brands do Cin7
--    4. Permite buscar/filtrar por qualquer supplier
--
--  TUDO read-only. Não toca em cin7_mirror.
--  Idempotente: pode rodar várias vezes.
-- =================================================================

-- 0. DROP preventivo (limpa qualquer estado parcial de tentativas anteriores)
--    CASCADE também derruba views que dependem (vão ser recriadas).
DROP VIEW IF EXISTS rapid_inv.v_forecast_suppliers  CASCADE;
DROP VIEW IF EXISTS rapid_inv.v_forecast            CASCADE;

-- Sanity check: também procura/derruba em qualquer outro schema (defensivo)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
      FROM information_schema.views
     WHERE table_name IN ('v_forecast', 'v_forecast_suppliers')
  LOOP
    EXECUTE format('DROP VIEW IF EXISTS %I.%I CASCADE', r.table_schema, r.table_name);
    RAISE NOTICE 'Dropped: %.%', r.table_schema, r.table_name;
  END LOOP;
END $$;

-- =================================================================
-- v_forecast — projeção semanal por SKU até 2030-12-29
-- -----------------------------------------------------------------
-- Ordem das colunas: mantém as 10 originais primeiro, depois adiciona
-- as 2 novas (current_soh, opening_inventory) no FIM.
-- Isso permite CREATE OR REPLACE funcionar mesmo se a view antiga
-- ainda existir parcialmente.
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_forecast AS
WITH project_by_week AS (
  SELECT sku, pick_date AS week_start, SUM(qty_to_pick) AS draws
  FROM rapid_inv.project_lines
  WHERE finish_date IS NULL AND pick_date IS NOT NULL
  GROUP BY sku, pick_date
),
incoming_by_week AS (
  SELECT sku, due_date AS week_start, SUM(qty) AS incoming
  FROM rapid_inv.po_lines
  WHERE is_received = false AND due_date IS NOT NULL
  GROUP BY sku, due_date
),
sales_by_week AS (
  SELECT sku, week_start, qty AS sold
  FROM rapid_inv.weekly_sales
),
current_soh AS (
  SELECT sku, available
  FROM rapid_inv.v_soh_main
),
base AS (
  SELECT
    s.sku,
    s.supplier_hint                AS supplier_code,
    c.week_start,
    (c.week_start < CURRENT_DATE)  AS is_past,
    COALESCE(p.draws,    0)        AS project_draws,
    COALESCE(i.incoming, 0)        AS incoming,
    COALESCE(sl.sold,    0)        AS sold_actual,
    COALESCE(wa.wk_avg,  0)        AS wk_avg,
    COALESCE(soh.available, 0)     AS current_soh_val
  FROM rapid_inv.v_skus_live s
  CROSS JOIN rapid_inv.week_calendar c
  LEFT JOIN project_by_week  p  ON p.sku  = s.sku AND p.week_start  = c.week_start
  LEFT JOIN incoming_by_week i  ON i.sku  = s.sku AND i.week_start  = c.week_start
  LEFT JOIN sales_by_week    sl ON sl.sku = s.sku AND sl.week_start = c.week_start
  LEFT JOIN rapid_inv.v_wk_avg wa ON wa.sku = s.sku
  LEFT JOIN current_soh soh ON soh.sku = s.sku
  WHERE s.is_active = true
    AND c.week_start BETWEEN CURRENT_DATE - INTERVAL '2 weeks'
                         AND '2030-12-29'
)
SELECT
  -- ── 10 colunas originais (mesma ordem da v_forecast antiga) ──
  sku,
  supplier_code,
  week_start,
  is_past,
  project_draws,
  incoming,
  sold_actual,
  wk_avg,
  CASE WHEN is_past THEN sold_actual ELSE wk_avg END                AS outflow,
  current_soh_val
    + SUM(incoming - project_draws
         - (CASE WHEN is_past THEN sold_actual ELSE wk_avg END))
        OVER (PARTITION BY sku ORDER BY week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)     AS projected_balance,
  -- ── 2 colunas NOVAS no FIM (CREATE OR REPLACE compatível) ──
  current_soh_val                                                   AS current_soh,
  current_soh_val
    + COALESCE(SUM(incoming - project_draws
                  - (CASE WHEN is_past THEN sold_actual ELSE wk_avg END))
        OVER (PARTITION BY sku ORDER BY week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_inventory
FROM base;

-- =================================================================
-- v_forecast_suppliers — TODOS os fornecedores disponíveis
--   1) 23 seeds da tabela rapid_inv.suppliers (mesmo com 0 SKUs)
--   2) + qualquer brand do Cin7 que não bate com seeds
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_forecast_suppliers AS
WITH cin7_brands AS (
  SELECT
    NULLIF(TRIM(brand), '')        AS brand_raw,
    UPPER(NULLIF(TRIM(brand), '')) AS brand_norm,
    COUNT(*)                       AS sku_count
  FROM cin7_mirror.products
  WHERE status = 'Active'
  GROUP BY 1, 2
),
seeded AS (
  SELECT
    s.code                                            AS supplier_code,
    s.name                                            AS supplier_name,
    'seed'                                            AS source,
    COALESCE((
      SELECT SUM(cb.sku_count) FROM cin7_brands cb
       WHERE cb.brand_norm IS NOT NULL
         AND (cb.brand_norm = UPPER(s.code)
              OR cb.brand_norm = UPPER(s.name)
              OR cb.brand_norm LIKE UPPER(s.code) || '%'
              OR UPPER(s.name) LIKE cb.brand_norm   || '%')
    ), 0) AS sku_count
  FROM rapid_inv.suppliers s
  WHERE s.is_active = true
),
unmatched_brands AS (
  SELECT
    cb.brand_raw  AS supplier_code,
    cb.brand_raw  AS supplier_name,
    'cin7_brand'  AS source,
    cb.sku_count
  FROM cin7_brands cb
  WHERE cb.brand_raw IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM rapid_inv.suppliers s
      WHERE s.is_active = true
        AND (UPPER(s.code) = cb.brand_norm
          OR UPPER(s.name) = cb.brand_norm
          OR cb.brand_norm LIKE UPPER(s.code) || '%'
          OR UPPER(s.name) LIKE cb.brand_norm   || '%')
    )
)
SELECT * FROM seeded
UNION ALL
SELECT * FROM unmatched_brands
ORDER BY source, supplier_code;

-- =================================================================
-- Permissions
-- =================================================================
GRANT SELECT ON rapid_inv.v_forecast            TO anon, authenticated;
GRANT SELECT ON rapid_inv.v_forecast_suppliers  TO anon, authenticated;

-- =================================================================
-- VERIFICAÇÃO
-- =================================================================
DO $$
DECLARE
  v_brands INT;
  v_seeds  INT;
  v_unmatched INT;
BEGIN
  SELECT COUNT(*) INTO v_brands    FROM rapid_inv.v_forecast_suppliers;
  SELECT COUNT(*) INTO v_seeds     FROM rapid_inv.v_forecast_suppliers WHERE source = 'seed';
  SELECT COUNT(*) INTO v_unmatched FROM rapid_inv.v_forecast_suppliers WHERE source = 'cin7_brand';
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  v_forecast (revisão 2) atualizada ✅';
  RAISE NOTICE '  Total no dropdown : %', v_brands;
  RAISE NOTICE '    - Seeds (23)    : %', v_seeds;
  RAISE NOTICE '    - Brands Cin7   : %', v_unmatched;
  RAISE NOTICE '======================================================';
END $$;
