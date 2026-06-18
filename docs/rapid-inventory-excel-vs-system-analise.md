# Rapid-Inventory: Análise profunda do Excel × Sistema Rapid Label + Viabilidade de migração

> Gerado em 2026-06-17 por análise multi-agente (16 agentes: 10 dissecando o Excel, 4 o sistema, 1 síntese, 1 revisão adversarial).
> Fonte: `Rapid-Inventory SKU 2025 (1).xlsx` (27 MB, 35 abas, ~179k fórmulas) × repositório `LabelsApp_Final` (branch `dev`).

---

## PARTE 1 — O que é o Excel e como cada aba funciona

O workbook é o **cérebro de planejamento de estoque, demanda e reposição** de um distribuidor de iluminação LED (Austrália). Ele transforma dados de estoque (Cin7/ERP), projetos de clientes e ordens de compra em uma **decisão de reabastecimento por SKU**, com horizonte semanal de até ~3 anos.

### 1.1 Abas-FONTE (dados de entrada)

| Aba | Tamanho | O que é | Como é gerenciada |
|---|---|---|---|
| **SOH** | 8.003 × 85 | Stock on hand por SKU: Qty on hand, Allocated, On order, Available (=Qty−Allocated), Avg/week | Export periódico/manual do Cin7 colado aqui; alimenta `Analysis!D` via VLOOKUP |
| **DALTON** / **GATEWAY** | 2.179 × 6 / 2.176 × 6 | Estoque por **filial** (2 filiais), Available por SKU | Mantidas à mão; alimentam `Analysis!N/O` via VLOOKUP |
| **Project** | **1.033.000** × 23 | Log operacional de demanda de projetos: cliente, rep, PO ref, SKU, qty, **qty held**, qty inv, **pick date**, date packed, **days held**, status | Digitação manual por vendas/CS/armazém; é a fonte de TODA a demanda de projeto |
| **Completed Projects** | 16.001 × 32 | Histórico de projetos finalizados (tem `#REF!`) | Arquivo histórico |
| **Projects** | 8.003 × 9 | Rollup do Project: Available líquido por SKU (SOH−Allocated) → `Analysis!E` | Derivada (fórmulas) |
| **PO's** | 1.458 × 14 | Ordens de compra: po#, fornecedor, sku, qty, **due date**, valor USD (qty×custo), valor AUD (USD÷FX) | Digitação manual; custo unitário congelado por linha; **FX derivou de 0,65→0,68** entre linhas |
| **WEEK SALES** | 1.059 × 7 | Extrato semanal por SKU: Qty vendida, Receita, **COGS, Profit**, Invoice | Extração manual filtrada por data (hard-coded a cada semana) |
| **WK Project** | 1.167 × 4 | Calendário semanal de demanda de projeto (sem fórmulas) | Manual |
| **BOM** | 5.764 × 117 | **Nome enganoso**: NÃO explode componentes — é um agregador de demanda de projeto por SKU acabado × 109 semanas (SUMIFS) | Derivada; duplica a lógica de "project draws" do Analysis em granularidade semanal |
| **Sheet1** | 10.913 × 78 | Registro de reconciliação de versões de SKU (-V1/-V2/-V3 → código canônico), valida contra catálogo mestre. Esparsa (1.787 fórmulas), código de erro custom "42", apoia CGD | Manual/workaround |

### 1.2 As 22 abas de FORNECEDOR (o motor de previsão replicado)

Aeon, AGC, AOK, CGD, CNEPSO, Cowin, Dolight, E-Lite, ePower, Foshan, General, Huibo, Kinglumi, LEDLUZ, Mixed, Ottima, Relight, Sealite, Senselite, Starlux, Upshine, Xtrack.

- **Template idêntico de 117 colunas** (Upshine é superset de 159 col). Cada aba é uma **cascata de inventário por SKU** ao longo de 52–156 semanas: `Closing = Opening + Incoming − Sales − Projects`, faseada por uma **curva de demanda sazonal manual** na Row 2 (ex.: CNY = 0 / blackout, 0,6–0,8 nas rampas pré/pós-Ano Novo Chinês).
- O `Analysis` puxa o **Wk/Avg** de cada fornecedor via `INDEX/MATCH(Fornecedor!B:B, ..., +3)`.
- **Fragilidade altíssima**: 11 abas têm `#REF!`; CGD tem **208 mil fórmulas** com links a workbooks externos `[2]/[3]/[6]` e dependências cruzadas; typos de copy-paste (`PROEJCT`). Manter 22 abas paralelas à mão é o maior risco de corrupção do arquivo.

