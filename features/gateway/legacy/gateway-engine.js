/**
 * Gateway Transfer Engine — Backend (Node.js)
 *
 * Manages Gateway warehouse shelf allocations, Cin7 stock transfers,
 * and movement history.
 *
 * Key Features:
 *   - Shelf map: all physical shelves A–G + E-FLOOR with allocations
 *   - Transfer Builder: select items → consolidate same SKU → one Cin7 transfer
 *   - FIFO tracking: dates on allocations, >30d / >60d / >90d alerts
 *   - Seed: parse "Gateway location map" file to bootstrap data
 *   - Movement history: permanent log of all inbound/outbound
 *
 * Cin7 Transfer Rules:
 *   - OUTBOUND (GW→MW): FROM = MA-GA bin, TO = MW receiving
 *   - INBOUND  (MW→GW): FROM = MA-DOCK bin, TO = MA-GA bin
 *   - Same SKU from multiple shelves → ONE transfer line (API rejects duplicates)
 */

const fetch = require('node-fetch');
const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// ─── Cin7 Config ───
const CIN7 = {
  baseUrl:   'https://inventory.dearsystems.com/ExternalApi/v2',
  accountId: process.env.CIN7_ACCOUNT_ID || '',
  apiKey:    process.env.CIN7_API_KEY     || '',
};

// ─── Supabase Config ───
const SUPABASE_URL  = process.env.SUPABASE_URL      || '';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY  || '';

// ─── Transfer Config ───
const RATE_DELAY       = 2500;   // 2.5s between Cin7 calls
const GW_BIN_PREFIX    = 'MA-GA';    // Gateway bin name in Cin7
const DOCK_BIN         = 'MA-DOCK';  // Dock bin for inbound
const MW_LOCATION_NAME = 'Main Warehouse';

// ─── In-memory caches ───
let binCache     = null;
let binCacheTime = 0;
const BIN_CACHE_TTL = 3600000; // 1 hour
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════
// CIN7 HELPERS
// ═══════════════════════════════════════════════════

async function cin7Get(endpoint) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    timeout: 20000,
  });
  if (res.status === 429) {
    console.warn('⚠️ Cin7 rate limit hit, waiting 25s...');
    await delay(25000);
    return cin7Get(endpoint);
  }
  if (!res.ok) throw new Error(`Cin7 ${res.status}: ${res.statusText} (${endpoint})`);
  return res.json();
}

async function cin7Post(endpoint, body) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    body: JSON.stringify(body),
    timeout: 20000,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Cin7 POST ${res.status}: ${txt} (${endpoint})`);
  }
  return res.json();
}

async function cin7Put(endpoint, body) {
  const url = `${CIN7.baseUrl}/${endpoint}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'api-auth-accountid': CIN7.accountId,
      'api-auth-applicationkey': CIN7.apiKey,
    },
    body: JSON.stringify(body),
    timeout: 20000,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Cin7 PUT ${res.status}: ${txt} (${endpoint})`);
  }
  return res.json();
}

// ═══════════════════════════════════════════════════
// BIN CACHE (fetches Cin7 location bin IDs)
// ═══════════════════════════════════════════════════

async function getBinCache() {
  if (binCache && Date.now() - binCacheTime < BIN_CACHE_TTL) return binCache;
  console.log('📍 [Gateway] Building bin cache...');
  binCache = new Map();
  let page = 1;
  while (true) {
    await delay(RATE_DELAY);
    const data = await cin7Get(`ref/location?Page=${page}&Limit=100&Name=${encodeURIComponent(MW_LOCATION_NAME)}`);
    const locs = data.LocationList || [];
    for (const loc of locs) {
      if (loc.Bins) {
        for (const bin of loc.Bins) binCache.set(bin.Name, bin.ID);
      }
    }
    if (locs.length < 100) break;
    page++;
  }
  binCacheTime = Date.now();
  console.log(`📍 [Gateway] Cached ${binCache.size} bin IDs`);
  return binCache;
}

// ═══════════════════════════════════════════════════
// SUPABASE HELPERS
// ═══════════════════════════════════════════════════

const SB_HEADERS = {
  'apikey': SUPABASE_ANON,
  'Authorization': `Bearer ${SUPABASE_ANON}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal',
};

