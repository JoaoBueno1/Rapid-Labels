# Excel Sync — validação de arquitetura (Fase 0)

> Status: **DESIGN / VALIDAÇÃO**. Nada implementado, nada ligado na UI, Microsoft Graph
> **não** entra ainda. Este doc registra o que foi medido ao vivo no mirror em
> **2026-08-07** e propõe a arquitetura antes de escrever a primeira linha do módulo.

> **Specs dos reports validados:** ver [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) —
> mapeamento coluna-a-coluna de cada report Cin7 contra o mirror, com a reconciliação
> feita em cima de exports reais.

O objetivo do módulo `excel-sync` é automatizar planilhas (e abas específicas dentro
delas) que hoje vivem no OneDrive/SharePoint da empresa. A regra que guia todo este
documento: **primeiro provar que conseguimos produzir o conteúdo correto de cada aba a
partir do mirror; só depois escrever no Excel de verdade.** Escrever no Excel é a parte
fácil e reversível; acertar o dado é a parte que dá trabalho.

---

## 1. O que foi medido (evidência, não suposição)

Tudo abaixo veio de consultas read-only ao Supabase de produção (`iaqnxamnjftwqdbsnfyl`)
e de 2 chamadas read-only à API do Cin7, em 2026-08-07.

### 1.1 Volume e frescor do mirror

| Tabela | Linhas | Frescor (max synced_at) | Cadência |
|---|---:|---|---|
| `cin7_mirror.stock_snapshot` | 14.971 | 2026-08-07 05:31 | horária |
| `cin7_mirror.stock_availability` | 12.681 | 2026-08-07 05:05 | 4h |
| `cin7_mirror.products` | 11.183 | 2026-08-06 22:05 | diária |
| `cin7_mirror.locations` | 1.417 | 2026-08-05 16:35 | diária |
| `cin7_mirror.sales_orders` | 74.293 | 2026-08-07 05:44 | 2h + webhook |
| `cin7_mirror.sale_lines` | 42.825 | 2026-08-07 06:02 | webhook |
| `cin7_mirror.stock_movements` | 48.878 | — | 6h + webhook |
| `cin7_mirror.stock_transfers` | 4.967 | 2026-08-07 05:20 | 2h |

O mirror está **saudável e fresco**. Os últimos 20 `sync_runs` estão todos `success`,
~70s cada, 15–16 chamadas Cin7. Não há nada a consertar antes de começar.

### 1.2 Stock por warehouse — ✅ **temos, hoje, sem construir nada**

17 localizações com estoque, atualizadas de hora em hora:

| Localização | SKUs | on_hand | allocated | valor AUD |
|---|---:|---:|---:|---:|
| Main Warehouse | 2.809 | 424.942 | 20.635 | 3.752.151 |
| Gateway | 515 | 93.264 | 0 | 1.265.491 |
| Sydney | 1.487 | 29.066 | 253 | 386.921 |
| Sunshine Coast Warehouse | 1.236 | 28.834 | 955 | 252.572 |
| Project Warehouse | 852 | 11.511 | 183.090 | 252.033 |
| Brisbane | 1.083 | 22.674 | 485 | 242.869 |
| Coffs Harbour | 1.204 | 17.837 | 498 | 213.535 |
| Hobart | 967 | 19.440 | 14 | 202.015 |
| Cairns | 770 | 15.390 | 543 | 178.041 |
| Melbourne | 805 | 20.776 | 788 | 146.530 |
| Faulty Warehouse | 565 | 6.656 | 18 | 134.468 |
| Ghost | 235 | 4.554 | 0 | 54.268 |
| BNE / SYD / CNS / SC- Project, Damaged Goods | — | ~1.911 | ~9.895 | ~27.217 |
| **Total** | **3.715 SKUs** | **~697k un** | — | **~AUD 7,11M** |

Forma de um report "SOH por warehouse": **3.715 linhas × 17 colunas de warehouse**, ou
**12.682 pares (sku, location)** no formato longo.

#### ⚠️ Três armadilhas que TÊM de entrar nas regras dos reports

