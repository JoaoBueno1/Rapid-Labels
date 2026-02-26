-- Add breakdown columns to branch_avg_monthly_sales
-- avg_sales_main    = Sale + SaleMultiple outQty / 6.53 months (sales only component)
-- avg_transfer_main = max(0, StockTransfer Out - StockTransfer In) / 6.53 months (transfer NET component)
-- avg_mth_main      = avg_sales_main + avg_transfer_main (total — already exists)

ALTER TABLE branch_avg_monthly_sales
  ADD COLUMN IF NOT EXISTS avg_sales_main    NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_transfer_main NUMERIC DEFAULT 0;

COMMENT ON COLUMN branch_avg_monthly_sales.avg_sales_main IS 'Avg monthly sales only (Sale+SaleMultiple) for Main warehouse';
COMMENT ON COLUMN branch_avg_monthly_sales.avg_transfer_main IS 'Avg monthly transfer NET (StockTransfer Out-In) from Main to branches';
