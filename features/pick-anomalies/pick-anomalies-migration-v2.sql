-- ═══════════════════════════════════════════════
-- Pick Anomalies Monitor — V2 Migration
-- Run this in Supabase SQL Editor (safe to re-run)
-- ═══════════════════════════════════════════════

-- 1. Add fulfilled_date to pick_anomaly_orders
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS fulfilled_date DATE;

-- 2. Add reviewed_by to pick_anomaly_orders
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS reviewed BOOLEAN DEFAULT FALSE;

ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- 3. Add order_status column (stores Cin7 status like FULFILLED, INVOICED, etc.)
ALTER TABLE public.pick_anomaly_orders
  ADD COLUMN IF NOT EXISTS order_status TEXT;

-- 4. Add transfer_status to corrections (may already exist)
ALTER TABLE public.pick_anomaly_corrections
  ADD COLUMN IF NOT EXISTS transfer_status TEXT DEFAULT 'DRAFT';

-- 5. Create the action log table
CREATE TABLE IF NOT EXISTS public.pick_anomaly_logs (
  id           BIGSERIAL PRIMARY KEY,
  order_number TEXT NOT NULL,
  action       TEXT NOT NULL,         -- 'synced', 'reviewed', 'correction_created', 'correction_completed'
  details      TEXT,                  -- Human-readable description
  user_email   TEXT DEFAULT 'system', -- Who performed the action
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pal_order ON public.pick_anomaly_logs(order_number);
CREATE INDEX IF NOT EXISTS idx_pal_created ON public.pick_anomaly_logs(created_at DESC);

-- 6. Index for fulfilled_date
CREATE INDEX IF NOT EXISTS idx_pao_fulfilled_date ON public.pick_anomaly_orders(fulfilled_date DESC);

-- 7. RLS for logs table
ALTER TABLE public.pick_anomaly_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_pal" ON public.pick_anomaly_logs FOR SELECT TO anon USING (true);
CREATE POLICY "anon_write_pal" ON public.pick_anomaly_logs FOR ALL TO anon USING (true) WITH CHECK (true);
