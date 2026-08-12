# Business rules — Rapid Labels

**Created:** 2026-08-12 · **Branch:** `dev` @ `46645cc` · **100 rules extracted with evidence**

## Why this file exists

These are decisions the **business** made that currently live only inside source code. Code records *what*
happens; it does not record *why*. Most of the replenishment numbers below were tuned against the manager's own
planner and verified against real transfers — none of that is recoverable from the code alone.

**`REASON NOT RECORDED`** means the rule is real and in force, but nothing explains why that value was chosen.
**Those rows are the backlog.**

| Marker | How it can be changed |
|---|---|
| 🟩 **env** | Environment variable / GitHub secret — no deploy |
| 🟦 **admin** | Editable from a screen |
| 🟨 **data** | A database row or an imported spreadsheet |
| 🟥 **code** | Code change and deploy |

---

## 1. Replenishment — how much stock each branch gets

The most commercially significant section in this repo. Every inter-branch transfer, and therefore a large part
of the freight bill, comes out of these numbers.

### Targets and tiers

| Rule | Value | Where | Why |
|---|---|---|---|
| Monthly averages are converted to weekly demand using a fixed figure | **4.345** weeks/month | `replenishment-config.js:17` | True value is 4.348. Comment: "business rounding, **matches the original planner**". Keeping it is what makes system numbers tie out against the manager's spreadsheet |
| **ABC velocity tiers set weeks of cover** | **A = 10 · B = 8 · C = 6** weeks | `replenishment-config.js:37` | The manager mega-overstocks A-class SKUs (RSS, RQC, R-GPO2-WH) at ~24 weeks; the system is deliberately conservative. **Tuned 2026-05-13: A dropped from 12 to 10** because 12 overshot on top movers where the manager actually keeps 6–8 weeks. Commit `2d0670a` |
| Tier cut-offs by share of total network demand | top **20%** = A · next **30%** = B · remaining **50%** = C | `replenishment-config.js:38` | Comment. ⚠️ Widening the A band immediately raises target stock across hundreds of SKUs |
| Fallback when a SKU cannot be tiered | **6 weeks** | `replenishment-config.js:24` | Same as the legacy default |
| **Main/Gateway must retain 8 weeks of its own demand before anything ships to a branch** | `MAIN_MIN_WEEKS = 8` | `replenishment-config.js:48` | Comment: **8 weeks ≈ supplier lead time (4–6 weeks) + processing buffer (2 weeks). Below this, Main itself becomes the bottleneck** |
| Main's safety stock is computed from **Main's own customer sales**, not total outflow | preference `avg_rep_main` → `avg_sales_main` → `avg_mth_main` | `replenishment-config.js:303-310` | Total outflow includes interstate transfers and is inflated. ⚠️ "Without that preference, 8 × inflated_avg **blocks all top movers**" |
| Branch demand prefers the sales-rep average over the shipped average | `avgRepField if > 0, else avgField` | `replenishment-config.js:284-289` | The rep-based figure "reflects actual demand at the branch, not just what was shipped from there" — a branch that has been under-supplied would otherwise look like it needs less | 🟨 data |
| Cover bands for reporting | Critical **<7 days** · Warning **<21** · OK **<35** | `replenishment-config.js:111-113` | ⚠️ REASON NOT RECORDED. Drives what operations treats as urgent |

### Carton rounding — how the manager actually behaves

| Rule | Value | Where | Why |
|---|---|---|---|
| Round up to a full carton only if the result stays within twice the target | `CARTON_ROUND_UP_MAX_RATIO = 2` | `replenishment-config.js:68` | The only guard when demand data is missing |
| Rounding must not leave a branch holding more than **4 months** of demand | `CARTON_ROUND_UP_MAX_MONTHS = 4` | `replenishment-config.js:74` | **"4 months mirrors manager behaviour"** — for slow movers where Main holds plenty, ops routinely ships a full carton covering 3–6 months to avoid partial-carton handling. **Verified against a real Sydney transfer 2026-05-12** (R-PMB, R-WPI220, R6232-BK-TRI sent full-carton at 4–7 months cover) |
| Relaxed to **8 months** for slow movers in large cartons when Main is loaded | branch avg < 5/month **AND** carton ≥ 50 units **AND** Main holds > 12 months | `replenishment-config.js:462-464` | "Mimics manager behaviour of shipping full ctn for slow movers when Main is loaded" |
| The cap rises to match the user's chosen target if that exceeds 4 months | `maxMonths = max(4, targetWeeks / 4.345)` | `replenishment-config.js:466-469` | **Without this, any target above ~17 weeks made the suggestion list silently go empty** |
| Cartons-only mode has a hard ceiling of **6 months** | `CARTON_MODE_MAX_MONTHS = 6` | `replenishment-config.js:78` | Independent of target weeks |
| A top-up is not worth sending below one week of demand, floor 3 units | `MIN_SEND_FALLBACK_UNITS = 3`; `min send = max(2, ceil(one week))` | `replenishment-config.js:87, :372-378` | Simplified 2026-05-13; applies only when the branch already has stock. **Oversold branches bypass it entirely.** The earlier half-carton rule "produced odd blocks for medium-carton SKUs (18–40 units)" |

