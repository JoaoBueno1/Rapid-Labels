# Stock Planning — Fase seguinte: o que dá para automatizar a partir do Cin7

> Escrito depois do MVP estar de pé e com paridade fechada.
> Companion de `STOCK_PLANNING_01_DISCOVERY.md` (o Excel) e `_02_PLAN.md` (o módulo).
> Data: 2026-08-25 · branch `dev`

Hoje o time faz **tudo** à mão, linha por linha. A regra deste documento é: cada automação
tem que **tirar digitação sem tirar controle**. Nada entra que o planejador não possa ver,
conferir e desfazer.

---

## 0. O que já está sincronizado (verificado agora)

Boa notícia: a maior parte do trabalho de integração **já existe no app**. Frescor real:

| Tabela | Linhas | Último sync | Serve para |
|---|---:|---|---|
| `cin7_mirror.order_pipeline` | 1.752 | hoje 07:39 | cabeçalho de SO — cliente, data, referência, status |
| `cin7_mirror.sale_lines` | 51.687 | hoje 06:52 | **linhas de SO — já alimenta o import de projeto** |
| `cin7_mirror.stock_snapshot` | 15.336 | hoje 07:17 | SOH por local |
| `cin7_mirror.products` | 11.251 | ontem 16:31 | catálogo, custo médio, cartonagem |
| `cin7_mirror.locations` | 1.417 | ontem 16:25 | normalizar a coluna WAREHOUSE |
| **Ordens de compra** | — | — | **não existe espelho. É a maior lacuna** |

O import de Sales Order do MVP já usa `sale_lines`. Não foi integração nova: foi ligar um cabo
entre duas coisas que já estavam no mesmo banco.

---

## 1. Produtos: catálogo e SKUs novos

**Hoje:** o SKU só entra no planejamento quando alguém o adiciona numa aba de fornecedor.
Produto lançado esta semana simplesmente não existe no modelo até alguém lembrar.

**Proposta — job noturno, ~03:00:**

```
sync de products (já roda)
      │
      ▼
detectar SKUs em cin7_mirror.products que não estão em rapid_inv.sku_settings
      │
      ├─ grava em rapid_inv.sku_intake  (status = NEW)
      └─ NÃO entra no planejamento sozinho
```

O planejador abre **Novos produtos**, vê a lista da noite e decide um a um: fornecedor,
`Wk/Avg` inicial, meta de cobertura, entra ou não no planejamento.

**Por que não entrar automático:** `Wk/Avg` é julgamento humano — foi o achado mais importante
do discovery (837 blocos conferidos, zero fórmulas). Um SKU entrando com média zero apareceria
como cobertura infinita e sumiria da tela de risco. Melhor pedir três campos ao planejador
uma vez do que entregar número errado todo dia.

**Também no mesmo job:**
- **SKU que sumiu do catálogo** ou virou inativo → marca `is_planned = false` e avisa, não apaga
- **SKU renomeado** (`-V1` → `-V2` → canônico) → cruza com `rapid_inv.sku_versions` (1.121 linhas
  já carregadas do `Sheet1`) e sugere o vínculo
- **Mudança de fornecedor** → sinaliza; não sobrescreve mapeamento curado sem confirmação

**Finder manual, já pronto:** `GET /find/skus` busca no catálogo vivo e mostra se o SKU já está
no planejamento. Serve para adicionar um produto no meio do dia sem esperar a madrugada.

**Esforço:** 1 dia (job + tela de intake). **Risco:** baixo, porque nada entra sozinho.

---

## 2. Estoque (SOH): trocar o paste pelo dado vivo

**Hoje:** o time exporta quatro relatórios do Cin7 e cola em `SOH`, `Projects`, `DALTON`,
`GATEWAY`. O importador do MVP faz o mesmo a partir do workbook.

**Proposta:** `planning_state.soh_source` já existe com dois valores. Trocar para `CIN7_LIVE`
faz `v_sp_soh` ler de `cin7_mirror.stock_snapshot` em vez do snapshot importado.

O que falta antes de virar a chave:
1. **Mapear os locais.** O workbook conhece Main (a aba chamada `DALTON`) e Gateway. O
   `stock_snapshot` tem 1.417 locais. Precisa de uma tabela de-para explícita — e decidir
   quais locais somam no "empresa inteira" que é a base do cálculo.
2. **Reproduzir a aba `Projects`.** Ela é o compromisso líquido de projeto (`Analysis!E`,
   negativo em 662 de 854 SKUs). É outro relatório, não o SOH. Descobrir qual filtro do Cin7
   a produz — sem isso a cobertura em meses muda de significado.
