# Container Builder

WMS module that plans optimal 3D loading of shipping containers
(20ft / 40ft / 40HC) from Cin7 master data.

## Status

**PR 1 — Scaffold + audit (live).** Solver, 3D viewport, PO picker,
save/load and PDF export ship in subsequent PRs (see roadmap on the
page itself).

## Files

| Path | Role |
|---|---|
| `container-builder.html` / `.js` / `.css` | Frontend page |
| `container-builder-engine.js` | Express routes (`/api/container-builder/*`) |
| `migrations/001_create_container_plans.sql` | `cin7_mirror.container_plans` + `container_plan_lines` |
| `packer.js` (PR 2) | Pure 3D bin-packing algorithm |
| `packer.test.js` (PR 2) | `node --test` unit tests |
| `view.html` / `view.js` (PR 10) | Read-only share view |

## Data dependencies

Reads from `cin7_mirror.products`, populated by
`cin7-stock-sync/sync-service.js` (see `mapProductRow`). Required fields
are already mapped: `category`, `carton_length`, `carton_width`,
`carton_height`, `carton_quantity`, `weight`.

If carton-dim coverage on active SKUs is below 80%, the module still
runs but most SKUs cannot be planned. The audit endpoint exposes the
punchlist for Cin7 data cleanup.

## Endpoints

```
GET  /api/container-builder/products/audit        ✅ live (PR 1)
GET  /api/container-builder/products              🟡 stub (PR 3)
POST /api/container-builder/solve                 🟡 stub (PR 3)
GET  /api/container-builder/pos                   🟡 stub (PR 7)
GET  /api/container-builder/pos/:poNum/lines      🟡 stub (PR 7)
GET  /api/container-builder/plans                 🟡 stub (PR 8)
POST /api/container-builder/plans                 🟡 stub (PR 8)
GET  /api/container-builder/plans/:id             🟡 stub (PR 8)
PUT  /api/container-builder/plans/:id             🟡 stub (PR 8)
POST /api/container-builder/plans/:id/confirm     🟡 stub (PR 8)
POST /api/container-builder/plans/:id/reopen      🟡 stub (PR 8)
POST /api/container-builder/plans/:id/export/pdf  🟡 stub (PR 9)
```

All responses use the `{ success, data?, error? }` envelope.

## Conventions

- `cin7Get` / `cin7Post` helpers in the engine are intentionally
  duplicated from `pick-anomalies-engine.js`. Matches the established
  per-engine client pattern in this repo — do not refactor into a
  shared module as part of this work.
- All write endpoints (PRs 7+) require an `x-cb-user` header carrying
  free-text identity from `localStorage.containerBuilderUser`. There is
  no auth in this repo; this is a guardrail, not security.
- Plan status workflow: `draft → confirmed → loaded → archived`. PUT on
  a confirmed plan is rejected server-side (409). Use `/reopen` to
  unlock.
- All CSS is scoped with the `.cb-*` prefix.

## Running locally

```
npm start                # Express on :8383
# Open http://localhost:8383/features/container-builder/container-builder.html
# or click Container Builder inside the Quality & Compliance card on the home page
# (PIN-protected — same gate as the rest of that card).
```
