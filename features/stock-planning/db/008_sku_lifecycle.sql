-- =====================================================================
-- Stock Planning · 008 · CICLO DE VIDA DO SKU
-- ---------------------------------------------------------------------
-- O problema, medido: 359 dos 1.951 SKUs de planejamento (18,4%) carregam
-- algum sinal de fim de vida e seguram A$326.371. Desses, 109 têm Wk/Avg
-- maior que zero — 2.035 unidades por semana de venda projetada que não vai
-- acontecer, e 8.606 unidades que a grade hoje apresenta como necessidade
-- de compra de produto que a empresa já decidiu parar de vender.
--
-- O caso -V1 sozinho responde pela maior parte: 132 SKUs -V1 que têm a base
-- sem sufixo TAMBÉM no planejamento, 71 deles com Wk/Avg nos dois lados.
-- É a mesma demanda contada duas vezes na mesma família.
--
-- ── Por que o Cin7 não resolve sozinho ────────────────────────────────
-- products.status tem Active 8.508 e Deprecated 2.743, e NENHUM dos 2.743
-- tem uma única unidade em estoque. O Cin7 só marca Deprecated depois que o
-- estoque zera: é confirmação póstuma, não detector. Dos 272 SKUs que a
-- própria empresa marcou como descontinuados, apenas 10 estão Deprecated lá
-- — 3,7%. Esperar o Cin7 é esperar o dinheiro já ter sido gasto.
--
-- O valor do Cin7 está na DISCORDÂNCIA, não na concordância: 46 SKUs ele
-- sabe que estão mortos e a planilha não.
-- =====================================================================

ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle_status IN ('ACTIVE','RUN_OUT','DISCONTINUED')),
  ADD COLUMN IF NOT EXISTS superseded_by      TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by_key  TEXT GENERATED ALWAYS AS (upper(btrim(superseded_by))) STORED,
  ADD COLUMN IF NOT EXISTS lifecycle_note     TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_source   TEXT CHECK (lifecycle_source IN ('MANUAL','CIN7','EXCEL_IMPORT','RULE')),
  ADD COLUMN IF NOT EXISTS lifecycle_set_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lifecycle_set_by   TEXT,
  ADD COLUMN IF NOT EXISTS cin7_status        TEXT,   -- espelho cru; humano nunca escreve aqui
  ADD COLUMN IF NOT EXISTS cin7_status_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_sp_lifecycle  ON rapid_inv.sku_settings (lifecycle_status) WHERE is_planned;
CREATE INDEX IF NOT EXISTS ix_sp_superseded ON rapid_inv.sku_settings (superseded_by_key);

COMMENT ON COLUMN rapid_inv.sku_settings.lifecycle_status IS
  'ACTIVE compra normal · RUN_OUT ainda vende o que sobrou mas não se compra mais · DISCONTINUED morto';

-- ---------------------------------------------------------------------
-- ESPELHO DO STATUS DO CIN7
-- Uma via. Escreve sempre, decide quase nunca.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_cin7_status AS
SELECT DISTINCT ON (upper(btrim(p.sku)))
       upper(btrim(p.sku)) AS sku_key, p.status, p.synced_at
  FROM cin7_mirror.products p
 ORDER BY upper(btrim(p.sku)), p.synced_at DESC NULLS LAST;

/**
 * Aplica o status do Cin7. Aditivo e conservador:
 * só marca DISCONTINUED quando o Cin7 diz Deprecated, ninguém decidiu nada
 * ainda, e o estoque já é zero. Hoje isso cobre exatamente 56 SKUs, todos
 * com A$0 — risco zero. Decisão humana nunca é sobrescrita.
 */
CREATE OR REPLACE FUNCTION rapid_inv.sp_sync_cin7_lifecycle()
RETURNS TABLE (mirrored INT, auto_discontinued INT) LANGUAGE plpgsql AS $$
DECLARE m INT; d INT;
BEGIN
  UPDATE rapid_inv.sku_settings s
     SET cin7_status = c.status, cin7_status_at = c.synced_at
    FROM rapid_inv.v_sp_cin7_status c
   WHERE c.sku_key = s.sku_key
     AND (s.cin7_status IS DISTINCT FROM c.status);
  GET DIAGNOSTICS m = ROW_COUNT;

  -- Subconsulta em vez de JOIN: SKU descontinuado costuma não ter NENHUMA
  -- linha de estoque, e um JOIN o excluiria justamente por estar zerado.
  UPDATE rapid_inv.sku_settings s
     SET lifecycle_status = 'DISCONTINUED', lifecycle_source = 'CIN7',
         lifecycle_set_at = now(), lifecycle_set_by = 'cin7-sync',
         lifecycle_note = COALESCE(s.lifecycle_note, 'Deprecated in Cin7 with no stock left')
   WHERE s.cin7_status = 'Deprecated'
     AND s.lifecycle_status = 'ACTIVE'
     AND s.lifecycle_source IS NULL
     AND COALESCE((SELECT soh.available FROM rapid_inv.v_sp_soh soh WHERE soh.sku = s.sku_key), 0) <= 0;
  GET DIAGNOSTICS d = ROW_COUNT;

  RETURN QUERY SELECT m, d;
