# Container List Builder — avaliação para decisão

**Estado:** avaliação + protótipo provado. **Não implementado.** Decidir depois.
**Data:** 2026-08-21 · **Autor da análise:** Joao (+ Claude)

Leitura de 5 min pra decidir se vale construir, e por qual caminho. O protótipo
que embasa isto está no apêndice no fim deste documento (rodou de verdade contra o Cin7).

---

## O problema, em uma frase

Hoje alguém monta **à mão, numa planilha**, a "Container List - Warehouse"
(o `Shipment Report`) juntando os packing lists de ~15–20 fornecedores por
navio — traduzindo códigos, convertendo metros em peças, e conferindo linha a
linha. É lento, depende de 1–2 pessoas, e erra em silêncio.

```
PO no Cin7 → fornecedor manda packing list (PDF/scan) →
  [MONTAGEM MANUAL DA LISTA]  ← o gargalo →
container chega → Container Check (QC) → stock entra
```

## Por que é difícil (medido, não achismo)

1. **Cada fornecedor, um formato.** Em 6 páginas de um scan real vi **5 layouts
   radicalmente diferentes**: retrato limpo (Aeon), girado 90° (Ehome/Senselite),
   com fotos (CNEPSO), colunas e nomes distintos, alguns com o Rapid code, outros
   com código próprio + Rapid code **escrito à mão**.
2. **O dado de embalagem não está no Cin7.** Só **33%** dos 8.521 produtos ativos
   têm `carton_quantity`; ICL 32%, dimensões 36%, **peso 6%**. Ou seja: a
   informação de "quantos por carton / por pallet" **vive no packing list**, não
   no ERP — por isso vocês dependem dele.
3. **Striplights em metros.** Extrusões/reels (`R2382-AL-2M`, `SOF1129C-1.2M`,
   "Reel 2216 10M") precisam virar peças pro time do container.
4. **Carton misto** — um carton com vários SKUs (acessórios, free parts, samples).
5. **Multi-PO / multi-fornecedor por navio** — um navio junta vários pedidos.

## O que o protótipo PROVOU (com dado real, ao vivo)

3 fornecedores, 3 formatos, cruzados contra o **PO real do Cin7**:

| Prova | Resultado |
|---|---|
| Layout heterogéneo → 1 estrutura | Aeon + Senselite + CNEPSO normalizados igual |
| Tradução de código automática | `SOF1129C-1.2M-40W→R3580-V2`, `FJQC01→RQC`, `MIS220→R-WPI220` |
| Validação vs PO | **CNEPSO 9/9 exato**; pegou `RSS4` pedido mas não embarcado |
| Detecção de short-ship | `R3579-V2`: veio **264 de 384** (o fornecedor mandou menos) |
| Metros → peças | `R3580-V2` 1002 pç × 1,2m = **1.202 m lineares** |
| Consolidação por navio | `MSC Sanya`: 11 SKUs · 34.618 pç · 382 ctns (2 fornecedores juntos) |

**15 linhas conferidas sozinho · 19 divergências marcadas** — o que hoje são os
checkmarks à mão.

### Bônus que ninguém pediu
A validação contra o PO entrega de graça: **saldo aberto do PO** (o que ainda
falta receber, container a container) e **detecção automática de short-ship** —
o erro que custa dinheiro e que só pega quem confere à mão.

## Nossos dados **ou** IA? — os dois, em camadas

Não é escolha. É pipeline:

1. **Cin7 PO (determinístico)** = a âncora e o validador. ~100% dos POs lá.
2. **IA multimodal** = extrai do PDF heterogéneo o que o Cin7 não tem.
3. **Regras (código)** = m→pcs, carton→pallet, consolidação por navio.

IA **sozinha** é perigosa (OCR erra número → estoque errado). Por isso a validação
contra o PO é obrigatória: todo número que não bate é sinalizado. Nossos dados
**sozinhos** não geram a lista (só 33% de cobertura). Juntos: a IA extrai, o PO valida.

**Por que IA e não parser por fornecedor:** seriam N parsers frágeis que quebram
quando o fornecedor muda o Excel. 5 formatos em 6 páginas provam. LLM generaliza
sem parser por fornecedor e lê scan girado e manuscrito.

## O que empresas grandes fazem

| Abordagem | Cabe no Rapid? |
|---|---|
| **EDI / ASN (mensagem 856)** — arquivo estruturado do fornecedor | ❌ Fornecedor pequeno chinês não tem EDI |
| **Template único de fornecedor** (Excel padrão obrigatório) | 🟡 Sim pros maiores; não resolve manuscrito |
| **IDP — Intelligent Document Processing** (Rossum/Docsumo/Google/Azure Document AI, ou LLM) | ✅ É o padrão pro "long tail" que manda PDF |
| Terceirizar pro despachante | ❌ Perde controle; dado não entra no ERP |

