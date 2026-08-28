#!/usr/bin/env node
'use strict';
/**
 * core/cin7/backfill-purchases.js — espelha as compras do Cin7 desde 2025-08-01.
 *
 * POR QUE ISTO E NÃO O backfill-driver.js: o driver traz uma máquina de estados
 * (ops.cin7_sync_state + 3 RPCs) que nunca rodou em produção. Para um job de
 * ~3,4 h não vale o risco. Este script usa `cin7_mirror.backfill_state`, que já
 * existe e é o checkpoint provado do backfill-sales.js desde junho/2026.
 *
 * O QUE ISTO DESTRAVA: hoje `on-order` vive só como número agregado em
 * stock_snapshot.on_order — diz QUANTO vem, nunca QUANDO nem DE QUEM. Com o
 * espelho, o Stock Planning ganha ETA por PO (required_by), fornecedor e lead
 * time medido, que hoje são digitação de Excel.
 *
 * RESUMÍVEL: mata no meio e roda de novo — retoma da última página confirmada.
 * IDEMPOTENTE: upsert por po_id. Rodar duas vezes não duplica.
 *
 * Pré-requisito: core/cin7/sql/002a_purchase_mirror.sql aplicado.
 *
 *   node core/cin7/backfill-purchases.js --dry-run      # só conta o trabalho
 *   node core/cin7/backfill-purchases.js                # roda até o fim
 *   node core/cin7/backfill-purchases.js --minutes=45   # roda 45 min e para
 *   node core/cin7/backfill-purchases.js --reset        # recomeça do zero
 */
require('dotenv').config();
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => +v);
types.setTypeParser(1700, (v) => +v);

const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split('=')[1] : d;
};
const DRY = process.argv.includes('--dry-run');
const RESET = process.argv.includes('--reset');
const SINCE = arg('since', '2025-08-01T00:00:00Z');
const RATE = parseInt(arg('rate', '24'), 10);            // chamadas/min
const MINUTES = parseInt(arg('minutes', '0'), 10);        // 0 = sem limite
const PAGE_SIZE = 500;
const JOB = 'purchases_v1';

const BASE = process.env.CIN7_BASE_URL || 'https://inventory.dearsystems.com/ExternalApi/v2';
const ACC = process.env.CIN7_ACCOUNT_ID;
const KEY = process.env.CIN7_API_KEY;
if (!ACC || !KEY) { console.error('faltam CIN7_ACCOUNT_ID / CIN7_API_KEY no .env'); process.exit(2); }

