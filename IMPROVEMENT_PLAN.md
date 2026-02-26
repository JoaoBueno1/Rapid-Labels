# Rapid-Labels WMS — Plano de Melhorias

> Gerado em: 26/02/2026  
> Nota atual do sistema: **6.2/10**  
> Meta: **8.5+/10**

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
