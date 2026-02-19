# Cin7 Stock Sync → Supabase Mirror — Architecture Document

## Date: 2026-02-19
## Status: DESIGN PHASE (isolated, not connected to app)

---

## 1. Cin7 API — Confirmed Facts (from official docs + live API tests)

### Rate Limits
- **60 requests per minute** per API Application key
- HTTP **429 Too Many Requests** returned when limit is exceeded
- Limits are **per API Application** (not per account — you can create multiple API apps on the same account for higher total throughput)
- No rate-limit headers in response (no X-RateLimit-Remaining etc.)
- **503** may occur under server load; treat as transient, retry with backoff

### Pagination
- Supported on: `Product`, `SaleList`, `PurchaseList`, `StockAdjustmentList`, `StockTakeList`, `StockTransferList`, `Category`
- **Also works on** `/ref/productavailability` (confirmed by live test)
- `Page` parameter (1-based), `Limit` parameter (min 1, **max 1000**)
- Default page size: 100
- Response includes `Total` field for total record count

### ProductAvailability Endpoint
- **URL:** `GET /ExternalApi/v2/ref/productavailability`
- **Supports filters:** `Location` (exact match, confirmed working)
- **Does NOT support:** `ModifiedSince` — always returns full dataset (confirmed: ModifiedSince returned same Total)
- **Omits zero-quantity items:** Items with 0 across all qty fields are NOT returned. This means **missing = zero stock** — safe rule.
- **Fields per row:**
  - `ID`, `SKU`, `Name`, `Barcode`, `Location`, `Bin`, `Batch`, `ExpiryDate`
  - `OnHand`, `Allocated`, `Available`, `OnOrder`, `StockOnHand`, `InTransit`, `NextDeliveryDate`

### Product Endpoint  
- **URL:** `GET /ExternalApi/v2/product`
- Supports `Page`, `Limit`, `ModifiedSince`, `Name`, `SKU`, `includeDeprecated`
- Returns full product details including suppliers, BOM, movements, attachments

---

## 2. Measured Dataset Size (Live API — 2026-02-19)

| Resource | Total Rows | Pages (Limit=1000) | API Calls Needed |
|----------|-----------|-------------------|-----------------|
| **Products** | **7,903** | ceil(7903/1000) = **8** | 8 calls |
| **ProductAvailability** (all locations) | **18,108** | ceil(18108/1000) = **19** | 19 calls |
| **ProductAvailability** (Main Warehouse only) | **6,110** | ceil(6110/1000) = **7** | 7 calls |
| **Locations** | **1,405** | 1 call (no pagination) | 1 call |

### Total calls for a FULL sync run:
- Products: **8 calls**
- ProductAvailability: **19 calls**
- Locations: **1 call**
- **Total: 28 calls per full sync**

### Estimated Runtime
- At safe throttle of **50 calls/min** (leaving 10/min headroom):
- 28 calls ÷ 50/min = **~34 seconds** per full run
- Even with network latency (~1-2s per call): **~1 minute** worst case
- **This is very manageable — full snapshots every 10-15 min are feasible**

---

## 3. Recommended Architecture: Option A — Periodic Full Snapshot

### Decision: **Option A (Full Snapshot every 10–15 minutes)**

### Reasons:
1. **ProductAvailability does NOT support ModifiedSince** — incremental sync is impossible via this endpoint
2. **Only 19 API calls** needed for a full stock snapshot — trivially under the 60/min limit
3. **28 total calls** for products + availability + locations — one full run takes ~34-60 seconds
4. **High warehouse activity** (receiving, pick/pack, transfers) means most products change frequently anyway
5. **Simplicity + reliability** — no complex change tracking, no drift risk, no webhook dependencies
6. **Deterministic correctness** — every run is a complete picture, not dependent on previous state

### Sync Schedule:
| Interval | What | Calls |
|----------|------|-------|
| **Every 10 min** | ProductAvailability full snapshot | 19 calls |
| **Every 30 min** | Products (metadata refresh) | 8 calls |
| **Every 6 hours** | Locations reference data | 1 call |
| **Daily at 2 AM** | Full rebuild (all tables, vacuum) | 28 calls |

### Why NOT Option B (Hybrid/Incremental):
- ProductAvailability has no ModifiedSince → can't detect changes
- Webhooks exist but only for Sales/Purchases/Stock events, not for "which SKU's availability changed"
- Complexity of reconciliation + risk of drift not worth it when full sync is so cheap (19 calls)

---

## 4. Supabase Schema

See `schema.sql` for the full SQL.

### Tables:
- `cin7_mirror.products` — Product catalog (SKU, name, barcode, category, status)
- `cin7_mirror.stock_snapshot` — Current stock levels per SKU per location
- `cin7_mirror.locations` — Warehouse/location reference data
- `cin7_mirror.sync_runs` — Audit log of every sync execution

