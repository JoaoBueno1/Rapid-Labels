# Cyclic Count — plano de construção

> Estado: **plano**, nada construído. Escrito em 2026-09-04 depois de ler o
> workbook real (`Cyclic Stock Count - Aug/Set 2026.xlsx`), o Summary mensal,
> e sondar o banco do Labels em somente-leitura.

---

## 1. O que o Excel faz hoje

O processo vive em duas planilhas no SharePoint
(`Inventory Management ▸ Warehouse Stock Counts ▸ Warehouses Fan Stock Take`):

**`Cyclic Stock Count - <mês> 2026.xlsx`** — o trabalho do mês.
**`Stock Count Summary - <mês>.xlsx`** — o acumulado por SKU ao longo das semanas.

### 1.1 Anatomia do workbook do mês

8 abas de filial — `BR CA CH Main SC SY ME HO` — mais abas de apoio
(`<XX> SOH` coladas do Cin7, `Ghost`, `GH SOH`, `Price List <data>`, `5DC`, `Item List`).

Cada aba de filial tem **quatro blocos semanais empilhados**, com o cabeçalho
repetido nas linhas **2, 47, 95 e 140**, e a data da contagem na primeira célula
de dados de cada bloco (coluna A):

| Bloco | Linhas | Data (Ago/26) | Lista | Itens |
|---|---|---|---|---|
| 1 | 3–46 | 05/08 | **A** | 44 |
| 2 | 48–94 | 12/08 | **B** | 47 |
| 3 | 96–139 | 19/08 | **A** | 44 |
| 4 | 141–187 | 26/08 | **B** | 47 |

Verificado: `bloco1 == bloco3`, `bloco2 == bloco4`, e a interseção A∩B é **zero**.
São **duas listas fixas que se alternam semana a semana** — cada lista roda
quinzenalmente. 91 SKUs distintos no total.

À direita (colunas N–V) existe **um segundo bloco, mensal**, com uma lista curta
que muda de mês para mês (5 itens em agosto, 11 em setembro).

**A lista é a MESMA para as 8 filiais.** Conferido nas duas planilhas.

### 1.2 As colunas de um bloco

| Col | Cabeçalho | O que é de verdade |
|---|---|---|
| A | Date | data da contagem, digitada (às vezes texto: `27th Aug`) |
| B | 5DC | código Cin7 de 5 dígitos |
| C | SKU | nome do produto |
| D | QTY | **estoque do sistema** — colado da aba SOH, ou `VLOOKUP` nela |
| E | Count | **o que a filial contou** — a única coluna que a filial preenche |
| F | Ghost | explicação 1, texto livre: `2`, `MA x 1`, `BR x 4`, `SC X 1` |
| G | Movement | explicação 2, referência: `TR#48861`, `TR-48889`, `ST-12713` |
| H | Variance | `=E−D` — a diferença em **unidades** |
| I | Unit Cost | `=VLOOKUP(5DC, 'Price List'!B:D, 3) * H` — a diferença em **dólares** |

Os dois últimos cabeçalhos estão trocados de nome: `Variance` é unidade e
`Unit Cost` é valor. O sistema chama pelo que são.

Na coluna L, uma legenda de três ações — **Move to Ghost · Move from Ghost ·
Add to Stock** — o que quem trata a divergência vai fazer no Cin7 depois.

### 1.3 O Summary

Uma aba por filial, uma linha por SKU, e **uma coluna por data de contagem**
(`18/03`, `25/03`, `09/04`, `15/04`, `22/04`, `29/04` …) guardando a variância
daquela semana. No fim: `Movement` (a TR que explica), `Variance Total` (o que
ficou **sem explicação**), `Cost Each`, `Total Value`.

É o Summary que responde a pergunta que importa: *este SKU some sempre, ou
sumiu uma vez?* Hoje ele é remontado à mão todo mês.

### 1.4 Onde dói

