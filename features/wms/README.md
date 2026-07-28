# Rapid WMS — Pick / Pack / Assembly on Cin7 Core

**Status: in development (dev branch). The handheld PWA is now reachable at `/wms`
(`http://localhost:8383/wms`) and the API at `/api/wms/*` — wired additively in
`server.js` (try/catch, no nav tile, no existing page touched). It is NOT yet linked from
any nav. Remaining prerequisite to be data-functional: deploy the `wms.*` Supabase schema
(see Activation). See the "Handoff" section at the bottom for exactly where we stopped.**

Our own warehouse-execution layer on top of Cin7 Core (Cin7 stays the ERP / source of
truth for total on-hand). We own the operator experience (PWA scanners), the in-progress
work state, and a disciplined write-once bridge to Cin7.

---

## Why this exists / what the live tests proved

Every Cin7 write below was **proven live** against real production sample orders before a
line of this feature was written (see `features/wms-spike/` for the raw probes). The
proven facts drive the whole design:

| Capability | Endpoint (keyed by TaskID) | Proven |
|---|---|---|
| Pick with an explicit source bin per line | `POST /sale/fulfilment/pick` `{TaskID, Status:"AUTHORISED", Lines:[{ProductID, SKU, Quantity, Location:"Main Warehouse: <bin>", LocationID:<binGUID>}]}` | ✅ |
| Pack (item → box) | `POST /sale/fulfilment/pack` — **line requires `Location`** | ✅ |
| Assembly recipe | `POST/PUT /finishedGoods/order` `{TaskID, Status:"AUTHORISED", OrderLines:[...]}` | ✅ |
| Assembly build w/ chosen component bins + complete | `POST/PUT /finishedGoods/pick` `{TaskID, Status:"COMPLETED", WIPAccount, Account, PickLines:[{ProductID, Quantity, BinID}]}` | ✅ |
| Create build container | `POST /finishedGoods` `{ProductID, Location, LocationID, Quantity, WIPAccount:"635", Account:"635"}` | ✅ |
| Split one sale's pick across two fulfilments/two users | multi-fulfilment | ✅ |

### Hard limits that shaped the architecture (cannot be engineered away)

1. **An AUTHORISED fulfilment cannot be edited or deleted.** `DELETE /sale/fulfilment`
   is a no-op (returns 200, does nothing). → We get **exactly one shot per fulfilment**.
   Everything before `AUTHORISED` lives in **our** DB; Cin7 is told only at the moment of
   commit. This is the single dominant rule: **physical truth first, then one clean write.**
2. **No server-side idempotency key on any Cin7 write.** A timeout + naive retry
   double-moves stock. → the **outbox** (`lib/outbox.js`) persists an operation key
   *before* every call and reconciles before any retry. Exactly-once is ours to guarantee.
3. **Cin7 auto-creates an assembly build linked to the sale.** Blindly POSTing our own
   consumes components twice. → the engine **adopts** the linked build if present, and
   creates one only when none exists.
4. **Produced FG is born with `Bin=null`.** → a build either feeds the same sale directly
   (reserved to it) or requires an explicit **putaway** step before it is pickable for stock.
5. **No packing-slip / document API** (all 404). → we print our own from pack data via the
   existing `features/label-sheets/label-render.js` PDF engine.
6. **Pack-with-cartons exists only on Advanced Sales.** Simple sales combine pick+ship. →
   every order we drive is forced to Advanced.
7. **Stock is a 10–15 min snapshot** (no `ModifiedSince` on availability). Bin suggestions
   can be stale → mandatory **scan-verify-before-authorise**, and we own a soft-reservation
   ledger so two operators are never sent to the same last unit.
8. **Only 30 % of SKUs have a real barcode.** Scanning resolves `barcode → SKU(CODE128)`,
   the identifier label-sheets already prints; 5DC is a human lookup only, never a scan key.

---

## Module map (dependency order)

