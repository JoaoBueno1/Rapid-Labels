/**
 * Shared config for the Cin7 Core webhook pipeline.
 * Single source of truth for which events we subscribe to — used by the
 * registration CLI (manage-webhooks.js) and the watchdog (webhook-watchdog.js).
 *
 * Full taxonomy reference (Cin7 Core, verified from the API blueprint):
 *   Sale/Created, Sale/QuoteAuthorised, Sale/OrderAuthorised, Sale/Voided,
 *   Sale/Backordered, Sale/ShipmentAuthorised, Sale/InvoiceAuthorised,
 *   Sale/PickAuthorised, Sale/PackAuthorised, Sale/CreditNoteAuthorised,
 *   Sale/Undo, Sale/PartialPaymentReceived, Sale/FullPaymentReceived,
 *   Sale/AttachmentAdded, Sale/AdditionalAttributesChanged,
 *   Sale/ShipmentTrackingNumberChanged, Purchase/OrderAuthorised,
 *   Purchase/InvoiceAuthorised, Purchase/StockReceivedAuthorised,
 *   Purchase/CreditNoteAuthorised, Purchase/Updated, Customer/Updated,
 *   Supplier/Updated, Product/Updated, Stock/AvailableStockLevelChanged,
 *   Lead/Updated, Lead/Converted, Opportunity/*, Task/Overdue
 */
module.exports = {
  // The events we register. Curated for stock + anomaly monitoring; expand freely.
  OUR_EVENTS: [
    'Sale/ShipmentAuthorised',          // ⭐ stock leaves the system — pick anomalies
    'Sale/Voided',                      // ⭐ cancellation → correction-conflict check
    'Sale/Undo',                        // ⭐ fulfilment reversed
    'Sale/InvoiceAuthorised',           // ⭐ invoiced → clears the non-invoiced monitor
    'Sale/PickAuthorised',              //    pick committed (richer trail)
    'Purchase/StockReceivedAuthorised', //    stock comes in (replenishment)
    'Stock/AvailableStockLevelChanged', //    catch-all on-hand change
  ],
};
