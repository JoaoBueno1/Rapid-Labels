# Excel Sync — entrega via Microsoft Graph (Fase 5)

> Decidido em 2026-08-08: **push via Graph** (as planilhas precisam estar atuais sem
> ninguém abrir) e **escrita direta na aba que já existe** (não numa aba de dados
> separada). Este doc é o plano dessa fase.
>
> As fases 1–4 estão prontas e no ar: os datasets são construídos, validados contra o
> export do Cin7 e materializados em `excel_sync.dataset_rows`. Ver
> [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) e
> [../features/excel-sync/README.md](../features/excel-sync/README.md).

## 1. O volume não é o problema

Medido em 2026-08-08 sobre os datasets reais:

| Dataset | Linhas | Colunas | Células | JSON | Chamadas Graph |
|---|---:|---:|---:|---:|---:|
| monthly-sales | 864 | 31 | 18.064 | 0,09 MB | **1** |
| stock-level | 3.698 | 121 | 447.458 | 2,12 MB | **3** (lotes de ~1 MB) |

Escrever isso leva segundos. O custo desta fase está em **permissão** e em **não
destruir a planilha de alguém** — não em performance.

## 2. O caminho crítico: consentimento no Azure

É a única coisa aqui que **não dá para paralelizar**. Sem isso, todo o resto fica
pronto e parado. O pedido tem de sair antes de qualquer código.

### O que pedir ao TI

