-- Returns: customer reference (the "Customer Reference" field on Cin7 sale orders).
-- Pulled from the scanned sales order when available, else typed manually.
alter table public.returns_active
  add column if not exists customer_reference text;
