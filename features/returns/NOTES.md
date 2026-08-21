# Returns — design notes & market alignment

Internal notes on how the Returns module works and how it compares to standard
returns/RMA handling. Dev-only module (Warehouse Ops).

## Our flow

| Stage | Who | What | Mutable? |
|-------|-----|------|----------|
| **1. Create** | Warehouse (walk-in) | Customer (+code), origin order, operator, product lines with per-line reason + provisional value (PriceTier1, editable). Prints 2 identical signed copies (customer + office), no values. | **Edit** allowed **while `pending` only** |
| **Edit** | Warehouse | Reopens the stage-1 form to fix the intake draft (wrong customer/qty/line) *before* it's processed. | Disappears once treatment starts |
| **2. Action / Treatment** | Finance | Treatment ref (credit/order #), "moved to", **credit lines** seeded from stage 1 but editable / splittable / zeroable, notes, "treated by". Stage 1 shown **read-only**. → *Save progress* (`in_treatment`) or *Complete* (`completed`). | Stage-1 frozen; only credit lines editable |
| **3. History** | All | Completed records, Value column (credit total), reprint ("Print form"). | Terminal (view/reprint only) |

Never hard-deleted: no delete policy on `returns_active`. Line tables have a
delete policy only so Edit/Treatment can *replace lines* — the return document
itself can't be deleted from the app.

## Stage 2: Simple vs Advanced (per-line treatment)

One return can be finished by more than one person, at different times, with a
different credit note per line — the office asked for it after hitting exactly that.
So credit note and processor live on `returns_treatment_lines`, not only on the header.

| Mode | For | What it does |
|---|---|---|
| **Simple** (default) | most returns | The Credit note and Processed by boxes are **written onto every line**. One credit note, one person, one click — unchanged from before. |
| **Advanced** | split decisions | Line columns unlock. Tick lines and *Apply to selected*, or type straight into a line. Each line keeps its own note and name. |

**Values are written, never inherited.** Simple mode could have left the lines blank and
had readers fall back to the header, which is less code — but then every consumer (detail
view, CSV, log, any future report) has to recompute an "effective value", and they will
eventually disagree. Writing costs one assignment and makes each line self-describing.

**A line is ready when** it has a return status *and* a processor, plus a credit note
**only** when the status is `Accepted for Credit Assessment`. A refused return or a
disposed warranty never raises one, so demanding it there would strand the return.

**Complete is a property of the lines, not the clicker.** It is blocked until every line
is ready, and the button explains which are not. *Save progress* keeps `in_treatment` and
leaves the open lines for whoever picks it up — reopening a part-finished return lands in
Advanced, because Simple would overwrite someone else's lines the moment the next person
typed a name.

`returns_line_log` is append-only (INSERT policy only, no UPDATE/DELETE) — a credit note
gets corrected, and overwriting the field would erase the history that gets asked about.
The detail view renders it as sentences under the treatment table.

### What protects the data

Two people editing one return is now a normal flow, and the save **replaces every line**
rather than patching one — so the failure modes are about losing someone else's work, not
about a bad field value. What guards each of them:

| Risk | Guard |
|---|---|
| Closing with Cancel or × after typing | Unsaved-changes modal. The check compares only what a save would write, so ticking a line or switching mode never triggers it. |
| Clicking Simple with per-line values on screen | Mode switching only shows and hides columns. It never writes. The boxes cascade **as you type**, and only in Simple. |
| Reopening a return that already has different notes per line | Opens in Advanced, and the two boxes open blank — they are apply-tools there, not the record. |
| Someone else saved while your modal sat open | The save re-reads `updated_at` and refuses on a mismatch, telling you to reopen. It cannot merge, so it must not pretend to. |
| Double-click on Save / Complete | Re-entry flag plus both buttons disabled for the whole write. |
| The delete half of replace-lines failing | The insert is undone. PostgREST answers `204` even when a policy blocks the rows, so an unchecked delete meant every line silently doubled. |
| The log table missing or unreachable | Best-effort insert. A monitoring gap must never fail a save the office already believes went through. |
| Saving under someone else's name | The name is the saver's own and is always required. It is never borrowed from a line. |

Attribution runs one way only: `processed_at` is stamped when a line **first** becomes
ready and is never restamped, so finishing the other half of a return does not rewrite
when the first half was decided.

Migrations: `db/005_returns_line_treatment.sql` (per-line fields + the log) and
`db/006_returns_void_attribution.sql` (`voided_by` / `voided_at` / `void_reason` — the
void modal collected them but the columns did not exist, so every void failed). Both are
additive and nullable.

## How the market handles returns (RMA)

Standard lifecycle in WMS/ERP (NetSuite, Unleashed, Cin7, Shopify Returns, etc.):

1. **Return requested** — reason captured.
2. **RMA authorized** — approve, issue an RMA number (often skipped for walk-ins).
3. **Received & inspected** — physical receipt, per-line condition/disposition
   (Restock / Scrap / Repair / RTV = return-to-vendor / Quarantine).
4. **Financial resolution** — credit note / refund / replacement / warranty claim.
5. **Closed** (or **Voided** — kept, never deleted).

Core principles the good systems share, and how we sit against them:

- **Separation of duties** — receiving (what physically arrived) is a different
  responsibility from disposition (what it's worth / where it goes). ✅ We split
  this: Stage 1 = warehouse intake, Stage 2 = finance disposition.
- **Immutable receipt + audit trail** — once goods are received and the doc is
  printed/signed, the received record is *evidence* and is frozen; money is
  adjusted in a separate layer, not by rewriting the receipt. ✅ Stage 1 locks
  the moment treatment begins; the signed customer copy always matches the record.
- **Intake reason ≠ disposition** — why the customer returned it isn't the same
  as what we did with it. ✅ Per-line reason at intake; per-line "moved to" +
  credit at treatment.
- **Provisional vs settled value** — receipt value is provisional; credit value
  is decided later by finance. ✅ Stage-1 `line_value` frozen, treatment
  `line_value` editable; History shows the credit total.
- **Void, don't delete** — mistaken records are voided (kept for audit), not
  erased. ⚠️ We enforce never-delete but have **no Void status yet** (gap #1).

## Do we need BOTH Edit and Action? — yes, keep them separate

**Recommendation: keep Edit and Action as two distinct actions. Do NOT let
Action edit stage 1.**

- **Edit** is "fix the draft before it's processed" — pending only.
- **Action** is "process it" — stage 1 frozen as the receipt evidence.
- Letting Action silently rewrite stage 1 would break the audit trail: the
  customer already holds a signed copy of stage 1. If finance changes what was
  "received," the signed copy no longer matches the record → disputes, no
  accountability. **That separation is the control, not a limitation.**

If a genuine intake error is found *during* treatment, the correct pattern is a
correction note (treatment notes) or void+redo — not a silent stage-1 rewrite.
Our current behaviour already does the right thing (Edit vanishes at
`in_treatment`).

## Deliberate non-features

- **No Cin7 stock write-back.** Returns is a document/credit register, not a
  stock mutation. Given the pick-anomaly history where every "fix" corrupted
  Cin7 stock, keeping Returns read-only against Cin7 is intentional and safe.

## Backlog (worth adding later, not blocking)

1. **Void status** (`void` + reason + who) — close out mistaken returns without
   deleting. Highest-value gap.
2. **Standardized disposition** — dropdown (Restock / Scrap / RTV / Repair /
   Quarantine) alongside the free-text "moved to", for clean reporting on how
   much is restocked vs scrapped.
3. **Re-open completed** — allow finance to reopen a `completed` return back to
   `in_treatment` for a correction (logged), instead of it being terminal.
4. **Warranty routing** — a "Warranty" reason often means RTV (supplier claim),
   not a customer credit; could branch the treatment path.

## Verdict

The core is solid and matches how proper RMA systems work: audit-safe immutable
intake, finance disposition separated from receiving, never-delete. The two-action
model (Edit while pending, Action to treat) is correct — don't merge them. The
main things to add when there's time are a **Void status** and a **standardized
disposition dropdown**; stock write-back should stay off on purpose.
