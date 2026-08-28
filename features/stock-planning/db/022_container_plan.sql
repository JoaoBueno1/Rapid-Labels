-- ============================================================================
-- 022 — Planos de contêiner.
--
-- Montar carga é trabalho de horas e envolve mais de uma pessoa: quem compra
-- escolhe o que entra, quem embarca confere se fecha. Se o plano só existe na
-- tela aberta, ele morre no primeiro F5 e a conversa recomeça do zero.
--
-- O plano guarda a QUANTIDADE por linha de PO, não a linha inteira: quase
-- nunca a PO cabe redondo num contêiner, e a resposta certa costuma ser
-- "esta PO vai em dois embarques". Sem quantidade parcial o planejador é
-- forçado a mentir para o sistema — ou levar tudo, ou não levar nada.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.container_plan (
  id             bigserial PRIMARY KEY,
  name           text NOT NULL,
  container_code text NOT NULL REFERENCES rapid_inv.container_type(code),
  supplier_code  text,
  status         text NOT NULL DEFAULT 'DRAFT'
                   CHECK (status IN ('DRAFT','BOOKED','SHIPPED','CANCELLED')),
  eta_date       date,
  vessel         text,
  note           text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

CREATE TABLE IF NOT EXISTS rapid_inv.container_plan_line (
  id          bigserial PRIMARY KEY,
  plan_id     bigint NOT NULL REFERENCES rapid_inv.container_plan(id) ON DELETE CASCADE,
  po_line_id  bigint REFERENCES rapid_inv.po_lines(id) ON DELETE SET NULL,
  sku_key     text NOT NULL,
  sku         text NOT NULL,
  qty         numeric NOT NULL CHECK (qty > 0),
  -- O cubo e o peso são CONGELADOS ao entrar no plano. A dimensão do produto
  -- muda no Cin7 e um plano fechado semana passada não pode reescrever a si
  -- mesmo — quem embarcou precisa ver o número em que baseou a decisão.
  cbm_at_plan numeric,
  kg_at_plan  numeric,
  cube_source text,          -- 'cin7' | 'file' | null, congelado junto
  added_by    text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, po_line_id)
);

CREATE INDEX IF NOT EXISTS ix_cpl_plan ON rapid_inv.container_plan_line (plan_id);
CREATE INDEX IF NOT EXISTS ix_cpl_poline ON rapid_inv.container_plan_line (po_line_id);

-- Quanto já foi comprometido de cada linha de PO, somando TODOS os planos que
-- ainda valem. É isto que impede a mesma carga de ser prometida a dois
-- contêineres — o erro que só aparece no porto.
DROP VIEW IF EXISTS rapid_inv.v_sp_po_committed CASCADE;
CREATE VIEW rapid_inv.v_sp_po_committed AS
SELECT l.po_line_id, sum(l.qty)::numeric AS qty_planned,
       count(DISTINCT l.plan_id)::int    AS plans,
       string_agg(DISTINCT p.name, ', ') AS plan_names
  FROM rapid_inv.container_plan_line l
  JOIN rapid_inv.container_plan p ON p.id = l.plan_id
 WHERE p.status <> 'CANCELLED'
 GROUP BY 1;

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.container_plan, rapid_inv.container_plan_line
  TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rapid_inv.container_plan_id_seq, rapid_inv.container_plan_line_id_seq
  TO anon, authenticated, service_role;
GRANT SELECT ON rapid_inv.v_sp_po_committed TO anon, authenticated, service_role;

COMMENT ON COLUMN rapid_inv.container_plan_line.cbm_at_plan IS
  'Cubo congelado na hora que a linha entrou. A dimensao muda no Cin7 e um plano fechado nao pode se reescrever.';
