# Excel Sync — specs dos reports (contrato)

> Uma seção por report Cin7 que alimenta uma aba de Excel. Cada spec diz: **de onde
> vem cada coluna no mirror**, **quais filtros/normalizações aplicar** e **o que ainda
> falta sincronizar** para o report sair 100%.
>
> Validado em 2026-08-07 contra dois exports reais do Cin7. Método: parsear o export,
> reconstruir o mesmo número a partir de `cin7_mirror`, e comparar célula a célula.

| # | Report Cin7 | Reproduzível hoje? | Falta |
|---|---|---|---|
| R1 | Inventory Products Stock Level Report | ✅ **100,00%** (12.656/12.656 células) | nada |
| R2 | Sale Order Details (mensal) | ✅ **99,88%** (1.628/1.630 células) · qty 100,02% · valor 100,01% | 2 células (7 un) de pedido dividido |

**Colunas em escopo do R2:** só `Quantity` e `Total` (decidido 2026-08-07 — `Discount`
descartado).

---

## R1 — Inventory Products Stock Level Report

**Arquivo validado:** `Inventory Products Stock Level Report (23).xlsx` (2026-08-07 16:26)

### Forma do export

Header de **duas linhas**: linha 0 = nome do warehouse (repetido em blocos), linha 1 = a
métrica. Dados a partir da linha 2.

```
linha 0:        │ BNE Project │ BNE Project │ … (7 col por warehouse)
linha 1: SKU │ Unit │ Quantity on hand │ Allocated │ On order │ In transit │ Unit cost │ Stock on hand │ Available
```

- **121 colunas** = 2 fixas (`SKU`, `Unit`) + **17 warehouses × 7 métricas**
- **3.696 linhas** de SKU
- Um bloco de warehouse fica em branco quando aquele SKU não existe naquele local

### Mapeamento coluna → mirror

Fonte: `cin7_mirror.stock_snapshot`, **agregado por (sku, location_name)** — o mirror
guarda por bin, o report é por warehouse. `SUM()` de todas as colunas.

| Coluna do export | Origem no mirror | Nota |
|---|---|---|
| `SKU` | `stock_snapshot.sku` | **aplicar `TRIM()`** — ver normalização |
| `Unit` | `products.uom` | constante `Item` em 100% dos casos |
| `Quantity on hand` | `SUM(on_hand)` | bate exato |
| `Allocated` | `SUM(allocated)` | bate exato |
| `On order` | `SUM(on_order)` | bate exato |
| `In transit` | `SUM(in_transit)` | bate exato |
| `Unit cost` | `SUM(stock_on_hand) / SUM(on_hand)` | ou `products.average_cost` (~2% de erro) |
| `Stock on hand` | `SUM(stock_on_hand)` | ⚠️ **é VALOR em AUD, não quantidade** |
| `Available` | `SUM(available)` | ⚠️ **não é `on_hand − allocated`** |

### As duas armadilhas — agora provadas pelo próprio Cin7

**`Stock on hand` é valor.** O export traz `Unit cost` e `Stock on hand` como colunas
separadas, e `on_hand × unit_cost = stock_on_hand` em **9.877 de 9.877 blocos (100,0%)**.
Confirma o que já tínhamos medido no mirror. O comentário em `cin7-stock-sync/schema.sql`
que diz *"Total across all locations"* está **errado** e precisa ser corrigido.

**`Available` não é `on_hand − allocated`.** Quebra em **1.666 blocos do export** — o mesmo
número exato encontrado no mirror. São SKUs de caixa fechada (`*-Carton20`, `*-Carton15`)
com `on_hand=0`, `allocated=0`, `available>0`: o Cin7 deriva a disponibilidade da caixa a
partir do estoque solto do produto pai. **Não é bug do mirror — é comportamento do Cin7,
e o mirror o reproduz fielmente.** Portanto: copiar `available` como está, e nunca
recalculá-lo.

### Filtro e normalização (obrigatórios)

1. **`products.type = 'Stock'`** — regra exata, verificada 19/19 e 5/5. Sem ela entram 19
   itens `Non Inventory` (`Freight`, `Paint`, `EC-SCREWS`, `CARTON - R1021`, `Accessories`…)
   que o Cin7 exclui. Não é filtro de quantidade zero: `Paint|Main Warehouse` tem
   `on_hand=157` e mesmo assim fica de fora.
