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
  // The sale lifecycle + purchase. Only ShipmentAuthorised + Purchase enrich
  // (Cin7 API call); the rest are recorded raw (no call) — see movement-processor.
  // Stock/AvailableStockLevelChanged is intentionally NOT here (high-volume
  // firehose; enable later only if we build a live stock-level view).
  OUR_EVENTS: [
    'Sale/ShipmentAuthorised',          // ⭐ stock leaves — anomalies (ENRICHES)
    'Sale/Voided',                      // ⭐ cancellation (raw)
    'Sale/Undo',                        // ⭐ fulfilment reversed (raw)
    'Sale/InvoiceAuthorised',           // ⭐ invoiced → non-invoiced monitor (raw)
    'Sale/PickAuthorised',              //    pick step — timeline (raw)
    'Sale/PackAuthorised',              //    pack step — timeline (raw)
    'Purchase/StockReceivedAuthorised', //    stock in — replenishment (ENRICHES)
  ],
};