### Allocation and conflicts

| Rule | Value | Where | Why |
|---|---|---|---|
| Stock already in transit is subtracted from the need | `effectiveNeed = max(0, needQty − pendingQty)` | `replenishment.js:517-519` | ⚠️ REASON NOT RECORDED, but removing it double-ships every shortfall while a transfer is on the road |
| A cross-branch **conflict** requires more than one branch needing it **and** Main having sendable stock **and** combined need exceeding it | — | `replenishment.js:462-465` | "The old code flagged ANY single-branch shortfall as a conflict, which inflated the KPI". A pure no-stock situation is not a conflict |
| ⚠️ **The 8-week Main safety buffer can be overridden** when a branch is oversold and the normal pool is too small | `pool = mainAvailable; override = true` | `replenishment.js:521-526` | ⚠️ REASON NOT RECORDED. Surfaced to the user as `safetyOverrides` on the branch KPI card. **This is the one path that can drain Main** |

### What is excluded from replenishment

| Rule | Value | Where | Why |
|---|---|---|---|
| Carton/multipack bundle SKUs and anything ending `-V1` | `/\bcarton\b/i`, `/[-_ ]carton\d+/i`, `/[-_]v1$/i` | `replenishment-config.js:125-132` | Carton variants "got planned alongside the base SKU and **double-counted**"; V1 is always the legacy version, successor is the same SKU without the suffix |
| Products sold by the metre (LED strip, fairy lights, extrusion) | `/\bper\s*metres?\b/i` and similar | `replenishment-config.js:136-144` | Tracked by length, not unit count — auto-replenishing them produces meaningless quantities |
| ⚠️ **A hand-curated list of ~45 individual SKUs** | 8 superseded bases (R-SMI10, R-TVPAL-F, R2352-CW-10 …) + ~37 R1069 / R1071–R1079 / R107M wattage variants unified into one SKU | `replenishment-config.js:153-218` | Audited 2026-05-13 against Cin7 status and last-modified, with named exceptions kept deliberately (R6071-BK-CW/-V2 differ by anti-corrosive coating; R1160-WH-V2 CCT variants are distinct; >12 W is outside the unified 6–12 W range). **This list only lives in code — nobody maintains it in Cin7, so every new -V2 revision silently starts double-planning until someone edits this file** |
| **Gateway is treated as part of Main** — one stock pool | `'gateway' → 'MAIN'` | `replenishment-config.js:237-256` | ⚠️ REASON NOT RECORDED, but consistent with the Coffs Harbour workbook, whose cell I1 reads "Include gateway With Totals". **Splitting them would understate Main and the 8-week rule would immediately block all branch shipments** |
| Seven branches served | SYD, MEL, BNE, CNS, CFS, HBA, SCS | `replenishment-config.js:260-268` | ⚠️ REASON NOT RECORDED. **Adding a branch needs three things — code, a warehouse-name mapping, and matching average columns — or it simply never appears in the plan** |
| Branch demand comes from a **manually imported spreadsheet**, and only SKUs the branch actually sells (average > 0) are planned | `branch_avg_monthly_sales` | `replenishment-config.js:260-272`, `replenishment.js:453-455` | Update procedure is operational — the office "new avg" workbook, imported per warehouse. **If the monthly import is skipped, the whole plan quietly runs on stale demand** | 🟨 data |

### Data-freshness gates

| Rule | Value | Where | Why |
|---|---|---|---|
| Recommendations warn at **4 hours** old and are **hidden entirely at 8 hours** | `SYNC_WARN_MINUTES = 240`; `SYNC_BLOCK_MINUTES = 480` | `replenishment-config.js:96-97` | This is the control on whether the business may act on the numbers at all |
| A sync is treated as partially failed below **8,000 stock rows** or **5,000 products** | — | `replenishment-config.js:105-106` | Set to ~60% of the live catalogue (stock ≈14,200 rows, products ≈10,700). Was 500/100, "way too low to detect partial syncs". ⚠️ **Must be re-tuned as the catalogue grows, or a half-failed sync passes silently** |

---

## 2. Pick anomaly detection

