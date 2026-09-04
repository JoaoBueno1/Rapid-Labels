# Dead code register — Rapid Labels

**Created:** 2026-08-12 · **Branch audited:** `dev` @ `46645cc` (identical to `origin/main` — everything committed is deployed)
**Method:** every item verified against `index.html` (the only launcher), `server.js` route registration, live
Supabase row counts using the service key, live HTTP probes of `rapid-labels.vercel.app`, and `git log` recency.

**Purpose:** decide what to delete. Nothing here is documented, and nothing here gets an SOP.

## How to use this register

Each item has a **verdict**:

| Verdict | Meaning |
|---|---|
| `DELETE` | No caller, no data, no plan. Remove the files |
| `DELETE AFTER EXPORT` | Has data worth keeping; export it, then remove |
| `DECIDE` | Complete work that was switched off on purpose. Adopt it or delete it — do not leave it |
| `FIX OR DELETE` | Broken but the capability is wanted |
| `KEEP` | Hidden but genuinely pending; leave alone |

Nothing should be deleted without a commit that names this file.

---

## A. Delete — no caller, no data

| Item | Files | Evidence |
|---|---|---|
| Old home launcher copy | `core/pages/index.html` | Duplicate of `index.html` from an abandoned `core/` reorganisation. Nothing links to it |
| Server-rendered collection label template | `collections_labels.html` | Jinja template in a Node app. No renderer exists |
| Manual Label standalone page | `manual-label.html` (17 lines) | Empty stub that tells the reader to use the pop-up on the home page instead |
| Cin7 cache sync utility page | `sync-cin7-cache.html` | Button that tells an old external server to reload a cache. That server is gone |
| Cin7 integration test harness | `test-integration.html` | Developer scratch page, publicly served |
| Scanner-vs-manual test harness | `test-scanner.html` | Developer scratch page, publicly served |
| Gateway Auditor (old page) | `features/gateway/gateway-auditor.html` (258 lines) | Superseded by `gateway-main.html` |
| Gateway table deployment scripts | `features/gateway/apply-tables.js`, `deploy-tables.js` | One-off migration runners, already run |
| Pick-anomaly migration runners | `features/pick-anomalies/run-migration-v2.js`, `run-migration-v2-rest.js`, `run-migration-v3.js` | Already applied. **One contains hardcoded credentials** |
| WMS Cin7 write spikes | `features/wms-spike/` (8 scripts: `assembly-build`, `complete-fg`, `pick-pack-test/-v2/-advanced/-clean/-final`, `cleanup`) | Throwaway probes written to prove which Cin7 writes are possible. Their findings are already in the WMS code |
| Logistics mock data | `features/logistics/mocks/*.mocks.js` | Hard-coded fake numbers from the design phase |
| Gateway movements dashboard (duplicate) | `features/logistics/gateway.html`, `gateway.js` | Superseded by `gateway-main.html`. **Still a live unauthenticated write path** into `gateway_daily` |
| Warehouse Movements pick-error report | `features/logistics/warehouse-movements.html`, `.js` | Superseded by Pick Anomalies + Pick Productivity |
| Direct-to-printer ZPL | `app.js:1352` `getZebraConfig`, `app.js:1465` `sendZplToPrinter`, `server.js:627` `POST /api/print-zpl` | `sendZplToPrinter` has no caller anywhere in the repo |
| Pick Errors / Branch Transfers modal + scanner import | `index.html:1630-1915` (`openPickErrors`, `openImportModal`, `importScannerReport`, `confirmImport`) | No button calls any of it. Superseded by the Pick Productivity page |
| Home health tiles and activity feed | `index.html` `setHealth`, `addActivity`, `activities` | `index.html:479` records that the KPI row, Today's Activity and System Health block were removed to make room for the wall display. The JS still runs and writes into DOM ids that no longer exist |
| Pick-anomaly unused endpoints | `pick-anomalies-engine.js:1621` `POST /refresh-dates`, `:2287` `GET /cancelled`, `:2598` `GET /logs` | No callers |
| Pick-anomaly single-order transfer endpoint | `pick-anomalies-engine.js:1534` `POST /api/pick-anomalies/create-transfer` | The UI uses `/batch-transfer` exclusively. **Note:** the safety guard exists on both — do not delete the guard when deleting the route |
| Pick-anomaly legacy analytics renderer (v1) | `pick-anomalies-engine.js:1695` | Superseded by analytics v2 |
| Standalone locations sync script | `cin7-stock-sync/sync-locations.js` | Untracked and superseded by the daily maintenance cron |
| Schema deploy / grant-fix scripts | `cin7-stock-sync/deploy-now.js`, `fix-grants.js`, `try-passwords.js` | One-off, already run. **All three contain hardcoded credentials — delete, then rotate** |
| Connectivity test scripts | `cin7-stock-sync/test-cin7-api.js`, `test-endpoints.js` | Developer probes |
| Broken npm scripts | `package.json` → `scheduler`, `audit`, `cache`, `setup:products` | Point at files that do not exist |
| Legacy Cin7 client trio | `cin7-client.js`, `cin7-config.js`, `cin7-service.js` | **DO NOT DELETE YET.** `collections.html:426-428` loads all three and `collections.js:856` calls `cin7Service` in the sales-order lookup fallback chain. Retire only after that chain is simplified |