### 1.3 Abas-CÉREBRO (consolidação e decisão)

**`Analysis`** (1.990 SKUs, 25.703 fórmulas) — o hub. Por SKU:
| Col | Conteúdo | Fórmula |
|---|---|---|
| B | Wk/Avg (velocidade semanal) | `INDEX(Fornecedor!B:B, MATCH(...)+3)` |
| C | Mth Avg (mensal anualizado) | `=B*52/12` |
| D | SOH Available | `VLOOKUP(sku, SOH!A:K, 5)` |
| E | Project Orders (compromisso líquido, pode ser **negativo** = overalloc) | `VLOOKUP(sku, Projects!A:I, 9)` |
| **F** | **Meses de cobertura (decisão)** | `=IF(D>0, (D+E)/C, "")` — **<1 = reordenar; negativo = ruptura aguda** |
| G | Comentários livres | manual |
| H–J… | **Project Draws** por semana | `SUMIFS(Project!J, Project!L=semana, Project!F=sku)` |
| K–M… | **Incoming Shipments** (POs) por semana | `SUMIFS(PO!E, PO!H=semana, PO!D=sku)` |
| N / O | SOH filial Dalton / Gateway | `IFNA(VLOOKUP(sku, DALTON!A:F, 6),0)` |

**`Stock Value`** (140 × 192) — projeção financeira de **capital de giro em AUD por semana por ~3,5 anos**: `Closing $ = Opening + custo landed das POs (SUMIFS) − COGS`. Tem cenários **Forecast vs Actual**, **margem de variância (Row 16)**, **metas de estoque ideal/política (Row 17)** e um **2º mecanismo sazonal** (Row 10 = % de venda do mês para distribuir COGS). ⚠️ Mostra saldos negativos de **−14M a −15M AUD** em períodos distantes = **extrapolação quebrada**, não funcionalidade.

---

## PARTE 2 — Fluxo de dados ponta-a-ponta do Excel

```
Cin7/ERP (export manual) → SOH + DALTON/GATEWAY
Vendas/projetos (digitação manual) → Project (1.03M linhas) → Projects (rollup) → Analysis!E
POs (digitação manual) → PO's → Analysis!K-M (incoming) + Stock Value (custo landed)
22 abas Fornecedor (Wk/Avg + curva sazonal) → Analysis!B (INDEX/MATCH)
        ↓
  Analysis: Meses de cobertura F=(D+E)/C  → decisão de reordenar (olho humano)
        ↓
  Quantidade de reposição às filiais = CALCULADA MANUALMENTE FORA do modelo
        ↓
  Stock Value: mesma base → projeção financeira AUD 3,5 anos (Forecast vs Actual)
```

Pontos cruciais do modelo:
- **Potente mas frágil**: headers de semana hard-coded e avançados à mão; sem trilha de auditoria; sem regra de safety-stock obrigatória; quantidade de reposição feita fora do Excel.
- A decisão final é **julgamento humano** olhando F vermelho/negativo.

---

## PARTE 3 — O sistema Rapid Label hoje

Node.js + Express + **Supabase (Postgres)**, integrado ao **Cin7 Core** via `cin7-stock-sync`. Frontend vanilla JS/HTML.

**Já construído (estrutura do Excel replicada em SQL):**
- **`cin7_mirror`** (dados vivos do Cin7): `products` (7.903, sync 30 min), `stock_snapshot` (18.108 linhas, 1–2 h), `locations` (diário), `order_pipeline` (2–4 h), webhooks near-real-time, `stock_movements` + `movement_alerts` (detecção de anomalia — **net-new, não existe no Excel**).
- **`rapid_inv`** (schema isolado): tabelas `suppliers, warehouses, skus, project_lines, po_lines, soh_snapshot, weekly_sales, week_calendar (até 2030), sku_settings, audit_log`.
- **Views**: `v_skus_live`, `v_soh_live/v_soh_main`, `v_wk_avg` (fallback 3 camadas), `v_analysis` (replica Analysis B–F), `v_forecast`/`get_forecast()` RPC (replica a cascata semanal das 22 abas como **uma window function** sobre calendário de 365 semanas auto-rolante).
- **Feature Replenishment** (produção): planejamento automático de transferências multi-filial — ABC (A=10/B=8/C=6 sem), safety 8 sem no Main, +5d lead-time, arredondamento de caixa, resolução proporcional de conflito, bloqueio por sync velho. **Supera o Excel** (que nunca teve reposição como feature de primeira classe).
- **Audit log universal (JSONB)** — fecha a maior lacuna de controle do Excel.

