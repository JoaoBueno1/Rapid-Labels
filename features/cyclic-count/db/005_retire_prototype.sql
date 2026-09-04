-- =====================================================================
-- Cyclic Count | 005 | APOSENTA O PROTOTIPO DE 2025
-- ---------------------------------------------------------------------
-- Em 21/11/2025 nasceu uma primeira tentativa de contagem ciclica:
-- cyclic-count.html/.js e count-form.html/.js na raiz do repo, com as
-- tabelas count_sessions e count_session_items. Nunca entrou em operacao.
--
-- A prova, conferida antes de escrever isto:
--   · nunca esteve no menu (shared/rail.js nao cita nenhum dos quatro);
--   · count_sessions tem UMA linha, de 21/11/2025, status 'pending',
--     submitted_at NULL — a sessao de teste do dia em que foi construida,
--     que ninguem chegou a preencher;
--   · as rotas /api/fetch-product e /api/cyclic-sync faziam
--     require('./cin7-sync-service'), e esse arquivo NAO EXISTE no repo.
--     Elas estouravam em runtime desde sempre.
--
-- O modulo vivo e features/cyclic-count/. As quatro paginas, os dois
-- uploaders orfaos e as sete rotas mortas sairam no mesmo commit deste
-- arquivo.
--
-- APLICAR: colar no SQL Editor do Supabase e rodar.
--
-- IRREVERSIVEL. A unica linha de dado que cai e a sessao pendente acima.
-- =====================================================================

DROP TABLE IF EXISTS public.count_session_items;
DROP TABLE IF EXISTS public.count_sessions;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name IN ('count_sessions','count_session_items');
  IF n = 0 THEN
    RAISE NOTICE '005: prototipo de 2025 aposentado (count_sessions e count_session_items removidas)';
  ELSE
    RAISE WARNING '005: ainda restam % tabela(s) count_*', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- NAO INCLUIDO AQUI, DE PROPOSITO: as tabelas audit_*
--
-- Com a saida das quatro paginas e dos dois uploaders, ninguem mais le:
--
--     audit_stock_analysis      5.208 linhas   ultimo 22/11/2025
--     audit_products               94 linhas   ultimo 21/11/2025
--     audit_runs                   28 linhas
--     audit_warehouses              8 linhas   ultimo 21/11/2025
--     audit_order_aggregates        0 linhas
--
-- Sao orfas, mas 5.208 delas sao analise de verdade de uma semana de
-- novembro de 2025. Apagar historico real e uma decisao a se tomar de
-- proposito, nao um efeito colateral de aposentar um prototipo. Quando
-- decidir, a instrucao e esta:
--
--     DROP TABLE IF EXISTS public.audit_stock_analysis;
--     DROP TABLE IF EXISTS public.audit_order_aggregates;
--     DROP TABLE IF EXISTS public.audit_runs;
--     DROP TABLE IF EXISTS public.audit_products;
--     DROP TABLE IF EXISTS public.audit_warehouses;
--
-- Registrado tambem em docs/DEAD_CODE_REGISTER.md.
-- ---------------------------------------------------------------------
