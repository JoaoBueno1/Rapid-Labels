-- ============================================================================
-- 021 — O cubo de cada SKU, com a fonte declarada.
--
-- Este arquivo existe porque a primeira leitura dos dados me levou à conclusão
-- errada. Olhei só o arquivo, achei 9 SKUs de 11.307 com cubo confiável e
-- concluí que o contêiner não tinha base. O arquivo é mesmo ruim — 1.284 das
-- 1.339 linhas com dimensão estão em milímetro com o CBM calculado como se
-- fossem centímetros, 1000x maior. Mas o Cin7 é outra fonte, e nele há
-- 3.372 SKUs com as três medidas presentes e nenhuma acima de 100 cm.
-- 40% dos ativos. Isso monta contêiner.
--
-- O QUE NÃO DÁ PARA RESOLVER SOZINHO, e por isso sai declarado em vez de
-- escondido: as duas fontes discordam sobre estarem medindo a UNIDADE ou a
-- CAIXA, e a discordância não é sistemática.
--   R1313-WH-24W-CW-60  Cin7 0,01107  ≈ o CBM de CAIXA do arquivo (0,010825)
--   R6241-WH-TRI        Cin7 0,01189  ≈ o CBM por UNIDADE do arquivo (0,01321)
--   R3240-BK-MED-60     Cin7 0,03834  vs 0,08946 do arquivo — 2,3x, nenhum dos dois
--
-- E HÁ UMA TERCEIRA FONTE, que é a certa e que eu tinha deixado passar:
-- cin7_mirror.products tem carton_length / carton_width / carton_height, além
-- das length/width/height que a v_master_stock expõe. Aquelas são a CAIXA DE
-- DESPACHO, medida para isto. São 3.047 SKUs ativos, e onde elas existem não
-- há ambiguidade nenhuma: a pergunta "unidade ou caixa" não se faz.
-- Por isso a ordem é: carton_* primeiro, dimensão de unidade depois, arquivo
-- por último — e cube_basis diz qual foi, porque nas duas últimas a resposta
-- é suposição e a tela precisa poder dizer quanto da carga se apoia nisso.
-- ============================================================================

DROP VIEW IF EXISTS rapid_inv.v_sp_cube CASCADE;
CREATE VIEW rapid_inv.v_sp_cube AS
SELECT
  m.sku_key, m.sku, m.name, m.status,
  coalesce(m.cin7_carton, m.file_carton)                       AS carton_qty,

  -- ── O cubo por CAIXA, em m³, e de onde ele veio ──
  CASE
    -- 1ª: a caixa de despacho medida. Sem ambiguidade.
    WHEN nullif(p.carton_length,0) IS NOT NULL AND nullif(p.carton_width,0) IS NOT NULL
     AND nullif(p.carton_height,0) IS NOT NULL
     AND greatest(p.carton_length, p.carton_width, p.carton_height) <= 300
      THEN round((p.carton_length * p.carton_width * p.carton_height / 1e6)::numeric, 6)
    -- 2ª: a dimensão de unidade do Cin7, tratada como se fosse a caixa.
    WHEN nullif(m.cin7_length,0) IS NOT NULL AND nullif(m.cin7_width,0) IS NOT NULL
     AND nullif(m.cin7_height,0) IS NOT NULL AND NOT m.flag_dim_unit
      THEN round((m.cin7_length * m.cin7_width * m.cin7_height / 1e6)::numeric, 6)
    -- 3ª: o CBM do arquivo, só onde passou nas duas checagens.
    WHEN m.cube_trustworthy THEN round(m.cbm::numeric, 6)
  END                                                          AS cbm_carton,

  CASE
    WHEN nullif(p.carton_length,0) IS NOT NULL AND nullif(p.carton_width,0) IS NOT NULL
     AND nullif(p.carton_height,0) IS NOT NULL
     AND greatest(p.carton_length, p.carton_width, p.carton_height) <= 300 THEN 'carton'
    WHEN nullif(m.cin7_length,0) IS NOT NULL AND nullif(m.cin7_width,0) IS NOT NULL
     AND nullif(m.cin7_height,0) IS NOT NULL AND NOT m.flag_dim_unit      THEN 'unit'
    WHEN m.cube_trustworthy                                               THEN 'file'
  END                                                          AS cube_source,

  -- 'measured' = veio da caixa de despacho e não se supõe nada.
  -- 'assumed'  = veio da dimensão de unidade ou do arquivo, tratada COMO SE
  --              fosse a caixa. A tela mostra quanto da carga está aqui.
  CASE
    WHEN nullif(p.carton_length,0) IS NOT NULL AND nullif(p.carton_width,0) IS NOT NULL
     AND nullif(p.carton_height,0) IS NOT NULL
     AND greatest(p.carton_length, p.carton_width, p.carton_height) <= 300 THEN 'measured'
    ELSE 'assumed'
  END                                                          AS cube_basis,

  -- As três medidas cruas, para a tela poder mostrar de onde saiu o número
  -- e para o packer 3D poder ser ligado depois sem refazer esta view.
  nullif(p.carton_length,0) AS carton_l, nullif(p.carton_width,0) AS carton_w,
  nullif(p.carton_height,0) AS carton_h,

  -- As duas fontes existem e discordam em mais de 20%? Então este SKU precisa
  -- de alguém olhando, e o contêiner que depende dele tem margem de erro.
  (nullif(m.cin7_length,0) IS NOT NULL AND NOT m.flag_dim_unit AND m.cbm IS NOT NULL
    AND abs((m.cin7_length * m.cin7_width * m.cin7_height / 1e6) - m.cbm)
        / greatest(m.cbm, 0.0001) > 0.20)                      AS cube_disputed,

  -- ── Peso ──
  -- Os valores do Cin7 são gramas de verdade (mediana 800), embora o campo
  -- weight_units diga 'g' para tudo por construção do sync. Abaixo de 100 já
  -- está em kg e não dá para saber qual é qual, então esses ficam de fora em
  -- vez de virarem uma carga 1000x errada.
  -- O peso vem do espelho e não da v_master_stock: aquela view expõe só as
  -- bandeiras de peso, não o valor.
  CASE WHEN p.weight >= 100 THEN round((p.weight / 1000.0)::numeric, 3) END AS kg_unit,
  (coalesce(p.weight,0) > 0 AND p.weight < 100)                AS weight_ambiguous,

  m.flag_dim_unit, m.flag_file_dim_unit, m.flag_volume_default, m.cube_trustworthy
FROM rapid_inv.v_master_stock m
LEFT JOIN cin7_mirror.products p ON upper(btrim(p.sku)) = m.sku_key;

GRANT SELECT ON rapid_inv.v_sp_cube TO anon, authenticated, service_role;

COMMENT ON VIEW rapid_inv.v_sp_cube IS
  'Cubo por SKU com a fonte declarada. cube_basis=carton e SUPOSICAO: as fontes discordam sobre medir unidade ou caixa.';
