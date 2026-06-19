# Rapid Inventory — Correções v2 (isoladas)

**Arquivo:** [sql/rapid_inv_fixes_v2.sql](../sql/rapid_inv_fixes_v2.sql)
**Data:** 2026-06-18

Corrige as divergências encontradas na auditoria Excel × Sistema, **sem quebrar nada**: tudo é criado com sufixo `_v2` via `CREATE OR REPLACE`, é 100% read-only e **não está ligado a nenhum botão/página** (proposital — você liga depois).

## O que foi corrigido

| # | Problema | Correção (v2) |
|---|---|---|
| **1** | Fórmula de meses-de-cobertura divergia do Excel e era ambígua (`+`/`−`) | `v_analysis_v2.mths_stock = (SOH − demanda_projeto_aberta) / média_mensal` (definição canônica). Coluna extra `mths_stock_with_on_order` replica a variante da aba SOH do Excel (inclui On Order) para conferência lado-a-lado |
| **2** | Thresholds eram `red=2,5 / yel=4`; Excel alerta com `<1 mês` | Default `red=1 / yel=2` em `v_analysis_v2` (overrides por SKU em `sku_settings` continuam valendo) |
| **3** | Analysis e Forecast usavam filtros de projeto diferentes → discordavam | **Uma** definição canônica: `finish_date IS NULL AND qty_to_pick > 0`, usada nas duas. Linhas vencidas ou sem `pick_date` caem na **semana atual** → soma das semanas do forecast == total do Analysis |
| **4** | Forecast subtraía `wk_avg` **e** `project_draws`, mas `wk_avg` já inclui vendas de projeto → dupla contagem | `v_wk_avg_v2` separa `wk_avg_routine = wk_avg_total − wk_avg_project`. Futuro: `outflow = wk_avg_routine + project_draws`. Projetos grandes em parcelas entram pela semana correta, sem duplicar |
| **6** | KPIs contavam só `mths_stock IS NOT NULL` → SKUs sem média (`wk_avg=0`) sumiam | `v_dashboard_kpis_v2` adiciona `skus_no_demand_data` e `skus_hidden_risk` (sem média mas com demanda de projeto aberta ou SOH≤0) |

> **#5 (Dalton/Gateway):** ignorado de propósito — é só SOH e o nosso é automático via `v_soh_live` (Cin7), não precisa das abas manuais do Excel.

**Bônus:** datas de `pick_date`/`due_date`/`week_start` são "snapadas" para o domingo da semana (alinham com `week_calendar`) — corrige um bug latente onde demanda/recebimento caíam fora de qualquer semana e sumiam.

## Objetos criados (todos novos, nada sobrescrito)

- `rapid_inv.v_wk_avg_v2` — média total / rotineira / projeto
- `rapid_inv.v_analysis_v2` — Analysis corrigida (#1, #2, #3, #6)
- `rapid_inv.v_forecast_v2` — cascata semanal corrigida (#3, #4)
- `rapid_inv.get_forecast_v2(p_supplier, p_sku_like, p_weeks)` — RPC performática (#3, #4)
- `rapid_inv.v_dashboard_kpis_v2` — KPIs sem esconder SKU em risco (#6)

## Como aplicar (quando quiser)

1. Supabase → SQL Editor → cole o conteúdo de `sql/rapid_inv_fixes_v2.sql` → Run.
2. Não afeta nada existente. Para reverter: `DROP VIEW/FUNCTION ..._v2`.

## Como validar lado-a-lado

O próprio arquivo SQL traz, no fim, 3 queries de validação:
1. Cobertura `v_analysis` (atual) × `v_analysis_v2` × compat-Excel.
2. Consistência Analysis × Forecast (deve dar **0 linhas** divergentes).
3. KPIs novos (#6).

## Ligar na UI (passo FUTURO — ainda NÃO feito)

Nada no `dashboard.html` foi tocado. Quando decidir migrar, é só apontar as consultas atuais para as `_v2`:
`v_analysis` → `v_analysis_v2`, `get_forecast` → `get_forecast_v2`, `v_dashboard_kpis` → `v_dashboard_kpis_v2`.
Sem novo botão e **sem** entrar no container planner, conforme combinado.
