/**
 * Gateway Inventory — backend engine.
 *
 * Replaces the read-only shelf viewer in gateway-engine.js with an inventory
 * layer that can explain itself: every quantity here is the sum of an
 * append-only ledger, and every transfer holds the lot allocations that
 * justify it.
 *
 * Architecture
 *   - public.gateway_* tables own the layer Cin7 does not model. Cin7 knows
 *     Gateway as one warehouse-level total per SKU (location_name='Gateway',
 *     bin=''), with no shelf, no pallet and no arrival date. That is the whole
 *     reason this exists.
 *   - Anything that touches more than one row goes through a plpgsql RPC, so
 *     it is one transaction with proper row locks. PostgREST cannot give us a
 *     transaction from out here, and the previous engine showed the cost of
 *     pretending otherwise.
 *   - Cin7 is never written. gateway_settings.erp_transfer_write_enabled is
 *     the seam for later; ERPTransferProvider below is the interface it will
 *     implement. Today a Gateway transfer is raised in Cin7 by hand and its
 *     TR reference is recorded against our transfer.
 *
 * Registered from server.js:
 *   require('./features/gateway/gateway-inventory-engine')(app, supabaseBackend);
 *
 * Responses use the house envelope { success, data?, error? }.
 */

const perms = require('./lib/gw-permissions');

const CIN7 = 'cin7_mirror';
const GATEWAY_LOCATION = 'Gateway';

// ─── response helpers ───────────────────────────────────────────────
const ok   = (res, data)         => res.json({ success: true, data });
const fail = (res, status, error, extra) =>
  res.status(status).json({ success: false, error, ...(extra || {}) });

/** Postgres raises our business rules as check_violation. Those are the user's
 *  fault and deserve a 409 with the real message, not a generic 500. */
