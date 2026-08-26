# Branch Replenishment — End-to-End Build Plan

> **Meta:** replicar o processo de replenishment do Excel **inteiro** dentro de `features/replenishment/`,
> automatizado, seguindo **fielmente o design do Stock Planner** (`features/stock-planning/`).
> Painel de branches+datas → grid line-by-line igual ao Excel → **suggestions/cover** → approve/reject
> por linha → **place order** (cria transfer no Cin7) → imprime o **template Transfer Out** que já temos →
> **timeline** de estados (ready to check → awaiting check → approval → sent) → **log + snapshots semanais
> imutáveis** consultáveis por TR/data, imprimíveis, expand/collapse.

- **Status:** planejamento — nada construído ainda. Baseado em análise multi-agente (3 facetas verificadas contra dado vivo, 27/08/2026).
- **Onde:** `features/replenishment/` (novo app, layout do stock-planning: `db/ lib/ routes/ ui/ tests/ scripts/`). **dev**, com cuidado, sem quebrar o fluxo existente.
- **Regra de ouro:** não reinventar. A engine, a escrita Cin7, o print e os dados **já existem** — isto é UI + orquestração.

---

## 1. A grande vantagem — quase tudo já existe (mapa de reuso)

| Peça | Já existe em | Como usar |
|---|---|---|
| **Engine de suggestion/cover** | `features/replenishment/replenishment-config.js` (ABC A=10/B=8/C=6 sem, `WEEKS_IN_MONTH=4.345`, carton round-up, min-send=3, `MAIN_MIN_WEEKS=8`, `isExcludedProduct()`, `pickAvg()`) + SQL RPC `public.excel_restock_suggestion` | **importar**, não copiar; embrulhar num `lib/replenishment-engine.js` puro/testável |
| **Escrita de transfer no Cin7** | `features/wms/lib/cin7-wms-client.js` (`createTransfer` DRAFT → `dispatchTransfer` IN TRANSIT) + `wms-transfers.js` (outbox exactly-once, DRAFT-checkpoint crash-safe) | **place order** roda por aqui, server-side, chave Cin7 nunca no browser |
| **Template de print** | `features/transfer-out/` (`TOStaging.open({id:TaskID,...})` + `transfer_out_print.html`) | após criar o TR, chama `TOStaging.open` — **zero print novo** |
| **SOH por armazém** | `cin7_mirror.stock_snapshot` (15.339 linhas, `location_name` por branch+bin, `available`, `in_transit`, `next_delivery_date`) | fonte viva de SOH/Main/Sydney/in-transit |
| **Médias por branch** | `public.branch_avg_monthly_sales` (4.644 linhas, `avg_mth_*` e `avg_rep_*` por branch) | ler direto; **não recalcular** |
| **Colunas estáticas** | `cin7_mirror.products` (`sku`=Rapid Code, `attribute1`=5DC, `name`, `stock_locator`=pickbay, `carton_quantity`) | join por Rapid Code |
| **Persistência** | `public.transfer_plans` + `transfer_plan_lines` (já com `approved_qty`, `status`, `notes`, campos `*_frozen`) | **estender**, não recriar |
| **Design/arquitetura** | `features/stock-planning/` + `shared/ui.css` + `shared/rail.js` (já tem o item **"Branch Replenishment"** no menu!) | replicar tokens, componentes, rotas, DB conventions |

---

## 2. Modelo de dados — cada coluna → fonte (verificado)

**Order form (grid principal):**
| Coluna | Fonte |
|---|---|
| SKU (5DC) | `products.attribute1` |
| Rapid Code | `products.sku` (chave de join) |
| Product | `products.name` |
| Ctn Qty | `products.carton_quantity` |
| **QTY** (input) | usuário → `transfer_plan_lines.approved_qty` |
| SENT | **decisão D1** — do nosso transfer colocado (ou `stock_movements` stock_transfer Main→branch) |
| Location | `products.stock_locator` |
| Mthly Avg | `branch_avg_monthly_sales.avg_rep_<branch>` (REP) ou `avg_mth_<branch>` |
| Current Month Sales | `SUM(stock_movements.quantity)` WHERE `movement_type='sales_ship'` AND `from_location=<branch>` (mês atual). **NÃO usar `sales_orders.location_name`** (33%+ null) |
| SOH (branch) | `SUM(stock_snapshot.available)` WHERE `location_name=<branch>` |
| Total Mths Stock (cover) | **computado**: `(SOH + QTY) / Mthly Avg` |
| Main stock | `SUM(stock_snapshot.available)` WHERE `location_name='Main Warehouse'` |
| **SYD Stock** *(só MEL/HBA)* | `SUM(stock_snapshot.available)` WHERE `location_name='Sydney'` |
| **Mthly Avg REP** *(só Sydney)* | `branch_avg_monthly_sales.avg_rep_sydney` |
| Comments (razão da branch) | usuário → `transfer_plan_lines.notes` |
| Inventory Comments (nosso feedback) | usuário → **nova coluna** `transfer_plan_lines.inventory_notes` |

