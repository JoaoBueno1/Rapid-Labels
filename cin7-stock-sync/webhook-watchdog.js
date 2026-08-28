#!/usr/bin/env node
/**
 * Cin7 Webhook Watchdog
 * ================================================================
 * Cin7 auto-DEACTIVATES a webhook after 6 failed deliveries (~75 min).
 * This guard checks OUR webhooks and reactivates any that Cin7 disabled,
 * logging every check to cin7_mirror.webhook_health_log.
 *
 * Safety: only ever touches webhooks that are BOTH (a) one of OUR_EVENTS
 * and (b) pointing at OUR receiver URL (CIN7_WEBHOOK_URL). Any other
 * system's webhooks (e.g. the n8n Customer/Updated) are never modified.
 *
 * Usage:  node cin7-stock-sync/webhook-watchdog.js
 * Env:    CIN7_ACCOUNT_ID, CIN7_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *         CIN7_WEBHOOK_URL (our receiver; optional but recommended)
 */
require('dotenv').config();
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const { OUR_EVENTS } = require('./webhook-config');

const ACC = process.env.CIN7_ACCOUNT_ID || '';
const KEY = process.env.CIN7_API_KEY || '';
const OUR_URL = process.env.CIN7_WEBHOOK_URL || '';
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';

function cin7(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const r = https.request(u, {
      method,
      headers: {
        'api-auth-accountid': ACC,
        'api-auth-applicationkey': KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let parsed; try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  if (!ACC || !KEY) { console.error('❌ CIN7 credentials missing'); process.exit(1); }
  const sb = process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;
  const logHealth = async (row) => {
    if (sb) { try { await sb.schema('cin7_mirror').from('webhook_health_log').insert(row); } catch {} }
  };

  const { status, body } = await cin7('GET', '/webhooks');
  if (status !== 200) { console.error('❌ GET /webhooks failed:', status, body); process.exit(1); }
  const hooks = (body && body.Webhooks) || [];

  // Only OURS: matching event type AND (if configured) our receiver URL
  const ours = hooks.filter(h =>
    OUR_EVENTS.includes(h.Type) && (!OUR_URL || h.ExternalURL === OUR_URL));

  console.log(`Checked ${hooks.length} webhook(s); ${ours.length} are ours.`);
  let reactivated = 0, healthy = 0;
  let needsToken = 0;   // webhooks que precisavam de reativação e o token não estava no ambiente

  for (const h of ours) {
    if (h.IsActive) {
      healthy++;
      await logHealth({ webhook_type: h.Type, webhook_id: h.ID, was_active: true, reactivated: false });
      continue;
    }
    // Cin7 disabled it → reactivate.
    // GUARDA: o PUT do Cin7 é substituição TOTAL, então reativar com o token
    // vazio apaga o bearer do webhook. O receptor então rejeita tudo com 401
    // (webhook-receiver.js:54), o Cin7 desativa de novo após 6 falhas, e o
    // watchdog reativa de novo — laço infinito que mata o feed tempo-real
    // (≈437 eventos/dia) enquanto grava reactivated:true e sai em verde.
    // Este ramo nunca tinha executado (webhook_health_log: 623 checagens, zero
    // com was_active=false), então o defeito estava armado e não disparado.
    if (!process.env.CIN7_WEBHOOK_TOKEN) {
      console.error(`❌ ${h.Type} está DESATIVADO e CIN7_WEBHOOK_TOKEN não está no ambiente.`);
      console.error('   NÃO vou reativar: o PUT gravaria bearer vazio e o feed morreria em laço.');
      console.error('   Adicione o secret CIN7_WEBHOOK_TOKEN ao workflow e rode de novo.');
      await logHealth({
        webhook_type: h.Type, webhook_id: h.ID, was_active: false,
        reactivated: false, notes: 'NÃO reativado: CIN7_WEBHOOK_TOKEN ausente no ambiente',
      });
      needsToken++;
      continue;
    }
    // PUT is a full replace → resend all fields incl. our bearer token
    const put = await cin7('PUT', '/webhooks', {
      ID: h.ID,
      Type: h.Type,
      IsActive: true,
      ExternalURL: h.ExternalURL,
      ExternalAuthorizationType: h.ExternalAuthorizationType || 'bearerauth',
      ExternalBearerToken: process.env.CIN7_WEBHOOK_TOKEN || '',
    });
    const ok = put.status === 200;
    reactivated += ok ? 1 : 0;
    console.log(`  ${ok ? '✓ reactivated' : '✗ failed to reactivate'} ${h.Type} (${h.ID})`);
    await logHealth({
      webhook_type: h.Type, webhook_id: h.ID, was_active: false,
      reactivated: ok, notes: ok ? 'reactivated by watchdog' : `PUT failed: ${put.status}`,
    });
  }

  // Optional: warn if an expected event has no webhook at all
  const present = new Set(ours.map(h => h.Type));
  const missing = OUR_EVENTS.filter(t => !present.has(t));
  if (missing.length) console.warn(`⚠️  Not registered: ${missing.join(', ')}`);

  console.log(`✅ Watchdog done. healthy=${healthy} reactivated=${reactivated} missing=${missing.length}`);

  // Sair 1 quando havia webhook desativado e não deu para reativar: um watchdog
  // que sai verde enquanto o feed está morto é pior que não ter watchdog.
  if (needsToken) {
    console.error(`❌ ${needsToken} webhook(s) desativado(s) e NÃO reativado(s) por falta de CIN7_WEBHOOK_TOKEN.`);
    process.exit(1);
  }
}

main().catch(e => { console.error('❌ Watchdog crashed:', e); process.exit(1); });