**Status real (o gargalo é DADO, não lógica):** as 3 tabelas de entrada da previsão — `weekly_sales`, `project_lines`, `po_lines` — estão **VAZIAS**.
- **Phase A** (sync de vendas → `weekly_sales`/Wk-Avg ao vivo): **BLOQUEADA** por um `GRANT` de service_role + dry-run.
- **Phase B** (sync de PO `/purchaseList` → `po_lines`): não construída (~2–3 h).
- **Phase C** (sync de linhas de projeto + UI de edição): não construída (2–3 dias).
- **Phase D** (importador do Excel legado): não construída (~4 h).
- Autenticação ainda é **PIN 4209** hard-coded (segurança 3/10 no plano interno).

---

## PARTE 4 — Matriz de viabilidade (capacidade por capacidade)

Legenda status: ✅ existe · 🟡 parcial · ⛔ falta · Esforço S/M/L/XL · Prioridade Must/Should/Could.

| # | Capacidade (Excel) | Status sistema | Dado? | Viável | Esforço | Prio | Veredito curto |
|---|---|---|---|---|---|---|---|
| 1 | **Meses de cobertura / gatilho de reorder** (F) | 🟡 existe c/ ressalva | parcial | Alta | S | Must | Fórmula **NÃO é idêntica** (ver Parte 6); falta `project_lines` |
| 2 | Wk/Avg (demanda semanal/SKU) | 🟡 parcial | parcial | Alta | M | Must | `v_wk_avg` 3-camadas; melhor que Excel só após Phase A |
| 3 | Mth Avg (mensal anualizado) | ✅ existe | sim | Alta | S | Must | `v_analysis` calcula igual. Pronto |
| 4 | SOH / Available | ✅ existe (superior) | sim | Alta | S | Must | Cin7 vivo 1–2 h substitui a aba SOH (mas `soh_snapshot` local vazio — usa `v_soh_main`) |
| 5 | **Compromisso líquido de projeto / overalloc** (E) | ⛔ falta | parcial | Média | L | Must | `project_lines` vazio → overalloc invisível. **Maior lacuna** |
| 6 | Project draws por semana (H–J) | 🟡 parcial | parcial | Alta | M | Must | Lógica pronta (`project_by_week`); zera sem `project_lines` |
| 7 | Incoming shipments / POs por semana (K–M) | 🟡 parcial | parcial | Alta | M | Must | Pronto; falta Phase B (`/purchaseList`) |
| 8 | Projeção de saldo futuro (cascata Opening+In−Out) | ✅ existe | parcial | Alta | M | Must | Window function substitui as 22 abas; usar Wk-Avg **plano** (sem sazonal) |
| 9 | Estoque por filial (Dalton/Gateway) | ✅ existe (superset) | sim | Alta | S | Must | ⚠️ mas as 8 filiais do sistema **não incluem Dalton/Gateway** (Parte 6) |
| 10 | **Reposição/transferência multi-filial** | ✅ existe (superior) | sim | Alta | S | Must | Feature mais forte; Excel fazia à mão |
| 11 | Histórico de vendas semanal (WEEK SALES) | 🟡 parcial | sim | Alta | M | Should | Script pronto; falta Phase A; **COGS/Profit não populados** |
| 12 | Consolidação multi-fornecedor (22 abas) | ✅ existe (superior) | sim | Alta | S | Should | 1 RPC `get_forecast(p_supplier)` substitui 22 abas frágeis |
| 13 | **Curva de demanda sazonal** (Row 2) | ⛔ falta | parcial | Média | L | Should | Forecast usa média **plana**; lacuna real de modelagem |
| 14 | **Valorização financeira / fluxo de caixa** (Stock Value) | ⛔ falta | parcial | Média | XL | Could | Adiar; depende de COGS + sazonal + custo landed |
| 15 | Alocação & fulfilment de projeto (linha) | 🟡 parcial | parcial | Média | L | Should | Schema pronto; falta UI editável + Phase C/D |
| 16 | Registro de PO + FX/payables | 🟡 parcial | sim | Alta | M | Should | Phase B popula; centralizar FX corrige drift 0,65→0,68 |
| 17 | Reconciliação de versão de SKU (Sheet1) | 🟡 parcial | sim | Média | M | Could | `products` é o mestre; replenishment já filtra -V1 |
| 18 | "BOM" (na verdade agregador de demanda) | ✅ existe | parcial | Alta | S | Could | `get_forecast()` já cobre; **NÃO** construir explosão de componente |
| 19 | Comentários/flags/thresholds manuais (G) | ✅ existe (superior) | sim | Alta | S | Should | `sku_settings` + audit; falta edição inline na grade |
| 20 | Trilha de auditoria | ✅ existe (net-new) | sim | Alta | S | Should | JSONB triggers — Excel não tinha |
| 21 | Safety-stock/ROP por lead-time (fornecedor) | 🟡 parcial | sim | Alta | M | Should | Branch pronto; falta ROP de reorder de PO ao fornecedor |

