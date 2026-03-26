# Rapid-Labels WMS — Plano de Melhorias

> Gerado em: 26/02/2026  
> Última atualização: **26/03/2026**  
> Nota atual do sistema: **7.5/10** (era 6.2)  
> Meta: **8.5+/10**

---

## 📋 Sessão Atual — Onde Paramos (26/03/2026)

### O que foi feito nessas sessões (Fev-Mar 2026):

#### ✅ Cin7 Mirror Auto-Integration
- Removido upload manual de stock CSV
- `restock-v2.js` e `replenishment.js` agora lêem direto de `cin7_mirror.stock_snapshot`
- Sync automático a cada 2h pelo `cin7-stock-sync/sync-service.js`
- Mapeamento de locations: `CIN7_LOCATION_MAP` (main warehouse → MAIN, sydney → SYD, etc.)

#### ✅ Smart Rules no Branch Replenishment
- **Smart CTN Rounding**: arredonda qty para carton inteiro (up se Main aguenta, senão down)
- **Min Send Threshold**: não envia se qty < metade de um carton (evita envios ineficientes)
- **Proportional Allocation**: quando múltiplas branches precisam do mesmo produto e Main não tem suficiente, distribui proporcionalmente

#### ✅ Restock V2 Melhorias
- Integração auto cin7_mirror (sem upload manual)
- Gateway Main improvements iniciados

#### ✅ Branch Replenishment Page — Overhaul Completo (replenishment-branch.js/html)
**REESCRITO ~80% do código** — mudanças principais:
1. **Auto-generate on load** — não precisa mais clicar "Generate Plan"
2. **Mostra TODOS os produtos** — não apenas os que precisam de stock (categories: critical/warning/ok/sufficient/no_avg)
3. **Coluna 5DC** — extrai código 5DC de `restock_setup.product` (formato "30290  R2101-WH-WW")
4. **Coluna CTN** — mostra qty_per_ctn para verificação visual
5. **Conflict tooltips detalhados** — breakdown: Main can send, Total demand, Your need %, Other branches, Your proportional share
6. **Row selection** — checkbox por linha + select all, export selecionados
7. **Layout 1440px** — tabela mais larga (era ~1200px)
8. **Filtro No AVG** — toggle "👻 No AVG" (oculto por default) para produtos sem avg_month
9. **Filtro "Sufficient"** — chip para ver produtos com 5+ semanas de cobertura
10. **8 summary cards** — Products w/ AVG, To Send, Total Units, Critical, Warning, OK, Sufficient, No AVG Data
11. **Coverage Distribution chart** — histograma com buckets 0-7d, 7-14d, etc.
12. **formatAvg()** — valores < 10 mostram 1 decimal (ex: 0.3), >= 10 arredondam

#### ✅ Bug Fix — Cache Server (26/03/2026)
- **Problema**: server.js servia `.js` com `Cache-Control: public, max-age=604800, immutable` (7 dias!)
- Browser cacheava JS antigo, usuário via versão velha do replenishment-branch.js (37 produtos em vez de 797)
- **Fix**: JS/CSS agora usam `no-cache` (sempre revalida), apenas imagens/fonts ficam 7 dias
- Adicionado cache busting `?v=20260326` nos `<script>` tags

#### ✅ Replenishment Overview Page (replenishment.js/html)
- Integração cin7_mirror (sem upload manual)
- Branch cards com KPIs
- Smart rules panel
- AVG management modal

#### ✅ Gateway Stocktake
- `stocktake-engine.js` + `stocktake-auditor.html` — novo módulo
- Comparação MAP vs Cin7 system stock

#### ✅ Pick Anomalies
- UX improvements
- Excel report generation (`scripts/_gen-report.js`)

### 🔧 Estado técnico dos arquivos:
| Arquivo | Linhas | Status |
|---|---|---|
| `replenishment-branch.js` | ~1255 | ✅ Reescrito (auto-load, all products, 5DC, CTN, selection, filters) |
| `replenishment-branch.html` | ~365 | ✅ Reescrito (10 colunas, 8 cards, 1440px layout) |
| `replenishment.js` | ~648 | ✅ Atualizado (cin7_mirror, KPIs, smart rules) |
| `replenishment.html` | ~490 | ✅ Atualizado (branch grid, rules panel) |
| `restock-v2.js` | ~1200+ | ✅ Atualizado (cin7_mirror integration) |
| `server.js` | ~457 | ✅ Fix cache headers |
| `gateway-engine.js` | ✅ | Stocktake routes added |

### 📊 Dados no DB (para referência):
- `branch_avg_monthly_sales`: **3.271 rows** total
  - 797 com `avg_mth_sydney > 0`
  - Populado via scripts manuais (`_update_avg_sales_xfr.js`, `_populate_avg_breakdown.js`) que parsam exports Cin7
