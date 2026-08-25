# Stock Planning — Fase 1: Discovery do `Rapid-Inventory SKU 2026.xlsx`

> Análise direta do arquivo que o time usa **hoje**: `~/Downloads/Rapid-Inventory SKU 2026.xlsx`
> 28,7 MB · 35 abas · **2.594.917 células** · **989.963 fórmulas** · semana de reporte **23-Ago-2026**
> Extração feita célula a célula (valores + fórmulas), não por aparência visual.
> Data da análise: 2026-08-25 · branch `dev`

Este documento é a **fonte de verdade sobre o Excel**. O plano de construção está em
`STOCK_PLANNING_02_PLAN.md`. Nada aqui foi inventado: todo número veio da extração.

---

## 0. Por que ele é lento

990 mil fórmulas, das quais ~**560 mil são `SUMIFS` de coluna inteira** (`Project!$J:$J`,
`'PO''s'!$E:$E`) espalhadas por 22 abas de fornecedor × 109 semanas. Cada recálculo varre
1.031.089 linhas da aba `Project` — **5.351 delas têm dado real**. O resto é range vazio herdado.

Não é problema de máquina. É `O(fórmulas × linhas_do_range)`. Em banco isso vira um
`GROUP BY sku, week` sobre 5 mil linhas — três ordens de grandeza menor.

---

## 1. Mapa das 35 abas por papel

| Papel | Abas | Como o dado entra |
|---|---|---|
| **Entrada colada do Cin7** | `SOH`, `Projects`, `DALTON`, `GATEWAY`, `WEEK SALES`, `WK Project` | export do Cin7 → copiar/colar semanal |
| **Operacional manual** | `Project`, `Completed Projects`, `PO's` | digitação humana (vendas / CS / compras / armazém) |
| **Motor de previsão** | 22 abas de fornecedor | fórmulas + **parâmetros manuais** por SKU |
| **Consolidação/decisão** | `Analysis`, `BOM`, `Stock Value` | 100% derivadas |
| **Referência** | `Sheet1` | mapa de versão de SKU (-V1/-V2/-V3) |

---

## 2. Aba por aba

### 2.1 `Project` — o coração operacional (5.351 linhas vivas)

Range declarado `A1:AB1031089`, mas só **5.351 linhas têm dado**.

| Col | Header | Tipo | Preenchimento real |
|---|---|---|---|
| A | DATE | data do pedido | todas |
| B | *(sem header — `B1` foi sequestrado por `=TODAY()`)* | **Sales Order** | 279 SOs distintos |
| C | CUSTOMER | texto | 130 clientes |
| D | REFERENCE | projeto/obra | — |
| E | REP | vendedor | 24 reps |
| F | SKU | texto | 1.020 SKUs |
| G | QTY | número | — |
| H | TYPE | código do tipo de luminária na planta do cliente | **957 valores distintos** (livre) |
| I | UNIT PRICE | moeda | — |
| J | **QTY to Pick** | **fórmula** | `=IF(G-P-M>0, G-P-M, "")` |
| K | PO | texto | 508 linhas |
| L | **PICK DATE** | data | **2.668 preenchidas / 2.683 vazias** |
| M | QTY HELD | número | 357 |
| N | Date packed | data | 349 |
| O | **Days held** | **fórmula** | `=IF(N>0, $B$1-N, 0)` — `$B$1` é `=TODAY()` |
| P | QTY INV | número | 1.990 |
| Q | REQUIRED | **texto livre de agenda** | **5.048 preenchidas, 316 distintas** |
| R | WAREHOUSE | texto livre | misturado (ver 3.3) |
| S | ACTION | — | **0 preenchidas — coluna morta** |
| T/U/V | Comments 1/2/3 | texto | **11 / 0 / 0** — praticamente mortas |
| W | ITEM | — | **0 — coluna morta** |

