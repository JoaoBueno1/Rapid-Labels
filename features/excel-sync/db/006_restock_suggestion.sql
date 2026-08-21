-- ═══════════════════════════════════════════════════════════════════
-- Restock suggestion por filial — o mesmo calculo da tela de
-- features/replenishment, feito UMA vez, no banco.
--
-- Por que aqui e nao no Power Query: o M precisaria juntar tres fontes
-- (medias, estoque da filial, estoque do Main) e o Formula Firewall recusa
-- consulta multi-fonte com caminho derivado -- "references other queries or
-- steps, so it may not directly access a data source". As abas que ja rodam
-- passam porque cada uma e fonte unica com RelativePath literal. Alem disso,
-- aqui a regra vive num lugar so, em vez de copiada dentro de 7 planilhas.
--
-- Constantes copiadas de replenishment-config.js, nao reinventadas:
--   WEEKS_IN_MONTH 4.345 | ABC A=10 B=8 C=6 semanas | cortes em 20% e 50%
--
-- O corte foi CALIBRADO contra a lista real de envio do Joao de 20/08
-- (transfer-SYD-selected-46.csv), nao escolhido no chute:
--   avg > 0        exige historico de venda
--   main > 0       dos 46 itens que ele mandaria, 46 tinham Main > 0
--   in_transit = 0 nao remandar o que ja esta a caminho
--   cover < 25     a cobertura dos itens que ele mandaria vai de 0 a 23 dias
-- Resultado dessa combinacao: 72 linhas cobrindo 44 dos 46.
--
-- suggested_qty e "quanto falta para o alvo", NAO o send_qty da tela: aquele
-- desconta ainda a seguranca de 8 semanas do Main, o arredondamento por caixa,
-- o minimo de envio e o conflito entre filiais. Nomear como envio seria mentir.
--
-- Idempotente — seguro reexecutar.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.excel_restock_suggestion(p_branch TEXT)
RETURNS TABLE (
  sku            TEXT,
  suggested_qty  INT,
  available_now  NUMERIC,
  avg_month      NUMERIC,
  main_gateway   NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = cin7_mirror, public
AS $fn$
WITH avg_raw AS (
  SELECT a.product,
         -- avg_rep vence avg_mth quando for maior que zero, como pickAvg()
         CASE p_branch
           WHEN 'Sydney'                   THEN COALESCE(NULLIF(a.avg_rep_sydney,0),         a.avg_mth_sydney)
           WHEN 'Melbourne'                THEN COALESCE(NULLIF(a.avg_rep_melbourne,0),      a.avg_mth_melbourne)
           WHEN 'Brisbane'                 THEN COALESCE(NULLIF(a.avg_rep_brisbane,0),       a.avg_mth_brisbane)
           WHEN 'Cairns'                   THEN COALESCE(NULLIF(a.avg_rep_cairns,0),         a.avg_mth_cairns)
           WHEN 'Coffs Harbour'            THEN COALESCE(NULLIF(a.avg_rep_coffs_harbour,0),  a.avg_mth_coffs_harbour)
           WHEN 'Hobart'                   THEN COALESCE(NULLIF(a.avg_rep_hobart,0),         a.avg_mth_hobart)
           WHEN 'Sunshine Coast Warehouse' THEN COALESCE(NULLIF(a.avg_rep_sunshine_coast,0), a.avg_mth_sunshine_coast)
         END::NUMERIC AS avg_branch,
         -- demanda de REDE: e ela que define o tier, nao a da filial
         (COALESCE(NULLIF(a.avg_rep_sydney,0),         a.avg_mth_sydney,         0)
        + COALESCE(NULLIF(a.avg_rep_melbourne,0),      a.avg_mth_melbourne,      0)
        + COALESCE(NULLIF(a.avg_rep_brisbane,0),       a.avg_mth_brisbane,       0)
        + COALESCE(NULLIF(a.avg_rep_cairns,0),         a.avg_mth_cairns,         0)
        + COALESCE(NULLIF(a.avg_rep_coffs_harbour,0),  a.avg_mth_coffs_harbour,  0)
        + COALESCE(NULLIF(a.avg_rep_hobart,0),         a.avg_mth_hobart,         0)
        + COALESCE(NULLIF(a.avg_rep_sunshine_coast,0), a.avg_mth_sunshine_coast, 0))::NUMERIC AS net
    FROM public.branch_avg_monthly_sales a
),
-- ROW_NUMBER, nao PERCENT_RANK: a tela usa indice posicional
-- (i < ceil(n*0.20)), enquanto PERCENT_RANK calcula (rank-1)/(n-1) e trata
-- empate de outro jeito -- isso jogava SKUs de fronteira para o tier errado.
--
-- E o desempate por product nao e enfeite. Dezenas de SKUs empatam na mesma
-- demanda de rede; sem uma segunda chave a ordem entre eles e arbitraria e o
-- MESMO produto cai em B numa execucao e em C na seguinte. O R1166-BK-WW esta
-- na posicao 480 de 954 com o corte B em 477: com desempate ele fica sempre em
-- B (sugestao 6); sem, alterna entre 6 e 5 sozinho. A fronteira continua sendo
-- arbitraria -- isso e da regra, nao da implementacao -- mas fica ESTAVEL, que
-- e o que decide se alguem confia na lista.
ranked AS (
  SELECT product, avg_branch,
         ROW_NUMBER() OVER (ORDER BY net DESC, product) AS rn,
         COUNT(*)     OVER ()                           AS n
    FROM avg_raw WHERE net > 0
),
tiered AS (
  SELECT product, avg_branch,
         CASE WHEN rn <= CEIL(n * 0.20) THEN 10
              WHEN rn <= CEIL(n * 0.50) THEN 8
              ELSE 6 END AS weeks
    FROM ranked
),
branch AS (
  SELECT s.sku,
         SUM(COALESCE(s.available,0))  AS avail,
         SUM(COALESCE(s.in_transit,0)) AS transit,
         MIN(s.product_name)           AS pname
    FROM cin7_mirror.stock_snapshot s
   WHERE s.location_name = p_branch
   GROUP BY s.sku
),
main AS (
  SELECT s.sku, SUM(COALESCE(s.available,0)) AS avail
    FROM cin7_mirror.stock_snapshot s
   WHERE s.location_name IN ('Main Warehouse','Gateway')
   GROUP BY s.sku
),
calc AS (
  SELECT t.product AS sku,
         COALESCE(b.avail,0)   AS avail,
         COALESCE(b.transit,0) AS transit,
         COALESCE(m.avail,0)   AS main_avail,
         t.avg_branch,
         b.pname,
         CEIL(t.avg_branch / 4.345 * t.weeks) AS target,
         CASE WHEN t.avg_branch > 0
              THEN GREATEST(0, ROUND(COALESCE(b.avail,0) / (t.avg_branch / 4.345) * 7))
              ELSE 0 END AS cover_days
    FROM tiered t
    LEFT JOIN branch b ON b.sku = t.product
    LEFT JOIN main   m ON m.sku = t.product
   WHERE t.avg_branch > 0
)
SELECT c.sku::TEXT,
       CEIL(GREATEST(0, c.target - c.avail))::INT,
       c.avail,
       c.avg_branch,
       c.main_avail
  FROM calc c
 WHERE c.avg_branch  > 0
   AND c.main_avail  > 0
   AND c.transit     = 0
   AND c.cover_days  < 25
   AND CEIL(GREATEST(0, c.target - c.avail)) > 0
   -- exclusoes, copiadas de isExcludedProduct()
   AND UPPER(c.sku) NOT IN (
    'R-SMI10', 'R-TVPAL-F', 'R2340-WW-10',
    'R2332-WW-10', 'R2360-WW-10', 'R2352-CW-10',
    'R2360-CW-10', 'R2332-WW-15', 'R1069-WH-12W-WW-60',
    'R1071-A-BK-12W-CW-60', 'R1071-A-BK-12W-WW-60', 'R1071-A-WH-12W-CW-60',
    'R1071-A-WH-12W-WW-60', 'R1071-BK-12W-WW-60', 'R1071-BK-9W-CW-60',
    'R1071-WH-12W-CW-60', 'R1071-WH-12W-WW-60', 'R1071-WH-6W-WW-60',
    'R1071-WH-9W-CW-60', 'R1071-WH-9W-WW-60', 'R1072-WH-12W-WW-60',
    'R1072-WH-9W-WW-60', 'R1073-WH-12W-CW-60', 'R1073-WH-9W-WW-60',
    'R1074-BK-12W-CW-60', 'R1075-BK-12W-WW-60', 'R1075-WH-12W-WW-24',
    'R1075-WH-12W-WW-60', 'R1075-WH-6W-CW-60', 'R1075-WH-6W-WW-60',
    'R1075-WH-9W-WW-60', 'R1076-BK-12W-WW-60', 'R1076-WH-12W-CW-60',
    'R1076-WH-12W-WW-60', 'R1076-WH-6W-WW-60', 'R1077-WH-12W-WW-24',
    'R1077-WH-12W-WW-60', 'R1077-WH-6W-WW-24', 'R1077-WH-9W-WW-60',
    'R1078-WH-12W-WW-60', 'R1078-WH-6W-WW-60', 'R1078-WH-9W-WW-24',
    'R1078-WH-9W-WW-60', 'R1079-WH-12W-CW-60', 'R1079-WH-12W-WW-60',
    'R107M-12W-CW-60', 'R107M-12W-CW-60-S', 'R107M-12W-WW-60',
    'R107M-6W-CW-60', 'R107M-9W-CW-60'
   )
   AND c.sku !~* 'carton'
   AND c.sku !~* '[-_]v1$'
   AND COALESCE(c.pname,'') !~* '(per +[0-9]+ *m\y| per *metres?| per *meters?|/ *m\y)'
 ORDER BY c.cover_days, CEIL(GREATEST(0, c.target - c.avail)) DESC;
$fn$;

REVOKE ALL ON FUNCTION public.excel_restock_suggestion(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.excel_restock_suggestion(TEXT)
  TO anon, authenticated, service_role;

SELECT 'restock suggestion v2 - tier estavel' AS status,
       (SELECT count(*) FROM public.excel_restock_suggestion('Sydney')) AS sydney_linhas;
