-- =====================================================================
-- Cyclic Count | 004 | FUNCOES DE ESCRITA
-- ---------------------------------------------------------------------
-- Por que funcao e nao SQL na rota: o transporte deste modulo e o
-- public.sp_exec, e ele executa UMA statement por transacao. Congelar uma
-- rodada e "inserir 44 linhas E mudar o status" — duas statements. Feito de
-- fora, um erro no meio deixa rodada com linhas e status de rascunho, ou
-- status de enviada e nenhuma linha. Aqui e tudo ou nada.
--
-- Mesmo padrao de features/stock-planning/db/030_write_fns.sql.
--
-- APLICAR: colar no SQL Editor do Supabase e rodar. Idempotente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- cc_create_rounds — abre as rodadas em rascunho da semana.
--
-- Idempotente pela unique (filial, semana, lista): rodar duas vezes nao cria
-- rodada dobrada, e por isso o botao "Open the week" pode ser clicado sem medo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_create_rounds(
  p_week_start DATE,
  p_list_id    BIGINT,
  p_branches   TEXT[],
  p_due_date   DATE DEFAULT NULL,
  p_actor      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_created INT := 0;
  v_ids     BIGINT[];
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_actor, 'anon'), true);

  IF NOT EXISTS (SELECT 1 FROM rapid_inv.cc_list WHERE id = p_list_id) THEN
    RAISE EXCEPTION 'Lista % nao existe', p_list_id;
  END IF;

  WITH alvo AS (
    SELECT w.code
      FROM rapid_inv.warehouses w
     WHERE w.cc_enabled
       AND (p_branches IS NULL OR array_length(p_branches, 1) IS NULL OR w.code = ANY(p_branches))
  ), novo AS (
    INSERT INTO rapid_inv.cc_round (branch_code, list_id, week_start, due_date, status, updated_by)
    SELECT a.code, p_list_id, p_week_start, p_due_date, 'draft', p_actor
      FROM alvo a
    ON CONFLICT (branch_code, week_start, list_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::INT, COALESCE(array_agg(id), '{}') INTO v_created, v_ids FROM novo;

  RETURN jsonb_build_object('created', v_created, 'round_ids', to_jsonb(v_ids));
END $fn$;

-- ---------------------------------------------------------------------
-- cc_dispatch_round — O CONGELAMENTO.
--
-- Grava, por linha, o estoque do deposito e o custo unitario do momento.
-- Depois disso nada nesta rodada muda sozinho: trocar a lista, o custo medio
-- ou o estoque nao mexe mais numa contagem que ja saiu.
--
-- COALESCE(on_hand, 0) e deliberado: `ref/productavailability` do Cin7 OMITE
-- item zerado, entao SKU ausente do espelho significa zero, nao desconhecido.
-- E o mesmo IF(ISNA(VLOOKUP(...)),0,...) que o workbook faz.
--
-- Custo NAO leva COALESCE: sem custo o valor em dolar fica NULL e a tela conta
-- a linha em lines_no_cost. Zero ali seria dizer "esta faltando R$ 0,00".
--
-- status vira 'sent' aqui, e nao depois do e-mail, porque e aqui que a folha
-- passa a existir para a filial. Se o e-mail falhar, a folha continua valida
-- e o board mostra o envio como falho — sao dois fatos diferentes.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_dispatch_round(
  p_round_id BIGINT,
  p_source   TEXT,
  p_age_min  INT DEFAULT NULL,
  p_actor    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_r       rapid_inv.cc_round%ROWTYPE;
  v_lines   INT := 0;
  v_nocost  INT := 0;
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_actor, 'anon'), true);

  SELECT * INTO v_r FROM rapid_inv.cc_round WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rodada % nao existe', p_round_id;
  END IF;
  IF v_r.status <> 'draft' THEN
    RAISE EXCEPTION 'Rodada % esta em "%": so rascunho pode ser disparado', p_round_id, v_r.status;
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('CIN7_REFRESH','MIRROR') THEN
    RAISE EXCEPTION 'snapshot_source invalido: %', p_source;
  END IF;

  DELETE FROM rapid_inv.cc_round_line WHERE round_id = p_round_id;

  INSERT INTO rapid_inv.cc_round_line
        (round_id, sku, sku_code, product_name, sort_order, system_qty, unit_cost_aud, updated_by)
  SELECT p_round_id,
         upper(btrim(i.sku)),
         i.sku_code,
         p.name,                          -- cin7_mirror.products chama de "name", nao product_name
         i.sort_order,
         COALESCE(s.on_hand, 0),
         c.unit_cost_aud,
         p_actor
    FROM rapid_inv.cc_list_item i
    LEFT JOIN rapid_inv.v_cc_branch_soh s
           ON s.branch_code = v_r.branch_code AND s.sku = upper(btrim(i.sku))
    LEFT JOIN rapid_inv.v_cc_sku_cost c
           ON c.sku = upper(btrim(i.sku))
    LEFT JOIN cin7_mirror.products p
           ON upper(btrim(p.sku)) = upper(btrim(i.sku))
   WHERE i.list_id = v_r.list_id;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'Lista da rodada % nao tem nenhum item', p_round_id;
  END IF;

  SELECT count(*)::INT INTO v_nocost
    FROM rapid_inv.cc_round_line WHERE round_id = p_round_id AND unit_cost_aud IS NULL;

  UPDATE rapid_inv.cc_round
     SET status           = 'sent',
         snapshot_at      = now(),
         snapshot_source  = p_source,
         snapshot_age_min = p_age_min,
         updated_by       = p_actor
   WHERE id = p_round_id;

  RETURN jsonb_build_object(
    'round_id', p_round_id, 'lines', v_lines, 'lines_no_cost', v_nocost,
    'token', v_r.token, 'branch_code', v_r.branch_code, 'snapshot_source', p_source);
END $fn$;

-- ---------------------------------------------------------------------
-- cc_save_counts — a filial digitando.
--
-- p_counts e um objeto {"SKU": numero|null}. null apaga a contagem daquela
-- linha (apagar o campo tem que ser possivel: quem digitou 100 no lugar errado
-- precisa poder limpar, e nao substituir por 0, que significa "contei, nao tem").
--
-- So aceita rodada em 'sent'. Depois de entregue, a folha esta travada — e e
-- essa trava que impede alguem "recontar" depois de ver a diferenca.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_save_counts(
  p_token  TEXT,
  p_counts JSONB,
  p_by     TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_r       rapid_inv.cc_round%ROWTYPE;
  v_touched INT := 0;
  v_done    INT := 0;
  v_total   INT := 0;
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_by, 'branch'), true);

  SELECT * INTO v_r FROM rapid_inv.cc_round WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link invalido';
  END IF;
  IF v_r.status <> 'sent' THEN
    RAISE EXCEPTION 'Esta contagem esta em "%" e nao aceita mais alteracao', v_r.status;
  END IF;
  IF p_counts IS NULL OR jsonb_typeof(p_counts) <> 'object' THEN
    RAISE EXCEPTION 'Formato invalido';
  END IF;

  UPDATE rapid_inv.cc_round_line li
     SET counted_qty = CASE WHEN jsonb_typeof(e.value) = 'null' THEN NULL
                            ELSE (e.value #>> '{}')::NUMERIC END,
         counted_at  = CASE WHEN jsonb_typeof(e.value) = 'null' THEN NULL ELSE now() END,
         updated_by  = p_by
    FROM jsonb_each(p_counts) AS e(key, value)
   WHERE li.round_id = v_r.id
     AND upper(btrim(li.sku)) = upper(btrim(e.key));

  GET DIAGNOSTICS v_touched = ROW_COUNT;

  SELECT count(*)::INT, count(counted_qty)::INT INTO v_total, v_done
    FROM rapid_inv.cc_round_line WHERE round_id = v_r.id;

  RETURN jsonb_build_object('saved', v_touched, 'counted', v_done, 'total', v_total);
END $fn$;

-- ---------------------------------------------------------------------
-- cc_submit_round — a filial entrega.
--
-- Exige TODAS as linhas preenchidas. Contagem pela metade entregue vira
-- variancia falsa: linha sem numero nao e "zero encontrado", e se entrar como
-- entregue alguem vai tratar a diferenca de um item que ninguem olhou.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_submit_round(
  p_token TEXT,
  p_by    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE
  v_r     rapid_inv.cc_round%ROWTYPE;
  v_miss  INT;
  v_total INT;
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_by, 'branch'), true);

  SELECT * INTO v_r FROM rapid_inv.cc_round WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Link invalido';
  END IF;
  IF v_r.status = 'submitted' OR v_r.status = 'review' OR v_r.status = 'closed' THEN
    RETURN jsonb_build_object('already', true, 'status', v_r.status,
                              'submitted_at', v_r.submitted_at, 'submitted_by', v_r.submitted_by);
  END IF;
  IF v_r.status <> 'sent' THEN
    RAISE EXCEPTION 'Esta contagem esta em "%" e nao pode ser entregue', v_r.status;
  END IF;

  SELECT count(*)::INT, count(*) FILTER (WHERE counted_qty IS NULL)::INT
    INTO v_total, v_miss
    FROM rapid_inv.cc_round_line WHERE round_id = v_r.id;

  IF v_miss > 0 THEN
    RAISE EXCEPTION 'Faltam % de % itens sem contagem', v_miss, v_total;
  END IF;

  UPDATE rapid_inv.cc_round
     SET status = 'submitted', submitted_at = now(),
         submitted_by = NULLIF(btrim(COALESCE(p_by, '')), ''), updated_by = p_by
   WHERE id = v_r.id;

  RETURN jsonb_build_object('ok', true, 'round_id', v_r.id, 'total', v_total);
