# Power Query delivery — the branch workbooks pull their own data

The push model (a Windows PC writing the workbooks over Excel COM) lost data on
2026-08-17: a user opened Hobart in Excel for the web between two writes, Excel
Online autosaved the browser session, the server copy won, and OneDrive pulled it
down over the writes. No conflict copy, no error, no way to notice. That is a
property of whole-file sync, not a bug to fix.

Here the direction is reversed. Each workbook carries its own Power Query
connections and pulls from Supabase when somebody presses **Data ▸ Refresh All**.
Nothing external writes to the file, so there is nothing to clobber.

Proven in the browser on 2026-08-19: Coffs Harbour refreshed from Excel for the
web (`docProps/app.xml` records `Microsoft Excel Online`), all three tabs updated
together, and the data matched the source cell for cell.

## Running it

    python survey_tabs.py                  # read the real tabs; writes /tmp/tabs.json
    python migrate.py --only Melbourne     # convert one workbook
    python verify_data.py                  # every tab vs the source, cell by cell
    python verify_layout.py                # widths, number formats, stamps vs backup

`migrate.py` works on a copy outside the synced folder and only replaces the
original once every tab has loaded and the file has closed. Back up first anyway.

`generate_m.py` reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from `~/Rapid-Labels/.env`
and bakes them into the M. The anon key therefore ships inside a file ~20 people
hold. That was audited on 2026-08-19: of 16 real tables probed, 14 are not exposed
to PostgREST at all (404), `scanner_activity` returns 0 rows under RLS, and
`branch_avg_monthly_sales` is public by design. The key reaches nothing the
workbook does not already display.

## Four traps, each of which cost real time

**1. PostgREST silently ignores the `Range` header on this RPC.** Every offset
returns the same first 1000 rows with `Content-Range: 0-999/*`, including offsets
past the end — so a `List.Generate` loop keyed on "page came back empty" never
terminates. Only `limit`/`offset` in the querystring paginates. Pagination is
mandatory: `SOH Main` is 2,954 SKUs after summing Main Warehouse + Gateway, and
the server caps every response at 1000. Without the loop each tab would truncate
at 1000 rows and look perfectly normal.

**2. `DateTime.From(datetimezone)` re-expresses the instant in the *host machine's*
timezone.** Not the value's. `SwitchZone` is fine and idempotent; its result was
thrown away by the next line. The effective rule was `printed = UTC + host_offset`,
so the stamp was correct only on a machine already set to UTC+10 — this dev box —
and read 10 hours low in Excel for the web, whose servers are UTC. Worse, Sydney,
Melbourne and Hobart sit at +10 until October and +11 after, so those branches
would have looked right through winter and started lying at the DST switch.

Use `DateTimeZone.RemoveZone(DateTimeZone.ToUtc(dz)) + #duration(0, 10, 0, 0)`.
`RemoveZone` returns the value's own clock reading verbatim and never consults the
system. **The substring `Local` must not appear in the M** — that bans
`DateTimeZone.LocalNow`, `DateTime.LocalNow`, `DateTimeZone.ToLocal` and
`FixedLocalNow`, all of which are the same trap. The tempting one-line "fix"
`RemoveZone(LocalNow())` is flawless here and wrong everywhere else.

**3. `ListObjects.Add` autofits the key column before the QueryTable exists.**
There is no earlier moment at which `AdjustColumnWidth = False` can be set — it
already reads `True` the first instant it is readable. Writing the 52-character
stamp into a `bestFit` column widens that one too. Both are unpreventable, so
`migrate.py` records `ColumnWidth` for columns 1..40 before touching the sheet and
restores them after the stamp is written. The widths are user-authored and
load-bearing: `SOH Main` key columns are pinned at 37.0 and Sunshine Coast's
`SOH SC` at 8.85, against SKUs up to 45 characters.

