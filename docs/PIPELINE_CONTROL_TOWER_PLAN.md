# Pipeline Control Tower — Plano de Trabalho

> **Objetivo (North Star):** capturar **tudo**, monitorar **tudo**, o mais **live** possível.
> Manter a visão profunda do **Main** (scanner) **e** ganhar a visão de **rede** — todos os
> armazéns, todos os pedidos abertos **e** processados, em todo estágio. Transformar o board
> passivo de contagens num **control tower** que lidera por exceções.

- **Status:** **Fase 0 implementada no dev** (seletor de armazém, faixa de exceções + backorders, modal profissional, fixes de fullscreen). Pendente na Fase 0: limpeza de código morto + carimbo de freshness. Fases 1+ a seguir.
- **Escopo:** app Rapid-Labels (Node/Express + vanilla JS), home dashboard.
- **Fonte da verdade dos fatos:** análise multi-agente de 25/08/2026 (5 leituras do código real + sonda ao vivo). Artifact: `Pipeline Control Tower`. Referências em `arquivo:linha` mantidas abaixo.
- **Regra de ouro:** nunca inventar dado. Métrica de scanner NÃO existe fora do Main → mostrar "sem scanner / n/a", **nunca "0"**.

---

## 1. Estado atual reconfirmado (fatos)

Board = `cin7_mirror.order_pipeline` (espelho do Cin7/DEAR) desenhado como funil de 4 estágios.

- **Funil:** Ordered → Picking → To Pack → Completed. Estágios saem de `pick_status/pack_status` (não de `status`), então cada pedido cai em 1 tile só. `home.js:306-328`, markup `index.html:181-205`.
- **Duas fontes de dado (freshness diferente na mesma tela):**
  - **Mirror (horário):** `order_pipeline` sincroniza de hora em hora — cron GitHub `35 * * * *` (`order-pipeline-sync.yml:23`) **+** o próprio server via `setInterval` de 1h (`server.js:295-302`). Alimenta Ordered/Picking/ToPack. **Até ~1h de atraso.**
  - **Webhook (~1min):** `pick_anomaly_orders` (data real de `ShipmentDate`). Alimenta "Completed hoje", o gráfico e a Pick Accuracy. `home.js:330-344`.
- **Por que Completed foge do mirror:** `order_pipeline.completed_at` é a **hora do sync**, não do ship (`order-pipeline-sync.js:345-347`). Já "leu 0 com ~100 expedidos".
- **Só o Main:** `mainPipeline = filter(from_location === 'Main Warehouse')` (`home.js:301-302`). Os outros **9 armazéns** (Project 71, Sunshine Coast 70, Sydney 68, Brisbane 49, Cairns 34, Melbourne 30, Coffs 27, Hobart 9, Gateway 1) somem — **~350 pedidos abertos invisíveis**.
- **Refresh:** tiles 60s (`home.js:390`), gráfico 5min (`home.js:394`) — mas fonte horária.
- **Aging:** janela de 5 dias; o mais velho sai da contagem e vira legenda cinza `· N aged` (`home.js:319-327, 355-356`). Nunca fica vermelho.
- **Alertas:** exatamente **1** proativo — `whSyncInfo` fica vermelho se sync > 120 min (`home.js:364-371`). Nada mais.
- **BACKORDERED (113 hoje):** não entra em nenhum tile e é excluído da visão padrão do modal (`home.js:322, 951`). Ponto cego total.
- **Sem observabilidade do sync:** o sync do pipeline **não grava** `sync_runs`. Se os 2 agendadores morrerem, ninguém é avisado. **Já congelou 2 dias.**
- **Sem SLA possível:** `order_pipeline` não traz data prometida/ship-by nem timestamp por estágio (`order-pipeline-sync.js:328-348`). Só `order_date` (só data, ruidoso).
- **Fullscreen quebra:** os modais ficam FORA do `#whPipelineCard` → no fullscreen renderizam atrás (cliques mortos); e o gráfico volta pra paleta clara no rebuild de 5min (ilegível no navy).
- **Código morto:** feed `addActivity` + 4 health dots + KPIs que renderizam em elementos que não existem mais (`home.js:47-48, 36-45`).
- **Dois agendadores não-coordenados** fazem poll do Cin7 pela mesma chave (idempotente, mas carga dobrada).

