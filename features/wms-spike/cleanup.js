/**
 * wms-spike/cleanup.js — remove every draft fulfilment the spike created on
 * SO-280071, leaving the sample order in its original AUTHORISED / NOT PICKED
 * state. Read-only-safe otherwise. Run: node features/wms-spike/cleanup.js
 */
require('dotenv').config();
const BASE = 'https://inventory.dearsystems.com/ExternalApi/v2';
const H = { 'api-auth-accountid': process.env.CIN7_ACCOUNT_ID, 'api-auth-applicationkey': process.env.CIN7_API_KEY, 'Content-Type': 'application/json' };
const ID = '3a855378-d20a-4d0a-8ac4-4b16543e8240';
const call = async (m, p) => { const r = await fetch(`${BASE}/${p}`, { method: m, headers: H }); const t = await r.text(); let j; try { j = JSON.parse(t) } catch (e) { j = t } return { status: r.status, j }; };
(async () => {
  const f = ((((await call('GET', 'sale/fulfilment?SaleID=' + ID)).j) || {}).Fulfilments) || [];
  console.log('fulfilments on SO-280071:', f.length);
  for (const x of f) {
    const d = await call('DELETE', 'sale/fulfilment?SaleID=' + ID + '&TaskID=' + x.TaskID);
    console.log('  delete', x.TaskID, '(#' + x.FulfillmentNumber + ', pick ' + (x.Pick && x.Pick.Status) + ') → HTTP', d.status);
  }
  const after = ((((await call('GET', 'sale/fulfilment?SaleID=' + ID)).j) || {}).Fulfilments) || [];
  const s = (await call('GET', 'sale?ID=' + ID)).j || {};
  console.log('remaining fulfilments:', after.length);
  console.log('sale status:', s.Status, '| picking:', s.CombinedPickingStatus, '| order:', s.Order && s.Order.Status);
})().catch(e => console.error('ERR', e.message));
