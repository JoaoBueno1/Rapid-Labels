# Rapid Labels — instruções para o agente

Ferramenta de depósito/armazém da Rapid LED: etiquetas, WMS, reposição, contagem cíclica, devoluções, anomalias de picking.
Express 5 servindo HTML/CSS/JS **vanilla** multipágina. Sem framework de front.

## Antes de tocar em qualquer coisa

- **Nunca altere `package.json` sem rodar `npm install --package-lock-only` no MESMO commit.** Existem **15 workflows** em `.github/workflows` rodando `npm ci`, e deriva entre `package.json` e `package-lock.json` aborta todos os crons de sync do Cin7. Já aconteceu em 2026-08-07.
- O Supabase do Labels é **separado** do TMS. Migrações vão pelo SQL Editor, não por `apply_sql.py`.
- **Não existe `.vercelignore`.** O deploy estático serve a raiz do repo — qualquer arquivo commitado fica publicamente acessível. Não commite screenshot, dump ou relatório com dado de cliente.
- **Congelado (saída física):** `features/returns/returns_doc.html` (tem `@media print`).
- O WMS **não é offline-capable**. Não há service worker, e `features/container-check/`, `features/label-sheets/` e `features/pick-productivity/` desregistram ativamente qualquer um que exista. Não prometa indicador de sync.

## Design — regras obrigatórias em código NOVO

Canônico completo vive em `Rapid-Express-Web/docs/DESIGN_SYSTEM.md`. Inventário deste repo: [docs/UI_AUDIT.md](docs/UI_AUDIT.md).

Modo **"parar a sangria"**: tela nova nasce certa, tela existente não é migrada.

### Proibido

- Escrever hex cravado. Use `var(--color-*)`.
- **Criar mais um arquivo `*-theme.css` de override.** Existem 4 hoje (`pick-anomalies-theme.css`, `replenishment-theme.css`, `home-returns-theme.css`, `restock-v2-theme.css`) carregados por último com `!important` re-apontando tokens de outro módulo. Esse padrão é a dívida — não a solução. Se precisa mudar um valor, mude na fonte.
- `!important` (há 52 declarações de `--var` com `!important` hoje; não some a elas).
- `style="..."` inline.
- `z-index` fora das 4 camadas.
- `alert()` e `confirm()` nativos.
- `'$' + x.toFixed(2)` para dinheiro.

### Tokens

```
Superfície   surface #FFFFFF · sunken #F8FAFC · subtle #F1F5F9
Tinta        text #1B2A3F · muted #64748B · muted-strong #475569 · subtle #94A3B8 · inverse #FFFFFF
Borda        border #E2E8F0 · border-strong #CBD5E1
Acento       accent #2563EB · subtle #DBEAFE · text #1E40AF
Erro         danger #DC2626 · subtle #FEE2E2 · text #991B1B
Sucesso      success #15803D · subtle #DCFCE7 · text #166534
Aviso        warning #F59E0B (nunca texto) · subtle #FEF3C7 · text #92400E
Espaço       4 · 6 · 8 · 12 · 16 · 24 · 32      (10 NÃO existe — é o 2º mais usado aqui hoje)
Raio         6 · 8 · 12 · 9999
Fonte        12 · 14 · 16 · 20    piso deste repo = 12    pesos 400 · 600 · 700
Camadas      sticky 100 · dropdown 1000 · modal 2000 · toast 3000
```

**Marca = `#1B2A3F`.** O ciano `#0AA5E6` das 6 páginas mais recentes **não é migrado**, mas também **não é usado em código novo**.

**Fonte:** stack de sistema em código novo. As 16 páginas que já carregam IBM Plex ficam como estão.

### Contraste

| Tinta | branco | `#F8FAFC` | `#F1F5F9` |
|---|---|---|---|
| `#1B2A3F` | 14.49 ✅ | 13.85 ✅ | 13.22 ✅ |
| `#64748B` | 4.76 ✅ | 4.55 ✅ | **4.34 ❌** |
| `#475569` | 7.58 ✅ | 7.24 ✅ | 6.92 ✅ |
| `#94A3B8` | **2.56 ❌** | **2.45 ❌** | **2.34 ❌** |

**Cabeçalho de tabela tem fundo `#F1F5F9` → a tinta é `#475569`.**

### Toda tela tem 4 estados

`carregando` · `vazio` · `erro` · `com dado`. **Vazio ≠ erro** — num controle de estoque, "nenhum item" por causa de um 500 vira decisão de reposição errada.

Ação em voo trava o botão que a disparou.

## Dívida conhecida (não é para consertar sem pedido, mas saiba que existe)

- `styles.css:1043` tem um **dark mode acidental**: `@media (prefers-color-scheme: dark) and (max-width: 768px)` sobrescreve `.app-table` (usada por 13 páginas). Operador com celular em tema escuro já vê tabela escura que ninguém projetou. Dark mode está **fora de escopo** — se for tokenizar `.app-table`, trate esse bloco de propósito.
- `manifest.json` declara `theme_color`/`background_color` `#232946` — o design legado. Barra e splash no celular do armazém ainda são do visual antigo.