| Rule | Value | Where | Why |
|---|---|---|---|
| **Only captured at the moment an order ships** | `CombinedShippingStatus === 'SHIPPED'` only | `pick-anomalies-engine.js:742-746` | That is when Cin7 deducts stock from the bin. Any other stage compares picks against bin data before or after the movement |
| **An analysed order is never re-analysed or overwritten** | insert with ignore-duplicates on `order_number`; **sync aborts if the dedup query fails** | `:216-228, :776-783` | Stops `analyzed_at` drifting when Cin7 touches an order days later, which would corrupt monthly reporting and re-open reviewed anomalies |
| **Nothing before the scanner went live is ever analysed** | `SCANNER_CUTOFF_DATE = 2026-03-26` | `:67` (also `verify-coverage.js:39`) | Pre-scanner orders had no bin-level tracking, so the analysis is meaningless. Commit `d5a3b96` |
| Orders shipped more than **45 days** ago are rejected | 45 days | `:1002-1009` | "Catches phantom orders that somehow have SHIPPED status but ancient dates" |
| Sync window | 7-day last-modified lookback; **30-day** order-date pre-filter | `:671-675, :705-709` | 30 days "covers even orders that take 3+ weeks from placement to ship. **With the old 14-day window, this order would have been silently dropped**" |
| At most **200 orders per run**, newest first | `MAX_ORDERS_PER_RUN = 200` | `:59, :788-805` | Cin7 returns orders in arbitrary order; **without the newest-first sort a backlog of old orders permanently starves recent shipments out of the queue**. Cap raised to 200 in `984d666` |

### How an anomaly is judged

| Rule | Value | Where | Why |
|---|---|---|---|
| **Staging and production pulls are never mispicks** | `/^MA-(DOCK\|GA\|PRODUCTION)\b/` | `:456-457` | A pick from these is expected. **The word boundary matters** — without it, every pick from aisle G would be swallowed as "staging" and real errors hidden, while real pickface bins like `MA-G-15-L1` must not match |
| **Picking from returns / samples / damaged / faulty / quarantine / reject is always a confirmed error** | `/RETURN\|SAMPLE\|DAMAGE\|FAULT\|QUARANTINE\|REJECT/i` → `confirmed` | `:322-327` | "The HIGHEST quality risk" — un-QA'd goods going to a customer. Never downgraded regardless of stock |
| ⚠️ **If the bin picked from holds stock, it is overflow, not a mispick** — downgraded to `suspect` and the correction gate blocks it | `on_hand > 0` → `suspect`, note prefixed `"Overflow:"` | `:332-337` | **This is the guard that stops a corrective transfer corrupting Cin7.** Without the tag "an operator can apply a corrective stock transfer for stock that was never in the wrong place" |
| The overflow check is skipped for orders analysed more than **3 days** after shipping | `FRESH_DAYS = 3` | `:379-386` | For a backfill, "today's stock is unrelated to what was in the bin then — claiming overflow would be a false suspect, and missing it a false confirmed" |
| Cancelled orders are hidden everywhere except their own filter; a cancellation is only a conflict when a correction **actually moved stock and was not reversed** | `transfer_status = COMPLETED AND is_reversed = false` | `:562-563, :1071-1075` | "Reversing a correction that never happened **creates phantom stock**" |
| The Pending queue has **no date window** | `anomaly_picks > 0 OR fg_anomaly_picks > 0`, `reviewed = false` | `:578-582` | So the queue matches the "Reviewed X/Y" KPI and the operator can clear it to 100%. A `PENDING_SHIP_DAYS = 10` constant remains declared at `:567` but is **no longer applied** |
| History is ordered by **ship date**, not order or analysis date | `fulfilled_date desc nullslast` | `:557-559` | "An old order shipped today must surface at the top for review — `analyzed_at` would mislead for backfilled rows" |

---

## 3. Pick productivity — what counts against an operator

| Rule | Value | Where | Why |
|---|---|---|---|
| An error = a SKU picked from a stock shelf that is not the product's pickface. **Excluded:** returns, dock, production, samples, office, Gateway area, transfers, non-scanner manual picks, finished-goods assemblies | `/RETURNS\|DOCK\|PRODUCTION\|SAMPLES\|OFFICE/` plus `MA-GA` and `GA` | `pick-productivity.js:21, :1-9` | "Including staging picks would make every operator look far worse than they are and **make the metric unusable for performance conversations**" |
| ⚠️ **13 named shelf locations are permanently excluded as valid alternate pick spots** | MA-A-05-L3, MA-F-15-L1, MA-A-09-L2, MA-B-12-L2, MA-B-02-L1, MA-A-04-L1, MA-A-08-L4, MA-C-15-L3, MA-A-10-L3, MA-H-04-L2, MA-G-01-L2, MA-A-06-L2, MA-A-05-L4 | `pick-productivity.js:25-28` | Comment: "manually reviewed as NOT real errors. Append new confirmed ones here." Commit `6be9c90`. **No record of who reviewed them or when.** This list directly changes each operator's measured error rate and cannot be audited |
| Individual picks can be excluded by a reviewer, permanently | `pick_error_exclusions` | `pick-productivity.js:104-107` | ⚠️ REASON NOT RECORDED. **An unaudited exclusion list can be used to quietly clear a person's record** | 🟦 admin |

