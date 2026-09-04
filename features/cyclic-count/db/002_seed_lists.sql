-- =====================================================================
-- Cyclic Count | 002 | SEMENTE DAS LISTAS
-- ---------------------------------------------------------------------
-- Extraido de `Cyclic Stock Count - Septmeber 2026.xlsx`, aba BR.
-- Conferido contra o workbook de agosto: as listas A e B sao IDENTICAS
-- entre os dois meses, e nenhum SKU aparece nas duas. A mensal muda todo mes.
--
-- Rodar DEPOIS do 001. Idempotente: reexecutar nao duplica item nem
-- sobrescreve edicao feita na tela (ON CONFLICT DO NOTHING).
-- =====================================================================

-- ---- Cyclic List A: 44 itens -------------------------------
INSERT INTO rapid_inv.cc_list (code, name, notes, updated_by)
VALUES ('A', 'Cyclic List A', 'Semanas 1 e 3. Extraida de Cyclic Stock Count - Septmeber 2026.xlsx, aba BR, linhas 3-46.', 'seed/002')
ON CONFLICT DO NOTHING;

INSERT INTO rapid_inv.cc_list_item (list_id, sku, sku_code, sort_order, updated_by)
SELECT l.id, v.sku, v.sku_code, v.sort_order, 'seed/002'
  FROM rapid_inv.cc_list l, (VALUES
    ('CAL-CLA348-L-WH', '96853', 1),
    ('CAL-CLA348-WH', '97062', 2),
    ('CAL-CLA352-L-WH', '95868', 3),
    ('CAL-CLA352-WH', '96605', 4),
    ('DEK-ALBANY48-WH', '90301', 5),
    ('DEK-ALBANY48-BK', '90170', 6),
    ('DEK-ALBANY48-L-BK', '90359', 7),
    ('DEK-ALBANY48-L-WH', '90393', 8),
    ('DEK-ALBANY52-BK', '90324', 9),
    ('DEK-ALBANY52-L-BK', '90550', 10),
    ('DEK-ALBANY52-L-WH', '90735', 11),
    ('DEK-ALBANY52-WH', '90447', 12),
    ('DEK-EVOII50-BK', '90488', 13),
    ('DEK-EVOII50-BK-DC', '91208', 14),
    ('DEK-EVOII50-L-WH', '90513', 15),
    ('DEK-EVOII50-L-WH-DC', '91410', 16),
    ('DEK-EVOII50-L-BK-DC', '93237', 17),
    ('DEK-EVOII50-WH', '90526', 18),
    ('DEK-EVOII50-WH-DC', '90272', 19),
    ('DEK-EVOII58-BK-DC', '92069', 20),
    ('DEK-EVOII58-WH-DC', '91629', 21),
    ('EP-HYB-240-RF-10', '92049', 22),
    ('EP-HYB-RF-MOD', '98042', 23),
    ('EP-RANG-RF-10', '90012', 24),
    ('EP-SA-CONT-RF', '90026', 25),
    ('EP-VC-240-1', '90039', 26),
    ('EP-VC-240-10', '90048', 27),
    ('EP-VC-RF-MOD', '90055', 28),
    ('DEK-HAWK48-L-WH', '90643', 29),
    ('DEK-HAWK48-L-WH-DC', '90762', 30),
    ('DEK-HAWK48-WH', '90627', 31),
    ('DEK-HAWK48-WH-DC', '90721', 32),
    ('DEK-INGRAM-BK-DC', '95024', 33),
    ('DEK-INGRAM-L-BK', '90648', 34),
    ('DEK-INGRAM-L-BK-DC', '90031', 35),
    ('DEK-INGRAM-L-WH', '90659', 36),
    ('DEK-INGRAM-L-WH-DC', '97895', 37),
    ('DEK-INGRAM-WH', '90668', 38),
    ('DEK-INGRAM-WH-DC', '96701', 39),
    ('DEK-RONDOII52-L-WH', '91172', 40),
    ('DEK-RONDOII52-L-BK', '93200', 41),
    ('DEK-RONDOII52-WH', '91159', 42),
    ('DEK-RONDOII58-BK', '91204', 43),
    ('DEK-RONDOII58-L-WH', '90838', 44)
  ) AS v(sku, sku_code, sort_order)
 WHERE upper(btrim(l.code)) = 'A'
ON CONFLICT DO NOTHING;

-- ---- Cyclic List B: 47 itens -------------------------------
INSERT INTO rapid_inv.cc_list (code, name, notes, updated_by)
VALUES ('B', 'Cyclic List B', 'Semanas 2 e 4. Extraida do mesmo workbook, linhas 48-94.', 'seed/002')
ON CONFLICT DO NOTHING;

