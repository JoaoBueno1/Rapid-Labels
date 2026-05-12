#!/usr/bin/env node
/**
 * ============================================================
 * sync-rapid-inv-sales.js
 *  → Fase A do Rapid Inventory SKU
 *  → Sincroniza sales completados do Cin7 para rapid_inv.weekly_sales
 * ============================================================
 *
 * Uso:
 *   node cin7-stock-sync/sync-rapid-inv-sales.js                 # incremental (só novos)
 *   node cin7-stock-sync/sync-rapid-inv-sales.js --weeks=26      # janela maior
 *   node cin7-stock-sync/sync-rapid-inv-sales.js --limit=20      # processa só 20 (teste)
 *   node cin7-stock-sync/sync-rapid-inv-sales.js --dry-run       # não escreve nada
 *   node cin7-stock-sync/sync-rapid-inv-sales.js --verbose       # log detalhado
 *
 * Como funciona:
 *   1. Lê SOs completados de cin7_mirror.order_pipeline (já populada
 *      pelo order-pipeline-sync.js que roda a cada hora)
 *   2. Pula os que já estão em rapid_inv._sales_processed_orders (cache)
 *   3. Para cada SO novo: chama Cin7 /sale?ID={id} para pegar as linhas
 *   4. Agrega por (week_start, sku) e upsert em rapid_inv.weekly_sales
 *   5. Marca SO como processado no cache
 *
 * Rate limit:
 *   Reutiliza o Cin7ApiClient existente, que respeita 60 calls/min
 *   por padrão. Throttle automático.
 *
 * Idempotente: pode rodar quantas vezes quiser.
 *
 * Crontab sugerida (rodar 1× por dia, 3 AM):
 *   0 3 * * * cd /path/to/LabelsApp_Final && \
 *             node cin7-stock-sync/sync-rapid-inv-sales.js >> logs/rapid-inv-sales.log 2>&1
 *
 * Primeira execução: pode levar 30-60 min (depende da quantidade de SOs).
 * Execuções subsequentes: ~1 min (só novos SOs).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createClient } = require('@supabase/supabase-js');

// ─── Cin7 client standalone (não importa sync-service para não disparar
//      o main() top-level dele) ───────────────────────────────────────
const CIN7_BASE_URL = process.env.CIN7_BASE_URL
  || 'https://inventory.dearsystems.com/ExternalApi/v2';
const CIN7_THROTTLE_MS = 1100;   // ~55 calls/min (margem do limite de 60)
const CIN7_TIMEOUT_MS  = 30000;
const CIN7_MAX_RETRIES = 4;

let _lastCallAt = 0;
async function cin7Throttle() {
  const since = Date.now() - _lastCallAt;
  if (since < CIN7_THROTTLE_MS) {
    await new Promise(r => setTimeout(r, CIN7_THROTTLE_MS - since));
  }
}

async function cin7Get(endpoint, params = {}) {
  const url = new URL(`${CIN7_BASE_URL}/${endpoint}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  let lastErr;
  for (let attempt = 1; attempt <= CIN7_MAX_RETRIES; attempt++) {
    await cin7Throttle();
    try {
      const controller = new AbortController();
      const tId = setTimeout(() => controller.abort(), CIN7_TIMEOUT_MS);
      const r = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'api-auth-accountid': process.env.CIN7_ACCOUNT_ID,
          'api-auth-applicationkey': process.env.CIN7_API_KEY,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(tId);
      _lastCallAt = Date.now();
      if (r.status === 429) {
        const back = Math.min(1000 * 2 ** attempt + Math.random() * 500, 30000);
        await new Promise(rr => setTimeout(rr, back));
        continue;
      }
      if (r.status === 503) {
        const back = Math.min(2000 * 2 ** attempt + Math.random() * 1000, 60000);
        await new Promise(rr => setTimeout(rr, back));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt < CIN7_MAX_RETRIES) {
        await new Promise(rr => setTimeout(rr, 1500 * attempt));
      }
    }
  }
  throw lastErr || new Error('cin7Get failed');
}

// ─── CLI args ──────────────────────────────────────────────
const args = process.argv.slice(2);
function argInt(name, def) {
  const a = args.find(x => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) || def : def;
}
const WEEKS_BACK = argInt('weeks', 13);
const LIMIT      = argInt('limit', 0);
const DRY_RUN    = args.includes('--dry-run');
const VERBOSE    = args.includes('--verbose');
const FLUSH_EVERY = 100;     // commit a cada 100 SOs processados

// ─── Helpers ───────────────────────────────────────────────
function ts() { return new Date().toISOString(); }
function log(msg, kind = 'info') {
  if (kind === 'debug' && !VERBOSE) return;
  console.log(`[${ts()}] [${kind.toUpperCase()}] ${msg}`);
}

function weekStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());           // back to Sunday
  return d.toISOString().slice(0, 10);
}

// ─── Sanity check ──────────────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ Falta SUPABASE_URL ou SUPABASE_SERVICE_KEY no .env');
  process.exit(2);
}
if (!process.env.CIN7_ACCOUNT_ID || !process.env.CIN7_API_KEY) {
  console.error('❌ Falta CIN7_ACCOUNT_ID ou CIN7_API_KEY no .env');
  process.exit(2);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// ─── 1. Lê SOs completados do mirror ───────────────────────
async function getCompletedSOIds() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - WEEKS_BACK * 7);
  cutoff.setHours(0, 0, 0, 0);

  let all = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .schema('cin7_mirror')
      .from('order_pipeline')
      .select('id, number, completed_at, updated_at, status')
      .eq('type', 'SO')
      .in('status', ['COMPLETED', 'CLOSED'])
      .gte('updated_at', cutoff.toISOString())
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ─── 2. Quais já foram processados ────────────────────────
async function getAlreadyProcessedIds() {
  const ids = new Set();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabase
      .schema('rapid_inv')
      .from('_sales_processed_orders')
      .select('sale_id')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) ids.add(r.sale_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

// ─── 3. Detalhes de uma sale (linhas) ─────────────────────
async function fetchSaleDetails(saleId) {
  return await cin7Get('sale', { ID: saleId });
}

// Cin7 sale shape varies. Extract line items robustly.
function extractLineItems(sale) {
  const items = [];
  const pushLine = (line, dateStr) => {
    const sku = (line.SKU || line.Sku || line.Code || '').toString().trim();
    const qty = Number(line.Quantity ?? line.Qty ?? 0);
    const total = Number(line.Total ?? line.TotalPrice ?? line.LineTotal ?? 0);
    const wk = weekStart(dateStr);
    if (sku && qty > 0 && wk) items.push({ sku, qty, sale_value: total, week_start: wk });
  };

  // Estrutura 1: top-level Invoices[].Lines[]
  if (Array.isArray(sale.Invoices)) {
    for (const inv of sale.Invoices) {
      const dt = inv.Date || inv.InvoiceDate || sale.CompletedDate || sale.OrderDate;
      for (const line of (inv.Lines || [])) pushLine(line, dt);
    }
  }
  // Estrutura 2: top-level Invoice.Lines
  if (items.length === 0 && sale.Invoice && Array.isArray(sale.Invoice.Lines)) {
    const dt = sale.Invoice.Date || sale.Invoice.InvoiceDate || sale.CompletedDate;
    for (const line of sale.Invoice.Lines) pushLine(line, dt);
  }
  // Estrutura 3: fulfillments / shipments com Lines
  if (items.length === 0 && Array.isArray(sale.Fulfilments)) {
    for (const f of sale.Fulfilments) {
      const dt = f.ShippedDate || f.Date || sale.CompletedDate;
      for (const line of (f.Lines || f.Shipment?.Lines || [])) pushLine(line, dt);
    }
  }
  // Estrutura 4 (fallback): Order.Lines com OrderDate (não-ideal mas serve)
  if (items.length === 0 && sale.Order && Array.isArray(sale.Order.Lines)) {
    const dt = sale.Order.OrderDate || sale.OrderDate || sale.CompletedDate;
    for (const line of sale.Order.Lines) pushLine(line, dt);
  }
  return items;
}

// ─── 4. Upsert agregados em weekly_sales ──────────────────
async function upsertWeeklyAggregates(aggMap) {
  const rows = Array.from(aggMap.values());
  if (rows.length === 0) return 0;
  if (DRY_RUN) {
    log(`[DRY] would upsert ${rows.length} rows in weekly_sales`, 'debug');
    return rows.length;
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({
      week_start: r.week_start,
      sku:        r.sku,
      qty:        r.qty,
      sale_value: r.sale_value,
    }));
    const { error } = await supabase
      .schema('rapid_inv')
      .from('weekly_sales')
      .upsert(batch, { onConflict: 'week_start,sku' });
    if (error) throw new Error(`upsert weekly_sales: ${error.message}`);
    inserted += batch.length;
  }
  return inserted;
}

// ─── 5. Marca SO como processado ──────────────────────────
async function markProcessed(records) {
  if (records.length === 0 || DRY_RUN) return;
  const { error } = await supabase
    .schema('rapid_inv')
    .from('_sales_processed_orders')
    .upsert(records, { onConflict: 'sale_id' });
  if (error) throw new Error(`upsert _sales_processed_orders: ${error.message}`);
}

// ─── Main ──────────────────────────────────────────────────
(async () => {
  const startedAt = Date.now();
  log(`Fase A — Sync Sales históricos`);
  log(`weeks=${WEEKS_BACK}  dry-run=${DRY_RUN}  limit=${LIMIT || 'none'}`);

  log('1/4 Reading completed SOs from cin7_mirror.order_pipeline…');
  const allSOs = await getCompletedSOIds();
  log(`     → found ${allSOs.length} SOs in window`);

  log('2/4 Reading already-processed cache…');
  const done = await getAlreadyProcessedIds();
  log(`     → already processed: ${done.size}`);

  let todo = allSOs.filter(so => !done.has(so.id));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  log(`3/4 To process: ${todo.length}`);

  if (todo.length === 0) {
    log('Nothing to do. Exiting.');
    process.exit(0);
  }

  const estMinutes = Math.ceil(todo.length / 50);
  log(`     ETA ~${estMinutes} min at 50 calls/min`);

  let aggMap = new Map();
  let processedRecords = [];
  let processed = 0;
  let errors = 0;
  let lineCount = 0;

  for (const so of todo) {
    try {
      const sale = await fetchSaleDetails(so.id);
      const lines = extractLineItems(sale);
      let totalQty = 0;
      for (const line of lines) {
        const key = `${line.week_start}|${line.sku}`;
        const ex = aggMap.get(key) || { week_start: line.week_start, sku: line.sku, qty: 0, sale_value: 0 };
        ex.qty += line.qty;
        ex.sale_value += line.sale_value;
        aggMap.set(key, ex);
        totalQty += line.qty;
      }
      lineCount += lines.length;
      processedRecords.push({
        sale_id: so.id,
        sale_number: so.number,
        completed_at: so.completed_at,
        items_count: lines.length,
        total_qty: totalQty,
        cin7_modified: so.updated_at,
      });
      processed++;
      if (VERBOSE) log(`  ${so.number}: ${lines.length} lines, total qty ${totalQty}`, 'debug');
      if (processed % 25 === 0) log(`     …${processed}/${todo.length}  (${lineCount} lines)`);
      if (processed % FLUSH_EVERY === 0) {
        await upsertWeeklyAggregates(aggMap);
        await markProcessed(processedRecords);
        aggMap = new Map();
        processedRecords = [];
      }
    } catch (err) {
      errors++;
      log(`  ERR ${so.number || so.id}: ${err.message}`, 'warn');
      if (errors > 50) {
        log(`Too many errors (${errors}). Aborting.`, 'error');
        break;
      }
    }
  }

  log('4/4 Final flush…');
  const upserted = await upsertWeeklyAggregates(aggMap);
  await markProcessed(processedRecords);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  log('======================================================');
  log(` Done in ${elapsed}s`);
  log(`   SOs processed: ${processed}`);
  log(`   Lines extracted: ${lineCount}`);
  log(`   Aggregate rows: ${upserted}`);
  log(`   Errors: ${errors}`);
  log('======================================================');
  process.exit(0);
})().catch(e => {
  console.error(`[${ts()}] FATAL:`, e);
  process.exit(1);
});
