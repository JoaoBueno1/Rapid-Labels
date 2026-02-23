-- ═══════════════════════════════════════════════
-- Pick Anomalies Monitor — Supabase Tables
-- Run this once in Supabase SQL Editor
-- ═══════════════════════════════════════════════

-- 1. Orders history: stores every analyzed order permanently
CREATE TABLE IF NOT EXISTS public.pick_anomaly_orders (
  id           BIGSERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  sale_id      TEXT,
  order_date   DATE,
  customer     TEXT,
  total_picks  INT DEFAULT 0,
  correct_picks INT DEFAULT 0,
  anomaly_picks INT DEFAULT 0,
  fg_count     INT DEFAULT 0,
  picks        JSONB DEFAULT '[]'::jsonb,
  fg_orders    JSONB DEFAULT '[]'::jsonb,
  analyzed_at  TIMESTAMPTZ DEFAULT now()
);

-- Index for fast listing
CREATE INDEX IF NOT EXISTS idx_pao_order_date ON public.pick_anomaly_orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_pao_analyzed_at ON public.pick_anomaly_orders(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_pao_anomaly ON public.pick_anomaly_orders(anomaly_picks) WHERE anomaly_picks > 0;

-- 2. Corrections: tracks each Stock Transfer created
CREATE TABLE IF NOT EXISTS public.pick_anomaly_corrections (
  id             BIGSERIAL PRIMARY KEY,
  order_number   TEXT NOT NULL,
  pick_id        TEXT NOT NULL,
  sku            TEXT NOT NULL,
  from_bin       TEXT,
  to_bin         TEXT,
  qty            INT DEFAULT 1,
  transfer_id    TEXT,
  transfer_ref   TEXT,
  corrected_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(order_number, pick_id)
);

CREATE INDEX IF NOT EXISTS idx_pac_order ON public.pick_anomaly_corrections(order_number);

-- 3. Sync metadata: tracks the last sync date
CREATE TABLE IF NOT EXISTS public.pick_anomaly_sync (
  id               INT PRIMARY KEY DEFAULT 1,
  last_synced_date DATE,
  last_synced_at   TIMESTAMPTZ,
  total_orders     INT DEFAULT 0
);

-- Seed sync row
INSERT INTO public.pick_anomaly_sync (id, last_synced_date, last_synced_at, total_orders)
VALUES (1, '2026-02-20', now(), 0)
ON CONFLICT (id) DO NOTHING;

-- Enable RLS but allow anon access (same pattern as cin7_mirror)
ALTER TABLE public.pick_anomaly_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pick_anomaly_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pick_anomaly_sync ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_pao" ON public.pick_anomaly_orders FOR SELECT TO anon USING (true);
CREATE POLICY "anon_write_pao" ON public.pick_anomaly_orders FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_read_pac" ON public.pick_anomaly_corrections FOR SELECT TO anon USING (true);
CREATE POLICY "anon_write_pac" ON public.pick_anomaly_corrections FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon_read_pas" ON public.pick_anomaly_sync FOR SELECT TO anon USING (true);
CREATE POLICY "anon_write_pas" ON public.pick_anomaly_sync FOR ALL TO anon USING (true) WITH CHECK (true);
