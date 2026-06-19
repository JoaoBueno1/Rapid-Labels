-- =================================================================
--  RAPID INVENTORY SKU — CORREÇÕES v2 (ISOLADAS, NÃO QUEBRA NADA)
-- -----------------------------------------------------------------
--  Corrige as divergências encontradas na auditoria Excel × Sistema:
--    #1 fórmula de meses-de-cobertura (definição canônica + compat Excel)
--    #2 thresholds de alerta (Excel: <1 mês = reordenar)  -> default red=1 / yel=2
--    #3 demanda de projeto CONSISTENTE entre Analysis e Forecast
--    #4 dupla contagem no forecast (separa baseline rotineiro de projeto)
--    #6 KPIs não escondem mais SKUs sem média (skus_no_demand_data / skus_hidden_risk)
--
--  >>> TUDO criado com sufixo _v2 — NÃO altera nenhuma view/função viva.
--  >>> 100% read-only: só CREATE OR REPLACE VIEW / FUNCTION. Sem tabela,
--      sem trigger, sem write, sem tocar em cin7_mirror nem no dashboard.
--  >>> Reverter é trivial: DROP ... _v2.  Idempotente: pode rodar de novo.
--
--  NÃO está conectado a nenhum botão/página ainda (proposital).
--  Para validar lado-a-lado com a versão atual, ver bloco "VALIDAÇÃO" no fim.
-- =================================================================

-- =================================================================
-- V2.1  v_wk_avg_v2  →  separa média ROTINEIRA de média de PROJETO
-- -----------------------------------------------------------------
--  Corrige #4 (dupla contagem). A wk_avg "total" (vinda de v_wk_avg)
--  embute as vendas históricas de projeto. Aqui estimamos a parcela de
--  projeto (wk_avg_project) a partir do histórico de project_lines e
--  derivamos a baseline rotineira (wk_avg_routine = total − projeto).
--  Enquanto project_lines estiver vazia, wk_avg_project = 0 e
--  wk_avg_routine = wk_avg_total (comportamento atual) — o mecanismo já
--  fica pronto e se autocorrige assim que os dados de projeto entrarem.
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_wk_avg_v2 AS
WITH proj_rate AS (
  -- demanda média semanal de projeto nas últimas 26 semanas (qty bruta da linha)
  SELECT
    sku,
    ROUND((SUM(qty) / 26.0)::numeric, 2) AS wk_avg_project
  FROM rapid_inv.project_lines
  WHERE pick_date IS NOT NULL
    AND pick_date >= CURRENT_DATE - INTERVAL '26 weeks'
    AND pick_date <  CURRENT_DATE
  GROUP BY sku
)
SELECT
  w.sku,
  COALESCE(w.wk_avg, 0)                                            AS wk_avg_total,
  COALESCE(pr.wk_avg_project, 0)                                   AS wk_avg_project,
  GREATEST(COALESCE(w.wk_avg,0) - COALESCE(pr.wk_avg_project,0), 0) AS wk_avg_routine
FROM rapid_inv.v_wk_avg w
LEFT JOIN proj_rate pr ON pr.sku = w.sku;

GRANT SELECT ON rapid_inv.v_wk_avg_v2 TO anon, authenticated;