> These two rows deserve a policy decision, not just a code comment. They determine published per-person error
> rates and there is currently no audit trail behind either.

---

## 4. Gateway overflow warehouse

| Rule | Value | Where | Why |
|---|---|---|---|
| **Fixed bin routing for Gateway transfers** | Gateway → Main: FROM `MA-GA`. Main → Gateway: FROM `MA-DOCK`, TO `MA-GA` | `gateway-engine.js:15-16, :38-40` | The operational reason for the specific bins is not recorded. Changing them deducts stock from a bin it never left and breaks reconciliation |
| The same SKU picked from several shelves is consolidated into one transfer line | — | `gateway-engine.js:17, :293-309` | A Cin7 constraint: "API rejects duplicates". Sending duplicates makes the whole transfer fail |
| FIFO ageing alerts | **30 / 60 / 90** days | `gateway-engine.js:471-478` | ⚠️ REASON NOT RECORDED |
| ⚠️ **Gateway shelf occupancy exists only in our own database** — Cin7 sees only the aggregate `MA-GA` bin | `gateway_allocations` (status = active), seeded from the "Gateway location map" file | `gateway-engine.js:205, :730-840` | ⚠️ REASON NOT RECORDED. **The shelf-level location of Gateway stock exists nowhere else. If this table is wiped or drifts, the stock must be physically re-counted** | 🟨 data |

---

## 5. Returns

| Rule | Value | Where | Why |
|---|---|---|---|
| **Returns never write stock back to Cin7** | deliberate non-feature | `features/returns/NOTES.md` | Documented: "Returns is a document/credit register, not a stock mutation. **Given the pick-anomaly history where every 'fix' corrupted Cin7 stock, keeping Returns read-only against Cin7 is intentional and safe**" |
| **The intake record freezes the moment finance starts treating** — only credit lines stay editable; nothing is ever deleted, only voided with a reason and author | `pending → in_treatment → to_putaway → completed`, plus `void` | `returns.js:19, :547`; `NOTES.md` | Documented: "the customer already holds a signed copy of stage 1. If finance changes what was 'received,' the signed copy no longer matches the record → disputes, no accountability. **That separation is the control, not a limitation**" |
| Six intake reasons and three warehouse conditions | Reasons: Faulty · Product Left Over / Change of Mind · Incorrect Item Supplied · Incorrect Item Ordered · Freight Damage · Other. Conditions: Resaleable · Not Resaleable · Faulty | `returns.js:10-11` | ⚠️ REASON NOT RECORDED. These are the categories all returns reporting is built on |
| Three outcomes printed on the customer's receipt | **Accepted for Credit Assessment** · **Accepted for Warranty Assessment** · **Return Not Accepted** | `returns.js:12` | Comment: "printed on customer receipt" — deliberately **assessment outcomes, not promises of credit**. This wording is what the customer signs and holds |
| A return must be raised against a **Cin7 customer** — free text rejected | — | `returns.js:304-312` | Otherwise the credit cannot be matched to a debtor account |

> ⚠️ Void is currently **broken in production** — `returns_active.void_reason` does not exist. See `RUNBOOKS.md` RB-07.

---

## 6. WMS — everything is off by default, on purpose

