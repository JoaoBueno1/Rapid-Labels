-- ============================================================================
-- 020 — Contêineres, e as decisões por produto.
--
-- Duas coisas que a tela precisa e que hoje não existem em lugar nenhum:
-- a capacidade de um contêiner, e a decisão de quem manda no produto.
-- ============================================================================

-- ── CAPACIDADE DE CONTÊINER ────────────────────────────────────────────
-- Vira TABELA e não constante no código porque estes números não são lei da
-- física: o volume útil depende de paletizar ou não, e a carga paga depende
-- da tara do contêiner e do limite de estrada do país. Quem carrega sabe
-- disso e vai querer ajustar sem esperar um deploy.
--
-- Os valores abaixo são o interno nominal do contêiner de aço padrão. O
-- `usable_pct` é o que separa o número do catálogo do número real: ninguém
-- enche um contêiner a 100%, e apresentar o nominal como se coubesse tudo é
-- a forma mais fácil de prometer uma carga que não fecha.
CREATE TABLE IF NOT EXISTS rapid_inv.container_type (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  cbm_internal numeric NOT NULL,      -- volume interno nominal, m³
  usable_pct   numeric NOT NULL DEFAULT 85,   -- quanto disso se usa na prática
  payload_kg   numeric NOT NULL,      -- carga paga
  sort_order   int NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  note         text
);

INSERT INTO rapid_inv.container_type (code, name, cbm_internal, usable_pct, payload_kg, sort_order, note) VALUES
  ('20GP', '20ft standard',  33.2, 85, 28200, 10, 'Interno nominal 5,90 x 2,35 x 2,39 m'),
  ('40GP', '40ft standard',  67.7, 85, 26700, 20, 'Interno nominal 12,03 x 2,35 x 2,39 m'),
  ('40HC', '40ft high cube', 76.4, 85, 26500, 30, 'Mesmo comprimento do 40GP, 30 cm a mais de altura')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, cbm_internal = EXCLUDED.cbm_internal,
  payload_kg = EXCLUDED.payload_kg, sort_order = EXCLUDED.sort_order, note = EXCLUDED.note;

COMMENT ON COLUMN rapid_inv.container_type.usable_pct IS
  'Quanto do volume interno se usa de fato. Apresentar o nominal como se coubesse tudo promete carga que nao fecha.';

-- ── DECISÕES POR PRODUTO ───────────────────────────────────────────────
-- `is_planned` já existe e diz se o SKU entra no arquivo de planejamento.
-- Estas são outras duas perguntas, e misturá-las com aquela seria errado:
-- um produto pode ser planejado para compra e mesmo assim não fazer sentido
-- mandar para filial (é montado no Main, ou é volumoso demais para o frete).
ALTER TABLE rapid_inv.sku_settings
  ADD COLUMN IF NOT EXISTS use_in_replenishment boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS replenishment_note   text,
  ADD COLUMN IF NOT EXISTS settings_updated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS settings_updated_by  text;

COMMENT ON COLUMN rapid_inv.sku_settings.use_in_replenishment IS
  'Se o SKU pode ser sugerido na reposicao de filial. Pergunta diferente de is_planned: da para comprar sem fazer sentido mandar para filial.';

-- O default é true, mas há dois grupos que já se sabe que não devem ir para
-- filial, e deixá-los ligados faria a pessoa ter que desligar 650 na mão:
--   os SKUs de caixa (-CartonNN), que já são a mesma unidade contada duas vezes
--   os descontinuados
-- Isto roda UMA vez, na criação da coluna, e não sobrescreve decisão humana
-- depois porque só toca em quem nunca foi tocado (settings_updated_at IS NULL).
UPDATE rapid_inv.sku_settings s
   SET use_in_replenishment = false,
       replenishment_note = 'Desligado automaticamente: SKU de caixa (-CartonNN)'
 WHERE s.settings_updated_at IS NULL
   AND s.use_in_replenishment
   AND s.sku ~* 'carton[0-9]*$';

UPDATE rapid_inv.sku_settings s
   SET use_in_replenishment = false,
       replenishment_note = 'Desligado automaticamente: ciclo de vida DISCONTINUED'
 WHERE s.settings_updated_at IS NULL
   AND s.use_in_replenishment
   AND s.lifecycle_status = 'DISCONTINUED';

GRANT SELECT ON rapid_inv.container_type TO anon, authenticated, service_role;
GRANT INSERT, UPDATE ON rapid_inv.container_type TO service_role;
