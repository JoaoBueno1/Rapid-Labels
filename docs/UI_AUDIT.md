# Auditoria de UI — Rapid-Labels

> **O que este documento é:** inventário **datado** do estado atual, com os comandos que o regeneram.
> **O que não é:** não é o cânone, e não é ordem de migração.
>
> | | |
> |---|---|
> | **Data** | 2026-08-26 |
> | **Cânone** | `Rapid-Express-Web/docs/DESIGN_SYSTEM.md` (canônico, outro repo) |
> | **Modo** | **Parar a sangria** — nada aqui é tarefa obrigatória. Telas existentes ficam como estão até você decidir o contrário. |
> | **Validade** | Envelhece em semanas. Cada seção traz a medição que a regenera. |
> | **Revisar até** | 2027-02-26 |

> **Nota de leitura — uma correção já aplicada ao cânone.**
> Esta auditoria rodou contra uma versão anterior do `DESIGN_SYSTEM.md`, que trazia sucesso `#16A34A`.
> Os três relatórios apontaram de forma independente que `#16A34A` dá **3,30:1** e reprova WCAG AA.
> **A crítica foi aceita:** o cânone já usa `#15803D` (5,02:1). Onde o texto abaixo ataca `#16A34A`, o ataque venceu.

---

**Escopo e método da medição:** **Repo:** `C:\Users\JoaoMarcos\Rapid-Labels` · branch `dev` @ `eedc09e` · 452 commits · medido em 2026-08-26 **Escopo medido:** 46 `.html` (16.199 linhas), 23 `.css` (7.240 linhas), 151 `.js` fora de `node_modules` e fora dos `_*.js` soltos (58.505 linhas). Excluídos de toda contagem: `node_modules/`, `.git/`, `.venv/`, `_slide_report/`, `_verify_out/`, `_audit_tmp/`, `_d3tmp/`, `_dmg/`, `_patmp/`, `_tmp_invest/`, `_product_data_quality/`, `*.xlsx`, dumps `.json`.

---

## 1. Stack

| Item | Medido |
|---|---|
| Backend | Express **5.1.0** (`package.json`), `server.js` (985 linhas, 19 rotas). Deploy alternativo Vercel serverless (`api/index.js`, `vercel.json` com 5 rewrites) |
| Render do front | **Estático puro.** `app.use(express.static(__dirname))` (server.js:82) — todo `.html` do repo é uma rota pública. Zero template engine. Uma exceção morta: `collections_labels.html` é um template Jinja (`{{ order.id }}`) num app Node, sem renderizador |
| CSS | Vanilla, sem pré-processador. **4.619 linhas de CSS moram dentro de `<style>` em HTML** contra 7.240 em `.css` externos → **39% de todo o CSS é embutido por tela** |
| Pipeline de build | **Não existe.** `package.json` tem 24 scripts, nenhum de build/bundle/minify/lint. Nenhum `postcss`, `tailwind`, `vite`, `esbuild`. Versionamento de asset é manual via query string (`home.css?v=20260826c`, `app.js?v=20260302k`) — 140 tags `<script src>`, **0 com `defer` ou `async`** |
| Sistema de ícones | **Nenhum, consolidado.** Três abordagens convivem: (a) 1 sprite SVG real com 18 `<symbol>` — só em `index.html` (20 dos 22 `<svg>` do repo inteiro); (b) **~230 emoji** espalhados em 34 arquivos HTML (`cyclic-count.html` 42, `dashboard.html` 32, `core/pages/index.html` 20); (c) Font Awesome **6.4.0** via CDN carregado em **1 página** (`collections.html`) para **3 ícones** |
| Libs de UI de terceiros (com versão) | `@supabase/supabase-js@2` (**sem pin de minor**, unpkg, 26 páginas) · `@zxing/browser@0.1.5` (4 páginas) e `@zxing/library@latest` (**tag `latest`**, 1 página) · `chart.js@4.4.1` (6 refs CDN + 1 cópia local `assets/vendor/chart.umd.min.js` 205 KB) · `jspdf@2.5.1` · `jsbarcode@3.11.5` **e** `3.11.6` (duas versões no mesmo repo) · `xlsx@0.18.5` (unpkg **e** jsdelivr) + `xlsx-0.20.3` (cdn.sheetjs) · `html2pdf.js@0.10.1` · `html2canvas@1.4.1` · `font-awesome@6.4.0`. **Nenhuma lib de componentes** (sem Bootstrap/Tailwind/Material) |

---

## 2. Camada de design

| Arquivo | Tamanho | Tokens `--x:` definidos | Arquivos que consomem | Veredito |
|---|---|---|---|---|
| `styles.css` | 45.844 B / 1.633 linhas | **10** (num bloco `body{}` na linha 1145, seção "Minimal Theme Overrides" — **não há `:root`**) | **29 `<link>`** apontam para ele; mas só 23 arquivos no repo inteiro usam `var(--`, e ele mesmo consome 53 | **Parcial / base por acidente.** É a folha da app original de etiquetas (seções "Botões Principais", "Search Section", "Size Selection"), com um bloco de tokens colado no fim. 167 `!important` |
| `features/returns/returns.css` | 16.708 B / 256 linhas | **0** | 2 `<link>` | **Overlay conceitual.** É o arquivo que os 4 `*-theme.css` chamam de "the Returns design system" — e ele **não define nenhuma variável**: 69 hex distintos hardcoded em 256 linhas |
| `home-returns-theme.css` | 5.706 B / 78 linhas | 10 (repontando os de `styles.css`) | **1** (`index.html`) | **Overlay.** 77 `!important` em 78 linhas |
| `restock-v2-theme.css` | 6.315 B / 73 linhas | 0 | **1** (`restock-v2.html`) | **Overlay.** 105 `!important` em 73 linhas |
| `features/pick-anomalies/pick-anomalies-theme.css` | 7.495 B / 130 linhas | 8 | **1** | **Overlay.** 71 `!important` |
| `features/replenishment/replenishment-theme.css` | 7.349 B / 145 linhas | 18 | **2** | **Overlay.** 83 `!important` |
| `features/replenishment/replenishment-cb.css` | 2.957 B / 57 linhas | 16 | **0** — o único texto no repo que o cita é um comentário em `replenishment-theme.css:14` | **MORTO.** Sobra da campanha "Container Builder overlay" (commit `61d63be`, 2026-06-21). 34 `!important` |
| `features/logistics/logistics.css` | 13.330 B / 314 linhas | 10 (`--log-*`) | 7 `<link>` | **Vivo, mas parcial** — é o token set mais adotado depois de `styles.css`; e é justamente o alvo do re-point de `pick-anomalies-theme.css` |
| `features/wms/pwa/wms.css` | 9.245 B / 140 linhas | **23** (`:root`, o set mais completo do repo) | **1** (`wms.html`) | **Vivo mas isolado** — sistema próprio, paleta teal, nada mais o consome |

### O padrão de overlay, medido

Os 4 `*-theme.css` somam **426 linhas** e **336 `!important`** — **0,79 `!important` por linha**, e **31% de todos os 1.073 `!important` do repo** (738 em `.css` + 335 em `<style>` de HTML).

O mecanismo é literal e está documentado nos próprios cabeçalhos:

- `restock-v2-theme.css:2` — *"loaded LAST, wins via !important"*
- `home-returns-theme.css:4` — *"Loaded AFTER the inline `<style>` so it wins. To revert: delete the one `<link>` line"*
- `replenishment-theme.css:19` — *"base `<style>` sets several with !important on body, so we must match that to win"*

O caso mais claro é a home. `home.css:7-17` define `--primary-600:#2563eb; --border:#e2e8f0; --header:#0f172a` (paleta slate). `home-returns-theme.css:12-25` redefine **os mesmos 10 tokens** com `!important` para `--primary:#0aa5e6; --border:#e2e7ef; --header:#ffffff`. **A home carrega os dois conjuntos de tokens, um sombreando o outro, na mesma requisição.**

**Veredito global: não existe fonte de verdade visual.** Existe um *comentário de paleta* copiado à mão em **12 arquivos** (`grep 'Returns design|house style'`), e **11 arquivos** repetem a tríade literal `#0aa5e6` + `#1a2230` + `#e2e7ef` hardcoded. O "design system" é convenção transcrita, não código compartilhado.

---

## 3. Paleta

**414 hex distintos** em **5.206 ocorrências** (CSS + HTML + JS).

### Os 15 mais usados

| # | Hex | Ocorr. | Família provável | Papel inferido |
|---|---|---:|---|---|
| 1 | `#fff` / `#ffffff` | 352 + 27 | — | Superfície de card |
| 2 | `#64748b` | 253 | Tailwind **slate-500** | Texto muted (sistema A) |
| 3 | `#e2e8f0` | 191 | Tailwind **slate-200** | Borda (sistema A) |
| 4 | `#94a3b8` | 182 | Tailwind **slate-400** | Texto subtle (sistema A) |
| 5 | `#1a2230` | 111 | Custom (overlay Returns) | Tinta escura (sistema B) |
| 6 | `#0aa5e6` | 110 | Custom — **não é Tailwind** (sky-500 é `#0ea5e9`) | **Acento (sistema B)** |
| 7 | `#cbd5e1` | 106 | Tailwind slate-300 | Borda forte (A) |
| 8 | `#f1f5f9` | 104 | Tailwind slate-100 | Fundo hover (A) |
| 9 | `#475569` | 101 | Tailwind slate-600 | Texto secundário (A) |
| 10 | `#0f172a` | 100 | Tailwind slate-900 | Tinta escura (A) |
| 11 | `#f8fafc` | 96 | Tailwind slate-50 | Fundo de página (A) |
| 12 | `#e2e7ef` | 79 | Custom | **Borda (sistema B)** — rival de `#e2e8f0` |
| 13 | `#dc2626` | 105 | Tailwind red-600 | Erro |
| 14 | `#1e293b` | 65 | Tailwind slate-800 | Tinta |
| 15 | `#1a1a1a` | 60 | Genérico/legado | Tinta (páginas antigas) |

### Sistemas de design rivais coexistindo

