-- ═══════════════════════════════════════════════════════════════════════════
-- cin7_mirror.purchase_orders / purchase_lines — o espelho que não existe.
--
-- É a lacuna que o próprio repo já registrou como prioridade 1
-- (docs/STOCK_PLANNING_03_CIN7_AUTOMATION.md:24). Hoje on-order vive só como
-- número agregado em stock_snapshot.on_order (cin7-stock-sync/schema.sql:84):
-- diz QUANTO vem, nunca QUANDO nem DE QUEM. E rapid_inv.po_lines é digitação
-- de Excel com is_received=false nas 1.466 linhas.
--
-- Aditivo: nenhuma tabela existente é tocada. Colar no SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS cin7_mirror.purchase_orders (
  po_id          UUID PRIMARY KEY,          -- purchaseList.ID
  po_number      TEXT UNIQUE,
  supplier       TEXT,
  supplier_id    UUID,
  status         TEXT,                      -- DRAFT|ORDERING|ORDERED|RECEIVING|COMPLETED|VOID
  order_date     DATE,
  required_by    DATE,                      -- o ETA do fornecedor
  completed_date DATE,
  currency       TEXT,
  total          NUMERIC,
  occurred_at    TIMESTAMPTZ,               -- data do NEGÓCIO, nunca now()
  synced_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_status ON cin7_mirror.purchase_orders (status);
CREATE INDEX IF NOT EXISTS idx_po_dates  ON cin7_mirror.purchase_orders (order_date, required_by);

CREATE TABLE IF NOT EXISTS cin7_mirror.purchase_lines (
  po_id             UUID NOT NULL REFERENCES cin7_mirror.purchase_orders(po_id) ON DELETE CASCADE,
  line_no           INT  NOT NULL,
  sku               TEXT NOT NULL,
  product_name      TEXT,
  quantity          NUMERIC,
  unit_cost         NUMERIC,
  total             NUMERIC,
  received_quantity NUMERIC DEFAULT 0,      -- soma de StockReceived.Lines do mesmo SKU
  synced_at         TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (po_id, line_no)
);
-- Índice funcional no SKU normalizado: sem ele todo join com rapid_inv custa
-- uma varredura, a mesma lição de features/stock-planning/db/006_overview_views.sql:26.
CREATE INDEX IF NOT EXISTS idx_pl_skukey ON cin7_mirror.purchase_lines (upper(btrim(sku)));

-- occurred_at em stock_movements: a coluna que faz o backfill de movimento ser
-- possível. detected_at fica INTOCADA (13 páginas já dependem dela) — o
-- contrato de dados passa a ler occurred_at.
ALTER TABLE cin7_mirror.stock_movements
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_sm_occurred ON cin7_mirror.stock_movements (occurred_at);
-- Backfill da coluna nas linhas que já existem, a partir da data do negócio
-- que o webhook enterrou em raw_data (movement-processor.js:370).
UPDATE cin7_mirror.stock_movements
   SET occurred_at = COALESCE((raw_data->>'ship_date')::timestamptz, detected_at)
 WHERE occurred_at IS NULL;

ALTER TABLE cin7_mirror.purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cin7_mirror.purchase_lines  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS po_read ON cin7_mirror.purchase_orders;
CREATE POLICY po_read ON cin7_mirror.purchase_orders FOR SELECT USING (true);
DROP POLICY IF EXISTS pl_read ON cin7_mirror.purchase_lines;
CREATE POLICY pl_read ON cin7_mirror.purchase_lines FOR SELECT USING (true);
GRANT SELECT ON cin7_mirror.purchase_orders, cin7_mirror.purchase_lines TO anon, authenticated;
GRANT ALL    ON cin7_mirror.purchase_orders, cin7_mirror.purchase_lines TO service_role;

SELECT 'purchase_orders' AS t, count(*) FROM cin7_mirror.purchase_orders
UNION ALL SELECT 'purchase_lines', count(*) FROM cin7_mirror.purchase_lines;
