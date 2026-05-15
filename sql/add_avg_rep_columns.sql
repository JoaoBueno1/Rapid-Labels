-- ============================================================
-- Add `avg_rep_*` columns to branch_avg_monthly_sales.
--
-- WHY: existing `avg_mth_*` columns are populated from sales grouped by
--   from_location (the warehouse that shipped). This systematically
--   undercounts demand at branches whose orders are fulfilled from
--   Main/Gateway — the sale credits Main instead of the home branch.
--
--   `avg_rep_*` holds the sales-rep-based avg the manager curates
--   manually: it groups sales by the rep who took the order, which
--   reflects true branch-level demand.
--
-- USAGE: algorithm prefers avg_rep_* when > 0, falls back to avg_mth_*.
--
-- This migration is additive — no existing data is changed.
-- ============================================================

ALTER TABLE branch_avg_monthly_sales
  ADD COLUMN IF NOT EXISTS avg_rep_main           NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_sydney         NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_melbourne      NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_brisbane       NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_cairns         NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_coffs_harbour  NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_hobart         NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_rep_sunshine_coast NUMERIC DEFAULT 0;

COMMENT ON COLUMN branch_avg_monthly_sales.avg_rep_sydney IS 'Sales-rep-based monthly avg for Sydney (preferred over avg_mth_sydney when > 0)';
COMMENT ON COLUMN branch_avg_monthly_sales.avg_rep_main IS 'Sales-rep-based monthly avg for Main (preferred over avg_mth_main when > 0)';
