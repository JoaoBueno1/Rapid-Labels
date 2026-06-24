# Container Check — QC de Recebimento (inbound)

Substitui o `Container Report.xlsx`. Registra a qualidade das etiquetas
e barcodes que chegam da fábrica em cada container, com **fotos**, e
deixa a responsável revisar online. Tudo no site — sem app nativo.

Spec completa: [PLAN.md](PLAN.md).

## Arquivos

| Path | Papel |
|---|---|
| `container-check.html` / `.js` / `.css` | Página (2 abas + modal de formulário) |
| `container-check-engine.js` | Rotas Express (`/api/container-check/*`) |
| `migrations/001_create_container_checks.sql` | `cin7_mirror.container_checks` + bucket de fotos |

## Modelo

1 registro = 1 SKU recebido. Campos: data, rapid_code, 5dc, qty, po,
3 seletores de etiqueta (`ocl`/`icl`/`bar` = OK/Wrong/Missing/N/A),
até 4 fotos, notas do estoque, notas de revisão, `status`
(green/red/orange/pending), e `reviewed_by`/`reviewed_at`. Sem link com
PO/Cin7 — texto livre, mas o campo Rapid Code tem **autocomplete** a partir
de `cin7_mirror.products` (sugere, não bloqueia digitação manual).

## Fluxo / status

```
New record ──> status: PENDING ──> aparece em "Need Review"
                                        │
                          revisão (🟢/🟠/🔴 + nota) define o status final
                                        │
                                        v
        green / orange / red  ──> fica no histórico (aba Records)
```
- **pending** — recém-criado, aguardando revisão (fica em Need Review).
- **green** — revisado, tudo OK.
- **orange** — revisado, problema menor / em acompanhamento.
- **red** — revisado, problema real (etiqueta/barcode errado/faltando).

`updated_at` é bumpado pelo engine (sem trigger). `reviewed_by/at` são
carimbados quando a revisão muda o status (≠ pending).

## Auditoria (log)

Toda ação (criar / editar / revisar / apagar, + fotos +/−) grava 1 linha em
`cin7_mirror.container_check_log` (sobrevive ao delete do registro). É
**best-effort**: se a tabela não existir (migration 003 não rodada), o CRUD
segue funcionando sem log. O histórico de cada registro aparece no modal de
detalhe.

## Fotos

Sobem **direto do navegador** pro bucket `container-check` do Supabase
Storage (resize no canvas → ~250KB). Não passam pelo Express (limite de
2mb no JSON). O POST só guarda as URLs em `photos`.

## Endpoints

```
GET    /api/container-check/records?from&to&status&q&page&pageSize
                                                       lista paginada + summary (sobre o filtro inteiro)
GET    /api/container-check/review                     fila Need Review (status=pending)
GET    /api/container-check/products?q=                autocomplete (cin7_mirror.products)
GET    /api/container-check/records/:id/log            histórico do registro (auditoria)
POST   /api/container-check/records                    cria (sempre entra como pending)
PUT    /api/container-check/records/:id                edita / revisa (carimba reviewed_by/at)
DELETE /api/container-check/records/:id                apaga (log sobrevive)
```

`/records` devolve `{ items, summary, total, page, pageSize, pageCount }`.
Paginação default = 50/página.

Envelope `{ success, data?, error? }`. Writes exigem header `x-cc-user`
(texto livre do `localStorage.containerCheckUser` — guard-rail, não auth).

## Setup

1. No **Supabase SQL Editor** do projeto do Rapid-Labels, rodar (nesta ordem):
   - `migrations/001_create_container_checks.sql` — tabela + RLS + grants.
   - `migrations/002_container_check_storage.sql` — bucket `container-check` + policies.
   - `migrations/003_review_and_audit_log.sql` — `reviewed_by/at` + tabela de log.
   (Não há `_exec_sql` nem `DATABASE_URL` direto pra esse projeto, então o
   apply é manual pelo SQL Editor. A feature roda mesmo sem o 003 — só sem o
   log de auditoria até rodá-lo.)
2. `npm start` → abrir
   `http://localhost:8383/features/container-check/container-check.html`
   ou clicar **Container Check** no card Quality & Compliance da home
   (atrás do mesmo PIN).

## Convenções

- CSS escopado com prefixo `.cc-*`.
- Mesmo design system do Container Builder (IBM Plex, paleta, pills).
- Registrado em `server.js` via
  `require('./features/container-check/container-check-engine')(app, supabaseBackend)`.