Also: `ListObjects.Add(SourceType, Source, LinkSource, HasHeaders, Destination)`
needs `LinkSource=True` for an external source or it returns `E_INVALIDARG`.
`QueryTables.Add` "works" but produces a legacy range with no ListObject, which
Excel for the web will not refresh.

**4. AutoSave persists a half-finished migration.** These files live in a synced
folder with AutoSave on, and `wb.AutoSaveOn` cannot be set through pywin32 late
binding. The first failed run left a stray `_Sync` sheet in Melbourne that then
blocked the retry. Hence the temp-copy-and-swap.

## What the tabs look like afterwards

Data lands as an Excel Table anchored one row above `data_anchor`, so the query's
header row falls exactly on the existing header row. The ~3,826 VLOOKUPs are all
whole-column references (`'SOH Dear'!B:F`), so they survive the table growing and
shrinking — measured directly, and confirmed by the formula-error count being
unchanged across all 19 tabs.

The stamp is a formula, so it moves on its own at refresh:

    Updated Wednesday, 19 August 2026 at 3:01 pm (Brisbane time) - 2,954 products
        Refreshed    Wednesday, 19 August 2026 at 3:01 pm (Brisbane time)
        Data from    Wednesday, 19 August 2026 at 6:07 am (Brisbane time)
        Products     2,954
        Source       Database connected

Green when refreshed today, amber with `(!) Press Data > Refresh All` otherwise.

`Refreshed` and `Data from` are deliberately two different clocks. Refresh pulls
the published dataset; the dataset is rebuilt by `excel-sync.yml` once a day at
06:00 Brisbane. Pressing Refresh does not reach Cin7. Showing only `Refreshed`
would imply a freshness the numbers do not have.

## Live

All seven branch workbooks in `Rapid LED - Data / Inventory Management /
Inventory Stock Orders` were converted on 2026-08-20 and verified against the
source cell for cell: 7/7 identical, 0 inherited number formats, column widths
preserved, formula-error counts unchanged. `_Sync` is hidden in all of them
(`--hide-sync`).

    python survey_tabs.py --real --with-hobart      # read the SharePoint copies
    python migrate.py --real --hide-sync --only Hobart
    python verify_real.py "Hobart Aug 26.xlsx"      # data + widths + formats
    python verify_formulas.py "Hobart Aug 26.xlsx"  # #N/A count vs backup
    python compare_cin7_export.py                   # tabs vs a fresh Cin7 export

Melbourne's `Sales MTD` held **July** (`From: 01-Jul-2026`), not August; the
migration replaced it with August on Joao's instruction. 130 SKUs left the view
and 68 arrived. Nothing was lost — the July figures were simply the wrong month.

`compare_cin7_export.py` answers "did we drop a line?" against a report exported
straight from Cin7. Run on 2026-08-20 with exports taken at 07:09 against tabs
refreshed at 07:07: Coffs stock 1,225 vs 1,225 with nothing on either side, and
every difference explained by one hour of trading. The proof is mechanical —
where Cin7 shows more `allocated`, it shows exactly the same number more sold:

    SKU                     alloc +   sold +
    R-GPO2-WH                     9        9
    R-VGPO2-WH                    3        3
    R-WPGPO2                      1        1
    R3590                         1        1
    VEN-DC31203-L-WH              1        1     5/5

## The old push engine is disarmed

`--force` overrides the disabled-binding gate, and the `ExcelSync Trial`
scheduled task passed `-Root`, which adds it. It fired on 2026-08-20 at 07:00
against the test copies and tried to write over Brisbane. What stopped it was
the formula guard — it found the stamp formula in F1 and refused:

    REFUSE - 1 formula(s) inside the status cell area (F1)

That was incidental protection, not design: an armed writer with `--force`
pointed at files that now feed themselves. The task is now `Disabled`. Re-enable
with `Enable-ScheduledTask -TaskName 'ExcelSync Trial'` only if the pull model is
being rolled back.

