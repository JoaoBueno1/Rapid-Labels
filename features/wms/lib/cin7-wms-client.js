/**
 * cin7-wms-client.js — thin Cin7 Core client for the PROVEN WMS endpoints only.
 *
 * Every payload here was validated live (see features/wms-spike/). No business
 * logic, no idempotency — that lives in lib/outbox.js. This module just speaks
 * Cin7 correctly and handles rate limits/backoff.
 *
 * Endpoints (all fulfilment/build sub-resources are keyed by TaskID):
 *   /sale, /saleList, /sale/fulfilment (container, POST creates)
 *   /sale/fulfilment/pick   POST/PUT {TaskID, Status, Lines}
 *   /sale/fulfilment/pack   POST/PUT {TaskID, Status, Location, Lines, Boxes}
 *   /finishedGoods          POST create {ProductID, Location, LocationID, Quantity, WIPAccount, Account}
 *   /finishedGoods/order    POST/PUT {TaskID, Status, OrderLines}   (the recipe)
 *   /finishedGoods/pick     POST/PUT {TaskID, Status, WIPAccount, Account, PickLines}
 *   /ref/productavailability GET  (10–15 min snapshot; per SKU+Location+Bin)
 */
'use strict';

const BASE = process.env.CIN7_WMS_BASE || 'https://inventory.dearsystems.com/ExternalApi/v2';
// GL accounts for finished-goods builds (validated live: "635"). Overridable.
const WIP_ACCOUNT = process.env.CIN7_WIP_ACCOUNT || '635';
const ASM_ACCOUNT = process.env.CIN7_ASSEMBLY_ACCOUNT || '635';