> ⛔ **Corrigido em 2026-08-13. A versão anterior desta seção pedia a coisa
> errada** — `Sites.Selected` como *Application permission* — e argumentava
> contra `Files.ReadWrite.All`. O raciocínio (menor privilégio, mais fácil de
> aprovar) estava certo em geral e **errado para este caso**, porque a API de
> workbook do Graph não aceita permissão de aplicação de forma alguma:
>
> ```
> PATCH  /workbook/worksheets/{id}/range   Application: Not supported.
> POST   /workbook/createSession           Application: Not supported.
> ```
>
> Tabelas de permissão da Microsoft, conferidas em 2026-08-13
> ([range update](https://learn.microsoft.com/en-us/graph/api/range-update) ·
> [createSession](https://learn.microsoft.com/en-us/graph/api/workbook-createsession)).
>
> Um token app-only com `Sites.Selected` **acha o arquivo, lê o arquivo e não
> escreve uma célula**. Falha no primeiro PATCH, com 21 bindings já configuradas,
> parecendo bug de código. Custa um ciclo inteiro de consentimento para descobrir.

**Solicitação correta:**

> - **App:** `Rapid labels - Excel sync` (já existe)
> - **Permissão:** Microsoft Graph → **Delegated** → **`Files.ReadWrite.All`**,
>   com **consentimento de admin** (o tenant bloqueia consentimento de usuário —
>   `AADSTS90094`, reconfirmado em 2026-08-13)
> - **Uma conta de serviço** para o job rodar como ela, com acesso de edição
>   **só** a `Rapid LED - Data` → `Inventory Management/Inventory Stock Orders`.
>   Precisa conseguir fazer um device-code login uma vez e não ser forçada a
>   reautenticar interativamente.
> - **`Allow public client flows = Yes`** no app registration — ✅ **já está ligado**,
>   confirmado em 2026-08-13 (o device code foi emitido).

**Por que `.All` e não `Files.ReadWrite`:** o mínimo da tabela da Microsoft é
`Files.ReadWrite`, mas delegado ele alcança **só o OneDrive do próprio usuário**.
Estes arquivos estão numa biblioteca do SharePoint. Quem "reduzir" o escopo para
o mínimo documentado vai receber um token válido que não enxerga os arquivos.

**Onde ficou a contenção.** Era para vir do `Sites.Selected` (app limitado a um
site, via `POST /sites/{id}/permissions`). Com token delegado isso não se aplica:
o alcance é o que a **conta** enxerga, não o que o app recebeu. Então a contenção
mudou de lugar — é a permissão da conta de serviço na biblioteca. Diferença
honesta: se alguém der a essa conta acesso a mais sites depois, a automação ganha
esse alcance junto, sem ninguém mexer no código.

**Por que uma conta de serviço e não a do Joao:** o histórico de versão de sete
planilhas vai carregar aquele nome toda manhã, e a automação morre no dia em que
a conta mudar.

Tenant ID e Client ID viram secrets do GitHub Actions (`GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`). **Não há client secret neste caminho** — o que persiste é o
refresh token, e ele fica no Supabase (`excel_sync.graph_token`), não num secret,
porque o Azure o rotaciona a cada uso e um job que não grava o novo se tranca
depois de uma execução.

**Como verificar antes de pedir qualquer coisa:**

```
python tools/probe_graph_auth.py --delegated --write-test
```

Seis testes; só o sexto decide. Os testes 1-3 (token, site, arquivo) passam
também no caminho app-only — foi exatamente assim que o caminho errado pareceu
plausível.

## 3. Escrever por cima de uma aba viva — os riscos reais

A decisão de escrever direto na aba existente (em vez de numa aba crua) é mais
confortável para quem usa, mas transfere o risco para nós. Três coisas podem dar
errado, e todas são silenciosas.

### 3.1 Fórmula dentro da área escrita morre

Um `PATCH` de valores num range **substitui fórmula por valor**, sem aviso e sem
volta. Se hoje existe qualquer fórmula dentro do retângulo que vamos escrever, ela
deixa de existir na primeira execução.

**Mitigação obrigatória:** antes da primeira escrita automática, ler a aba inteira e
guardar um snapshot — valores **e fórmulas** — em `excel_sync`. Serve para conferir
o que existia e para restaurar. É barato e é a diferença entre um susto e um
desastre.

### 3.2 A contagem de linhas encolhe

Hoje o `stock-level` tem 3.696 linhas de SKU. Amanhã pode ter 3.600. Se escrevermos
um range fixo, **as 96 linhas velhas do final sobrevivem** — dado de ontem misturado
com o de hoje, sem nada indicando.

**Mitigação:** guardar por binding a extensão escrita na execução anterior
(`last_row`, `last_col`) e, quando a nova for menor, **limpar o conteúdo do
excedente** antes de escrever. Determinístico, e não depende de adivinhar o
`usedRange` (que inclui coisa não nossa).

### 3.3 Alguém está com o arquivo aberto

O Graph escreve mesmo com o arquivo aberto no Excel Online ou desktop, e as
alterações de quem está editando podem sobrescrever as nossas — ou o contrário.
Rodar de madrugada (o cron já é 06:00 Sydney) reduz muito, mas não elimina.

**Mitigação:** usar uma *workbook session* persistente e escrever numa transação
curta; e registrar em `ops.sync_runs` quando a escrita detectar conflito, para o
painel mostrar em vez de engolir.

## 4. Contrato de escrita

```
1. POST  /workbook/createSession            (persistente)
2. GET   snapshot da aba (1ª vez, ou se o checksum do layout mudou)
3. PATCH range do cabeçalho + dados, em lotes de ~1 MB
4. Limpar o excedente se a extensão anterior era maior
5. POST  /workbook/closeSession
6. Gravar extensão + checksum + run em ops.sync_runs
```

O adapter fica em `features/excel-sync/engine/delivery/graph.py`. **Nada mais muda**
— dataset, specs, gates e painel continuam iguais. Foi para isso que a entrega ficou
isolada desde o começo.

> Correção (2026-08-11): uma versão anterior deste parágrafo dizia que o adapter
> entraria "atrás da mesma interface do `local_xlsx.py` que já existe". **Não
> existe.** Não há `engine/delivery/` nem nenhuma interface de entrega — a Fase 5
> está em zero, não em "falta só o Graph". O `openpyxl` que aparece em `pivot.py`
> gera um `.xlsx` novo e avulso para inspeção; não escreve em planilha viva.

## 5. Ordem de trabalho

| # | O quê | Depende de | Quando |
|---|---|---|---|
| 1 | Pedido do app registration ao TI | — | **hoje, antes de tudo** |
| 2 | Você me passa os arquivos/abas de destino | — | em paralelo |
| 3 | Adapter Graph + snapshot + limpeza de excedente, testado contra um arquivo de teste | 1 e 2 | enquanto o consentimento não sai |
| 4 | Bindings reais em `specs/bindings/` | 2 | idem |
| 5 | Primeira escrita real, num **arquivo cópia** | 1, 3, 4 | quando o consentimento sair |
| 6 | Virar para os arquivos de produção, um por vez | 5 verde | depois |

O passo 5 não é burocracia: a primeira escrita automática numa planilha de produção
é irreversível se algo estiver errado. Uma cópia custa cinco minutos e remove o
único risco que não dá para desfazer.

## 6. O que eu preciso de você

Para cada planilha a automatizar:

1. **O arquivo em si** (ou uma cópia) — preciso ver o que tem na aba de destino:
   fórmula, formatação condicional, tabela dinâmica, validação, célula mesclada.
   Isto é o item mais importante: escolhemos escrever por cima de uma aba viva, e
   sem ver a aba eu estaria adivinhando o que vou destruir.
2. **Caminho no SharePoint** — nome do site e caminho do arquivo.
3. **Nome exato da aba** de destino.
4. **Qual dataset** alimenta ela: `stock-level` ou `monthly-sales`.
5. **Onde começa** o bloco na aba (célula âncora, ex.: `A1`), e se o cabeçalho já
   está lá ou deve ser escrito junto.
6. **Com que frequência** deve atualizar.
7. **Se alguém digita nessa aba** — se sim, em quais colunas, porque essas não podem
   entrar no range que sobrescrevemos.

Os itens 2–6 eu consigo inferir vendo o arquivo. O 1 e o 7 não.

## 7. Enquanto o consentimento não sai

Nada disso fica bloqueado:

- adapter Graph escrito e testado contra um `.xlsx` local com a mesma mecânica
  (snapshot → escrever → limpar excedente), para o dia do consentimento ser
  configuração e não desenvolvimento
- bindings reais criados e visíveis no painel como `disabled`
- snapshot/restore implementado e testado
- a tabela de extensão anterior por binding
