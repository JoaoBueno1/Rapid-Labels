#!/usr/bin/env node
/**
 * Puxa o Bill of Materials do Cin7 para rapid_inv.product_bom.
 *
 *   node features/stock-planning/scripts/sync-bom.js            (dry-run)
 *   node features/stock-planning/scripts/sync-bom.js --write
 *
 * O BOM não tem endpoint próprio: /bom, /productBOM e /ref/bom devolvem a
 * página 404 em HTML com status 200 — medido. Ele vem dentro do produto, e a
 * LISTA paginada já traz BillOfMaterialsProducts[] inteiro. Por isso este
 * script pagina a lista em vez de buscar pai por pai: ~86 chamadas contra ~700.
 *
 * O ritmo é deliberado. A cota de 60/min é da APLICAÇÃO, compartilhada com o
 * TMS e uns 16 workflows; um sync que corre solto aqui derruba o pedido de
 * alguém lá. 1,2s entre páginas deixa folga para os outros.
 */
'use strict';
require('dotenv').config();
const db = require('../lib/sp-db');

const WRITE = process.argv.includes('--write');
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
            'api-auth-applicationkey': process.env.CIN7_API_KEY };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const K = (s) => String(s == null ? '' : s).trim().toUpperCase();

async function page(n) {
  for (let tent = 1; tent <= 4; tent++) {
    const res = await fetch(`${BASE}/product?Page=${n}&Limit=100&IncludeBOM=true`,
      { headers: H, signal: AbortSignal.timeout(45000) });
    if (res.status === 429) { await nap(3000 * tent); continue; }   // a cota é compartilhada
    if (!res.ok) throw new Error(`pagina ${n}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`pagina ${n}: 429 depois de 4 tentativas`);
}

async function main() {
  const linhas = [];
  const pais = new Set();
  let n = 1, total = null, vistos = 0;
  while (true) {
    const j = await page(n);
    const ps = j.Products || [];
    if (total == null) { total = j.Total; console.log(`  ${total} produtos no Cin7`); }
    vistos += ps.length;
    for (const p of ps) {
      const comps = p.BillOfMaterialsProducts || [];
      if (!p.BillOfMaterial || !comps.length) continue;
      pais.add(K(p.SKU));
      for (const c of comps) {
        // Componente sem código é linha inútil e viraria chave primária vazia.
        if (!K(c.ProductCode)) continue;
        linhas.push([K(p.SKU), K(c.ProductCode), p.SKU, c.ProductCode, c.Name,
          Number(c.Quantity) || 0, Number(c.WastagePercent) || 0,
          p.BOMType || null, p.AutoAssembly === true]);
      }
    }
    process.stdout.write(`\r  pagina ${n} · ${vistos}/${total} · ${pais.size} pais com BOM   `);
    if (!ps.length || vistos >= total) break;
    n++; await nap(1200);
  }
  console.log(`\n\n  ${pais.size} produtos montados · ${linhas.length} linhas de componente`);
  const porPai = {};
  linhas.forEach((l) => { porPai[l[0]] = (porPai[l[0]] || 0) + 1; });
  const dist = {};
  Object.values(porPai).forEach((q) => { dist[q] = (dist[q] || 0) + 1; });
  console.log(`  componentes por pai: ${Object.entries(dist).map(([k, v]) => `${k}→${v}`).join('  ')}`);
  const carton = linhas.filter((l) => /carton[0-9]*$/i.test(l[2]));
  console.log(`  destes, ${carton.length} sao SKU -Carton (o tamanho da caixa que carton_quantity nao tem)`);

  if (!WRITE) { console.log('\n  (dry-run — rode com --write para gravar)\n'); await db.close(); return; }

  await db.tx(async (c) => {
    // Substituição inteira: um pai que perdeu o BOM no Cin7 tem que sumir daqui
    // também, e um merge o deixaria para sempre.
    await c.query('TRUNCATE rapid_inv.product_bom');
    const cols = ['parent_key', 'component_key', 'parent_sku', 'component_sku', 'component_name',
                  'quantity', 'wastage_pct', 'bom_type', 'auto_assembly'];
    for (let i = 0; i < linhas.length; i += 400) {
      const ch = linhas.slice(i, i + 400), vals = [], ph = [];
      ch.forEach((r, k) => { ph.push('(' + cols.map((_, j) => `$${k * cols.length + j + 1}`).join(',') + ')'); vals.push(...r); });
      await c.query(`INSERT INTO rapid_inv.product_bom (${cols.join(',')}) VALUES ${ph.join(',')}
                     ON CONFLICT (parent_key, component_key) DO NOTHING`, vals);
    }
  }, 'sync-bom');
  const [{ q }] = await db.query('SELECT count(*)::int q FROM rapid_inv.product_bom');
  console.log(`\n  ✓ gravadas ${q} linhas\n`);
  await db.close();
}
main().catch((e) => { console.error('\n  ERRO:', e.message); process.exit(1); });
