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

**Still TODO / nice-to-have:**
- Populate the pickface registry (`POST /api/wms/sync/pickface`) — today suggestions
  fall back to `stock_locator` + availability bins (works, but the owned registry is
  empty).
- Wire the Pack Station "Send to booking" to the TMS booking screen (SO#/cartons/dims).
- Non-Main-origin TRs have no bins/pickface (only Main has bins in Cin7) — the pick
  works but with no pickface guidance; revisit if branch-origin TRs are picked here.

## Running it
- Server: `node server.js` (full node path on the office PC:
  `C:\Users\JoaoMarcos\.fnm\node-versions\v24.13.1\installation\node.exe server.js`).
- PWA: `http://localhost:8383/wms` (this PC) or `http://<LAN-IP>:8383/wms` (handheld
  on the same Wi-Fi). `.env` has `SUPABASE_*` + `CIN7_*`.
- Note: on the Vercel deploy only `/api/*` is routed to Express (per `vercel.json`) —
  the `/wms` static mount is local-only; on Vercel the PWA would live at
  `/features/wms/pwa/wms.html` and long calls risk the serverless timeout. Use the
  local/LAN URL for handheld testing.
