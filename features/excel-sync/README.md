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

# the two read-only tools. Neither opens Excel or writes anything.
python tools/survey_workbooks.py                          # shape of all 7 workbooks
python tools/survey_workbooks.py --emit-bindings out/bindings
python tools/preview_delivery.py                          # what would CHANGE in each tab
python tools/preview_delivery.py brisbane-main-stock --samples 15

# the one that matters — build and diff against the real Cin7 export
python -m engine build stock-level --verify "~/Downloads/Inventory Products Stock Level Report (23).xlsx"

# delivery (phase 5) — dry run unless --write
python -m engine graph-login             # once, interactive; only for delegated auth
python -m engine deliver coffs-soh-main            # rehearsal: proves every gate, writes nothing
python -m engine deliver coffs-soh-main --write --file "Coffs Harbour COPY.xlsx"
python -m engine deliver                           # every enabled binding
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
| `tools/survey_workbooks.py` | reads the 7 workbooks and writes the bindings. The tabs are **not** the same shape branch to branch — the branch-stock tab alone is called `SOH Dear`, `SOH CNS`, `SOH SC` and `SOH Sydney` — so the bindings are generated from the files rather than copied |
| `tools/preview_delivery.py` | diffs what would be written against what the tab holds today. A dry run proves the write is *safe*; this is the one that says whether the numbers are *right* |
| `tools/probe_graph_auth.py` | which Graph door is open, all the way to a real PATCH |
| `out/` | generated builds. Not committed. |

Columns are matched **by header name**, never by position. Cin7 has re-ordered
report columns before; a spec that trusts position turns that into silently
shifted data.

TOML rather than YAML because `tomllib` is stdlib from Python 3.11 — a spec file
costs no dependency, and CI needs no resolver.

## Status

| Stage | | |
|---|---|---|
| Cin7 → `cin7_mirror` | ✅ | hourly |
| mirror → datasets | ✅ | nightly, 20:00 UTC. Both published and current |
| bindings | ✅ | **21** — 7 branches × 3 tabs, generated from the files, all `enabled = false` |
| rehearsal | ✅ | all 3 Brisbane tabs pass against a copy of the real workbook |
| first write | ⛔ | needs `db/003_graph_delivery.sql` deployed |
| Graph transport | ⛔ | needs delegated admin consent + an automation account |
| scheduling | ⬜ | nothing calls `deliver` yet |

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

## Delivery (phase 5)

`engine/delivery/` writes a built dataset into the tab that consumes it. It is
the only code here that touches a real workbook, and it refuses far more often
than it writes:

| Gate | Refuses when | Why it matters |
|---|---|---|
| **stale** | the dataset is older than the binding's `sla_minutes` | caught a real one on 2026-08-11: the tab held **fresher** sales than the dataset built the night before. Delivering would have replaced good numbers with old ones and logged a success. No other gate can see this — the rows were internally consistent; staleness is invisible from inside the data |
| disabled | `enabled = false` | `--force` overrides |
| header | the header row above the anchor no longer matches | column F of `SOH Main` is read by 2 556 VLOOKUPs at index 5; a shifted column corrupts every one |
| snapshot | — (takes one) | values **and** formulas stored before the first write, in `excel_sync.tab_snapshots` |
| **formula** | any formula sits inside the rectangle, the status cell, the status block, or the range we clear | a PATCH replaces it with a number, permanently. **`--force` does not override this one** |
| clear overlap | `[status] clear` intersects the data or the block | a mistyped range would erase what the same run just wrote |
| empty | the build produced 0 rows | an empty write would blank a live tab |

It also clears the tail when the data shrinks — a fixed range would otherwise
leave yesterday's last rows looking like today's — and writes the status block.

### The status block

A one-line stamp is enough for whoever wrote it and no use to anybody else.
These tabs are read by branch managers, and the question they need answered on
sight is *did this run, and what period am I looking at?*. So `[status]` carries
three things:

| key | |
|---|---|
| `cell` | the one-line stamp, written **where somebody already types it by hand** |
| `block` | four lines beside it: `Updated` / `Covers` / `Rows` / `Source` |
| `clear` | blanks the Cin7 export's own preamble, whose period goes stale |

