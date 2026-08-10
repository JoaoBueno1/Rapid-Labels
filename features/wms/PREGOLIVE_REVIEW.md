# WMS pre-go-live review — 2026-08-10

Adversarial correctness review of the WMS Cin7-write paths + newly-built features, run
BEFORE any first live write. 33 raw findings → **20 CONFIRMED** (each survived a verifier
that tried to refute it). **Nothing here has caused harm: every write path is gated OFF
(`WMS_WRITE_ENABLED`) and no write has ever run against real Cin7 — these are latent bugs
to fix before enabling writes, not live incidents.**

## 🔴 Must fix before the first live write (defeat exactly-once / cause silent loss)

| # | Where | Bug | Fix direction |
|---|-------|-----|---------------|
| 1 | `wms-engine.js:507` | `finalize` re-run silently drops an already-built FG: the build is `committed` but the FG `parcel_line.qty_scanned` is only set inside the loop that excludes committed builds → on retry the FG is never picked → **silent short-ship + orphan FG stock**, wave marked done. | Set the FG line `qty_scanned` independently of the build loop (at buildWave, or iterate ALL wave builds before commitPick). |
| 2 | `wms-engine.js:280` | commitPick `op_key` built from an **unordered** line set → same intent can hash to 2 keys → **bypasses the outbox → double-write**. | Sort lines deterministically before `opKey`. |
| 3 | `wms-engine.js:369` | commitBuild `op_key` omits the build id → 2 builds of the same FG SKU in one wave collide → 2nd deduped → **under-produce**. | Include `build.id` in the op_key. |
| 4 | `wms-engine.js:286` | commitPick POSTs a **new fulfilment without adopting an existing one**, and **outside the outbox** → can duplicate an irreversible Cin7 fulfilment. | GET fulfilments, adopt `f[0]` if present; move the create inside the outbox op. |
| 5 | `wms-transfers.js:164` | recordTrScan **overwrites the ORDERED qty** with the scanned qty → a short-pick silently dispatches the reduced number, no variance. | Add a separate `qty_picked` (keep `qty`=ordered). Needs a small migration. |
| 6 | `wms-transfers.js:204` | dispatchTr **doesn't null-check From/To** LocationIDs (commitTransfer does) → dispatches with `null` location. | Throw if `fromId`/`toId` is null, like commitTransfer. |
| 7 | `cin7-wms-client.js:174` + `wms-engine.js:366` | **BOM per-component quantity hardcoded to 1** (getRecipe fallback + commitBuild recipe) → consumes too few components → **inventory drift** for BOMs using >1/unit. | Read the real `Quantity` from the build OrderLines in the fallback; send true qty in the recipe. |
| 8 | `wms-routes.js:183` | On an assembly order the pack flow only packs the `kind='pick'` parcel → the assembled **FG is picked but never packed** (dropped from the pack). | Include the assembly parcel's produced FG in the pack. |
| 9 | `outbox.js:84` | The compare-and-swap closes the `pending→sent` race but **not the `sent→sent` post-crash resend** (both concurrent workers still re-send). | Add a short claim/lease or a distinct 'sending' state so only one worker resends. |
| 10 | `outbox.js:67` | A `failed` row is re-sent **without verify** → if doWrite threw *after* Cin7 committed, retry re-issues blindly. | Run `verify()` before resending `failed` rows too, not only `sent`. |
| 11 | `outbox.js:113` | `movements.op_key` is **not UNIQUE** → concurrent journalers insert duplicate, un-deletable movement rows. | Add `UNIQUE(op_key)` (migration) + upsert-ignore. |

## 🟠 Fix before real production volume (don't block a controlled test)
- `wms-engine.js:513` — `finalize` fires many sequential Cin7 calls → serverless timeout (split into commit/build+pick, or run local/LAN).
- `wms-engine.js:293` — no server-side qty gate before the irreversible AUTHORISED pick; no unpick/void recovery path.
- `reconciler.js:48` — reconcile writes a placeholder `{sku:'(reconciled)', qty:0}` and then `journalIfAbsent` suppresses the real per-line movements (append-only → can't fix later).
- `wms-routes.js:250` — the reserved-stock `override` is client-asserted (no role check) and leaves no audit trail.
- `wms-app.js:28` — claim identity is the mutable `S.user`; renaming the operator mid-hold breaks heartbeat/release matching (only relevant with `WMS_CLAIMS_ENABLED`).

## 🟡 Minor / already live
- `wms-engine.js:262` — **stockLookup** does N sequential Cin7 availability calls for a BOM → can time out the PWA. **This route is live now** (read-only). Parallelise with `Promise.all`.
- `book_order.js:327` (TMS) — the `Array.isArray(parcels)` guard checks the wrong variable; harmless (the surrounding try/catch absorbs it), just misleading.

_Full run: 39 agents, transcript under `subagents/workflows/wf_40be37cb-ac6`._