-- =================================================================
-- V2.2  v_analysis_v2  →  Analysis corrigida
-- -----------------------------------------------------------------
--  #1  mths_stock = (SOH − demanda_projeto_aberta) / média mensal   (canônica)
--      mths_stock_with_on_order = (SOH + On Order − demanda) / média (compat Excel/On-Order)
--  #2  thresholds default red=1 / yel=2  (regra do Excel: F<1 = reordenar)
--  #3  "open_project_demand" = MESMA definição usada no forecast_v2
--      (finish_date IS NULL AND qty_to_pick > 0)  -> as duas telas batem
--  #6  flag no_demand_data exposta (wk_avg = 0)
--  SOH: prioridade snapshot local > v_soh_main (Cin7 vivo) > 0
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_analysis_v2 AS
WITH snap AS (   -- override manual de SOH (paste); vazio no caminho vivo
  SELECT DISTINCT ON (sku) sku, available
  FROM rapid_inv.soh_snapshot
  ORDER BY sku, snapshot_date DESC
),
soh AS (         -- JOIN (rápido) em vez de subquery correlacionada; snapshot > Cin7 vivo
  SELECT
    m.sku,
    COALESCE(sn.available, m.available, 0) AS available,
    COALESCE(m.on_order, 0)                AS on_order
  FROM rapid_inv.v_soh_main m
  LEFT JOIN snap sn ON sn.sku = m.sku
),
open_proj AS (   -- definição CANÔNICA de demanda de projeto aberta (== forecast_v2)
  SELECT sku, SUM(qty_to_pick) AS open_demand
  FROM rapid_inv.project_lines
  WHERE finish_date IS NULL AND qty_to_pick > 0
  GROUP BY sku
)
SELECT
  s.sku,
  s.supplier_hint                                               AS supplier_code,
  COALESCE(wa.wk_avg_total, 0)                                  AS wk_avg,
  COALESCE(wa.wk_avg_routine, 0)                               AS wk_avg_routine,
  COALESCE(wa.wk_avg_project, 0)                               AS wk_avg_project,
  ROUND(COALESCE(wa.wk_avg_total, 0) * 52.0/12.0, 2)           AS mth_avg,
  COALESCE(soh.available, 0)                                   AS soh,
  COALESCE(soh.on_order, 0)                                    AS on_order,
  COALESCE(op.open_demand, 0)                                  AS open_project_demand,
  (COALESCE(soh.available,0) - COALESCE(op.open_demand,0))     AS net_available_now,
  -- #1 cobertura canônica (estoque já livre de projeto / consumo mensal)
  CASE WHEN COALESCE(wa.wk_avg_total,0) > 0
       THEN ROUND(((COALESCE(soh.available,0) - COALESCE(op.open_demand,0))
                  / (wa.wk_avg_total * 52.0/12.0))::numeric, 2)
       ELSE NULL
  END                                                          AS mths_stock,
  -- #1 variante incluindo On Order no numerador (paridade com a aba SOH do Excel)
  CASE WHEN COALESCE(wa.wk_avg_total,0) > 0
       THEN ROUND(((COALESCE(soh.available,0) + COALESCE(soh.on_order,0) - COALESCE(op.open_demand,0))
                  / (wa.wk_avg_total * 52.0/12.0))::numeric, 2)
       ELSE NULL
  END                                                          AS mths_stock_with_on_order,
  COALESCE(ss.comments, '')                                    AS comments,
  COALESCE(ss.threshold_red, 1)                                AS threshold_red,  -- #2 Excel: <1 = reorder
  COALESCE(ss.threshold_yel, 2)                                AS threshold_yel,  -- #2
  (COALESCE(wa.wk_avg_total,0) = 0)                            AS no_demand_data  -- #6
FROM rapid_inv.v_skus_live s
LEFT JOIN rapid_inv.v_wk_avg_v2 wa  ON wa.sku = s.sku
LEFT JOIN soh                       ON soh.sku = s.sku
LEFT JOIN open_proj op              ON op.sku = s.sku
LEFT JOIN rapid_inv.sku_settings ss ON ss.sku = s.sku
WHERE s.is_active = true;

GRANT SELECT ON rapid_inv.v_analysis_v2 TO anon, authenticated;