> The last row is a correction from the first audit pass — it was initially marked dead and is not.

---

## B. Delete after export — has data, no future

| Item | Files | Data on record | Action |
|---|---|---|---|
| ~~Cyclic Count management~~ | ~~`cyclic-count.html` + `cyclic-count.js`, `count-form.html`, `count-form.js`~~ | ~~`count_sessions` = 1 row~~ | ✅ **FEITO 2026-09-04.** Nada foi exportado, e de propósito: a única sessão era de 21/11/2025 com status `pending` e `submitted_at` NULL — a sessão de teste do dia em que o protótipo nasceu, que ninguém preencheu. Saíram as 4 páginas, os 2 uploaders órfãos (`upload-system.js`, `upload-handler-new.js` — nenhum HTML os carregava depois que `cyclic-count.html` caiu) e as 7 rotas (`server.js` foi de 1.131 para 838 linhas). As tabelas caem em `features/cyclic-count/db/005_retire_prototype.sql`. Substituído por `features/cyclic-count/` — não pelo Re-Stock V2, como esta linha dizia |
| Tabelas `audit_*` | nenhum arquivo — ficaram órfãs em 2026-09-04 | `audit_stock_analysis` = 5.208 linhas (última 22/11/2025), `audit_products` = 94, `audit_runs` = 28, `audit_warehouses` = 8, `audit_order_aggregates` = 0 | **Ninguém mais lê.** Eram lidas só pelas 4 páginas e pelos 2 uploaders removidos acima. Ficaram FORA do `005` de propósito: 5.208 linhas são análise real de uma semana de novembro/2025, e apagar histórico é decisão a tomar de propósito, não efeito colateral. O `DROP` pronto está comentado no fim do `005_retire_prototype.sql` |
| Replacements module | `replacements/` | `replacements_requests` = 1 row, `replacements_items` = 1 row | Orphaned since 2025-12-15. Unreachable from the launcher, but still publicly served. Export the single record and delete |
| Deliveries & Couriers manual register | `features/logistics/deliveries-couriers.*` | `deliveries_daily` = 4,496 rows, **newest 2026-06-01** | Abandoned ten weeks ago. The dashboard reads real history, so either restart the daily entry or export the 4,496 rows and delete both |
| Gateway daily register | `features/logistics/gateway.js:192` writes `gateway_daily` | Stale | Same decision as above |
| Rapid Inventory sales sync | `cin7-stock-sync/sync-rapid-inv-sales.js`, `sql/rapid_inv_*.sql` | `rapid_inv` schema populated | Only consumer is the unadopted Rapid Inventory dashboard. Decide the dashboard first (section C) |

---

## C. Decide — complete work, deliberately switched off

These are assets. They should either be adopted with a date, or deleted with a decision recorded. Leaving them in
limbo is the worst option — they carry maintenance cost and they distort any inventory of the system.

