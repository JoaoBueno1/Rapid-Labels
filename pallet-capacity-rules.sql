-- ============================================
-- PALLET CAPACITY RULES TABLE
-- ============================================
-- Purpose: Defines the expected units per bin/shelf location for each SKU
-- Used by: Stock Anomaly Checker page
-- 
-- This table is separate from restock_setup (pickface capacity)
-- and is used to detect bin/shelf anomalies.
-- ============================================

-- Create the table if it doesn't exist
CREATE TABLE IF NOT EXISTS pallet_capacity_rules (
    id SERIAL PRIMARY KEY,
    dc TEXT DEFAULT 'DEFAULT',
    sku TEXT NOT NULL,
    qty_pallet INTEGER NOT NULL CHECK (qty_pallet > 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(dc, sku)
);

-- Create index on SKU for fast lookups
CREATE INDEX IF NOT EXISTS idx_pallet_capacity_rules_sku ON pallet_capacity_rules(sku);

-- Create index on DC for filtering by distribution center
CREATE INDEX IF NOT EXISTS idx_pallet_capacity_rules_dc ON pallet_capacity_rules(dc);

-- Add comment to table
COMMENT ON TABLE pallet_capacity_rules IS 'Defines expected pallet quantities for bin/shelf locations by SKU';
COMMENT ON COLUMN pallet_capacity_rules.dc IS 'Distribution Center code (default: DEFAULT for single-DC systems)';
COMMENT ON COLUMN pallet_capacity_rules.sku IS 'Product SKU';
COMMENT ON COLUMN pallet_capacity_rules.qty_pallet IS 'Expected units per pallet/bin location (must be > 0)';

-- Enable RLS (Row Level Security) if needed
-- ALTER TABLE pallet_capacity_rules ENABLE ROW LEVEL SECURITY;

-- Grant access to anon role for Supabase
GRANT SELECT, INSERT, UPDATE, DELETE ON pallet_capacity_rules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON pallet_capacity_rules TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE pallet_capacity_rules_id_seq TO anon;
GRANT USAGE, SELECT ON SEQUENCE pallet_capacity_rules_id_seq TO authenticated;

-- ============================================
-- EXAMPLE DATA
-- ============================================
-- Example: SKU r3206-tri should have 90 units per bin location
-- INSERT INTO pallet_capacity_rules (dc, sku, qty_pallet) VALUES 
--   ('DEFAULT', 'r3206-tri', 90),
--   ('DEFAULT', 'r1234-abc', 120),
--   ('DEFAULT', 'r5678-xyz', 60);

-- ============================================
-- OPTIONAL: ANOMALY REPORTS TABLES
-- ============================================
-- Uncomment if you want to persist report history

-- CREATE TABLE IF NOT EXISTS anomaly_reports (
--     id SERIAL PRIMARY KEY,
--     dc TEXT DEFAULT 'DEFAULT',
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
--     created_by TEXT,
--     total_count INTEGER DEFAULT 0,
--     pickface_count INTEGER DEFAULT 0,
--     bin_count INTEGER DEFAULT 0
-- );

-- CREATE TABLE IF NOT EXISTS anomaly_report_items (
--     id SERIAL PRIMARY KEY,
--     report_id INTEGER REFERENCES anomaly_reports(id) ON DELETE CASCADE,
--     sku TEXT NOT NULL,
--     type TEXT NOT NULL CHECK (type IN ('PICKFACE', 'BIN')),
--     location TEXT NOT NULL,
--     qty INTEGER NOT NULL,
--     expected INTEGER NOT NULL,
--     diff INTEGER NOT NULL,
--     description TEXT
-- );

-- CREATE INDEX IF NOT EXISTS idx_anomaly_report_items_report_id ON anomaly_report_items(report_id);

-- GRANT SELECT, INSERT, UPDATE, DELETE ON anomaly_reports TO anon;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON anomaly_reports TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON anomaly_report_items TO anon;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON anomaly_report_items TO authenticated;
-- GRANT USAGE, SELECT ON SEQUENCE anomaly_reports_id_seq TO anon;
-- GRANT USAGE, SELECT ON SEQUENCE anomaly_reports_id_seq TO authenticated;
-- GRANT USAGE, SELECT ON SEQUENCE anomaly_report_items_id_seq TO anon;
-- GRANT USAGE, SELECT ON SEQUENCE anomaly_report_items_id_seq TO authenticated;