**Regras extraídas:**
- `QTY to Pick = QTY − QTY INV − QTY HELD`, com piso em zero (string vazia quando ≤0).
  É **a demanda ainda em aberto** — e é ela que alimenta todo o forecast.
- `Days held = hoje − Date packed` — aging do que está embalado e parado.
- Não existe coluna de status nem de finish date. **Concluir um projeto = recortar as linhas
  e colar em `Completed Projects` à mão.**

**`REQUIRED` é a coluna mais rica e mais ignorada.** Amostras reais:
`"6-8 Month Delay - Nov 2023"`, `"From June 2024"`, `"Delivery Monday October 14th"`,
`"Tal TBC"`, `"Starting March 2024"`, `"April 24th 2025"`. É o **cronograma real do cliente**
em texto livre — 94% das linhas têm. Não pode ser descartada.

**Múltiplos draws já existem, disfarçados de linhas duplicadas:**
- 747 pares `SO + SKU` aparecem em mais de uma linha
- **391 desses grupos têm datas de pick diferentes** entre as linhas
- **197 misturam linha com data e linha sem data**

O time **já faz** planejamento por parcelas. O Excel só não tem onde guardar isso, então
duplica a linha. Isso valida sozinho o modelo `Projeto → Linha → Draw`.

⚠️ **Correção importante sobre o que essas linhas repetidas são.** A primeira leitura supôs que
fossem parcelas de uma mesma linha. Os dados dizem outra coisa. Em `SO 207455 / R5511` há oito
linhas, cada uma com sua QTY, sua QTY INV e seu próprio texto de agenda: *"Delivery 15th May
2025"*, *"Delivery 16th June 2025"*, *"Delivery 16th July 2025"*… Não são parcelas de uma
linha: são **chamadas de entrega distintas**. **A linha do Excel já é o draw.**

Consequência para a migração: o import é **1-para-1**, e nada é fundido. Cada linha do
workbook vira uma linha com um draw. O ganho do modelo aparece daí em diante — quando o
planejador quiser dividir um saldo em duas datas, ele acrescenta um draw em vez de duplicar
a linha inteira.

---

### 2.2 `Completed Projects` — o arquivo (18.767 linhas / 1.680 SOs)

Mesmas colunas + `A = Finish Date` e `M = PO Due`. Perde `WAREHOUSE`, `Comments 3`, `ITEM`.

⚠️ **Só 9.861 das 18.767 linhas têm Finish Date** — 47% do arquivo histórico perdeu a data de
conclusão no recorta-e-cola. Não é aba diferente: é `Project` com um status a mais.

---

### 2.3 `PO's` — ordens de compra (1.466 linhas / 258 POs)

| Col | Header | Observação |
|---|---|---|
| A | PO # | `PO-13087` |
| B | Date | data da PO — 02-Nov-2025 → 23-Ago-2026 |
| C | Supplier | **26 grafias distintas** para ~22 fornecedores |
| D | SKU | — |
| E | QTY | — |
| F | Finish Date | data de produção pronta, ou a string `"Ready"` — 1.139 linhas |
| G | Date Checked | QC — 78 linhas |
| H | **Due Date** | **ETA no armazém — é isto que vira "Inventory In"** — 1.466 linhas |
| I | Require | **nome do navio** — 756 linhas (`"MSC Unity"`, `"Seagull MSC Daisy"`) |
| J | Value USD | `=QTY × custo_unitário_cravado_na_fórmula` |
| K | Value AUD | `=USD / 0.65` **ou** `/ 0.68` |
| M/N | Barcode / OCL | **0 preenchidas — colunas mortas** |

**Problemas quantificados:**
- **539 custos unitários distintos cravados dentro das fórmulas.** Não existe campo de custo.
  Corrigir um custo = editar fórmula.