**(a) `available` não é `on_hand − allocated`.** Quebra em **1.666 de 14.971 linhas
(11,13%)**. Todas são SKUs de caixa fechada (`*-Carton20`, `*-Carton15`) com
`on_hand=0`, `allocated=0`, mas `available > 0` — o Cin7 deriva a disponibilidade da
caixa a partir do estoque solto do produto pai. Efeito prático no Main Warehouse:

```
SUM(available)        = 452.587
SUM(on_hand) − alloc  = 404.307     ← diferença de 48.280 unidades fantasma
```

**Regra: para totais de warehouse usar `on_hand` (e `on_hand − allocated`), nunca
`SUM(available)`.** O app já faz certo — `restock-v2.js` e `gateway-main.js` só leem
`on_hand`. Qualquer report novo tem de seguir a mesma convenção.

**(b) `stock_on_hand` é VALOR em AUD, não quantidade.** O comentário no `schema.sql`
diz "Total across all locations" e está **errado**. Medição: em 94,2% das linhas
`stock_on_hand / on_hand ≈ products.average_cost`, e o total por warehouse bate com
`qty × average_cost` dentro de ~2% (Main: 3.752.151 vs 3.834.103). Confirmado direto
na API do Cin7 para o SKU `R1021-WH-TRI`: bin `MA-A-07-L7-P2` tem `OnHand=1170` e
`StockOnHand=4486.39` — razão 3,83 = custo unitário.

> **Isto é um ganho, não só um risco:** já temos **valor de estoque por warehouse e por
> bin** no mirror. É exatamente o insumo da aba **Stock Value** do Excel, sem precisar
> de sync nenhum novo. Só precisa ser corrigido o comentário do schema para ninguém
> mais usar o campo como quantidade.

**(c) "Dalton" não existe.** O Excel usa **DALTON + GATEWAY** como as duas filiais.
No Cin7 existe `Gateway`, mas **não existe nenhuma localização Dalton**. Preciso saber
para o que Dalton mapeia hoje (foi renomeada? virou Main? saiu de operação?) antes de
gerar qualquer aba que a referencie.

### 1.3 Monthly sales — 🟡 **dá no nível de pedido, ainda NÃO no nível de SKU**

**Nível pedido (cabeçalho) — pronto para uso.** `sales_orders` tem 74.293 linhas com
`order_date` de 2021-07 a 2026-08, mas a cobertura real só começa em **2025-08**
(antes disso são 6–62 pedidos/ano, ruído de teste). `invoice_amount` está preenchido em
99,97% das linhas. Ou seja: **12 meses sólidos de receita mensal, já dá para espelhar hoje.**

| Mês | Pedidos | Receita AUD | Linhas de SKU |
|---|---:|---:|---:|
| 2025-08 | 5.855 | 2.678.295 | 0,7% |
| 2025-09 | 6.317 | 3.291.304 | 0,4% |
| 2025-10 | 6.248 | 3.389.899 | 0,3% |
| 2025-11 | 5.816 | 3.334.371 | 0,4% |
| 2025-12 | 4.558 | 2.214.339 | 0,6% |
| 2026-01 | 4.608 | 2.646.113 | 1,2% |
| 2026-02 | 5.752 | 3.189.045 | 2,9% |
| 2026-03 | 6.523 | 3.723.567 | 4,7% |
| 2026-04 | 5.929 | 3.260.792 | 19,0% |
| 2026-05 | 6.557 | 3.793.053 | 12,9% |
| 2026-06 | 6.981 | 4.134.512 | **78,9%** |
| 2026-07 | 7.218 | 3.792.221 | **89,6%** |
| 2026-08 (parcial) | 1.833 | 983.706 | 84,4% |

**Nível SKU (linhas) — este é o gargalo real.** `sale_lines` cobre apenas
**16.168 de 74.293 pedidos (21,8%)**, e a cobertura é fortemente enviesada no tempo:
quase zero até fev/2026, e só fica utilizável a partir de **jun/2026**, quando o
detail-fetch por webhook entrou em operação. Na prática temos **~3 meses** de vendas
por SKU, não 12.

Consequências diretas:
- **Vendas por SKU/mês** (o equivalente da aba `WEEK SALES`): só de jun/2026 em diante.
- **Vendas por warehouse**: `location_name` também só existe nos mesmos 16.169 pedidos
  (58.124 pedidos sem localização) — é o mesmo portão do detail-sync.
