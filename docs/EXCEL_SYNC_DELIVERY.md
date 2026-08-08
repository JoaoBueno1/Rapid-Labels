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

> **Solicitação:** criar um *app registration* no Azure AD para uma automação que
> escreve numa planilha do SharePoint.
>
> - **Nome:** `Rapid Labels — Excel Sync`
> - **Tipo:** single tenant, **sem** redirect URI (é daemon / client-credentials,
>   roda sem usuário)
> - **Permissão:** Microsoft Graph → **Application permissions** → **`Sites.Selected`**
> - **Consentimento de admin:** necessário
> - **Segundo passo, e é o que costuma ser esquecido:** `Sites.Selected` sozinha não
>   dá acesso a nada. Depois do consentimento, um admin precisa conceder acesso ao
>   site específico, uma vez, via Graph:
>   ```
>   POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
>   { "roles": ["write"],
>     "grantedToIdentities": [{ "application": { "id": "{clientId}", "displayName": "Rapid Labels — Excel Sync" } }] }
>   ```
> - **Devolver:** Tenant ID, Client ID e um Client Secret (ou certificado)

**Por que `Sites.Selected` e não `Files.ReadWrite.All`:** a segunda dá acesso a todo
o tenant e costuma ser recusada, ou aprovada depois de semanas de discussão. A
primeira dá acesso **só aos sites que o admin liberar explicitamente** — é o mínimo
necessário, e é muito mais fácil de aprovar. Pedir a permissão ampla é a forma mais
comum de transformar uma semana em um mês.

Os três valores viram secrets do GitHub Actions (`GRAPH_TENANT_ID`,
`GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`), como já é feito com Cin7 e Supabase.

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

O adapter fica em `features/excel-sync/engine/delivery/graph.py`, atrás da mesma
interface do `local_xlsx.py` que já existe. **Nada mais muda** — dataset, specs,
gates e painel continuam iguais. Foi para isso que a entrega ficou isolada desde o
começo.

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
