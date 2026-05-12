-- =================================================================
--  GRANT permissões para o role service_role (usado pelos scripts Node)
-- -----------------------------------------------------------------
--  O Supabase Service Key roda como role "service_role". Para acessar
--  qualquer schema custom (rapid_inv, cin7_mirror, etc) precisa GRANT
--  explícito. Para o role anon/authenticated já fizemos antes.
--
--  Idempotente. Roda em ~50ms.
-- =================================================================

GRANT USAGE  ON SCHEMA rapid_inv TO service_role;
GRANT ALL ON ALL TABLES    IN SCHEMA rapid_inv TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA rapid_inv TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA rapid_inv TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv
  GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv
  GRANT ALL ON FUNCTIONS TO service_role;

-- E (defensivo) garantir o mesmo em cin7_mirror caso esteja faltando
GRANT USAGE  ON SCHEMA cin7_mirror TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA cin7_mirror TO service_role;

DO $$
BEGIN
  RAISE NOTICE '======================================================';
  RAISE NOTICE '  service_role agora tem acesso a rapid_inv ✅';
  RAISE NOTICE '  Pode rodar: npm run rapid-inv:sync:sales:test';
  RAISE NOTICE '======================================================';
END $$;
