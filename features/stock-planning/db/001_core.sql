-- =====================================================================
-- Stock Planning · 001 · NÚCLEO
-- ---------------------------------------------------------------------
-- Projeto → Linha → Draw.
--
-- O Excel guarda parcelamento de entrega duplicando a linha: 747 pares
-- SO+SKU repetidos, 391 deles com PICK DATE diferente. O draw dá um lugar
-- para isso morar sem inventar conceito novo para o time.
--
-- Aditivo. Não dropa nem reescreve nada existente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROJETO — cabeçalho do que hoje é "o bloco de linhas com o mesmo SO"
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.projects (
  id              BIGSERIAL PRIMARY KEY,
  sales_order     TEXT NOT NULL,
  order_date      DATE,
  customer        TEXT,
  reference       TEXT,                    -- "2943 - Tod Ferny Grove"
  rep             TEXT,
  warehouse_code  TEXT,                    -- normalizado quando reconhecível
  warehouse_note  TEXT,                    -- texto livre original, íntegro
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED')),
  finish_date     DATE,
  source          TEXT NOT NULL DEFAULT 'MANUAL'
                  CHECK (source IN ('MANUAL','EXCEL_IMPORT','CIN7')),
  cin7_sale_id    TEXT,                    -- reservado para a fase Cin7; NULL na V1
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      TEXT
);

-- Um Sales Order não pode entrar duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sp_projects_so
  ON rapid_inv.projects (upper(btrim(sales_order)));
CREATE INDEX IF NOT EXISTS ix_sp_projects_status   ON rapid_inv.projects (status, order_date DESC);
CREATE INDEX IF NOT EXISTS ix_sp_projects_customer ON rapid_inv.projects (customer);
CREATE INDEX IF NOT EXISTS ix_sp_projects_rep      ON rapid_inv.projects (rep);
CREATE INDEX IF NOT EXISTS ix_sp_projects_cin7     ON rapid_inv.projects (cin7_sale_id)
  WHERE cin7_sale_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- LINHA — já existe. Só ganha o vínculo com o projeto e o que faltava.
-- qty_to_pick continua GENERATED: GREATEST(qty - qty_inv - qty_held, 0)
-- que é exatamente o =IF(G-P-M>0, G-P-M, "") do Excel.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.project_lines
  ADD COLUMN IF NOT EXISTS project_id  BIGINT REFERENCES rapid_inv.projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS line_no     INT,
  ADD COLUMN IF NOT EXISTS po_due_date DATE,        -- existia só em Completed Projects
  ADD COLUMN IF NOT EXISTS source      TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS is_void     BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ix_sp_lines_project ON rapid_inv.project_lines (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sp_lines_project_no
  ON rapid_inv.project_lines (project_id, line_no) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- DRAW — a parcela planejada. O conceito que o Excel não tinha.
-- planned_date NULL = TBA, e isso é legítimo: metade das linhas hoje.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.project_draws (
  id            BIGSERIAL PRIMARY KEY,
  line_id       BIGINT NOT NULL REFERENCES rapid_inv.project_lines(id) ON DELETE CASCADE,
  seq           INT NOT NULL DEFAULT 1,
  qty           NUMERIC NOT NULL CHECK (qty > 0),
  planned_date  DATE,
  status        TEXT NOT NULL DEFAULT 'PLANNED'
                CHECK (status IN ('PLANNED','PICKED','PACKED','INVOICED','CANCELLED')),
  note          TEXT,                       -- "handover 14/8", "aguardando cliente"
  source        TEXT NOT NULL DEFAULT 'MANUAL'
                CHECK (source IN ('MANUAL','EXCEL_IMPORT','SPLIT','CIN7')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

CREATE INDEX IF NOT EXISTS ix_sp_draws_line ON rapid_inv.project_draws (line_id, seq);
-- Só draws vivos entram no planejamento.
CREATE INDEX IF NOT EXISTS ix_sp_draws_open ON rapid_inv.project_draws (planned_date)
  WHERE status IN ('PLANNED','PICKED','PACKED');
CREATE INDEX IF NOT EXISTS ix_sp_draws_tba  ON rapid_inv.project_draws (line_id)
  WHERE planned_date IS NULL AND status = 'PLANNED';

-- ---------------------------------------------------------------------
-- updated_at automático
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS tg_sp_projects_touch ON rapid_inv.projects;
CREATE TRIGGER tg_sp_projects_touch BEFORE UPDATE ON rapid_inv.projects
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_sp_draws_touch ON rapid_inv.project_draws;
CREATE TRIGGER tg_sp_draws_touch BEFORE UPDATE ON rapid_inv.project_draws
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

-- ---------------------------------------------------------------------
-- AUDITORIA — o trigger universal JSONB já existe. Só ligar.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS tg_sp_projects_audit ON rapid_inv.projects;
CREATE TRIGGER tg_sp_projects_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.projects
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS tg_sp_draws_audit ON rapid_inv.project_draws;
CREATE TRIGGER tg_sp_draws_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.project_draws
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DO $$ BEGIN RAISE NOTICE '001_core: projects + project_draws prontos'; END $$;

-- ---------------------------------------------------------------------
-- Linha com QTY zero é dado real, não lixo.
--
-- São 25 linhas no workbook: o SKU já está no projeto mas a quantidade
-- ainda não fechou, e a linha carrega o texto de agenda ("CVSG TBA",
-- "Feb - May"). O CHECK original (qty > 0) as rejeitava, o que descartaria
-- intenção de planejamento em silêncio. Não geram draw, porque
-- qty_to_pick continua zero.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.project_lines DROP CONSTRAINT IF EXISTS project_lines_qty_check;
ALTER TABLE rapid_inv.project_lines ADD  CONSTRAINT project_lines_qty_check CHECK (qty >= 0);
