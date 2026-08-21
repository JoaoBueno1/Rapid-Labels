# Excel Sync — onde paramos (2026-08-13)

> Ponto de retomada. Docs relacionados:
> [EXCEL_SYNC_ARCHITECTURE.md](EXCEL_SYNC_ARCHITECTURE.md) ·
> [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) ·
> [EXCEL_SYNC_DELIVERY.md](EXCEL_SYNC_DELIVERY.md) ·
> [../features/excel-sync/README.md](../features/excel-sync/README.md)

## A virada: não precisamos mais do Microsoft Graph

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
As planilhas das filiais ficam numa biblioteca do SharePoint que **sincroniza para o
PC**. Escrever o arquivo local **é** escrever no SharePoint — o cliente do OneDrive
sobe sozinho, com o login que já existe naquela máquina.

O script não fala com a Microsoft. Ele grava um arquivo em disco. Por isso **não
precisa de Graph, de app no Entra, nem de consentimento de admin** — que era o que
estava travando desde 08-Ago.

**O preço, dito claro:** aquele PC precisa estar ligado e logado, com OneDrive
rodando. O Graph continua sendo melhor (roda no GitHub Actions, sem PC), e quando o
consentimento sair a gente troca o adapter sem mexer em mais nada.

---

## ✅ Pronto e provado

### Escrita cirúrgica — a peça que faltava
`engine/delivery/surgical.py`. Um `.xlsx` é um ZIP de XML. Em vez de desmontar e
remontar tudo, ele **troca só o XML das abas que escrevemos** e copia o resto byte a
byte.

Medido no arquivo real do Coffs, comparando os dois métodos:

| | openpyxl | **cirúrgico** |
|---|---:|---:|
| partes perdidas | **20** | **1** *(calcChain, de propósito)* |
| código de barras `TR-48681` (Print Layout) | perdido | ✅ hash idêntico |
| printerSettings (3 abas) | perdidos | ✅ idênticos |
| customXml, sharedStrings | perdidos | ✅ idênticos |
| 41 abas · 32.336 fórmulas | ok | ok |
| precisa do Excel instalado | não | **não** |

> O `calcChain.xml` sai de propósito: ele indexa fórmulas por posição e uma entrada
> velha faz o Excel pedir reparo. O Excel reconstrói ao abrir.

> ⚠️ Cuidado ao medir: `openpyxl` reporta `_images = 0` na `Print Layout` **mesmo no
> arquivo original** — ele não modela aquele desenho. Quem prova é o hash do
> `xl/media/image1.png`, não o openpyxl.

**Dependências da escrita: nenhuma.** `surgical.py` usa só `zipfile`/`re`, e o acesso
ao Supabase é `urllib`. `openpyxl` só é preciso para `render --workbook` e `master`.

### Resultado no arquivo real (cópia)
```
SOH Main    2.919 linhas  B3:F2921   (Main Warehouse + Gateway somados)
SOH Dear    1.215 linhas  B3:F1217   (Coffs Harbour)
Sales MTD     188 linhas  A7:D194    (Coffs Harbour, mês corrente)
linha após cada bloco: limpa
'Coffs' → SOH Dear: 787 SKUs achados antes → 792 depois, 0 perdidos
```

### Travas de segurança
- `local_xlsx.assert_writable()` **recusa** qualquer caminho dentro de pasta
  cloud-sincronizada sem `--i-know-this-is-live`. Testado contra o arquivo real: recusou.
- Todo run copia o arquivo para backup antes de tocar.

### Master
`python -m engine master` gera um workbook com `STOCK LEVEL` (3.705 × 17 warehouses)
e `MONTHLY SALES` (1.103 × 10), no mesmo layout do export do Cin7.

**O master NÃO entra no fluxo de entrega.** As branches são escritas direto. Ligá-las a
um master externo exigiria reescrever as **6.600 fórmulas internas** delas e passaria a
depender de link entre arquivos, que praticamente não atualiza no Excel Online. O master
serve para conferência e como possível fonte de Power Query. Está escrito na aba README
dele para ninguém confundir daqui a seis meses.