- `cin7_mirror.stock_snapshot`: **14.181 rows**, sync automático
  - Main: 2.634 SKUs, Sydney: 1.366 SKUs, Melbourne: 607 SKUs, etc.
- `restock_setup`: tem product (com 5DC code) + qty_per_ctn + qty_per_pallet

### ⏳ Próximos passos sugeridos:
1. **Testar visualmente** a branch page no browser (Ctrl+Shift+R para hard refresh)
2. **Verificar se 797 produtos** aparecem para SYD (com AVG), ~1400+ no "No AVG Data"
3. **Exportar CSV** e validar dados vs Cin7
4. **Repetir para outras branches** (MEL, BNE, etc.)
5. **Overview page** — verificar se KPIs batem com branch pages
6. **Considerar**: popular `avg_mth_*` para branches via script automático (hoje é manual)

### 🖥️ Como rodar:
```bash
cd Rapid-Labels
fnm env --use-on-cd | Out-String | Invoke-Expression
node server.js
# Abrir http://localhost:8383/features/replenishment/replenishment.html
# Ou direto: http://localhost:8383/features/replenishment/replenishment-branch.html?branch=SYD
```

### 📁 Git:
- Branch: `dev`
- Último commit antes deste: `0435acd` (docs: LLM/AI strategy analysis)
- Arquivos novos não-tracked: `AI_FEATURES_ROADMAP.md`, `data/`, `stocktake-auditor.html`, `stocktake-engine.js`, scripts diversos

---

## Fase 1 — Segurança & Higiene (Urgente)
*Esforço: 1-2 dias | Impacto: Crítico*

- [ ] **1.1** Remover service keys hardcoded de `server.js` e `sync-service.js` — usar `.env` obrigatório com validação de presença
- [ ] **1.2** Restringir `express.static` a diretório `/public` — mover HTML/CSS/JS/assets para lá, parar de servir `.sql`, scripts debug, `.env.example`
- [ ] **1.3** Restringir CORS — substituir wildcard `*` por origens específicas (localhost, IP do warehouse)
- [ ] **1.4** Limpar scripts debug/fix da raiz — mover `_analyze_wkavg.js`, `debug-*.js`, `fix-*.js`, `check-*.js`, `_*.js`, `_*.json` para pasta `scripts/dev/` ou remover
- [ ] **1.5** Atualizar `.gitignore` — excluir `_db_current.json`, `_parsed_*.json`, `_upsert_data.json`, dados de teste

---

## Fase 2 — Dashboard Home Inteligente
*Esforço: 1-2 dias | Impacto: Alto (UX)*

- [ ] **2.1** Criar barra de mini-KPIs no topo da home: ordens pendentes, collections ativas, anomalias do dia, taxa de acerto %
- [ ] **2.2** Adicionar Notifications/Alerts Feed — badge com alertas: "5 anomalias novas", "Stock baixo em 3 SKUs", "Collection pendente há 2h" (usando `movement_alerts` que já existe)
- [ ] **2.3** Timestamp "Last sync" visível na home

---

## Fase 3 — Export & Relatórios
*Esforço: 2-3 dias | Impacto: Alto (Gerência)*

- [ ] **3.1** Botão Export CSV/Excel em Pick Anomalies (histórico completo com filtros aplicados)
- [ ] **3.2** Botão Export CSV/Excel em Collections History
- [ ] **3.3** Botão Export CSV/Excel em Restock V2
- [ ] **3.4** Geração de relatório PDF resumido (Pick Accuracy semanal) para envio à gerência

---

## Fase 4 — Autenticação & Roles
*Esforço: 2-3 dias | Impacto: Alto (Segurança)*

- [ ] **4.1** Implementar login com Supabase Auth (email/senha)
- [ ] **4.2** Definir roles: `admin`, `warehouse`, `viewer`
- [ ] **4.3** Proteger endpoints backend com middleware de auth (JWT)
- [ ] **4.4** QC card só visível para `admin` — elimina PIN 4209
- [ ] **4.5** Configurar RLS policies reais no Supabase (substituir `USING(true)`)
- [ ] **4.6** Activity log: registrar quem fez o quê (user_id em todas as ações)

---

## Fase 5 — Pick Accuracy Dashboard
*Esforço: 2-3 dias | Impacto: Alto (Analytics)*

- [ ] **5.1** Gráfico histórico de % accuracy por semana/mês (Chart.js)
- [ ] **5.2** Trending line com meta configurável (ex: 95%)
- [ ] **5.3** Breakdown por tipo de anomalia (bin errado, qty errada, SKU errado)
- [ ] **5.4** Comparativo mês atual vs anterior
- [ ] **5.5** Top 10 SKUs com mais anomalias

---

