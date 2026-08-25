#!/usr/bin/env node
'use strict';
/**
 * Aplica as migrações do módulo, em ordem, cada uma numa transação.
 *   node features/stock-planning/scripts/apply-db.js            # mostra o que faria
 *   node features/stock-planning/scripts/apply-db.js --write
 *   node features/stock-planning/scripts/apply-db.js --write --only=003
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/sp-db');

const WRITE = process.argv.includes('--write');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const DIR = path.join(__dirname, '..', 'db');

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
    .filter((f) => !ONLY || f.startsWith(ONLY));
  console.log(`\n${WRITE ? 'Aplicando' : 'DRY-RUN de'} ${files.length} migração(ões) em rapid_inv\n`);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!WRITE) { console.log(`  ○ ${f}  (${sql.split('\n').length} linhas)`); continue; }
    const t = Date.now();
    try {
      await db.tx(async (c) => { await c.query(sql); });
      console.log(`  ✓ ${f}  ${Date.now() - t}ms`);
    } catch (e) {
      console.error(`  ✗ ${f}\n     ${e.message}`);
      await db.close();
      process.exit(1);
    }
  }
  if (!WRITE) console.log('\nNada foi aplicado. Rode com --write.\n');
  else console.log('\nPronto.\n');
  await db.close();
})().catch(async (e) => { console.error(e.message); await db.close(); process.exit(1); });
