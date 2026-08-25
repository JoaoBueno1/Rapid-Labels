# Stock Planning — Plano de construção

> Companion de `STOCK_PLANNING_01_DISCOVERY.md`. Lá está o que o Excel é; aqui está o que
> construímos. Branch `dev`, módulo isolado, nada plugado na navegação até você mandar.
>
> **Princípio:** *as regras são as do Excel. O modelo de dados é melhor. A tela é familiar.*

---

## 0. Estado do repositório (verificado agora, não assumido)

| Item | Estado real |
|---|---|
| `cin7_mirror.products` | **11.251** linhas |
| `cin7_mirror.stock_snapshot` | **15.337** |
| `cin7_mirror.sale_lines` | **51.675** ← linhas de SO existem |
| `cin7_mirror.order_pipeline` | 1.754 |
| `cin7_mirror.locations` | 1.417 |
| `public.branch_avg_monthly_sales` | 4.644 |
| **schema `rapid_inv`** | **inacessível pela API** — `42501 permission denied for schema rapid_inv` |
| `features/rapid-inventory/dashboard.html` | existe, mas **não consegue ler nada** pelo motivo acima |
| Autenticação | **PIN `4209` compartilhado, cravado no código**. Não existe tabela de usuários |

O trabalho anterior (`sql/rapid_inv_setup.sql`, 10 tabelas) foi aplicado ao banco mas o
`GRANT` de `sql/rapid_inv_service_role_grants.sql` **nunca rodou** — por isso o schema inteiro
está dormente. As tabelas estão vazias e inalcançáveis.

**Consequência boa:** podemos reestruturar `rapid_inv` livremente. Nenhuma página viva depende dele.

**Decisão:** *estender* `rapid_inv` em vez de criar um terceiro schema. Ele já tem
`week_calendar`, `audit_log` com trigger universal, `suppliers`, `skus`. Duplicar isso seria
exatamente o "segundo backend" que o briefing proíbe.

---

## 1. Convenção do módulo

Seguindo o padrão mais novo do repo (`features/wms/`), que é o mais limpo:

```
features/stock-planning/
├── db/
│   ├── 001_core.sql            projects, project_lines, project_draws
│   ├── 002_planning.sql        seasonal_factors, planning params, fx, aliases, versões
│   ├── 003_views.sql           demanda/semana, incoming/semana, projeção
│   ├── 004_permissions.sql     usuários, papéis, matriz  (aplicar por último)
│   └── 000_grants.sql          o GRANT que destrava o schema
├── lib/
│   ├── planning-engine.js      a cascata — puro, testável, sem I/O
│   ├── week.js                 data → semana (a correção do bug do SUMIFS)
│   └── excel-import.js         leitor do workbook
├── routes/
│   └── stock-planning-routes.js
├── ui/
│   ├── planning.html  planning.css  planning.js
└── tests/
    └── planning-engine.test.js   (node --test, como features/gateway e container-builder)
```

Registro no `server.js` em **uma linha**, igual ao WMS, atrás de flag:

```js
if (process.env.STOCK_PLANNING_ENABLED === '1') {
  require('./features/stock-planning/routes/stock-planning-routes').register(app, supabaseBackend);
  app.use('/planning', express.static(path.join(__dirname,'features/stock-planning/ui'), { index:'planning.html' }));
}
```

Sem botão no `index.html`, sem tocar `home.js`, sem alterar página existente.
CSS com tokens próprios no arquivo do módulo — mesma convenção de `restock-v2-theme.css`
e `features/wms/pwa/wms.css`.

---

## 2. Modelo de dados

### 2.1 O que muda em relação ao Excel — e por quê