```
db/001_wms_core.sql     the owned state: bins/pickface registry, waves, parcels, lines,
                        claims, builds, the OUTBOX (idempotency ledger), movement journal,
                        transfers. Schema: wms.*  (isolated from cin7_mirror.* and public.*)
lib/cin7-wms-client.js  thin Cin7 client for the PROVEN endpoints only, with the exact
                        validated payloads. No business logic.
lib/outbox.js           write-once orchestration: enqueue(op) → send() → confirm/reconcile.
                        The heart of exactly-once. Every Cin7 write goes through here.
lib/wms-engine.js       domain logic: build a Wave from a sale, split BOM vs normal lines,
                        line-level claims, recipe lookup, and the commit paths
                        (pick / build / pack) — all via the outbox.
lib/wms-transfers.js    bin↔bin and warehouse↔warehouse transfers on the proven
                        stockTransfer write (POST DRAFT → PUT COMPLETED), pausable sessions
                        for huge TRs, crash-safe DRAFT checkpoint through the outbox.
lib/wms-sync.js         populate the owned bin/pickface registry from cin7_mirror with the
                        cleanup gate (drop barcode-named/branch-code junk, classify bin_type).
lib/reconciler.js       drain ambiguous 'sent' / 'failed' outbox rows against live Cin7 —
                        completes exactly-once (a timeout that actually landed is reconciled,
                        never blindly re-sent). Run every ~60s once live.
routes/wms-routes.js    Express API. registerWmsRoutes(app, supabaseBackend). Mounted under
                        /api/wms/*. Wired in server.js; NOT added to any nav tile.
lib/wms-receiving.js    PO receiving: read a purchase's expected lines, then putaway each
                        into a bin (from the receiving dock) via the proven stockTransfer +
                        outbox. The PO-receipt write itself stays in Cin7 (out of scope).
pwa/                    the HANDHELD PWA (scanner-first) for pickers + stock staff:
                        home (open-orders list) · wave · pick · assembly/production ·
                        stock-lookup · transfer · receive (PO putaway) · ops (outbox +
                        movements audit). Scans resolve barcode→SKU→5DC server-side via
                        /api/wms/resolve/:code. Served at /wms (mounted in server.js).
                        NOTE: pack is NOT here — it is a separate DESKTOP page for packers
                        (open picked orders → authorise pack → print slip → booking). The
                        commitPack engine/route stay in the backend for it (not built yet).
```

## The large-order, two-user flow (the thing this is built for)

A big Advanced sale with BOM/assembly lines + normal lines:

1. **Ingest** → engine builds a **Wave**, splits lines into an **assembly parcel** (BOM
   lines) and a **pick parcel** (normal lines). Both are **DRAFT in our DB — zero Cin7
   writes yet**.
2. **Production user** claims + opens the assembly parcel, scans each component from the
   bin they physically took it from (editable/re-scannable draft), then **completes the
   build** — the engine adopts-or-creates the Cin7 finishedGoods build and commits it once
   through the outbox. Produced FG is reserved to this sale.
3. Production **SAVES** → authorises **only the assembled lines** into **fulfilment A**.
   The normal lines are untouched and still claimable.
4. **Picker** resumes the wave, claims the normal lines, scans them from their bins, and
   commits to a **separate fulfilment B**.
5. **Pack** (per fulfilment): scan-verify items into cartons, capture dims in our DB, push
   pack to Cin7, print our own slip.

The cross-user "save" is **never** a half-authorised Cin7 fulfilment (those can't be
edited). All handoff/claim/draft state is in `wms.*`; our layer is the sole concurrency
authority because Cin7 offers none.

## Guarantees the outbox enforces

- **Write-after-confirm:** a Cin7 write is only enqueued after the operator confirms the
  physical action on a scan-verified parcel.
- **Exactly-once:** an op-key is persisted `pending` before the HTTP call; on any
  ambiguity (timeout) the reconciler checks Cin7 + `cin7_mirror.stock_movements` before a
  retry, so stock never double-moves.
- **Append-only journal:** every committed move is written to `wms.movements` with the
  actor, op-key, and Cin7 reference — the auditable record Cin7 itself can't fully give us.

## Activation status

- [x] **Routes wired** — `server.js` calls `registerWmsRoutes(app, supabaseBackend)` and
      mounts the PWA folder at `/wms` (try/catch, additive). `/api/wms/health` returns ok.
- [x] **PWA reachable** — open `http://localhost:8383/wms` (redirects to `/wms/`, assets
      resolve under that mount). NOT linked from any nav tile yet — intentional.
- [ ] **Apply the schema** — run `db/001_wms_core.sql` on Supabase (SQL editor or psql).
      **This is the remaining blocker: until done, the shell loads but `/open`, `/wave`,
      etc. error with `relation "wms.*" does not exist`.**