| Sistema | Ocorrências | % do total | Hex de prova | Onde vive |
|---|---:|---:|---|---|
| **A. Tailwind slate** (neutro) | **1.341** | 25,8% | `#0f172a #1e293b #334155 #475569 #64748b #94a3b8 #cbd5e1 #e2e8f0 #f1f5f9 #f8fafc` | `styles.css`, `home.css`, `pick-anomalies.css`, `logistics.css`, todo o JS |
| **B. Overlay "Returns" cyan** (neutro + acento) | **677** | 13,0% | `#0aa5e6 #0893cc #1a2230 #5b6b86 #7a8aa2 #8a97ab #e2e7ef #d3dae6 #eef1f6 #f4f6f9 #f7f9fc` | 14 arquivos: os 4 `*-theme.css`, `returns.css`, `container-check.css`, `gateway-main.css`, `label-sheets.css`, `pick-productivity.css`, `pack.css`, `replenishment-all.html`, `returns_doc.html`, `gateway-stock-analysis.css` |
| C. Vermelho/danger | 385 | 7,4% | `#dc2626 #ef4444 #b91c1c #991b1b #fee2e2 #fecaca #fef2f2` | transversal |
| D. Âmbar/warn | 303 | 5,8% | `#f59e0b #d97706 #b45309 #92400e #fef3c7 #fde68a` | transversal |
| E. Tailwind green | 278 | 5,3% | `#16a34a #22c55e #15803d #166534 #dcfce7 #bbf7d0` | transversal |
| **F. Indigo/violeta** | **209** | 4,0% | `#6366f1`(46) `#8b5cf6`(30) `#7c3aed`(27) `#4f46e5`(22) `#3730a3` `#6d28d9` `#ede9fe` `#e0e7ff` | `restock-v2.js`, `cyclic-count`, `dashboard.html` |
| **G. Tailwind blue** | **203** | 3,9% | `#2563eb`(40) `#3b82f6`(40) `#1d4ed8`(22) `#1e3a8a`(13) `#dbeafe` `#bfdbfe` `#eff6ff` | `styles.css`, `home.css`, `logistics.css` |
| H. Flat UI / legado | 195 | 3,7% | `#c0392b`(47) `#1a1a1a`(60) `#333`(27) `#ddd`(31) | páginas de 2025 + overlay (que adotou `#c0392b` como "red") |
| I. Emerald | 103 | 2,0% | `#059669 #10b981 #047857 #d1fae5 #ecfdf5` | rival direto de (E) |
| **J. Tailwind gray** (rival direto de slate) | **82** | 1,6% | `#e5e7eb`(13) `#6b7280` `#9ca3af` `#f3f4f6` | resíduo |
| K. Teal WMS PWA | 15 | 0,3% | `#0d9488 #0f766e #f0fdfa` (Tailwind teal-600/700) | **só** `features/wms/pwa/wms.css` |
| L. Cream Container-Builder | 38 | 0,7% | `#faf8f5 #d4cfc5` | `container-builder.css` + `replenishment-cb.css` (morto) |
| M. Laranja sidebar | 10 | — | `#f97316` (Tailwind orange-500) + rail `#1b2537` | só `home.css` (sidebar de 2026-08-22) |
| N. Gradiente pack | 11 | — | `#4facfe` (cor de "gradient pack" popular, não pertence a nenhum sistema) | `pick-anomalies.css`, `open-orders.css` |

**Cor de marca vs cor de framework.** Não há cor de marca definida em lugar nenhum. O único candidato é `#232946` — o `<meta name="theme-color">` de `index.html` e `manifest.json` — que aparece **3 vezes** no repo e **em nenhuma folha de estilo**. Todo o resto é paleta de framework (Tailwind) ou paleta inventada por campanha de redesign (`#0aa5e6`, `#faf8f5`, `#0d9488`). Ou seja: **13 cores rivais, zero cor de marca aplicada.**

**Explosão por arquivo:**

| Arquivo | Hex distintos | Ocorr. |
|---|---:|---:|
| `home.css` (618 linhas) | **89** | 287 |
| `styles.css` (1.633) | 79 | 202 |
| `features/pick-anomalies/pick-anomalies.css` (1.435) | 76 | 497 |
| `features/returns/returns.css` (**256 linhas**) | **69** | 156 |
| `restock-v2.html` | 63 | 268 |

`returns.css` — o arquivo tratado como referência canônica pelos overlays — tem **69 cores distintas em 256 linhas e nenhuma variável**.

---

## 4. Tipografia

### Font stacks distintas (35 declarações únicas)

| Stack | Ocorr. |
|---|---:|
| `inherit` | 39 + 3 (`!important`) |
| `'IBM Plex Mono', monospace` | 20 |
| `'IBM Plex Mono', ui-monospace, monospace` | 19 + 4 |
| `'Courier New', monospace` | 19 |
| `var(--mono)` | 16 |
| `monospace` (nu) | 14 |
| `'IBM Plex Sans', system-ui, sans-serif` | 9 + 5 |
| `Arial, sans-serif` | 5 + 1 |
| `Consolas, monospace` | 4 |
| `ui-monospace, SFMono-Regular, Menlo, monospace` | 3 |
| `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | 3 variantes distintas |
| `'Segoe UI', Tahoma, Geneva, Verdana, sans-serif` | 2 |
| `'Segoe UI', Arial, sans-serif` | 2 |
| `'SF Mono','Monaco', monospace` / `+ 'Consolas'` | 2 variantes |
| `'Inter', 'Segoe UI', sans-serif` | **1** |
| `'Helvetica', Arial, sans-serif` | 1 |
| `'IBM Plex Sans', sans-serif` | 1 |
| `'IBM Plex Sans',system-ui,-apple-system,Segoe UI,Roboto,sans-serif` | 1 |

**8 stacks mono distintas** e **9 stacks sans distintas** para o mesmo produto.

### Carregamento

- **16 das 46 páginas** carregam Google Fonts via `<link>`, com **6 URLs de query diferentes** (pesos `400;500`, `400;500;600`, `400;500;600;700`, `400;500;700` — quatro subsets diferentes da mesma família).
- **1 `@import`** de Google Fonts dentro de CSS: `home-returns-theme.css:1`. É a pior variante — a folha é a **última** do `<head>` de `index.html`, então a requisição da fonte só começa depois que ela baixa.
- **0 `<link rel="preconnect">`** para `fonts.gstatic.com` em todo o repo.
- **Bug medido:** `features/pick-anomalies/pick-anomalies.html` declara `font-family: 'IBM Plex Sans'` em `pick-anomalies-theme.css:29` e **não carrega a fonte em lugar nenhum** (nem no HTML, nem em nenhum dos 3 CSS que linka). A tela cai em `system-ui` enquanto o CSS afirma outra coisa.

### Escala de tamanho medida (px)

| px | ocorr. | | px | ocorr. |
|---:|---:|---|---:|---:|
| **12** | 344 | | 22 | 28 |
| **13** | 283 | | 20 | 27 |
| **11** | 255 | | 13.5 | 21 |
| **10** | 140 | | 11.5 | 20 |
| **14** | 111 | | 24 | 15 |
| **16** | 58 | | 10.5 | 10 |
| **9** | 46 | | 26 | 9 |
| 12.5 | 35 | | 28 / 17 | 8 / 8 |
| 15 | 31 | | 8 / 9.5 / 32 | 3 / 4 / 4 |
| 18 | 29 | | +26 valores de 1-5 ocorr. | |

**44 valores px distintos**, mais **~30 valores em `rem`/`em`** (`.78rem`, `.82rem`, `.68rem`, `.66rem`, `0.85em`, `1.1em`…) e **4 em `pt`** (`10pt`, nas etiquetas).

### Problemas

1. **Meio-degraus decimais**: `12.5px`(35), `13.5px`(21), `11.5px`(20), `10.5px`(10), `9.5px`(4), `16.5px`, `8.5px` — 92 declarações em tamanhos que nenhuma escala justifica.
2. **479 declarações abaixo de 12px** (11px, 10px, 9px, 8px e decimais). Numa ferramenta de depósito lida às vezes em tablet, isso é o maior problema tipográfico do repo.
3. Mistura de unidade sem regra: `px` e `rem` no mesmo arquivo (`home.css` usa `.63rem` para labels de sidebar e `11px` para badges).

---

## 5. Espaçamento e raio

### Espaçamento (`padding`/`margin`/`gap`) — **41 valores px distintos**

| px | ocorr. | múltiplo de 4/8? |
|---:|---:|---|
| **8** | 661 | ✅ |
| **10** | **533** | ❌ |
| **12** | 491 | ✅ |
| **6** | 462 | ✅ (degrau 6 do cânone) |
| **4** | 347 | ✅ |
| **16** | 245 | ✅ |
| **14** | 237 | ❌ |
| **2** | 189 | ❌ |
| **20** | 154 | ❌ |
| **5** | 119 | ❌ |
| **3** | 101 | ❌ |
| **18** | 88 | ❌ |
| 7 | 73 | ❌ |
| 24 | 64 | ✅ |
| 1 / 9 / 11 / 15 / 22 / 30 / 13 | 52/50/38/32/30/29/11 | ❌ |
| 40 / 60 / 28 / 48 / 34 / 26 / 36 / 32 | 49/10/6/5/5/5/4/4 | misto |

**Veredito: arbitrária.** Os degraus canônicos (4/6/8/12/16/24/32) somam **2.274 ocorrências**; os não-canônicos (10/14/2/20/5/3/18/7/9/11/15/22/30/13/…) somam **1.907**. É praticamente 55/45 — não há escala, há hábito.

O degrau **10px sozinho tem 533 ocorrências**, mais que 12px e 4px.

### Border-radius — **27 valores distintos**

| valor | ocorr. |
|---|---:|
| `8px` | 184 |
| `6px` | 122 |
| `10px` | 92 |
| `12px` | 75 |
| `999px` | 67 |
| `4px` | 67 |
| `7px` | 45 |
| `50%` | 31 |
| `0` | 30 |
| `14px` | 18 |
| `3px` / `20px` | 16 / 16 |
| `9px` | 15 |
| `99px` | 13 |
| `5px` | 13 |
| `16px` / `2px` / `15px` | 6 / 5 / 3 |
| `var(--log-card-radius)` / `var(--r)` | 3 / 2 |
| 6 formas assimétricas (`14px 14px 0 0`, `7px 0 0 7px`, …) | 8 |

Duas convenções de pill coexistem (`999px` 67× e `99px` 13×). Os overlays introduziram `7px`/`9px`/`10px` (radius "Returns") sobre um repo que já tinha `6px`/`8px`/`12px`. Só **5 ocorrências** usam token.

**Relacionados:** **161 valores distintos de `box-shadow`**, **56 de `transition`**, **96 `linear-gradient`**, **25 `@keyframes`** — dos quais **8 são spinner** definidos independentemente (`spin` ×6, `sp` ×2, `gw-spin`).

---

## 6. Camadas (z-index)

**25 valores distintos**, 62 declarações:

| z-index | ocorr. | | z-index | ocorr. |
|---:|---:|---|---:|---:|
| 0 | 1 | | 60 | 3 |
| 1 | 8 | | 61 | **1** |
| 2 | 4 | | 70 | 1 |
| 3 | 4 | | 90 | 1 |
| 4 | 2 | | 100 | 10 |
| 5 | 4 | | 200 | 4 |
| 10 | 4 | | 900 | 1 |
| 20 | 3 | | 999 | 3 |
| 30 | 1 | | 1000 | 11 |
| 40 | 1 | | 1100 | 1 |
| 50 | 4 | | 1200 | 1 |
| | | | 2000 | 6 |
| | | | 3000 | 7 |
| | | | **9999** | **4** |

### Problemas

1. **Escala arbitrária, sem nome.** 25 degraus para o que na prática são 4 camadas (conteúdo, sticky header, dropdown, modal/toast).
2. **Valores mágicos:** `9999` (4×) e `3000` (7×) e `2000` (6×) coexistem para a mesma função — modal por cima de tudo. Ninguém sabe qual ganha sem ler os três.
3. **Colisão real medida:** `z-index:100` tem **10 ocorrências** e é usado tanto para `.site-header` sticky (`home.css:25`) quanto para overlays de tela em outras features. Numa página que carrega `styles.css` + CSS de feature + overlay, quem ganha depende da ordem do `<link>`, não da intenção.
4. `61`, `90`, `900`, `1100`, `1200` são incrementos de escape — o sintoma clássico de "somei 1 até subir".

Nota honesta: **não há `99999`** neste repo. O topo é `9999`. Comparado com o que o cânone descreve, este é o menor dos problemas medidos aqui.

---

## 7. Inventário de componentes

`class="…"` distintas no repo: **1.004**.

| Componente / classe | Onde é definido | Usos reais (`class="…"`) | Status |
|---|---|---:|---|
| `.btn` | `styles.css`, `wms.css`, `logistics.css` | **444** | Adotado |
| `.btn-primary` | `styles.css` | 32 | **Subutilizado** (7% do `.btn`) |
| `.btn-secondary` | `styles.css` | 18 | Subutilizado |
| `.btn-sm` | **nenhum CSS o define** | 49 | **Órfão — classe usada, nunca estilizada** |
| `.modal` | 18 arquivos CSS/HTML | **260** | Adotado |
| `.modal-content` | `styles.css` + 5 | 47 | Parcial |
| `.modal-body` | 2 defs | 24 | Subutilizado |
| `.modal-header` | 3 defs | 12 | Subutilizado |
| `.modal-footer` | **0 defs** | **0** | Inexistente — as 13 famílias de modal usam `-actions`, `-ft`, `-foot`, cada uma a sua |
| `.card` | `styles.css`, `wms.css`, `pack.css` | **138** | Adotado |
| `.card-header` | 1 def | 10 | Subutilizado |
| **`.card-body`** | **0 defs** | **1** | **Assimetria máxima: 138 cascas para 1 corpo** |
| `.kpi` | `logistics.css`, `pick-anomalies.css` | 113 | Adotado |
| `.kpi-card` | `styles.css`, `home.css` | **4** | **Duplicado** — `.kpi` e `.kpi-card` são dois componentes concorrentes |
| `.kpi-value` / `.kpi-label` | 17 / 9 defs | 24 / 24 | Parcial |
| `.wh-kpi*` | `home.css` | ~14 defs | **Duplicado** (terceira família de KPI) |
| `.pp-kpi*` | `pick-productivity.css` | 4 defs | **Duplicado** (quarta) |
| `.chip` | 63 seletores em 6 arquivos | 97 | Adotado |
| `.filter-chip` | `replenishment*` | 7 | **Duplicado** de `.chip` |
| `.status-badge` | 27 seletores | 5 | **Subutilizado gravemente** — 27 regras CSS para 5 usos estáticos (o resto é gerado em JS) |
| `.badge` | 20 seletores | 91 | Adotado |
| `.app-table` | `styles.css` (62 seletores) | 25 | Parcial |
| `.table` | 28 seletores | 123 | Adotado |
| `.table-wrapper` | 18 seletores | 18 | Adotado (1:1) |
| `.empty-state` | 4 defs | **4** | **Órfão na prática** (ver §12) |
| `.spinner` | 5 defs | 5 | Subutilizado |
| `.toast` | 10 defs | 7 | **Duplicado** (11 implementações, ver §8) |
| `.site-header` / `.site-footer` | 61 / 22 seletores | 27 / 14 | Adotado — é o único componente realmente transversal |
| `.nav-link` | `styles.css`, `home.css` + 3 overlays | 27 | Adotado |
| `.sb-*` (sidebar) | só `home.css` | 11 classes | Novo (2026-08-22), isolado em 1 página |

### Assimetria de adoção — o padrão dominante

- **`.card` 138 : `.card-body` 1.** Pegam a casca e preenchem inline.
- **`.btn` 444 : `.btn-primary` 32 : `.btn-secondary` 18.** 89% dos botões não declaram variante — a hierarquia visual vem de `style=""` ou de classes de feature (`.rt-btn-primary`, `.cb-btn`, `.pa-btn`).
- **`.modal` 260 : `.modal-footer` 0.**
- **`.btn-sm` usada 49 vezes sem existir em CSS nenhum** — 49 botões que o autor achou que ficariam pequenos e não ficam.

A prova numérica de que a casca é preenchida inline: **1.926 atributos `style="`** e **518 atribuições `.style.X =` em JS** (§9).

