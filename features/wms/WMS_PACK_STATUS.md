# Rapid WMS + Pack — where we stopped

_Last updated 2026-07-29 (dev branch). Read `features/wms/README.md` for the deeper
architecture; this file is the practical "where we are / what's next"._

## The shape of it

- **Handheld PWA** at `/wms` (`features/wms/pwa/`, single-file SPA `wms-app.js`) —
  scanner-first, light "Cin7-WMS-style" theme (slate top bar, teal accents, squarish
  cards). Home is a **menu of 4 options**:
  - **Pick** — open a sales order and pick its items.
  - **Transfer (TR)** — scan an ordered stock transfer and pick it.
  - **Bin transfer** — guided bin→bin move.
  - **Stock lookup** — find a SKU across bins.
- **Pack Station** — a **desktop** page (`features/wms/pack/`), not in the PWA. Nav
  tile in `index.html` is currently **removed** (not used in production yet); the page
  still works by URL.
- **API** `/api/wms/*` (`routes/wms-routes.js`), engine `lib/wms-engine.js` +
  `lib/wms-transfers.js`, Cin7 client `lib/cin7-wms-client.js`, exactly-once
  `lib/outbox.js`. Schema `wms.*` (`db/001_wms_core.sql`) is deployed + exposed.
- **Live Cin7 writes are OFF by default** (`WMS_WRITE_ENABLED` unset). Read/draft
  flows (open order, pick list, scan-to-draft, lookup, TR open) are always on; the 7
  stock-moving endpoints return `403 {wmsWriteDisabled:true}` until the flag is set.

## End-to-end flows

### Pick (sales order)
`Home → Pick → scan/type SO → pick list → pick each card → Finish`
- **Only Advanced Sales** can be picked (Cin7 pick/pack tasks exist only on Advanced).
  A Simple scan is rejected with a clear message. **No auto-convert** — operators
  already set Advanced when an order needs the warehouse (data: 44.7% of open orders
  are Advanced, ~270 in the queue; 3% of *new* orders are Advanced).
- `buildWave` reads the sale, detects **assembly lines from the mirror**
  (`products.stock_locator` = BOM/PRODUCTION — the company convention; ~12s, not the
  60-110s the old per-line Cin7 calls took) and stages a draft build + components.
- **Unified pick list**: normal lines + **assembly components expanded inline** (each
  a normal-looking card tagged `for <FG>`, its own build qty). Sorted alphanumerically.
- Each card shows the **pickface** (`stock_locator`) = "pick from MA-…". Focused pick
  = separate **Bin → Product → Quantity** fields: the bin must match the pickface (no
  random bins), the product scan is mandatory, qty is typeable/scan-incremented and
  capped at the need, other bins are consultative only. Reaching the need auto-saves +
  the card goes green. Back prompts **Save / Discard** (unsaved = reset; saved =
  resumable by another operator; all scans logged in `wms.scans`).
- **Finish** → `finalize`: builds each FG (with a `Created as an assembly for sale
  order #SO-… by WMS (operator)` note) then picks everything — one clean commit via
  the outbox. Everything is draft until Finish, so an abandoned pick leaves **zero
  Cin7 footprint**.

### Transfer (TR)
`Home → Transfer (TR) → scan/type TR → pick list → pick each → Dispatch`
- `POST /tr/open` reads the ordered TR's `Order.Lines`, adopts it into
  `wms.transfers` + `transfer_lines` (with pickfaces), and **reuses the pick screen**.
- `Dispatch` → advances the TR **ORDERED → IN TRANSIT** (`cin7.dispatchTransfer`).

### Bin transfer (guided)
`Home → Bin transfer → step 1 FROM (scan bin + products + qty) → step 2 TO (scan bin)
→ Commit` — one bin→bin `stockTransfer`.

## Status

**Done + verified (read + draft-persist, headless, 0 errors):**
- PWA (all 4 screens), light Cin7-style theme, focused-pick guardrails.
- `buildWave` (fast), unified pick list, component inline, pick/component scan persist
  (multi-user), TR open/read (TR-47603 = Main Warehouse → Gateway), bin-transfer steps.
- Fixed a latent bug: `cin7.getTransfer` used `stockTransfer?ID=` (400s) → `?TaskID=`.

**NOT yet live-tested — these are the ONLY real Cin7 writes; do WITH Joao on a small
chosen order/TR:**
1. **`finalize`** (SO build + pick). Watch the produced-FG pick source (it picks the
   FG from `putaway_bin` = MA-PRODUCTION — verify the putaway→pick timing in Cin7).
2. **`tr-dispatch`** (TR → IN TRANSIT). The IN TRANSIT API call
   (`PUT stockTransfer Status:'IN TRANSIT' + picked Lines`) is a **best guess** —
   this is the one most likely to need adjusting.
3. **Bin transfer commit** (bin→bin `stockTransfer`).