- **Duas taxas de câmbio convivendo** (0,65 e 0,68) na mesma coluna. Sem tabela de FX.
- Grafias de fornecedor: `AOK` e `AOK ` (espaço), `X TRACK` vs aba `Xtrack`, `ELITE` vs `E-Lite`,
  `EPOWER` vs `ePower`, `FOSHAN KL` vs `Foshan`. Mais 4 fornecedores **sem aba nenhuma**:
  `AQUA`, `ENRICH`, `VISION`, `HENGJIAN`.
- Horizonte: due dates vão de 15-Ago-2026 a **19-Dez-2026** — só ~17 semanas de incoming
  conhecido. **1.446 linhas são futuras.**
- Coluna `Require` (navio) é o **gancho natural para o TMS** que já existe no sistema.

---

### 2.4 As 22 abas de fornecedor — **o motor**

`Aeon, AGC, AOK, CGD, CNEPSO, Cowin, Dolight, E-Lite, ePower, Foshan, General, Huibo,
Kinglumi, LEDLUZ, Mixed, Ottima, Relight, Sealite, Senselite, Starlux, Upshine, Xtrack`

**3.725 blocos de SKU no total.** Todas com a **mesma grade**: 109 semanas,
`01-Jun-2025 → 27-Jun-2027`, coluna `E` até `DI`, semana de reporte em **`BQ` = 23-Ago-2026**.

**Cabeçalho (linhas 1–5), compartilhado por todos os blocos:**

| Linha | Conteúdo |
|---|---|
| 2 | **fator sazonal da semana** (100% = normal) |
| 3 | número da semana |
| 4 | **data de fim de semana** — `=anterior+7` (domingos) |
| 5 | marcador `1` na **semana de reporte** (única célula) |

**Cada SKU ocupa um bloco de 7 linhas:**

```
linha+0   A="Product SKU"   B=<SKU>   C=<código legado>
linha+1   Opening Inventory Level     → semanal: = fechamento da semana anterior
linha+2   Inventory In:               → semanal: SUMIFS(PO's.QTY; PO's.DueDate=semana; PO's.SKU=sku)
linha+3   Inventory/Sales Out         → semanal: ver fórmula abaixo
linha+4   Project orders              → semanal: ver fórmula abaixo
linha+5   Closing Inventory Level     → semanal: ver fórmula abaixo
```

**As três fórmulas que são todo o negócio** (célula `BR`, primeira semana futura):

```excel
Sales   =IF(BR$5>0, IFNA(VLOOKUP($B6,'WEEK SALES'!$A:$B,2,0),0),  $B9 * BR$2 )
Project =IF(BR$5>0, IFNA(VLOOKUP($B6,'WK Project'!$A:$B,2,0),0),
                    SUMIFS(Project!$J:$J, Project!$L:$L, BR$4, Project!$F:$F, $B6) )
Closing =IF(BR$5>0, VLOOKUP($B6,SOH!$A:$E,5,FALSE),  BR7 + BR8 - BR9 - BR10 )
```

Lidas em português:

- **Se é a semana de reporte** → usa o **realizado**: vendas da `WEEK SALES`, projetos da
  `WK Project`, e o fechamento é o **SOH real do Cin7**. A semana de reporte é a **âncora**
  que ressincroniza o modelo com a realidade toda semana.
- **Se é semana futura** → projeta: `Sales = Wk/Avg × fator_sazonal`,
  `Project = soma dos QTY-to-Pick cuja PICK DATE cai exatamente naquela semana`,
  `Closing = Opening + In − Sales − Project`.
- **Opening da semana seguinte = Closing da semana anterior.** Cascata pura.

**A coluna `B` de cada bloco é o painel de parâmetros do SKU:**

| Linha | `B` contém | Origem |
|---|---|---|
| Inventory In | `=VLOOKUP(sku, SOH!A:E, 4)` | total **On Order** |
| **Sales Out** | **número digitado à mão = `Wk/Avg`** | **manual — 0 fórmulas em 837 blocos amostrados** |
| Project orders | `=-VLOOKUP(sku, Projects!A:I, 9)` | compromisso de projeto (positivado) |
| **Closing** | `=B(sales) × N` | **meta de cobertura em semanas** |

