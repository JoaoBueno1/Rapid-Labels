-- =====================================================================
-- Stock Planning · 002 · PARÂMETROS DE PLANEJAMENTO
-- ---------------------------------------------------------------------
-- Tudo que no Excel vivia dentro de fórmula, de header hard-coded, ou
-- copiado 22 vezes, vira dado com nome e histórico.
--
-- NOTA DE NOMENCLATURA: rapid_inv.week_calendar.week_start guarda domingos.
-- No Excel esses mesmos domingos são a linha "Week Ended Date". É a mesma
-- série. Nas views e na API deste módulo o campo se chama week_ending,
-- que é como o time lê. Ver v_sp_weeks em 003.
-- =====================================================================

-- ---------------------------------------------------------------------
-- CURVA SAZONAL — uma, global, por semana.
-- No Excel são 26 fatores repetidos identicamente nas 22 abas (Ano Novo
-- Chinês, dois ciclos). Semana sem linha aqui = fator 1.
-- O fator multiplica APENAS venda normal. Draw de projeto e chegada de PO
-- não são sazonalizados — e isso está certo.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.seasonal_factors (
  week_ending  DATE PRIMARY KEY,
  factor       NUMERIC(6,4) NOT NULL DEFAULT 1 CHECK (factor >= 0 AND factor <= 5),
  reason       TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

INSERT INTO rapid_inv.seasonal_factors (week_ending, factor, reason) VALUES
  ('2025-12-07',0.80,'Chinese New Year ramp-down'),
  ('2025-12-14',0.73,'Chinese New Year ramp-down'),
  ('2025-12-21',0.54,'Chinese New Year ramp-down'),
  ('2025-12-28',0.12,'Chinese New Year ramp-down'),
  ('2026-01-04',0.00,'Chinese New Year blackout'),
  ('2026-01-11',0.60,'Chinese New Year ramp-up'),
  ('2026-01-18',0.75,'Chinese New Year ramp-up'),
  ('2026-01-25',0.77,'Chinese New Year ramp-up'),
  ('2026-02-01',0.66,'Chinese New Year ramp-up'),
  ('2026-02-08',0.80,'Chinese New Year ramp-up'),
  ('2026-02-15',0.80,'Chinese New Year ramp-up'),
  ('2026-02-22',0.80,'Chinese New Year ramp-up'),
  ('2026-03-01',0.80,'Chinese New Year ramp-up'),
  ('2026-12-06',0.80,'Chinese New Year ramp-down'),
  ('2026-12-13',0.73,'Chinese New Year ramp-down'),
  ('2026-12-20',0.25,'Chinese New Year ramp-down'),
  ('2026-12-27',0.00,'Chinese New Year blackout'),
  ('2027-01-03',0.15,'Chinese New Year ramp-up'),
  ('2027-01-10',0.50,'Chinese New Year ramp-up'),
  ('2027-01-17',0.75,'Chinese New Year ramp-up'),
  ('2027-01-24',0.70,'Chinese New Year ramp-up'),
  ('2027-01-31',0.75,'Chinese New Year ramp-up'),
  ('2027-02-07',0.80,'Chinese New Year ramp-up'),
  ('2027-02-14',0.80,'Chinese New Year ramp-up'),
  ('2027-02-21',0.80,'Chinese New Year ramp-up'),
  ('2027-02-28',0.80,'Chinese New Year ramp-up')
ON CONFLICT (week_ending) DO NOTHING;

-- ---------------------------------------------------------------------
-- ESTADO DO PLANEJAMENTO — a semana de reporte.
-- No Excel isso é o "1" da linha 5 que alguém move à mão em 22 abas toda
-- semana. Aqui é uma linha, com registro de quem rolou e quando.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.planning_state (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  reporting_week  DATE NOT NULL,
  horizon_weeks   INT  NOT NULL DEFAULT 26 CHECK (horizon_weeks BETWEEN 4 AND 156),
  soh_source      TEXT NOT NULL DEFAULT 'SNAPSHOT' CHECK (soh_source IN ('SNAPSHOT','CIN7_LIVE')),
  rolled_at       TIMESTAMPTZ,
  rolled_by       TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO rapid_inv.planning_state (id, reporting_week) VALUES (1, '2026-08-23')
ON CONFLICT (id) DO NOTHING;

-- Histórico de rolagem — para saber o que o modelo enxergava em cada semana.
CREATE TABLE IF NOT EXISTS rapid_inv.planning_roll_log (
  id             BIGSERIAL PRIMARY KEY,
  from_week      DATE,
  to_week        DATE NOT NULL,
  rolled_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_by      TEXT,
  notes          TEXT
);

-- ---------------------------------------------------------------------
-- CÂMBIO — no Excel conviviam /0.65 e /0.68 na mesma coluna.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.fx_rates (
  effective_from DATE PRIMARY KEY,
  aud_per_usd    NUMERIC(9,5) NOT NULL CHECK (aud_per_usd > 0),
  note           TEXT
);
INSERT INTO rapid_inv.fx_rates (effective_from, aud_per_usd, note) VALUES
  ('2000-01-01', 0.65, 'Taxa histórica usada na maior parte da aba PO''s'),
  ('2026-07-01', 0.68, 'Taxa mais recente encontrada nas fórmulas da aba PO''s')
ON CONFLICT (effective_from) DO NOTHING;

-- ---------------------------------------------------------------------
-- ALIASES DE FORNECEDOR — a aba PO's tem 26 grafias para ~22 fornecedores.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.supplier_aliases (
  alias         TEXT PRIMARY KEY,          -- sempre gravado em UPPER(BTRIM())
  supplier_code TEXT NOT NULL,
  note          TEXT
);

-- Fornecedores que aparecem em PO's mas não têm aba própria no workbook.
INSERT INTO rapid_inv.suppliers (code, name, notes) VALUES
  ('AQUA','Aqua','Aparece em PO''s; sem aba de planejamento no workbook'),
  ('ENRICH','Enrich','Aparece em PO''s; sem aba de planejamento no workbook'),
  ('VISION','Vision','Aparece em PO''s; sem aba de planejamento no workbook'),
  ('HENGJIAN','Hengjian','Aparece em PO''s; sem aba de planejamento no workbook')
ON CONFLICT (code) DO NOTHING;

INSERT INTO rapid_inv.supplier_aliases (alias, supplier_code, note) VALUES
  ('X TRACK','XTRACK','grafia da aba PO''s'),
  ('XTRACK','XTRACK',NULL),
  ('E-LITE','ELITE','nome da aba'),
  ('ELITE','ELITE',NULL),
  ('EPOWER','EPOWER',NULL),
  ('FOSHAN KL','FOSHAN','sub-fábrica tratada como Foshan'),
  ('FOSHAN','FOSHAN',NULL),
  ('AOK','AOK',NULL),
  ('LEDLUZ','LEDLUZ',NULL),
  ('CGD','CGD',NULL),      ('AEON','AEON',NULL),
  ('AGC','AGC',NULL),      ('RELIGHT','RELIGHT',NULL),
  ('UPSHINE','UPSHINE',NULL), ('SENSELITE','SENSELITE',NULL),
  ('SEALITE','SEALITE',NULL), ('CNEPSO','CNEPSO',NULL),
  ('KINGLUMI','KINGLUMI',NULL),('STARLUX','STARLUX',NULL),
  ('GENERAL','GENERAL',NULL), ('OTTIMA','OTTIMA',NULL),
  ('COWIN','COWIN',NULL),  ('DOLIGHT','DOLIGHT',NULL),
  ('HUIBO','HUIBO',NULL),  ('MIXED','MIXED',NULL),
  ('AQUA','AQUA',NULL),    ('ENRICH','ENRICH',NULL),
  ('VISION','VISION',NULL),('HENGJIAN','HENGJIAN',NULL)
ON CONFLICT (alias) DO NOTHING;

-- ---------------------------------------------------------------------
-- VERSÃO DE SKU — a aba Sheet1: -V1/-V2/-V3 → código canônico.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.sku_versions (
  version_code TEXT PRIMARY KEY,
  current_sku  TEXT NOT NULL,
  resolved     BOOLEAN NOT NULL DEFAULT false,  -- bate no catálogo mestre?
  note         TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sp_skuver_current ON rapid_inv.sku_versions (current_sku);

-- ---------------------------------------------------------------------
-- PARÂMETROS POR SKU — estende sku_settings, não substitui.
--   wk_avg             : MANUAL, como no Excel. 837 blocos conferidos, zero fórmulas.
--   target_cover_weeks : no Excel era o N de "=Wk/Avg × N". Varia 4/6/7/8/10 por SKU.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS wk_avg             NUMERIC,
  ADD COLUMN IF NOT EXISTS wk_avg_source      TEXT NOT NULL DEFAULT 'MANUAL'
                                              CHECK (wk_avg_source IN ('MANUAL','EXCEL_IMPORT','COMPUTED')),
  ADD COLUMN IF NOT EXISTS target_cover_weeks INT DEFAULT 7 CHECK (target_cover_weeks BETWEEN 0 AND 104),
  ADD COLUMN IF NOT EXISTS supplier_code      TEXT,
  ADD COLUMN IF NOT EXISTS legacy_code        TEXT,   -- coluna C do bloco de fornecedor
  ADD COLUMN IF NOT EXISTS is_planned         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unit_cost_usd      NUMERIC;

CREATE INDEX IF NOT EXISTS ix_sp_settings_supplier ON rapid_inv.sku_settings (supplier_code)
  WHERE is_planned;

-- O Excel dispara recompra abaixo de 1 mês de cobertura. Os defaults 2.5/4 que
-- estavam aqui não são a regra do negócio.
ALTER TABLE rapid_inv.sku_settings ALTER COLUMN threshold_red SET DEFAULT 1;
ALTER TABLE rapid_inv.sku_settings ALTER COLUMN threshold_yel SET DEFAULT 3;

-- ---------------------------------------------------------------------
-- LINHAS DE PO — ganha o que vivia dentro da fórmula.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.po_lines
  ADD COLUMN IF NOT EXISTS unit_cost_usd NUMERIC,   -- os 539 custos cravados em fórmula
  ADD COLUMN IF NOT EXISTS fx_used       NUMERIC,   -- o divisor real daquela linha
  ADD COLUMN IF NOT EXISTS vessel        TEXT,      -- coluna "Require": gancho do TMS
  ADD COLUMN IF NOT EXISTS shipment_id   BIGINT,    -- reservado p/ container/vessel
  ADD COLUMN IF NOT EXISTS cin7_po_id    TEXT,      -- reservado p/ fase Cin7
  ADD COLUMN IF NOT EXISTS line_no       INT,
  ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'MANUAL';

CREATE INDEX IF NOT EXISTS ix_sp_po_vessel ON rapid_inv.po_lines (vessel) WHERE vessel IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sp_po_line ON rapid_inv.po_lines (po_number, line_no)
  WHERE line_no IS NOT NULL;

-- ---------------------------------------------------------------------
-- ESTOQUE POR FILIAL — as abas DALTON e GATEWAY.
-- ATENÇÃO: no workbook a aba "DALTON" tem cabeçalho "Main Warehouse".
-- O nome da aba engana. Aqui o código é MAIN.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.branch_soh (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  branch_code   TEXT NOT NULL,
  sku           TEXT NOT NULL,
  qty_on_hand   NUMERIC NOT NULL DEFAULT 0,
  allocated     NUMERIC NOT NULL DEFAULT 0,
  on_order      NUMERIC NOT NULL DEFAULT 0,
  available     NUMERIC GENERATED ALWAYS AS (COALESCE(qty_on_hand,0) - COALESCE(allocated,0)) STORED,
  source        TEXT NOT NULL DEFAULT 'EXCEL_IMPORT',
  UNIQUE (snapshot_date, branch_code, sku)
);
CREATE INDEX IF NOT EXISTS ix_sp_branch_soh ON rapid_inv.branch_soh (sku, snapshot_date DESC);

INSERT INTO rapid_inv.warehouses (code, name) VALUES
  ('MAIN','Main Warehouse (aba DALTON do workbook)'),
  ('GATEWAY','Gateway'),
  ('PROJECTS','Locais de projeto (aba Projects do workbook)')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- COMPROMISSO DE PROJETO POR SKU — a aba "Projects" do workbook.
-- É o Analysis!E: quase sempre NEGATIVO (662 de 854 SKUs).
-- Por isso a cobertura SOMA em vez de subtrair.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.project_commitment (
  snapshot_date DATE NOT NULL,
  sku           TEXT NOT NULL,
  qty_on_hand   NUMERIC NOT NULL DEFAULT 0,
  allocated     NUMERIC NOT NULL DEFAULT 0,
  on_order      NUMERIC NOT NULL DEFAULT 0,
  available     NUMERIC GENERATED ALWAYS AS (COALESCE(qty_on_hand,0) - COALESCE(allocated,0)) STORED,
  source        TEXT NOT NULL DEFAULT 'EXCEL_IMPORT',
  PRIMARY KEY (snapshot_date, sku)
);

-- ---------------------------------------------------------------------
-- SOH da empresa — a aba SOH. soh_snapshot já existe; só ganha origem.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.soh_snapshot
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'EXCEL_IMPORT';

-- ---------------------------------------------------------------------
-- LOTES DE IMPORTAÇÃO — para poder reverter e para saber de onde veio o dado.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.import_batches (
  id           BIGSERIAL PRIMARY KEY,
  source_file  TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- PROJECTS | POS | SOH | SETTINGS | VERSIONS
  rows_in      INT,
  rows_written INT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  detail       JSONB,
  run_by       TEXT
);

DROP TRIGGER IF EXISTS tg_sp_settings_audit ON rapid_inv.sku_settings;
CREATE TRIGGER tg_sp_settings_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.sku_settings
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS tg_sp_seasonal_audit ON rapid_inv.seasonal_factors;
CREATE TRIGGER tg_sp_seasonal_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.seasonal_factors
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DO $$ BEGIN RAISE NOTICE '002_planning: parâmetros, sazonalidade, FX, aliases e filiais prontos'; END $$;

-- ---------------------------------------------------------------------
-- CHAVE DE SKU INSENSÍVEL A CAIXA
--
-- A aba PO's grava "12V-IP20-012W" e as demais abas "12v-IP20-012w".
-- O SUMIFS do Excel ignora caixa e casa; um "=" de SQL não casaria, e a
-- entrada de estoque simplesmente sumiria (312 unidades num único SKU da
-- primeira amostra de paridade).
--
-- sku_key é só para JOIN. A coluna sku continua guardando exatamente o que
-- foi digitado, e é ela que aparece na tela.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.project_lines      ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.po_lines           ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.soh_snapshot       ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.branch_soh         ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.project_commitment ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.sku_settings       ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.weekly_sales       ADD COLUMN IF NOT EXISTS sku_key TEXT GENERATED ALWAYS AS (upper(btrim(sku))) STORED;
ALTER TABLE rapid_inv.sku_versions       ADD COLUMN IF NOT EXISTS current_sku_key TEXT GENERATED ALWAYS AS (upper(btrim(current_sku))) STORED;

CREATE INDEX IF NOT EXISTS ix_sp_lines_skukey  ON rapid_inv.project_lines (sku_key);
CREATE INDEX IF NOT EXISTS ix_sp_po_skukey     ON rapid_inv.po_lines (sku_key);
CREATE INDEX IF NOT EXISTS ix_sp_soh_skukey    ON rapid_inv.soh_snapshot (sku_key) WHERE is_current;
CREATE INDEX IF NOT EXISTS ix_sp_branch_skukey ON rapid_inv.branch_soh (sku_key);
CREATE INDEX IF NOT EXISTS ix_sp_commit_skukey ON rapid_inv.project_commitment (sku_key);
-- Dois SKUs do workbook diferem apenas em caixa ("R2121-Trim-BK" × "R2121-TRIM-BK",
-- "R-TVPAL-F-v2" × "R-TVPAL-F-V2"), com os mesmos parâmetros. Fica a linha que o
-- Analysis curou (is_planned), que é a que o time enxerga.
DELETE FROM rapid_inv.sku_settings a
 USING rapid_inv.sku_settings b
 WHERE upper(btrim(a.sku)) = upper(btrim(b.sku))
   AND a.sku <> b.sku
   AND (a.is_planned, a.sku) < (b.is_planned, b.sku);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sp_settings_skukey ON rapid_inv.sku_settings (sku_key);
