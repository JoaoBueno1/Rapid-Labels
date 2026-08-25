'use strict';
/**
 * O motor de planejamento.
 *
 * Função pura: entra fato, sai projeção. Sem banco, sem rede, sem relógio.
 * É assim porque a paridade com o Excel precisa ser testável célula a célula.
 *
 * ── A aritmética, idêntica ao workbook ──────────────────────────────────
 *
 *   semana de reporte   closing = SOH real do Cin7            (a âncora)
 *   semana futura       opening = closing da semana anterior
 *                       expectedSales = wkAvg × fator sazonal
 *                       closing = opening + incoming − expectedSales − draws
 *
 * O fator sazonal multiplica APENAS venda normal. Draw de projeto e chegada
 * de PO não são sazonalizados — um contêiner que chega em janeiro chega em
 * janeiro, independente do Ano Novo Chinês. É assim no Excel e está certo.
 *
 * ── As quatro diferenças deliberadas ────────────────────────────────────
 *
 *  1. Datas caem na semana delas (ver week.js). O Excel exige domingo exato
 *     e perde a demanda em silêncio quando não é.
 *  2. Demanda sem data volta separada em `undatedQty` e NUNCA é somada a uma
 *     semana. Metade da demanda de hoje é TBA; inventar uma semana para ela
 *     seria inventar dado.
 *  3. SOH ≤ 0 não some. O Excel faz IF(SOH>0, …, "") e esconde 714 SKUs —
 *     justamente os piores. Aqui o SKU aparece, marcado.
 *  4. Horizonte rolante. Nenhuma coluna de banco por semana, nenhuma célula
 *     de projeção persistida.
 */

const DAY = 86400000;
const weeksBehind = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / (7 * DAY));

const round = (n, p = 4) => {
  const f = Math.pow(10, p);
  return Math.round((n + Number.EPSILON) * f) / f;
};
const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));

/**
 * @param {object} input
 * @param {Array<{weekEnding:string, factor?:number, isReporting?:boolean}>} input.weeks
 *        Ordenadas. weeks[0] é a semana de reporte.
 * @param {number}  input.soh              Disponível no fechamento da semana de reporte.
 * @param {number?} input.wkAvg            Média semanal — parâmetro MANUAL do planejador.
 * @param {object}  input.incoming         { 'YYYY-MM-DD': qty } por semana de due date.
 * @param {object}  input.draws            { 'YYYY-MM-DD': qty } por semana planejada.
 * @param {number}  input.undatedQty       Demanda conhecida sem data. Devolvida à parte.
 * @param {number?} input.actualSales      Realizado da semana de reporte (WEEK SALES).
 * @param {number?} input.actualDraws      Realizado da semana de reporte (WK Project).
 * @param {number}  input.targetCoverWeeks Meta de cobertura do SKU (4/6/7/8/10 no Excel).
 * @param {number}  input.projectOrders    Compromisso líquido de projeto (normalmente negativo).
 */
function projectSku(input) {
  const {
    weeks = [],
    soh = 0,
    wkAvg = null,
    incoming = {},
    draws = {},
    undatedQty = 0,
    actualSales = null,
    actualDraws = null,
    targetCoverWeeks = 7,
    projectOrders = 0,
  } = input;

  const avg = wkAvg == null ? null : num(wkAvg);
  const targetQty = avg == null ? null : round(avg * num(targetCoverWeeks));
  const rows = [];

  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const wk = w.weekEnding;
    const factor = w.factor == null ? 1 : num(w.factor);
    const inQty = round(num(incoming[wk]));
    const drawQty = round(num(draws[wk]));

    let opening, sales, projectDraws, closing;

    if (i === 0) {
      // Semana de reporte: o modelo se ressincroniza com a realidade.
      // O fechamento é o SOH de verdade, não o que a projeção previa.
      sales = actualSales == null ? (avg == null ? 0 : round(avg * factor)) : round(num(actualSales));
      projectDraws = actualDraws == null ? drawQty : round(num(actualDraws));
      closing = round(num(soh));
      opening = round(closing - inQty + sales + projectDraws);
    } else {
      opening = rows[i - 1].closing;
      sales = avg == null ? 0 : round(avg * factor);
      projectDraws = drawQty;
      closing = round(opening + inQty - sales - projectDraws);
    }

    rows.push({
      weekEnding: wk,
      weekIndex: i,
      isReporting: i === 0,
      factor,
      opening,
      incoming: inQty,
      expectedSales: sales,
      projectDraws,
      closing,
      belowZero: closing < 0,
      belowTarget: targetQty != null && closing < targetQty,
    });
  }

  return { rows, summary: summarise(rows, { avg, targetQty, undatedQty, soh, projectOrders, targetCoverWeeks }) };
}