- Achar quem não contou = abrir 8 abas e olhar se a coluna E está vazia.
- Disparo e cobrança por e-mail à mão, sem registro de que saiu.
- O SOH é colado — congela no momento da colagem, e ninguém sabe qual foi.
- `Ghost` e `Movement` são texto livre: `TR#`, `TR-`, `ST-`, `MA x 1`. Não somam.
- O Summary é trabalho manual mensal.
- Não há trava: a filial pode "contar" depois de ver a diferença.

---

## 2. O que já existe (e serve)

**Sonda somente-leitura no banco do Labels, 04/09/2026:**

| Coisa | Onde | Estado |
|---|---|---|
| SOH por local, diário | `cin7_mirror.stock_snapshot` | vivo, sync 03/09 23:04Z (≈ 04/09 09:04 Bne) |
| Inclui **Ghost** | idem, `location_name='Ghost'` | 313 SKUs |
| Filiais | `rapid_inv.warehouses` | BNE CFS CNS HBA MEL SCS SYD + MAIN, GATEWAY |
| Custo unitário canônico | `rapid_inv.v_sp_sku_cost.unit_cost_aud` | vivo |
| Usuários/papéis | `rapid_inv.app_users`, `app_roles`, `role_permissions` | **estrutura pronta, 0 linhas, gate desligado** |
| Transporte SQL | `public.sp_exec` via `features/stock-planning/lib/sp-db.js` | em uso |

O de-para das abas para os códigos:
`BR→BNE · CA→CNS · CH→CFS · Main→MAIN · SC→SCS · SY→SYD · ME→MEL · HO→HBA`.

### 2.1 O protótipo morto

Existem na raiz do repo `cyclic-count.html` (50 KB), `cyclic-count.js` (96 KB),
`count-form.html`, `count-form.js` — de 2025-11-21. **Não estão no menu**
(`shared/rail.js` não os cita) e as tabelas `count_sessions` / `count_session_items`
têm **1 linha, de 21/11/2025**. Nunca entrou em operação.

Ele acertou uma ideia — link com token para a filial preencher — e nada mais:
indigo `#4f46e5`, `alert()`, `style=` inline, lista cravada de 94 SKUs no
JavaScript, sem e-mail, sem agenda, sem snapshot, sem tratativa, sem histórico.

**Decisão: não migrar.** Feature nova em `features/cyclic-count/`, no design
system atual. O protótipo e as tabelas `count_*` ficam onde estão até a nova
subir, e então saem num commit próprio. `audit_products` (94 linhas) serve de
semente para a Lista A + B — é praticamente a mesma lista.

---

## 3. Desenho

### 3.1 Fidelidade visual

A tela nasce no mesmo sistema que **Branch Replenishment**, que por sua vez é o
do **Stock Planning** — `planning.css` carregado direto, sem tema novo
(CLAUDE.md proíbe mais um `*-theme.css`):

```html
<link rel="stylesheet" href="/features/stock-planning/ui/planning.css?v=21">
<link rel="stylesheet" href="/shared/rail.css?v=8">
<link rel="stylesheet" href="/shared/ui.css?v=4">
<link rel="stylesheet" href="cyclic-count.css?v=1">
<script defer src="/shared/rail.js?v=9"></script>
```

Vocabulário reaproveitado, verbatim: `sp-header` · `sp-brand` · `sp-logo` ·
`sp-tabs`/`sp-tab` · `sp-status`/`sp-dot` · `sp-main` · `sp-view`/`sp-view-inner` ·
`sp-bar` · `sp-tiles`/`sp-tile` (KPI) · `sp-scroll` + `sp-grid` (tabela densa,
linha 24 px, header sticky `--head`, zebra) · `sp-side` (painel direito) ·
`sp-modal`/`sp-box` · `sp-foot` (legenda) · `sp-loading`/`sp-empty` · `sp-count`.

Da Branch Replenishment vêm dois padrões específicos, porque foi ela que você
apontou como referência:

- **`rp-sched`** — a faixa de agenda semanal no topo da landing.
- **`rp-board`** — a tabela "In progress" com paginação, badge de status e a
  coluna **Emailed**. É literalmente a tabela de gestão pedida.

### 3.2 Modelo de dados — schema `rapid_inv`, prefixo `cc_`

