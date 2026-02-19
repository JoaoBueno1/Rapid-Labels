-- Disable RLS for Cyclic Count Upload Tables
-- Run this in Supabase SQL Editor to allow uploads from the browser

-- Disable RLS for audit_runs table
ALTER TABLE audit_runs DISABLE ROW LEVEL SECURITY;

-- Disable RLS for audit_stock_analysis table
ALTER TABLE audit_stock_analysis DISABLE ROW LEVEL SECURITY;

-- Optional: Create policies if you want fine-grained control instead
-- (Enable RLS and create policies that allow inserts/updates)

/*
-- Example: Enable RLS with permissive policy
ALTER TABLE audit_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on audit_runs" 
ON audit_runs 
FOR ALL 
USING (true) 
WITH CHECK (true);

ALTER TABLE audit_stock_analysis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on audit_stock_analysis" 
ON audit_stock_analysis 
FOR ALL 
USING (true) 
WITH CHECK (true);
*/