-- =================================================================
-- V2.3  v_forecast_v2  →  cascata semanal corrigida
-- -----------------------------------------------------------------
--  #3  demanda de projeto = MESMA definição da v_analysis_v2
--      (finish_date IS NULL AND qty_to_pick > 0). Linhas vencidas (pick_date
--      no passado) ou SEM data caem na SEMANA ATUAL — nada se perde e a soma
--      de todas as semanas == open_project_demand do Analysis.
--  #4  futuro: outflow = wk_avg_routine + project_draws  (sem dupla contagem;
--      no passado outflow = vendas reais, e project_draws=0 por construção).
--  Datas "snapadas" para o domingo da semana (alinha com week_calendar) —
--  corrige bug latente de pick_date/due_date que não caíam em nenhuma semana.
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_forecast_v2 AS
WITH cur AS (
  SELECT (SELECT MAX(week_start) FROM rapid_inv.week_calendar
           WHERE week_start <= CURRENT_DATE) AS current_week
),
open_lines AS (
  SELECT
    pl.sku,
    pl.qty_to_pick,
    CASE
      WHEN pl.pick_date IS NULL
        THEN (SELECT current_week FROM cur)
      ELSE GREATEST(
             (pl.pick_date - EXTRACT(DOW FROM pl.pick_date)::int)::date,
             (SELECT current_week FROM cur)
           )
    END AS week_start
  FROM rapid_inv.project_lines pl
  WHERE pl.finish_date IS NULL AND pl.qty_to_pick > 0
),
project_by_week AS (
  SELECT sku, week_start, SUM(qty_to_pick) AS draws
  FROM open_lines
  GROUP BY sku, week_start
),
incoming_by_week AS (
  SELECT
    sku,
    (due_date - EXTRACT(DOW FROM due_date)::int)::date AS week_start,
    SUM(qty) AS incoming
  FROM rapid_inv.po_lines
  WHERE is_received = false AND due_date IS NOT NULL
  GROUP BY sku, (due_date - EXTRACT(DOW FROM due_date)::int)::date
),
sales_by_week AS (
  SELECT
    sku,
    (week_start - EXTRACT(DOW FROM week_start)::int)::date AS week_start,
    SUM(qty) AS sold
  FROM rapid_inv.weekly_sales
  GROUP BY sku, (week_start - EXTRACT(DOW FROM week_start)::int)::date
),
current_soh AS (   -- JOIN (rápido); snapshot manual > Cin7 vivo
  SELECT m.sku, COALESCE(sn.available, m.available, 0) AS available
  FROM rapid_inv.v_soh_main m
  LEFT JOIN (
    SELECT DISTINCT ON (sku) sku, available
    FROM rapid_inv.soh_snapshot ORDER BY sku, snapshot_date DESC
  ) sn ON sn.sku = m.sku
),
base AS (
  SELECT
    s.sku,
    s.supplier_hint                AS supplier_code,
    c.week_start,
    (c.week_start < CURRENT_DATE)  AS is_past,
    COALESCE(p.draws, 0)           AS project_draws,
    COALESCE(i.incoming, 0)        AS incoming,
    COALESCE(sl.sold, 0)           AS sold_actual,
    COALESCE(wa.wk_avg_total, 0)   AS wk_avg_total,
    COALESCE(wa.wk_avg_routine, 0) AS wk_avg_routine,
    COALESCE(soh.available, 0)     AS current_soh_val
  FROM rapid_inv.v_skus_live s
  CROSS JOIN rapid_inv.week_calendar c
  LEFT JOIN project_by_week  p  ON p.sku  = s.sku AND p.week_start  = c.week_start
  LEFT JOIN incoming_by_week i  ON i.sku  = s.sku AND i.week_start  = c.week_start
  LEFT JOIN sales_by_week    sl ON sl.sku = s.sku AND sl.week_start = c.week_start
  LEFT JOIN rapid_inv.v_wk_avg_v2 wa ON wa.sku = s.sku
  LEFT JOIN current_soh soh ON soh.sku = s.sku
  WHERE s.is_active = true
    AND c.week_start BETWEEN CURRENT_DATE - INTERVAL '2 weeks' AND '2030-12-29'
)
SELECT
  sku,
  supplier_code,
  week_start,
  is_past,
  project_draws,
  incoming,
  sold_actual,
  wk_avg_total,
  wk_avg_routine,
  -- consumo rotineiro (passado = real; futuro = baseline sem projeto)
  (CASE WHEN is_past THEN sold_actual ELSE wk_avg_routine END)            AS routine_outflow,
  -- saída total reportada (rotina + projeto)
  (CASE WHEN is_past THEN sold_actual ELSE wk_avg_routine END) + project_draws AS outflow_total,
  current_soh_val
    + SUM(incoming - project_draws
          - (CASE WHEN is_past THEN sold_actual ELSE wk_avg_routine END))
        OVER (PARTITION BY sku ORDER BY week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)           AS projected_balance,
  current_soh_val                                                         AS current_soh,
  current_soh_val
    + COALESCE(SUM(incoming - project_draws
                   - (CASE WHEN is_past THEN sold_actual ELSE wk_avg_routine END))
        OVER (PARTITION BY sku ORDER BY week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)       AS opening_inventory
FROM base;

GRANT SELECT ON rapid_inv.v_forecast_v2 TO anon, authenticated;

-- =================================================================
-- V2.4  get_forecast_v2()  →  RPC de alta performance (filtros empurrados)
-- -----------------------------------------------------------------
--  Mesma lógica corrigida da v_forecast_v2, mas com p_supplier/p_sku_like/
--  p_weeks empurrados pra dentro das CTEs (evita CROSS JOIN de milhões).
--  Assinatura nova (não conflita com get_forecast atual).
-- =================================================================
CREATE OR REPLACE FUNCTION rapid_inv.get_forecast_v2(
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
  wk_avg_total       NUMERIC,
  wk_avg_routine     NUMERIC,
  routine_outflow    NUMERIC,
  outflow_total      NUMERIC,
  projected_balance  NUMERIC,
  current_soh        NUMERIC,
  opening_inventory  NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH cur AS (
    SELECT (SELECT MAX(week_start) FROM rapid_inv.week_calendar
             WHERE week_start <= CURRENT_DATE) AS current_week
  ),
  filtered_skus AS (
    SELECT s.sku, s.supplier_hint
    FROM rapid_inv.v_skus_live s
    WHERE s.is_active = true
      AND (p_supplier IS NULL OR s.supplier_hint = p_supplier)
      AND (p_sku_like IS NULL OR s.sku ILIKE '%' || p_sku_like || '%')
  ),
  filtered_weeks AS (
    SELECT c.week_start, (c.week_start < CURRENT_DATE) AS is_past
    FROM rapid_inv.week_calendar c
    WHERE c.week_start BETWEEN CURRENT_DATE - INTERVAL '2 weeks'
                          AND CURRENT_DATE + (GREATEST(p_weeks,1) * INTERVAL '7 days')
  ),
  open_lines AS (
    SELECT
      pl.sku,
      pl.qty_to_pick,
      CASE
        WHEN pl.pick_date IS NULL THEN (SELECT current_week FROM cur)
        ELSE GREATEST((pl.pick_date - EXTRACT(DOW FROM pl.pick_date)::int)::date,
                      (SELECT current_week FROM cur))
      END AS week_start
    FROM rapid_inv.project_lines pl
    WHERE pl.finish_date IS NULL AND pl.qty_to_pick > 0
      AND pl.sku IN (SELECT sku FROM filtered_skus)
  ),
  project_by_week AS (
    SELECT sku, week_start, SUM(qty_to_pick) AS draws
    FROM open_lines GROUP BY sku, week_start
  ),
  incoming_by_week AS (
    SELECT po.sku,
           (po.due_date - EXTRACT(DOW FROM po.due_date)::int)::date AS week_start,
           SUM(po.qty) AS incoming
    FROM rapid_inv.po_lines po
    WHERE po.is_received = false AND po.due_date IS NOT NULL
      AND po.sku IN (SELECT sku FROM filtered_skus)
    GROUP BY po.sku, (po.due_date - EXTRACT(DOW FROM po.due_date)::int)::date
  ),
  sales_by_week AS (
    SELECT ws.sku,
           (ws.week_start - EXTRACT(DOW FROM ws.week_start)::int)::date AS week_start,
           SUM(ws.qty) AS sold
    FROM rapid_inv.weekly_sales ws
    WHERE ws.sku IN (SELECT sku FROM filtered_skus)
    GROUP BY ws.sku, (ws.week_start - EXTRACT(DOW FROM ws.week_start)::int)::date
  ),
  soh_now AS (   -- JOIN filtrado (rápido); snapshot manual > Cin7 vivo
    SELECT m.sku, COALESCE(sn.available, m.available, 0) AS available
    FROM rapid_inv.v_soh_main m
    LEFT JOIN (
      SELECT DISTINCT ON (sku) sku, available
      FROM rapid_inv.soh_snapshot ORDER BY sku, snapshot_date DESC
    ) sn ON sn.sku = m.sku
    WHERE m.sku IN (SELECT sku FROM filtered_skus)
  ),
  base AS (
    SELECT
      fs.sku,
      fs.supplier_hint                AS supplier_code,
      fw.week_start,
      fw.is_past,
      COALESCE(p.draws, 0)            AS project_draws,
      COALESCE(i.incoming, 0)         AS incoming,
      COALESCE(sl.sold, 0)            AS sold_actual,
      COALESCE(wa.wk_avg_total, 0)    AS wk_avg_total,
      COALESCE(wa.wk_avg_routine, 0)  AS wk_avg_routine,
      COALESCE(soh.available, 0)      AS current_soh_val
    FROM filtered_skus fs
    CROSS JOIN filtered_weeks fw
    LEFT JOIN project_by_week  p  ON p.sku  = fs.sku AND p.week_start  = fw.week_start
    LEFT JOIN incoming_by_week i  ON i.sku  = fs.sku AND i.week_start  = fw.week_start
    LEFT JOIN sales_by_week    sl ON sl.sku = fs.sku AND sl.week_start = fw.week_start
    LEFT JOIN rapid_inv.v_wk_avg_v2 wa ON wa.sku = fs.sku
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
    b.wk_avg_total,
    b.wk_avg_routine,
    (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg_routine END)                  AS routine_outflow,
    (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg_routine END) + b.project_draws AS outflow_total,
    b.current_soh_val +
      SUM(b.incoming - b.project_draws
          - (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg_routine END))
        OVER (PARTITION BY b.sku ORDER BY b.week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)                         AS projected_balance,
    b.current_soh_val                                                                   AS current_soh,
    b.current_soh_val +
      COALESCE(SUM(b.incoming - b.project_draws
                   - (CASE WHEN b.is_past THEN b.sold_actual ELSE b.wk_avg_routine END))
        OVER (PARTITION BY b.sku ORDER BY b.week_start
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)                     AS opening_inventory
  FROM base b
  ORDER BY b.sku, b.week_start;
$$;

GRANT EXECUTE ON FUNCTION rapid_inv.get_forecast_v2(TEXT, TEXT, INT) TO anon, authenticated;

-- =================================================================
-- V2.5  v_dashboard_kpis_v2  →  #6: não esconde SKUs sem média
-- -----------------------------------------------------------------
--  Mantém todos os KPIs atuais e ADICIONA:
--    skus_no_demand_data  = SKUs ativos com wk_avg = 0 (antes sumiam)
--    skus_hidden_risk     = SKUs sem média PORÉM com demanda de projeto
--                           aberta OU SOH <= 0 (risco real invisível)
--  Usa v_analysis_v2 (thresholds 1/2).
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_dashboard_kpis_v2 AS
SELECT
  (SELECT COUNT(*) FROM rapid_inv.v_open_sos)                                      AS open_so_lines,
  (SELECT COUNT(*) FROM rapid_inv.po_lines      WHERE is_received = false)         AS open_po_lines,
  (SELECT COALESCE(SUM(qty_held),0) FROM rapid_inv.project_lines
     WHERE finish_date IS NULL AND qty_held > 0)                                   AS qty_pack_and_hold,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis_v2
     WHERE mths_stock IS NOT NULL AND mths_stock < threshold_red)                  AS skus_critical_red,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis_v2
     WHERE mths_stock IS NOT NULL
       AND mths_stock >= threshold_red AND mths_stock < threshold_yel)             AS skus_warning_yellow,
  -- #6 novos
  (SELECT COUNT(*) FROM rapid_inv.v_analysis_v2 WHERE no_demand_data = true)       AS skus_no_demand_data,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis_v2
     WHERE mths_stock IS NULL AND (open_project_demand > 0 OR soh <= 0))           AS skus_hidden_risk,
  (SELECT COUNT(DISTINCT sku) FROM rapid_inv.v_skus_live WHERE is_active = true)   AS total_active_skus,
  (SELECT COALESCE(SUM(value_aud),0) FROM rapid_inv.po_lines
     WHERE is_received = false)                                                    AS po_pipeline_aud,
  (SELECT MAX(synced_at) FROM cin7_mirror.stock_snapshot)                          AS soh_last_synced_at,
  (SELECT MAX(synced_at) FROM cin7_mirror.products)                               AS skus_last_synced_at;

GRANT SELECT ON rapid_inv.v_dashboard_kpis_v2 TO anon, authenticated;

-- =================================================================
-- VERIFICAÇÃO (só lê; não muda nada)
-- =================================================================
DO $$
DECLARE
  v_rows INT;
BEGIN
  PERFORM 1 FROM rapid_inv.v_analysis_v2 LIMIT 1;
  PERFORM 1 FROM rapid_inv.v_forecast_v2 LIMIT 1;
  SELECT COUNT(*) INTO v_rows FROM rapid_inv.get_forecast_v2(NULL, NULL, 4);
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  rapid_inv correções v2 criadas ✅ (isoladas, _v2)';
  RAISE NOTICE '  v_wk_avg_v2 / v_analysis_v2 / v_forecast_v2';
  RAISE NOTICE '  get_forecast_v2() teste 4 semanas: % linhas', v_rows;
  RAISE NOTICE '  v_dashboard_kpis_v2';
  RAISE NOTICE '  Nada do sistema atual foi alterado.';
  RAISE NOTICE '======================================================';
END $$;

-- =================================================================
-- VALIDAÇÃO LADO-A-LADO (rode manualmente quando quiser comparar)
-- -----------------------------------------------------------------
-- 1) Comparar cobertura antiga × nova por SKU:
--    SELECT a.sku, a.mths_stock AS v1, b.mths_stock AS v2,
--           b.mths_stock_with_on_order AS v2_excel_compat
--    FROM rapid_inv.v_analysis a
--    JOIN rapid_inv.v_analysis_v2 b USING (sku)
--    WHERE a.mths_stock IS DISTINCT FROM b.mths_stock
--    ORDER BY b.mths_stock NULLS FIRST LIMIT 50;
--
-- 2) Conferir consistência Analysis × Forecast (#3) — devem bater:
--    SELECT an.sku, an.open_project_demand AS analysis_total,
--           fc.fc_total
--    FROM rapid_inv.v_analysis_v2 an
--    JOIN (SELECT sku, SUM(project_draws) AS fc_total
--            FROM rapid_inv.v_forecast_v2 GROUP BY sku) fc USING (sku)
--    WHERE an.open_project_demand IS DISTINCT FROM fc.fc_total;   -- ideal: 0 linhas
--
-- 3) KPIs novos (#6):
--    SELECT skus_critical_red, skus_warning_yellow,
--           skus_no_demand_data, skus_hidden_risk, total_active_skus
--    FROM rapid_inv.v_dashboard_kpis_v2;
-- =================================================================