- `rapid_inv.weekly_sales` está **vazio**, e o schema `rapid_inv` **nem está acessível
  pela API** (ver 1.4). Não dá para contar com ele agora.

**Caminho para fechar o buraco — muito mais barato do que parecia.** A estimativa inicial
(~58.125 pedidos, ~65 h de relógio) valia para um backfill **histórico completo**. Mas o
report de vendas que importa é **do mês corrente, atualizado diariamente** — nesse escopo
faltam apenas **~286 pedidos**, ou **~20 minutos** de chamadas. Ver
[EXCEL_SYNC_REPORTS.md § R2](EXCEL_SYNC_REPORTS.md) para o desenho do sync
`sales-detail-month`.

O backfill histórico completo continua sendo um item separado, e só entra se algum report
precisar de **mais de 3 meses** de vendas por SKU.

### 1.4 Restrição de acesso: `rapid_inv` não é alcançável

```
rapid_inv.skus         → permission denied for schema rapid_inv
rapid_inv.weekly_sales → permission denied for schema rapid_inv
```

Testado **com a service key**. O schema não está exposto no PostgREST e não tem grants.
Portanto **um módulo Python usando o cliente Supabase não consegue ler `rapid_inv`**.
Só `cin7_mirror`, `public` e `wms` estão acessíveis. Ou expomos + damos grant, ou
conectamos via Postgres direto (precisa da senha do banco, que não está no `.env`).

**Para a Fase 1 isso não é bloqueio** — todos os dados de estoque e vendas de que
precisamos estão em `cin7_mirror`.

---

## 2. Arquitetura proposta

### 2.1 O princípio: separar "o quê" de "como entrega"

```
   cin7_mirror (Supabase)
            │
            ▼
   ┌──────────────────────┐
   │  1. REPORT SPEC      │  declarativo: aba, colunas, ordem, chave, cadência
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  2. BUILDER (Python) │  spec → query → DataFrame → validação
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  3. VALIDATORS       │  frescor da fonte, colunas, nulos, delta de linhas
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  4. DELIVERY ADAPTER │  Fase 1: .xlsx/.csv em disco  ──▶  Fase 4: MS Graph
   └──────────┬───────────┘
              ▼
   ┌──────────────────────┐
   │  5. RUN LOG          │  excel_sync.report_runs → página de monitoramento
   └──────────────────────┘
```

O adapter de entrega é a **única** peça que muda quando o Graph entrar. Tudo antes dele
é validado antes, comparando o `.xlsx` que geramos contra o export real do Cin7 que
você usa hoje. É por isso que a ordem que você pediu (validar antes do Graph) está certa.

### 2.2 Onde o Python roda

Já existe precedente no repo: `scripts/update_main_avg_3mo.py` lê um export `.xlsx` do
Cin7 e escreve no Supabase. Funciona, mas roda **na sua máquina, à mão**.

**Recomendação: GitHub Actions**, o mesmo lugar onde os 14 syncs Cin7 já vivem.

| Opção | Veredito |
|---|---|
| **GitHub Actions cron** | ✅ **Recomendado.** Secrets já configurados, `actions/setup-python` é trivial, mesma disciplina de `concurrency:` + cron de-colidido já documentada em [SYNC_WORKFLOWS.md](docs/SYNC_WORKFLOWS.md). E o client-credentials flow do MS Graph funciona daqui na Fase 4. |
| Vercel Python function | ❌ Runtime separado do Express, limite de 60s, complica o deploy sem ganho. |
| Máquina local | ❌ Não automatiza. É o que temos hoje e é o problema. |

O Rapid Labels **só lê status** do Supabase — a página nunca precisa falar com o GitHub.

### 2.3 Schemas novos (isolados, não tocam em nada existente)

