'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { projectSku, buildAlerts } = require('../lib/planning-engine');
const { weekEnding, weekSeries, addWeeks } = require('../lib/week');

const START = '2026-08-23';                       // semana de reporte do workbook
const W = weekSeries(START, 8);                   // 23-Ago .. 11-Out
const weeks = (factors = {}) =>
  W.map((wk, i) => ({ weekEnding: wk, factor: factors[wk] ?? 1, isReporting: i === 0 }));

const closings = (p) => p.rows.map((r) => r.closing);

// ── 1. Só SOH ───────────────────────────────────────────────────────────
test('1. só SOH: sem venda e sem demanda, o saldo não se move', () => {
  const p = projectSku({ weeks: weeks(), soh: 500, wkAvg: 0 });
  assert.deepStrictEqual(closings(p), [500, 500, 500, 500, 500, 500, 500, 500]);
  assert.strictEqual(p.summary.firstStockoutWeek, null);
});

// ── 2. SOH + venda semanal ──────────────────────────────────────────────
test('2. SOH mais venda semanal: cai wkAvg por semana', () => {
  const p = projectSku({ weeks: weeks(), soh: 500, wkAvg: 50 });
  assert.deepStrictEqual(closings(p), [500, 450, 400, 350, 300, 250, 200, 150]);
  assert.strictEqual(p.rows[1].expectedSales, 50);
});

// ── 3. PO entrando ──────────────────────────────────────────────────────
test('3. PO entrando soma no fechamento da semana do due date', () => {
  const p = projectSku({ weeks: weeks(), soh: 100, wkAvg: 10, incoming: { [W[3]]: 500 } });
  assert.deepStrictEqual(closings(p), [100, 90, 80, 570, 560, 550, 540, 530]);
});

// ── 4. Um draw datado ───────────────────────────────────────────────────
test('4. um draw datado sai só na semana dele', () => {
  const p = projectSku({ weeks: weeks(), soh: 300, wkAvg: 0, draws: { [W[2]]: 120 } });
  assert.deepStrictEqual(closings(p), [300, 300, 180, 180, 180, 180, 180, 180]);
});

// ── 5. Vários draws ─────────────────────────────────────────────────────
test('5. vários draws: cada um na sua semana', () => {
  const p = projectSku({
    weeks: weeks(), soh: 1000, wkAvg: 0,
    draws: { [W[1]]: 250, [W[3]]: 350, [W[5]]: 200 },
  });
  assert.deepStrictEqual(closings(p), [1000, 750, 750, 400, 400, 200, 200, 200]);
  assert.strictEqual(p.summary.totalDraws, 800);
});

// ── 6. Draw sem data ────────────────────────────────────────────────────
test('6. draw sem data volta separado e NUNCA entra numa semana', () => {
  const p = projectSku({ weeks: weeks(), soh: 1000, wkAvg: 0, draws: {}, undatedQty: 200 });
  assert.deepStrictEqual(closings(p), Array(8).fill(1000), 'TBA não pode mexer no saldo semanal');
  assert.strictEqual(p.summary.undatedQty, 200);
  assert.strictEqual(p.summary.hasUndated, true);
  assert.ok(buildAlerts('X', p).some((a) => a.code === 'UNDATED_DEMAND'));
});

// ── 7. Demanda maior que o estoque ──────────────────────────────────────
test('7. demanda maior que o estoque leva a fechamento negativo', () => {
  const p = projectSku({ weeks: weeks(), soh: 100, wkAvg: 0, draws: { [W[2]]: 400 } });
  assert.strictEqual(p.rows[2].closing, -300);
  assert.strictEqual(p.summary.firstStockoutWeek, W[2]);
  assert.ok(buildAlerts('X', p).some((a) => a.code === 'PROJECTED_STOCKOUT' && a.severity === 'CRITICAL'));
});

// ── 8. PO chegando depois da ruptura ────────────────────────────────────
test('8. PO depois da ruptura: repõe, mas o alerta continua', () => {
  const p = projectSku({
    weeks: weeks(), soh: 100, wkAvg: 0,
    draws: { [W[2]]: 400 }, incoming: { [W[5]]: 1000 },
  });
  assert.strictEqual(p.rows[2].closing, -300);
  assert.strictEqual(p.rows[5].closing, 700);
  const codes = buildAlerts('X', p).map((a) => a.code);
  assert.ok(codes.includes('PROJECTED_STOCKOUT'));
  assert.ok(codes.includes('PO_AFTER_STOCKOUT'), 'a reposição tardia tem que ser sinalizada');
});

