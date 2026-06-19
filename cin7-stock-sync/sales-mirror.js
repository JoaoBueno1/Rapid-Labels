/**
 * Shared mapper/upsert for the sales mirror (cin7_mirror.sales_orders + sale_lines)
 * from a Cin7 sale DETAIL object. Used by the webhook (movement-processor, on ship)
 * so new orders land in sales_orders live, and reusable by any detail-fed path.
 *
 * Upsert semantics: only the columns we derive from the detail are written; columns
 * we don't have here (e.g. invoice_amount from the saleList header) are left untouched
 * on existing rows, so the webhook ENRICHES without wiping header-only fields.
 */
const d = v => (v ? String(v).split('T')[0] : null);
const num = v => (v == null || v === '') ? null : Number(v);

function mapDetailToSalesOrder(det, orderNumber, saleId, source) {
  const addr = det.ShippingAddress || {};
  const order = det.Order || {};
  const inv = (det.Invoices || [])[0] || {};
  let shipDate = null;
  for (const f of (det.Fulfilments || det.Fulfillments || [])) {
    if (f.Ship && f.Ship.Lines && f.Ship.Lines[0] && f.Ship.Lines[0].ShipmentDate) { shipDate = f.Ship.Lines[0].ShipmentDate; break; }
  }
  return {
    order_number: orderNumber, sale_id: saleId || det.ID,
    customer: det.Customer || null, customer_id: det.CustomerID || null, customer_reference: det.CustomerReference || null,
    contact: det.Contact || null, email: det.Email || null, phone: det.Phone || null,
    sales_rep: det.SalesRepresentative || null,
    order_date: d(det.SaleOrderDate), ship_date: d(shipDate), invoice_date: d(inv.InvoiceDate),
    invoice_number: inv.InvoiceNumber || null,
    order_amount: num(order.Total), tax_amount: num(order.Tax), cogs_amount: num(det.COGSAmount),
    currency_rate: num(det.CurrencyRate), base_currency: det.BaseCurrency || null,
    status: det.Status || null, order_status: det.OrderStatus || null, fulfilment_status: det.FulFilmentStatus || null,
    shipping_status: det.CombinedShippingStatus || null, picking_status: det.CombinedPickingStatus || null,
    packing_status: det.CombinedPackingStatus || null, invoice_status: det.CombinedInvoiceStatus || null,
    payment_status: det.CombinedPaymentStatus || null, quote_status: det.QuoteStatus || null,
    location_name: det.Location || null, source_channel: det.SourceChannel || null, type: det.Type || null,
    carrier: det.Carrier || null, service_only: !!det.ServiceOnly,
    ship_suburb: addr.City || null, ship_state: addr.State || null, ship_postcode: addr.Postcode || null, ship_country: addr.Country || null,
    cin7_updated: det.LastModifiedOn || null,
    detail_synced_at: new Date().toISOString(), source: source || 'webhook',
  };
}

function mapSaleLines(det, orderNumber, saleId) {
  return (det.Order && det.Order.Lines ? det.Order.Lines : []).map((ln, i) => ({
    order_number: orderNumber, sale_id: saleId, line_no: i,
    sku: ln.SKU, product_id: ln.ProductID, product_name: ln.Name,
    quantity: num(ln.Quantity), price: num(ln.Price), discount: num(ln.Discount), tax: num(ln.Tax), total: num(ln.Total),
  })).filter(l => l.sku);
}

// Upsert sales_orders + sale_lines from a detail. Best-effort; throws are caller's to catch.
async function upsertSalesMirror(sb, det, orderNumber, saleId, source) {
  const cm = sb.schema('cin7_mirror');
  await cm.from('sales_orders').upsert(mapDetailToSalesOrder(det, orderNumber, saleId, source), { onConflict: 'order_number' });
  const lines = mapSaleLines(det, orderNumber, saleId);
  if (lines.length) await cm.from('sale_lines').upsert(lines, { onConflict: 'order_number,line_no' });
}

module.exports = { upsertSalesMirror, mapDetailToSalesOrder, mapSaleLines };