### Convenção de nomes (crédito onde é devido)

Das 1.004 classes: **818 kebab-case**, 146 palavra única, **3 camelCase**, **0 BEM**, **0 PascalCase**. **627 usam prefixo de feature de 2-4 letras** (`rt-` 64, `gt-` 49, `gw-` 47, `cc-` 47, `cb-` 47, `pa-` 44, `ls-` 40, `wh-` 29, `pk-` 29, `pp-` 25, `oo-` 19…). **A nomenclatura é consistente e disciplinada.** É o único eixo do design system que funciona, e não deve ser mexido.

---

## 8. Duplicação

| Padrão | Implementações independentes | Prova | Valor de consolidar |
|---|---:|---|---|
| **Modal** | **13 famílias de classe** | `.modal`(90 seletores) `.pa-modal`(16) `.tr-modal`(15) `.orders-modal`(15) `.gt-modal`(11) `.cb-modal`(11) `.rt-modal`(9) `.pp-modal`(9) `.oo-modal`(9) `.cc-modal`(8) `.ls-modal`(7) `.gw-modal`(7) `.trl-modal`(1) — definidas em 18 arquivos | Alto. Cada uma tem seu backdrop, sua animação de entrada (`modalSlideUp`, `modalSlideIn`, `paModalIn`, `gtSlideUp`, `gwBulkSlide`), seu botão de fechar (`-close`, `-x`, `-back`), seu comportamento de ESC |
| **Toast / notificação** | **11 funções `toast()` independentes** | `collections.js:578`, `container-builder.js:128`, `view.js:261`, `container-check.js:42`, `returns.js:57`, `transfer-out.js:16`, `wms-app.js:15`, `gateway-main.js:119`, `replacements-history.js:486`, `replacements.js:896`, `restock-v2.js:1637` (`showToast`) — + 11 classes CSS (`.toast`, `.rt-toast`, `.cb-toast`, `.cc-toast`, `.gt-toast`, `.gw-toast`, `.pp-toast`, `.toast-wrap`, `.toast-container`) | Alto. Assinaturas divergentes: `toast(msg, type='success')`, `toast(msg, kind='')`, `toast(msg, bad)`. Duração hardcoded 3500ms em 3 delas |
| **Tabela** | **19 famílias** | `.app-table`(62) `.table`(28) `.orders-table`(20) `.gw-table`(15) `.tr-table`(12) `.st-table`(12) `.pp-table`(12) `.oo-table`(11) `.plan-table`(10) `.rt-table`(9) `.pav2-table`(7) `.audit-table`(6) `.avg-table`(5) `.slip-tbl`(3) `.analysis-table`(2) `.im-table` `.count-table` `.cc-table` `.cb-table` | Alto. Todas fazem a mesma coisa: header cinza uppercase 11px, hover na linha, borda inferior. O overlay teve que escrever a mesma regra 4 vezes (`#planTable th`, `.app-table thead th`, `#restockTable thead th`, `.rt-table th`) |
| **Badge / chip de status** | **~30 famílias** | `.chip`(48) `.status-badge`(27) `.badge`(16) `.filter-chip`(12) `.severity-badge`(10) `.orders-badge`(9) `.status-chip`(8) `.weeks-badge`(7) `.pa-badge`(7) `.date-chip`(7) `.st-chip`(6) `.audit-chip`(6) `.cat-badge`(5) `.tr-badge` `.od-chip` `.ls-badge` `.info-badge` `.pp-chip` `.pav2-chip` `.im-chip` `.gw-chip` … | Alto |
| **Card de KPI** | **4 famílias** | `.kpi`/`.kpi-value` (logistics, pick-anomalies), `.kpi-card` (styles.css, home.css), `.wh-kpi*` (home.css), `.pp-kpi*` (pick-productivity.css) | Médio |
| **Spinner** | **8 `@keyframes` de rotação** | `spin`×6, `sp`×2, `gw-spin` | Baixo esforço, alto ganho simbólico |
| **Toolbar de filtro** | Ao menos 6 | `.pa-toolbar`, `.rt-toolbar`, `.oo-filters`, `#restockFilters`, `.gw-filters`, `.im-filters` | Médio |
| **Empty state** | **Quase nenhum** — 8 usos de `.empty-state` para 59 strings "No … found" espalhadas | ver §12 | Alto (é buraco, não duplicação) |
| **Paginação** | 3 (replenishment, warehouse-movements, container-list) | `.pages-btn`, paginação manual em `warehouse-movements.js:184` | Baixo |

---

## 9. Assinaturas de IA

**Fato estabelecido antes da análise:** **303 dos 452 commits (67%)** trazem `Co-Authored-By: Claude` no corpo. Não é preciso inferir se houve geração por IA — houve. A pergunta útil é **qual sintoma é específico de IA-sem-design-system** e qual é legado humano sob pressão. Abaixo, cada assinatura com essa separação.

---

