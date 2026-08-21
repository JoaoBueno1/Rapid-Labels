/**
 * Runs the Gateway migration in a real Postgres, in process, with no database
 * to deploy to and nothing to clean up afterwards.
 *
 * The Labels project cannot execute DDL from a script — direct Postgres is
 * gone (rotated password) and PostgREST has no exec_sql — so the migration
 * would otherwise reach production having never been run once. PGlite is
 * actual Postgres compiled to WASM, plpgsql and all, so the same .sql files
 * that get pasted into the SQL Editor are executed here first.
 *
 * Only two things are faked, because they belong to the Cin7 mirror and not to
 * this feature: cin7_mirror.products and cin7_mirror.stock_snapshot, created
 * with the columns the Gateway views and gateway_resolve_sku actually read.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const DB_DIR = path.resolve(__dirname, '..', 'db');
const MIGRATIONS = ['001_gateway_inventory.sql', '002_gateway_logic.sql', '003_gateway_import.sql'];

/** The roles Supabase provides and a bare Postgres does not. */
const ROLES = `
DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

/** Only the columns the Gateway code reads. Shapes taken from the live schema. */
const CIN7_STUB = `
CREATE SCHEMA IF NOT EXISTS cin7_mirror;

CREATE TABLE IF NOT EXISTS cin7_mirror.products (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sku          TEXT UNIQUE NOT NULL,
  name         TEXT,
  status       TEXT DEFAULT 'Active',
  uom          TEXT DEFAULT 'Item',
  attribute1   TEXT,
  average_cost NUMERIC,
  synced_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cin7_mirror.stock_snapshot (
  sku           TEXT NOT NULL,
  location_name TEXT NOT NULL,
  bin           TEXT NOT NULL DEFAULT '',
  batch         TEXT NOT NULL DEFAULT '',
  product_name  TEXT,
  on_hand       NUMERIC DEFAULT 0,
  allocated     NUMERIC DEFAULT 0,
  available     NUMERIC DEFAULT 0,
  synced_at     TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (sku, location_name, bin, batch)
);

CREATE TABLE IF NOT EXISTS cin7_mirror.stock_transfers (
  task_id       TEXT PRIMARY KEY,
  number        TEXT,
  from_location TEXT,
  to_location   TEXT,
  status        TEXT,
  total_qty     NUMERIC
);
`;

async function bootDb({ seedCin7 = true } = {}) {
  const db = new PGlite();
  await db.exec(ROLES);
  await db.exec(CIN7_STUB);

  if (seedCin7) {
    // Real spellings, including the mixed case that broke the SKU join.
    await db.exec(`
      INSERT INTO cin7_mirror.products (sku, name, attribute1) VALUES
        ('R6052-WH-TRI',  'Downlight WH TRI',        '30313'),
        ('12v-IP20-030w', 'Driver 12V IP20 30W',     '31001'),
        ('R3117',         'Track Head',              '71779'),
        ('R2379-2m',      'Extrusion 2m',            '30585')
      ON CONFLICT (sku) DO NOTHING;
      INSERT INTO cin7_mirror.stock_snapshot (sku, location_name, bin, batch, on_hand, available) VALUES
        ('R6052-WH-TRI',  'Gateway', '', '', 149, 149),
        ('R3117',         'Gateway', '', '', 720, 720)
      ON CONFLICT DO NOTHING;`);
  }

  // A slice of the real 447-shelf map, so shelf binding is exercised rather
  // than skipped. Applied after the migration creates the table.
  const seedShelves = `
    INSERT INTO public.gateway_shelves (id, area, shelf_number, shelf_type, pick_sequence) VALUES
      ('A1','A',1,'stock',1), ('A2','A',2,'stock',2), ('A12','A',12,'stock',12),
      ('B4','B',4,'stock',104), ('C31','C',31,'stock',231), ('E-FLOOR','E',NULL,'floor',400)
    ON CONFLICT (id) DO NOTHING;`;

  for (const f of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(DB_DIR, f), 'utf8');
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`${f} failed to apply:\n${e.message}`);
    }
  }
  if (seedCin7) await db.exec(seedShelves);
  return db;
}

/** One row, or null. */
async function one(db, sql, params) {
  const r = await db.query(sql, params);
  return r.rows[0] || null;
}
/** Scalar out of a single-column single-row result. */
async function val(db, sql, params) {
  const row = await one(db, sql, params);
  return row ? Object.values(row)[0] : null;
}
/** Run something that must fail, and return the message. */
async function mustFail(db, sql, params) {
  try {
    await db.query(sql, params);
  } catch (e) {
    return e.message;
  }
  throw new Error(`expected a failure from: ${sql.slice(0, 120)}`);
}

module.exports = { bootDb, one, val, mustFail, MIGRATIONS };
