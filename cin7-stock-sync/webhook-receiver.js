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

const MovementProcessor = require('./movement-processor');

module.exports = function registerWebhookRoutes(app, supabaseBackend) {
  if (!supabaseBackend) {
    console.warn('⚠️  Webhook receiver: Supabase backend not configured — skipping webhook routes');
    return;
  }

  const processor = new MovementProcessor(supabaseBackend);

  // ────────────────────────────────────────────────────────
  // POST /api/cin7/webhook — Receive Cin7 Core webhooks
  // ────────────────────────────────────────────────────────
  app.post('/api/cin7/webhook', async (req, res) => {
    const receivedAt = new Date().toISOString();
    const payload = req.body || {};

    try {
      // Extract key fields from Cin7 webhook payload
      const topic = payload.Type || payload.type || payload.Topic || payload.topic || 'unknown';
      const eventId = payload.ID || payload.id || payload.EventID || null;
      const orderNumber = payload.OrderNumber || payload.Number || payload.Reference || null;

      console.log(`📩 Webhook received: ${topic} | ID: ${eventId || 'N/A'} | Ref: ${orderNumber || 'N/A'}`);

      // Store in webhook_events table
      const { data: event, error: insertError } = await supabaseBackend
        .schema('cin7_mirror')
        .from('webhook_events')
        .insert({
          received_at: receivedAt,
          topic: topic,
          event_id: eventId,
          payload: payload,
          status: 'pending',
          metadata: {
            ip: req.ip,
            user_agent: req.get('User-Agent'),
            order_number: orderNumber,
          },
        })
        .select('id')
        .single();

      if (insertError) {
        console.error('❌ Failed to store webhook event:', insertError.message);
        return res.status(500).json({ success: false, error: 'Failed to store event' });
      }

      // Acknowledge immediately (Cin7 expects fast response)
      res.status(200).json({ success: true, event_id: event.id });

      // Process asynchronously (don't block the response)
      setImmediate(async () => {
        try {
          await processor.processWebhookEvent(event.id, topic, payload);
        } catch (e) {
          console.error(`❌ Async processing failed for event ${event.id}:`, e.message);
        }
      });

    } catch (e) {
      console.error('❌ Webhook handler error:', e);
      res.status(500).json({ success: false, error: e.message });
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
