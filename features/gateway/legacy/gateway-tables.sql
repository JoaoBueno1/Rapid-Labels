-- ═══════════════════════════════════════════════════════════
-- Gateway Transfer System — Database Tables
-- Run this in Supabase SQL Editor (safe to re-run)
-- ═══════════════════════════════════════════════════════════

-- 1. gateway_shelves: Physical shelf locations in the gateway area
CREATE TABLE IF NOT EXISTS public.gateway_shelves (
  id          TEXT PRIMARY KEY,                    -- e.g., 'A1', 'B2', 'E-FLOOR'
  area        TEXT NOT NULL,                       -- 'A','B','C','D','E','E-FLOOR','F','G'
  shelf_number INT,                                -- numeric part (null for E-FLOOR)
  shelf_type  TEXT NOT NULL DEFAULT 'stock',        -- 'stock', 'special', 'floor'
  label       TEXT,                                 -- human label: 'Office Files','Trash', etc.
  active      BOOLEAN DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gs_area ON public.gateway_shelves(area);
CREATE INDEX IF NOT EXISTS idx_gs_type ON public.gateway_shelves(shelf_type);

-- 2. gateway_allocations: Current items on each shelf
CREATE TABLE IF NOT EXISTS public.gateway_allocations (
  id             BIGSERIAL PRIMARY KEY,
  shelf_id       TEXT NOT NULL REFERENCES public.gateway_shelves(id),
  sku            TEXT NOT NULL,
  product_name   TEXT,
  five_dc        TEXT,                              -- 5-digit code
  qty            INT NOT NULL DEFAULT 0,
  pallet_number  TEXT,                              -- pallet # from the map
  stock_date     DATE,                              -- when stock was placed (FIFO tracking)
  transfer_ref   TEXT,                              -- Cin7 transfer reference (e.g. TR-33264)
  status         TEXT NOT NULL DEFAULT 'active',    -- 'active','transferred_out'
  allocated_by   TEXT DEFAULT 'system',
  allocated_at   TIMESTAMPTZ DEFAULT now(),
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_ga_shelf   ON public.gateway_allocations(shelf_id);
CREATE INDEX IF NOT EXISTS idx_ga_sku     ON public.gateway_allocations(sku);
CREATE INDEX IF NOT EXISTS idx_ga_status  ON public.gateway_allocations(status);
CREATE INDEX IF NOT EXISTS idx_ga_date    ON public.gateway_allocations(stock_date);
CREATE INDEX IF NOT EXISTS idx_ga_five_dc ON public.gateway_allocations(five_dc);

-- 3. gateway_movement_history: Permanent log of all movements
CREATE TABLE IF NOT EXISTS public.gateway_movement_history (
  id               BIGSERIAL PRIMARY KEY,
  direction        TEXT NOT NULL,                   -- 'inbound' or 'outbound'
  sku              TEXT NOT NULL,
  product_name     TEXT,
  five_dc          TEXT,
  qty              INT NOT NULL,
  from_shelves     TEXT,                            -- comma-separated shelf IDs
  to_location      TEXT,                            -- e.g., 'MA-GA' or shelf ID
  transfer_ref     TEXT,                            -- Cin7 transfer Number
  cin7_transfer_id TEXT,                            -- Cin7 TaskID / StockTransferID
  stock_date       DATE,
  created_by       TEXT DEFAULT 'system',
  created_at       TIMESTAMPTZ DEFAULT now(),
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS idx_gmh_direction ON public.gateway_movement_history(direction);
CREATE INDEX IF NOT EXISTS idx_gmh_sku       ON public.gateway_movement_history(sku);
CREATE INDEX IF NOT EXISTS idx_gmh_created   ON public.gateway_movement_history(created_at DESC);

-- 4. RLS policies (permissive for internal tool)
ALTER TABLE public.gateway_shelves ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_gs" ON public.gateway_shelves FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE public.gateway_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_ga" ON public.gateway_allocations FOR ALL TO anon USING (true) WITH CHECK (true);

ALTER TABLE public.gateway_movement_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_gmh" ON public.gateway_movement_history FOR ALL TO anon USING (true) WITH CHECK (true);

-- Done ✅
