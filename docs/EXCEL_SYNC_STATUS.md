# Excel Sync — onde paramos (2026-08-08)

> Ponto de retomada. O que está pronto, o que está travado e o que fazer quando
> destravar. Docs relacionados:
> [EXCEL_SYNC_ARCHITECTURE.md](EXCEL_SYNC_ARCHITECTURE.md) ·
> [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) ·
> [EXCEL_SYNC_DELIVERY.md](EXCEL_SYNC_DELIVERY.md) ·
> [../features/excel-sync/README.md](../features/excel-sync/README.md)

## Resumo em uma linha

Tudo pronto e no ar até a porta do Excel. **Trava única: um clique de consentimento
de admin no Entra ID.** Nenhum desenvolvimento depende dele.

---

## ✅ Pronto e verificado

### Dados
| | |
|---|---|
| `cin7_mirror` | espelho do Cin7, 15 syncs, saudável |
| `excel_sync.dataset_rows` | 2 datasets materializados, lidos pela chave anon |
| `stock-level` | 12.657 linhas × 17 warehouses — **7/7 métricas em 100,00%** contra o export do Cin7 |
| `monthly-sales` | 1.630 linhas × 10 warehouses — 1.624/1.630 células (99,63%), valor 100,21% |

### Sync novo
`cin7-sales-detail-month` (`backfill-sales.js detail-month`) — busca todo pedido do
mês, qualquer status, e **re-busca quando o Cin7 muda**. Levou a reconciliação de
93,5% para 99,63%. Corrigiu também um bug latente: `sale_lines` nunca apagava linha
removida pelo Cin7 (SO-281413 tinha 149 linhas contra 100 reais).

### Painel
**Quality & Compliance → Sync Monitor**, 2 abas, 17 cards. Saúde vem do **frescor da
tabela de destino**, não de log de execução — por isso cobre os 15 workflows desde o
dia 1. Cinco syncs medidos em **minutos úteis**, senão ficariam vermelhos todo fim de
semana.

### Bindings da primeira planilha
`Coffs Harbour Aug 26.xlsx`, três abas mapeadas e **provadas contra o arquivo real**:

| Binding | Aba | Fonte | Conferência |
|---|---|---|---|
| `coffs-soh-main` | SOH Main | Main Warehouse **+ Gateway somados** | 2.907 vs 2.933 linhas, Available 73,8% |
| `coffs-soh-dear` | SOH Dear | Coffs Harbour | 1.204 vs 1.204, Available **92,2%** |
| `coffs-sales-mtd` | Sales MTD | Coffs Harbour, mês corrente | 117 vs 68, Quantity 63,2% |

As diferenças são **atraso do arquivo**, não erro de mapeamento — o arquivo é de
03-Ago. Prova: dos 68 SKUs em comum no Sales MTD, 43 idênticos, 25 maiores e **zero
menores**. Acumulado do mês só pode subir.

### Contrato descoberto lendo o arquivo
- As três abas de destino **não têm fórmula nenhuma** — são colagem pura.
- Só duas colunas são consumidas de fora, e a posição delas é crítica:
  - `VLOOKUP(...,'SOH Main'!B:F,5)` → **coluna F, Available** — 2.556 fórmulas em 16 abas
  - `VLOOKUP(...,'SOH Dear'!B:F,5)` → **coluna F** — 2.994 fórmulas na aba `Coffs`
  - `VLOOKUP(...,'Sales MTD'!A:B,2)` → **coluna B, Quantity** — 1.052 fórmulas em 13 abas
- Célula **I1** do SOH Main diz *"Include gateway With Totals"* → aquela aba é
  **Main + Gateway somados**, confirmado com o negócio.
- Células de status já existem e serão escritas automaticamente:
  `H1` (SOH Main), `H1` (SOH Dear), `G1` (Sales MTD).

---

## ⛔ Travado: consentimento de admin

### Estado no Entra ID

| | |
|---|---|
| App | **Rapid labels - Excel sync** |
| Client ID | `8c4aa84e-db46-4d6c-b629-922e7ca22243` |
| Tenant ID | `59ec4380-0cab-455d-a6e2-f10314801005` |
| Tenant | `rapidled.com.au` |
| Tipo | Single tenant, sem redirect URI (daemon) ✅ |
| Segredo | criado ✅ |
| Permissão | `Sites.Selected` · **Application** ✅ |
| Consentimento | ⛔ **Not granted for RapidLED** |

> Client ID e Tenant ID **não são segredos** — podem ficar aqui e no workflow.

`joao@rapidled.com.au` cria app registration mas **não consente**: botão cinza, e o
link direto devolve `AADSTS90094 — This operation can only be performed by an
administrator`.

### Link para aprovar

```
https://login.microsoftonline.com/59ec4380-0cab-455d-a6e2-f10314801005/adminconsent?client_id=8c4aa84e-db46-4d6c-b629-922e7ca22243
```

Quem pode: **Global Administrator**, **Privileged Role Administrator** ou
**Cloud Application Administrator**. Ver em Entra → *Roles & admins*.

> Se existir uma segunda conta administrativa (`admin.joao@…`), a própria tela de erro
> oferece **"Have an admin account? Sign in with that account"** e resolve na hora.

### Texto para encaminhar

