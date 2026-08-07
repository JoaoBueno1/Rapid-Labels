# Cin7 Sync Workflows — architecture & schedule map

How Rapid-Labels keeps its `cin7_mirror` (+ `public`) tables in sync with Cin7, and the
scheduling rules that keep it inside the **shared Cin7 API rate limit** (the key is shared
across TMS + app + Labels; the limit is **per account**, so a dedicated key does not help).

> The Labels Supabase (`iaqnxamnjftwqdbsnfyl`) is a **separate database from the TMS**. These
> syncs only READ from Cin7 and WRITE to the Labels mirror. They never touch the TMS.

## Two layers

1. **Real-time (webhooks)** — Vercel receiver → `webhook_events` queue → processed in real time
   (+ a 2h drain backstop). Registered events: `Sale/ShipmentAuthorised` (stock leaves → pick
   anomalies + `stock_movements`), `Sale/Voided`, `Sale/Undo`, `Sale/InvoiceAuthorised`,
   `Sale/PickAuthorised`, `Sale/PackAuthorised`, `Purchase/StockReceivedAuthorised` (stock in).
   This path is what keeps pick-anomaly analysis and the movement ledger **0-min fresh**.
2. **Scheduled polling (GitHub Actions)** — for what webhooks deliberately do **not** cover:
   stock **levels** (`Stock/AvailableStockLevelChanged` is unsubscribed — too high volume),
   **product/location master data** (not webhook-fed), and internal **transfers / adjustments /
   assembly** (no Cin7 webhook). Everything else is a backstop for dropped webhooks.

## Why the 2026-08 change (concurrency + de-collide)

Symptom: scheduled jobs fired but **timed out and were cancelled at 15 min**. Root cause was
**burst concurrency** — many jobs collided on the same cron minute (`:00 / :15 / :30`), all hit
the shared key at once → Cin7 429 → the paged fetch stalled in backoff → job cancelled. And
**no workflow had a `concurrency:` block**, so a hung run overlapped the next tick → a pile-up
death spiral. Fix (all YAML, reversible):

- **`concurrency: { group: <name>, cancel-in-progress: false }`** on every workflow → serializes
  same-workflow runs (no overlap / no double load) and **never cancels a run mid-write** (safe for
  the stock TRUNCATE+reinsert).
- **De-collided cron minutes** → no two Cin7 workflows start on the same minute.
- **Reduced frequency on webhook-covered backstops only** (reconciles → daily, pick-anomalies batch
  → 2×/day) — the real-time path keeps those fresh; the batch just backfills a dropped webhook.
- Operational syncs kept at their cadence (stock hourly, order-pipeline hourly, transfers 2h,
  availability 4h).

## Schedule map (UTC)

| Workflow | Cron | Cin7 cost | Fed by / purpose | Note |
|---|---|---|---|---|
| cin7-sync (stock levels) | `0 * * * *` | light (~16) | poll — **only** stock-level source → replenishment/coverage | keep hourly |
| order-pipeline-sync | `35 * * * *` | medium | poll — warehouse pick/pack/ship board | de-collided off :15 |
| cin7-sales-sync | `10 */2 * * *` | light (~1) | poll — new/open order headers (no order-created webhook) | de-collided off :15 |
| cin7-webhook-drain | `25 */2 * * *` | ~0 | webhook queue backstop | de-collided off :15 |
| cin7-availability-sync | `30 */4 * * *` | light | poll — `stock_availability` aggregate (chase "Have stock") | *dup of stock endpoint — consolidate later* |
| cin7-transfers-sync | `45 */2 * * *` | light (~4) | poll — `stock_transfers` mirror (no transfer webhook) | keep |
| cin7-open-detail-sync | `5 */6 * * *` | medium (self-draining) | poll — open-order rep/location/lines | keep |
| cin7-movements-sync | `50 */6 * * *` | **heavy** (per-task) | poll — transfers/adjustments/assembly/purchase | *drop purchase later (webhook-fed)* |
| cin7-transfers-reconcile | `20 3 * * *` | medium (backlog) | poll — close phantom transfers | → daily |
| pick-anomalies-sync | `30 3,15 * * *` | medium | backstop — anomalies are webhook-real-time | → 2×/day |
| cin7-sales-reconcile | `40 15 * * *` | medium (backlog) | backstop — status is webhook-real-time | → daily |
| cin7-daily (products/locations) | `15 16 * * *` | medium | poll — product + location master (not webhook-fed) | de-collided off :00 |
| cin7-webhook-watchdog | `20 6,18 * * *` | ~1 | **reactivates Cin7 auto-disabled webhooks** — guards the whole real-time path | 2×/day (was daily) |

