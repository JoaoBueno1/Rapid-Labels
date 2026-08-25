-- =====================================================================
-- Stock Planning · 000 · GRANTS
-- ---------------------------------------------------------------------
-- O schema rapid_inv existe desde 2026-06 mas nunca recebeu GRANT, então
-- a API inteira responde 42501 "permission denied for schema rapid_inv".
-- Este arquivo destrava. É o primeiro a rodar e pode rodar de novo sem dano.
-- =====================================================================

GRANT USAGE ON SCHEMA rapid_inv TO service_role, anon, authenticated, postgres;

GRANT ALL    ON ALL TABLES    IN SCHEMA rapid_inv TO service_role, postgres;
GRANT ALL    ON ALL SEQUENCES IN SCHEMA rapid_inv TO service_role, postgres;
GRANT ALL    ON ALL FUNCTIONS IN SCHEMA rapid_inv TO service_role, postgres;

-- O frontend lê pelo backend (pg direto), mas deixamos leitura para o caso
-- de alguém precisar via PostgREST.
GRANT SELECT ON ALL TABLES    IN SCHEMA rapid_inv TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv GRANT ALL    ON TABLES    TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv GRANT ALL    ON SEQUENCES TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA rapid_inv GRANT SELECT ON TABLES    TO anon, authenticated;

DO $$ BEGIN RAISE NOTICE 'rapid_inv: grants aplicados'; END $$;
