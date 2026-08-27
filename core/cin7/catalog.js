'use strict';
/**
 * core/cin7/catalog.js — CATÁLOGO DE RECURSOS Cin7 Core v2.
 *
 * O contrato de dados do Rapid Labels: um objeto por recurso do Cin7 que este
 * repo consome, com endpoint, cursor, tabela de destino, chave de upsert,
 * mecanismo, custo em chamadas e quem consome. Só descreve — não executa nada,
 * não abre conexão, não lê env. É `require`-ável de qualquer script, workflow
 * ou rota sem efeito colateral.
 *
 * POR QUE ELE EXISTE
 *   36 arquivos falam HTTP com o Cin7 e só 16 tratam 429. Não havia um lugar
 *   que respondesse "de onde vem este número, com que chave, e quanto custa
 *   buscá-lo de novo". Este arquivo é esse lugar. O espelho SQL consultável
 *   é sql/2026-08_catalog.sql (ops.cin7_resource + ops.cin7_sync_state).
 *
 * REGRAS DE MANUTENÇÃO
 *   1. Cada entrada precisa de pelo menos um consumidor NOMEADO (arquivo:linha
 *      ou view). Recurso sem leitor não entra — vira linha em DECISIONS.
 *   2. Onde já existe implementação, a entrada DESCREVE o que existe. O campo
 *      `implementedBy` aponta o arquivo. Nada aqui propõe substituir código
 *      que funciona.
 *   3. `status` é o estado do MUNDO, não do desejo:
 *        'IMPLEMENTADO' — roda hoje e cobre o que promete
 *        'PARCIAL'      — roda hoje mas não cobre a janela/campo declarado
 *        'A CONSTRUIR'  — não existe destino ou não existe passe
 *   4. Todo número tem procedência: arquivo:linha, ou uma conta mostrada em
 *      `notes`. Se você não consegue mostrar a conta, não escreva o número.
 *
 * LIMITE DE API — 60 req/min POR CONTA (docs/SYNC_WORKFLOWS.md:3-5). A chave é
 * compartilhada com o TMS e com o app; uma chave dedicada NÃO ajuda. Os
 * throttles reais do repo: 2500ms = 24/min (cin7-sales-detail-month.yml:73,
 * sync-service.js:48) e 4000ms = 15/min (backfill-sales.js:35, o default).
 *
 * SEM WEBHOOK NO CIN7 (verificado na taxonomia em webhook-config.js:9-16):
 * transferência, ajuste/stocktake e produção (finished goods) não têm evento.
 * Esses três são obrigatoriamente 'ciclo' — não é escolha de arquitetura.
 */

const CATALOG_VERSION = '2026-08-26';
const CIN7_BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';

/** Teto compartilhado (TMS + app + Labels). Por conta, não por chave. */
const RATE_LIMIT_PER_MIN = 60;

/** Meta de cobertura do dono: 13 meses saudáveis a partir daqui. */
const COVERAGE_SINCE = '2025-08-01T00:00:00Z';

/**
 * Fim da janela usada para congelar `callsPerFullPass`. Mantenha fixo: se
 * alguém trocar por new Date(), os números da doc param de bater com o SQL.
 */
const COVERAGE_UNTIL = '2026-08-26T00:00:00Z';

// ═════════════════════════════════════════════════════════════════════
// RECURSOS
// ═════════════════════════════════════════════════════════════════════
//
// Campos:
//   id                   chave estável — é o PK em ops.cin7_resource
//   status               IMPLEMENTADO | PARCIAL | A CONSTRUIR
//   implementedBy        arquivo(:linha) que faz o trabalho hoje, ou null
//   domain               sales | stock | movement | purchase | master
//   cin7Endpoint         o recurso de DETALHE (ou o próprio, quando só há lista)
//   listEndpoint         o recurso de LISTA que enumera ids, ou null
//   pageParam/limitParam nomes reais dos parâmetros de paginação
//   maxPageSize          maior Limit que o repo usa neste endpoint
//   cursorParam          CreatedSince | UpdatedSince | ModifiedSince | null
//                        null = a lista IGNORA filtro de data (medido)
//   targetSchema/Table   destino no Supabase Labels
//   upsertKey            colunas do ON CONFLICT (ou a estratégia de dedup)
//   cin7IdField          campo do Cin7 que identifica a linha na origem
//   mechanism            webhook | ciclo | sob-demanda | backfill
//   webhookEvents        tópicos registrados (OUR_EVENTS) que alimentam isto
//   cycleCron            cron UTC do workflow, ou null
//   estimatedRowsPerMonth  linhas/mês na janela de 13 meses (conta em notes)
//   listCallsPerPass     chamadas de LISTA fixas por passe; null = derivar de
//                        ceil(linhas / maxPageSize)
//   callsPerRow          chamadas de DETALHE por linha (0 = só lista)
//   callsPerFullPass     total congelado para 2025-08-01 → 2026-08-26
//   backfillSince        data a partir da qual faz sentido backfillar; null =
//                        não backfillável (dado só existe no "agora")
//   jobKey               o `job` correspondente no executor de chunks
//                        (core/cin7/plan.js + handlers/index.js); null = não é
//                        dirigido pelo driver
//   consumers            quem lê. arquivo:linha ou view. Sem isto, não entra.
//   notes                a verdade operacional: armadilha, defeito, conta.

