#!/usr/bin/env node
/**
 * Cin7 Webhook Queue Drainer (single-flight)
 * ================================================================
 * Drains cin7_mirror.webhook_events, enriches each event via the Cin7 API,
 * runs the MovementProcessor, and applies retry/backoff.
 *
 * SINGLE-FLIGHT: acquires a DB lease so only ONE drain runs at a time, even
 * when many Supabase-trigger /process invocations fire during a burst. This
 * is what prevents the Cin7 403 "burst throttle" — calls stay sequential and
 * throttled instead of concurrent. A crashed run's lease expires (90s) and
 * the next run takes over; claimed events have a 2-min visibility timeout.
 *
 * Falls back to a legacy SELECT-based drain if the queue RPCs aren't present
 * yet (so deploying before applying sql/2026-06-16_webhook_queue_rpcs.sql is
 * safe).
 *
 * CLI usage:  node cin7-stock-sync/process-webhook-queue.js
 */
const MovementProcessor = require('./movement-processor');

function backoffMs(attempt) {
  return Math.min(6 * 60 * 60 * 1000, Math.round(Math.pow(3, attempt) * 60 * 1000));
}

// schedule retry / dead-letter for an event the processor didn't finish
async function rescheduleOrFail(cm, ev, maxAttempts) {
  const attempts = (ev.attempts || 0) + 1;
  if (attempts < maxAttempts) {
    const next = new Date(Date.now() + backoffMs(attempts)).toISOString();
    await cm.from('webhook_events')
      .update({ status: 'pending', attempts, next_attempt_at: next }).eq('id', ev.id);
    return 'retried';
  }
  await cm.from('webhook_events').update({ status: 'failed', attempts }).eq('id', ev.id);
  return 'dead';
}

async function processOne(cm, processor, ev, maxAttempts, totals) {
  const type = ev.event_type || ev.topic || 'unknown';
  try {
    await processor.processWebhookEvent(ev.id, type, ev.payload);
  } catch (e) {
    console.error(`  ! event ${ev.id} threw: ${e.message}`);
  }
  const { data: after } = await cm.from('webhook_events').select('status').eq('id', ev.id).single();
  if (after && after.status === 'processed') { totals.processed++; return; }
  const outcome = await rescheduleOrFail(cm, ev, maxAttempts);
  totals[outcome]++;
}

/**
 * Drain due events. Single-flight via lease; sequential + throttled.
 * @returns {Promise<{found,processed,retried,dead,skipped?}>}
 */
async function drainQueue(sb, opts = {}) {
  const batch = opts.batch || 10;
  const maxAttempts = opts.maxAttempts || 6;
  const leaseSec = opts.leaseSec || 90;
  const cm = sb.schema('cin7_mirror');
  const processor = new MovementProcessor(sb);
  const totals = { found: 0, processed: 0, retried: 0, dead: 0 };

  // Try to acquire the single-flight lease. If the RPC is missing, fall back.
  let leased = null, rpcAvailable = true;
  try {
    const { data, error } = await cm.rpc('acquire_drain_lease', { p_seconds: leaseSec });
    if (error) throw error;
    leased = data;
  } catch (e) {
    rpcAvailable = false; // RPCs not deployed yet → legacy path
  }

  if (rpcAvailable && !leased) {
    return { ...totals, skipped: true }; // another drain is already running
  }

  try {
    if (rpcAvailable) {
      // claim/process loop, stop a little before the lease expires
      const deadline = Date.now() + (leaseSec - 15) * 1000;
      while (Date.now() < deadline) {
        const { data: events, error } = await cm.rpc('claim_webhook_events', { p_batch: batch });
        if (error) throw error;
        if (!events || events.length === 0) break;
        totals.found += events.length;
        for (const ev of events) await processOne(cm, processor, ev, maxAttempts, totals);
      }
    } else {
      // legacy fallback: select due events directly (no single-flight)
      const nowIso = new Date().toISOString();
      const { data: events } = await cm.from('webhook_events')
        .select('id, event_type, topic, payload, attempts')
        .in('status', ['pending', 'failed']).lte('next_attempt_at', nowIso)
        .lt('attempts', maxAttempts).order('received_at', { ascending: true }).limit(batch);
      if (events && events.length) {
        totals.found = events.length;
        for (const ev of events) await processOne(cm, processor, ev, maxAttempts, totals);
      }
    }
  } finally {
    if (rpcAvailable) { try { await cm.rpc('release_drain_lease'); } catch {} }
  }

  if (totals.found > 0) {
    await cm.from('webhook_processing_log').insert({
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      events_found: totals.found, events_processed: totals.processed,
      events_failed: totals.retried + totals.dead,
    });
  }
  return totals;
}

module.exports = { drainQueue };

// ── CLI entry (backstop run) ──
if (require.main === module) {
  require('dotenv').config();
  const { createClient } = require('@supabase/supabase-js');
  if (!process.env.SUPABASE_SERVICE_KEY) { console.error('❌ SUPABASE_SERVICE_KEY not set'); process.exit(1); }
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  drainQueue(sb, {
    batch: parseInt(process.env.WEBHOOK_BATCH || '10', 10),
    maxAttempts: parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '6', 10),
  }).then(r => {
    console.log(`✅ Drain done. ${JSON.stringify(r)}`);
    process.exit(0);
  }).catch(e => { console.error('❌ Drainer crashed:', e); process.exit(1); });
}
