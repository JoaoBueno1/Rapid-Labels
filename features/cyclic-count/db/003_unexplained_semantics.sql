-- =====================================================================
-- Cyclic Count | 003 | CORRECAO: o que "explicado" quer dizer
-- ---------------------------------------------------------------------
-- O 001 definiu:
--     unexplained_qty = variance + COALESCE(explain_qty, 0)
--
-- Isso trata explain_qty como um deslocamento COM SINAL, e so fecha quando a
-- variancia e negativa. Medido num teste de ciclo completo: numa linha que
-- batia (variancia 0), lancar "achei 2 no Ghost" fazia o nao-explicado da
-- rodada SUBIR de $3.885 para $4.095. Explicar uma diferenca aumentava o
-- prejuizo aparente.
--
-- No workbook a coluna Ghost e sempre um numero positivo — `2`, `MA x 1`,
-- `BR x 4`. Ela nao e um sinal, e uma MAGNITUDE: "destas unidades que faltam
-- (ou sobram), tantas eu achei". Entao:
--
--     unexplained = sign(variancia) * max(0, |variancia| - explicado)
--
-- Sempre anda em direcao a zero, nunca inverte o sinal, e explicar demais
-- para em zero em vez de virar prejuizo do outro lado.
--
-- Seguro rodar: no momento em que foi escrito, cc_round_line e cc_round
-- estavam vazias em producao (nenhuma rodada criada ainda). Coluna GENERATED
-- nao aceita ALTER de expressao — tem que cair e voltar, e as views que
-- dependem dela caem junto.
--
-- APLICAR: colar no SQL Editor do Supabase e rodar. Rodar ANTES do 004.
-- =====================================================================

DROP VIEW IF EXISTS rapid_inv.v_cc_open;
DROP VIEW IF EXISTS rapid_inv.v_cc_round_summary;
DROP VIEW IF EXISTS rapid_inv.v_cc_sku_history;

ALTER TABLE rapid_inv.cc_round_line DROP COLUMN IF EXISTS unexplained_qty;
ALTER TABLE rapid_inv.cc_round_line DROP COLUMN IF EXISTS unexplained_value;

-- Magnitude, nunca negativa. Sem isto, "-3 explicadas" volta a ser um
-- deslocamento com sinal por outro caminho.
ALTER TABLE rapid_inv.cc_round_line DROP CONSTRAINT IF EXISTS ck_cc_line_explain_positive;
ALTER TABLE rapid_inv.cc_round_line
  ADD CONSTRAINT ck_cc_line_explain_positive CHECK (explain_qty IS NULL OR explain_qty >= 0);

ALTER TABLE rapid_inv.cc_round_line
  ADD COLUMN unexplained_qty NUMERIC GENERATED ALWAYS AS (
    sign(counted_qty - system_qty)
    * GREATEST(0, abs(counted_qty - system_qty) - COALESCE(explain_qty, 0))
  ) STORED;

ALTER TABLE rapid_inv.cc_round_line
  ADD COLUMN unexplained_value NUMERIC GENERATED ALWAYS AS (
    sign(counted_qty - system_qty)
    * GREATEST(0, abs(counted_qty - system_qty) - COALESCE(explain_qty, 0))
    * unit_cost_aud
  ) STORED;

COMMENT ON COLUMN rapid_inv.cc_round_line.explain_qty IS
  'Quantas unidades da diferenca ficaram explicadas. Sempre positivo: e magnitude, nao sinal.';
COMMENT ON COLUMN rapid_inv.cc_round_line.unexplained_qty IS
  'O que sobrou sem explicacao, no mesmo sinal da variancia. Explicar demais para em zero.';

-- ---------------------------------------------------------------------
-- As tres views, de volta, sem nenhuma outra mudanca.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_cc_round_summary AS
SELECT r.id                AS round_id,
       r.branch_code,
       w.name              AS branch_name,
       r.week_start,
       r.status,
       l.code              AS list_code,
       l.name              AS list_name,
       r.token,
       r.due_date,
       r.snapshot_at,
       r.snapshot_source,
       r.snapshot_age_min,
       r.sent_at,
       r.sent_to,
       r.submitted_at,
       r.submitted_by,
       r.closed_at,
       count(li.id)                                                        AS lines_total,
       count(li.counted_qty)                                               AS lines_counted,
       count(*) FILTER (WHERE li.counted_qty IS NOT NULL
                          AND li.variance_qty <> 0)                        AS lines_variance,
       count(*) FILTER (WHERE li.id IS NOT NULL
                          AND li.unit_cost_aud IS NULL)                    AS lines_no_cost,
       COALESCE(sum(li.variance_qty),        0)                            AS variance_qty,
       COALESCE(sum(li.variance_value),      0)                            AS variance_value,
       COALESCE(sum(li.unexplained_qty),     0)                            AS unexplained_qty,
       COALESCE(sum(li.unexplained_value),   0)                            AS unexplained_value,
       COALESCE(sum(abs(li.variance_value)), 0)                            AS variance_abs_value
  FROM rapid_inv.cc_round r
  JOIN rapid_inv.cc_list  l ON l.id = r.list_id
  LEFT JOIN rapid_inv.warehouses    w  ON w.code    = r.branch_code
  LEFT JOIN rapid_inv.cc_round_line li ON li.round_id = r.id
 GROUP BY r.id, w.name, l.code, l.name;

CREATE OR REPLACE VIEW rapid_inv.v_cc_sku_history AS
SELECT r.branch_code,
       w.name           AS branch_name,
       r.week_start,
       l.code           AS list_code,
       li.sku,
       li.sku_code,
       li.product_name,
       li.system_qty,
       li.counted_qty,
       li.variance_qty,
       li.variance_value,
       li.explain_qty,
       li.explain_location,
       li.explain_ref,
       li.action,
       li.unexplained_qty,
       li.unexplained_value,
       r.status,
       r.snapshot_at
  FROM rapid_inv.cc_round_line li
  JOIN rapid_inv.cc_round      r ON r.id = li.round_id
  JOIN rapid_inv.cc_list       l ON l.id = r.list_id
  LEFT JOIN rapid_inv.warehouses w ON w.code = r.branch_code
 WHERE r.status IN ('submitted','review','closed');

CREATE OR REPLACE VIEW rapid_inv.v_cc_open AS
SELECT s.*,
       (now() AT TIME ZONE 'Australia/Brisbane')::date AS today_bne,
       CASE
         WHEN s.status IN ('closed','cancelled') THEN false
         WHEN s.due_date IS NULL                 THEN false
         ELSE s.due_date < (now() AT TIME ZONE 'Australia/Brisbane')::date
       END AS is_overdue,
       CASE
         WHEN s.status IN ('draft','dispatching')      THEN 'nos'
         WHEN s.status = 'sent'                        THEN 'filial'
         WHEN s.status IN ('submitted','review')       THEN 'nos'
         ELSE 'ninguem'
       END AS waiting_on
  FROM rapid_inv.v_cc_round_summary s
 WHERE s.status NOT IN ('closed','cancelled');

REVOKE ALL ON rapid_inv.v_cc_round_summary FROM anon, authenticated;
REVOKE ALL ON rapid_inv.v_cc_open          FROM anon, authenticated;

DO $$ BEGIN RAISE NOTICE '003: unexplained corrigido (magnitude, nao sinal)'; END $$;