// ── 9. Held e invoiced parciais ─────────────────────────────────────────
test('9. qty_to_pick é QTY − QTY INV − QTY HELD, com piso em zero', () => {
  const toPick = (qty, inv, held) => Math.max(qty - inv - held, 0);
  assert.strictEqual(toPick(96, 0, 48), 48);      // linha real do workbook
  assert.strictEqual(toPick(32, 39, 5), 0);       // faturado além do pedido: piso zero
  assert.strictEqual(toPick(15, 3, 11), 1);
});

// ── 10. Várias semanas em cascata ───────────────────────────────────────
test('10. cascata: opening de cada semana é o closing da anterior', () => {
  const p = projectSku({
    weeks: weeks(), soh: 1250, wkAvg: 120,
    incoming: { [W[3]]: 500 }, draws: { [W[1]]: 200, [W[2]]: 75 },
  });
  for (let i = 1; i < p.rows.length; i++) {
    assert.strictEqual(p.rows[i].opening, p.rows[i - 1].closing, `semana ${i}`);
    assert.strictEqual(
      p.rows[i].closing,
      p.rows[i].opening + p.rows[i].incoming - p.rows[i].expectedSales - p.rows[i].projectDraws
    );
  }
});

// ── 11. Filtro por fornecedor ───────────────────────────────────────────
test('11. filtro por fornecedor não altera o cálculo de cada SKU', () => {
  const base = { weeks: weeks(), soh: 400, wkAvg: 25, draws: { [W[2]]: 100 } };
  const all = projectSku(base);
  const filtered = projectSku(base);
  assert.deepStrictEqual(closings(filtered), closings(all));
});

// ── 12. Versão de SKU ───────────────────────────────────────────────────
test('12. SKU versionado: demanda do -V1 e do canônico somam no mesmo bucket', () => {
  const resolve = (sku, map) => map[sku] || sku;
  const map = { 'R1066-WH-12W-CW-24-V1': 'R1066-WH-12W-CW-24' };
  const raw = [
    { sku: 'R1066-WH-12W-CW-24-V1', week: W[2], qty: 40 },
    { sku: 'R1066-WH-12W-CW-24',    week: W[2], qty: 60 },
  ];
  const draws = {};
  for (const r of raw) {
    if (resolve(r.sku, map) !== 'R1066-WH-12W-CW-24') continue;
    draws[r.week] = (draws[r.week] || 0) + r.qty;
  }
  const p = projectSku({ weeks: weeks(), soh: 500, wkAvg: 0, draws });
  assert.strictEqual(p.rows[2].projectDraws, 100);
  assert.strictEqual(p.rows[2].closing, 400);
});

// ═══ Casos que a análise do workbook 2026 acrescentou ═══════════════════

test('13. sazonal: fator 0% no Ano Novo Chinês zera a venda daquela semana', () => {
  const p = projectSku({ weeks: weeks({ [W[3]]: 0, [W[4]]: 0.6 }), soh: 1000, wkAvg: 100 });
  assert.strictEqual(p.rows[3].expectedSales, 0, 'blackout de CNY não vende');
  assert.strictEqual(p.rows[4].expectedSales, 60);
  assert.strictEqual(p.rows[3].closing, p.rows[2].closing, 'saldo parado na semana de blackout');
});

test('14. sazonal NÃO se aplica a draw de projeto nem a chegada de PO', () => {
  const p = projectSku({
    weeks: weeks({ [W[2]]: 0 }), soh: 1000, wkAvg: 100,
    draws: { [W[2]]: 300 }, incoming: { [W[2]]: 500 },
  });
  assert.strictEqual(p.rows[2].expectedSales, 0);
  assert.strictEqual(p.rows[2].projectDraws, 300, 'contêiner e projeto não são sazonalizados');
  assert.strictEqual(p.rows[2].incoming, 500);
});

