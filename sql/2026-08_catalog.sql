-- ═══════════════════════════════════════════════════════════════════════════
-- ops.cin7_resource + ops.cin7_resource_state
-- O CATÁLOGO DE RECURSOS Cin7 como tabela consultável.
--
-- Espelho SQL de core/cin7/catalog.js. O JS é a fonte para código; ESTA tabela
-- é a fonte para SQL, para o Sync Monitor e para qualquer feature futura que
-- precise perguntar "de onde vem este número e quanto custa buscá-lo de novo"
-- sem abrir um require().
--
-- Duas tabelas, dois papéis:
--   cin7_resource       — o CONTRATO. Muda quando o desenho muda. Semeado aqui.
--   cin7_resource_state — o RELÓGIO por RECURSO. Cursor, última execução,
--                         linhas vistas, chamadas gastas, status.
--
-- NOME: por que `cin7_resource_state` e não `cin7_sync_state`.
--   `ops.cin7_sync_state` JÁ EXISTE — core/cin7/sql/001_cin7_sync_state.sql, o
--   estado do EXECUTOR, com PK (job, chunk_key), lease/claim e um driver em
--   cima (core/cin7/backfill-driver.js). Grão diferente: lá é um chunk de
--   trabalho, aqui é um recurso do catálogo. Usar o mesmo nome seria pior que
--   feio: CREATE TABLE IF NOT EXISTS não falha, ele NÃO FAZ NADA — quem
--   aplicasse por segundo herdaria a tabela do outro e só descobriria no
--   primeiro INSERT, com "column does not exist". Este arquivo é ADITIVO:
--   não cria, não altera e não apaga nada de 001_cin7_sync_state.sql.
--   A ponte entre os dois é a coluna `job_key` (abaixo) e a view
--   ops.v_cin7_backfill_progress, que ROLA o executor por recurso.
--
-- Por que separado de ops.sync_registry (features/excel-sync/db/001_ops_registry.sql):
--   sync_registry é por WORKFLOW ("cin7-movements roda a cada 6h e está verde").
--   Aqui é por RECURSO ("stockAdjustment tem 3.482 tarefas na janela, custa 3.490
--   chamadas, ninguém as trouxe, e quem lê é pa-movements.js:60"). Um workflow
--   toca vários recursos; um recurso pode não ter workflow nenhum. Os dois
--   convivem — este arquivo não altera sync_registry.
--
-- APLICAR: cole o arquivo inteiro no SQL Editor do Supabase (projeto Labels).
--   O Labels é um banco SEPARADO do TMS — não vai por apply_sql.py.
--   Idempotente: CREATE ... IF NOT EXISTS + ON CONFLICT DO UPDATE. Re-rodar
--   atualiza o contrato e NÃO toca o estado de sincronização.
--
-- LIMITE DE API: 60 req/min POR CONTA, compartilhado com TMS + app
--   (docs/SYNC_WORKFLOWS.md:3-5). Throttles reais: 2500ms = 24/min,
--   4000ms = 15/min (o default de backfill-sales.js:35).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS ops;

-- ───────────────────────────────────────────────────────────────────────────
-- 1) CONTRATO — um recurso do Cin7 por linha.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.cin7_resource (
  id                     TEXT PRIMARY KEY,      -- casa com RESOURCES[].id no JS
  status                 TEXT NOT NULL,         -- IMPLEMENTADO | PARCIAL | A CONSTRUIR
  implemented_by         TEXT,                  -- arquivo:linha que faz o trabalho hoje
  domain                 TEXT NOT NULL,         -- sales | stock | movement | purchase | master

  -- endpoint
  cin7_endpoint          TEXT,                  -- recurso de DETALHE
  list_endpoint          TEXT,                  -- recurso de LISTA que enumera ids
  page_param             TEXT,
  limit_param            TEXT,
  max_page_size          INT,
  -- NULL = a lista IGNORA filtro de data. Medido, não suposto:
  -- ref/productavailability (ARCHITECTURE.md:27,:68), stockTransferList,
  -- stockAdjustmentList e finishedGoodsList ignoram; purchaseList HONRA.
  cursor_param           TEXT,

  -- destino
  target_schema          TEXT,
  target_table           TEXT,
  upsert_key             TEXT,                  -- ON CONFLICT, ou a estratégia de dedup
  cin7_id_field          TEXT,

  -- como o dado chega
  mechanism              TEXT NOT NULL,         -- webhook | ciclo | sob-demanda | backfill
  webhook_events         TEXT[] DEFAULT '{}',
  cycle_cron             TEXT,                  -- cron UTC do workflow, ou NULL

  -- custo (toda estimativa tem conta em `notes`)
  estimated_rows_month   NUMERIC,
  list_calls_per_pass    INT,                   -- NULL = derivar de ceil(linhas/max_page_size)
  calls_per_row          NUMERIC DEFAULT 0,
  calls_per_full_pass    INT,                   -- congelado p/ 2025-08-01 → 2026-08-26
  backfill_since         DATE,                  -- NULL = não backfillável

  consumers              TEXT[] DEFAULT '{}',   -- sem consumidor nomeado, não entra
  -- Ponte para o executor: o `job` correspondente em ops.cin7_sync_state
  -- (core/cin7/plan.js). NULL = este recurso não é dirigido pelo driver.
  job_key                TEXT,
  notes                  TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cin7_resource_mechanism_chk
    CHECK (mechanism IN ('webhook','ciclo','sob-demanda','backfill')),
  CONSTRAINT cin7_resource_status_chk
    CHECK (status IN ('IMPLEMENTADO','PARCIAL','A CONSTRUIR')),
  -- A regra número 1 do catálogo, aplicada pelo banco.
  -- COALESCE não é enfeite: array_length('{}', 1) devolve NULL, e um CHECK que
  -- avalia NULL PASSA. Sem o COALESCE a trava aceita exatamente a linha que
  -- deveria barrar — a de consumers vazio.
  CONSTRAINT cin7_resource_has_consumer_chk
    CHECK (COALESCE(array_length(consumers, 1), 0) >= 1)
);

-- Reparo para bancos onde a tabela foi criada por uma versão anterior deste
-- arquivo: CREATE TABLE IF NOT EXISTS não corrige constraint de tabela que já
-- existe, então a troca precisa ser explícita.
--
-- Se houver linha órfã, o ALTER falha com "is violated by some row" e NÃO diz
-- qual. Nomeamos as culpadas antes, para que o erro seja acionável em vez de
-- mandar alguém caçar no escuro.
DO $$
DECLARE culpadas TEXT;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id) INTO culpadas
    FROM ops.cin7_resource
   WHERE COALESCE(array_length(consumers, 1), 0) = 0;
  IF culpadas IS NOT NULL THEN
    RAISE EXCEPTION
      'Recurso sem consumidor nomeado: %. Regra 1 do catálogo: dê um consumidor a essas linhas ou apague-as, e rode de novo.',
      culpadas;
  END IF;
END $$;

ALTER TABLE ops.cin7_resource DROP CONSTRAINT IF EXISTS cin7_resource_has_consumer_chk;
ALTER TABLE ops.cin7_resource ADD  CONSTRAINT cin7_resource_has_consumer_chk
  CHECK (COALESCE(array_length(consumers, 1), 0) >= 1);

CREATE INDEX IF NOT EXISTS idx_cin7_resource_domain    ON ops.cin7_resource (domain);
CREATE INDEX IF NOT EXISTS idx_cin7_resource_mechanism ON ops.cin7_resource (mechanism);
CREATE INDEX IF NOT EXISTS idx_cin7_resource_status    ON ops.cin7_resource (status);
CREATE INDEX IF NOT EXISTS idx_cin7_resource_backfill  ON ops.cin7_resource (backfill_since)
  WHERE backfill_since IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2) RELÓGIO — onde cada recurso parou. Uma linha por recurso.
