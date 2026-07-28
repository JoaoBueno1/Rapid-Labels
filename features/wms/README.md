# Rapid WMS — Pick / Pack / Assembly on Cin7 Core

**Status: in development (dev branch). The handheld PWA is at `/wms`
(`http://localhost:8383/wms`), the desktop **Pack Station** at `features/wms/pack/pack.html`,
and the API at `/api/wms/*` — all wired additively in `server.js` (try/catch, no existing
page touched). The `wms.*` Supabase schema is now **deployed and exposed**; the API is
**live** (server restarted 2026-07-29, `/api/wms/pack/open` returns real business errors,
not 404). It is deliberately **NOT linked from any nav** — the Pack Station tile was pulled
from `index.html` on 2026-07-29 (we're not using it in production yet). See the "Handoff"
section at the bottom for exactly where we stopped and what to continue.**

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
- [x] **Apply the schema** — `db/001_wms_core.sql` ran on Supabase (SQL editor); the
      `wms.*` tables exist. **This was the old blocker — now done (2026-07-29).**
- [x] **Expose the schema** — done via SQL Editor (the dashboard "Exposed schemas" UI did
      **not** match the live PostgREST list, so it didn't apply). The reliable fix that
      worked: `alter role authenticator set pgrst.db_schemas = 'public, graphql_public,
      cin7_mirror, rapid_inv, wms'; notify pgrst, 'reload config';`. ⚠️ **Keep `cin7_mirror`
      and `rapid_inv` in that list** or Open Orders / Label Sheets / Pick Anomalies break.
- [x] **Env** — `CIN7_ACCOUNT_ID` / `CIN7_API_KEY` set; Supabase service key present
      (`/api/wms/health` confirmed). Optional overrides: `WMS_MAIN_WAREHOUSE_ID`,
      `CIN7_WIP_ACCOUNT` / `CIN7_ASSEMBLY_ACCOUNT` (default `635`), `WMS_PRODUCTION_BIN`
      (`MA-PRODUCTION`), `WMS_RECEIVING_BIN` (`MA-DOCK`).
- [ ] **Link from nav** — intentionally **not** linked. The Pack Station tile was added and
      then **removed from `index.html` on 2026-07-29** (not used in production yet).
      Re-add the tile in Warehouse Ops when ready to go live.

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

## Handoff — where we stopped (2026-07-29)

Last worked: 2026-07-29, dev branch. Pack-Station commits: `c506239` (desktop page +
pack-ready/assign routes), `a5b70a9` (redesign to the Returns design system, scan-first,
guided sections), `911d53b` (SO-driven entry + pack orders not-yet-picked in the WMS).

**State right now — activation is essentially DONE, we're at first-real-order testing**
- PWA + API + **desktop Pack Station** built and wired. `wms.*` schema **deployed and
  exposed**; server **restarted**, `/api/wms/*` **live**. `/api/wms/health` → `{"ok":true}`.
- Pack Station (`features/wms/pack/pack.html`): SO-driven landing (type/scan an `SO-…` →
  `POST /api/wms/pack/open` → workspace) → scan items (resolves a 13/14-digit barcode **and**
  the SKU-as-CODE128 e.g. `R1021-WH-TRI`, case-insensitive, client-side from a
  `cin7_mirror.products` pre-fetch) → cartons/dims → **Authorise pack** (via outbox) → print
  slip → **Send to booking (TMS handoff = STUB, not wired yet)**. Also packs orders **not**
  picked in the WMS (button reads "Pick & pack" vs "Authorise pack").
- **Nav tile REMOVED from `index.html` (2026-07-29)** — not used in production yet. The page
  still works by URL; re-add the Warehouse-Ops tile when going live.

**What the first real test showed (the current gap, not a bug)**
- `POST /api/wms/pack/open` for a **Simple Sale** returns HTTP 400:
  `"… is a Simple Sale. Only Advanced Sales support the pack step — set it to Advanced in
  Cin7."` (`wms-engine.js:40`). This is by design: our pick/pack writes to Cin7
  **fulfilment tasks** (`/sale/fulfilment/{pick,pack}`, keyed by TaskID), which **only
  Advanced Sales have** — a Simple Sale collapses pick+ship into one step with no task.
- **Open decision before volume testing:** are the real outbound orders Simple or Advanced
  in Cin7? If mostly Simple, either default WMS-driven sales to Advanced, or build a separate
  "ship a Simple Sale" path (no pick/pack task → less control; not recommended as default).

**To resume**
1. `git pull` on **dev**; `.env` present (git-ignored — `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `CIN7_ACCOUNT_ID`, `CIN7_API_KEY`).
2. `node server.js` (full node path on this PC:
   `C:\Users\JoaoMarcos\.fnm\node-versions\v24.13.1\installation\node.exe server.js`).
3. In Cin7, take an **Advanced Sale** (ideally not-yet-picked) → open it in the Pack Station
   by URL → scan → Authorise. ⚠️ Authorising a real order = **real Cin7 writes** (pick+pack,
   moves stock); the confirm warns.

**Immediate next tasks (in priority order)**
1. Decide the Simple-vs-Advanced default (see gap above) and run one real Advanced Sale
   end-to-end through the Pack Station.
2. **Wire "Send to booking"** to the TMS booking screen (Rapid-Express-Web repo) — carry
   `SO#` / customer / cartons+dims into the booking flow. Currently a JS `alert` stub.
3. Persist box dims into the Cin7 pack (dims are captured in our DB only today).
4. Re-add the Warehouse-Ops nav tile when ready to expose it to users.
