# Rapid-Labels

Ferramenta interna de operação de armazém (WMS) da Rapid LED / Rapid Express: um servidor Express 5 que serve páginas HTML/CSS/JS vanilla e expõe rotas `/api/*` apoiadas por um Supabase próprio e pela API do Cin7/DEAR.

- **Produção:** https://rapid-labels.vercel.app
- **Repositório:** https://github.com/JoaoBueno1/Rapid-Labels — branch default `main`, desenvolvimento em `dev`
- **Local no disco:** `/Users/joaomarcos/Desktop/untitled folder/LabelsApp_Final`

---

## 1. O que é este sistema e onde ele se encaixa

O Rapid-Labels nasceu como um impressor de etiquetas de container e hoje é a camada de software do chão de armazém. O que está de fato implementado no repositório:

- Impressão de etiquetas de container e de produto
- WMS: pack e pick (`/wms`, `/pack`)
- Replenishment (reposição com demanda viva)
- Contagem cíclica e conferência de container
- Devoluções (returns)
- Anomalias de picking e produtividade de picking
- Stock planning (planejamento de estoque)
- Gateway: hub central de navegação entre as features
- Transfer out, logistics, analytics, sync monitor, excel sync, rapid inventory, label sheets

Um serviço separado dentro do mesmo repositório (`cin7-stock-sync/`) espelha estoque, vendas e movimentos do Cin7 para o Supabase, disparado por 15 crons no GitHub Actions. Esses syncs **não** fazem parte do app web — rodam fora dele.

### Ecossistema Rapid

São três sistemas independentes hoje:

| Sistema | O que é | Stack | Deploy |
|---|---|---|---|
| **Rapid-Express-Web** | TMS (transporte / operação de entregas) | Flask | Render |
| **Rapid Express App** | Front-end do TMS | React + Vite | — |
| **Rapid-Labels** (este repo) | Operação de armazém / WMS | Express 5 | Vercel |

Existe um plano de unificar o Rapid-Labels como **módulo dentro do TMS**, e um novo repositório de login/landing central está sendo criado. Enquanto isso não acontece, os dois lados permanecem separados — inclusive os bancos: **o Supabase do Labels é um projeto diferente do Supabase do TMS.**

---

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js `>=18` (CI usa Node 20), CommonJS |
| Backend | Express 5.1 — monolito em `server.js` |
| Front-end | HTML/CSS/JS vanilla, multipágina, **sem framework e sem build step** |
| Banco | Supabase (Postgres) próprio, schema `cin7_mirror`; conexão Postgres direta via `pg` para o stock-planning (schema `rapid_inv`, não exposto no PostgREST) |
| Integração externa | API Cin7 / DEAR |
| Scripts auxiliares | Python em `features/gateway`, `features/excel-sync` e `populate_cin7_cache.py` |
| Deploy | Vercel (serverless via `api/index.js`) + GitHub Actions para os syncs |

**Dependências principais:** `@supabase/supabase-js ^2.50`, `express ^5.1`, `pg ^8.18`, `helmet ^7.1`, `compression`, `express-rate-limit`, `node-cron`, `node-fetch ^2.7`, `xlsx ^0.18`, `dotenv`. Em devDependencies: `puppeteer`, `pptxgenjs`, `@electric-sql/pglite`.

O app **não é offline-capable**: não há service worker, e algumas páginas (`features/container-check`, `features/label-sheets`, `features/pick-productivity`) desregistram ativamente qualquer service worker antigo.

---

## 3. Como rodar local

```bash
git clone https://github.com/JoaoBueno1/Rapid-Labels.git
cd Rapid-Labels

# 1. Dependências
npm install

# 2. Variáveis de ambiente (obrigatório — o app não sobe útil sem elas)
cp .env.example .env
# abra o .env e preencha os valores reais (peça as credenciais ao time)

# 3. Subir o servidor
npm start          # equivalente a: node server.js
```

