/**
 * Cin7 Snapshot Differ
 * 
 * Detects stock movements by comparing consecutive stock snapshots.
 * Since Cin7's ProductAvailability API doesn't support ModifiedSince,
 * we must fetch the full snapshot each sync and compare to the previous one.
 *
 * Flow:
 *   1. Copy current stock_snapshot → stock_snapshot_prev
 *   2. Run a full sync (updates stock_snapshot)
 *   3. Compare stock_snapshot vs stock_snapshot_prev
 *   4. Log unattributed changes as 'snapshot_delta' movements
 *   5. (Optional) Generate alerts for large or suspicious deltas
 */

class SnapshotDiffer {
  constructor(supabaseBackend) {
    this.sb = supabaseBackend;
  }

  // ──────────────────────────────────────────
  // Step 1: Save current snapshot as "previous"
  // ──────────────────────────────────────────
  async savePreviousSnapshot() {
    console.log('📸 Saving current snapshot as previous...');

    // Clear previous
    const { error: delErr } = await this.sb.schema('cin7_mirror')
      .from('stock_snapshot_prev')
      .delete()
      .neq('sku', '__never_matches__'); // delete all

    if (delErr) {
      console.error('❌ Failed to clear previous snapshot:', delErr.message);
      throw delErr;
    }

    // Copy current snapshot → previous
    // We need to read all rows and re-insert them
    let allRows = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await this.sb.schema('cin7_mirror')
        .from('stock_snapshot')
        .select('sku, product_name, location_name, bin, available, on_hand, allocated, batch')
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) throw error;
      if (data && data.length > 0) {
        allRows = allRows.concat(data);
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    }

    if (allRows.length === 0) {
      console.warn('⚠️  Current snapshot is empty — nothing to save');
      return 0;
    }

    // Insert in batches
    const batchSize = 500;
    for (let i = 0; i < allRows.length; i += batchSize) {
      const batch = allRows.slice(i, i + batchSize).map(row => ({
        sku: row.sku,
        product_name: row.product_name,
        location_name: row.location_name,
        bin: row.bin || '',
        available: row.available || 0,
        on_hand: row.on_hand || 0,
        allocated: row.allocated || 0,
        batch: row.batch || '',
        captured_at: new Date().toISOString(),
      }));

      const { error: insErr } = await this.sb.schema('cin7_mirror')
        .from('stock_snapshot_prev')
        .insert(batch);

      if (insErr) {
        console.error(`❌ Failed to insert prev snapshot batch at ${i}:`, insErr.message);
      }
    }

