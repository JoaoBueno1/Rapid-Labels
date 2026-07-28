# Rapid WMS — Pick / Pack / Assembly on Cin7 Core

**Status: in development (dev branch). NOT wired into the live app — no nav button, no
home tile. The routes are self-contained and the PWA page is unlinked. Nothing here
touches an existing feature.**

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
                        line-level claims, and the commit paths (pick / build / pack /
                        transfer) — all via the outbox.
routes/wms-routes.js    Express API. registerWmsRoutes(app, supabaseBackend). Mounted under
                        /api/wms/*. NOT added to any nav.
pwa/                    the operator PWA (scanner-first): pick, assembly/production, pack,
                        transfer, stock-lookup. wms.html is unlinked.
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

## Activation (when ready — NOT done yet, keeps the feature dark)

1. **Apply the schema:** run `db/001_wms_core.sql` on Supabase (SQL editor or psql).
2. **Expose the schema:** Supabase → Settings → API → *Exposed schemas* → add `wms`
   (same as `cin7_mirror` is exposed). The service-role client uses `.schema('wms')`.
3. **Wire the routes** — add one line to `server.js` near the other feature routes:
   ```js
   const { registerWmsRoutes } = require('./features/wms/routes/wms-routes');
   registerWmsRoutes(app, supabaseBackend);
   ```
4. **Open the PWA** at `/features/wms/pwa/wms.html` (already served statically; just not
   linked from any nav — add a tile to `index.html` only when you want it live).
5. **Env:** `CIN7_ACCOUNT_ID` / `CIN7_API_KEY` are already set. Optional overrides:
   `WMS_MAIN_WAREHOUSE_ID`, `CIN7_WIP_ACCOUNT` / `CIN7_ASSEMBLY_ACCOUNT` (default `635`).

Until steps 3–4 are done, none of this is reachable from the running app.

## Not built yet / next (2-week horizon)
- TMS boundary (ShipmentRequest/Result) — intentionally out of scope now.
- Ship step write-back (we stop at pack for now).
- Multi-warehouse bin onboarding UI (schema is multi-warehouse-shaped from day one).
- Box-dimension persistence into Cin7 pack (dims are captured in our DB regardless).