--
-- Isto NÃO substitui nem toca as outras duas tabelas de progresso que já
-- existem — cin7_mirror.backfill_state (backfill-sales.js) e
-- ops.cin7_sync_state (o executor de chunks). É a camada ACIMA das duas:
-- "este RECURSO foi visto pela última vez em X, custou Y chamadas, está
-- verde/amarelo/vermelho". Quem roda pelo driver não precisa escrever aqui —
-- a view ops.v_cin7_backfill_progress deriva o mesmo do executor.
--
-- last_cursor é TEXT de propósito: para saleList é um ISO, para
-- stockAdjustmentList é um número de página, para finishedGoodsList é um
-- índice de cauda. Guardar o tipo nativo obrigaria uma coluna por formato.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.cin7_resource_state (
  resource_id      TEXT PRIMARY KEY
                     REFERENCES ops.cin7_resource(id) ON DELETE CASCADE,
  last_cursor      TEXT,                        -- ISO, nº de página, ou índice — ver acima
  last_page        INT,
  last_run_at      TIMESTAMPTZ,                 -- última TENTATIVA
  last_ok_at       TIMESTAMPTZ,                 -- última que terminou sem erro
  rows_seen        BIGINT      NOT NULL DEFAULT 0,
  calls_made       BIGINT      NOT NULL DEFAULT 0,
  status           TEXT        NOT NULL DEFAULT 'idle',
  last_error       TEXT,
  -- Meta da janela: quantas linhas esperamos e quantas já processamos. Sem
  -- isto não há como um backfill de 33.100 chamadas declarar que terminou.
  total_target     BIGINT,
  processed        BIGINT      NOT NULL DEFAULT 0,
  done             BOOLEAN     NOT NULL DEFAULT FALSE,
  stats            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cin7_resource_state_status_chk
    CHECK (status IN ('idle','running','ok','partial','failed','blocked'))
);

CREATE INDEX IF NOT EXISTS idx_cin7_res_state_status  ON ops.cin7_resource_state (status);
CREATE INDEX IF NOT EXISTS idx_cin7_res_state_last_ok ON ops.cin7_resource_state (last_ok_at DESC NULLS LAST);

-- updated_at que não depende de quem escreve lembrar dele.
CREATE OR REPLACE FUNCTION ops.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_cin7_resource_touch   ON ops.cin7_resource;
CREATE TRIGGER trg_cin7_resource_touch   BEFORE UPDATE ON ops.cin7_resource
  FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_cin7_res_state_touch ON ops.cin7_resource_state;
CREATE TRIGGER trg_cin7_res_state_touch BEFORE UPDATE ON ops.cin7_resource_state
  FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) SEED — o catálogo, na mesma ordem de core/cin7/catalog.js.
--    ON CONFLICT DO UPDATE: o contrato é sobrescrito, o relógio nunca.
-- ═══════════════════════════════════════════════════════════════════════════
INSERT INTO ops.cin7_resource (
  id, status, implemented_by, domain,
  cin7_endpoint, list_endpoint, page_param, limit_param, max_page_size, cursor_param,
  target_schema, target_table, upsert_key, cin7_id_field,
  mechanism, webhook_events, cycle_cron,
  estimated_rows_month, list_calls_per_pass, calls_per_row, calls_per_full_pass,
  backfill_since, consumers, notes
) VALUES
-- job_key é preenchido logo abaixo do seed, num UPDATE separado: mantém as 34
-- linhas de VALUES legíveis e deixa o mapeamento driver↔catálogo num lugar só.

-- ── VENDAS: cabeçalho ─────────────────────────────────────────────────────
('sale_header_backfill','IMPLEMENTADO','cin7-stock-sync/backfill-sales.js:148-166 (modo `headers`)','sales',
 'saleList','saleList','Page','Limit',1000,'CreatedSince',
 'cin7_mirror','sales_orders','order_number','SaleID',
 'backfill','{}',NULL,
 1300,NULL,0,17,
 DATE '2025-08-01',
 ARRAY['features/analytics/db/001_analytics_views.sql:35-56 (v_an_monthly_sales)',
       'features/logistics/open-orders.js:59',
       'features/logistics/invoicing-monitor.js:242',
       'features/wms/lib/wms-engine.js:109',
       'home.js:1220'],
 'JÁ PAGO — 78.256 pedidos desde 2021 (001_analytics_views.sql:8). Conta: 13 x 1.300 = 16.900; /1000 = 17 páginas. '
 'ARMADILHA: o checkpoint chama-se sempre "sales_headers" e NÃO guarda o SINCE (backfill-sales.js:150); `done` é gravado '
 'ao sair do laço por qualquer motivo (:163). Re-rodar com outro BACKFILL_SINCE retoma em last_page+1 de OUTRO conjunto '
 'e pula tudo em silêncio. Zere o checkpoint, ou use um job por janela.'),

('sale_header_cycle','IMPLEMENTADO','cin7-stock-sync/backfill-sales.js:247-263 (modo `sync`)','sales',
 'saleList','saleList','Page','Limit',1000,'UpdatedSince',
 'cin7_mirror','sales_orders','order_number','SaleID',
 'ciclo','{}','10 */2 * * *',
 1300,2,0,0,
 NULL,
 ARRAY['features/logistics/open-orders.js:59',
       'features/excel-sync (dataset monthly-sales)',
       'rapid_inv.v_an_monthly_sales'],
 'CICLO porque o Cin7 NÃO tem webhook de pedido criado. Janela de 3h a cada 2h = 1h de sobreposição. '
 'Escreve SÓ cabeçalho: mapHeader (:76-90) não toca sale_lines — é por isso que "cabeçalho completo" e "linha vazia" '
 'convivem. Workflow: cin7-sales-sync.yml:17.'),

('sale_status_reconcile','PARCIAL','cin7-stock-sync/reconcile-sales.js:70-113','sales',
 'saleList','saleList','Page','Limit',10,NULL,
 'cin7_mirror','sales_orders','order_number','OrderNumber',
 'ciclo','{}','40 15 * * *',
 0,200,1,0,
 NULL,
 ARRAY['features/logistics/open-orders.js:59','features/logistics/invoicing-monitor.js:242'],
 'Backstop de webhook perdido: 1 chamada Search POR PEDIDO, CAP=200/run (yml:40). RECONCILE_SO_SINCE já é 2025-08-01 (:31). '
 'NÃO é backfill: 16.900 pedidos a 200/dia = 85 dias. mapStatus (:57-68) escreve só status/valor — nenhuma linha. '
 'O comentário do yml:16 diz "a cada 6h" e mente: o cron é diário.'),

-- ── VENDAS: detalhe (o buraco principal) ──────────────────────────────────
('sale_detail_month','PARCIAL','cin7-stock-sync/backfill-sales.js:279-368 (modo `detail-month`)','sales',
 'sale?ID={SaleID}',NULL,NULL,NULL,1,NULL,
 'cin7_mirror','sale_lines','order_number,line_no','SaleID',
 'ciclo','{}','0 19 * * 0-4',
 1300,0,1,16900,
 DATE '2025-08-01',
 ARRAY['features/stock-planning/db/006_overview_views.sql:198-213 (v_sp_actual_weekly)',
       'features/stock-planning/db/010_wkavg_drift.sql:13-37',
       'features/analytics/db/001_analytics_views.sql:128-130 (backorder)',
       'features/excel-sync/specs/datasets/monthly-sales.toml (gate min_detail_coverage_pct = 99)',
       'features/logistics/open-orders.js:256',
       'home.js:1220-1224'],
 'ÚNICO modo que fecha um mês: qualquer status (só derruba VOIDED/CANCELLED, :320-321), re-busca o que o Cin7 mudou '
 '(:327-328) e poda linha órfã (pruneStaleLines, :362). O cron só alcança mês corrente + 1 anterior '
 '(DETAIL_MONTH_BACK=1 fixo em cin7-sales-detail-month.yml:75) e o modo só existe desde 2026-08-08 — daí o buraco de '
 '2025-08 a 2026-06, medido pelo próprio repo em 006_overview_views.sql:193. '
 'BACKFILL: 16.900 chamadas (13 x 1.300 x 1) = 11,7h a 24/min, 18,8h a 15/min. Os cabeçalhos do mês vêm do SUPABASE, '
 'não do Cin7 (:300-308) → 0 chamada de lista. ARMADILHA: com BACK=1 um dispatch para 2025-08 varre 2 meses (~2.600) '
 'contra DETAIL_MONTH_CAP=2000 (yml:76), e 2.000 x 2,5s = 83min contra timeout-minutes: 90 (yml:54). '
 'Para os 11 meses: rodar local com DETAIL_MONTH_BACK=0, um mês por vez.'),

('sale_detail_open','PARCIAL','cin7-stock-sync/backfill-sales.js:210-241 (modo `detail-open`)','sales',
 'sale?ID={SaleID}',NULL,NULL,NULL,1,NULL,
 'cin7_mirror','sale_lines','order_number,line_no','SaleID',
 'ciclo','{}','5 */6 * * *',
 0,0,1,0,
 NULL,
 ARRAY['features/logistics/open-orders.js:256','features/logistics/open-orders-notes.js:132'],
 'ESTRUTURALMENTE INCAPAZ de fechar histórico, de propósito: filtra shipping_status <> SHIPPED e '
 'order_status = AUTHORISED (:217), e só aceita detail_synced_at IS NULL (:219). Pedido de 2025 já embarcou → nunca é '
 'candidato. NÃO chama pruneStaleLines (:235). Cap 60/run (cin7-open-detail-sync.yml:41).'),

