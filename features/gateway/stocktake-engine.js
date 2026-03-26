/**
 * Gateway Stocktake Engine — Backend (Node.js)
 *
 * Compares gateway_allocations (live shelf data from Transfer tab)
 * vs cin7_mirror.stock_snapshot (Cin7 system stock).
 *
 * The shelf map is maintained via the Transfer tab and stored in
 * Supabase (gateway_allocations + gateway_shelves).
 * cin7_mirror.stock_snapshot represents the ERP system's on_hand stock
 * (auto-syncs every ~2 h from Cin7).
 *
 * Endpoints:
 *   GET /api/stocktake/audit  → full comparison results + summary
 *   GET /api/stocktake/export → download report as TSV
 */

const fetch = require('node-fetch');
const path  = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ─── Config ───
const SUPABASE_URL  = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY  || '';

// ═══════════════════════════════════════════════════
// Supabase REST helper (paginated)
// ═══════════════════════════════════════════════════

async function sbGet(table, query, schema = 'public') {
  if (!SUPABASE_URL || !SUPABASE_ANON) throw new Error('Supabase credentials not configured');

  const baseUrl = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const headers = {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
  if (schema !== 'public') headers['Accept-Profile'] = schema;

  const all = [];
  let offset = 0;
  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}offset=${offset}&limit=1000`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Supabase ${table}: ${res.status} ${res.statusText} — ${body.substring(0, 200)}`);
    }
    const data = await res.json();
    if (!data || !data.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return all;
}

// ═══════════════════════════════════════════════════
// AUDIT: Compare Shelf Map (gateway_allocations) vs Cin7 System Stock
// ═══════════════════════════════════════════════════

