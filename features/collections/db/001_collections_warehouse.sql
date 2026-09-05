-- 001_collections_warehouse.sql — de qual armazém é cada agendamento de coleta.
--
-- Até hoje o Collections foi usado SÓ na Main Warehouse, então toda linha que já
-- existe é da Main — o backfill abaixo não é um chute, é o registro do que houve.
--
-- O DEFAULT existe para o dia em que alguém escrever sem informar o campo: sem
-- ele a linha nasceria NULL e viraria "de armazém nenhum", que é pior do que uma
-- suposição declarada. Quando as filiais começarem a usar, o formulário manda o
-- valor e o default deixa de importar.
--
-- Aditivo e idempotente: a tela funciona antes disto rodar (o campo só não
-- persiste). Seguro reexecutar.

ALTER TABLE public.collections_active
  ADD COLUMN IF NOT EXISTS warehouse text NOT NULL DEFAULT 'Main Warehouse';
ALTER TABLE public.collections_history
  ADD COLUMN IF NOT EXISTS warehouse text NOT NULL DEFAULT 'Main Warehouse';

UPDATE public.collections_active  SET warehouse = 'Main Warehouse' WHERE warehouse IS NULL;
UPDATE public.collections_history SET warehouse = 'Main Warehouse' WHERE warehouse IS NULL;

-- O filtro por armazém é a consulta que a tela passa a fazer o tempo todo.
CREATE INDEX IF NOT EXISTS idx_coll_active_wh  ON public.collections_active  (warehouse);
CREATE INDEX IF NOT EXISTS idx_coll_history_wh ON public.collections_history (warehouse, collected_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- A RPC PRECISA CARREGAR O CAMPO. Ela copia coluna por coluna de active para
-- history; sem esta parte, o armazém existiria nas duas tabelas e mesmo assim
-- TODA coleta confirmada cairia no default — o dado se perderia exatamente no
-- momento em que vira histórico, que é o único que alguém consulta depois.
--
-- Corpo idêntico ao que está no banco hoje, com warehouse acrescentado nas duas
-- listas. Nada mais muda: mesma assinatura, mesmos parâmetros, mesma ordem — a
-- chamada do cliente continua valendo sem alteração.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.confirm_collection(
  p_id uuid,
  p_collected_by text,
  p_operator text,
  p_collected_at timestamp with time zone,
  p_signature text,
  p_signature_data text DEFAULT NULL::text,
  p_invoice text DEFAULT NULL::text,
  p_sales_rep text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
declare
  v_row public.collections_active%rowtype;
begin
  select * into v_row
  from public.collections_active
  where id = p_id
  for update;

  if not found then
    raise exception 'Collection % not found', p_id;
  end if;

  insert into public.collections_history(
      id, customer, reference, cartons, pallets,
      contact_name, contact_number, email,
      collected_by, operator, collected_at, collection_date,
      signature, signature_data, created_at, created_by, tubes,
      invoice, sales_rep, warehouse
  )
  values (
      v_row.id, v_row.customer, v_row.reference, v_row.cartons, v_row.pallets,
      v_row.contact_name, v_row.contact_number, v_row.email,
      p_collected_by, p_operator, coalesce(p_collected_at, now()), v_row.collection_date,
      p_signature, p_signature_data, v_row.created_at, v_row.created_by, v_row.tubes,
      coalesce(p_invoice, v_row.invoice), coalesce(p_sales_rep, v_row.sales_rep),
      coalesce(v_row.warehouse, 'Main Warehouse')
  )
  on conflict (id) do nothing;

  delete from public.collections_active where id = p_id;
end;
$function$;

SELECT 'collections warehouse ready' AS status;
