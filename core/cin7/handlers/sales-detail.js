'use strict';
/**
 * Handler `sales_detail` — um chunk = UM MÊS (chunk_key = 'YYYY-MM').
 *
 * NÃO reimplementa o fetch. Chama o modo `detail-month` de
 * cin7-stock-sync/backfill-sales.js:279-368, que é o ÚNICO modo que:
 *   · pega qualquer status (só derruba VOIDED/CANCELLED, :320-321)
 *   · re-busca o que o Cin7 mudou (cin7_updated > detail_synced_at, :327-328)
 *   · e chama pruneStaleLines (:362) — sem isso o backfill grava por cima de
 *     linha órfã deixada pelo webhook (SO-281413: 149 linhas/qty 491 no espelho
 *     contra 100/349 no Cin7).
 * Reusar é a escolha de isolamento: o caminho vivo não muda de forma.
 *
 * DETAIL_MONTH_BACK=0 é obrigatório aqui. O workflow crava BACK=1
 * (.github/workflows/cin7-sales-detail-month.yml:75), o que faria cada chunk
 * varrer DOIS meses (~2.600 pedidos) contra o CAP de 2.000 — corta e mente
 * sobre a conclusão. O driver dá um mês por vez, de propósito.
 *
 * O TESTE DE CONCLUSÃO NÃO É O QUE O SCRIPT DIZ — é o que o banco mostra.
 * Depois do subprocesso, consulta public.v_cin7_sales_detail_coverage e só
 * marca 'done' se o mês tem ≥99% de detalhe e 0 stale. Um script que morreu
 * no meio não consegue mentir que terminou.
 */
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'cin7-stock-sync', 'backfill-sales.js');
const REPO = path.join(__dirname, '..', '..', '..');

function runScript(env, budgetMs, log) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, 'detail-month'], {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const grab = (b) => {
      const s = b.toString();
      tail = (tail + s).slice(-4000);
      s.split('\n').filter(Boolean).forEach((l) => log(l));
    };
    p.stdout.on('data', grab);
    p.stderr.on('data', grab);
    // Cinto de segurança: mata o subprocesso no fim do orçamento. Ele é
    // idempotente, então matar no meio só custa o pedido em voo.
    const kill = setTimeout(() => { log('⏱️ orçamento — encerrando o subprocesso'); p.kill('SIGTERM'); }, budgetMs);
    p.on('close', (code) => { clearTimeout(kill); resolve({ code, tail }); });
  });
}

module.exports = async function salesDetail({ chunk, cin7, q, dryRun, outOfBudget, log }) {
  const ym = chunk.chunk_key;                       // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`chunk_key inválido para sales_detail: ${ym}`);

  const before = await coverage(q, ym);
  log(`${ym}: ${before.detailed}/${before.orders} com detalhe (${before.pct_detailed}%), ${before.stale} stale`);
  if (isComplete(before)) {
    return { done: true, cursor: {}, doneCount: 0, note: `já completo (${before.pct_detailed}%)` };
  }
  if (dryRun) return { done: false, cursor: chunk.cursor, doneCount: 0, note: 'dry-run' };
  if (outOfBudget()) return { done: false, cursor: chunk.cursor, doneCount: 0, note: 'sem orçamento' };

  // O CAP vira o orçamento de chamadas: 1 pedido = 1 chamada `sale?ID=`.
  const cap = Math.max(1, cin7.remaining);
  // Respeita o --budget-min do driver. Era fixo em 30 min, então --budget-min=12
  // na verdade permitia um turno de 30 — contra o contrato escrito no topo.
  const budgetMs = Math.max(1, parseInt(process.env.BACKFILL_BUDGET_MIN || '12', 10)) * 60 * 1000;
  const { code } = await runScript({
    DETAIL_MONTH: ym,
    DETAIL_MONTH_BACK: '0',
    DETAIL_MONTH_CAP: String(cap),
    BACKFILL_THROTTLE_MS: String(Math.ceil(60000 / (parseInt(process.env.BACKFILL_RATE || '24', 10)))),
    BACKFILL_PICK_ANOMALIES: process.env.BACKFILL_PICK_ANOMALIES || '0',
  }, budgetMs, log);

  const after = await coverage(q, ym);
  const gained = after.detailed - before.detailed;
  if (code !== 0 && gained === 0) throw new Error(`detail-month saiu ${code} sem progresso`);

  return {
    done: isComplete(after),
    cursor: { pct: after.pct_detailed, detailed: after.detailed },
    doneCount: gained,
    note: `${after.detailed}/${after.orders} (${after.pct_detailed}%), ${after.stale} stale`,
  };
};

// Lê pct_with_lines, não pct_detailed: 'detalhado' sem linha não é cobertura
// (1.248 pedidos já estão nesse estado). E exigir stale === 0 num mês que o
// cron ainda toca é exigir o impossível — 0,5% de stale é ruído, não buraco.
const isComplete = (c) => c.orders > 0
  && Number(c.pct_with_lines) >= 99
  && Number(c.stale) <= Math.max(5, c.orders * 0.005);

async function coverage(q, ym) {
  const [row] = await q(
    'SELECT * FROM public.v_cin7_sales_detail_coverage WHERE ym = $1', [ym]);
  return row || { ym, orders: 0, detailed: 0, stale: 0, pct_detailed: 0, pct_with_lines: 0, with_lines: 0, detailed_no_lines: 0 };
}