const THROTTLE_MS = Math.ceil(60000 / RATE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let calls = 0;

// Throttle + backoff em 429/503. O teto de 60/min é POR CONTA e compartilhado
// com o TMS e o app (docs/SYNC_WORKFLOWS.md:4-5) — 24/min deixa folga.
async function cin7(path, params = {}, retry = 0) {
  const wait = THROTTLE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}/${path}${qs ? '?' + qs : ''}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'api-auth-accountid': ACC, 'api-auth-applicationkey': KEY, Accept: 'application/json' },
    });
  } catch (e) {
    if (retry < 4) { await sleep(4000 * (retry + 1)); return cin7(path, params, retry + 1); }
    throw e;
  }
  calls++;
  if ((res.status === 429 || res.status === 503) && retry < 5) {
    const back = 5000 * Math.pow(2, retry);
    console.log(`   ⏳ ${res.status} — aguardando ${back / 1000}s`);
    await sleep(back);
    return cin7(path, params, retry + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${path}`);
  return res.json();
}

// ── checkpoint (a tabela que o backfill-sales.js já usa) ────────────────────
async function getCp(q) {
  const { rows } = await q('SELECT * FROM cin7_mirror.backfill_state WHERE job=$1', [JOB]);
  return rows[0] || null;
}
async function saveCp(q, patch) {
  await q(
    `INSERT INTO cin7_mirror.backfill_state (job, last_page, processed, total_target, done, notes, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (job) DO UPDATE SET
       last_page=EXCLUDED.last_page, processed=EXCLUDED.processed,
       total_target=COALESCE(EXCLUDED.total_target, cin7_mirror.backfill_state.total_target),
       done=EXCLUDED.done, notes=EXCLUDED.notes, updated_at=now()`,
    [JOB, patch.last_page, patch.processed, patch.total_target ?? null, !!patch.done, patch.notes || null]);
}

const d = (v) => { if (!v) return null; const x = new Date(v); return isNaN(x) ? null : x.toISOString().slice(0, 10); };
const ts = (v) => { if (!v) return null; const x = new Date(v); return isNaN(x) ? null : x.toISOString(); };
const n = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

// `list` é a linha do purchaseList e `det` o purchase?ID=. Precisa dos DOIS:
// OrderDate/RequiredBy/InvoiceStatus só existem na LISTA, e Total/Lines só no
// DETALHE (det.OrderDate e det.Total são `undefined` — verificado na API em
// 2026-08-27 contra PO-00365). Ler só o detalhe gravava null em order_date,
// completed_date e total de TODA PO.
async function writePurchase(q, det, list) {
  const L = list || {};
  await q(
    `INSERT INTO cin7_mirror.purchase_orders
       (po_id, po_number, supplier, supplier_id, status, order_date, required_by,
        completed_date, currency, total, occurred_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (po_id) DO UPDATE SET
       po_number=EXCLUDED.po_number, supplier=EXCLUDED.supplier, supplier_id=EXCLUDED.supplier_id,
       status=EXCLUDED.status, order_date=EXCLUDED.order_date, required_by=EXCLUDED.required_by,
       completed_date=EXCLUDED.completed_date, currency=EXCLUDED.currency, total=EXCLUDED.total,
       occurred_at=EXCLUDED.occurred_at, synced_at=now()`,
    [det.ID, det.OrderNumber || L.OrderNumber || null,
     det.Supplier || L.Supplier || null, det.SupplierID || L.SupplierID || null,
     det.Status || L.Status || null,
     d(L.OrderDate || (det.Order && det.Order.Date)),          // só na lista / em Order.Date
     d(det.RequiredBy || L.RequiredBy),                        // ETA do fornecedor (quase sempre null aqui)
     null,                                                     // preenchido abaixo com a data REAL de recebimento
     det.SupplierCurrency || L.SupplierCurrency || null,
     n(det.Order && det.Order.Total),                          // NÃO det.Total — não existe
     ts(L.OrderDate || (det.Order && det.Order.Date))]);

  // Linhas do pedido + o quanto já foi recebido. `received_quantity` é o que
  // transforma on-order agregado em on-order por PO com data.
  const order = det.Order || {};
  const lines = order.Lines || det.Lines || [];

  // StockReceived é um OBJETO {Status, Lines}, não um array — mas a compra
  // avançada (PurchaseAdvanced) pode trazer vários. Trata os dois.
  const recebido = [];
  const sr = det.StockReceived;
  (Array.isArray(sr) ? sr : sr ? [sr] : []).forEach((b) => (b.Lines || []).forEach((l) => recebido.push(l)));

  // A data REAL de recebimento — é ela que dá lead time medido (recebimento −
  // pedido), que vale mais que o RequiredBy prometido (null em toda PO vista).
  const datas = recebido.map((l) => l.Date).filter(Boolean).sort();
  if (datas.length) {
    await q('UPDATE cin7_mirror.purchase_orders SET completed_date=$2 WHERE po_id=$1',
            [det.ID, d(datas[datas.length - 1])]);
  }

  // delete-then-insert: uma PO editada no Cin7 (linha removida) não deixa órfã.
  await q('DELETE FROM cin7_mirror.purchase_lines WHERE po_id=$1', [det.ID]);
  if (!lines.length) return 0;

  const vals = [], ph = [];
  lines.forEach((l, i) => {
    const sku = l.SKU || l.ProductCode || null;
    const rec = recebido.filter((r) => (r.SKU || r.ProductCode) === sku)
                        .reduce((a, r) => a + (+r.Quantity || 0), 0);
    // on-order = pedido − recebido. É isto que stock_snapshot.on_order não sabe
    // dizer: QUANTO falta chegar, de QUAL PO, com QUAL data.
    const b = i * 8;
    ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
    vals.push(det.ID, i, sku, l.Name || l.ProductName || null,
      n(l.Quantity), n(l.Price), n(l.Total), rec);
  });
  await q(
    `INSERT INTO cin7_mirror.purchase_lines
       (po_id, line_no, sku, product_name, quantity, unit_cost, total, received_quantity)
     VALUES ${ph.join(',')}`, vals);
  return lines.length;
}

(async () => {
  const m = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase/i);
  if (!m || !process.env.SUPABASE_DB_PASSWORD) throw new Error('faltam SUPABASE_URL / SUPABASE_DB_PASSWORD');
  const pool = new Pool({
    host: process.env.SUPABASE_DB_HOST, port: +(process.env.SUPABASE_DB_PORT || 5432),
    database: 'postgres', user: 'postgres.' + m[1],
    password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });
  const q = (sql, p) => pool.query(sql, p);

  // pré-requisito, checado explicitamente: sem isto o INSERT falharia a cada PO
  const { rows: [chk] } = await q(
    `SELECT count(*)::int AS t FROM information_schema.tables
      WHERE table_schema='cin7_mirror' AND table_name IN ('purchase_orders','purchase_lines')`);
  if (chk.t < 2) {
    console.error('❌ cin7_mirror.purchase_orders/purchase_lines não existem.');
    console.error('   Aplique core/cin7/sql/002a_purchase_mirror.sql antes de rodar.');
    await pool.end(); process.exit(2);
  }

  if (RESET) { await q('DELETE FROM cin7_mirror.backfill_state WHERE job=$1', [JOB]); console.log('checkpoint zerado.'); }

  const head = await cin7('purchaseList', { UpdatedSince: SINCE, Page: 1, Limit: 1 });
  const total = head.Total ?? (head.PurchaseList || []).length;
  const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cp = await getCp(q);
  const from = cp && !cp.done ? (cp.last_page || 0) + 1 : 1;

  console.log(`\nCompras desde ${SINCE.slice(0, 10)}`);
  console.log(`  ${total.toLocaleString('en-AU')} POs · ${paginas} página(s) de ${PAGE_SIZE}`);
  console.log(`  ~${(total + paginas + 1).toLocaleString('en-AU')} chamadas · ${(total / RATE / 60).toFixed(1)} h a ${RATE}/min`);
  if (cp) console.log(`  checkpoint: página ${cp.last_page}, ${cp.processed} POs${cp.done ? ' (CONCLUÍDO)' : ''}`);
  if (cp && cp.done) { console.log('\nJá concluído. Use --reset para refazer.'); await pool.end(); return; }
  if (DRY) { console.log('\n(dry-run — nada gravado)'); await pool.end(); return; }

  const deadline = MINUTES ? Date.now() + MINUTES * 60000 : Infinity;
  let processados = cp ? (cp.processed || 0) : 0;
  let linhas = 0, falhas = 0, page = from;

  // `parcial` distingue "página terminou" de "página foi interrompida". Sem essa
  // distinção o checkpoint marcava como concluída uma página processada pela
  // metade, e o re-run pulava o resto — 952 POs sumiram em silêncio no teste de
  // 2 min (48 de 500 processadas, página 1 marcada ok, retomada na 3).
  let parcial = false;
  for (; page <= paginas; page++) {
    if (Date.now() > deadline) { parcial = true; break; }
    const list = await cin7('purchaseList', { UpdatedSince: SINCE, Page: page, Limit: PAGE_SIZE });
    const pos = list.PurchaseList || list.Purchases || [];
    if (!pos.length) { console.log(`página ${page}/${paginas}: vazia`); continue; }
    console.log(`página ${page}/${paginas}: ${pos.length} POs`);

    let completa = true;
    for (const po of pos) {
      if (Date.now() > deadline) { completa = false; break; }
      const id = po.ID || po.PurchaseID;
      if (!id) continue;
      try {
        const det = await cin7('purchase', { ID: id });
        linhas += await writePurchase(q, det, po);   // `po` é a linha da lista
        processados++;
        if (processados % 50 === 0) {
          process.stdout.write(`\r   ${processados}/${total} POs · ${linhas} linhas · ${calls} chamadas`);
        }
      } catch (e) {
        falhas++;
        console.warn(`\n   ⚠️ PO ${po.OrderNumber || id}: ${e.message}`);
        // Uma PO ruim não mata o backfill; o checkpoint só avança por página
        // COMPLETA, então o re-run reprocessa a página e tenta de novo.
      }
    }
    process.stdout.write('\r');

    if (!completa) {
      // Página interrompida: NÃO avança o checkpoint. O re-run refaz esta
      // página inteira — custa até 500 chamadas repetidas, e repetir é
      // idempotente (upsert por po_id). Perder PO não é.
      console.log(`\n⏱️  limite de ${MINUTES} min no meio da página ${page} — ela será refeita`);
      parcial = true;
      break;
    }

    // Checkpoint só aqui: a página inteira foi gravada.
    await saveCp(q, { last_page: page, processed: processados, total_target: total, done: false,
                      notes: `${falhas} falha(s)` });
  }

  // Concluído só quando o laço venceu todas as páginas SEM interrupção.
  const done = !parcial && page > paginas;
  // last_page = a última página COMPLETA (page-1 quando parou no meio de `page`).
  await saveCp(q, { last_page: Math.max(0, Math.min(page, paginas + 1) - 1), processed: processados,
                    total_target: total, done, notes: `${falhas} falha(s)` });

  console.log(`\n${done ? '✅ concluído' : '⏸️  parcial'} — ${processados}/${total} POs · ${linhas} linhas · ${calls} chamadas · ${falhas} falha(s)`);
  if (!done) console.log('   rode de novo para continuar de onde parou.');
  await pool.end();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