| Rule | Value | Where | Why |
|---|---|---|---|
| **Every WMS write to Cin7 is off by default** | `WMS_WRITE_ENABLED` must equal `'true'`, else 403. Read/draft flows stay open | `wms-routes.js:29-33` | ⚠️ Per `WMS_PACK_STATUS.md`, the `/api/wms/*` endpoints **have no authentication yet**, so enabling writes before auth exposes live stock mutation to anyone who can reach the endpoint | 🟩 env |
| Multi-operator claim lease | **10 minutes** unless refreshed; gated by `WMS_CLAIMS_ENABLED` (off) | `wms-engine.js:170-171` | "Cin7 has no such lock — this is our concurrency authority." Commit `7a852fd`. The choice of 10 minutes is not explained | 🟩 env |
| Reserved-stock guard on transfer dispatch | blocked when qty > free available; gated by `WMS_RESERVATION_GUARD` (off) | `wms-transfers.js:168-201` | "Would dispatching stock OUT eat into stock already promised to a sale?" Built 2026-07-30. ⚠️ `PREGOLIVE_REVIEW.md:29` records the **override is client-asserted with no role check and no audit trail** |
| **Exactly-once writes via an outbox**, verifying against live Cin7 before any re-send | unique `op_key`; verify-before-resend on `sent`/`failed` | `outbox.js:20-95` | "Ambiguous prior attempt: reconcile against live Cin7 BEFORE any re-send." Bypassing it double-posts picks and builds |
| **The outbox retry cron ships disabled** | no schedule block, `workflow_dispatch` only | `.github/workflows/wms-reconcile.yml` | "Only AFTER `/api/wms/*` has authentication, since **an unauthenticated live outbox plus a background retrier is a higher-risk combination**" |
| Only **Advanced Sales** can enter the pack flow | `Sale.Type` matches `/advanced/i` | `wms-engine.js:40-42` | The operator is told to change the order type in Cin7 rather than the system guessing |
| A product is an **assembly** when its Cin7 stock locator reads BOM or Production | `/^(bom\|production)$/i` | `wms-engine.js:47-52` (same convention in `pick-anomalies-engine.js:867`) | "The company's convention, matches Cin7's `BOMType='Assembly'`. One query, not N Cin7 calls — this is what keeps opening an order fast for the picker." ⚠️ **It is a data-entry convention in Cin7, not a system flag** — a wrong locator sends a product to be picked when it must be built | 🟨 data |

---

## 7. Container check (inbound QC)

| Rule | Value | Where | Why |
|---|---|---|---|
| Records enter `pending` and clear to `green`; each of the three label checks records OK / Wrong / Missing / N/A | `STATUS_VALUES = ['green','pending']` | `container-check-engine.js:28-33, :241` | "Red + orange retired — the DB CHECK still allows them for legacy rows, but nothing sets them anymore. Every record is treated eventually, so a simple pending → green flow is clearer than a traffic light." ⚠️ **Legacy rows still carry red/orange, so any report must handle them** |

---

## 8. Excel reporting — the numbers the branches order against

| Rule | Value | Where | Why |
|---|---|---|---|
| **A month is refused if under 99% of its orders have line detail synced** | `min_detail_coverage_pct = 99` | `monthly-sales.toml` | "**A tab that is 6% low reads as normal; a tab that did not update does not.**" Refuse to publish rather than publish a quiet wrong number |
| Row and warehouse bounds block a truncated build | monthly-sales 200–4,000 rows / ≥5 warehouses · stock-level 3,000–5,000 rows / ≥10 warehouses | both dataset TOMLs | ⚠️ **Must be revisited as the network grows** — a stale upper bound starts blocking legitimate builds |
| **Sales Total is `line total + tax`, never `× 1.1`** | tolerance 0.02 | `monthly-sales.toml` | "`sale_lines.total` is ex-GST and alone lands on exactly 1/1.1 of the export; total + tax matched **1,470 of 1,471** qty-identical cells. **Never use × 1.1 — it would break on a tax-exempt line**" |
| **`Available` is copied from Cin7 verbatim, never recomputed** | — | `stock-level.toml` | Cin7 derives carton-SKU availability from the loose parent stock, so `available ≠ on_hand − allocated` on **1,666 of 14,971 rows — and the export shows the very same 1,666** |
| ⚠️ **"Stock on hand" is an AUD value, not a unit count** | `on_hand × unit_cost` | `stock-level.toml` | The mirror column is named `stock_on_hand`, "which reads like a count and **is documented wrongly in `cin7-stock-sync/schema.sql`**". Proven on 9,877 of 9,877 blocks. **The database documentation is known to be wrong and has not been corrected** |
| Reproduction tolerances against the Cin7 report | default 0.005 · unit_cost 0.01 · stock_value 0.05 · sales total 0.02 | `verify.py:114` | ⚠️ REASON NOT RECORDED for the individual figures |
| **One dataset snapshot feeds every workbook** | built once into `excel_sync.dataset_rows`; the Excel job never calls Cin7 | `publish.py:1-7` | "Rebuilding per workbook would re-read the mirror N times **AND let two tabs refreshed minutes apart disagree with each other**" |
| ⚠️ **Column order in the Coffs Harbour tab is load-bearing** | `Available` must stay 5th within B:F; `locations = ["Main Warehouse","Gateway"]`; anchor B3 | `coffs-soh-main.toml` | **2,556 VLOOKUP formulas across 16 tabs depend on that position. Reordering a column silently changes what every one of them returns, so every branch order would be placed against the wrong number** |
| All workbook bindings are **registered but off** | `enabled = false` on all three; `sla_minutes = 1560` | `bindings/*.toml` | "Nothing writes to a real workbook until the bindings carry real file/sheet names." ⚠️ **The monthly file rename (`<Branch> <Mon YY>.xlsx`) is manual — an enabled binding will write to last month's file until someone updates the spec** |
| A blocked dataset must not stop the others | per-slug loop, all attempted | `excel-sync.yml` | "Failing fast would mean one bad dataset silently withholds every other report from the branches" |
| Built tabs kept as a downloadable snapshot | **14 days** | `excel-sync.yml` | ⚠️ REASON NOT RECORDED. After 14 days a disputed number cannot be reconstructed |

