'use strict';
/**
 * Handler genérico `list → detail` — um chunk = UMA FAIXA DE PÁGINAS.
 *
 * Serve transferências, ajustes, montagens e compras. Todos têm a mesma forma:
 * paginar uma lista, buscar o detalhe de cada task, escrever fato.
 *
 * Por que faixa de páginas e não janela de data: stockTransferList,
 * stockAdjustmentList e finishedGoodsList IGNORAM UpdatedSince/ModifiedSince
 * (medido). A única chave estável é o índice da paginação — e ele É estável
 * porque essas listas são ordenadas por CRIAÇÃO: em stockTransferList a página
 * P com Limit=1 devolve TR-(50090−P). Registro criado depois entra na ponta,
 * não no meio, então uma faixa antiga não se move debaixo do cursor.
 * (purchaseList é a exceção: HONRA UpdatedSince, e a config abaixo usa isso.)
 *
 * cursor = { page, idx } — página atual e índice dentro dela. O cursor só
 * avança DEPOIS do write. Reprocessar um item é idempotente: todo write é
 * delete-por-(task,source) + insert, ou upsert em chave natural.
 *
 * occurred_at: TODO movimento escrito aqui carimba a DATA DO NEGÓCIO, nunca
 * now(). É o conserto do defeito que inviabilizaria o backfill —
 * movement-processor.js:348 grava detected_at = new Date() enquanto
 * sync-movements.js:39 grava a data do negócio, e um GROUP BY por dia mistura
 * as duas. Sem occurred_at, 13 meses caem todos no dia da execução.
 */
const d = (v) => (v ? String(v).split('T')[0] : null);
const ts = (v) => (v ? `${d(v)}T00:00:00Z` : null);
const n = (v) => (v == null || v === '' ? 0 : Number(v));
const binOf = (loc) => (loc && loc.includes(':') ? loc.split(':').slice(1).join(':').trim() : null);
const whOf = (loc) => (loc ? String(loc).split(':')[0].trim() : null);

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS — transcritos de cin7-stock-sync/sync-movements.js:69-137 e
// sync-assembly.js:59-87, com occurred_at acrescentado. Copiados de propósito:
// aqueles arquivos fazem process.exit() no topo, não são importáveis.
// ─────────────────────────────────────────────────────────────────────────────
function transferMovements(det) {
  const out = [];
  const when = ts(det.CompletionDate || det.DepartureDate || det.RequiredBy);
  for (const l of det.Lines || []) {
    const base = {
      cin7_task_id: det.TaskID, reference_number: det.TransferNumber || det.Number,
      sku: l.SKU, quantity: n(l.Quantity || l.TransferQuantity),
      occurred_at: when, source: 'backfill', raw_data: { status: det.Status },
    };
    out.push({ ...base, movement_type: 'stock_transfer', quantity: -Math.abs(base.quantity),
      from_location: whOf(l.FromLocation || det.From), from_bin: binOf(l.FromLocation) });
    out.push({ ...base, movement_type: 'stock_transfer', quantity: Math.abs(base.quantity),
      to_location: whOf(l.ToLocation || det.To), to_bin: binOf(l.ToLocation) });
  }
  return out.filter((m) => m.sku && m.quantity);
}

function adjustmentMovements(det) {
  const when = ts(det.EffectiveDate || det.Date);
  const key = (l) => `${l.SKU}|${l.Location || ''}`;
  const old = new Map(); const now = new Map();
  (det.ExistingStockLines || []).forEach((l) => old.set(key(l), n(l.Quantity)));
  (det.NewStockLines || []).forEach((l) => now.set(key(l), n(l.Quantity)));
  const out = [];
  for (const k of new Set([...old.keys(), ...now.keys()])) {
    const delta = (now.get(k) || 0) - (old.get(k) || 0);
    if (!delta) continue;                          // ajuste que só troca de bin some — defeito conhecido
    const [sku, loc] = k.split('|');
    if (!sku || sku === 'undefined') continue;   // sem esta guarda o ledger ganha um SKU fantasma
    out.push({
      cin7_task_id: det.TaskID, reference_number: det.TaskNumber || det.Number,
      movement_type: 'stock_adjustment', sku, quantity: delta,
      [delta > 0 ? 'to_location' : 'from_location']: whOf(loc),
      [delta > 0 ? 'to_bin' : 'from_bin']: binOf(loc),
      occurred_at: when, source: 'backfill',
      raw_data: { reason: det.Comment || null, effective: d(det.EffectiveDate) },
    });
  }
  return out;
}

