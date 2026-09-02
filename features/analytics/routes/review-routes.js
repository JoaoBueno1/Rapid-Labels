/**
 * Monthly Review · o quadro de trabalho.
 *
 * A tela em /analytics/review.html e onde o relatorio mensal deixa de ser
 * PowerPoint aos poucos: cada uma das 54 analises tem estado, nota e — quando
 * a fonte ja existe — o grafico ao vivo no lugar do print.
 *
 * TUDO POR REST, sem senha de banco. Depois de 31/08 essa e a regra: uma
 * variavel que so existe numa maquina faz a tela quebrar em silencio na outra,
 * e foi exatamente o que custou uma manha no replenishment.
 *
 * O CATALOGO e um arquivo (review-catalog.json), nao uma tabela: ele descreve
 * o DECK, que muda quando o deck muda, e vem versionado junto do codigo. A
 * tabela guarda so o que e trabalho — estado e nota.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const CATALOGO = path.join(__dirname, '..', 'ui', 'review-catalog.json');

function register(app) {
  const R = '/api/review';

  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      console.error('[review]', req.method, req.path, e.message);
      res.status(500).json({ error: e.message });
    }
  };

  const H = (schema, extra) => Object.assign(
    { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    schema ? { 'Accept-Profile': schema, 'Content-Profile': schema } : {}, extra || {});

  // O PostgREST corta em 1000 e nao avisa. Aqui nenhuma tabela chega perto
  // disso, mas paginar e o padrao da casa desde que o teto comeu 238 SKUs da
  // regua do rep sem dar erro.
  async function sbAll(p, schema) {
    const out = [];
    for (let off = 0; ; off += 1000) {
      const sep = p.includes('?') ? '&' : '?';
      const r = await fetch(`${SB}/rest/v1/${p}${sep}limit=1000&offset=${off}`,
        { headers: H(schema), signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 180)}`);
      const b = await r.json();
      out.push(...b);
      if (b.length < 1000) return out;
    }
  }

  /** O quadro: catalogo do deck + o estado gravado de cada analise. */
  app.get(`${R}/board`, wrap(async (req, res) => {
    const cat = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));
    let estado = [];
    let aviso = null;
    try {
      estado = await sbAll('review_board?select=*', 'rapid_inv');
    } catch (e) {
      // NAO cai em silencio. Sem a tabela a tela ainda mostra o catalogo, mas
      // dizendo na cara que nada sera salvo -- o oposto do catch que trocava a
      // regua do rep sem avisar.
      aviso = 'Table rapid_inv.review_board does not exist yet. '
            + 'Run features/analytics/db/002_review_board.sql in the Supabase SQL Editor. '
            + 'Until then nothing on this page is saved.';
    }
    const por = estado.reduce((m, r) => (m[r.slide_key] = r, m), {});
    const rows = cat.map((c) => ({
      ...c,
      status: por[c.key] ? por[c.key].status : 'todo',
      note: por[c.key] ? por[c.key].note : '',
      updated_at: por[c.key] ? por[c.key].updated_at : null,
      updated_by: por[c.key] ? por[c.key].updated_by : null,
    }));
    const conta = rows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
    res.json({ rows, counts: conta, total: rows.length, warning: aviso });
  }));

  /** Gravar estado e nota de uma analise. Um por chamada: e decisao. */
  app.put(`${R}/board/:key`, wrap(async (req, res) => {
    const key = String(req.params.key);
    const cat = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));
    const item = cat.find((c) => c.key === key);
    if (!item) return res.status(404).json({ error: 'unknown slide: ' + key });

    const { status, note } = req.body || {};
    if (status && !['todo', 'working', 'done'].includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const linha = {
      slide_key: key, deck: item.deck, slide_no: item.n, title: item.title,
      readiness: item.readiness,
      status: status || 'todo',
      note: note == null ? null : String(note).slice(0, 4000),
      updated_by: (req.get('x-sp-user') || 'anon').slice(0, 120),
      updated_at: new Date().toISOString(),
    };
    // Upsert de verdade: aqui a linha INTEIRA e nossa (nao ha coluna inferida
    // a preservar, ao contrario de sales_rep_branch), entao merge-duplicates
    // serve e evita o par GET+PATCH.
    const r = await fetch(`${SB}/rest/v1/review_board`, {
      method: 'POST',
      headers: H('rapid_inv', { Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(linha),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 180)}`);
    res.json({ ok: true, row: (await r.json())[0] || linha });
  }));

  /**
   * O dado dos graficos que ja podem existir.
   *
   * Cada id aponta para uma view CURADA, nunca para tabela crua. E a regra do
   * plano: a definicao de "venda liquida de imposto" mora num lugar so, senao
   * a tela e o deck divergem e ninguem sabe qual esta certo.
   */
  const FONTES = {
    'monthly-sales': {
      view: 'v_an_monthly_sales',
      select: 'mth,wh,sales,cogs,gross_profit,gp_pct,orders,sales_ly,growth_pct',
      order: 'mth.asc',
      titulo: 'Monthly sales by warehouse',
      nota: 'Net of tax, as the deck reports. Source: cin7_mirror.sales_orders.',
    },
    'stock-by-warehouse': {
      view: 'v_an_stock_by_warehouse',
      select: 'wh,kind,skus,units,soh_value,mth_cogs,months_stock',
      order: 'soh_value.desc',
      titulo: 'Stock on hand by warehouse',
      nota: 'Months of cover uses COGS as the denominator, not revenue — '
          + 'revenue inflates cover by the whole margin.',
    },
  };

  app.get(`${R}/data/:id`, wrap(async (req, res) => {
    const f = FONTES[req.params.id];
    if (!f) return res.status(404).json({ error: 'unknown chart source: ' + req.params.id });
    const rows = await sbAll(`${f.view}?select=${f.select}&order=${f.order}`, 'rapid_inv');
    res.json({ id: req.params.id, title: f.titulo, note: f.nota, rows });
  }));

  console.log('✅ Monthly Review board registered (/api/review/*)');
}

module.exports = { register };