Dois achados que mudam o modelo de dados:

1. **`Wk/Avg` é 100% entrada manual.** Verificado em Aeon, Relight, Upshine, CGD e Kinglumi:
   **837 blocos, zero fórmulas**. Não é média calculada — é **julgamento do planejador**.
   Migrar isso como "calculado" quebraria a paridade e mudaria toda a decisão.
2. **A meta de cobertura varia por SKU.** O multiplicador não é fixo:
   `Aeon {6:80, 7:42, 4:1, 8:1}` · `Relight {4:119, 6:195, 7:66}` ·
   `CGD {6:41, 7:44, 8:41}` · `Kinglumi {7:34, 10:34, 6:4, 1:2}`.
   Ou seja: **4, 6, 7, 8 e 10 semanas** de cobertura-alvo, escolhidas SKU a SKU.

**A curva sazonal é global, não por fornecedor.** As 22 abas têm **exatamente os mesmos
26 fatores nas mesmas semanas** — é o **Ano Novo Chinês**, duas vezes:

| Semana | Fator | | Semana | Fator |
|---|---|---|---|---|
| 07-Dez-25 | 80% | | 06-Dez-26 | 80% |
| 14-Dez-25 | 73% | | 13-Dez-26 | 73% |
| 21-Dez-25 | 54% | | 20-Dez-26 | 25% |
| 28-Dez-25 | 12% | | 27-Dez-26 | **0%** |
| 04-Jan-26 | **0%** | | 03-Jan-27 | 15% |
| 11-Jan-26 | 60% | | 10-Jan-27 | 50% |
| 18-Jan-26 | 75% | | 17-Jan-27 | 75% |
| 25-Jan-26 | 77% | | 24-Jan-27 | 70% |
| 01-Fev-26 | 66% | | 31-Jan-27 | 75% |
| 08-Fev a 01-Mar-26 | 80% | | 07-Fev a 28-Fev-27 | 80% |

⚠️ **O fator só multiplica vendas normais.** Draws de projeto e POs **não** são sazonalizados.
Isso é correto e precisa ser preservado.

**Fragilidade:** **5.133 células de erro** (`#REF!` / `#N/A`) nas 22 abas.
Piores: `CGD` 1.572, `Upshine` 1.574, `Relight` 771, `AGC` 475.

---

### 2.5 `Analysis` — a tela de decisão (1.988 SKUs)

| Col | Header | Fórmula |
|---|---|---|
| A | Product SKU | — |
| B | **Wk/Avg** | `=INDEX(<Fornecedor>!B:B, MATCH(A3,<Fornecedor>!B:B,0)+3)` |
| C | Mth Avg | `=B*52/12` |
| D | SOH | `=VLOOKUP(A, SOH!A:K, 5)` → **Available da empresa toda** |
| E | Project Orders | `=VLOOKUP(A, Projects!A:I, 9)` → normalmente **negativo** |
| F | **Mths Stock** | **`=IF(D>0, (D+E)/C, "")`** |
| G | Comments | manual — **1 preenchida em 1.988** |
| H,I,J | Project Draws | `SUMIFS(Project!J; Project!L=data; Project!F=sku)` — 3 semanas |
| K,L,M | Incoming | `SUMIFS(PO's!E; PO's!H=data; PO's!D=sku)` — 3 semanas |
| N | Dalton SOH | `=IFNA(VLOOKUP(A, DALTON!A:F, 6), 0)` |
| O | Gateway SOH | `=IFNA(VLOOKUP(A, GATEWAY!A:F, 6), 0)` |

**O nome da aba de fornecedor está cravado dentro da fórmula da coluna B.**
É esse hardcode que define o mapa SKU→fornecedor. Extraído integralmente:

