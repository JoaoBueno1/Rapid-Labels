# Container Check — QC de Recebimento (Plano)

**Dono:** Joao
**Status:** Spec / pronto pra backlog
**Atualizado:** 2026-06-23

Feature **simples** dentro do Rapid Labels pra substituir o
`Container Report.xlsx`. Registrar a qualidade das etiquetas/barcodes
que chegam da fábrica, com **fotos**, e deixar a responsável (Kim)
revisar online — tudo no site, sem app nativo.

---

## 1. Princípios (o que é e o que NÃO é)

**É:**
- Formulário simples na web. Abre no celular pra bater foto no dock.
- 1 registro = 1 SKU recebido. Campos digitados na mão + seletores + notas.
- 1 a 4 fotos por registro.
- 2 abas pra visualizar: **Records** (tudo que registramos, com data) e
  **Need Review** (fila da Kim).
- Mesmo visual do Container Builder (header, cards, pills, IBM Plex).

**NÃO é (fora de escopo agora):**
- ❌ App nativo — só web responsivo.
- ❌ Link com PO/Cin7 — `PO` e `5DC` são campos de texto livres, sem busca.
- ❌ Prefill automático de linhas. Tudo digitado.
- ❌ Detecção automática de regressão entre containers (fica pra v2 — o
  dado já fica salvo no banco pronto pra isso depois).
- ❌ 3D, OCR, login real.

---

## 2. Modelo de dados (1 tabela só)

Cada linha do Excel vira uma linha aqui. Sem tabela de "lines" separada —
cada registro já é uma linha.

```sql
-- features/container-check/migrations/001_create_container_checks.sql
CREATE TABLE IF NOT EXISTS cin7_mirror.container_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  check_date      DATE NOT NULL DEFAULT CURRENT_DATE,   -- "Date"
  five_dc         TEXT,                                  -- "5DC" (id Cin7, texto livre)
  rapid_code      TEXT NOT NULL,                         -- "Rapid Code" (SKU)
  qty             NUMERIC,                               -- "QTY"
  po              TEXT,                                  -- "PO" (texto livre, sem link)

  ocl             TEXT CHECK (ocl IN ('OK','Wrong','Missing','N/A')),  -- Outer Carton
  icl             TEXT CHECK (icl IN ('OK','Wrong','Missing','N/A')),  -- Inner Carton
  bar             TEXT CHECK (bar IN ('OK','Wrong','Missing','N/A')),  -- Barcode Unit

  photos          JSONB NOT NULL DEFAULT '[]',           -- [{url, label}] (1–4)

  inventory_notes TEXT,                                  -- "Inventory - Comments"
  reviewer_notes  TEXT,                                  -- "Kim - Comments"

  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('green','red','orange','pending')),

  created_by      TEXT,                                  -- nome do localStorage
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_date   ON cin7_mirror.container_checks (check_date DESC);
CREATE INDEX IF NOT EXISTS idx_cc_status ON cin7_mirror.container_checks (status);
CREATE INDEX IF NOT EXISTS idx_cc_code   ON cin7_mirror.container_checks (rapid_code);

-- RLS permissiva (mesma convenção do cin7_mirror — guard-rail, não segurança)
ALTER TABLE cin7_mirror.container_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cc read"  ON cin7_mirror.container_checks;
DROP POLICY IF EXISTS "cc write" ON cin7_mirror.container_checks;
CREATE POLICY "cc read"  ON cin7_mirror.container_checks FOR SELECT USING (true);
CREATE POLICY "cc write" ON cin7_mirror.container_checks FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON cin7_mirror.container_checks TO anon, authenticated;
GRANT ALL ON cin7_mirror.container_checks TO service_role;

-- touch updated_at
CREATE OR REPLACE FUNCTION cin7_mirror.touch_cc_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_touch_cc ON cin7_mirror.container_checks;
CREATE TRIGGER trg_touch_cc BEFORE UPDATE ON cin7_mirror.container_checks
  FOR EACH ROW EXECUTE FUNCTION cin7_mirror.touch_cc_updated_at();
```

**Status auto-sugerido no formulário** (a Kim confirma/troca depois):
- algum de OCL/ICL/Bar = `Wrong` ou `Missing` → sugere `red`
- todos `OK`/`N/A` → sugere `green`
- enquanto não revisado → fica `pending` (cai no Need Review)

---

## 3. Fotos — direto do navegador pro Supabase Storage

O Express limita JSON a **2mb**, então a foto **não** passa pelo backend.
Fluxo:

1. No celular o user escolhe/tira a foto (`<input type="file" accept="image/*" capture="environment">`).
2. JS **reduz no canvas** pra ~1280px / JPEG ~0.7 (foto de 5MB → ~250KB) —
   rápido de subir e barato de guardar.
3. Sobe direto pro bucket via `supabase.storage.from('container-check').upload(...)`
   (client anon, mesma chave já usada no front).