## Opções para o Rapid

**A — Manter como está.** Custo hoje baixo, custo acumulado alto: horas manuais
recorrentes, risco de erro (m→pcs, código trocado), conhecimento em 1–2 cabeças.

**B — Padronizar a entrada.** Um template Excel único pros 3–4 maiores. Quase
custo zero. Reduz o problema; não resolve scan manuscrito nem quem não adere.
**Dá pra fazer já, em paralelo a qualquer coisa.**

**C — Container List Builder com IA + validação vs PO (recomendado, faseado).**
Página no Rapid Labels (mesma stack de Gateway/Container Check): sobe o PDF → IA
extrai → casa com o PO do Cin7 → aplica regras → gera a Container List + export.
Humano revisa só o que a IA marcou como incerto (parte de ~90% pronto).
**Subproduto:** cada extração alimenta o cadastro (carton_qty/dims/peso que
faltam), o que destrava o Container Builder 3D, o Gateway e cálculo de frete.

## Custos e riscos (honesto)

**Custos**
- **IA por documento:** ~US$0,01–0,05/página. Se são ~50–100 packing lists/mês
  (~300–500 páginas), dá **~US$5–25/mês** de API. Trivial.
- **Build do MVP:** feature de médio porte (escopo ~ Container Check). O custo
  real é o desenvolvimento, não o rodar.
- **Manutenção:** baixa — sem parser por fornecedor pra manter.

**Riscos e mitigação**
- IA erra número em scan ruim → **validação vs PO** é a rede de segurança.
- Código novo de fornecedor sem mapa → humano na 1ª vez, o dicionário aprende.
- Carton misto → o schema precisa modelar `1 carton → N SKUs`.
- m→pcs → **tabela de conversão por família**, definida uma vez por vocês.
- Dependência de API externa → custo recorrente + fallback se a API cair.

## O que NÃO fazer agora

Não investir no `features/container-builder` (bin-packing 3D). Depende de
dimensões (36% de cobertura) e resolve o *empilhamento*, que **não é o gargalo**.
O gargalo é a **ingestão/consolidação**. Priorizar o 3D agora = resolver o
problema errado. (Ele fica mais fácil depois, quando a Opção C alimentar as
dimensões no cadastro.)

## Recomendação em uma linha

**Fazer B já** (template pros maiores, custo ~zero) **e planejar o MVP da C**
(IA + validação vs PO) como próxima feature — o protótipo mostrou que os 4 pontos
difíceis têm solução, e o bônus (saldo de PO + short-ship + alimentar o cadastro)
paga o investimento em mais de um lugar.

---

## Apêndice — o protótipo (rodou de verdade contra o Cin7)

A extração foi feita por um modelo multimodal lendo as imagens dos PDFs
(`~/Downloads/21082026140041-0001.pdf`); os POs vieram ao vivo do Cin7. Num
sistema real, a extração seria uma chamada de API por documento. Código guardado
aqui para reprodutibilidade.

<details>
<summary>poc_container_list.py — clique para expandir</summary>

