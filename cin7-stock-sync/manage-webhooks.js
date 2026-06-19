#!/usr/bin/env node
/**
 * Cin7 Core — Webhook management CLI (Rapid Labels)
 * ================================================================
 * Lets us register OUR OWN webhooks alongside any existing ones
 * (e.g. the n8n `Customer/Updated` from another system) WITHOUT
 * touching them. Each webhook is an independent record (own ID);
 * Cin7 allows up to 5 of the same Type, and our Types differ anyway.
 *
 * SAFE by default:
 *   - `list`     → read-only (GET /webhooks)
 *   - `register` → creates our set as INACTIVE (IsActive=false → Cin7
 *                  never calls them, zero deliveries) unless --activate
 *   - `activate` / `deactivate` / `delete` → explicit, one ID at a time
 *
 * Prereq for going live: a PUBLIC HTTPS URL that stays up. If a webhook
 * is active and the endpoint fails 6 delivery attempts (~75 min), Cin7
 * AUTO-DEACTIVATES it (that's why the existing n8n one is inactive).
 *
 * Usage:
 *   node cin7-stock-sync/manage-webhooks.js list
 *   node cin7-stock-sync/manage-webhooks.js register --url https://host/api/cin7/webhook
 *   node cin7-stock-sync/manage-webhooks.js register --url https://host/api/cin7/webhook --activate
 *   node cin7-stock-sync/manage-webhooks.js activate   --id <guid>
 *   node cin7-stock-sync/manage-webhooks.js deactivate --id <guid>
 *   node cin7-stock-sync/manage-webhooks.js delete     --id <guid>
 *
 * Env: CIN7_ACCOUNT_ID, CIN7_API_KEY, and optionally CIN7_WEBHOOK_TOKEN
 * (bearer token Cin7 will send to our receiver so we can verify it's Cin7).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── load .env (no dependency) ──
(() => {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
})();

const ACC = process.env.CIN7_ACCOUNT_ID;
const KEY = process.env.CIN7_API_KEY;
const TOKEN = process.env.CIN7_WEBHOOK_TOKEN || 'CHANGE-ME-set-CIN7_WEBHOOK_TOKEN';
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';

if (!ACC || !KEY) { console.error('Missing CIN7_ACCOUNT_ID / CIN7_API_KEY'); process.exit(1); }

// ── the events WE want — single source of truth in webhook-config.js ──
const { OUR_EVENTS } = require('./webhook-config');

function req(method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + urlPath);
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

async function list() {
  const { status, body } = await req('GET', '/webhooks');
  if (status !== 200) { console.error('GET /webhooks failed:', status, body); return []; }
  const hooks = body.Webhooks || [];
  console.log(`\n${hooks.length} webhook(s) registered:\n`);
  for (const h of hooks) {
    console.log(`  • ${h.Type.padEnd(34)} active=${String(h.IsActive).padEnd(5)} id=${h.ID}`);
    console.log(`      → ${h.ExternalURL}`);
  }
  console.log('');
  return hooks;
}

async function register(url, activate) {
  if (!url) { console.error('--url <public https endpoint> is required'); process.exit(1); }
  const existing = await req('GET', '/webhooks');
  const have = new Set((existing.body.Webhooks || []).map((h) => h.Type));
  console.log(`\nRegistering ${OUR_EVENTS.length} webhook(s) → ${url}`);
  console.log(`IsActive = ${activate ? 'TRUE (live!)' : 'false (staged — activate later)'}\n`);
  for (const type of OUR_EVENTS) {
    if (have.has(type)) { console.log(`  ↷ ${type} already exists — skipped (won't duplicate)`); continue; }
    const { status, body } = await req('POST', '/webhooks', {
      Type: type,
      IsActive: !!activate,
      ExternalURL: url,
      ExternalAuthorizationType: 'bearerauth',
      ExternalBearerToken: TOKEN,
    });
    console.log(`  ${status === 200 ? '✓' : '✗ ' + status} ${type}` +
      (status !== 200 ? `  ${JSON.stringify(body).slice(0, 160)}` : ''));
  }
  await list();
}

async function setActive(id, active) {
  if (!id) { console.error('--id <guid> required'); process.exit(1); }
  // Cin7 PUT is a FULL replace → fetch current and resend every field.
  // The GET returns an empty ExternalBearerToken, so we MUST resend ours
  // (otherwise the bearer secret would be wiped).
  const cur = await req('GET', '/webhooks');
  const hook = ((cur.body && cur.body.Webhooks) || []).find(h => h.ID === id);
  if (!hook) { console.error(`webhook ${id} not found`); process.exit(1); }
  const { status, body } = await req('PUT', '/webhooks', {
    ID: id,
    Type: hook.Type,
    IsActive: active,
    ExternalURL: hook.ExternalURL,
    ExternalAuthorizationType: hook.ExternalAuthorizationType || 'bearerauth',
    ExternalBearerToken: TOKEN,
  });
  console.log(`PUT (IsActive=${active}) ${hook.Type} → ${status}`, status !== 200 ? body : 'OK');
}

async function del(id) {
  if (!id) { console.error('--id <guid> required'); process.exit(1); }
  const { status, body } = await req('DELETE', `/webhooks?ID=${encodeURIComponent(id)}`);
  console.log(`DELETE ${id} → ${status}`, status !== 200 ? body : 'OK');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Activate every OUR_EVENTS webhook that's registered but inactive (gentle:
// spaced PUTs so we don't burst the Cin7 rate limit). Skips already-active ones.
async function activateAll() {
  const cur = await req('GET', '/webhooks');
  const hooks = (cur.body && cur.body.Webhooks) || [];
  const todo = hooks.filter(h => OUR_EVENTS.includes(h.Type) && !h.IsActive);
  console.log(`Activating ${todo.length} webhook(s) (of ${OUR_EVENTS.length} ours):\n`);
  for (const h of todo) {
    const { status, body } = await req('PUT', '/webhooks', {
      ID: h.ID, Type: h.Type, IsActive: true, ExternalURL: h.ExternalURL,
      ExternalAuthorizationType: h.ExternalAuthorizationType || 'bearerauth',
      ExternalBearerToken: TOKEN,
    });
    console.log(`  ${status === 200 ? '✓' : '✗ ' + status} ${h.Type}` + (status !== 200 ? `  ${JSON.stringify(body).slice(0, 120)}` : ''));
    await sleep(2500); // gentle: stay well under the 60/min cap
  }
  await list();
}

// ── CLI ──
const [cmd] = process.argv.slice(2);
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const flag = (name) => process.argv.includes(name);

(async () => {
  switch (cmd) {
    case 'list': await list(); break;
    case 'register': await register(arg('--url'), flag('--activate')); break;
    case 'activate': await setActive(arg('--id'), true); break;
    case 'activate-all': await activateAll(); break;
    case 'deactivate': await setActive(arg('--id'), false); break;
    case 'delete': await del(arg('--id')); break;
    default:
      console.log('Commands: list | register --url <https> [--activate] | activate-all | activate --id <guid> | deactivate --id <guid> | delete --id <guid>');
  }
})();