## Fase 6 — Refatoração de Código
*Esforço: 3-5 dias | Impacto: Médio (Manutenibilidade)*

- [ ] **6.1** Quebrar `cyclic-count.js` (2496 linhas) em módulos menores
- [ ] **6.2** Quebrar `restock.js` (2114 linhas) em módulos menores
- [ ] **6.3** Quebrar `collections.js` (1834 linhas) em módulos menores
- [ ] **6.4** Refatorar `supabase-config.js` (509 linhas) — separar client init, search helpers, collections API
- [ ] **6.5** Unificar client Cin7 — eliminar duplicação frontend (`cin7-client.js`) vs backend (`pick-anomalies-engine.js`)
- [ ] **6.6** Remover `upload-handler-new.js` ou `upload-system.js` (manter apenas um)
- [ ] **6.7** Remover mocks não utilizados de `features/logistics/mocks/`
- [ ] **6.8** Depreciar Re-Stock V1 formalmente (redirect para V2 ou banner de aviso)

---

## Fase 7 — Stock Alerts Automáticos
*Esforço: 1-2 dias | Impacto: Alto (Operacional)*

- [ ] **7.1** Cron job que verifica `cin7_mirror.stock_snapshot` vs thresholds de `restock_setup`
- [ ] **7.2** Notificação in-app quando SKU cai abaixo do mínimo
- [ ] **7.3** Integração opcional com Slack/email para alertas críticos (stockout iminente)

---

## Fase 8 — Mobile & Scanner
*Esforço: 3-4 dias | Impacto: Alto (Produtividade)*

- [ ] **8.1** PWA mobile-first com câmera nativa para scan contínuo
- [ ] **8.2** Scan → auto-lookup → auto-label (fluxo de 1 toque)
- [ ] **8.3** Batch Label Printing — upload CSV/Excel com lista SKUs+QTY → gera todas as labels
- [ ] **8.4** Offline-first: cache de produtos para scan sem rede

---

## Fase 9 — Testes & CI/CD
*Esforço: 3-5 dias | Impacto: Médio (Qualidade)*

- [ ] **9.1** Configurar Jest/Vitest como test runner
- [ ] **9.2** Unit tests para pick-anomalies-engine (sync, analyze, transfer)
- [ ] **9.3** Unit tests para supabase-config helpers
- [ ] **9.4** Integration tests para endpoints críticos (/sync, /batch-transfer, /stats)
- [ ] **9.5** GitHub Actions CI pipeline — lint + test em cada PR
- [ ] **9.6** Staging environment (branch `staging` → deploy automático)

---

## Fase 10 — Frontend Moderno (Opcional)
*Esforço: 1-2 semanas | Impacto: Médio (DX/Performance)*

- [ ] **10.1** Introduzir Vite como bundler — tree-shaking, HMR, CSS modules
- [ ] **10.2** Migrar globals para ES modules (`import`/`export`)
- [ ] **10.3** Dark mode toggle com CSS variables
- [ ] **10.4** Considerar TypeScript gradual (começar por engines backend)

---

## Fase 11 — Features Avançadas (Game-Changer)
*Esforço: 2-4 semanas | Impacto: Muito Alto*

- [ ] **11.1** AI-Powered Stock Predictions — usar `branch_avg_monthly_sales` + sazonalidade para prever stockout 2-4 semanas antes
- [ ] **11.2** Warehouse Heatmap — visualização gráfica dos bins com cores por volume de picks/anomalias
- [ ] **11.3** Multi-Warehouse Real-time View — dashboard unificado de todos os warehouses com KPIs comparativos
- [ ] **11.4** Cycle Count Scheduling — calendário de contagem cíclica com tracking de conclusão
- [ ] **11.5** Integration Hub — conectar carriers, accounting (Xero/MYOB), expandir além do Cin7

---

## Documentação Pendente

- [ ] Reescrever `README.md` com estado atual do projeto
- [ ] Criar `CONTRIBUTING.md` para Rapid-Labels
- [ ] Documentar todos os endpoints da API (Swagger/OpenAPI ou markdown)
- [ ] Criar guia de onboarding para novos devs

---

## Métricas de Sucesso

| Critério | Atual | Meta Fase 4 | Meta Fase 9 |
|---|---|---|---|
| Segurança | 3/10 | 7/10 | 9/10 |
| Funcionalidade | 8.5/10 | 9/10 | 9.5/10 |
| UX/Design | 7/10 | 8/10 | 8.5/10 |
| Código Backend | 7/10 | 8/10 | 9/10 |
| Código Frontend | 5.5/10 | 6.5/10 | 8/10 |
| Testes | 1/10 | 3/10 | 7/10 |
| Documentação | 4/10 | 6/10 | 8/10 |
| **GERAL** | **6.2/10** | **7.5/10** | **8.5/10** |