function pgFail(res, error, fallback = 'Database error') {
  const code = error && error.code;
  const msg  = (error && (error.message || error.hint)) || fallback;
  if (code === '23514' || code === 'P0001') return fail(res, 409, msg);
  if (code === '23505') return fail(res, 409, `Already exists: ${msg}`);
  if (code === '23503') return fail(res, 400, `Referenced record missing: ${msg}`);
  if (code === '42P01') return fail(res, 503, 'Gateway tables are not deployed yet. Apply features/gateway/db/*.sql in the Supabase SQL Editor.');
  console.error('[gateway]', code, msg);
  return fail(res, 500, msg);
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = v => (v == null ? null : String(v).trim() || null);

module.exports = function registerGatewayInventoryRoutes(app, sb) {
  if (!sb) {
    console.warn('⚠️  Gateway inventory: no Supabase backend client — routes not registered');
    return;
  }

  const user = req => perms.userOf(req) || 'unknown';

  // ═══════════════════════════════════════════════════════════════════
  // ERP seam. Deliberately inert.
  // ═══════════════════════════════════════════════════════════════════
  const ERPTransferProvider = {
    /**
     * Create the transfer in the ERP. Not implemented on purpose: Gateway
     * transfers are raised by hand in Cin7 today. When that changes, this is
     * the only function that has to learn how, and it must go through
     * features/wms/lib/outbox.js — Cin7 has no idempotency key and an
     * authorised transfer cannot be undone.
     */
    async createTransfer() {
      throw Object.assign(
        new Error('Creating Cin7 transfers from the Gateway module is disabled.'),
        { code: 'ERP_WRITE_DISABLED' });
    },
    async isEnabled() {
      const { data } = await sb.from('gateway_settings')
        .select('value').eq('key', 'erp_transfer_write_enabled').maybeSingle();
      return data?.value === 'true';
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  // Reads
  // ═══════════════════════════════════════════════════════════════════

  // Dashboard counters. One question per number, no derived opinions.
  app.get('/api/gateway/summary', async (req, res) => {
    try {
      const [bal, tr, recon, iss, fresh, settings] = await Promise.all([
        sb.from('gateway_v_sku_balance').select('sku,qty_on_hand,qty_reserved,oldest_age_days,undated_lots'),
        sb.from('gateway_v_transfers').select('id,status,direction'),
        sb.from('gateway_v_reconciliation').select('state,difference,local_qty,cin7_qty')
          .or('local_qty.neq.0,cin7_qty.neq.0'),
        sb.from('gateway_import_issues').select('id', { count: 'exact', head: true }).eq('resolved', false),
        sb.schema(CIN7).from('stock_snapshot')
          .select('synced_at').eq('location_name', GATEWAY_LOCATION)
          .order('synced_at', { ascending: false }).limit(1),
        sb.from('gateway_settings').select('key,value'),
      ]);
      // Same reasoning as /attention: a failed count must not render as a
      // reassuring zero. fresh/settings are allowed to be missing — they only
      // affect labelling.
      for (const p of [bal, tr, recon, iss]) if (p.error) return pgFail(res, p.error);

      const rows = bal.data || [];
      const cfg  = Object.fromEntries((settings.data || []).map(r => [r.key, r.value]));
      const warn  = Number(cfg.age_warn_days  || 60);
      const alert = Number(cfg.age_alert_days || 120);
      const openStatuses = ['draft', 'ready_for_cin7', 'cin7_created', 'picking', 'dispatched'];

      ok(res, {
        products:      rows.filter(r => Number(r.qty_on_hand) > 0).length,
        units:         rows.reduce((s, r) => s + Number(r.qty_on_hand || 0), 0),
        reserved:      rows.reduce((s, r) => s + Number(r.qty_reserved || 0), 0),
        undated_lots:  rows.reduce((s, r) => s + Number(r.undated_lots || 0), 0),
        aging_warn:    rows.filter(r => r.oldest_age_days >= warn && r.oldest_age_days < alert).length,
        aging_alert:   rows.filter(r => r.oldest_age_days >= alert).length,
        open_transfers: (tr.data || []).filter(t => openStatuses.includes(t.status)).length,
        transfers_by_status: (tr.data || []).reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {}),
        discrepancies: (recon.data || []).filter(r => r.state !== 'match').length,
        discrepancy_units: (recon.data || []).reduce((s, r) => s + Math.abs(Number(r.difference || 0)), 0),
        open_import_issues: iss.count || 0,
        cin7_synced_at: fresh.data?.[0]?.synced_at || null,
        settings: cfg,
      });
    } catch (e) { pgFail(res, e); }
  });

  // Inventory list. Server-side search/filter/sort/paginate — the browser
  // never receives the whole ledger.
  app.get('/api/gateway/inventory', async (req, res) => {
    try {
      const limit  = Math.min(Number(req.query.limit) || 100, 500);
      const offset = Number(req.query.offset) || 0;
      const q      = str(req.query.q);
      const filter = str(req.query.filter) || 'all';
      const sort   = str(req.query.sort) || 'oldest';

      let query = sb.from('gateway_v_reconciliation').select('*', { count: 'exact' });

      if (q) {
        const like = `*${q}*`;
        query = query.or(`sku.ilike.${like},product_name.ilike.${like},five_dc.ilike.${like},shelves.ilike.${like}`);
      }
      // Hide pure noise: 171 '-CartonNN' UOM-variant SKUs sit in the Cin7
      // Gateway snapshot at 0 on hand and show as "Only Cin7 / 0 / 0". They
      // are not stock and not a real discrepancy — drop any row that is zero
      // on both sides (unless the caller explicitly asked for the zero view).
      if (filter !== 'zero') {
        query = query.or('local_qty.neq.0,cin7_qty.neq.0');
      }
      switch (filter) {
        case 'mismatch':    query = query.neq('state', 'match'); break;
        case 'cin7_only':   query = query.eq('state', 'cin7_only'); break;
        case 'local_only':  query = query.eq('state', 'local_only'); break;
        case 'undated':     query = query.gt('undated_lots', 0); break;
        case 'reserved':    query = query.gt('open_lots', 0); break;
        case 'in_stock':    query = query.gt('local_qty', 0); break;
        case 'zero':        query = query.eq('local_qty', 0).gt('cin7_qty', 0); break;
        case 'aging':       query = query.gte('oldest_age_days', Number(req.query.age_days) || 120); break;
      }
      const order = {
        oldest:   ['oldest_age_days', false],
        newest:   ['oldest_age_days', true],
        qty:      ['local_qty', false],
        variance: ['difference', false],
        sku:      ['sku', true],
      }[sort] || ['oldest_age_days', false];
      query = query.order(order[0], { ascending: order[1], nullsFirst: false })
                   .order('sku', { ascending: true })
                   .range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) return pgFail(res, error);
      ok(res, { rows: data || [], total: count || 0, limit, offset });
    } catch (e) { pgFail(res, e); }
  });

  // One SKU, fully explained: lots, FIFO order, and the movements behind them.
  app.get('/api/gateway/inventory/:sku', async (req, res) => {
    try {
      const sku = req.params.sku;
      const [bal, lots, fifo, moves, cin7] = await Promise.all([
        sb.from('gateway_v_reconciliation').select('*').eq('sku', sku).maybeSingle(),
        sb.from('gateway_v_lots').select('*').eq('sku', sku)
          .order('fifo_sort_date', { ascending: true }).order('id', { ascending: true }),
        sb.rpc('gateway_fifo_queue', { p_sku: sku }),
        sb.from('gateway_movements').select('*').eq('sku', sku)
          .order('occurred_at', { ascending: false }).limit(Math.min(Number(req.query.movements) || 200, 500)),
        sb.schema(CIN7).from('stock_snapshot')
          .select('on_hand,allocated,available,synced_at')
          .eq('location_name', GATEWAY_LOCATION).eq('sku', sku),
      ]);
      if (lots.error) return pgFail(res, lots.error);
      if (!bal.data && !(lots.data || []).length && !(cin7.data || []).length) {
        return fail(res, 404, `No Gateway record for ${sku}`);
      }
      ok(res, {
        sku,
        balance: bal.data || null,
        lots: lots.data || [],
        fifo: fifo.data || [],
        movements: moves.data || [],
        cin7: (cin7.data || []).reduce((a, r) => ({
          on_hand:   a.on_hand   + Number(r.on_hand   || 0),
          allocated: a.allocated + Number(r.allocated || 0),
          available: a.available + Number(r.available || 0),
          synced_at: r.synced_at || a.synced_at,
        }), { on_hand: 0, allocated: 0, available: 0, synced_at: null }),
      });
    } catch (e) { pgFail(res, e); }
  });

  app.get('/api/gateway/fifo/:sku', async (req, res) => {
    const { data, error } = await sb.rpc('gateway_fifo_queue', { p_sku: req.params.sku });
    if (error) return pgFail(res, error);
    ok(res, data || []);
  });

  app.get('/api/gateway/shelves', async (req, res) => {
    const { data, error } = await sb.from('gateway_shelves')
      .select('*').eq('active', true).order('area').order('shelf_number');
    if (error) return pgFail(res, error);
    ok(res, data || []);
  });

  // What needs a human today, grouped by the question it answers.
  app.get('/api/gateway/attention', async (req, res) => {
    try {
      const alertDays = Number(req.query.age_days) || 120;
      const parts = await Promise.all([
        sb.from('gateway_v_reconciliation').select('sku,product_name,local_qty,oldest_age_days,shelves')
          .gte('oldest_age_days', alertDays).order('oldest_age_days', { ascending: false }).limit(25),
        sb.from('gateway_v_reconciliation').select('sku,product_name,local_qty,cin7_qty,difference,state,issue_status')
          .neq('state', 'match').or('local_qty.neq.0,cin7_qty.neq.0')
          .order('difference', { ascending: true }).limit(25),
        sb.from('gateway_v_reconciliation').select('sku,product_name,local_qty,undated_lots')
          .gt('undated_lots', 0).order('local_qty', { ascending: false }).limit(25),
        sb.from('gateway_v_transfers').select('*')
          .in('status', ['ready_for_cin7', 'cin7_created', 'picking', 'dispatched'])
          .order('created_at', { ascending: true }).limit(25),
        sb.from('gateway_import_issues').select('*').eq('resolved', false)
          .in('severity', ['error', 'warning']).order('severity').limit(25),
      ]);
      // An empty "needs attention" panel reads as "all clear". If any of these
      // queries actually failed, saying nothing is worse than saying nothing
      // works — so the first error is reported rather than rendered as calm.
      const broke = parts.find(p => p.error);
      if (broke) return pgFail(res, broke.error);

      const [aging, mism, undated, stuck, issues] = parts;
      ok(res, {
        aging_stock:   aging.data   || [],
        discrepancies: mism.data    || [],
        undated_stock: undated.data || [],
        open_transfers: stuck.data  || [],
        import_issues: issues.data  || [],
      });
    } catch (e) { pgFail(res, e); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Lots
  // ═══════════════════════════════════════════════════════════════════

  app.post('/api/gateway/lots', async (req, res) => {
    if (!perms.require(req, res, 'gateway.lot.receive')) return;
    const b = req.body || {};
    if (!str(b.sku))             return fail(res, 400, 'sku is required');
    if (!(num(b.qty_received) > 0)) return fail(res, 400, 'qty_received must be greater than zero');
    // The DB refuses an undated lot from the app, but say so in English first.
    if (!str(b.received_on))     return fail(res, 400, 'received_on is required — a new receipt always has a date');

    const { data, error } = await sb.rpc('gateway_create_lot', {
      p: {
        sku: str(b.sku), five_dc: str(b.five_dc), product_name: str(b.product_name),
        received_on: str(b.received_on), qty_received: num(b.qty_received),
        uom: str(b.uom) || 'Item',
        source_type: str(b.source_type) || 'transfer_in',
        source_reference: str(b.source_reference), cin7_task_id: str(b.cin7_task_id),
        shelf_id: str(b.shelf_id), shelf_text: str(b.shelf_text) || str(b.shelf_id),
        pallet_number: str(b.pallet_number), notes: str(b.notes),
        created_by: user(req),
        idempotency_key: str(b.idempotency_key),
      },
    });
    if (error) return pgFail(res, error);
    ok(res, { lot_id: data });
  });

  app.post('/api/gateway/lots/:id/adjust', async (req, res) => {
    if (!perms.require(req, res, 'gateway.lot.adjust')) return;
    const b = req.body || {};
    const delta = num(b.delta);
    if (delta == null || delta === 0) return fail(res, 400, 'delta must be a non-zero number');
    if (!str(b.reason))               return fail(res, 400, 'reason is required');

    const { data, error } = await sb.rpc('gateway_adjust_lot', {
      p_lot_id: Number(req.params.id), p_delta: delta,
      p_reason_code: str(b.reason_code) || 'manual',
      p_reason: str(b.reason), p_reference: str(b.reference), p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Transfers
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/gateway/transfers', async (req, res) => {
    const limit  = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    let q = sb.from('gateway_v_transfers').select('*', { count: 'exact' });
    if (str(req.query.status))    q = q.in('status', String(req.query.status).split(','));
    if (str(req.query.direction)) q = q.eq('direction', str(req.query.direction));
    if (str(req.query.q)) {
      const like = `*${str(req.query.q)}*`;
      q = q.or(`transfer_no.ilike.${like},cin7_reference.ilike.${like},reference.ilike.${like}`);
    }
    const { data, error, count } = await q
      .order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return pgFail(res, error);
    ok(res, { rows: data || [], total: count || 0, limit, offset });
  });

  app.get('/api/gateway/transfers/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [tr, lines, allocs] = await Promise.all([
        sb.from('gateway_v_transfers').select('*').eq('id', id).maybeSingle(),
        sb.from('gateway_transfer_lines').select('*').eq('transfer_id', id).order('line_no').order('sku'),
        sb.from('gateway_transfer_allocations')
          .select('*, lot:gateway_lots(id,received_on,date_confidence,shelf_id,shelf_text,pallet_number,qty_received,qty_remaining)')
          .eq('transfer_id', id).order('id'),
      ]);
      if (!tr.data) return fail(res, 404, 'Transfer not found');
      ok(res, { transfer: tr.data, lines: lines.data || [], allocations: allocs.data || [] });
    } catch (e) { pgFail(res, e); }
  });

  app.post('/api/gateway/transfers', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.create')) return;
    const b = req.body || {};
    const direction = str(b.direction) || 'gateway_to_main';
    if (!['gateway_to_main', 'main_to_gateway'].includes(direction)) {
      return fail(res, 400, 'direction must be gateway_to_main or main_to_gateway');
    }
    const { data: no, error: seqErr } = await sb.rpc('gateway_next_transfer_no');
    if (seqErr) return pgFail(res, seqErr);

    const { data, error } = await sb.from('gateway_transfers').insert({
      transfer_no: no, direction,
      planned_for: str(b.planned_for), reference: str(b.reference), notes: str(b.notes),
      created_by: user(req), updated_by: user(req),
    }).select().single();
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  // Add a SKU and let FIFO choose the lots. The caller never picks lots by
  // hand unless it deliberately overrides.
  app.post('/api/gateway/transfers/:id/lines', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.edit')) return;
    const id  = Number(req.params.id);
    const b   = req.body || {};
    const qty = num(b.qty_requested);
    if (!str(b.sku))  return fail(res, 400, 'sku is required');
    if (!(qty > 0))   return fail(res, 400, 'qty_requested must be greater than zero');

    const { data: tr } = await sb.from('gateway_transfers').select('id,status,direction').eq('id', id).maybeSingle();
    if (!tr) return fail(res, 404, 'Transfer not found');
    if (!['draft', 'ready_for_cin7'].includes(tr.status)) {
      return fail(res, 409, `Transfer is ${tr.status} — lines can only change while draft or ready_for_cin7`);
    }

    const { data: resolved, error: rErr } = await sb.rpc('gateway_resolve_sku', { p_sku: str(b.sku) });
    if (rErr) return pgFail(res, rErr);

    const { data: line, error } = await sb.from('gateway_transfer_lines').insert({
      transfer_id: id, sku: resolved, five_dc: str(b.five_dc), product_name: str(b.product_name),
      qty_requested: qty, uom: str(b.uom) || 'Item', line_no: num(b.line_no),
      source: str(b.source) || 'manual', notes: str(b.notes),
    }).select().single();
    if (error) return pgFail(res, error);

    // main_to_gateway has nothing in Gateway to allocate from — the stock
    // arrives and becomes a lot when the transfer is posted.
    let allocation = null;
    if (tr.direction === 'gateway_to_main' && b.allocate !== false) {
      const { data: a, error: aErr } = await sb.rpc('gateway_allocate_line',
        { p_line_id: line.id, p_qty: null, p_user: user(req) });
      if (aErr) return pgFail(res, aErr);
      allocation = a;
    }
    ok(res, { line, allocation });
  });

  app.delete('/api/gateway/transfers/:id/lines/:lineId', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.edit')) return;
    const { data: tr } = await sb.from('gateway_transfers').select('status').eq('id', Number(req.params.id)).maybeSingle();
    if (!tr) return fail(res, 404, 'Transfer not found');
    if (!['draft', 'ready_for_cin7'].includes(tr.status)) {
      return fail(res, 409, `Transfer is ${tr.status} — lines can only change while draft or ready_for_cin7`);
    }
    // Cascade drops the allocations, and their trigger frees the reservations.
    const { error } = await sb.from('gateway_transfer_lines').delete().eq('id', Number(req.params.lineId));
    if (error) return pgFail(res, error);
    await sb.rpc('gateway_refresh_fifo_flag', { p_transfer_id: Number(req.params.id) });
    ok(res, { deleted: true });
  });

  app.post('/api/gateway/transfers/:id/allocate', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.edit')) return;
    const b = req.body || {};
    if (!num(b.line_id)) return fail(res, 400, 'line_id is required');
    const { data, error } = await sb.rpc('gateway_allocate_line', {
      p_line_id: Number(b.line_id), p_qty: num(b.qty), p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  app.post('/api/gateway/transfers/:id/override', async (req, res) => {
    if (!perms.require(req, res, 'gateway.override_fifo')) return;
    const b = req.body || {};
    if (!num(b.line_id))  return fail(res, 400, 'line_id is required');
    if (!num(b.lot_id))   return fail(res, 400, 'lot_id is required');
    if (!(num(b.qty) > 0)) return fail(res, 400, 'qty must be greater than zero');
    // Reason is optional at the UI: allocating to the shelf the driver actually
    // used is the norm. The RPC still requires one and flags is_fifo_override
    // only when the chosen lot differs from FIFO, so a default note keeps it
    // frictionless without losing the audit trail.
    const reason = str(b.reason) || 'Alocado conforme colocação na Gateway';

    const { data, error } = await sb.rpc('gateway_allocate_override', {
      p_line_id: Number(b.line_id), p_lot_id: Number(b.lot_id),
      p_qty: num(b.qty), p_reason: reason, p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  app.delete('/api/gateway/allocations/:allocId', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.edit')) return;
    const { data: a } = await sb.from('gateway_transfer_allocations')
      .select('id,transfer_id,state').eq('id', Number(req.params.allocId)).maybeSingle();
    if (!a) return fail(res, 404, 'Allocation not found');
    if (a.state === 'consumed') {
      return fail(res, 409, 'This stock has already moved. Reverse it instead of deleting the record.');
    }
    const { error } = await sb.from('gateway_transfer_allocations').delete().eq('id', a.id);
    if (error) return pgFail(res, error);
    await sb.rpc('gateway_refresh_fifo_flag', { p_transfer_id: a.transfer_id });
    ok(res, { deleted: true });
  });

  // Status moves that carry no stock effect. Posting and cancelling are
  // separate endpoints because they do.
  const STATUS_FLOW = {
    draft:          ['ready_for_cin7', 'cancelled'],
    ready_for_cin7: ['cin7_created', 'draft', 'cancelled'],
    cin7_created:   ['picking', 'ready_for_cin7', 'cancelled'],
    picking:        ['dispatched', 'cin7_created', 'cancelled'],
    dispatched:     ['completed', 'picking', 'cancelled'],
  };

  app.post('/api/gateway/transfers/:id/status', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.edit')) return;
    const id = Number(req.params.id);
    const to = str((req.body || {}).status);
    const { data: tr } = await sb.from('gateway_transfers').select('*').eq('id', id).maybeSingle();
    if (!tr) return fail(res, 404, 'Transfer not found');
    if (to === 'completed') return fail(res, 400, 'Use POST /post to complete a transfer — it moves stock');
    if (to === 'cancelled') return fail(res, 400, 'Use POST /cancel to cancel a transfer');
    if (!(STATUS_FLOW[tr.status] || []).includes(to)) {
      return fail(res, 409, `Cannot go from ${tr.status} to ${to}`,
        { allowed: STATUS_FLOW[tr.status] || [] });
    }
    if (to === 'cin7_created' && !tr.cin7_reference) {
      return fail(res, 409, 'Record the Cin7 transfer reference before marking it created in Cin7');
    }

    const patch = { status: to, updated_by: user(req) };
    if (to === 'ready_for_cin7') { patch.prepared_at = new Date().toISOString(); patch.prepared_by = user(req); }
    if (to === 'picking')        { patch.picked_at = new Date().toISOString();   patch.picked_by = user(req); }
    if (to === 'dispatched')     { patch.dispatched_at = new Date().toISOString(); patch.dispatched_by = user(req); }

    const { data, error } = await sb.from('gateway_transfers').update(patch).eq('id', id).select().single();
    if (error) return pgFail(res, error);
    await sb.from('gateway_audit_log').insert({
      entity_type: 'transfer', entity_id: String(id), action: `status_${to}`,
      details: { from: tr.status, to }, user_name: user(req),
    });
    ok(res, data);
  });

  // The manual bridge to Cin7: a human raised TR-xxxxx by hand, this records it.
  app.post('/api/gateway/transfers/:id/cin7', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.link_cin7')) return;
    const id  = Number(req.params.id);
    const ref = str((req.body || {}).cin7_reference);
    if (!ref) return fail(res, 400, 'cin7_reference is required (e.g. TR-49562)');

    // Best-effort: confirm it exists in the Cin7 mirror. Not fatal — the
    // mirror syncs every couple of hours and a fresh transfer will not be
    // there yet. Refusing would push people back to the spreadsheet.
    let matched = null;
    const { data: hit } = await sb.schema(CIN7).from('stock_transfers')
      .select('task_id,number,from_location,to_location,status,total_qty')
      .eq('number', ref).maybeSingle();
    if (hit) matched = hit;

    const { data, error } = await sb.from('gateway_transfers').update({
      cin7_reference: ref, cin7_task_id: matched?.task_id || null,
      cin7_linked_at: new Date().toISOString(), cin7_linked_by: user(req),
      status: 'cin7_created', updated_by: user(req),
    }).eq('id', id).select().single();
    if (error) return pgFail(res, error);

    await sb.from('gateway_audit_log').insert({
      entity_type: 'transfer', entity_id: String(id), action: 'cin7_linked',
      details: { cin7_reference: ref, matched_in_mirror: !!matched, matched }, user_name: user(req),
    });
    ok(res, { transfer: data, cin7: matched, matched_in_mirror: !!matched });
  });

  app.post('/api/gateway/transfers/:id/post', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.complete')) return;
    const b = req.body || {};
    const picked = Array.isArray(b.picked) ? b.picked : null;
    const { data, error } = await sb.rpc('gateway_post_transfer', {
      p_transfer_id: Number(req.params.id),
      p_picked: picked,
      p_occurred_at: str(b.occurred_at),
      p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  app.post('/api/gateway/transfers/:id/cancel', async (req, res) => {
    if (!perms.require(req, res, 'gateway.transfer.cancel')) return;
    const reason = str((req.body || {}).reason);
    if (!reason) return fail(res, 400, 'A reason is required to cancel a transfer');
    const { data, error } = await sb.rpc('gateway_cancel_transfer', {
      p_transfer_id: Number(req.params.id), p_reason: reason, p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  app.post('/api/gateway/allocations/:allocId/reverse', async (req, res) => {
    if (!perms.require(req, res, 'gateway.lot.adjust')) return;
    const b = req.body || {};
    if (!(num(b.qty) > 0)) return fail(res, 400, 'qty must be greater than zero');
    if (!str(b.reason))    return fail(res, 400, 'reason is required');
    const { data, error } = await sb.rpc('gateway_reverse_transfer_line', {
      p_allocation_id: Number(req.params.allocId), p_qty: num(b.qty),
      p_reason: str(b.reason), p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  // Everything the pick sheet needs, in walking order rather than SKU order.
  app.get('/api/gateway/transfers/:id/picklist', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [tr, allocs, lines] = await Promise.all([
        sb.from('gateway_v_transfers').select('*').eq('id', id).maybeSingle(),
        sb.from('gateway_transfer_allocations')
          .select('id,qty,fifo_rank,is_fifo_override,override_reason,state,' +
                  'line:gateway_transfer_lines(sku,five_dc,product_name,uom),' +
                  'lot:gateway_lots(id,received_on,date_confidence,shelf_id,shelf_text,pallet_number,qty_remaining)')
          .eq('transfer_id', id).neq('state', 'released'),
        sb.from('gateway_transfer_lines').select('*').eq('transfer_id', id),
      ]);
      if (!tr.data) return fail(res, 404, 'Transfer not found');

      const shelves = Object.fromEntries(
        ((await sb.from('gateway_shelves').select('id,area,shelf_number,pick_sequence')).data || [])
          .map(s => [s.id, s]));

      const rows = (allocs.data || []).map(a => {
        const s = shelves[a.lot?.shelf_id] || {};
        return {
          allocation_id: a.id,
          shelf: a.lot?.shelf_id || a.lot?.shelf_text || null,
          area: s.area || null,
          pick_sequence: s.pick_sequence ?? null,
          shelf_number: s.shelf_number ?? null,
          pallet: a.lot?.pallet_number || null,
          sku: a.line?.sku, five_dc: a.line?.five_dc, product_name: a.line?.product_name,
          qty: Number(a.qty), uom: a.line?.uom || 'Item',
          received_on: a.lot?.received_on || null,
          date_confidence: a.lot?.date_confidence,
          fifo_rank: a.fifo_rank,
          is_fifo_override: a.is_fifo_override,
          override_reason: a.override_reason,
          lot_id: a.lot?.id,
        };
      });

      // Sort by the route the picker actually walks: explicit pick_sequence
      // first, then area + shelf number, then SKU. That is what column B of
      // the paper sheet encoded, scrambled, by hand.
      rows.sort((x, y) =>
        (x.pick_sequence ?? 1e9) - (y.pick_sequence ?? 1e9) ||
        String(x.area || '~').localeCompare(String(y.area || '~')) ||
        (x.shelf_number ?? 1e9) - (y.shelf_number ?? 1e9) ||
        String(x.shelf || '~').localeCompare(String(y.shelf || '~')) ||
        String(x.sku || '').localeCompare(String(y.sku || '')));
      rows.forEach((r, i) => { r.pick_no = i + 1; });

      ok(res, {
        transfer: tr.data,
        rows,
        unallocated: (lines.data || [])
          .filter(l => Number(l.qty_allocated) < Number(l.qty_requested))
          .map(l => ({ sku: l.sku, product_name: l.product_name,
                       requested: Number(l.qty_requested), allocated: Number(l.qty_allocated),
                       short: Number(l.qty_requested) - Number(l.qty_allocated) })),
      });
    } catch (e) { pgFail(res, e); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Reconciliation
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/gateway/reconciliation', async (req, res) => {
    const limit  = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Number(req.query.offset) || 0;
    let q = sb.from('gateway_v_reconciliation').select('*', { count: 'exact' });
    // Drop the zero-on-both-sides carton-variant noise (see /inventory).
    q = q.or('local_qty.neq.0,cin7_qty.neq.0');
    if (req.query.state) q = q.in('state', String(req.query.state).split(','));
    else                 q = q.neq('state', 'match');
    if (req.query.issue_status) q = q.eq('issue_status', str(req.query.issue_status));
    const { data, error, count } = await q
      .order('difference', { ascending: true }).range(offset, offset + limit - 1);
    if (error) return pgFail(res, error);

    const { data: fresh } = await sb.schema(CIN7).from('data_freshness')
      .select('*').eq('table_name', 'stock_snapshot').maybeSingle();
    ok(res, { rows: data || [], total: count || 0, limit, offset, cin7_freshness: fresh || null });
  });

  app.post('/api/gateway/reconciliation/refresh', async (req, res) => {
    if (!perms.require(req, res, 'gateway.reconcile')) return;
    const { data, error } = await sb.rpc('gateway_refresh_reconciliation', {
      p_tolerance: num((req.body || {}).tolerance) ?? 0, p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  app.post('/api/gateway/reconciliation/:id/resolve', async (req, res) => {
    if (!perms.require(req, res, 'gateway.reconcile')) return;
    const b = req.body || {};
    const { data, error } = await sb.rpc('gateway_resolve_recon_issue', {
      p_issue_id: Number(req.params.id), p_status: str(b.status) || 'resolved',
      p_cause: str(b.cause_code), p_note: str(b.note), p_user: user(req),
    });
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Imports
  // ═══════════════════════════════════════════════════════════════════

  app.get('/api/gateway/imports', async (req, res) => {
    const { data, error } = await sb.from('gateway_import_batches')
      .select('*').order('started_at', { ascending: false }).limit(50);
    if (error) return pgFail(res, error);
    ok(res, data || []);
  });

  app.get('/api/gateway/imports/:id/issues', async (req, res) => {
    let q = sb.from('gateway_import_issues').select('*', { count: 'exact' })
      .eq('batch_id', Number(req.params.id));
    if (req.query.severity) q = q.in('severity', String(req.query.severity).split(','));
    if (req.query.resolved !== undefined) q = q.eq('resolved', req.query.resolved === 'true');
    const { data, error, count } = await q
      .order('severity').order('id')
      .range(Number(req.query.offset) || 0, (Number(req.query.offset) || 0) + (Math.min(Number(req.query.limit) || 200, 1000)) - 1);
    if (error) return pgFail(res, error);
    ok(res, { rows: data || [], total: count || 0 });
  });

  app.post('/api/gateway/imports/issues/:id/resolve', async (req, res) => {
    if (!perms.require(req, res, 'gateway.import')) return;
    const { data, error } = await sb.from('gateway_import_issues').update({
      resolved: true, resolved_by: user(req), resolved_at: new Date().toISOString(),
    }).eq('id', Number(req.params.id)).select().single();
    if (error) return pgFail(res, error);
    ok(res, data);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Replenishment recommendation
  // ═══════════════════════════════════════════════════════════════════
  //
  // The workbook never held a target level: 'Consolidate plan' is a shelf
  // consolidation list, not a min/max. So the recommendation is built from
  // what the business already measures — Main's own stock against its average
  // monthly sales — and it never suggests more than Gateway can actually
  // supply. recommended / selected / actual stay three different numbers all
  // the way through; this endpoint only produces the first.
  app.get('/api/gateway/recommendations', async (req, res) => {
    try {
      const weeksTarget = Number(req.query.weeks) || 4;
      const limit = Math.min(Number(req.query.limit) || 100, 500);

      const [gw, mainRows, avg] = await Promise.all([
        sb.from('gateway_v_sku_balance').select('sku,product_name,five_dc,qty_available,oldest_received_on,oldest_age_days,shelves'),
        sb.schema(CIN7).from('stock_snapshot').select('sku,on_hand').eq('location_name', 'Main Warehouse'),
        sb.from('branch_avg_monthly_sales').select('product,avg_mth_main,avg_sales_main,avg_transfer_main'),
      ]);
      if (gw.error) return pgFail(res, gw.error);

      const mainBySku = {};
      for (const r of mainRows.data || []) {
        mainBySku[r.sku] = (mainBySku[r.sku] || 0) + Number(r.on_hand || 0);
      }
      // branch_avg_monthly_sales.product is the Rapid CODE/SKU (e.g. 'R3206-TRI'),
      // not the description — so key by SKU, not name. Weeks of cover uses
      // avg_mth_main = TOTAL monthly movement out of Main (sales + transfers to
      // branches), which is how the old Gateway screen did it; avg_sales_main
      // alone understates demand and overstates cover.
      const avgByCode = {};
      for (const r of avg.data || []) {
        const k = String(r.product || '').toUpperCase().trim();
        if (k) avgByCode[k] = {
          total: Number(r.avg_mth_main ?? 0),
          sales: Number(r.avg_sales_main ?? 0),
          transfer: Number(r.avg_transfer_main ?? 0),
        };
      }

      const rows = [];
      for (const g of gw.data || []) {
        const available = Number(g.qty_available || 0);
        if (available <= 0) continue;
        const a = avgByCode[String(g.sku || '').toUpperCase().trim()]
               || avgByCode[String(g.product_name || '').toUpperCase().trim()] || null;
        const monthly = a ? a.total : 0;
        const weekly  = monthly / 4.33;
        const main    = mainBySku[g.sku] || 0;
        if (!weekly) continue;                       // no demand signal, no recommendation
        const weeksCover = Math.round((main / weekly) * 10) / 10;
        const target  = weekly * weeksTarget;
        const gap     = target - main;
        if (gap <= 0) continue;                       // Main already covered
        // bucket by how little cover Main has left — the "less than N weeks" view
        const bucket = weeksCover < 2 ? 'lt2' : weeksCover < 4 ? 'lt4' : weeksCover < 6 ? 'lt6' : 'ok';
        rows.push({
          sku: g.sku, product_name: g.product_name, five_dc: g.five_dc,
          main_qty: main,
          weekly_demand: Math.round(weekly * 10) / 10,
          weeks_cover: weeksCover, bucket,
          target_qty: Math.round(target),
          recommended_qty: Math.min(Math.round(gap), available),
          gateway_available: available,
          capped_by_gateway: Math.round(gap) > available,
          oldest_received_on: g.oldest_received_on,
          oldest_age_days: g.oldest_age_days,
          shelves: g.shelves,
        });
      }
      rows.sort((a, b) => (a.weeks_cover ?? 1e9) - (b.weeks_cover ?? 1e9));
      const counts = { lt2: 0, lt4: 0, lt6: 0, ok: 0 };
      rows.forEach(r => { counts[r.bucket]++; });
      ok(res, {
        rows: rows.slice(0, limit), total: rows.length, weeks_target: weeksTarget,
        counts,
        note: 'Cobertura = stock da Main ÷ (avg mensal total da Main ÷ 4.33). ' +
              'Só sugere o que a Gateway tem e o que a Main está abaixo do alvo.',
      });
    } catch (e) { pgFail(res, e); }
  });

  // ═══════════════════════════════════════════════════════════════════
  app.get('/api/gateway/audit', async (req, res) => {
    let q = sb.from('gateway_audit_log').select('*', { count: 'exact' });
    if (req.query.entity_type) q = q.eq('entity_type', str(req.query.entity_type));
    if (req.query.entity_id)   q = q.eq('entity_id', str(req.query.entity_id));
    const { data, error, count } = await q
      .order('created_at', { ascending: false })
      .range(Number(req.query.offset) || 0, (Number(req.query.offset) || 0) + 99);
    if (error) return pgFail(res, error);
    ok(res, { rows: data || [], total: count || 0 });
  });

  app.get('/api/gateway/capabilities', (req, res) => {
    ok(res, {
      user: perms.userOf(req),
      capabilities: Object.fromEntries(perms.CAPABILITIES.map(c => [c, perms.can(req, c)])),
      erp_write_enabled: false,
    });
  });

  console.log('✅ Gateway inventory routes registered (/api/gateway/*)');
  return { ERPTransferProvider };
};