function headers() {
  return {
    'api-auth-accountid': process.env.CIN7_ACCOUNT_ID || '',
    'api-auth-applicationkey': process.env.CIN7_API_KEY || '',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Core request with 429/503 backoff. Returns { status, body }.
async function req(method, endpoint, body, _retry = 0) {
  let res;
  try {
    res = await fetch(`${BASE}/${endpoint}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (_retry < 4) { await sleep(4000 * (_retry + 1)); return req(method, endpoint, body, _retry + 1); }
    throw e;
  }
  if ((res.status === 429 || res.status === 503) && _retry < 5) {
    await sleep(5000 * Math.pow(2, _retry));
    return req(method, endpoint, body, _retry + 1);
  }
  const text = await res.text();
  const isHtml = /^<!DOCTYPE|^<html/i.test(text.trim());
  let json;
  try { json = JSON.parse(text); } catch (e) { json = isHtml ? null : text; }
  return { status: res.status, body: json, html: isHtml };
}
const get = (ep) => req('GET', ep);
const post = (ep, b) => req('POST', ep, b);
// Sub-resources accept PUT (update) but fall back to POST when PUT is 405.
async function write(ep, b) {
  const r = await req('PUT', ep, b);
  if (r.status === 405) return req('POST', ep, b);
  return r;
}
function ok(r) { return r.status >= 200 && r.status < 300; }
function errText(r) {
  if (Array.isArray(r.body)) return r.body.map((e) => e.Exception || e.Message).join('; ');
  if (r.body && r.body.Exception) return r.body.Exception;
  return typeof r.body === 'string' ? r.body.slice(0, 300) : `HTTP ${r.status}`;
}

// ── Sales ────────────────────────────────────────────────────────────────────
async function findSaleByNumber(orderNumber) {
  const r = await get(`saleList?Search=${encodeURIComponent(orderNumber)}&Page=1&Limit=5`);
  const rows = (r.body && r.body.SaleList) || [];
  return rows.find((x) => x.OrderNumber === orderNumber) || null;
}
async function getSale(saleId) {
  const r = await get(`sale?ID=${saleId}`);
  return ok(r) ? r.body : null;
}
async function getFulfilments(saleId) {
  const r = await get(`sale/fulfilment?SaleID=${saleId}`);
  return (ok(r) && r.body && r.body.Fulfilments) || [];
}
async function createFulfilment(saleId) {
  const r = await post('sale/fulfilment', { SaleID: saleId });
  if (!ok(r)) throw new Error(`createFulfilment: ${errText(r)}`);
  const f = ((r.body && r.body.Fulfilments) || [])[0] || {};
  return f.TaskID;
}

// ── Pick ─────────────────────────────────────────────────────────────────────
// lines: [{ ProductID, SKU, Quantity, Location:'Main Warehouse: <bin>', LocationID }]
async function authorisePick(taskId, lines) {
  const r = await write('sale/fulfilment/pick', { TaskID: taskId, Status: 'AUTHORISED', Lines: lines });
  if (!ok(r)) throw new Error(`authorisePick: ${errText(r)}`);
  return r.body;
}
async function getPick(taskId) {
  const r = await get(`sale/fulfilment/pick?TaskID=${taskId}`);
  return ok(r) ? r.body : null;
}

// ── Pack ─────────────────────────────────────────────────────────────────────
// The pack line REQUIRES a Location. lines carry Box; boxes carry dimensions.
async function authorisePack(taskId, lines, boxes, warehouseName) {
  const body = {
    TaskID: taskId,
    Status: 'AUTHORISED',
    Location: warehouseName || 'Main Warehouse',
    Lines: lines,
    Boxes: boxes || [],
  };
  const r = await write('sale/fulfilment/pack', body);
  if (!ok(r)) throw new Error(`authorisePack: ${errText(r)}`);
  return r.body;
}
async function getPack(taskId) {
  const r = await get(`sale/fulfilment/pack?TaskID=${taskId}`);
  return ok(r) ? r.body : null;
}

// ── Assembly / finished goods ────────────────────────────────────────────────
async function createBuild({ productId, productCode, location, locationId, quantity }) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await post('finishedGoods', {
    ProductID: productId, ProductCode: productCode,
    Location: location || 'Main Warehouse', LocationID: locationId,
    Quantity: quantity, Status: 'DRAFT',
    WIPAccount: WIP_ACCOUNT, Account: ASM_ACCOUNT, WIPDate: today,
  });
  if (!ok(r)) throw new Error(`createBuild: ${errText(r)}`);
  return r.body; // { TaskID, AssemblyNumber, ... }
}
// recipe: [{ ProductID, ProductCode, Quantity }]  (per-unit)
async function setBuildRecipe(taskId, orderLines) {
  const r = await write('finishedGoods/order', { TaskID: taskId, Status: 'AUTHORISED', OrderLines: orderLines });
  if (!ok(r)) throw new Error(`setBuildRecipe: ${errText(r)}`);
  return r.body;
}
// components: [{ ProductID, ProductCode, Quantity, BinID, Bin }]  (total consumed)
async function completeBuild(taskId, pickLines) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await write('finishedGoods/pick', {
    TaskID: taskId, Status: 'COMPLETED',
    WIPAccount: WIP_ACCOUNT, Account: ASM_ACCOUNT, WIPDate: today, CompletionDate: today,
    PickLines: pickLines,
  });
  if (!ok(r)) throw new Error(`completeBuild: ${errText(r)}`);
  return r.body;
}
async function getBuild(taskId) {
  const r = await get(`finishedGoods?TaskID=${taskId}`);
  return ok(r) ? r.body : null;
}
// Adopt-or-create support: find a build Cin7 auto-created for this sale / FG sku.
// Returns the most recent non-completed build for the product code, if any.
async function findLinkedBuild(productCode) {
  const r = await get(`finishedGoodsList?Search=${encodeURIComponent(productCode)}&Limit=100`);
  const rows = (r.body && r.body.FinishedGoods) || [];
  const open = rows.filter((x) => x.ProductCode === productCode && !/COMPLETED|VOIDED/i.test(x.Status));
  return open.length ? open[open.length - 1] : null;
}
// The BOM recipe is unreadable from the product but IS in an existing build's OrderLines.
async function recipeFromExistingBuild(productCode) {
  const r = await get(`finishedGoodsList?Search=${encodeURIComponent(productCode)}&Limit=100`);
  const rows = (r.body && r.body.FinishedGoods) || [];
  const comp = rows.filter((x) => x.ProductCode === productCode && /COMPLETED/i.test(x.Status)).pop();
  if (!comp) return null;
  const det = await getBuild(comp.TaskID);
  return det && det.OrderLines ? det.OrderLines.map((l) => ({ ProductID: l.ProductID, ProductCode: l.ProductCode, Quantity: 1 })) : null;
}

// ── Availability (stock lookup + bin suggestion) ─────────────────────────────
async function availability(sku) {
  const r = await get(`ref/productavailability?Sku=${encodeURIComponent(sku)}&Limit=50`);
  return (ok(r) && r.body && r.body.ProductAvailabilityList) || [];
}

// ── Stock transfers (bin↔bin, warehouse↔warehouse) ──────────────────────────
// The ONE Cin7 write already proven in production (gateway-engine.js): POST DRAFT
// then PUT COMPLETED. From/To are location GUIDs (a bin GUID or a warehouse root).
// lines: [{ ProductID, TransferQuantity, Comments }]
async function createTransfer({ fromLocationId, toLocationId, reference, lines }) {
  const r = await post('stockTransfer', { Status: 'DRAFT', From: fromLocationId, To: toLocationId, Reference: reference, Lines: lines });
  if (!ok(r)) throw new Error(`createTransfer: ${errText(r)}`);
  return r.body; // { TaskID, Number, ... }
}
async function completeTransfer({ taskId, fromLocationId, toLocationId, reference, lines }) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await write('stockTransfer', {
    TaskID: taskId, From: fromLocationId, To: toLocationId, Status: 'COMPLETED',
    CompletionDate: today, Reference: reference, CostDistributionType: 'Cost', SkipOrder: true, Lines: lines,
  });
  if (!ok(r)) throw new Error(`completeTransfer: ${errText(r)}`);
  return r.body;
}
async function getTransfer(taskId) {
  const r = await get(`stockTransfer?ID=${taskId}`);
  return ok(r) ? r.body : null;
}

// ── Purchases (for receiving) ────────────────────────────────────────────────
async function findPurchaseByNumber(orderNumber) {
  const r = await get(`purchaseList?Search=${encodeURIComponent(orderNumber)}&Page=1&Limit=5`);
  const rows = (r.body && (r.body.PurchaseList || r.body.Purchases)) || [];
  return rows.find((x) => x.OrderNumber === orderNumber || x.Number === orderNumber) || rows[0] || null;
}
async function getPurchase(id) {
  const r = await get(`purchase?ID=${id}`);
  return ok(r) ? r.body : null;
}

// ── Product / assembly detection ─────────────────────────────────────────────
async function getProduct(productId) {
  const r = await get(`product?ID=${productId}`);
  return (r.body && r.body.Products && r.body.Products[0]) || null;
}
// A line needs a build first when its product is an assembled BOM product.
async function isAssembled(productId) {
  const p = await getProduct(productId);
  return !!(p && (p.BillOfMaterial === true || /assembly/i.test(p.BOMType || '')));
}

module.exports = {
  BASE, WIP_ACCOUNT, ASM_ACCOUNT, ok, errText,
  findSaleByNumber, getSale, getFulfilments, createFulfilment,
  authorisePick, getPick, authorisePack, getPack,
  createBuild, setBuildRecipe, completeBuild, getBuild, findLinkedBuild, recipeFromExistingBuild,
  createTransfer, completeTransfer, getTransfer,
  findPurchaseByNumber, getPurchase,
  availability, getProduct, isAssembled,
};