**Hardening done 2026-07-30 (safe, no live Cin7 write involved):**
- **Write kill-switch** — the 7 stock-moving endpoints (`receive`, `commit/pick`,
  `finalize`, `commit/build`, `commit/pack`, `commit/transfer`, `tr-dispatch`) are
  gated behind `W()` and 403 unless `WMS_WRITE_ENABLED=true`. Verified both ways
  locally (OFF → 403, ON → handler runs).
- **Outbox concurrent-safety** — `outbox.execute` now claims `pending→sent` with an
  atomic compare-and-swap (`.eq('status', loaded)`); a same-`op_key` double-submit
  loses the race and bails instead of issuing a second Cin7 write. Single-worker
  behaviour unchanged.
- **Reconciler** now knows `tr_dispatch` (was missing) so a timed-out TR dispatch that
  actually landed can be drained, not stranded at `sent`.
- **Pick guard** — `commitPick` throws if a scanned line's bin never resolved to a
  Cin7 `LocationID`, instead of silently picking from the warehouse root.

**Still TODO before go-live:**
- **Auth** on `/api/wms/*` — there is none (only a spoofable `X-WMS-User`). On the
  public Vercel URL the kill-switch is what keeps writes safe; add a real gate (shared
  secret / session) before turning writes on outside a supervised test.
- **Schedule** the reconciler (`POST /api/wms/reconcile`, ~60s) + registry sync
  (`/sync/bins`, `/sync/pickface`) — nothing runs them yet; do it via a GitHub Action
  (serverless `setInterval` is unreliable), and only after auth lands.
- Populate the pickface registry (`POST /api/wms/sync/bins` + `/sync/pickface`) — both
  read the mirror only (no Cin7 write); today suggestions fall back to `stock_locator`.
