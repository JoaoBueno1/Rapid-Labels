# Stock Planning

Substitui o `Rapid-Inventory SKU 2026.xlsx` — 35 abas, 990 mil fórmulas, 28,7 MB.
As regras de cálculo são as do workbook. O modelo de dados é melhor. A tela é familiar.

Feature isolada, atrás de `STOCK_PLANNING_ENABLED=1`, fora da navegação.
Análise completa em `docs/STOCK_PLANNING_01_DISCOVERY.md`, `_02_PLAN.md` e `_03_CIN7_AUTOMATION.md`.

## Rodar

```bash
STOCK_PLANNING_ENABLED=1 npm start      # abre http://localhost:8383/planning
```

Dois transportes (`lib/sp-db.js`): com `SUPABASE_DB_PASSWORD` no `.env` fala direto com o
Postgres; sem ela, cai no `public.sp_exec` usando só a service key. O schema `rapid_inv`
não é exposto pelo PostgREST — foi esse 42501 que deixou o dashboard anterior dormente por
dois meses sem ninguém perceber.

**O transporte por service key classificava errado toda consulta que começa com
comentário** e devolvia `[]` sem erro — a lista de compra inteira vinha vazia em qualquer
máquina sem a senha. Consertado na 032; ver o cabeçalho dela.

## Scripts

```bash
node features/stock-planning/scripts/apply-db.js                 # dry-run das migrações
node features/stock-planning/scripts/apply-db.js --write

node features/stock-planning/scripts/import-workbook.js          # dry-run (padrão, seguro)
node features/stock-planning/scripts/import-workbook.js --write
node features/stock-planning/scripts/import-workbook.js --write --skip-completed
node features/stock-planning/scripts/import-workbook.js --only=pos,stock --write

node features/stock-planning/scripts/parity-check.js --sample=60 --weeks=26
node features/stock-planning/scripts/parity-check.js --supplier=CGD --verbose

node --test features/stock-planning/tests/planning-engine.test.js
```

O `parity-check` é **gate**: sai com código 1 se sobrar qualquer divergência sem causa
conhecida. Ele classifica cada diferença entre defeito do workbook e erro do motor —
"a tela parece certa" não conta.

## Estrutura

```
db/       000 grants · 001 projeto/linha/draw · 002 parâmetros · 003 views · 004 permissões
lib/      week.js (data → semana) · planning-engine.js (a cascata, pura) · excel-import.js · sp-db.js
routes/   stock-planning-routes.js  → /api/stock-planning/*
ui/       planning.html/css/js      → /planning
tests/    planning-engine.test.js   (22 casos)
scripts/  apply-db · import-workbook · parity-check
```

## O motor

```
semana de reporte   closing = SOH real                       (a âncora)
semana futura       opening = closing da semana anterior
                    expectedSales = Wk/Avg × fator sazonal
                    closing = opening + incoming − expectedSales − draws
```

O fator sazonal multiplica **só venda normal**. Draw de projeto e chegada de PO não são
sazonalizados — um contêiner que chega em janeiro chega em janeiro.

Quatro diferenças deliberadas em relação ao Excel, cada uma com um defeito medido atrás dela:
data cai na semana dela (32 draws e 7 POs que o `SUMIFS` perdia em silêncio); TBA volta
separado e nunca entra numa semana; `SOH ≤ 0` não some da tela (714 SKUs invisíveis hoje);
horizonte rolante, sem coluna de banco por semana.

## Coisas que não são óbvias

- **`Wk/Avg` é MEDIDO desde a migração 029.** Este parágrafo dizia o contrário — "é
  julgamento do planejador, tratar como calculado mudaria a decisão de compra da empresa
  inteira" — e a leitura do banco desmentiu: `wk_avg_source = 'EXCEL_IMPORT'` em 1.951 de
  1.951 SKUs, `updated_at` = 25/08/2026 em todos, e 609 em zero. Ninguém encostou no campo
  desde o import. Contra a venda real, 832 dos 1.226 comparáveis erravam por 9,4
  unidades/semana em média (92%).

  Hoje o padrão é a venda das últimas 13 semanas, sem projeto (o draw já entra na cascata
  em separado). Quem quiser fixar um número usa `wk_avg_override`, e a grade mostra a
  linha como fixada em vez de fingir que o número saiu da venda. A janela é escolhível na
  tela (4/13/26/52); 13 é a régua que alertas, buy e overview também leem.
- **A cobertura em meses SOMA o compromisso de projeto**, porque ele vem negativo (662 de 854
  SKUs). Trocar por subtração inverte tudo.
- **A aba `DALTON` do workbook contém o Main Warehouse** — o cabeçalho dela diz isso. O nome
  da aba engana; aqui o código é `MAIN`.
- **SKU casa por `sku_key`** (upper+trim). A aba PO's grava em maiúsculas e as demais em
  minúsculas; o `SUMIFS` ignora caixa, um `=` de SQL não.
- **A linha do Excel já é o draw.** A suposição de que linhas repetidas de SO+SKU fossem
  parcelas não se sustentou — cada uma tem sua QTY, sua QTY INV e seu próprio texto de agenda.
  O import é 1-para-1 e não funde nada.
- **Draws somando mais que a linha avisam, não travam.** A operação tem exceção legítima, e
  travar faria o time voltar para o Excel no primeiro dia.
