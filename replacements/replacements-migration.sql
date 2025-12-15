-- =====================================================
-- REPLACEMENTS MODULE - Database Migration Script
-- Run this in Supabase SQL Editor
-- =====================================================

-- Drop existing tables if you need a fresh start (UNCOMMENT IF NEEDED)
-- DROP TABLE IF EXISTS replacements_items CASCADE;
-- DROP TABLE IF EXISTS replacements_requests CASCADE;

-- 1. Create main requests table with auto-incrementing request_number
CREATE TABLE IF NOT EXISTS replacements_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONFIRMED', 'CANCELLED')),
  customer TEXT NOT NULL,
  reason TEXT,
  resolution_type TEXT CHECK (resolution_type IN ('Refund', 'Exchange', 'Credit Note', 'Stock Return', NULL)),
  courier TEXT,
  consignment TEXT,
  tracking_number TEXT,
  value_aud NUMERIC(10,2),
  sales_order TEXT,
  sales_order_reference TEXT,
  comments TEXT,
  internal_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  received BOOLEAN DEFAULT false,
  received_at DATE,
  confirmed_at TIMESTAMPTZ,
  confirmed_by TEXT,
  action_taken TEXT,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT
);

-- 2. Create items/products table
CREATE TABLE IF NOT EXISTS replacements_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES replacements_requests(id) ON DELETE CASCADE,
  code_5digit TEXT,
  product_sku TEXT,
  qty INTEGER DEFAULT 1 CHECK (qty > 0)
);

-- 3. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_replacements_status ON replacements_requests(status);
CREATE INDEX IF NOT EXISTS idx_replacements_customer ON replacements_requests(customer);
CREATE INDEX IF NOT EXISTS idx_replacements_created ON replacements_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replacements_request_num ON replacements_requests(request_number);
CREATE INDEX IF NOT EXISTS idx_replacements_items_request ON replacements_items(request_id);

-- 4. Enable Row Level Security (optional - adjust as needed)
ALTER TABLE replacements_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE replacements_items ENABLE ROW LEVEL SECURITY;

-- 5. Create policies for public access (DROP first to avoid duplicates)
DROP POLICY IF EXISTS "Allow all access to replacements_requests" ON replacements_requests;
DROP POLICY IF EXISTS "Allow all access to replacements_items" ON replacements_items;

CREATE POLICY "Allow all access to replacements_requests" ON replacements_requests
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all access to replacements_items" ON replacements_items
  FOR ALL USING (true) WITH CHECK (true);

-- 6. Verify tables were created
SELECT 'replacements_requests' as table_name, COUNT(*) as row_count FROM replacements_requests
UNION ALL
SELECT 'replacements_items' as table_name, COUNT(*) as row_count FROM replacements_items;

-- =====================================================
-- IF TABLE ALREADY EXISTS, RUN THIS TO ADD NEW COLUMNS:
-- =====================================================
-- ALTER TABLE replacements_requests 
-- ADD COLUMN IF NOT EXISTS resolution_type TEXT CHECK (resolution_type IN ('Refund', 'Exchange', 'Credit Note', 'Stock Return', NULL)),
-- ADD COLUMN IF NOT EXISTS consignment TEXT,
-- ADD COLUMN IF NOT EXISTS tracking_number TEXT,
-- ADD COLUMN IF NOT EXISTS value_aud NUMERIC(10,2),
-- ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT false;