2. **`TRIM()` no SKU.** Dois SKUs têm espaço no fim no mirror e não no export:
   `AIRCE200N EXHAUST FAN 200MM ` e `AIRCE250N EXHAUST FAN 250MM `. Sem o trim viram
   linhas órfãs duplicadas.
3. **Omitir o bloco** do warehouse quando o SKU não tem nenhuma linha ali (célula vazia,
   não zero).

### Resultado da reconciliação

```
export : 3.696 SKUs × 17 warehouses → 12.658 blocos com dado
mirror : 14.973 linhas de bin       → 12.684 pares (sku, location)

em ambos                : 12.656
só no export            :      2   (os dois SKUs com espaço no fim)
só no mirror            :     28   (19 Non Inventory + 2 espaços + 7 zerados)
on_hand IDÊNTICO        : 12.656 / 12.656  →  100,00%
```

Totais por warehouse batem em **0,0%** de diferença em 15 dos 17; Main Warehouse e
Sunshine Coast ficam em 0,1%, explicado pela ~1h entre o export (16:26 local) e o último
sync do mirror (05:31 UTC).

### Sync necessário

**Nenhum.** O `cin7-sync` horário já entrega tudo. O report pode ser gerado agora.

---

## R2 — Sale Order Details (vendas do mês por SKU × warehouse)

**Arquivo validado:** `Sale Order Details (22).xlsx` (2026-08-07 16:27)
**Período:** `This month` → 01-Aug-2026 a 31-Aug-2026 (parcial, mês corrente)

### Forma do export

4 linhas de metadado, header de **duas linhas**, dados a partir da linha 6.

```
linha 0: Report period: This month
linha 1: From: 01-Aug-2026
linha 2: To: 31-Aug-2026
linha 3: Currency: Base Currency
linha 4:     │ Brisbane │ Brisbane │ Brisbane │ Cairns │ …
linha 5: SKU │ Quantity │ Discount │ Total    │ Quantity │ …
```

- **31 colunas** = 1 (`SKU`) + **10 warehouses × 3 métricas**
- **859 SKUs**, 1.631 células (sku × warehouse) com venda
- Só aparecem os warehouses **com venda no período** — este mês foram 10 dos 17

Totais do export: **38.561 un**, **AUD 1.099.601**.

### Definição do período — testada empiricamente

Comparei 5 definições candidatas contra o export:

| Definição | Δ qty | Δ valor |
|---|---:|---:|
| **`order_date`, todos os status** | **−5,7%** | −15,3% → **−0,0% após ajuste de GST** |
| `invoice_date` | +16,3% | +14,0% |
| `ship_date` | +69,5% | +52,5% |

→ **O report usa `order_date`**, não data de fatura nem de envio.

### ⚠️ O `Total` do export inclui GST (10%)

Nas células onde a quantidade bate exatamente, testei três candidatos para o valor:

| Candidato | Bate exato | Σmirror / Σexport |
|---|---:|---:|
| `sale_lines.total` (ex-GST) | 11 / 1.471 (0,7%) | 0,90911 |
| **`sale_lines.total + sale_lines.tax`** | **1.470 / 1.471 (99,9%)** | **1,00002** |
| `sale_lines.total × 1,1` | 1.470 / 1.471 (99,9%) | 1,00002 |

`0,90911 = 1/1,1` — é GST puro. **Usar `total + tax`** (não `× 1,1`, que quebraria em
qualquer linha isenta de imposto).

Sem essa correção o report automatizado sairia **10% abaixo do real**, de forma
silenciosa e consistente — exatamente o tipo de erro que ninguém pega olhando.

### Mapeamento coluna → mirror

| Coluna do export | Origem no mirror |
|---|---|
| `SKU` | `sale_lines.sku` (com `TRIM()`) |
| grupo (warehouse) | `sales_orders.location_name` — **do cabeçalho, não da linha** |
| `Quantity` | `SUM(sale_lines.quantity)` |
| `Total` | `SUM(sale_lines.total + sale_lines.tax)` ⬅ **inclui GST** |
| ~~`Discount`~~ | ❌ **fora de escopo** (decidido 2026-08-07) — só `Quantity` e `Total` |