**A. Camada de override carregada por último, com `!important`** — **SEVERIDADE ALTA**

Medido: 4 arquivos `*-theme.css`, **426 linhas, 336 `!important`** (0,79/linha), cada um linkado por exatamente 1-2 páginas, todos declarando no cabeçalho que "wins the cascade". Nascidos entre **2026-07-20 e 2026-07-30**; três deles em **1 único commit** cada.

`git show --stat b9d5260` — *"redesign: align Replenishment, Gateway, Pick Productivity & Pick Anomalies with the Returns design system"*, **2026-07-27**: 11 arquivos, +567/−331, criando `replenishment-theme.css` (145 linhas de uma vez) e `pick-anomalies-theme.css` (92 de uma vez).

**Só geração por IA explica?** Não exatamente — mas quase. Um humano sob pressão *também* escreve overlay com `!important`. O que é específico aqui é a **combinação**: (1) quatro overlays criados em 10 dias, (2) cada um com um cabeçalho em caixa de caracteres box-drawing explicando a própria arquitetura e como reverter, (3) **nenhum** deles tocando o CSS de origem. Isso é o padrão de quem consegue produzir 145 linhas coerentes num passe mas não consegue (ou não é autorizado a) refatorar o que já existe. **Severidade alta** porque é irreversível por acumulação: o quinto overlay vai precisar de `!important` mais específico que o quarto.

---

**B. Paletas de frameworks diferentes misturadas** — **SEVERIDADE ALTA**

Medido: **414 hex distintos**; 13 famílias identificadas (§3); dois sistemas neutros completos e mutuamente exclusivos coexistindo (Tailwind slate 1.341 ocorr. vs overlay cyan 677); Tailwind **gray** (`#e5e7eb`, 82 ocorr.) coexistindo com Tailwind **slate** (`#e2e8f0`, 191) — duas escalas de cinza do *mesmo* framework; **green** (278) e **emerald** (103) para o mesmo estado "ok"; **blue** (203), **indigo/violet** (209), **cyan custom** (148), **sky** (`#0ea5e9`, 6), **teal** (15) e **orange** (10) todos servindo de acento em telas diferentes.

**Só IA explica?** **Sim, majoritariamente.** Um humano tende a copiar a paleta da tela anterior. A assinatura específica de IA é o *escorregão de família dentro do mesmo framework* — `#16a34a` e `#059669` no mesmo repo não são uma decisão, são dois prompts diferentes que pediram "verde". Idem `#e2e8f0`/`#e5e7eb`.

---

**C. Explosão de font stacks** — **SEVERIDADE MÉDIA**

Medido: **35 declarações `font-family` distintas**; **8 stacks mono** para o mesmo papel (`'Courier New',monospace`, `Consolas,monospace`, `'SF Mono','Monaco',monospace`, `ui-monospace,SFMono-Regular,Menlo,monospace`, `'IBM Plex Mono',ui-monospace,monospace`, …); **6 URLs diferentes** de Google Fonts para a mesma família com subsets de peso diferentes; **1 única** referência a `'Inter'` no repo inteiro.

**Só IA explica?** **Sim.** Nenhum humano digita `'SF Mono','Monaco','Consolas',monospace` numa tela e `'Courier New',monospace` na tela seguinte por decisão. As 6 URLs de fonte com pesos diferentes são a mesma assinatura: cada tela pediu os pesos que aquela tela usava.

---

**D. `<style>` embutido por tela** — **SEVERIDADE ALTA**

Medido: **4.619 linhas de CSS dentro de HTML** (39% de todo o CSS). Piores:

| Arquivo | Total | Linhas de `<style>` | % |
|---|---:|---:|---:|
| `features/replenishment/replenishment-branch.html` | 1.312 | **1.051** (linhas 12-1062) | **80%** |
| `features/replenishment/replenishment.html` | 760 | **599** | **79%** |
| `core/pages/index.html` | 506 | **361** | **71%** |
| `cyclic-count.html` | 1.208 | **610** | 50% |
| `features/rapid-inventory/dashboard.html` | 1.383 | **347** | 25% |

**Só IA explica?** **Não.** Este é o sintoma mais clássico de legado humano de app estático — é assim que se começa qualquer projeto HTML. Contra-evidência forte: `index.html` tem **113 commits ao longo de 413 dias** e só foi partido em `home.css`+`home.js` em 2026-08-22 (`1e5777b`) — cresceu, não nasceu. **Severidade alta pelo efeito, não pela origem.**

---

**E. `style=` inline em massa + handlers inline** — **SEVERIDADE MÉDIA**

Medido: **1.926 `style="`** + **518 `.style.X =`** em JS + **749 handlers inline** (`onclick=` etc.) contra **328 `addEventListener`**. Piores: `restock-v2.js` 259 `style="`, `restock-v2.html` 181, `cyclic-count.html` 161, `index.html` 76.

Consequência arquitetural medida: `server.js:34` precisa de `"script-src-attr": ["'unsafe-inline'"]` no CSP **só** para os 749 handlers funcionarem. O CSP está permanentemente enfraquecido por causa de uma escolha de UI.

**Só IA explica?** **Não.** É o modo natural de escrever HTML sem framework. A parte que *é* assinatura de IA: 259 `style="` num único arquivo JS (`restock-v2.js`) coexistindo com um `restock-v2-theme.css` que tenta anular exatamente essas cores por `!important` — os dois autores do mesmo arquivo não se falaram.

---

**F. Token file criado e esquecido** — **SEVERIDADE ALTA**

Medido, três instâncias:

1. `features/replenishment/replenishment-cb.css` — 57 linhas, **16 tokens**, **34 `!important`**, **1 commit, 0 dias de vida**, **0 consumidores hoje**. Sobra da campanha "Container Builder overlay" (`61d63be`, `73c06f3`, `c7767c8`, `90b883b`, junho/2026). Só existe citado num comentário do overlay que o substituiu.
2. `features/wms/pwa/wms.css` — o `:root` mais completo do repo (**23 tokens**), consumido por **1 arquivo**.
3. `collections-returns-theme.css` — criado em `6c2e473` (*"PREVIEW Returns-style theme"*) e revertido em `d98b01a` (*"drop the preview Returns theme"*) — **2 commits, 0 dias**. Nasceu e morreu no mesmo dia.

**Só IA explica?** **Em grande parte, sim.** "Criar um arquivo de tokens completo, aplicar em uma tela, nunca propagar" é o padrão de um agente que resolve o pedido literal e não tem custo marginal de escrever 145 linhas novas em vez de reusar 20.

---

**G. Código morto de redesigns anteriores** — **SEVERIDADE ALTA**

Medido — **14 arquivos CSS/HTML vivos hoje nasceram num único commit e nunca mais foram tocados**, somando **1.988 linhas**:

`replenishment.css`(442) `container-builder.css`(359) `sync-cin7-cache.html`(276) `count-form.html`(264) `test-scanner.html`(172) `replenishment-theme.css`(145) `pa-analytics.css`(137) `sync-monitor.css`(128) `test-integration.html`(123) `invoicing-monitor.css`(101) `pdf-template.html`(77) `gateway-stock-analysis.css`(77) `replenishment-cb.css`(57) `board-report-one-page.html`(0 bytes).

**22 páginas HTML não são referenciadas por nenhum `href`, `window.open` ou `location.href`** do repo — e todas continuam servidas publicamente por `express.static`. As mais pesadas:

- `features/rapid-inventory/dashboard.html` — **1.383 linhas, o maior HTML do repo, zero referências**
- `core/pages/index.html` — 506 linhas, cópia da home de uma reorganização `core/` abandonada, linka `../styles/styles.css` que **não existe**
- `features/gateway/legacy/gateway-transfer.html`(843) + `gateway-stock-analysis.html`(397) + `gateway-auditor.html`(258)
- `features/replenishment/replenishment-all.html`(213)

**Isto já está documentado pelo próprio autor** em `docs/DEAD_CODE_REGISTER.md` (criado 2026-08-12, 2 semanas atrás) — e **nada foi removido**. O registro lista `core/pages/index.html`, `collections_labels.html`, `manual-label.html`, `sync-cin7-cache.html`, `test-integration.html`, `test-scanner.html`, `gateway-auditor.html` como `DELETE`.

**Só IA explica?** **Não.** Código morto acumula em qualquer projeto solo. O que é assinatura de IA é o *volume por campanha*: três campanhas de redesign identificáveis em `git log` num semestre — "Container Builder overlay" (jun), "Returns design system" (jul), "sidebar + wall display" (ago) — cada uma deixando artefatos completos e nenhuma limpando a anterior.

---

**H. z-index arbitrário** — **SEVERIDADE MÉDIA**

Medido: 25 valores distintos, topo `9999` (4×), com `3000`(7) `2000`(6) `1000`(11) `999`(3) todos no papel de modal; incrementos de escape em `61`, `90`, `900`, `1100`, `1200`.

**Só IA explica?** **Não.** É universal. Mas `61` e `1100` num repo que já tem `60` e `1000` é assinatura de patch cego.

---

**I. Nomes de classe em convenções misturadas** — **NÃO CONFIRMADO**

Medido: 818/1.004 kebab-case, 3 camelCase, 0 BEM, 627 com prefixo de feature consistente. **Esta assinatura não se aplica a este repo.** A nomenclatura é a coisa mais bem feita aqui.

---

**J. Emoji como sistema de ícones** — **SEVERIDADE MÉDIA**

Medido: **~230 emoji** em 34 arquivos HTML. O próprio autor reconhece o problema em dois commits: `34f670a` *"style(restock-v2): align to Returns/Pick-Anomalies design + **drop AI-look emojis**"* e `1159c99` *"professional orders modal — **no emoji**, neutral"* e `3f00464` *"**de-emoji** the transfers modal"*.

**Só IA explica?** **Sim.** Um dev solo não escreve `📦` em 34 arquivos HTML de uma ferramenta de depósito. E a mensagem de commit literalmente chama isso de "AI-look".

---

### Resumo honesto

| Assinatura | Explicação humana alternativa existe? |
|---|---|
| B. Paletas de frameworks misturadas | **Não** — escorregão intra-framework (`green` vs `emerald`) é específico de geração |
| C. 35 font stacks / 8 stacks mono | **Não** |
| J. Emoji como ícone (admitido em commit) | **Não** |
| F. Token file criado e esquecido (3×) | Fraca — o custo marginal zero de gerar arquivo novo é específico de IA |
| A. 4 overlays `!important` em 10 dias | Fraca — humano faz 1, não 4 com cabeçalho auto-documentado |
| D. `<style>` embutido por tela | **Sim, e é a explicação certa** — `index.html`: 113 commits / 413 dias |
| E. `style=` inline + handlers inline | **Sim** — padrão normal de HTML sem framework |
| G. Código morto de redesign | **Sim** — mas o volume por campanha é anômalo |
| H. z-index arbitrário | **Sim** — universal |
| I. Convenções de nome misturadas | **Não se aplica** — repo é consistente |

