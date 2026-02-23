-- Add qty_per_ctn and qty_per_pallet columns to restock_setup
-- These store packaging info: how many units per carton and per pallet
-- Used in Restock V2 table and edit modal

ALTER TABLE restock_setup ADD COLUMN IF NOT EXISTS qty_per_ctn integer;
ALTER TABLE restock_setup ADD COLUMN IF NOT EXISTS qty_per_pallet integer;

-- Optionally migrate existing pallet_capacity_rules data into restock_setup
-- UPDATE restock_setup rs
-- SET qty_per_pallet = pcr.qty_pallet
-- FROM pallet_capacity_rules pcr
-- WHERE rs.sku = pcr.sku AND rs.qty_per_pallet IS NULL;
