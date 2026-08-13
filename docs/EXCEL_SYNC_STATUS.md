# Excel Sync — onde paramos (2026-08-13)

> Ponto de retomada. Docs relacionados:
> [EXCEL_SYNC_ARCHITECTURE.md](EXCEL_SYNC_ARCHITECTURE.md) ·
> [EXCEL_SYNC_REPORTS.md](EXCEL_SYNC_REPORTS.md) ·
> [EXCEL_SYNC_DELIVERY.md](EXCEL_SYNC_DELIVERY.md) ·
> [../features/excel-sync/README.md](../features/excel-sync/README.md)

## A virada: não precisamos mais do Microsoft Graph

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
- `Discount` fora de escopo.
- Primeira escrita real sempre numa cópia.
