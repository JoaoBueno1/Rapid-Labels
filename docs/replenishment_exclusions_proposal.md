# Replenishment — proposed exclusions (Sydney audit, 2026-05-13)

Lista pronta pra aplicar no `features/replenishment/replenishment-config.js` quando aprovado. Nada foi alterado ainda.

## 1. Per-metre regex (15 SKUs em Sydney + futuros)

Adicionar em `EXCLUDED_NAME_PATTERNS`:

```js
const EXCLUDED_NAME_PATTERNS = [
  /\bcarton\b/i,              // já existe
  /[-_ ]carton\d+/i,          // já existe
  // NEW — per-metre products (LED strips, fairy lights):
  /\bper\s+\d+\s*m\b/i,       // "per 1m", "per 10m", "per 1M"
  /\bper\s*metre\b/i,
  /\bper\s*meter\b/i,
  /\/\s*m\b/i,                // "/m"
];
```

**Captura confirmada (Sydney avg > 0):**

| SKU | avg/mês | Nome |
|---|---|---|
| R8101 | 48 | 1.5w 12v DC LED Fairy Lights, IP66 2400K, per 1m |
| R2333-WW | 17 | 7w 24V LED Strip Light, IP20, 3000K WW, per 1m |
| R2332-CW | 10 | 9.6W 24V 8mm LED Strip Light, IP20, 4000K CW, per 1m |
| R2360-WW | 9 | 5w 24V COB LED Strip Light, IP65, 3000K WW, per 1m * |
| R2341-WW | 8 | 10w 24V COB LED Strip Light, IP20, 3000K WW, per 1M |
| R2323-WW | 7 | 6w 24V Neo Slim LED Strip Light, IP65, 3000K WW, per 1M * |
| R2340-WW | 5 | 5w 24V COB LED Strip Light, IP20, 3000K WW, per 1m * |
| R2340-WW-V2 | 5 | 5w 24V 8mm COB LED Strip Light, IP20, 3000K WW, per 1m |
| R2360-CW | 4 | 5w 24V COB LED Strip Light, IP65, 4000K CW, per 1M * |
| R2323-CW | 2 | 6w 24V Neo Slim LED Strip Light, IP65, 4000K CW, per 1m * |
| R2352-WW | 2 | 9.6W 24V LED Strip Light, IP65, 3000K WW, per 1m * |
| R2332-DL | 1 | 9.6W 24V LED Strip Light, IP20, 5000K DL, per 1m |
| R2334-CW | 1 | 14.4W 24V LED Strip Light, IP20, 4000K, per 1M |
| R2351-WW | 1 | 4.8W 24V LED Strip Light, IP65, 3000K WW, per 1m |
| R2352-BL | 1 | 9.6W 24V LED Strip Light, IP65, Blue, per 1m |

Observação: `R2340-WW` e `R2340-WW-V2` aparecem aqui (per-metre) — vão sair pela regex sem precisar de SKU explícita.

---

## 2. Lista SKU explícita (legacy versions, 17 SKUs)

Adicionar ao config:

```js
// Legacy SKUs replaced by newer revisions. Confirmed via side-by-side
// comparison with successor (name, status, modified date, stock).
const EXCLUDED_SKUS = new Set([
  // -V1 (V1 is the old version, base sem suffix is the new):
  'R-GPO2-WH-V1',
  'R-SW1-WH-V1',
  'R-SW2-WH-V1',
  'R-GPO1-WH-V1',
  'R1076-WH-12W-CW-60-V1',
  'R9995-V1',
  'R9998-V1',
  // -V2 que são velhos (sucessor sem suffix existe):
  'R-SMI10-V2',
  'R-TVPAL-F-V2',
  'R1160-WH-V2',

  // Bases que são velhos (-V2 é o redesign 8mm/anti-corrosivo, mantém):
  // (3 destes já estão flagados Deprecated no Cin7)
  'R2340-WW-10',     // deprecated; V2 8mm é o atual
  'R2332-WW-10',     // deprecated; V2 8mm é o atual
  'R2360-WW-10',     // deprecated; V2 8mm é o atual
  'R2352-CW-10',     // V2 8mm é o redesign
  'R2360-CW-10',     // V2 8mm é o redesign
  'R2332-WW-15',     // V2 8mm é o redesign
  // R2340-WW omitido — já sai pelo regex per-metre

  // R6071-BK-CW / R6071-BK-CW-V2 — DECIDIDO manter os dois (anti-corrosive
  // é produto distinto, não substituto).
]);
```

