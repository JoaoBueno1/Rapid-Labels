# Gateway Inventory — onde paramos

Estado em 2026-08-21. Retomada rápida: leia isto + `features/gateway/README.md`.

## TL;DR

O subsistema Gateway Inventory está **construído, aplicado no banco de produção,
com o histórico da planilha importado, e commitado na `dev`**. Falta só decidir
o `git push` e testar a tela na app rodando.

## O que está FEITO e verificado

| Etapa | Estado | Evidência |
|---|---|---|
| Schema no Supabase | ✅ aplicado | 11 tabelas, 4 views, 21 funções — `npm run gateway:verify` |
| Histórico importado | ✅ batch 11 `completed` | 743 lots, 882 movements, **102.087 unidades**, 494 SKUs |
| Reconciliação vs Cin7 | ✅ calculada | 328 match · 60 mismatch · 106 só-nosso · 178 só-Cin7 |
| Resíduo de teste limpo | ✅ | verificado via REST: tudo 0, shelves 447 intactos |
| Testes | ✅ | 30/30 lógica SQL (PGlite) + 31/31 parser + 22/23 live |
| Commit na dev | ✅ | `f5208c4` (feature) + `ceca7d4` (fix paths legacy) |

## O que FALTA (retomar aqui)

1. **`git push origin dev`** — 2 commits à frente do remoto, **ainda NÃO enviados**.
   Segurei o push de propósito: havia outro chat trabalhando no mesmo repo e
   `origin/dev` não tinha avançado. Confirme que o outro chat terminou/sincronizou
   antes de enviar. Nada meu depende de push — dá pra continuar local.

2. **Abrir a tela e testar de verdade na app.** Subir o servidor e navegar:
   ```bash
   npm start           # ou: PORT=8390 node server.js
   # abrir http://localhost:8390/gateway-main.html
   ```
   Roteiro de fumaça: Overview mostra ~102k unidades → Inventory filtra/busca →
   clicar um SKU abre o drawer com lotes em ordem FIFO → criar uma transferência
   Gateway→Main de teste → imprimir a folha de picking → cancelar.

3. **Revisar as 183 import issues** na aba *Data quality* (ou
   `gateway_import_issues WHERE batch_id=11 AND resolved=false`). São as linhas
   que o importador se recusou a adivinhar — 28 erros, 155 avisos.

## Decisões que ficaram em aberto (não bloqueiam)

- **17.049 unidades / 277 pallets sem data de chegada.** Irrecuperável sem
  contagem física (a folha de papel nunca teve campo de data). Exposto
  explicitamente; FIFO trata como mais antigo.
- **178 SKUs "só no Cin7"** — o Cin7 tem no Gateway, a planilha nunca registrou
  num pallet. Ficam na reconciliação para decisão caso a caso.
- **73 SKUs não existem no `cin7_mirror`** (ex: `R3041-050 BRACKETS`, `SPIGOTS`).
  Importados como digitados; aparecem como "só nosso".
- **Import dos ~620 daily tabs históricos (2024–2026):** NÃO feito. São as folhas
  de papel (não saldos) e só 64% das linhas casam com evento do ledger. Vale para
  analytics de lane depois; não é necessário para o operacional.
- **Permissões:** não há auth na app (`docs/RUNBOOKS.md:19`). `lib/gw-permissions.js`
  nomeia as capabilities e lê `GATEWAY_ROLES` (env, opcional). Sem o env, tudo
  liberado e avisa no boot. `x-gw-user` é atribuição, não prova.

## Como reverter / re-rodar (se precisar)

```bash
# re-importar do zero
python features/gateway/import/import_gateway_history.py --rollback 11
python features/gateway/import/import_gateway_history.py --apply

# regenerar o SQL colável (se editar as migrations)
npm run gateway:bundle      # -> features/gateway/db/_apply_all.generated.sql

# testes (offline, não tocam produção)
npm run test:gateway        # 30 lógica SQL (PGlite)
npm run test:gateway:parse  # 31 parser
```

⚠️ O teste **`test:gateway:live`** escreve no banco real e deixa resíduo
`ZZ-GWTEST-` que o teardown não limpa (movements append-only). Se rodar,
depois cole `features/gateway/tests/cleanup_test_data.sql` no SQL Editor
(**sem** BEGIN/COMMIT — o editor gerencia a transação).

## Arquitetura em uma frase

Gateway é uma *location* do Cin7 sem bins, então o Cin7 só sabe o total por SKU;
este módulo é dono do resto (prateleira, pallet, data de chegada, FIFO) num
ledger append-only. Cin7 continua a verdade do total; divergência é registrada,
nunca corrigida em silêncio. **Nada escreve no Cin7** — transferências são
lançadas à mão lá e o TR é registrado de volta aqui.

## Arquivos-chave

```
features/gateway/
  db/001_gateway_inventory.sql   tabelas, constraints, RLS
  db/002_gateway_logic.sql       triggers, FIFO, RPCs transacionais, views
  db/003_gateway_import.sql      import + reconciliação RPCs
  db/apply.py                    --bundle (SQL colável) / --verify
  import/import_gateway_history.py   planilha -> lots (idempotente)
  gateway-inventory-engine.js    /api/gateway/*
  lib/gw-permissions.js          capabilities (sem auth real ainda)
  legacy/                        engine antigo, DESLIGADO (GATEWAY_LEGACY_ENABLED)
  tests/                         PGlite + parser + live + cleanup.sql
gateway-main.{html,js,css}       a tela (6 abas)
```