function summarise(rows, ctx) {
  const { avg, targetQty, undatedQty, soh, projectOrders } = ctx;
  const future = rows.slice(1);

  const stockout = future.find((r) => r.belowZero) || null;
  const belowTarget = targetQty == null ? null : future.find((r) => r.belowTarget) || null;
  let min = null;
  for (const r of future) if (!min || r.closing < min.closing) min = r;

  // A fórmula de cobertura do Excel: (SOH + Project Orders) ÷ (Wk/Avg × 52 ÷ 12).
  // É SOMA porque Project Orders vem negativo — 662 dos 854 SKUs da aba Projects.
  // Trocar por subtração inverteria a decisão de compra da empresa inteira.
  const mthAvg = avg && avg > 0 ? (avg * 52) / 12 : null;
  const mthsStock = mthAvg ? round((num(soh) + num(projectOrders)) / mthAvg, 2) : null;

  return {
    wkAvg: avg,
    mthAvg: mthAvg == null ? null : round(mthAvg, 2),
    targetQty,
    mthsStock,
    // O Excel apaga a célula quando SOH <= 0. Guardamos os dois para a
    // fase de paridade, mas a UI usa mthsStock e sinaliza sohNonPositive.
    mthsStockExcel: num(soh) > 0 ? mthsStock : null,
    sohNonPositive: num(soh) <= 0,
    undatedQty: round(num(undatedQty)),
    hasUndated: num(undatedQty) > 0,
    totalIncoming: round(future.reduce((s, r) => s + r.incoming, 0)),
    totalDraws: round(future.reduce((s, r) => s + r.projectDraws, 0)),
    totalExpectedSales: round(future.reduce((s, r) => s + r.expectedSales, 0)),
    firstStockoutWeek: stockout ? stockout.weekEnding : null,
    weeksToStockout: stockout ? stockout.weekIndex : null,
    firstBelowTargetWeek: belowTarget ? belowTarget.weekEnding : null,
    minClosing: min ? min.closing : null,
    minClosingWeek: min ? min.weekEnding : null,
    closingAtHorizon: rows.length ? rows[rows.length - 1].closing : null,
  };
}

/**
 * Exceções. Determinísticas de propósito: aritmética não precisa de LLM
 * para virar alerta, e um alerta que muda de opinião não é confiável.
 */
const SEVERITY = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

function buildAlerts(sku, projection, opts = {}) {
  const { rows, summary } = projection;
  const { largeDrawFactor = 8, todayWeek = null } = opts;
  const out = [];
  const push = (code, severity, message, extra = {}) =>
    out.push({ sku, code, severity, rank: SEVERITY[severity], message, ...extra });

  if (summary.firstStockoutWeek) {
    push('PROJECTED_STOCKOUT', 'CRITICAL',
      `Runs out in the week ending ${summary.firstStockoutWeek} — down to ${summary.minClosing}`,
      { weekEnding: summary.firstStockoutWeek });
  }
  if (summary.sohNonPositive) {
    push('SOH_NON_POSITIVE', 'CRITICAL',
      'Available stock is zero or negative — this SKU would not appear at all in the Excel',
      {});
  }
  if (!summary.firstStockoutWeek && summary.firstBelowTargetWeek) {
    push('BELOW_TARGET_COVER', 'HIGH',
      `Drops below the ${summary.targetQty} target cover in the week ending ${summary.firstBelowTargetWeek}`,
      { weekEnding: summary.firstBelowTargetWeek });
  }
  if (summary.mthsStock != null && summary.mthsStock < 1) {
    push('BELOW_ONE_MONTH', 'HIGH',
      `${summary.mthsStock} months of cover — under the one-month reorder line the Excel uses`, {});
  }
  if (summary.hasUndated) {
    push('UNDATED_DEMAND', 'MEDIUM',
      `${summary.undatedQty} units of project demand with no pick date`, {});
  }

  // PO que chega tarde demais: existe entrada depois da semana da ruptura.
  if (summary.firstStockoutWeek) {
    const late = rows.find((r) => r.incoming > 0 && r.weekEnding > summary.firstStockoutWeek);
    if (late) {
      push('PO_AFTER_STOCKOUT', 'HIGH',
        `PO lands ${late.weekEnding}, after the stockout in ${summary.firstStockoutWeek}`,
        { weekEnding: late.weekEnding });
    }
  }

  // Draw fora do padrão do SKU — normalmente erro de digitação de quantidade.
  if (summary.wkAvg && summary.wkAvg > 0) {
    const limit = summary.wkAvg * largeDrawFactor;
    for (const r of rows) {
      if (r.projectDraws > limit) {
        push('LARGE_DRAW', 'MEDIUM',
          `Draw of ${r.projectDraws} in ${r.weekEnding} — over ${largeDrawFactor}× the weekly average`,
          { weekEnding: r.weekEnding });
        break;
      }
    }
  }

  // A semana de reporte é sempre a última FECHADA, então ficar uma semana
  // atrás de hoje é o normal. Só avisa quando atrasou de verdade.
  if (todayWeek && rows.length && weeksBehind(rows[0].weekEnding, todayWeek) > 1) {
    push('STALE_REPORTING_WEEK', 'MEDIUM',
      `Reporting week is still ${rows[0].weekEnding}; today is ${todayWeek}. Roll the planning week.`, {});
  }

  return out.sort((a, b) => b.rank - a.rank);
}

module.exports = { projectSku, buildAlerts, SEVERITY };
