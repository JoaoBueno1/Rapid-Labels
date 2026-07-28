/**
 * wms-receiving.js — PO receiving putaway. The stock person scans a PO, sees the
 * expected lines, then scans each product + qty + destination bin; we putaway from
 * the receiving dock into the bin (proven stockTransfer via the outbox) and record
 * where it went.
 *
 * Scope note: the Cin7 PO RECEIPT itself (increasing on-hand) is assumed done in
 * Cin7 (stock lands at the receiving dock, default MA-DOCK). This module owns the
 * PUTAWAY — the bin placement + our journal. Driving the PO-receipt write from here
 * is a separate, still-unproven Cin7 write to validate later (like pick/pack were).
 */
'use strict';

const cin7 = require('./cin7-wms-client');
const transfers = require('./wms-transfers');

// Read a PO and return the expected lines the operator will put away.
async function getPurchaseLines(sb, orderNumber) {
  const head = await cin7.findPurchaseByNumber(orderNumber);
  if (!head) throw new Error(`Purchase ${orderNumber} not found in Cin7`);
  const po = await cin7.getPurchase(head.ID || head.TaskID || head.PurchaseID);
  const order = (po && (po.Order || po.StockReceived || po)) || {};
  const lines = (order.Lines || []).map((l) => ({
    sku: l.SKU, productId: l.ProductID, name: l.Name,
    qty: Number(l.Quantity || l.ReceivingQuantity || 0),
  }));
  return { orderNumber, supplier: po && po.Supplier, lines };
}

// Putaway one received line into a bin (from the receiving dock).
async function receiveLine(sb, { sku, productId, qty, toBin, poNumber }, user) {
  if (!productId) throw new Error('productId required');
  const from = process.env.WMS_RECEIVING_BIN || transfers.RECEIVING_BIN;
  const res = await transfers.putaway(sb, {
    sku, productId, qty, fromLocation: from, toBin, tag: 'RECEIVE',
  }, user);
  return Object.assign({ poNumber, from }, res);
}

module.exports = { getPurchaseLines, receiveLine };