    console.log(`📸 Saved ${allRows.length} rows to stock_snapshot_prev`);
    return allRows.length;
  }

  // ──────────────────────────────────────────
  // Step 2: Compare current vs previous
  // ──────────────────────────────────────────
  async detectDeltas() {
    console.log('🔍 Detecting stock deltas...');

    // Fetch both snapshots into memory and compare
    // This is simple but works for ~15k rows
    const [currResult, prevResult] = await Promise.all([
      this._fetchAllFromTable('stock_snapshot'),
      this._fetchAllFromTable('stock_snapshot_prev'),
    ]);

    const current = currResult;
    const previous = prevResult;

    if (previous.length === 0) {
      console.warn('⚠️  No previous snapshot — skipping delta detection. Run savePreviousSnapshot first.');
      return [];
    }

    // Build lookup maps keyed by sku|location|bin|batch
    const makeKey = (row) => `${row.sku}|${row.location_name}|${row.bin || ''}|${row.batch || ''}`;

    const prevMap = new Map();
    previous.forEach(row => prevMap.set(makeKey(row), row));

    const currMap = new Map();
    current.forEach(row => currMap.set(makeKey(row), row));

    const deltas = [];

    // Check for changes in current vs previous
    for (const [key, currRow] of currMap) {
      const prevRow = prevMap.get(key);

      if (!prevRow) {
        // New stock entry — likely purchase receive or transfer in
        if ((currRow.on_hand || 0) > 0) {
          deltas.push({
            type: 'new_stock',
            sku: currRow.sku,
            product_name: currRow.product_name,
            location: currRow.location_name,
            bin: currRow.bin || '',
            prev_on_hand: 0,
            curr_on_hand: currRow.on_hand || 0,
            delta: currRow.on_hand || 0,
            prev_available: 0,
            curr_available: currRow.available || 0,
          });
        }
        continue;
      }

      // Check if quantity changed
      const prevOnHand = prevRow.on_hand || 0;
      const currOnHand = currRow.on_hand || 0;
      const deltaQty = currOnHand - prevOnHand;

      const prevAvail = prevRow.available || 0;
      const currAvail = currRow.available || 0;
      const deltaAvail = currAvail - prevAvail;

      if (deltaQty !== 0 || deltaAvail !== 0) {
        deltas.push({
          type: 'qty_change',
          sku: currRow.sku,
          product_name: currRow.product_name || prevRow.product_name,
          location: currRow.location_name,
          bin: currRow.bin || '',
          prev_on_hand: prevOnHand,
          curr_on_hand: currOnHand,
          delta: deltaQty,
          prev_available: prevAvail,
          curr_available: currAvail,
        });
      }
    }

    // Check for removed stock entries (was in previous, not in current)
    for (const [key, prevRow] of prevMap) {
      if (!currMap.has(key) && (prevRow.on_hand || 0) > 0) {
        deltas.push({
          type: 'stock_removed',
          sku: prevRow.sku,
          product_name: prevRow.product_name,
          location: prevRow.location_name,
          bin: prevRow.bin || '',
          prev_on_hand: prevRow.on_hand || 0,
          curr_on_hand: 0,
          delta: -(prevRow.on_hand || 0),
          prev_available: prevRow.available || 0,
          curr_available: 0,
        });
      }
    }

    console.log(`🔍 Found ${deltas.length} stock deltas`);
    return deltas;
  }

  // ──────────────────────────────────────────
  // Step 3: Log deltas as movements + check for alerts
  // ──────────────────────────────────────────
  async logDeltas(deltas) {
    if (!deltas || deltas.length === 0) {
      console.log('ℹ️  No deltas to log');
      return 0;
    }

    // Fetch existing webhook-sourced movements from last 6 hours
    // to avoid double-counting movements already attributed via webhooks
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

    const { data: recentMovements } = await this.sb.schema('cin7_mirror')
      .from('stock_movements')
      .select('sku, movement_type, quantity, from_location, to_location')
      .eq('source', 'webhook')
      .gte('detected_at', sixHoursAgo);

    // Build a set of already-attributed changes
    const attributedSet = new Set();
    if (recentMovements) {
      recentMovements.forEach(m => {
        attributedSet.add(`${m.sku}|${m.from_location || m.to_location}`);
      });
    }

    // Filter out deltas that likely correspond to webhook-attributed movements
    const unattributed = deltas.filter(d => {
      const key = `${d.sku}|${d.location}`;
      return !attributedSet.has(key);
    });

    console.log(`📝 ${deltas.length} total deltas, ${unattributed.length} unattributed`);

    if (unattributed.length === 0) return 0;

    // Convert to stock_movements records
    const movements = unattributed.map(d => ({
      detected_at: new Date().toISOString(),
      sku: d.sku,
      product_name: d.product_name,
      movement_type: 'snapshot_delta',
      reference_type: 'SnapshotDiff',
      from_location: d.delta < 0 ? d.location : null,
      from_bin: d.delta < 0 ? d.bin : null,
      to_location: d.delta > 0 ? d.location : null,
      to_bin: d.delta > 0 ? d.bin : null,
      quantity: d.delta,
      quantity_before: d.prev_on_hand,
      quantity_after: d.curr_on_hand,
      is_internal: false,
      is_external: false,
      is_anomaly: false,
      source: 'snapshot_diff',
      raw_data: {
        delta_type: d.type,
        prev_on_hand: d.prev_on_hand,
        curr_on_hand: d.curr_on_hand,
        prev_available: d.prev_available,
        curr_available: d.curr_available,
      },
    }));

    // Insert in batches
    const batchSize = 200;
    let inserted = 0;
    for (let i = 0; i < movements.length; i += batchSize) {
      const batch = movements.slice(i, i + batchSize);
      const { error } = await this.sb.schema('cin7_mirror')
        .from('stock_movements')
        .insert(batch);

      if (error) {
        console.error(`❌ Failed to insert delta movements at ${i}:`, error.message);
      } else {
        inserted += batch.length;
      }
    }

    // Check for large unattributed deltas → create alerts
    for (const d of unattributed) {
      if (Math.abs(d.delta) >= 100) {
        await this._createDeltaAlert(d);
      }
      if (d.curr_on_hand < 0) {
        await this._createNegativeStockAlert(d);
      }
    }

    console.log(`📝 Logged ${inserted} unattributed delta movements`);
    return inserted;
  }

  // ──────────────────────────────────────────
  // Full pipeline: save → (external sync) → detect → log
  // ──────────────────────────────────────────
  async runFullDiff() {
    const saved = await this.savePreviousSnapshot();
    console.log(`⏳ Previous snapshot saved (${saved} rows). Now detecting deltas vs current...`);

    const deltas = await this.detectDeltas();
    const logged = await this.logDeltas(deltas);

    return {
      previousRows: saved,
      totalDeltas: deltas.length,
      loggedMovements: logged,
    };
  }

  // ── Helpers ──

  async _fetchAllFromTable(tableName) {
    let all = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await this.sb.schema('cin7_mirror')
        .from(tableName)
        .select('*')
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) throw error;
      if (data && data.length > 0) {
        all = all.concat(data);
        hasMore = data.length === pageSize;
        page++;
      } else {
        hasMore = false;
      }
    }
    return all;
  }

  async _createDeltaAlert(delta) {
    try {
      const { error } = await this.sb.schema('cin7_mirror')
        .from('movement_alerts')
        .insert({
          alert_type: 'large_unattributed_delta',
          severity: Math.abs(delta.delta) >= 500 ? 'critical' : 'warning',
          title: `Large unattributed change: ${delta.sku}`,
          description: `${delta.product_name || delta.sku} changed by ${delta.delta > 0 ? '+' : ''}${delta.delta} units at ${delta.location}${delta.bin ? ` (${delta.bin})` : ''}. Previous: ${delta.prev_on_hand} → Current: ${delta.curr_on_hand}. No matching webhook event found.`,
          sku: delta.sku,
          product_name: delta.product_name,
          movement_type: 'snapshot_delta',
          from_location: delta.delta < 0 ? delta.location : null,
          to_location: delta.delta > 0 ? delta.location : null,
          quantity: delta.delta,
        });

      if (error) console.error('⚠️ Alert insert error:', error.message);
    } catch (e) {
      console.error('⚠️ Delta alert error:', e.message);
    }
  }

  async _createNegativeStockAlert(delta) {
    try {
      const { error } = await this.sb.schema('cin7_mirror')
        .from('movement_alerts')
        .insert({
          alert_type: 'stock_negative',
          severity: 'critical',
          title: `Negative stock: ${delta.sku}`,
          description: `${delta.product_name || delta.sku} has ${delta.curr_on_hand} on hand at ${delta.location}${delta.bin ? ` (${delta.bin})` : ''}.`,
          sku: delta.sku,
          product_name: delta.product_name,
          movement_type: 'snapshot_delta',
          from_location: delta.location,
          quantity: delta.delta,
        });

      if (error) console.error('⚠️ Alert insert error:', error.message);
    } catch (e) {
      console.error('⚠️ Negative alert error:', e.message);
    }
  }
}

module.exports = SnapshotDiffer;
