'use strict';
/**
 * Leitor do Rapid-Inventory SKU 2026.xlsx.
 *
 * Só interpreta: não escreve em banco. Assim dá para conferir o que saiu
 * antes de gravar, e para testar o parser sem Postgres.
 *
 * ── A regra de fusão, e por que ela é 1-para-1 ──────────────────────────
 *
 * O plano inicial supunha que linhas repetidas de SO+SKU fossem parcelas de
 * uma mesma linha. Os dados dizem outra coisa. Em SO 207455 / R5511 há oito
 * linhas, cada uma com sua QTY, sua QTY INV e seu próprio texto de agenda:
 * "Delivery 15th May 2025", "Delivery 16th June 2025", "Delivery 16th July
 * 2025"… Não são parcelas de uma linha: são chamadas de entrega distintas.
 * A linha do Excel JÁ É o draw.
 *
 * Então cada linha vira uma project_line com um draw. Nada é fundido. O
 * ganho do modelo aparece daqui para frente: quando o planejador quiser
 * dividir o saldo em duas datas, ele acrescenta um draw — sem duplicar linha.
 */
const path = require('path');
const XLSX = require('xlsx');
const { toISODate, weekEnding } = require('./week');

const DEFAULT_FILE = path.join(require('os').homedir(), 'Downloads', 'Rapid-Inventory SKU 2026.xlsx');

const txt = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};
const nz = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : 0;
};
const nOrNull = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? n : null;
};
const isErr = (v) => typeof v === 'string' && v.startsWith('#');

function grid(wb, sheet, fromRow) {
  const ws = wb.Sheets[sheet];
  if (!ws) return [];
  return XLSX.utils
    .sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false })
    .slice(fromRow);
}

