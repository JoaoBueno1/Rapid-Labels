# excel-sync

Builds the company's Excel tabs from the Cin7 mirror instead of someone
exporting a report and pasting it in.

## The shape

```
cin7_mirror ──▶ dataset (built ONCE) ──▶ excel_sync.dataset_rows ──┬──▶ workbook A / tab
                                                                   ├──▶ workbook B / tab
                                                                   └──▶ workbook C / tab
```

**Datasets** (`specs/datasets/*.toml`) say how the numbers are computed.
**Bindings** (`specs/bindings/*.toml`) say which workbook and tab consume them,
which columns and how often.

That split is the point. Several spreadsheets want the same stock availability
and monthly sales figures. Rebuilding per workbook would re-read the mirror N
times *and* let two tabs refreshed minutes apart disagree with each other. Built
once, stored once, every binding reads the same snapshot — so connecting a new
spreadsheet is one file in `specs/bindings/`, with no new query, no new sync and
no extra Cin7 call.

**Phase 1 (this): prove the content.** The engine diffs its build, cell by cell,
against the real Cin7 export it replaces. Writing into OneDrive/SharePoint via
Microsoft Graph is a later, swappable adapter. Writing to Excel is the easy
reversible part; getting the numbers right is the work.

Reconciliation that settled each column:
[../../docs/EXCEL_SYNC_REPORTS.md](../../docs/EXCEL_SYNC_REPORTS.md).

## Use

```bash
pip install -r requirements.txt          # openpyxl; everything else is stdlib

python -m engine list                    # datasets + bindings
python -m engine build stock-level   --out out
python -m engine build monthly-sales --month 2026-08 --publish
python -m engine register                # bindings → ops.sync_registry

# the one that matters — build and diff against the real Cin7 export
python -m engine build stock-level --verify "~/Downloads/Inventory Products Stock Level Report (23).xlsx"
```

Needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (or `SUPABASE_ANON_KEY`) in the
environment or the repo `.env`. Reads the mirror; writes only to `excel_sync`
and `ops`.

## Deploy

1. Run `db/001_ops_registry.sql` then `db/002_excel_sync.sql` in the Supabase
   SQL editor (both idempotent).
2. `python -m engine register` — puts the dataset builds on the monitor.
3. Add `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` to GitHub Actions secrets if not
   already there, and push — `.github/workflows/excel-sync.yml` takes it from
   there (20:00 UTC Sun–Thu = 06:00 Mon–Fri Sydney).

**No "Exposed schemas" change is needed.** `ops` and `excel_sync` stay private;
everything goes through a handful of `public.*` functions — `sync_health`,
`excel_datasets`, `excel_dataset_rows` for reads, and `excel_publish_dataset`,
`ops_run_start`, `ops_run_finish`, `ops_register_bindings` for writes (those four
are revoked from anon/authenticated and granted only to service_role). That drops
a manual UI step from the deploy and keeps the API surface to named functions
rather than raw table access.

## Where things live

| | |
|---|---|
| `specs/datasets/*.toml` | how a dataset is computed: columns, headers, order, gates |
| `specs/bindings/*.toml` | which workbook tab consumes it, columns, cadence — see its README |
| `db/*.sql` | `ops` (sync catalogue + run log + health) and `excel_sync` (datasets) |
| `engine/sources.py` | one function per dataset. Deliberately concrete: *what each report counts* was won by reconciling against real exports, and belongs in commented code, not a query string |
| `engine/pivot.py` | spec loading, the SKU × warehouse pivot, csv/xlsx output |
| `engine/verify.py` | publish gates, and the diff against a Cin7 export |
| `engine/publish.py` | materialise a dataset into Supabase, log the run |
| `engine/supabase.py` | PostgREST over `urllib` — same pattern as `scripts/update_main_avg_3mo.py`, so CI needs no resolver |
| `out/` | generated builds. Not committed. |

Columns are matched **by header name**, never by position. Cin7 has re-ordered
report columns before; a spec that trusts position turns that into silently
shifted data.

TOML rather than YAML because `tomllib` is stdlib from Python 3.11 — a spec file
costs no dependency, and CI needs no resolver.

## Status

| Dataset | Verified against | Result |
|---|---|---|
| `stock-level` | Inventory Products Stock Level Report (23) | ✅ **7/7 metrics at 100.00%**, 12 657/12 657 cells |
| `monthly-sales` | Sale Order Details (23) | 🟡 1 624/1 630 cells (99.63%); **Total 100.21% ✓**, Quantity 103.19% ✗ |

`monthly-sales` **blocks**, and that is the gate working. The whole 3.19% is one
Cin7 order-split shell (`SO-280868`) and its sibling `SO-280873` — retained
originals from a chain Cin7 split twice, whose lines the report does not count.
No derivable rule isolates them: `Note` does not discriminate (`SO-280244`
carries the same "Original Order #" text and *is* counted), and "every line
fully backordered" catches 37 orders and drags quantity to 94.25%.

Money is already right — **Total is at 100.21%** because the shell's lines are
low value. Only Quantity is affected, by one order.

**Open decision:** how Cin7 treats split orders in this report. That is business
knowledge, not derivable from the API fields we mirror. Until it is answered,
the honest options are to leave the gate blocking (it is telling the truth) or
to set `total_tolerance_pct` on the Quantity metric with the reason in the spec.

## Gates

A tab that is 6% low reads as completely normal; a tab that did not refresh is
obvious. So the engine refuses to publish rather than publish quietly wrong:

- `min_detail_coverage_pct` — every order in the month must have its detail
  synced (fed by `backfill-sales.js detail-month`)
- `expect_rows_between`, `min_groups` — shape sanity
- `--verify` — per-metric tolerance against the real export

A blocked dataset is recorded as `blocked` in `ops.sync_runs` and shown as such
on the Sync Monitor, rather than failing silently.

## Next

1. Fill `[workbook]` in a binding once the target file and tab are confirmed.
2. Settle the split-order question above.
3. Graph adapter — last, behind `engine/delivery/`.