async function getStocktakeAudit() {
  console.log('📋 [Stocktake] Running audit — Shelf Map vs Cin7 System Stock…');
  const t0 = Date.now();

  // 1. Fetch gateway_allocations (live shelf data from Transfer tab)
  let allocations = [];
  try {
    allocations = await sbGet(
      'gateway_allocations',
      'select=id,shelf_id,sku,product_name,five_dc,qty,pallet_number,stock_date&status=eq.active'
    );
  } catch (e) {
    console.warn('⚠️ [Stocktake] Could not fetch gateway_allocations:', e.message);
    if (e.message.includes('42P01') || e.message.includes('does not exist')) {
      throw new Error('Gateway tables not created. Seed data via Transfer tab first.');
    }
    throw e;
  }

  // 2. Fetch cin7_mirror.stock_snapshot (system stock)
  let cin7Stock = [];
  try {
    cin7Stock = await sbGet(
      'stock_snapshot',
      'select=sku,product_name,on_hand&location_name=eq.Gateway&on_hand=gt.0',
      'cin7_mirror'
    );
  } catch (e) {
    console.warn('⚠️ [Stocktake] Could not fetch cin7_mirror:', e.message);
  }

  // 3. Fetch known product names for enrichment
  let knownProducts = new Map();
  try {
    const products = await sbGet('products', 'select=sku,name&status=eq.Active', 'cin7_mirror');
    for (const p of products) knownProducts.set((p.sku || '').toUpperCase().trim(), p.name);
  } catch (_) {}

  console.log(`📋 [Stocktake] Shelf Map: ${allocations.length} allocations | Cin7: ${cin7Stock.length} rows`);

  // 4. Aggregate Shelf Map by SKU (with shelf detail)
  const mapBySku = {};
  for (const a of allocations) {
    const sku = (a.sku || '').toUpperCase().trim();
    if (!sku) continue;
    if (!mapBySku[sku]) {
      mapBySku[sku] = {
        totalQty: 0,
        shelves: [],
        fiveDC: a.five_dc,
        product_name: a.product_name,
      };
    }
    mapBySku[sku].totalQty += a.qty || 0;
    mapBySku[sku].shelves.push({
      shelf: a.shelf_id,
      pallet: a.pallet_number || null,
      qty: a.qty || 0,
      stock_date: a.stock_date || null,
    });
    if (a.five_dc && !mapBySku[sku].fiveDC) mapBySku[sku].fiveDC = a.five_dc;
    if (a.product_name && !mapBySku[sku].product_name) mapBySku[sku].product_name = a.product_name;
  }

  // 5. Aggregate Cin7 by SKU
  const cin7BySku = {};
  for (const s of cin7Stock) {
    const sku = (s.sku || '').toUpperCase().trim();
    if (!sku) continue;
    if (!cin7BySku[sku]) cin7BySku[sku] = { on_hand: 0, product_name: s.product_name };
    cin7BySku[sku].on_hand += parseFloat(s.on_hand) || 0;
  }

  // 6. Build unified results — union of Shelf Map SKUs + Cin7 SKUs
  const allSkus = new Set([...Object.keys(mapBySku), ...Object.keys(cin7BySku)]);
  const results = [];

  for (const sku of allSkus) {
    const mapData = mapBySku[sku] || null;
    const mapQty  = mapData ? mapData.totalQty : 0;
    const cin7Raw = cin7BySku[sku];
    const cin7Qty = cin7Raw ? Math.round(cin7Raw.on_hand) : 0;
    const diff    = cin7Qty - mapQty;
    const inSystem = !!cin7Raw;

    // Best product name from any source
    const productName = mapData?.product_name
      || cin7Raw?.product_name
      || knownProducts.get(sku)
      || null;

    const row = {
      sku,
      five_dc: mapData?.fiveDC || null,
      product_name: productName,
      map_qty: mapQty,
      sys_qty: cin7Qty,
      difference: diff,
      map_shelves: mapData?.shelves || [],
      in_map: !!mapData,
      in_system: inSystem,
    };

    // Determine status
    if (row.in_map && row.in_system) {
      if (diff === 0) {
        row.status = 'match';
        row.status_label = 'Match ✓';
      } else {
        row.status = 'mismatch';
        row.status_label = diff > 0 ? `Cin7 +${diff}` : `Map +${Math.abs(diff)}`;
      }
    } else if (row.in_map && !row.in_system) {
      row.status = 'map_only';
      row.status_label = 'Map only';
    } else {
      row.status = 'sys_only';
      row.status_label = 'Cin7 only';
    }

    results.push(row);
  }

  // Sort: issues first, then alphabetical
  const statusOrder = { map_only: 0, sys_only: 1, mismatch: 2, match: 3 };
  results.sort((a, b) =>
    (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.sku.localeCompare(b.sku)
  );

  // 7. Summary stats
  const totalMatch    = results.filter(r => r.status === 'match').length;
  const totalMismatch = results.filter(r => r.status === 'mismatch').length;
  const totalMapOnly  = results.filter(r => r.status === 'map_only').length;
  const totalSysOnly  = results.filter(r => r.status === 'sys_only').length;
  const totalOverlap  = totalMatch + totalMismatch;

  const mapSkuCount  = Object.keys(mapBySku).length;
  const cin7SkuCount = Object.keys(cin7BySku).length;
  const totalMapQty  = Object.values(mapBySku).reduce((s, v) => s + v.totalQty, 0);
  const totalCin7Qty = Object.values(cin7BySku).reduce((s, v) => s + Math.round(v.on_hand), 0);

  const matchRate = totalOverlap > 0
    ? ((totalMatch / totalOverlap) * 100).toFixed(1)
    : '0.0';

  // 8. Fetch last cin7_mirror sync run info
  let lastSync = null;
  try {
    const syncRuns = await sbGet(
      'sync_runs',
      'select=run_id,started_at,ended_at,status,duration_ms,stock_rows_synced&order=ended_at.desc&limit=1',
      'cin7_mirror'
    );
    if (syncRuns && syncRuns.length > 0) {
      const run = syncRuns[0];
      lastSync = {
        status: run.status,
        ended_at: run.ended_at,
        started_at: run.started_at,
        duration_ms: run.duration_ms,
        stock_rows: run.stock_rows_synced,
      };
    }
  } catch (e) {
    console.warn('⚠️ [Stocktake] Could not fetch sync_runs:', e.message);
  }

  const elapsed = Date.now() - t0;
  console.log(`📋 [Stocktake] Audit complete in ${elapsed}ms — ${totalMatch} match, ${totalMismatch} mismatch, ${totalMapOnly} map-only, ${totalSysOnly} cin7-only | Match rate: ${matchRate}%`);

  return {
    results,
    summary: {
      map_skus: mapSkuCount,
      sys_skus: cin7SkuCount,
      overlap: totalOverlap,
      total_match: totalMatch,
      total_mismatch: totalMismatch,
      total_map_only: totalMapOnly,
      total_sys_only: totalSysOnly,
      match_rate: parseFloat(matchRate),
      map_total_qty: totalMapQty,
      sys_total_qty: totalCin7Qty,
      map_allocations: allocations.length,
      cin7_rows: cin7Stock.length,
      last_sync: lastSync,
    },
  };
}

// ═══════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════

function registerStocktakeRoutes(app) {
  /**
   * GET /api/stocktake/audit — Full comparison: Shelf Map vs Cin7 System Stock
   */
  app.get('/api/stocktake/audit', async (req, res) => {
    try {
      const audit = await getStocktakeAudit();
      res.json({ success: true, ...audit });
    } catch (err) {
      console.error('❌ [Stocktake] audit error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/stocktake/export — Download report as TSV
   */
  app.get('/api/stocktake/export', async (req, res) => {
    try {
      const audit = await getStocktakeAudit();
      const lines = ['SKU\tPRODUCT\tSTATUS\tMAP_QTY\tCIN7_QTY\tDIFF\tSHELVES'];
      const order = { mismatch: 0, map_only: 1, sys_only: 2, match: 3 };
      audit.results.sort((a, b) =>
        (order[a.status] || 9) - (order[b.status] || 9) ||
        Math.abs(b.difference || 0) - Math.abs(a.difference || 0)
      );
      for (const r of audit.results) {
        const shelves = r.map_shelves
          ? r.map_shelves.map(s => `${s.shelf}(${s.qty})`).join(', ')
          : '';
        lines.push(`${r.sku}\t${r.product_name || ''}\t${r.status.toUpperCase()}\t${r.map_qty}\t${r.sys_qty}\t${r.difference}\t${shelves}`);
      }
      res.setHeader('Content-Type', 'text/tab-separated-values');
      res.setHeader('Content-Disposition', `attachment; filename="stocktake-report-${new Date().toISOString().slice(0,10)}.tsv"`);
      res.send(lines.join('\n'));
    } catch (err) {
      console.error('❌ [Stocktake] export error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('✅ Stocktake audit routes registered');
}

module.exports = { registerStocktakeRoutes, getStocktakeAudit };
