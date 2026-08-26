#!/usr/bin/env node
'use strict';
/**
 * core/cin7/backfill-driver.js — o backfill que se lembra sozinho.
 *
 * Contrato, em uma frase: LÊ ops.cin7_sync_state, PEGA um chunk com lease,
 * processa UM chunk até o orçamento acabar, GRAVA o progresso, SAI.
 *
 * Nunca roda mais que --budget-min minutos (default 12). Nunca gasta mais que
 * --max-calls chamadas. Idempotente: todo write é upsert em chave natural e o
 * cursor só avança DEPOIS do write. Rodar duas vezes não duplica nada.
 *
 * Serve os três chamadores sem mudar de forma:
 *   cron    → node core/cin7/backfill-driver.js run --budget-min=12
 *   humano  → node core/cin7/backfill-driver.js status
 *   agente  → node core/cin7/backfill-driver.js status --json   (10 linhas)
 *
 * Fala com o Postgres por `pg`, não por PostgREST: o schema `ops` não é
 * exposto pela API (por isso features/excel-sync/db/002_excel_sync.sql:100
 * precisou de RPC SECURITY DEFINER), e o claim atômico com SKIP LOCKED não
 * existe em PostgREST. Mesmo padrão de conexão de features/stock-planning/
 * lib/sp-db.js:24-37. `pg` JÁ é dependência (package.json:"pg":"^8.18.0"),
 * então package.json NÃO é tocado e os 15 workflows com `npm ci` não correm
 * risco (CLAUDE.md).
 *
 * Códigos de saída — é assim que o cron e o loop da IA decidem:
 *   0  progrediu, ou não havia nada a fazer  → chame de novo
 *   3  o chunk falhou de forma retentável    → chame de novo (attempts++)
 *   4  há chunk BLOCKED, precisa de humano   → NÃO chame de novo, avise
 *   2  fatal (credencial, banco fora)        → NÃO chame de novo, avise
 */
require('dotenv').config();
const { Pool, types } = require('pg');
const { makeClient } = require('./cin7-client');
const HANDLERS = require('./handlers');

// DATE volta como string. Sem isto, em AEST (+10) 2026-08-30 vira 2026-08-29T14:00Z.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) || 'status';
const flag = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};
const num = (k, d) => { const v = flag(k, null); return v === null ? d : parseInt(v, 10); };

const OPT = {
  job:       flag('job', null),
  chunk:     flag('chunk', null),
  budgetMin: num('budget-min', 12),
  ratePerMin: num('rate', 24),          // 24/min = 2500ms, o valor já provado em produção
  maxCalls:  num('max-calls', 0),       // 0 = derivado de budget-min × rate
  leaseMin:  num('lease-min', 0),       // 0 = budget-min + 8 de folga
  json:      !!flag('json', false),
  dryRun:    !!flag('dry-run', false),
};
if (!OPT.maxCalls) OPT.maxCalls = Math.max(1, Math.floor(OPT.budgetMin * OPT.ratePerMin));
if (!OPT.leaseMin) OPT.leaseMin = OPT.budgetMin + 8;
const THROTTLE_MS = Math.ceil(60000 / OPT.ratePerMin);

const OWNER = process.env.BACKFILL_OWNER
  || `${process.env.GITHUB_RUN_ID ? 'gha' : require('os').hostname()}:${process.pid}`;