## Not defects, checked

- **Column widths grew on Hobart and Melbourne after go-live** (G 23 -> 69.7,
  H 18.3 -> 64). Refresh does not do this: tested on Sydney, columns F..J are
  byte-identical after a full `RefreshAll`. A person widened them, almost
  certainly to read the ~70-character stamp in a 23-wide column. Worth knowing
  the stamp is longer than the space it sits in.
- **Five new `#N/A` on Hobart's `New order` tab.** Somebody typed
  `12V-IP67-012W` into B8; it does not exist in Cin7 (the 12v-IP67 family goes
  020w, 040w, 060w, 100w, 200W, 300W). The failing lookups read `Descriptions`,
  `HOB` and `Location` — none of them tabs this project touches. The workbook is
  correctly reporting a bad code.

## The two extra tabs

`Stock Data` — one row per product, 11,242 of them, 30 columns straight from
`cin7_mirror.products`. Read live at refresh: there is no dataset build in
between, so its age is the age of the products mirror, refreshed once a day by
`cin7-daily` (16:15 UTC). Blank never means zero. Where a number is missing the
cell is empty, because "no carton measured" and "does not come in a carton"
must not look the same.

Fill rates, measured 2026-08-20 across all 11,242: SKU/name/category/status/
type/UOM/sellable 100%, default location 71.0%, **pick bay 46.7%**, brand 37.0%,
dimensions 34.6%, barcode 30.5%, carton OCL 28.5%, carton ICL 27.2%,
**weight 6.1%**, warranty 0.1%, **pick zone / min-before-reorder / reorder-qty
all 0.0%**. The empty columns are kept on purpose: they are the measurement.

A trap worth knowing: Cin7 stores the literal string `"0"` where a field is
unset. Counting non-null put pick bay at 94.2% when the real figure is 46.7% —
5,343 products have `"0"` instead of a bin. Both `generate_stock_data.py` and
`006_restock_suggestion.sql` treat `"0"` as blank.

`Restock Suggestion` — the branch replenishment rule, ported from
`features/replenishment` into `db/006_restock_suggestion.sql`. The workbook query
is a single GET against the RPC; all the logic is server-side.

It had to go server-side. The first attempt computed it in M, joining three
sources (averages from `public`, branch stock and Main stock from `cin7_mirror`).
Power Query refuses that: *"references other queries or steps, so it may not
directly access a data source"*, and `FastCombine = True` does not help. Every
query that works in production is single-source with a literal `RelativePath`.
Putting the rule in SQL also means one implementation instead of a copy inside
each of seven workbooks.

### How the rule was calibrated

Not guessed — measured against `transfer-SYD-selected-46-2026-08-20.csv`, the
46 lines Joao actually chose to send:

| transit | cover | lines | hits of 46 |
|---|---|---|---|
| exclude | < 21d | 70 | 43 (93%) |
| exclude | < 25d | 72 | 44 (96%) |
| subtract | < 21d | 91 | 45 (98%) |
| subtract | < 25d | 94 | 46 (100%) |

Joao chose exclude + 25 days. Two things the real list taught, both correcting
the instructions given beforehand:

- **Every one of his 46 had Main + Gateway > 0.** He never picks what the hub
  cannot supply, so `main > 0` is a filter, and the `Main + Gateway` column is
  red when it cannot cover the suggestion.
- **21 days was too tight by two days.** His picks span 0 to 23 days of cover.

The first version missed 34 of the 46 for a structural reason: it started from
the branch's `stock_snapshot` rows. A SKU with zero stock at the branch has no
row there at all — 31 of his 46 did not exist in Sydney's snapshot. The rule
must start from the products that have an average, exactly as the screen does
(`new Set(Object.keys(state.avgData))`), and left-join stock.

`suggested_qty` is target minus available. It is **not** the screen's `send_qty`,
which further deducts Main's 8-week safety, carton rounding, minimum send and
conflicts between branches competing for the same stock.

