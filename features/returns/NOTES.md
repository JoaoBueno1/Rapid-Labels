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
