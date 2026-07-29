# Re-Stock V2 — Main AVG update (rolling N-month demand)

How to refresh the Main-warehouse average demand that Re-Stock V2 uses to size
pickfaces and raise the red/orange coverage alerts.

## What the AVG drives (and what it does NOT)

`public.branch_avg_monthly_sales.avg_mth_main` = **what LEAVES Main Warehouse per
month** = `avg_sales_main` (Sale + SaleMultiple) **+** `avg_transfer_main`
(StockTransfer net out).

Re-Stock V2 uses it ONLY for coverage insight:

| Uses the AVG | Does NOT use the AVG |
| --- | --- |
| `capacity_weeks` = cap_max ÷ (avg ÷ 4.33) | `restock_qty` = `max(0, cap_max − pickface_on_hand)` |
| `runway_weeks` = on_hand ÷ (avg ÷ 4.33) | status LOW / MEDIUM / FULL / OVER (on_hand vs min/med/max) |
| 🔴 alert `< 3 wk`, 🟡 alert `< 4 wk` | |
| "ideal pickface = 4 weeks of demand" suggestion | |

So a wrong/blank AVG never mis-orders stock — it only affects the sizing advice.

## Rules (agreed 2026-07-30)

- **Total = what leaves Main = sales + transfer NET.** Not sales-only. (Branch
  transfers usually come off reserve pallets, so sales-only was considered, but
  the business wants everything that leaves Main.)
- **Round UP (`ceil`) everything → whole integers only, never decimals** (1.2 → 2).
- **Products with no Main movement in the window → 0** (their N-month average *is*
  zero; keeping a stale value would mix periods and reintroduce decimals).
- **Case-insensitive product match** — update the existing row even if the report's
  letter-case differs, so we never create case-duplicate rows.

## The report

Cin7 → Reports → **Product Transaction** / "Inventory Movement Details",
**Location = Main Warehouse**, pick the period (e.g. last 3 months). Export to
`.xlsx`. Header row must be:

```
SKU | Category | Reference type | Quantity in | Quantity out | Cost in | Cost out
```

The script parses **by header** — Cin7 has changed the column order before, so never
rely on a fixed index. The divisor (months) is taken from the report's own From/To
dates (a clean 3-month pull → divisor 3.0).

## Run it

```bash
# dry-run — auto-finds the newest "Inventory Movement Details*.xlsx" in Downloads
python scripts/update_main_avg_3mo.py

# execute
python scripts/update_main_avg_3mo.py --write

# explicit path
python scripts/update_main_avg_3mo.py "C:/Users/you/Downloads/report.xlsx" --write
```

Needs `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`) in `.env`. A CSV backup of
prior values is written next to the report before any write. Re-running is safe /
idempotent. **Refresh monthly** so seasonal SKUs that resume selling get an AVG
again on the next pull.

## 2026-07-30 run (3-month window: 29-Apr → 29-Jul-2026, ÷ 3)

- **2,113** moving products updated with fresh, rounded-up AVG.
- **1,009** non-movers reset to 0 (no Main movement in 3 months).
- **257** products newly added to the table.
- **3** case-duplicate rows merged/cleaned (Main values kept, branch data preserved).
- Result: 4,647 rows, **0 decimals** in `avg_mth_main`.
- Moving the window to the last 3 months (was Aug 2025 – Feb 2026) lifted total
  Main demand **~+25%** (both the old and new figures already counted transfers —
  the rise is fresher, current velocity, not a change in method).
- Effect on the 1,473 configured pickfaces: **🔴 critical (<3 wk) 99 → 166**,
  **⚪ no-demand 247 → 352** (dead SKUs to reclaim), 🟢 healthy 1,069 → 885. Balanced
  churn: 232 pickfaces became more urgent, 237 less urgent, 1,004 unchanged.