Join: `sale_lines.order_number = sales_orders.order_number`,
filtrado por `sales_orders.order_date BETWEEN <mês>`.

### `Discount` — descartado

Decidido em 2026-08-07: a aba usa **só `Quantity` e `Total`**. A coluna `Discount` do
export é um percentual agregado com regra ambígua (afetava 17 de 1.631 células) e não
tem uso a jusante. Fica fora da spec — e com isso o R2 deixa de ter qualquer coluna em
aberto.

### Cobertura atual e por que não chega a 100%

Depois de corrigir GST e usar `order_date`:

```
qty   : export 38.561        mirror 36.356        → 94,3%
valor : export AUD 1.099.601 mirror AUD 1.024.155 → 93,1%
células idênticas em qty: 1.471 / 1.574 (93,5%)
```

Por warehouse — repare que onde a quantidade bate 100%, o valor também bate 100%:

| Warehouse | qty exp | qty mirror | cob. | $ exp | $ mirror | cob. |
|---|---:|---:|---:|---:|---:|---:|
| Hobart | 692 | 692 | 100% | 13.871 | 13.871 | **100%** |
| Melbourne | 542 | 542 | 100% | 13.803 | 13.803 | **100%** |
| CNS Project | 40 | 40 | 100% | 3.960 | 3.960 | **100%** |
| Cairns | 2.525 | 2.518 | 100% | 62.634 | 61.655 | 98% |
| Coffs Harbour | 883 | 874 | 99% | 23.501 | 22.989 | 98% |
| Main Warehouse | 22.804 | 22.365 | 98% | 646.948 | 615.056 | 95% |
| Brisbane | 1.415 | 1.325 | 94% | 57.633 | 54.340 | 94% |
| Sydney | 1.191 | 1.061 | 89% | 49.550 | 46.440 | 94% |
| Sunshine Coast | 3.336 | 2.920 | 88% | 71.723 | 64.854 | 90% |
| Project Warehouse | 5.134 | 4.019 | 78% | 155.978 | 127.187 | 82% |

**A lógica está certa — falta dado.** Dos 1.649 pedidos do mês, **286 não têm
`sale_lines` nem `location_name`**. E o status deles explica tudo:

```
faltando : ESTIMATING 201 · ORDERED 35 · ESTIMATED 12 · BACKORDERED 12
           ORDERING 11 · PICKED 6 · DRAFT 4 · VOIDED 4 · PICKING 1
temos    : INVOICED 1021 · COMPLETED 215 · BACKORDERED 58 · ORDERED 35 · …
```

**Causa raiz:** hoje o detalhe do pedido (que traz as linhas *e* o `location_name`) só é
buscado quando dispara um webhook de **ship / invoice / pick / pack**. Pedido parado em
`ESTIMATING`/`DRAFT`/`ORDERING` nunca dispara nada, então **nunca ganha detalhe** — mas o
report do Cin7 o inclui, porque lê o Cin7 ao vivo. Por isso o Project Warehouse (78%) é o
pior: são justamente os pedidos que ficam alocados em estimativa por muito tempo.

### Cabeçalho × detalhe — medido contra o Cin7 ao vivo (2026-08-07)

Confrontei o `saleList` do Cin7 com o mirror para separar "falta o pedido" de "falta o
detalhe do pedido". São problemas diferentes com custos muito diferentes:

```
Cin7   : 1.662 pedidos com OrderDate em Ago
mirror : 1.660 pedidos          → cobertura de CABEÇALHO 99,88%

  faltando no mirror : 2   (SO-282421, SO-282423 — criados nas últimas horas)
  sobrando no mirror : 0
```

**O cabeçalho já está resolvido.** Os 2 ausentes são apenas o atraso do
`cin7-sales-sync`, que roda de 2 em 2 horas — não é lacuna, é latência. Some sozinho no
próximo ciclo.

