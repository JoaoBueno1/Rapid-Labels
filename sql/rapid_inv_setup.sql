-- =================================================================
--  RAPID INVENTORY SKU — SETUP COMPLETO (copy + paste, rode uma vez)
-- -----------------------------------------------------------------
--  Cria TUDO no schema "rapid_inv" — totalmente isolado.
--  Não toca em nenhuma tabela existente do projeto Labels.
--  Idempotente: pode rodar de novo sem quebrar.
-- =================================================================

-- 0. SCHEMA
-- -----------------------------------------------------------------
-- Se você já tentou rodar antes (e o script parou no meio com erro),
-- descomente a linha abaixo para começar do zero. CUIDADO: apaga dados.
-- DROP SCHEMA IF EXISTS rapid_inv CASCADE;

CREATE SCHEMA IF NOT EXISTS rapid_inv;
GRANT USAGE ON SCHEMA rapid_inv TO anon, authenticated;

-- =================================================================
-- 1. SUPPLIERS
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.suppliers (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  lead_time_weeks  INT  DEFAULT 12,
  fx_rate          NUMERIC(6,4) DEFAULT 0.65,
  notes            TEXT,
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- =================================================================
-- 2. WAREHOUSES
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.warehouses (
  code             TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  is_active        BOOLEAN DEFAULT true
);

-- =================================================================
-- 3. SKUS
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.skus (
  sku              TEXT PRIMARY KEY,
  description      TEXT,
  supplier_code    TEXT REFERENCES rapid_inv.suppliers(code) ON UPDATE CASCADE,
  uom              TEXT DEFAULT 'EA',
  is_active        BOOLEAN DEFAULT true,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skus_supplier ON rapid_inv.skus(supplier_code);
CREATE INDEX IF NOT EXISTS idx_skus_active   ON rapid_inv.skus(is_active);

-- =================================================================
-- 4. PROJECT LINES  (substitui o Project sheet)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.project_lines (
  id               BIGSERIAL PRIMARY KEY,
  date_opened      DATE NOT NULL DEFAULT CURRENT_DATE,
  sales_order      TEXT,
  customer         TEXT,
  reference        TEXT,
  rep              TEXT,
  sku              TEXT NOT NULL,
  qty              NUMERIC NOT NULL CHECK (qty > 0),
  type             TEXT,
  unit_price       NUMERIC,
  po_ref           TEXT,
  pick_date        DATE,
  qty_held         NUMERIC DEFAULT 0 CHECK (qty_held >= 0),
  date_packed      DATE,
  qty_inv          NUMERIC DEFAULT 0 CHECK (qty_inv >= 0),
  required_text    TEXT,
  warehouse        TEXT,
  action_text      TEXT,
  comments         TEXT[],
  item_desc        TEXT,
  finish_date      DATE,
  qty_to_pick      NUMERIC GENERATED ALWAYS AS (
                     GREATEST(qty - COALESCE(qty_inv,0) - COALESCE(qty_held,0), 0)
                   ) STORED,
  -- days_held: calculado dinamicamente via view v_project_lines (CURRENT_DATE não é IMMUTABLE,
  --            Postgres não permite em GENERATED STORED)
  status           TEXT GENERATED ALWAYS AS (
                     CASE
                       WHEN finish_date IS NOT NULL                                THEN 'COMPLETED'
                       WHEN COALESCE(qty_inv,0)  >= qty                            THEN 'INVOICED'
                       WHEN COALESCE(qty_held,0) >= (qty - COALESCE(qty_inv,0))    THEN 'HELD'
                       WHEN po_ref IS NOT NULL                                     THEN 'ON_PO'
                       ELSE 'OPEN'
                     END
                   ) STORED,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  updated_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_proj_sku       ON rapid_inv.project_lines(sku);
CREATE INDEX IF NOT EXISTS idx_proj_pickdate  ON rapid_inv.project_lines(pick_date);
CREATE INDEX IF NOT EXISTS idx_proj_status    ON rapid_inv.project_lines(status);
CREATE INDEX IF NOT EXISTS idx_proj_open      ON rapid_inv.project_lines(sku) WHERE finish_date IS NULL;
CREATE INDEX IF NOT EXISTS idx_proj_rep       ON rapid_inv.project_lines(rep);
CREATE INDEX IF NOT EXISTS idx_proj_customer  ON rapid_inv.project_lines(customer);

-- =================================================================
-- 5. PO LINES  (substitui o PO's sheet)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.po_lines (
  id               BIGSERIAL PRIMARY KEY,
  po_number        TEXT NOT NULL,
  po_date          DATE NOT NULL,
  supplier_code    TEXT,
  sku              TEXT NOT NULL,
  qty              NUMERIC NOT NULL,
  finish_date      DATE,
  date_checked     DATE,
  due_date         DATE,
  require_status   TEXT,
  value_usd        NUMERIC,
  value_aud        NUMERIC,
  barcode          TEXT,
  ocl              TEXT,
  is_received      BOOLEAN DEFAULT false,
  notes            TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  updated_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_po_sku       ON rapid_inv.po_lines(sku);
CREATE INDEX IF NOT EXISTS idx_po_number    ON rapid_inv.po_lines(po_number);
CREATE INDEX IF NOT EXISTS idx_po_due       ON rapid_inv.po_lines(due_date);
CREATE INDEX IF NOT EXISTS idx_po_supplier  ON rapid_inv.po_lines(supplier_code);

-- =================================================================
-- 6. SOH SNAPSHOT (input do Cin7 / paste manual no MVP)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.soh_snapshot (
  id               BIGSERIAL PRIMARY KEY,
  snapshot_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sku              TEXT NOT NULL,
  warehouse        TEXT,
  qty_on_hand      NUMERIC DEFAULT 0,
  allocated        NUMERIC DEFAULT 0,
  on_order         NUMERIC DEFAULT 0,
  available        NUMERIC GENERATED ALWAYS AS (
                     COALESCE(qty_on_hand,0) - COALESCE(allocated,0)
                   ) STORED,
  is_current       BOOLEAN DEFAULT true,
  notes            TEXT,
  UNIQUE (snapshot_date, sku, warehouse)
);
CREATE INDEX IF NOT EXISTS idx_soh_sku_date ON rapid_inv.soh_snapshot(sku, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_soh_current  ON rapid_inv.soh_snapshot(sku) WHERE is_current = true;

-- =================================================================
-- 7. WEEKLY SALES (input do Cin7 — substitui WEEK SALES sheet)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.weekly_sales (
  id               BIGSERIAL PRIMARY KEY,
  week_start       DATE NOT NULL,
  sku              TEXT NOT NULL,
  qty              NUMERIC DEFAULT 0,
  sale_value       NUMERIC DEFAULT 0,
  cogs             NUMERIC DEFAULT 0,
  invoice_value    NUMERIC DEFAULT 0,
  profit           NUMERIC DEFAULT 0,
  UNIQUE (week_start, sku)
);
CREATE INDEX IF NOT EXISTS idx_sales_sku_week ON rapid_inv.weekly_sales(sku, week_start DESC);

-- =================================================================
-- 8. WEEK CALENDAR (DIFERENCIAL: até 2030!)
--    Domingos de 07/01/2024 a 29/12/2030 = 365 semanas
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.week_calendar (
  week_start       DATE PRIMARY KEY,
  week_index       INT,
  year             INT,
  -- is_past: calculado dinamicamente nas views (CURRENT_DATE não é IMMUTABLE
  --          e Postgres não permite em GENERATED STORED)
  label            TEXT
);

INSERT INTO rapid_inv.week_calendar (week_start, week_index, year, label)
SELECT
  d::DATE,
  (ROW_NUMBER() OVER (ORDER BY d))::INT - 1,
  EXTRACT(YEAR FROM d)::INT,
  to_char(d, 'DD Mon YYYY')
FROM generate_series('2024-01-07'::DATE, '2030-12-29'::DATE, '7 days'::INTERVAL) d
ON CONFLICT (week_start) DO NOTHING;

-- =================================================================
-- 9. SKU SETTINGS (overrides manuais — Wk/Avg, thresholds, comments)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.sku_settings (
  sku              TEXT PRIMARY KEY,
  wk_avg_override  NUMERIC,
  comments         TEXT,
  threshold_red    NUMERIC DEFAULT 2.5,
  threshold_yel    NUMERIC DEFAULT 4,
  updated_at       TIMESTAMPTZ DEFAULT now(),
  updated_by       TEXT
);

-- =================================================================
-- 10. AUDIT LOG (TUDO que mudar fica registrado)
-- =================================================================
CREATE TABLE IF NOT EXISTS rapid_inv.audit_log (
  id               BIGSERIAL PRIMARY KEY,
  table_name       TEXT NOT NULL,
  record_id        TEXT,
  action           TEXT NOT NULL,
  old_value        JSONB,
  new_value        JSONB,
  user_email       TEXT,
  user_pin         TEXT,
  changed_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_record ON rapid_inv.audit_log(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON rapid_inv.audit_log(user_email, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON rapid_inv.audit_log(changed_at DESC);

-- =================================================================
-- 11. TRIGGER UNIVERSAL DE AUDIT
-- =================================================================
CREATE OR REPLACE FUNCTION rapid_inv.fn_audit_log()
RETURNS TRIGGER AS $$
DECLARE
  v_email TEXT;
  v_pin   TEXT;
  v_id    TEXT;
BEGIN
  v_email := current_setting('rapid_inv.user_email', true);
  v_pin   := current_setting('rapid_inv.user_pin',   true);

  IF (TG_OP = 'DELETE') THEN
    v_id := COALESCE(OLD.id::TEXT, OLD.sku::TEXT, OLD.code::TEXT);
    INSERT INTO rapid_inv.audit_log(table_name, record_id, action, old_value, user_email, user_pin)
    VALUES (TG_TABLE_NAME, v_id, 'DELETE', to_jsonb(OLD), v_email, v_pin);
    RETURN OLD;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_id := COALESCE(NEW.id::TEXT, NEW.sku::TEXT, NEW.code::TEXT);
    INSERT INTO rapid_inv.audit_log(table_name, record_id, action, old_value, new_value, user_email, user_pin)
    VALUES (TG_TABLE_NAME, v_id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_email, v_pin);
    RETURN NEW;
  ELSIF (TG_OP = 'INSERT') THEN
    v_id := COALESCE(NEW.id::TEXT, NEW.sku::TEXT, NEW.code::TEXT);
    INSERT INTO rapid_inv.audit_log(table_name, record_id, action, new_value, user_email, user_pin)
    VALUES (TG_TABLE_NAME, v_id, 'INSERT', to_jsonb(NEW), v_email, v_pin);
    RETURN NEW;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- nunca quebrar a operação principal por causa do audit
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Anexa triggers nas tabelas críticas
DROP TRIGGER IF EXISTS trg_audit_project  ON rapid_inv.project_lines;
CREATE TRIGGER trg_audit_project
  AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.project_lines
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_po       ON rapid_inv.po_lines;
CREATE TRIGGER trg_audit_po
  AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_skus     ON rapid_inv.skus;
CREATE TRIGGER trg_audit_skus
  AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.skus
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS trg_audit_settings ON rapid_inv.sku_settings;
CREATE TRIGGER trg_audit_settings
  AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.sku_settings
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

-- =================================================================
-- 12. TRIGGER updated_at automático
-- =================================================================
CREATE OR REPLACE FUNCTION rapid_inv.fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_project ON rapid_inv.project_lines;
CREATE TRIGGER trg_touch_project
  BEFORE UPDATE ON rapid_inv.project_lines
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_po ON rapid_inv.po_lines;
CREATE TRIGGER trg_touch_po
  BEFORE UPDATE ON rapid_inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS trg_touch_skus ON rapid_inv.skus;
CREATE TRIGGER trg_touch_skus
  BEFORE UPDATE ON rapid_inv.skus
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

-- =================================================================
-- 13. VIEW: Wk/Avg automático (substitui Analysis coluna B)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_wk_avg AS
SELECT
  s.sku,
  COALESCE(
    (SELECT wk_avg_override FROM rapid_inv.sku_settings ss WHERE ss.sku = s.sku),
    (SELECT ROUND(AVG(qty)::numeric, 2)
       FROM rapid_inv.weekly_sales ws
       WHERE ws.sku = s.sku
         AND ws.week_start >= CURRENT_DATE - INTERVAL '13 weeks'),
    0
  )::NUMERIC AS wk_avg
FROM rapid_inv.skus s;

-- =================================================================
-- 14. VIEW: Analysis (substitui Analysis sheet inteira)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_analysis AS
WITH soh AS (
  SELECT DISTINCT ON (sku) sku, available
  FROM rapid_inv.soh_snapshot
  WHERE warehouse IS NULL OR warehouse = '' OR warehouse = 'MAIN'
  ORDER BY sku, snapshot_date DESC
),
draws AS (
  SELECT sku, SUM(qty_to_pick) AS project_orders
  FROM rapid_inv.project_lines
  WHERE finish_date IS NULL
  GROUP BY sku
)
SELECT
  s.sku,
  COALESCE(wa.wk_avg, 0)                            AS wk_avg,
  ROUND(COALESCE(wa.wk_avg, 0) * 52.0/12.0, 2)      AS mth_avg,
  COALESCE(soh.available, 0)                        AS soh,
  -COALESCE(draws.project_orders, 0)                AS project_orders,
  CASE WHEN COALESCE(wa.wk_avg, 0) > 0
       THEN ROUND(((COALESCE(soh.available,0) - COALESCE(draws.project_orders,0))
                  / (wa.wk_avg * 52.0/12.0))::numeric, 2)
       ELSE NULL
  END                                               AS mths_stock,
  COALESCE(ss.comments, '')                         AS comments,
  COALESCE(ss.threshold_red, 2.5)                   AS threshold_red,
  COALESCE(ss.threshold_yel, 4)                     AS threshold_yel
FROM rapid_inv.skus s
LEFT JOIN rapid_inv.v_wk_avg wa ON wa.sku = s.sku
LEFT JOIN soh                   ON soh.sku = s.sku
LEFT JOIN draws                 ON draws.sku = s.sku
LEFT JOIN rapid_inv.sku_settings ss ON ss.sku = s.sku;

-- =================================================================
-- 15. VIEW: Forward Forecast — substitui as 23 supplier sheets
--     Range: 8 semanas atrás até 29/12/2030
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
  SELECT DISTINCT ON (sku) sku, available
  FROM rapid_inv.soh_snapshot
  ORDER BY sku, snapshot_date DESC
),
base AS (
  SELECT
    s.sku,
    s.supplier_code,
    c.week_start,
    (c.week_start < CURRENT_DATE)  AS is_past,
    COALESCE(p.draws, 0)           AS project_draws,
    COALESCE(i.incoming, 0)        AS incoming,
    COALESCE(sl.sold, 0)           AS sold_actual,
    COALESCE(wa.wk_avg, 0)         AS wk_avg,
    COALESCE(soh.available, 0)     AS current_soh
  FROM rapid_inv.skus s
  CROSS JOIN rapid_inv.week_calendar c
  LEFT JOIN project_by_week  p  ON p.sku  = s.sku AND p.week_start  = c.week_start
  LEFT JOIN incoming_by_week i  ON i.sku  = s.sku AND i.week_start  = c.week_start
  LEFT JOIN sales_by_week    sl ON sl.sku = s.sku AND sl.week_start = c.week_start
  LEFT JOIN rapid_inv.v_wk_avg wa ON wa.sku = s.sku
  LEFT JOIN current_soh soh ON soh.sku = s.sku
  WHERE c.week_start BETWEEN CURRENT_DATE - INTERVAL '8 weeks' AND '2030-12-29'
)
SELECT
  sku, supplier_code, week_start, is_past,
  project_draws, incoming, sold_actual, wk_avg,
  CASE WHEN is_past THEN sold_actual ELSE wk_avg END AS outflow,
  current_soh +
    SUM(incoming - project_draws - (CASE WHEN is_past THEN sold_actual ELSE wk_avg END))
      OVER (PARTITION BY sku ORDER BY week_start
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
    AS projected_balance
FROM base;

-- =================================================================
-- 15b. VIEW: v_project_lines — adiciona days_held calculado dinamicamente
--      (não pode ser STORED porque CURRENT_DATE não é IMMUTABLE)
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_project_lines AS
SELECT
  pl.*,
  CASE WHEN pl.date_packed IS NOT NULL
       THEN (CURRENT_DATE - pl.date_packed)::INT
       ELSE 0
  END AS days_held
FROM rapid_inv.project_lines pl;

-- =================================================================
-- 15c. VIEW: v_week_calendar — adiciona is_past calculado dinamicamente
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_week_calendar AS
SELECT
  wc.*,
  (wc.week_start < CURRENT_DATE) AS is_past
FROM rapid_inv.week_calendar wc;

-- =================================================================
-- 16. VIEW: KPIs do Dashboard
-- =================================================================
CREATE OR REPLACE VIEW rapid_inv.v_dashboard_kpis AS
SELECT
  (SELECT COUNT(*) FROM rapid_inv.project_lines WHERE finish_date IS NULL)       AS open_so_lines,
  (SELECT COUNT(*) FROM rapid_inv.po_lines      WHERE is_received = false)       AS open_po_lines,
  (SELECT COALESCE(SUM(qty_held),0) FROM rapid_inv.project_lines
     WHERE finish_date IS NULL AND qty_held > 0)                                 AS qty_pack_and_hold,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis
     WHERE mths_stock IS NOT NULL AND mths_stock < threshold_red)                AS skus_critical_red,
  (SELECT COUNT(*) FROM rapid_inv.v_analysis
     WHERE mths_stock IS NOT NULL
       AND mths_stock >= threshold_red AND mths_stock < threshold_yel)           AS skus_warning_yellow,
  (SELECT COUNT(DISTINCT sku) FROM rapid_inv.skus WHERE is_active = true)        AS total_active_skus,
  (SELECT COALESCE(SUM(value_aud),0) FROM rapid_inv.po_lines
     WHERE is_received = false)                                                  AS po_pipeline_aud;

-- =================================================================
-- 17. SEEDS (warehouses + 23 suppliers vindos do Excel)
-- =================================================================
INSERT INTO rapid_inv.warehouses (code, name) VALUES
  ('MAIN',    'Main Warehouse'),
  ('DALTON',  'Dalton'),
  ('GATEWAY', 'Gateway')
ON CONFLICT (code) DO NOTHING;

INSERT INTO rapid_inv.suppliers (code, name) VALUES
  ('AEON',     'Aeon'),
  ('AGC',      'AGC'),
  ('AOK',      'AOK'),
  ('CGD',      'CGD'),
  ('CNEPSO',   'CNEPSO'),
  ('COWIN',    'Cowin'),
  ('DOLIGHT',  'Dolight'),
  ('ELITE',    'E-Lite'),
  ('EPOWER',   'ePower'),
  ('FOSHAN',   'Foshan'),
  ('GENERAL',  'General'),
  ('HUIBO',    'Huibo'),
  ('KINGLUMI', 'Kinglumi'),
  ('LEDLUZ',   'LEDLUZ'),
  ('MIXED',    'Mixed'),
  ('RELIGHT',  'Relight'),
  ('OTTIMA',   'Ottima'),
  ('SEALITE',  'Sealite'),
  ('SENSELITE','Senselite'),
  ('STARLUX',  'Starlux'),
  ('UPSHINE',  'Upshine'),
  ('XTRACK',   'Xtrack'),
  ('BOM',      'BOM (Bill of Materials)')
ON CONFLICT (code) DO NOTHING;

-- =================================================================
-- 18. RPC: set_audit_user — chamada pelo frontend antes de qualquer write
--     uso JS:  await supabase.rpc('set_audit_user', { p_email, p_pin })
-- =================================================================
CREATE OR REPLACE FUNCTION rapid_inv.set_audit_user(p_email TEXT, p_pin TEXT)
RETURNS VOID AS $$
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_email, ''), true);
  PERFORM set_config('rapid_inv.user_pin',   COALESCE(p_pin,   ''), true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Expor o schema rapid_inv para PostgREST (Supabase API)
-- Você TAMBÉM precisa adicionar "rapid_inv" em:
--   Supabase Dashboard → Project Settings → API → Exposed schemas
-- (separado por vírgula, ex: "public, rapid_inv, cin7_mirror")
GRANT USAGE ON SCHEMA rapid_inv TO anon, authenticated;
GRANT ALL ON ALL TABLES    IN SCHEMA rapid_inv TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA rapid_inv TO anon, authenticated;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA rapid_inv TO anon, authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA rapid_inv TO anon, authenticated;
GRANT EXECUTE ON FUNCTION rapid_inv.set_audit_user(TEXT, TEXT) TO anon, authenticated;

-- Default privileges para objetos criados no futuro
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv
  GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv
  GRANT ALL ON SEQUENCES TO anon, authenticated;

-- =================================================================
-- 19. VERIFICAÇÃO FINAL
-- =================================================================
DO $$
DECLARE
  v_tables INT;
  v_views  INT;
  v_weeks  INT;
  v_sup    INT;
  v_wh     INT;
BEGIN
  SELECT COUNT(*) INTO v_tables FROM information_schema.tables
   WHERE table_schema = 'rapid_inv' AND table_type = 'BASE TABLE';
  SELECT COUNT(*) INTO v_views  FROM information_schema.views
   WHERE table_schema = 'rapid_inv';
  SELECT COUNT(*) INTO v_weeks  FROM rapid_inv.week_calendar;
  SELECT COUNT(*) INTO v_sup    FROM rapid_inv.suppliers;
  SELECT COUNT(*) INTO v_wh     FROM rapid_inv.warehouses;
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  RAPID INVENTORY SKU — Setup completo com sucesso ✅';
  RAISE NOTICE '  Tabelas: %  |  Views: %  |  Suppliers: %  |  Warehouses: %', v_tables, v_views, v_sup, v_wh;
  RAISE NOTICE '  Calendário de semanas: % (de 2024-01-07 a 2030-12-29)', v_weeks;
  RAISE NOTICE '======================================================';
  RAISE NOTICE 'PRÓXIMO PASSO:';
  RAISE NOTICE '  Supabase Dashboard → Settings → API → Exposed schemas';
  RAISE NOTICE '  adicione "rapid_inv" (separado por vírgula)';
  RAISE NOTICE '======================================================';
END $$;