`Covers` exists because the stamp alone never answered it. Three of the seven
workbooks are wrong about their own period right now: Brisbane shows June
figures under a hand-typed "Updated 10-Aug", Melbourne shows July, and Coffs
says `To: 30-aug` in a 31-day month. Writing the numbers and the period in the
same run is the only way they cannot disagree.

`Rows` is the cheapest tamper check there is — 1 247 today and 3 tomorrow is
obvious to someone who understands nothing else on the page.

`--write` is opt-in; without it the whole thing is a rehearsal. The first real
write should go to a copy: `--file "Coffs Harbour COPY.xlsx"`.

### Two transports, one interface

| | |
|---|---|
| `local_excel.py` | **in use.** Drives real Excel (COM) over the OneDrive-synced copy. Needs no tenant permission at all. Excel does the saving, so the 6 602 VLOOKUPs and all formatting survive — which is why this is COM and not openpyxl. |
| `graph.py` | **written and working up to the door.** Blocked on an admin consent. |

Switching is `EXCEL_SYNC_TRANSPORT=graph` or `--transport graph`. Nothing else
changes: the gates above call nothing specific to either.

**Why the bridge.** Graph is shut, and the shape of the block is not what it
first looked like. Delegated sign-in was tried on 2026-08-11 and again on
2026-08-13: both returned an admin-approval wall (`AADSTS90094` — a tenant policy
that blocks user consent). Note the trap: the portal showed *Admin consent
required: **No*** for the delegated permission, because that column reports the
Microsoft default, not the organisation's policy. Only the sign-in proves it.

**App-only is not the way out, and this is the part worth remembering.** The
Graph workbook API does not accept application permissions at all:

```
PATCH  /workbook/worksheets/{id}/range   Application: Not supported.
POST   /workbook/createSession           Application: Not supported.
```

So `Sites.Selected`, however perfectly consented, reads the file and never writes
a cell — it fails at the first PATCH, long after everything looks configured.
The ask is delegated `Files.ReadWrite.All` (`.All` because plain
`Files.ReadWrite` only reaches the user's own OneDrive, not a SharePoint
library) plus a **dedicated automation account** to run as, because the version
history of seven workbooks will carry that name every morning.

`tools/probe_graph_auth.py --write-test` is how you check, and it goes all the
way to a real PATCH against a throwaway workbook it creates and deletes. Tests
1-3 pass on app-only too; only test 6 settles anything.

The local transport costs what a laptop costs: this machine has to be on with
OneDrive running, it runs as one named account, and it is scheduled by Windows
Task Scheduler rather than the GitHub Actions cron. Bridge, not architecture.

Deploy `db/003_graph_delivery.sql` before the first `deliver` — snapshots and
extent tracking are transport-independent.

## Next

1. **Deploy `db/003_graph_delivery.sql`.** It is the only thing between here and
   a first real write: no snapshot table means no undo, so `--write` refuses.
   Idempotent, 193 lines, paste it into the Supabase SQL editor.
2. Then the write rehearsal on a copy:
   `python -m engine deliver brisbane-main-stock --force --write --file "…/out/TEST_Brisbane.xlsx"`,
   and check the workbook afterwards — values, formulas intact, VLOOKUPs still
   resolving, status block where it belongs.
3. Review the 21 bindings against `tools/preview_delivery.py`. Three open
   questions it surfaces: the `Total` column on `Sales MTD` is empty in the tabs
   today and the dataset would fill it; `main-stock` would change 976 of 2 909
   rows (plausible for three days, worth spot-checking five against Cin7); and
   22 SKUs in the tab are absent from the dataset, several of them `-CartonNN`
   variants — check whether that is a dataset filter before letting them clear.
4. Settle the split-order question above.
5. **Melbourne's branch-stock tab is empty** — 0 rows, while 6 096 formulas read
   column F of it. Every one falls through to the `ISNA→0` branch, so that
   workbook shows SOH 0 for everything. Independent of this project, and worth
   telling somebody today.