**Verificação caso a caso** (15 SKUs explícitos, V1):

### V1 antigos (sucessor confirmado sem suffix)

| Excluir | Sucessor | Sydney avg | Justificativa |
|---|---|---|---|
| R-GPO2-WH-V1 | R-GPO2-WH | 17 | Power point novo sem V1 ativo |
| R-SW1-WH-V1 | R-SW1-WH | 17 | 1 Gang Wall Switch novo |
| R-SW2-WH-V1 | R-SW2-WH | 17 | 2 Gang Wall Switch novo |
| R-GPO1-WH-V1 | R-GPO1-WH | 3 | 10A Single Powerpoint |
| R1076-WH-12W-CW-60-V1 | R1076-WH-CW-60 | 2 | Exemplo dado pelo João |
| R9995-V1 | R9995 | 1 | LED Exit Fitting Box-W |
| R9998-V1 | R9998 | 1 | LED Exit Fitting Box |

### V2 antigos (sucessor sem suffix existe e é o atual)

| Excluir | Sucessor | Sydney avg | Justificativa |
|---|---|---|---|
| R-SMI10-V2 | R-SMI10 | 1 | 10A Intermediate mech |
| R-TVPAL-F-V2 | R-TVPAL-F | 8 | PAL-F TV Mechanism |
| R1160-WH-V2 | R1160-WH-CW/WW | 7 | Surface Mount Downlight CCT split |

### Bases substituídos por V2 (V2 é o novo, base é o velho)

| Excluir (base) | Sucessor (V2) | Sydney avg | Sinal |
|---|---|---|---|
| R2340-WW-10 | R2340-WW-10-V2 | 0 (base) / 4 (V2) | Base **Deprecated** no Cin7. V2 é o novo 8mm. |
| R2332-WW-10 | R2332-WW-10-V2 | 0 / 1 | Base **Deprecated**. V2 8mm atual. |
| R2360-WW-10 | R2360-WW-10-V2 | 0 / 1 | Base **Deprecated**. V2 8mm atual. |
| R2352-CW-10 | R2352-CW-10-V2 | 0 / 3 | V2 modificado depois (2026-05-07 vs 2026-04-16), nome "8mm" |
| R2360-CW-10 | R2360-CW-10-V2 | 0 / 2 | V2 nome "8mm". Sydney só consome V2. |
| R2332-WW-15 | R2332-WW-15-V2 | 0 / 2 | V2 modificado depois, V2 stock 97 vs base 2, V2 8mm |

### Decidido manter

- **R6071-BK-CW** + **R6071-BK-CW-V2**: ambos ativos, V2 tem "anti corrosive" — é produto distinto, não substituto.

---

## 3. Impacto

| Métrica | Atual | Após exclusão |
|---|---|---|
| Sydney SKUs com avg > 0 | 723 | 723 − 15 (per-metre) − 17 (explicit) = **691** |
| Unidades a enviar | (sujeito a recompute) | redução estimada modesta (esses SKUs costumam ter qty baixa) |

A regra é **global** (catalog-level) — outras branches herdam automaticamente quando ativarmos.

---

## 4. Quando aplicar

Quando você aprovar, eu:
1. Edito `features/replenishment/replenishment-config.js` adicionando `EXCLUDED_NAME_PATTERNS` extras + `EXCLUDED_SKUS` set
2. Atualizo `isExcludedProduct(productCode)` pra checar ambos
3. Bump cache version
4. Rodo verify script pra confirmar que esses SKUs somem do plano de Sydney

Me dá o sinal verde e eu aplico.