**Restock Suggestion:** `Suggested qty` (engine) · `Available now` (`SOH − allocated`, pode ser **negativo**) · `Avg/month` · `Main+Gateway` (`location_name IN ('Main Warehouse','Gateway')`).

**Regra do amarelo (fiel ao Excel):** pintar a linha quando `(SOH+QTY)/Mthly Avg > 1.5 meses (6 semanas)`. **Só visual — nunca bloqueia** (branch pode over-order com Comment/SO).

---

## 3. As regras (a engine — não reinventar)

- `avg_branch = COALESCE(NULLIF(avg_rep_<branch>,0), avg_mth_<branch>)` — REP ganha do WHS.
- **ABC por rank de demanda de rede:** top 20% → A=10 sem · próx 30% → B=8 · resto → C=6.
- `target = CEIL(avg_branch / 4.345 * weeks)`; `suggested_qty = CEIL(GREATEST(0, target − branch_available))`.
- **Corte (filtro do que sugerir):** `avg_branch>0 AND main_avail>0 AND in_transit=0 AND cover_days<25 AND suggested_qty>0`, ordenado por `cover_days ASC, suggested_qty DESC`.
  - ⚠️ **D5:** o texto do Excel diz "cover under 21 days" mas o SQL corta em **25** (calibração real de 20/08). Usar **um** constante e o UI lê dela.
- **Suggested qty do tab ≠ qty a enviar:** o tab é só o "target gap". O número real de envio (com `MAIN_MIN_WEEKS=8` de segurança, carton rounding, min-send, conflito entre branches) vem da `replenishment-config.js`. **D6:** mostrar `send_qty` da engine como o número acionável (e o gap cru ao lado).
- **Exclusões:** blocklist ~50 SKUs + regex (`carton`, `-v1`/`_v1`, "per 6 m"/"/m").

---

## 4. UI — telas (fiel ao Stock Planner)

Reusar `shared/ui.css` + `shared/rail.css` **as-is** (link, não fork); copiar o bloco de tokens de `planning.css:22-74` **verbatim** (shell + `--xl-*` das cores do Excel — a legenda que o time já conhece). Fonte IBM Plex Sans/Mono. Grid dentro de `.sp-scroll` com scroll horizontal (15+ colunas).

1. **Landing (painel branches + datas)** — padrão `Overview`: `.sp-tiles` de `.sp-tile` (um por branch, borda vermelha/âmbar se cover urgente) + `.sp-panel` listando as datas/ciclos. Clica → abre o grid.
2. **Grid line-by-line** — `table.sp-grid` dirigido por array de colunas (`[key,label,cls,width,render]`), com **todas** as colunas do Excel. Colunas variantes por branch (SYD Stock só MEL/HBA; Mthly Avg REP só Sydney) por feature-flag. `.sp-cell` contenteditable pro QTY (input branco), estados de save `.busy/.ok/.bad`. **Amarelo** = classe condicional única.
   - **Approve/Reject por linha:** `.ui-act--ok` (approve) / `.ui-act--danger` (reject). Reject **empurra a linha pra baixo** (reordena o array + re-render, igual Excel).
   - **Free-text lines** (sem SKU: "notepads", "3 long items with Cody", "1 Pallet"): linha só com Product+QTY+Comments; place-order **pula/parqueia** essas (pick manual), não rejeita a ordem.
   - **Sydney re-route (MEL/HBA):** coluna extra `SYD Stock` + escolha de **source por linha** (Main vs Sydney), default Main, vira Sydney só por ação humana. **Sem auto-routing.**
3. **Suggestions form** (botão) — `.sp-modal` com perguntas em botões (`.sp-chip`): usar cover configurado, ou digitar/buscar produtos (`.sp-results`). Puxa da engine.
4. **Place order** — `.sp-modal` de confirmação → cria o TR no Cin7 (via outbox) → `TOStaging.open(...)` imprime o template.
5. **Timeline + log** — `.sp-side` com a `.brk` table lendo o `plan_status_events` + `audit_log`.
6. **Snapshots** — lista consultável por TR/data, expand/collapse, imprimível pelo mesmo TOStaging.

---

## 5. DB — tabelas novas (convenções do stock-planning)

Schema próprio do módulo, migrations numeradas em `features/replenishment/db/` começando por `000_grants.sql` (senão dá `42501` como o rapid_inv deu). Convenções: `BIGSERIAL PK`, `created_at/updated_at TIMESTAMPTZ`, `updated_by`, enums via `CHECK`, `sku_key GENERATED ALWAYS AS (upper(btrim(sku)))`, triggers `fn_touch_updated_at` + `fn_audit_log`, views `v_rep_*`, `import_batches`.