## What each sync writes → which page/feature it affects

| Workflow | Writes (table) | Feeds (page / feature) |
|---|---|---|
| Cin7 Sync Scheduler | `stock_snapshot` (bin-level levels) | Replenishment, Restock, Cyclic Count, coverage "Have stock", pick-anomaly stock-check |
| Cin7 Availability | `stock_availability` (SKU×location rollup) | Chase list "Have stock" + backorder detection |
| Cin7 Daily Maintenance | `products`, `locations` (master) | Whole app: labels/search/product names, Replenishment names, **weight/dims for freight** |
| Cin7 Movements | `stock_movements` (transfer/adjustment/purchase/assembly) | Movements audit tab, reconciliation, Pick Anomalies (assembly builds) |
| Cin7 Open Detail | `sales_orders` rep/location + `sale_lines` | Open Orders / chase (who/where, per-line backorder) |
| Cin7 Sales Reconcile | `sales_orders` status | Open Orders (un-sticks phantom-open orders) |
| Cin7 Sales Sync | `sales_orders` headers | Open Orders / chase (new + modified orders) |
| Cin7 Transfers Reconcile | `stock_transfers` (closes phantoms) | Branch Transfers control tower (open counts) |
| Cin7 Transfers Sync | `stock_transfers` headers | Branch Transfers control tower |
| Cin7 Webhook Drain | processes `webhook_events` | Real-time backstop for everything (pick anomalies, movement ledger) |
| Cin7 Webhook Watchdog | `webhook_health_log` | Guardian — keeps the real-time webhook feed alive |
| Order Pipeline Sync | `order_pipeline` | Warehouse dashboard pick/pack/ship board |
| Pick Anomalies Sync | `pick_anomaly_orders` | Pick Anomalies page (backstop; ship-time is webhook-real-time) |

> Sales *ship* movements + pick-anomaly analysis are already real-time via webhooks, so the polling
> jobs above are mostly backstops for the non-webhook data (stock levels, products, transfers).

## Deferred improvements (higher blast-radius — do carefully, verify each)

1. **429 circuit-breaker** in the shared Cin7 client: after N consecutive 429/403, exit cleanly
   (all syncs are idempotent) instead of burning the 15-min timeout in backoff.
2. **movements-sync: drop the `purchase` slice** (already webhook-fed via
   `Purchase/StockReceivedAuthorised`); keep a daily purchase-only reconcile as the net.
3. **availability-sync: consolidate** — aggregate `stock_availability` inside `_syncStock` from rows
   already fetched by the hourly stock sync, then retire the separate workflow (−90 Cin7 calls/day).

## How to monitor

- **Coverage/health**: `node cin7-stock-sync/verify-coverage.js` (read-only; checks sales-capture,
  movement freshness, webhook backlog, snapshot freshness, cron liveness).
- **GitHub Actions**: runs should be green; a `cancelled`-at-15-min run = throttle/hang.
- **DB freshness** (Labels Supabase): `stock_snapshot.synced_at`, `products.synced_at`,
  `stock_movements.detected_at`, `pick_anomaly_orders.analyzed_at`, `webhook_events` last received.
- **Manual catch-up** if ever stale: `node cin7-stock-sync/sync-service.js --stock-only`
  (and `--products-only`; `sync-movements.js --type=all`) — reads Cin7, writes the Labels mirror.
