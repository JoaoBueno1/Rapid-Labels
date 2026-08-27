# Branch Replenishment — where we stopped (handoff)

> **PT-BR rápido:** rebuild do processo de branch replenishment na `dev`. Já está de pé: planilha
> estilo Excel + sugestões da engine + painel lateral + History + stages. **Falta:** persistência
> real em banco (P4, precisa migration), print (P5), master tab (P6). **Escrever pedido no Cin7 está
> travado de propósito.** Pra continuar: `git pull` na `dev`, `node server.js`, abrir a URL abaixo.

_Last updated: 2026-08-27 · Branch `dev` · latest commit `b28eecd`_

## Run it
```bash
git checkout dev && git pull            # get the latest
node server.js                          # local server on :8383  (fnm: use the repo's node)
```
Open: **http://localhost:8383/features/replenishment/ui/replenishment.html**
(or the nav item **Branch Replenishment** — `shared/rail.js` points here).

> Local server serves files straight from disk (static), so edits show on Ctrl+F5 without a rebuild.
> Reads LIVE Supabase (`cin7_mirror` + `public`) via the anon key in `supabase-config.js` — read-only.
> No writes to Cin7 anywhere in this module yet.

## Commits so far (all on `dev`, pushed)
- `1b3ce0c` — P0: read-only grid + engine + settings + averages
- `2ca1336` — P1+P2: clarity rebuild, gate, manual, stage flow
- `b28eecd` — **P3 (current): sheet redesign — no gate, fill-in rows, side panel, History, column chooser + 4-lens review fixes**

## Files
| File | What |
|---|---|
| `features/replenishment/ui/replenishment.html` | Shell (header, sub-tabs, grid, side panel `#side`, modals: load/cols/settings) |
| `features/replenishment/ui/replenishment.css` | Module CSS only — **all tokens/shell come from the linked `features/stock-planning/ui/planning.css`** |
| `features/replenishment/ui/replenishment-app.js` | All app logic (IIFE, vanilla JS) |
| `features/replenishment/replenishment-config.js` | **The engine — reused as-is.** `window.ReplenishmentConfig` (ABC tiers, coverage, carton round, Main 8-wk safety, exclusions, `BRANCHES`) |
| `features/replenishment/BUILD_PLAN.md` | The plan + decisions |
| `shared/rail.js` | Nav → `/features/replenishment/ui/replenishment.html` |

Cache-bust: HTML links use `?v=3` on css/js — **bump the `?v=` when you edit css/js** or the browser serves stale files.

## Data sources (live, read-only)
- `public.branch_avg_monthly_sales` — one row per SKU (`product`), columns `avg_mth_<branch>` + `avg_rep_<branch>` + Main (`avg_mth_main`, `avg_rep_main`, `avg_sales_main`).
- `cin7_mirror.stock_snapshot` — `sku, location_name, available, in_transit, on_order, bin, next_delivery_date`. Bucketed by `locBucket(location_name)` → MAIN/GATEWAY/SYD/MEL/BNE/CNS/CFS/HBA/SCS.
- `cin7_mirror.products` — `sku, attribute1 (= 5DC), name, stock_locator, carton_quantity`.
- Side panel lazily fetches `stock_snapshot` for one SKU (bins + on-order + `next_delivery_date` ETA).

## What works now (P0–P3)
- **Branches landing** → tiles with suggested count. Click → **straight into the sheet** (no menu).
- **Weekly sheet**: Excel-style empty rows to fill; autocomplete by 5DC / Rapid Code / name.
  **Load suggested (N)** → confirm modal (suggested only, no "all") → **merges into empty rows,
  never overwrites typed lines**. Columns: 5DC · Rapid Code · Product · **Branch Ask** · **Inv Qty** ·
  Mthly Avg · SOH · In Transit · Cover · Main (=Main+Gateway, tooltip split + Main avg) · [SYD for
  MEL/HBA] · Comments. Numbers centered, text left. **Column chooser** (Columns button). Header-click sort.