('sale_detail_recent','PARCIAL','cin7-stock-sync/backfill-sales.js:167-201 (modo `detail`) — sem workflow','sales',
 'sale?ID={SaleID}',NULL,NULL,NULL,1,NULL,
 'cin7_mirror','sale_lines','order_number,line_no','SaleID',
 'sob-demanda','{}',NULL,
 0,0,1,0,
 NULL,
 ARRAY['public.pick_anomaly_orders (via pick-anomalies-engine, backfill-sales.js:194)'],
 'NÃO usar para a meta. Janela cin7_updated >= now-14d (:171,:179): pedido de 2025 que o Cin7 não tocou é inalcançável '
 'para sempre. Não está em nenhum workflow. Marca detail_synced_at MESMO em falha (:188). Não poda linha (:193). '
 'Está no catálogo porque o modo existe e alguém vai encontrá-lo — esta linha é o aviso.'),

-- ── VENDAS: webhooks ──────────────────────────────────────────────────────
('sale_webhook_ship','PARCIAL','cin7-stock-sync/movement-processor.js:102-105,240-330 + sales-mirror.js:42-56','sales',
 'sale?ID={SaleID}',NULL,NULL,NULL,1,NULL,
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=webhook) — movement-processor.js:158-165','SaleID',
 'webhook',ARRAY['Sale/ShipmentAuthorised'],NULL,
 1300,0,1,0,
 NULL,
 ARRAY['features/pick-anomalies/pick-anomalies-engine.js:319 (bin de origem do pick)',
       'features/pick-anomalies/pa-movements.js:60-62',
       'home.js:543-569',
       'cin7-stock-sync/verify-coverage.js:149'],
 'WEBHOOK e não ciclo: é a saída física de estoque e a análise de anomalia precisa de latência zero. Único evento de '
 'venda que ENRIQUECE (1 chamada). TRÊS DEFEITOS ATIVOS: (1) upsertSalesMirror NÃO poda linha (sales-mirror.js:55) — '
 're-embarque acumula órfã, foi assim que SO-281413 ficou com 149 linhas contra 100; (2) mapSaleLines (:43-47) não grava '
 'backorder_quantity, que mapLines grava (backfill-sales.js:115) e 3 views do analytics leem; (3) o `return []` em :264 '
 'marca o evento como processed com zero movimentos quando o fetch falha, e o mirror nem roda (está depois, :288). '
 'NÃO RETROAGE: nasce em 2026-06-19 (commit 5f6c587).'),

('sale_webhook_status','IMPLEMENTADO','cin7-stock-sync/movement-processor.js:106-126','sales',
 NULL,NULL,NULL,NULL,NULL,NULL,
 'cin7_mirror','sales_orders','order_number','OrderNumber',
 'webhook',ARRAY['Sale/Voided','Sale/Undo','Sale/InvoiceAuthorised'],NULL,
 0,0,0,0,
 NULL,
 ARRAY['features/logistics/invoicing-monitor.js:242,255',
       'features/logistics/open-orders.js:59',
       'public.pick_anomaly_orders (markOrderCancelledRealtime)'],
 'ZERO chamadas ao Cin7 — reflexo local do payload. Sale/Undo é gravado cru DE PROPÓSITO (:109-110): reverte para status '
 'desconhecido e o sync de 2h reconcilia honestamente.'),

('sale_webhook_stage','A CONSTRUIR',NULL,'sales',
 NULL,NULL,NULL,NULL,NULL,NULL,
 'cin7_mirror','order_stage_events','order_id,stage','SaleID',
 'webhook',ARRAY['Sale/PickAuthorised','Sale/PackAuthorised','Sale/ShipmentAuthorised'],NULL,
 3900,0,0,0,
 NULL,
 ARRAY['cin7_mirror.order_stage_events (tempo-em-estágio do board)',
       'docs/PIPELINE_CONTROL_TOWER_PLAN.md'],
 'O SQL PROMETE E O CÓDIGO NÃO CUMPRE: sql/order_stage_events.sql:48-50 documenta upsert de picked/packed/shipped no '
 'instante do evento; movement-processor.js:127-131 joga Pick/PackAuthorised no ramo else ("recorded raw"). O único '
 'produtor real é o carimbo HORÁRIO de order-pipeline-sync.js:696-724 (source=sync) → resolução de 1h, e só desde '
 '2026-03. Os tópicos JÁ estão registrados (webhook-config.js:29-30): o conserto é escrever o handler, custo 0 chamadas.'),

('sale_credit_note','A CONSTRUIR',NULL,'sales',
 'sale?ID={SaleID} (bloco de credit note)','saleList','Page','Limit',1000,'CreatedSince',
 'cin7_mirror','sale_credit_lines','order_number,line_no','SaleID',
 'webhook',ARRAY['Sale/CreditNoteAuthorised'],NULL,
 39,0,0,0,
 DATE '2025-08-01',
 ARRAY['features/stock-planning/db/006_overview_views.sql:203 (v_sp_actual_weekly — hoje soma BRUTA)',
       'features/returns/returns.js:836 (credit_note digitado à mão, sem write-back)'],
 'COBERTURA ZERO. Sale/CreditNoteAuthorised está na taxonomia (webhook-config.js:9) e FORA de OUR_EVENTS (:24-32). '
 'Só existe sales_orders.credit_note_number, um TEXT (2026-06-17_sales_mirror.sql:54). Consequência: toda demanda '
 'calculada é BRUTA — nenhuma view subtrai devolução. CUSTO INCREMENTAL DO HISTÓRICO = 0 CHAMADAS: o JSON de sale?ID= '
 'que o backfill de detalhe já busca carrega o bloco de credit note. É mapeamento + tabela nova, não API.'),

('sale_lookup_live','IMPLEMENTADO','server.js:198-238 (/api/sale) e server.js:541-680 (/api/sale/:number)','sales',
 'sale?ID={SaleID}','saleList','Page','Limit',20,NULL,
 NULL,NULL,NULL,'SaleID',
 'sob-demanda','{}',NULL,
 0,1,1,0,
 NULL,
 ARRAY['features/returns/returns.js:432-439 (busca do SO na tela de devolução)',
       'home.js:1227+ (fallback ao vivo quando não há espelho)'],
 'SOB-DEMANDA porque é o operador digitando um número que pode não estar no espelho. 2 chamadas por leitura '
 '(Search + detalhe) e ZERO tratamento de 429 (grep "429" em server.js = 0 ocorrências). Depois do backfill, ler '
 'sale_lines primeiro e cair para o Cin7 só quando não houver linha — o padrão que home.js:1220-1227 já faz. '
 'NADA é persistido.'),

('order_pipeline','PARCIAL','order-pipeline-sync.js:255-300,613-645,696-724','sales',
 'saleList / stockTransferList (por Status)','saleList','Page','Limit',500,'CreatedSince',
 'cin7_mirror','order_pipeline','id','SaleID | TaskID',
 'ciclo','{}','35 * * * *',
 0,15,0,0,
 NULL,
 ARRAY['features/transfer-out/transfer-out.js:31 (type=TR, from=Main)',
       'features/stock-planning/routes/stock-planning-routes.js:466,495 (/find/orders)',
       'features/rapid-inventory/dashboard.html:1025 (v_open_sos)',
       'home.js (board do armazém)'],
 'NÃO É HISTÓRICO E NUNCA VAI SER: sinceDate hardcoded 2026-03-01 (:48) e cleanupCompleted APAGA '
 'COMPLETED/VOIDED/CLOSED com completed_at > 7 dias (:613-645). Janela viva de ~1.752 linhas. É o SEGUNDO espelho do '
 'mesmo pedido: chave id=SaleID contra sales_orders.order_number → duas noções de "aberto" que podem discordar na tela. '
 'server.js:296-302 roda o mesmo sync por setInterval SEM guarda de VERCEL, duplicando o cron.'),