| Tabela | Papel | Colunas-chave |
|---|---|---|
| `cc_list` | uma lista de contagem (A, B, mensal…) | `id, code, name, is_active, updated_at, updated_by` |
| `cc_list_item` | os SKUs da lista | `list_id, sku, sku_code, sort_order` |
| `cc_round` | **a unidade de trabalho**: uma filial, uma semana | `id, branch_code, list_id, week_start, status, token, snapshot_at, snapshot_source, sent_at, submitted_at, submitted_by, closed_at, closed_by` |
| `cc_round_line` | uma linha contável, congelada | `round_id, sku, sku_code, product_name, system_qty, unit_cost_aud, counted_qty, explain_qty, explain_location, explain_ref, action, note` |
| `cc_recipient` | lista de e-mails **por filial** | `branch_code, email, name, is_active` |
| `cc_email_log` | prova de que saiu | `round_id, to_emails, subject, status, provider_id, error, sent_at` |
| `cc_audit` | histórico que não se perde | `round_id, at, actor, what, detail jsonb` |

**O que é congelado e o que é derivado.** `system_qty` e `unit_cost_aud` são
**gravados na linha no momento do disparo**, com `snapshot_at` e
`snapshot_source`. Não são `VLOOKUP` vivo. Sem isso, a variância de julho muda
sozinha quando o custo médio muda em setembro — que é o defeito silencioso de
uma planilha com `VLOOKUP` para uma Price List que é substituída todo mês.

`snapshot_source` grava de onde veio o número: `CIN7_REFRESH` (o disparo pediu
um refresh e ele chegou) ou `MIRROR` (o refresh não rolou; usou o mirror com a
idade que tinha). A tela mostra qual foi. **Um snapshot que não sabe dizer de
onde veio não é prova de nada** — e é justamente o snapshot que sustenta a
conversa sobre dinheiro perdido.

Derivados, nunca gravados: `variance_qty = counted − system`,
`variance_value = variance_qty × unit_cost_aud`,
`unexplained_qty = variance_qty + explain_qty`.

**Ciclo de vida do `cc_round`:**

```
draft ─► sent ─► submitted ─► review ─► closed
  │        │
  │        └─ (não contou até o prazo) ─► overdue  [derivado, não é status]
  └─ cancelled
```

`sent` grava `snapshot_at` + as `system_qty`. **Depois de `sent`, a lista da
rodada não muda mais** — mudar a lista de uma contagem em andamento é o
equivalente a mudar a pergunta depois da resposta.

**Views:**
- `v_cc_round_summary` — por rodada: linhas, contadas, variância un/$, não-explicado $, status. Alimenta o board e os KPIs.
- `v_cc_sku_history` — por (filial, SKU, semana): **substitui o Summary mensal**.
- `v_cc_open` — o que está esperando alguém, e há quantos dias.

### 3.3 Telas

**A. `/cyclic-count` — gestão.** Abas `Rounds · Lists · Recipients · History`.

*Rounds* (a landing):
1. faixa `rp-sched`: a semana — que lista roda, para quais filiais, quando sai;
2. `sp-tiles`: filiais pendentes · contadas · variância líquida $ · **não explicado $** (o número que importa);
3. **o board** — `Branch · Week · List · Status · Sent · Counted · Var (un) · Var ($) · Unexplained ($) · Action`, paginado, clicável.

*Round workspace* — a grade do Excel em `sp-grid`:
`5DC · SKU · System · Count · Ghost · Movement · Variance · Value · Action · Note`,
com as colunas de tratativa editáveis por quem gerencia depois do `submitted`.
Clicar numa linha abre o `sp-side` com o **histórico daquele SKU naquela filial
por semana** — o Summary, embutido, sem remontar nada.

*Lists* — adicionar/remover linha, buscar SKU pelo mirror, duplicar lista,
ativar/desativar. É o "poder adicionar linhas" pedido. Toda edição vai no `cc_audit`.

*Recipients* — os e-mails por filial.

