# Re-Stock V2 — "Closed-loop" replenishment task: vale a pena? (análise)

**Contexto:** a auditoria de mercado apontou como o maior gap vs um WMS de verdade a
*task fechada scan-confirmada reserva→pickface* — em vez de só imprimir uma lista de
sugestões, o operador escaneia/confirma cada movimento, o sistema decrementa a reserva
e registra que o top-up aconteceu. Joao pediu: **analisar se vale, porque não dá pra
mudar muito o processo hoje.**

**Veredito curto: NÃO construir a versão completa agora.** O ganho real que ela traz
já é coberto pelo sync do Cin7 — desde que os movimentos de bin sejam registrados no
Cin7 —, e a versão completa exige mudança de processo + write-back de estoque (arriscado).
Há uma alternativa leve de 20% do esforço que entrega 80% do valor operacional.

---

## O que a feature seria

1. Re-Stock diz "mova 100 de `MA-A-05-L3` (reserva) para o pickface `MA-A-01-L1`".
2. O operador **escaneia** o produto + bin de origem + bin de destino (ou confirma na tela).
3. O sistema **decrementa a reserva**, **zera o déficit do pickface**, e grava a task como
   *feita* (quem, quando, quanto) → histórico + prova de execução.

Isso é a feature **definidora** de um WMS forward-pick (Manhattan, Blue Yonder). Faz sentido
lá porque **o WMS É a fonte de verdade do estoque**.

---

## Por que, no Rapid LED, ela vale menos do que parece

### 1. O Cin7 é a fonte de verdade — não o Re-Stock
O Re-Stock **lê** `cin7_mirror.stock_snapshot` (sync horário). Ele não é dono do estoque.
Se o operador mover fisicamente 100 unidades reserva→pickface e **registrar isso no Cin7**
(bin transfer), o **próximo sync já reflete** o novo on_hand do pickface e da reserva —
sem o Re-Stock escrever nada. Ou seja: **o "loop" já fecha sozinho pelo sync**, contanto
que o movimento entre no Cin7. O que o Re-Stock ganharia é só *imediatismo* (não esperar
até 1h de sync) e *prova/histórico* — não a correção do saldo.

### 2. A versão completa exige write-back de estoque — e isso é a parte perigosa
Pra decrementar a reserva "de verdade", o Re-Stock teria que **escrever um movimento de
bin no Cin7**. Já temos cicatriz disso: o bug de correção de pick-anomaly corrompeu estoque
do Cin7 em massa (ver `[[project_pick_anomaly_overflow_bug]]`). Escrever estoque de volta no
Cin7 a partir de uma tela de replenishment é exatamente a classe de operação que mais dá
errado. **Alto risco, num sistema que hoje é read-only e seguro.**

### 3. Sem write-back, o decremento vira uma segunda verdade que dá drift
Se o Re-Stock decrementa a reserva **só no banco dele** (sem Cin7), passa a existir um
saldo "Re-Stock" divergindo do "Cin7", e no próximo sync o Cin7 **sobrescreve** de volta.
Resultado: número que pisca/volta, confiança destruída. Fazer isso direito **obriga** o
write-back do item 2.

### 4. Exige mudança de processo — justamente o que não dá pra fazer agora
A task fechada só tem valor se o operador **escanear todo replenishment**. Se hoje ele não
escaneia esse movimento, a feature adiciona um passo obrigatório no chão de fábrica. Joao
foi explícito: **não dá pra mudar muito o processo hoje.** Uma feature que depende de novo
hábito operacional entrega zero até o hábito existir.

### 5. Lead-time interno é minutos, não semanas
O "loop" importa muito num WMS porque a reposição do pickface disputa com picking em tempo
real. Aqui a reserva está **no mesmo prédio**, a poucos metros. O custo de um pickface
momentaneamente vazio é um walk extra até a reserva — não uma ruptura de venda. O ROI da
rastreabilidade fina é proporcionalmente menor.

---

## O que REALMENTE dói hoje (e a task fechada não resolve)

O gargalo real não é "provar que o top-up aconteceu" — é **o Re-Stock não saber que o
pickface esvaziou até o próximo sync**, e **não priorizar bem** o que reabastecer. Isso se
ataca com dado fresco + boa priorização (já temos os dois em grande parte), não com scan.

---

## Recomendação

**Não construir a task fechada scan-confirmada agora.** Custo alto (write-back arriscado +
mudança de processo) para um ganho que o sync do Cin7 já entrega em ~1h.

**Alternativa leve (se quiser fechar a lacuna de "prova/histórico") — ~20% do esforço:**

1. **"Mark as done" sem escrita de estoque.** Botão na sugestão/print que grava numa tabela
   própria (`restock_tasks`: sku, from_bin, to_bin, qty, operador, timestamp) apenas como
   **registro/histórico** — nunca toca o estoque do Cin7. Fecha o loop de *rastreabilidade*
   sem virar segunda-fonte de verdade nem exigir scan.
2. **Deixar o Cin7 ser a verdade do saldo.** O saldo continua vindo do sync; o "done" é só
   um log de "eu tratei esta linha", que some/limpa quando o sync confirma o pickface cheio.
3. **(Opcional) Reduzir a janela de sync** para as horas de pico de reposição, se o atraso
   de 1h incomodar — muito mais barato que rastreabilidade transacional.

Isso dá o histórico ("o que foi reabastecido, por quem") e tira linhas já-tratadas da lista,
**sem** mudar processo e **sem** risco de corromper estoque.

**Só reconsiderar a versão completa se/quando:** (a) o processo passar a escanear todo
replenishment de qualquer forma, e (b) existir um caminho de write-back de bin no Cin7 já
comprovado e seguro (mesmo padrão de gate do `CIN7_WRITEBACK_ENABLED`).

---

## Resumo

| | Task fechada completa | Alternativa leve ("mark as done") | Não fazer nada |
|---|---|---|---|
| Prova/histórico de reposição | ✅ | ✅ | ❌ |
| Corrige saldo na hora | ✅ (via write-back) | ❌ (Cin7 corrige no sync) | ❌ (Cin7 corrige no sync) |
| Muda o processo do operador | ❌ obriga scan | ✅ opcional, 1 clique | ✅ |
| Risco de corromper estoque Cin7 | 🔴 alto | 🟢 nenhum | 🟢 nenhum |
| Esforço | Grande | Pequeno | Zero |

**Decisão registrada:** ficar no "não fazer" por ora; se a lacuna de histórico incomodar,
subir para o "mark as done" leve. Não construir write-back de estoque a partir do Re-Stock.