### As 7 filiais
`~/Library/CloudStorage/OneDrive-RapidLED/Shortcuts/WorkDocs - Inventory Stock Orders/`

| Arquivo | SOH Main | SOH Dear | Sales MTD |
|---|:--:|:--:|:--:|
| Brisbane Aug 26 | ✓ | ✓ | ✓ |
| Cairns - Aug 26 | ✓ | — | ✓ |
| Coffs Harbour Aug 26 | ✓ | ✓ | ✓ |
| Hobart Aug 26 | ✓ | ✓ | ✓ |
| Melbourne Aug 26 | ✓ | ✓ | ✓ |
| Sunshine Coast Aug 26 | ✓ | — | ✓ |
| Sydney Aug 26 | ✓ | ✓ | ✓ |

Só Coffs tem binding hoje (`coffs-soh-main`, `coffs-soh-dear`, `coffs-sales-mtd`).
Faltam 6 filiais — é copiar o TOML e trocar a localização.

---

## ⛔ Aberto

1. **O Excel abre sem pedir reparo?** Único teste que não dá para fazer por aqui.
   Arquivo: `~/Downloads/Coffs CIRURGICO.xlsx`. Se pedir reparo, ajustar o gerador de
   XML **antes** de qualquer coisa ir para produção.
2. **Cairns, Sunshine Coast e Sydney não têm `SOH Dear`** — confirmar se `SOH Main`
   sozinho basta nelas.
3. **Bindings das outras 6 filiais.**
4. **Consentimento no Entra** — não bloqueia mais nada, mas segue pendente se um dia
   quiserem rodar sem depender do PC. Ver [EXCEL_SYNC_DELIVERY.md](EXCEL_SYNC_DELIVERY.md).

---

## Amanhã, no Windows

### 1. Python
Instalar Python 3.11+ marcando **"Add python.exe to PATH"**. A escrita não precisa de
biblioteca nenhuma; só instale `openpyxl` se for usar `master` ou `render --workbook`:
```
pip install openpyxl
```

### 2. Credenciais do Supabase
`.env` na raiz do repo, ou variáveis de ambiente:
```
SUPABASE_URL=<a mesma que já está no .env do Mac>
SUPABASE_SERVICE_KEY=<idem>
```
**Só leitura do mirror.** Nada de Microsoft aqui.

### 3. Descobrir o caminho sincronizado
No Explorer, a biblioteca aparece normalmente como:
```
C:\Users\<usuario>\OneDrive - RapidLED\Shortcuts\WorkDocs - Inventory Stock Orders\
```
Confirmar com `dir` antes de apontar o script.

### 4. Testar numa CÓPIA primeiro
```
copy "...\Coffs Harbour Aug 26.xlsx" "%USERPROFILE%\Desktop\teste.xlsx"
python -m engine apply "%USERPROFILE%\Desktop\teste.xlsx" ^
    --bindings coffs-soh-main coffs-soh-dear coffs-sales-mtd
```
Abrir no Excel e conferir. **Só depois** apontar para o arquivo real, e aí é obrigatório
o `--i-know-this-is-live` (a trava existe justamente para não acontecer sem querer).

### 5. Agendar
Task Scheduler → tarefa diária → ação: `python -m engine apply ...`
com *Start in* na pasta `features/excel-sync`.

> A tarefa precisa rodar **com o usuário logado** — se marcar "run whether user is
> logged on or not", o script grava mas o OneDrive não está rodando para subir.

---

## Decisões tomadas (não re-discutir)

- **Escrita local via OneDrive sincronizado**, não Graph — Graph fica para quando o
  consentimento sair.
- **Escrita cirúrgica**, não openpyxl — openpyxl destrói o código de barras e a config
  de impressão de abas que a gente nem toca.
- **Sem master no fluxo** — as branches são escritas direto.
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
- `Discount` fora de escopo.
- Primeira escrita real sempre numa cópia.