Abre em **http://localhost:8383** (porta configurável via `PORT`).

Sem `SUPABASE_SERVICE_KEY` o servidor sobe, mas os endpoints de auditoria não funcionam — o `server.js` avisa no console na inicialização.

### Scripts npm úteis

| Comando | O que faz |
|---|---|
| `npm start` / `npm run dev` | Sobe o servidor Express (`node server.js`) |
| `npm run sync` | Sync completo Cin7 → Supabase |
| `npm run sync:stock` | Sync apenas de estoque |
| `npm run sync:products` | Sync apenas de produtos |
| `npm run sync:dry` | Dry-run verboso do sync (seguro para testar) |
| `npm run sync:verify` | Verifica consistência do mirror |
| `npm run sync:verify:quick` | Versão rápida da verificação |
| `npm run test:packer` | `node --test features/container-builder/packer.test.js` |
| `npm run test:gateway` | Testes de lógica do gateway |
| `npm run test:gateway:live` | Testes do gateway contra dados vivos |
| `npm run gateway:verify` | Verificação de schema do gateway (Python) |

> **Atenção:** `npm test` está aliasado para `node server.js` — ele **sobe o servidor, não roda teste nenhum**. Use os scripts `test:*` acima. Além disso, os scripts `cache`, `audit`, `audit:test`, `setup:products` e `scheduler` apontam para arquivos que **não existem** no repositório e quebram na primeira execução.

---

## 4. Variáveis de ambiente

Copie `.env.example` para `.env` e preencha. **Nunca commite o `.env`.** Abaixo só os nomes — os valores vêm do time.

| Variável | Para que serve | Obrigatória |
|---|---|---|
| `SUPABASE_URL` | URL do projeto Supabase do Labels | Sim |
| `SUPABASE_SERVICE_KEY` | Service role key (backend, endpoints de auditoria) | Sim |
| `SUPABASE_ANON_KEY` | Anon key usada pelo front | Sim |
| `CIN7_ACCOUNT_ID` | Conta da API Cin7/DEAR | Sim |
| `CIN7_API_KEY` | Chave da API Cin7/DEAR | Sim |
| `PORT` | Porta HTTP local (default `8383`) | Não |
| `PRINTER_HOST` | Host da impressora de etiquetas | Não |
| `PRINTER_PORT` | Porta da impressora | Não |
| `SUPABASE_DB_PASSWORD` | Senha do Postgres (conexão direta, stock-planning) | Só p/ stock-planning |
| `SUPABASE_DB_HOST` | Host do pooler Postgres | Só p/ stock-planning |
| `SUPABASE_DB_PORT` | Porta do pooler Postgres | Só p/ stock-planning |
| `STOCK_PLANNING_ENABLED` | Liga/desliga o módulo de stock planning | Não |

Em produção, as mesmas variáveis são configuradas no painel da Vercel; os workflows de sync usam GitHub Secrets.

---

## 5. Mapa da estrutura

