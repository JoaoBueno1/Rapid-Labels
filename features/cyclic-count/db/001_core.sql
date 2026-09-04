-- =====================================================================
-- Cyclic Count · 001 · NÚCLEO
-- ---------------------------------------------------------------------
-- Substitui `Cyclic Stock Count - <mês>.xlsx` + `Stock Count Summary`.
--
-- O que o Excel faz e como vira tabela:
--   aba de filial            -> cc_round.branch_code
--   bloco semanal empilhado  -> cc_round (um por filial/semana/lista)
--   as listas A e B          -> cc_list + cc_list_item
--   coluna D (QTY sistema)   -> cc_round_line.system_qty   CONGELADO no disparo
--   coluna E (Count)         -> cc_round_line.counted_qty  digitado pela filial
--   coluna F (Ghost)         -> explain_qty + explain_location
--   coluna G (Movement)      -> explain_ref
--   colunas H e I            -> GENERATED, nunca digitadas
--   Summary (col por data)   -> v_cc_sku_history
--
-- APLICAR: colar no SQL Editor do Supabase (projeto do Labels) e rodar.
-- Idempotente. Aditivo — não dropa nem reescreve nada que já existe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Quais depósitos entram no ciclo.
--
-- O Excel conta 8 abas: BR CA CH Main SC SY ME HO. Gateway fica de fora.
-- Vira uma coluna na tabela que já existe, em vez de uma lista cravada numa
-- view — assim entrar ou sair do ciclo é um UPDATE, não uma migration.
-- ---------------------------------------------------------------------
ALTER TABLE rapid_inv.warehouses
  ADD COLUMN IF NOT EXISTS cc_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE rapid_inv.warehouses
   SET cc_enabled = true
 WHERE code IN ('BNE','CNS','CFS','MAIN','SCS','SYD','MEL','HBA');

COMMENT ON COLUMN rapid_inv.warehouses.cc_enabled IS
  'Participa da contagem ciclica. Espelha as 8 abas do workbook (Gateway fora).';