('pick_anomaly_batch','IMPLEMENTADO','features/pick-anomalies/pick-anomalies-engine.js:783,873,954-964','sales',
 'sale?ID={SaleID} + finishedGoods?TaskID={id}','saleList','Page','Limit',100,'UpdatedSince',
 'public','pick_anomaly_orders','order_number','SaleID',
 'ciclo',ARRAY['Sale/ShipmentAuthorised'],'30 3,15 * * *',
 0,3,1,0,
 NULL,
 ARRAY['features/pick-anomalies/pick-anomalies.html (monitor de anomalias)',
       'features/pick-anomalies/pa-movements.js'],
 'CICLO como BACKSTOP do webhook, não como fonte: a análise real acontece no ship (movement-processor.js:262-268). '
 'Cap 200/run a 2,5s. O saleList usa UpdatedSince, que filtra por LastModifiedOn e NÃO por OrderDate (engine:24).'),

-- ── ESTOQUE ───────────────────────────────────────────────────────────────
('stock_snapshot_bin','IMPLEMENTADO','cin7-stock-sync/sync-service.js:253-257,461-480,681-715','stock',
 'ref/productavailability','ref/productavailability','Page','Limit',1000,NULL,
 'cin7_mirror','stock_snapshot','sku,location_name,bin,batch','SKU + Location + Bin + Batch',
 'ciclo','{}','0 * * * *',
 0,15,0,0,
 NULL,
 ARRAY['features/pick-anomalies/pick-anomalies-engine.js:319 (EXIGE grão de bin)',
       'features/replenishment/replenishment.js:358',
       'features/stock-planning/db/007_live_stock.sql:56,70',
       'features/excel-sync/db/006_restock_suggestion.sql:91',
       'restock-v2.html:728',
       'home.js:125,149'],
 'CICLO e não webhook POR DECISÃO: Stock/AvailableStockLevelChanged é firehose e está deliberadamente fora de '
 'OUR_EVENTS (webhook-config.js:22-23). ref/productavailability NÃO aceita ModifiedSince — testado contra a API real '
 '(ARCHITECTURE.md:27,:68, "confirmed: ModifiedSince returned same Total"). Por isso cursor_param é NULL. '
 'Conta: 14.971 linhas / 1000 = 15 chamadas; o laço para quando a página vem com <1000 (:242). 24 exec/dia = 360 '
 'chamadas/dia. TRUNCATE+INSERT a cada hora (clearStockSnapshot :704, RPC em schema.sql:255-263) — é o AGORA, nunca a '
 'série. Bin/Batch/ExpiryDate vêm de graça na mesma resposta (:468-470); não existe flag CIN7_INCLUDE_BINS neste repo.'),

('stock_availability_sku','PARCIAL','cin7-stock-sync/sync-availability.js:46-90','stock',
 'ref/productavailability','ref/productavailability','Page','Limit',1000,NULL,
 'cin7_mirror','stock_availability','sku,location','SKU + Location',
 'ciclo','{}','30 */4 * * *',
 0,15,0,0,
 NULL,
 ARRAY['cin7_mirror.chase_list (sql/2026-06-18_chase_automation.sql:80-81)',
       'features/logistics/open-orders-notes.js:132'],
 'SEGUNDA VARREDURA DO MESMO ENDPOINT: 90 chamadas/dia (6 x 15) sobre o recurso que stock_snapshot já varre 360x/dia. '
 'docs/SYNC_WORKFLOWS.md:88 já estima "−90 Cin7 calls/day" ao aposentá-lo. PROVAVELMENTE ERRADO HOJE: :59-60 faz '
 'on_order += e in_transit += ATRAVÉS das linhas de bin, mas ambos são grandezas por LOCALIZAÇÃO (schema.sql:85,:87). '
 '14.971 linhas colapsam em 12.681 chaves → ~2.290 pares com mais de um bin têm o número MULTIPLICADO. '
 'CAMINHO SEM RISCO: virar VIEW sobre stock_snapshot com sum() em on_hand/allocated/available e MAX() em '
 'on_order/in_transit — chase_list e open-orders-notes continuam lendo o mesmo nome, sem tocar em nenhum dos dois.'),

('stock_daily_history','A CONSTRUIR',NULL,'stock',
 NULL,NULL,NULL,NULL,NULL,NULL,
 'cin7_mirror','stock_daily','snapshot_date,sku,location_name,bin,batch',NULL,
 'ciclo','{}','0 * * * *',
 449130,0,0,0,
 NULL,
 ARRAY['features/stock-planning/db/006_overview_views.sql:12-13 (giro/DIO — hoje IMPOSSÍVEL)',
       'features/stock-planning (roll-week: foto da semana de reporte)',
       'features/analytics (estoque médio, ruptura, cobertura histórica)'],
 'NÃO É COMPRÁVEL DO CIN7 A NENHUM PREÇO: ref/productavailability não aceita ModifiedSince (ARCHITECTURE.md:27,:68) e '
 'não há endpoint de saldo em data passada. backfill_since é NULL DE PROPÓSITO — 2025-08-01 → hoje é irrecuperável e o '
 'contrato precisa dizer isso por escrito. PARA FRENTE custa ZERO chamada: INSERT..SELECT de stock_snapshot ANTES do '
 'TRUNCATE (sync-service.js:704), no mesmo job que já baixou as linhas (o padrão de cin7-sync.yml:48-49). '
 'Volume: 14.971 linhas/dia x 30 = 449.130/mês no grão de bin. Se pesar, gravar (sku,location) e manter bin só nos '
 'últimos N dias.'),

('stock_availability_by_sku_live','IMPLEMENTADO','features/wms/lib/cin7-wms-client.js:178-181','stock',
 'ref/productavailability?Sku={sku}',NULL,NULL,'Limit',50,NULL,
 NULL,NULL,NULL,'SKU',
 'sob-demanda','{}',NULL,
 0,0,1,0,
 NULL,
 ARRAY['features/wms/lib/wms-engine.js:258-262 (stockLookup; 1 chamada POR COMPONENTE em assembly)'],
 'SOB-DEMANDA porque é o operador no chão pedindo o bin de um SKU. CUSTO VIVO E IMPREVISÍVEL no pico do armazém, '
 'exatamente quando os crons rodam. O dado JÁ está em stock_snapshot no mesmo grão com até 60 min de idade — trocar por '
 'uma view wms.v_bin_stock custa 0 chamada. CLAUDE.md proíbe prometer indicador de sync no WMS: mostre rótulo de '
 'FRESCOR, não ícone.'),

-- ── MOVIMENTO: transferência / ajuste / montagem (SEM WEBHOOK NO CIN7) ────
('transfer_header','PARCIAL','cin7-stock-sync/sync-transfers.js:51-74','movement',
 'stockTransferList','stockTransferList','Page','Limit',500,NULL,
 'cin7_mirror','stock_transfers','task_id','TaskID',
 'ciclo','{}','45 */2 * * *',
 2550,NULL,0,67,
 DATE '2025-08-01',
 ARRAY['features/logistics/open-orders.js:79-100 (Branch Transfers control tower)',
       'home.js:1277-1500 (tabela de TRs + Find TR)',
       'features/gateway/gateway-inventory-engine.js:516',
       'features/analytics/db/001_analytics_views.sql:152-177'],
 'CICLO OBRIGATÓRIO: o Cin7 NÃO tem webhook de transferência (taxonomia em webhook-config.js:9-16; sync-transfers.js:3 '
 'diz "Cin7 has NO transfer webhook"). ORDENAÇÃO MEDIDA: a lista é por CRIAÇÃO, não por LastModifiedOn — página P '
 'devolve TR-(50090−P), verificado em 12 sondagens. Logo o comentário de :65 ("most-recently-modified → catches '
 'completions") é FALSO: status não reordena a lista, e é essa a causa-raiz dos 232 fantasmas de IN TRANSIT. A lista '
 'IGNORA UpdatedSince/ModifiedSince (medido; reconcile-transfers.js:9 registra o mesmo). '
 'BURACO: sync busca IN TRANSIT + DRAFT (:64) mas open-orders.js:79 filtra por ORDERED — status que a lista NUNCA busca. '
 'COLUNAS MORTAS: line_count, total_qty, required_by (DDL em 2026-06-17_sales_mirror.sql:120-122) nunca são escritas e '
 'open-orders.js:84,91 e home.js:1316 as renderizam em branco. '
 'BACKFILL: Total medido hoje = 50.089; corte de 2025-08-01 em ~TR-17.000 (índice ~33.100) → 67 páginas ≈ 4,5 min.'),