function assemblyMovements(det) {
  const when = ts(det.CompletionDate || det.Date);
  const out = [];
  for (const l of det.PickLines || det.Pick?.Lines || []) {
    out.push({ cin7_task_id: det.TaskID, reference_number: det.TaskNumber || det.Number,
      movement_type: 'assembly_consume', sku: l.SKU, quantity: -Math.abs(n(l.Quantity)),
      from_location: whOf(l.Location), from_bin: binOf(l.Location),
      occurred_at: when, source: 'backfill', raw_data: { fg: det.SKU, batch: l.BatchSN || null } });
  }
  for (const l of det.OutputLines || det.Lines || []) {
    out.push({ cin7_task_id: det.TaskID, reference_number: det.TaskNumber || det.Number,
      movement_type: 'assembly_produce', sku: l.SKU || det.SKU, quantity: Math.abs(n(l.Quantity)),
      to_location: whOf(l.Location), to_bin: binOf(l.Location),
      occurred_at: when, source: 'backfill', raw_data: {} });
  }
  return out.filter((m) => m.sku && m.quantity);
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITERS — idempotência por delete-then-insert em (cin7_task_id, source).
// Mesmo contrato de sync-movements.js:181, com source='backfill' para NÃO
// colidir com o que o poller ('movements-sync') e o webhook ('webhook') já
// escreveram. Assim o backfill nunca apaga dado vivo.
// ─────────────────────────────────────────────────────────────────────────────
async function writeMovements(q, taskId, rows) {
  await q(`DELETE FROM cin7_mirror.stock_movements WHERE cin7_task_id=$1 AND source='backfill'`, [taskId]);
  if (!rows.length) return 0;
  const cols = ['cin7_task_id','reference_number','movement_type','sku','quantity',
                'from_location','from_bin','to_location','to_bin','occurred_at','detected_at','source','raw_data'];
  const vals = []; const ph = [];
  rows.forEach((r, i) => {
    ph.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(',')})`);
    vals.push(r.cin7_task_id, r.reference_number || null, r.movement_type, r.sku, r.quantity,
      r.from_location || null, r.from_bin || null, r.to_location || null, r.to_bin || null,
      // detected_at é NOT NULL (movement-schema.sql:23). Task sem data de
      // negócio (DRAFT/IN PROGRESS não têm CompletionDate) gravava nulo e a
      // linha era rejeitada em silêncio pelo catch lá embaixo.
      r.occurred_at, r.occurred_at || new Date().toISOString(),
      'backfill', JSON.stringify(r.raw_data || {}));
  });
  await q(`INSERT INTO cin7_mirror.stock_movements (${cols.join(',')}) VALUES ${ph.join(',')}`, vals);
  return rows.length;
}

async function writePurchase(q, det) {
  await q(
    `INSERT INTO cin7_mirror.purchase_orders
       (po_id, po_number, supplier, supplier_id, status, order_date, required_by,
        completed_date, currency, total, occurred_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (po_id) DO UPDATE SET
       po_number=EXCLUDED.po_number, supplier=EXCLUDED.supplier, status=EXCLUDED.status,
       order_date=EXCLUDED.order_date, required_by=EXCLUDED.required_by,
       completed_date=EXCLUDED.completed_date, total=EXCLUDED.total,
       occurred_at=EXCLUDED.occurred_at, synced_at=now()`,
    [det.ID, det.OrderNumber, det.Supplier, det.SupplierID, det.Status,
     d(det.OrderDate), d(det.RequiredBy), d(det.CompletedDate),
     det.SupplierCurrency || null, n(det.Total), ts(det.OrderDate)]);

  const lines = (det.Order?.Lines || det.Lines || []).map((l, i) => [
    det.ID, i, l.SKU, l.Name || null, n(l.Quantity), n(l.Price), n(l.Total),
    n((det.StockReceived?.Lines || []).filter((r) => r.SKU === l.SKU).reduce((a, r) => a + n(r.Quantity), 0)),
  ]).filter((r) => r[2]);
  // poda a versão anterior da PO antes de reescrever (mesma lição do pruneStaleLines)
  await q(`DELETE FROM cin7_mirror.purchase_lines WHERE po_id=$1`, [det.ID]);
  if (!lines.length) return 1;
  const ph = lines.map((_, i) => `($${i * 8 + 1},$${i * 8 + 2},$${i * 8 + 3},$${i * 8 + 4},$${i * 8 + 5},$${i * 8 + 6},$${i * 8 + 7},$${i * 8 + 8})`);
  await q(`INSERT INTO cin7_mirror.purchase_lines
             (po_id, line_no, sku, product_name, quantity, unit_cost, total, received_quantity)
           VALUES ${ph.join(',')}`, lines.flat());
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURAÇÃO POR JOB
// ─────────────────────────────────────────────────────────────────────────────
const JOBS = {
  tr_detail: {
    list: (p, lim) => `stockTransferList?Page=${p}&Limit=${lim}`,
    listKey: 'StockTransferList', idKey: 'TaskID',
    detail: (id) => `stockTransfer?TaskID=${id}`,
    write: async (q, det) => writeMovements(q, det.TaskID, transferMovements(det)),
  },
  adj_detail: {
    list: (p, lim) => `stockAdjustmentList?Page=${p}&Limit=${lim}`,
    listKey: 'StockAdjustmentList', idKey: 'TaskID',
    detail: (id) => `stockAdjustment?TaskID=${id}`,
    write: async (q, det) => writeMovements(q, det.TaskID, adjustmentMovements(det)),
  },
  asm_detail: {
    list: (p, lim) => `finishedGoodsList?Page=${p}&Limit=${lim}`,
    listKey: 'FinishedGoodsList', idKey: 'TaskID',
    detail: (id) => `finishedGoods?TaskID=${id}`,
    // NÃO filtra Status='COMPLETED' no cliente como sync-assembly.js:108 faz:
    // o build VOIDED precisa existir no espelho para o ledger fechar.
    write: async (q, det) => writeMovements(q, det.TaskID, assemblyMovements(det)),
  },
  po_detail: {
    // purchaseList HONRA UpdatedSince (medido: sem filtro 14.097, com
    // UpdatedSince=2025-08-01 → 4.943). Usar o filtro corta 2/3 do trabalho.
    list: (p, lim) => `purchaseList?UpdatedSince=2025-08-01T00%3A00%3A00Z&Page=${p}&Limit=${lim}`,
    listKey: 'PurchaseList', idKey: 'ID',
    detail: (id) => `purchase?ID=${id}`,
    write: async (q, det) => writePurchase(q, det),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
module.exports = function makeListDetail(jobName) {
  const cfg = JOBS[jobName];
  if (!cfg) throw new Error(`job desconhecido: ${jobName}`);

  return async function listDetail({ chunk, cursor, cin7, q, dryRun, outOfBudget, log }) {
    // chunk_key = 'p0019-0026'  → páginas 19..26 (inclusive), Limit fixo 500.
    const m = String(chunk.chunk_key).match(/^p(\d+)-(\d+)$/);
    if (!m) throw new Error(`chunk_key inválido para ${jobName}: ${chunk.chunk_key}`);
    const [from, to] = [Number(m[1]), Number(m[2])];
    const LIMIT = 500;

    let page = cursor.page || from;
    let idx = cursor.idx || 0;
    let written = 0;

    while (page <= to) {
      if (outOfBudget()) return { done: false, cursor: { page, idx }, doneCount: written, note: 'orçamento' };

      const data = await cin7.get(cfg.list(page, LIMIT));
      const list = data[cfg.listKey] || [];
      if (!list.length) { page++; idx = 0; continue; }
      log(`página ${page}: ${list.length} tasks (retomando em ${idx})`);

      for (; idx < list.length; idx++) {
        if (outOfBudget()) return { done: false, cursor: { page, idx }, doneCount: written, note: 'orçamento' };
        const id = list[idx][cfg.idKey];
        if (!id) continue;
        try {
          const det = await cin7.get(cfg.detail(id));
          if (!dryRun) written += await cfg.write(q, det);
          else written++;
        } catch (e) {
          if (e.code === 'BUDGET') { e.cursor = { page, idx }; e.doneCount = written; throw e; }
          // Uma task ruim não pode matar o chunk. Registra e segue —
          // o verify por contagem vai apontar o buraco se for material.
          log(`⚠️ ${jobName} ${id}: ${e.message} — pulando`);
        }
        // O cursor só avança DEPOIS do write. Matar o processo aqui reprocessa
        // no máximo uma task, e reprocessar é idempotente.
      }
      page++; idx = 0;
    }
    return { done: true, cursor: { page, idx: 0 }, doneCount: written, note: `páginas ${from}-${to}` };
  };
};

module.exports.JOBS = JOBS;