| Caminho | O que é |
|---|---|
| `server.js` | **O coração do sistema.** Monolito Express 5 (~47 KB): headers helmet/CSP, rate-limit, `express.static(__dirname)` servindo a raiz inteira, e todas as rotas `/api/*`. É o entrypoint de dev e de produção. |
| `api/index.js` | Handler serverless da Vercel. Três linhas — apenas `module.exports = require('../server')`. |
| `vercel.json` | Config de deploy: `maxDuration` 60s e os rewrites `/wms`, `/pack`, `/api/:path*`. |
| `features/` | Módulos de produto (354 arquivos versionados) em 19 subpastas: `wms`, `replenishment`, `returns`, `gateway`, `container-builder`, `container-check`, `container-list`, `pick-anomalies`, `pick-productivity`, `stock-planning`, `analytics`, `excel-sync`, `rapid-inventory`, `logistics`, `transfer-out`, `sync-monitor`, `label-sheets`, `wms-spike`. Cada uma com `ui/`, `migrations/` e, em alguns casos, `tests/`. |
| `core/cin7/` | Camada "core" de integração Cin7 (client, catalog, plan, backfill, `sql/`). Coexiste com os `cin7-*.js` da raiz e com `cin7-stock-sync/` — veja a seção de limitações. |
| `cin7-stock-sync/` | Serviço de sync Cin7 → Supabase (37 arquivos): `sync-service.js`, `verify-sync.js`, migrations `.sql`, `DEPLOY_ALL.sql`. Alvo dos scripts `sync:*` e dos 15 crons. |
| `shared/` | Assets comuns de UI: `rail.js`, `nav-counts.js`, `ui.css`, `rail.css` (navegação lateral compartilhada). |
| `docs/` | 21 documentos markdown — o ativo de conhecimento mais forte do repositório. Veja a seção 7. |
| `sql/`, `database/`, `replacements/`, `reports/`, `scripts/`, `data/`, `assets/` | Suporte: migrations SQL, scripts utilitários, dados. `data/scanner_activity.json` é gitignored (contém nomes de funcionários). |
| `index.html`, `gateway-main.{html,css,js}`, `home.{css,js}` | Páginas de navegação na raiz. `gateway-main.html` é o hub de features; `index.html` é a tela de labels. `home.js` tem 112 KB. |
| `.github/workflows/` | 20 workflows: 15 crons de sync Cin7 (`cin7-*.yml`), `order-pipeline-sync`, `pick-anomalies-sync`, `wms-reconcile`, `excel-sync`, `monthly-review-capture` e `ci-lockfile.yml`. |
| `CLAUDE.md` | Guia de convenções do repositório (design system, regras de commit, dívidas conhecidas). Leitura obrigatória antes de mexer em CSS. |

### Rotas notáveis

- `/` → `index.html` (labels)
- `/gateway-main.html` → hub de features
- `/wms` → `features/wms/pwa/wms.html` (rewrite da Vercel)
- `/pack` → `features/wms/pack/pack.html` (rewrite da Vercel)
- `/api/*` → tratado por `server.js`

---

## 6. Deploy

**App web (Vercel):** push na branch de produção dispara o deploy. A Vercel executa `api/index.js`, que re-exporta `server.js`, e serve o restante do repositório como arquivos estáticos. Não há build step — o que está no repositório é o que vai ao ar.

**Syncs (GitHub Actions):** os 15 crons `cin7-*.yml` rodam `npm ci --production` e chamam scripts de `cin7-stock-sync/`. Eles são independentes do deploy da Vercel.

**Migrations de banco:** aplicadas manualmente pelo **Supabase SQL Editor** do projeto do Labels. Não use o `apply_sql.py` do TMS — são bancos diferentes.

### Regra crítica: package.json e lockfile

> **Nunca altere `package.json` sem rodar `npm install --package-lock-only` no MESMO commit.**
>
> Os 15 workflows de sync executam `npm ci --production`, que aborta se o lockfile divergir do `package.json`. Isso já derrubou todos os crons **duas vezes**, e em uma delas o mirror do Cin7 ficou 3 dias congelado. O workflow `ci-lockfile.yml` existe exatamente para pegar essa divergência — é o único CI real do repositório.

---

## 7. Onde está a documentação de verdade

Este README é só a porta de entrada. O conhecimento operacional está em `docs/`:

| Documento | Conteúdo |
|---|---|
| `docs/RUNBOOKS.md` | Procedimentos operacionais — leia antes de mexer em produção |
| `docs/BUSINESS_RULES.md` | Regras de negócio (35 KB). A referência sobre *por que* o sistema faz o que faz |
| `docs/SYNC_WORKFLOWS.md` | O que cada um dos crons de sync faz |
| `docs/DEAD_CODE_REGISTER.md` | Registro de código morto — consulte antes de deletar qualquer coisa |
| `docs/UI_AUDIT.md` | Auditoria de UI (69 KB) |
| `docs/STOCK_PLANNING_01..03` | Discovery, plano e automação do stock planning |
| `docs/EXCEL_SYNC_*.md` | Arquitetura, status e relatórios do excel-sync |
| `CLAUDE.md` (raiz) | Convenções de código, design system e dívidas técnicas assumidas |

