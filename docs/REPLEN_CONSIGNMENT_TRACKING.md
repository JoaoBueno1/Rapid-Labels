# Replenishment → consignment + carrier do TMS (como ACENDER + backfill)

Branch Replenishment (History + Tabela A da landing) mostra, por TR, **com quem foi
bookado** e o **número de consignment clicável** (abre o tracking público do TMS).
Código pronto e no ar em `dev`; falta **acender** (passos manuais). Este doc é o
lembrete do que fazer — pensado para acender no fim de semana.

## O que já está pronto (2026-09-03)

- **TMS** (`Rapid-Express-Web`, commit `053164f`): `GET /api/v1/transfer_tracking?trs=TR-1,TR-2`
  em `src/routes/external_api.py`. Read-only, atrás de API-key (ou sessão). Reusa o
  `_TR_SQL` + `_carrier_display` do `transfers.py`. Devolve, por TR, a lista de
  `{consignment, carrier, is_own_fleet, status, public_track_url, carrier_tracking_url}`.
- **Labels** (`Rapid-Labels`, commit `e747486`): proxy `GET /api/replenishment/tr-tracking`
  (cache 60s, degrada em silêncio); History ganhou colunas **Carrier + Consignment**;
  **Tabela A** virou server-backed como a History (sem Units), mantendo o rascunho
  local como linha "draft". Preenchimento **progressivo** — célula vazia = "—" até o
  TR ser bookado.

Enquanto não acender, as colunas ficam **"—"** de propósito (não quebra nada).

## COMO ACENDER (3 passos manuais)

1. **Deploy do TMS** (Render, manual) — publica o `/api/v1/transfer_tracking`.
2. **Emitir uma API key** no TMS: logar como admin → **`/api_management`** → criar key.
   Copiar a key (só aparece uma vez).
3. **Setar 2 variáveis no ambiente do Labels** (`.env` local **e** Render/Vercel) e
   reiniciar o servidor Labels:
   ```
   TMS_BASE_URL=https://www.rapidexpress.com.au
   TMS_API_KEY=<a key do passo 2>
   ```
   (Opcional no TMS: `PUBLIC_BASE_URL` — já cai em `https://www.rapidexpress.com.au`.)

### Verificar que acendeu
1. TMS direto (com a key):
   `curl -H "X-API-Key: <key>" "https://www.rapidexpress.com.au/api/v1/transfer_tracking?trs=TR-50666"`
   → deve vir `{"results":{"TR-50666":[...]},...}`.
2. Proxy Labels: `curl "http://<labels>/api/replenishment/tr-tracking?trs=TR-50666"`
   → deve virar `{"configured":true,...}` (antes era `configured:false`).
3. Na tela: hard-refresh (Ctrl+Shift+R) → History/Tabela A com o consignment clicável.

## A REALIDADE DO VÍNCULO (honesto — não é bug)

- O TR casa por **texto livre** dentro de `orders.reference` no TMS (regex `TR-<n>`).
  Se o operador não digitou o `TR-` na reserva, **não casa**.
- É **1:many**: um TR vira vários connotes (pallet+carton) → a coluna mostra lista.
- Só cobre transferências **bookadas pelo TMS desde abr/2026**; van própria mostra o
  link interno (não tem connote externo).
- Logo, algumas linhas ficam **em branco com razão**.

## BACKFILL DESDE ABRIL — avaliação + recomendação

**Medição (02–03/09):**
- `cin7_mirror.stock_transfers`: **1.770 desde abr/2026** (7.219 no total). Dessas,
  **~607 para as 7 filiais** (Cairns 136, Sunshine Coast 120, Brisbane 96,
  Coffs 84, Hobart 65, Sydney 61, Melbourne 45). O resto é interno/projeto/faulty.
- `rapid_inv.replenishment_order` (o que a History mostra): **7 linhas** (desde 27/08).

**Conclusão: NÃO fazer "backfill" na `replenishment_order`.** Aquela tabela guarda o
que o módulo **colocou**, congelado no valor enviado (com snapshot de linhas, stage,
printed). As ~607 históricas não têm nada disso — inserir linhas sintéticas ali
**inventaria** dados que não existem e **poluiria** a History que o outro chat acabou
de reconstruir (f14d817). Ruim.

**Se quiser valor retroativo (mostrar as ~607 com consignment), o caminho certo é
um REGISTRO DE TRANSFERÊNCIAS separado, read-only** — uma aba/lista que lê
`cin7_mirror.stock_transfers` (o Labels já tem, desde 2019) filtrando destino=filial
e `departure_date >= 2026-04-01`, e **enriquece cada TR com o mesmo
`/api/replenishment/tr-tracking`** (reusa o proxy + `paintTrack` que já existem).
Não toca `replenishment_order`, não briga com a History. É uma feature nova pequena
(~meia tela), mas **pisa no território da History do outro chat → COORDENAR antes**.

**Alternativa de custo zero:** o histórico completo já existe na **página Branch
Transfers do TMS** (`transfers.py`) — as ~607 desde abril, com connote + carrier +
POD + custo. Se o objetivo é só "ver o histórico", já está lá; não precisa backfill.

**Recomendação:** acender primeiro (os 3 passos), ver o valor nas transferências
NOVAS. Só depois decidir o registro retroativo — e, se decidir, fazer como registro
read-only sobre `cin7_mirror.stock_transfers`, **nunca** backfill na
`replenishment_order`.

## Automação de email por warehouse (PLANEJADO — coluna já montada)

Objetivo: quando o sistema **captar o tracking** de um TR (o consignment aparece via
`/api/replenishment/tr-tracking`), **disparar um email** para o warehouse de destino
avisando que a transferência saiu, e **registrar** isso — quem recebeu + horário —
sem ninguém fazer à mão. A **coluna "Emailed"** já existe na Table A (in-progress) e
na History (mostra "—" até isto rodar; enche igual carrier/consignment).

**O que falta montar (nesta ordem):**
1. **Campo de registro** — migração aditiva em `rapid_inv.replenishment_order`:
   `emailed_at timestamptz`, `emailed_to text`, `emailed_count int default 0` (mesmo
   padrão do `printed_*` da 003). É o que a coluna "Emailed" lê.
2. **Lista de email por warehouse** — tabela/config `{branch_code → [emails]}`
   (ex. `rapid_inv.branch_email` ou um JSON de config). O destino vem do
   `branch_code` do pedido.
3. **Gatilho** — quando o `tr-tracking` retorna consignment para um TR que ainda tem
   `emailed_at` nulo → enfileira o email. Idempotente pela chave (TR): reenvio só se
   pedido explícito (incrementa `emailed_count`), nunca duplica no automático.
4. **Envio** — reusar o mesmo transporte de email que o Labels já usa (verificar qual;
   senão, um sender simples). Corpo: TR, filial, carrier, consignment + link do
   tracking público do TMS.
5. **Confirmação na tela** — o envio grava `emailed_at`/`emailed_to`; a coluna passa
   a mostrar o horário + destinatário (tooltip).

**Decisões pendentes (configurar depois):** qual endereço por warehouse; disparar no
**primeiro consignment** (mais cedo) ou só quando o status vira SHIPPED (mais certo);
1 email por TR ou por connote (lembrar do 1:many). Nada disso escreve em terceiro
além do próprio email — mas email É efeito externo, então testar com um endereço
interno antes de ligar de verdade (política POLITICA_TESTES_COM_EFEITO_REAL do TMS).