> Preciso de consentimento de admin para o app **Rapid labels - Excel sync**
> (`8c4aa84e-db46-4d6c-b629-922e7ca22243`).
>
> É um serviço que roda de madrugada e atualiza três abas de dados nas planilhas de
> estoque das filiais no SharePoint. Hoje isso é feito à mão colando export do Cin7,
> e as planilhas estão de 5 a 12 dias desatualizadas.
>
> A permissão é **`Sites.Selected`**, não `Files.ReadWrite.All`. A diferença importa:
> `Sites.Selected` **não dá acesso a nada por si só** — depois do consentimento ainda
> é preciso liberar explicitamente cada site do SharePoint. Se o segredo vazar, o
> alcance é apenas o site liberado.

---

## Secrets

**Nenhum segredo neste repositório.** Só os nomes e onde cada um mora.

### GitHub Actions → Settings → Secrets and variables → Actions
| Nome | Estado |
|---|---|
| `SUPABASE_URL` | ✅ já existe |
| `SUPABASE_SERVICE_KEY` | ✅ já existe |
| `CIN7_ACCOUNT_ID` / `CIN7_API_KEY` | ✅ já existem |
| `GRAPH_CLIENT_SECRET` | ⛔ **falta** — o *Value* do client secret |

`GRAPH_TENANT_ID` e `GRAPH_CLIENT_ID` **não precisam ser secret** — vão como env
comum no workflow, já que não são sigilosos.

### `.env` local (gitignored) — para testar sem o Actions
Hoje só tem Supabase e Cin7. Para eu validar a autenticação daqui, falta:

```
GRAPH_TENANT_ID=59ec4380-0cab-455d-a6e2-f10314801005
GRAPH_CLIENT_ID=8c4aa84e-db46-4d6c-b629-922e7ca22243
GRAPH_CLIENT_SECRET=<o Value do secret>
```

> O *Value* só é exibido **uma vez** na criação. Se tiver se perdido, apaga e cria
> outro em Certificates & secrets — não há como recuperar.

---

## Sequência quando o consentimento sair

1. **Liberar o site** — `Sites.Selected` sozinha não dá acesso a nada. Uma chamada,
   uma vez por site:
   ```
   POST https://graph.microsoft.com/v1.0/sites/{siteId}/permissions
   { "roles": ["write"],
     "grantedToIdentities": [{ "application": {
        "id": "8c4aa84e-db46-4d6c-b629-922e7ca22243",
        "displayName": "Rapid labels - Excel sync" } }] }
   ```
   Exige token com `Sites.FullControl.All`. Como o Graph Explorer foi bloqueado, o
   caminho é elevar o **próprio app** temporariamente: adicionar
   `Sites.FullControl.All` (Application) → consentir → fazer o POST acima →
   **remover a permissão**, deixando só `Sites.Selected`. O passo de remoção não é
   opcional.
2. **Teste de leitura** — pegar token e listar o arquivo. Sem escrever nada.
3. **Escrever numa CÓPIA**, num site de teste. Conferir as três abas.
4. **Apontar para produção**, um workbook por vez.

O arquivo é resolvido direto pela URL via `/shares`; não é preciso caçar ID:
```
https://rapidled.sharepoint.com/:x:/r/_layouts/15/Doc.aspx?sourcedoc=%7BC67CA800-01C0-400C-BD07-A274774F304B%7D&file=Coffs%20Harbour%20Aug%2026.xlsx
```

> ⚠️ O arquivo está hoje no **site raiz** (`rapidled.sharepoint.com`, sem `/sites/…`).
> Liberar o raiz dá escrita em tudo que estiver nele. Recomendado criar um site
> dedicado (ex.: `Branch Workbooks`) e mover os arquivos: uma liberação passa a cobrir
> todas as filiais, e o alcance fica contido. Criar site **não exige role**.

---

## A construir enquanto isso (não depende do consentimento)

- [ ] `engine/delivery/graph.py` — token client-credentials, resolução por `/shares`,
      sessão de workbook, escrita em lotes (~1 MB: 1 chamada para o Sales MTD, 3 para
      o SOH Main), limpeza do excedente quando a contagem de linhas encolhe, e a
      célula de status.
- [ ] Snapshot da aba (valores **e** fórmulas) antes da primeira escrita, para
      conferência e restauração.
- [ ] Guardar a extensão escrita por binding, para saber o que limpar.
- [ ] Bindings das demais filiais — mesma estrutura, só muda a localização.

## Decisões já tomadas (não re-discutir)

- **Push via Graph**, não Power Query: o requisito é estar atual **sem ninguém abrir**,
  e conexão Power Query a API REST só atualiza com o arquivo aberto no Excel desktop.
- **Escrita direta na aba existente**, não numa aba de dados separada.
- **`Sites.Selected`**, não `Files.ReadWrite.All`.
- Primeira escrita real vai numa **cópia** — é o único risco irreversível do projeto.
- `Discount` está fora do escopo (agregação ambígua, ninguém lê).

## Se travar por mais de uma semana

Deixa de ser questão técnica e vira prioridade. A alternativa **não é** Power Query —
é rebaixar o pedido para `Files.ReadWrite.All`: uma permissão só, sem liberação de
site, às vezes aprovada mais rápido por ser mais conhecida. Pior em segurança, mas é
uma troca consciente.