Há também vários `.md` de planejamento soltos na raiz (`AI_FEATURES_ROADMAP.md`, `IMPROVEMENT_PLAN.md`, `LLM_AI_STRATEGY_ANALYSIS.md`, `CIN7_INTEGRATION*.md`, `RAPID_INVENTORY_STATUS.md`). **Não são canônicos** — são material histórico de estratégia. Em caso de conflito, `docs/` e `CLAUDE.md` vencem.

---

## 8. Convenções de contribuição

1. **Branches:** trabalhe a partir de `dev`. `main` é produção.
2. **Lockfile:** toda mudança em `package.json` vem com o `package-lock.json` regenerado no mesmo commit (veja a seção 6).
3. **Não commite dado de cliente.** Não existe `.vercelignore`, e o `server.js` serve a raiz inteira com `express.static(__dirname)` — qualquer arquivo commitado na raiz fica **publicamente acessível** em `rapid-labels.vercel.app`. Isso vale para CSV, XLSX, TSV, dumps JSON, screenshots e relatórios.
4. **Não commite segredos.** Chaves vão em `.env` (local) e nos secrets da Vercel / GitHub Actions.
5. **Antes de deletar código**, consulte `docs/DEAD_CODE_REGISTER.md`. O repositório tem duplicações históricas — o que parece morto pode estar vivo em outra página.
6. **CSS:** siga o que o `CLAUDE.md` define. Não introduza novos hex cravados em código novo; o ciano legado `#0AA5E6` não deve ser usado fora das páginas que já o usam.
7. **Testes:** rode `npm run test:packer` e `npm run test:gateway` manualmente antes de abrir PR — o CI não roda testes.
8. **Arquivos de investigação/debug** ficam fora do controle de versão. Não adicione mais scripts `_*.js` / `debug-*.js` na raiz.

### Identidade visual (resumo)

Referência completa no `CLAUDE.md`. O essencial:

- **Cor de marca:** `#1B2A3F` (navy, tinta principal)
- **Acento:** `#2563EB` — subtle `#DBEAFE`, text `#1E40AF`
- **Neutros (slate):** surface `#FFFFFF`, sunken `#F8FAFC`, subtle `#F1F5F9`, border `#E2E8F0`, border-strong `#CBD5E1`; texto muted `#64748B`, muted-strong `#475569`, subtle `#94A3B8`
- **Semânticas:** danger `#DC2626` / `#FEE2E2` / `#991B1B`; success `#15803D` / `#DCFCE7` / `#166534`; warning `#F59E0B` / `#FEF3C7` / `#92400E`
- **Legado, não usar em código novo:** ciano `#0AA5E6` (6 páginas recentes), `#232946` (theme/background do `manifest.json`, visual antigo ainda visível no splash mobile)
- **Fontes:** páginas existentes usam `IBM Plex Sans` / `IBM Plex Mono`. **Código novo usa stack de sistema.** Tamanhos 12/14/16/20, pesos 400/600/700
- **Raios:** 6 / 8 / 12 / 9999. **Espaçamentos:** 4 / 6 / 8 / 12 / 16 / 24 / 32 (o valor `10` não faz parte do sistema, apesar de ser muito usado por engano)
- **Logos:** `rapid-express-logo.png`, `rapid-express-icon.png` na raiz; ícones PWA `icon-192.svg`, `icon-512.svg`. `favicon.svg` existe mas está vazio (0 bytes)

---

## 9. Estado atual e limitações conhecidas

