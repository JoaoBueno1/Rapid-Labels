/**
 * Cin7 Webhook Receiver — Express routes
 * 
 * Adds webhook endpoints to the existing server.js Express app.
 * Receives Cin7 Core webhooks, stores them in cin7_mirror.webhook_events,
 * and triggers immediate processing to fetch movement details.
 * 
 * Usage:
 *   In server.js: require('./cin7-stock-sync/webhook-receiver')(app, supabaseBackend);
 * 
 * Cin7 Webhook Topics:
 *   sale/order/create       — New sales order
 *   sale/order/update       — SO status change (pick, pack, ship)
 *   sale/order/void         — SO cancelled
 *   purchase/order/create   — New purchase order
 *   purchase/order/update   — PO received
 *   stock/adjustment/create — Manual stock adjustment
 *   stock/transfer/create   — Stock transfer between locations
 *   product/update          — Product details changed
 */

const crypto = require('crypto');

// ── Normalize the many Cin7 Core webhook payload shapes into our fields ──
// Real payloads vary by event: Sale/Created uses SaleID+SaleOrderNumber,
// Sale/ShipmentAuthorised uses SaleTaskID+OrderNumber, etc.
function normalizeWebhook(payload) {
  const eventType = payload.EventType || payload.Type || payload.type || payload.Topic || payload.topic || 'unknown';
  const saleId = payload.SaleID || payload.SaleTaskID || payload.ID || payload.id || null;
  const orderNumber = payload.OrderNumber || payload.SaleOrderNumber || payload.Number || payload.Reference || null;
  return { eventType, saleId, orderNumber };
}

module.exports = function registerWebhookRoutes(app, supabaseBackend) {
  if (!supabaseBackend) {
    console.warn('⚠️  Webhook receiver: Supabase backend not configured — skipping webhook routes');
    return;
  }

  const WEBHOOK_TOKEN = process.env.CIN7_WEBHOOK_TOKEN || '';
  if (!WEBHOOK_TOKEN) {
    console.warn('⚠️  CIN7_WEBHOOK_TOKEN not set — webhook receiver runs UNAUTHENTICATED (dev mode). Set it before registering live webhooks.');
  }

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/webhook — Receive Cin7 Core webhooks
  // Design: verify → persist (idempotent) → ACK fast. NO inline
  // processing (serverless-safe); the queue drainer enriches later.
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/webhook', async (req, res) => {
    // 1) Auth — Cin7 sends the bearer token we configured on the webhook
    if (WEBHOOK_TOKEN) {
      const auth = req.get('Authorization') || '';
      if (auth !== `Bearer ${WEBHOOK_TOKEN}`) {
        console.warn('🚫 Webhook rejected: bad/missing bearer token');
        return res.status(401).json({ success: false, error: 'unauthorized' });
      }
    }

    const receivedAt = new Date().toISOString();
    const payload = req.body || {};

    try {
      const { eventType, saleId, orderNumber } = normalizeWebhook(payload);
      // 2) Idempotency: identical Cin7 retries → identical payload → same key
      const dedupKey = crypto.createHash('md5')
        .update(`${eventType}|${JSON.stringify(payload)}`)
        .digest('hex');

      console.log(`📩 Webhook: ${eventType} | sale=${saleId || 'N/A'} | ref=${orderNumber || 'N/A'}`);

      // 3) Persist (insert; unique dedup_key drops duplicate retries)
      const { data: event, error: insertError } = await supabaseBackend
        .schema('cin7_mirror')
        .from('webhook_events')
        .insert({
          received_at: receivedAt,
          topic: eventType,            // keep legacy column populated
          event_type: eventType,
          sale_id: saleId,
          order_number: orderNumber,
          event_id: saleId,
          dedup_key: dedupKey,
          payload: payload,
          status: 'pending',
          source: 'webhook',
          next_attempt_at: receivedAt,
          metadata: {
            ip: req.ip,
            user_agent: req.get('User-Agent'),
          },
        })
        .select('id')
        .single();

      if (insertError) {
        // 23505 = unique violation → we already received this exact event
        if (insertError.code === '23505') {
          return res.status(200).json({ success: true, duplicate: true });
        }
        console.error('❌ Failed to store webhook event:', insertError.message);
        return res.status(500).json({ success: false, error: 'Failed to store event' });
      }

      // 4) ACK immediately — Cin7 expects a fast 200; processing is decoupled
      return res.status(200).json({ success: true, event_id: event.id });

    } catch (e) {
      console.error('❌ Webhook handler error:', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/process — Drain the queue (real-time trigger)
  // Fired by a Supabase DB webhook on webhook_events INSERT, or manually.
  // Token-protected; processes a small batch (serverless-duration-safe).
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/process', async (req, res) => {
    if (WEBHOOK_TOKEN) {
      const auth = req.get('Authorization') || '';
      const headerTok = req.get('x-process-token') || '';
      if (auth !== `Bearer ${WEBHOOK_TOKEN}` && headerTok !== WEBHOOK_TOKEN) {
        return res.status(401).json({ success: false, error: 'unauthorized' });
      }
    }
    try {
      const { drainQueue } = require('./process-webhook-queue');
      const batch = parseInt(process.env.WEBHOOK_PROCESS_BATCH || '10', 10);
      const result = await drainQueue(supabaseBackend, { batch });
      return res.status(200).json({ success: true, ...result });
    } catch (e) {
      console.error('❌ Queue process error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/webhook/test — Test webhook endpoint
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/webhook/test', async (req, res) => {
    res.json({
      success: true,
      message: 'Webhook endpoint is active',
      timestamp: new Date().toISOString(),
    });
  });

  // ────────────────────────────────────────────────────────
  // GET /api/cin7/webhook/status — Webhook processing status
  // ────────────────────────────────────────────────────────
  app.get('/api/cin7/webhook/status', async (req, res) => {
    try {
      // Count by status
      const { data: counts, error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('webhook_events')
        .select('status', { count: 'exact', head: false });

      if (error) throw error;

      const summary = { pending: 0, processing: 0, processed: 0, failed: 0 };
      (counts || []).forEach(r => { summary[r.status] = (summary[r.status] || 0) + 1; });

      // Last processed
      const { data: last } = await supabaseBackend
        .schema('cin7_mirror')
        .from('webhook_events')
        .select('id, topic, processed_at, status')
        .order('processed_at', { ascending: false })
        .limit(1)
        .single();

      res.json({
        success: true,
        counts: summary,
        last_processed: last || null,
      });

    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/snapshot-diff — Trigger snapshot delta detection
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/snapshot-diff', async (req, res) => {
    try {
      const SnapshotDiffer = require('./snapshot-differ');
      const differ = new SnapshotDiffer(supabaseBackend);
      const result = await differ.runFullDiff();
      res.json({ success: true, ...result });
    } catch (e) {
      console.error('❌ Snapshot diff error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/alerts/acknowledge — Acknowledge alerts
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/alerts/acknowledge', async (req, res) => {
    try {
      const { alert_ids } = req.body || {};
      if (!alert_ids || !Array.isArray(alert_ids)) {
        return res.status(400).json({ success: false, error: 'alert_ids array required' });
      }

      const { error } = await supabaseBackend
        .schema('cin7_mirror')
        .from('movement_alerts')
        .update({ acknowledged_at: new Date().toISOString() })
        .in('id', alert_ids);

      if (error) throw error;
      res.json({ success: true, acknowledged: alert_ids.length });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('✅ Cin7 webhook routes registered: POST /api/cin7/webhook');
};