- [ ] **Expose the schema** — Supabase → Settings → API → *Exposed schemas* → add `wms`
      (same as `cin7_mirror`). The service-role client uses `.schema('wms')`.
- [x] **Env** — `CIN7_ACCOUNT_ID` / `CIN7_API_KEY` set; Supabase service key present
      (`/api/wms/health` confirmed). Optional overrides: `WMS_MAIN_WAREHOUSE_ID`,
      `CIN7_WIP_ACCOUNT` / `CIN7_ASSEMBLY_ACCOUNT` (default `635`), `WMS_PRODUCTION_BIN`
      (`MA-PRODUCTION`), `WMS_RECEIVING_BIN` (`MA-DOCK`).
- [ ] **Link from nav** — add a tile to `index.html` only when you want it visible to users.

## Roadmap / status

**Done**
- Owned state schema + outbox (exactly-once) + append-only journal.
- Pick with chosen bin, pack, assembly/kitting (adopt-or-create) — proven live.
- Large-order two-user flow (assembly parcel + pick parcel, multi-fulfilment).
- Transfers (bin↔bin, warehouse↔warehouse) on the proven stockTransfer write, pausable.
- Bin/pickface sync with the cleanup gate; outbox reconciler.
- Receiving putaway (`lib/wms-receiving.js`) + PWA **receive** screen.
- PWA: home (open-orders list) · wave · pick · assembly · stock-lookup · transfer ·
  receive · ops. Scans resolve barcode→SKU→5DC server-side. Pack is **not** a PWA screen.
- Wired at `/wms` + `/api/wms/*` in `server.js` (additive, isolated).

**Maintenance jobs to schedule once live** (cron / interval):
- `POST /api/wms/sync/bins` + `/sync/pickface` — refresh the registry (e.g. hourly).
- `POST /api/wms/reconcile` — drain ambiguous outbox rows (e.g. every 60s).

**Next (2-week horizon)**
- **Deploy the `wms.*` schema** (the current blocker — see Activation / Handoff).
- **Desktop pack-station page** for packers (picked orders → authorise pack → print slip →
  booking). Backend (`commitPack` + `/api/wms/commit/pack`) exists; the page does not.
- Our own **packing slip** PDF (reuse `features/label-sheets/label-render.js`).
- **Cycle count** for the ~0.34% hard divergence.
- **Ship** write-back + a thin **TMS** boundary (ShipmentRequest/Result) — out of scope now.
- Box-dimension persistence into Cin7 pack (dims already captured in our DB regardless).

---

## Handoff — where we stopped (continue on another PC)

Last worked: 2026-07-28, dev branch. Latest relevant commits: `6801559` (wire PWA at
`/wms` + receive/ops screens), building on `db77326` (transfers + sync + reconciler).

**State right now**
- PWA + API fully built and wired at `/wms` and `/api/wms/*`. Smoke-tested: `/wms` serves,
  CSS/JS load (200), `/api/wms/health` → `{"ok":true}`. No existing page touched.
- Feature is on **dev**, pushed. Not linked from any nav (intentional).
- Pack is backend-only by design; the desktop pack page is **not** built.

**The one thing blocking a live end-to-end run**
- The `wms.*` Supabase schema is (probably) **not deployed**. `/health` doesn't touch the
  DB, so it passes regardless. Opening a real order will error until the schema exists.

**To resume on the other PC**
1. `git pull` on the **dev** branch.
2. `.env` must have `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CIN7_ACCOUNT_ID`,
   `CIN7_API_KEY` (this file is git-ignored — copy it over, it does NOT travel with git).
3. Deploy the schema: run `db/001_wms_core.sql` in Supabase, then expose the `wms` schema
   (Settings → API → Exposed schemas). *(Verify first — it may already be deployed.)*
4. `node server.js` → open `http://localhost:8383/wms`.
5. Seed the owned registry once: `POST /api/wms/sync/bins` then `POST /api/wms/sync/pickface`.
6. Then test a real order via the home open-orders list (scan/type an `SO-…`).

**Immediate next tasks (in priority order)**
1. Confirm/deploy the `wms.*` schema and run one real order end-to-end (pick + assembly).
2. Build the **desktop pack-station page** (picked orders list → authorise pack → print
   packing slip → booking/TMS handoff).
3. Schedule the maintenance jobs (sync + reconcile) once it's live.