Escrito de forma direta para quem está chegando. Nada aqui é motivo para não trabalhar no repositório — é o mapa das minas.

### Crítico

- **`cin7-stock-sync/try-passwords.js` está commitado** com 8 candidatos de senha de banco em texto plano, além dos hosts e usuários exatos do pooler Supabase. Mesmo que nenhuma senha funcione hoje, o arquivo revela o padrão de senha da empresa e o project ref. Deve ser removido do repositório e as senhas rotacionadas.

### Alto

- **SQL que desabilita Row Level Security está commitado como receita** (`disable-rls-for-uploads.sql`, `fix_rls_supabase.sql`, `setup_cin7_cache_rls.sql`). Se aplicado, abre `audit_runs` e `audit_stock_analysis` para leitura/escrita anônima via anon key. **Não execute esses arquivos.** Confirme se o RLS está realmente ativo em todas as tabelas.
- **Dados reais de cliente commitados e servidos publicamente.** Sem `.vercelignore` e com `express.static(__dirname)`, arquivos como `real-picking-errors-all-corrected.csv` (nomes de empresas clientes, números de SO), `real-picking-errors-after-24mar.csv`, `pick-anomalies-report.xlsx`, `product-stock-locators.csv`, `stock_locators_export.tsv`, `stocktake-issues.tsv` e `stocktake-report.tsv` estão acessíveis em `rapid-labels.vercel.app`.
- **Raiz do repositório poluída:** 110 arquivos soltos, com código de produção e ~30 scripts de investigação/debug no mesmo nível (`_analyze_wkavg.js`, `_e.js`, `TESTE_CONSOLE.js`, `debug-replenishment.js`, `check-tables.js`, `fix-rqc-data.js`, `test-all-branches.js`…). Um dev novo não consegue distinguir o que está vivo do que é lixo.
- **Scripts npm quebrados:** `cache`, `audit`, `audit:test`, `setup:products` e `scheduler` apontam para arquivos inexistentes (`cin7-cache-server.js`, `run-audit.js`, `setup-products.js`, `scheduler.js`).
- **Testes existem mas não rodam em CI.** O único workflow não-cron (`ci-lockfile.yml`) apenas valida o lockfile. Nenhum workflow executa `node --test`. E `npm test` está aliasado para `node server.js`.

### Médio

- **Três implementações de integração Cin7 sem fronteira clara:** `cin7-client.js` na raiz (7 KB), `core/cin7/cin7-client.js` (2,4 KB, versão diferente) e o serviço completo em `cin7-stock-sync/`. Somam-se `cin7-config.js`, `cin7-service.js` e `cin7-simple-cache.js` na raiz. Antes de tocar em Cin7, confirme em `docs/DEAD_CODE_REGISTER.md` qual caminho é o vivo.
- **Dumps grandes de estado do banco versionados na raiz:** `_db_current.json` (671 KB), `_upsert_data.json` (861 KB), `_parsed_main.json` (325 KB), `_parsed_branches.json` (210 KB).
- **CORS `Access-Control-Allow-Origin: *` em todas as rotas `/api/*`**, incluindo endpoints de escrita (`scanner-activity/import`). Combinado com a anon key exposta no front, qualquer origem pode chamar a API.
- **O design system existe só no papel.** O `CLAUDE.md` prescreve tokens `var(--color-*)`, mas nenhum CSS versionado define esses tokens — o código usa hex cravado em todo lugar. Há 52 declarações `!important` e 4 arquivos `*-theme.css` de override registrados como dívida.

### Baixo

- Documentação de planejamento espalhada na raiz junto com código, competindo com `docs/`.
- Arquivos versionados com espaços no nome e sem extensão (`avg month from manager`, `manual import avg main`, `Gateway location map`, `it.txt`) — são exports de texto do Cin7, e também ficam públicos.
- `modal.js` existe mas está vazio (0 bytes), resquício da versão original de labels.