### Capacidades ESQUECIDAS pela 1ª síntese (achadas pelo revisor) — também viáveis:
- **22b. Fase sazonal de COGS no Stock Value (Row 10)** — 2º mecanismo sazonal, distinto da Row 2. Necessário para a engine financeira.
- **23. Aging de alocação / Days Held / Date Packed** — latência de fulfilment (SLA, ciclo de caixa). `v_project_lines` calcula `days_held` mas nenhuma UI mostra. Subestimado.
- **24. Coluna On-Order na cobertura** — o Excel inclui On-Order no numerador de weeks-of-cover; `v_analysis` usa só SOH disponível. Diferença de definição (dado existe em `stock_snapshot`).
- **25. Forecast-vs-Actual variance (Row 16) + metas de estoque ideal (Row 17)** — capacidades analíticas independentes, entregáveis **sem** a engine financeira completa.
- **26. Lead-time empírico por fornecedor (Due Date − PO Date)** — o Excel tem o lead-time realizado por PO; o sistema usa default fixo de 12 semanas. Oportunidade ao popular `po_lines`.
- **27. Detecção de anomalia de movimento (`movement_alerts`, 5 regras)** — **net-new do sistema, sem análogo no Excel**.

---

## PARTE 5 — O que NÃO é viável (e por quê)

1. **BOM de explosão de componente** — a aba "BOM" é nome enganoso; nunca explodiu componentes (só agrega demanda por SKU). Não há relação pai/componente nem no Excel nem no Cin7. Construir isso seria inventar capacidade que o negócio nunca modelou.
2. **Port fiel da extrapolação do Stock Value** — os saldos −14M/−15M AUD são **bug** de extrapolação, não feature. Portar fielmente replicaria o erro. A valorização deve ser construída do zero sobre fluxos reais.
3. **`#REF!` / links externos / dependências cruzadas das 22 abas** — são artefatos de corrupção. Já substituídos por 1 RPC paramétrico; nada a migrar.
4. **Captura 100% automática de pick-date / qty-held de projeto** — Cin7 não tem conceito de "projeto/pick date/qty held"; eram entradas manuais (julgamento humano). Máximo viável: derivação parcial de linhas de SO (Phase C) + **UI de edição**. Automação total é impossível aqui.
5. **Curva sazonal como "port de fórmula"** — a Row 2 era julgamento manual curado, não derivado de dado. Pode ser **reimplementada** (média viabilidade) re-inserindo os fatores ou acumulando 2+ anos de `weekly_sales` — não é migração mecânica.

---

## PARTE 6 — ⚠️ Correções críticas do revisor adversarial (leia antes de decidir)

A primeira síntese exagerou "paridade exata". Pontos que mudam decisões:

1. **A fórmula de meses-de-cobertura NÃO é idêntica ao Excel.**
   - Excel: `F = (D + E)/C`, onde `E = Projects!I = (SOH − Allocated)`, frequentemente **negativo e SOMADO**.
   - Sistema (`rapid_inv_setup.sql` L346-350): `(SOH − project_orders)/(wk_avg*52/12)`, onde `project_orders = SUM(qty_to_pick)` de linhas de projeto abertas (`finish_date IS NULL`) — **quantidade e fonte diferentes**. A própria síntese se contradiz (escreve ora com `+`, ora com `−`). → Validar a definição antes de confiar em "paridade".

2. **Os thresholds de alerta são diferentes.** Excel: `<1 mês` = reordenar. Sistema: `threshold_red=2,5` / `threshold_yel=4` meses (defaults). Marca crítico abaixo de 2,5 — muda **quais/quantos** SKUs são sinalizados. Nunca foi divulgado como divergência.

