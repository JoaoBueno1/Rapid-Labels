/**
 * Container Builder — Packing algorithm
 *
 * Pure module — no I/O, no side effects, safe to test in isolation
 * and to call from both server (/api/container-builder/solve) and the
 * browser (live preview as the user edits cartons).
 *
 * Algorithm: Extreme-Point First-Fit Decreasing with 2-way rotation
 * (L×W and W×L, H always upright). Same logic as the validated
 * prototype in container_builder_vanilla_preview.html.
 *
 * Conventions:
 *   - All linear dimensions in centimetres.
 *   - All weights in kilograms.
 *   - Positive Z is "up" (gravity acts on the floor).
 */

'use strict';

// Bumped when the algorithm changes — persisted on container_plans.solver_version
// so saved plans are reproducible and we can tell when to re-solve.
const SOLVER_VERSION = '1.0.0';

// Hard cap on containers per solve. Anything above this is almost certainly
// a data problem (qty typo, dimensions in wrong unit, etc.) — better to bail
// loudly than to render thousands of useless tabs in the UI.
const MAX_CONTAINERS = 50;

// Standard ISO container internal dimensions (cm) and legal payload (kg).
// Same values as the prototype.
const CONTAINERS = Object.freeze({
  '20ft': { label: "20' Standard",  L:  589.8, W: 235.2, H: 239.3, maxKg: 28180 },
  '40ft': { label: "40' Standard",  L: 1203.2, W: 235.2, H: 239.3, maxKg: 26680 },
  '40HC': { label: "40' High Cube", L: 1203.2, W: 235.2, H: 269.8, maxKg: 26580 },
});

// ─── Geometry helpers ────────────────────────────────────────────────
function overlaps(b, items) {
  return items.some(it =>
    !(b.x + b.l <= it.x + 0.001 || it.x + it.l <= b.x + 0.001) &&
    !(b.y + b.w <= it.y + 0.001 || it.y + it.w <= b.y + 0.001) &&
    !(b.z + b.h <= it.z + 0.001 || it.z + it.h <= b.z + 0.001)
  );
}

function supported(b, items) {
  // Floor support is always OK.
  if (b.z < 0.01) return true;
  let cov = 0;
  for (const it of items) {
    if (Math.abs(it.z + it.h - b.z) > 0.01) continue;
    const ox = Math.min(it.x + it.l, b.x + b.l) - Math.max(it.x, b.x);
    const oy = Math.min(it.y + it.w, b.y + b.w) - Math.max(it.y, b.y);
    if (ox > 0 && oy > 0) cov += ox * oy;
  }
  // Need ≥50% of the carton base supported by items below.
  return cov / (b.l * b.w) >= 0.5;
}

// ─── Single-item placement ───────────────────────────────────────────
function place(item, ctr, dims) {
  const rots = [
    { l: item.L, w: item.W, h: item.H },
    { l: item.W, w: item.L, h: item.H },
  ];
  let best = null;

  for (let ei = 0; ei < ctr.eps.length; ei++) {
    const ep = ctr.eps[ei];
    for (const r of rots) {
      if (ep.x + r.l > dims.L + 0.01) continue;
      if (ep.y + r.w > dims.W + 0.01) continue;
      if (ep.z + r.h > dims.H + 0.01) continue;
      if (ctr.weight + item.kg > dims.maxKg) continue;

      const box = { x: ep.x, y: ep.y, z: ep.z, l: r.l, w: r.w, h: r.h };
      if (overlaps(box, ctr.items)) continue;
      if (!supported(box, ctr.items)) continue;

      // Score: prefer low Z (floor-first), then low X (back wall), then low Y.
      const score = box.z * 10000 + box.x + box.y * 0.01;
      if (!best || score < best.score) best = { box, ei, score };
    }
  }
  if (!best) return false;

  ctr.items.push({ sku: item.sku, kg: item.kg, ...best.box });
  ctr.weight += item.kg;
  ctr.eps.splice(best.ei, 1);

  // Add up to 3 new extreme points (corners of the placed box).
  const b = best.box;
  for (const ne of [
    { x: b.x + b.l, y: b.y,         z: b.z         },
    { x: b.x,         y: b.y + b.w, z: b.z         },
    { x: b.x,         y: b.y,         z: b.z + b.h },
  ]) {
    if (!ctr.eps.some(e =>
      Math.abs(e.x - ne.x) < 0.01 &&
      Math.abs(e.y - ne.y) < 0.01 &&
      Math.abs(e.z - ne.z) < 0.01
    )) ctr.eps.push(ne);
  }
  return true;
}

// ─── Multi-container packer ──────────────────────────────────────────
/**
 * @param {Array<{sku:string,L:number,W:number,H:number,kg:number,qty:number}>} cartons
 * @param {{L:number,W:number,H:number,maxKg:number}} cdims
 * @returns {{containers:Array, unplaced:Array, stats:object}}
 */
function packAll(cartons, cdims) {
  // Expand qty into individual instances and sort by volume desc.
  const inst = [];
  for (const c of cartons) {
    const qty = Math.max(0, Math.floor(Number(c.qty) || 0));
    if (qty === 0) continue;
    if (!(c.L > 0 && c.W > 0 && c.H > 0)) continue;   // skip zero-dim cartons
    const vol = c.L * c.W * c.H;
    for (let i = 0; i < qty; i++) {
      inst.push({
        sku: c.sku,
        L:   Number(c.L)  || 0,
        W:   Number(c.W)  || 0,
        H:   Number(c.H)  || 0,
        kg:  Number(c.kg) || 0,
        volume: vol,
      });
    }
  }
  inst.sort((a, b) => b.volume - a.volume);

  const ctrs = [];
  const unplaced = [];
  let hitCap = false;

  for (const it of inst) {
    let placed = false;
    for (const c of ctrs) {
      if (place(it, c, cdims)) { placed = true; break; }
    }
    if (!placed) {
      if (ctrs.length >= MAX_CONTAINERS) {
        hitCap = true;
        unplaced.push({ sku: it.sku, reason: 'container_cap_reached' });
        continue;
      }
      const nc = { items: [], eps: [{ x: 0, y: 0, z: 0 }], weight: 0 };
      if (place(it, nc, cdims)) {
        ctrs.push(nc);
      } else {
        // Item can't fit even in an empty container — too big or overweight
        unplaced.push({
          sku: it.sku,
          reason:
            (it.L > cdims.L || it.W > cdims.W || it.H > cdims.H) ? 'too_big' :
            (it.kg > cdims.maxKg)                                ? 'overweight' :
                                                                   'no_support',
        });
      }
    }
  }

  // Compute per-container utilisation stats.
  const cv = cdims.L * cdims.W * cdims.H;
  for (const c of ctrs) {
    const used = c.items.reduce((s, it) => s + it.l * it.w * it.h, 0);
    c.volumeUsedCm3        = used;
    c.volumeUtilizationPct = cv ? (used / cv) * 100 : 0;
    c.weightUtilizationPct = cdims.maxKg ? (c.weight / cdims.maxKg) * 100 : 0;
  }

  return {
    containers: ctrs,
    unplaced,
    stats: {
      totalCartons:   inst.length,
      placedCartons:  ctrs.reduce((s, c) => s + c.items.length, 0),
      containerCount: ctrs.length,
      unplacedCount:  unplaced.length,
      hitContainerCap: hitCap,
    },
  };
}

module.exports = {
  SOLVER_VERSION,
  CONTAINERS,
  packAll,
  // exposed for tests + browser preview path
  place,
  overlaps,
  supported,
};
