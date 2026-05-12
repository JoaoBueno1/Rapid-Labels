# Rapid Inventory SKU — Status do desenvolvimento

> **Snapshot:** 2026-05-12
> **Branch:** `dev`
> **Onde parou:** Fase A da automação Cin7 → falta rodar `sql/rapid_inv_service_role_grants.sql` no Supabase e rodar `npm run rapid-inv:sync:sales:test`.

---

## O que é

Módulo novo dentro do app Labels que substitui o Excel `Rapid-Inventory SKU 2025.xlsx`
(27 MB, 35 sheets, ~179k fórmulas) por um dashboard web rodando em Vercel/Supabase
com dados ao vivo do Cin7.

**Acesso:** Home → card amarelo *Quality & Compliance* → PIN `4209` → botão **Rapid Inventory**.

**URL:** `features/rapid-inventory/dashboard.html`.

---

## Arquitetura

- **Schema isolado** no Supabase: `rapid_inv` (não toca em nenhuma tabela existente).
- **Read-only** sobre o que já existe em `cin7_mirror.*` e `public.branch_avg_monthly_sales`.
- **Escrita** apenas em `rapid_inv.*` (tabelas próprias).

```
Cin7 Core API
   │
   ▼  (cin7-stock-sync — já rodando 2h/dia)
cin7_mirror.products       (7.903 SKUs)
cin7_mirror.stock_snapshot (18.108 rows SOH)
cin7_mirror.order_pipeline (SO headers)
public.branch_avg_monthly_sales
   │
   ▼  (views read-only)
rapid_inv.v_skus_live
rapid_inv.v_soh_live      / v_soh_main
rapid_inv.v_wk_avg_live   / v_wk_avg
rapid_inv.v_analysis
rapid_inv.v_open_sos
rapid_inv.v_dashboard_kpis
rapid_inv.v_forecast       / v_forecast_suppliers
   │
   ▼  (RPC com filtros empurrados — perf)
rapid_inv.get_forecast(p_supplier, p_sku_like, p_weeks)
   │
   ▼  (frontend)
features/rapid-inventory/dashboard.html
```

---

## Estado de cada parte

| Componente | Estado | Observação |
|---|:---:|---|
| Schema `rapid_inv` (10 tabelas) | ✅ pronto | `sql/rapid_inv_setup.sql` (rodado) |
| Views live conectadas ao Cin7 | ✅ pronto | `sql/rapid_inv_live_views.sql` (rodado) |
| Forecast view + suppliers | ✅ pronto | `sql/rapid_inv_forecast_view.sql` (rodado) |
| Forecast RPC (performance) | ✅ pronto | `sql/rapid_inv_forecast_rpc.sql` (rodado) |
| Dashboard com 9 módulos | ✅ pronto | KPIs + SKUs + Stock Live + Open SOs + Analysis + Forecast |
| Forecast 5-linhas por SKU (Excel-like) | ✅ pronto | Opening / Incoming / Outgoing / Project Draws / Balance |
| Bot�o "Rapid Inventory" no index.html | ✅ pronto | Dentro do card *Quality & Compliance* (PIN 4209) |
| Fase A — Sales históricos sync | ⏳ **travado** | Faltam 2 passos (abaixo) |
| Fase B — POs sync | ⏸️ pendente | Aguarda Fase A |
| Fase C — Project Lines sync | ⏸️ pendente | Aguarda Fase A |
| Fase D — Importer Excel | ⏸️ pendente | Atalho alternativo se quiser dados manuais antes |

---

## Onde voltar (próximos passos exatos)

### 1) Rodar GRANT do `service_role` (1 SQL único)

Abre Supabase Dashboard → SQL Editor → cola e roda:

```
sql/rapid_inv_service_role_grants.sql
```

Vai aparecer `NOTICE: service_role agora tem acesso a rapid_inv ✅`.

**Por quê:** o script Node usa a `SUPABASE_SERVICE_KEY` (role `service_role`).
O Supabase só dá acesso automático ao schema `public` — para schemas custom
(`rapid_inv`) precisa de `GRANT USAGE` explícito. Erro pego no último teste:
`permission denied for schema rapid_inv`.

### 2) Rodar o teste dry-run (5 SOs, sem escrever)

```bash
cd "/Users/joaomarcos/Desktop/untitled folder/LabelsApp_Final"
npm run rapid-inv:sync:sales:test
```

