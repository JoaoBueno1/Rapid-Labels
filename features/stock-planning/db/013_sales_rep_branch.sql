-- ============================================================================
-- 013 — A qual filial cada sales rep pertence.
--
-- Isto não existia em lugar nenhum do banco. Foi procurado em todos os schemas:
-- só há colunas de texto livre com o nome do rep, nenhuma dizendo onde ele
-- trabalha. Tudo o que o sistema sabia era INFERIDO de onde a mercadoria saiu.
--
-- E inferir tem limite duro. Medido nos 13 meses de histórico: dos pedidos de
-- um rep de Sydney, 48,8% despacham de Sydney e 42,6% do Main — porque o Main
-- atende pedido de todo mundo. Em Brisbane isso vira empate real: os três
-- candidatos ficam em ~52% contra ~44% no Main, e nenhum passa no limite
-- inferior de Wilson. Mais dados não resolvem: a carteira é dividida mesmo.
--
-- Por isso esta tabela. O palpite estatístico continua na tela como sugestão,
-- mas quem decide é gente, e a decisão fica gravada com autor e data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.sales_rep_branch (
  sales_rep     text PRIMARY KEY,
  -- NULL é uma resposta legítima: "não é rep de filial" (o pessoal do Main),
  -- "não é pessoa" (razão social, canal de API), ou "ainda não decidimos".
  branch_code   text,
  -- Por que esta decisão. Um empate 52/44 resolvido por alguém precisa dizer
  -- em que se baseou, senão daqui a seis meses ninguém sabe se foi critério
  -- ou chute.
  note          text,
  is_active     boolean     NOT NULL DEFAULT true,
  -- O que a estatística sugeria quando a decisão foi tomada. Guardado para
  -- dar para comparar depois: se a inferência mudar muito, vale reconferir.
  inferred_branch text,
  inferred_pct    numeric,
  inferred_orders int,
  decided_by    text        NOT NULL DEFAULT 'anon',
  decided_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_srb_branch ON rapid_inv.sales_rep_branch (branch_code) WHERE branch_code IS NOT NULL;

COMMENT ON TABLE rapid_inv.sales_rep_branch IS
  'Alocação de sales rep a filial. Decisão humana; a inferência estatística fica só como sugestão na tela.';
COMMENT ON COLUMN rapid_inv.sales_rep_branch.branch_code IS
  'NULL = não é rep de filial, não é pessoa, ou ainda não decidido. É resposta válida, não falta de dado.';

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.sales_rep_branch TO anon, authenticated, service_role;
