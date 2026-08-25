'use strict';
/**
 * Semanas de planejamento.
 *
 * O workbook trabalha com semanas que TERMINAM no domingo — a linha
 * "Week Ended Date" das abas de fornecedor. Toda a aritmética aqui é feita
 * em UTC sobre strings 'YYYY-MM-DD' de propósito: qualquer conversão para
 * Date local introduz o deslocamento de fuso que já estraga datas neste repo
 * (AEST +10 vira 14:00Z do dia anterior).
 */

const DAY = 86400000;

/** Normaliza Date | 'YYYY-MM-DD' | ISO timestamp para 'YYYY-MM-DD'. */
function toISODate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const parsed = new Date(value);
    if (isNaN(parsed)) return null;
    return parsed.toISOString().slice(0, 10);
  }
  if (value instanceof Date) {
    if (isNaN(value)) return null;
    // Componentes LOCAIS de propósito. O SheetJS materializa o serial do Excel
    // na meia-noite local; usar toISOString() aqui recua um dia inteiro em
    // AEST (+10) e transforma todo domingo em sábado. Foi assim que datas
    // erradas entraram no banco antes.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * O domingo que encerra a semana da data.
 *
 * Esta é a correção do defeito mais caro do Excel: lá a PICK DATE tem que
 * cair exatamente no domingo, senão o SUMIFS não casa e a demanda desaparece
 * do forecast sem erro nenhum — 32 draws e 8 linhas de PO hoje. Aqui uma
 * quarta-feira entra na semana dela.
 */
function weekEnding(value) {
  const iso = toISODate(value);
  if (!iso) return null;
  const ms = toUTC(iso);
  const dow = new Date(ms).getUTCDay();      // 0 = domingo
  const daysToSunday = (7 - dow) % 7;
  return fromUTC(ms + daysToSunday * DAY);
}

function addWeeks(weekEndingIso, n) {
  return fromUTC(toUTC(weekEndingIso) + n * 7 * DAY);
}

function weeksBetween(fromIso, toIso) {
  return Math.round((toUTC(toIso) - toUTC(fromIso)) / (7 * DAY));
}

/** Horizonte rolante: `count` semanas a partir de (e incluindo) a de reporte. */
function weekSeries(startWeekEndingIso, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(addWeeks(startWeekEndingIso, i));
  return out;
}

/** "30 Aug" — rótulo curto para o cabeçalho da grade. */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function shortLabel(weekEndingIso) {
  const [, m, d] = weekEndingIso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

module.exports = { toISODate, weekEnding, addWeeks, weeksBetween, weekSeries, shortLabel };