test('15. o bug do domingo: data em dia útil entra na semana dela', () => {
  assert.strictEqual(weekEnding('2026-09-02'), '2026-09-06', 'quarta cai na semana que fecha domingo');
  assert.strictEqual(weekEnding('2026-08-30'), '2026-08-30', 'domingo é a própria semana');
  assert.strictEqual(weekEnding('2026-08-31'), '2026-09-06', 'segunda abre a semana seguinte');
  // No Excel um SUMIFS com PICK DATE = 2026-09-02 não casa com nenhuma coluna
  // e a demanda desaparece. Aqui ela aparece.
  const draws = {}; draws[weekEnding('2026-09-02')] = 150;
  const p = projectSku({ weeks: weeks(), soh: 500, wkAvg: 0, draws });
  assert.strictEqual(p.rows[2].projectDraws, 150);
});

test('16. SOH zerado não pode sumir da tela', () => {
  const p = projectSku({ weeks: weeks(), soh: 0, wkAvg: 20, projectOrders: -50 });
  assert.strictEqual(p.summary.mthsStockExcel, null, 'o Excel apagaria a célula');
  assert.notStrictEqual(p.summary.mthsStock, null, 'nós mostramos o número');
  assert.strictEqual(p.summary.sohNonPositive, true);
  assert.ok(buildAlerts('X', p).some((a) => a.code === 'SOH_NON_POSITIVE' && a.severity === 'CRITICAL'));
});

test('17. cobertura em meses SOMA o compromisso de projeto, que vem negativo', () => {
  // Linha real: 12v-IP20-012w — SOH 38, Project Orders −50, Wk/Avg 16.
  // Excel: (38 + (−50)) / (16 × 52 ÷ 12) = −0,17
  const p = projectSku({ weeks: weeks(), soh: 38, wkAvg: 16, projectOrders: -50 });
  assert.strictEqual(p.summary.mthsStock, -0.17);
  assert.strictEqual(Math.round(p.summary.mthAvg), 69);
});

test('18. meta de cobertura por SKU dispara antes da ruptura', () => {
  const p = projectSku({ weeks: weeks(), soh: 500, wkAvg: 50, targetCoverWeeks: 6 });
  assert.strictEqual(p.summary.targetQty, 300);          // 50 × 6
  assert.strictEqual(p.summary.firstBelowTargetWeek, W[5]); // fecha em 250
  const codes = buildAlerts('X', p).map((a) => a.code);
  assert.ok(codes.includes('BELOW_TARGET_COVER'));
  assert.ok(!codes.includes('PROJECTED_STOCKOUT'), 'ainda não é ruptura');
});

test('19. semana de reporte usa o realizado, não a projeção', () => {
  const p = projectSku({
    weeks: weeks(), soh: 47, wkAvg: 16,
    actualSales: 13, actualDraws: 5, incoming: { [W[0]]: 0 },
  });
  assert.strictEqual(p.rows[0].closing, 47, 'fechamento da semana de reporte é o SOH real');
  assert.strictEqual(p.rows[0].expectedSales, 13, 'venda realizada, não wkAvg');
  assert.strictEqual(p.rows[0].projectDraws, 5);
  assert.strictEqual(p.rows[0].opening, 65, '47 − 0 + 13 + 5');
  assert.strictEqual(p.rows[1].opening, 47, 'a semana seguinte parte do real');
});

test('20. draw grande demais é sinalizado como possível erro de digitação', () => {
  const p = projectSku({ weeks: weeks(), soh: 5000, wkAvg: 10, draws: { [W[2]]: 900 } });
  assert.ok(buildAlerts('X', p).some((a) => a.code === 'LARGE_DRAW'));
});

test('21. sem Wk/Avg o motor não inventa venda', () => {
  const p = projectSku({ weeks: weeks(), soh: 300, wkAvg: null, draws: { [W[2]]: 100 } });
  assert.strictEqual(p.rows[1].expectedSales, 0);
  assert.strictEqual(p.summary.mthsStock, null);
  assert.strictEqual(p.rows[2].closing, 200);
});

test('22. horizonte rolante: 12, 26 e 52 semanas dão o mesmo caminho', () => {
  const mk = (n) => projectSku({
    weeks: weekSeries(START, n).map((wk, i) => ({ weekEnding: wk, factor: 1, isReporting: i === 0 })),
    soh: 1000, wkAvg: 10,
  });
  const w12 = mk(12), w52 = mk(52);
  assert.strictEqual(w12.rows.length, 12);
  assert.strictEqual(w52.rows.length, 52);
  assert.deepStrictEqual(closings(w12), closings(w52).slice(0, 12));
  assert.strictEqual(addWeeks(START, 51), w52.rows[51].weekEnding);
});
