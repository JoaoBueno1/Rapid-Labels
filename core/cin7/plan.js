#!/usr/bin/env node
'use strict';
/**
 * core/cin7/plan.js — semeia ops.cin7_sync_state com os chunks do backfill.
 *
 * Idempotente: ON CONFLICT DO NOTHING. Rodar de novo NÃO reabre chunk concluído.
 * O `seq` é a ordem de execução — é aqui que a dependência entre recursos vira
 * dado, para o driver não precisar saber nada sobre o grafo.
 *
 *   node core/cin7/plan.js            # semeia o núcleo (cabe no fim de semana)
 *   node core/cin7/plan.js --with-tr  # inclui as linhas de transferência (23 h)
 *   node core/cin7/plan.js --show     # só imprime o plano
 */
require('dotenv').config();
const { Pool } = require('pg');

const WITH_TR = process.argv.includes('--with-tr');
const SHOW = process.argv.includes('--show');

// Faixas de página medidas em 2026-08-26 contra a API (Limit=500).
// Re-meça com `?Page=1&Limit=1` (devolve Total) antes de rodar — é 1 chamada.
const PAGES = {
  po_detail:  { from: 1,  to: 10, note: 'purchaseList?UpdatedSince=2025-08-01 → Total 4.943' },
  adj_detail: { from: 19, to: 26, note: 'stockAdjustmentList Total 12.732, corte 2025-08 no índice ~9.250 (lista oldest-first)' },
  asm_detail: { from: 38, to: 53, note: 'finishedGoodsList Total 26.315, corte no índice ~18.700 (oldest-first)' },
  tr_detail:  { from: 1,  to: 67, note: 'stockTransferList Total 50.089, newest-first, corte 2025-08 no índice ~33.100' },
};

function months(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// Bandas de 8 páginas: ~4.000 tasks por chunk é grande demais para um turno de
// 12 min, mas o cursor {page,idx} retoma dentro do chunk. A banda existe para
// dar granularidade de RELATÓRIO e de reset, não de turno.
function bands(job, size = 8) {
  const { from, to } = PAGES[job];
  const out = [];
  for (let p = from; p <= to; p += size) {
    out.push(`p${String(p).padStart(4, '0')}-${String(Math.min(p + size - 1, to)).padStart(4, '0')}`);
  }
  return out;
}

const PLAN = [];
let seq = 0;
const add = (job, keys, target) => keys.forEach((k) => PLAN.push({ job, chunk_key: k, seq: ++seq, target_count: target }));

// ── ORDEM. seq menor roda primeiro. É o grafo de dependência, materializado. ──
// 1) COMPRAS — 10 páginas, ~4.953 chamadas. Melhor retorno por chamada do repo:
//    destrava on-order com PO/fornecedor/ETA, is_received e lead time medido.
add('po_detail', bands('po_detail'), 4943);
// 2) VENDAS — o buraco principal. Do mais recente para o mais antigo: se o fim
//    de semana acabar no meio, o que ficou de fora é o passado distante, não a
//    janela que o Stock Planning usa toda semana.
add('sales_detail', months('2025-08', '2026-08').reverse(), 1300);
// 3) AJUSTES — 3.482 chamadas. Sem eles nenhuma reconstrução de saldo fecha.
add('adj_detail', bands('adj_detail'), 3482);
// 4) MONTAGENS — 7.615. Traz assembly_consume E a receita (BOM), de graça.
add('asm_detail', bands('asm_detail'), 7615);
// 5) LINHAS DE TRANSFERÊNCIA — 33.100 chamadas / 23 h. NÃO cabe no fim de
//    semana e é o dado de menor valor. Vira dreno de fundo (--with-tr).
if (WITH_TR) add('tr_detail', bands('tr_detail'), 33100);

(async () => {
  if (SHOW) {
    PLAN.forEach((p) => console.log(`${String(p.seq).padStart(3)}  ${p.job.padEnd(13)} ${p.chunk_key}`));
    console.log(`\n${PLAN.length} chunks`);
    return process.exit(0);
  }
  const url = process.env.SUPABASE_DB_URL;
  const ref = (process.env.SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  const pool = new Pool(url ? { connectionString: url, ssl: { rejectUnauthorized: false } } : {
    host: process.env.SUPABASE_DB_HOST || 'aws-0-ap-southeast-2.pooler.supabase.com',
    port: Number(process.env.SUPABASE_DB_PORT || 5432), database: 'postgres',
    user: `postgres.${ref && ref[1]}`, password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  let ins = 0;
  for (const p of PLAN) {
    const r = await pool.query(
      `INSERT INTO ops.cin7_sync_state (job, chunk_key, seq, target_count)
       VALUES ($1,$2,$3,$4) ON CONFLICT (job, chunk_key) DO NOTHING`,
      [p.job, p.chunk_key, p.seq, p.target_count]);
    ins += r.rowCount;
  }
  const { rows } = await pool.query('SELECT * FROM public.v_cin7_backfill_status');
  console.log(`✅ plano semeado — ${ins} chunk(s) novo(s), ${PLAN.length} no total`);
  rows.forEach((r) => console.log(`   ${r.job.padEnd(13)} ${r.done}/${r.chunks}  próximo=${r.next_chunk || '-'}`));
  await pool.end();
})().catch((e) => { console.error('❌', e.message); process.exit(2); });
