'use strict';
/**
 * Contadores do rail, servidos pelo backend.
 *
 * Antes eles existiam só na home, porque home.js os buscava com o cliente
 * Supabase do navegador. Em qualquer outra página o rail mostrava um menu
 * mudo — e o número que faz a pessoa clicar é justamente o que dizia que
 * havia trabalho esperando.
 *
 * Um endpoint só, cache curto, e cada contagem falha sozinha: se a tabela de
 * devoluções sumir, o contador de coleta continua aparecendo.
 */
const db = require('../features/stock-planning/lib/sp-db');

let cache = null, cachedAt = 0;
const TTL = 30000;

async function count(sql) {
  try { const r = await db.query(sql); return Number(r[0].n); } catch (_) { return null; }
}

function register(app) {
  app.get('/api/nav/counts', async (req, res) => {
    if (cache && Date.now() - cachedAt < TTL) return res.json({ ...cache, cached: true });
    try {
      const [collections, returns, openOrders, backordered, planningAlerts] = await Promise.all([
        count(`SELECT count(*)::int n FROM public.collections_active`),
        count(`SELECT count(*)::int n FROM public.returns_active WHERE COALESCE(status,'') <> 'completed'`),
        count(`SELECT count(*)::int n FROM cin7_mirror.order_pipeline
                WHERE type='SO' AND status NOT IN ('COMPLETED','CLOSED','VOIDED','CANCELLED')`),
        count(`SELECT count(*)::int n FROM cin7_mirror.order_pipeline WHERE type='SO' AND status='BACKORDERED'`),
        count(`SELECT count(*)::int n FROM rapid_inv.v_sp_planning_skus WHERE soh_nonpositive OR mths_stock < 1`),
      ]);
      cache = { collections, returns, openOrders, backordered, planningAlerts, at: new Date().toISOString() };
      cachedAt = Date.now();
      res.json(cache);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  console.log('✅ Nav counts endpoint registered: /api/nav/counts');
}

module.exports = { register };