| Fornecedor | SKUs | | Fornecedor | SKUs |
|---|---:|---|---|---:|
| CGD | 492 | | Sealite | 38 |
| Relight | 404 | | Cowin | 36 |
| Upshine | 239 | | Ottima | 33 |
| AGC | 132 | | ePower | 26 |
| Aeon | 113 | | General | 20 |
| Kinglumi | 81 | | E-Lite | 20 |
| Xtrack | 81 | | AOK | 13 |
| CNEPSO | 77 | | Senselite | 13 |
| Foshan | 71 | | Huibo | 12 |
| LEDLUZ | 42 | | Starlux | 4 |
| Mixed | 40 | | *(1 linha sem fórmula)* | 1 |

**A distribuição real de `Mths Stock`** (o número que a compra olha):

| | valor |
|---|---|
| SKUs com número | 1.274 |
| **SKUs em branco porque `SOH ≤ 0`** | **714 (36%)** |
| negativos (ruptura já instalada) | 40 |
| **< 1 mês (recomprar agora)** | **125** |
| 1–3 meses | 201 |
| > 12 meses (capital parado) | 360 |
| mediana | 6,00 meses |
| mínimo / máximo | −41,7 / 346 |

⚠️ **Os 714 em branco são o buraco mais perigoso do Excel.** `IF(D>0,...)` significa:
**SKU zerado não mostra alerta nenhum** — ele simplesmente some da tela de decisão.
Justamente o SKU em pior situação é o invisível.

---

### 2.6 `SOH`, `Projects`, `DALTON`, `GATEWAY` — os quatro estoques

São **quatro exports diferentes do Cin7**, com escopos diferentes, colados à mão:

| Aba | Linhas | Escopo real | Alimenta |
|---|---:|---|---|
| `SOH` | 2.900 | **empresa inteira** (`Available = OnHand − Allocated`) | `Analysis!D`, Closing da semana de reporte |
| `Projects` | 854 | **estoque em locais de projeto** — 746 com `Allocated>0`, **662 com Available negativo** | `Analysis!E` |
| `DALTON` | 2.282 | header diz literalmente **"Main Warehouse"** | `Analysis!N` |
| `GATEWAY` | 396 | Gateway | `Analysis!O` |

Verificações cruzadas:
- `SOH.qty == DALTON + GATEWAY` em apenas **931 de 2.393 SKUs** → existem outros locais
  (Sydney, Brisbane, Cairns, Coffs…) fora dessas duas abas.
- `SOH.qty == Projects.qty` em apenas 56 de 689 → confirmam-se escopos distintos.

⚠️ **A aba chamada `DALTON` contém o Main Warehouse.** O nome engana. Qualquer migração que
tratasse "Dalton" como filial secundária inverteria o significado do número.

---

### 2.7 `WEEK SALES` e `WK Project` — o realizado da semana

- `WEEK SALES` (1.059 linhas): export do Cin7 com período **cravado no texto**
  (`From: 17-Aug-2026` / `To: 23-Aug-2026`). Colunas: Qty, Sale, **COGS**, Invoice, **Profit**.
  Só a coluna B (Qty) é consumida pelo motor.
- `WK Project` (1.167 linhas, **zero fórmulas**): qty de projeto realizada na semana, por SKU.

Ambas são **substituídas inteiras toda semana**. Não há histórico: a semana anterior é perdida
no momento em que a nova é colada. O histórico só sobrevive congelado dentro das
abas de fornecedor, como valores.

---

### 2.8 `BOM` — nome enganoso

**Não explode componentes.** É `-VLOOKUP(Projects)` na coluna B + `SUMIFS(Project!J)` por
semana — ou seja, **o mesmo agregador de demanda de projeto do `Analysis`**, em granularidade
semanal, para 5.764 linhas. Duplicação pura da mesma lógica.

Não existe relação pai/componente em lugar nenhum do workbook.

---

### 2.9 `Stock Value` — projeção financeira

Blocos por armazém (`Main Warehouse`, `Brisbane Warehouse`, …), cada um com dois cenários:

```
FORECAST:  Opening → In → Out → Closing (=Opening+In−Out)     linhas 6–9
ACTUAL:    Opening → In → Out → Closing                        linhas 12–15
linha 10:  Percentage of month sales  (20%, 30%, 25%…)   ← 2º mecanismo sazonal, distinto da Row 2
linha 16:  variância  =Out / $B$99
linha 17:  Ideal closing stock  ($4.917.605)
```

Grade em AUD por semana desde 02-Jul-2023. É a única aba com **meta de estoque ideal** e
**forecast vs actual** explícitos.

---

### 2.10 `Sheet1` — mapa de versão de SKU

1.787 linhas: `Version Code` (`R1066-WH-12W-CW-24-V1`) → `Current Dear Code` → validação
`VLOOKUP` contra o catálogo mestre na coluna L.
**1.121 têm código atual; só 904 resolvem.** É o registro de que SKUs mudam de código com
sufixo `-V1/-V2/-V3` e o planejamento precisa saber que são o mesmo produto.

---

## 3. O ritual semanal (o que realmente consome o time)

Toda semana, à mão:

1. Exportar do Cin7 e colar: `SOH`, `Projects`, `DALTON`, `GATEWAY`, `WEEK SALES`, `WK Project`
2. Digitar POs novas em `PO's` — **incluindo o custo unitário dentro da fórmula**
3. Atualizar `Project`: pick dates, qty held, date packed, qty inv, texto do `REQUIRED`
4. Recortar linhas concluídas e colar em `Completed Projects`, preenchendo `Finish Date`
5. **Mover o marcador `1` da linha 5 uma coluna à direita**, em cada uma das 22 abas
6. Congelar a coluna que virou passado (colar valores por cima das fórmulas)
7. Esperar o recálculo de 990 mil fórmulas
8. Ler `Analysis!F`, decidir o que recomprar — **e calcular a quantidade fora do Excel**

Passos 5 e 6 são a parte que corrompe o arquivo. Passo 8 é a decisão que o Excel nunca modelou.

---

## 4. Fragilidades quantificadas (todas verificadas)

| # | Achado | Número | Consequência |
|---|---|---|---|
| 1 | **Pick dates fora do domingo** | **32 de 2.668** | `SUMIFS` não casa → **a demanda some do forecast, sem erro** |
| 2 | **PO due dates fora do domingo** | **7 de 1.466** | incoming nunca aparece |
| 3 | **`Mths Stock` em branco quando SOH ≤ 0** | **714 de 1.988** | SKU pior fica invisível |
| 4 | **Células de erro nas abas de fornecedor** | **5.133** | linhas de SKU sem projeção |
| 5 | Demanda sem pick date | **2.683 de 5.351 (50%)** | metade da demanda conhecida fora do forecast |
| 6 | Custos cravados em fórmula | 539 distintos | sem campo de custo, sem histórico |
| 7 | FX misturado na mesma coluna | 0,65 **e** 0,68 | valores AUD inconsistentes |
| 8 | Grafias de fornecedor | 26 para ~22 | agrupamento errado; 4 sem aba |
| 9 | Finish Date perdido no arquivo | 8.906 de 18.767 | histórico sem data |
| 10 | Sem trilha de auditoria | — | ninguém sabe quem mudou a pick date |
| 11 | Sem controle de acesso | — | qualquer um edita qualquer célula |
| 12 | Arquivo de usuário único | — | 50–80 pessoas não podem trabalhar juntas |

| 13 | **Células com valor velho** | ver §4.1 | a fórmula está lá; o cache não bate com ela |
| 14 | **Fórmula de QTY to Pick sobrescrita** | **5 linhas** | alguém digitou por cima; a linha mente |
| 15 | **SKU em caixa diferente entre abas** | ver §4.2 | invisível no Excel, quebra qualquer sistema |