```sql
-- Registro declarativo de TODO sync (Cin7 e Excel) — alimenta as duas abas da página
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE ops.sync_registry (
  slug            TEXT PRIMARY KEY,        -- 'cin7-stock' | 'excel-soh-main'
  kind            TEXT NOT NULL,           -- 'cin7_to_system' | 'system_to_excel'
  title           TEXT NOT NULL,
  what_it_does    TEXT NOT NULL,           -- frase simples, aparece no card
  source          TEXT,                    -- 'Cin7 /ref/productavailability'
  target          TEXT,                    -- 'cin7_mirror.stock_snapshot'
  feeds           TEXT[],                  -- páginas/features que dependem
  cron_utc        TEXT,                    -- '0 * * * *' → calcula o "próximo run"
  sla_minutes     INT,                     -- passou disso = unhealthy
  freshness_table TEXT,                    -- onde medir o frescor de verdade
  freshness_col   TEXT,
  enabled         BOOLEAN DEFAULT true,
  runbook_url     TEXT
);

CREATE TABLE ops.sync_runs (
  run_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        TEXT NOT NULL REFERENCES ops.sync_registry(slug),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'running',  -- running|success|failed|skipped
  rows_read   INT,
  rows_written INT,
  duration_ms INT,
  trigger     TEXT,        -- cron|manual|webhook
  run_url     TEXT,        -- link do run no GitHub Actions
  error       TEXT,
  stats       JSONB DEFAULT '{}'::jsonb
);
```

```sql
-- O módulo Excel Sync propriamente dito
CREATE SCHEMA IF NOT EXISTS excel_sync;

CREATE TABLE excel_sync.report_defs (
  slug        TEXT PRIMARY KEY,       -- 'soh-main'
  workbook    TEXT NOT NULL,          -- 'Rapid-Inventory SKU 2025.xlsx'
  sheet       TEXT NOT NULL,          -- 'SOH'
  drive_path  TEXT,                   -- caminho SharePoint (só na Fase 4)
  anchor      TEXT DEFAULT 'A1',      -- canto superior-esquerdo do range escrito
  write_mode  TEXT DEFAULT 'replace_range',   -- replace_range | append
  columns     JSONB NOT NULL,         -- [{header, expr, type, format}] — ORDEM IMPORTA
  source_view TEXT,                   -- view/SQL que produz as linhas
  cron_utc    TEXT,
  enabled     BOOLEAN DEFAULT false   -- nasce desligado
);

CREATE TABLE excel_sync.report_runs (
  run_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       TEXT NOT NULL REFERENCES excel_sync.report_defs(slug),
  built_at   TIMESTAMPTZ DEFAULT now(),
  row_count  INT,
  col_count  INT,
  checksum   TEXT,        -- permite dizer "não mudou desde o último run"
  status     TEXT,
  delivered  BOOLEAN DEFAULT false,   -- sempre false até a Fase 4
  validation JSONB,       -- {freshness_ok, row_delta_pct, null_rates, ...}
  error      TEXT
);
```

Por que `checksum`: com ele a página consegue mostrar "rodou, mas o conteúdo não mudou",
que é a diferença entre *saudável* e *travado* — e evita reescrever a aba do Excel à toa.

### 2.4 A página de monitoramento (as duas abas que você pediu)

Uma página, duas abas, lendo **só do Supabase** com a anon key — igual às outras páginas.

**Aba 1 — "Cin7 → Our System"**
Um card por sync: o que faz · última execução · saudável? · próxima execução · o que alimenta.

Há um detalhe importante aqui: hoje `cin7_mirror.sync_runs` só conhece **3 tipos**
(`full`, `products_only`, `stock_only`) enquanto existem **14 workflows**. A maioria dos
syncs não registra run nenhum. Por isso o `ops.sync_registry` é necessário — sem ele a
página mostraria 3 de 14 syncs e daria uma falsa sensação de cobertura.

- **última execução / saúde** → do frescor real da tabela de destino (`freshness_table` +
  `freshness_col` vs `sla_minutes`). Isso funciona **mesmo para os syncs que ainda não
  logam runs**, então a aba já nasce completa sem ter de instrumentar os 14 workflows.
- **próxima execução** → calculada no browser a partir do `cron_utc`. Os crons aqui são
  simples; um parser pequeno resolve, e assim a página não precisa de token do GitHub.

**Aba 2 — "Excel Sync"**
Mesmo formato: cada conexão (workbook → aba), o que ela escreve, último build, checksum
mudou ou não, próximo run, e — na Fase 1, antes do Graph — um link para baixar o `.xlsx`
gerado, para conferência manual.