---

## 9. Cin7 integration — rate limits and scheduling

⚠️ **The Cin7 key is shared with the TMS and the driver app, and the limit is per account, not per key.**
Anything in this section that speeds up affects the TMS quoting and booking path too.

| Rule | Value | Where | Why |
|---|---|---|---|
| **All Cin7 calls throttled to ~24/min** | 2,500 ms between calls (movements 2,800 ms) | `sync-service.js:46-49`; `pick-anomalies-engine.js:58`; `gateway-engine.js:37` | `docs/SYNC_WORKFLOWS.md:3-5`: "the key is shared across TMS + app + Labels; the limit is per account, so **a dedicated key does not help**" |
| On HTTP 429, wait 25 s and retry | 25,000 ms | `pick-anomalies-engine.js:91-95`; `gateway-engine.js:64-68` | ⚠️ REASON NOT RECORDED, **and recorded as a known weakness**: the deferred fix is a circuit breaker that exits cleanly after N consecutive 429s "instead of burning the 15-min timeout in backoff" (`SYNC_WORKFLOWS.md:82-84`) |
| In-process lock + 5-minute circuit breaker on stock syncs | lock wait 120 s | `sync-service.js:828-845` | ⚠️ REASON NOT RECORDED |
| Paging and batching | page 1,000 (**Cin7 maximum**), batch 500, 3 retries, 30 s timeout | `sync-service.js:31-45` | Only the page size has a recorded reason (a vendor constraint) |
| Bounded windows and per-run caps | `ASSEMBLY_SINCE_DAYS 1` · `MOVE_SINCE_DAYS 3` · `DETAIL_OPEN_CAP 60` · `RECONCILE_SO_CAP 200` (stale 2 days) · `RECONCILE_TR_CAP 300` · `WMS_RECONCILE_CAP 50` · `SYNC_HOURS 3` | the workflow YAMLs | `SYNC_HOURS 3` gives "1h overlap with the 2h cadence = no gap". ⚠️ **The open-detail header text says 150; the configured value is 60** |
| **Every workflow is serialised against itself and never cancelled mid-write; no two start on the same minute** | `concurrency: {group, cancel-in-progress: false}` on all 16; de-collided cron minutes | all workflows; `SYNC_WORKFLOWS.md:22-37` | Documented root cause of the **August 2026 outage**: "many jobs collided on the same cron minute, all hit the shared key at once → 429 → the paged fetch stalled in backoff → job cancelled. And no workflow had a concurrency block, so a hung run overlapped the next tick → **a pile-up death spiral**." `cancel-in-progress: false` because it is "safe for the stock TRUNCATE+reinsert" |
| ⚠️ **Sales-detail and Excel run Sunday–Thursday UTC on purpose** | `0 19 * * 0-4` (05:00 Mon–Fri Sydney) and `0 20 * * 0-4` (06:00) | the two workflow headers | Both say: "so the workbook is current before the shift starts. **The day shift in the cron is deliberate — do not 'fix' 0-4 to 1-5**." Correcting it shifts every run a day later, so Monday starts on Friday's numbers |
| Cadence map | stock 1h · pipeline 1h · sales headers and transfers 2h · open-detail and movements 6h · availability 4h · reconciles daily · pick-anomaly batch 2×/day | `SYNC_WORKFLOWS.md:39-56` | Backstops are less frequent because "the real-time path keeps those fresh; the batch just backfills a dropped webhook" |
| Month-detail keeps the previous month in window | `DETAIL_MONTH_BACK = 1` | `cin7-sales-detail-month.yml` | "It costs no Cin7 calls once that month is fully detailed, and it is **what catches an order voided (or edited) after its month closed**" |

### Webhooks