### Key Design Decisions:
- **Separate schema** (`cin7_mirror`) — fully isolated from production tables
- **Composite primary keys** on stock_snapshot — (sku, location_name) for fast upserts
- **synced_at timestamp** on every row — know how fresh each data point is
- **GIN index on SKU** for fast text search
- **Missing = zero rule** — if a SKU+Location combo disappears from API response, set all qty fields to 0

---

## 5. Implementation Plan

See `sync-service.js` for the full skeleton.

### Service Architecture:
```
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   Cron/Scheduler │──▶│  Cin7 Sync Service  │──▶│  Supabase (PG)     │
│   (every 10 min) │      │  (Node.js)        │      │  cin7_mirror.*    │
└──────────────────┘      └──────────────────┘      └──────────────────┘
                                │
                                ▼
                          ┌──────────────────┐
                          │  Cin7 Core API    │
                          │  (DEAR Systems)   │
                          └──────────────────┘
```

### Safety Features:
- **Throttle:** 50 calls/min max (configurable), with 1.2s delay between calls
- **Retry:** Exponential backoff + jitter on 429/503 (3 attempts max)
- **Idempotent:** Uses UPSERT (INSERT ... ON CONFLICT DO UPDATE) — safe to rerun
- **Dry-run mode:** `--dry-run` flag logs what would happen without writing
- **Structured logging:** JSON logs with timestamps, call counts, errors
- **Run audit:** Every execution logged to `sync_runs` table
- **Graceful zero handling:** Products missing from response get qty set to 0

---

## 6. Verification Plan

### Pre-Go-Live Checklist:

#### Data Correctness:
- [ ] Run full sync 3+ times, verify row counts match API `Total` values
- [ ] Sample 20 random SKUs — compare mirror qty vs Cin7 UI for each warehouse
- [ ] Verify Main Warehouse totals: `SUM(on_hand)` in mirror vs Cin7 Stock Report
- [ ] Check edge cases: negative Available qty (confirmed exists: SKU R2340-WW-10-V2 has Available: -38.0)
- [ ] Verify zero-stock handling: confirm products with 0 qty are correctly zeroed (not orphaned)

#### Operational:
- [ ] Run sync for 24 hours continuously (every 10 min) — verify no 429 errors
- [ ] Verify sync_runs table has no failures over 24h
- [ ] Confirm average sync duration stays under 2 minutes
- [ ] Test with artificially slow network (add 3s delay) — verify retry logic works
- [ ] Verify dry-run mode produces correct output without writing

#### Drift Detection:
- [ ] After 24h of running, compare full snapshot at T vs T+10min — delta should be reasonable
- [ ] Set up alert: if ANY sync_run fails 3x in a row → notification
- [ ] Set up alert: if sync takes >5 minutes → notification
- [ ] Periodic (daily) compare: count of SKUs in mirror vs Products API total

### Go/No-Go Criteria:
- **GO:** All correctness checks pass + 24h operational run with 0 failures
- **NO-GO:** Any data mismatch >1% of rows, or >2 consecutive sync failures

---

## 7. Monitoring & Alerting

### Recommended Alerts:
| Alert | Condition | Action |
|-------|-----------|--------|
| Sync Failure | `sync_runs.status = 'failed'` 3x consecutive | Page on-call |
| Rate Limited | Any 429 response | Warning log + auto-backoff |
| Slow Sync | Run duration > 5 min | Warning |
| Data Staleness | `MAX(synced_at)` > 30 min old | Alert |
| Row Count Drift | `stock_snapshot` rows differ >20% from expected | Investigate |
| API Down | 3 consecutive connection failures | Alert |

### Dashboard Queries:
```sql
-- Latest sync status
SELECT * FROM cin7_mirror.sync_runs ORDER BY started_at DESC LIMIT 10;

-- Data freshness
SELECT MAX(synced_at) as latest_sync, 
       NOW() - MAX(synced_at) as staleness
FROM cin7_mirror.stock_snapshot;

-- Stock by warehouse (for dashboard)
SELECT location_name, COUNT(*) as skus, SUM(on_hand) as total_on_hand
FROM cin7_mirror.stock_snapshot
WHERE on_hand > 0
GROUP BY location_name
ORDER BY total_on_hand DESC;
```

---

## 8. Future Enhancements (after validation)

1. Connect app pages (restock.html, stock-anomalies.html) to read from `cin7_mirror.stock_snapshot`
2. Add Cin7 Webhooks for near-real-time updates on specific events (Sale/OrderAuthorised, Purchase/StockReceivedAuthorised)
3. Add materialized views for common dashboard queries
4. Deploy sync service as a scheduled cloud function (Vercel Cron, Supabase Edge Functions, or Railway)
5. Create a second API Application key in Cin7 for higher combined throughput (2x60 = 120/min)