async function sbGet(table, query = '', schema = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const headers = { ...SB_HEADERS, 'Prefer': '' };
  if (schema) headers['Accept-Profile'] = schema;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${table}: ${res.status} ${txt}`);
  }
  return res.json();
}

async function sbPost(table, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase POST ${table}: ${res.status} ${txt}`);
  }
  return res.json();
}

async function sbPatch(table, query, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${table}: ${res.status} ${txt}`);
  }
  return res.json();
}

async function sbDelete(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase DELETE ${table}: ${res.status} ${txt}`);
  }
}

// ═══════════════════════════════════════════════════
// SHELVES + ALLOCATIONS
// ═══════════════════════════════════════════════════

async function getAllShelves() {
  const shelves = await sbGet('gateway_shelves', 'select=*&order=area.asc,shelf_number.asc.nullslast');
  const allocations = await sbGet('gateway_allocations', 'select=*&status=eq.active&order=stock_date.asc.nullslast');

  // Group allocations by shelf
  const byShelf = {};
  for (const a of allocations) {
    if (!byShelf[a.shelf_id]) byShelf[a.shelf_id] = [];
    byShelf[a.shelf_id].push(a);
  }

  return shelves.map(s => ({
    ...s,
    allocations: byShelf[s.id] || [],
    itemCount: (byShelf[s.id] || []).length,
    totalQty: (byShelf[s.id] || []).reduce((sum, a) => sum + (a.qty || 0), 0),
    oldestDate: (byShelf[s.id] || []).reduce((oldest, a) => {
      if (!a.stock_date) return oldest;
      return (!oldest || a.stock_date < oldest) ? a.stock_date : oldest;
    }, null),
  }));
}

async function getAllocations({ shelf, sku, status = 'active' } = {}) {
  let query = `select=*&order=stock_date.asc.nullslast`;
  if (status) query += `&status=eq.${status}`;
  if (shelf) query += `&shelf_id=eq.${shelf}`;
  if (sku)   query += `&sku=ilike.*${sku}*`;
  return sbGet('gateway_allocations', query);
}

async function addAllocation({ shelf_id, sku, product_name, five_dc, qty, pallet_number, stock_date, transfer_ref, allocated_by, notes }) {
  const row = {
    shelf_id,
    sku: sku.toUpperCase().trim(),
    product_name: product_name || null,
    five_dc: five_dc || null,
    qty: parseInt(qty) || 0,
    pallet_number: pallet_number || null,
    stock_date: stock_date || null,
    transfer_ref: transfer_ref || null,
    status: 'active',
    allocated_by: allocated_by || 'manual',
    notes: notes || null,
  };
  return sbPost('gateway_allocations', row);
}

async function updateAllocation(id, updates) {
  return sbPatch('gateway_allocations', `id=eq.${id}`, updates);
}

async function removeAllocation(id) {
  return sbDelete('gateway_allocations', `id=eq.${id}`);
}

// ═══════════════════════════════════════════════════
// PRODUCT ID LOOKUP (for Cin7 transfers)
// ═══════════════════════════════════════════════════

async function lookupProductIds(skus) {
  if (!skus.length) return new Map();
  const result = new Map();
  const batchSize = 50;
  for (let i = 0; i < skus.length; i += batchSize) {
    const batch = skus.slice(i, i + batchSize);
    const filter = batch.map(s => `sku.eq.${encodeURIComponent(s)}`).join(',');
    const rows = await sbGet('products', `select=id,sku&or=(${filter})`, 'cin7_mirror');
    for (const r of rows) result.set(r.sku, r.id);
  }
  return result;
}

// ═══════════════════════════════════════════════════
// TRANSFER BUILDER (Cin7 API)
// ═══════════════════════════════════════════════════

/**
 * Create a Cin7 stock transfer from selected allocations.
 * CRITICAL: Consolidates same-SKU items into ONE transfer line.
 *
 * @param {string} direction - 'outbound' (GW→MW) or 'inbound' (MW→GW)
 * @param {Array} items - [{ allocationId, sku, qty }]
 * @param {string} [createdBy] - who initiated
 * @returns {Object} { success, transferId, transferRef, consolidated }
 */
