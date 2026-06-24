-- =====================================================================
-- CONTAINER CHECK — Storage (bucket de fotos) — separado da tabela pra
-- isolar transação (se a policy de storage falhar por permissão, a
-- tabela do 001 já fica de pé).
-- Bucket público: leitura via URL pública; upload pelo anon key direto
-- do navegador (a foto não passa pelo Express).
-- =====================================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('container-check', 'container-check', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "cc photos read"   ON storage.objects;
DROP POLICY IF EXISTS "cc photos upload" ON storage.objects;
CREATE POLICY "cc photos read"   ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'container-check');
CREATE POLICY "cc photos upload" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'container-check');