-- ---------------------------------------------------------------------
-- A LISTA — o que se conta.
--
-- Hoje são duas, alternando: A nas semanas 1 e 3, B nas 2 e 4. Conferido nos
-- workbooks de agosto e setembro: A e B são idênticas entre os meses e não
-- têm nenhum SKU em comum. A lista MENSAL curta (bloco N–V) muda todo mês e
-- por isso é uma lista como as outras, não um caso especial.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.cc_list (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_list_code
  ON rapid_inv.cc_list (upper(btrim(code)));

CREATE TABLE IF NOT EXISTS rapid_inv.cc_list_item (
  id          BIGSERIAL PRIMARY KEY,
  list_id     BIGINT NOT NULL REFERENCES rapid_inv.cc_list(id) ON DELETE CASCADE,
  sku         TEXT NOT NULL,
  sku_code    TEXT,                       -- o "5DC" do Excel
  sort_order  INT  NOT NULL DEFAULT 0,    -- a ordem da folha; o armazém anda nela
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_list_item_sku
  ON rapid_inv.cc_list_item (list_id, upper(btrim(sku)));
CREATE INDEX IF NOT EXISTS ix_cc_list_item_order
  ON rapid_inv.cc_list_item (list_id, sort_order);

-- ---------------------------------------------------------------------
-- A RODADA — uma filial, uma semana, uma lista. A unidade de trabalho.
--
-- Chave (filial, semana, lista) e não (filial, semana): o workbook roda a
-- lista da semana E o bloco mensal na mesma semana. Duas rodadas, não uma.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.cc_round (
  id               BIGSERIAL PRIMARY KEY,
  branch_code      TEXT   NOT NULL REFERENCES rapid_inv.warehouses(code),
  list_id          BIGINT NOT NULL REFERENCES rapid_inv.cc_list(id),
  week_start       DATE   NOT NULL,
  status           TEXT   NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','dispatching','sent','submitted','review','closed','cancelled')),

  -- O link da filial. É credencial: quem tem o token conta. Ver os REVOKE no fim.
  token            TEXT   NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  due_date         DATE,

  -- A prova de qual estoque foi congelado, e de onde veio.
  snapshot_at      TIMESTAMPTZ,
  snapshot_source  TEXT CHECK (snapshot_source IN ('CIN7_REFRESH','MIRROR')),
  snapshot_age_min INT,                   -- idade do mirror no instante do congelamento

  sent_at          TIMESTAMPTZ,
  sent_to          TEXT[],
  submitted_at     TIMESTAMPTZ,
  submitted_by     TEXT,
  closed_at        TIMESTAMPTZ,
  closed_by        TEXT,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       TEXT,

  -- Semana começa na segunda. Sem isto, "semana de 12/08" e "semana de 13/08"
  -- viram duas rodadas diferentes da mesma semana, e o histórico por SKU
  -- ganha duas colunas onde devia ter uma.
  CONSTRAINT ck_cc_round_monday CHECK (EXTRACT(ISODOW FROM week_start) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_round_branch_week_list
  ON rapid_inv.cc_round (branch_code, week_start, list_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_round_token
  ON rapid_inv.cc_round (token);
CREATE INDEX IF NOT EXISTS ix_cc_round_status ON rapid_inv.cc_round (status, week_start DESC);
CREATE INDEX IF NOT EXISTS ix_cc_round_week   ON rapid_inv.cc_round (week_start DESC, branch_code);

-- ---------------------------------------------------------------------
-- A LINHA CONTÁVEL — congelada no disparo.
--
-- system_qty e unit_cost_aud são GRAVADOS, não VLOOKUP vivo. O workbook lê
-- de uma `Price List 14 Aug` que é trocada todo mês: a variância de julho
-- muda sozinha quando alguém cola a lista de setembro. Aqui não muda.
--
-- As três derivadas são GENERATED: ninguém digita, ninguém corrige, e dá
-- para ordenar o board por dinheiro sem recalcular no navegador.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.cc_round_line (
  id                BIGSERIAL PRIMARY KEY,
  round_id          BIGINT NOT NULL REFERENCES rapid_inv.cc_round(id) ON DELETE CASCADE,
  sku               TEXT   NOT NULL,
  sku_code          TEXT,
  product_name      TEXT,
  sort_order        INT    NOT NULL DEFAULT 0,

  system_qty        NUMERIC,              -- congelado no disparo
  unit_cost_aud     NUMERIC,              -- congelado no disparo
  counted_qty       NUMERIC,              -- a filial digita
  counted_at        TIMESTAMPTZ,

  -- A tratativa. No Excel: coluna F (texto livre "MA x 1") e G ("TR#48861").
  explain_qty       NUMERIC,              -- quantas unidades a explicação cobre
  explain_location  TEXT,                 -- onde estavam: 'GHOST', 'MAIN', 'BNE'...
  explain_ref       TEXT,                 -- a transferência: 'TR-48861', 'ST-12713'
  action            TEXT CHECK (action IN ('MOVE_TO_GHOST','MOVE_FROM_GHOST','ADD_TO_STOCK','NONE')),
  note              TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        TEXT,

  -- NULL quando não foi contado. Zero seria mentira: "contei e bateu" e
  -- "ninguém contou" não podem ser o mesmo número numa tela de estoque.
  variance_qty      NUMERIC GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
  variance_value    NUMERIC GENERATED ALWAYS AS ((counted_qty - system_qty) * unit_cost_aud) STORED,
  unexplained_qty   NUMERIC GENERATED ALWAYS AS (counted_qty - system_qty + COALESCE(explain_qty, 0)) STORED,
  unexplained_value NUMERIC GENERATED ALWAYS AS ((counted_qty - system_qty + COALESCE(explain_qty, 0)) * unit_cost_aud) STORED
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_round_line_sku
  ON rapid_inv.cc_round_line (round_id, upper(btrim(sku)));
CREATE INDEX IF NOT EXISTS ix_cc_round_line_order ON rapid_inv.cc_round_line (round_id, sort_order);
CREATE INDEX IF NOT EXISTS ix_cc_round_line_sku   ON rapid_inv.cc_round_line (upper(btrim(sku)));
CREATE INDEX IF NOT EXISTS ix_cc_round_line_var   ON rapid_inv.cc_round_line (round_id)
  WHERE variance_qty IS NOT NULL AND variance_qty <> 0;

-- ---------------------------------------------------------------------
-- DESTINATÁRIOS — a lista de e-mails por filial.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.cc_recipient (
  id           BIGSERIAL PRIMARY KEY,
  branch_code  TEXT NOT NULL REFERENCES rapid_inv.warehouses(code),
  email        TEXT NOT NULL,
  name         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cc_recipient
  ON rapid_inv.cc_recipient (branch_code, lower(btrim(email)));

-- ---------------------------------------------------------------------
-- LOG DE E-MAIL — a confirmação de que saiu.
--
-- Falha grava linha também. Um envio que falhou e não deixou rastro é a
-- filial jurando que não recebeu e ninguém sabendo quem tem razão.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rapid_inv.cc_email_log (
  id           BIGSERIAL PRIMARY KEY,
  round_id     BIGINT REFERENCES rapid_inv.cc_round(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'DISPATCH'
               CHECK (kind IN ('DISPATCH','REMINDER','RESULT')),
  to_emails    TEXT[] NOT NULL,
  subject      TEXT,
  status       TEXT NOT NULL CHECK (status IN ('SENT','FAILED')),
  provider_id  TEXT,                      -- X-Message-Id do SendGrid
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by      TEXT
);

CREATE INDEX IF NOT EXISTS ix_cc_email_log_round ON rapid_inv.cc_email_log (round_id, sent_at DESC);

-- ---------------------------------------------------------------------
-- Gatilhos. As duas funções já existem no schema e servem qualquer tabela.
-- ---------------------------------------------------------------------
DROP TRIGGER IF EXISTS tg_cc_list_touch ON rapid_inv.cc_list;
CREATE TRIGGER tg_cc_list_touch BEFORE UPDATE ON rapid_inv.cc_list
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_cc_list_item_touch ON rapid_inv.cc_list_item;
CREATE TRIGGER tg_cc_list_item_touch BEFORE UPDATE ON rapid_inv.cc_list_item
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_cc_round_touch ON rapid_inv.cc_round;
CREATE TRIGGER tg_cc_round_touch BEFORE UPDATE ON rapid_inv.cc_round
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_cc_round_line_touch ON rapid_inv.cc_round_line;
CREATE TRIGGER tg_cc_round_line_touch BEFORE UPDATE ON rapid_inv.cc_round_line
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

DROP TRIGGER IF EXISTS tg_cc_recipient_touch ON rapid_inv.cc_recipient;
CREATE TRIGGER tg_cc_recipient_touch BEFORE UPDATE ON rapid_inv.cc_recipient
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_touch_updated_at();

-- Auditoria: a lista e a rodada. NÃO em cc_round_line — 101 linhas por rodada
-- × 8 filiais × 4 semanas gera 3.232 linhas de log por mês de digitação
-- normal, e log que enche de ruído é log que ninguém abre.
DROP TRIGGER IF EXISTS tg_cc_list_audit ON rapid_inv.cc_list;
CREATE TRIGGER tg_cc_list_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.cc_list
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS tg_cc_list_item_audit ON rapid_inv.cc_list_item;
CREATE TRIGGER tg_cc_list_item_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.cc_list_item
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS tg_cc_round_audit ON rapid_inv.cc_round;
CREATE TRIGGER tg_cc_round_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.cc_round
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

DROP TRIGGER IF EXISTS tg_cc_recipient_audit ON rapid_inv.cc_recipient;
CREATE TRIGGER tg_cc_recipient_audit AFTER INSERT OR UPDATE OR DELETE ON rapid_inv.cc_recipient
  FOR EACH ROW EXECUTE FUNCTION rapid_inv.fn_audit_log();

-- ---------------------------------------------------------------------
-- CUSTO — de onde sai o unit_cost_aud congelado.
--
-- Medido nos 101 SKUs das listas A + B + mensal:
--     cin7_mirror.products.average_cost   101/101
--     rapid_inv.v_sp_sku_cost               7/101   (alimentado por Excel manual)
--
-- Uma view própria para o congelamento ter UM lugar para ler, e para trocar
-- a fonte depois sem mexer no código de disparo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_cc_sku_cost AS
SELECT upper(btrim(p.sku)) AS sku,
       p.average_cost      AS unit_cost_aud
  FROM cin7_mirror.products p
 WHERE p.sku IS NOT NULL
   AND p.average_cost IS NOT NULL
   AND p.average_cost > 0;

-- ---------------------------------------------------------------------
-- ESTOQUE POR FILIAL — a fonte do system_qty.
--
-- ATENÇÃO: `ref/productavailability` do Cin7 OMITE item com quantidade zero,
-- então o mirror não tem linha para SKU zerado. Ausência = 0, não desconhecido.
-- É por isso que o congelamento usa COALESCE(...,0) — igual ao
-- IF(ISNA(VLOOKUP(...)),0,...) que o próprio workbook faz.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW rapid_inv.v_cc_branch_soh AS
SELECT w.code                  AS branch_code,
       upper(btrim(ss.sku))    AS sku,
       sum(ss.on_hand)         AS on_hand,
       sum(ss.available)       AS available,
       max(ss.synced_at)       AS synced_at
  FROM cin7_mirror.stock_snapshot ss
  JOIN rapid_inv.warehouses w
    ON w.cin7_location_name = ss.location_name
   AND w.is_active
 GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- O BOARD — uma linha por rodada. Alimenta a tabela de gestão e os KPIs.
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
       -- Linhas sem custo: sem isto, o total em dólares mente para menos e
       -- ninguém sabe que mentiu.
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

-- ---------------------------------------------------------------------
-- O SUMMARY — substitui `Stock Count Summary - <mês>.xlsx`.
--
-- Lá era uma coluna por data de contagem, remontada à mão todo mês. Aqui é
-- uma linha por (filial, SKU, semana) e o pivô é problema da tela.
-- Só rodada entregue entra: rodada aberta não é histórico.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- O QUE ESTÁ ESPERANDO ALGUÉM.
--
-- Brisbane por AT TIME ZONE porque aqui as colunas são TIMESTAMPTZ de
-- verdade — o `+ INTERVAL '10 hours'` do TMS existe lá porque lá é
-- naive-UTC. Copiar aquela regra para cá erra o horário de verão.
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- Permissões.
--
-- 000_grants deu SELECT a anon/authenticated em TODA tabela nova do schema,
-- por ALTER DEFAULT PRIVILEGES. Para duas destas isso é errado:
--   cc_round     — guarda o token, que é a credencial de contagem
--   cc_recipient — guarda e-mail de pessoa
-- rapid_inv não está exposto no PostgREST hoje, então isto é defesa em
-- profundidade: no dia em que alguém expuser o schema, o token não vaza junto.
-- ---------------------------------------------------------------------
GRANT ALL ON ALL TABLES    IN SCHEMA rapid_inv TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA rapid_inv TO service_role, postgres;

REVOKE ALL ON rapid_inv.cc_round     FROM anon, authenticated;
REVOKE ALL ON rapid_inv.cc_recipient FROM anon, authenticated;
REVOKE ALL ON rapid_inv.cc_email_log FROM anon, authenticated;
REVOKE ALL ON rapid_inv.v_cc_round_summary FROM anon, authenticated;
REVOKE ALL ON rapid_inv.v_cc_open          FROM anon, authenticated;

DO $$
DECLARE n_wh INT;
BEGIN
  SELECT count(*) INTO n_wh FROM rapid_inv.warehouses WHERE cc_enabled;
  RAISE NOTICE '001_core: cyclic count pronto — % depositos no ciclo', n_wh;
END $$;
