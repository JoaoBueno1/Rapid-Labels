/**
 * Cin7 Movement Processor
 * 
 * Processes webhook events by:
 *   1. Fetching full transaction details from Cin7 API
 *   2. Extracting stock movements (from/to, qty, who, reference)
 *   3. Classifying movements (internal bin transfer vs external)
 *   4. Storing in cin7_mirror.stock_movements
 *   5. Checking alert rules and creating alerts as needed
 * 
 * Cin7 Core API v2 endpoints used:
 *   GET /sale?ID={id}                — Sales Order details (fulfillment lines)
 *   GET /saleList?Search={number}    — Sales Order search
 *   GET /stockTransfer?TaskID={id}   — Stock Transfer details
 *   GET /stockAdjustment?TaskID={id} — Stock Adjustment details
 *   GET /purchase?ID={id}            — Purchase Order details (receipts)
 */

const fetch = require('node-fetch');

const CIN7_CONFIG = {
  accountId: process.env.CIN7_ACCOUNT_ID || '',
  apiKey: process.env.CIN7_API_KEY || '',
  baseUrl: 'https://inventory.dearsystems.com/ExternalApi/v2',
  timeoutMs: 30000,
};

class MovementProcessor {
  constructor(supabaseBackend) {
    this.sb = supabaseBackend;
    this.lastApiCall = 0;
  }