INSERT INTO rapid_inv.cc_list_item (list_id, sku, sku_code, sort_order, updated_by)
SELECT l.id, v.sku, v.sku_code, v.sort_order, 'seed/002'
  FROM rapid_inv.cc_list l, (VALUES
    ('DEK-RUSSELL-BK-DC', '92330', 1),
    ('DEK-RUSSELL-L-BK-DC', '15685', 2),
    ('DEK-RUSSELL-L-WH', '90807', 3),
    ('DEK-RUSSELL-L-WH-DC', '96758', 4),
    ('DEK-RUSSELL-WH', '90772', 5),
    ('DEK-RUSSELL-WH-DC', '96731', 6),
    ('R10', '92591', 7),
    ('R10RF', '90000', 8),
    ('R10RFB', '90064', 9),
    ('R10RFP', '90346', 10),
    ('R240', '90071', 11),
    ('R240ACB', '92263', 12),
    ('R240B', '90083', 13),
    ('R240RC', '90092', 14),
    ('R240RCB', '90100', 15),
    ('RAC', '90129', 16),
    ('RAC240', '95058', 17),
    ('RFMDUAL', '90464', 18),
    ('RFMOD', '90362', 19),
    ('RHA10RF', '90138', 20),
    ('RHA240SL', '94419', 21),
    ('RSDUALP', '91194', 22),
    ('RSG4', '95465', 23),
    ('RWB', '90149', 24),
    ('RWB2', '99878', 25),
    ('RWBB', '90156', 26),
    ('R360-SIMPLICITY-WH', '91642', 27),
    ('VEN-DC31203-L-WH', '92610', 28),
    ('VEN-DC31203-WH', '92645', 29),
    ('VEN-GLA1203-L-BK', '95236', 30),
    ('VEN-GLA1203-L-WH', '69347', 31),
    ('VEN-GLA1203-WH', '75648', 32),
    ('VEN-GLA1303-BK', '94463', 33),
    ('VEN-GLA1303-L-WH', '75701', 34),
    ('VEN-GLA1303-WH', '69283', 35),
    ('VEN-SKY1203WH', '91827', 36),
    ('VEN-SKY1203WH-L', '92059', 37),
    ('VEN-SKY1303BL', '93990', 38),
    ('VEN-SKY1303', '92627', 39),
    ('VEN-SKY1303-WH-L', '92670', 40),
    ('VEN-SKY1503-BL', '92356', 41),
    ('VEN-SKY1503-WH', '92707', 42),
    ('VEN-SKY1503-WH-L', '92733', 43),
    ('VEN-SPY0903-WH', '92813', 44),
    ('VEN-SPY1253-L-WH', '93058', 45),
    ('VEN-SPY1253-WH', '93138', 46),
    ('VEN-SPY1573-BK', '93386', 47)
  ) AS v(sku, sku_code, sort_order)
 WHERE upper(btrim(l.code)) = 'B'
ON CONFLICT DO NOTHING;

-- ---- Monthly extra - Set/2026: 11 itens --------------------
INSERT INTO rapid_inv.cc_list (code, name, notes, updated_by)
VALUES ('MONTHLY-2026-09', 'Monthly extra - Set/2026', 'O bloco das colunas N-V, que muda todo mes. Setembro tinha 11 itens; agosto, 5.', 'seed/002')
ON CONFLICT DO NOTHING;

INSERT INTO rapid_inv.cc_list_item (list_id, sku, sku_code, sort_order, updated_by)
SELECT l.id, v.sku, v.sku_code, v.sort_order, 'seed/002'
  FROM rapid_inv.cc_list l, (VALUES
    ('R1076-WH-WW-60', '30861', 1),
    ('R1092-18-WH-SIL-TRI', '30754', 2),
    ('R2202-WH-CW', '30153', 3),
    ('R3072-1200W_F19805', '82670', 4),
    ('R3072-1200W-5070_F19813', '94637', 5),
    ('R3117', '71779', 6),
    ('R3570-EM-TRI', '31095', 7),
    ('R6332-500', '30480', 8),
    ('R-HDMI', '31428', 9),
    ('RSDUALP', '91194', 10),
    ('TRI 28005501', '90389', 11)
  ) AS v(sku, sku_code, sort_order)
 WHERE upper(btrim(l.code)) = 'MONTHLY-2026-09'
ON CONFLICT DO NOTHING;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT l.code, count(i.id) AS n
             FROM rapid_inv.cc_list l
             LEFT JOIN rapid_inv.cc_list_item i ON i.list_id = l.id
            GROUP BY l.code ORDER BY l.code
  LOOP
    RAISE NOTICE '002_seed: lista % com % itens', r.code, r.n;
  END LOOP;
END $$;