```
dos 1.660 pedidos que temos:
  sem detail_synced_at : 265  (16,0%)
  sem location_name    : 265  (os mesmos)

  status deles: ESTIMATING 202 · ORDERED 24 · ORDERING 14 · ESTIMATED 13
                DRAFT 4 · VOIDED 4 · BACKORDERED 4
```

### Estágio de cotação — 215 dos 265 estão FORA do report

Ao rodar o sync descobri que `ESTIMATING` e `ESTIMATED` são **estágio de cotação**: o Cin7
devolve as linhas em `Quote.Lines` e deixa **`Order.Lines` vazio**. Confirmado na API:

```
SO-281355  ESTIMATING   Order.Lines= 0   Quote.Lines=11   Melbourne
SO-281097  ESTIMATED    Order.Lines= 0   Quote.Lines= 4   Melbourne
SO-280996  ORDERED      Order.Lines= 1   Quote.Lines= 1   Project Warehouse
SO-279693  BACKORDERED  Order.Lines=19   Quote.Lines=19   Project Warehouse
SO-280983  ORDERING     Order.Lines= 1   Quote.Lines= 0   Brisbane
```

Tudo indica que o report **não conta cotação**: **Hobart e Melbourne fecham em 100%**
tendo 5 e 6 pedidos `ESTIMATING` cujas linhas o nosso pivot não tem. Coerente no outro
extremo: Project Warehouse (78%, o pior) e Sunshine Coast (88%) têm **zero** `ESTIMATING`
— a lacuna deles vem de `ORDERED`/`BACKORDERED`/`ORDERING`, que têm `Order.Lines` normal.

> ⚠️ **Status é o discriminador errado — use `Order.Lines`.** Cheguei a excluir
> `ESTIMATING`/`ESTIMATED` no *fetch*, a partir de uma amostra de 3 pedidos com
> `Order.Lines` vazio. Errado: `SO-282226` é `ESTIMATING` **com** `Order.Lines` populado
> (R3603-WH, qty 214). Um pedido sem linhas contribui zero sozinho — não precisa de filtro
> para isso, e filtrar por status descarta venda real. O `detail-month` busca tudo menos
> voided/cancelled; o **filtro do report vive no build**, onde muda sem re-buscar nada.

Custo de buscar os quote-stage mesmo assim: **218 pedidos → 54 linhas**. Barato como
seguro contra descartar venda de verdade.

**Escopo real do report e custo para ficar 100%:**

```
1.660 pedidos com order_date em Agosto
  −  7 voided/cancelled
  − 215 em cotação (ESTIMATING/ESTIMATED)
  ─────
  1.438 pedidos NO ESCOPO do report
```

| Trabalho | Pedidos | Chamadas Cin7 |
|---|---:|---:|
| Buscar cabeçalhos faltantes | 2 | 2 *(ou zero — o sync de 2h já pega)* |
| Detalhe **faltante** (no escopo) | 38 | 38 |
| Detalhe **defasado** (no escopo) | 1.075 | 1.075 |
| **Total** | **1.113** | **~46 min a 24/min** |

O custo é dominado pelo **refresh dos defasados**, não pelos buracos.

### Sync necessário — reaproveitando o que já existe

**Não precisa de sync novo do zero.** Já existe `cin7-stock-sync/backfill-sales.js` no modo
`detail-open`, rodando pelo workflow `cin7-open-detail-sync.yml` a cada 6h com cap de 60.
Ele faz exatamente a chamada certa (`GET /sale/{ID}` → `mapDetail` + `mapLines`). O que
ele **não** faz é pegar os pedidos que o report precisa — por dois filtros no código.

#### Bloqueio 1 — `order_status = 'AUTHORISED'` exclui 237 dos 265

`backfill-sales.js:190` filtra por `order_status = 'AUTHORISED'`. Mas os pedidos que
faltam têm outro `order_status`:

```
order_status dos 265 sem detalhe:
  NOT AVAILABLE 206 · AUTHORISED 28 · DRAFT 22 · SHORT STOCK 3 · VOIDED 4 · NO STOCK 2

  → capturados pelo filtro atual : 28 de 265
  → bloqueados só por esse filtro: 237  (nunca serão pegos, por design)
```

