# Excel Sync — onde paramos (2026-08-13)

> Ponto de retomada. O que está pronto, o que está travado e o que fazer quando
> destravar. Docs relacionados:
> [EXCEL_SYNC_ARCHITECTURE.md](EXCEL_SYNC_ARCHITECTURE.md) ·
> [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) ·
> [EXCEL_SYNC_DELIVERY.md](EXCEL_SYNC_DELIVERY.md) ·
> [../features/excel-sync/README.md](../features/excel-sync/README.md)

## Resumo em uma linha

As 21 bindings existem, foram geradas a partir dos arquivos reais e passam em
ensaio. Falta **uma migração colada no Supabase** para o primeiro write de
verdade — e a porta app-only do Graph, que era o plano de longo prazo, **nunca
vai servir**: a API de workbook do Graph não aceita permissão de aplicação.

---

## 🔖 2026-08-14 — ONDE PARAMOS (retomar por aqui)

**Estado:** pronto e provado nas cópias. Falta **alerta** antes de apontar para
os arquivos reais. Nada bloqueado por terceiros.

### Como retomar em outra máquina

```bash
git pull                                   # branch dev
cd features/excel-sync
pip install -r requirements.txt            # openpyxl; o resto e stdlib
# precisa de SUPABASE_URL e SUPABASE_SERVICE_KEY no .env da raiz do repo
# precisa de Excel instalado + pywin32 (transporte local) e OneDrive rodando

python -m engine list                      # deve listar 21 bindings, todas [disabled]
python tools/check_access.py               # 21 ok contra a biblioteca real, so leitura
```

Rodar o teste (nas cópias, nunca nos originais):

```powershell
& ".\tools\run_delivery.ps1" -Root "C:\Users\JoaoMarcos\OneDrive - RapidLED\Desktop\Tests files"
```

Log em `out/logs/delivery-AAAA-MM-DD.log`. Sai `exit 0 | 21 written | 0 refused`
quando está tudo certo, e **exit 1 se qualquer binding recusar**.

> ⚠️ As cópias de teste ficam em `Desktop\Tests files` e são arquivos
> **fisicamente distintos** dos originais (FileId NTFS diferente, sem hardlink,
> sem reparse point — conferido). Escrever nelas não toca no SharePoint.

### ✅ Fechado

| | |
|---|---|
| Bindings | **21**, geradas dos arquivos reais, instaladas, todas `enabled = false` |
| `db/003` | aplicado; snapshot/undo funcionando (`excel_snapshot_count` responde) |
| Acesso aos 21 tabs reais | verificado, incluindo permissão de escrita, **sem alterar byte** |
| Escrita | 4 rodadas nas cópias, 21/21, zero recusas |
| Integridade | **0 fórmulas alteradas de 267.496**; 178 abas intocadas; zero erros novos |
| Contra export do Cin7 | 99,83–99,98% por célula; Main+Gateway **2.914/2.914** |
| Mensagem de status | inglês, hora de Brisbane fixa (UTC+10), 2–3 linhas |
| Runner | `tools/run_delivery.ps1` + linha do `schtasks` no cabeçalho do arquivo |

### 🔧 Erros que a validação pegou (e o que ensinaram)

1. **Sydney cobre SYD+MEL+HOB**, não só Sydney — ver `LOCATION_OVERRIDES` em
   `tools/survey_workbooks.py`. **Sydney está virando filial satélite**: vai
   receber estoque e distribuir para Melbourne e Hobart, então a demanda que ela
   precisa comprar é a dos três. A aba de estoque dela segue só Sydney (99,5%) e
   provavelmente vai precisar do mesmo tratamento quando a operação mudar.
2. **Sunshine Coast** chama-se `Sunshine Coast Warehouse` no Cin7.
3. **`data_anchor = "None"`** era emitido quando a aba estava vazia — arquivo que
   parseia e morre na entrega. Agora infere e marca com aviso.
4. **Excel converteu o carimbo em data** e renderizou `8/14/26`. O sufixo
   `(Brisbane)` impede o parse.
5. **Bloco encolhido deixava linha órfã** — agora escreve sempre 4 linhas,
   preenchendo em branco.
6. **O runner contava `REFUSE` no log do dia inteiro**, e a própria linha de
   resumo (`0 refused`) casava com o padrão. Conta na saída da execução.

### ⬜ O que falta

1. **Alerta** — único item de verdade. Uma recusa hoje é correta e **silenciosa**;
   num job das 7h ninguém lê log. Construir antes dos arquivos reais.