Os itens 1, 2 e 3 são os graves: **eles não dão erro.** O número aparece, parece certo, e está
errado. É exatamente o tipo de coisa que um banco de dados elimina por construção.

### 4.1 O workbook mostra números que ele mesmo não recalcularia

Achado durante a validação de paridade, comparando célula a célula contra um `SUMIFS`
recomputado a partir da aba `Project`:

- `C328-42600DB-F`, semana de 30-Ago, aba Kinglumi: a célula exibe **262**. Ela **tem fórmula**.
  Um `SUMIFS` correto sobre a aba `Project` dá **270**.
- `R6336-TRI`, aba AGC: exibe **5 / 3 / 26 / 14** em quatro semanas. O `SUMIFS` real dá **0**
  em todas. Aquela demanda não existe mais na aba `Project`.
- Linhas de venda de vários SKUs exibem o `Wk/Avg` cru em semanas de Ano Novo Chinês — o fator
  da linha 2 está lá e simplesmente não foi aplicado.

Com 990 mil fórmulas, ninguém deixa o Excel em cálculo automático. A consequência é que
**a tela de decisão mostra números defasados em relação aos próprios dados do arquivo**, sem
nenhum sinal de que estão defasados.

### 4.2 O mesmo SKU escrito de dois jeitos

A aba `PO's` grava `12V-IP20-012W`; as abas de estoque e planejamento gravam `12v-IP20-012w`.
O `SUMIFS` do Excel ignora caixa e casa. Qualquer sistema que use igualdade exata não casa —
e some estoque entrando. Num único SKU da primeira amostra de paridade isso valia **312
unidades**. Também existem dois pares de SKU que diferem *só* na caixa dentro da mesma aba
(`R2121-Trim-BK` × `R2121-TRIM-BK`, `R-TVPAL-F-v2` × `R-TVPAL-F-V2`).

---

## 5. O que precisa ser preservado sem discussão

1. `QTY to Pick = QTY − QTY INV − QTY HELD`, piso zero
2. `Days Held = hoje − Date Packed`
3. `Mths Stock = (SOH + Project Orders) / (Wk/Avg × 52 ÷ 12)` — **soma**, porque `E` é negativo
4. `Closing = Opening + In − Sales − Project`; `Opening(n) = Closing(n−1)`
5. **Semana de reporte reancora tudo no realizado** (SOH real, vendas reais, projetos reais)
6. `Sales_futuro = Wk/Avg × fator_sazonal`; **fator não se aplica a projeto nem a PO**
7. **`Wk/Avg` é parâmetro manual do planejador**, não média calculada
8. **Meta de cobertura é por SKU** (4/6/7/8/10 semanas)
9. Fator sazonal é **global**, por semana de calendário
10. `Inventory In` vem do **Due Date** da PO (não da data da PO, não do Finish Date)
11. `Analysis!D` é **estoque da empresa inteira**; filial é contexto, não base de cálculo
12. Texto livre de `REQUIRED` é cronograma real do cliente — preservar íntegro
13. Múltiplos draws por SO+SKU já são prática corrente (391 casos)

---

## 6. Volumes reais (dimensionamento)

| Entidade | Volume |
|---|---|
| Linhas de projeto ativas | **5.351** |
| Sales Orders ativos | 279 |
| Clientes | 130 · Reps | 24 |
| SKUs em projeto | 1.020 |
| Linhas de projeto históricas | 18.767 (1.680 SOs) |
| Linhas de PO | 1.466 (258 POs, 1.446 futuras) |
| SKUs no `Analysis` | 1.988 |
| Blocos SKU nas abas de fornecedor | 3.725 |
| SKUs com SOH | 2.900 |
| Semanas de grade | 109 (`01-Jun-25 → 27-Jun-27`) |
| Mapa de versão de SKU | 1.787 |

Nada disso é grande para Postgres. O grid inteiro de planejamento é
`1.988 SKUs × 52 semanas ≈ 103 mil células` — calculadas, não armazenadas.
