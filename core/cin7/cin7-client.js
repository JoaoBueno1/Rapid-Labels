'use strict';
/**
 * Cliente Cin7 com throttle global, backoff de 429/403 e CONTADOR DE CHAMADAS.
 *
 * O contador é o ponto: o driver precisa parar por orçamento de chamadas, não
 * só por relógio. Mesma mecânica já provada em cin7-stock-sync/backfill-sales.js
 * :52-70 e sync-movements.js:43-60 — copiada, não importada, porque este
 * módulo nasce ao lado e não pode arrastar a inicialização daqueles scripts
 * (eles fazem process.exit no topo se faltar credencial).
 */
const BASE = process.env.CIN7_BASE_URL || 'https://inventory.dearsystems.com/ExternalApi/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient({ throttleMs = 2500, maxCalls = Infinity, onCall = null } = {}) {
  const ACC = process.env.CIN7_ACCOUNT_ID;
  const KEY = process.env.CIN7_API_KEY;
  if (!ACC || !KEY) throw new Error('faltam CIN7_ACCOUNT_ID / CIN7_API_KEY');

  let last = 0;
  let calls = 0;
  let throttled = 0;

  async function get(path, _retry = 0) {
    if (calls >= maxCalls) {
      const e = new Error(`orçamento de chamadas esgotado (${maxCalls})`);
      e.code = 'BUDGET';
      throw e;
    }
    const wait = Math.max(0, throttleMs - (Date.now() - last));
    if (wait) await sleep(wait);
    last = Date.now();
    calls++;
    if (onCall) onCall(calls);

    let res;
    try {
      res = await fetch(`${BASE}/${path}`, {
        headers: {
          'api-auth-accountid': ACC,
          'api-auth-applicationkey': KEY,
          Accept: 'application/json',
        },
      });
    } catch (e) {
      if (_retry < 6) { await sleep(5000); return get(path, _retry + 1); }
      throw e;
    }

    // 429 e 403 são a MESMA coisa no Cin7: estouro do teto de 60/min da conta.
    if ((res.status === 429 || res.status === 403) && _retry < 6) {
      throttled++;
      const back = 5000 * 2 ** _retry + Math.floor(Math.random() * 2000);
      console.warn(`  Cin7 ${res.status} — backoff ${Math.round(back / 1000)}s [${_retry + 1}/6]`);
      await sleep(back);
      return get(path, _retry + 1);
    }
    if (!res.ok) throw new Error(`Cin7 ${res.status} ${path.split('?')[0]}`);
    return res.json();
  }

  return {
    get,
    get calls() { return calls; },
    get throttled() { return throttled; },
    get remaining() { return maxCalls - calls; },
  };
}

module.exports = { makeClient, BASE };
