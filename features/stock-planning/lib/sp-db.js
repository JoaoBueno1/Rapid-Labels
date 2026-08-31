'use strict';
/**
 * Acesso ao Postgres para o módulo Stock Planning / Inventory Management.
 *
 * DOIS transportes, mesma API pública (query/one/tx). O código das rotas não muda:
 *
 *   • pg   — conexão direta com `pg` (precisa de SUPABASE_DB_PASSWORD/SUPABASE_DB_URL).
 *            Usado quando a senha existe. Continua sendo o caminho de quem já funciona.
 *   • rpc  — chama public.sp_exec via PostgREST usando SÓ a SUPABASE_SERVICE_KEY (que toda
 *            máquina já tem). Assim nenhum PC precisa da senha do banco. Requer a migration
 *            028_sp_exec.sql aplicada uma vez no banco compartilhado.
 *
 * O schema rapid_inv não é exposto no PostgREST (origem do 42501), por isso não dá para
 * usar supabase-js direto nas tabelas — o sp_exec (SECURITY DEFINER) é a ponte.
 */
const { Pool, types } = require('pg');

// DATE (1082) volta como string 'YYYY-MM-DD' (no rpc o jsonb já entrega assim). Sem isto o
// driver monta um Date à meia-noite local e em AEST (+10) 2026-08-30 vira 2026-08-29T14:00Z.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));  // NUMERIC → número
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));  // int8 → int

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

let pool = null;

// Config da conexão direta. null quando não há senha/URL de banco.
function pgConfig() {
  if (process.env.SUPABASE_DB_URL) {
    return { connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } };
  }
  const ref = SB_URL.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
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

// 'pg' (senha), 'rpc' (só service key) ou 'none' (sem como falar com o banco).
function mode() {
  if (pgConfig()) return 'pg';
  if (SB_URL && SB_KEY) return 'rpc';
  return 'none';
}

function getPool() {
  if (pool) return pool;
  const cfg = pgConfig();
  if (!cfg) throw new Error('Stock Planning (modo pg): defina SUPABASE_DB_URL, ou SUPABASE_DB_PASSWORD com SUPABASE_URL.');
  pool = new Pool({ ...cfg, max: 6, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[stock-planning] erro no pool:', e.message));
  return pool;
}

// ── transporte rpc (service key) ────────────────────────────────────────
async function rpc(text, params, actor) {
  if (!SB_URL || !SB_KEY) throw new Error('Stock Planning (modo rpc): faltam SUPABASE_URL e SUPABASE_SERVICE_KEY.');
  let resp;
  try {
    resp = await fetch(`${SB_URL}/rest/v1/rpc/sp_exec`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, p: params || [], actor: actor || null }),
    });
  } catch (e) {
    throw new Error('sp_exec: falha de rede ao chamar o banco — ' + e.message);
  }
  const body = await resp.text();
  if (!resp.ok) {
    // Propaga o code do Postgres (ex.: 23505 → 409 na rota) quando o PostgREST manda JSON.
    let err = new Error(`sp_exec HTTP ${resp.status}: ${body.slice(0, 500)}`);
    try {
      const j = JSON.parse(body);
      if (j && j.code) err.code = j.code;
      if (j && j.message) err.message = j.message;
      if (resp.status === 404) err.message =
        'public.sp_exec não existe no banco — rode features/stock-planning/db/028_sp_exec.sql no SQL Editor.';
    } catch (_) {}
    throw err;
  }
  try { return JSON.parse(body); } catch (_) { return []; }  // sp_exec retorna jsonb array
}

// ── API pública ─────────────────────────────────────────────────────────
async function query(text, params, actor) {
  if (mode() === 'pg') return (await getPool().query(text, params)).rows;
  return await rpc(text, params, actor);
}
async function one(text, params, actor) {
  const rows = await query(text, params, actor);
  return rows[0] || null;
}

/**
 * Transação. O actor é registrado (GUC rapid_inv.user_email) antes das escritas para o
 * trigger de auditoria saber quem foi.
 *   • pg  — BEGIN/COMMIT real, várias statements atômicas.
 *   • rpc — só transação de UMA statement (o shim manda ao sp_exec com o actor, uma
 *           statement = uma transação atômica). Multi-statement/lock ainda não é suportado
 *           por aqui: essas rotas viram funções rapid_inv.* na migration 029. O shim
 *           recusa a 2ª statement em vez de gravar pela metade.
 */
async function tx(fn, actor) {
  if (mode() === 'pg') {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      if (actor) await client.query(`SELECT set_config('rapid_inv.user_email', $1, true)`, [actor]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  // rpc mode — single-statement only
  let calls = 0;
  const shim = {
    query: async (text, params) => {
      if (++calls > 1) {
        throw new Error(
          'sp-db.tx: transação com múltiplas statements ainda não roda no transporte por service key. ' +
          'Rode a migration 029 (função rapid_inv dedicada) para este endpoint.');
      }
      return { rows: await rpc(text, params, actor) };
    },
  };
  return await fn(shim);
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

/* Tem como falar com o banco, sem conectar? (pg com senha, ou rpc com service key.) */
function temCredencial() { return mode() !== 'none'; }

module.exports = { getPool, query, one, tx, close, temCredencial, mode };