  // ── Cin7 API call with throttle ──
  async _cin7Request(endpoint, params = {}, _retry = 0) {
    // Throttle: 2.5s between calls — gentle enough to coexist with the other
    // Cin7 sync jobs (stock/pick-anomalies/order-pipeline) under the 60/min cap.
    const now = Date.now();
    const wait = Math.max(0, 2500 - (now - this.lastApiCall));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const url = new URL(`${CIN7_CONFIG.baseUrl}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CIN7_CONFIG.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'api-auth-accountid': CIN7_CONFIG.accountId,
          'api-auth-applicationkey': CIN7_CONFIG.apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      this.lastApiCall = Date.now();

      // Cin7 throttles bursts with 429 AND sometimes 403 (transient) — back off
      // and retry both, up to 3 times, before giving up.
      if ((response.status === 429 || response.status === 403) && _retry < 4) {
        const backoff = 3000 * Math.pow(2, _retry) + Math.floor(Math.random() * 1500); // +jitter
        console.warn(`⚠️ Cin7 ${response.status} (throttle) — retry ${_retry + 1}/4 in ${Math.round(backoff / 1000)}s`);
        await new Promise(r => setTimeout(r, backoff));
        return this._cin7Request(endpoint, params, _retry + 1);
      }

      if (!response.ok) {
        throw new Error(`Cin7 API ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  // ══════════════════════════════════════════════
  // MAIN ENTRY: Process a single webhook event
  // ══════════════════════════════════════════════
  async processWebhookEvent(eventId, topic, payload) {
    const startMs = Date.now();
    console.log(`⚙️  Processing webhook event #${eventId}: ${topic}`);

    try {
      // Mark as processing
      await this.sb.schema('cin7_mirror').from('webhook_events')
        .update({ status: 'processing' })
        .eq('id', eventId);

      let movements = [];

      // Route by REAL Cin7 Core event type (e.g. Sale/ShipmentAuthorised,
      // Sale/Voided, Purchase/StockReceivedAuthorised, Stock/AvailableStockLevelChanged).
      const t = (topic || '').toLowerCase();

      if (t.startsWith('sale/')) {
        if (t.includes('shipmentauthorised')) {
          // ONLY ship ENRICHES (needs the pick lines to detect anomalies + the
          // real stock-out). Every other sale event is recorded RAW only.
          movements = await this._processSaleOrder(payload);
        } else if (t.includes('voided') || t.includes('undo')) {
          // Cancellation → mark the order cancelled in pick_anomaly_orders in
          // real time (no Cin7 call). Best-effort.
          try {
            const pa = require('../features/pick-anomalies/pick-anomalies-engine');
            const on = payload.OrderNumber || payload.SaleOrderNumber || payload.Number;
            if (on) {
              const r = await pa.markOrderCancelledRealtime(on, t.includes('undo') ? 'UNDO' : 'VOIDED');
              console.log(`  🚫 Cancellation (realtime) ${on}: ${JSON.stringify(r)}`);
            }
          } catch (e) { console.warn(`  ⚠️ Cancellation realtime failed: ${e.message}`); }
          // Reflect VOIDED in the sales mirror too (Undo reverts to an unknown
          // status → leave it for the 2h header sync to reconcile honestly).
          if (t.includes('voided')) {
            try { await this._reflectSaleStatus(payload, 'voided'); } catch (e) { console.warn(`  ⚠️ sales_orders void reflect failed: ${e.message}`); }
          }
        } else if (t.includes('invoiceauthorised') || t.includes('invoice/')) {
          // Invoice authorised → reflect invoice status in the sales mirror in
          // real time (no Cin7 call). The 2h header sync later reconciles the
          // exact CombinedInvoiceStatus (partial/full) from Cin7.
          try { await this._reflectSaleStatus(payload, 'invoice'); } catch (e) { console.warn(`  ⚠️ sales_orders invoice reflect failed: ${e.message}`); }
        } else {
          // Pick/Pack/Created/Order/Backordered/payment… recorded RAW in
          // webhook_events — NO Cin7 call. Keeps the full lifecycle cheap; the
          // raw payload IS the timeline record (readers/wiring act on it later).
          console.log(`ℹ️  Sale event ${topic} — recorded raw (no enrichment)`);
        }
      } else if (t.includes('stock/transfer') || t.includes('stocktransfer')) {
        movements = await this._processStockTransfer(payload);
      } else if (t.includes('stock/adjustment') || t.includes('stockadjustment')) {
        movements = await this._processStockAdjustment(payload);
      } else if (t.includes('availablestocklevel')) {
        // Stock/AvailableStockLevelChanged — Cin7's only stock webhook; a
        // catch-all on-hand change with no task detail to expand. The raw
        // event is recorded; line-level detail still comes from polling.
        console.log(`ℹ️  Stock level changed — recorded (no line detail)`);
      } else if (t.startsWith('purchase/')) {
        movements = await this._processPurchaseOrder(payload);
      } else if (t.startsWith('product/')) {
        console.log(`ℹ️  Product update — no stock movement`);
      } else {
        console.warn(`⚠️  Unhandled webhook topic: ${topic}`);
      }

      // Idempotent reprocess: clear this event's prior movements + alerts so a
      // re-run (retry/backfill) never duplicates or leaves stale rows.
      await this.sb.schema('cin7_mirror').from('movement_alerts').delete().eq('webhook_event_id', eventId);
      await this.sb.schema('cin7_mirror').from('stock_movements').delete().eq('webhook_event_id', eventId);

      // Store movements
      if (movements.length > 0) {
        // Add webhook reference and source
        movements.forEach(m => {
          m.webhook_event_id = eventId;
          m.source = 'webhook';
        });

        const { error: insertErr } = await this.sb.schema('cin7_mirror')
          .from('stock_movements')
          .insert(movements);

        if (insertErr) {
          console.error('❌ Failed to insert movements:', insertErr.message);
        } else {
          console.log(`✅ Stored ${movements.length} movements from event #${eventId}`);
        }

        // Check alert rules for each movement
        for (const m of movements) {
          await this._checkAlertRules(m);
        }
      }

      // Extract affected SKUs
      const affectedSkus = [...new Set(movements.map(m => m.sku).filter(Boolean))];

      // Mark event as processed
      const durationMs = Date.now() - startMs;
      await this.sb.schema('cin7_mirror').from('webhook_events')
        .update({
          status: 'processed',
          processed_at: new Date().toISOString(),
          affected_skus: affectedSkus,
          metadata: {
            movements_created: movements.length,
            processing_duration_ms: durationMs,
          },
        })
        .eq('id', eventId);

    } catch (e) {
      console.error(`❌ Processing failed for event #${eventId}:`, e.message);

      await this.sb.schema('cin7_mirror').from('webhook_events')
        .update({
          status: 'failed',
          error_message: e.message,
          processed_at: new Date().toISOString(),
        })
        .eq('id', eventId);
    }
  }

  // Reflect a non-ship sale event into sales_orders WITHOUT a Cin7 call. Updates
  // only the affected status columns by order_number; if the order isn't mirrored
  // yet it's a no-op (the 2h header sync adds it). Never touches detail columns
  // (rep/lines/ship_date), so it enriches without wiping anything.
  async _reflectSaleStatus(payload, kind) {
    const on = payload.OrderNumber || payload.SaleOrderNumber || payload.Number;
    if (!on) return;
    let patch;
    if (kind === 'invoice') {
      patch = { invoice_status: 'INVOICED', header_synced_at: new Date().toISOString() };
      if (payload.InvoiceNumber) patch.invoice_number = payload.InvoiceNumber;
    } else if (kind === 'voided') {
      patch = { status: 'VOIDED', order_status: 'VOIDED', header_synced_at: new Date().toISOString() };
    } else return;
    const { data, error } = await this.sb.schema('cin7_mirror')
      .from('sales_orders').update(patch).eq('order_number', on).select('order_number');
    if (error) { console.warn(`  ⚠️ sales_orders ${kind} reflect: ${error.message}`); return; }
    console.log(`  📝 sales_orders ${kind} → ${on}${(data && data.length) ? '' : ' (not mirrored yet — sync will add)'}`);
  }

  // ══════════════════════════════════════════════
  // SALES ORDER processing
  // ══════════════════════════════════════════════
  async _processSaleOrder(payload) {
    // Real Cin7 payloads: Sale/Created → SaleID; Sale/ShipmentAuthorised →
    // SaleTaskID. Try the sale GUID first; fall back to OrderNumber search.
    const soId = payload.SaleID || payload.SaleTaskID || payload.ID || payload.id;
    const soNumber = payload.OrderNumber || payload.SaleOrderNumber || payload.Number || '';
    if (!soId && !soNumber) { console.warn('⚠️ SO webhook missing SaleID/OrderNumber'); return []; }

    let soData;
    try {
      soData = await this._cin7Request('sale', { ID: soId });
    } catch (e) {
      console.warn(`⚠️ Could not fetch SO ${soId}: ${e.message}`);
      // Try by order number as fallback
      if (soNumber) {
        try {
          const list = await this._cin7Request('saleList', { Search: soNumber });
          const match = (list.SaleList || []).find(s => s.OrderNumber === soNumber);
          if (match) soData = await this._cin7Request('sale', { ID: match.ID });
        } catch (e2) { console.warn(`⚠️ Fallback search also failed: ${e2.message}`); }
      }
      if (!soData) return [];
    }

    const movements = [];
    const order = soData;

    // ── Feed the Pick-Anomalies engine in REAL TIME, reusing the detail we
    // already fetched (no extra sale call). This catches OLD orders shipped
    // today that the 2h date-based sync misses. Best-effort — a failure here
    // never blocks the stock-movement ledger.
    try {
      const pa = require('../features/pick-anomalies/pick-anomalies-engine');
      const r = await pa.analyzeOrderRealtime(order.ID || soId, order.OrderNumber || soNumber, order, 'webhook');
      if (r && r.ok) console.log(`  🧷 Pick-anomalies (realtime): ${r.orderNumber} → ${r.anomalies} anomalies, ${r.correct} correct`);
      else if (r && r.skipped) console.log(`  🧷 Pick-anomalies (realtime): ${order.OrderNumber} skipped (${r.skipped})`);
    } catch (e) {
      console.warn(`  ⚠️ Pick-anomalies realtime failed: ${e.message}`);
    }

    // ── Mirror the full sale into sales_orders + sale_lines (LIVE), reusing the
    // detail we already fetched. Keeps the sales mirror up to date going forward.
    try {
      const { upsertSalesMirror } = require('./sales-mirror');
      await upsertSalesMirror(this.sb, order, order.OrderNumber || soNumber, order.ID || soId, 'webhook');
    } catch (e) {
      console.warn(`  ⚠️ sales_orders mirror failed: ${e.message}`);
    }

    // Extract customer and sales rep info
    const customer = order.Customer || order.CustomerName || '';
    const salesRep = order.SalesRepresentative || order.SalesPerson || '';
    const memberEmail = order.MemberEmail || order.CreatedBy || '';
    const refNumber = order.OrderNumber || soNumber;

    // Process fulfillment lines — these show WHAT was picked and FROM WHERE
    const fulfillments = order.Fulfilments || order.Fulfillments || [];

    const orderWarehouse = order.Location || 'Main Warehouse';
    for (const fulfilment of fulfillments) {
      // Real Cin7 fulfilment shape: { Pick:{Status,Lines:[]}, Pack:{...}, Ship:{Status,Lines:[]} }
      const shipDate = (fulfilment.Ship && fulfilment.Ship.Lines && fulfilment.Ship.Lines[0]
        && fulfilment.Ship.Lines[0].ShipmentDate) || null;
      const fulfilLines = (fulfilment.Pick && fulfilment.Pick.Lines) || fulfilment.Lines || [];

      for (const line of fulfilLines) {
        const sku = line.SKU || line.ProductCode || '';
        const productName = line.Name || line.ProductName || '';
        const qty = parseFloat(line.Quantity) || 0;
        // Cin7 pick "Location" is "Warehouse: BIN" (e.g. "Main Warehouse: MA-F-04-L1")
        // or just a warehouse name for branch picks. Split into warehouse + bin code.
        const rawLoc = line.Location || line.Bin || line.BinLocation || '';
        const binCode = rawLoc.includes(':') ? rawLoc.split(':').slice(1).join(':').trim() : '';
        const bin = binCode;
        const location = (rawLoc.includes(':') ? rawLoc.split(':')[0].trim() : rawLoc) || orderWarehouse;
        const batch = line.BatchSN || line.Batch || '';

        if (!sku || qty === 0) continue;

        // Look up product's stock_locator (pickface)
        let stockLocator = '';
        let category = '';
        try {
          const { data: prod } = await this.sb.schema('cin7_mirror')
            .from('products')
            .select('stock_locator, category')
            .eq('sku', sku)
            .single();
          if (prod) { stockLocator = prod.stock_locator || ''; category = prod.category || ''; }
        } catch {}

        // Anomaly = picked from a real BIN CODE that isn't the product's pickface.
        // Branch/warehouse-level picks carry no bin code → NOT flagged (legit branch ship).
        const normBin = binCode.replace(/\s+/g, '').toUpperCase();
        const normPickface = (stockLocator || '').replace(/\s+/g, '').toUpperCase();
        const isFromPickface = normPickface && normBin === normPickface;
        const isAnomaly = !!normBin && !!normPickface && !isFromPickface;

        // Determine movement type. Real Cin7 fulfilments expose FulFilmentStatus
        // (+ Ship.Status), not a top-level Status; a shipment date means shipped.
        const status = (fulfilment.FulFilmentStatus || (fulfilment.Ship && fulfilment.Ship.Status) || '').toLowerCase();
        const isShipped = !!shipDate || status.includes('ship') || status.includes('fulfil');
        const movementType = isShipped ? 'sales_ship' : 'sales_pick';

        movements.push({
          detected_at: new Date().toISOString(),
          sku,
          product_name: productName,
          movement_type: movementType,
          reference_number: refNumber,
          reference_type: 'SalesOrder',
          cin7_task_id: soId,
          sales_rep: salesRep,
          member_email: memberEmail,
          customer_name: customer,
          from_location: location,
          from_bin: bin,
          to_location: isShipped ? 'SHIPPED' : null,
          to_bin: null,
          quantity: -Math.abs(qty),  // Negative = stock out
          is_internal: false,
          is_external: true,
          is_anomaly: isAnomaly,
          stock_locator: stockLocator,
          product_category: category,
          raw_data: {
            fulfilment_status: fulfilment.Status,
            ship_date: shipDate,
            batch: batch,
            customer: customer,
            line_total: line.Total,
          },
        });
      }
    }

    return movements;
  }

  // ══════════════════════════════════════════════
  // STOCK TRANSFER processing
  // ══════════════════════════════════════════════
  async _processStockTransfer(payload) {
    const taskId = payload.ID || payload.id || payload.TaskID;
    if (!taskId) { console.warn('⚠️ Transfer webhook missing ID'); return []; }

    let transferData;
    try {
      transferData = await this._cin7Request('stockTransfer', { TaskID: taskId });
    } catch (e) {
      console.warn(`⚠️ Could not fetch transfer ${taskId}: ${e.message}`);
      return [];
    }

    const movements = [];
    const transfer = transferData;

    const refNumber = transfer.Number || transfer.TaskNumber || `TRF-${taskId}`;
    const memberEmail = transfer.MemberEmail || transfer.CreatedBy || '';
    const fromLocation = transfer.From?.Location || transfer.SourceLocation || '';
    const toLocation = transfer.To?.Location || transfer.DestinationLocation || '';

    const lines = transfer.Lines || transfer.TransferLines || [];

    for (const line of lines) {
      const sku = line.SKU || line.ProductCode || '';
      const productName = line.Name || line.ProductName || '';
      const qty = parseFloat(line.Quantity) || 0;
      const fromBin = line.FromBin || line.SourceBin || '';
      const toBin = line.ToBin || line.DestinationBin || '';

      if (!sku || qty === 0) continue;

      // Look up product's stock_locator
      let stockLocator = '';
      let category = '';
      try {
        const { data: prod } = await this.sb.schema('cin7_mirror')
          .from('products')
          .select('stock_locator, category')
          .eq('sku', sku)
          .single();
        if (prod) { stockLocator = prod.stock_locator || ''; category = prod.category || ''; }
      } catch {}

      // Classify: internal (bin-to-bin same location) vs external (cross-location)
      const sameLocation = fromLocation && toLocation && fromLocation === toLocation;
      const isInternal = sameLocation && fromBin && toBin;
      const movementType = isInternal ? 'bin_transfer' : 'stock_transfer';

      movements.push({
        detected_at: new Date().toISOString(),
        sku,
        product_name: productName,
        movement_type: movementType,
        reference_number: refNumber,
        reference_type: 'StockTransfer',
        cin7_task_id: taskId,
        member_email: memberEmail,
        from_location: fromLocation,
        from_bin: fromBin,
        to_location: toLocation,
        to_bin: toBin,
        quantity: -Math.abs(qty),  // Outgoing from source
        is_internal: isInternal,
        is_external: !isInternal,
        is_anomaly: false,
        stock_locator: stockLocator,
        product_category: category,
        raw_data: {
          transfer_number: refNumber,
          transfer_status: transfer.Status,
          transfer_date: transfer.Date || transfer.CompletionDate,
        },
      });

      // Also log the receiving side (positive qty at destination)
      if (!isInternal) {
        movements.push({
          detected_at: new Date().toISOString(),
          sku,
          product_name: productName,
          movement_type: 'stock_transfer',
          reference_number: refNumber,
          reference_type: 'StockTransfer',
          cin7_task_id: taskId,
          member_email: memberEmail,
          from_location: fromLocation,
          from_bin: fromBin,
          to_location: toLocation,
          to_bin: toBin,
          quantity: Math.abs(qty),  // Incoming at destination
          is_internal: false,
          is_external: true,
          is_anomaly: false,
          stock_locator: stockLocator,
          product_category: category,
          raw_data: {
            side: 'receiving',
            transfer_number: refNumber,
          },
        });
      }
    }

    return movements;
  }

  // ══════════════════════════════════════════════
  // STOCK ADJUSTMENT processing
  // ══════════════════════════════════════════════
  async _processStockAdjustment(payload) {
    const taskId = payload.ID || payload.id || payload.TaskID;
    if (!taskId) { console.warn('⚠️ Adjustment webhook missing ID'); return []; }

    let adjData;
    try {
      adjData = await this._cin7Request('stockAdjustment', { TaskID: taskId });
    } catch (e) {
      console.warn(`⚠️ Could not fetch adjustment ${taskId}: ${e.message}`);
      return [];
    }

    const movements = [];
    const adj = adjData;

    const refNumber = adj.Number || adj.TaskNumber || `ADJ-${taskId}`;
    const memberEmail = adj.MemberEmail || adj.CreatedBy || '';
    const reason = adj.Reason || adj.Notes || '';
    const location = adj.Location || adj.Warehouse || 'Main Warehouse';

    const lines = adj.Lines || adj.AdjustmentLines || [];

    for (const line of lines) {
      const sku = line.SKU || line.ProductCode || '';
      const productName = line.Name || line.ProductName || '';
      const qty = parseFloat(line.Quantity) || 0;
      const bin = line.Bin || line.BinLocation || '';

      if (!sku) continue;

      let stockLocator = '';
      let category = '';
      try {
        const { data: prod } = await this.sb.schema('cin7_mirror')
          .from('products')
          .select('stock_locator, category')
          .eq('sku', sku)
          .single();
        if (prod) { stockLocator = prod.stock_locator || ''; category = prod.category || ''; }
      } catch {}

      movements.push({
        detected_at: new Date().toISOString(),
        sku,
        product_name: productName,
        movement_type: 'stock_adjustment',
        reference_number: refNumber,
        reference_type: 'StockAdjustment',
        cin7_task_id: taskId,
        member_email: memberEmail,
        from_location: qty < 0 ? location : null,
        from_bin: qty < 0 ? bin : null,
        to_location: qty > 0 ? location : null,
        to_bin: qty > 0 ? bin : null,
        quantity: qty,  // Positive = added, Negative = removed
        is_internal: false,
        is_external: false,
        is_anomaly: false,
        stock_locator: stockLocator,
        product_category: category,
        raw_data: {
          reason: reason,
          adjustment_status: adj.Status,
          adjustment_date: adj.Date,
        },
      });
    }

    return movements;
  }

  // ══════════════════════════════════════════════
  // PURCHASE ORDER processing
  // ══════════════════════════════════════════════
  async _processPurchaseOrder(payload) {
    const poId = payload.ID || payload.id;
    if (!poId) { console.warn('⚠️ PO webhook missing ID'); return []; }

    let poData;
    try {
      poData = await this._cin7Request('purchase', { ID: poId });
    } catch (e) {
      console.warn(`⚠️ Could not fetch PO ${poId}: ${e.message}`);
      return [];
    }

    const movements = [];
    const po = poData;

    const refNumber = po.OrderNumber || po.Number || `PO-${poId}`;
    const memberEmail = po.MemberEmail || po.CreatedBy || '';
    const supplier = po.SupplierName || po.Supplier || '';

    // Process stock receive lines
    const receipts = po.StockReceived || po.Receipts || po.ReceiveLines || [];

    for (const receipt of receipts) {
      const receiveLines = receipt.Lines || receipt.ReceiveLines || [receipt];

      for (const line of receiveLines) {
        const sku = line.SKU || line.ProductCode || '';
        const productName = line.Name || line.ProductName || '';
        const qty = parseFloat(line.Quantity) || 0;
        const location = line.Location || receipt.Location || po.Location || 'Main Warehouse';
        const bin = line.Bin || line.BinLocation || '';

        if (!sku || qty === 0) continue;

        let stockLocator = '';
        let category = '';
        try {
          const { data: prod } = await this.sb.schema('cin7_mirror')
            .from('products')
            .select('stock_locator, category')
            .eq('sku', sku)
            .single();
          if (prod) { stockLocator = prod.stock_locator || ''; category = prod.category || ''; }
        } catch {}

        movements.push({
          detected_at: new Date().toISOString(),
          sku,
          product_name: productName,
          movement_type: 'purchase_receive',
          reference_number: refNumber,
          reference_type: 'PurchaseOrder',
          cin7_task_id: poId,
          member_email: memberEmail,
          customer_name: supplier,
          from_location: 'SUPPLIER',
          to_location: location,
          to_bin: bin,
          quantity: Math.abs(qty),  // Positive = stock in
          is_internal: false,
          is_external: true,
          is_anomaly: false,
          stock_locator: stockLocator,
          product_category: category,
          raw_data: {
            supplier: supplier,
            receive_date: receipt.ReceiveDate || receipt.Date,
            po_status: po.Status,
          },
        });
      }
    }

    return movements;
  }

  // ══════════════════════════════════════════════
  // ALERT RULES CHECKER
  // ══════════════════════════════════════════════
  async _checkAlertRules(movement) {
    try {
      // Fetch active rules
      const { data: rules, error } = await this.sb.schema('cin7_mirror')
        .from('alert_rules')
        .select('*')
        .eq('is_active', true);

      if (error || !rules) return;

      for (const rule of rules) {
        const alert = this._evaluateRule(rule, movement);
        if (alert) {
          alert.webhook_event_id = movement.webhook_event_id || null; // link for idempotent reprocess
          const { error: insertErr } = await this.sb.schema('cin7_mirror')
            .from('movement_alerts')
            .insert(alert);

          if (insertErr) {
            console.error('❌ Failed to create alert:', insertErr.message);
          } else {
            console.log(`🚨 Alert created: ${alert.alert_type} — ${alert.title}`);
          }
        }
      }
    } catch (e) {
      console.error('⚠️ Alert check error:', e.message);
    }
  }

  _evaluateRule(rule, mov) {
    const config = rule.config || {};

    switch (rule.rule_type) {
      case 'non_pickbay_pick': {
        if (!mov.is_anomaly) return null;
        if (mov.movement_type !== 'sales_pick' && mov.movement_type !== 'sales_ship') return null;
        return {
          alert_type: 'non_pickbay_pick',
          severity: rule.severity,
          title: `Pick from non-pickface: ${mov.sku}`,
          description: `${mov.product_name || mov.sku} was picked from ${mov.from_bin || mov.from_location} instead of designated pickface ${mov.stock_locator || 'N/A'}. SO: ${mov.reference_number || 'N/A'}. Qty: ${Math.abs(mov.quantity)}.${mov.sales_rep ? ` Sales Rep: ${mov.sales_rep}` : ''}`,
          movement_id: mov.id || null,
          sku: mov.sku,
          product_name: mov.product_name,
          reference_number: mov.reference_number,
          movement_type: mov.movement_type,
          from_location: mov.from_location,
          to_location: mov.to_location,
          quantity: mov.quantity,
          member_email: mov.member_email,
          sales_rep: mov.sales_rep,
        };
      }

      case 'external_transfer': {
        if (mov.movement_type !== 'stock_transfer') return null;
        const watchLocations = config.locations || [];
        const toUp = (mov.to_location || '').toUpperCase();
        const matches = watchLocations.some(l => toUp.includes(l.toUpperCase()));
        if (!matches) return null;
        return {
          alert_type: 'external_transfer',
          severity: rule.severity,
          title: `Transfer to ${mov.to_location}: ${mov.sku}`,
          description: `${mov.product_name || mov.sku} transferred from ${mov.from_location || 'N/A'} to ${mov.to_location}. Qty: ${Math.abs(mov.quantity)}.${mov.member_email ? ` By: ${mov.member_email}` : ''} Ref: ${mov.reference_number || 'N/A'}`,
          movement_id: mov.id || null,
          sku: mov.sku,
          product_name: mov.product_name,
          reference_number: mov.reference_number,
          movement_type: mov.movement_type,
          from_location: mov.from_location,
          to_location: mov.to_location,
          quantity: mov.quantity,
          member_email: mov.member_email,
        };
      }

      case 'large_quantity': {
        const minQty = config.min_quantity || 500;
        if (Math.abs(mov.quantity) < minQty) return null;
        return {
          alert_type: 'large_quantity',
          severity: rule.severity,
          title: `Large movement: ${mov.sku} (${Math.abs(mov.quantity)} units)`,
          description: `${mov.product_name || mov.sku}: ${Math.abs(mov.quantity)} units ${mov.quantity > 0 ? 'added to' : 'removed from'} ${mov.from_location || mov.to_location || 'N/A'}. Type: ${mov.movement_type}. Ref: ${mov.reference_number || 'N/A'}`,
          movement_id: mov.id || null,
          sku: mov.sku,
          product_name: mov.product_name,
          reference_number: mov.reference_number,
          movement_type: mov.movement_type,
          from_location: mov.from_location,
          to_location: mov.to_location,
          quantity: mov.quantity,
          member_email: mov.member_email,
        };
      }

      case 'stock_negative': {
        if (mov.quantity_after == null || mov.quantity_after >= 0) return null;
        return {
          alert_type: 'stock_negative',
          severity: 'critical',
          title: `Negative stock: ${mov.sku}`,
          description: `${mov.product_name || mov.sku} went negative (${mov.quantity_after} units) at ${mov.from_location || mov.to_location || 'N/A'}. Movement: ${mov.movement_type}. Ref: ${mov.reference_number || 'N/A'}`,
          movement_id: mov.id || null,
          sku: mov.sku,
          product_name: mov.product_name,
          reference_number: mov.reference_number,
          movement_type: mov.movement_type,
          from_location: mov.from_location,
          to_location: mov.to_location,
          quantity: mov.quantity,
          member_email: mov.member_email,
        };
      }

      default:
        return null;
    }
  }
}

module.exports = MovementProcessor;