3. **Rodar os dois em paralelo por duas semanas** e comparar diariamente antes de trocar.

**Esforço:** 2–3 dias, quase todo em (1) e (2). **Ganho:** elimina quatro colagens por semana
e o estoque para de ter a idade da última exportação.

---

## 3. Ordens de compra: a lacuna real

**Hoje:** as POs são digitadas à mão no Excel, **com o custo unitário dentro da fórmula**
(539 custos distintos) e o câmbio idem (0,65 e 0,68 convivendo). Não existe espelho de PO
no `cin7_mirror`.

### 3a. Add PO manual — **já entregue no MVP**
Digita o número, escolhe o fornecedor, cola as linhas (SKU, qty, custo, due date) e grava.
O câmbio é resolvido pela vigência, não digitado. As linhas viram entrada de estoque na hora.
Isso sozinho já tira o pior da digitação e acaba com custo escondido em fórmula.

### 3b. Espelho de PO (`/purchaseList` + `/purchase/{id}`)
Mesmo padrão do `order_pipeline`: um sync que popula `cin7_mirror.purchase_orders` e
`purchase_lines`, e daí para `rapid_inv.po_lines` com `cin7_po_id` — a coluna já existe.

Cuidados que a análise do workbook deixou claros:
- **Casar por `sku_key`.** A aba PO's grava o SKU em maiúsculas e as outras em minúsculas.
  Isso custou 312 unidades de estoque entrando num único SKU até corrigirmos.
- **Não sobrescrever o que é do planejamento.** `due_date` é campo operacional: o time ajusta
  quando o fornecedor avisa atraso. Sync sobrescrever isso todo dia apagaria a informação mais
  valiosa da tela. Regra: Cin7 manda em quantidade, SKU e fornecedor; **a data de chegada é
  nossa até o contêiner ser recebido**.
- **Fornecedor por alias.** São 26 grafias para ~22 fornecedores, mais quatro (`AQUA`,
  `ENRICH`, `VISION`, `HENGJIAN`) sem aba nenhuma. A tabela `supplier_aliases` já resolve.

**Esforço:** 2–3 dias. **Prioridade: a mais alta das automações**, porque PO é o único dado
de planejamento que ainda depende inteiramente de digitação.

### 3c. Criar PO no Cin7 — **não na V1**
`cin7_po_id` está reservado. A ordem certa é: primeiro o espelho de leitura funcionando e
confiável por algumas semanas, depois recomendação de compra, e só então escrita — sempre com
revisão humana antes de enviar.

---

## 4. Sales Orders: do finder ao acompanhamento

### 4a. Import por finder — **já entregue**
`GET /find/orders` busca por número, cliente ou referência; mostra se já virou projeto;
`GET /find/orders/:n/lines` mostra as linhas para conferência; o POST importa. Testado com o
SO-286414: 25 linhas, sem redigitar nada, e a segunda tentativa foi recusada.

Cada linha nasce com um **draw sem data**. Inventar pick date seria pior que TBA.

### 4b. Manter o projeto vivo depois de importado
O SO muda no Cin7: linha acrescentada, quantidade alterada, pedido cancelado. Proposta:

| Mudança no Cin7 | O que o módulo faz |
|---|---|
| Linha nova no SO | acrescenta a linha, cria draw TBA, **marca como novidade** |
| Quantidade aumentou | atualiza `qty`, mantém os draws, sinaliza que sobrou saldo sem draw |
| Quantidade diminuiu | **não mexe nos draws**, sinaliza `over_planned` para o humano resolver |
| SO cancelado | `status = CANCELLED`, preserva tudo, tira da demanda |
| Faturado | atualiza `qty_inv`, o que já reduz `qty_to_pick` pela regra |

O princípio: **Cin7 manda no que é transacional; o planejamento manda no que é planejamento.**
Um sync que apaga um draw que alguém combinou com o cliente é pior que sync nenhum.

### 4c. Quote → projeto
Vale mapear o fluxo de cotação no Cin7 antes. Se a cotação tem número próprio, dá para
importar como projeto em `status = ACTIVE` com marcação de "ainda é quote", e trocar a
referência quando virar SO — sem perder os draws já planejados. **Precisa de uma conversa com
o time comercial antes de codar**: hoje ninguém planeja cotação, e não sabemos se querem.

---

## 5. Recebimento: fechar o ciclo da PO

