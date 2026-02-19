-- =====================================================
-- BRANCH REPLENISHMENT PLANNER - DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- =====================================================

-- 1. BRANCH AVG MONTHLY SALES (simplified wide format)
-- User maintains this table manually or via CSV import
CREATE TABLE IF NOT EXISTS branch_avg_monthly_sales (
    product TEXT PRIMARY KEY,  -- e.g., R3206-TRI
    avg_mth_main NUMERIC DEFAULT 0,
    avg_mth_sydney NUMERIC DEFAULT 0,
    avg_mth_melbourne NUMERIC DEFAULT 0,
    avg_mth_brisbane NUMERIC DEFAULT 0,
    avg_mth_cairns NUMERIC DEFAULT 0,
    avg_mth_coffs_harbour NUMERIC DEFAULT 0,
    avg_mth_hobart NUMERIC DEFAULT 0,
    avg_mth_sunshine_coast NUMERIC DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- No index needed - product is primary key

-- 2. STOCK SNAPSHOTS (header for each upload)
CREATE TABLE IF NOT EXISTS stock_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    source TEXT DEFAULT 'manual_upload',
    original_filename TEXT,
    notes TEXT,
    row_count INTEGER DEFAULT 0
);

-- 3. STOCK SNAPSHOT LINES (normalized data from report)
CREATE TABLE IF NOT EXISTS stock_snapshot_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
    product TEXT NOT NULL,       -- e.g., R3206-TRI (matches AVG table)
    warehouse_code TEXT NOT NULL, -- MAIN, SYD, MEL, BNE, CNS, CFS, HBA, SCS
    qty_available NUMERIC DEFAULT 0,
    qty_on_hand NUMERIC DEFAULT 0,
    qty_allocated NUMERIC DEFAULT 0,
    qty_on_order NUMERIC DEFAULT 0,
    qty_in_transit NUMERIC DEFAULT 0,
    UNIQUE(snapshot_id, warehouse_code, product)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_snapshot_lines_snapshot ON stock_snapshot_lines(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snapshot_lines_product ON stock_snapshot_lines(product);
CREATE INDEX IF NOT EXISTS idx_snapshot_lines_warehouse ON stock_snapshot_lines(warehouse_code);

-- 4. TRANSFER PLANS (one plan per branch per snapshot)
CREATE TABLE IF NOT EXISTS transfer_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL REFERENCES stock_snapshots(id) ON DELETE CASCADE,
    branch_code TEXT NOT NULL, -- SYD, MEL, BNE, CNS, CFS, HBA, SCS (not MAIN)
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent')),
    target_weeks NUMERIC DEFAULT 5,
    main_min_weeks NUMERIC DEFAULT 8,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(snapshot_id, branch_code)
);

-- Index for queries
CREATE INDEX IF NOT EXISTS idx_transfer_plans_snapshot ON transfer_plans(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_transfer_plans_branch ON transfer_plans(branch_code);

-- 5. TRANSFER PLAN LINES (frozen calculations for each product)
CREATE TABLE IF NOT EXISTS transfer_plan_lines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES transfer_plans(id) ON DELETE CASCADE,
    product_code TEXT NOT NULL,  -- e.g., R3206-TRI
    -- Frozen snapshot values (values at time of plan generation)
    branch_available_frozen NUMERIC DEFAULT 0,
    main_available_frozen NUMERIC DEFAULT 0,
    avg_month_frozen NUMERIC,
    -- Calculated values (frozen at generation time)
    target_qty NUMERIC DEFAULT 0,
    need_qty NUMERIC DEFAULT 0,
    main_min_qty NUMERIC DEFAULT 0,
    can_send_qty NUMERIC DEFAULT 0,
    suggested_qty NUMERIC DEFAULT 0,
    -- User editable
    approved_qty NUMERIC DEFAULT 0,
    -- Status and flags
    status TEXT,
    notes TEXT,
    UNIQUE(plan_id, product_code)
);

-- Index for queries
CREATE INDEX IF NOT EXISTS idx_transfer_plan_lines_plan ON transfer_plan_lines(plan_id);
CREATE INDEX IF NOT EXISTS idx_transfer_plan_lines_product ON transfer_plan_lines(product_code);

-- =====================================================
-- HELPER VIEW: Latest snapshot
-- =====================================================
CREATE OR REPLACE VIEW latest_stock_snapshot AS
SELECT * FROM stock_snapshots 
ORDER BY created_at DESC 
LIMIT 1;

-- =====================================================
-- HELPER VIEW: Branch summary with plan status
-- =====================================================
CREATE OR REPLACE VIEW branch_plan_status AS
SELECT 
    b.code,
    b.name,
    ls.id as latest_snapshot_id,
    ls.created_at as snapshot_date,
    tp.id as plan_id,
    tp.status as plan_status,
    tp.created_at as plan_created_at,
    CASE 
        WHEN tp.id IS NULL THEN 'no_plan'
        ELSE tp.status
    END as display_status
FROM (
    VALUES 
        ('SYD', 'Sydney'),
        ('MEL', 'Melbourne'),
        ('BNE', 'Brisbane'),
        ('CNS', 'Cairns'),
        ('CFS', 'Coffs Harbour'),
        ('HBA', 'Hobart'),
        ('SCS', 'Sunshine Coast')
) AS b(code, name)
CROSS JOIN LATERAL (
    SELECT id, created_at FROM stock_snapshots ORDER BY created_at DESC LIMIT 1
) ls
LEFT JOIN transfer_plans tp ON tp.snapshot_id = ls.id AND tp.branch_code = b.code;

-- =====================================================
-- RLS POLICIES (if needed - adjust as required)
-- =====================================================
-- For now, disable RLS to allow full access
ALTER TABLE branch_avg_monthly_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_snapshot_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfer_plan_lines ENABLE ROW LEVEL SECURITY;

-- Allow all operations for anon users (adjust for production)
CREATE POLICY "Allow all for branch_avg_monthly_sales" ON branch_avg_monthly_sales FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for stock_snapshots" ON stock_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for stock_snapshot_lines" ON stock_snapshot_lines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for transfer_plans" ON transfer_plans FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for transfer_plan_lines" ON transfer_plan_lines FOR ALL USING (true) WITH CHECK (true);

-- =====================================================
-- SAMPLE DATA: Insert some test avg values (optional)
-- =====================================================
-- INSERT INTO branch_avg_monthly_sales (sku, product, avg_mth_main, avg_mth_sydney, avg_mth_melbourne) 
-- VALUES ('59008', 'R3206-TRI', 100, 25, 30);

-- =====================================================
-- WAREHOUSE CODE MAPPING (for reference)
-- =====================================================
-- Main Warehouse    -> MAIN
-- Sydney           -> SYD
-- Melbourne        -> MEL
-- Brisbane         -> BNE
-- Cairns           -> CNS
-- Coffs Harbour    -> CFS
-- Hobart           -> HBA
-- Sunshine Coast   -> SCS
-- =====================================================