async function createTransfer(direction, items, createdBy = 'user') {
  if (!items?.length) throw new Error('No items selected for transfer');

  // 1. Consolidate same SKU into one line
  const consolidated = new Map(); // sku → { totalQty, shelves[], allocationIds[], productName, fiveDc }
  for (const item of items) {
    const key = item.sku.toUpperCase().trim();
    if (!consolidated.has(key)) {
      consolidated.set(key, {
        sku: key,
        totalQty: 0,
        shelves: [],
        allocationIds: [],
        productName: item.product_name || null,
        fiveDc: item.five_dc || null,
      });
    }
    const c = consolidated.get(key);
    c.totalQty += parseInt(item.qty) || 0;
    if (item.shelf_id && !c.shelves.includes(item.shelf_id)) c.shelves.push(item.shelf_id);
    if (item.allocationId) c.allocationIds.push(item.allocationId);
  }

  const lines = Array.from(consolidated.values());
  console.log(`📦 [Gateway] Transfer ${direction}: ${lines.length} consolidated lines from ${items.length} items`);

  // 2. Lookup Cin7 ProductIDs
  const skus = lines.map(l => l.sku);
  const productIds = await lookupProductIds(skus);

  // Validate all SKUs have ProductIDs
  const missing = skus.filter(s => !productIds.get(s));
  if (missing.length) {
    console.warn(`⚠️ [Gateway] Missing ProductIDs for: ${missing.join(', ')} — will skip these`);
  }

  const validLines = lines.filter(l => productIds.has(l.sku));
  if (!validLines.length) throw new Error('No valid products found for transfer (missing Cin7 ProductIDs)');

  // 3. Resolve bin IDs
  const bins = await getBinCache();
  let fromBinId, toBinId, fromBinName, toBinName;

  if (direction === 'outbound') {
    // GW → MW: FROM = MA-GA, TO = MA-GA (stock leaves gateway as a recorded transfer)
    fromBinName = GW_BIN_PREFIX;
    toBinName   = GW_BIN_PREFIX;
    fromBinId   = bins.get(fromBinName);
    toBinId     = bins.get(toBinName);
  } else {
    // MW → GW: FROM = MA-DOCK, TO = MA-GA
    fromBinName = DOCK_BIN;
    toBinName   = GW_BIN_PREFIX;
    fromBinId   = bins.get(fromBinName);
    toBinId     = bins.get(toBinName);
  }

  if (!fromBinId) throw new Error(`Bin "${fromBinName}" not found in Cin7 location cache`);
  if (!toBinId)   throw new Error(`Bin "${toBinName}" not found in Cin7 location cache`);

  // 4. Build transfer payload
  const now         = new Date();
  const todayStr    = now.toISOString().split('T')[0];
  const readableDate = now.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
  const dirLabel    = direction === 'outbound' ? 'GW-OUT' : 'GW-IN';
  const reference   = `${dirLabel} | ${readableDate}`;

  const transferLines = validLines.map(l => ({
    ProductID: productIds.get(l.sku),
    TransferQuantity: l.totalQty,
    Comments: [
      `Gateway ${direction === 'outbound' ? 'Outbound' : 'Inbound'}`,
      `SKU: ${l.sku}  |  Qty: ${l.totalQty}`,
      l.shelves.length ? `Shelves: ${l.shelves.join(', ')}` : '',
      `Date: ${readableDate}`,
    ].filter(Boolean).join('\n'),
  }));

  // 5. Create transfer as DRAFT
  await delay(RATE_DELAY);
  const result = await cin7Post('stockTransfer', {
    Status: 'DRAFT',
    From: fromBinId,
    To: toBinId,
    Reference: reference,
    Lines: transferLines,
  });

  const transferId  = result?.TaskID || result?.ID || result?.StockTransferID || null;
  let transferRef   = result?.Number || result?.Reference || null;
  let transferStatus = 'DRAFT';

  // 6. Complete the transfer
  if (transferId) {
    try {
      await delay(RATE_DELAY);
      const completed = await cin7Put('stockTransfer', {
        TaskID: transferId,
        From: fromBinId,
        To: toBinId,
        Status: 'COMPLETED',
        CompletionDate: todayStr,
        Reference: reference,
        CostDistributionType: 'Cost',
        SkipOrder: true,
        Lines: transferLines.map(l => ({ ...l, Comments: l.Comments })),
      });
      transferRef    = completed?.Number || transferRef;
      transferStatus = 'COMPLETED';
    } catch (e) {
      console.warn(`⚠️ [Gateway] Could not complete transfer ${transferId}: ${e.message} — left as DRAFT`);
    }
  }

  // 7. Mark allocations as transferred_out (for outbound) & log history
  for (const line of validLines) {
    // Mark allocations
    if (direction === 'outbound') {
      for (const allocId of line.allocationIds) {
        try {
          await sbPatch('gateway_allocations', `id=eq.${allocId}`, {
            status: 'transferred_out',
            notes: `Transferred via ${transferRef || transferId || 'unknown'} on ${readableDate}`,
          });
        } catch (e) {
          console.warn(`⚠️ [Gateway] Could not mark allocation ${allocId}: ${e.message}`);
        }
      }
    }

    // Log movement
    try {
      await sbPost('gateway_movement_history', {
        direction,
        sku: line.sku,
        product_name: line.productName,
        five_dc: line.fiveDc,
        qty: line.totalQty,
        from_shelves: line.shelves.join(', ') || null,
        to_location: direction === 'outbound' ? toBinName : 'Gateway Shelf',
        transfer_ref: transferRef,
        cin7_transfer_id: transferId,
        stock_date: todayStr,
        created_by: createdBy,
      });
    } catch (e) {
      console.warn(`⚠️ [Gateway] Could not log movement for ${line.sku}: ${e.message}`);
    }
  }

  return {
    success: true,
    transferId,
    transferRef,
    transferStatus,
    consolidated: validLines.map(l => ({ sku: l.sku, qty: l.totalQty, shelves: l.shelves })),
    skippedSkus: missing,
  };
}

