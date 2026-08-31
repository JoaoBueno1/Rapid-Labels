-- ============================================================================
-- 025 — A política por produto, e a auditoria que nunca auditou.
--
-- O Master Stock é uma CAMADA NOSSA. Ele diz como cada produto se comporta
-- dentro do Inventory Management e não toca no Cin7 — nada aqui é escrito de
-- volta no ERP. É por isso que ele pode discordar do Cin7 de propósito: o
-- Cin7 diz o que o produto É, esta tabela diz o que a gente FAZ com ele.
--
-- ── PRIMEIRO, O DEFEITO ──
--
-- rapid_inv.audit_log existe, tem o formato certo, tem DOIS gatilhos em
-- sku_settings, e está com ZERO linhas. Testado: um UPDATE passa e não grava
-- nada.
--
-- A causa está no fim de fn_audit_log:
--
--     v_id := COALESCE(NEW.id::TEXT, NEW.sku::TEXT, NEW.code::TEXT);
--     ...
--     EXCEPTION WHEN OTHERS THEN RETURN COALESCE(NEW, OLD);
--
-- sku_settings não tem coluna `id` nem `code`. Em PL/pgSQL, NEW.id numa
-- tabela sem `id` levanta erro — e o EXCEPTION engole. A intenção do
-- comentário original era boa ("nunca quebrar a operação principal por causa
-- do audit") e é ela que torna o defeito invisível: a gravação principal
-- funciona, o log fica vazio, e ninguém descobre até precisar do histórico.
--
-- O conserto é ler o campo do JSONB em vez do RECORD. `j->>'id'` devolve NULL
-- num objeto sem `id`; NEW.id levanta exceção. A mesma pergunta, feita de um
-- jeito que não estoura.
--
-- O EXCEPTION continua — mas agora avisa. Um erro engolido em silêncio é como
-- este defeito sobreviveu.
-- ============================================================================

CREATE OR REPLACE FUNCTION rapid_inv.fn_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_email TEXT;
  v_pin   TEXT;
  v_id    TEXT;
  j_new   JSONB;
  j_old   JSONB;
BEGIN
  v_email := current_setting('rapid_inv.user_email', true);
  v_pin   := current_setting('rapid_inv.user_pin',   true);
  j_new := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  j_old := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;

  -- Pelo JSONB, não pelo RECORD: ->> devolve NULL para chave ausente, e é isso
  -- que faz a função servir a qualquer tabela, com ou sem `id`.
  v_id := COALESCE(
    coalesce(j_new, j_old) ->> 'id',
    coalesce(j_new, j_old) ->> 'sku_key',
    coalesce(j_new, j_old) ->> 'sku',
    coalesce(j_new, j_old) ->> 'code');

  IF TG_OP = 'DELETE' THEN
    INSERT INTO rapid_inv.audit_log(table_name, record_id, action, old_value, user_email, user_pin)
    VALUES (TG_TABLE_NAME, v_id, 'DELETE', j_old, v_email, v_pin);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Só grava se algo mudou de verdade. Um UPDATE que reescreve o mesmo valor
    -- é ruído, e ruído num log de auditoria é o que faz ninguém abrir o log.
    IF j_old IS DISTINCT FROM j_new THEN
      INSERT INTO rapid_inv.audit_log(table_name, record_id, action, old_value, new_value, user_email, user_pin)
      VALUES (TG_TABLE_NAME, v_id, 'UPDATE', j_old, j_new, v_email, v_pin);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO rapid_inv.audit_log(table_name, record_id, action, new_value, user_email, user_pin)
    VALUES (TG_TABLE_NAME, v_id, 'INSERT', j_new, v_email, v_pin);
    RETURN NEW;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Continua não quebrando a gravação principal — mas AVISA. O silêncio aqui
  -- é o que deixou este log vazio desde que nasceu.
  RAISE WARNING '[audit] % em %.% não registrado: %',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Dois gatilhos idênticos na mesma tabela gravavam duas linhas por mudança.
-- Um deles é sobra de migração.
DROP TRIGGER IF EXISTS trg_audit_settings ON rapid_inv.sku_settings;

-- ── A POLÍTICA POR PRODUTO ──
-- Uma coluna por ferramenta, e não um único "ativo". Um produto pode fazer
-- sentido no planejamento de compra e não fazer sentido mandar para filial —
-- é montado no Main, ou o frete come a margem. Colapsar as duas perguntas numa
-- só obrigaria a escolher entre não comprar e mandar errado.
ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS use_in_planning  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS use_in_gateway   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS policy_note      text;

COMMENT ON COLUMN rapid_inv.sku_settings.use_in_replenishment IS
  'Pode ser sugerido na reposicao de filial. Nao afeta o Cin7.';
COMMENT ON COLUMN rapid_inv.sku_settings.use_in_planning IS
  'Entra na projecao e nos alertas do Stock Planning. Nao afeta o Cin7.';
COMMENT ON COLUMN rapid_inv.sku_settings.use_in_gateway IS
  'Pode ser sugerido para o Gateway. Nao afeta o Cin7.';

-- ── O QUE O CIN7 DIZ, AO LADO DO QUE NÓS DECIDIMOS ──
-- A tela precisa mostrar os dois: o status do Cin7 é informação de fora, a
-- nossa decisão é o que manda dentro do sistema. Quando discordam, o usuário
-- tem de VER que discordam — foi assim que 534 descontinuados entraram sem
-- ninguém revisar um por um.
DROP VIEW IF EXISTS rapid_inv.v_sku_policy CASCADE;
CREATE VIEW rapid_inv.v_sku_policy AS
SELECT
  upper(btrim(p.sku))                              AS sku_key,
  p.sku, p.name, p.category,
  p.status                                          AS cin7_status,
  (p.status = 'Deprecated')                         AS cin7_deprecated,
  coalesce(s.lifecycle_status, 'ACTIVE')            AS lifecycle_status,
  coalesce(s.use_in_replenishment, true)            AS use_in_replenishment,
  coalesce(s.use_in_planning, true)                 AS use_in_planning,
  coalesce(s.use_in_gateway, true)                  AS use_in_gateway,
  s.policy_note, s.replenishment_note,
  s.settings_updated_at, s.settings_updated_by,
  (s.sku_key IS NOT NULL)                           AS has_settings,
  -- O desacordo, explícito. O Cin7 aposentou e nós ainda usamos, ou o
  -- contrário. Nenhum dos dois é erro — mas os dois merecem uma olhada.
  (p.status = 'Deprecated' AND coalesce(s.lifecycle_status,'ACTIVE') = 'ACTIVE')  AS cin7_says_dead_we_say_alive,
  (p.status <> 'Deprecated' AND coalesce(s.lifecycle_status,'ACTIVE') = 'DISCONTINUED') AS cin7_says_alive_we_say_dead
FROM cin7_mirror.products p
LEFT JOIN rapid_inv.sku_settings s ON s.sku_key = upper(btrim(p.sku));

GRANT SELECT ON rapid_inv.v_sku_policy TO anon, authenticated, service_role;
