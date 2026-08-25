'use strict';
/**
 * Acesso ao Postgres para o módulo Stock Planning.
 *
 * Vai direto no banco com `pg` em vez de passar pelo PostgREST porque o
 * schema rapid_inv não é exposto pela API (é a origem do 42501 que deixou
 * o módulo anterior dormente por dois meses). Conexão direta não depende
 * de "Exposed schemas" no painel do Supabase.
 */
const { Pool, types } = require('pg');

// DATE (OID 1082) volta como string 'YYYY-MM-DD'. Sem isto o driver constrói
// um Date na meia-noite local e, em AEST (+10), 2026-08-30 vira 2026-08-29T14:00Z.
// Já existe esse estrago em dados antigos deste repo.
types.setTypeParser(1082, (v) => v);
// NUMERIC (1700) volta como número. Volumes aqui são de estoque, não de dinheiro
// com centavos críticos, e a UI precisa somar.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8

let pool = null;

function config() {
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

function getPool() {
  if (pool) return pool;
  const cfg = config();
  if (!cfg) {
    throw new Error(
      'Stock Planning: faltam credenciais do banco. Defina SUPABASE_DB_URL, ' +
      'ou SUPABASE_DB_PASSWORD junto com SUPABASE_URL.'
    );
  }
  pool = new Pool({ ...cfg, max: 6, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[stock-planning] erro no pool:', e.message));
  return pool;
}

async function query(text, params) {
  const res = await getPool().query(text, params);
  return res.rows;
}

async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

/**
 * Transação. O usuário é registrado antes de qualquer escrita para que o
 * trigger de auditoria saiba quem foi — hoje o app grava 'dashboard'/'4209'
 * em tudo, o que não responde nada.
 */
async function tx(fn, actor) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (actor) {
      await client.query('SELECT set_config($1, $2, true)', ['rapid_inv.audit_user', actor]);
      try {
        await client.query('SELECT rapid_inv.set_audit_user($1, $2)', [actor, null]);
      } catch (_) { /* a função pode não existir em bases antigas */ }
    }
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

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, query, one, tx, close };