---

## 10. Acessibilidade

| Métrica | Medido |
|---|---|
| Atributos `aria-*` | **80 no total** em 46 HTML + 151 JS: `aria-label` 42, `aria-pressed` 18, `aria-hidden` 5, `aria-haspopup` 4, `aria-disabled` 4, `aria-expanded` 2, `aria-selected` 1, `aria-modal` **1**, `aria-live` **1**, `aria-labelledby` 1, `aria-current` 1 |
| `role=` | **14 no total**: `group` 4, `img` 3, `tab` 2, `menu` 2, `tablist` 1, `option` 1, **`dialog` 1** |
| `:focus-visible` | **1 ocorrência em todo o repo** — `restock-v2.html:430`, num `.info-badge` |
| `:focus` | 63 |
| `outline: none` | **50** — descartam o anel de foco 50 vezes e o repõem via `:focus-visible` 1 vez |
| `tabindex` | **1** (`tabindex="0"`) |
| `addEventListener('keydown')` | 30 (`keypress` 1) — quase todos para leitura de scanner/Enter, não para navegação |
| HTML semântico | `<button>` **523**, `<th>` 420, `<label>` 364, `<table>` 57, `<section>` 34, `<nav>` 34, `<header>` 32, `<main>` 24, `<footer>` 14, `<aside>` 4 |
| Div soup | **2.232 `<div>`** — razão div:button ≈ **4,3:1** |
| Botões falsos | **106** `<div|span|td|tr|li … onclick=>` — clicáveis não focáveis, não anunciáveis, sem Enter/Space |
| `cursor:pointer` em não-botão | 257 |
| `<img>` sem `alt` | 1 de 17 |
| `<html lang>` | 41 de 46 têm `lang="en"`; 5 sem |

**Diagnóstico:** o HTML é melhor que a média (523 `<button>` reais, 420 `<th>`, 364 `<label>`), mas a camada de foco está **desligada**: 50 `outline:none` contra 1 `:focus-visible`. Num coletor/tablet isso não importa; num teclado de estação de packing, o operador não sabe onde está.

`aria-modal` aparece **1 vez** para **260 usos de `.modal`** e **13 famílias de modal**. Nenhuma delas prende foco.

### Risco de contraste — pares reais, calculados com os hex medidos

Fundo branco `#ffffff`:

| Texto | Contraste | AA normal (4,5) | AA grande (3,0) |
|---|---:|---|---|
| **`#0aa5e6`** (acento do overlay, 110 ocorr.) | **2,79** | ❌ | ❌ |
| `#0893cc` (hover do acento, 38) | 3,47 | ❌ | ✅ |
| `#7a8aa2` (muted overlay, 50) | 3,51 | ❌ | ✅ |
| `#8a97ab` (subtle overlay, 51) | 2,96 | ❌ | ❌ |
| `#94a3b8` (subtle slate, **182**) | **2,56** | ❌ | ❌ |
| `#9aa6ba` (30) | 2,46 | ❌ | ❌ |
| `#64748b` (muted slate, **253**) | 4,76 | ✅ | ✅ |
| `#5b6b86` (60) | 5,40 | ✅ | ✅ |
| `#3b82f6` (40) | 3,68 | ❌ | ✅ |
| `#2563eb` (40) | 5,17 | ✅ | ✅ |
| `#16a34a` (40) | 3,30 | ❌ | ✅ |
| `#f59e0b` (55) | **2,15** | ❌ | ❌ |
| `#4facfe` (11) | 2,42 | ❌ | ❌ |
| `#1a2230` (111) | 15,96 | ✅ | ✅ |

Sobre o fundo real das telas com overlay (`#f4f6f9`) todos os valores caem ~8%: `#7a8aa2` vira **3,24**, `#64748b` vira **4,40** (perde o AA por 0,1).

**Texto branco sobre botão preenchido:**

| Fundo do botão | Contraste com `#fff` |
|---|---:|
| **`#0aa5e6`** — `.rt-btn-primary`, `.chip.active`, `.filter-chip.active`, `.branch-tab.active`, `.map-area-btn.active`, `.action-btn.edit`, `.pa-top-bar` | **2,79 — reprova AA e AAA, e reprova até o limiar de 3:1 de componente gráfico (WCAG 1.4.11)** |
| `#16a34a` | 3,30 ❌ |
| `#f59e0b` | 2,15 ❌ |
| `#dc2626` | 4,83 ✅ |
| `#2563eb` | 5,17 ✅ |
| `#c0392b` | 5,44 ✅ |

**O achado mais grave desta seção:** o acento do sistema visual mais recente e mais copiado do repo (`#0aa5e6`, presente em 14 arquivos, incluindo os 4 overlays) **reprova WCAG AA em todos os papéis em que é usado** — como texto sobre branco (2,79), como fundo de botão primário com texto branco (2,79) e como borda de estado ativo. É pior que o `#3b82f6` que o cânone já rejeitou por 3,68.

---

## 11. Responsivo / adaptação de tela

**72 `@media`** no total, dos quais **12 são `@media print`** → **60 media queries de layout**.

**14 breakpoints distintos:** 480, 560, 620, 640, 720, 768, 900, 980, 1000, 1024, 1080, 1100, 1600, 2000 px (+ 1 `max-height:820px`, + 1 `prefers-color-scheme: dark and max-width:768px`).

Frequências: `768px` 12× (em 3 grafias: `(max-width: 768px)`, `(max-width:768px)`, `(max-width: 768px) and (orientation: landscape)`), `640px` 9×, `900px` 8×, `1100px` 6×, `720px` 5×.

**Nenhum arquivo compartilha uma definição de breakpoint.** Não há variável, não há `@custom-media`.

**9 páginas sem `<meta name="viewport">`** — e todas as 9 são templates de impressão ou harnesses de teste (`barcodes_labels.html`, `collections_labels.html`, `pdf-template.html`, `returns_doc.html`, `transfer_out_print.html`, `board-report-one-page.html`, `test-integration.html`, `test-scanner.html`, `_transfer_out_mockup.html`). **Isso está correto** — não é falha.

### Isto importa neste produto?

**Parcialmente, e é preciso separar três consumidores:**

1. **Telas de escritório/análise** (`restock-v2`, `replenishment`, `pick-anomalies`, `open-orders`, `invoicing-monitor`, `warehouse-movements`, `gateway-main`) — desktop de operador, tabelas de 8-14 colunas. **Não penalizar por não ser mobile-first.** As media queries `max-width:640px` que existem nelas são, na prática, código morto.
2. **Telas de chão de fábrica** (`features/wms/pwa/wms.html`, `features/wms/pack/pack.html`) — **estas importam de verdade**. `wms.css` é o único arquivo do repo escrito mobile-first: `#app{max-width:560px}`, `font-size:16px` no body, `.btn{padding:16px; font-size:17px}` (≈51px de alvo), `.scan input{font-size:20px; padding:16px 14px}`. **Está certo.** `pack.css` (93 linhas) tem `@media print` mas nenhuma media query de layout.
3. **Wall display** (`home.css`, `.pipeline-fs`, `@media (min-width:1600px)` e `(min-width:2000px)`) — o único caso de "responsivo para cima", e é intencional (o board é lido de longe no depósito). Note o comentário em `home-returns-theme.css:41-43`: dois `!important` do overlay estavam vazando para o modo fullscreen e tiveram que ganhar um `:not(.pipeline-fs)` — **prova de que a camada de override já causou um bug visual de produção**.

**Veredito:** responsivo não é o problema deste repo. Os 14 breakpoints inconsistentes custam manutenção, não usabilidade. **Prioridade baixa**, exceto por `min-height:44px` (11 ocorrências) que é o padrão iOS antigo — `pack.html` e o teclado do WMS mereceriam auditoria de alvo de toque separada.

---

## 12. Estados de interface

Esta é a seção com o maior buraco medido.

| Estado | Medição global |
|---|---|
| **Loading** | 14 elementos com `id`/`class` de loading no repo inteiro (`#loadingOverlay` 4, `.ls-loading` 4, `.spinner` 3, `.pa-mov-loading` 3, `#pav2Loading`, `.od-loading` 2, `.gw-spinner`, `#loadingState`). 89 strings "Loading"/"Carregando" renderizadas. **8 `@keyframes` de spinner distintos**. **2 ocorrências de `skeleton`** (ambas em `home.css`, "Loading skeleton pulse") |
| **Empty state** | **`.empty-state` usado 8 vezes** e `.empty-row` 1 vez, contra **59 strings "No … found/yet/available"** — ou seja, ~51 estados vazios são texto solto sem componente |
| **Error state** | **Zero componente de erro.** Não existe `.error-state`, `.alert-error` nem equivalente. O tratamento é: **98 `alert()` nativos** + `console.error` (357 `catch` blocks nas telas medidas) |
| **Feedback de ação demorada** | **1 `aria-live` no repo inteiro.** Nenhum botão com estado `disabled`+spinner sistematizado (`.btn:disabled` existe só em `wms.css` e `returns.css`) |
| **Confirmação destrutiva** | **28 `confirm()` nativos** + 5 modais de confirmação custom (`#confirmModal` ×3, `#paConfirmModal`, `#ppImportConfirm`, `#invRemoveConfirm`) |
| **Prompt** | 5 `prompt()` nativos |

### `alert()` por arquivo — o feedback real do produto

| Arquivo | `alert()` |
|---|---:|
| `cyclic-count.js` | **34** |
| `features/pick-anomalies/pick-anomalies.js` | 12 |
| `features/label-sheets/label-sheets.js` | 10 |
| `cyclic-count.html` | 8 |
| `app.js` | 7 |
| `upload-system.js` / `upload-handler-new.js` | 3 / 3 |
| `replenishment-branch.js`, `pa-analytics.js`, `open-orders.js`, `integrations.html` | 3 cada |
| restante (7 arquivos) | 1-2 cada |

**A Contagem Cíclica — a tela usada por operador com coletor na mão — comunica 42 situações via `alert()` nativo do browser.** Num tablet isso é um diálogo modal do sistema que trava a página e exige toque no OK.