- `replenishment_cycle` — header por (branch, semana): `status` CHECK (`draft → ready_to_check → awaiting_check → approved → sent → closed`), datas, actor. (padrão `planning_state`/`projects`.)
- `replenishment_line` — linhas: rapid_code, sku, qty, sent, source(`main`/`sydney`), line_status(`pending`/`approved`/`rejected`), notes(razão), inventory_notes(feedback), + campos **frozen** (branch_avail, main_avail, avg, cover no momento da geração).
- `replenishment_snapshot` — cópia **imutável** das linhas por (branch, snapshot_date, sku) — o histórico semanal.
- `replenishment_status_event` — append-only (cycle_id, from_status, to_status, actor, note, at) — a **timeline** cross-city.
- `import_batches` — pros imports de avg/workbook.

Escrita **sempre via rotas server-side** (service key) — **não** deixar o browser escrever (RLS hoje é allow-all → spoofável).

---

## 6. API — rotas (`/api/replenishment`, padrão stock-planning)

`register(app)` + `wrap()`/`actorOf(x-sp-user)`/`asInt()`; math server-side. Aproximado:
- `GET /branches` · `GET /branches/:code/cycles`
- `GET /cycles/:id/lines` · `PATCH /lines/:id` (qty/approve/reject/comment/source)
- `POST /cycles/:id/suggestions` (roda a engine) · `POST /cycles/:id/lines` (add manual/free-text)
- `POST /cycles/:id/place-order` (Cin7 transfer via outbox → devolve TaskID/Number pro TOStaging)
- `POST /cycles/:id/status` (avança a timeline) · `GET /cycles/:id/timeline` · `GET /audit`
- `GET /snapshots` / `GET /snapshots/:id` · `POST /avgs/refresh` (roda os importers existentes)

---

## 7. Casos especiais + riscos (atenção)

- **ProductID pro Cin7:** transfer lines pedem **ProductID (GUID Cin7)**, não SKU. `products.id` pode ser surrogate do mirror → **verificar antes de place-order**; fallback: resolver por SKU via `cin7-wms-client.getProduct`/`/product?Sku=` e cachear.
- **Melbourne pendura sob "Ghost"** (`parent_id != null`): mapear **sempre** por `rapid_inv.warehouses.cin7_location_name`, nunca por `parent_id IS NULL`.
- **Filtrar SOH** a branches/hubs (Project Warehouse tem `available=-168.735` → distorce).
- **Available negativo** é normal (branch oversold) — não validar como ≥0.
- **7 branches**, não 4: Sydney, Melbourne, Brisbane, Cairns, Coffs Harbour, Hobart, Sunshine Coast. **D3:** replicar os 4 primeiro, mas modelar os 7.
- **Não correr com o excel-sync** existente (Power Query/`_Sync`) — não duplicar escrita.
- **Cin7 rate-limit** (chave compartilhada) — serializar place-order pelo outbox, esperar retries.

---

## 8. Decisões a confirmar

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Fonte do **SENT** | do nosso transfer colocado (approved→sent) + reconciliar com `stock_movements` |
| D2 | SOH canônico | **`cin7_mirror.stock_snapshot` (vivo)**, não o snapshot manual |
| D3 | Escopo | modelar os **7 branches**, testar com os 4 do Excel |
| D5 | Corte de cover | **25 dias** (SQL real), UI lê da constante |
| D6 | Número mostrado | `send_qty` da engine (com segurança/carton) como acionável; gap cru ao lado |
| D7 | Aprovação cross-city | timeline + actor audit já; **role enforcement** (scaffold `sp_can`) numa fase 2 |
| D8 | AVGs | manter pelos importers existentes + botão "refresh avgs" no app |

---

## 9. Fases de build

- **Fase 0 — Esqueleto + leitura (sem escrita Cin7):** módulo `features/replenishment/` novo (db/lib/routes/ui) no design do stock-planning; landing branches+datas; grid read-only com **todas as colunas** vindas de dado vivo (products+snapshot+avgs+movements); engine de suggestion via `lib/`. Aceite: abro um branch e vejo o grid igual ao Excel, com cover/amarelo corretos, batendo com a planilha.
- **Fase 1 — Editar + approve/reject + suggestions:** QTY editável, amarelo live, approve/reject (reject desce), free-text lines, source Main/Sydney (MEL/HBA), form de suggestions. Persistência em `replenishment_line`. Aceite: monto uma ordem line-by-line como no Excel.
- **Fase 2 — Timeline + snapshots + log:** estados (ready→check→approval→sent), `status_event`, snapshots imutáveis por semana, consulta por TR/data + print. Aceite: pessoa de outra cidade vê "ready to check" e aprova; semana fecha e vira snapshot.
- **Fase 3 — Place order (Cin7) + print:** cria o transfer via outbox (ProductID resolvido/cacheado) → `TOStaging.open` imprime o template. Aceite: place order cria o TR no Cin7 e sai a folha idêntica à do dashboard.
- **Fase 4 — Paridade + AVGs:** script de parity-check (UI vs Excel) como o stock-planning; botão refresh avgs. Aceite: paridade provada antes de substituir a planilha.

> Tudo no **dev**, incremental, revisável. Nada de escrita Cin7 sem o outbox. O fluxo existente de `replenishment` fica intacto até a paridade fechar.