const RESOURCES = [

  // ───────────────────────────────────────────────────────────────────
  // VENDAS — cabeçalho
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'sale_header_backfill',
    status: 'IMPLEMENTADO',
    implementedBy: 'cin7-stock-sync/backfill-sales.js:148-166 (modo `headers`)',
    domain: 'sales',
    cin7Endpoint: 'saleList',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'CreatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'sales_orders',
    upsertKey: 'order_number',
    cin7IdField: 'SaleID',
    mechanism: 'backfill',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 1300,
    listCallsPerPass: null,
    callsPerRow: 0,
    callsPerFullPass: 17,
    backfillSince: COVERAGE_SINCE,
    consumers: [
      'features/analytics/db/001_analytics_views.sql:35-56 (v_an_monthly_sales)',
      'features/logistics/open-orders.js:59',
      'features/logistics/invoicing-monitor.js:242',
      'features/wms/lib/wms-engine.js:109',
      'home.js:1220 (expansão de linha)',
    ],
    notes:
      'JÁ PAGO — 78.256 pedidos desde 2021 (features/analytics/db/001_analytics_views.sql:8). ' +
      'Conta: 13 meses x 1.300 pedidos = 16.900; 16.900/1000 = 17 páginas. ' +
      'ARMADILHA: o checkpoint chama-se sempre "sales_headers" e NÃO guarda o SINCE ' +
      '(backfill-sales.js:150), e `done` é gravado ao sair do laço por qualquer motivo (:163). ' +
      'Re-rodar com outro BACKFILL_SINCE retoma em last_page+1 de OUTRO conjunto e pula tudo ' +
      'em silêncio. Zere a linha do checkpoint, ou use um job por janela.',
  },

  {
    id: 'sale_header_cycle',
    status: 'IMPLEMENTADO',
    implementedBy: 'cin7-stock-sync/backfill-sales.js:247-263 (modo `sync`)',
    domain: 'sales',
    cin7Endpoint: 'saleList',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'UpdatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'sales_orders',
    upsertKey: 'order_number',
    cin7IdField: 'SaleID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '10 */2 * * *',
    estimatedRowsPerMonth: 1300,
    listCallsPerPass: 2,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/open-orders.js:59',
      'features/excel-sync (dataset monthly-sales)',
      'rapid_inv.v_an_monthly_sales',
    ],
    notes:
      'Cin7 NÃO tem webhook de pedido criado — por isso este ciclo existe. Janela de 3h a cada ' +
      '2h = 1h de sobreposição (SYNC_HOURS, backfill-sales.js:248). Escreve SÓ colunas de ' +
      'cabeçalho: mapHeader (:76-90) não toca sale_lines. É por isso que "cabeçalho completo" ' +
      'e "linha vazia" convivem. Workflow: .github/workflows/cin7-sales-sync.yml:17.',
  },

  {
    id: 'sale_status_reconcile',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/reconcile-sales.js:70-113',
    domain: 'sales',
    cin7Endpoint: 'saleList',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 10,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'sales_orders',
    upsertKey: 'order_number',
    cin7IdField: 'OrderNumber',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '40 15 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 200,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/open-orders.js:59 (quadro de chase)',
      'features/logistics/invoicing-monitor.js:242',
    ],
    notes:
      'Backstop de webhook perdido: 1 chamada `Search=` POR PEDIDO (não é lote), CAP=200/run ' +
      '(cin7-sales-reconcile.yml:40). RECONCILE_SO_SINCE já é 2025-08-01 (:31), alinhado à meta. ' +
      'NÃO é ferramenta de backfill: 16.900 pedidos a 200/dia = 85 dias. mapStatus (:57-68) ' +
      'escreve só status/valor — nenhuma linha, nenhum rep, nenhuma location. ' +
      'O comentário do yml:16 diz "a cada 6h" e mente: o cron é diário.',
  },

  // ───────────────────────────────────────────────────────────────────
  // VENDAS — detalhe (o buraco principal da meta de 13 meses)
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'sale_detail_month',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/backfill-sales.js:279-368 (modo `detail-month`)',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID}',
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: 1,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'sale_lines',
    upsertKey: 'order_number,line_no',
    cin7IdField: 'SaleID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '0 19 * * 0-4',
    estimatedRowsPerMonth: 1300,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 16900,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'sales_detail',
    consumers: [
      'features/stock-planning/db/006_overview_views.sql:198-213 (v_sp_actual_weekly)',
      'features/stock-planning/db/010_wkavg_drift.sql:13-37',
      'features/analytics/db/001_analytics_views.sql:128-130 (backorder)',
      'features/excel-sync/specs/datasets/monthly-sales.toml (gate min_detail_coverage_pct = 99)',
      'features/logistics/open-orders.js:256',
      'home.js:1220-1224',
    ],
    notes:
      'ÚNICO modo que fecha um mês de verdade: pega qualquer status (só derruba VOIDED/CANCELLED, ' +
      ':320-321), re-busca o que o Cin7 mudou (:327-328) e poda linha órfã via pruneStaleLines ' +
      '(:362). O cron só alcança mês corrente + 1 anterior (DETAIL_MONTH_BACK=1 fixo em ' +
      'cin7-sales-detail-month.yml:75) e o modo só existe desde 2026-08-08 — daí o buraco de ' +
      '2025-08 a 2026-06 medido pelo próprio repo em 006_overview_views.sql:193. ' +
      'CUSTO DO BACKFILL: 16.900 chamadas (13 x 1.300 x 1). A 24/min = 11,7h; a 15/min = 18,8h. ' +
      'Os cabeçalhos do mês vêm do SUPABASE, não do Cin7 (:300-308) → 0 chamada de lista. ' +
      'ARMADILHA: com BACK=1, um dispatch para 2025-08 varre 2 meses (~2.600) contra ' +
      'DETAIL_MONTH_CAP=2000 (yml:76), e 2.000 x 2,5s = 83min contra timeout-minutes: 90 (yml:54). ' +
      'Para os 11 meses: rodar local com DETAIL_MONTH_BACK=0, um mês por vez.',
  },

  {
    id: 'sale_detail_open',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/backfill-sales.js:210-241 (modo `detail-open`)',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID}',
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: 1,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'sale_lines',
    upsertKey: 'order_number,line_no',
    cin7IdField: 'SaleID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '5 */6 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/open-orders.js:256 (linha expandida do chase)',
      'features/logistics/open-orders-notes.js:132',
    ],
    notes:
      'ESTRUTURALMENTE INCAPAZ de fechar histórico, e é de propósito: filtra ' +
      'shipping_status <> SHIPPED e order_status = AUTHORISED (:217) e só aceita ' +
      'detail_synced_at IS NULL (:219). Pedido de 2025 já embarcou → nunca é candidato. ' +
      'NÃO chama pruneStaleLines (:235). Cap 60/run (cin7-open-detail-sync.yml:41).',
  },

  {
    id: 'sale_detail_recent',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/backfill-sales.js:167-201 (modo `detail`) — sem workflow',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID}',
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: 1,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'sale_lines',
    upsertKey: 'order_number,line_no',
    cin7IdField: 'SaleID',
    mechanism: 'sob-demanda',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'public.pick_anomaly_orders (via pick-anomalies-engine, backfill-sales.js:194)',
    ],
    notes:
      'NÃO usar para a meta. Janela cin7_updated >= now-14d (:171,:179): pedido de 2025 que o ' +
      'Cin7 não tocou é inalcançável para sempre. Não está em nenhum workflow. Marca ' +
      'detail_synced_at MESMO em falha (:188), o que faz o pedido parecer detalhado. ' +
      'Não chama pruneStaleLines (:193). Mantido no catálogo porque o modo existe e alguém ' +
      'vai encontrá-lo: esta entrada é o aviso.',
  },

  // ───────────────────────────────────────────────────────────────────
  // VENDAS — webhooks
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'sale_webhook_ship',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/movement-processor.js:102-105,240-330 + sales-mirror.js:42-56',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID}',
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: 1,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=webhook) — movement-processor.js:158-165',
    cin7IdField: 'SaleID',
    mechanism: 'webhook',
    webhookEvents: ['Sale/ShipmentAuthorised'],
    cycleCron: null,
    estimatedRowsPerMonth: 1300,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/pick-anomalies/pick-anomalies-engine.js:319 (bin de origem do pick)',
      'features/pick-anomalies/pa-movements.js:60-62',
      'home.js:543-569 (painel de movimento)',
      'cin7-stock-sync/verify-coverage.js:149',
    ],
    notes:
      'WEBHOOK e não ciclo: é a saída física de estoque, precisa de latência zero para a ' +
      'análise de anomalia de picking. Único evento de venda que ENRIQUECE (1 chamada). ' +
      'TRÊS DEFEITOS ATIVOS: (1) upsertSalesMirror NÃO chama pruneStaleLines (sales-mirror.js:55) ' +
      '— re-embarque acumula linha órfã (foi assim que SO-281413 ficou com 149 linhas contra 100); ' +
      '(2) mapSaleLines (:43-47) não grava backorder_quantity, que mapLines grava ' +
      '(backfill-sales.js:115) e 3 views do analytics leem; (3) o `return []` em :264 marca o ' +
      'evento como processed com zero movimentos quando o fetch falha, e o mirror de venda nem ' +
      'roda (está depois, :288). NÃO RETROAGE: nasce em 2026-06-19 (commit 5f6c587).',
  },

  {
    id: 'sale_webhook_status',
    status: 'IMPLEMENTADO',
    implementedBy: 'cin7-stock-sync/movement-processor.js:106-126',
    domain: 'sales',
    cin7Endpoint: null,
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: null,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'sales_orders',
    upsertKey: 'order_number',
    cin7IdField: 'OrderNumber',
    mechanism: 'webhook',
    webhookEvents: ['Sale/Voided', 'Sale/Undo', 'Sale/InvoiceAuthorised'],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 0,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/invoicing-monitor.js:242,255',
      'features/logistics/open-orders.js:59',
      'public.pick_anomaly_orders (markOrderCancelledRealtime)',
    ],
    notes:
      'ZERO chamadas ao Cin7 — é reflexo local do payload. Sale/Undo é gravado cru DE PROPÓSITO ' +
      '(:109-110): reverte para status desconhecido, e o sync de 2h reconcilia honestamente.',
  },

  {
    id: 'sale_webhook_stage',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'sales',
    cin7Endpoint: null,
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: null,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'order_stage_events',
    upsertKey: 'order_id,stage',
    cin7IdField: 'SaleID',
    mechanism: 'webhook',
    webhookEvents: ['Sale/PickAuthorised', 'Sale/PackAuthorised', 'Sale/ShipmentAuthorised'],
    cycleCron: null,
    estimatedRowsPerMonth: 3900,
    listCallsPerPass: 0,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'cin7_mirror.order_stage_events (tempo-em-estágio do board)',
      'docs/PIPELINE_CONTROL_TOWER_PLAN.md',
    ],
    notes:
      'O SQL PROMETE E O CÓDIGO NÃO CUMPRE. sql/order_stage_events.sql:48-50 documenta que o ' +
      'worker do webhook faz upsert de picked/packed/shipped no instante do evento. ' +
      'movement-processor.js:127-131 joga Pick/PackAuthorised no ramo else ("recorded raw"). ' +
      'O único produtor real é o carimbo HORÁRIO de order-pipeline-sync.js:696-724 ' +
      "(source='sync') → resolução de 1 hora, e só desde 2026-03. " +
      'Os tópicos JÁ estão registrados (webhook-config.js:29-30): o conserto é escrever o ' +
      'handler, custo 0 chamadas.',
  },

  {
    id: 'sale_credit_note',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID} (bloco de credit note)',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'CreatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'sale_credit_lines',
    upsertKey: 'order_number,line_no',
    cin7IdField: 'SaleID',
    mechanism: 'webhook',
    webhookEvents: ['Sale/CreditNoteAuthorised'],
    cycleCron: null,
    estimatedRowsPerMonth: 39,
    listCallsPerPass: 0,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: COVERAGE_SINCE,
    consumers: [
      'features/stock-planning/db/006_overview_views.sql:203 (v_sp_actual_weekly — hoje soma BRUTA)',
      'features/returns/returns.js:836 (credit_note digitado à mão, sem write-back)',
    ],
    notes:
      'COBERTURA ZERO hoje. Sale/CreditNoteAuthorised está na taxonomia (webhook-config.js:9) e ' +
      'FORA de OUR_EVENTS (:24-32). Só existe sales_orders.credit_note_number, um TEXT do ' +
      'cabeçalho (sql/2026-06-17_sales_mirror.sql:54). Consequência: toda demanda calculada é ' +
      'BRUTA — nenhuma view subtrai devolução. ' +
      'CUSTO INCREMENTAL DO HISTÓRICO = 0 CHAMADAS: o JSON de sale?ID= que o backfill de detalhe ' +
      'já vai buscar carrega o bloco de credit note. É mapeamento + tabela nova, não API. ' +
      'Estimativa de volume: ~3% de 1.300/mês = 39/mês.',
  },

  {
    id: 'sale_lookup_live',
    status: 'IMPLEMENTADO',
    implementedBy: 'server.js:198-238 (/api/sale) e server.js:541-680 (/api/sale/:number)',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID}',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 20,
    cursorParam: null,
    targetSchema: null,
    targetTable: null,
    upsertKey: null,
    cin7IdField: 'SaleID',
    mechanism: 'sob-demanda',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 1,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/returns/returns.js:432-439 (busca do SO na tela de devolução)',
      'home.js:1227+ (fallback ao vivo quando não há espelho)',
    ],
    notes:
      'SOB-DEMANDA porque é o operador digitando um número que pode não estar no espelho. ' +
      '2 chamadas por leitura (Search + detalhe) e ZERO tratamento de 429 (grep "429" em ' +
      'server.js = 0 ocorrências). Depois do backfill de detalhe, ler sale_lines primeiro e ' +
      'cair para o Cin7 só quando não houver linha — o padrão que home.js:1220-1227 já faz. ' +
      'NADA é persistido: a resposta morre depois de preencher o formulário.',
  },

  {
    id: 'order_pipeline',
    status: 'PARCIAL',
    implementedBy: 'order-pipeline-sync.js:255-300,613-645,696-724',
    domain: 'sales',
    cin7Endpoint: 'saleList / stockTransferList (por Status)',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: 'CreatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'order_pipeline',
    upsertKey: 'id',
    cin7IdField: 'SaleID | TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '35 * * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 15,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/transfer-out/transfer-out.js:31 (type=TR, from=Main)',
      'features/stock-planning/routes/stock-planning-routes.js:466,495 (/find/orders)',
      'features/rapid-inventory/dashboard.html:1025 (v_open_sos)',
      'home.js (board do armazém)',
    ],
    notes:
      'NÃO É HISTÓRICO E NUNCA VAI SER — registre isso: sinceDate hardcoded 2026-03-01 ' +
      '(order-pipeline-sync.js:48) e cleanupCompleted APAGA COMPLETED/VOIDED/CLOSED com ' +
      'completed_at > 7 dias (:613-645). É uma janela viva de ~1.752 linhas. ' +
      'É o SEGUNDO espelho do mesmo pedido: chave `id`=SaleID contra sales_orders.order_number. ' +
      'Duas noções de "aberto" que podem discordar na tela. ' +
      'server.js:296-302 roda o mesmo sync por setInterval SEM guarda de VERCEL, duplicando o cron.',
  },

  {
    id: 'pick_anomaly_batch',
    status: 'IMPLEMENTADO',
    implementedBy: 'features/pick-anomalies/pick-anomalies-engine.js:783,873,954-964',
    domain: 'sales',
    cin7Endpoint: 'sale?ID={SaleID} + finishedGoods?TaskID={id}',
    listEndpoint: 'saleList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 100,
    cursorParam: 'UpdatedSince',
    targetSchema: 'public',
    targetTable: 'pick_anomaly_orders',
    upsertKey: 'order_number',
    cin7IdField: 'SaleID',
    mechanism: 'ciclo',
    webhookEvents: ['Sale/ShipmentAuthorised'],
    cycleCron: '30 3,15 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 3,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/pick-anomalies/pick-anomalies.html (monitor de anomalias)',
      'features/pick-anomalies/pa-movements.js',
    ],
    notes:
      'CICLO como BACKSTOP do webhook, não como fonte: a análise real acontece no ship ' +
      '(movement-processor.js:262-268). Cap 200/run a 2,5s. O saleList usa UpdatedSince, que ' +
      'filtra por LastModifiedOn e NÃO por OrderDate (aviso no cabeçalho do engine, :24).',
  },

  // ───────────────────────────────────────────────────────────────────
  // ESTOQUE
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'stock_snapshot_bin',
    status: 'IMPLEMENTADO',
    implementedBy: 'cin7-stock-sync/sync-service.js:253-257,461-480,681-715',
    domain: 'stock',
    cin7Endpoint: 'ref/productavailability',
    listEndpoint: 'ref/productavailability',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_snapshot',
    upsertKey: 'sku,location_name,bin,batch',
    cin7IdField: 'SKU + Location + Bin + Batch',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '0 * * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 15,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/pick-anomalies/pick-anomalies-engine.js:319 (EXIGE grão de bin)',
      'features/replenishment/replenishment.js:358',
      'features/stock-planning/db/007_live_stock.sql:56,70',
      'features/excel-sync/db/006_restock_suggestion.sql:91',
      'restock-v2.html:728',
      'home.js:125,149',
    ],
    notes:
      'CICLO e não webhook POR DECISÃO: Stock/AvailableStockLevelChanged é um firehose e está ' +
      'deliberadamente fora de OUR_EVENTS (webhook-config.js:22-23). ' +
      'ATENÇÃO — `ref/productavailability` NÃO aceita ModifiedSince: testado contra a API real ' +
      '(cin7-stock-sync/ARCHITECTURE.md:27 e :68, "confirmed: ModifiedSince returned same Total"). ' +
      'Por isso cursorParam é null e a varredura é sempre completa. ' +
      'Conta: 14.971 linhas / 1000 = 15 chamadas; o laço para quando a página vem com <1000 ' +
      '(sync-service.js:242), então são 15 exatas. 24 execuções/dia = 360 chamadas/dia. ' +
      'TRUNCATE+INSERT a cada hora (clearStockSnapshot, :704, RPC em schema.sql:255-263) — ' +
      'este recurso é o AGORA, nunca a série. Bin/Batch/ExpiryDate vêm de graça na mesma ' +
      'resposta (:468-470); não existe nenhuma flag CIN7_INCLUDE_BINS neste repo.',
  },

  {
    id: 'stock_availability_sku',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-availability.js:46-90',
    domain: 'stock',
    cin7Endpoint: 'ref/productavailability',
    listEndpoint: 'ref/productavailability',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_availability',
    upsertKey: 'sku,location',
    cin7IdField: 'SKU + Location',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '30 */4 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 15,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'cin7_mirror.chase_list (sql/2026-06-18_chase_automation.sql:80-81)',
      'features/logistics/open-orders-notes.js:132',
    ],
    notes:
      'SEGUNDA VARREDURA DO MESMO ENDPOINT: 90 chamadas/dia (6 x 15) sobre o recurso que ' +
      'stock_snapshot já varre 360 vezes/dia. docs/SYNC_WORKFLOWS.md:88 já estima "−90 Cin7 ' +
      'calls/day" ao aposentá-lo. ' +
      'PROVAVELMENTE ERRADO HOJE: :59-60 faz `on_order +=` e `in_transit +=` ATRAVÉS das linhas ' +
      'de bin, mas ambos são grandezas por LOCALIZAÇÃO (schema.sql:85 "Incoming from POs", :87 ' +
      '"In transfer between locations"). 14.971 linhas colapsam em 12.681 chaves → ~2.290 pares ' +
      'com mais de um bin têm o número MULTIPLICADO. ' +
      'CAMINHO SEM RISCO: virar VIEW sobre stock_snapshot com sum() em on_hand/allocated/available ' +
      'e MAX() em on_order/in_transit. chase_list e open-orders-notes continuam lendo o mesmo ' +
      'nome, sem tocar em nenhum dos dois. Validar o max() com 1 query, custo Cin7 zero.',
  },

  {
    id: 'stock_daily_history',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'stock',
    cin7Endpoint: null,
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: null,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_daily',
    upsertKey: 'snapshot_date,sku,location_name,bin,batch',
    cin7IdField: null,
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '0 * * * *',
    estimatedRowsPerMonth: 449130,
    listCallsPerPass: 0,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/stock-planning/db/006_overview_views.sql:12-13 (giro/DIO — hoje IMPOSSÍVEL)',
      'features/stock-planning (roll-week: foto da semana de reporte)',
      'features/analytics (estoque médio, ruptura, cobertura histórica)',
    ],
    notes:
      'NÃO É COMPRÁVEL DO CIN7 A NENHUM PREÇO. ref/productavailability não aceita ModifiedSince ' +
      '(ARCHITECTURE.md:27,:68) e não existe endpoint de saldo em data passada. ' +
      'backfillSince é NULL de propósito: 2025-08-01 → hoje é irrecuperável e o contrato precisa ' +
      'dizer isso por escrito, não deixar implícito. ' +
      'PARA FRENTE custa ZERO chamada: INSERT..SELECT de stock_snapshot ANTES do TRUNCATE ' +
      '(sync-service.js:704), no mesmo job que já baixou as linhas — o padrão de custo zero que ' +
      'cin7-sync.yml:48-49 já usa para track-first-arrivals. ' +
      'Volume: 14.971 linhas/dia x 30 = 449.130/mês no grão de bin (5,5M/ano). Se pesar, gravar ' +
      '(sku,location) e manter bin só nos últimos N dias.',
  },

  {
    id: 'stock_availability_by_sku_live',
    status: 'IMPLEMENTADO',
    implementedBy: 'features/wms/lib/cin7-wms-client.js:178-181',
    domain: 'stock',
    cin7Endpoint: 'ref/productavailability?Sku={sku}',
    listEndpoint: null,
    pageParam: null,
    limitParam: 'Limit',
    maxPageSize: 50,
    cursorParam: null,
    targetSchema: null,
    targetTable: null,
    upsertKey: null,
    cin7IdField: 'SKU',
    mechanism: 'sob-demanda',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/wms/lib/wms-engine.js:258-262 (stockLookup; 1 chamada POR COMPONENTE em assembly)',
    ],
    notes:
      'SOB-DEMANDA porque é o operador no chão de fábrica pedindo o bin de um SKU. ' +
      'CUSTO VIVO E IMPREVISÍVEL no pico do armazém, exatamente quando os crons rodam. ' +
      'O dado JÁ está em cin7_mirror.stock_snapshot no mesmo grão (sku, location, bin) com ' +
      'até 60 min de idade. Trocar por uma view wms.v_bin_stock sobre o espelho custa 0 chamada. ' +
      'CLAUDE.md proíbe prometer indicador de sync no WMS — mostre rótulo de FRESCOR, não ícone.',
  },

  // ───────────────────────────────────────────────────────────────────
  // MOVIMENTO — transferência / ajuste / montagem (SEM WEBHOOK NO CIN7)
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'transfer_header',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-transfers.js:51-74',
    domain: 'movement',
    cin7Endpoint: 'stockTransferList',
    listEndpoint: 'stockTransferList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_transfers',
    upsertKey: 'task_id',
    cin7IdField: 'TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '45 */2 * * *',
    estimatedRowsPerMonth: 2550,
    listCallsPerPass: null,
    callsPerRow: 0,
    callsPerFullPass: 67,
    backfillSince: COVERAGE_SINCE,
    consumers: [
      'features/logistics/open-orders.js:79-100 (Branch Transfers control tower)',
      'home.js:1277-1500 (tabela de TRs + Find TR)',
      'features/gateway/gateway-inventory-engine.js:516',
      'features/analytics/db/001_analytics_views.sql:152-177',
    ],
    notes:
      'CICLO OBRIGATÓRIO: o Cin7 NÃO tem webhook de transferência (taxonomia em ' +
      'webhook-config.js:9-16; o próprio sync-transfers.js:3 diz "Cin7 has NO transfer webhook"). ' +
      'ORDENAÇÃO MEDIDA: stockTransferList é ordenada por CRIAÇÃO, não por LastModifiedOn — a ' +
      'página P devolve TR-(50090−P), verificado em 12 sondagens. Logo o comentário de :65 ' +
      '("most-recently-modified → catches completions/changes") é FALSO: mudança de status não ' +
      'reordena a lista, e é essa a causa-raiz dos 232 fantasmas de IN TRANSIT. ' +
      'A lista IGNORA UpdatedSince/ModifiedSince (medido; reconcile-transfers.js:9 registra o mesmo). ' +
      'BURACO: sync busca IN TRANSIT + DRAFT (:64) mas open-orders.js:79 filtra por ORDERED — ' +
      'status que a lista NUNCA busca. Conserto de 1 linha. ' +
      'COLUNAS MORTAS: line_count, total_qty e required_by (DDL em 2026-06-17_sales_mirror.sql:120-122) ' +
      'não são escritas por nada — open-orders.js:84,91 e home.js:1316 as renderizam em branco. ' +
      'BACKFILL: Total medido hoje = 50.089; o corte de 2025-08-01 fica em ~TR-17.000 (índice ' +
      '~33.100). 33.100/500 = 67 páginas ≈ 4,5 min a 15/min. É barato — faça primeiro.',
  },

  {
    id: 'transfer_reconcile',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/reconcile-transfers.js:79-113',
    domain: 'movement',
    cin7Endpoint: 'stockTransferList?Search={number}',
    listEndpoint: 'stockTransferList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 10,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_transfers',
    upsertKey: 'task_id',
    cin7IdField: 'TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '20 3 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 2,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/open-orders.js:79 (fecha TR fantasma no quadro)',
    ],
    notes:
      'CONJUNTOS ABERTOS DIVERGENTES: reconcile fecha IN TRANSIT + ORDERED (:79-80), sync busca ' +
      'IN TRANSIT + DRAFT (sync-transfers.js:64). ORDERED nunca é varrido, DRAFT nunca é ' +
      'reconciliado — um DRAFT que completou fica DRAFT para sempre. ' +
      'Cron é DIÁRIO (yml:16) enquanto o comentário na mesma linha e o cabeçalho (:6) prometem 6h. ' +
      'Com CAP=300 e ~85 TRs saindo do aberto por dia, uma rodada diária mal empata. ' +
      'PROTEÇÃO BOA que deve ser copiada: aborta se o conjunto vivo vier VAZIO (:87), para não ' +
      'interpretar blip de API como "tudo completou".',
  },

  {
    id: 'transfer_lines',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'movement',
    cin7Endpoint: 'stockTransfer?TaskID={id}',
    listEndpoint: 'stockTransferList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_transfer_lines',
    upsertKey: 'task_id,line_no',
    cin7IdField: 'TaskID',
    mechanism: 'backfill',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 2550,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 33100,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'tr_detail',
    consumers: [
      'features/logistics/open-orders-notes.js:19-34 (hoje AO VIVO, cache de 10 min)',
      'features/transfer-out/transfer-out-engine.js:38 (hoje AO VIVO)',
      'features/analytics/db/001_analytics_views.sql:152 (v_an_transfer_leadtime)',
      'features/replenishment/replenishment-config.js:297-302 (demanda inflada por transferência)',
    ],
    notes:
      'NÃO EXISTE TABELA. open-orders-notes.js:19-20 diz por escrito: "the mirror stores ' +
      'transfers header-only, so line items aren\'t there to read". Cada expansão de TR na tela ' +
      'dispara uma chamada VIVA em horário de operação, disputando o mesmo teto de 60/min dos crons. ' +
      'CUSTO: 33.100 detalhes (1 por TR na janela) = 36,8h a 15/min ou 23,0h a 24/min. É a única ' +
      'peça que NÃO cabe num fim de semana — trate como dreno de fundo, com checkpoint em ' +
      'cin7_mirror.backfill_state (job/last_page/last_cursor/done/total_target/processed já existem).',
  },

  {
    id: 'transfer_movements',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-movements.js:69-89,141,174-195',
    domain: 'movement',
    cin7Endpoint: 'stockTransfer?TaskID={id}',
    listEndpoint: 'stockTransferList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181',
    cin7IdField: 'TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '50 */6 * * *',
    estimatedRowsPerMonth: 2550,
    listCallsPerPass: null,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/pick-anomalies/pa-movements.js:60-62 (aba Movements audit)',
      'home.js:543-569,663-671 (painel de transferências)',
      'cin7-stock-sync/verify-coverage.js:282',
    ],
    notes:
      'CICLO OBRIGATÓRIO (sem webhook). Gera PAR out/in por linha de TR. ' +
      'Janela = MOVE_SINCE_DAYS=1 forçado no workflow (cin7-movements-sync.yml:50) contra default ' +
      '3 no código (:32). Nasce em 2026-06-19 (commit 5f6c587) → 322 dias sem nada. ' +
      'CAUDA QUE SOME EM SILÊNCIO: MOVE_TIME_BUDGET_MS=1200000 corta aos 20 min (:175) e ' +
      'MAX_CONSEC=4 erros também para (:190) — e em ambos o script sai com exit 0, por design. ' +
      'Como a janela é de 1 dia e a ordem é determinística, o que não for alcançado em ~8 ' +
      'execuções some para sempre, sem alarme. ' +
      'backfillSince é NULL porque a rota certa para o passado é transfer_lines (mesmo JSON, ' +
      'destino melhor) — backfillar os dois seria pagar 33.100 chamadas duas vezes.',
  },

  {
    id: 'transfer_lookup_live',
    status: 'IMPLEMENTADO',
    implementedBy: 'features/logistics/open-orders-notes.js:24 · features/transfer-out/transfer-out-engine.js:38 · features/wms/lib/cin7-wms-client.js:202',
    domain: 'movement',
    cin7Endpoint: 'stockTransfer?TaskID={id}',
    listEndpoint: null,
    pageParam: null,
    limitParam: null,
    maxPageSize: 1,
    cursorParam: null,
    targetSchema: null,
    targetTable: null,
    upsertKey: null,
    cin7IdField: 'TaskID',
    mechanism: 'sob-demanda',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/logistics/open-orders.js:262-268 (expansão de linha de TR)',
      'features/transfer-out/transfer-out.js:31 (pick sheet)',
    ],
    notes:
      'SOB-DEMANDA hoje POR FALTA de transfer_lines, não por escolha. Cache de 10 min em memória ' +
      '(open-orders-notes.js:19-34). Quando transfer_lines existir, esta entrada vira fallback: ' +
      'lê o espelho primeiro, chama o Cin7 só se não houver linha. ' +
      'ATENÇÃO: o Cin7 chaveia transferência por TaskID — `?ID=` devolve 400 ' +
      '(cin7-wms-client.js:202).',
  },

  {
    id: 'adjustment_movements',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-movements.js:94-118,142',
    domain: 'movement',
    cin7Endpoint: 'stockAdjustment?TaskID={id}',
    listEndpoint: 'stockAdjustmentList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181',
    cin7IdField: 'TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '50 */6 * * *',
    estimatedRowsPerMonth: 268,
    listCallsPerPass: null,
    callsPerRow: 1,
    callsPerFullPass: 3490,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'adj_detail',
    consumers: [
      'features/pick-anomalies/pa-movements.js:60-62 (chip stock_adjustment)',
      'cyclic-count.js (fechamento de contagem cíclica contra o ledger)',
    ],
    notes:
      'CICLO OBRIGATÓRIO: ajuste/stocktake NÃO tem webhook no Cin7 — é justamente o movimento ' +
      'que "não bate" (contagem, correção, perda), e sem ele nenhuma reconstrução de saldo fecha. ' +
      'stockAdjustmentList IGNORA UpdatedSince (medido: Total=12.732 inalterado). Lista é ' +
      'OLDEST-FIRST, o script anda de trás para frente (reverse:true, :154-156). ' +
      'MEDIDO HOJE: page 9.300 = ST-09379 em 2025-08-05, page 9.500 = ST-09580 em 2025-08-20 → ' +
      '200 ajustes em 15 dias = 13/dia; corte de 2025-08-01 no índice ~9.250 → 3.482 ajustes na ' +
      'janela = 268/mês. Custo: 8 páginas de cauda + 3.482 detalhes = 3.490 ≈ 3,9h a 15/min. ' +
      'DOIS DEFEITOS SEMÂNTICOS: (1) movement-schema.sql:44 declara "write_off" mas :112-115 ' +
      'grava TUDO como stock_adjustment e joga o motivo em raw_data.reason (texto livre) — ' +
      'descarte e recontagem no mesmo balde; (2) ajuste com delta 0 é descartado (:110), então ' +
      'correção que só move de bin desaparece do ledger.',
  },

  {
    id: 'assembly_movements',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-assembly.js:59-87,97-126',
    domain: 'movement',
    cin7Endpoint: 'finishedGoods?TaskID={id}',
    listEndpoint: 'finishedGoodsList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=assembly-sync) — sync-assembly.js:125',
    cin7IdField: 'TaskID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '50 */6 * * *',
    estimatedRowsPerMonth: 586,
    listCallsPerPass: null,
    callsPerRow: 1,
    callsPerFullPass: 7631,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'asm_detail',
    consumers: [
      'features/pick-anomalies/pa-movements.js:60-62 (chip assembly_consume)',
      'features/pick-anomalies/pick-anomalies-engine.js (analyzeAssemblyRealtime)',
      'cin7-stock-sync/verify-coverage.js:167-190 (captura de montagem)',
    ],
    notes:
      'CICLO OBRIGATÓRIO: produção/finished goods NÃO tem webhook no Cin7. É o ponto cego citado ' +
      'no próprio cabeçalho do arquivo (sync-assembly.js:3-6): componente consumido em kit sai do ' +
      'bin SEM venda e SEM webhook. ' +
      'finishedGoodsList IGNORA UpdatedSince (medido: Total=26.315 inalterado) e é OLDEST-FIRST. ' +
      'MEDIDO: page 19.000 = FG-19747 em 2025-08-14, page 19.500 = FG-20273 em 2025-09-05 → ' +
      '500 builds em 22 dias = 22,7/dia; corte de 2025-08-01 no índice ~18.700 → 7.615 builds = ' +
      '586/mês. Custo: 16 páginas de cauda + 7.615 detalhes = 7.631 ≈ 8,5h a 15/min. ' +
      'DOIS DEFEITOS NO WALK: (1) :108 só aceita Status==="COMPLETED", então VOIDED e WIP nunca ' +
      'entram (e há VOIDED no meio da lista, o que também explica ela não ser perfeitamente ' +
      'ordenada por data); (2) a parada :109 — fg.every(h => dt && dt < since) — NUNCA dispara ' +
      'numa página que contenha um h.Date nulo, então o job caminha as 53 páginas em vez de 1-2.',
  },

  {
    id: 'assembly_bom',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'movement',
    cin7Endpoint: 'finishedGoods?TaskID={id} (OrderLines = receita)',
    listEndpoint: 'finishedGoodsList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 100,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'assembly_bom',
    upsertKey: 'fg_sku,component_sku',
    cin7IdField: 'TaskID (da última build COMPLETED)',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 300,
    callsPerRow: 1.5,
    callsPerFullPass: 750,
    backfillSince: null,
    jobKey: 'asm_detail',
    consumers: [
      'features/wms/lib/wms-engine.js:315-325 (getRecipe — hoje AO VIVO, sem cache)',
      'features/logistics/open-orders-notes.js:53-81 (hoje AO VIVO, cache de 1h)',
    ],
    notes:
      'NÃO EXISTE ESPELHO e a receita é RECONSTRUÍDA AO VIVO EM DOIS LUGARES independentes, com ' +
      'caches diferentes. open-orders-notes.js:48-51 explica por quê: "Cin7 exposes no readable ' +
      'BOM template — product?ID BillOfMaterialsProducts comes back empty", então lê as PickLines ' +
      'consumidas pela build COMPLETED mais recente. ' +
      'CUSTO: ~300 SKUs de montagem (products com stock_locator em BOM/PRODUCTION, o critério de ' +
      'wms-engine.js:52) x ~2,5 chamadas = 750 ≈ 31 min. Depois disso, refresh semanal só dos SKUs ' +
      'com build nova. Troca custo VIVO e imprevisível no pico do armazém por 31 min de fim de semana. ' +
      'backfillSince NULL: receita é ESTADO, não série — o que importa é a build mais recente.',
  },

  // ───────────────────────────────────────────────────────────────────
  // COMPRAS — a maior lacuna, e o melhor retorno por chamada
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'purchase_header',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'purchase',
    cin7Endpoint: 'purchaseList',
    listEndpoint: 'purchaseList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: 'UpdatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'purchase_orders',
    upsertKey: 'po_number',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 380,
    listCallsPerPass: null,
    callsPerRow: 0,
    callsPerFullPass: 10,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'po_detail',
    consumers: [
      'features/stock-planning/db/003_views.sql:176-193 (v_sp_incoming — hoje 100% Excel)',
      'features/stock-planning/db/002_planning.sql:179 (rapid_inv.po_lines.cin7_po_id, reservado e NULL)',
      'features/container-builder/container-builder-engine.js:345 (hoje vê só 100 POs vivas)',
      'features/stock-planning/db/009_leadtime_and_buying.sql:31-46 (lead time medido)',
    ],
    notes:
      'A MAIOR LACUNA, e o dono já a registrou como prioridade 1 ' +
      '(docs/STOCK_PLANNING_03_CIN7_AUTOMATION.md:24 "não existe espelho. É a maior lacuna", :133-137). ' +
      'DESCOBERTA QUE MUDA O PLANO: purchaseList HONRA UpdatedSince — medido hoje, ' +
      'UpdatedSince=2025-08-01 → Total=4.943 contra 14.097 sem filtro. É o ÚNICO dos quatro ' +
      'endpoints de tarefa que aceita cursor de data. ' +
      'CUSTO DO BACKFILL DE CABEÇALHO: 4.943/500 = 10 chamadas ≈ 40s. Melhor retorno por chamada ' +
      'do repositório inteiro. ' +
      'REGRA DE PRECEDÊNCIA JÁ DECIDIDA (STOCK_PLANNING_03:141-143): Cin7 manda em quantidade, SKU ' +
      'e fornecedor; a DATA DE CHEGADA é nossa até o contêiner ser recebido. Sync NÃO pode ' +
      'sobrescrever due_date. ' +
      'Casar por sku_key = upper(btrim(sku)): a aba PO\'s grava maiúscula e as outras minúscula — ' +
      'custou 312 unidades num único SKU (002_planning.sql:271-278).',
  },

  {
    id: 'purchase_lines',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'purchase',
    cin7Endpoint: 'purchase?ID={id}',
    listEndpoint: 'purchaseList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: 'UpdatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'purchase_lines',
    upsertKey: 'po_number,line_no',
    cin7IdField: 'ID',
    mechanism: 'backfill',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 380,
    listCallsPerPass: 0,
    callsPerRow: 1,
    callsPerFullPass: 4943,
    backfillSince: COVERAGE_SINCE,
    jobKey: 'po_detail',
    consumers: [
      'features/stock-planning/db/006_overview_views.sql:8-11 (is_received=false em 1.466 linhas)',
      'features/stock-planning/db/009_leadtime_and_buying.sql:84-98 (v_sp_sku_leadtime)',
      'features/wms/lib/wms-receiving.js:18-28 (hoje AO VIVO)',
      'features/container-builder/container-builder-engine.js:390',
    ],
    notes:
      'On-order por SKU com PO, fornecedor e ETA não existe em lugar nenhum hoje. ' +
      'O agregado stock_snapshot.on_order diz "quanto vem" mas não "quando" nem "de quem". ' +
      'DEGRAU BARATO PRIMEIRO: só as 686 POs ABERTAS (medido: DRAFT 4 + ORDERING 207 + ORDERED 371 ' +
      '+ RECEIVING 104) = 686 detalhes + 4 listas de status = 690 chamadas ≈ 46 min. Isso sozinho ' +
      'destrava o Stock Planning. ' +
      'JANELA COMPLETA: 4.943 detalhes ≈ 5,5h a 15/min. ' +
      'Sem isto, is_received nunca vira true (PO recebida conta como estoque entrando PARA SEMPRE) ' +
      'e o lead time cai no FALLBACK de 12 semanas (009:86-90).',
  },

  {
    id: 'purchase_movements',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-movements.js:122-137,143',
    domain: 'purchase',
    cin7Endpoint: 'purchase?ID={id}',
    listEndpoint: 'purchaseList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 500,
    cursorParam: 'UpdatedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=movements-sync) — sync-movements.js:181',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '50 */6 * * *',
    estimatedRowsPerMonth: 380,
    listCallsPerPass: null,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/pick-anomalies/pa-movements.js:60-62 (chip purchase_receive)',
      'features/replenishment (entrada de estoque no ledger)',
    ],
    notes:
      'ESTRUTURALMENTE ERRADO E DE GRAÇA CONSERTAR. CFG.purchase (:143) filtra por LastUpdatedDate ' +
      'mas pagina de TRÁS PARA FRENTE (reverse:true, :154-156) numa lista ordenada por CRIAÇÃO ' +
      'crescente (page 1 = PO-00001, 2018-07-16). Uma PO criada em março e recebida hoje fica no ' +
      'índice ~12.700; o walk quebra na primeira página inteiramente antiga (:164), na página 29 ou ' +
      '28, e nunca a alcança. O slice de purchase só enxerga PO CRIADA na janela — recebimento em ' +
      'PO velha é INVISÍVEL. ' +
      'Conserto: trocar o walk por UpdatedSince (que este endpoint HONRA, medido) — corrige a ' +
      'cobertura E derruba o custo. ' +
      'DUPLICIDADE ATIVA com o webhook: aqui cin7_task_id = ID da purchase, lá = TaskID do ' +
      'StockReceived (movement-processor.js:570); cada um deduplica só dentro do próprio source → ' +
      'o mesmo recebimento pode aparecer duas vezes, em dois dias diferentes. ' +
      'docs/SYNC_WORKFLOWS.md:86-87 já propõe derrubar esta fatia por ser redundante com o webhook.',
  },

  {
    id: 'purchase_webhook_receive',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/movement-processor.js:144-145,568-650',
    domain: 'purchase',
    cin7Endpoint: 'purchase?ID={id}',
    listEndpoint: 'purchaseList?Search={number}',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 5,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'stock_movements',
    upsertKey: 'delete+insert por (cin7_task_id, source=webhook) — movement-processor.js:158-165',
    cin7IdField: 'TaskID do StockReceived',
    mechanism: 'webhook',
    webhookEvents: ['Purchase/StockReceivedAuthorised'],
    cycleCron: null,
    estimatedRowsPerMonth: 380,
    listCallsPerPass: 0,
    callsPerRow: 1.5,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/replenishment (entrada de estoque em tempo real)',
      'features/pick-anomalies/pa-movements.js:60-62',
    ],
    notes:
      'ÚNICO WEBHOOK DE ENTRADA que existe no repo — os outros três tipos de movimento não têm ' +
      'evento no Cin7. É por isso que ele merece webhook e transferência/ajuste/montagem não podem. ' +
      'CUSTO ESCONDIDO: o TaskID do webhook frequentemente NÃO é o purchase ID (movement-processor.js:' +
      '577-590) — quando cai no fallback são 2 chamadas extras (purchaseList?Search= + purchase?ID=). ' +
      'DEFEITO DE DATA: carimba detected_at = now() (:630) enquanto o poller carimba a data do ' +
      'negócio (sync-movements.js:39) — o mesmo recebimento cai em dois dias. ' +
      'PRÉ-REQUISITO OPERACIONAL: webhook-watchdog.js:88 reativa webhook com bearer VAZIO porque o ' +
      'workflow não injeta CIN7_WEBHOOK_TOKEN. Enquanto isso não for consertado, todo webhook novo ' +
      'entra na mesma armadilha e é auto-desativado pelo Cin7 após 6 falhas.',
  },

  {
    id: 'purchase_lookup_live',
    status: 'IMPLEMENTADO',
    implementedBy: 'features/container-builder/container-builder-engine.js:343-390 · features/wms/lib/cin7-wms-client.js:225-230',
    domain: 'purchase',
    cin7Endpoint: 'purchase?ID={id}',
    listEndpoint: 'purchaseList',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 100,
    cursorParam: null,
    targetSchema: null,
    targetTable: null,
    upsertKey: null,
    cin7IdField: 'ID',
    mechanism: 'sob-demanda',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 1,
    callsPerRow: 1,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/container-builder/container-builder.html (montagem de contêiner)',
      'features/wms/lib/wms-receiving.js:18-28 (recebimento no chão)',
    ],
    notes:
      'LIMITE DURO E INVISÍVEL: container-builder pede Page=1&Limit=100 e filtra no CLIENTE ' +
      '(:343-345, "Status filter not supported on /purchaseList directly"). Existem só 100 POs ' +
      'para esta tela, sempre as mais recentes. Cache de 5 min em memória. ' +
      'Quando purchase_header existir, esta tela lê o espelho e o teto de 100 desaparece.',
  },

  // ───────────────────────────────────────────────────────────────────
  // DADO MESTRE
  // ───────────────────────────────────────────────────────────────────
  {
    id: 'products',
    status: 'IMPLEMENTADO',
    implementedBy: 'cin7-stock-sync/sync-service.js:262-266,485-526,731-772',
    domain: 'master',
    cin7Endpoint: 'product',
    listEndpoint: 'product',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'ModifiedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'products',
    upsertKey: 'sku',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '15 16 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 12,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'supabase-config.js:27,76,112 (etiquetas / busca)',
      'features/returns/returns.js:343,364,530-544 (price_tier1)',
      'features/wms/lib/wms-engine.js:51,124-128 (barcode, attribute1, stock_locator)',
      'features/stock-planning/db/009_leadtime_and_buying.sql:66-76 (carton_quantity)',
      'features/stock-planning/db/008_sku_lifecycle.sql:46-84 (status)',
      'restock-v2.js:2710 · features/label-sheets/label-sheets.js:1179',
      '(40 arquivos no total — é a tabela mais lida do repo)',
    ],
    notes:
      'CICLO e não webhook POR ORDEM DE SEGURANÇA: Product/Updated existe na taxonomia ' +
      '(webhook-config.js:14) e assiná-lo é melhor que qualquer cron — mas NÃO antes de consertar ' +
      'webhook-watchdog.js:88, senão o Cin7 auto-desativa após 6 falhas e o watchdog reativa com ' +
      'token errado em loop. ' +
      '11.251 produtos (8.508 Active + 2.743 Deprecated) / 1000 = 12 chamadas, 1x/dia. ' +
      'cursorParam ModifiedSince É SUPORTADO (ARCHITECTURE.md:18,:35) e NÃO é usado — fetchProducts ' +
      '(:262-266) monta só IncludeDeprecated. Quem escreve no Cin7 usando products.id ' +
      '(wms-transfers.js:36-40) pode estar usando um id de até 24h atrás. ' +
      'SEM HISTÓRICO: average_cost / price_tier1 / status são sobrescritos todo dia. Valorar ' +
      'estoque de 2025 com o custo de hoje é errado e nada sinaliza isso. ' +
      'ARMADILHA DE SCHEMA: mapProductRow grava 36 colunas e o DDL versionado (schema.sql:36-60 + ' +
      'migrations/001) declara 23. As 13 restantes (length, width, height, dimensions_units, ' +
      'carton_*, price_tier1, price_tiers, warranty_name, tags) existem SÓ em produção, criadas à ' +
      'mão. Recriar o banco do schema.sql zera o catálogo com log VERDE (PGRST204 → recuperação ' +
      'linha a linha → recovered=0 → _syncProducts não lança → sync_runs.status=success).',
  },

  {
    id: 'locations',
    status: 'PARCIAL',
    implementedBy: 'cin7-stock-sync/sync-service.js:271-272,531-546,776-816',
    domain: 'master',
    cin7Endpoint: 'ref/location',
    listEndpoint: 'ref/location',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: null,
    targetSchema: 'cin7_mirror',
    targetTable: 'locations',
    upsertKey: 'name',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: '15 16 * * *',
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 2,
    callsPerRow: 0,
    callsPerFullPass: 0,
    backfillSince: null,
    consumers: [
      'features/wms/lib/wms-sync.js:29-58 (wms.bins) e :62-75 (wms.pickface)',
      'features/wms/lib/wms-transfers.js:23-25 (resolve GUID por NOME e escreve no Cin7)',
      'features/transfer-out/transfer-out.js:101 · transfer-out-staging.js:168',
      'features/wms/lib/wms-engine.js:27',
    ],
    notes:
      'QUEBRADO POR MODELAGEM, não por cobertura. A tabela tem CONSTRAINT uq_location_name UNIQUE ' +
      '(name) (schema.sql:27) e o upsert resolve por "name" (:802-806) — mas o Cin7 PERMITE nomes ' +
      'repetidos: o de-para cravado em order-pipeline-sync.js:51-64 lista 14 GUIDs para 12 nomes ' +
      '(Gold Coast, Coffs Harbour e Hobart com 2 GUIDs cada). Três GUIDs são destruídos a cada ' +
      'sync e o vencedor depende da ordem de paginação do Cin7 — NÃO determinista. ' +
      'Isso importa porque cinco features resolvem local POR NOME e mandam o GUID resultante para ' +
      'DENTRO do Cin7: um Transfer Out para "Hobart" vai para o GUID que sobreviveu ao último sync. ' +
      'parent_id NÃO É CONFIÁVEL: 007_live_stock.sql:20-24 registra Melbourne pendurado em "Ghost". ' +
      '1.417 locais / 1000 = 2 chamadas, 1x/dia.',
  },

  {
    id: 'customers',
    status: 'A CONSTRUIR',
    implementedBy: 'server.js:167-192 (só cache em memória de 1h — NADA persistido)',
    domain: 'master',
    cin7Endpoint: 'customer',
    listEndpoint: 'customer',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'ModifiedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'customers',
    upsertKey: 'customer_id',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 10,
    callsPerRow: 0,
    callsPerFullPass: 10,
    backfillSince: null,
    consumers: [
      'features/returns/returns.js:94,381 (business DEVE ser um cliente do Cin7; nome digitado é rejeitado)',
      'cin7_mirror.sales_orders.customer_id (GUID que hoje aponta para dimensão inexistente)',
    ],
    notes:
      'CICLO e não webhook por um motivo concreto: docs/RUNBOOKS.md:61 avisa que já existe um ' +
      'Customer/Updated de OUTRO sistema (n8n) na mesma conta Cin7 e que não se deve tocá-lo. ' +
      '(O Cin7 aceita até 5 webhooks do mesmo Type — manage-webhooks.js:7-8 — então coexistir é ' +
      'possível depois, mas não é a primeira coisa a fazer.) ' +
      'HOJE: `let _custCache = { at, list }` (server.js:169), TTL 3600000ms. Em Vercel serverless ' +
      'CADA lambda fria repete as 10 chamadas de paginação — N lambdas = 10N chamadas. ' +
      'Espelhar 1x/dia custa 10 chamadas FIXAS e o cache vira SELECT. ' +
      '~9.800 clientes / 1000 = 10 páginas. Returns BLOQUEIA a criação se o Cin7 estiver fora.',
  },

  {
    id: 'suppliers',
    status: 'A CONSTRUIR',
    implementedBy: null,
    domain: 'master',
    cin7Endpoint: 'supplier',
    listEndpoint: 'supplier',
    pageParam: 'Page',
    limitParam: 'Limit',
    maxPageSize: 1000,
    cursorParam: 'ModifiedSince',
    targetSchema: 'cin7_mirror',
    targetTable: 'suppliers',
    upsertKey: 'supplier_id',
    cin7IdField: 'ID',
    mechanism: 'ciclo',
    webhookEvents: [],
    cycleCron: null,
    estimatedRowsPerMonth: 0,
    listCallsPerPass: 1,
    callsPerRow: 0,
    callsPerFullPass: 1,
    backfillSince: null,
    consumers: [
      'features/stock-planning/db/002_planning.sql:107-134 (rapid_inv.suppliers + supplier_aliases, hoje 100% digitados)',
      'features/stock-planning/db/009_leadtime_and_buying.sql:31-46 (v_sp_supplier_leadtime)',
    ],
    notes:
      'REGISTRE ISTO NO CONTRATO PARA NINGUÉM PERDER UM DIA PROCURANDO: lead time e MOQ NÃO ' +
      'existem no Cin7 deste tenant. Medido hoje — /supplier (Total=500) devolve ID, Name, ' +
      'Currency, PaymentTerm, TaxRule, Discount, AdditionalAttribute1..10 e NENHUM campo de lead ' +
      'time ou MOQ; e 0 de 300 produtos amostrados têm Suppliers[] preenchido, com ' +
      'MinimumBeforeReorder = 0 em 300/300. ' +
      'O que o espelho RESOLVE é a IDENTIDADE: hoje rapid_inv.suppliers.code é um código inventado ' +
      'à mão, com 30 aliases para cobrir 26 grafias de ~22 fornecedores. ' +
      'Lead time medido continua vindo de rapid_inv.po_lines (Excel) até purchase_lines existir. ' +
      'Custo: 1 chamada (500 fornecedores cabem numa página).',
  },
];