| Rule | Value | Where | Why |
|---|---|---|---|
| **Seven Cin7 events subscribed; the stock firehose deliberately not** | Sale/ShipmentAuthorised, Voided, Undo, InvoiceAuthorised, PickAuthorised, PackAuthorised, Purchase/StockReceivedAuthorised. **Excluded:** Stock/AvailableStockLevelChanged | `webhook-config.js:18-32` | "High-volume firehose; enable later only if we build a live stock-level view" |
| **Cin7 disables a webhook after 6 failed deliveries (~75 min)** — a watchdog reactivates ours twice a day | cron `20 6,18 * * *` | `webhook-watchdog.js:5` | A vendor-imposed limit, not our choice. ⚠️ **If the watchdog stops, a short outage permanently kills the real-time feed and nothing tells you** |
| A failed event is retried 6 times, 10 at a time, then marked failed | `WEBHOOK_MAX_ATTEMPTS = 6`, `WEBHOOK_BATCH = 10` | `process-webhook-queue.js:124-125` | ⚠️ REASON NOT RECORDED. **A permanently failed ShipmentAuthorised means that order never enters pick-anomaly analysis unless the batch backstop catches it** | 🟩 env |

### Health thresholds

| Rule | Value | Where |
|---|---|---|
| What "healthy" means for the whole Cin7 feed | SALES fail if >**2%** of orders shipped before today are unanalysed (4-day window) · MOVEMENT stale 6 h / fail 18 h · SNAPSHOT stale 24 h / fail 36 h · NOBIN warn 0.15 (baseline ~8.8%) · CRON sale warn 2.5 h / fail 5 h, movements warn 6.5 h / fail 14 h | `verify-coverage.js:38-50` |

Comments explain the 4-day window ("so it always spans business days even after a weekend") and the Brisbane
offset ("cin7 dates are Brisbane-local; timestamptz cols are real UTC").

---

## 10. Labels and barcodes — three paths, three different codes, on purpose

⚠️ **Do not "unify" these.** Each prints a different code because each serves a different scan.

| Path | Prints | Where | Why |
|---|---|---|---|
| **Search & Print** | The **Cin7 SKU** as CODE128 — *not* the retail barcode | `app.js:1099, :1123-1131` | ⚠️ Naming trap: on screen, **"SKU" is the 5-digit code (5DC / attribute1) and "Code" is the Cin7 SKU** — the reverse of everyday usage (`app.js:422`) |
| **Barcodes (3 sections)** | The product's **retail barcode**, symbology by digit length. Location barcodes always CODE128 | `barcodes_labels.html:166-181` | 14 digits → ITF14 · 13 starting with 0 → **CODE128** · valid 13 → EAN13 · other 13 → UPC (first 12) · 12 → UPC · 8 → EAN8 · else CODE128 |
| **Multi-Label** | Retail barcode, falling back to the Cin7 SKU; same ladder | `multi-label.js:356, :392-412` | Same rationale |

**Why the leading-zero rule matters:** "A 13-digit EAN-13 starting with 0 is a UPC-A: scanners drop the leading 0.
Cin7 stores (and matches) the full 13 digits, so encode as CODE128." Encoding it as EAN-13 makes the scanner
return 12 digits, **which silently matches nothing in Cin7**. And for 12 digits, UPC — not EAN13, which would
append a 13th check digit.

### Label sheet geometry

| Rule | Value | Where | Why |
|---|---|---|---|
| Six Celcast/Avery A4 sheets, with a load-time check that each actually tiles the page | L7167/48001 1-up 199.6×289.1 · L7165/48008 8-up 99.1×67.7 · L7163/48014 14-up 99.1×38.1 · L7162/48016 16-up 99.1×33.9 · L7159/48024 24-up 64.0×33.9 · L7157/48033 33-up 64.0×24.3 | `label-templates.js:29-34, :105-115` | "Only the sheets Rapid LED actually stocks — **Celcast codes confirmed on the physical box (2026-07-24)**." A broken spec is flagged and never printed |
| Two die families | 3-across: margin 6.5 mm, pitch 66.5 mm (Celcast "QuickPeel"). 2-across: margin 4.65 mm, pitch 101.6 mm (4 in) | `label-templates.js:26-28` | Mixing them prints the third column off the sheet |
| **No calibration step — print at 100% / Actual size** | — | `label-templates.js:8-11, :118-121` | "This serves one company on one known set of sheets, so these numbers are the answer." ⚠️ **If a printer is left on "Fit to page" every label misaligns and the fix is the print dialog, not the app** |
| Each sheet declares its purpose and permitted contents | L7165 = product sticker · L7163/L7162 = shipping + bin locations · L7159 = code/5DC/barcode · L7157 = shelf ticket / price | `label-templates.js:68-96` | "A sheet is not a blank canvas. A 38 mm price ticket and a 68 mm product sticker serve different jobs." `tuned` marks formats settled with the operator |
| Zebra thermal | 4×6: three 100×40 mm sections, 5 mm gap · stk1 96×146 · stk2 two 96×72 | `label-templates.js:37-43` | Physical thermal stock dimensions |
| Multi-Label rows per sheet | A4 portrait 8 · A4 landscape 5 · A3 portrait 14 · A3 landscape 10 | `label-templates.js:55-58` | ⚠️ REASON NOT RECORDED — raising the cap shrinks rows until barcodes stop scanning |