**O que esperar:**
- `→ found 701 SOs in window`
- `To process: 5`
- 5 linhas tipo `SO-XXXXXX: N lines, total qty NN`
- Termina sem erros

### 3) Se OK, rodar sync real (~14 min)

```bash
npm run rapid-inv:sync:sales
```

Pode rodar em background:

```bash
nohup npm run rapid-inv:sync:sales > /tmp/rapid-inv-sales.log 2>&1 &
tail -f /tmp/rapid-inv-sales.log
```

### 4) Validar no dashboard

Recarrega `features/rapid-inventory/dashboard.html` → abre **Forecast 2030** →
escolhe um supplier → vê as **semanas passadas com dados reais** (Outgoing
não-zero, balance variando).

Query de validação no SQL Editor:

```sql
SELECT * FROM rapid_inv.v_sales_sync_status;
-- processed_sos > 0, weekly_sales_rows > 100 ✓
```

### 5) Agendar cron (após validar)

```cron
0 3 * * * cd "/Users/joaomarcos/Desktop/untitled folder/LabelsApp_Final" && /usr/local/bin/node cin7-stock-sync/sync-rapid-inv-sales.js >> /tmp/rapid-inv-sales.log 2>&1
```

Runs subsequentes: ~1 min (só novos SOs por causa do cache).

---

## Como continuar Fases B/C/D depois

Mesma estrutura da Fase A:
- **Fase B (PO sync):** `cin7-stock-sync/sync-rapid-inv-pos.js` puxando `/purchaseList` → popula `rapid_inv.po_lines`. ~2-3h de trabalho.
- **Fase C (Project Lines):** mesmo padrão, puxa linhas de SOs abertos (`/sale/{id}`). Esses sim ficam editáveis pra qty_held/pick_date. ~2-3 dias.
- **Fase D (Importer Excel):** drag-and-drop no dashboard pra subir as 4.500 linhas de Project + 1.396 de POs do Excel antigo. ~4h. Atalho rápido se quiser tudo populado HOJE.

---

## Arquivos novos criados

```
sql/
├── rapid_inv_setup.sql              ── 10 tabelas + funções (RODADO)
├── rapid_inv_live_views.sql         ── views live Cin7 (RODADO)
├── rapid_inv_forecast_view.sql      ── v_forecast + suppliers (RODADO)
├── rapid_inv_forecast_rpc.sql       ── RPC get_forecast (RODADO)
├── rapid_inv_phase_a_sales.sql      ── cache + view status (RODADO)
└── rapid_inv_service_role_grants.sql ── GRANT pra service_role (FALTA RODAR)

features/rapid-inventory/
└── dashboard.html                   ── SPA com 9 módulos

cin7-stock-sync/
└── sync-rapid-inv-sales.js          ── Node script standalone

index.html                           ── + botão Rapid Inventory
package.json                         ── + 2 scripts npm
```

---

## Decisões importantes tomadas

- **PIN próprio do Rapid Inventory removido** → acesso protegido pelo PIN 4209 já existente do card *Quality & Compliance*.
- **Tudo via views** quando o dado já existe ao vivo (SOH, SKUs, Wk/Avg). Tabelas `rapid_inv.*` só para dados operacionais novos (project_lines, po_lines, sku_settings, audit_log).
- **Range até 2030-12-29** no `week_calendar` — diferencial sobre o Excel que termina em 2028.
- **Forecast com layout Excel-like 5 linhas por SKU** (Opening / Incoming / Outgoing / Project / Balance) — para o time se sentir em casa.
- **RPC `get_forecast` em vez de filtros na view** — empurra os filtros pra dentro das CTEs, reduz de 3M para 1k linhas, evita timeout 500.

---

## Diagnóstico para conferir o estado a qualquer momento

```sql
-- O que está populado em rapid_inv?
SELECT * FROM rapid_inv.v_sales_sync_status;
SELECT * FROM rapid_inv.v_dashboard_kpis;

-- Suppliers disponíveis no dropdown do Forecast
SELECT * FROM rapid_inv.v_forecast_suppliers ORDER BY sku_count DESC LIMIT 30;

-- Quantos SOs estão completados no mirror (alimenta a sync de Fase A)
SELECT COUNT(*) FROM cin7_mirror.order_pipeline
 WHERE type='SO' AND status IN ('COMPLETED','CLOSED');
```
