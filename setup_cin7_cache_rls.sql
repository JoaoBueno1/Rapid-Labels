-- ==============================================
-- Configuração de RLS para cin7_orders_cache
-- ==============================================
-- 
-- Este script configura Row Level Security (RLS) para permitir
-- acesso público read-only à tabela cin7_orders_cache
-- 
-- Uso:
-- Execute este SQL no Supabase SQL Editor (Dashboard > SQL Editor)
-- ==============================================

-- 1. Ativar RLS na tabela cin7_orders_cache
ALTER TABLE cin7_orders_cache ENABLE ROW LEVEL SECURITY;

-- 2. Criar política de SELECT público (read-only)
-- Permite que qualquer usuário (incluindo anônimos) leia os dados
CREATE POLICY "Allow public read access to cin7 cache"
ON cin7_orders_cache
FOR SELECT
USING (true);

-- ==============================================
-- Verificação
-- ==============================================

-- Para verificar se RLS está ativo:
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' AND tablename = 'cin7_orders_cache';
-- Resultado esperado: rowsecurity = true

-- Para listar as políticas ativas:
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'cin7_orders_cache';
-- Deve mostrar a política "Allow public read access to cin7 cache"

-- ==============================================
-- Notas de Segurança
-- ==============================================
-- 
-- ✅ Seguro: SELECT (leitura) é público
-- ❌ Protegido: INSERT, UPDATE, DELETE requerem autenticação
-- 
-- Usuários anônimos (usando SUPABASE_ANON_KEY) podem:
-- - ✅ Consultar ordens (SELECT)
-- - ✅ Buscar por referência
-- - ✅ Listar ordens
-- 
-- Usuários anônimos NÃO podem:
-- - ❌ Inserir novas ordens (INSERT)
-- - ❌ Atualizar ordens (UPDATE)
-- - ❌ Deletar ordens (DELETE)
-- 
-- Apenas usuários autenticados ou service_role key podem modificar dados.
-- ==============================================

-- ==============================================
-- Rollback (se necessário)
-- ==============================================
-- 
-- Para DESABILITAR RLS (não recomendado):
-- ALTER TABLE cin7_orders_cache DISABLE ROW LEVEL SECURITY;
--
-- Para REMOVER a política:
-- DROP POLICY IF EXISTS "Allow public read access to cin7 cache" ON cin7_orders_cache;
-- ==============================================
