#!/usr/bin/env node
/**
 * Cin7 Webhook Queue Drainer
 * ================================================================
 * Decoupled processor: drains cin7_mirror.webhook_events (the queue the
 * Vercel receiver fills), enriches each event via the Cin7 API, runs the
 * MovementProcessor (stock movements + alert rules), and applies retry/
 * backoff. The SAME drainQueue() powers both:
 *   • real-time:  POST /api/cin7/process  (fired by a Supabase DB webhook)
 *   • backstop:   this CLI on a GitHub Actions cron (catches any gaps)
 *
 * Safe by design:
 *   - Only touches rows already in the queue (does nothing if empty).
 *   - Per-event status is owned by MovementProcessor (processed/failed);
 *     drainQueue adds attempts + exponential backoff + dead-lettering.
 *   - Sequential processing → naturally throttled under Cin7's 60/min limit.
 *
 * CLI usage:  node cin7-stock-sync/process-webhook-queue.js
 * Env:        SUPABASE_URL, SUPABASE_SERVICE_KEY, CIN7_ACCOUNT_ID, CIN7_API_KEY
 *             WEBHOOK_MAX_ATTEMPTS (default 6), WEBHOOK_BATCH (default 50)
 */
const MovementProcessor = require('./movement-processor');

// exponential backoff: 1, 3, 9, 27 min … capped at 6h
function backoffMs(attempt) {
  return Math.min(6 * 60 * 60 * 1000, Math.round(Math.pow(3, attempt) * 60 * 1000));
}

/**
 * Drain due events from the queue.
 * @param {SupabaseClient} sb   service-role client
 * @param {object} opts         { batch, maxAttempts }
 * @returns {Promise<{found,processed,retried,dead}>}
 */
async function drainQueue(sb, opts = {}) {
  const batch = opts.batch || 50;
  const maxAttempts = opts.maxAttempts || 6;
  const cm = sb.schema('cin7_mirror');
  const processor = new MovementProcessor(sb);

  const startedAt = new Date().toISOString();
  const nowIso = new Date().toISOString();

  const { data: events, error } = await cm
    .from('webhook_events')
    .select('id, event_type, topic, payload, attempts')
    .in('status', ['pending', 'failed'])
    .lte('next_attempt_at', nowIso)
    .lt('attempts', maxAttempts)
    .order('received_at', { ascending: true })
    .limit(batch);

  if (error) throw new Error(`claim failed: ${error.message}`);
  if (!events || events.length === 0) return { found: 0, processed: 0, retried: 0, dead: 0 };

  let processed = 0, retried = 0, dead = 0;
  for (const ev of events) {
    const type = ev.event_type || ev.topic || 'unknown';
    try {
      await processor.processWebhookEvent(ev.id, type, ev.payload);
    } catch (e) {
      console.error(`  ! event ${ev.id} threw: ${e.message}`);
    }

    const { data: after } = await cm
      .from('webhook_events').select('status').eq('id', ev.id).single();

    if (after && after.status === 'processed') { processed++; continue; }

    const attempts = (ev.attempts || 0) + 1;
    if (attempts < maxAttempts) {
      const next = new Date(Date.now() + backoffMs(attempts)).toISOString();
      await cm.from('webhook_events')
        .update({ status: 'pending', attempts, next_attempt_at: next }).eq('id', ev.id);
      retried++;
    } else {
      await cm.from('webhook_events')
        .update({ status: 'failed', attempts }).eq('id', ev.id);
      dead++;
    }
  }

  await cm.from('webhook_processing_log').insert({
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    events_found: events.length,
    events_processed: processed,
    events_failed: retried + dead,
  });

  return { found: events.length, processed, retried, dead };
}

module.exports = { drainQueue };

// ── CLI entry (backstop run) ──
if (require.main === module) {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY not set');
    process.exit(1);
  }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  drainQueue(sb, {
    batch: parseInt(process.env.WEBHOOK_BATCH || '50', 10),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10),
  }).then(r => {
    console.log(`✅ Drain done. found=${r.found} processed=${r.processed} retried=${r.retried} dead=${r.dead}`);
    process.exit(0);
  }).catch(e => { console.error('❌ Drainer crashed:', e); process.exit(1); });
}
