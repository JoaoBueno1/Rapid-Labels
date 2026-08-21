# Gateway Inventory

Replaces `Gateway Driver Aug 26.xlsx` as the operational record of what is in
the Gateway warehouse, when it arrived, and what should move to Main first.

## Why it exists

Gateway is a top-level **location** in Cin7 (`cin7_mirror.locations` name
`Gateway`, `parent_id IS NULL`, `bin_count = 0`). Cin7 therefore knows one
number per SKU — 564 SKUs, 97,978 units — and nothing about which shelf a
pallet sits on, which pallet it is, or when it arrived. None of that is
recoverable from the ERP, which is why it has lived in a spreadsheet for two
years.

This module owns that layer. Cin7 stays the source of truth for the per-SKU
total; where the two disagree, the disagreement is recorded and explained
rather than corrected by editing our own history until it agrees.

> The previous module thought Gateway was bin `MA-GA` inside Main Warehouse
> (`legacy/gateway-engine.js:26-28`). Only 6 rows in the entire stock snapshot
> match that, so its Cin7 transfers moved `MA-GA -> MA-GA`: a no-op against a
> different warehouse object. It also had 0 rows in `gateway_movement_history`,
> so it had never actually run in production.

## The model

```
receipt ─▶ gateway_lots ─┬─▶ gateway_movements     (append-only, explains every balance)
                         └─▶ gateway_transfer_allocations   (the FIFO choice AND the reservation)
                                     │
                              gateway_transfer_lines ─▶ gateway_transfers
```

Four rules the schema enforces rather than trusts:

- **No balance is typed in.** `qty_remaining` only ever moves because a row was
  appended to `gateway_movements`, applied by a `BEFORE INSERT` trigger that
  stamps `qty_before` / `qty_after` from the locked lot row.
- **The ledger is append-only.** `UPDATE` and `DELETE` are refused by trigger.
  A mistake is corrected by posting a corrective movement. The single exception
  is `gateway_rollback_import`, which flips a transaction-local GUC that dies
  with the transaction.
- **Reservations are allocations.** There is no second reservation record that
  can drift out of step with the transfer that caused it. `qty_reserved` is
  *recomputed* from the allocation rows, never incremented.
- **Everything multi-step is an RPC.** PostgREST has no transaction, so
  allocation, posting and cancellation are plpgsql functions — one call, one
  transaction, proper row locks, taken in a consistent order so two operators
  cannot deadlock.

## FIFO

`gateway_fifo_queue(sku)` returns the free stock oldest first. Allocation walks
that queue under `FOR UPDATE`, so two people building transfers against the
same SKU serialise instead of both succeeding against the same units.

**Undated stock ranks first.** 277 of the 743 migrated pallets (37%) have no
arrival date, because the paper docket the office keys from has no date field
on it. Those pallets only exist because the migration found that stock already
sitting in Gateway, so they *are* old, and draining them first retires the
ambiguity instead of preserving it. Configurable via
`gateway_settings.fifo_unknown_policy` (`oldest` | `newest`).

A new receipt can never be undated: `gw_lots_date_required` refuses any lot
without `received_on` unless its `source_type` is `opening_balance`.

Taking stock out of FIFO order is allowed, requires a reason, and stores what
FIFO recommended alongside what was actually chosen, with who and when.

## Cin7

**This module never writes to Cin7.** Transfers are raised by hand and their
`TR-xxxxx` recorded against ours. `ERPTransferProvider` in
`gateway-inventory-engine.js` is the seam for later and currently throws;
`gateway_settings.erp_transfer_write_enabled` is the flag. When it is enabled
it must go through `features/wms/lib/outbox.js`, because Cin7 has no
idempotency key and an authorised transfer cannot be undone.

Reconciliation is `gateway_v_reconciliation`, a FULL OUTER JOIN against
`cin7_mirror.stock_snapshot` where `location_name = 'Gateway'` — both
directions matter: stock we hold that Cin7 does not, and stock Cin7 holds that
never got a lot.

## SKU case is load-bearing

Cin7 holds `12v-IP20-030w`; people type `12V-IP20-030W`. 276 of the first 1,000
products carry lower-case letters. `gateway_resolve_sku()` resolves every SKU to
Cin7's own spelling before storing it — without it, 78 migrated lots could not
join the product mirror and reconciliation would report a phantom difference
for each.

## Deploy

Direct Postgres is gone (the pooler password committed in
`scripts/add_fulfilment_col.js` was rotated) and PostgREST exposes no
`exec_sql`, so DDL is pasted by hand.

```bash
npm run gateway:bundle     # writes db/_apply_all.generated.sql
# paste it into Supabase Dashboard -> SQL Editor -> Run
npm run gateway:verify     # checks all 11 tables, 4 views, 21 functions
```

Then migrate the workbook:

```bash
npm run gateway:import                                                  # dry run
python features/gateway/import/import_gateway_history.py --apply        # write
python features/gateway/import/import_gateway_history.py --rollback N   # undo
```

## Tests

```bash
npm run test:gateway         # 30 tests — the real migration in PGlite, offline
npm run test:gateway:parse   # 31 tests — the workbook readers
npm run test:gateway:live    # the same scenarios against the deployed database
```

`test:gateway` boots real Postgres in-process (PGlite), applies the actual
`.sql` files and exercises the plpgsql. It needs no credentials and leaves
nothing behind. It has already caught three bugs that would have reached
production: a function used before it was defined, `gateway_post_transfer`
violating `qty_reserved <= qty_remaining` on every posting, and
`gateway_rollback_import` tripping a foreign key.

## Permissions

There is no authentication in this app (`docs/RUNBOOKS.md:19`). `lib/gw-permissions.js`
names the capabilities so the code says what it needs, and reads an optional
`GATEWAY_ROLES` env map. With no map set every capability is open and the
process says so once at boot — a silent allow-all is how a permission model
rots. `x-gw-user` is attribution, not proof.

## Legacy

`legacy/` holds the previous module, unregistered. `GATEWAY_LEGACY_ENABLED=true`
brings it back, but note what that turns on: `POST /api/gateway/transfer`
creates and authorises a Cin7 stock transfer with no idempotency key behind two
live buttons, and `POST /api/gateway/seed` deletes the whole shelf map
unauthenticated. `legacy/gateway-stock-analysis.html` is the old Main-stock and
pickface-cover page, still reachable directly if anyone wants it.

`public.gateway_allocations` (661 rows) and `public.gateway_movement_history`
(0 rows) are left in place, unread. The allocations are a frozen 2026-02-26
seed whose `stock_date` is one day early on all 368 comparable rows and in the
future on 146 of them, so it was never usable for ageing.
