/**
 * Container Builder — Packer unit tests
 *
 * Run with: npm run test:packer
 *           (or directly: node --test features/container-builder/packer.test.js)
 *
 * These are the first tests in the repo. Scope is intentionally limited
 * to the pure packer module — no Express, no Supabase, no Cin7.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOLVER_VERSION,
  CONTAINERS,
  packAll,
  overlaps,
  supported,
} = require('./packer');

// ─── Module surface ─────────────────────────────────────────────────
test('exports SOLVER_VERSION as a stable string', () => {
  assert.equal(typeof SOLVER_VERSION, 'string');
  assert.match(SOLVER_VERSION, /^\d+\.\d+\.\d+$/);
});

test('exports CONTAINERS with 20ft / 40ft / 40HC presets', () => {
  for (const k of ['20ft', '40ft', '40HC']) {
    assert.ok(CONTAINERS[k], `missing ${k}`);
    assert.ok(CONTAINERS[k].L > 0);
    assert.ok(CONTAINERS[k].W > 0);
    assert.ok(CONTAINERS[k].H > 0);
    assert.ok(CONTAINERS[k].maxKg > 0);
  }
});

// ─── Geometry primitives ────────────────────────────────────────────
test('overlaps: two boxes at the same origin overlap', () => {
  const a = { x: 0, y: 0, z: 0, l: 10, w: 10, h: 10 };
  const b = { x: 0, y: 0, z: 0, l: 10, w: 10, h: 10 };
  assert.equal(overlaps(a, [b]), true);
});

test('overlaps: adjacent boxes do not overlap', () => {
  const a = { x: 10, y: 0, z: 0, l: 10, w: 10, h: 10 };
  const b = { x: 0,  y: 0, z: 0, l: 10, w: 10, h: 10 };
  assert.equal(overlaps(a, [b]), false);
});

test('supported: floor-level box is always supported', () => {
  const b = { x: 0, y: 0, z: 0, l: 10, w: 10, h: 10 };
  assert.equal(supported(b, []), true);
});

test('supported: airborne box with no items below is unsupported', () => {
  const b = { x: 0, y: 0, z: 50, l: 10, w: 10, h: 10 };
  assert.equal(supported(b, []), false);
});

test('supported: 50% support exactly is accepted', () => {
  // Box rests on a base item that covers exactly half its footprint.
  const base = { x: 0, y: 0, z: 0,  l: 5,  w: 10, h: 10 };
  const b    = { x: 0, y: 0, z: 10, l: 10, w: 10, h: 10 };
  assert.equal(supported(b, [base]), true);
});

test('supported: <50% support is rejected', () => {
  const base = { x: 0, y: 0, z: 0,  l: 4,  w: 10, h: 10 };  // 40% coverage
  const b    = { x: 0, y: 0, z: 10, l: 10, w: 10, h: 10 };
  assert.equal(supported(b, [base]), false);
});

// ─── packAll: small deterministic cases ─────────────────────────────
test('packAll: 3 cartons fit in one 20ft', () => {
  const cartons = [
    { sku: 'A', L: 100, W: 100, H: 100, kg: 10, qty: 3 },
  ];
  const r = packAll(cartons, CONTAINERS['20ft']);
  assert.equal(r.containers.length, 1);
  assert.equal(r.stats.placedCartons, 3);
  assert.equal(r.unplaced.length, 0);
});

test('packAll: opens a second container when first is full', () => {
  // Each carton is huge — only a few fit per container.
  const cartons = [
    { sku: 'BIG', L: 500, W: 230, H: 200, kg: 100, qty: 5 },
  ];
  const r = packAll(cartons, CONTAINERS['20ft']);
  assert.ok(r.containers.length >= 2, `expected ≥2 containers, got ${r.containers.length}`);
  assert.equal(r.stats.placedCartons, 5);
});

test('packAll: oversized carton goes to unplaced with reason="too_big"', () => {
  const cartons = [
    { sku: 'HUGE', L: 9999, W: 9999, H: 9999, kg: 1, qty: 1 },
  ];
  const r = packAll(cartons, CONTAINERS['40HC']);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].sku, 'HUGE');
  assert.equal(r.unplaced[0].reason, 'too_big');
});

test('packAll: overweight carton goes to unplaced with reason="overweight"', () => {
  const cartons = [
    { sku: 'HEAVY', L: 50, W: 50, H: 50, kg: 999999, qty: 1 },
  ];
  const r = packAll(cartons, CONTAINERS['40HC']);
  assert.equal(r.unplaced.length, 1);
  assert.equal(r.unplaced[0].reason, 'overweight');
});

test('packAll: zero-qty cartons are skipped (do not crash)', () => {
  const cartons = [
    { sku: 'A', L: 50, W: 50, H: 50, kg: 5, qty: 0 },
    { sku: 'B', L: 50, W: 50, H: 50, kg: 5, qty: 2 },
  ];
  const r = packAll(cartons, CONTAINERS['20ft']);
  assert.equal(r.stats.totalCartons, 2);
  assert.equal(r.stats.placedCartons, 2);
});

test('packAll: zero-dim cartons are skipped (do not crash)', () => {
  const cartons = [
    { sku: 'NODIMS', L: 0, W: 50, H: 50, kg: 5, qty: 3 },
    { sku: 'OK',     L: 50, W: 50, H: 50, kg: 5, qty: 1 },
  ];
  const r = packAll(cartons, CONTAINERS['20ft']);
  assert.equal(r.stats.totalCartons, 1);
  assert.equal(r.stats.placedCartons, 1);
});

test('packAll: prototype sample (~555 instances) runs in <2s', () => {
  const sample = [
    { sku: 'R3206-TRI',    L: 40, W: 30, H: 12, kg: 3.5,  qty: 120 },
    { sku: 'R3540-S-TRI',  L: 45, W: 45, H: 15, kg: 6.0,  qty: 80  },
    { sku: 'R3117',        L: 60, W: 40, H: 22, kg: 8.5,  qty: 50  },
    { sku: 'R3118',        L: 60, W: 40, H: 22, kg: 8.5,  qty: 40  },
    { sku: 'R1021-WH-TRI', L: 30, W: 30, H: 10, kg: 2.0,  qty: 200 },
    { sku: 'RQC',          L: 55, W: 40, H: 28, kg: 11.0, qty: 35  },
    { sku: 'RSS',          L: 50, W: 40, H: 25, kg: 9.5,  qty: 30  },
  ];
  const t0 = Date.now();
  const r = packAll(sample, CONTAINERS['40HC']);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `solver took ${ms}ms (>2000ms)`);
  assert.equal(r.stats.totalCartons, 555);
  assert.ok(r.stats.placedCartons + r.stats.unplacedCount === 555);
});

test('packAll: result has no overlapping items in any container', () => {
  const cartons = [
    { sku: 'A', L: 100, W: 100, H: 100, kg: 10, qty: 8 },
  ];
  const r = packAll(cartons, CONTAINERS['40ft']);
  for (const c of r.containers) {
    for (let i = 0; i < c.items.length; i++) {
      for (let j = i + 1; j < c.items.length; j++) {
        const ov =
          !(c.items[i].x + c.items[i].l <= c.items[j].x + 0.001 ||
            c.items[j].x + c.items[j].l <= c.items[i].x + 0.001) &&
          !(c.items[i].y + c.items[i].w <= c.items[j].y + 0.001 ||
            c.items[j].y + c.items[j].w <= c.items[i].y + 0.001) &&
          !(c.items[i].z + c.items[i].h <= c.items[j].z + 0.001 ||
            c.items[j].z + c.items[j].h <= c.items[i].z + 0.001);
        assert.equal(ov, false, `items ${i} and ${j} overlap`);
      }
    }
  }
});

test('packAll: weight per container never exceeds maxKg', () => {
  const cartons = [
    { sku: 'A', L: 80, W: 60, H: 40, kg: 100, qty: 60 },
  ];
  const r = packAll(cartons, CONTAINERS['20ft']);
  for (const c of r.containers) {
    assert.ok(c.weight <= CONTAINERS['20ft'].maxKg, `weight ${c.weight} > maxKg`);
  }
});

test('packAll: stats are consistent', () => {
  const cartons = [
    { sku: 'A', L: 50, W: 50, H: 50, kg: 5, qty: 7 },
    { sku: 'B', L: 50, W: 50, H: 50, kg: 5, qty: 3 },
  ];
  const r = packAll(cartons, CONTAINERS['40HC']);
  assert.equal(r.stats.totalCartons, 10);
  assert.equal(r.stats.placedCartons + r.stats.unplacedCount, r.stats.totalCartons);
  assert.equal(r.stats.containerCount, r.containers.length);
});
