-- Returns: dedicated Invoice number (the office verifies credits/warranties by invoice).
-- Auto-filled from the scanned sales order (Cin7 InvoiceNumber) or typed manually.
alter table public.returns_active
  add column if not exists invoice_number text;