('transfer_reconcile','PARCIAL','cin7-stock-sync/reconcile-transfers.js:79-113','movement',
 'stockTransferList?Search={number}','stockTransferList','Page','Limit',10,NULL,
 'cin7_mirror','stock_transfers','task_id','TaskID',
 'ciclo','{}','20 3 * * *',
 0,2,1,0,
 NULL,
 ARRAY['features/logistics/open-orders.js:79 (fecha TR fantasma no quadro)'],
 'CONJUNTOS ABERTOS DIVERGENTES: reconcile fecha IN TRANSIT + ORDERED (:79-80), sync busca IN TRANSIT + DRAFT '
 '(sync-transfers.js:64). ORDERED nunca é varrido, DRAFT nunca é reconciliado — um DRAFT que completou fica DRAFT para '
 'sempre. Cron é DIÁRIO (yml:16) enquanto o comentário na mesma linha e o cabeçalho (:6) prometem 6h; com CAP=300 e ~85 '
 'TRs saindo do aberto por dia, uma rodada diária mal empata. PROTEÇÃO A COPIAR: aborta se o conjunto vivo vier VAZIO '
 '(:87), para não interpretar blip de API como "tudo completou".'),

('transfer_lines','A CONSTRUIR',NULL,'movement',
 'stockTransfer?TaskID={id}','stockTransferList','Page','Limit',500,NULL,
 'cin7_mirror','stock_transfer_lines','task_id,line_no','TaskID',
 'backfill','{}',NULL,
 2550,0,1,33100,
 DATE '2025-08-01',
 ARRAY['features/logistics/open-orders-notes.js:19-34 (hoje AO VIVO, cache de 10 min)',
       'features/transfer-out/transfer-out-engine.js:38 (hoje AO VIVO)',
       'features/analytics/db/001_analytics_views.sql:152 (v_an_transfer_leadtime)',
       'features/replenishment/replenishment-config.js:297-302 (demanda inflada por transferência)'],
 'NÃO EXISTE TABELA. open-orders-notes.js:19-20 diz por escrito: "the mirror stores transfers header-only, so line '
 'items aren''t there to read". Cada expansão de TR na tela é uma chamada VIVA em horário de operação, disputando o '
 'mesmo teto de 60/min dos crons. CUSTO: 33.100 detalhes = 36,8h a 15/min ou 23,0h a 24/min. É a única peça que NÃO '
 'cabe num fim de semana — trate como dreno de fundo, com checkpoint em cin7_mirror.backfill_state.'),

('transfer_movements','PARCIAL','cin7-stock-sync/sync-movements.js:69-89,141,174-195','movement',
 'stockTransfer?TaskID={id}','stockTransferList','Page','Limit',500,NULL,
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181','TaskID',
 'ciclo','{}','50 */6 * * *',
 2550,NULL,1,0,
 NULL,
 ARRAY['features/pick-anomalies/pa-movements.js:60-62 (aba Movements audit)',
       'home.js:543-569,663-671 (painel de transferências)',
       'cin7-stock-sync/verify-coverage.js:282'],
 'CICLO OBRIGATÓRIO (sem webhook). Gera PAR out/in por linha. Janela = MOVE_SINCE_DAYS=1 forçado no workflow '
 '(cin7-movements-sync.yml:50) contra default 3 no código (:32). Nasce em 2026-06-19 → 322 dias sem nada. '
 'CAUDA QUE SOME EM SILÊNCIO: MOVE_TIME_BUDGET_MS=1200000 corta aos 20 min (:175) e MAX_CONSEC=4 erros também para '
 '(:190) — nos dois casos o script sai com exit 0, por design. Com janela de 1 dia e ordem determinística, o que não '
 'for alcançado em ~8 execuções some para sempre, sem alarme. backfill_since é NULL porque a rota certa para o passado '
 'é transfer_lines (mesmo JSON, destino melhor) — backfillar os dois é pagar 33.100 chamadas duas vezes.'),

('transfer_lookup_live','IMPLEMENTADO','features/logistics/open-orders-notes.js:24 · features/transfer-out/transfer-out-engine.js:38 · features/wms/lib/cin7-wms-client.js:202','movement',
 'stockTransfer?TaskID={id}',NULL,NULL,NULL,1,NULL,
 NULL,NULL,NULL,'TaskID',
 'sob-demanda','{}',NULL,
 0,0,1,0,
 NULL,
 ARRAY['features/logistics/open-orders.js:262-268 (expansão de linha de TR)',
       'features/transfer-out/transfer-out.js:31 (pick sheet)'],
 'SOB-DEMANDA hoje POR FALTA de transfer_lines, não por escolha. Cache de 10 min em memória '
 '(open-orders-notes.js:19-34). Quando transfer_lines existir, vira fallback: espelho primeiro, Cin7 só se não houver '
 'linha. ATENÇÃO: o Cin7 chaveia transferência por TaskID — ?ID= devolve 400 (cin7-wms-client.js:202).'),

('adjustment_movements','PARCIAL','cin7-stock-sync/sync-movements.js:94-118,142','movement',
 'stockAdjustment?TaskID={id}','stockAdjustmentList','Page','Limit',500,NULL,
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181','TaskID',
 'ciclo','{}','50 */6 * * *',
 268,NULL,1,3490,
 DATE '2025-08-01',
 ARRAY['features/pick-anomalies/pa-movements.js:60-62 (chip stock_adjustment)',
       'cyclic-count.js (fechamento de contagem cíclica contra o ledger)'],
 'CICLO OBRIGATÓRIO: ajuste/stocktake NÃO tem webhook no Cin7 — e é justamente o movimento que "não bate" (contagem, '
 'correção, perda); sem ele nenhuma reconstrução de saldo fecha. stockAdjustmentList IGNORA UpdatedSince (medido: '
 'Total=12.732 inalterado) e é OLDEST-FIRST (reverse:true, :154-156). MEDIDO: page 9.300 = ST-09379 em 2025-08-05, '
 'page 9.500 = ST-09580 em 2025-08-20 → 13/dia; corte de 2025-08-01 no índice ~9.250 → 3.482 ajustes = 268/mês. '
 'Custo: 8 páginas de cauda + 3.482 detalhes = 3.490 ≈ 3,9h a 15/min. DOIS DEFEITOS SEMÂNTICOS: (1) movement-schema.sql:44 '
 'declara "write_off" mas :112-115 grava TUDO como stock_adjustment, com o motivo em raw_data.reason (texto livre); '
 '(2) ajuste com delta 0 é descartado (:110), então correção que só move de bin desaparece do ledger.'),

('assembly_movements','PARCIAL','cin7-stock-sync/sync-assembly.js:59-87,97-126','movement',
 'finishedGoods?TaskID={id}','finishedGoodsList','Page','Limit',500,NULL,
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=assembly-sync) — sync-assembly.js:125','TaskID',
 'ciclo','{}','50 */6 * * *',
 586,NULL,1,7631,
 DATE '2025-08-01',
 ARRAY['features/pick-anomalies/pa-movements.js:60-62 (chip assembly_consume)',
       'features/pick-anomalies/pick-anomalies-engine.js (analyzeAssemblyRealtime)',
       'cin7-stock-sync/verify-coverage.js:167-190 (captura de montagem)'],
 'CICLO OBRIGATÓRIO: produção/finished goods NÃO tem webhook no Cin7. É o ponto cego citado no próprio cabeçalho do '
 'arquivo (:3-6): componente consumido em kit sai do bin SEM venda e SEM webhook. finishedGoodsList IGNORA UpdatedSince '
 '(medido: Total=26.315 inalterado) e é OLDEST-FIRST. MEDIDO: page 19.000 = FG-19747 em 2025-08-14, page 19.500 = '
 'FG-20273 em 2025-09-05 → 22,7/dia; corte de 2025-08-01 no índice ~18.700 → 7.615 builds = 586/mês. '
 'Custo: 16 páginas de cauda + 7.615 detalhes = 7.631 ≈ 8,5h a 15/min. DOIS DEFEITOS NO WALK: (1) :108 só aceita '
 'Status=COMPLETED, então VOIDED e WIP nunca entram; (2) a parada :109 — fg.every(h => dt && dt < since) — NUNCA dispara '
 'numa página que contenha h.Date nulo, então o job caminha as 53 páginas em vez de 1-2.'),

