# Branch Replenishment — build plan & decisions

Rebuild of the office's weekly branch-transfer process, in-app, on the Stock Planning design.
Backend (engine, Cin7 write, print, data) already exists — this is UI + orchestration.
**Everything is built EXCEPT the final "write order to Cin7" step** (explicit user hold).

## Two order types (inside a branch)
1. **Weekly replenishment** — engine suggestions *or* manual. Has the full check flow
   (branch asks → inventory team confirms → approve). This is the big grid.
2. **Daily / urgent** — no suggestions. Add up to **12** items, each with a **reason**, print
   together. Approval + analysis still happen, but the **branch does NOT do "ready to check"**
   (these are special/just-sold orders coming from the branch).

## Opening a branch (revised P3) — no pre-open menu
Clicking a branch drops **straight into the sheet** with Excel-style **empty rows to fill** (no
"Add line" button; type a product into any blank row via **autocomplete by 5DC / Rapid Code / name**).
A **Load suggested (N)** button (N shown live) opens a small **confirm modal** — suggested only, no
"all" — that **merges** the engine picks into empty rows and **never overwrites what you typed**
(write-protection). The engine owns the rules; they're changed only in Settings (no rules banner on
the sheet). A **Columns** chooser toggles which columns show; everything fits with no side scroll.

**Right panel** (click any row, any stage): the product across every branch (avg · SOH · in-transit),
Main+Gateway SOH + **bins**, **on-the-way (Main) + ETA** (`next_delivery_date`), and a comment box.

**History sub-tab** (per branch): approved snapshots, frozen at the approved values.

## Columns (weekly) — clarity like the Excel
Grouped + colour-coded headers. **Numbers centered, text left.** No full-row colour by cover
(we colour in analysis, not here). **Only red = no Main stock (can't send)** — and the engine never
suggests those. Marks (not row colours) for oversold / low cover / in-transit.

| Group | Columns |
|---|---|
| Identity | Tier · 5DC · Rapid Code · Product · Ctn · Location |
| Demand & stock (blue) | Mthly Avg · SOH · **In Transit** · Cover · Main (sendable) |
| Order (amber, editable) | **Branch Ask** (white input) · **Inv Qty** (grey — locks until *Ready to check*) |
| Reference | [SYD Stock — MEL/HBA only] · Comments · Inventory · ✕ |

- **Branch Ask**: what the branch requests. Pre-filled from the engine on suggestions; typed in manual.
- **Inv Qty**: our inventory team's confirmed qty. **Greyed/locked** until warehouse advances to
  *Ready to check*; then it unlocks and Branch Ask locks.
- Cover recomputes live off (SOH + In-Transit + Ask).
- Per-column **sort on header click** + optional **filter row**.

## Stage flow (timeline)
- **Weekly:** Draft → Submitted → **Ready to check** (unlocks Inv Qty) → Approved.
- **Daily:** Draft → Submitted → Approved (no Ready-to-check).
- Approved locks everything. (Place-order → Cin7 is the held final step, after Approved.)

## Phases
- **P0 ✅** live read-only grid + engine + settings + averages.
- **P1 (this pass)** clarity rebuild: bigger rows, grouped/colour headers, number-center/text-left,
  in-transit column, Branch-Ask + Inv-Qty, red only on no-Main, marks, header sort + filter row.
- **P2 (this pass)** the gate (suggestions vs manual), suggestions confirm, manual autocomplete add-line,
  local draft persistence + stage bar (Draft→…→Approved), Inv-Qty unlock at Ready-to-check.
- **P3** Daily / urgent mode (≤12 items + reason, no ready-to-check).
- **P4** DB persistence + immutable weekly snapshots + audit timeline (needs a Labels migration).
- **P5** Print (reuse the Transfer Out template) + parity check vs the Excel.
- **P6** Master product tab in Inventory Management: "deprecated from branch replenishment"
  (per-branch / all) + current-month sales column.
- **HELD** place-order → Cin7 transfer (via the wms-transfers outbox). Not built until asked.

## Verified
Engine reproduces the Excel: Melbourne = 17 suggestions; R2595-BK-CW = 10 (exact cell);
engine caps by Main-sendable vs the raw Excel gap (D6).