Os 28 o job já pega sozinho (240 pedidos/dia de capacidade — está em dia). Os 237 são
invisíveis para ele.

#### Bloqueio 2 — nunca re-busca: 1.078 pedidos com detalhe defasado

`backfill-sales.js:192` usa `.is('detail_synced_at', null)`. O comentário acima da função
diz *"missing **or stale** detail"*, mas o código só pega o `null`. Resultado:

```
pedidos do mês com detalhe JÁ DEFASADO (cin7_updated > detail_synced_at): 1.078 de 1.660
  status deles: INVOICED 815 · COMPLETED 211 · BACKORDERED 19 · CREDITED 16 · …
```

Nem todo "touch" no Cin7 muda linha (pagamento, tracking…), então 1.078 é o **teto** do
risco, não o erro. Mas o sintoma é mensurável e já apareceu na reconciliação: das 1.574
células presentes nos dois lados, **103 (6,5%) têm quantidade diferente**. É isto que
sobra depois de descontar os 265 ausentes — e é exatamente o que a defasagem explica.

> **Correção do que eu estimei antes:** eu disse "265 pedidos, ~18 min". Isso fecha só a
> *cobertura*. O *frescor* custa mais: 265 ausentes + 1.078 defasados = **~1.343 pedidos**
> na primeira passada.

#### As três mudanças (cirúrgicas, no arquivo que já existe)

Adicionar um modo `detail-month` ao `backfill-sales.js` — reaproveitando o mesmo cliente
Cin7, o mesmo throttle/backoff, o mesmo `mapDetail`/`mapLines`, as mesmas tabelas e os
mesmos secrets. Sem tabela nova no Supabase, sem script novo.

```js
// escopo: mês corrente, QUALQUER status exceto VOIDED, faltando OU defasado
.gte('order_date', monthStart).lte('order_date', monthEnd)
.not('status', 'in', '(VOIDED,CANCELLED)')
.or('detail_synced_at.is.null,cin7_updated.gt.detail_synced_at')
.order('order_date', { ascending: true })
```

1. **Sem o filtro `order_status`** → destrava os 237.
2. **`OR cin7_updated > detail_synced_at`** → destrava o re-fetch e resolve os 6,5%.
3. **Escopo de mês + `VOIDED` fora** → alinha com a definição do report.

**Custo:**

| Cenário | Pedidos | A 15/min | A 30/min (off-peak) |
|---|---:|---:|---:|
| Primeira passada (265 ausentes + 1.078 defasados) | ~1.343 | ~90 min | **~45 min** |
| Run diário em regime (novos + alterados do dia) | ~150–400 | ~10–27 min | ~5–13 min |
| Virada de mês (mês novo do zero) | ~1.660 | ~110 min | ~55 min |

Como é um job diário **off-peak**, dá para usar throttle mais agressivo (2.000 ms =
30/min) sem encostar no cap compartilhado de 60/min — desde que caia numa janela livre do
[mapa de crons](SYNC_WORKFLOWS.md). Precisa de `timeout-minutes` maior que os 15 padrão
dos outros workflows.

**Efeito colateral positivo:** depois desta passada o `detail-open` encontra quase nada
para fazer (os conjuntos se sobrepõem), então o custo Cin7 **líquido** quase não muda.

#### Cadência — seg a sex

```yaml
on:
  schedule:
    - cron: '0 19 * * 0-4'   # UTC dom–qui 19:00 = seg–sex 05:00 em Sydney
```

O deslocamento de dia é intencional: 19:00 UTC + 10h (AEST) cai às 05:00 do dia seguinte
em Sydney, então `0-4` (dom–qui em UTC) = **seg–sex em Sydney**, e o Excel está pronto
antes do expediente. O mapeamento se mantém em AEDT (UTC+11 → 06:00).

### O que "100% e correto" exige — três coisas, não uma

**1. Cobertura** — todo pedido do mês tem detalhe.
Resolvido pelo passo 2. Custo medido: 265 pedidos hoje.

