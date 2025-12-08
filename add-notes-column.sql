-- Add notes column to restock_setup table
-- Run this in Supabase SQL Editor

ALTER TABLE restock_setup 
ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

-- Verify the column was added
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'restock_setup' 
ORDER BY ordinal_position;