END $$;

-- ---------------------------------------------------------------------
-- A LISTA DE PLANEJAMENTO, CIENTE DO CICLO DE VIDA
--
-- RUN_OUT      → mantém a venda (ele vende mesmo) e zera o alvo de cobertura.
--                Nunca mais pede compra.
-- DISCONTINUED → venda tratada como zero. O saldo para de decair e a grade
--                passa a dizer "é isto que sobrou e não anda" em vez de
--                "acaba na semana N, compre".
--
-- Os dois somem da necessidade de compra e CONTINUAM no valor de estoque.
-- Os A$326.371 são o ponto: precisam ficar visíveis como dinheiro parado,
-- não escondidos. Por isso NUNCA usar is_planned=false para aposentar SKU —
-- isso apagaria a linha de todas as views e destruiria o rastro.
-- ---------------------------------------------------------------------
-- Ordem das colunas preservada de propósito: CREATE OR REPLACE VIEW só
-- permite ACRESCENTAR colunas no fim, e dropar esta view derrubaria em
-- cascata as seis views do Overview que dependem dela.
CREATE OR REPLACE VIEW rapid_inv.v_sp_planning_skus AS
SELECT
  s.sku,
  s.sku_key,
  s.supplier_code,
  s.legacy_code,
  -- Wk/Avg EFETIVO: descontinuado não vende mais. O digitado continua
  -- disponível em wk_avg_input, para a tela mostrar o que o humano pôs lá.
  CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 0 ELSE s.wk_avg END AS wk_avg,
  s.wk_avg_source,
  (CASE WHEN s.lifecycle_status = 'DISCONTINUED' THEN 0 ELSE s.wk_avg END * 52 / 12) AS mth_avg,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN s.target_cover_weeks ELSE 0 END AS target_cover_weeks,
  CASE WHEN s.lifecycle_status = 'ACTIVE' THEN s.wk_avg * s.target_cover_weeks ELSE 0 END AS target_qty,
  s.comments,
  s.threshold_red,
  s.threshold_yel,
  COALESCE(soh.available, 0)                               AS soh_available,
  COALESCE(soh.qty_on_hand, 0)                             AS soh_on_hand,
  COALESCE(soh.on_order, 0)                                AS soh_on_order,
  COALESCE(cm.available, 0)                                AS project_orders,
  COALESCE(un.qty, 0)                                      AS undated_qty,
  COALESCE(br_main.available, 0)                           AS main_soh,
  COALESCE(br_gw.available, 0)                             AS gateway_soh,
  (COALESCE(soh.available,0) <= 0)                         AS soh_nonpositive,
  CASE WHEN s.lifecycle_status <> 'DISCONTINUED' AND COALESCE(s.wk_avg,0) > 0
       THEN (COALESCE(soh.available,0) + COALESCE(cm.available,0)) / (s.wk_avg * 52 / 12)
  END                                                      AS mths_stock,
  CASE WHEN COALESCE(soh.available,0) > 0 AND COALESCE(s.wk_avg,0) > 0
       THEN (COALESCE(soh.available,0) + COALESCE(cm.available,0)) / (s.wk_avg * 52 / 12)
  END                                                      AS mths_stock_excel,
  -- colunas novas, acrescentadas no fim
  s.lifecycle_status,
  s.superseded_by,
  s.superseded_by_key,
  s.lifecycle_note,
  s.cin7_status,
  s.wk_avg                                                 AS wk_avg_input,
  s.lifecycle_source
