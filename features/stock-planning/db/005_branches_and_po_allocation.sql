-- =====================================================================
-- Stock Planning · 005 · FILIAIS E ALOCAÇÃO DE PO
-- ---------------------------------------------------------------------
-- Duas coisas:
--
--   1. Filial deixa de ser constante de JavaScript. Hoje a lista canônica
--      vive em features/replenishment/replenishment-config.js:260-268 e
--      rapid_inv.warehouses só conhece 4 códigos, nenhum deles filial.
--
--   2. Uma linha de PO passa a poder ser repartida entre filiais. Hoje ela
--      tem só quantidade total, e o destino aparece como texto solto no
--      campo do navio.
--
-- Aditivo e idempotente. Não dropa nada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- FILIAIS
-- Nomes e códigos vêm de replenishment-config.js (BRANCHES + CIN7_LOCATION_MAP),
-- que é a lista que o replenishment usa em produção. cin7_location_name é o
-- nome exato do local no Cin7 — repare que Sunshine Coast tem sufixo lá e não
-- no código, e é por isso que o de-para precisa existir.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.warehouses
  ADD COLUMN IF NOT EXISTS cin7_location_name TEXT,
  ADD COLUMN IF NOT EXISTS is_branch  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_hub     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 100;

INSERT INTO rapid_inv.warehouses (code, name, cin7_location_name, is_branch, is_hub, sort_order) VALUES
  ('MAIN',   'Main Warehouse','Main Warehouse',          false, true , 10),
  ('GATEWAY','Gateway',       'Gateway',                 false, true , 20),
  ('SYD',    'Sydney',        'Sydney',                  true , false, 30),
  ('MEL',    'Melbourne',     'Melbourne',               true , false, 40),
  ('BNE',    'Brisbane',      'Brisbane',                true , false, 50),
  ('CNS',    'Cairns',        'Cairns',                  true , false, 60),
  ('CFS',    'Coffs Harbour', 'Coffs Harbour',           true , false, 70),
  ('HBA',    'Hobart',        'Hobart',                  true , false, 80),
  ('SCS',    'Sunshine Coast','Sunshine Coast Warehouse',true , false, 90)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  cin7_location_name = EXCLUDED.cin7_location_name,
  is_branch = EXCLUDED.is_branch,
  is_hub = EXCLUDED.is_hub,
  sort_order = EXCLUDED.sort_order;

-- DALTON e PROJECTS ficam, mas fora da lista de destino: DALTON é como o
-- workbook chama o Main, e PROJECTS são os locais de projeto.
UPDATE rapid_inv.warehouses SET is_active = false, sort_order = 900
 WHERE code IN ('DALTON','PROJECTS');

CREATE OR REPLACE VIEW rapid_inv.v_sp_branches AS
SELECT code, name, cin7_location_name, is_branch, is_hub, sort_order
  FROM rapid_inv.warehouses
 WHERE is_active AND (is_branch OR is_hub)
 ORDER BY sort_order;