| Item | State | What is holding it | Recommendation |
|---|---|---|---|
| **WMS** — handheld PWA, guided pick, transfer pick, bin-to-bin, receiving, SKU lookup, outbox, claims, reserved-stock guard | Written. `wms` schema partially deployed (`wms.parcels` = 7, `wms.scans` = 5). **`wms.claims` table does not exist**; `wms.parcel_lines.boxes` column not applied. Live writes behind a kill switch | 20 defects in `features/wms/PREGOLIVE_REVIEW.md` | Adopt with a plan, or park formally. Do not delete — it is the largest single asset in this repo |
| **Pack Station** | Written (`features/wms/pack/`). The **TMS side of the hand-off is already live in production** (`static/js/book_order.js:314-336` reads `?ref` and `?parcels`) | Depends on the WMS | Same decision as WMS |
| **Container Builder** — 3D load planner, packing solver, PO import, save/confirm/reopen, PDF export, share view | Complete. Migration applied (`container_plans` = 1, `container_plan_lines` = 2). Tile commented out at `index.html:670-676` | Adoption decision only | Adopt or delete. It is finished software sitting idle |
| **Rapid Inventory** — KPIs, project lines, POs, shortage analysis, forward forecast to 2030 | `features/rapid-inventory/dashboard.html` (1,383 lines) + `rapid_inv` SQL views | Never adopted; no menu entry at all (bare comment, no anchor) | Highest-risk item here: it was built to replace a 27 MB spreadsheet and that spreadsheet is presumably still in use. Decide explicitly |
| **Invoicing Monitor** | Complete. `invoicing_monitor` = **73,782 rows** — the data pipeline is running | Tile commented out at `index.html:676-681` | The data is being maintained whether or not anyone looks at it. Either re-enable the tile or stop the pipeline |
| **Excel Sync — delivery layer** | Build engine works and is verified cell-by-cell against a real Cin7 export. Delivery does not | Microsoft Graph blocked by tenant policy (`AADSTS90094`, both doors). Local Excel COM transport is unfinished | Keep. This is blocked externally, not abandoned. See `docs/EXCEL_SYNC_DELIVERY.md` |
| Excel Sync monthly-sales dataset + Coffs Harbour bindings | `enabled = FALSE` in `001_ops_registry.sql` and the binding TOMLs | Blocked by the same delivery problem | Keep |
| WMS Outbox Reconcile cron | `wms-reconcile.yml` ships with its `schedule:` block commented out, `workflow_dispatch` only | Correct — must not run while the WMS is off | Keep as is |
| Restock All Branches | `features/replenishment/replenishment-all.html/.js` | Scaffold; consolidated allocation across 7 branches | Decide against the per-branch planner, which is live and used |
| Cin7 Integration Monitor | `features/analytics/integrations.html` | Scaffold; superseded by Sync Monitor, which is live | Likely delete |

---

## D. Fix or delete — broken, but the capability is wanted

| Item | Defect | Evidence |
|---|---|---|
| **Returns → Void** | The button exists but the column does not | `returns_active.void_reason` returns PostgREST error `42703` (column does not exist) in production. **The published Returns SOP v1.2 does not mention Void, so operations is not currently blocked — but the migration should be applied or the button removed** |
| **Camera scan on Collections** | Broken on one page only | `openScanModal` is defined in `scanner.js:93`. `scanner.js` is loaded by `index.html`, `collections-history.html` and `restock-v2.html` — but **not** by `collections.html` |
| **New-product first-arrival tracker** | Runs hourly and does nothing | `cin7_mirror.product_first_arrival` returns 404 — the table was never created. `track-first-arrivals.js:54-61` self-skips and logs a warning every hour |
| **Open Orders chase notes** | Feature built, table deployed, **zero rows** | `cin7_mirror.chase_notes` = 0. Either the feature was never announced to the office or it does not fit how they work. Ask before deleting |
| **Re-Stock V2 saved plans** | Feature built, **zero rows** | `transfer_plans` = 0, `transfer_plan_lines` = 0. `loadExistingPlan()` always finds nothing |
| **Label Sheets manual alignment** | Retired on purpose | Commit `a5b6ece` hid the card once print-at-100% proved reliable. Finish the removal |

---

## E. Housekeeping — repo tidiness

Not dead code, but it makes the repository hard to read and is worth a single cleanup commit.

| Item | Count | Action |
|---|---|---|
| One-off analysis scripts in the repo root | ~120 files matching `_analyze_*`, `_check_*`, `_audit_*`, `_compare_*`, `_diag_*` plus their `.json`/`.txt` output | Move to `archive/` or delete. They are investigation artefacts from replenishment, Sydney stock gaps, pick-face comparison and ghost transfers |
| Temporary output directories | `_audit_tmp/`, `_d3tmp/`, `_dmg/`, `_patmp/`, `_tmp_invest/`, `_verify_out/`, `_slide_report/`, `_product_data_quality/` | Add to `.gitignore` or archive |
| Committed report artefacts served publicly | `Board_Report_Pick_Accuracy_9Apr2026` (PDF + PPTX), raw stock extracts, `Gateway location map`, `_db_current.json` (671 KB) | These are served by the public Vercel deployment. Move out of the web root |
| Duplicate front-end copies | `core/pages/index.html`, standalone test pages | Covered in section A |

---

## F. Suggested order of work

1. **Section A deletions** — mechanical, no decisions needed. One commit.
2. **Rotate the credentials** found in the deleted scripts (`deploy-now.js`, `fix-grants.js`, `try-passwords.js`, `run-migration-v2.js`).
3. **Section E housekeeping** — one commit, large diff, zero behaviour change.
4. **Section D** — fix Returns Void and the Collections camera scan; both are small and both are visible to users.
5. **Section B exports**, then delete.
6. **Section C decisions** — take these to a meeting, one at a time. Record the outcome in this file.

---

## Change log

| Date | Change |
|---|---|
| 2026-08-12 | Created from the full three-system inventory |