- **Row colour**: only full-row RED when Main+Gateway is empty (can't send) — **non-blocking**.
  Oversold / low / over are small inline marks, not row washes.
- **Right side panel** (click a row, any stage): product across every branch (avg · SOH · in-transit),
  Main/Gateway SOH + bins, **on-the-way (Main) + ETA**, comment box. Reuses `.sp-side` from planning.
- **Daily / urgent** sub-tab: no suggestions; ≤12 items + Reason; no branch ready-to-check.
- **Stages**: weekly `draft → submitted → ready_to_check → approved`; daily `draft → submitted → approved`.
  `askEditable = stage==='draft'`; `invEditable = weekly && stage==='ready_to_check'` (Inv Qty locked until then, seeded from Branch Ask). Approve → snapshot.
- **History** sub-tab (per branch): approved snapshots, frozen at approved values.
- **Settings** (top-right): cover weeks/days, ABC on/off, avg source, avg rounding, carton round-up, consultative averages table.

### State lives in localStorage (per browser — this is the P4 gap)
- `rp.set` — engine settings
- `rp.cols.weekly` / `rp.cols.daily` — visible columns
- `rp.draft.<BRANCH>.<mode>` — working draft `{stage, week, lines:[{code,ask,invQty,reason,comment}]}`
- `rp.history.<BRANCH>` — array of approved snapshots

## Verified
Engine reproduces the Excel: `R2595-BK-CW @ MEL` suggests **10** (the exact Excel cell); engine caps
by Main-sendable vs the raw Excel gap (decision D6). Counts move day-to-day because data is live.

## Review status
P3 passed an adversarial 4-lens review (runtime / requirements / layout / data). All 15 requirements
traced to code. Fixed: overlay z-index (modals/toast above the drawer + `closeSide()` on modal open),
zebra-vs-red-row specificity, case-insensitive side query, send-pool-scoped on-the-way, cover 'over'
badge on avg=0, autocomplete flip-up, `overflow-x:auto`, guarded engine-missing deref, Daily Comments
default-on. **Deferred on purpose:** engine `computeMinSend` floor is NOT applied (keeps Excel parity —
revisit only if tiny 1–2u suggestions become noise).

## NEXT — build order (everything EXCEPT the Cin7 write)
### P4 — real persistence + immutable snapshots + audit  *(needs a migration you run in the Labels Supabase SQL Editor — see `reference_labels_db_topology`)*
Move drafts/snapshots off localStorage so the branch→inventory-team handoff is real (multi-user).
Proposed tables (rapid_inv or public schema, TBD):
- `transfer_plan(id, branch, mode, stage, week, created_by, created_at, updated_at, approved_at, approved_by)`
- `transfer_plan_line(id, plan_id, sku, branch_ask, inv_qty, reason, comment, avg_snapshot, soh_snapshot, main_gw_snapshot, sort)`
- `transfer_plan_snapshot(id, branch, week, mode, approved_at, approved_by, total_units, lines jsonb)` — frozen
- `transfer_plan_event(id, plan_id, stage_from, stage_to, actor, at)` — audit timeline
Add `/api/replenishment/*` routes in `server.js` (service key, server-side). Swap the four
localStorage helpers (`saveDraft/loadDraft/snapshotToHistory/loadHist`) for fetches; keep localStorage
as offline fallback. Identify the actor (there's an `x-sp-user` header pattern in stock-planning).

### P5 — Print (reuse the Transfer Out template)
On an approved plan, render the existing **Transfer Out** print layout (the one the office prints).
Look at the Stock Transfers / `TOStaging` print path already in the repo; feed it the plan lines.
No Cin7 write — print only.

### P6 — Master product tab (Inventory Management)
"Deprecated from branch replenishment" per-branch / all (exclusions surfaced as a UI, feeding
`isExcludedProduct` / a new exclusions table). Add a **current-month sales** column
(needs `cin7_mirror.stock_movements` sales aggregation — deferred data work).

### HELD — Place order → Cin7 transfer
Do NOT build until explicitly asked. Would go through the wms-transfers outbox (exactly-once), after Approved.

## Working rules (carry over)
- `dev` only; never force-push. Deploy is manual (Render, main-only) — not relevant to this local module yet.
- Keep the Stock Planning design (linked `planning.css`); no hardcoded hex, tokens only.
- Bump `?v=` on css/js edits. `node --check` the JS before committing (fnm node).
- Review at the end of each phase (the 4-lens workflow is a good template).