### Cobertura por tela (medido em HTML+JS de cada tela)

| Tela | refs loading | refs empty | refs error | `catch` |
|---|---:|---:|---:|---:|
| `features/wms/pack/pack.html` | **0** | **0** | **1** | 7 |
| `features/logistics/warehouse-movements.html` | **0** | 5 | 96 | 19 |
| `features/sync-monitor/sync-monitor.html` | 1 | 4 | 5 | **1** |
| `features/pick-productivity/pick-productivity.html` | **1** | 9 | 38 | 9 |
| `collections.html` | 2 | **4** | 104 | 42 |
| `features/returns/returns.html` | 2 | 12 | 18 | 18 |
| `features/logistics/open-orders.html` | 3 | 10 | 14 | 10 |
| `replacements/replacements.html` | 3 | 3 | 32 | 11 |
| `features/transfer-out/transfer-out.html` | 5 | 9 | 5 | 6 |
| `features/container-builder/container-builder.html` | 6 | **1** | 20 | 12 |
| `features/pick-anomalies/pick-anomalies.html` | 9 | 17 | 58 | 26 |
| `features/label-sheets/label-sheets.html` | 10 | 6 | 9 | 13 |
| `features/container-check/container-check.html` | 10 | 9 | 12 | 12 |
| `gateway-main.html` | 10 | 25 | 6 | 24 |
| `index.html` | 13 | 23 | 72 | 35 |
| `features/replenishment/replenishment.html` | 14 | 10 | 20 | **6** |
| `restock-v2.html` | 17 | 40 | 59 | 26 |
| `cyclic-count.html` | 22 | 11 | 158 | 24 |

**Telas sem NENHUM tratamento de loading:** `features/wms/pack/pack.html` (Pack Station — 0 loading, 0 empty, 1 error, e é uma tela de chão de fábrica que espera resposta do Supabase), `features/logistics/warehouse-movements.html`, e efetivamente `sync-monitor` e `pick-productivity` (1 ref cada).

**Telas sem empty state:** `pack.html` (0), `container-builder.html` (1), `replacements.html` (3), `collections.html` (4), `sync-monitor.html` (4).

**Ação destrutiva sem confirmação, medida por chamada real:** `features/container-check/container-check-engine.js` tem 2 `.delete()` de banco e **0 `confirm()`**; `features/pick-productivity/pick-productivity.js` tem 2 `.delete()` e 0 `confirm()`; `features/logistics/deliveries-couriers.js` tem 7 escritas e 0 `confirm()`. (Ressalva honesta: em `restock-v2.js`, 5 dos 6 `.delete(` são `Set.prototype.delete` de estado local, não banco — só a linha 77, `user_favorites`, é destrutiva, e é inócua. Em `returns.js` os 3 `.delete()` são substituição de linhas dentro de uma transação, não botão de usuário.)

---

## 13. Performance de front

### Dependências de CDN (risco de terceiro)

| Recurso | Páginas | Risco medido |
|---|---:|---|
| `https://unpkg.com/@supabase/supabase-js@2` | **26** | **Sem pin de minor.** Um breaking change de minor do SDK derruba 26 páginas simultaneamente. Sem SRI. **Se unpkg cair, 26 páginas do WMS param** |
| `https://unpkg.com/@zxing/library@latest` | 1 | **Tag `latest`** — pior caso possível |
| `https://unpkg.com/@zxing/browser@0.1.5` | 4 | Pinado ✅ |
| `https://cdn.jsdelivr.net/npm/chart.js@4.4.1` | 6 | Pinado, mas há uma **cópia local de 205 KB** (`assets/vendor/chart.umd.min.js`) usada só por `index.html` — mesma lib, duas origens |
| `jsbarcode@3.11.5` **e** `@3.11.6` | 2 + 2 | Duas versões no mesmo repo |
| `xlsx@0.18.5` (unpkg) + `xlsx@0.18.5` (jsdelivr) + `xlsx-0.20.3` (cdn.sheetjs) | 3 | **Três origens, duas versões** |
| `cdnjs.cloudflare.com/.../font-awesome/6.4.0/css/all.min.css` | 1 | **CSS render-blocking de ~100 KB carregado em `collections.html` para 3 ícones** |
| `cdnjs.../html2pdf.js@0.10.1` | 1 | |
| `fonts.googleapis.com` | 16 páginas + 1 `@import` | **0 `preconnect`** |
| `barcode.tec-it.com/barcode.ashx?...` | 1 | Serviço externo gerando código de barras server-side, dentro de um template Jinja morto |

**Total: 4 hosts CDN distintos** (unpkg, jsdelivr, cdnjs, cdn.sheetjs) + Google Fonts. O CSP em `server.js:33-39` teve que abrir `script-src` para unpkg e jsdelivr, e `style-src-elem` para cdnjs.

### Recursos render-blocking

- **140 tags `<script src>`; 0 com `defer` ou `async`.** Todas bloqueiam o parser.
- `index.html` carrega, em ordem no `<head>`: `styles.css` → `home.css` → `home-returns-theme.css` (que dispara um `@import` de Google Fonts **depois** de baixar) → `supabase-js@2` (CDN) → `@zxing/browser` (CDN, ~300 KB).
- **`@zxing/browser` está no `<head>` de `index.html` e de `restock-v2.html`** — uma lib de leitura de código de barras por câmera, bloqueando o primeiro paint de um dashboard.

### Maiores assets

| Asset | Bytes | Situação |
|---|---:|---|
| `rapid-express-logo.png` | **219.445** | **Não referenciado por nenhum HTML/CSS/JS** — está no repo e é servido publicamente |
| `assets/vendor/chart.umd.min.js` | 205.419 | Usado só por `index.html` |
| `home.js` | 106.821 | |
| `app.js` | 66.840 | |
| `home.css` | 52.187 | |
| `styles.css` | 45.844 | |
| `index.html` | 45.997 | |
| `supabase-config.js` | 25.283 | |
| `rapid-express-icon.png` | 15.393 | Usado (favicon + brand) |

**Peso local da home: 598.942 bytes (585 KB)** em 11 arquivos, mais 2 scripts de CDN. Tudo síncrono. `Cache-Control: no-cache` para `.js`/`.css` (server.js:71) — revalidação a cada navegação, correto para o modelo de deploy manual, mas significa que os 585 KB são re-validados sempre.

**Ressalva metodológica:** não há build, então não existe "bundle size" no sentido usual. Estes são bytes de arquivo em disco, não gzipped — `compression()` está ativo em `server.js:49`, o que provavelmente corta CSS/JS em ~70%. Não medi o payload comprimido porque isso exigiria subir o servidor.

---

## 14. Piores ofensores

| # | Arquivo | Métrica | Por que é problema |
|---:|---|---|---|
| 1 | `features/replenishment/replenishment-branch.html` | 1.312 linhas · **1.051 de `<style>` (80%)** · 48 defs de token · 57 `!important` · 44 hex distintos · 35 handlers inline | Uma tela onde 4 de cada 5 linhas são CSS. Define **48 variáveis CSS** que `replenishment-theme.css` depois **anula com `!important`**. Impossível revisar markup e estilo separadamente |
| 2 | `features/rapid-inventory/dashboard.html` | **1.383 linhas** (maior HTML do repo) · 347 de `<style>` · 693 de `<script>` · 43 hex · 41 `style=` | **Zero referências no código.** 1.383 linhas de superfície de manutenção que nenhum menu alcança. `DEAD_CODE_REGISTER.md:80` já o marca como o item de maior risco de decisão |
| 3 | `cyclic-count.html` + `cyclic-count.js` | 1.208 + 2.587 linhas · 610 de `<style>` · **42 `alert()` nativos** · 161 `style=` · 49 handlers inline · 38 hex | Tela de operador com coletor. Comunica 42 situações via diálogo do sistema. 24 `catch` mas nenhum estado de erro na UI |
| 4 | `restock-v2.js` | 3.478 linhas · **259 `style="` inline** · 27 handlers inline · 22 hex das famílias blue/indigo | O `restock-v2-theme.css` (73 linhas, 105 `!important`) existe para anular o que este arquivo escreve inline. Nunca vai ganhar — `style=` bate `!important` de folha externa em specificity de atributo |
| 5 | `features/pick-anomalies/pick-anomalies.css` | 1.435 linhas · **497 ocorrências de hex, 76 distintos** · 34 `!important` · 0 `var()` de token próprio | Cabeçalho diz "Full Design System" e "follows logistics.css design tokens", mas hardcoda `#64748b`, `#94a3b8`, `#f59e0b`, `#22c55e`, `#ef4444` direto. Depois `pick-anomalies-theme.css` (130 linhas, 71 `!important`) tenta consertar por cima. **Três camadas** |
| 6 | `home.css` | 618 linhas / 52 KB · **89 hex distintos** (o maior do repo) · 77 `!important` · define 10 tokens que o overlay anula | Linhas de até **311 caracteres**. Carrega a paleta slate + a paleta laranja/dark da sidebar nova (`#1b2537`, `#f97316`), e é imediatamente sobrescrita por `home-returns-theme.css` |
| 7 | `styles.css` | 1.633 linhas · **167 `!important`** (o maior número absoluto) · 79 hex · **linkado por 29 páginas** | É a base de facto do produto e não é um design system: é a folha da app de etiquetas de 2025 com tokens colados na linha 1145 e um bloco `@media (prefers-color-scheme: dark)` na linha 1042 que ninguém testou |
| 8 | `core/pages/index.html` | 506 linhas · 361 de `<style>` · **87 `!important`** (o maior de qualquer HTML) | Morto. Linka `../styles/styles.css` que **não existe**. Serve como fóssil da paleta original (`--primary:#1e3a8a`, `--primary-600:#2563eb`) |
| 9 | `features/gateway/legacy/gateway-transfer.html` | 843 linhas · 141 de `<style>` · 578 de `<script>` · 41 hex · 21 handlers inline · 3 `confirm()` | Morto para navegação, **vivo para URL direta** (`express.static`), e o `gateway-engine.js` que ele usa **está registrado** em `server.js:323` |
| 10 | `features/returns/returns.css` | 256 linhas · **69 hex distintos** · **0 `var()`** | O arquivo tratado como referência canônica por 4 overlays. 69 cores hardcoded, zero tokens. Toda a "design system" do repo é uma transcrição manual deste arquivo |

---

## 15. Mapa de risco