```python
# -*- coding: utf-8 -*-
"""
PoC — Container List Builder: packing list (PDF) -> extração -> validação vs PO Cin7 -> lista.

A EXTRAÇÃO abaixo foi produzida por um modelo multimodal (Claude) lendo as MESMAS
imagens renderizadas dos PDFs do scan (scan_p1..p6.png). Num sistema real seria
uma chamada de API por documento. Aqui está hard-coded para provar o pipeline
end-to-end contra os POs REAIS do Cin7 (po_15144/14965/15167.json, puxados ao vivo).

Mostra 3 fornecedores / 3 formatos radicalmente diferentes, todos normalizados
para a mesma estrutura, e a validação automática contra o pedido.
"""
import json, os, re, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
SCR = os.path.dirname(os.path.abspath(__file__))

# ─────────────────────────────────────────────────────────────────────────────
# 1. EXTRAÇÃO — o que o "LLM" leu de cada packing list, normalizado num só schema.
#    Repare como 3 layouts diferentes viram a MESMA estrutura.
# ─────────────────────────────────────────────────────────────────────────────
EXTRACTION = [
  { "file": "scan_p1 (Aeon)", "supplier": "Aeon Technology", "vessel": "MSC Sanya",
    "invoice": "AIT261222", "po": "PO-15144", "layout": "retrato, CODE=Rapid direto",
    "lines": [
      {"supplier_code": "R3540-TRI",    "rapid_code": "R3540-TRI",    "qty_pcs": 102, "ctns": 17, "units_per_ctn": 6,  "dims": "130*28.5*27.5"},
      {"supplier_code": "R3540-EM-TRI", "rapid_code": "R3540-EM-TRI", "qty_pcs": 576, "ctns": 96, "units_per_ctn": 6,  "dims": "130*28.5*27.5"},
    ]},
  { "file": "scan_p3 (Senselite)", "supplier": "NINGBO SENSELITE", "vessel": "MSC Glitter",
    "invoice": "S26Y026-3", "po": "PO-14965", "layout": "girado 90°, Client Code + Item NO, inner/outer",
    "lines": [
      # Item NO do fornecedor traz o comprimento do batten: 1.2M / 0.6M (linear!)
      {"supplier_code": "SOF1129C-1.2M-40W", "rapid_code": "R3580-V2", "qty_pcs": 1002, "ctns": 167, "units_per_ctn": 6, "linear_m_per_unit": 1.2},
      {"supplier_code": "SOF1129C-0.6M-20W", "rapid_code": "R3579-V2", "qty_pcs": 264,  "ctns": 44,  "units_per_ctn": 6, "linear_m_per_unit": 0.6},
      {"supplier_code": "SCL319-8W-CCT",     "rapid_code": "R1060-WH-TRI", "qty_pcs": 3600, "ctns": 75, "units_per_ctn": 48},
      {"supplier_code": "SCL270-8W",         "rapid_code": "R1053-WH-TRI", "qty_pcs": 3600, "ctns": 90, "units_per_ctn": 40},
    ]},
  { "file": "scan_p4 (CNEPSO)", "supplier": "NINGBO CNEPSO", "vessel": "MSC Sanya",
    "invoice": "—", "po": "PO-15167", "layout": "fotos, Factory Code + RAPIDLED Code",
    "lines": [
      {"supplier_code": "FJQC01",      "rapid_code": "RQC",           "qty_pcs": 19200, "ctns": 96,  "units_per_ctn": 200},
      {"supplier_code": "FJTP01",      "rapid_code": "RSS",           "qty_pcs": 12000, "ctns": 120, "units_per_ctn": 100},
      {"supplier_code": "Y135-COOKER", "rapid_code": "R-SM35-COOKER", "qty_pcs": 200,   "ctns": 1,   "units_per_ctn": 200},
      {"supplier_code": "M001",        "rapid_code": "R-VMB",         "qty_pcs": 1000,  "ctns": 5,   "units_per_ctn": 200},
      {"supplier_code": "SWPS110",     "rapid_code": "R-WPGPO1",      "qty_pcs": 300,   "ctns": 6,   "units_per_ctn": 50},
      {"supplier_code": "SWPS215",     "rapid_code": "R-WPGPO2-15",   "qty_pcs": 120,   "ctns": 3,   "units_per_ctn": 40},
      {"supplier_code": "SWPS210S-WN", "rapid_code": "R-WPGPO2X",     "qty_pcs": 120,   "ctns": 3,   "units_per_ctn": 40},
      {"supplier_code": "MIS220",      "rapid_code": "R-WPI220",      "qty_pcs": 500,   "ctns": 10,  "units_per_ctn": 50},
      {"supplier_code": "MIF1-235",    "rapid_code": "R-WPI235-L",    "qty_pcs": 500,   "ctns": 25,  "units_per_ctn": 20},
    ]},
]

PO_FILES = {"PO-15144": "po_15144.json", "PO-14965": "po_14965.json", "PO-15167": "po_15167.json"}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Carregar os POs reais do Cin7 (o "esperado")
# ─────────────────────────────────────────────────────────────────────────────
def load_po(path):
    d = json.load(open(os.path.join(SCR, path), encoding="utf8"))
    o = d.get("Order") if isinstance(d, dict) else None
    lines = (o.get("Lines") if isinstance(o, dict) else None) or (d.get("Lines") if isinstance(d, dict) else None) or []
    out = {}
    for ln in lines:
        sku = (ln.get("SKU") or "").strip()
        if sku:
            out[sku] = out.get(sku, 0) + float(ln.get("Quantity") or 0)
    return out

PO = {po: load_po(f) for po, f in PO_FILES.items()}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Normalização de código + match contra o PO
# ─────────────────────────────────────────────────────────────────────────────
def resolve(rapid_code, po_skus):
    """Casa o código do packing list com o SKU do PO. Exato -> sem sufixo -V1/-V2 -> None."""
    if rapid_code in po_skus:
        return rapid_code, "exato"
    base = re.sub(r"-V\d+$", "", rapid_code)
    for sku in po_skus:
        if re.sub(r"-V\d+$", "", sku) == base:
            return sku, f"variante ({rapid_code}→{sku})"
    return None, "sem correspondência no PO"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Rodar o pipeline
# ─────────────────────────────────────────────────────────────────────────────
print("═"*100)
print("  PoC — Packing list heterogéneo  →  extração  →  validação contra PO Cin7 (ao vivo)")
print("═"*100)

container_list = []   # a Container List consolidada
flags = []            # divergências para revisão humana

for doc in EXTRACTION:
    po_skus = PO.get(doc["po"], {})
    print(f"\n▶ {doc['file']}   navio={doc['vessel']}   {doc['po']}   [{doc['layout']}]")
    print(f"  {'RAPID CODE':16} {'código forn.':16} {'PL pcs':>7} {'PO pcs':>7} {'ctns':>5} {'u/ctn':>6}  situação")
    print("  " + "─"*94)
    shipped_skus = set()
    for ln in doc["lines"]:
        sku, how = resolve(ln["rapid_code"], po_skus)
        po_qty = po_skus.get(sku) if sku else None
        shipped_skus.add(sku)
        # validação
        if po_qty is None:
            status = "⚠ NÃO está no PO"
            flags.append(f"{doc['po']}: {ln['rapid_code']} veio mas não está no pedido")
        elif abs(ln["qty_pcs"] - po_qty) < 0.5:
            status = "✓ bate"
        elif ln["qty_pcs"] < po_qty:
            status = f"⚠ PARCIAL faltam {int(po_qty-ln['qty_pcs'])}"
            flags.append(f"{doc['po']}: {sku} embarcou {ln['qty_pcs']} de {int(po_qty)} (faltam {int(po_qty-ln['qty_pcs'])})")
        else:
            status = f"⚠ EXCESSO +{int(ln['qty_pcs']-po_qty)}"
            flags.append(f"{doc['po']}: {sku} embarcou {ln['qty_pcs']}, pedido era {int(po_qty)}")
        # regra striplight (linear): mostra metros lineares equivalentes
        extra = ""
        if ln.get("linear_m_per_unit"):
            extra = f"  [strip {ln['linear_m_per_unit']}m/pç → {int(ln['qty_pcs']*ln['linear_m_per_unit'])}m lineares]"
        print(f"  {ln['rapid_code']:16} {ln['supplier_code']:16} {ln['qty_pcs']:>7} "
              f"{('' if po_qty is None else int(po_qty)):>7} {ln['ctns']:>5} {ln['units_per_ctn']:>6}  {status}{extra}")
        container_list.append({
            "vessel": doc["vessel"], "supplier": doc["supplier"], "po": doc["po"],
            "rapid_code": (sku or ln["rapid_code"]), "qty_pcs": ln["qty_pcs"],
            "ctns": ln["ctns"], "units_per_ctn": ln["units_per_ctn"],
            "match": how, "po_qty": po_qty,
        })
    # itens no PO que NÃO vieram neste container
    for sku, q in po_skus.items():
        base_shipped = {re.sub(r"-V\d+$","",s) for s in shipped_skus if s}
        if sku not in shipped_skus and re.sub(r"-V\d+$","",sku) not in base_shipped:
            print(f"  {sku:16} {'—':16} {'—':>7} {int(q):>7} {'—':>5} {'—':>6}  ⚠ pedido, NÃO neste navio")
            flags.append(f"{doc['po']}: {sku} ({int(q)} pç) está no pedido mas não veio neste container")

# ─────────────────────────────────────────────────────────────────────────────
# 5. Container List consolidada (agrupada por navio) + resumo de validação
# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "═"*100)
print("  CONTAINER LIST consolidada (o que iria pro time do container)")
print("═"*100)
by_vessel = {}
for r in container_list:
    by_vessel.setdefault(r["vessel"], []).append(r)
for vessel, rows in by_vessel.items():
    tot_pcs = sum(r["qty_pcs"] for r in rows); tot_ctn = sum(r["ctns"] for r in rows)
    print(f"\n  🚢 {vessel}   —   {len(rows)} SKUs · {tot_pcs:,} pcs · {tot_ctn} cartons")
    print(f"     {'RAPID CODE':16} {'fornecedor':18} {'PO':10} {'pcs':>7} {'cartons':>8}")
    for r in sorted(rows, key=lambda x: x["rapid_code"]):
        print(f"     {r['rapid_code']:16} {r['supplier'][:18]:18} {r['po']:10} {r['qty_pcs']:>7} {r['ctns']:>8}")

print("\n" + "═"*100)
print(f"  VALIDAÇÃO — {len(flags)} divergência(s) que o sistema pegou sozinho (hoje = conferência à mão):")
print("═"*100)
for f in flags:
    print("  •", f)
print(f"\n  Linhas conferidas automaticamente: {sum(len(d['lines']) for d in EXTRACTION)}"
      f"  ·  divergências marcadas p/ humano: {len(flags)}")
```

</details>