('assembly_bom','A CONSTRUIR',NULL,'movement',
 'finishedGoods?TaskID={id} (OrderLines = receita)','finishedGoodsList','Page','Limit',100,NULL,
 'cin7_mirror','assembly_bom','fg_sku,component_sku','TaskID (da última build COMPLETED)',
 'ciclo','{}',NULL,
 0,300,1.5,750,
 NULL,
 ARRAY['features/wms/lib/wms-engine.js:315-325 (getRecipe — hoje AO VIVO, sem cache)',
       'features/logistics/open-orders-notes.js:53-81 (hoje AO VIVO, cache de 1h)'],
 'NÃO EXISTE ESPELHO e a receita é RECONSTRUÍDA AO VIVO EM DOIS LUGARES independentes, com caches diferentes. '
 'open-orders-notes.js:48-51 explica: "Cin7 exposes no readable BOM template — product?ID BillOfMaterialsProducts comes '
 'back empty", então lê as PickLines da build COMPLETED mais recente. CUSTO: ~300 SKUs de montagem (stock_locator em '
 'BOM/PRODUCTION, o critério de wms-engine.js:52) x ~2,5 chamadas = 750 ≈ 31 min, depois refresh semanal. Troca custo '
 'VIVO e imprevisível no pico do armazém por 31 min de fim de semana. backfill_since NULL: receita é ESTADO, não série.'),

-- ── COMPRAS ───────────────────────────────────────────────────────────────
('purchase_header','A CONSTRUIR',NULL,'purchase',
 'purchaseList','purchaseList','Page','Limit',500,'UpdatedSince',
 'cin7_mirror','purchase_orders','po_number','ID',
 'ciclo','{}',NULL,
 380,NULL,0,10,
 DATE '2025-08-01',
 ARRAY['features/stock-planning/db/003_views.sql:176-193 (v_sp_incoming — hoje 100% Excel)',
       'features/stock-planning/db/002_planning.sql:179 (rapid_inv.po_lines.cin7_po_id, reservado e NULL)',
       'features/container-builder/container-builder-engine.js:345 (hoje vê só 100 POs vivas)',
       'features/stock-planning/db/009_leadtime_and_buying.sql:31-46 (lead time medido)'],
 'A MAIOR LACUNA, já registrada pelo dono como prioridade 1 (docs/STOCK_PLANNING_03_CIN7_AUTOMATION.md:24, :133-137). '
 'DESCOBERTA QUE MUDA O PLANO: purchaseList HONRA UpdatedSince — medido, UpdatedSince=2025-08-01 → Total=4.943 contra '
 '14.097 sem filtro. É o ÚNICO dos quatro endpoints de tarefa que aceita cursor de data. BACKFILL DE CABEÇALHO: '
 '4.943/500 = 10 chamadas ≈ 40s — melhor retorno por chamada do repositório. REGRA DE PRECEDÊNCIA JÁ DECIDIDA '
 '(STOCK_PLANNING_03:141-143): Cin7 manda em quantidade, SKU e fornecedor; a DATA DE CHEGADA é nossa até o contêiner ser '
 'recebido — sync NÃO pode sobrescrever due_date. Casar por sku_key = upper(btrim(sku)): a aba PO''s grava maiúscula e '
 'as outras minúscula, o que custou 312 unidades num único SKU (002_planning.sql:271-278).'),

('purchase_lines','A CONSTRUIR',NULL,'purchase',
 'purchase?ID={id}','purchaseList','Page','Limit',500,'UpdatedSince',
 'cin7_mirror','purchase_lines','po_number,line_no','ID',
 'backfill','{}',NULL,
 380,0,1,4943,
 DATE '2025-08-01',
 ARRAY['features/stock-planning/db/006_overview_views.sql:8-11 (is_received=false em 1.466 linhas)',
       'features/stock-planning/db/009_leadtime_and_buying.sql:84-98 (v_sp_sku_leadtime)',
       'features/wms/lib/wms-receiving.js:18-28 (hoje AO VIVO)',
       'features/container-builder/container-builder-engine.js:390'],
 'On-order por SKU com PO, fornecedor e ETA não existe em lugar nenhum. O agregado stock_snapshot.on_order diz "quanto '
 'vem" mas não "quando" nem "de quem". DEGRAU BARATO PRIMEIRO: só as 686 POs ABERTAS (medido: DRAFT 4 + ORDERING 207 + '
 'ORDERED 371 + RECEIVING 104) = 686 detalhes + 4 listas = 690 chamadas ≈ 46 min, e isso sozinho destrava o Stock '
 'Planning. JANELA COMPLETA: 4.943 detalhes ≈ 5,5h a 15/min. Sem isto, is_received nunca vira true (PO recebida conta '
 'como estoque entrando PARA SEMPRE) e o lead time cai no FALLBACK de 12 semanas (009:86-90).'),

('purchase_movements','PARCIAL','cin7-stock-sync/sync-movements.js:122-137,143','purchase',
 'purchase?ID={id}','purchaseList','Page','Limit',500,'UpdatedSince',
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181','ID',
 'ciclo','{}','50 */6 * * *',
 380,NULL,1,0,
 NULL,
 ARRAY['features/pick-anomalies/pa-movements.js:60-62 (chip purchase_receive)',
       'features/replenishment (entrada de estoque no ledger)'],
 'ESTRUTURALMENTE ERRADO E DE GRAÇA CONSERTAR: CFG.purchase (:143) filtra por LastUpdatedDate mas pagina de TRÁS PARA '
 'FRENTE (reverse:true, :154-156) numa lista ordenada por CRIAÇÃO crescente (page 1 = PO-00001, 2018-07-16). Uma PO '
 'criada em março e recebida hoje fica no índice ~12.700; o walk quebra na primeira página inteiramente antiga (:164) e '
 'nunca a alcança — recebimento em PO velha é INVISÍVEL. Conserto: trocar o walk por UpdatedSince, que este endpoint '
 'HONRA (medido). DUPLICIDADE ATIVA com o webhook: aqui cin7_task_id = ID da purchase, lá = TaskID do StockReceived '
 '(movement-processor.js:570); cada um deduplica só dentro do próprio source → mesmo recebimento, duas linhas, dois dias. '
 'docs/SYNC_WORKFLOWS.md:86-87 já propõe derrubar esta fatia por redundância com o webhook.'),

('purchase_webhook_receive','PARCIAL','cin7-stock-sync/movement-processor.js:144-145,568-650','purchase',
 'purchase?ID={id}','purchaseList?Search={number}','Page','Limit',5,NULL,
 'cin7_mirror','stock_movements','delete+insert por (cin7_task_id, source=webhook) — movement-processor.js:158-165','TaskID do StockReceived',
 'webhook',ARRAY['Purchase/StockReceivedAuthorised'],NULL,
 380,0,1.5,0,
 NULL,
 ARRAY['features/replenishment (entrada de estoque em tempo real)',
       'features/pick-anomalies/pa-movements.js:60-62'],
 'ÚNICO WEBHOOK DE ENTRADA que existe — os outros três tipos de movimento não têm evento no Cin7. É por isso que ele '
 'merece webhook e transferência/ajuste/montagem não podem. CUSTO ESCONDIDO: o TaskID do webhook frequentemente NÃO é o '
 'purchase ID (:577-590) — no fallback são 2 chamadas extras. DEFEITO DE DATA: carimba detected_at = now() (:630) '
 'enquanto o poller carimba a data do negócio (sync-movements.js:39) — o mesmo recebimento cai em dois dias. '
 'PRÉ-REQUISITO OPERACIONAL: webhook-watchdog.js:88 reativa webhook com bearer VAZIO porque o workflow não injeta '
 'CIN7_WEBHOOK_TOKEN; enquanto isso não for consertado, todo webhook novo entra na mesma armadilha.'),

('purchase_lookup_live','IMPLEMENTADO','features/container-builder/container-builder-engine.js:343-390 · features/wms/lib/cin7-wms-client.js:225-230','purchase',
 'purchase?ID={id}','purchaseList','Page','Limit',100,NULL,
 NULL,NULL,NULL,'ID',
 'sob-demanda','{}',NULL,
 0,1,1,0,
 NULL,
 ARRAY['features/container-builder/container-builder.html (montagem de contêiner)',
       'features/wms/lib/wms-receiving.js:18-28 (recebimento no chão)'],
 'LIMITE DURO E INVISÍVEL: container-builder pede Page=1&Limit=100 e filtra no CLIENTE (:343-345, "Status filter not '
 'supported on /purchaseList directly"). Existem só 100 POs para esta tela, sempre as mais recentes. Cache de 5 min em '
 'memória. Quando purchase_header existir, a tela lê o espelho e o teto de 100 desaparece.'),

