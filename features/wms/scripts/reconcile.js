#!/usr/bin/env node
/**
 * features/wms/scripts/reconcile.js — WMS outbox reconciler entrypoint for CI.
 *
 * Drains ambiguous 'sent'/'failed' WMS outbox ops by checking live Cin7 (GET-only) and,
 * if the write actually landed, marking the row reconciled + journaling — so a timed-out
 * write is never blindly re-sent. Read-only against Cin7; writes only wms.outbox/movements.
 *
 * Ships DISABLED (the workflow has no schedule — manual only). Enable the cron only after
 * WMS is live AND /api/wms/* has auth (see features/wms/WMS_PACK_STATUS.md). With no live
 * writes yet, the outbox is empty and this is a no-op.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const reconciler = require('../lib/reconciler');

(async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) { console.error('wms reconcile: missing SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const cap = Number(process.env.WMS_RECONCILE_CAP || 50);
  try {
    const out = await reconciler.reconcile(sb, { limit: cap });
    console.log('wms reconcile:', JSON.stringify(out));
    process.exit(0);
  } catch (e) {
    console.error('wms reconcile failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