| Excel | Sistema | Motivo |
|---|---|---|
| linha duplicada para parcelar entrega | **`project_draw`** | já é a prática real (391 casos). Só não tinha onde caber |
| aba `Project` + aba `Completed Projects` | **um `status`** | recortar-e-colar perdeu 8.906 finish dates |
| pick date tem que cair no domingo exato | **qualquer data → cai na sua semana** | corrige 32 draws + 8 POs invisíveis |
| `Wk/Avg` digitado dentro da aba do fornecedor | **campo `wk_avg` por SKU** | mesma semântica manual, agora com histórico e auditoria |
| meta de cobertura cravada em `=B9*7` | **`target_cover_weeks` por SKU** | já variava (4/6/7/8/10). Vira campo |
| curva sazonal copiada em 22 abas | **um calendário `seasonal_factors`** | são idênticas. 22 cópias é só risco |
| custo dentro da fórmula (539 distintos) | **`unit_cost` na linha da PO** | permite corrigir sem editar fórmula |
| `/0.65` e `/0.68` misturados | **`fx_rates` com vigência** | AUD consistente |
| 26 grafias de fornecedor | **`supplier_aliases`** | agrupa certo |
| marcador da semana movido à mão em 22 abas | **`reporting_week` — uma linha de config** | o passo que mais corrompe o arquivo |
| sem quem-mudou-o-quê | **`audit_log` (já existe)** | requisito para 50–80 pessoas |

Tudo isso **preserva a aritmética**. Nenhuma regra de cálculo do documento de discovery muda.

### 2.2 DDL — `001_core.sql`

```sql
-- Projeto = cabeçalho do que hoje é o bloco de linhas com o mesmo Sales Order
CREATE TABLE rapid_inv.projects (
  id              BIGSERIAL PRIMARY KEY,
  sales_order     TEXT NOT NULL,
  order_date      DATE,
  customer        TEXT,
  reference       TEXT,                      -- "2943 - Tod Ferny Grove"
  rep             TEXT,
  warehouse_note  TEXT,                      -- texto livre da coluna WAREHOUSE (ver 2.4)
  warehouse_code  TEXT,                      -- normalizado quando reconhecível
  status          TEXT NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED')),
  finish_date     DATE,
  source          TEXT NOT NULL DEFAULT 'MANUAL'   -- MANUAL | EXCEL_IMPORT | CIN7
  cin7_sale_id    TEXT,                      -- reservado; NULL na V1
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  updated_by      TEXT
);
-- impede o mesmo SO entrar duas vezes
CREATE UNIQUE INDEX ux_projects_so ON rapid_inv.projects (upper(trim(sales_order)));
CREATE INDEX ix_projects_status ON rapid_inv.projects (status, order_date DESC);

-- Linha = um SKU dentro do projeto. Aritmética idêntica ao Excel.
ALTER TABLE rapid_inv.project_lines
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES rapid_inv.projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS line_no    INT,
  ADD COLUMN IF NOT EXISTS po_due_date DATE,           -- existia só em Completed Projects
  ADD COLUMN IF NOT EXISTS source     TEXT DEFAULT 'MANUAL';
-- qty_to_pick já é GENERATED: GREATEST(qty - qty_inv - qty_held, 0)   ✔ igual ao Excel

-- Draw = uma parcela planejada da linha. O conceito que o Excel não tinha.
CREATE TABLE rapid_inv.project_draws (
  id            BIGSERIAL PRIMARY KEY,
  line_id       BIGINT NOT NULL REFERENCES rapid_inv.project_lines(id) ON DELETE CASCADE,
  qty           NUMERIC NOT NULL CHECK (qty > 0),
  planned_date  DATE,                        -- NULL = TBA. Legítimo: 50% das linhas hoje
  status        TEXT NOT NULL DEFAULT 'PLANNED'
                CHECK (status IN ('PLANNED','PICKED','PACKED','INVOICED','CANCELLED')),
  note          TEXT,                        -- "handover 14/8", "aguardando cliente"
  source        TEXT NOT NULL DEFAULT 'MANUAL',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  updated_by    TEXT
);
CREATE INDEX ix_draws_line ON rapid_inv.project_draws (line_id);
CREATE INDEX ix_draws_date ON rapid_inv.project_draws (planned_date)
                             WHERE status NOT IN ('CANCELLED','INVOICED');
CREATE INDEX ix_draws_tba  ON rapid_inv.project_draws (line_id)
                             WHERE planned_date IS NULL AND status = 'PLANNED';
```

