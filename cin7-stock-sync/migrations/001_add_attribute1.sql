-- Migration: Add attribute1 (5DC code) to cin7_mirror.products
-- Run this in Supabase Dashboard → SQL Editor
-- Date: 2026-02-20

-- Add attribute1 column (stores Cin7 AdditionalAttribute1 = 5DC code)
ALTER TABLE cin7_mirror.products 
  ADD COLUMN IF NOT EXISTS attribute1 TEXT DEFAULT NULL;

-- Add attribute2 column (stores Cin7 AdditionalAttribute2, e.g. brand/supplier)
ALTER TABLE cin7_mirror.products 
  ADD COLUMN IF NOT EXISTS attribute2 TEXT DEFAULT NULL;

-- Index on attribute1 for fast 5DC lookups
CREATE INDEX IF NOT EXISTS idx_products_attribute1 
  ON cin7_mirror.products (attribute1) 
  WHERE attribute1 IS NOT NULL AND attribute1 != '';

-- Verify
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_schema = 'cin7_mirror' 
  AND table_name = 'products' 
  AND column_name IN ('attribute1', 'attribute2');