4. Pega a `publicUrl` e guarda no array `photos` do registro.

**Infra nova** (única coisa que não é reaproveitar): criar 1 bucket
público `container-check` no Supabase (leitura pública, escrita anon —
coerente com o "guard-rail, não segurança" do repo). Caminho dos
arquivos: `container-check/<check_date>/<rapid_code>-<timestamp>.jpg`.

---

## 4. Telas

Mesma casca do Container Builder: `site-header` com ← Back, top bar com
título + botão, cards, status pills, prefixo CSS `.cc-*`, fontes IBM Plex.
Tudo responsivo (mobile = coluna única).

### Top bar
```
🚢 Container Check          [ + Novo registro ]   (usuário: Joao)
```

### Botão "Novo registro" → abre o formulário (modal)
Um card simples, campo a campo, otimizado pra dedão:
```
┌─ Novo registro ────────────────────────────┐
│ Data      [ 2026-06-23 ▾ ]  (default hoje)  │
│ Rapid Code[ R1030-WH-TRI            ]  *     │
│ 5DC [ 30619 ]   QTY [ 300 ]   PO [ 11822 ]  │
│                                             │
│ OCL  ( OK ) (Wrong) (Missing) ( N/A )       │  ← seletor de pílula
│ ICL  ( OK ) (Wrong) (Missing) ( N/A )       │
│ Bar  ( OK ) (Wrong) (Missing) ( N/A )       │
│                                             │
│ Fotos  [📷 +]  ▣ ▣ ▣      (até 4)           │  ← thumb com X pra remover
│ Notas  [ ____________________________ ]     │
│                                             │
│ Status sugerido: 🔴 Red   [ Salvar ]        │
└─────────────────────────────────────────────┘
```

### Aba 1 — **Records** (tudo compilado, com data)
- Faixa de resumo no topo (igual o dashboard do Excel):
  `Total · OK · Com problema · Issue Rate · 🟢 🔴 🟠 ⬜`
- Filtros: data (de–até), status, busca por Rapid Code.
- Tabela: Data · Rapid Code · QTY · OCL · ICL · Bar · 📷(thumb) · Status pill.
- Clicar na linha → modal de detalhe com fotos grandes + as duas notas.

### Aba 2 — **Need Review** (fila da Kim)
- Só os `pending` (e qualquer um marcado pra revisar).
- Cada item: fotos + dados + as notas do estoque → campo **Reviewer notes**
  + botões 🟢 🟡(orange) 🔴. Ao salvar, sai da fila.

> Máximo 2 abas. O formulário é um modal, não conta como aba.

---

## 5. Endpoints (engine)

Mesmo padrão do container-builder: envelope `{success, data?, error?}`,
header `x-cc-user` (texto livre do `localStorage.containerCheckUser`).

```
GET    /api/container-check/records?from&to&status&q   lista (Records)
GET    /api/container-check/records/review             fila Need Review (status=pending)
GET    /api/container-check/summary                    contadores do resumo
POST   /api/container-check/records                    cria (recebe URLs das fotos já subidas)
PUT    /api/container-check/records/:id                edita / revisa (status + reviewer_notes)
DELETE /api/container-check/records/:id                apaga
```

Registrar em `server.js` junto dos outros:
```js
require('./features/container-check/container-check-engine')(app, supabaseBackend);
```

---

## 6. Arquivos (espelha o container-builder)

```
features/container-check/
  container-check.html              página (2 abas + modal de form)
  container-check.js                lógica frontend (CRUD, upload, resize, render)
  container-check.css               estilos .cc-*
  container-check-engine.js         rotas Express
  migrations/001_create_container_checks.sql
  README.md
```

E um botão no card **Quality & Compliance** do `index.html`
(ao lado do Container Builder), atrás do mesmo PIN.

---

## 7. Rollout (2 passos pequenos)

**Passo 1 — registrar + ver (o essencial)**
- [ ] Migration + bucket `container-check` no Supabase.
- [ ] Engine: `POST` create + `GET` records + `GET` summary.
- [ ] Página: top bar, modal de formulário, aba **Records** com resumo,
      filtros e detalhe.
- [ ] Upload de foto (resize no canvas → Storage).
- [ ] Link no card Quality & Compliance.

**Passo 2 — revisão**
- [ ] `GET review` + `PUT` (status + reviewer_notes).
- [ ] Aba **Need Review** com os botões 🟢🟡🔴.

Depois disso o `Container Report.xlsx` está 100% coberto, e o banco já
guarda o histórico pronto pra v2 (regressão entre containers / scorecard
por fornecedor) quando você quiser.

---

## 8. Decisões em aberto pra você

1. Os 3 tipos de etiqueta (OCL / ICL / Bar) cobrem tudo, ou quer mais um?
2. "Orange" = problema menor / em acompanhamento? (Pra eu rotular certo.)
3. Quem registra põe o próprio nome 1x (localStorage) — ok, ou nem precisa?
</content>
</invoke>