Quando o contêiner chega, `po_lines.is_received` deveria virar `true` sozinho — hoje a linha
continuaria contando como estoque entrando para sempre.

Duas fontes possíveis, ambas já no app:
- webhook de estoque do Cin7 (a infra de webhook existe)
- o **WMS de recebimento** que já está em `features/wms/lib/wms-receiving.js`

Isso também dá de graça o **lead time realizado por fornecedor** (`recebido − data da PO`),
que hoje é chute. Com dois ou três meses disso, a sugestão de quando recomprar deixa de usar
um número fixo.

**Esforço:** 1–2 dias depois do 3b. **Depende de:** espelho de PO.

---

## 6. A semana de reporte

O passo que mais corrompe o workbook — mover o marcador em 22 abas e congelar a coluna que
virou passado — já é um botão (`POST /roll-week`, com log de quem rolou e quando).

**Automatizar:** job na segunda de manhã que rola a semana, guarda o snapshot de estoque
daquela semana e grava as vendas realizadas em `weekly_sales`. O alerta
`STALE_REPORTING_WEEK` já existe como rede de segurança para o caso de o job falhar.

**Esforço:** meio dia. **Ganho grande em relação ao esforço.**

---

## 7. Vendas semanais e o `Wk/Avg` calculado

`weekly_sales` hoje tem só a semana que estava no workbook. Acumulando de verdade:
- o histórico deixa de ser perdido toda semana (hoje a aba `WEEK SALES` é substituída inteira)
- dá para **calcular** a média semanal e mostrar ao lado da manual

**Regra que não muda:** o `Wk/Avg` do planejamento continua manual. A média calculada aparece
como sugestão — "você usa 16, os últimos 13 semanas dão 21" — com um botão para adotar.
Sobrescrever o número do planejador em massa mudaria a decisão de compra da empresa inteira
sem ninguém pedir.

Com dois anos acumulados dá para revisitar a **curva sazonal**, que hoje são 26 fatores
curados à mão. Aí sim faz sentido comparar o fator com o realizado.

---

## 8. TMS: PO → contêiner → navio → ETA

`po_lines` já tem `vessel` (a coluna `Require` do Excel, 756 linhas preenchidas com nomes de
navio) e `shipment_id` reservado. O app já tem container-builder e container-check.

O caminho: ligar `shipment_id` ao contêiner existente e fazer o `due_date` de planejamento
seguir o ETA do navio. Mudou o ETA, mudou a projeção — sem redesenhar tabela, que era o ponto
do desenho.

---

## 9. Ordem sugerida

| # | Item | Esforço | Por que nessa ordem |
|---|---|---|---|
| 1 | Espelho de PO (3b) | 2–3 d | único dado de planejamento ainda 100% digitado |
| 2 | Rolagem automática da semana (6) | ½ d | melhor relação ganho/esforço do documento |
| 3 | Intake de produtos novos (1) | 1 d | para de perder SKU lançado |
| 4 | Recebimento fecha a PO (5) | 1–2 d | precisa do 1; dá lead time real de brinde |
| 5 | SOH ao vivo (2) | 2–3 d | tem que resolver o mapa de locais antes |
| 6 | Manter SO sincronizado (4b) | 2 d | depende de acordar as regras de precedência |
| 7 | Vendas acumuladas e média sugerida (7) | 1–2 d | ganha valor com o tempo |
| 8 | TMS (8) | — | depois que o espelho de PO estiver estável |
| — | Criar PO no Cin7 (3c) | — | só depois de tudo acima rodando semanas |

---

## 10. Regras que valem para toda automação daqui pra frente

1. **Cin7 manda no transacional. O planejamento manda no planejamento.** Quantidade, SKU,
   cliente e faturamento vêm de lá. Draw, pick date, `Wk/Avg`, meta de cobertura e comentário
   são nossos, e nenhum sync os sobrescreve.
2. **Nada entra sem poder ser visto.** Toda automação escreve no `audit_log` com um autor
   identificável, não com "sistema".
3. **Divergência vira alerta, não sobrescrita.** Quando o Cin7 discorda do planejamento, o
   humano decide.
4. **Todo sync roda em dry-run primeiro** e reporta o que faria, como o importador do workbook.
5. **Sem IA nesta lista.** Tudo aqui é determinístico. Interpretar o texto livre de `REQUIRED`
   para sugerir data é um caso de IA legítimo — mas só depois, e sempre como sugestão que o
   planejador aceita ou recusa.
