-- =====================================================================
-- Stock Planning · 009 · LEAD TIME MEDIDO E PARÂMETROS DE COMPRA
-- ---------------------------------------------------------------------
-- O lead time do fornecedor não existia nem como campo, apesar de o dado
-- bruto estar inteiro na aba PO's: data de emissão, Finish Date de produção
-- pronta, Date Checked de QC e Due Date de ETA, em 258 POs.
--
-- Enquanto ele não existe, "safety stock estatístico" é casa decimal em cima
-- de um chute, e a pergunta que o comprador realmente faz — "quando eu tinha
-- que ter comprado isto?" — não tem resposta.
--
-- Três trechos, porque o negócio tem três e eles falham por motivos
-- diferentes: produção atrasa por fábrica, travessia atrasa por navio.
-- =====================================================================

CREATE OR REPLACE VIEW rapid_inv.v_sp_po_leg AS
SELECT po.id, po.po_number, po.supplier_code, po.sku_key, po.qty,
       po.po_date, po.finish_date, po.date_checked, po.due_date, po.vessel,
       (po.finish_date - po.po_date)  AS days_to_ready,   -- emissão → produção pronta
       (po.due_date - po.finish_date) AS days_at_sea,     -- pronta → chegada
       (po.due_date - po.po_date)     AS days_total       -- o lead time que interessa
  FROM rapid_inv.po_lines po
 WHERE po.po_date IS NOT NULL;

/**
 * Por fornecedor. A MEDIANA, não a média: uma PO represada de seis meses
 * puxaria a média e faria todo o resto parecer lento.
 * O desvio importa tanto quanto o centro — fornecedor previsível de 14
 * semanas é melhor que um de 10 que às vezes leva 20.
 */
CREATE OR REPLACE VIEW rapid_inv.v_sp_supplier_leadtime AS
SELECT supplier_code,
       count(*)::INT                                                   AS po_lines,
       count(DISTINCT po_number)::INT                                  AS pos,
       count(*) FILTER (WHERE days_total IS NOT NULL)::INT              AS measured,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_total)::NUMERIC, 0)      AS median_days,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_total)::NUMERIC / 7, 1)  AS median_weeks,
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY days_total)::NUMERIC / 7, 1)  AS p90_weeks,
       round(stddev_samp(days_total)::NUMERIC / 7, 1)                                  AS sd_weeks,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_to_ready)::NUMERIC / 7, 1) AS ready_weeks,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_at_sea)::NUMERIC / 7, 1)   AS sea_weeks,
       min(po_date)                                                    AS first_po,
       max(po_date)                                                    AS last_po
  FROM rapid_inv.v_sp_po_leg
 WHERE supplier_code IS NOT NULL
 GROUP BY 1;

-- ---------------------------------------------------------------------
-- PARÂMETROS DE COMPRA
-- MOQ não existia; múltiplo de caixa existe no Cin7 e nunca foi usado em
-- sugestão nenhuma. Sem os dois, o comprador corrige a sugestão à mão — e no
-- dia em que ele corrige à mão, a ferramenta perdeu a autoridade.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.suppliers
  ADD COLUMN IF NOT EXISTS review_weeks INT NOT NULL DEFAULT 1,   -- de quanto em quanto tempo se compra
  ADD COLUMN IF NOT EXISTS moq_units    NUMERIC,
  ADD COLUMN IF NOT EXISTS moq_value_usd NUMERIC;

ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS moq_units      NUMERIC,
  ADD COLUMN IF NOT EXISTS carton_qty     NUMERIC,   -- espelho do Cin7, para não depender dele em tempo real
  ADD COLUMN IF NOT EXISTS lead_weeks_override NUMERIC;

/** Espelha a cartonagem do Cin7 uma vez, para a sugestão não fazer join vivo. */
CREATE OR REPLACE FUNCTION rapid_inv.sp_sync_carton_qty()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  UPDATE rapid_inv.sku_settings s
     SET carton_qty = p.carton_quantity
    FROM (SELECT DISTINCT ON (upper(btrim(sku))) upper(btrim(sku)) AS k, carton_quantity
            FROM cin7_mirror.products WHERE carton_quantity > 0
           ORDER BY upper(btrim(sku)), synced_at DESC NULLS LAST) p
   WHERE p.k = s.sku_key AND s.carton_qty IS DISTINCT FROM p.carton_quantity;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

/**
 * O lead time efetivo de um SKU, e de onde ele veio. Ordem de precedência:
 * override manual > medido do histórico do fornecedor > o default antigo.
 * A coluna `source` existe para a tela poder dizer "12 semanas porque é o
 * default, ninguém mediu" em vez de fingir precisão.
 */
CREATE OR REPLACE VIEW rapid_inv.v_sp_sku_leadtime AS
SELECT s.sku_key, s.sku, s.supplier_code,
       COALESCE(s.lead_weeks_override, lt.median_weeks, sup.lead_time_weeks, 12)::NUMERIC AS lead_weeks,
       CASE WHEN s.lead_weeks_override IS NOT NULL THEN 'MANUAL'
            WHEN lt.median_weeks IS NOT NULL       THEN 'MEASURED'
            WHEN sup.lead_time_weeks IS NOT NULL   THEN 'SUPPLIER_DEFAULT'
            ELSE 'FALLBACK' END                                       AS lead_source,
       lt.sd_weeks, lt.p90_weeks, lt.measured AS measured_pos,
       COALESCE(sup.review_weeks, 1)                                  AS review_weeks,
       COALESCE(s.moq_units, sup.moq_units)                           AS moq_units,
       s.carton_qty
  FROM rapid_inv.sku_settings s
  LEFT JOIN rapid_inv.suppliers sup ON sup.code = s.supplier_code
  LEFT JOIN rapid_inv.v_sp_supplier_leadtime lt ON lt.supplier_code = s.supplier_code
 WHERE s.is_planned;

DO $$ BEGIN RAISE NOTICE '009: lead time medido e parâmetros de compra prontos'; END $$;
