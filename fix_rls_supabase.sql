-- =====================================================
-- DIAGNÓSTICO E CORREÇÃO DO RLS
-- Execute no Supabase SQL Editor
-- =====================================================

-- 1️⃣ VERIFICAR SE RLS ESTÁ ATIVO
SELECT 
    schemaname,
    tablename, 
    rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename = 'cin7_orders_cache';

-- Se rls_enabled = true, o RLS está ativo
-- Se rls_enabled = false, o RLS está desativado

-- =====================================================

-- 2️⃣ VERIFICAR POLÍTICAS EXISTENTES
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies
WHERE tablename = 'cin7_orders_cache';

-- Deve mostrar pelo menos uma política de SELECT
-- Se não mostrar nada, não há políticas configuradas

-- =====================================================

-- 3️⃣ SOLUÇÃO RÁPIDA: DESABILITAR RLS TEMPORARIAMENTE
-- ⚠️ Use apenas para TESTE - não recomendado em produção

ALTER TABLE cin7_orders_cache DISABLE ROW LEVEL SECURITY;

-- Agora teste novamente o test-supabase-cache.html
-- Se funcionar, o problema é o RLS

-- =====================================================

-- 4️⃣ SOLUÇÃO PERMANENTE: RECONFIGURAR RLS CORRETAMENTE

-- Primeiro, limpar políticas antigas (se existirem)
DROP POLICY IF EXISTS "Allow public read access to cin7 cache" ON cin7_orders_cache;
DROP POLICY IF EXISTS "Enable read access for all users" ON cin7_orders_cache;
DROP POLICY IF EXISTS "Public read access" ON cin7_orders_cache;

-- Reativar RLS
ALTER TABLE cin7_orders_cache ENABLE ROW LEVEL SECURITY;

-- Criar política correta para SELECT público (anon key)
CREATE POLICY "allow_public_select"
ON cin7_orders_cache
FOR SELECT
TO public
USING (true);

-- Criar política para INSERT/UPDATE (apenas authenticated ou service_role)
CREATE POLICY "allow_authenticated_all"
ON cin7_orders_cache
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- =====================================================

-- 5️⃣ VERIFICAR SE FUNCIONOU

-- Testar query simples
SELECT COUNT(*) as total_orders FROM cin7_orders_cache;

-- Listar algumas ordens
SELECT 
    cin7_reference, 
    customer_name, 
    synced_at 
FROM cin7_orders_cache 
ORDER BY synced_at DESC 
LIMIT 5;

-- Buscar ordem específica
SELECT * FROM cin7_orders_cache WHERE cin7_reference = 'SO-237088';

-- =====================================================

-- 6️⃣ VERIFICAR PERMISSÕES DA ANON KEY

-- Verificar role do anon
SELECT current_user, session_user;

-- Se aparecer "anon", está correto
-- Se aparecer "postgres" ou outro, você está usando credencial errada

-- =====================================================

-- 📋 RESUMO DE COMANDOS ÚTEIS:

-- Desabilitar RLS (para teste):
-- ALTER TABLE cin7_orders_cache DISABLE ROW LEVEL SECURITY;

-- Habilitar RLS:
-- ALTER TABLE cin7_orders_cache ENABLE ROW LEVEL SECURITY;

-- Ver todas as políticas:
-- SELECT * FROM pg_policies WHERE tablename = 'cin7_orders_cache';

-- Deletar todas as políticas:
-- DROP POLICY IF EXISTS "nome_da_politica" ON cin7_orders_cache;

-- =====================================================
