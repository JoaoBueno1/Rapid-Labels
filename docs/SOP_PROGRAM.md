# SOP Programme — Rapid LED systems

**Status:** planning · not started
**Created:** 2026-08-12
**Scope:** all three systems — Rapid Express Web (TMS), Rapid Labels, RapidExpress Driver app
**Lives here because** Rapid Labels is the system closest to the floor staff who will use most of these SOPs.
The other two repos hold their own `DEAD_CODE_REGISTER.md`, `RUNBOOKS.md` and `BUSINESS_RULES.md`.

---

## 1. Why this document exists

A full inventory of the three systems (12 Aug 2026) found **741 distinct capabilities**, of which **396 are live
and in use**. Writing an SOP for each one would produce several hundred pages that nobody reads and that go stale
within a quarter. Stale documentation is worse than none, because someone follows a step that no longer exists.

This document fixes the scope: **which SOPs get written, in what order, and — just as importantly — what will
deliberately never be documented.**

---

## 2. The filter

A capability only becomes an SOP if it passes **all four** tests.

| # | Test | Question |
|---|---|---|
| 1 | Human | A person performs it — it is not a background job |
| 2 | Recurrent | It happens weekly or more often |
| 3 | Costly if wrong | Getting it wrong costs money, stock, or a customer |
| 4 | Shared | More than one person does it, or the person who does it could leave |

Applying the filter to the 396 live capabilities leaves **25 SOPs**.

**Never document:**

- Anything in `DEAD_CODE_REGISTER.md` — it gets deleted, not written up.
- Anything not yet in production (WMS, Pack Station, Container Builder, Rapid Inventory, Excel Sync delivery,
  Today Orders V2). Document on the day it goes live, not before.
- Anything switched off behind a flag — one line in the catalogue is enough.
- Developer and maintenance tooling — that belongs in `RUNBOOKS.md`.
- Live capabilities with near-zero usage. **Decide whether they stay before writing anything.**

---

## 3. Format

Keep the existing house style. Two models are already published and both work:

| Model | Example | Use it for |
|---|---|---|
| **Process Quick SOP** | `Returns_feature_SOP.pdf` (2 pages) | A task that moves through stages and hands off between people. Stage strip → numbered steps → quick reference of the vocabulary |
| **Decision Quick SOP** | `Rapid_LED_Operations_Quick_SOP_Container_Arrival.pdf` (1 page) | A judgement call. Ordered checks → the decision table → key rules → one-line summary chain |

Rules for every SOP:

- **One or two pages.** If it needs three, it is two SOPs.
- **Rapid LED masthead**, title, subtitle, version and month. Version bumps on every change.
- **Business language.** No file paths, no endpoint names, no table names.
- **Name the screen and the button** exactly as the user sees them.
- **Footer:** "Something unclear? Send it back and we'll fix the guide."
- Store the source and the PDF together. Publish PDF to the shared `SOP's` folder.

---

## 4. The 25 SOPs, by wave

Ownership column = who the SOP is written *for*, not who writes it.

### Wave 1 — daily and money-touching (8)

| # | SOP | System | Audience | Why first |
|---|---|---|---|---|
| 1.1 | Close the carrier manifest (Direct Freight and StarTrack) | TMS | Office | Daily ritual; a missed close leaves freight unmanifested and unbilled. Must cover what to do with an order booked after the day's close |
| 1.2 | Book a consignment and choose the carrier | TMS | Office | The single highest-value decision made in the business, many times a day. Must state when *not* to take the cheapest quote |
| 1.3 | Edit or cancel a booked order | TMS | Office | Wrong handling means we pay for freight we did not send. Must cover the case where the carrier refuses |
| 1.4 | Reconcile a carrier invoice | TMS | Office / finance | Import → review → dispute → credit. This is the cash-recovery loop |
| 1.5 | Act on a Proximity Alert | TMS | Dispatch | Time-limited: the saving disappears if not actioned the same day |
| 1.6 | Work the Stuck and Open Orders queues | TMS | Office | Prevents a customer finding a problem before we do |
| 1.7 | Run branch replenishment | Labels | Office | Drives every inter-branch transfer and therefore a large freight bill |
| 1.8 | Restock the pick face | Labels | Warehouse | Done every day by more than one person, entirely by convention today |

### Wave 2 — warehouse (7)