-- ── DADO MESTRE ───────────────────────────────────────────────────────────
('products','IMPLEMENTADO','cin7-stock-sync/sync-service.js:262-266,485-526,731-772','master',
 'product','product','Page','Limit',1000,'ModifiedSince',
 'cin7_mirror','products','sku','ID',
 'ciclo','{}','15 16 * * *',
 0,12,0,0,
 NULL,
 ARRAY['supabase-config.js:27,76,112 (etiquetas / busca)',
       'features/returns/returns.js:343,364,530-544 (price_tier1)',
       'features/wms/lib/wms-engine.js:51,124-128 (barcode, attribute1, stock_locator)',
       'features/stock-planning/db/009_leadtime_and_buying.sql:66-76 (carton_quantity)',
       'features/stock-planning/db/008_sku_lifecycle.sql:46-84 (status)',
       'restock-v2.js:2710 · features/label-sheets/label-sheets.js:1179',
       '(40 arquivos no total — é a tabela mais lida do repo)'],
 'CICLO e não webhook POR ORDEM DE SEGURANÇA: Product/Updated existe na taxonomia (webhook-config.js:14) e é melhor que '
 'qualquer cron — mas NÃO antes de consertar webhook-watchdog.js:88, senão o Cin7 auto-desativa após 6 falhas e o '
 'watchdog reativa com token errado em loop. 11.251 produtos (8.508 Active + 2.743 Deprecated) / 1000 = 12 chamadas/dia. '
 'ModifiedSince É SUPORTADO (ARCHITECTURE.md:18,:35) e NÃO é usado — fetchProducts (:262-266) monta só IncludeDeprecated; '
 'quem escreve no Cin7 com products.id (wms-transfers.js:36-40) pode usar um id de até 24h atrás. '
 'SEM HISTÓRICO: average_cost/price_tier1/status são sobrescritos todo dia — valorar estoque de 2025 com o custo de hoje '
 'é errado e nada sinaliza. ARMADILHA DE SCHEMA: mapProductRow grava 36 colunas e o DDL versionado declara 23; as 13 '
 'restantes existem só em produção, criadas à mão. Recriar o banco do schema.sql zera o catálogo com log VERDE '
 '(PGRST204 → recuperação linha a linha → recovered=0 → _syncProducts não lança → sync_runs.status=success).'),

('locations','PARCIAL','cin7-stock-sync/sync-service.js:271-272,531-546,776-816','master',
 'ref/location','ref/location','Page','Limit',1000,NULL,
 'cin7_mirror','locations','name','ID',
 'ciclo','{}','15 16 * * *',
 0,2,0,0,
 NULL,
 ARRAY['features/wms/lib/wms-sync.js:29-58 (wms.bins) e :62-75 (wms.pickface)',
       'features/wms/lib/wms-transfers.js:23-25 (resolve GUID por NOME e escreve no Cin7)',
       'features/transfer-out/transfer-out.js:101 · transfer-out-staging.js:168',
       'features/wms/lib/wms-engine.js:27'],
 'QUEBRADO POR MODELAGEM, não por cobertura: a tabela tem CONSTRAINT uq_location_name UNIQUE (name) (schema.sql:27) e o '
 'upsert resolve por "name" (:802-806) — mas o Cin7 PERMITE nomes repetidos. O de-para cravado em '
 'order-pipeline-sync.js:51-64 lista 14 GUIDs para 12 nomes (Gold Coast, Coffs Harbour e Hobart com 2 cada). Três GUIDs '
 'são destruídos a cada sync e o vencedor depende da ordem de paginação do Cin7 — NÃO determinista. Isso importa porque '
 'cinco features resolvem local POR NOME e mandam o GUID resultante para DENTRO do Cin7. parent_id NÃO É CONFIÁVEL: '
 '007_live_stock.sql:20-24 registra Melbourne pendurado em "Ghost". 1.417 locais / 1000 = 2 chamadas/dia.'),

('customers','A CONSTRUIR','server.js:167-192 (só cache em memória de 1h — NADA persistido)','master',
 'customer','customer','Page','Limit',1000,'ModifiedSince',
 'cin7_mirror','customers','customer_id','ID',
 'ciclo','{}',NULL,
 0,10,0,10,
 NULL,
 ARRAY['features/returns/returns.js:94,381 (business DEVE ser um cliente do Cin7; nome digitado é rejeitado)',
       'cin7_mirror.sales_orders.customer_id (GUID que hoje aponta para dimensão inexistente)'],
 'CICLO e não webhook por um motivo concreto: docs/RUNBOOKS.md:61 avisa que já existe um Customer/Updated de OUTRO '
 'sistema (n8n) na mesma conta Cin7 e que não se deve tocá-lo. (O Cin7 aceita até 5 webhooks do mesmo Type — '
 'manage-webhooks.js:7-8 — então coexistir é possível depois, mas não é a primeira coisa a fazer.) HOJE: _custCache '
 '(server.js:169), TTL 3600000ms; em Vercel serverless CADA lambda fria repete as 10 chamadas — N lambdas = 10N. '
 'Espelhar 1x/dia custa 10 chamadas FIXAS e o cache vira SELECT. Returns BLOQUEIA a criação se o Cin7 estiver fora.'),

('suppliers','A CONSTRUIR',NULL,'master',
 'supplier','supplier','Page','Limit',1000,'ModifiedSince',
 'cin7_mirror','suppliers','supplier_id','ID',
 'ciclo','{}',NULL,
 0,1,0,1,
 NULL,
 ARRAY['features/stock-planning/db/002_planning.sql:107-134 (rapid_inv.suppliers + supplier_aliases, hoje 100% digitados)',
       'features/stock-planning/db/009_leadtime_and_buying.sql:31-46 (v_sp_supplier_leadtime)'],
 'REGISTRE PARA NINGUÉM PERDER UM DIA PROCURANDO: lead time e MOQ NÃO existem no Cin7 deste tenant. Medido — /supplier '
 '(Total=500) devolve ID, Name, Currency, PaymentTerm, TaxRule, Discount, AdditionalAttribute1..10 e NENHUM campo de '
 'lead time ou MOQ; 0 de 300 produtos amostrados têm Suppliers[] preenchido, com MinimumBeforeReorder = 0 em 300/300. '
 'O que o espelho RESOLVE é a IDENTIDADE: hoje rapid_inv.suppliers.code é código inventado à mão, com 30 aliases para '
 '26 grafias de ~22 fornecedores. Lead time medido continua vindo do Excel até purchase_lines existir. Custo: 1 chamada.')

ON CONFLICT (id) DO UPDATE SET
  status               = EXCLUDED.status,
  implemented_by       = EXCLUDED.implemented_by,
  domain               = EXCLUDED.domain,
  cin7_endpoint        = EXCLUDED.cin7_endpoint,
  list_endpoint        = EXCLUDED.list_endpoint,
  page_param           = EXCLUDED.page_param,
  limit_param          = EXCLUDED.limit_param,
  max_page_size        = EXCLUDED.max_page_size,
  cursor_param         = EXCLUDED.cursor_param,
  target_schema        = EXCLUDED.target_schema,
  target_table         = EXCLUDED.target_table,
  upsert_key           = EXCLUDED.upsert_key,
  cin7_id_field        = EXCLUDED.cin7_id_field,
  mechanism            = EXCLUDED.mechanism,
  webhook_events       = EXCLUDED.webhook_events,
  cycle_cron           = EXCLUDED.cycle_cron,
  estimated_rows_month = EXCLUDED.estimated_rows_month,
  list_calls_per_pass  = EXCLUDED.list_calls_per_pass,
  calls_per_row        = EXCLUDED.calls_per_row,
  calls_per_full_pass  = EXCLUDED.calls_per_full_pass,
  backfill_since       = EXCLUDED.backfill_since,
  consumers            = EXCLUDED.consumers,
  notes                = EXCLUDED.notes,
  updated_at           = now();

-- Todo recurso ganha uma linha de estado, vazia. Assim o painel mostra
-- "nunca rodou" (que é uma informação) em vez de linha ausente (que não é).
INSERT INTO ops.cin7_resource_state (resource_id)
SELECT id FROM ops.cin7_resource
ON CONFLICT (resource_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 3b) PONTE COM O EXECUTOR (core/cin7/plan.js + backfill-driver.js).
--     Os cinco jobs que o driver conhece, ligados aos recursos que eles enchem.
--     Fora do bloco VALUES de propósito: quando alguém acrescentar um handler
--     em core/cin7/handlers/index.js, esta é a única linha a mexer aqui.
-- ───────────────────────────────────────────────────────────────────────────
UPDATE ops.cin7_resource r SET job_key = m.job
  FROM (VALUES
    ('sale_detail_month',    'sales_detail'),
    ('purchase_lines',       'po_detail'),     -- po_detail traz header E linha
    ('purchase_header',      'po_detail'),
    ('adjustment_movements', 'adj_detail'),
    ('assembly_movements',   'asm_detail'),    -- o mesmo JSON carrega a receita
    ('assembly_bom',         'asm_detail'),
    ('transfer_lines',       'tr_detail')
  ) AS m(id, job)
 WHERE r.id = m.id AND r.job_key IS DISTINCT FROM m.job;