END $fn$;

-- ---------------------------------------------------------------------
-- cc_close_round — o gestor fecha depois de tratar.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_close_round(
  p_round_id BIGINT,
  p_actor    TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, cin7_mirror, public
AS $fn$
DECLARE v_r rapid_inv.cc_round%ROWTYPE;
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_actor, 'anon'), true);

  SELECT * INTO v_r FROM rapid_inv.cc_round WHERE id = p_round_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rodada % nao existe', p_round_id; END IF;
  IF v_r.status NOT IN ('submitted','review') THEN
    RAISE EXCEPTION 'Rodada % esta em "%": so entregue ou em revisao pode fechar', p_round_id, v_r.status;
  END IF;

  UPDATE rapid_inv.cc_round
     SET status = 'closed', closed_at = now(), closed_by = p_actor, updated_by = p_actor
   WHERE id = p_round_id;

  RETURN jsonb_build_object('ok', true, 'round_id', p_round_id);
END $fn$;

-- ---------------------------------------------------------------------
-- cc_reorder_list — a ordem da folha, numa statement.
-- p_order e ["SKU-A","SKU-B",...] na ordem desejada.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rapid_inv.cc_reorder_list(
  p_list_id BIGINT,
  p_order   JSONB,
  p_actor   TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = rapid_inv, public
AS $fn$
DECLARE v_n INT := 0;
BEGIN
  PERFORM set_config('rapid_inv.user_email', COALESCE(p_actor, 'anon'), true);

  UPDATE rapid_inv.cc_list_item i
     SET sort_order = o.ord, updated_by = p_actor
    FROM (SELECT upper(btrim(value #>> '{}')) AS sku, ordinality::INT AS ord
            FROM jsonb_array_elements(p_order) WITH ORDINALITY) o
   WHERE i.list_id = p_list_id AND upper(btrim(i.sku)) = o.sku;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('reordered', v_n);
END $fn$;

-- ---------------------------------------------------------------------
-- Execucao so pelo service_role: a chave e do servidor, nunca do navegador.
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION rapid_inv.cc_create_rounds(DATE,BIGINT,TEXT[],DATE,TEXT)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rapid_inv.cc_dispatch_round(BIGINT,TEXT,INT,TEXT)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rapid_inv.cc_save_counts(TEXT,JSONB,TEXT)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rapid_inv.cc_submit_round(TEXT,TEXT)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rapid_inv.cc_close_round(BIGINT,TEXT)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION rapid_inv.cc_reorder_list(BIGINT,JSONB,TEXT)               FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION rapid_inv.cc_create_rounds(DATE,BIGINT,TEXT[],DATE,TEXT) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION rapid_inv.cc_dispatch_round(BIGINT,TEXT,INT,TEXT)        TO service_role, postgres;
GRANT EXECUTE ON FUNCTION rapid_inv.cc_save_counts(TEXT,JSONB,TEXT)                TO service_role, postgres;
GRANT EXECUTE ON FUNCTION rapid_inv.cc_submit_round(TEXT,TEXT)                     TO service_role, postgres;
GRANT EXECUTE ON FUNCTION rapid_inv.cc_close_round(BIGINT,TEXT)                    TO service_role, postgres;
GRANT EXECUTE ON FUNCTION rapid_inv.cc_reorder_list(BIGINT,JSONB,TEXT)             TO service_role, postgres;

DO $$ BEGIN RAISE NOTICE '004_write_fns: 6 funcoes de escrita prontas'; END $$;
