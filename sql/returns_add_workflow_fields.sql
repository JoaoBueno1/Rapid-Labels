-- Returns: extra fields to match how the team already logs credit notes
-- (their Excel columns: Warehouse, Rep, Credit Note, Emailed Customer + Note)
-- plus the customer email pulled from Cin7 for quick verification/emailing.
--
-- Credit Note # reuses the existing returns_active.treatment_ref (no new column).

alter table public.returns_active
  add column if not exists warehouse        text,   -- Main / Brisbane / Cairns / Coffs Harbour / ...
  add column if not exists rep              text,   -- sales rep (Cin7 SalesRepresentative)
  add column if not exists customer_email   text,   -- default contact email (Cin7), editable
  add column if not exists customer_emailed text;   -- "Emailed" / "Should have emailed" / free note