2. **Habilitar bindings** (`enabled = true`), uma por vez. Estão `false` de
   propósito: rodar sem argumento contra a biblioteca real **não faz nada**.
3. **Decidir o Melbourne** — a aba de vendas dele está com julho. Está fora do
   ciclo semanal por desenho (SOP: *"advise when require"*). Confirmar se alguém
   quer aquilo sincronizado.
4. **Observar no teste**: recusa por cabeçalho movido (alguém inserindo coluna),
   e se as 7h pegam alguém com o arquivo aberto.

### Escopo, para não esquecer

Só **3 abas por planilha**: estoque da filial, `SOH Main` (Main+Gateway somados)
e `Sales MTD`. Aba de pedido semanal, `Print Layout`, `BNE`, listas de produto e
localizações — **tudo continua manual, de propósito**.

Tabela por filial com anchor, colunas, armazéns contados e células de status:
[artefato publicado](https://claude.ai/code/artifact/5f14a32f-71e7-4306-87bb-319b3e426650).

---

## 2026-08-13 — o que mudou

### 1. ⛔ App-only NÃO é o destino. Nunca foi.

A correção mais importante deste doc. A API de workbook do Microsoft Graph
**não suporta permissão de aplicação**, e isso não é política do tenant — é a
API:

```
PATCH  /workbook/worksheets/{id}/range   Application: Not supported.
POST   /workbook/createSession           Application: Not supported.
```

Tabelas de permissão da Microsoft, conferidas em 2026-08-13
([range update](https://learn.microsoft.com/en-us/graph/api/range-update) ·
[createSession](https://learn.microsoft.com/en-us/graph/api/workbook-createsession)).
As duas listam `Files.ReadWrite` **delegated** e mais nada.

Consequência prática: um token app-only com `Sites.Selected` perfeitamente
consentido **lê o arquivo e não escreve uma célula**. Falha no primeiro PATCH,
depois de tudo parecer configurado — o pior lugar possível para descobrir.

> **Não peça `Sites.Selected` Application ao TI achando que destrava a escrita.**
> Não destrava. O pedido certo é consentimento **delegated** de
> `Files.ReadWrite.All` **mais uma conta de serviço** para o job rodar como ela.
> O `.All` é necessário: `Files.ReadWrite` delegado alcança só o OneDrive do
> próprio usuário, não biblioteca do SharePoint.

**Bug latente corrigido:** `engine/delivery/auth.py` preferia app-only com
fallback para delegated, "para trocar sozinho no dia em que o consent saísse".
Com essa limitação, isso era uma granada: o consent chegando faria a entrega
migrar para a porta que não escreve, e todo run passaria a falhar por uma
mudança que ninguém fez. Agora o padrão é `WORKBOOK_MODE = 'delegated'`.

### 2. Delegated reconfirmado como fechado

Novo teste de device code em 2026-08-13: código emitido (logo
`Allow public client flows` **continua ligado** ✅), e o login devolveu a tela
**"Need admin approval — Rapid labels - Excel sync needs permission to access
resources in your organization that only an admin can grant"**. Mesmo resultado
de 11-Ago, agora com print para anexar no chamado.

### 3. As sete planilhas não têm o mesmo formato

`tools/survey_workbooks.py` (novo) lê os 7 arquivos e responde as quatro
perguntas que uma binding precisa: onde os dados começam, qual é a linha de
cabeçalho, **quais colunas as fórmulas realmente leem e em que índice**, e se
existe fórmula dentro do retângulo de escrita.

O que ele achou, e que derruba o "18 bindings, mesmos três formatos":

| tipo de aba | formatos | detalhe |
|---|---|---|
| `main-stock` | **2** | âncora `A3`/lê E (BNE, CNS, HOB, MEL) · `B3`/lê F (Coffs, SC, SYD) |
| `branch-stock` | **6** | o nome muda por filial — `SOH Dear`, `SOH CNS`, `SOH SC`, `SOH Sydney`; Hobart ancora em `A3`; **Melbourne está vazia** |
| `branch-sales` | **2** | todas `A7`, mas Cairns/SC/Sydney só têm `SKU|Quantity` (sem Discount/Total) |

> ⚠️ A primeira versão do survey assumiu `SOH Dear` em todo lugar e reportou 3
> filiais como "aba não existe". A aba existia com outro nome. O survey agora
> **descobre** por padrão e usa a contagem de fórmulas para decidir qual manda —
> Hobart e Melbourne têm duas candidatas, e a `SOH Sydney` delas tem 51 leituras
> contra 6.036 da principal (é sobra, não se liga).

Validação: o survey reproduziu sozinho as **3 âncoras do Coffs** que tinham sido
escritas e conferidas à mão. 3/3.

### 4. 21 bindings instaladas

Geradas pelo survey a partir dos arquivos, todas `enabled = false`. Cada coluna
load-bearing sai comentada com a evidência (`# Column E. READ BY 1716 FORMULAS
via A:E,5`). As três antigas do Coffs (`coffs-soh-*`, `coffs-sales-mtd`) foram
aposentadas — nomes inconsistentes, conteúdo equivalente.

### 5. Bloco de status — a aba passa a dizer de quando ela é

O `[status]` da binding agora aceita três coisas:

| chave | o que faz |
|---|---|
| `cell` | o carimbo de uma linha, escrito **onde a pessoa já digita hoje** |
| `block` | 4 linhas ao lado: `Updated` / `Covers` / `Rows` / `Source` |
| `clear` | apaga o preâmbulo do export do Cin7, cujo período envelhece |

`Covers` é a resposta que o carimbo sozinho nunca deu. **3 das 7 filiais estão
hoje com o período errado**: Brisbane mostra `From: 01-Jun / To: 30-Jun` sob um
"Updated 10-Aug" digitado à mão, Melbourne mostra julho, e Coffs tem
`To: 30-aug` (agosto tem 31). Escrever o número e o período **na mesma execução**
é a única forma de eles não se contradizerem.

`Rows` é o detector mais barato que existe: 1 247 hoje e 3 amanhã é óbvio para
quem não entende mais nada da página.

O gate de fórmula, que antes protegia só o retângulo de dados, agora cobre
também o carimbo, o bloco e a área de limpeza — e um `clear` que encoste nos
dados **aborta** em vez de apagar.

### 6. `tools/preview_delivery.py` (novo) — o que mudaria antes de ligar

O ensaio prova que a escrita é *segura*; não diz se os números estão *certos*.
Este faz o diff do que seria escrito contra o que a aba tem hoje, chave por
chave, com openpyxl (não abre Excel, não trava arquivo). É a revisão das 21 sem
abrir planilha nenhuma.

Brisbane, contra o arquivo de 10-Ago:

| binding | igual | mudaria | novas | sumiriam |
|---|---|---|---|---|
| `brisbane-branch-sales` | **0%** | 164 | 45 | 0 |
| `brisbane-main-stock` | 65% | 976 | 32 | 22 |
| `brisbane-branch-stock` | 85% | 154 | 14 | 13 |

Os 0% do Sales MTD são esperados: a aba tem junho, o dataset tem agosto. Parte
também é a coluna `Total`, hoje **vazia na aba**, que o dataset preencheria.

### 7. Ensaio completo nas 3 abas do Brisbane ✅

Contra uma cópia do arquivo real (`out/TEST_Brisbane.xlsx`), transporte local:
header conferido, **zero fórmula no caminho**, contagens sãs, bloco de status
calculado. O dataset já está publicado e fresco (12.647 linhas, 9,5h) — o job
noturno **está rodando**.

### 8. Decisão: nome de arquivo fixo

O arquivo de trabalho passa a ter **um nome para sempre**; a cópia mensal
arquivada é que ganha nome novo. Isso elimina o "renomeia todo mês" como classe
de falha. Se o nome parar de resolver, é alguém renomeando o arquivo vivo, e a
entrega falhar em voz alta é o comportamento correto — não algo para contornar
com wildcard. Registrado no cabeçalho de cada binding.

### 9. ⛔ O único bloqueio para o primeiro write

`db/003_graph_delivery.sql` **não está aplicado**. Sem ele não há tabela de
snapshot, e o snapshot é o único desfazer do projeto — então o código recusa
escrever, corretamente. 193 linhas, idempotente, 3 tabelas e 6 funções. Colar no
SQL Editor do Supabase (o Labels não tem `_exec_sql`).

---

## 2026-08-11 — o que mudou

### 1. O consentimento não vai sair por nós

Confirmado com o Joao: ele **não tem acesso nem credencial para liberar nada** na
organização. O caminho app-only não é "esperar um clique", é *depender de outra
pessoa por tempo indeterminado*. Deixa de ser o plano padrão e vira o plano de
longo prazo.

### 2. Os arquivos foram localizados — e são sete, não um

Estão todos numa biblioteca do SharePoint **já sincronizada nesta máquina**:

```
C:\Users\JoaoMarcos\RapidLED\WorkDocs - Rapid LED - Data\
    Inventory Management\Inventory Stock Orders\
        Brisbane Aug 26.xlsx        Melbourne Aug 26.xlsx
        Cairns - Aug 26.xlsx        Sunshine Coast Aug 26.xlsx
        Coffs Harbour Aug 26.xlsx   Sydney Aug 26.xlsx
        Hobart Aug 26.xlsx
        2026\<Mon YY>\...           ← meses fechados são arquivados aqui
```

Todos com escrita de `joao@rapidled.com.au` (é biblioteca sincronizada dele).
Escopo real do projeto: **7 filiais × 3 abas = 21 bindings**, não 3. Os bindings do
Coffs já carregam `library` e `folder`.

> ⚠️ **Cairns tem espaço-hífen** (`Cairns - Aug 26.xlsx`) enquanto os outros seis não.
> E o nome muda todo mês. Nenhum binding adivinha isso — resolver antes de habilitar.

Isso também derruba a preocupação do doc antigo de que o arquivo estaria na raiz do
site: está numa biblioteca nomeada, e liberar **essa pasta** é contido. A recomendação
de criar um site dedicado deixa de ser necessária.

### 3. Delegated foi testado — e também está fechado ⛔

Hipótese: `Files.ReadWrite.All` **delegated** é consentível pelo próprio usuário e
não precisaria de admin. Testada de ponta a ponta em 2026-08-11, e **refutada**.

O que foi feito antes do teste (tudo pelo Joao, sem admin):
- `Allow public client flows = Yes` no app registration ✅
- `Files.ReadWrite.All` **Delegated** adicionada — e o portal mostrou
  **Admin consent required: `No`** ✅

E o login mesmo assim devolveu:

```
AADSTS90094: An administrator of RapidLED has set a policy that prevents you
from granting Rapid labels - Excel sync the permissions it is requesting.
```

> **A lição, para não repetir:** a coluna *Admin consent required* mostra o
> **padrão da Microsoft**, não a política da organização — a própria tela avisa
> isso. `No` ali não é permissão; é só ausência de exigência padrão. A RapidLED
> desligou consentimento de usuário no tenant. **Só o login prova.**

O probe (`tools/probe_graph_auth.py`) continua útil: é ele que vai detectar o dia
em que isso mudar, sem precisar reconstruir raciocínio nenhum.

### 4. Plano C é o plano — as duas portas do Graph estão fechadas

Escrever a **cópia local sincronizada** por automação do Excel de verdade
(`pywin32`/COM — já instalado nesta máquina, com Excel instalado), e deixar o
OneDrive subir. **Zero permissão de tenant, e é por isso que é o plano.**

Implementado em `engine/delivery/local_excel.py`.

- ✅ Preserva fórmula, formatação, pivot — **o Excel salva, não uma biblioteca**.
- ❌ **Não use `openpyxl` para isso.** Reescrever um workbook com 2.556 VLOOKUPs em
  16 abas por openpyxl perde gráfico, valor em cache e formatação condicional.
- ❌ Depende desta máquina ligada com OneDrive rodando; o cron do GitHub Actions
  não a alcança — o agendador é o **Windows Task Scheduler**.
- ❌ Roda como o Joao: o histórico do SharePoint vai dizer isso, e morre com a conta.
- ❌ Se alguém estiver com o arquivo aberto, o OneDrive resolve como **cópia de
  conflito**, não como merge. (O código recusa se o Excel abrir read-only.)

**Pré-requisito:** o `OneDrive.exe` **não está em execução** e os arquivos são
placeholders (cloud-only, `RECALL_ON_DATA_ACCESS`). O transporte local detecta e
recusa com essa mensagem. Iniciar o OneDrive resolve.

### 5. Correção de estado: a Fase 5 está em zero

O `EXCEL_SYNC_DELIVERY.md` dizia que o adapter entraria "atrás da mesma interface do
`local_xlsx.py` que já existe". **Não existe** — não há `engine/delivery/`, nem
qualquer camada de entrega. O que falta não é "só o Graph": é a abstração inteira.
Corrigido lá.

### 6. O gate do `monthly-sales` não depende da Microsoft

`monthly-sales` segue bloqueado por causa do `SO-280868` (pedido dividido pelo Cin7)
— e isso é **conhecimento de negócio, não permissão**. Dá para resolver hoje, sem
depender de ninguém do TI. Ver [../features/excel-sync/README.md](../features/excel-sync/README.md).

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

## O ensaio contra o arquivo real (2026-08-11) — e o que ele pegou

Os três bindings do Coffs foram ensaiados contra `Coffs Harbour Aug 26.xlsx` de
verdade, com o Excel aberto em **somente-leitura**. Nada foi escrito. Passaram
todos os gates — inclusive o de fórmula, que leu a aba real e confirmou que não há
nenhuma dentro de `B3:F2917`.

**Mas o ensaio encontrou um problema que nenhum gate existente via.**

O `Sales MTD` tinha 168 SKUs; nosso bloco tinha 142. E **todas** as diferenças
tinham o nosso número menor — 26 SKUs ausentes, 19 quantidades abaixo, zero acima.
Venda do mês só sobe, e nosso dataset era mais novo que a aba. Impossível.

Investigação (o filtro de status **não** era a causa — explicou 0 de 8 casos):

| | R-GPO2-WH | RQC | RSS | R-MB34 |
|---|---:|---:|---:|---:|
| aba (10-Ago) | 40 | 80 | 137 | 11 |
| dataset publicado | 10 | 70 | 127 | 5 |
| espelho recalculado na hora | **40** | **80** | **137** | **11** |

O espelho batia com a aba. **A lógica sempre esteve certa; o dataset publicado é que
estava velho** — o build noturno de 10-Ago saiu subcontado. Reconstruído e
republicado, o diff virou saudável: 176 vs 168, **zero SKUs só na aba**, e todas as
diferenças com o nosso número maior.

> **Gate novo: `stale`.** Recusa entregar dataset mais velho que o `sla_minutes` do
> próprio binding. É o único gate que enxerga isso — os outros olham a consistência
> interna dos dados, e um dataset velho é perfeitamente consistente consigo mesmo.
> Sem ele, a entrega teria trocado números bons por velhos **relatando sucesso**.

Contraste que vale guardar como diagnóstico: nas abas de estoque as diferenças iam
**nos dois sentidos** (+900, +425, mas também −16) — movimento real. No `Sales MTD`
iam num sentido só. **Diferença unidirecional é dado faltando, não defasagem.**

Pendente de investigar: por que o build de 10-Ago saiu curto. O `excel-sync.yml`
roda 20:00 UTC, uma hora depois do `cin7-sales-detail-month` — se aquele sync passar
de uma hora ou falhar parcial, este constrói em cima de linha incompleta, e
`detail_coverage_pct` dá 100% mesmo assim (mede `detail_synced_at`, não se as linhas
chegaram completas).

---

## Ordem de ataque (revisada 2026-08-11, depois do AADSTS90094)

1. **Ligar o OneDrive** e deixar sincronizar a pasta `Inventory Stock Orders`.
2. **Aplicar `db/003_graph_delivery.sql`** no SQL Editor do Supabase. Os snapshots
   e o controle de extensão valem para os dois transportes; só a tabela
   `graph_token` fica ociosa enquanto o Graph estiver fechado.
3. **Ensaio:** `python -m engine deliver coffs-soh-main --force` — prova todos os
   gates e não escreve nada.
4. **Primeira escrita real numa CÓPIA:** `--write --file "Coffs Harbour COPY.xlsx"`.
   É o único passo irreversível do projeto; gastá-lo num arquivo do qual ninguém
   depende custa cinco minutos.
5. **Produção**, um binding por vez (`enabled = true`).
6. **Agendar** no Windows Task Scheduler. O GitHub Actions continua construindo os
   datasets; ele não alcança esta máquina.
7. **Em paralelo, sem depender de nada disso:** resolver o `SO-280868` e desbloquear
   o gate do `monthly-sales`; escrever os 18 bindings das outras seis filiais.

> **O pedido de admin continua valendo, e agora tem munição melhor:** já não é
> "quero uma permissão", é "tentei os dois caminhos sem admin, o tenant bloqueia
> ambos, aqui está o erro exato". Quando sair, `EXCEL_SYNC_TRANSPORT=graph` e o
> `graph.py` — escrito, testado até a porta e intacto — volta a ser o transporte.
>
> O que **não** é alternativa: Power Query (só atualiza com o arquivo aberto) e
> pedir `Files.ReadWrite.All` **application** (mais amplo que o `Sites.Selected`
> que já foi recusado).