// ═══════════════════════════════════════════════════
// MOVEMENT HISTORY
// ═══════════════════════════════════════════════════

async function getHistory({ direction, sku, limit = 100, offset = 0 } = {}) {
  let query = `select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
  if (direction) query += `&direction=eq.${direction}`;
  if (sku) query += `&sku=ilike.*${sku}*`;
  return sbGet('gateway_movement_history', query);
}

// ═══════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════

async function getStats() {
  const shelves = await sbGet('gateway_shelves', 'select=id,area,shelf_type,active');
  const allocations = await sbGet('gateway_allocations', 'select=id,shelf_id,qty,stock_date,sku&status=eq.active');

  const usedShelves = new Set(allocations.map(a => a.shelf_id));
  const today = new Date();

  let fifo30 = 0, fifo60 = 0, fifo90 = 0;
  for (const a of allocations) {
    if (!a.stock_date) continue;
    const d = new Date(a.stock_date);
    const days = Math.floor((today - d) / 86400000);
    if (days > 90) fifo90++;
    else if (days > 60) fifo60++;
    else if (days > 30) fifo30++;
  }

  const areas = {};
  for (const s of shelves) {
    if (!areas[s.area]) areas[s.area] = { total: 0, used: 0, empty: 0 };
    areas[s.area].total++;
    if (usedShelves.has(s.id)) areas[s.area].used++;
    else areas[s.area].empty++;
  }

  return {
    totalShelves: shelves.length,
    usedShelves: usedShelves.size,
    emptyShelves: shelves.length - usedShelves.size,
    totalAllocations: allocations.length,
    totalQty: allocations.reduce((sum, a) => sum + (a.qty || 0), 0),
    uniqueSkus: new Set(allocations.map(a => a.sku)).size,
    fifo: { over30d: fifo30, over60d: fifo60, over90d: fifo90 },
    areas,
  };
}

// ═══════════════════════════════════════════════════// AUDIT: Compare Gateway map vs Cin7 MA-GA stock
// ═══════════════════════════════════════════════════════════

async function getAuditData() {
  // 1. Get all active gateway allocations (our map)
  const allocations = await sbGet('gateway_allocations', 'select=id,shelf_id,sku,product_name,five_dc,qty,pallet_number,stock_date&status=eq.active');

  // 2. Get Cin7 stock snapshot for Gateway LOCATION (not Main Warehouse bin)
  //    Gateway is a separate Cin7 location with no bins — just total per SKU
  let cin7Stock = [];
  try {
    cin7Stock = await sbGet('stock_snapshot', 'select=sku,product_name,barcode,on_hand,available,allocated&location_name=eq.Gateway&on_hand=gt.0', 'cin7_mirror');
  } catch (e) {
    console.warn('⚠️ [Gateway Audit] Could not fetch cin7_mirror stock:', e.message);
  }

  // 3. Get known products from cin7_mirror for validation
  let knownProducts = new Map(); // sku → { name, barcode }
  try {
    const products = await sbGet('products', 'select=sku,name,barcode&status=eq.Active', 'cin7_mirror');
    for (const p of products) knownProducts.set(p.sku.toUpperCase().trim(), p);
  } catch (e) {
    console.warn('⚠️ [Gateway Audit] Could not fetch products:', e.message);
  }

  // 4. Aggregate gateway allocations by SKU
  const mapBySku = {}; // sku → { totalQty, shelves: [{shelf_id, qty, five_dc, pallet_number}] }
  for (const a of allocations) {
    const sku = (a.sku || '').toUpperCase().trim();
    if (!sku) continue;
    if (!mapBySku[sku]) mapBySku[sku] = { totalQty: 0, shelves: [], five_dc: a.five_dc, product_name: a.product_name };
    mapBySku[sku].totalQty += a.qty || 0;
    mapBySku[sku].shelves.push({ shelf_id: a.shelf_id, qty: a.qty, five_dc: a.five_dc, pallet_number: a.pallet_number });
    if (a.five_dc && !mapBySku[sku].five_dc) mapBySku[sku].five_dc = a.five_dc;
    if (a.product_name && !mapBySku[sku].product_name) mapBySku[sku].product_name = a.product_name;
  }

  // 5. Aggregate Cin7 stock by SKU
  const cin7BySku = {}; // sku → { on_hand, available, allocated, product_name, barcode }
  for (const s of cin7Stock) {
    const sku = (s.sku || '').toUpperCase().trim();
    if (!sku) continue;
    if (!cin7BySku[sku]) cin7BySku[sku] = { on_hand: 0, available: 0, allocated: 0, product_name: s.product_name, barcode: s.barcode };
    cin7BySku[sku].on_hand += parseFloat(s.on_hand) || 0;
    cin7BySku[sku].available += parseFloat(s.available) || 0;
    cin7BySku[sku].allocated += parseFloat(s.allocated) || 0;
  }

  // 6. Build audit results — single flat list, all products together
  const allSkus = new Set([...Object.keys(mapBySku), ...Object.keys(cin7BySku)]);
  const results = [];

  for (const sku of allSkus) {
    const mapData  = mapBySku[sku] || null;
    const cin7Data = cin7BySku[sku] || null;

    const mapQty  = mapData ? mapData.totalQty : 0;
    const cin7Qty = cin7Data ? cin7Data.on_hand : 0;
    const diff    = cin7Qty - mapQty;

    const row = {
      sku,
      product_name: cin7Data?.product_name || mapData?.product_name || knownProducts.get(sku)?.name || null,
      five_dc: mapData?.five_dc || null,
      barcode: cin7Data?.barcode || knownProducts.get(sku)?.barcode || null,
      map_qty: mapQty,
      cin7_qty: Math.round(cin7Qty),
      difference: Math.round(diff),
      shelves: mapData?.shelves || [],
      in_map: !!mapData,
      in_cin7: !!cin7Data,
    };

    // Determine status
    if (!mapData && cin7Data) {
      row.status = 'cin7_only';
      row.status_label = 'Cin7 GW only';
    } else if (mapData && !cin7Data) {
      row.status = 'map_only';
      row.status_label = 'Map only';
    } else if (diff === 0) {
      row.status = 'match';
      row.status_label = 'Match ✓';
    } else {
      row.status = 'mismatch';
      row.status_label = diff > 0 ? `Cin7 GW +${Math.round(diff)}` : `Map +${Math.round(Math.abs(diff))}`;
    }

    results.push(row);
  }

  // Sort: discrepancies first, then alphabetical
  const statusOrder = { map_only: 0, mismatch: 1, cin7_only: 2, match: 3 };
  results.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.sku.localeCompare(b.sku));

  // Summary stats
  const totalMatch    = results.filter(r => r.status === 'match').length;
  const totalMismatch = results.filter(r => r.status === 'mismatch').length;
  const totalCin7Only = results.filter(r => r.status === 'cin7_only').length;
  const totalMapOnly  = results.filter(r => r.status === 'map_only').length;
  const totalCin7Qty  = Object.values(cin7BySku).reduce((s, v) => s + v.on_hand, 0);
  const totalMapQty   = Object.values(mapBySku).reduce((s, v) => s + v.totalQty, 0);

  return {
    results,
    summary: {
      total_skus: allSkus.size,
      total_match: totalMatch,
      total_mismatch: totalMismatch,
      total_cin7_only: totalCin7Only,
      total_map_only: totalMapOnly,
      cin7_gw_total_qty: Math.round(totalCin7Qty),
      map_total_qty: totalMapQty,
      qty_difference: Math.round(totalCin7Qty - totalMapQty),
    },
  };
}

// ═══════════════════════════════════════════════════════════// SEED: Parse "Gateway location map" file
// ═══════════════════════════════════════════════════

/**
 * Special shelf labels — if SKU matches these, mark shelf_type = 'special'
 */
const SPECIAL_LABELS = [
  'Office Files', 'Trash', 'Large Boxes', 'Damaged Stock', 'Faulty',
  'DRIVERS', 'SPARE DRIVERS', 'Invoices', 'Promo Esky', 'Extrusion Offcuts',
  'PANELS WITH NO SCREWS', 'JACKSON SAMPLES', 'ALEX FAULTY HIBAYS',
  'MIX OF OLD PANELS',
];

function isSpecialLabel(text) {
  if (!text) return false;
  const upper = text.toUpperCase().trim();
  return SPECIAL_LABELS.some(l => upper.includes(l.toUpperCase()));
}

function isValidSku(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  // Valid SKUs typically start with R, a digit, or known patterns
  if (/^R\d/i.test(t)) return true;
  if (/^R-/i.test(t)) return true;
  if (/^\d+V-/i.test(t)) return true;     // 24V-IP20-...
  if (/^DEK-/i.test(t)) return true;       // DEK-EVOII50-WH
  if (/^BC-/i.test(t)) return true;
  // If it looks like a code (letters+numbers, no long spaces)
  if (/^[A-Z0-9][-A-Z0-9._]+$/i.test(t) && t.length > 3) return true;
  return false;
}

/**
 * Parse a date from the map's varied formats:
 * "16-Feb", "28-Sep", "25-Mar-25", "12-Feb-25", "8-Jan-26", "17-07", "45928" (Excel serial)
 */
function parseMapDate(raw) {
  if (!raw || !raw.trim()) return null;
  const t = raw.trim();

  // Excel serial number (5 digits) — skip these
  if (/^\d{5}$/.test(t)) return null;

  // "17-07" format (day-month, assume current year)
  if (/^\d{1,2}-\d{2}$/.test(t)) {
    const [d, m] = t.split('-');
    const year = new Date().getFullYear();
    const date = new Date(year, parseInt(m) - 1, parseInt(d));
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    return null;
  }

  // "16-Feb" or "28-Sep" (day-month, no year)
  if (/^\d{1,2}-[A-Za-z]{3}$/.test(t)) {
    // Try current year first, then previous year
    const year = new Date().getFullYear();
    let date = new Date(`${t}-${year}`);
    if (isNaN(date.getTime())) date = new Date(`${t}-${year - 1}`);
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    return null;
  }

  // "25-Mar-25" or "12-Feb-25" (day-month-YY)
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2}$/.test(t)) {
    const parts = t.split('-');
    const yy = parseInt(parts[2]);
    const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
    const date = new Date(`${parts[0]}-${parts[1]}-${fullYear}`);
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    return null;
  }

  // "8-Jan-26" or "2-Oct-25" or "10-Sep-25" (day-month-YY)
  if (/^\d{1,2}-[A-Za-z]{3}-\d{2,4}$/.test(t)) {
    const parts = t.split('-');
    let yr = parseInt(parts[2]);
    if (yr < 100) yr = yr < 50 ? 2000 + yr : 1900 + yr;
    const date = new Date(`${parts[0]}-${parts[1]}-${yr}`);
    if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    return null;
  }

  // "1-Jul-25" or similar
  const lastTry = new Date(t);
  if (!isNaN(lastTry.getTime())) return lastTry.toISOString().split('T')[0];

  return null;
}

/**
 * Determine the area from a shelf ID:
 *   A1-A110 → 'A', B1-B100 → 'B', ..., E-FLOOR → 'E-FLOOR'
 */
function shelfArea(shelfId) {
  if (!shelfId) return null;
  const id = shelfId.trim().toUpperCase();
  if (id === 'E-FLOOR') return 'E-FLOOR';
  const m = id.match(/^([A-G])(\d+)$/i);
  return m ? m[1].toUpperCase() : null;
}

function shelfNum(shelfId) {
  if (!shelfId) return null;
  const id = shelfId.trim().toUpperCase();
  if (id === 'E-FLOOR') return null;
  const m = id.match(/^[A-G](\d+)$/i);
  return m ? parseInt(m[1]) : null;
}

/**
 * Parse the "Gateway location map" TSV file and return shelves + allocations
 */
function parseMapFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const shelves = new Map();      // shelfId → { area, shelf_number, shelf_type, label }
  const allocations = [];         // [{ shelf_id, sku, five_dc, qty, pallet_number, stock_date, transfer_ref }]

  let currentShelf = null;

  for (let i = 1; i < lines.length; i++) { // skip header
    const line = lines[i];
    if (!line.trim()) continue;

    const cols = line.split('\t');
    const fiveDc     = (cols[0] || '').trim();
    const shelfAlloc = (cols[1] || '').trim();
    const palletNum  = (cols[2] || '').trim();
    const skuRaw     = (cols[3] || '').trim();
    const qtyRaw     = (cols[4] || '').trim();
    const dateRaw    = (cols[5] || '').trim();
    // cols[6] = unit qty (duplicate), cols[7] = transfer#
    const transferRef = (cols[7] || '').trim();

    // New shelf detected if column 2 has a valid shelf name
    if (shelfAlloc && (shelfArea(shelfAlloc) || shelfAlloc.toUpperCase() === 'E-FLOOR')) {
      currentShelf = shelfAlloc.toUpperCase();
      const area = shelfArea(currentShelf) || 'E-FLOOR';
      const num  = shelfNum(currentShelf);

      if (!shelves.has(currentShelf)) {
        // Check if this is a special shelf
        let shelfType = 'stock';
        let label = null;
        if (isSpecialLabel(skuRaw)) {
          shelfType = 'special';
          label = skuRaw.trim();
        }
        if (currentShelf === 'E-FLOOR') shelfType = 'floor';

        shelves.set(currentShelf, { area, shelf_number: num, shelf_type: shelfType, label });
      }
    }

    // Add allocation if we have a valid SKU and a current shelf
    if (currentShelf && skuRaw) {
      if (isValidSku(skuRaw) && !isSpecialLabel(skuRaw)) {
        const qty = parseInt(qtyRaw) || 0;
        allocations.push({
          shelf_id: currentShelf,
          sku: skuRaw.toUpperCase().trim(),
          five_dc: fiveDc && fiveDc !== '0' ? fiveDc : null,
          qty,
          pallet_number: palletNum || null,
          stock_date: parseMapDate(dateRaw),
          transfer_ref: transferRef || null,
        });
      } else if (isSpecialLabel(skuRaw)) {
        // Update shelf label if not already set
        const shelf = shelves.get(currentShelf);
        if (shelf && !shelf.label) shelf.label = skuRaw.trim();
        if (shelf) shelf.shelf_type = 'special';
      }
    }
  }

  return { shelves: Array.from(shelves.entries()), allocations };
}

/**
 * Seed the database from the "Gateway location map" file.
 * Clears existing data and re-imports.
 */
async function seedFromMap() {
  const mapPath = path.resolve(__dirname, '../../Gateway location map');
  if (!fs.existsSync(mapPath)) {
    throw new Error(`Map file not found: ${mapPath}`);
  }

  const { shelves, allocations } = parseMapFile(mapPath);
  console.log(`🌱 [Gateway] Parsed: ${shelves.length} shelves, ${allocations.length} allocations`);

  // Clear existing
  try { await sbDelete('gateway_allocations', 'id=gt.0'); } catch {}
  try { await sbDelete('gateway_shelves', 'id=neq.DUMMY'); } catch {}

  // Insert shelves in batches
  const shelfRows = shelves.map(([id, data]) => ({
    id,
    area: data.area,
    shelf_number: data.shelf_number,
    shelf_type: data.shelf_type,
    label: data.label,
    active: true,
  }));

  const BATCH = 100;
  for (let i = 0; i < shelfRows.length; i += BATCH) {
    await sbPost('gateway_shelves', shelfRows.slice(i, i + BATCH));
  }
  console.log(`✅ [Gateway] Inserted ${shelfRows.length} shelves`);

  // Insert allocations in batches
  const allocRows = allocations.map(a => ({
    ...a,
    status: 'active',
    allocated_by: 'seed',
  }));

  for (let i = 0; i < allocRows.length; i += BATCH) {
    await sbPost('gateway_allocations', allocRows.slice(i, i + BATCH));
  }
  console.log(`✅ [Gateway] Inserted ${allocRows.length} allocations`);

  return { shelves: shelfRows.length, allocations: allocRows.length };
}

// ═══════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════

function registerGatewayRoutes(app) {

  /**
   * GET /api/gateway/shelves — All shelves with allocations
   */
  app.get('/api/gateway/shelves', async (req, res) => {
    try {
      const shelves = await getAllShelves();
      res.json({ success: true, shelves });
    } catch (err) {
      console.error('❌ [Gateway] shelves:', err);
      if (err.message.includes('42P01') || err.message.includes('does not exist')) {
        return res.status(503).json({ success: false, error: 'TABLES_NOT_CREATED', message: 'Run gateway-tables.sql in Supabase.' });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/gateway/allocations?shelf=&sku=&status=active
   */
  app.get('/api/gateway/allocations', async (req, res) => {
    try {
      const { shelf, sku, status } = req.query;
      const rows = await getAllocations({ shelf, sku, status });
      res.json({ success: true, allocations: rows });
    } catch (err) {
      console.error('❌ [Gateway] allocations:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gateway/allocations — Add manual allocation
   */
  app.post('/api/gateway/allocations', async (req, res) => {
    try {
      const result = await addAllocation(req.body);
      res.json({ success: true, allocation: result[0] || result });
    } catch (err) {
      console.error('❌ [Gateway] add allocation:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * PATCH /api/gateway/allocations/:id — Update allocation
   */
  app.patch('/api/gateway/allocations/:id', async (req, res) => {
    try {
      const result = await updateAllocation(req.params.id, req.body);
      res.json({ success: true, allocation: result[0] || result });
    } catch (err) {
      console.error('❌ [Gateway] update allocation:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * DELETE /api/gateway/allocations/:id — Remove allocation
   */
  app.delete('/api/gateway/allocations/:id', async (req, res) => {
    try {
      await removeAllocation(req.params.id);
      res.json({ success: true });
    } catch (err) {
      console.error('❌ [Gateway] delete allocation:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gateway/transfer — Create Cin7 stock transfer
   * Body: { direction: 'outbound'|'inbound', items: [{allocationId, sku, qty, shelf_id, product_name, five_dc}] }
   */
  app.post('/api/gateway/transfer', async (req, res) => {
    try {
      const { direction, items, createdBy } = req.body;
      if (!direction || !items?.length) {
        return res.status(400).json({ success: false, error: 'direction and items[] required' });
      }
      const result = await createTransfer(direction, items, createdBy || 'user');
      res.json(result);
    } catch (err) {
      console.error('❌ [Gateway] transfer:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/gateway/history?direction=&sku=&limit=100&offset=0
   */
  app.get('/api/gateway/history', async (req, res) => {
    try {
      const { direction, sku, limit, offset } = req.query;
      const rows = await getHistory({
        direction,
        sku,
        limit: parseInt(limit) || 100,
        offset: parseInt(offset) || 0,
      });
      res.json({ success: true, history: rows });
    } catch (err) {
      console.error('❌ [Gateway] history:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/gateway/stats
   */
  app.get('/api/gateway/stats', async (req, res) => {
    try {
      const stats = await getStats();
      res.json({ success: true, ...stats });
    } catch (err) {
      console.error('❌ [Gateway] stats:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * POST /api/gateway/seed — Seed from "Gateway location map" file (one-time)
   */
  app.post('/api/gateway/seed', async (req, res) => {
    try {
      const result = await seedFromMap();
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('❌ [Gateway] seed:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('✅ Gateway transfer routes registered');
}

module.exports = { registerGatewayRoutes, seedFromMap, createTransfer, getAllShelves, getStats };