---

## 2. Arquitetura — duas faixas (decisão travada)

Existem **dois graus de sinal**. A decisão NÃO é "Main ou rede" — é **as duas faixas juntas**.

| | **Faixa A — Rede (order-status)** | **Faixa B — Main (scanner)** |
|---|---|---|
| **Escopo** | Todos os 10 armazéns | Só Main Warehouse |
| **Fonte** | `order_pipeline` (Cin7 CombinedPicking/PackingStatus) | `pick_anomaly_orders` + `scanner_activity` (webhook, hardcoded `Location=Main`) |
| **Mostra** | Aguardando pick · Picking · To Pack · Backordered · Transfers | Expedido hoje (real-time) · Pick accuracy % · Produtividade por operador |
| **Freshness** | Até ~1h (mirror) → alvo ~1min via webhook | ~1min já |
| **Dado novo?** | **Nenhum** — já está no mirror | já existe |

**Regras travadas:**
1. 3 dos 4 tiles atuais (Ordered/Picking/ToPack) já são order-status → rodam pra rede **sem dado novo** (só tirar o filtro `home.js:301-302`).
2. Métrica de scanner **nunca** aparece pra branch como "0" — mostrar "sem scanner".
3. Toda métrica na tela carrega um rótulo honesto de **fonte + idade** (mirror horário vs webhook ~1min).

---

## 3. Estratégia de dado & freshness ("o mais live possível")

Meta: capturar todo pedido, todo estágio, toda transição — e mostrar o mais perto de tempo-real que o dado permite.

- **Agora:** poll 60s em cima de mirror horário. Só Completed/gráfico são frescos.
- **Alvo 1 — funil ao vivo:** alimentar Ordered/Picking/ToPack pelos webhooks que já assinamos (`Sale/PickAuthorised`, `Sale/PackAuthorised`, `Sale/ShipmentAuthorised`) → funil a ~1min, relegando o poll horário a backstop.
- **Alvo 2 — capturar toda transição:** criar uma tabela de **histórico de status por estágio** (event log): `(order_id, from_stage, to_stage, at, warehouse, source)`. É o dado que **não existe hoje** e que destrava tempo-em-estágio (horas), cycle time real e "capturar tudo" de verdade.
- **Alvo 3 — heartbeat + alerta:** cada sync grava `cin7_mirror.sync_runs` (started/ended/status/rows/error). Board lê disso (não de `max(synced_at)`). Cron com `if: failure()` avisa. Fecha o gap "background jobs sem alerta".
- **Coordenar os 2 agendadores:** definir 1 primário (GitHub cron) e colocar o `setInterval` do server atrás de env flag / lease, pra não fazer poll dobrado.
- **Localização desconhecida:** hoje um UUID de armazém novo vira `from_location=null` e o pedido some silenciosamente (`order-pipeline-sync.js:50-65, 339`). Adicionar log/bucket "Unknown".

---

## 4. Workstreams por fase (com aceite)

### Fase 0 — Rede + Exceções · **só front-end, zero dado novo** · ALTO valor
- [x] **Faixa A de rede:** tirar o filtro Main; agrupar Ordered/Picking/ToPack por `from_location` (roll-up de todos os sites). Reusar a lógica de estágio `home.js:322-328` sem mudança.
  - *Aceite:* os 10 armazéns aparecem; totais batem com o mirror; Main continua com seu funil detalhado.
- [x] **Faixa de exceções** (oldest-first, cada uma com estado **vermelho/âmbar** clicável → abre modal filtrado):
  - Pick atrasado (`ORDERED`, não picking/picked, `order_date` > N dias úteis)
  - Backorder pile-up (`BACKORDERED`, contagem + idade do mais velho) — **dar visibilidade**
  - Pack backlog (`PICKED` e não `PACKED`, > X h)
  - Dispatch backlog (`PACKED` e não shipped)
  - *Aceite:* backorders deixam de ser invisíveis; thresholds coloram o tile; clique leva à fila.