**B. `/count/<token>` — a filial.** Sem login, feita para o celular/tablet do armazém.
Cabeçalho com filial, semana, e **a data/hora do snapshot com sufixo de fuso**
(`04/09/2026 09:04 AEST` — regra do CLAUDE.md). Uma linha por SKU, campo
numérico grande, salvamento automático de rascunho, `Submit` que trava.
Depois de enviar: recibo somente-leitura.

⚠️ **Armadilha conhecida:** `styles.css:1043` tem um dark mode acidental
(`@media (prefers-color-scheme: dark) and (max-width: 768px)`) que pinta
`.app-table`. Esta tela é exatamente uma tabela num celular. **Não usar
`.app-table`** — classe própria.

### 3.4 E-mail

**Não existe nenhuma capacidade de envio de e-mail no Rapid-Labels.** Verificado:
sem nodemailer, sem SMTP, sem SDK. O TMS tem SendGrid, em Python
(`src/services/notifications.py`, `SENDGRID_API_KEY`).

Recomendação: **SendGrid v3 REST por `fetch`**, do próprio Express do Labels.
Sem dependência nova — e isso importa, porque mexer em `package.json` sem rodar
`npm install --package-lock-only` no mesmo commit derruba os **15 workflows**
que rodam `npm ci` (já aconteceu em 07/08/2026).

Volume: 8 filiais × 4 semanas = **32 e-mails/mês**. O tier grátis é 100/dia.

Toda tentativa — sucesso ou falha — escreve em `cc_email_log`. A coluna **Sent**
do board mostra a hora real; falha vira estado visível, não silêncio.

### 3.5 O disparo, e o snapshot ao vivo

Decidido: **botão do gestor** na fase 3; cron na fase 5. E o `system_qty` sai do
Cin7 no momento do disparo, não de um número velho.

Duas restrições reais moldam como isso é feito:

**(a) A chave do Cin7 é compartilhada com o TMS.** Todo o sync do Labels roda a
**2,5 s entre chamadas** (`callsPerMinute: 24`) e **derruba um circuit breaker a
qualquer 429**, explicitamente para proteger o Rapid-Express-Web. Abrir um
segundo chamador sem esse controle é como o incidente já documentado: o TMS
leva o 429 que o Labels causou.

**(b) `vercel.json` limita `api/index.js` a `maxDuration: 60`.** Um pull completo
de `ref/productavailability` são ~15,4 mil linhas ÷ 1000 por página = **~16
chamadas × 2,5 s ≈ 40 s**, antes de escrever no banco. Cabe em 60 s por pouco —
e "por pouco" numa rota que dispara e-mail para 8 filiais não é margem.

**Como fica.** O mirror já é atualizado **de hora em hora** por
`cin7-sync.yml` (`cron: '0 * * * *'`), e esse workflow **já aceita
`workflow_dispatch`**. Então:

```
[Send]  →  cc_round: dispatching
        →  dispara cin7-sync (workflow_dispatch) e espera aterrissar
        →  congela system_qty + unit_cost_aud, snapshot_source = CIN7_REFRESH
        →  envia os e-mails, grava cc_email_log
        →  cc_round: sent, sent_at = a hora real
```

O número é do Cin7 no momento do disparo — mas pelo **único caminho throttled e
com circuit breaker que já existe**, em vez de um segundo caminho sem freio.

Se o refresh não puder rodar (sem token, workflow ocupado, Cin7 fora), o disparo
**não trava**: congela do mirror, grava `snapshot_source = MIRROR` e a idade, e a
tela diz isso. Vazio ≠ erro, e "ao vivo" ≠ "achamos que era ao vivo".

⚠️ Na fase 5, o cron do GH Actions atrasa: mediana **+14 min**, pior caso
**+59 min** (medido). A agenda promete *"segunda de manhã"*, não *"07:00"*.

### 3.6 Permissões (fase 5)

`rapid_inv.app_users` / `app_roles` / `role_permissions` já existem e estão
vazios; o gate está desligado e o app usa o PIN `4209`. Quando ligar:
`cyclic.manage` (gestão) e `cyclic.count` (filial, só a própria). O link com
token continua sendo o caminho de quem conta — quem está no armazém não tem
login, e exigir um faria a contagem parar.