### 2.5 Layout no repo

```
features/excel-sync/
├── README.md
├── db/
│   ├── 001_ops_registry.sql
│   └── 002_excel_sync.sql
├── specs/                      # uma spec declarativa por aba automatizada
│   ├── soh-main.yaml
│   └── stock-value.yaml
├── engine/
│   ├── builder.py              # spec → DataFrame
│   ├── validators.py           # frescor, colunas, nulos, delta
│   ├── sources.py              # acesso ao Supabase (só cin7_mirror por ora)
│   └── delivery/
│       ├── local_xlsx.py       # Fase 1
│       └── graph.py            # Fase 4 — stub por enquanto
├── cli.py                      # python -m excel_sync build soh-main --dry
└── requirements.txt
```

---

## 3. Faseamento

| Fase | O que | Depende de | Esforço |
|---|---|---|---|
| **0** | Coletar o contrato: workbooks, abas, colunas exatas, exports do Cin7 | **você** | ✅ 2 reports validados |
| **1** | Engine Python + specs + validators + saída `.xlsx` local. Sem Graph, sem UI. Diff contra o export real do Cin7. | Fase 0 | 2–3 d |
| **1b** | Sync `sales-detail-month` (destrava o R2 de 94% → 100%) | — | 0,5 d |
| **2** | Schemas `ops` + `excel_sync`, seed do registry com os 14 syncs Cin7 | — | 1 d |
| **3** | Página de monitoramento, 2 abas, read-only | Fase 2 | 1–2 d |
| **4** | Rodar em GitHub Actions (ainda gerando artefato, sem escrever no Excel) | Fases 1–2 | 0,5 d |
| **5** | Adapter MS Graph — escreve de verdade na aba do OneDrive | Fases 1–4 verdes | 2–3 d |
| **P** | *(só se algum report pedir >3 meses de vendas por SKU)* backfill histórico | — | ~65 h de relógio |

As fases 1–4 não tocam em nada que está no ar. A fase 5 é a única com blast radius
externo, e só começa depois que a 1 provar que o dado sai certo.

---

## 4. O que eu preciso de você (Fase 0)

Você ofereceu mandar as colunas e os reports — é exatamente o que destrava. Em ordem de
utilidade:

1. **Um export real do Cin7** (`.xlsx`) de cada report que hoje alimenta as planilhas.
   Com ele eu faço o diff coluna-a-coluna contra o mirror e te digo, por coluna:
   já temos / precisa de sync novo / é impossível.
2. **A lista de workbooks e abas** a automatizar — nome do arquivo, caminho no
   SharePoint/OneDrive, e quais abas de cada um.
3. **A linha de cabeçalho exata de cada aba** (texto e ordem). O `update_main_avg_3mo.py`
   já aprendeu na marra que o Cin7 muda a ordem das colunas — as specs vão casar por
   nome de header, nunca por índice.
4. **Cada aba é substituída inteira ou é append?** E existe fórmula/pivot/tabela dentro
   da aba? Isso decide entre escrever um range de valores ou trocar a planilha toda — e
   é o que evita destruir fórmula de alguém.
5. **Cadência de cada aba** (diária? semanal? antes da reunião de segunda?).
6. **Dalton mapeia para quê?** (ver 1.2c)
7. **Algum report precisa de vendas por SKU com mais de 3 meses de histórico?**
   Se sim, o backfill entra no caminho crítico agora. Se não, começamos rápido.

---

## 5. Decisões já tomadas (para não re-discutir)

- Reports de estoque usam `on_hand`, nunca `SUM(available)`. (1.2a)
- `stock_on_hand` é valor AUD — usar para valor, nunca para quantidade. (1.2b)
- Python roda em GitHub Actions, não na Vercel nem na máquina local. (2.2)
- A página de monitoramento lê só do Supabase; nada de token do GitHub no browser. (2.4)
- `ops.sync_registry` é declarativo e cobre os 14 syncs desde o dia 1, mesmo os que não
  logam runs — saúde vem do frescor da tabela de destino. (2.4)
- Graph é a última fase, atrás de um adapter isolado. (2.1)
