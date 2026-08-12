# Runbooks — Rapid Labels

**Created:** 2026-08-12
**Audience:** whoever maintains the platform. This is **not** an SOP — warehouse staff should never need it.
**Rule:** every entry is a real failure mode confirmed in production.

## Standing facts you need before touching anything

| Fact | Detail |
|---|---|
| Hosting | Vercel — `https://rapid-labels.vercel.app`. `api/index.js` re-exports `server.js`; `vercel.json` rewrites `/api/:path*` to that one function (`maxDuration 60`) plus `/wms` and `/pack` |
| Branches | `origin/main` and `origin/dev` have been identical. **Local `main` goes stale fast** — an audit was misled by a local `main` 120 commits behind. Always check `origin/` |
| Database | Supabase `iaqnx…` (ap-southeast-2). Schemas: `public`, `cin7_mirror`, `rapid_inv`, `wms`, `excel_sync`, `ops`. **Separate project from the TMS** |
| Migrations | No `_exec_sql`, no `DATABASE_URL`. **Apply SQL through the Supabase SQL Editor** — `apply_sql.py` does not work here |
| Compute for syncs | **GitHub Actions, not Vercel.** Serverless cannot run a scheduler; `cin7-sync.yml` says so in its header |
| Authentication | **None.** Any page URL opens for anyone who can reach it. The PIN at `index.html:650` gates four management tools only |
| Cin7 credentials | **Byte-identical to the TMS**, so one shared per-account rate-limit bucket |
| Sync health | The Sync Monitor page judges freshness from the **data**, not the job log — a job that reports success but writes nothing still shows stale. Trust the page over the Actions tab |
| Node | via `fnm` |

---

## RB-01 · A sync is stale

**Symptom:** Sync Monitor shows a card red or amber; replenishment hides its recommendations; stock numbers look old.

1. Open **Sync Monitor** first. It tells you which dataset is stale and when the job next runs.
2. Check the corresponding GitHub Actions run. All 15 scheduled workflows live on the default branch.
3. If the job ran and succeeded but the data is stale, the job is writing nothing — read its log for a silent skip.
   **Known example:** `track-first-arrivals.js` self-skips every hour because `cin7_mirror.product_first_arrival`
   was never created.
4. Re-run the workflow manually (`workflow_dispatch`) before doing anything more invasive.
5. **Replenishment intentionally hides its output when the stock sync is stale.** That is the guard working — fix
   the sync, do not bypass the guard.

---

## RB-02 · Cin7 429s / sync jobs timing out or cancelled

**This happened and was fixed on 2026-08-07 (`5099cfc`).**

**Cause:** cron collisions. Several workflows fired at the same minute against a **shared per-account Cin7 key**,
producing 429s and cancelled runs.

1. Fix already in place: `concurrency: false` plus de-collided cron times. See `docs/SYNC_WORKFLOWS.md`.
2. **Before changing any cron time, check the TMS side too.** It refreshes its Cin7 order cache every 10 minutes
   against the same account. Neither system can see the other's consumption.
3. A dedicated Cin7 key does **not** buy throughput — the limit is per account.
4. Deferred hardening (Pass 2, not done): a 429 circuit breaker, movements purchase-drop, availability consolidation.

---

## RB-03 · The real-time Cin7 event feed has gone quiet

**Symptom:** pick anomalies stop appearing in real time; the pipeline board lags.

1. Cin7 deactivates a webhook after repeated failed deliveries. A **watchdog runs twice a day and turns them back
   on** — check whether it has already recovered.
2. The **webhook drainer** runs every two hours as a backstop, and the pick-anomaly batch runs twice a day, so
   nothing is lost — it is late, not missing.
3. Manage webhooks with the Cin7 webhook CLI. ⚠️ **Only touch our own webhooks.** Do **not** disturb the n8n
   Customer/Updated webhook — it belongs to another system.
4. `CIN7_WEBHOOK_TOKEN` must match in `.env`, Vercel and the GitHub secrets, or Cin7's bearer will not validate.

---

## RB-04 · Products are missing from the mirror

**Known bug, unfixed.** About 451 products are missing because new inserts fail.

**Mechanism:** a duplicate SKU inside one batch causes an `ON CONFLICT` error, the whole 500-row batch is dropped,
and the job still reports success.

**Fix:** dedupe by SKU before the upsert. Until then, expect gaps and do not trust "sync succeeded".

---

## RB-05 · Pick anomaly detection looks wrong

1. Run the coverage check first: `node cin7-stock-sync/verify-coverage.js`. It answers "is detection still catching
   everything" across seven separate signals. It is a morning check, not a scheduled job.
2. Expect roughly **8–10% sales leakage** and a **6-day retention window**; inserts are immutable.
3. Picks from staging bins (`MA-DOCK`, `MA-GA`, `MA-PRODUCTION`) are **excluded on purpose**
   (`isExcludedPickBin` in `engine.js`) — classification only. If exclusions look wrong, run `refresh-locators` once.
4. If home shelves changed in Cin7, run the **refresh locators** maintenance action so analysis is judged against
   current data.

---

## RB-06 · ⚠️ A pick-anomaly "Fix" corrupted stock

**Read this before pressing Fix, not after.**

Cin7 has **already deducted from the real bin** at the time of shipping. Creating a correction transfer therefore
moves the stock a second time. **Every "Fix" can corrupt stock.**