### Two implementations, two bugs

`restock_reference.py` recomputes the same rule in Python. Comparing the two
found one error on each side, and neither would have surfaced alone:

- The SQL used `PERCENT_RANK()`; the screen uses a positional index. Different
  tie handling pushed boundary SKUs into the wrong tier.
- The Python used `round()`, which rounds half to even — `round(24.5) = 24`.
  JavaScript and Postgres round half up. The reference was the wrong one here.

The A/B/C boundary is inherently arbitrary where products tie on network demand:
`R1166-BK-WW` sits at rank 480 of 954 with the B cut at 477, so it lands in B or
C depending on tie order, and the suggestion is 6 or 5. The tie-break by product
name does not remove the arbitrariness — it makes it *stable*, which is what
matters. Verified: four consecutive calls return byte-identical results.

## Gateway Driver

`Inventory Management - Documents/Gateway/Gateway Driver Aug 26.xlsx` — a
different SharePoint library from the branch workbooks, synced under
`RapidLED/Inventory Management - Documents/`.

Its `SOH Dear` is the raw Cin7 export shape, nine columns, not the reduced
five the branches use. 998 formulas read it, and they only ever touch column A
(SKU) and column C (Quantity on hand), so those two positions are load-bearing.

The tab lists **all 8,517 active products**, not just the 564 with Gateway
stock. Starting from `stock_snapshot` would have dropped 2,359 SKUs — a SKU with
no stock has no row there at all — and every lookup against them would have
turned into `#N/A`. Listing all active products loses nothing (2,798 of the
2,799 SKUs already in the tab are Active; the one exception no longer exists in
Cin7) and shows 0 where there is no stock, which is what the Cin7 report already
did.

### The `stock check` tab was dead

All 522 of its formulas read `VLOOKUP(B2,'SOH Dear'!B:F,2,FALSE)` — searching
for a SKU starting at column B, which is `Unit` and says "Item" for everything.
It never matched. Every cell was `#N/A`, and the VARIANCE column that the tab
exists to produce was `#N/A` with it. A column shift: someone pasted the Cin7
export, which puts SKU in A, over a layout that had it in B.

Replaced with `SUMIF('SOH Dear'!$A:$A,B2,'SOH Dear'!$C:$C)` — the pattern
already working in this same workbook's `DAILY STOCK REPORT`, which returns 0
rather than `#N/A` for an absent SKU and sums duplicates. 306 of 524 rows now
carry a real figure and 87 show a non-zero variance that nobody could see.

## Monitoring

`monitor.py` reads every workbook and reports last refresh, age, who saved it
(desktop Excel vs Excel Online), query count and any empty data tab. It touches
nothing — each file already carries its own refresh time in `_Sync`.

What it cannot tell you: **whether a refresh failed**. Excel shows the user an
error and records it nowhere readable. All that is visible is the shadow — the
stamp does not advance — which covers "failed" and "nobody pressed it" without
separating them. Separating them would mean the query writing to the database
from inside the workbook, which hands the anon key write access and adds one
more thing that can break a refresh that currently works.

## Open

- **The stamp can go fresh over stale data.** `Sync_Status` is a separate query
  from the data queries, and Refresh All carries on past a failure. If a data
  query times out mid-pagination while `Sync_Status` succeeds, the tab keeps the
  old numbers under a new timestamp. Fix is to have `Sync_Status` reference the
  data queries so it fails with them; costs roughly 2x refresh time, measured at
  6.6s (Cairns) to 19.6s (Melbourne) on the desktop.
- `_Sync` is still visible for testing. Hide before handing to the team.
- Each user authorises the source once: **Anonymous** in the credential dialog.
  Per person, not per session — needs confirming over a few days.
- Only the six test copies are converted. Hobart is not, and is still
  half-updated from the failed push go-live.