// ═════════════════════════════════════════════════════════════════════
// DECISÕES REGISTRADAS — endpoints que existem e que NÃO usamos.
// Não são recursos (não têm consumidor), mas precisam ficar escritos para
// ninguém re-abrir a discussão daqui a seis meses.
// ═════════════════════════════════════════════════════════════════════
const DECISIONS = [
  {
    subject: 'Stock/AvailableStockLevelChanged (webhook)',
    decision: 'NÃO ASSINAR',
    why:
      'Firehose de alto volume, marcado como deliberadamente fora em webhook-config.js:22-23. ' +
      'movement-processor.js:139-143 tem a rota pronta, mas é código morto. ' +
      'Reabrir SE E QUANDO stock_daily existir — aí o custo de perder mudança entre duas ' +
      'varreduras horárias passa a importar.',
  },
  {
    subject: 'Stock/Transfer* e Stock/Adjustment* (webhook)',
    decision: 'NÃO EXISTEM NO CIN7',
    why:
      'movement-processor.js:135-138 roteia esses tópicos para _processStockTransfer (:385) e ' +
      '_processStockAdjustment (:494), mas OUR_EVENTS (webhook-config.js:24-32) não registra ' +
      'nenhum — e a taxonomia verificada (:9-16) não os lista. Os dois handlers NUNCA executam. ' +
      'CONSEQUÊNCIA PRÁTICA: dos 4 `return []` de movement-processor.js (:264, :394, :503, :592), ' +
      'só DOIS são alcançáveis — :264 (sale) e :592 (purchase). Consertar os quatro sem verificar ' +
      'isso é gastar metade do esforço em caminho morto.',
  },
  {
    subject: 'ref/category, ref/brand, ref/unitofmeasure, ref/pricetier',
    decision: 'NÃO ESPELHAR AGORA',
    why:
      'Zero chamadas no repo inteiro. Categoria/marca/UOM existem desnormalizados como texto em ' +
      'cin7_mirror.products (sync-service.js:491-495). Sem lista canônica não dá para saber se ' +
      '"LED Downlight" e "Downlight LED" são a mesma coisa — mas ninguém pede isso hoje. ' +
      'Custo se um dia pedirem: 5 chamadas, semanal.',
  },
  {
    subject: 'cin7_mirror.product_first_arrival',
    decision: 'ESCRITO, SEM LEITOR',
    why:
      'track-first-arrivals.js grava a tabela a cada hora (cin7-sync.yml:54, 0 chamadas Cin7) e ' +
      'NENHUM arquivo do repo a lê — grep confirma só o escritor, a migração, ' +
      'docs/DEAD_CODE_REGISTER.md e docs/RUNBOOKS.md. Fora do catálogo pela regra de consumidor ' +
      'nomeado. Decidir: ligar um leitor (ciclo de vida de SKU) ou aposentar.',
  },
  {
    subject: 'rapid_inv.weekly_sales / cin7-stock-sync/sync-rapid-inv-sales.js',
    decision: 'NÃO CONSERTAR O SCRIPT',
    why:
      'Quebrado em três camadas: (1) fonte é order_pipeline, que começa em 2026-03-01 e apaga ' +
      'concluído após 7 dias; (2) o flush zera o aggMap a cada 100 pedidos (:330-335) e o upsert em ' +
      '(week_start,sku) SUBSTITUI em vez de somar (:247-257); (3) não está em nenhum workflow. ' +
      'Estado medido: 932 linhas, TODAS da mesma semana (006_overview_views.sql:12-13) — o que há ' +
      'ali veio do import de Excel. Aponte a demanda para sale_lines (que o Stock Planning JÁ lê) e ' +
      'trate weekly_sales como legado. Consta em docs/DEAD_CODE_REGISTER.md:66.',
  },
  {
    subject: 'Criar PO no Cin7 (escrita)',
    decision: 'NÃO NA V1',
    why:
      'docs/STOCK_PLANNING_03_CIN7_AUTOMATION.md:130-133. A ordem certa é: espelho de leitura ' +
      'confiável por algumas semanas → recomendação de compra → só então escrita, sempre com ' +
      'revisão humana. rapid_inv.po_lines.cin7_po_id já está reservado.',
  },
];