Rastreado abrindo `server.js`, `vercel.json`, cada HTML citado e o JS que ele carrega, e contando chamadas de escrita (`.insert(`/`.update(`/`.upsert(`/`.delete(`/`.rpc(`) e `method:'POST'`.

**Regra que vale para tudo aqui:** `app.use(express.static(__dirname))` (server.js:82) significa que **todo `.html` do repo é uma URL pública viva**. "Não referenciado" ≠ "não acessível".

### 🟢 Seguro mexer (refactor visual sem risco operacional)

| Tela / arquivo | Rota que renderiza | JS que carrega | Escritas / POST | Justificativa |
|---|---|---|---|---|
| `features/logistics/warehouse-movements.html` + `.js` (536 + 561 linhas) | estática, `/features/logistics/warehouse-movements.html` | `supabase-config.js`, `warehouse-movements.js` | **0 escritas, 0 POST** — só `sb.from('warehouse_movements').select(...)` (linhas 160-161) e agregação em memória | Relatório read-only puro. Nada a corromper |
| `features/logistics/invoicing-monitor.html` + `.js` + `.css` (125 + 627 + 101) | estática | `supabase-config.js`, `invoicing-monitor.js` | **0 escritas, 0 POST** — `sb.from('sales_orders').select(...)` (linha 255) + `localStorage` para linhas ocultas (linha 16) | Read-only. O único estado persistido é `localStorage` do próprio navegador |
| `features/sync-monitor/sync-monitor.html` + `.js` + `.css` (63 + 208 + 128) | estática | só `sync-monitor.js` (não carrega nem `supabase-config.js` global) | **1 chamada:** `sb.rpc('sync_health')` (linha 181) — **função de leitura** | 63 linhas de HTML, sem `<style>` embutido, CSS externo de 128 linhas nascido num commit. Refactor trivial |
| `features/logistics/deliveries-couriers.html` (162 linhas) — **só o HTML/CSS** | estática | `deliveries-couriers.js` (1.565 linhas, **7 escritas**) | HTML: 0 handlers inline, 0 `<style>` | A **camada de apresentação** é segura; o `.js` **não é** (7 escritas). Mexer só no HTML/CSS |
| `features/container-builder/view.html` (98 linhas) + `pdf-template.html` (77) | estáticas | `view.js` (1 escrita: salvar plano) / nenhum | `pdf-template.html`: **0 JS, 0 escrita** | `pdf-template.html` é template de PDF puro |
| `core/pages/index.html` (506 linhas) | estática, **não referenciada** | nenhum (linka CSS inexistente) | 0 | **Candidato a deleção, não a refactor.** Já listado como `DELETE` em `docs/DEAD_CODE_REGISTER.md` |
| `test-integration.html` (123), `test-scanner.html` (172), `sync-cin7-cache.html` (276), `manual-label.html` (17), `collections_labels.html` (60), `_transfer_out_mockup.html` (194), `reports/board-report-one-page.html` (0 bytes) | estáticas, não referenciadas | mínimo | 0 | Idem — deletar, não redesenhar. 842 linhas |
| `features/replenishment/replenishment-cb.css` (57 linhas, 34 `!important`) | — | — | — | **0 consumidores.** Deletar |

**Total realmente seguro para refactor visual: ~1.500 linhas de HTML/CSS em 4 telas read-only.** Mais ~1.400 linhas para deletar.

### 🔴 Não tocar

| Tela / arquivo | Por quê, com evidência |
|---|---|
| **`index.html` (676 linhas)** | Carrega **8 scripts** incluindo `app.js`, que faz `fetch('/api/print-zpl', {method:'POST'})` (app.js:1466) — **a impressora térmica**. O HTML hospeda **5 modais** (`#searchModal` l.274, `#manualModal` l.341, `#scanModal` l.401, `#barcodesModal` l.416, `#multiLabelModal` l.520) e `app.js` amarra **40 IDs distintos** via `getElementById`. Tem **67 handlers `onclick=` inline** e **76 `style=`**. Qualquer renomeação de ID ou reordenação de markup quebra impressão de etiqueta em produção |
| **`app.js` (1.657 linhas) + `multi-label.js` + `scanner.js`** | Caminho de impressão ZPL. `multi-label.js` gera HTML de impressão em milímetros (4 ocorrências de `mm`). Estilo e geometria de etiqueta são a mesma coisa aqui |
| **`barcodes_labels.html` (404 linhas, 42 ocorrências de `mm`)** | `@page { size:100mm 150mm; margin:0 }` (linha 130). O próprio arquivo tem comentários de instrução (linhas 13-71) explicando onde mexer. **Geometria de impressão térmica — um `padding` alterado é uma etiqueta rejeitada** |
| **`features/label-sheets/*` (label-render.js 1.149 linhas, 5 `mm`)** | Etiquetas A4 multi-up com calibração por modelo (Celcast/Avery). `jsPDF` em mm exatos a 100% |
| **`cyclic-count.html` + `cyclic-count.js` (1.208 + 2.587)** | 8 escritas no banco, 3 `confirm()`, `POST /api/cyclic-sync`. Gera token de sessão de contagem e monta `count-form.html?token=…` (cyclic-count.js:1204, 1256). **610 linhas de `<style>` e 461 de `<script>` no mesmo arquivo** — não há como tocar no visual sem tocar na lógica |
| **`features/returns/returns.html` + `returns.js` (411 + 1.094)** | **12 escritas** em `returns_lines`, `returns_treatment_lines`. Regra de negócio conhecida: estágio 1 congela quando o tratamento começa. `returns.css` é a referência visual de 4 overlays — mexer nele propaga por reflexo para 11 arquivos |
| **`features/pick-anomalies/*`** | 4 escritas + **5 POST**. Memória do projeto: cada "Fix" corrige estoque no Cin7. `pick-anomalies.js` tem 58 `style=` inline e 19 handlers inline. Três camadas de CSS (`pick-anomalies.css` 1.435 + `pa-analytics.css` 137 + `pick-anomalies-theme.css` 130) |
| **`gateway-main.html` + `gateway-main.js` (253 + 1.172)** | **15 `method:'POST'`** — o volume de escrita mais alto do front. Subsistema de inventário com lotes/FIFO/transferências (`f5208c4`). `gateway-main.css` tem `@page { size:A4 landscape }` (linha 155) |
| **`features/gateway/legacy/*.html` (1.498 linhas)** | Não linkadas, **mas `gateway-engine.js` está registrado em `server.js:323`** e `gateway-stock-analysis.html:334` carrega `stocktake-auditor.html` num iframe. `gateway-transfer.html` tem 3 `confirm()` e 578 linhas de script. **Zona cinzenta: parece morto, tem backend vivo.** Decidir antes de tocar, não durante |
| **`features/wms/pwa/wms.css` + `wms-app.js`** | Rota `/wms` (server.js:361 e `vercel.json`). 3 `confirm()`, `wms-engine.js` com 25 escritas, `outbox.js` (exactly-once). **É o único CSS bem construído do repo** (23 tokens, 16px base, alvos de ~51px). Mexer nele é regressão garantida |
| **`features/wms/pack/pack.html` + `pack.js`** | Rota `/pack`. 2 `confirm()`, 7 `catch`. Chão de fábrica |
| **`restock-v2.html` + `restock-v2.js` (943 + 3.478)** | 11 escritas. `restock-v2.js` tem **259 `style=` inline** — o overlay não vence, e cada tentativa de "limpar" o CSS vai mover exatamente nada até que os 259 saiam do JS. `@page{size:A4 landscape}` em duas linhas (496, 835) |
| **`collections.html` + `collections.js` (579 + 1.922)** | 2 escritas, carrega **6 scripts** incluindo a cadeia Cin7 (`cin7-config`, `cin7-client`, `cin7-service`, `cin7-simple-cache`) + `app.js` (impressão). É a única página com Font Awesome |
| **`features/container-check/*`** | 6 escritas + upload de fotos para Supabase Storage. `container-check-engine.js` tem **2 `.delete()` sem `confirm()`** |
| **`styles.css` (1.633 linhas, 167 `!important`)** | **Linkado por 29 páginas.** Qualquer edição toca todas. Contém `.size-btn`, `.print-section`, `@media print` da impressão |
| **Os 4 `*-theme.css`** | Não porque sejam bons, mas porque cada um é o último elo de uma cascata de 3 camadas em 5 páginas de produção. Removê-los sem antes remover o que eles anulam devolve gradiente indigo e header escuro a 5 telas de uma vez |

---

## 16. Quick wins

| # | Ação | Esforço | Impacto | Arquivos-alvo |
|---:|---|---|---|---|
| 1 | **Pinar `@supabase/supabase-js@2` numa versão exata e trocar `@zxing/library@latest` por versão fixa** | 1h | **Alto** (risco de parada total em 26 páginas) | 26 HTMLs; `sed` em `unpkg.com/@supabase/supabase-js@2` → `@2.50.3` (a versão que o `package.json` já usa) |
| 2 | **Deletar o que `docs/DEAD_CODE_REGISTER.md` já marcou como `DELETE`** | 2h | Alto (superfície pública) | `core/pages/index.html`(506), `collections_labels.html`(60), `manual-label.html`(17), `sync-cin7-cache.html`(276), `test-integration.html`(123), `test-scanner.html`(172), `replenishment-cb.css`(57), `reports/board-report-one-page.html`(0), `_transfer_out_mockup.html`(194), `rapid-express-logo.png`(219 KB não referenciado) — **~1.400 linhas + 219 KB** |
| 3 | **`defer` nos 140 `<script src>` que não são inline** | 3h | Alto (first paint) | Todos os HTML. Cuidado: os que dependem de ordem (`supabase-config.js` antes de `*.js` de feature) precisam de `defer` em **todos** para manter a ordem — `defer` preserva ordem de execução, `async` não. **Não usar `async`** |
| 4 | **Trocar `#0aa5e6` por um acento que passe AA** nos 14 arquivos que o usam | 4h | **Alto** (é o único achado de acessibilidade que reprova em botão primário) | Ver §17. 148 declarações (`#0aa5e6` 110 + `#0893cc` 38) |
| 5 | **Adicionar `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` nas 16 páginas com Google Fonts, e trocar o `@import` de `home-returns-theme.css:1` por `<link>` no `<head>` de `index.html`** | 1h | Médio | 16 HTMLs + `home-returns-theme.css` |
| 6 | **Remover Font Awesome de `collections.html` e substituir os 3 ícones por SVG inline do sprite de `index.html`** | 1h | Médio (mata 1 host CDN e ~100 KB de CSS bloqueante numa página) | `collections.html` |
| 7 | **Um `:focus-visible` global** em `styles.css` (linkado por 29 páginas) + auditar os 50 `outline:none` | 2h | **Alto** (acessibilidade de teclado sai de ~zero) | `styles.css` |
| 8 | **Consolidar os 8 `@keyframes` de spinner e as 11 funções `toast()` num `ui-feedback.js`/`ui-feedback.css`** | 1 dia | Médio | 11 arquivos JS listados em §8 |
| 9 | **Trocar os 42 `alert()` de `cyclic-count` por um toast** | 1 dia | **Alto** (é a tela de coletor) | `cyclic-count.js`(34), `cyclic-count.html`(8) — reusar o `toast()` do item 8 |
| 10 | **Carregar a webfont em `pick-anomalies.html`** (declara IBM Plex Sans e nunca a baixa) | 5 min | Baixo, mas é um bug real | `features/pick-anomalies/pick-anomalies.html` |
| 11 | **Definir `--radius-*`, `--space-*` e `--z-*` num único `tokens.css` importado antes de tudo, sem trocar valor nenhum ainda** | 1 dia | Alto (habilita todo o resto) | novo arquivo + `<link>` nas 29 páginas que já linkam `styles.css` |
| 12 | **Nomear as 4 camadas de z-index** (`--z-base:1; --z-sticky:100; --z-dropdown:200; --z-modal:1000`) e mapear os 25 valores para elas | meio dia | Médio | os 62 sites de `z-index` |
| 13 | **Colapsar 10px → 8px ou 12px** com busca-e-troca revisada tela a tela | **1 semana** | Médio | 533 declarações — ver §17, é o item mais caro da lista |