- Wire Pack Station "Send to booking" to the TMS (SO#/cartons/dims) — today an
  `alert()` stub; carton dims are also not yet persisted server-side.
- Non-Main-origin TRs have no bins/pickface (only Main has bins in Cin7).

**Behaviour to validate DURING the first supervised write (don't fix blind):**
- `commitPick` POSTs a new fulfilment when we have none; the proven spike adopted an
  existing one — check the sale's fulfilment count first (duplicate-fulfilment risk).
- `commitBuild` writes the recipe with `Quantity:1` per component — correct only for
  1:1 BOMs; pick a 1:1 FG first (e.g. the spike-proven one), defer multi-per-unit kits.
- `tr-dispatch` IN TRANSIT payload (`SkipOrder:true`, `DepartureDate`, picked lines) is
  a best guess — first diff it against a real IN-TRANSIT TR read (see runbook).
- `recordTrScan` overwrites the ordered qty with the scanned qty — a short-pick is
  silently swallowed; decide the policy before trusting dispatch.

## Multi-operator claim + richer lookup (built 2026-07-30 — gated / inactive)
- **Order-level claim + lease** (analysis item #1): opening an SO/TR claims it for the
  operator with a 10-min lease + 60s heartbeat; a second picker on the same order is
  turned away ("Being picked by <name>"). A dead session's lease expires and frees the
  order. **Gated by `WMS_CLAIMS_ENABLED`** (default off) — until it's on, the flow is the
  same single-operator flow. Needs migration `db/002_wms_claims.sql` run in the Labels
  Supabase SQL Editor first (additive nullable columns on `waves` + `transfers`). Logic
  unit-tested 10/10 (claim, reject-held, heartbeat, lease-takeover, release, off=no-op).
  `WMS_LEASE_MIN` overrides the 10-min lease.
- **Stock lookup** (analysis item #3): shows **physical on-hand per bin** as the primary
  number, Cin7 "available" separately (it can include buildable units), and for an
  assembly SKU the **BOM components + how many are buildable**. Read-only; always on.
- **Assembly (item #2): left as-is by decision** — always build from fresh components;
  do NOT consume pre-built FG on-hand (could be an error/return; provenance unverifiable).
- Still to build (careful, gated): #4 reserved-stock guard, #6 pick-exception surface,
  #7 reconciler/sync scheduling, #5 Pack→Booking→Ship (TMS). Auth/login = future (the
  claim `user` is still just the `X-WMS-User` header — no login screens yet, by request).

## Pack → Booking → Ship (#5) — safe deep-link slice BUILT 2026-07-30
The full server-to-server booking is NOT easy (details below); the safe slice is shipped.

**Built (A):** Pack "Send to booking" now opens
`<TMS>/book-order?use_flask=1&ref=<SO>&parcels=<json>&src=wms-pack` in a new tab. The TMS
reads `?ref` → its existing Cin7 lookup (`searchCin7Order`) fills customer + address;
`?parcels` pre-fills the packed cartons; the operator rate-shops + picks a carrier IN the
TMS (its quote + AusPost validation stay authoritative). No new TMS booking auth, no Cin7
write. It's one additive JS hook in `static/js/book_order.js` `initBookOrderPage()` (fires
only with `?ref`/`?parcels`; the prod quote/book/dispatch flow is untouched). TMS base
defaults to https://www.rapidexpress.com.au (override `localStorage.rapidExpressWebBaseUrl`);
the operator must already be logged into the TMS. Carton dims now persist via POST
`/api/wms/pack/boxes` → `wms.parcels.boxes` (migration `003_wms_pack_boxes.sql`, additive;
best-effort — reports `persisted:false` until the migration is run, deep-link works anyway).

Why the FULL "book from the WMS" chain is deferred (separate, careful TMS pass):
- The TMS has a clean, framework-agnostic `book_shipment()` / `BookingService.book()`
  (Rapid-Express-Web `src/services/booking.py`) returning consignment + tracking + base64
  label. BUT the real booking + quote endpoints are **session-cookie only**
  (`@login_required`); the one api-key route (`/api/v1/book`) creates an internal order,
  no carrier call. So the Labels Node server can't book today without a headless login OR
  a NEW api-key route wrapping `book_shipment()` + branch binding (`ApiKey` has no
  `branch_id`). Booking is prod-critical — wrap it, never modify orders_booking/carriers.
- Cin7 "Ship" write-back (`PUT /sale/fulfilment/ship` + `AddTrackingNumbers`) is proven
  but DORMANT: the code is only in TMS `git stash@{0}` (not committed to dev/main), and
  the Labels WMS client has no ship method. It would be the first Cin7 write from that
  path → must be async + queued.
- Pack lacks: a carrier/service choice (no rate-shop step), contact phone/email, and a
  persisted carton-dims column (dims live only in browser + `outbox.payload` JSON; the
  `commitPack` "persist dims for the TMS" comment is inaccurate — it doesn't).
- To book server-to-server FROM the WMS later: a NEW api-key/token-authed TMS route
  wrapping `book_shipment()` (`src/services/booking.py`) + branch binding on the `ApiKey`
  model (today's booking endpoints are session-cookie only). Wrap it — never modify
  orders_booking/carriers (prod-critical).
- Then the Cin7 "Ship" write-back (`PUT /sale/fulfilment/ship` + `AddTrackingNumbers`):
  revive the TMS `git stash@{0}` code, commit behind `CIN7_WRITEBACK_ENABLED`, run async
  post-booking behind a queue (this is the first Cin7 write from that path).

## Running it
- Server: `node server.js` (full node path on the office PC:
  `C:\Users\JoaoMarcos\.fnm\node-versions\v24.13.1\installation\node.exe server.js`).
- PWA (local/LAN): `http://localhost:8383/wms` or `http://<LAN-IP>:8383/wms` (handheld
  on the same Wi-Fi). Pack: `.../features/wms/pack/pack.html`. `.env` has `SUPABASE_*`
  + `CIN7_*`.
- **Production (Vercel)**: `vercel.json` now rewrites `/wms` → the PWA and `/pack` →
  Pack Station, and `/api/:path*` → the Express app; `maxDuration` is 60s. So the prod
  URLs are `https://<domain>/wms` and `https://<domain>/pack`. Heavy writes (`finalize`
  fires 8-15 sequential Cin7 calls) can still exceed 60s under rate-limit backoff —
  prefer the local/LAN server for the first live writes, or split `finalize` into
  per-parcel `commit/build` + `commit/pick`.

## Test-day runbook (when ready — WITH Joao, writes still gated)
All prep steps below touch **zero** Cin7 writes; only the final step enables them.
1. **Read-only smoke** (flag OFF): `GET /api/wms/health` → `{ok:true}`; open a known
   **Advanced** SO in Pick and in Pack; walk a TR open; run a Stock lookup. Confirm the
   draft rows in `wms.waves/parcels/parcel_lines` and that no `wms.outbox` rows exist.
2. **Populate the registry**: `POST /api/wms/sync/bins` + `/sync/pickface` (mirror-only,
   no Cin7 write). Then confirm every bin you'll touch — each pick bin, `MA-PRODUCTION`,
   and the TR from/to — resolves to a non-null Cin7 `LocationID`. Abort on any null.
3. **Inspect the risky payloads without writing**: `GET stockTransfer?TaskID=<a real,
   already IN-TRANSIT TR>` and diff its shape against `dispatchTransfer`'s body
   (confirm `SkipOrder`, `DepartureDate`, whether Lines echo full ordered qty). `GET
   sale/fulfilment?SaleID=<test SO>` to see if a fulfilment already exists.
4. **Pick the smallest test targets**: one small **Advanced, non-assembly** SO (1-2
   lines, not already picked in Cin7); one low-value **ORDERED** TR that can be voided;
   two Main-warehouse bins + a cheap SKU with confirmed on-hand for the bin move.
5. **Enable writes**: set `WMS_WRITE_ENABLED=true` and restart the (local/LAN) server.
   Test in order of reversibility: **bin transfer** → **commit/pick** (single
   fulfilment) → **finalize** (multi-write) → **tr-dispatch** (least proven, throwaway
   TR first). After each: check `GET /api/wms/outbox` (row `pending→sent→confirmed`),
   `GET /api/wms/movements`, and the matching Cin7 record. If anything times out, `POST
   /api/wms/reconcile` before retrying (never blind-retry a write).
6. **Turn writes back OFF** (`WMS_WRITE_ENABLED` unset) when the session ends.