// ─────────────────────────────────────────────────────────────────────────────
// Banco
// ─────────────────────────────────────────────────────────────────────────────
function dbConfig() {
  if (process.env.SUPABASE_DB_URL) {
    return { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } };
  }
  const ref = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!ref || !process.env.SUPABASE_DB_PASSWORD) return null;
  return {
    host: process.env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-2.pooler.supabase.com',
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: 'postgres',
    user: `postgres.${ref[1]}`,
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  };
}
let pool = null;
function db() {
  if (pool) return pool;
  const cfg = dbConfig();
  if (!cfg) die(2, 'faltam credenciais do banco (SUPABASE_DB_URL ou SUPABASE_DB_PASSWORD+SUPABASE_URL)');
  pool = new Pool({ ...cfg, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[backfill] pool:', e.message));
  return pool;
}
const q = async (text, params) => (await db().query(text, params)).rows;

function die(code, msg) {
  if (OPT.json) console.log(JSON.stringify({ ok: false, exit: code, error: msg }));
  else console.error(`❌ ${msg}`);
  process.exit(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// status — a leitura barata. É ISTO que o loop da IA chama.
// ─────────────────────────────────────────────────────────────────────────────
async function cmdStatus() {
  const jobs = await q('SELECT * FROM public.v_cin7_backfill_status');
  const [{ n: blocked }] = await q(
    `SELECT count(*)::int AS n FROM ops.cin7_sync_state WHERE status='blocked'`);
  const recent = await q(
    `SELECT job, chunk_key, outcome, calls, rows_written, message, at
       FROM ops.cin7_sync_log ORDER BY at DESC LIMIT 3`);
  const totals = jobs.reduce((a, j) => ({
    chunks: a.chunks + Number(j.chunks), done: a.done + Number(j.done),
    todo: a.todo + Number(j.todo), calls: a.calls + Number(j.calls_used || 0),
    rows: a.rows + Number(j.rows_done || 0),
  }), { chunks: 0, done: 0, todo: 0, calls: 0, rows: 0 });

  if (OPT.json) {
    console.log(JSON.stringify({
      ok: true, blocked, totals,
      jobs: jobs.map((j) => ({
        job: j.job, pct: Number(j.pct), done: Number(j.done), todo: Number(j.todo),
        blocked: Number(j.blocked), next: j.next_chunk, problem: j.last_problem,
      })),
      last: recent.map((r) => `${r.job}/${r.chunk_key} ${r.outcome} ${r.message || ''}`.trim()),
    }));
    return blocked > 0 ? 4 : 0;
  }

  console.log(`\nBACKFILL  ${totals.done}/${totals.chunks} chunks · ${totals.rows} linhas · ${totals.calls} chamadas Cin7`);
  console.log('─'.repeat(76));
  for (const j of jobs) {
    const bar = '█'.repeat(Math.round(Number(j.pct || 0) / 5)).padEnd(20, '·');
    console.log(
      `${String(j.job).padEnd(16)} ${bar} ${String(j.pct ?? 0).padStart(5)}%  ` +
      `todo=${String(j.todo).padStart(3)}${Number(j.blocked) ? ` BLOCKED=${j.blocked}` : ''}` +
      `${j.next_chunk ? `  próximo=${j.next_chunk}` : ''}`);
    if (j.last_problem) console.log(`${' '.repeat(17)}⚠️  ${j.last_problem}`);
  }
  console.log('─'.repeat(76));
  recent.forEach((r) => console.log(`  ${r.at.toISOString().slice(5, 16)}  ${r.job || '-'}/${r.chunk_key || '-'}  ${r.outcome}  ${r.message || ''}`));
  return blocked > 0 ? 4 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// run — UM chunk, e sai.
// ─────────────────────────────────────────────────────────────────────────────
async function cmdRun() {
  const t0 = Date.now();
  await q('SELECT public.cin7_block_exhausted()');

  const [chunk] = await q(
    'SELECT * FROM public.cin7_claim_chunk($1, $2, $3)',
    [OWNER, OPT.leaseMin, OPT.job]);

  if (!chunk) {
    const [{ n }] = await q(`SELECT count(*)::int AS n FROM ops.cin7_sync_state WHERE status='blocked'`);
    await log(null, null, n ? 'blocked' : 'idle', 0, 0, Date.now() - t0,
      n ? `${n} chunk(s) bloqueado(s) — precisa de humano` : 'nada pendente');
    console.log(n ? `⛔ nada elegível; ${n} chunk(s) BLOCKED` : '✅ nada pendente — backfill em dia');
    return n ? 4 : 0;
  }

  const handler = HANDLERS[chunk.job];
  if (!handler) {
    await finish(chunk, 'blocked', chunk.cursor, 0, 0, `sem handler para job '${chunk.job}'`);
    return 4;
  }

  console.log(`▶ ${chunk.job}/${chunk.chunk_key}  (tentativa ${chunk.attempts}, ` +
    `orçamento ${OPT.budgetMin}min / ${OPT.maxCalls} chamadas @ ${OPT.ratePerMin}/min)`);

  const deadline = Date.now() + OPT.budgetMin * 60000;
  const cin7 = makeClient({ throttleMs: THROTTLE_MS, maxCalls: OPT.maxCalls });

  // Heartbeat: renova o lease enquanto o chunk anda, para que um chunk lento
  // não seja roubado por outro runner no meio do trabalho.
  const beat = setInterval(() => {
    q(`UPDATE ops.cin7_sync_state
          SET lease_until = now() + make_interval(mins => $3)
        WHERE job=$1 AND chunk_key=$2`, [chunk.job, chunk.chunk_key, OPT.leaseMin])
      .catch(() => {});
  }, 60000);
  beat.unref?.();

  let out;
  try {
    out = await handler({
      chunk,
      cursor: chunk.cursor || {},
      cin7,
      q,
      dryRun: OPT.dryRun,
      // O handler consulta isto antes de cada unidade de trabalho. É o que
      // garante "nunca mais que N minutos" mesmo com um chunk de 2.000 pedidos.
      outOfBudget: () => Date.now() > deadline || cin7.remaining <= 0,
      log: (m) => console.log(`   ${m}`),
    });
  } catch (e) {
    clearInterval(beat);
    // BUDGET não é falha: é o fim educado do turno.
    if (e.code === 'BUDGET') {
      await finish(chunk, 'pending', e.cursor || chunk.cursor, e.doneCount || 0, cin7.calls,
        null, Date.now() - t0, 'orçamento de chamadas — retomando no próximo run');
      console.log(`⏸  orçamento esgotado (${cin7.calls} chamadas) — chunk devolvido à fila`);
      return 0;
    }
    await finish(chunk, 'failed', chunk.cursor, 0, cin7.calls, e.message, Date.now() - t0);
    console.error(`✗ ${chunk.job}/${chunk.chunk_key}: ${e.message}`);
    return 3;
  }
  clearInterval(beat);

  const status = out.done ? 'done' : 'pending';
  await finish(chunk, status, out.cursor || {}, out.doneCount || 0, cin7.calls,
    null, Date.now() - t0, out.note);
  console.log(out.done
    ? `✅ ${chunk.job}/${chunk.chunk_key} CONCLUÍDO — ${out.doneCount} un., ${cin7.calls} chamadas, ${Math.round((Date.now() - t0) / 1000)}s`
    : `⏸  ${chunk.job}/${chunk.chunk_key} parcial — ${out.doneCount} un., ${cin7.calls} chamadas; retoma em ${JSON.stringify(out.cursor)}`);
  return 0;
}

// Grava o progresso. O cursor SEMPRE avança depois do write do handler, nunca antes.
async function finish(chunk, status, cursor, doneCount, calls, error, ms, note) {
  await q(
    `UPDATE ops.cin7_sync_state
        SET status      = $3,
            cursor      = $4::jsonb,
            done_count  = done_count + $5,
            calls_used  = calls_used + $6,
            last_error  = $7,
            notes       = COALESCE($8, notes),
            lease_owner = NULL,
            lease_until = NULL,
            finished_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END,
            -- um turno que PROGREDIU não gasta tentativa: só falha gasta.
            attempts    = CASE WHEN $3 IN ('done','pending') THEN GREATEST(attempts - 1, 0)
                               ELSE attempts END
      WHERE job = $1 AND chunk_key = $2`,
    [chunk.job, chunk.chunk_key, status, JSON.stringify(cursor || {}),
     doneCount || 0, calls || 0, error, note || null]);
  await log(chunk.job, chunk.chunk_key,
    status === 'done' ? 'complete' : status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : 'progress',
    calls, doneCount, ms, error || note);
}

async function log(job, chunkKey, outcome, calls, rows, ms, message) {
  await q(
    `INSERT INTO ops.cin7_sync_log (job, chunk_key, outcome, calls, rows_written, duration_ms, owner, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [job, chunkKey, outcome, calls || 0, rows || 0, ms || null, OWNER, message ? String(message).slice(0, 500) : null]);
}

// ─────────────────────────────────────────────────────────────────────────────
// reset — devolve um chunk (ou um job) à fila. É o botão do humano.
// ─────────────────────────────────────────────────────────────────────────────
async function cmdReset() {
  if (!OPT.job) die(2, 'reset exige --job=<job> (e opcionalmente --chunk=<chave>)');
  const rows = await q(
    `UPDATE ops.cin7_sync_state
        SET status='pending', attempts=0, lease_owner=NULL, lease_until=NULL, last_error=NULL
      WHERE job=$1 AND ($2::text IS NULL OR chunk_key=$2)
        AND ($3 OR status <> 'done')
      RETURNING job, chunk_key`,
    [OPT.job, OPT.chunk, !!flag('include-done', false)]);
  console.log(`↺ ${rows.length} chunk(s) devolvidos à fila: ${rows.map((r) => r.chunk_key).join(', ') || '-'}`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// verify — a prova de que terminou. Conta o DADO, não o checkpoint.
// ─────────────────────────────────────────────────────────────────────────────
async function cmdVerify() {
  const cov = await q('SELECT * FROM public.v_cin7_sales_detail_coverage');
  const bad = cov.filter((r) => r.verdict !== 'OK');
  if (OPT.json) {
    console.log(JSON.stringify({ ok: bad.length === 0, months: cov.length, failing: bad }));
  } else {
    console.log('\nmês      pedidos  detalhe  linhas   %det   %lin  veredito');
    cov.forEach((r) => console.log(
      `${r.ym}  ${String(r.orders).padStart(7)}  ${String(r.detailed).padStart(7)}  ` +
      `${String(r.with_lines).padStart(6)}  ${String(r.pct_detailed).padStart(5)}  ` +
      `${String(r.pct_with_lines).padStart(5)}  ${r.verdict}${r.stale ? ` (${r.stale} stale)` : ''}`));
  }
  return bad.length ? 3 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  let code = 0;
  try {
    if (cmd === 'run') code = await cmdRun();
    else if (cmd === 'status') code = await cmdStatus();
    else if (cmd === 'reset') code = await cmdReset();
    else if (cmd === 'verify') code = await cmdVerify();
    else { console.log('uso: backfill-driver.js run|status|reset|verify [--job=] [--chunk=] [--budget-min=12] [--rate=24] [--json] [--dry-run]'); code = 2; }
  } catch (e) {
    try { await log(OPT.job, OPT.chunk, 'fatal', 0, 0, null, e.message); } catch { /* banco fora */ }
    die(2, e.message);
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
  process.exit(code);
})();