-- ───────────────────────────────────────────────────────────────────────────
-- 3c) PROGRESSO REAL, derivado do executor — sem segunda fonte de verdade.
--
--     ops.cin7_sync_state é de outro arquivo (core/cin7/sql/001_cin7_sync_state.sql)
--     e pode ainda não ter sido aplicado. Criar a view incondicionalmente faria
--     ESTE arquivo falhar por causa de uma dependência que ele não instala — e
--     aí ninguém teria catálogo nenhum. Então: cria se existir, e registra um
--     aviso legível se não existir.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('ops.cin7_sync_state') IS NULL THEN
    RAISE NOTICE 'ops.cin7_sync_state ausente — pulei a view de progresso. Aplique core/cin7/sql/001_cin7_sync_state.sql e rode este arquivo de novo.';
    RETURN;
  END IF;

  EXECUTE $v$
    CREATE OR REPLACE VIEW ops.v_cin7_backfill_progress AS
    SELECT r.id                                   AS resource_id,
           r.domain,
           r.job_key,
           count(*)                               AS chunks,
           count(*) FILTER (WHERE s.status = 'done')    AS chunks_done,
           count(*) FILTER (WHERE s.status = 'failed')  AS chunks_failed,
           count(*) FILTER (WHERE s.status = 'running') AS chunks_running,
           sum(s.done_count)                      AS units_done,
           sum(s.target_count)                    AS units_target,
           CASE WHEN COALESCE(sum(s.target_count), 0) = 0 THEN NULL
                ELSE round(100.0 * sum(s.done_count) / sum(s.target_count), 1) END AS pct_done,
           sum(s.calls_used)                      AS calls_used,
           r.calls_per_full_pass                  AS calls_budgeted,
           max(s.last_run_at)                     AS last_run_at,
           max(s.finished_at)                     AS last_finished_at
      FROM ops.cin7_resource r
      JOIN ops.cin7_sync_state s ON s.job = r.job_key
     WHERE r.job_key IS NOT NULL
     GROUP BY r.id, r.domain, r.job_key, r.calls_per_full_pass
  $v$;

  EXECUTE 'GRANT SELECT ON ops.v_cin7_backfill_progress TO anon, authenticated';
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) VISÕES DE LEITURA
-- ═══════════════════════════════════════════════════════════════════════════

-- Contrato + relógio, com o custo do backfill já calculado. É a view que
-- responde "o que falta, quanto custa e quem quebra se eu mexer".
CREATE OR REPLACE VIEW ops.v_cin7_catalog AS
SELECT
  r.id,
  r.domain,
  r.status,
  r.mechanism,
  r.cin7_endpoint,
  r.cursor_param,
  COALESCE(r.target_schema || '.', '') || COALESCE(r.target_table, '(nada é persistido)') AS target,
  r.upsert_key,
  r.cycle_cron,
  r.job_key,
  r.implemented_by,
  r.backfill_since,
  r.calls_per_full_pass,
  -- Tempo de parede do backfill nos dois throttles reais do repo.
  ROUND(r.calls_per_full_pass / 15.0 / 60.0, 1) AS hours_at_15_per_min,
  ROUND(r.calls_per_full_pass / 24.0 / 60.0, 1) AS hours_at_24_per_min,
  s.status                                       AS sync_status,
  s.last_ok_at,
  s.last_cursor,
  s.processed,
  s.total_target,
  CASE
    WHEN s.total_target IS NULL OR s.total_target = 0 THEN NULL
    ELSE ROUND(100.0 * s.processed / s.total_target, 1)
  END                                            AS pct_done,
  s.calls_made,
  s.last_error,
  array_length(r.consumers, 1)                   AS consumer_count,
  r.consumers,
  r.notes
FROM ops.cin7_resource r
LEFT JOIN ops.cin7_resource_state s ON s.resource_id = r.id;

-- O plano do backfill, na ordem em que as chamadas devem ser gastas: o barato
-- primeiro, para que uma janela interrompida ainda tenha entregue valor.
CREATE OR REPLACE VIEW ops.v_cin7_backfill_plan AS
SELECT
  ROW_NUMBER() OVER (ORDER BY r.calls_per_full_pass ASC)      AS step,
  r.id,
  r.domain,
  r.status,
  COALESCE(r.target_schema || '.', '') || r.target_table       AS target,
  r.backfill_since,
  r.job_key,
  r.calls_per_full_pass                                        AS calls,
  ROUND(r.calls_per_full_pass / 24.0)                          AS minutes_at_24_per_min,
  SUM(r.calls_per_full_pass) OVER (ORDER BY r.calls_per_full_pass ASC
                                   ROWS UNBOUNDED PRECEDING)   AS cumulative_calls,
  ROUND(SUM(r.calls_per_full_pass) OVER (ORDER BY r.calls_per_full_pass ASC
                                         ROWS UNBOUNDED PRECEDING) / 24.0 / 60.0, 1)
                                                               AS cumulative_hours_at_24,
  COALESCE(s.status, 'idle')                                   AS sync_status,
  s.last_ok_at
FROM ops.cin7_resource r
LEFT JOIN ops.cin7_resource_state s ON s.resource_id = r.id
WHERE r.backfill_since IS NOT NULL
  AND r.calls_per_full_pass > 0;

-- O que NÃO é backfillável, e por quê. Uma pergunta que vai voltar.
CREATE OR REPLACE VIEW ops.v_cin7_not_backfillable AS
SELECT r.id, r.domain, r.status, r.mechanism,
       COALESCE(r.target_schema || '.', '') || COALESCE(r.target_table, '—') AS target,
       r.notes
FROM ops.cin7_resource r
WHERE r.backfill_since IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) RLS + GRANTS — mesma forma de ops.sync_registry: a página lê com a chave
--    anon, os jobs escrevem com a service_role.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE ops.cin7_resource   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.cin7_resource_state ENABLE ROW LEVEL SECURITY;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['cin7_resource','cin7_resource_state'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON ops.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON ops.%I FOR SELECT USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON ops.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON ops.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t, t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA ops TO anon, authenticated, service_role;
GRANT SELECT ON ops.cin7_resource, ops.cin7_resource_state TO anon, authenticated;
GRANT SELECT ON ops.v_cin7_catalog, ops.v_cin7_backfill_plan, ops.v_cin7_not_backfillable
  TO anon, authenticated;
GRANT ALL    ON ops.cin7_resource, ops.cin7_resource_state TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) WRAPPER PÚBLICO — `ops` fica FORA de "Exposed schemas" no PostgREST.
--    O app chama uma função, não as tabelas. Mesmo padrão de public.sync_health().
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cin7_catalog()
RETURNS TABLE (
  id TEXT, domain TEXT, status TEXT, mechanism TEXT,
  cin7_endpoint TEXT, cursor_param TEXT, target TEXT, upsert_key TEXT,
  cycle_cron TEXT, job_key TEXT, implemented_by TEXT, backfill_since DATE,
  calls_per_full_pass INT, hours_at_15_per_min NUMERIC, hours_at_24_per_min NUMERIC,
  sync_status TEXT, last_ok_at TIMESTAMPTZ, last_cursor TEXT,
  processed BIGINT, total_target BIGINT, pct_done NUMERIC,
  calls_made BIGINT, last_error TEXT,
  consumer_count INT, consumers TEXT[], notes TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ops, public
AS $$ SELECT * FROM ops.v_cin7_catalog $$;

GRANT EXECUTE ON FUNCTION public.cin7_catalog() TO anon, authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7) CONFERÊNCIA — o que este arquivo deixou no banco.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT domain, mechanism, status, count(*) AS recursos
  FROM ops.cin7_resource
 GROUP BY ROLLUP (domain, mechanism, status)
 ORDER BY domain NULLS LAST, mechanism NULLS LAST, status NULLS LAST;

SELECT step, id, target, calls, minutes_at_24_per_min, cumulative_hours_at_24
  FROM ops.v_cin7_backfill_plan
 ORDER BY step;
