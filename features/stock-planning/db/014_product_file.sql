-- ============================================================================
-- 014 — O "Product Stock File", o que a empresa mantém fora do Cin7.
--
-- O usuário guarda numa planilha de 27 abas o que o ERP não tem ou tem
-- desatualizado: dimensões, CBM, volume por caixa, custo de frete rateado,
-- e o espaço de pickface. Medido no arquivo de 2024:
--
--   Product Summary  2.032 linhas  RAPID CODE casa com sku em 1.998
--   Stock Volume     3.928 linhas  Item No. casa com o 5DC em 3.710
--   Pickaybay space  1.340 linhas  SKU casa direto em 1.324
--
-- Três abas, três chaves diferentes. Errar a chave aqui dá zero silencioso:
-- na primeira tentativa juntei Stock Volume por SKU e casou 1 linha de 3.928.
--
-- Esta tabela é STAGING: guarda o arquivo como ele é, sem julgar. Quem decide
-- qual fonte vale é a view de reconciliação, e a tela mostra as duas quando
-- discordam — o objetivo é o usuário ver a divergência e corrigir a origem,
-- não o sistema escolher em silêncio.
-- ============================================================================

CREATE TABLE IF NOT EXISTS rapid_inv.product_file (
  sku_key        text PRIMARY KEY,
  sku            text,
  dc             text,              -- 5DC, quando o arquivo traz
  description    text,
  supplier       text,
  -- Dimensões e volume: a razão principal de este arquivo existir. O Cin7
  -- cobre 35,8% dos SKUs ativos; aqui há 1.930 com largura e altura.
  length_mm      numeric,
  width_mm       numeric,
  height_mm      numeric,
  cbm            numeric,
  each_volume    numeric,
  ctn_volume     numeric,
  carton_qty     numeric,
  -- Custo e frete rateado, que o ERP não calcula.
  cost_usd       numeric,
  cost_aud       numeric,
  avg_cost       numeric,
  freight_each   numeric,
  unit_price     numeric,
  sell_price     numeric,
  -- Espaço de pickface: quantas unidades cabem na posição de separação.
  pickbay        text,
  source_sheets  text[],            -- de quais abas esta linha veio
  imported_at    timestamptz NOT NULL DEFAULT now(),
  source_file    text
);

CREATE INDEX IF NOT EXISTS ix_pf_dc ON rapid_inv.product_file (dc) WHERE dc IS NOT NULL;

COMMENT ON TABLE rapid_inv.product_file IS
  'Staging do Product Stock File. Guarda o arquivo como ele é; a reconciliação com o Cin7 é feita em view.';
COMMENT ON COLUMN rapid_inv.product_file.source_sheets IS
  'De quais abas do arquivo esta linha recebeu dado. Três abas usam três chaves diferentes.';

GRANT SELECT, INSERT, UPDATE, DELETE ON rapid_inv.product_file TO anon, authenticated, service_role;