---

## 4. Fases

| # | Entrega | Estado |
|---|---|---|
| **1** | Schema + seed das listas A/B/mensal a partir do Excel | ✅ **aplicado em prod** 04/09 (`001`, `002`) |
| **2** | Correção da semântica do "explicado" + funções de escrita | `003`, `004` — escritos e testados, **a aplicar** |
| **3** | Rotas, tela de gestão, folha da filial, e-mail, item no menu | ✅ construído, a validar em uso |
| **4** | Tratativa, fechar rodada, histórico | ✅ dentro da fase 3 |
| **5** | Cron do agendador + página de análise (SKUs que somem sempre) | pendente |
| **6a** | Aposentar o protótipo de 2025 — 4 páginas, 2 uploaders órfãos, 7 rotas, `server.js` 1.131→838 | ✅ 04/09 (`005` a aplicar) |
| **6b** | Gate de permissão (`app_users` já existe, vazio) | pendente |

Decisão registrada: as tabelas `audit_*` ficaram órfãs junto, mas **não caem
no `005`**. `audit_stock_analysis` tem 5.208 linhas de análise real de
novembro/2025 — apagar histórico é decisão a se tomar de propósito. O `DROP`
pronto está comentado no fim do `005` e em `docs/DEAD_CODE_REGISTER.md`.

### O que foi construído

```
features/cyclic-count/
  db/001_core.sql                    tabelas, views, grants        APLICADO
  db/002_seed_lists.sql              A=44 · B=47 · mensal=11       APLICADO
  db/003_unexplained_semantics.sql   correção do "explicado"       a aplicar
  db/004_write_fns.sql               6 funções de escrita          a aplicar
  lib/mailer.js                      SendGrid v3 por fetch
  routes/cyclic-count-routes.js      a API
  ui/cyclic-count.{html,css,js}      gestão — Rounds/Lists/Recipients/History
  ui/count-form.{html,css,js}        a folha da filial, no celular
```

Ligações: `server.js` (bloco próprio), `shared/rail.js` (item **Cyclic Count**
fechando o grupo Inventory Management), `vercel.json` (`/cyclic-count` e
`/count/:token`).

### O que ainda falta para rodar de verdade

Variáveis de ambiente (Vercel e `.env` local):

| Variável | Para quê | Sem ela |
|---|---|---|
| `SENDGRID_API_KEY` | enviar | a tela avisa "Email off"; o disparo congela e cria a folha, mas ninguém é notificado |
| `CC_MAIL_FROM` | remetente verificado no SendGrid | idem |
| `CC_PUBLIC_BASE_URL` | o link dentro do e-mail | cai no padrão `https://rapid-labels.vercel.app` |
| `CC_GH_TOKEN` + `CC_GH_REPO` | botão "Refresh from Cin7" | o botão some; o disparo usa o espelho, que já é de hora em hora |
| `CC_MAX_SNAPSHOT_AGE_MIN` | limite de idade do espelho | 90 min |

---

## 5. Decidido (04/09/2026)

| # | Decisão |
|---|---|
| **Lista** | **Uma lista por semana, igual para todas as filiais** — como o Excel faz hoje. Lista A e Lista B alternando. |
| **Disparo** | **Botão do gestor** na fase 3. Cron automático só na fase 5, depois que o fluxo provar que funciona. |
| **Snapshot** | **Do Cin7 no momento do disparo**, congelado por linha — via refresh sob demanda do sync existente (§3.5), com `snapshot_source` gravado. |

### Ainda aberto

**Contagem cega.** A filial vê o `System QTY` enquanto conta? No Excel ela vê
(coluna D ao lado da E). Contar às cegas — digitar só o que se achou, e o
sistema mostrar a diferença depois — é o que evita alguém "confirmar" o número
da tela em vez de ir até a prateleira. Não bloqueia a fase 1: o snapshot é
gravado dos dois jeitos; muda só o que a tela da filial renderiza na fase 3.