**Sobre a soma dos draws vs a quantidade da linha:** o briefing pede validação sem travar
exceção operacional. Implementação: **aviso, não bloqueio**. Uma view
`v_draw_integrity` marca `over_planned` quando `Σ draws abertos > qty_to_pick`, aparece como
badge âmbar na grade e como alerta. Nunca impede salvar — a operação tem casos legítimos
(cliente pediu a mais, split entre armazéns) e travar faria o time voltar pro Excel.

**Migração das linhas atuais:** toda linha do Excel vira 1 linha + 1 draw
(`qty = qty_to_pick`, `planned_date = PICK DATE`). Linhas duplicadas do mesmo `SO+SKU` viram
**draws da mesma linha** quando `QTY`, `TYPE` e `UNIT PRICE` batem — os 391 casos multi-data.
Quando não batem, ficam linhas separadas. Regra conservadora: **na dúvida, não funde.**

### 2.3 DDL — `002_planning.sql`

```sql
-- Curva sazonal: UMA, global, por semana. Substitui as 22 cópias idênticas.
CREATE TABLE rapid_inv.seasonal_factors (
  week_start  DATE PRIMARY KEY REFERENCES rapid_inv.week_calendar(week_start),
  factor      NUMERIC(5,4) NOT NULL DEFAULT 1 CHECK (factor >= 0),
  reason      TEXT,                            -- 'Chinese New Year'
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  TEXT
);
-- Semana sem linha aqui = fator 1. Seed = as 26 semanas extraídas do workbook.

-- Parâmetros de planejamento por SKU. Estende sku_settings, não substitui.
ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS wk_avg              NUMERIC,       -- MANUAL, como no Excel
  ADD COLUMN IF NOT EXISTS wk_avg_source       TEXT DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS target_cover_weeks  INT DEFAULT 7, -- Excel: 4/6/7/8/10 por SKU
  ADD COLUMN IF NOT EXISTS supplier_override   TEXT,
  ADD COLUMN IF NOT EXISTS is_planned          BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS unit_cost_usd       NUMERIC;

-- Estado do planejamento: a semana de reporte. Substitui mover o "1" em 22 abas.
CREATE TABLE rapid_inv.planning_state (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  reporting_week  DATE NOT NULL REFERENCES rapid_inv.week_calendar(week_start),
  rolled_at       TIMESTAMPTZ,
  rolled_by       TEXT
);

CREATE TABLE rapid_inv.fx_rates (
  effective_from  DATE PRIMARY KEY,
  aud_per_usd     NUMERIC(8,5) NOT NULL,      -- 0.65 → 0.68
  note            TEXT
);

CREATE TABLE rapid_inv.supplier_aliases (
  alias         TEXT PRIMARY KEY,             -- 'X TRACK', 'AOK ', 'ELITE', 'FOSHAN KL'
  supplier_code TEXT NOT NULL REFERENCES rapid_inv.suppliers(code)
);

CREATE TABLE rapid_inv.sku_versions (
  version_code  TEXT PRIMARY KEY,             -- 'R1066-WH-12W-CW-24-V1'
  current_sku   TEXT NOT NULL,
  resolved      BOOLEAN DEFAULT false,        -- bate no catálogo? (904 de 1.787 hoje)
  note          TEXT
);

ALTER TABLE rapid_inv.po_lines
  ADD COLUMN IF NOT EXISTS unit_cost_usd NUMERIC,   -- os 539 custos que viviam na fórmula
  ADD COLUMN IF NOT EXISTS fx_used       NUMERIC,
  ADD COLUMN IF NOT EXISTS vessel        TEXT,      -- coluna "Require": gancho do TMS
  ADD COLUMN IF NOT EXISTS shipment_id   BIGINT,    -- reservado p/ container/vessel do TMS
  ADD COLUMN IF NOT EXISTS cin7_po_id    TEXT;      -- reservado; NULL na V1
```

