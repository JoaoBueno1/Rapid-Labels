# Bindings — one file per Excel tab we drive

A **dataset** (`../datasets/*.toml`) says how the numbers are computed and is
built once into `excel_sync.dataset_rows`. A **binding** says which workbook and
tab consume it, which columns, and how often.

That split is the whole point: several spreadsheets want the same stock
availability and monthly sales figures. They read one stored snapshot, so two
tabs refreshed minutes apart cannot disagree, and a new spreadsheet costs no
extra Cin7 call.

## Connecting a new spreadsheet

1. Copy the nearest binding below into `<slug>.toml`.
2. Set `[workbook] file`, `sheet`, `anchor`.
3. Optionally narrow `columns` — headers must exist in the dataset; the engine
   fails loudly if one does not, rather than writing a blank column.
4. `enabled = true` when it should actually run.
5. `python -m engine register` to make it appear on the Sync Monitor.

```toml
slug = "ops-stock-weekly"
title = "Ops workbook — stock tab"
dataset = "stock-level"                  # must match a specs/datasets/*.toml
what_it_does = "Stock on hand per warehouse for the ops planning workbook."
cron_utc = "0 20 * * 0-4"                # weekdays 06:00 Sydney
sla_minutes = 1560
enabled = false

[workbook]
file = "Ops Planning.xlsx"
sheet = "SOH"
anchor = "A1"
write_mode = "replace_range"             # replace_range | append

# Optional. Omit to take every dataset column, in dataset order.
columns = ["Quantity on hand", "Allocated", "Available"]
```

## Cadence

`cron_utc` is UTC. To land on a Sydney weekday morning use day-of-week `0-4`
(Sun–Thu UTC) — 19:00–20:00 UTC is 05:00–06:00 next day in Sydney, and the
mapping holds in both AEST and AEDT. Do not "fix" `0-4` to `1-5`.

## Write mode

`replace_range` overwrites exactly the rectangle the tab occupies, leaving
everything else in the sheet — formulas, pivots, other tabs — untouched. Use
`append` only for a log-style tab that never restates history.
