/**
 * wms-sync.js — populate our owned bin/pickface registry from the Cin7 mirror,
 * with the validation/cleanup gate the analysis flagged as mandatory. Reads
 * cin7_mirror.* (no Cin7 API calls); writes wms.bins + wms.pickface. Run on
 * demand or on a schedule. Idempotent (upsert).
 *
 * Cleanup rules (from the live audit of cin7_mirror.locations):
 *   - skip barcode-named "bins" (all digits) and branch-code pollution
 *   - classify bin_type from the MA-{aisle}-{bay}-L{level}[-P{pos}] grammar:
 *       -P<n>  → bulk (pallet position),  DOCK/GA/PRODUCTION → staging,
 *       plain MA- → pickface candidate,  else unknown
 */
'use strict';

function wms(sb) { return sb.schema('wms'); }
const BRANCH_CODES = /^(BNE|CFS|GC|HBT|CNS|MEL|SYD|SC)\b/i;
const isBarcodeName = (s) => /^\d{6,}$/.test(String(s || '').trim());

function classify(binCode) {
  const b = String(binCode || '').toUpperCase();
  if (/DOCK|PRODUCTION|STAGING|-GA\b|^GA-/.test(b)) return 'staging';
  if (/-P\d+$/.test(b)) return 'bulk';
  if (/^MA-[A-Z]-\d+-L\d+/.test(b)) return 'pickface';
  return 'unknown';
}

async function syncBins(sb) {
  const cm = sb.schema('cin7_mirror');
  // pull all locations (roots + child bins)
  let from = 0, size = 1000, all = [];
  while (true) {
    const { data, error } = await cm.from('locations').select('id,name,parent_id,is_deprecated').range(from, from + size - 1);
    if (error) throw new Error(`syncBins: ${error.message}`);
    if (!data || !data.length) break;
    all = all.concat(data); if (data.length < size) break; from += size; if (from > 20000) break;
  }
  const roots = {}; all.forEach((l) => { if (!l.parent_id) roots[l.id] = l.name; });

  const rows = [], stats = { total: 0, kept: 0, skipped: 0 };
  for (const l of all) {
    if (!l.parent_id) continue;               // roots are warehouses, not bins
    stats.total++;
    const name = String(l.name || '').trim();
    if (isBarcodeName(name) || BRANCH_CODES.test(name) || !name) { stats.skipped++; continue; }
    const whName = roots[l.parent_id] || 'Unknown';
    rows.push({
      warehouse_id: l.parent_id, warehouse_name: whName, bin_code: name,
      cin7_location_id: l.id, bin_type: classify(name), active: !l.is_deprecated,
      synced_at: new Date().toISOString(),
    });
    stats.kept++;
  }
  // upsert in chunks
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await wms(sb).from('bins').upsert(rows.slice(i, i + 500), { onConflict: 'warehouse_id,bin_code' });
    if (error) throw new Error(`syncBins upsert: ${error.message}`);
  }
  return stats;
}

async function syncPickface(sb, mainWarehouseId) {
  const cm = sb.schema('cin7_mirror');
  const WH = mainWarehouseId || process.env.WMS_MAIN_WAREHOUSE_ID || '907821e3-c06b-4bf1-a8af-888bc3a2031f';
  let from = 0, size = 1000, rows = [], scanned = 0;
  while (true) {
    const { data, error } = await cm.from('products').select('sku,stock_locator').range(from, from + size - 1);
    if (error) throw new Error(`syncPickface: ${error.message}`);
    if (!data || !data.length) break;
    scanned += data.length;
    data.forEach((p) => {
      const loc = String(p.stock_locator || '').trim().toUpperCase();
      if (/^MA-[A-Z]-\d+-L\d+/.test(loc)) rows.push({ warehouse_id: WH, sku: p.sku, bin_code: loc, rank: 1, source: 'stock_locator', updated_at: new Date().toISOString() });
    });
    if (data.length < size) break; from += size; if (from > 40000) break;
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await wms(sb).from('pickface').upsert(rows.slice(i, i + 500), { onConflict: 'warehouse_id,sku,bin_code' });
    if (error) throw new Error(`syncPickface upsert: ${error.message}`);
  }
  return { scanned, pickfaces: rows.length };
}

module.exports = { syncBins, syncPickface, classify };