- Recorded scale: **730 corrections**, most recent 2026-08-11, **zero reversed**.
- A partial guard is shipped (`pick-anomalies-engine.js:1546` and `:1578` on both `/create-transfer` and
  `/batch-transfer`): the action is blocked when the anomaly is an overflow case or confidence is unknown, unless
  forced.
- Recommended posture: **make the page review-only** and build a bulk unwind. Until then, treat Fix as a
  last resort and record every use.
- A **Reverse** action exists for undoing a single correction.

---

## RB-07 · Returns — the Void button errors

**Broken in production.** `returns_active.void_reason` returns PostgREST `42703` — the column does not exist.

- Operations is not currently blocked: the published Returns SOP v1.2 does not mention Void.
- Fix: apply the missing migration, or remove the button.
- Reminder: **Returns never writes stock into Cin7.** That is deliberate. It is a document and credit register.

---

## RB-08 · The camera scanner does not work on a page

`openScanModal` is defined once, in `scanner.js:93`. `scanner.js` is loaded by `index.html`,
`collections-history.html` and `restock-v2.html` — **not** by `collections.html`. If scanning fails on Collections,
that is why. Adding the script tag is the fix.

---

## RB-09 · A WMS or Pack page is reachable and should not be

- `/wms`, `/pack`, `/sync-cin7-cache.html`, `/test-integration.html` and `/cyclic-count.html` all return **200
  unauthenticated** in production.
- The WMS **live-write kill switch is on**, so no stock can move — that is the real protection.
- `wms.parcels` = 7 and `wms.scans` = 5, so drafts and scans have been exercised. `wms.claims` does not exist and
  `wms.parcel_lines.boxes` was never applied.
- **Do not turn on live writes** until the 20 defects in `features/wms/PREGOLIVE_REVIEW.md` are closed.

---

## RB-10 · Replenishment numbers look wrong

1. Replenishment runs off `branch_avg_monthly_sales` (public/anon) and **only lists what a branch actually sells**
   (average > 0). A product missing from the list usually means average = 0, not a bug.
2. Update it from the office's `new avg.xlsx`: one tab per warehouse, Rapid code in **column B**, average in
   **column D**, Sydney in **column F**. Procedure: `docs/RESTOCK_AVG_UPDATE.md`.
3. Check the sync freshness guard has not silently hidden output.
4. `transfer_plans` and `transfer_plan_lines` are empty — saved plans have never been used, so "my saved plan
   disappeared" is expected behaviour, not data loss.

---

## RB-11 · Re-Stock V2 print comes out wrong

**Known trap, documented.** The print layout depends on a **column index**: the controls live in column 1.
**Never add a column** to that table without re-checking the print output. This has broken before.

---

## RB-12 · Label sheets print misaligned

Print at **100% scale**, no "fit to page". The PDF is generated at true millimetre size with jsPDF. Manual
alignment calibration was deliberately retired (`a5b6ece`) once print-at-100% proved reliable — do not reinstate it.

`jspdf` is loaded from jsDelivr and must stay on the CSP allowlist in `server.js`.

---

## RB-13 · Which label prints which code

Three label paths exist **by design**, and they do not print the same code:

| Path | Prints |
|---|---|
| Search & Print | **Product code** (the Cin7 SKU) — leave it as is |
| Barcodes | Cin7 barcode |
| Multi-labels | Cin7 barcode |

This is correct. Do not "fix" it.

---

## RB-14 · Excel Sync will not deliver

**Blocked externally, not broken.**

- Microsoft Graph is closed by tenant policy (`AADSTS90094`) through both doors. The Azure portal column
  "Admin consent required: No" **is lying** — it is required.
- Transport therefore falls back to local Excel COM over the OneDrive-synced copy, which is unfinished.
- The build half works and is verified cell-by-cell against a real Cin7 export. `probe_graph_auth.py` checks in one
  command whether Microsoft has started allowing it.
- Details: `docs/EXCEL_SYNC_DELIVERY.md`, `docs/EXCEL_SYNC_STATUS.md`.

---

## RB-15 · Restoring the mirror after a bad sync

1. `cin7_sync_log` records recent runs.
2. Manual backfill scripts exist for headers and line detail and **resume from a checkpoint** — use them rather
   than re-running a whole cron.
3. Mirror-vs-Cin7 verification tools sample the mirror against live Cin7 and confirm the compatibility views still
   return the shape the pages expect. Run them after any bulk backfill.

---

## Gaps — no runbook exists yet

| Gap | Why it matters |
|---|---|
| **No authentication at all** | Any URL is open. There is no procedure because there is no access control to operate |
| **No request logging** | There is no way to answer "who used what" or "is this page used". Vercel analytics or a minimal request log would settle it |
| **No backup procedure** | Same gap as the TMS. No tested restore |
| Credentials committed in deleted scripts | `deploy-now.js`, `fix-grants.js`, `try-passwords.js`, `run-migration-v2.js` contain hardcoded credentials. **Rotate after deleting them** — see `DEAD_CODE_REGISTER.md` |
| Public artefacts in the web root | Board reports and raw stock extracts are served publicly by the Vercel deployment |

---

## Change log

| Date | Change |
|---|---|
| 2026-08-12 | Created from the three-system inventory and the incident history |