- [x] **Fullscreen:** re-parentar (ou mover) os modais pra dentro do elemento fullscreen; re-aplicar a paleta dark do gráfico no rebuild de 5min.
  - *Aceite:* na parede, tiles e "all ›" abrem; o gráfico continua legível depois de 5min.
- [x] **Título + escopo:** "Warehouse Pipeline" visível; rótulo por faixa (Rede vs Main-scanner).
- [ ] **Limpeza:** apagar CSS morto (`.wh-hero*`, `.wh-flow-foot`, `.wh-foot-*`, `.wh-kpi*`) e o feed `addActivity`/health/KPIs mortos.
- [ ] **Refresh honesto:** carimbo de idade/fonte por faixa (mirror horário vs webhook ~1min).

### Fase 1 — Honestidade + cutoff + heartbeat · front + 1 workflow
- [ ] `sync_runs` para o order-pipeline sync + board lendo dele + `if: failure()` no cron.
- [ ] Relógio de **cutoff** (regra de negócio, **17h AEST** — D1 confirmado) + burndown "due-today vs shipped" no Main (usando `fulfilled_date` fresco).
- [ ] Alinhar o threshold vermelho do sync à cadência (~130-150 min = 2 runs perdidas) e corrigir o comentário `:15` vs `:35` no YAML.

### Fase 2 — Tempo real de estágio · modelo de dados
- [ ] Tabela **status-history / event log** por estágio → tempo-em-estágio (horas), cycle time e **hora (AM/PM) por stage**. **Migração pronta: `sql/order_stage_events.sql`** — Joao aplica no SQL Editor. Depois: capturar via webhook (Pick/Pack/ShipmentAuthorised) + backfill pelo sync; exibir "Picked 2:14pm" nas listas.
- [ ] Alimentar Ordered/Picking/ToPack por **webhook** → funil ~1min.
- [ ] Sincronizar a **data ship-by** do Cin7 pro `order_pipeline` → SLA e **on-time-ship %** reais.
- [ ] Persistir `completed_at` = ShipmentDate real (ou declarar `fulfilled_date` como única fonte de conclusão).

### Fase 3 — Entrega de alerta + parede
- [ ] Alerta por e-mail/Slack/push nas exceções (breach).
- [ ] Parede: auto-rotação entre Rede / Main / Exceções + alarme de breach (visual + som opcional).
- [ ] Dono/atribuição na fila de exceções.

---

## 5. Modal de pedidos — refação profissional (spec)

O user pediu: **sem emoji, sem cores, só o simples funcionar** — profissional e útil, mostrando **todos os armazéns** e **todos os estágios** (abertos e processados).

**Hoje** (`openOrdersModal`, `ordersModalOverlay` `index.html:574`): filtra Main, esconde BACKORDERED por padrão, mistura fontes, usa cor/aging visual.