FROM rapid_inv.sku_settings s
LEFT JOIN rapid_inv.v_sp_soh        soh ON soh.sku = s.sku_key
LEFT JOIN rapid_inv.v_sp_commitment cm  ON cm.sku  = s.sku_key
LEFT JOIN rapid_inv.v_sp_undated_demand un ON un.sku = s.sku_key
LEFT JOIN rapid_inv.v_sp_branch br_main ON br_main.sku = s.sku_key AND br_main.branch_code = 'MAIN'
LEFT JOIN rapid_inv.v_sp_branch br_gw   ON br_gw.sku   = s.sku_key AND br_gw.branch_code   = 'GATEWAY'
WHERE s.is_planned;

-- v_sp_sku_value precisa enxergar o ciclo de vida para o painel de estoque morto.
CREATE OR REPLACE VIEW rapid_inv.v_sp_sku_value AS
SELECT v.sku, v.sku_key, v.supplier_code, v.wk_avg, v.mths_stock, v.soh_available,
       v.target_qty, v.target_cover_weeks, v.soh_nonpositive,
       COALESCE(c.unit_cost_aud, 0)                                              AS unit_cost_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(v.soh_available, 0)               AS stock_value_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(v.soh_available - COALESCE(v.target_qty, 0), 0) AS excess_value_aud,
       COALESCE(c.unit_cost_aud, 0) * GREATEST(COALESCE(v.target_qty, 0) - v.soh_available, 0) AS gap_value_aud,
       v.lifecycle_status, v.superseded_by, v.lifecycle_note, v.cin7_status, v.wk_avg_input
  FROM rapid_inv.v_sp_planning_skus v
  LEFT JOIN rapid_inv.v_sp_sku_cost c ON c.sku_key = v.sku_key;

-- ---------------------------------------------------------------------
-- DINHEIRO PARADO EM PRODUTO QUE NÃO SE COMPRA MAIS
-- Substitui o placar semanal do Discontinued Items.xlsx, cujo total está
-- literalmente #N/A hoje por um VLOOKUP quebrado — e que deixava 158 SKUs
-- numa lista-sombra sem custo, sem valor e sem ninguém olhando.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_dead_stock AS
SELECT v.sku, v.sku_key, v.supplier_code, v.lifecycle_status, v.superseded_by,
       v.lifecycle_note, v.cin7_status,
       v.soh_available, v.unit_cost_aud,
       round(v.stock_value_aud::NUMERIC, 2) AS stock_value_aud,
       v.wk_avg_input, ss.lifecycle_source, ss.lifecycle_set_at, ss.lifecycle_set_by
  FROM rapid_inv.v_sp_sku_value v
  JOIN rapid_inv.sku_settings ss ON ss.sku_key = v.sku_key
 WHERE v.lifecycle_status <> 'ACTIVE';

CREATE OR REPLACE VIEW rapid_inv.v_sp_dead_stock_totals AS
SELECT lifecycle_status,
       count(*)::INT                                    AS skus,
       count(*) FILTER (WHERE soh_available > 0)::INT    AS with_stock,
       sum(soh_available)                               AS units,
       round(sum(stock_value_aud)::NUMERIC, 0)          AS value_aud,
       count(*) FILTER (WHERE wk_avg_input > 0)::INT     AS still_forecast
  FROM rapid_inv.v_sp_dead_stock
 GROUP BY 1;

-- ---------------------------------------------------------------------
-- ONDE O CIN7 E A EMPRESA DISCORDAM — a parte útil do Cin7.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_lifecycle_conflicts AS
SELECT s.sku, s.supplier_code, s.lifecycle_status, s.cin7_status,
       COALESCE(soh.available, 0) AS soh_available,
       CASE
         WHEN s.cin7_status = 'Deprecated' AND s.lifecycle_status = 'ACTIVE'
           THEN 'Cin7 says deprecated, we still plan it'
         WHEN s.lifecycle_status = 'DISCONTINUED' AND s.cin7_status = 'Active' AND a.actual_wk > 0
           THEN 'We call it dead, it is still selling'
       END AS conflict,
       round(COALESCE(a.actual_wk, 0)::NUMERIC, 2) AS actual_wk
  FROM rapid_inv.sku_settings s
  LEFT JOIN rapid_inv.v_sp_soh soh        ON soh.sku = s.sku_key
  LEFT JOIN rapid_inv.v_sp_actual_weekly a ON a.sku_key = s.sku_key
 WHERE s.is_planned
   AND ((s.cin7_status = 'Deprecated' AND s.lifecycle_status = 'ACTIVE')
     OR (s.lifecycle_status = 'DISCONTINUED' AND s.cin7_status = 'Active' AND a.actual_wk > 0));

DO $$ BEGIN RAISE NOTICE '008: ciclo de vida do SKU pronto'; END $$;