---

## 17. Colisões com o cânone

Sete decisões canônicas colidem com o que está medido aqui. Ordenadas por custo.

---

### 🔴 1. Acento `#2563eb` × `#0aa5e6` — **a colisão mais cara, e o cânone está certo**

**Medido:** `#0aa5e6` aparece **110 vezes em 14 arquivos**; com o hover `#0893cc` (38), são **148 declarações**. É o acento dos 4 `*-theme.css` e de `returns.css`, `container-check.css`, `gateway-main.css`, `label-sheets.css`, `pick-productivity.css`, `pack.css`. **`#2563eb` já existe no repo com 40 ocorrências** (em `styles.css`, `home.css`, `core/pages/index.html`) — é a cor original, que os overlays substituíram.

**O cânone rejeitou `#3b82f6` por dar 3,68:1. `#0aa5e6` dá 2,79:1** — pior. E é usado como **fundo de botão primário com texto branco** (`.rt-btn-primary`, `.chip.active`, `.filter-chip.active`, `.branch-tab.active`, `.action-btn.edit`, `.pa-top-bar`), onde 2,79 reprova até o limiar de 3:1 de componente gráfico (WCAG 1.4.11). O hover `#0893cc` (3,47) também reprova como texto.

**Não é colisão, é confirmação:** o repo migrou de uma cor que passa (`#2563eb`, 5,17) para uma que reprova (`#0aa5e6`, 2,79), e a migração está apenas 14/37 completa.

**Onde vai doer:** em 5 páginas de produção que hoje são cyan e voltariam a ser azuis — `index.html`, `restock-v2.html`, `pick-anomalies.html`, `replenishment.html`, `replenishment-branch.html`, mais `returns.html` e `container-check.html`. É a mudança visual mais perceptível de todo o plano. **Quantificado: 148 declarações, 14 arquivos, ~4h de trabalho, mas uma conversa com o usuário final.**

---

### 🔴 2. Escala de espaçamento sem degrau 10 — **533 ocorrências**

**Medido:** `10px` é o **segundo valor de espaçamento mais usado do repo** (533 ocorrências, atrás só de `8px` com 661 e à frente de `12px` com 491).

Não é o único fora da escala: `14px`(237), `2px`(189), `20px`(154), `5px`(119), `3px`(101), `18px`(88), `7px`(73), `9px`(50), `11px`(38), `15px`(32), `22px`(30), `30px`(29), `13px`(11) — **1.907 declarações fora dos degraus canônicos**, contra 2.274 dentro.

**Onde vai doer:** `10px` está no padding de praticamente todo `.chip`, `.badge` e célula de tabela do repo. Absorver 533 sites para 8 ou 12 é a única tarefa desta auditoria que não tem atalho seguro — **cada troca muda a altura de linha de uma tabela**, e as tabelas do WMS estão calibradas para caber N linhas na tela do operador. **Estimativa honesta: 1 semana, e deve ser feito tela a tela com verificação visual, nunca por `sed` global.**

Sinalização ao cânone: `6px` (462 ocorrências) e `4px` (347) estão bem servidos. O degrau 6 do cânone tem uso real aqui — bom sinal.

---

### 🟠 3. Piso de fonte 12px para Labels — **479 declarações abaixo**

**Medido:** `11px`(255) + `10px`(140) + `9px`(46) + `11.5px`(20) + `10.5px`(10) + `9.5px`(4) + `8px`(3) + `8.5px`(1) = **479 declarações abaixo de 12px**.

**Onde vai doer:** os `11px` estão majoritariamente em `thead th` (o padrão de header de tabela uppercase 11px foi copiado para os 4 overlays: `#planTable th`, `.app-table thead th`, `#restockTable thead th`, `.rt-table th`) e em badges. Subir 11→12 nesses casos é barato e melhora legibilidade. Os `9px` e `10px` estão em rótulos densos de KPI e em `features/label-sheets` (onde px vira mm na impressão — **ali o piso de 12px não se aplica e não deve ser forçado**; a régua é a legibilidade impressa, não a de tela).

**Quantificado: ~380 declarações a corrigir em tela, ~100 a preservar em contexto de impressão.**

---

### 🟠 4. Tipografia web = Inter — **colide de frente com IBM Plex**

**Medido:** **82 referências a "IBM Plex"** no repo; **16 páginas** carregam IBM Plex Sans/Mono via Google Fonts; **1 única referência a `'Inter'`** em todo o repo.

O cânone diz "App: stack do sistema (não empacota fonte)". Vale notar que **`features/wms/pwa/wms.css` já faz isso corretamente** (`--f:-apple-system,system-ui,"Segoe UI",Roboto,sans-serif`, `--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace`) — o PWA do coletor já está alinhado ao cânone. **A colisão é só nas 16 páginas web.**

**Onde vai doer:** trocar IBM Plex por Inter é mecânico (16 `<link>` + 82 declarações), mas IBM Plex Mono tem `tnum` e largura tabular usados em `.kpi-value`, `.prod-code`, `.loc-cell` — Inter tem `tnum` via `font-feature-settings`, então é equivalente. **~3h. Baixo risco, alto ruído visual.**

Sinalização: o cânone define `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` para mono. Esse stack **já aparece 3 vezes** no repo, contra 8 outras variantes mono. Nenhuma dor real aqui.

---

### 🟡 5. Borda `#e2e8f0`, aposentando `#e5e7eb` — **o cânone subestima o problema**

**Medido:** `#e2e8f0` (191) já é o vencedor. `#e5e7eb` (13) é resíduo trivial. **Mas o rival real não é `#e5e7eb`, é `#e2e7ef`** — a borda do overlay Returns, com **79 ocorrências em 11 arquivos**, mais `#d3dae6`(39) e `#eef1f6`(37) da mesma família.

`#e2e7ef` e `#e2e8f0` diferem em 1 valor no canal B. São visualmente idênticos e semanticamente rivais.

**Sinalização ao cânone:** a decisão está correta mas incompleta. **Aposentar `#e2e7ef`(79) + `#d3dae6`(39) + `#eef1f6`(37) + `#e5e7eb`(13) = 168 declarações**, não 13.

---

### 🟡 6. Tinta escura `#1b2a3f` — **10 ocorrências contra 211 de dois rivais**

**Medido:** `#1b2a3f` = **10** ocorrências. Os incumbentes: `#1a2230` (**111**, tinta do overlay Returns) e `#0f172a` (**100**, slate-900), mais `#1e293b`(65), `#1a1a1a`(60), `#334155`(32).

Todos passam AA folgado (`#1a2230` = 15,96 no branco; `#0f172a` = 17,8). **Esta é a colisão de menor consequência funcional e maior volume de edição** — 211 sites para trocar por uma cor que ninguém vai notar.

**Recomendação:** deixar esta por último. O ganho é consistência de token, não legibilidade.

---

### 🟡 7. z-index nomeado, aposentando 9999/10000/99999 — **o cânone é mais duro que a realidade**

**Medido:** `9999` existe (4 ocorrências), `10000` e `99999` **não existem** neste repo. O topo real é `9999`. Mas há **25 valores distintos** e quatro deles disputam o papel de modal (`1000`×11, `3000`×7, `2000`×6, `999`×3, `9999`×4 = 31 declarações para uma camada).

**Sinalização:** o alvo aqui não é "matar o 9999" (4 sites), é **colapsar 31 declarações de modal num único `--z-modal`** e resolver a colisão real em `z-index:100` (10 sites, disputado entre sticky header e overlay de tela).

---

### Resumo das colisões

| Decisão canônica | Sites a mudar | Onde dói mais | Custo |
|---|---:|---|---|
| Espaçamento sem degrau 10 | **533** (+1.374 outros fora da escala) | Altura de linha de tabela no WMS | **1 semana** |
| Piso 12px (Labels) | **479** (≈380 aplicáveis) | `thead th` uppercase 11px replicado em 4 overlays | 3 dias |
| Tinta `#1b2a3f` | **211** | Nenhum funcional — só consistência | 2 dias |
| Borda `#e2e8f0` | **168** (não 13) | `#e2e7ef` em 11 arquivos do overlay | 2 dias |
| Acento `#2563eb` | **148** | 5 páginas de produção mudam de cyan para azul — **mas hoje reprovam WCAG AA a 2,79:1** | 4h + conversa |
| Fonte Inter | **82** (+16 `<link>`) | Nenhum — PWA do coletor já está conforme | 3h |
| z-index nomeado | **62** (31 na camada modal) | Colisão real em `z-index:100` | 1 dia |

**Nenhuma decisão canônica é contradita pelo que medi.** A única correção a propor é de escopo: a borda a aposentar é `#e2e7ef`(79), não `#e5e7eb`(13); e o acento a aposentar é `#0aa5e6`(2,79:1), que é pior que o `#3b82f6` já rejeitado.