### 2.4 A coluna `WAREHOUSE` do Excel

Hoje ela mistura três coisas: armazém real (`BNE Project`, `SYD PROJECTS`), divisão
(`400 AT SYD, 180 AT MAIN`) e recado (`emailed rod 17/8`, `container`).

Import: tenta casar com `cin7_mirror.locations`; casou → `warehouse_code`;
não casou → **texto vai inteiro para `warehouse_note`**. Nada é descartado.
A grade mostra as duas colunas. Nenhuma informação some, e o dado limpo fica utilizável.

---

## 3. O motor de planejamento

`features/stock-planning/lib/planning-engine.js` — função pura, sem banco, sem rede.
Recebe fatos, devolve a projeção. É o que os testes atacam.

```js
projectSku({ openingAvailable, wkAvg, seasonalByWeek, incomingByWeek,
             drawsByWeek, undatedQty, weeks })
// → [{ week, opening, incoming, expectedSales, projectDraws, closing }]
```

Regras, **idênticas ao Excel** (§5 do discovery):

```
semana de reporte:  closing = SOH real                      (âncora)
semana futura:      opening = closing da anterior
                    expectedSales = wkAvg × fator(semana)   ← fator só aqui
                    closing = opening + incoming − expectedSales − projectDraws
```

Quatro diferenças, todas deliberadas e documentadas:

1. **Bucketing por semana.** `weekOf(date)` = domingo da semana da data. Uma pick date numa
   quarta entra na semana dela. No Excel ela sumia. Corrige 32 draws + 8 POs hoje.
2. **`undatedQty` é retornado à parte, nunca somado a uma semana.** Vira coluna própria no
   grid. Metade da demanda de hoje é TBA — jogar num bucket arbitrário seria inventar dado.
3. **SOH ≤ 0 não some.** O Excel faz `IF(D>0,…,"")` e esconde 714 SKUs. Aqui `mths_stock`
   vira `NULL` mas o SKU **aparece marcado como crítico**.
4. **Horizonte rolante** (12/26/52 semanas) derivado do `week_calendar`. Nenhuma coluna de
   banco por semana; nenhuma célula de projeção persistida.

`Mths Stock` mantém a fórmula do Excel exatamente: `(SOH + project_orders) / (wk_avg × 52/12)`
— **soma**, porque `project_orders` é negativo. E o limiar de alerta é o do Excel:
**< 1 mês = recomprar**. Os defaults 2,5/4 que estavam em `sku_settings` **não** são a regra
do negócio; viram parâmetro configurável com default 1.

### Performance

- Draws e POs agregados por `(sku, week)` numa view — `GROUP BY` sobre 5.351 + 1.466 linhas.
- Cascata em CTE recursiva por SKU, ou em JS quando o filtro já reduziu o conjunto.
- UI **virtualizada** e paginada por fornecedor. `Upshine` sozinho tem 1.312 SKUs.
- Nenhuma chamada ao Cin7 por linha. A V1 não chama Cin7 em runtime.
- Alvo: fornecedor × 52 semanas em **< 400 ms**.

---

## 4. As telas

Cinco seções, densas, sem enfeite — é ferramenta operacional.

### Projects
A grade que o time reconhece à primeira olhada. **Mesmos nomes, mesma ordem do Excel:**

```
DATE │ SALES ORDER │ CUSTOMER │ REFERENCE │ REP │ SKU │ QTY │ TYPE │ UNIT PRICE │
QTY to Pick │ PO │ PICK DATE │ QTY HELD │ Date packed │ Days held │ QTY INV │
REQUIRED │ WAREHOUSE │ Comments
```