-- ---------------------------------------------------------------------
-- ALOCAÇÃO DE LINHA DE PO POR FILIAL
-- Espelha project_draws: filho da linha, com quantidade e data próprias.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.po_line_allocations (
  id           BIGSERIAL PRIMARY KEY,
  po_line_id   BIGINT NOT NULL REFERENCES rapid_inv.po_lines(id) ON DELETE CASCADE,
  seq          INT NOT NULL DEFAULT 1,
  branch_code  TEXT NOT NULL REFERENCES rapid_inv.warehouses(code),
  qty          NUMERIC NOT NULL CHECK (qty > 0),
  eta_date     DATE,                       -- NULL = usa a due_date da linha
  status       TEXT NOT NULL DEFAULT 'PLANNED'
               CHECK (status IN ('PLANNED','CONFIRMED','SHIPPED','RECEIVED','CANCELLED')),
  note         TEXT,
  source       TEXT NOT NULL DEFAULT 'MANUAL'
               CHECK (source IN ('MANUAL','EXCEL_IMPORT','SPLIT','CIN7')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT,
  UNIQUE (po_line_id, branch_code, seq)
);
CREATE INDEX IF NOT EXISTS ix_sp_po_alloc_line   ON rapid_inv.po_line_allocations (po_line_id, seq);
CREATE INDEX IF NOT EXISTS ix_sp_po_alloc_branch ON rapid_inv.po_line_allocations (branch_code, eta_date)
  WHERE status <> 'CANCELLED';

DROP TRIGGER IF EXISTS tg_sp_po_alloc_touch ON rapid_inv.po_line_allocations;
CREATE TRIGGER tg_sp_po_alloc_touch BEFORE UPDATE ON rapid_inv.po_line_allocations
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_sp_po_alloc_audit ON rapid_inv.po_line_allocations;
CREATE TRIGGER tg_sp_po_alloc_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.po_line_allocations
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

-- Sem CHECK de soma, de propósito — mesma disciplina dos draws: alocar mais
-- que a linha AVISA, não trava. A operação tem exceção legítima, e travar
-- faria o time voltar para o Excel no primeiro dia.
CREATE OR REPLACE VIEW rapid_inv.v_sp_po_allocation AS
SELECT po.id AS po_line_id, po.po_number, po.line_no, po.sku, po.sku_key, po.qty, po.due_date,
       po.supplier_code, po.vessel,
       COALESCE(a.allocated, 0)                  AS allocated_qty,
       po.qty - COALESCE(a.allocated, 0)         AS unallocated_qty,
       (COALESCE(a.allocated, 0) > po.qty)       AS over_allocated,
       COALESCE(a.n, 0)                          AS allocation_count
  FROM rapid_inv.po_lines po
  LEFT JOIN LATERAL (
    SELECT sum(x.qty) AS allocated, count(*)::int AS n
      FROM rapid_inv.po_line_allocations x
     WHERE x.po_line_id = po.id AND x.status <> 'CANCELLED'
  ) a ON TRUE;

CREATE OR REPLACE VIEW rapid_inv.v_sp_po_allocation_integrity AS
SELECT po_line_id, po_number, sku, qty, allocated_qty, unallocated_qty, 'OVER_ALLOCATED' AS issue
  FROM rapid_inv.v_sp_po_allocation WHERE over_allocated;

-- ---------------------------------------------------------------------
-- ENTRADA DE ESTOQUE POR FILIAL
--
-- O saldo não alocado é do MAIN, e isso fica EXPLÍCITO como uma linha, não
-- implícito. Assim a soma por filial é sempre idêntica ao total da linha por
-- construção, e ninguém precisa lembrar da regra.
--
-- ATENÇÃO: esta view é CONTEXTO. A projeção semanal continua usando
-- v_sp_incoming, que é da empresa inteira — é a regra do Excel, e alocação
-- por filial não pode virar a base do cálculo sem querer.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_sp_incoming_branch AS
WITH open_po AS (
  SELECT id, sku_key, qty, due_date
    FROM rapid_inv.po_lines
   WHERE due_date IS NOT NULL AND NOT COALESCE(is_received, false)
), parts AS (
  SELECT p.sku_key, a.branch_code, COALESCE(a.eta_date, p.due_date) AS eta, a.qty
    FROM open_po p
    JOIN rapid_inv.po_line_allocations a ON a.po_line_id = p.id AND a.status <> 'CANCELLED'
  UNION ALL
  SELECT p.sku_key, 'MAIN'::TEXT, p.due_date,
         p.qty - COALESCE((SELECT sum(a.qty) FROM rapid_inv.po_line_allocations a
                            WHERE a.po_line_id = p.id AND a.status <> 'CANCELLED'), 0)
    FROM open_po p
)
SELECT sku_key AS sku, branch_code, rapid_inv.week_ending(eta) AS week_ending, sum(qty) AS qty
  FROM parts WHERE qty > 0
 GROUP BY 1, 2, 3;

DO $$ BEGIN RAISE NOTICE '005: filiais e alocação de PO prontas'; END $$;