/** Normaliza fornecedor: UPPER + trim resolve boa parte das 26 grafias. */
function normSupplier(v) {
  const s = txt(v);
  return s ? s.toUpperCase().replace(/\s+/g, ' ').trim() : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Project / Completed Projects
// ─────────────────────────────────────────────────────────────────────────
function readProjects(wb, opts = {}) {
  const out = { projects: new Map(), lines: [], stats: {} };
  const push = (rows, map, status) => {
    let n = 0, skipped = 0, offGrid = 0;
    for (const r of rows) {
      const so = txt(r[map.so]);
      const sku = txt(r[map.sku]);
      if (!so || !sku) { skipped++; continue; }
      const key = so.toUpperCase();
      if (!out.projects.has(key)) {
        out.projects.set(key, {
          sales_order: so,
          order_date: toISODate(r[map.date]),
          customer: txt(r[map.customer]),
          reference: txt(r[map.reference]),
          rep: txt(r[map.rep]),
          warehouse_note: map.warehouse != null ? txt(r[map.warehouse]) : null,
          status,
          finish_date: map.finish != null ? toISODate(r[map.finish]) : null,
          source: 'EXCEL_IMPORT',
        });
      } else if (status === 'COMPLETED' && map.finish != null) {
        const p = out.projects.get(key);
        if (!p.finish_date) p.finish_date = toISODate(r[map.finish]);
      }

      const qty = nz(r[map.qty]);
      const qtyInv = nz(r[map.inv]);
      const qtyHeld = nz(r[map.held]);
      const toPick = Math.max(qty - qtyInv - qtyHeld, 0);
      const pick = toISODate(r[map.pick]);
      if (pick && weekEnding(pick) !== pick) offGrid++;

      out.lines.push({
        project_key: key,
        line_no: ++n,
        sku,
        qty,
        type: txt(r[map.type]),
        unit_price: nOrNull(r[map.price]),
        po_ref: txt(r[map.po]),
        po_due_date: map.poDue != null ? toISODate(r[map.poDue]) : null,
        pick_date: pick,
        qty_held: qtyHeld,
        date_packed: toISODate(r[map.packed]),
        qty_inv: qtyInv,
        required_text: txt(r[map.required]),
        finish_date: map.finish != null ? toISODate(r[map.finish]) : null,
        warehouse: map.warehouse != null ? txt(r[map.warehouse]) : null,
        comments: [r[map.c1], r[map.c2], r[map.c3]].map(txt).filter(Boolean),
        status,
        // O draw só existe se houver saldo a separar. Linha 100% faturada
        // não gera demanda futura — é exatamente o que o Excel faz ao
        // devolver "" em QTY to Pick.
        draw: toPick > 0 ? { qty: toPick, planned_date: pick } : null,
      });
    }
    return { n: out.lines.length, skipped, offGrid };
  };

  const active = push(grid(wb, 'Project', 1), {
    date: 0, so: 1, customer: 2, reference: 3, rep: 4, sku: 5, qty: 6, type: 7, price: 8,
    toPick: 9, po: 10, pick: 11, held: 12, packed: 13, inv: 15, required: 16,
    warehouse: 17, c1: 19, c2: 20, c3: 21,
  }, 'ACTIVE');
  out.stats.activeOffGrid = active.offGrid;
  const beforeCompleted = out.lines.length;

  if (opts.includeCompleted !== false) {
    const done = push(grid(wb, 'Completed Projects', 1), {
      finish: 0, date: 1, so: 2, customer: 3, reference: 4, rep: 5, sku: 6, qty: 7, type: 8,
      price: 9, toPick: 10, po: 11, poDue: 12, held: 13, packed: 14, inv: 16, required: 17,
      c1: 19, c2: 20,
    }, 'COMPLETED');
    out.stats.completedOffGrid = done.offGrid;
  }

  out.stats.activeLines = beforeCompleted;
  out.stats.completedLines = out.lines.length - beforeCompleted;
  out.stats.projects = out.projects.size;
  out.stats.draws = out.lines.filter((l) => l.draw).length;
  out.stats.undatedDraws = out.lines.filter((l) => l.draw && !l.draw.planned_date).length;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// PO's — o custo unitário e o câmbio vivem DENTRO da fórmula. 539 custos
// distintos em =QTY*custo, e dois divisores (/0.65 e /0.68) na mesma coluna.
// ─────────────────────────────────────────────────────────────────────────
function readPOs(wb) {
  const ws = wb.Sheets["PO's"];
  if (!ws) return { lines: [], stats: {} };
  const rows = grid(wb, "PO's", 1);
  const lines = [];
  let offGrid = 0;
  const seq = new Map();

  rows.forEach((r, i) => {
    const po = txt(r[0]);
    const sku = txt(r[3]);
    if (!po || !sku) return;
    const excelRow = i + 2;
    const fCost = (ws['J' + excelRow] || {}).f || '';
    const fFx = (ws['K' + excelRow] || {}).f || '';
    const mCost = fCost.match(/\*\s*([\d.]+)/);
    const mFx = fFx.match(/\/\s*([\d.]+)/);

    const due = toISODate(r[7]);
    if (due && weekEnding(due) !== due) offGrid++;

    const n = (seq.get(po) || 0) + 1;
    seq.set(po, n);

    // "Finish Date" às vezes é a string "Ready" em vez de data.
    const finishRaw = r[5];
    const finish = toISODate(finishRaw);

    lines.push({
      po_number: po,
      line_no: n,
      po_date: toISODate(r[1]),
      supplier_raw: normSupplier(r[2]),
      sku,
      qty: nz(r[4]),
      finish_date: finish,
      finish_note: finish ? null : txt(finishRaw),
      date_checked: toISODate(r[6]),
      due_date: due,
      vessel: txt(r[8]),
      value_usd: isErr(r[9]) ? null : nOrNull(r[9]),
      value_aud: isErr(r[10]) ? null : nOrNull(r[10]),
      unit_cost_usd: mCost ? parseFloat(mCost[1]) : null,
      fx_used: mFx ? parseFloat(mFx[1]) : null,
      source: 'EXCEL_IMPORT',
    });
  });

  return {
    lines,
    stats: {
      lines: lines.length,
      pos: new Set(lines.map((l) => l.po_number)).size,
      offGrid,
      withCost: lines.filter((l) => l.unit_cost_usd != null).length,
      fxValues: [...new Set(lines.map((l) => l.fx_used).filter(Boolean))],
      suppliers: [...new Set(lines.map((l) => l.supplier_raw).filter(Boolean))],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Estoques. Quatro exports diferentes do Cin7, com escopos diferentes.
// A aba "DALTON" traz o Main Warehouse — o cabeçalho dela diz isso, o nome
// da aba engana.
// ─────────────────────────────────────────────────────────────────────────
function readStock(wb) {
  const soh = grid(wb, 'SOH', 2)
    .filter((r) => txt(r[0]))
    .map((r) => ({ sku: txt(r[0]), qty_on_hand: nz(r[1]), allocated: nz(r[2]), on_order: nz(r[3]) }));

  const commitment = grid(wb, 'Projects', 2)
    .filter((r) => txt(r[0]))
    .map((r) => ({ sku: txt(r[0]), qty_on_hand: nz(r[3]), allocated: nz(r[4]), on_order: nz(r[5]) }));

  const branch = [];
  for (const [sheet, code] of [['DALTON', 'MAIN'], ['GATEWAY', 'GATEWAY']]) {
    for (const r of grid(wb, sheet, 2)) {
      if (!txt(r[0])) continue;
      branch.push({ branch_code: code, sku: txt(r[0]), qty_on_hand: nz(r[2]), allocated: nz(r[3]), on_order: nz(r[4]) });
    }
  }

  const salesRows = grid(wb, 'WEEK SALES', 6).filter((r) => txt(r[0]));
  const period = {};
  for (const r of grid(wb, 'WEEK SALES', 0).slice(0, 4)) {
    const s = txt(r[0]) || '';
    const m = s.match(/^(From|To):\s*(.+)$/i);
    if (m) period[m[1].toLowerCase()] = m[2].trim();
  }
  const weekly_sales = salesRows.map((r) => ({
    sku: txt(r[0]), qty: nz(r[1]), sale_value: nz(r[2]),
    cogs: nz(r[3]), invoice_value: nz(r[4]), profit: nz(r[5]),
  }));

  return { soh, commitment, branch, weekly_sales, sales_period: period };
}

// ─────────────────────────────────────────────────────────────────────────
// Abas de fornecedor — os parâmetros de planejamento por SKU.
//
// Bloco de 7 linhas. Wk/Avg é o valor da coluna B três linhas abaixo do SKU
// (é o que o Analysis busca com INDEX(...)+3) e é SEMPRE digitado à mão:
// 837 blocos conferidos em cinco fornecedores, zero fórmulas.
// A meta de cobertura é o N de "=B{sales}*N" na linha de Closing.
// ─────────────────────────────────────────────────────────────────────────
const SUPPLIER_SHEETS = ['Aeon','AGC','AOK','CGD','CNEPSO','Cowin','Dolight','E-Lite','ePower',
  'Foshan','General','Huibo','Kinglumi','Mixed','Ottima','LEDLUZ','Relight','Sealite',
  'Senselite','Starlux','Upshine','Xtrack'];

function readSkuSettings(wb) {
  const settings = new Map();
  const perSheet = {};
  for (const sheet of SUPPLIER_SHEETS) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const code = sheet.toUpperCase().replace('-', '').replace(/\s+/g, '');
    let count = 0;
    for (let r = 0; r <= range.e.r; r++) {
      const a = ws['A' + (r + 1)];
      if (!a || String(a.v).trim() !== 'Product SKU') continue;
      const sku = txt((ws['B' + (r + 1)] || {}).v);
      if (!sku) continue;
      const legacy = txt((ws['C' + (r + 1)] || {}).v);
      const salesCell = ws['B' + (r + 4)];      // +3 linhas = Inventory/Sales Out
      const closeCell = ws['B' + (r + 6)];      // +5 linhas = Closing = Wk/Avg × N
      const wkAvg = salesCell && !salesCell.f && typeof salesCell.v === 'number' ? salesCell.v : null;
      let target = null;
      if (closeCell && closeCell.f) {
        const m = closeCell.f.match(/\*\s*(\d+)/);
        if (m) target = parseInt(m[1], 10);
      }
      // Um SKU pode aparecer em mais de uma aba. Fica com o primeiro que
      // trouxer Wk/Avg — o Analysis também aponta para uma aba só.
      const prev = settings.get(sku);
      if (!prev || (prev.wk_avg == null && wkAvg != null)) {
        settings.set(sku, { sku, supplier_code: code, legacy_code: legacy, wk_avg: wkAvg, target_cover_weeks: target });
      }
      count++;
    }
    perSheet[sheet] = count;
  }

  // O Analysis manda no mapa SKU→fornecedor: o nome da aba está cravado
  // dentro da fórmula da coluna B. É a lista curada de 1.988 SKUs.
  const an = wb.Sheets['Analysis'];
  const inAnalysis = new Set();
  if (an) {
    const ar = XLSX.utils.decode_range(an['!ref']);
    for (let r = 2; r <= ar.e.r; r++) {
      const a = an['A' + (r + 1)];
      const sku = a ? txt(a.v) : null;
      if (!sku) continue;
      inAnalysis.add(sku);
      const b = an['B' + (r + 1)];
      const m = b && b.f ? b.f.match(/INDEX\(\s*'?([^'!]+)'?!/) : null;
      const cur = settings.get(sku) || { sku, supplier_code: null, legacy_code: null, wk_avg: null, target_cover_weeks: null };
      if (m) cur.supplier_code = m[1].toUpperCase().replace('-', '').replace(/\s+/g, '');
      if (cur.wk_avg == null && b && typeof b.v === 'number') cur.wk_avg = b.v;
      const g = an['G' + (r + 1)];
      if (g && txt(g.v)) cur.comments = txt(g.v);
      cur.in_analysis = true;
      settings.set(sku, cur);
    }
  }

  const list = [...settings.values()];
  return {
    settings: list,
    stats: {
      total: list.length,
      inAnalysis: inAnalysis.size,
      withWkAvg: list.filter((s) => s.wk_avg != null).length,
      withTarget: list.filter((s) => s.target_cover_weeks != null).length,
      targets: list.reduce((acc, s) => { if (s.target_cover_weeks) acc[s.target_cover_weeks] = (acc[s.target_cover_weeks] || 0) + 1; return acc; }, {}),
      perSheet,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sheet1 — mapa de versão de SKU (-V1/-V2/-V3 → código atual).
// ─────────────────────────────────────────────────────────────────────────
function readSkuVersions(wb) {
  const rows = grid(wb, 'Sheet1', 2);
  const out = [];
  for (const r of rows) {
    const version = txt(r[0]);
    const current = txt(r[1]);
    if (!version || !current) continue;
    const check = r[2];
    out.push({ version_code: version, current_sku: current, resolved: !isErr(check) && txt(check) != null });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
function parseWorkbook(file = DEFAULT_FILE, opts = {}) {
  const wb = XLSX.readFile(file, { cellFormula: true, cellDates: true });
  const projects = readProjects(wb, opts);
  const pos = readPOs(wb);
  const stock = readStock(wb);
  const skus = readSkuSettings(wb);
  const versions = readSkuVersions(wb);
  return {
    file,
    projects,
    pos,
    stock,
    skus,
    versions,
    summary: {
      ...projects.stats,
      poLines: pos.stats.lines,
      poCount: pos.stats.pos,
      poOffGrid: pos.stats.offGrid,
      sohRows: stock.soh.length,
      commitmentRows: stock.commitment.length,
      branchRows: stock.branch.length,
      weeklySalesRows: stock.weekly_sales.length,
      salesPeriod: stock.sales_period,
      skuSettings: skus.stats,
      versionRows: versions.length,
    },
  };
}

module.exports = { parseWorkbook, readProjects, readPOs, readStock, readSkuSettings, readSkuVersions, DEFAULT_FILE, SUPPLIER_SHEETS };
