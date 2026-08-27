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

const WITH_TR  = process.argv.includes('--with-tr');
const WITH_ASM = process.argv.includes('--with-asm');   // 7.831 chamadas / 5,4 h — fora do núcleo
const SHOW = process.argv.includes('--show');

// Faixas de página medidas em 2026-08-26 contra a API (Limit=500).
// Re-meça com `?Page=1&Limit=1` (devolve Total) antes de rodar — é 1 chamada.
const PAGES = {
  po_detail:  { from: 1,  to: 10, note: 'purchaseList?UpdatedSince=2025-08-01 → Total 4.943' },
  adj_detail: { from: 19, to: 26, note: 'stockAdjustmentList Total 12.732, corte 2025-08 no índice ~9.250 (lista oldest-first)' },
  asm_detail: { from: 38, to: 53, note: 'finishedGoodsList Total 26.315, corte no índice ~18.700 (oldest-first)' },
  tr_detail:  { from: 1,  to: 67, note: 'stockTransferList Total 50.089, newest-first, corte 2025-08 no índice ~33.100' },
};

// O último mês FECHADO. Nunca semeia o mês corrente — ver o comentário no add().
function lastClosedMonth() {
  const n = new Date();
  const y = n.getUTCFullYear(); const m = n.getUTCMonth();   // 0-based = mês anterior em 1-based
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

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
// target é o TOTAL do job; cada chunk leva a sua fatia. Gravar o total em cada
// chunk fazia a view de progresso somar N× o alvo — um job 2/2 concluído
// reportava 50%, e um de 13 chunks nunca passava de 7,7%.
const add = (job, keys, total) => keys.forEach((k, i) => PLAN.push({
  job, chunk_key: k, seq: ++seq,
  target_count: Math.floor(total / keys.length) + (i < total % keys.length ? 1 : 0),
}));

// ── ORDEM. seq menor roda primeiro. É o grafo de dependência, materializado. ──
// 1) COMPRAS — 10 páginas, ~4.953 chamadas. Melhor retorno por chamada do repo:
//    destrava on-order com PO/fornecedor/ETA, is_received e lead time medido.
add('po_detail', bands('po_detail'), 4943);
// 2) VENDAS — o buraco principal. Do mais recente para o mais antigo: se o fim
//    de semana acabar no meio, o que ficou de fora é o passado distante, não a
//    janela que o Stock Planning usa toda semana.
// O mês CORRENTE fica de fora: ele enche sozinho enquanto o dreno roda
// (pedido novo + cin7-sales-sync reescrevendo cin7_updated a cada 2 h), então
// isComplete nunca é satisfeito, o chunk nunca fecha e — por ter o menor seq
// entre as vendas — trava a fila inteira. O mês corrente é trabalho do cron.
add('sales_detail', months('2025-08', lastClosedMonth()).reverse(), 62432);
// 3) AJUSTES — 3.482 chamadas. Sem eles nenhuma reconstrução de saldo fecha.
add('adj_detail', bands('adj_detail'), 3732);
// 4) MONTAGENS — 7.831 chamadas / 5,4 h. FORA do núcleo por decisão de escopo:
//    o núcleo sem ela é 49,4 h numa janela de 58 h (17% de folga); com ela são
//    54,8 h (5,8%). O BOM já tem fallback ao vivo em wms-engine.js:315-325.
if (WITH_ASM) add('asm_detail', bands('asm_detail'), 7831);
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