- `SALES ORDER`, `CUSTOMER`, `SKU` congelados à esquerda
- edição inline nos campos de planejamento; `Tab`/`Enter`/setas navegam como planilha
- filtro rápido, busca, ordenação, seleção múltipla
- estado de gravação explícito por célula (salvo / salvando / erro) — nunca silencioso
- **`PICK DATE` mostra `2 draws` quando a linha tem parcelas**, e expande
- **Split Draw**: divide quantidade e data em dois cliques
- `REQUIRED` renderizado íntegro, com destaque quando contém data reconhecível
- Completed = **filtro**, não outra tela. Botão Complete / Reactivate por projeto

### Supply Planning
```
SKU │ SOH │ Wk/Avg │ Mths │ TBA │ Incoming │ W35 │ W36 │ W37 │ W38 │ …
```
Filtro por fornecedor (obrigatório antes de renderizar — é o mental model das 22 abas).
Cores: negativo, abaixo do alvo de cobertura, saudável; marcadores discretos para
semana com PO chegando e semana com draw grande.

### SKU detail (o "por quê")
Clicar numa célula abre o extrato daquela semana:
```
Opening                    1.250
Incoming    PO-14521        +500      due 05-Oct
Expected sales (Wk/Avg 120 × 100%)   −120
Project draws
   SO-208233  Techlight     −200      draw 2 de 3
   SO-209114  Hillside       −75
Closing                    1.355
```
Se o planejador não consegue explicar o número, o módulo falhou.

### Purchase Orders
Espelho da aba `PO's` + `unit_cost_usd`, FX resolvido por vigência, `vessel`.
V1 **não cria PO no Cin7** — só registra e alimenta o Incoming.

### Alerts
Determinístico, sem IA:
`projeção < 0` · `projeção < alvo de cobertura` · `demanda sem pick date` ·
`PO chegando depois da ruptura` · `draw fora do padrão do SKU` · `SOH ≤ 0` (os 714 invisíveis)
· `draws somam mais que a linha` · `pick date no passado`.

---

## 5. Auditoria

`rapid_inv.audit_log` + `fn_audit_log()` já existem e funcionam por trigger JSONB.
Basta ligar nas tabelas novas. Campos rastreados, conforme o briefing:
quantidade e data de draw, status, `REQUIRED`, `qty_held`, `date_packed`, `qty_inv`,
comentários, `wk_avg`, `target_cover_weeks`, fator sazonal e roll da semana de reporte.

Duas mudanças necessárias para 50–80 pessoas:
- hoje `set_audit_user(email, pin)` recebe `'dashboard' / '4209'` — inútil. Passa a receber o
  usuário real da sessão.