| # | SOP | System | Audience | Notes |
|---|---|---|---|---|
| 2.1 | Register and hand over a customer collection | Labels | Warehouse | 4,500+ handled; signature is the proof of handover |
| 2.2 | Process a customer return | Labels | Warehouse + office | **Already written (v1.2).** Needs updating — Void is broken in production |
| 2.3 | Container QC on receiving | Labels | Warehouse | Replaces the old spreadsheet; adoption is still low, so the SOP is also the rollout |
| 2.4 | Review a pick anomaly | Labels | Supervisor | **Must state explicitly when NOT to press Fix.** See `BUSINESS_RULES.md` |
| 2.5 | Print a label — which tool for which job | Labels | Warehouse | Three separate label paths print different codes. This is a live source of confusion |
| 2.6 | Build an A4 label sheet | Labels | Warehouse | Print-at-100% is a hard requirement or the stickers misalign |
| 2.7 | Run a physical count | Labels | Warehouse | Count sheets, reserve vs pick face, what to do with a variance |

### Wave 3 — dispatch and drivers (5)

| # | SOP | System | Audience | Notes |
|---|---|---|---|---|
| 3.1 | Build and optimise a van run | TMS | Dispatch | Pins, grouping, run settings, ordering |
| 3.2 | The run lock — what changes once the driver leaves | TMS | Dispatch | Add and remove are allowed; reordering is not. Exists because of a real incident |
| 3.3 | The driver's day | App | Driver | Load check → drive → deliver → proof → finish run. The onboarding document for a new driver |
| 3.4 | When the app goes offline | App | Driver | What still works, what to expect, what not to do (do not clear cache with unsent proof) |
| 3.5 | Add a stop to a run already on the road | TMS | Dispatch | Includes what the driver sees and does not see |

### Wave 4 — administration (5)

| # | SOP | System | Audience | Notes |
|---|---|---|---|---|
| 4.1 | Create a user and choose the right role | TMS | Admin | Seven roles; the wrong one either blocks someone or over-exposes data |
| 4.2 | Add or change a branch | TMS | Admin | The branch address becomes the sender on every label and every quote |
| 4.3 | Add a suburb to a van's coverage | TMS | Manager | **This is what makes the van appear as a quote option.** Highest-impact admin action in the system |
| 4.4 | Register a driver and issue app credentials | TMS | Admin | Links the fleet record to the mobile login |
| 4.5 | Enable a carrier for a branch | TMS | Admin | Without it the branch cannot quote or book that carrier at all |

---

## 5. Sequencing and effort

Do not attempt the programme in one block. One SOP is roughly half a day including review with the person who
does the job.

| Wave | SOPs | Suggested window |
|---|---|---|
| 1 | 8 | Highest priority — start here |
| 2 | 7 | Follows wave 1 |
| 3 | 5 | Can run in parallel with wave 2 (different audience) |
| 4 | 5 | Lowest urgency — low frequency, single audience |

**Precondition for waves 1 and 2:** finish `BUSINESS_RULES.md` in each repo first. Several SOPs are unwritable
until the rules behind them are recorded — you cannot document "when not to take the cheapest quote" without
first writing down the routing rules.

---

## 6. What is *not* an SOP but is still needed

The SOP programme is one of four documentation layers. Do not let it absorb the other three.

| Layer | File | Audience | Purpose |
|---|---|---|---|
| 1. System catalogue | `Rapid-Express-Web/docs/SYSTEM_CATALOGUE.md` + the CEO-facing HTML | Management, board | What exists and what is actually used |
| 2. Quick SOPs | this programme | Operations | How to do the job |
| 3. Runbooks | `RUNBOOKS.md` in each repo | Whoever maintains the systems | What to do when something breaks |
| 4. Business rules | `BUSINESS_RULES.md` in each repo | The company | The decisions the software makes, and why |

**Layer 4 is the highest-risk gap and should be completed before the SOPs.** The rules currently exist only in
code and in one person's memory: why StarTrack is withheld at the Sydney branch address, why Phoenix is preferred
inside its zone, why fast movers hold 8–10 weeks of cover, why Returns never writes stock into Cin7. Code records
*what*; it does not record *why*. If that knowledge is lost, nobody can safely change any of it.

---

## 7. Progress

| Wave | Written | Reviewed | Published |
|---|---|---|---|
| 1 | 0 / 8 | — | — |
| 2 | 1 / 7 (Returns, needs update) | — | Returns v1.2 |
| 3 | 0 / 5 | — | — |
| 4 | 0 / 5 | — | — |

Update this table as SOPs land.
