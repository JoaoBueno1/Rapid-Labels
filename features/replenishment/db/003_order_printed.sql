-- 003_order_printed.sql — quando a transferência foi impressa, e por quem.
--
-- A folha vira TR no Cin7 e alguém imprime o documento para o picking. Sem
-- registro, "isto já foi impresso?" só se responde perguntando à pessoa — e a
-- resposta mais cara é reimprimir por via das dúvidas, que põe duas cópias do
-- mesmo picking no chão.
--
-- printed_at é a PRIMEIRA impressão e não se mexe depois: é a resposta a "quando
-- este picking saiu para o chão". printed_count conta as reimpressões, que são
-- legítimas (papel perdido, segunda via) mas dizem algo — uma TR impressa seis
-- vezes é um sinal, não um detalhe.
--
-- Aditivo e nullable: a tela funciona antes disto rodar, só não guarda a marca.

ALTER TABLE rapid_inv.replenishment_order
  ADD COLUMN IF NOT EXISTS printed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS printed_by    text,
  ADD COLUMN IF NOT EXISTS printed_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN rapid_inv.replenishment_order.printed_at IS
  'Primeira impressao do documento. Nao muda em reimpressao.';
COMMENT ON COLUMN rapid_inv.replenishment_order.printed_count IS
  'Quantas vezes foi impressa. Reimpressao e legitima, mas seis nao e detalhe.';

SELECT 'order printed columns ready' AS status;
