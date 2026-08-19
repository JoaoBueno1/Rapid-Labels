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