- toda linha de projeto ganha um **timeline lateral** ("quem mudou a pick date, quando, de quê
  para quê"). É a pergunta nº 1 que ninguém consegue responder hoje.

---

## 6. Permissões (desenhado agora, ligado depois)

Não existe nada hoje: PIN `4209` compartilhado, sem tabela de usuários. Para 50–80 pessoas isso
não escala e nem é auditável. Desenho preparado desde já para não precisar refazer o schema:

```sql
rapid_inv.app_users        (id, email, name, is_active, last_seen_at)
rapid_inv.app_roles        (code, name)
rapid_inv.role_permissions (role_code, permission)     -- 'projects.edit_draw', 'planning.edit_wkavg'…
rapid_inv.user_roles       (user_id, role_code)
```

Papéis iniciais e o que cada um toca:

| Papel | Projetos | Draws | Params de planejamento | POs | Completar | Admin |
|---|---|---|---|---|---|---|
| Viewer | ler | ler | ler | ler | — | — |
| Sales / CS | criar, editar | editar | — | ler | — | — |
| Warehouse | ler | held/packed | — | ler | — | — |
| Planner | editar | editar | **editar** | editar | ✔ | — |
| Purchasing | ler | ler | ler | **editar** | — | — |
| Admin | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

Enquanto o login real não existe, o módulo pede **nome/e-mail na entrada** e grava no audit —
não é segurança, mas já responde "quem mudou". Gate de permissão fica atrás da mesma flag,
desligado, sem bloquear nada na V1.

---

## 7. Fases

Ordem alinhada com o que você definiu: **fiel ao Excel primeiro, Cin7 depois.**

| # | Fase | Entrega | Depende de |
|---|---|---|---|
| **0** | Fundação | `000_grants.sql` (destrava o schema) + `001` + `002` + seeds: 109 semanas, 26 fatores sazonais, 22 fornecedores + aliases, FX 0,65/0,68, `reporting_week = 2026-08-23` | — |
| **1** | Import do workbook | 5.351 linhas ativas → projetos/linhas/draws · 18.767 históricas · 1.466 POs · 1.988 SKUs com `wk_avg` e `target_cover_weeks` · 1.787 versões · SOH/Dalton/Gateway | 0 |
| **2** | Motor + testes | `planning-engine.js` + os 12 casos obrigatórios | 0 |
| **3** | **Paridade** | comparar Excel × motor em SKUs de vários fornecedores, célula a célula | 1, 2 |
| **4** | Projects UI | grade, edição inline, split draw, complete/reactivate | 1 |
| **5** | Supply Planning UI | grid semanal + drill-down | 2, 3 |
| **6** | POs UI | grade + custo + FX + vessel | 1 |
| **7** | Alerts + timeline de auditoria | | 4, 5 |
| **8** | Permissões | `004_permissions.sql` + login real | 4–7 |
| **9** | *(depois)* Cin7 | import de SO (`cin7_mirror.sale_lines`, 51.675 linhas prontas), PO sync, SOH ao vivo, webhooks | tudo acima estável |

A fase 3 é **gate**: sem paridade demonstrada, não avança para a UI de planejamento.

---

## 8. Testes

`node --test features/stock-planning/tests/` — mesma convenção de
`features/container-builder/packer.test.js` e `features/gateway/tests/`.

Os 12 casos exigidos: só SOH · SOH + vendas · PO entrando · um draw datado · vários draws ·
draw sem data · demanda > estoque · PO depois da ruptura · held/invoiced parcial ·
várias semanas em cascata · filtro por fornecedor · SKU com versão `-V1/-V2`.

Mais os que o workbook exigiu depois da análise:
sazonal 0% no CNY · pick date fora do domingo (o bug) · SOH ≤ 0 não pode sumir ·
soma de draws > qty da linha · alias de fornecedor · FX por vigência.

**Paridade (fase 3):** para uma amostra de SKUs de CGD, Relight, Upshine, Aeon e Ottima,
comparar `opening`, `incoming`, `expected sales`, `project draws` e `closing` semana a semana
contra os valores calculados pelo Excel. Qualquer diferença é: (a) bug nosso — corrigir, ou
(b) um dos 12 defeitos do §4 do discovery — documentar como divergência intencional.
Não existe terceira opção, e "a tela parece certa" não conta.

---

## 9. O que NÃO entra na V1

- Criação automática de PO no Cin7 — schema já preparado (`cin7_po_id`), comportamento não
- Explosão de BOM — não existe no Excel nem no Cin7; a aba `BOM` só agrega demanda
- Port do `Stock Value` — precisa de COGS + custo landed; fase própria depois
- Qualquer IA. Aritmética determinística não precisa de LLM
- Integração TMS completa — só os identificadores (`vessel`, `shipment_id`) para plugar depois
  sem redesenhar tabela

---

## 10. Riscos

| Risco | Mitigação |
|---|---|
| Time acha a tela estranha e volta pro Excel | colunas com o mesmo nome e ordem; Excel roda em paralelo até a paridade fechar |
| Import funde draws errado | funde só quando `QTY`+`TYPE`+`UNIT PRICE` batem; na dúvida, não funde; import é `--dry-run` por padrão |
| `wk_avg` importado desatualiza | mostra o realizado calculado ao lado como sugestão; **nunca sobrescreve** o manual |
| Números divergem do Excel | fase 3 é gate, com diferença documentada linha a linha |
| Excel muda enquanto construímos | import é idempotente por `sales_order` + `line_no`; reimportável |
| `rapid_inv` continuar inacessível | `000_grants.sql` é o primeiro passo da fase 0 |