**Alvo — tabela limpa, monocromática, funcional:**
- **Colunas:** `Warehouse · Order # · Customer · Stage · Age (d) · Lines · Qty · Order date`. Números com `tabular-nums`. Sem emoji, sem badge colorido — **Stage** e **Age** como texto simples (Age pode ter um único tom de ênfase para muito antigo, mas sem paleta semântica cheia — decidir na implementação).
- **Filtros (topo, discretos):** Warehouse (todos / um), Stage/Status (**incluindo** Backordered e Completed), busca (Order #/customer/SKU). Ordenável por coluna (default: Age desc).
- **Escopo:** todos os armazéns, todos os estágios. **Parar de excluir BACKORDERED** por padrão (`home.js:951`).
- **Comportamento:** clique numa linha → detalhe do pedido; paginação; contagem "N pedidos". Reaproveitar o padrão de tabela limpa do **Returns** (mesma pegada visual profissional que acabamos de fazer).
- *Aceite:* consigo ver, num lugar só, todo pedido aberto/processado de qualquer armazém, em qualquer estágio, filtrável — sem nenhum emoji e sem semáforo de cor.

---

## 6. Monitorar tudo (capture-everything)

O que passa a ser capturado/monitorado:
1. **Todo pedido** de **todo armazém** em **todo estágio** (Faixa A de rede) — aberto e processado.
2. **Toda transição de estágio** (Fase 2 event log) — quando entrou/saiu de cada estágio, por quem/onde.
3. **Saúde do sync** (`sync_runs`) — sucesso/falha/duração/linhas, com alerta na falha.
4. **Exceções** — aged pick, backorder, pack/dispatch backlog, sync stale — como fila acionável, não contagem.
5. **Throughput/acurácia do Main** (scanner) — já existe, manter rotulado como Main-only.

Isso vira base de decisão pra empresa: onde tá o gargalo (por site/estágio), o que está travado, e há quanto tempo.

---

## 7. Decisões a confirmar (reconfirme tudo)

| # | Decisão | Valor | Status |
|---|---|---|---|
| D1 | Cutoff de expedição (relógio) | **17h AEST** | ✅ confirmado |
| D2 | Threshold "pick atrasado" | **> 2 dias** | ✅ confirmado |
| D3 | Threshold "pack backlog" | **> 4h após PICKED** | ✅ confirmado |
| D4 | Armazéns na Faixa A | **todos (10)** | ✅ confirmado |
| D10 | **Foco do dashboard** | **Main por padrão + seletor de armazém** ("Todos" = rede) | ✅ confirmado |
| D9 | Modal | **padrão de mercado, sem cor exagerada, sem emoji, simples e completo** | ✅ confirmado |
| D5 | Base do aging (sem due date real até Fase 2) | dias desde `order_date`, rotulado como tal (NÃO chamar de SLA) | default |
| D6 | Agendador primário do sync | GitHub cron; server atrás de env flag | default |
| D7 | Alvo de freshness do funil | webhook ~1min (Fase 2); interino poll 60s | default |
| D8 | Canal de alerta (Fase 3) | a definir (e-mail? Slack?) | aberto |

**D10 — seletor de armazém (UX primária do dashboard):** o board **abre focado no Main** (primeiro a usar, pedidos normais). Um **seletor** no topo (segmented/dropdown) troca o foco pra qualquer armazém; opção **"Todos"** mostra o roll-up de rede. As métricas de scanner (accuracy, completed-today, operador) só aparecem quando **Main** está selecionado — nos outros, "sem scanner".

---

## 8. Mapa de arquivos

- **Board/UI + lógica:** `home.js` (loadWarehouseBoard, renderTransfersTable, togglePipelineFullscreen, loadPipelineChart), markup `index.html`, estilos `home.css`.
- **Modal de pedidos:** `openOrdersModal` + `#ordersModalOverlay` (`index.html:574`).
- **Sync do pipeline:** `order-pipeline-sync.js`, workflow `.github/workflows/order-pipeline-sync.yml`, scheduler em `server.js:268-302`.
- **Scanner (Main):** `pick_anomaly_orders` (`pick-anomalies-engine.js`), `scanner_activity` (`ingest-scanner-report.js`, `/api/scanner-activity`).
- **Heartbeat futuro:** `cin7_mirror.sync_runs`.
- **Padrão visual de referência (modal limpo):** `features/returns/` (tabelas sem emoji, profissionais).

---

## 9. Ordem de execução sugerida

1. **Fase 0** inteira (front-end, sem dado novo) — maior valor, menor risco. Rodar no dev, revisar, promover só o de pipeline pro main.
2. **Modal profissional** (seção 5) — junto ou logo após a Fase 0.
3. **Fase 1** (heartbeat + cutoff).
4. **Fase 2** (event log + due date) — destrava o "tempo real de estágio".
5. **Fase 3** (alertas + parede).

> Tudo prod-safe: mudanças vão pro **dev**, rodam local, você revisa, e promovo **só os commits de pipeline** pro main via cherry-pick (o redesign da home ainda pendente de análise fica de fora). Deploy no Render é manual.