---

## 11. Access, security and data policy

| Rule | Value | Where | Why |
|---|---|---|---|
| ⚠️ **A single shared four-digit PIN gates four pages** — Pick Anomalies, Branch Replenishment, Gateway, Pick Productivity. Container Check, Open Orders and Sync Monitor are deliberately open | **PIN = 4209**, hard-coded | `index.html:650` | ⚠️ REASON NOT RECORDED for the value or for which pages are gated (commit `ed43afc`). **It is visible in the page source, shared by everyone, cannot be revoked per person, and changing it locks out everyone at once.** This is the only access control on the operator-error and replenishment pages |
| 800 requests per IP per 15 minutes | — | `server.js:53` | "Generous for internal use". ⚠️ Lowering it can cut off a whole warehouse behind one office IP mid-shift |
| Content Security Policy allowlist | self + unpkg + jsDelivr + Google Fonts + cdnjs; connect to both Supabase projects + localhost:5050 | `server.js:29-47` | "Kept permissive for current external CDNs". ⚠️ **A new CDN library silently fails to load until its host is added here** (this is why jsPDF for Label Sheets needs jsDelivr). Still permits inline and eval'd script |
| Images/fonts cached 7 days; **JS, CSS and HTML always revalidate** | — | `server.js:70-80` | "Feature files change frequently" — caching them "would leave operators running yesterday's business rules after a deploy" |
| Request bodies capped at 8 MB | — | `server.js:68` | "Scanner-report grand-dump imports can be large" |
| **Operator names never enter the repository** | `data/scanner_activity.json` gitignored; `scanner_activity` table RLS-locked, reachable only via the server's service key | `server.js:89-122` | "The data file is gitignored (employee names)." **Exposing the table to the browser anon key would publish which employee picked which order to anyone who opens the page** |
| ⚠️ **A Supabase URL and anon JWT are hard-coded into a browser-served file** | `psczzrhmolxifgzgzswh.supabase.co` + literal anon JWT (expires 2035) — this is the **TMS** project | `cin7-simple-cache.js:6-7` | ⚠️ REASON NOT RECORDED. Rotating that key breaks the order cache until this file is edited and redeployed |
| **The Labels database is a separate Supabase project from the TMS**; these syncs read Cin7 and write the Labels mirror only | Labels = `iaqnxamnjftwqdbsnfyl` | `docs/SYNC_WORKFLOWS.md:7-8` | Documented as a deliberate isolation boundary. Any change letting a Labels job write to the TMS database crosses it |
| Expected pallet quantities per bin | `pallet_capacity_rules` (dc default `DEFAULT`, sku, qty_pallet > 0) | `pallet-capacity-rules.sql:12-21` | Separate from `restock_setup` (pickface capacity); used to detect bin/shelf anomalies. ⚠️ **The table is granted full read/write to the anonymous Supabase role** | 🟨 data |

---

## Backlog: rules with no recorded reason

Each needs an owner to confirm the value or change it. Ranked by consequence.

1. **The 13 excluded shelf locations** in pick productivity — they change published per-operator error rates and
   nobody recorded who reviewed them.
2. **The `pick_error_exclusions` list** — same problem, and it is editable from the UI with no audit trail.
3. **The Main safety-stock override** — the only path that can drain Main below its 8-week buffer.
4. **The ~45 hand-curated excluded SKUs** — maintained only in code, silently rots as new -V2 revisions ship.
5. **PIN 4209** — why that value, and why those four pages and not others.
6. **Gateway allocations** — the shelf map exists nowhere else and has no recorded backup or reconciliation policy.
7. Cover bands (7 / 21 / 35 days) and Gateway FIFO bands (30 / 60 / 90) — they set what operations treats as urgent.
8. The 25-second 429 retry, already documented as a known weakness.
9. Excel verification tolerances and the 14-day artifact retention.
10. The seven-branch list and the Gateway-is-Main mapping — both hard-coded, both with real consequences if a
    branch is added.

---

## Change log

| Date | Change |
|---|---|
| 2026-08-12 | Created — 100 rules extracted from source with evidence |