**2. Frescor** — o detalhe reflete o estado *atual* do pedido.
Este é o ponto sutil: um pedido em `ESTIMATING` hoje pode virar `INVOICED` amanhã com
**linhas diferentes**. Buscar uma vez e marcar `detail_synced_at` não basta — ficaria
congelado num estado velho e o report daria número errado *com cobertura de 100%*, que é
pior do que dar erro. Por isso o passo 1 usa **`UpdatedSince`** em vez de só procurar
`detail_synced_at IS NULL`: todo pedido que o Cin7 diz ter mudado é re-buscado.

**3. Determinismo** — o build só roda se 1 e 2 estiverem satisfeitos.
A trava `min_order_detail_coverage_pct: 99` faz o build **falhar em vez de escrever** uma
aba incompleta. Um número 6% baixo passa despercebido; uma aba que não atualizou, não.

Com os três, o report vira **função pura do mirror** — mesma entrada, mesma saída, e
qualquer divergência contra o Cin7 é detectável.

### `VOIDED` — resolvido

Confirmado em 2026-08-07: **o report do Cin7 não inclui pedidos voided.** Regra da spec:
`WHERE sales_orders.status <> 'VOIDED'`, tanto no sync quanto no build. O mês tem 7.

E o raciocínio de que o sync diário já resolve está certo: o `cin7-sales-sync` atualiza
status de 2 em 2 horas e o build lê o **status atual** — então um pedido anulado hoje some
do report no build de amanhã, sozinho. Não precisa de tratamento especial.

**Uma ressalva só:** isso vale enquanto o mês estiver na janela de rebuild. Um pedido de
agosto anulado em setembro não seria corrigido se em setembro só reconstruíssemos
setembro. Solução barata: manter o **mês anterior** na janela pelos primeiros ~5 dias
úteis do mês novo. Custo desprezível — o mês anterior já está detalhado, então é só
re-agregar: **zero chamada Cin7**.

*(A regra do `Discount` saiu de cena — coluna descartada. A completude de cabeçalho foi
medida e está em 99,88%, sem lacuna real.)*

---

## R2 — resultado depois do sync (2026-08-07)

Rodado `detail-month` em três passadas: 1.336 pedidos (cobertura + frescor), 1.438
(rebuild com prune) e 218 (quote-stage). **0 falhas.**

| Métrica | Antes | Depois |
|---|---:|---:|
| células com qty idêntica | 93,5% | **98,2 – 99,6%** *(depende do filtro de status)* |
| células do export sem par no mirror | 57 | **0** |
| qty total vs export | 94,3% | 101,1 – 104,2% |

Toda célula do export tem par no mirror. O que resta é **excesso**, de três origens
identificadas — nenhuma delas é falta de dado.

### Bug corrigido — `sale_lines` nunca apagava

O upsert em `(order_number, line_no)` só insere/atualiza. Quando o Cin7 **encurta ou
reordena** as linhas de um pedido, as antigas sobrevivem e inflam todo total construído
em cima. Latente enquanto nada era re-buscado; material assim que o refresh entrou.

```
SO-281413  mirror 149 linhas / qty 491  ×  Cin7 100 / 349   → 49 órfãs
SO-280240  mirror  19 / qty 2.312       ×  Cin7  18 / 2.192 →  1 órfã
SO-280418  mirror   3 / qty 28          ×  Cin7   2 / 17    →  1 órfã
```

`pruneStaleLines()` apaga o que ficou fora do conjunto recém-escrito. **Armadilha:**
`line_no` é o índice no array **bruto** do Cin7 e o `mapLines()` descarta linhas sem SKU —
os `line_no` guardados são esparsos, então `line_no >= kept.length` apagaria linhas
válidas. O prune casa pelo conjunto exato.

> Os modos `detail` e `detail-open` têm o mesmo padrão de upsert, mas como só pegam
> `detail_synced_at IS NULL` e nunca re-buscam, não acumulam órfãs. Vale checar se o
> caminho de webhook re-escreve `sale_lines` — se re-escrever, tem a mesma exposição.

### Casca de pedido dividido — a maior diferença que sobrou

`SO-280868` aparecia em 4 das 6 células com excesso, sempre com quantidade **igual ao
excesso** (1000, 160, 45, 11). É a casca retida depois que o Cin7 dividiu o pedido duas
vezes — `Note: "Original Order #SO-280240 Original Order #SO-280244"`, todas as 4 linhas
100% em backorder, fatura em `DRAFT`. O report conta os filhos da divisão, não a casca.
Removê-la: qty 104,24% → **101,09%**.

