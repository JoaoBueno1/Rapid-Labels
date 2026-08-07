# excel-sync

Builds the company's Excel tabs from the Cin7 mirror instead of someone
exporting a report and pasting it in.

**Phase 1 (this): prove the content.** The engine produces the tab and diffs it,
cell by cell, against the real Cin7 export it is meant to replace. Writing into
the OneDrive/SharePoint workbook via Microsoft Graph is a later phase and a
swappable adapter — nothing here touches a real workbook.

That order is deliberate. Writing to Excel is the easy, reversible part; getting
the numbers right is where the work is. See
[../../docs/EXCEL_SYNC_REPORTS.md](../../docs/EXCEL_SYNC_REPORTS.md) for the
reconciliation that settled each column, and
[../../docs/EXCEL_SYNC_ARCHITECTURE.md](../../docs/EXCEL_SYNC_ARCHITECTURE.md)
for how this fits with the Cin7 syncs.

## Use

```bash
pip install -r requirements.txt          # openpyxl; everything else is stdlib

python -m engine list
python -m engine build stock-level   --out out
python -m engine build monthly-sales --month 2026-08 --out out

# the one that matters — build and diff against the real Cin7 export
python -m engine build stock-level --verify "~/Downloads/Inventory Products Stock Level Report (23).xlsx"
```

Needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`) in the
environment or the repo `.env`. Reads only — nothing here writes to the mirror.

## Where things live

| | |
|---|---|
| `specs/*.toml` | one file per tab: columns, headers, order, gates. TOML because `tomllib` is stdlib — a spec file costs no dependency. |
| `engine/sources.py` | one function per report. Deliberately concrete: *what each report counts* was won by reconciling against real exports, and that belongs in commented code, not a query string. |
| `engine/pivot.py` | spec loading, the SKU × warehouse pivot, csv/xlsx output |
| `engine/verify.py` | the publish gates, and the diff against a Cin7 export |
| `engine/supabase.py` | PostgREST over `urllib` — same pattern as `scripts/update_main_avg_3mo.py`, so CI needs no resolver |
| `out/` | generated builds. Not committed. |

Columns are matched **by header name**, never by position. Cin7 has re-ordered
report columns before; a spec that trusts position turns that into silently
shifted data.

## Status

| Report | Verified against | Result |
|---|---|---|
| `stock-level` | Inventory Products Stock Level Report (23) | ✅ **7/7 metrics at 100.00%**, 12 657/12 657 cells |
| `monthly-sales` | Sale Order Details (23) | 🟡 1 624/1 630 cells (99.63%); **Total 100.21% ✓**, Quantity 103.19% ✗ |

`monthly-sales` currently **blocks**, and that is the gate working. The whole
3.19% is one Cin7 order-split shell (`SO-280868`) plus its sibling `SO-280873` —
retained originals from a chain that Cin7 split twice, whose lines the report
does not count. No derivable rule isolates them: `Note` does not discriminate
(`SO-280244` carries the same "Original Order #" text and *is* counted), and
"every line fully backordered" catches 37 orders and drags quantity down to
94.25%.

Money is already right — **Total is at 100.21%** because the shell's lines are
low value. Only Quantity is affected, by one order.

**Open decision:** how Cin7 treats split orders in this report. That is business
knowledge, not something derivable from the API fields we mirror. Until it is
answered, the honest options are to leave the gate blocking (it is telling the
truth) or to raise `total_tolerance_pct` on the Quantity metric with the reason
written in the spec.

## Gates

A tab that is 6% low reads as completely normal; a tab that did not refresh is
obvious. So the engine refuses to publish rather than publish quietly wrong:

- `min_detail_coverage_pct` — every order in the month must have its detail
  synced (fed by `backfill-sales.js detail-month`)
- `expect_rows_between`, `min_groups` — shape sanity
- `--verify` — per-metric tolerance against the real export

## Next

1. Fill `[workbook]` in each spec once the target file and tab are confirmed.
2. Settle the split-order question above.
3. Run in GitHub Actions producing artifacts (still no Graph).
4. Graph adapter — last, behind `engine/delivery/`.