3. **Inconsistência interna Analysis × Forecast.** `v_analysis` filtra `project_lines` por `finish_date IS NULL` (sem checar status); `v_forecast` exige também `pick_date IS NOT NULL`. Uma linha sem pick_date entra na cobertura (col E) mas **não** no forecast semanal → as duas telas vão **discordar** quando os dados entrarem.

4. **Risco de dupla contagem no forecast.** Semanas futuras subtraem **wk_avg E project_draws**, mas wk_avg já inclui as vendas históricas dirigidas por projeto → demanda de projeto contada 2×. O Excel separava Sales (Row 9) de Project Orders (Row 10); o wk_avg do sistema não separa.

5. **"Auto-computar médias a partir de vendas" está BLOQUEADO por dado**, não é um simples M. `order_pipeline` só tem localização no nível da ordem, **não por linha** → média por filial×SKU exige decompor linha-a-linha com localização (indisponível) ou buscar `/sale/{ID}` de cada SO (não implementado).

6. **As filiais não batem.** Excel = **DALTON & GATEWAY**. Replenishment cobre 8 filiais (SYD,MEL,BNE,CNS,CFS,HBA,SCS + MAIN) que **não incluem Dalton/Gateway**. `rapid_inv.warehouses` está semeado só com MAIN/DALTON/GATEWAY; docs citam Main/Sydney/Melbourne/Brisbane/Adelaide. **Reconciliar o mapa de filiais** antes de afirmar "superset".

7. **`branch_avg_monthly_sales` tem cobertura furada** (3.271 linhas, só 797 de Sydney). Como é a camada 3 do wk_avg até a Phase A, SKUs sem média → `wk_avg=0` → `mths_stock NULL` → **excluídos da contagem de críticos** → **esconde silenciosamente SKUs em risco**.

8. **`soh_snapshot` local está VAZIO** — o caminho vivo cai em `v_soh_main` (Cin7). Qualquer lógica que espere histórico de snapshot retorna nada.

9. **Performance/escala**: `get_forecast` faz CROSS JOIN skus × 365 semanas (~2,9M linhas antes de filtrar) e a UI tem **cap de 80 SKUs** — não dá paridade com a grade de 1.990 SKUs do Excel sem ajuste.

10. **Segurança/operação**: PIN 4209 hard-coded; `EXCLUDED_SKUS` é lista fixa de 200+ (novos -V1 passam batido até editar código); override de ABC só em localStorage (perde no login).

---

## PARTE 7 — Plano recomendado (sequência)

**Resumo:** o sistema já está ~80% do caminho e, no que cobre, é **melhor** que o Excel (dado vivo, calendário auto-rolante, 1 RPC no lugar de 22 abas frágeis, auditoria, reposição automática). O bloqueio é **dado**, não lógica. Mas **antes** valide as divergências da Parte 6 (fórmula, thresholds, filiais).

**Quick wins (dias):**
1. **Desbloquear Phase A**: rodar `sql/rapid_inv_service_role_grants.sql`, `npm run rapid-inv:sync:sales:test`, depois o full sync (~25 min). Liga Wk/Avg ao vivo (13 sem) + WEEK SALES.
2. Agendar o sync de vendas como cron diário (`0 3 * * *`).
3. **Phase B** (PO sync `/purchaseList` → `po_lines`, ~2–3 h) → liga Incoming + KPI de pipeline AUD.
4. **Phase D** importador do Excel (~4 h): carregar ~4.500 linhas de projeto + ~1.396 POs legados → paridade imediata de Analysis/Forecast.
5. Badge "primeira semana de ruptura / reordenar até" a partir do `projected_balance` cruzando zero (S).
6. Edição inline de `sku_settings` (comentários/thresholds) na grade (S).
7. Colunas de SOH por filial estilo Dalton/Gateway na grade (S).

**Médio prazo:** Phase C (sync de linha de projeto + UI editável, 2–3 dias); ROP por lead-time ao fornecedor; lead-time empírico (Due−PO); variance Forecast-vs-Actual + metas de estoque ideal.

**Adiar:** sazonalidade (L, média viabilidade — precisa dos fatores curados ou 2+ anos de histórico); engine financeira do Stock Value (XL — depende de COGS + sazonal + custo landed).

**Não construir:** BOM de explosão de componente; port fiel da extrapolação quebrada do Stock Value.

**Corrigir antes de confiar nos números:** definição da fórmula F (Parte 6.1), thresholds (6.2), consistência Analysis×Forecast (6.3), dupla contagem (6.4), mapa de filiais (6.6), supressão de NULL nos KPIs (6.7).