// ═════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════

const MECHANISMS = ['webhook', 'ciclo', 'sob-demanda', 'backfill'];
const STATUSES = ['IMPLEMENTADO', 'PARCIAL', 'A CONSTRUIR'];

/** Um recurso pelo id. Retorna null (não lança) — é catálogo, não runtime. */
function byId(id) {
  if (!id) return null;
  return RESOURCES.find((r) => r.id === id) || null;
}

/**
 * Todos os recursos de um mecanismo. Sem argumento, devolve o agrupamento
 * inteiro { webhook: [...], ciclo: [...], 'sob-demanda': [...], backfill: [...] }.
 */
function byMechanism(mechanism) {
  if (mechanism === undefined || mechanism === null) {
    const out = {};
    for (const m of MECHANISMS) out[m] = RESOURCES.filter((r) => r.mechanism === m);
    return out;
  }
  return RESOURCES.filter((r) => r.mechanism === mechanism);
}

/** Meses fracionários entre dois ISO. Nunca negativo. */
function monthsBetween(fromISO, toISO) {
  const a = new Date(fromISO);
  const b = new Date(toISO);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth()) +
    (b.getUTCDate() - a.getUTCDate()) / 30.4375;
  return Math.max(0, months);
}

/**
 * Custo total, em chamadas ao Cin7, de backfillar TUDO que é backfillável a
 * partir de `sinceISO`.
 *
 * Como a conta é feita, por recurso:
 *   linhas    = estimatedRowsPerMonth x meses(max(sinceISO, backfillSince) → until)
 *   detalhes  = round(linhas) x callsPerRow
 *   listas    = listCallsPerPass, quando fixo;
 *               senão ceil(linhas / maxPageSize)
 *               + 1 sonda quando cursorParam é null (o `?Page=1&Limit=1` que
 *                 sync-movements.js:145 faz para descobrir o Total)
 *
 * Devolve o detalhamento por recurso, não só o número — quem for executar
 * precisa saber em que ordem gastar as chamadas.
 *
 * O derivado fica ~1,4% ABAIXO de `callsPerFullPass` e está certo: o congelado
 * usa 13 meses redondos, e 2025-08-01 → 2026-08-26 são 12,8. Os dois números
 * aparecem lado a lado no resultado (`calls` e `frozenFullPass`) de propósito —
 * divergência maior que isso significa que alguém mexeu numa estimativa.
 *
 * @param {string} sinceISO   início da janela (default COVERAGE_SINCE)
 * @param {object} [opts]     { until, callsPerMin } — until default COVERAGE_UNTIL,
 *                            callsPerMin default 15 (o throttle padrão do repo)
 */