Testado e **descartado**: excluir `BACKORDERED` (cai para 77,5% — backorder *é* contado)
e usar `quantity − backorder_quantity` (90,9%).

Não há regra limpa ainda: o sinal está no `Note`, que não guardamos. Opções: passar a
gravar `Note`, ou usar "todas as linhas 100% backorder + fatura DRAFT" como heurística.
**Um pedido neste mês (0,37% das células)** — decidir com um mês fechado.

### Filtro de status — RESOLVIDO com export de deriva ~1 min

A primeira tentativa comparou um export das 16:27 com um mirror de 1h30 depois, e as
variantes ficaram empatadas — o alvo se mexia enquanto media. Repetimos com o mirror em
**0 faltando / 0 defasado** e um export tirado **1 minuto depois** (22:57 vs 22:58, fora
do horário comercial). Aí as variantes separam de vez:

| Excluindo | qty% | valor% | células idênticas | sóMIR | sóEXP |
|---|---:|---:|---:|---:|---:|
| só `VOIDED`+`CANCELLED` | 106,49% | 109,41% | 96,20% | 38 | 0 |
| + `ORDERING` | 105,49% | 107,37% | 97,91% | 24 | 0 |
| + `ORDERING` + `DRAFT` | 104,82% | 107,13% | 98,22% | 22 | 0 |
| + cotação | 104,85% | 102,49% | 97,48% | 16 | 0 |
| + cotação + `ORDERING` | 103,86% | 100,45% | 99,33% | 2 | 0 |
| + cotação + `ORDERING` + `DRAFT` | 103,19% | 100,21% | 99,63% | 0 | 0 |
| **+ casca de divisão** | **100,02%** | **100,01%** | **99,88%** | **0** | **0** |

**Regra final:** excluir `VOIDED`, `CANCELLED`, `ESTIMATING`, `ESTIMATED`, `ORDERING`,
`DRAFT`. Resultado: **1.628 de 1.630 células idênticas**, e **9 dos 10 warehouses batendo
exatamente 100,0% em quantidade E em valor**.

> A cotação sai mesmo — o contraexemplo `SO-282226` (célula `R3603-WH`) era deriva: o
> pedido mudou 20 min *depois* do primeiro export. Com deriva de 1 min, excluir cotação dá
> `sóEXP = 0`: nenhuma célula do export fica sem par.

**O fetch continua permissivo de propósito.** O `detail-month` busca tudo menos
voided/cancelled, e o filtro acima vive no **build**. Foi o que permitiu testar as 7
variantes acima **sem uma única chamada Cin7 extra** — depois de eu mudar de ideia duas
vezes sobre a regra. Custo do seguro: 218 pedidos → 54 linhas.

### O que sobra: 2 células, 7 unidades (0,02%)

```
R-WPGPO1-15|Main Warehouse   export=68  mirror=73   Δ=+5
STRIPTAIL-E|Main Warehouse   export=22  mirror=24   Δ=+2
```

Ambas vêm da **mesma família de pedidos divididos** do cliente Chillin Smarts:
`SO-280240` → dividido em `SO-280244`/`SO-280418` → subdividido em `SO-280868`/`SO-280873`.

Não existe regra derivável para isolá-las com o que guardamos:
- **`Note` não discrimina** — `SO-280244` também diz "Original Order #SO-280240" e **é**
  contado; `SO-280868` e `SO-280873` não são.
- **"todas as linhas 100% em backorder" é amplo demais** — pega 37 pedidos no mês e
  derruba a qty para 94,25%. A maioria dos backorders totais *é* contada.

Impacto prático, e é o que importa: **em valor o report já fecha em 100,21% sem tratar a
casca** — as linhas dela são de baixo valor unitário. O desvio de 3% é só em
**quantidade**, concentrado em um pedido. Recomendação: seguir sem regra de casca,
com o gate de validação sinalizando quando a divergência de qty passar de ~2%, e levar a
pergunta "como o Cin7 trata pedido dividido neste report" para quem opera o Cin7.

---

## Formato da spec (o artefato que a engine vai ler)

Uma spec declarativa por aba. Casamento de coluna **por nome de header**, nunca por
índice — o Cin7 já mudou ordem de coluna antes (lição do `update_main_avg_3mo.py`).

```yaml
# features/excel-sync/specs/stock-level.yaml
slug: stock-level
source_report: "Inventory Products Stock Level Report"
workbook: "<a definir>.xlsx"
sheet: "<a definir>"
layout:
  kind: pivot_2row_header       # linha de grupo + linha de métrica
  group_by: location_name       # vira o bloco de colunas
  group_order: alpha            # o Cin7 ordena os warehouses alfabeticamente
  key: sku
  key_transform: trim
source:
  table: cin7_mirror.stock_snapshot
  join: { products: "sku", on_type: "Stock" }
  aggregate: sum_by(sku, location_name)
filters:
  - products.type = 'Stock'
fixed_columns:
  - { header: SKU,  expr: "trim(sku)" }
  - { header: Unit, expr: "products.uom" }
metrics:
  - { header: "Quantity on hand", expr: "sum(on_hand)" }
  - { header: "Allocated",        expr: "sum(allocated)" }
  - { header: "On order",         expr: "sum(on_order)" }
  - { header: "In transit",       expr: "sum(in_transit)" }
  - { header: "Unit cost",        expr: "sum(stock_on_hand)/nullif(sum(on_hand),0)" }
  - { header: "Stock on hand",    expr: "sum(stock_on_hand)", note: "AUD value" }
  - { header: "Available",        expr: "sum(available)",     note: "copiar; NAO recalcular" }
validation:
  max_source_age_minutes: 120
  expect_rows_between: [3400, 4000]
  max_row_delta_pct: 10
cron_utc: "0 20 * * *"
```

```yaml
# features/excel-sync/specs/monthly-sales.yaml
slug: monthly-sales
source_report: "Sale Order Details"
layout:
  kind: pivot_2row_header
  group_by: location_name
  group_order: alpha
  drop_empty_groups: true        # so warehouse com venda vira coluna
  key: sku
  key_transform: trim
period:
  field: order_date              # NAO invoice_date, NAO ship_date
  window: current_month
  refresh: daily
source:
  table: cin7_mirror.sale_lines
  join: { sales_orders: "order_number" }
  aggregate: sum_by(sku, sales_orders.location_name)
filters:
  # regra provada em 2026-08-07 com export de deriva ~1min: 1628/1630 celulas
  # identicas, qty 100.02%, valor 100.01%. NAO e o mesmo filtro do fetch --
  # o sync busca tudo menos voided/cancelled de proposito (ver EXCEL_SYNC_REPORTS).
  - sales_orders.status NOT IN
      ('VOIDED','CANCELLED','ESTIMATING','ESTIMATED','ORDERING','DRAFT')
metrics:
  - { header: "Quantity", expr: "sum(quantity)" }
  - { header: "Total",    expr: "sum(total + tax)", note: "GST-inclusive" }
# Discount: descartado — nao entra na aba
depends_on_sync: sales-detail-month
validation:
  min_order_detail_coverage_pct: 99   # trava o build se o detalhe estiver incompleto
  max_source_age_minutes: 1440
cron_utc: "30 20 * * *"
```

O `min_order_detail_coverage_pct` é a trava importante: **é melhor não escrever a aba do
que escrever um número 6% abaixo do real**. A página de monitoramento mostra o build como
*blocked* e diz por quê.

---

## Próximos exports que eu preciso

Para cada report novo, mande o `.csv`/`.xlsx` **cru, direto do Cin7** — eu faço a mesma
reconciliação e devolvo a spec pronta. Além disso, dois específicos ajudariam agora:

1. **`Sale Order Details` de um mês fechado** (ex.: julho inteiro) → alvo estável para
   validar o `detail-month` depois do primeiro run, sem o mês corrente se mexendo embaixo.
   *(As regras de `Discount` e `VOIDED` já estão fechadas.)*
2. **O nome e o caminho do workbook/aba** de destino de cada um dos dois — sem isso as
   specs ficam com `<a definir>`.