function totalCallsForBackfill(sinceISO, opts) {
  const options = opts || {};
  const since = sinceISO || COVERAGE_SINCE;
  const until = options.until || COVERAGE_UNTIL;
  const callsPerMin = options.callsPerMin || 15; // BACKFILL_THROTTLE_MS=4000

  const items = [];
  let totalCalls = 0;

  for (const r of RESOURCES) {
    if (!r.backfillSince) continue;
    const from = since > r.backfillSince ? since : r.backfillSince;
    const months = monthsBetween(from, until);
    const rows = Math.round((r.estimatedRowsPerMonth || 0) * months);
    const detailCalls = Math.round(rows * (r.callsPerRow || 0));

    let listCalls;
    if (r.listCallsPerPass !== null && r.listCallsPerPass !== undefined) {
      listCalls = r.listCallsPerPass;
    } else {
      listCalls = r.maxPageSize ? Math.ceil(rows / r.maxPageSize) : 0;
      if (!r.cursorParam) listCalls += 1; // sonda de Total
    }

    const calls = listCalls + detailCalls;
    totalCalls += calls;
    items.push({
      id: r.id,
      status: r.status,
      mechanism: r.mechanism,
      targetTable: r.targetSchema ? r.targetSchema + '.' + r.targetTable : r.targetTable,
      months: Math.round(months * 10) / 10,
      rows: rows,
      listCalls: listCalls,
      detailCalls: detailCalls,
      calls: calls,
      minutes: Math.round(calls / callsPerMin),
      frozenFullPass: r.callsPerFullPass,
    });
  }

  items.sort((a, b) => a.calls - b.calls); // o barato primeiro: é a ordem de execução

  return {
    since: since,
    until: until,
    callsPerMin: callsPerMin,
    rateLimitPerMin: RATE_LIMIT_PER_MIN,
    totalCalls: totalCalls,
    totalMinutes: Math.round(totalCalls / callsPerMin),
    totalHours: Math.round((totalCalls / callsPerMin / 60) * 10) / 10,
    items: items,
  };
}

module.exports = {
  CATALOG_VERSION,
  CIN7_BASE,
  RATE_LIMIT_PER_MIN,
  COVERAGE_SINCE,
  COVERAGE_UNTIL,
  MECHANISMS,
  STATUSES,
  RESOURCES,
  DECISIONS,
  byId,
  byMechanism,
  totalCallsForBackfill,
};
