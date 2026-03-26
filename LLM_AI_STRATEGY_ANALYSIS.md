# Análise Estratégica: LLM & AI no Ecossistema Rapid Express + Rapid Labels

> Documento criado: 26 Mar 2026  
> Última atualização: 26 Mar 2026  
> Objetivo: Análise profunda de como LLMs (Claude API / Anthropic) podem transformar cada sistema do ecossistema, gerando vantagem competitiva real.  
> Princípio: **Regras + SQL + Solver como base. LLM como copiloto. ML depois.**

---

## ÍNDICE

1. [Entendendo a API do Claude (Anthropic)](#1-entendendo-a-api-do-claude-anthropic)
2. [Mapa do Ecossistema](#2-mapa-do-ecossistema)
3. [Rapid Labels — Oportunidades de IA](#3-rapid-labels--oportunidades-de-ia)
4. [Rapid Express Web — Oportunidades de IA](#4-rapid-express-web--oportunidades-de-ia)
5. [Rapid Express Hub — Oportunidades de IA](#5-rapid-express-hub--oportunidades-de-ia)
6. [Rapid Express App (Mobile) — Oportunidades de IA](#6-rapid-express-app-mobile--oportunidades-de-ia)
7. [Oportunidades Cross-System](#7-oportunidades-cross-system)
8. [Implementação Prática — Como Usar a API](#8-implementação-prática--como-usar-a-api)
9. [Roadmap de Prioridades](#9-roadmap-de-prioridades)
10. [Custos Estimados](#10-custos-estimados)
11. [Diferencial Competitivo Real](#11-diferencial-competitivo-real)
12. [Filosofia de Arquitetura — LLM como Copiloto](#12-filosofia-de-arquitetura--llm-como-copiloto)
13. [Analytics — Estado Atual e Estratégia](#13-analytics--estado-atual-e-estratégia)
14. [Comparação de Providers — Claude vs OpenAI vs Alternativas](#14-comparação-de-providers--claude-vs-openai-vs-alternativas)
15. [Onde NÃO Usar LLM — Limites Claros](#15-onde-não-usar-llm--limites-claros)
16. [Mapa de Decisão: Regra vs LLM vs ML vs Solver](#16-mapa-de-decisão-regra-vs-llm-vs-ml-vs-solver)

---

## 1. Entendendo a API do Claude (Anthropic)

### O que é um LLM?
Um Large Language Model (LLM) como o Claude é uma IA que entende e gera texto. Mas vai muito além de "chatbot" — ele pode:
- **Analisar dados** e encontrar padrões que humanos não veriam
- **Gerar código/queries** a partir de linguagem natural
- **Classificar e categorizar** automaticamente (intenções, prioridades, anomalias)
- **Extrair informação** de texto não-estruturado (emails, PDFs, comentários)
- **Tomar decisões** com explicações (recomendações com justificativa)
- **Gerar resumos** de grandes volumes de dados
- **Multi-modal**: analisar imagens (fotos POD, etiquetas danificadas)

### Como funciona a API do Claude?

```javascript
// Instalação
// npm install @anthropic-ai/sdk

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY  // Chave da API
});

// Chamada básica
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",  // Modelo (sonnet = rápido+barato, opus = máximo)
  max_tokens: 4096,
  system: "Você é um assistente de warehouse especializado em logística.",
  messages: [
    { role: "user", content: "Analise esses dados de stock e sugira reabastecimento..." }
  ]
});

console.log(response.content[0].text);
```

### Modelos disponíveis:

| Modelo | Velocidade | Custo | Melhor para |
|--------|-----------|-------|-------------|
| **claude-sonnet-4-20250514** | Rápido (~2s) | ~$3/1M tokens input, $15/1M output | 90% dos casos — chat, análise, classificação |
| **Claude Opus** | Lento (~8s) | ~$15/1M input, $75/1M output | Análises profundas, decisões complexas |
| **Claude Haiku** | Ultra-rápido (~0.5s) | ~$0.25/1M input, $1.25/1M output | Classificação, extração simples, alto volume |

### Conceitos-chave:

- **System Prompt**: Instrução que define o "papel" da IA. Ex: "Você é um analista de warehouse da Rapid Express na Austrália"
- **Context Window**: Quantidade de texto que a IA "vê" por vez (~200K tokens = ~150K palavras)
- **Structured Output**: Pedir resposta em JSON para integração automática
- **Tool Use (Function Calling)**: IA pode chamar funções do seu sistema (ex: consultar DB)
- **Streaming**: Respostas em tempo real (palavra por palavra) para melhor UX
- **Vision**: Enviar imagens junto com texto para análise visual

---

## 2. Mapa do Ecossistema

```
┌─────────────────────────────────────────────────────────────┐
│                    ECOSSISTEMA RAPID                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ RAPID LABELS │  │ RAPID EXPRESS│  │ RAPID EXPRESS    │  │
│  │  (WMS Lite)  │  │   WEB (Flask)│  │   HUB (Next.js) │  │
│  │              │  │              │  │                  │  │
│  │ • Etiquetas  │  │ • Pedidos    │  │ • Multi-carrier  │  │
│  │ • Restock    │  │ • Dispatch   │  │ • Booking        │  │
│  │ • Anomalias  │  │ • Tracking   │  │ • Cotações       │  │
│  │ • Gateway    │  │ • Carriers   │  │ • Management     │  │
│  │ • Collections│  │ • Monitoring │  │ • Integrations   │  │
│  │ • Replenish  │  │ • Fleet      │  │ • SSO            │  │
│  │ • Cyclic     │  │ • Reports    │  │ • PostCode AI    │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                    │            │
│         └──────────────────┼────────────────────┘            │
│                            │                                 │
│                    ┌───────▼────────┐                       │
│                    │ RAPID EXPRESS  │                       │
│                    │   APP (Mobile) │                       │
│                    │                │                       │
│                    │ • Driver runs  │                       │
│                    │ • POD capture  │                       │
│                    │ • GPS tracking │                       │
│                    │ • Load check   │                       │
│                    │ • Notifications│                       │
│                    └────────────────┘                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              SERVIÇOS COMPARTILHADOS                  │   │
│  │  • Supabase (PostgreSQL + Storage + Auth)             │   │
│  │  • Cin7 Core ERP (Inventário + Vendas)                │   │
│  │  • Google Maps API (Directions + Geocoding)           │   │
│  │  • Carriers (Phoenix, Direct Freight, AusPost, etc.)  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Rapid Labels — Oportunidades de IA

### 3.1 🔥 AI Warehouse Assistant (Prioridade MÁXIMA)

**O que faz**: Chat com linguagem natural que consulta dados reais do warehouse.

**Por que é revolucionário**: O gestor de warehouse não precisa navegar 10 páginas diferentes. Ele pergunta e recebe a resposta instantaneamente com dados reais.

**Exemplos de perguntas que a IA responderia**:
- "Quais SKUs vão acabar nos próximos 3 dias?"
- "Qual produto teve mais anomalias de pick este mês?"
- "Qual shelf do gateway tem itens parados há mais de 60 dias?"
- "Compare eficiência de picking desta semana vs semana passada"
- "Quanto stock da filial Melbourne precisa ser reposto?"
- "Qual o produto mais vendido que não está no pickface?"

**Implementação técnica (Tool Use)**:
```javascript
// O segredo: Use "Tool Use" do Claude para ele consultar suas próprias tabelas
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  system: `Você é o assistente de warehouse da Rapid LED/Express na Austrália.
    Você tem acesso a funções para consultar dados em tempo real.
    Sempre use dados reais antes de responder. Nunca invente números.
    Responda de forma concisa, com tabelas quando apropriado.`,
  tools: [
    {
      name: "query_stock",
      description: "Consulta stock atual por SKU, location ou bin",
      input_schema: {
        type: "object",
        properties: {
          sku: { type: "string" },
          location: { type: "string" },
          low_stock_only: { type: "boolean" }
        }
      }
    },
    {
      name: "query_anomalies",
      description: "Consulta anomalias de pick por período",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "number" },
          sku: { type: "string" }
        }
      }
    },
    {
      name: "query_gateway",
      description: "Consulta alocações do gateway (shelf map)",
      input_schema: { /* ... */ }
    },
    {
      name: "query_sales",
      description: "Consulta médias de vendas por filial/produto",
      input_schema: { /* ... */ }
    },
    {
      name: "query_restock",
      description: "Consulta status de reabastecimento do pickface",
      input_schema: { /* ... */ }
    }
  ],
  messages: [{ role: "user", content: userQuestion }]
});

// Quando Claude decide usar uma tool, você executa a query no Supabase
// e devolve o resultado para ele formular a resposta final
```

**Valor competitivo**: Nenhum WMS concorrente de pequeno/médio porte tem isso. É o tipo de feature que impressiona em demo e gera retenção.

---

### 3.2 🔥 Previsão de Demanda Inteligente

**O que faz**: Analisa histórico de vendas + sazonalidade + tendências e prevê demanda futura.

**Dados disponíveis**:
- `branch_avg_monthly_sales` — médias mensais por filial
- `cin7_mirror.stock_snapshot` — stock atual
- `stock_snapshot_lines` — snapshots históricos

**Como a IA agrega valor vs análise manual**:
```
ANTES (humano):
  - Olha planilha → "Brisbane vendeu 50 un. mês passado"
  - Decisão: "Manda 50 de novo"

DEPOIS (com IA):
  - IA vê: "Brisbane vendeu 50 em Jan, 45 em Fev, 60 em Mar"
  - IA detecta: "Tendência de alta (+10%/mês), próximo mês ~66 un."
  - IA cruza: "Main Warehouse tem apenas 80 un., 
    se mandar 66 para Brisbane, fica com 14 — ABAIXO do mínimo de 8 semanas"
  - IA sugere: "Envie 50 un. para Brisbane e faça PO de 200 un. ao fornecedor"
```

**Implementação**:
```javascript
const prompt = `Analise esses dados de vendas e stock. Gere previsão para as próximas 4 semanas.
Responda em JSON com este formato:
{
  "forecasts": [{ "sku": "...", "predicted_weekly": [...], "confidence": "high|medium|low", "risk": "..." }],
  "alerts": ["..."],
  "recommendations": ["..."]
}

Dados de vendas (últimos 6 meses): ${JSON.stringify(salesData)}
Stock atual: ${JSON.stringify(stockData)}
Configuração de pickface: ${JSON.stringify(restockSetup)}`;
```

---

### 3.3 🔥 Análise Inteligente de Anomalias de Pick

**O que faz**: Em vez de só mostrar "Fulano pegou do bin errado", a IA explica POR QUÊ.

**O que a IA pode detectar que humanos não veem**:
- **Padrão de picker**: "José errou 8x esta semana, sempre nos bins B3-B5 → possível confusão de layout"
- **Padrão de tempo**: "Anomalias aumentam 70% depois das 15h → fadiga?"
- **Padrão de produto**: "SKU FAN-001 tem 40% de anomalia → label do bin pode estar errada"
- **Correlação oculta**: "Bins vizinhos ao B7 (onde está SKU-POPULAR) têm 3x mais erro → tráfego gera confusão"

**Implementação**:
```javascript
const analysis = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  system: "Analise anomalias de picking de warehouse. Identifique root causes, padrões e sugira correções concretas.",
  messages: [{
    role: "user",
    content: `Anomalias dos últimos 30 dias:
${JSON.stringify(anomalies)}

Dados de cada picker:
${JSON.stringify(pickerStats)}

Layout de bins:
${JSON.stringify(binLayout)}

Identifique:
1. Padrões por picker (quem erra mais e por quê)
2. Padrões por produto (quais SKUs são mais confundidos)
3. Padrões temporais (horário/dia da semana)
4. Root causes prováveis
5. Ações corretivas priorizadas`
  }]
});
```

---

### 3.4 📋 Daily AI Briefing (Dashboard Inteligente)

**O que faz**: Todo dia, ao abrir o dashboard, um resumo gerado por IA aparece:

> "Bom dia! Resumo de hoje:
> - **12 SKUs precisam restock** (3 críticos: FAN-001, LED-STRIP-5M, DRIVER-48W)
> - **Pick Accuracy** esta semana: 94.2% (↑ 1.8% vs semana passada)
> - **Gateway**: 4 itens parados >60 dias — considere transferir de volta
> - **Brisbane** está com apenas 2 semanas de stock de ceiling fans
> - **Tendência**: Vendas de LED strips subiram 25% — antecipar PO"

**Custo**: ~$0.01 por briefing (1x/dia) = ~$0.30/mês

---

### 3.5 🏗️ Otimizador de Layout de Warehouse

**O que faz**: IA cruza dados de frequência de pick + localização dos bins + distância da zona de despacho e sugere reorganização.

**Dados para alimentar**:
- Pick frequency por SKU (de `pick_anomaly_orders`)
- Localização atual dos bins (de `cin7_mirror.stock_snapshot`)
- Médias de venda (de `branch_avg_monthly_sales`)
- Configuração de pickface (de `restock_setup`)

**Valor**: Reorganizar o warehouse para que os 20% de produtos mais vendidos estejam nos bins mais acessíveis pode **reduzir tempo de pick em 30-40%**.

---

### 3.6 🔄 Auto-Replenishment Inteligente

**Evolução do módulo de Branch Replenishment atual**:
- Hoje: target fixo de 5 semanas, mínimo Main de 8 semanas
- Com IA: targets dinâmicos baseados em velocidade de venda, sazonalidade, lead time do fornecedor
- IA sugere: "Melbourne precisa de 200 un. de FAN-001, mas o fornecedor leva 3 semanas para entregar. Faça PO AGORA."

---

### 3.7 📸 Scanner Inteligente de Labels (Vision)

**O que faz**: Motorista/operador fotografa uma etiqueta danificada ou ilegível, e a IA (Vision) lê o barcode/texto e identifica o produto.

```javascript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
      { type: "text", text: "Identifique o SKU, barcode e descrição do produto nesta etiqueta de warehouse." }
    ]
  }]
});
```

---

## 4. Rapid Express Web — Oportunidades de IA

### 4.1 🔥 Dispatch Center Inteligente (GAME CHANGER)

**Problema atual**: O dispatcher organiza runs manualmente, decide quais pedidos vão para qual motorista, e a otimização de rota é post-hoc (depois de atribuir).

**Com IA**:
```
ANTES: Dispatcher gasta 30-60 min organizando 80 pedidos em 6 runs
DEPOIS: IA organiza em 30 segundos com justificativa

IA analisa:
- Endereços de entrega (clusters geográficos)
- Capacidade dos veículos (van vs ute vs truck)
- Janelas de horário dos clientes
- Histórico de performance de cada motorista
- Restrições de peso/volume
- Prioridade dos pedidos (urgent, same-day, next-day)
```

**Implementação** — Claude como "Dispatch Brain":
```javascript
const dispatchPlan = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  system: `Você é o cérebro de despacho da Rapid Express.
    Brisbane/Gold Coast, Austrália. Horário AEST.
    Otimize atribuição de pedidos a motoristas minimizando:
    1. Distância total percorrida
    2. Tempo total de cada run
    3. Desbalanceamento entre motoristas
    Respeite restrições de veículo e horário.`,
  messages: [{
    role: "user",
    content: `
Pedidos pendentes (${orders.length}):
${JSON.stringify(orders.map(o => ({ id: o.tracking_id, suburb: o.suburb, postcode: o.postcode, 
  cartons: o.cartons, pallets: o.pallets, priority: o.priority })))}

Motoristas disponíveis:
${JSON.stringify(drivers.map(d => ({ name: d.name, vehicle: d.vehicle_type, 
  capacity: d.max_weight, branch: d.branch })))}

Branches (pontos de partida):
${JSON.stringify(branches)}

Gere plano em JSON:
{
  "runs": [{ 
    "driver": "...", "stops": ["tracking_id_1", ...], 
    "estimated_km": N, "estimated_hours": N,
    "reasoning": "..." 
  }],
  "unassigned": ["tracking_id_x"],
  "warnings": ["..."]
}`
  }]
});
```

**Valor**: Redução de 30-60 min de trabalho manual do dispatcher para 30 segundos + rotas mais eficientes.

---

### 4.2 🔥 Auto-Classificação e Seleção de Carrier

**Problema atual**: O sistema tem 6 carriers integrados, mas a seleção é semi-manual.

**Com IA**:
```javascript
// IA analisa cada pedido e recomenda o melhor carrier com justificativa
const recommendation = await client.messages.create({
  model: "claude-haiku-3-20241022",  // Haiku: rápido e barato para classificação
  system: `Selecione o melhor carrier para cada envio baseado em:
    - Área de cobertura (suburb/postcode)
    - Custo (quotações reais)
    - Tipo de carga (cartons vs pallets)
    - SLA de entrega
    - Histórico de performance do carrier nessa área
    - Se é entrega interna (Rapid Express fleet) ou terceirizada`,
  messages: [{ role: "user", content: JSON.stringify(orderDetails) }]
});
```

---

### 4.3 🔥 Análise Preditiva de Atrasos

**O que faz**: IA analisa padrões históricos e prevê quais entregas têm risco de atraso ANTES de saírem.

**Dados disponíveis**:
- `tracking_updates` — histórico de status
- `driver_stop_performance` — tempo por parada
- `driver_run_summary` — KMs e duração por run
- `driver_location_history` — GPS histórico

**O que a IA faz**:
- "Run 045 tem 18 paradas em 6h — 3 deles são pallets em subúrbios distantes. Probabilidade de atraso: 72%. Sugestão: mover 3 paradas para run do dia seguinte."
- "Driver João tem médiana de 8 min/parada em Brisbane CBD vs 4 min em subúrbios. Hoje tem 12 paradas CBD — adicionar 48 min extra ao ETA."

---

### 4.4 🔥 Validação Inteligente de POD (Vision)

**Problema atual**: Fotos de POD (Proof of Delivery) são armazenadas mas nunca validadas. O motorista pode tirar foto do chão e o sistema aceita.

**Com IA Vision**:
```javascript
const validation = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: podPhotoBase64 } },
      { type: "text", text: `Valide esta foto de Proof of Delivery:
        - A foto mostra pacotes/caixas entregues?
        - Está em uma porta/entrada? 
        - A foto é clara o suficiente para servir como prova?
        - Há algum problema visível (embalagem danificada, local impróprio)?
        Responda em JSON: { "valid": bool, "confidence": 0-100, "issues": [], "description": "..." }` }
    ]
  }]
});
```

**Valor competitivo**: Reduz disputas com clientes, aumenta confiança na prova de entrega.

---

### 4.5 📊 Relatórios em Linguagem Natural

**O que faz**: Em vez de gráficos estáticos, o gestor pede:
- "Me dê um relatório de eficiência de motoristas desta semana"
- "Compare custos de carriers no último trimestre"
- "Quais clientes mais cancelam pedidos?"

**A IA gera**: Texto narrativo + dados tabulares + insights + recomendações.

---

### 4.6 🤖 Chatbot de Tracking para Clientes

**Problema atual**: A página de tracking público (`/track/<id>`) mostra status, mas o cliente não pode perguntar nada.

**Com IA**:
```
Cliente: "Onde está meu pedido RE0001085201?"
IA: "Seu pedido está em rota de entrega. O motorista está atualmente 
     a 3 paradas do seu endereço. Estimativa de chegada: 14:30 AEST."

Cliente: "Posso mudar o endereço?"
IA: "Para alterar o endereço, preciso transferir você para o suporte. 
     Deseja que eu inicie o contato via email? [Sim] [Não]"
```

---

### 4.7 📧 Geração Inteligente de Notificações

**Problema atual**: Templates de SMS/email são fixos com placeholders.

**Com IA**: Notificações personalizadas por contexto:
```
Pedido normal: "Olá Maria, seu pedido será entregue hoje entre 14h-15h."
Pedido atrasado: "Olá Maria, pedimos desculpa pelo atraso. Seu pedido chegará 
                  em aproximadamente 30 minutos. Agradecemos sua paciência."
Tentativa falha: "Olá Maria, tentamos entregar mas não havia ninguém. 
                  Podemos agendar nova entrega? Responda com o melhor horário."
```

---

## 5. Rapid Express Hub — Oportunidades de IA

### 5.1 🔥 Smart Quote Recommendation

**Evolução do Quote Engine atual**:
- Hoje: busca cotações em paralelo, marca cheapest/fastest
- Com IA: "A Direct Freight é $2 mais cara que Phoenix para esse subúrbio, MAS tem 99% de SLA vs 87% — recomendo Direct Freight para esse cliente VIP"

---

### 5.2 🔥 PostCode Recommender Turbinado

**Já existe um PostCode Recommender com Gemini**. Com Claude:
- Análise mais profunda de padrões de demanda
- Sugestões de expansão de cobertura com projeção de receita
- "Se você adicionar postcodes 4300-4310, pode capturar ~15 entregas/semana (baseado em pedidos recusados por falta de cobertura)"

---

### 5.3 📋 Onboarding Inteligente de Carriers

**O que faz**: Quando uma nova transportadora é adicionada, a IA gera guia de configuração, sugere areas de serviço, e valida credenciais automaticamente.

---

### 5.4 🔍 Reconciliação Financeira Assistida

**O que faz**: IA cruza faturas de carriers com dados internos e destaca discrepâncias:
- "Direct Freight cobrou $45 por consignment DF12345, mas nossa cotação era $38. Diferença de peso? Verificar."
- "6 envios do mês passado não aparecem na fatura da Phoenix. Possível perda de $178."

---

## 6. Rapid Express App (Mobile) — Oportunidades de IA

### 6.1 🔥 Assistente do Motorista (Voice/Chat)

**O que faz**: Motorista tem acesso a um assistente de voz/chat no app:

- "Qual o melhor caminho agora considerando o trânsito?"
- "O cliente não está em casa, o que faço?"
- "Onde deixo 3 pallets se o portão está trancado?"

**Implementação**: IA com contexto do run atual + regras da empresa + histórico de entregas no endereço.

---

### 6.2 📸 Scan Inteligente de Parcelas

**Problema atual**: Se o barcode está danificado, o motorista digita manualmente (erro-prone).

**Com Claude Vision**: Motorista tira foto → IA identifica o pacote pela etiqueta mesmo parcialmente danificada, cruzando com banco de dados de pedidos do run.

---

### 6.3 🗺️ Reordenação Inteligente Mid-Run

**Problema atual**: Se um cliente cancela ou um novo pedido aparece mid-run, o motorista reordena manualmente.

**Com IA**: "Stop #7 cancelado e 2 novos stops adicionados. Recalculei: mova Stop #12 para posição #8 (fica no caminho) e os novos stops ficam em #10 e #11. Economiza 12 min e 8 km."

---

### 6.4 📝 Notas de Entrega Inteligentes

**O que faz**: Motorista dita por voz, IA transcreve e estrutura:
- Motorista: "Deixei na porta lateral, portão verde, vizinho assinou"
- IA gera: `{ "location": "porta lateral", "landmark": "portão verde", "signed_by": "vizinho", "atl": true }`

---

## 7. Oportunidades Cross-System (O MAIOR DIFERENCIAL)

### 7.1 🔥🔥🔥 "AI Operations Center" — Hub Central de IA

**Conceito**: Um único painel de IA que conecta TODOS os 4 sistemas:

```
┌─────────────────────────────────────────────────┐
│           AI OPERATIONS CENTER                    │
│                                                   │
│  "Stock de FAN-001 crítico → 3 pedidos hoje →    │
│   Brisbane sem stock → Sugiro:                    │
│   1. Transferir 50 un. do Gateway (Shelf C4)      │
│   2. Enviar 30 un. para Brisbane via Direct       │
│      Freight (cotação: $89, chega em 2 dias)      │
│   3. Criar PO no Cin7 para 200 un.                │
│   4. Os 3 pedidos de hoje: entregar via Phoenix   │
│      (motorista João está na área, run 045)"      │
│                                                   │
│  [Executar Plano] [Ajustar] [Ignorar]            │
└─────────────────────────────────────────────────┘
```

**Isso é o GAME CHANGER**: IA que vê warehouse + delivery + stock + drivers + carriers simultaneamente e toma decisões holísticas que nenhum humano faria tão rápido.

---

### 7.2 🔥 Feedback Loop Warehouse ↔ Delivery

**Exemplo real**:
1. Pick Anomalies detecta que bin B7 tem 40% de erro
2. Deliveries mostram que 3 entregas desta semana tiveram produto errado (reclamação do cliente)
3. IA correlaciona: "Erro no bin B7 → produto errado entregue → 3 devoluções = $245 em custo"
4. IA sugere: "Relabelar bin B7, mover SKU-SIMILAR para corredor diferente, alertar picker"

---

### 7.3 🔥 Predictive Supply Chain

**Fluxo end-to-end com IA**:
```
IA detecta: Vendas de LED strips +25% (Rapid Labels)
    ↓
IA prevê: Stock vai acabar em 12 dias (Cin7 data)
    ↓
IA calcula: Brisbane precisa de 80 un., Melbourne 60, Sydney 45
    ↓
IA gera: Transfer plan otimizado (Rapid Labels → Replenishment)
    ↓
IA seleciona: Direct Freight para Melbourne ($45), Phoenix para Brisbane ($28)
    ↓
IA agenda: Pickup para amanhã 9h, run integrado com entregas existentes
    ↓
IA notifica: Motorista João recebe o run com as transferências incluídas
```

**Nenhum concorrente faz isso**. Nem grandes players como StarTrack ou Toll integram warehouse + delivery + forecasting em IA.

---

### 7.4 📊 Executive Dashboard com IA

**O que faz**: CEO/diretor recebe relatório semanal 100% gerado por IA:

```
📊 RELATÓRIO SEMANAL — Rapid Express (17-23 Mar 2026)

ENTREGAS: 847 pedidos (+12% vs sem. anterior)
  ✅ Entregues: 812 (95.9% — meta: 95%)
  ❌ Cancelados: 21
  ↩️ Devoluções: 14

WAREHOUSE:
  📦 Pick Accuracy: 96.1% (↑ 2.3%)
  🔄 Restock feitos: 34 SKUs
  ⚠️ 5 SKUs em risco de ruptura

FINANCEIRO:
  💰 Receita: $28,450
  📉 Custo médio/entrega: $8.92 (↓ 3.1%)
  🏆 Melhor carrier: Phoenix ($7.20/envio médio)

INSIGHTS:
  💡 Gold Coast teve 40% mais volume — considere adicionar motorista
  💡 Cliente "ABC Lighting" cancelou 8 pedidos — possível insatisfação
  💡 Domingo: 0 entregas — oportunidade para entregas premium?

RECOMENDAÇÕES:
  1. Adicionar motorista para Gold Coast (ROI estimado: $3,200/mês)
  2. Contatar ABC Lighting proativamente
  3. Testar entregas Sunday Premium ($15 extra)
```

---

## 8. Implementação Prática — Como Usar a API

### 8.1 Setup Básico (Node.js — para Rapid Labels)

```bash
npm install @anthropic-ai/sdk
```

```javascript
// ai-service.js
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ====== TOOL USE: IA consulta dados sob demanda ======
async function aiChat(userMessage, conversationHistory = []) {
  
  const tools = [
    {
      name: "query_stock_levels",
      description: "Busca níveis de stock por SKU ou bin location. Retorna lista de produtos com quantity, bin, warehouse.",
      input_schema: {
        type: "object",
        properties: {
          sku_filter: { type: "string", description: "Filtrar por SKU (contém)" },
          low_stock_only: { type: "boolean", description: "Só retornar itens com stock abaixo do pickface capacity" },
          location: { type: "string", description: "Filtrar por warehouse location" }
        }
      }
    },
    {
      name: "query_pick_anomalies",
      description: "Busca anomalias de pick. Retorna pedidos onde picker pegou do bin errado.",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Últimos N dias (default: 7)" },
          sku: { type: "string", description: "Filtrar por SKU específico" }
        }
      }
    },
    {
      name: "query_gateway_shelves",
      description: "Busca itens nas shelves do Gateway com FIFO tracking.",
      input_schema: {
        type: "object",
        properties: {
          shelf: { type: "string", description: "Filtrar por shelf (A-G)" },
          aged_days: { type: "number", description: "Só itens parados há mais de N dias" }
        }
      }
    },
    {
      name: "query_branch_sales",
      description: "Busca médias de vendas mensais por produto e filial.",
      input_schema: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Ex: Sydney, Melbourne, Brisbane" },
          sku: { type: "string" }
        }
      }
    },
    {
      name: "query_restock_status",
      description: "Busca status de reabastecimento do pickface (LOW/MEDIUM/FULL/OVER).",
      input_schema: {
        type: "object",
        properties: {
          status_filter: { type: "string", description: "Filtrar por status: LOW, MEDIUM, FULL, OVER, NOT_CONFIGURED" }
        }
      }
    }
  ];

  let messages = [
    ...conversationHistory,
    { role: "user", content: userMessage }
  ];

  // Loop de tool use — IA pode fazer múltiplas consultas
  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: `Você é o AI Warehouse Assistant da Rapid LED / Rapid Express.
Warehouse principal: Main Warehouse em Brisbane, Austrália.
7 filiais: Sydney, Melbourne, Brisbane, Cairns, Coffs Harbour, Hobart, Sunshine Coast.
Sistema ERP: Cin7 Core. Dados sincronizados a cada 10 minutos.
Sempre consulte dados reais antes de responder. Nunca invente números.
Formate respostas com Markdown. Use tabelas quando houver dados tabulares.
Seja conciso mas completo. Priorize insights acionáveis.`,
      tools,
      messages
    });

    // Se a IA quer usar uma tool
    if (response.stop_reason === 'tool_use') {
      const toolUse = response.content.find(c => c.type === 'tool_use');
      const toolResult = await executeToolQuery(toolUse.name, toolUse.input);
      
      messages.push({ role: "assistant", content: response.content });
      messages.push({ 
        role: "user", 
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }]
      });
      continue; // IA pode querer fazer mais consultas
    }

    // Resposta final
    return response.content[0].text;
  }
}

// Executa query no Supabase baseado na tool
async function executeToolQuery(toolName, input) {
  switch (toolName) {
    case 'query_stock_levels': {
      let query = supabase.from('cin7_mirror.stock_snapshot').select('*');
      if (input.sku_filter) query = query.ilike('product_code', `%${input.sku_filter}%`);
      if (input.location) query = query.eq('location', input.location);
      const { data } = await query.limit(100);
      return data;
    }
    case 'query_pick_anomalies': {
      const days = input.days || 7;
      const since = new Date(Date.now() - days * 86400000).toISOString();
      let query = supabase.from('pick_anomaly_orders').select('*').gte('created_at', since);
      if (input.sku) query = query.contains('picks', JSON.stringify([{ sku: input.sku }]));
      const { data } = await query.limit(200);
      return data;
    }
    case 'query_gateway_shelves': {
      let query = supabase.from('gateway_allocations').select('*, gateway_shelves(name)');
      if (input.shelf) query = query.eq('gateway_shelves.name', input.shelf);
      if (input.aged_days) {
        const since = new Date(Date.now() - input.aged_days * 86400000).toISOString();
        query = query.lte('created_at', since);
      }
      const { data } = await query;
      return data;
    }
    // ... outros cases
  }
}

module.exports = { aiChat };
```

### 8.2 Route no Express (Rapid Labels)

```javascript
// No server.js, adicionar:
const { aiChat } = require('./ai-service');

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    const response = await aiChat(message, history || []);
    res.json({ response });
  } catch (error) {
    console.error('AI Chat error:', error);
    res.status(500).json({ error: 'Erro ao processar sua pergunta' });
  }
});
```

### 8.3 Setup para Python/Flask (Rapid Express Web)

```bash
pip install anthropic
```

```python
# ai_service.py
import anthropic
import json
from datetime import datetime, timedelta

client = anthropic.Anthropic(api_key=os.environ['ANTHROPIC_API_KEY'])

def ai_dispatch_optimizer(orders, drivers, branches):
    """IA otimiza atribuição de pedidos a motoristas."""
    
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8192,
        system="""Você é o otimizador de despacho da Rapid Express, Brisbane, Austrália.
Atribua pedidos a motoristas minimizando distância total e tempo.
Considere: clusters geográficos, capacidade de veículo, prioridade.
Responda APENAS em JSON válido.""",
        messages=[{
            "role": "user",
            "content": f"""
Pedidos ({len(orders)}):
{json.dumps([{
    'id': o.tracking_id, 'suburb': o.suburb, 'postcode': o.postcode,
    'lat': o.latitude, 'lng': o.longitude,
    'cartons': o.cartons, 'pallets': o.pallets,
    'priority': o.priority or 'normal'
} for o in orders], indent=2)}

Motoristas ({len(drivers)}):
{json.dumps([{
    'id': d.id, 'name': d.name, 'vehicle': d.vehicle_type,
    'branch': d.branch.name if d.branch else 'HQ'
} for d in drivers], indent=2)}

Gere plano otimizado em JSON."""
        }]
    )
    
    return json.loads(response.content[0].text)


def ai_validate_pod(photo_base64, order_details):
    """IA valida foto de Proof of Delivery."""
    
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": photo_base64
                    }
                },
                {
                    "type": "text",
                    "text": f"""Valide esta Proof of Delivery.
Pedido: {order_details['tracking_id']}
Endereço: {order_details['address']}
Parcelas esperadas: {order_details['cartons']} cartons, {order_details['pallets']} pallets

Análise:
1. A foto mostra pacotes/caixas entregues? (S/N)
2. Está em uma porta/entrada? (S/N)
3. Número de volumes visíveis corresponde ao esperado?
4. Há danos visíveis?
5. Qualidade da foto é aceitável como prova?

JSON: {{"valid": bool, "confidence": 0-100, "volumes_visible": N, "issues": [], "summary": "..."}}"""
                }
            ]
        }]
    )
    
    return json.loads(response.content[0].text)
```

### 8.4 Streaming para UX responsiva

```javascript
// Frontend — streaming para resposta em tempo real no chat
async function streamAIResponse(message) {
  const response = await fetch('/api/ai/chat-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    fullText += chunk;
    updateChatUI(fullText); // Atualiza UI em tempo real
  }
}

// Backend — streaming endpoint
app.post('/api/ai/chat-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Transfer-Encoding', 'chunked');

  const stream = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    stream: true,
    // ... system + messages
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      res.write(event.delta.text);
    }
  }
  res.end();
});
```

---

## 9. Roadmap de Prioridades

### FASE 1 — Quick Wins (1-2 semanas cada)
| # | Feature | Sistema | Impacto | Custo/mês |
|---|---------|---------|---------|-----------|
| 1 | **Daily AI Briefing** | Rapid Labels | Alto | ~$1 |
| 2 | **Anomaly Root Cause** | Rapid Labels | Alto | ~$5 |
| 3 | **Smart Notifications** | Rapid Express Web | Médio | ~$2 |
| 4 | **Executive Weekly Report** | Cross-System | Alto | ~$0.50 |

### FASE 2 — Core Features (2-4 semanas cada)
| # | Feature | Sistema | Impacto | Custo/mês |
|---|---------|---------|---------|-----------|
| 5 | **AI Warehouse Assistant** | Rapid Labels | Muito Alto | ~$15 |
| 6 | **Dispatch Optimizer** | Rapid Express Web | Muito Alto | ~$20 |
| 7 | **POD Validation (Vision)** | Rapid Express Web/App | Alto | ~$30 |
| 8 | **Demand Forecasting** | Rapid Labels | Alto | ~$5 |

### FASE 3 — Advanced (4-8 semanas cada)
| # | Feature | Sistema | Impacto | Custo/mês |
|---|---------|---------|---------|-----------|
| 9 | **AI Operations Center** | Cross-System | Transformacional | ~$50 |
| 10 | **Carrier Auto-Select com IA** | Hub | Alto | ~$10 |
| 11 | **Layout Optimizer** | Rapid Labels | Médio | ~$3 |
| 12 | **Driver Assistant** | Rapid Express App | Médio | ~$15 |
| 13 | **Customer Tracking Chatbot** | Rapid Express Web | Médio | ~$10 |

---

## 10. Custos Estimados

### Modelo de preço da Anthropic (Mar 2026):

| Uso | Modelo | Tokens/mês | Custo estimado |
|-----|--------|-----------|----------------|
| Daily Briefing (1x/dia) | Sonnet | ~50K | **$0.50** |
| Weekly Report | Sonnet | ~100K | **$0.50** |
| AI Chat (50 perguntas/dia) | Sonnet | ~2M | **$15** |
| Dispatch Optimizer (1x/dia) | Sonnet | ~500K | **$5** |
| POD Validation (100/dia) | Sonnet | ~5M | **$30** |
| Anomaly Analysis | Sonnet | ~200K | **$3** |
| Demand Forecast (semanal) | Sonnet | ~300K | **$2** |
| **TOTAL ESTIMADO** | | | **~$56/mês** |

**Contexto de custo**: O sistema Rapid Express Web custa ~$50/mês no Render. A IA custaria ~$56/mês — **APROXIMADAMENTE O MESMO**. É baratíssimo pelo valor que gera.

### Comparação com alternativas:
- **Contratar analista de dados humano**: ~$5,000-8,000/mês
- **Software de BI Enterprise (Tableau/PowerBI)**: ~$500-2,000/mês
- **Claude API para tudo isso**: ~$56/mês

---

## 11. Diferencial Competitivo REAL

### O que nenhum concorrente tem:

| Capacidade | Concorrentes | Rapid Express + IA |
|-----------|-------------|-------------------|
| Dispatch | Manual ou regras fixas | IA otimiza com contexto completo |
| Carrier Selection | Cheapest wins | IA pondera preço + SLA + histórico |
| POD | Aceita qualquer foto | IA valida em tempo real |
| Stock Forecasting | Planilhas Excel | IA com previsão e alertas |
| Pick Quality | Detecta erro | IA explica causa raiz + previne |
| Reporting | Gráficos estáticos | IA gera narrativa e recomendações |
| Customer Communication | Templates fixos | IA personaliza por contexto |
| Cross-system Intelligence | Siloed | IA vê warehouse + delivery + fleet |

### A verdadeira vantagem:

> **Concorrentes tratam warehouse e delivery como sistemas separados.**
> **Vocês terão IA que vê TODO o fluxo: stock → pick → dispatch → delivery → POD → feedback.**
> 
> Isso permite decisões que são IMPOSSÍVEIS em sistemas isolados:
> - "Não envie para Brisbane via Direct Freight" (porque a IA sabe que o stock do produto está acabando E o fornecedor leva 3 semanas)
> - "Mude o motorista do run 045" (porque a IA sabe que ele tem 30% mais cancelamentos nessa área E tem outro motorista livre que conhece a região)
> - "Reposicione SKU-X no bin A1" (porque a IA sabe que é o produto mais vendido E tem 40% de anomalia de pick no bin atual)

### Por que Claude especificamente?

1. **200K context window** — pode analisar centenas de pedidos de uma vez
2. **Tool Use** — IA consulta suas próprias tabelas em tempo real
3. **Vision** — analisa fotos POD, etiquetas, recibos
4. **Streaming** — respostas em tempo real para chat
5. **Structured Output** — respostas em JSON para integração automática
6. **Consistência** — respostas confiáveis e reproduzíveis
7. **Preço** — ~$56/mês para uso enterprise real

---

## 12. Filosofia de Arquitetura — LLM como Copiloto

### Princípio Fundamental

> **Regras + SQL + Engine de otimização como BASE do sistema.**
> **LLM como COPILOTO para explicação, resumo, classificação e interface em linguagem natural.**
> **ML clássico DEPOIS, para previsão e risco, quando os dados estiverem limpos.**

Ou seja: **sim para IA, mas não para substituir a lógica central.**

### Por que essa separação é crucial

Uma LLM é **probabilística** — ela pode gerar respostas "bonitas, bem escritas, mas erradas". Para decisões operacionais críticas (transferência de stock, reorder, mudança de rota), isso é um risco inaceitável.

A lógica determinística (regras, SQL, cálculos) é **100% reproduzível e auditável**. Quando alguém pergunta "por que o sistema mandou 50 unidades para Brisbane?", a resposta é um cálculo exato, não uma inferência.

### O que já funciona com regras (NÃO substituir por LLM)

| Sistema | Lógica Atual | Motor |
|---------|-------------|--------|
| **Restock** | pickface capacity, LOW/MEDIUM/FULL/OVER, weeks-of-stock | Regra + SQL |
| **Branch Replenishment** | target 5 semanas, mínimo Main 8 semanas | Regra + SQL |
| **Pick Anomalies** | comparação PickedFromBin vs stock_locator | Regra |
| **Gateway FIFO** | alertas >30d, >60d, >90d | Regra + SQL |
| **Pricing** | $10.70 primeira caixa, $5.35 adicional, $66.50 pallet | Regra fixa |
| **Dispatch routing** | Google Directions + greedy nearest-neighbor | Solver + API |
| **Quote Engine** | cotações paralelas, cheapest/fastest tagging | Regra + API |
| **Carrier selection** | coverage por suburb/postcode | Regra + DB |
| **Tracking lifecycle** | pending → created → manifested → delivered | State machine |

**Tudo isso deve CONTINUAR como regra. A LLM entra como camada de inteligência POR CIMA.**

### Diagrama de camadas

```
┌──────────────────────────────────────────────────────────┐
│  CAMADA 3 — LLM (Copiloto)                                │
│  • Chat em linguagem natural                               │
│  • Explicação de decisões ("por que este alerta?")         │
│  • Resumos e briefings diários                              │
│  • Classificação semântica (motivos, exceções)             │
│  • Geração de relatórios narrativos                         │
│  • Validação visual (fotos POD via Vision)                  │
│  • Comunicação personalizada com cliente                    │
├──────────────────────────────────────────────────────────┤
│  CAMADA 2 — Regras + SQL + Solver (Cérebro)                │
│  • Cálculo de restock (pickface capacity)                   │
│  • Transfer plans (target semanas × avg vendas)             │
│  • Detecção de anomalias (bin comparison)                   │
│  • Pricing determinístico                                    │
│  • State machine de pedidos                                  │
│  • Otimização de rota (Google Directions / OR-Tools)        │
│  • Cotações de carriers (APIs reais)                        │
├──────────────────────────────────────────────────────────┤
│  CAMADA 1 — Dados (Fundação)                               │
│  • Supabase PostgreSQL                                       │
│  • Cin7 Core ERP (sync a cada 10 min)                       │
│  • Google Maps API                                           │
│  • Carrier APIs (Phoenix, Direct Freight, etc.)             │
└──────────────────────────────────────────────────────────┘
```

### Onde a LLM agrega valor REAL (copiloto)

#### No Restock (Rapid Labels)
- ❌ NÃO: decidir quantidade a transferir (regra faz melhor)
- ✅ SIM: "explica por que esse SKU entrou em alerta"
- ✅ SIM: "resume os 20 itens mais críticos de hoje"
- ✅ SIM: "gera comentário automático para o supervisor"
- ✅ SIM: "quais SKUs estão abaixo do mínimo em PICKFACE e de onde reabastecer?"

#### No Delivery (Rapid Express Web)
- ❌ NÃO: montar rota principal (Google Directions / OR-Tools)
- ❌ NÃO: decidir melhor ordem de paradas (solver determinístico)
- ✅ SIM: copiloto do dispatcher ("quais runs mais arriscados hoje?")
- ✅ SIM: classificar motivos de falha de entrega
- ✅ SIM: sugerir resposta para cliente
- ✅ SIM: transformar notas soltas em status limpo
- ✅ SIM: análise pós-operação ("por que ontem atrasou tanto?")
- ✅ SIM: validar fotos POD (Vision)
- ✅ SIM: resumir observações do motorista

### Exceção importante: Tool Use muda o jogo

A análise conservadora assume que LLM = "gerador de texto probabilístico". Mas o **Tool Use do Claude** muda fundamentalmente isso:

```
SEM Tool Use:
  User: "Quanto stock tem de FAN-001?"
  LLM: "Baseado no que sei, deve ter uns 50..." ← INVENTOU

COM Tool Use:
  User: "Quanto stock tem de FAN-001?"
  LLM: [chama query_stock_levels(sku='FAN-001')] → Supabase retorna 47
  LLM: "Existem 47 unidades de FAN-001 no Main Warehouse." ← DADO REAL
```

Com Tool Use, a LLM não "inventa" — ela **consulta dados reais e formula resposta baseada neles**. Isso elimina o risco de "erro bonito" para queries de consulta.

---

## 13. Analytics — Estado Atual e Estratégia

### 13.1 O que existe HOJE

#### Página de Analytics (Graphs.html) — PLACEHOLDER

No Rapid Express Web existe a página `/graphs` que é um **placeholder para Power BI**:

```html
<!-- templates/Graphs.html -->
{% extends 'base.html' %}
{% block title %}Analytics{% endblock %}

<!-- Container preparado para embed de Power BI -->
<div id="powerbi-container">
  <p>Power BI Dashboard Integration</p>
  <p>This area is prepared to embed your Power BI dashboard</p>
  <!-- <iframe src="YOUR_POWER_BI_EMBED_URL_HERE" ...></iframe> -->
</div>

<!-- Selector por empresa -->
<select onchange="changeDashboard(this.value)">
  <option>All Companies</option>
  <option>Endless Summer</option>
  <option>Rapid Brisbane</option>
  <option>Rapid Gold Coast</option>
</select>
```

**Status**: 100% placeholder. Iframe nunca conectado. Funções `changeDashboard()` e `refreshDashboard()` vazias.

#### Carrier Reports (Parcialmente Implementado)

| Endpoint | Status | O que faz |
|----------|--------|----------|
| `GET /api/v1/carriers/reports/summary` | ✅ Implementado | Performance summary por carrier |
| `GET /api/v1/carriers/reports/cost-comparison` | ✅ Implementado | Comparação de custos entre carriers |
| `GET /api/v1/carriers/reports/sla` | ✅ Implementado | Relatório SLA/on-time delivery |
| `POST /api/v1/carriers/auto-select` | 🟡 Parcial | Seleção automática de carrier |

Tabelas no banco: `carrier_performance`, `carrier_webhooks_log`, `carrier_selection_rules`

Template: `templates/carrier_reports.html`

#### Management Reports

| Endpoint | Status | O que faz |
|----------|--------|----------|
| `GET /api/reports/daily` | ✅ Implementado | Relatório diário |
| `GET /api/reports/driver-efficiency` | ✅ Implementado | Eficiência de motoristas |
| `GET /api/reports/trends` | ✅ Implementado | Tendências |

Template: `templates/management_reports.html`

#### Driver Monitoring Analytics (Parcialmente Implementado)

| Feature | Status |
|---------|--------|
| Live tracking no mapa | ✅ Funciona (quando há dados de GPS) |
| Performance por parada | ✅ Implementado |
| Alertas de idle/stationary | ✅ Implementado |
| Heatmaps de zonas problemáticas | 🔴 Planejado, não implementado |
| Driver scoring automático | 🔴 Planejado, não implementado |
| Route replay animado | 🔴 Planejado, não implementado |
| Reports tab | 🔴 Endpoint não existe |
| Compliance tab (TAP scans) | 🔴 Endpoint não existe |

#### Home Dashboard KPIs (Implementado)

| Endpoint | O que retorna |
|----------|---------------|
| `GET /api/home/today-stats` | Pedidos hoje, entregues, cancelados |
| `GET /api/home/kpis` | KPIs gerenciados |
| `GET /api/home/performance-chart` | Gráfico de performance |

Mas tudo é **dados crus, sem análise interpretativa**.

### 13.2 Ferramentas já mencionadas nos docs

| Ferramenta | Status | Onde mencionada | Custo |
|------------|--------|-----------------|-------|
| **Power BI** | 🔴 Placeholder (iframe vazio) | Graphs.html | ~$10/user/mês |
| **Google Vision API** | 🔴 Planejada para POD | IMPROVEMENT_ROADMAP Phase 2.4 | ~$1.50/1000 imgs |
| **AWS Rekognition** | 🔴 Alternativa à Google Vision | IMPROVEMENT_ROADMAP Phase 2.4 | ~$1/1000 imgs |
| **Chart.js** | 🟡 Planejado para gráficos | Driver Monitor, Performance | Free |
| **Google Maps** | ✅ Integrado | dispatch_center, driver_monitoring | $7/1000 req |
| **SendGrid** | ✅ Integrado | Email, notificações | Free tier |
| **Sentry** | ✅ Integrado | Crash reporting + performance | $26/mês |
| **ML Models** | 🔴 Futuro (Phase 4) | IMPROVEMENT_ROADMAP | - |

### 13.3 Estratégia: 3 Caminhos para Analytics

#### Caminho A: Power BI (Ferramenta externa embutida)
- **Prós**: Dashboards visuais profissionais, drag-and-drop, sem código
- **Contras**: Custo mensal per-user, dados duplicados, zero insights automáticos, ferramenta separada
- **Custo**: ~$10/user/mês (~$50/mês para 5 users)
- **Veredicto**: ❌ Fraco para o que precisamos. É "gráfico bonito" sem inteligência.

#### Caminho B: Charts Nativos (Chart.js / Recharts)
- **Prós**: 100% integrado, sem custo, customizável
- **Contras**: Muito trabalho de frontend, gráficos estáticos, sem insights
- **Custo**: Free (tempo de desenvolvimento)
- **Veredicto**: 🟡 Bom como complemento, não como solução principal.

#### Caminho C: AI-Powered Analytics (Claude como motor) ⭐ RECOMENDADO
- **Prós**: Insights narrativos, perguntas em linguagem natural, dados em tempo real via Tool Use, zero configuração de dashboards
- **Contras**: Depende de API externa, custo por chamada
- **Custo**: ~$15-30/mês
- **Veredicto**: ✅ É o mais diferenciador. Substitui Power BI com mais valor.

#### Estratégia Final: C + B

```
┌─────────────────────────────────────────────────────────┐
│            ANALYTICS PAGE — Nova Arquitetura              │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  AI INSIGHTS PANEL (Claude Sonnet via Tool Use)      │ │
│  │                                                      │ │
│  │  "Hoje: 127 entregas (+15% vs semana passada).       │ │
│  │   Gold Coast com 40% do volume. Driver João          │ │
│  │   com melhor performance (4.2 min/stop).             │ │
│  │   Phoenix carrier mais usado (67%). Direct Freight    │ │
│  │   teve 2 atrasos — verificar consignments DF1234,    │ │
│  │   DF1235."                                           │ │
│  │                                                      │ │
│  │  [Perguntar ao AI] _________________________ [Enviar] │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ Entregas/Dia │ │ Por Carrier  │ │ Driver Perf.    │ │
│  │ (Chart.js)   │ │ (Chart.js)   │ │ (Chart.js)       │ │
│  │  📊 Line     │ │  📊 Pie      │ │  📊 Bar          │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
│                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐ │
│  │ SLA %        │ │ Custo/Entrega│ │ Suburbs Heatmap  │ │
│  │ (Chart.js)   │ │ (Chart.js)   │ │ (Google Maps)    │ │
│  │  📊 Gauge    │ │  📊 Line     │ │  🗺️ Heatmap     │ │
│  └──────────────┘ └──────────────┘ └──────────────────┘ │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Delivery Heatmap (Google Maps)                       │ │
│  │                                                      │ │
│  │  🗺️ Mapa com pontos de entrega coloridos por:        │ │
│  │     • Volume (mais escuro = mais entregas)            │ │
│  │     • Status (verde=entregue, vermelho=falha)         │ │
│  │     • Tempo médio por suburb                          │ │
│  │                                                      │ │
│  │  [Filtro: Período] [Filtro: Carrier] [Filtro: Status] │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 13.4 Delivery Heatmap — Implementação

O mapa no analytics é uma das features mais visuais e úteis. Dados já existem:

```python
# Dados disponíveis para heatmap (já estão no banco):
# - orders.latitude, orders.longitude (geocodificados)
# - orders.suburb, orders.postcode
# - orders.status (delivered, cancelled, partial)
# - orders.delivered_at (timestamp)
# - orders.delivery_company_id (qual carrier)
# - driver_stop_performance.time_at_stop (tempo por parada)

# Endpoint sugerido:
@app.route('/api/analytics/heatmap-data')
@login_required
def analytics_heatmap_data():
    """Retorna dados geo para heatmap de entregas."""
    days = int(request.args.get('days', 30))
    since = datetime.now() - timedelta(days=days)
    
    orders = Order.query.filter(
        Order.created_at >= since,
        Order.latitude.isnot(None),
        Order.longitude.isnot(None)
    ).all()
    
    return jsonify([{
        'lat': o.latitude,
        'lng': o.longitude,
        'suburb': o.suburb,
        'status': o.status,
        'carrier': o.delivery_company.name if o.delivery_company else 'Internal',
        'date': o.created_at.isoformat()
    } for o in orders])
```

```javascript
// Frontend — Google Maps Heatmap Layer
function initHeatmap(data) {
  const map = new google.maps.Map(document.getElementById('heatmap'), {
    zoom: 10,
    center: { lat: -27.4698, lng: 153.0251 }, // Brisbane
    mapTypeId: 'roadmap'
  });

  const heatmapData = data.map(d => ({
    location: new google.maps.LatLng(d.lat, d.lng),
    weight: d.status === 'delivered' ? 1 : 0.3
  }));

  new google.maps.visualization.HeatmapLayer({
    data: heatmapData,
    map: map,
    radius: 20,
    gradient: [
      'rgba(0, 255, 0, 0)',
      'rgba(0, 255, 0, 1)',    // Low density
      'rgba(255, 255, 0, 1)',  // Medium
      'rgba(255, 165, 0, 1)',  // High
      'rgba(255, 0, 0, 1)'    // Very high
    ]
  });
}
```

### 13.5 Analytics AI Tools (Tool Use para consultas)

```python
# Tools que a IA teria acesso na página de analytics:
tools = [
    {
        "name": "query_delivery_stats",
        "description": "Busca estatísticas de entregas por período, carrier, suburb, driver.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Últimos N dias"},
                "carrier": {"type": "string", "description": "Filtrar por carrier"},
                "suburb": {"type": "string", "description": "Filtrar por suburb"},
                "group_by": {"type": "string", "enum": ["day", "week", "carrier", "suburb", "driver"]}
            }
        }
    },
    {
        "name": "query_driver_performance",
        "description": "Busca métricas de performance de motoristas.",
        "input_schema": {
            "type": "object",
            "properties": {
                "driver_id": {"type": "integer"},
                "days": {"type": "integer"},
                "metric": {"type": "string", "enum": ["time_per_stop", "success_rate", "kms_per_day", "stops_per_day"]}
            }
        }
    },
    {
        "name": "query_carrier_costs",
        "description": "Busca custos por carrier com comparação.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer"},
                "compare_with": {"type": "string", "description": "Período anterior para comparação"}
            }
        }
    },
    {
        "name": "query_suburb_analysis",
        "description": "Análise de entregas por suburb: volume, sucesso, tempo médio.",
        "input_schema": {
            "type": "object",
            "properties": {
                "top_n": {"type": "integer", "description": "Top N suburbs por volume"},
                "sort_by": {"type": "string", "enum": ["volume", "success_rate", "avg_time", "cost"]}
            }
        }
    },
    {
        "name": "query_cancellation_reasons",
        "description": "Busca motivos de cancelamento com frequência.",
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer"},
                "group_by": {"type": "string", "enum": ["reason", "suburb", "driver", "customer"]}
            }
        }
    }
]
```

---

## 14. Comparação de Providers — Claude vs OpenAI vs Alternativas

### 14.1 Pricing Atual (Mar 2026)

| Provider | Modelo | Input ($/MTok) | Output ($/MTok) | Velocidade | Context Window |
|----------|--------|---------------|-----------------|------------|----------------|
| **Anthropic** | Claude Opus 4.6 | $5.00 | $25.00 | ~8s | 200K |
| **Anthropic** | Claude Sonnet 4.6 | $3.00 | $15.00 | ~2s | 200K |
| **Anthropic** | Claude Haiku 4.5 | $1.00 | $5.00 | ~0.5s | 200K |
| **OpenAI** | GPT-5.4-mini | $0.75 | $4.50 | ~1s | 128K |
| **OpenAI** | GPT-5.4-mini (batch) | $0.375 | $2.25 | async | 128K |
| **Google** | Gemini (via Genkit) | ~$1.25 | ~$5.00 | ~1.5s | 1M |

### 14.2 Custo prático por cenário

Hipótese: cada chamada = ~4,000 tokens input + ~1,000 tokens output

| Cenário | Opus 4.6 | Sonnet 4.6 | Haiku 4.5 | GPT-5.4-mini |
|---------|----------|------------|-----------|---------------|
| **Custo por chamada** | $0.045 | $0.027 | $0.009 | $0.0075 |
| **100 chamadas/dia** | $135/mês | $81/mês | $27/mês | $22.50/mês |
| **30 chamadas/dia** | $40.50/mês | $24.30/mês | $8.10/mês | $6.75/mês |
| **10 chamadas/dia** | $13.50/mês | $8.10/mês | $2.70/mês | $2.25/mês |

### 14.3 Qual modelo para quê

| Tarefa | Modelo Recomendado | Por quê |
|--------|-------------------|----------|
| Daily briefing, resumos simples | **Haiku** | Alto volume, tarefa simples, $0.009/chamada |
| Chat warehouse, explicações | **Sonnet** | Equilíbrio qualidade/custo, Tool Use |
| Analytics chat, perguntas complexas | **Sonnet** | Precisa de raciocínio + Tool Use |
| POD validation (Vision) | **Sonnet** | Vision com qualidade boa |
| Classificação de exceções | **Haiku** | Alto volume, tarefa curta |
| Relatório executivo semanal | **Sonnet** | Boa narrativa, dados complexos |
| Análise de incidentes profunda | **Opus** (raro) | Máxima qualidade, usado 1-2x/semana |
| Notificações personalizadas | **Haiku** | Alto volume, texto curto |
| Root cause de anomalias | **Sonnet** | Precisa de raciocínio analítico |
| Investigação de falhas complexas | **Opus** (raro) | Análise profunda com muitos dados |

### 14.4 Claude vs OpenAI — Decisão para nosso caso

| Critério | Claude | OpenAI |
|----------|--------|--------|
| **Tool Use** | ✅ Excelente, nativo | ✅ Bom (Function Calling) |
| **Vision** | ✅ Nativo em todos modelos | ✅ GPT-4o Vision |
| **Structured Output (JSON)** | ✅ Muito confiável | ✅ JSON mode |
| **Streaming** | ✅ SSE nativo | ✅ SSE nativo |
| **Context Window** | ✅ 200K tokens | 🟡 128K tokens |
| **Consistência** | ✅ Alta (menos alucinação) | 🟡 Boa |
| **Preço (Sonnet vs mini)** | 🟡 ~3.6x mais caro | ✅ Mais barato |
| **Qualidade de raciocínio** | ✅ Superior | 🟡 Boa para o preço |
| **SDK Node.js** | ✅ `@anthropic-ai/sdk` | ✅ `openai` |
| **SDK Python** | ✅ `anthropic` | ✅ `openai` |

**Decisão recomendada**: 
- **Produção (volume)**: **Claude Haiku** ou **GPT-5.4-mini** (o mais barato no momento)
- **Qualidade (analytics, chat)**: **Claude Sonnet** (melhor raciocínio)
- **Premium (raro)**: **Claude Opus** (investigação, relatórios complexos)

Podemos até usar **ambos providers** — Haiku/GPT-mini para volume, Sonnet para qualidade. A abstração é simples:

```javascript
// Abstração multi-provider
function getAIClient(tier = 'standard') {
  switch (tier) {
    case 'economy':  // Alto volume, tarefas simples
      return { provider: 'openai', model: 'gpt-5.4-mini' }; // ou Claude Haiku
    case 'standard': // Chat, análise, Tool Use
      return { provider: 'anthropic', model: 'claude-sonnet-4-20250514' };
    case 'premium':  // Investigação profunda, relatórios
      return { provider: 'anthropic', model: 'claude-opus-4-20250514' };
  }
}
```

---

## 15. Onde NÃO Usar LLM — Limites Claros

### 15.1 Roteirização — Use Solver, NÃO LLM

Para montar rota, decidir melhor ordem de paradas, respeitar janelas de entrega e minimizar distância:

| Ferramenta | Tipo | Custo |
|-----------|------|-------|
| **Google Directions API** | API (já usamos) | ~$5/1000 rotas |
| **Google Route Optimization API** | Solver dedicado | $10-30/1000 shipments |
| **OR-Tools** (Google) | Solver open-source | Free |

O Google Route Optimization API distingue:
- **SingleVehicleRouting**: free cap 5,000, depois $10/1000 shipments
- **FleetRouting**: free cap 1,000, depois $30/1000 shipments

Para 3,000 shipments/mês com múltiplos veículos:
- 1,000 grátis
- 2,000 × $30/1000 = **~$60/mês**

Isso é mais barato E mais confiável que pedir a uma LLM. **Um solver é determinístico e otimizado matematicamente**.

### 15.2 Decisões de stock — Use Regras, NÃO LLM

O motor de restock já funciona com:
- estoque mínimo/máximo
- reorder point
- dias de cobertura
- consumo médio por SKU/local
- sugestão de transfer entre bins/warehouses
- alertas de pickface baixo
- priorização por urgência, giro e lead time

**Tudo isso é mais confiável com regra e cálculo normal.** A LLM não deve tomar decisão de transferência de estoque.

### 15.3 Pricing — Use Regras Fixas

Preços são contratuais e determinísticos:
- 1ª caixa/satchel: $10.70
- Caixas adicionais: $5.35
- Pallets: $66.50

Uma LLM nunca deveria calcular preço. Use a regra que já existe.

### 15.4 State Machine de Pedidos — Use Código

```
pending → order_created → manifested → assigned → loaded → on_the_way → delivered
```

Transições de estado são regras de negócio. LLM não participa.

### 15.5 Regra de ouro

> **Se a decisão precisa ser 100% reproduzível e auditável → NÃO use LLM.**
> **Se a tarefa é interpretar, explicar, classificar ou comunicar → USE LLM.**

---

## 16. Mapa de Decisão: Regra vs LLM vs ML vs Solver

### Tabela definitiva por feature

| Feature | Camada | Motor | Onde implementar |
|---------|--------|-------|-----------------|
| **Cálculo de restock** | Regra | SQL + JS | Rapid Labels (já existe) |
| **Transfer plans** | Regra | SQL + cálculo | Rapid Labels (já existe) |
| **Pick anomaly detection** | Regra | Comparação bin | Rapid Labels (já existe) |
| **Pick anomaly ROOT CAUSE** | LLM | Sonnet + Tool Use | Rapid Labels (NOVO) |
| **Pricing** | Regra | Fórmula fixa | Rapid Express (já existe) |
| **Otimização de rota** | Solver | Google Directions / OR-Tools | Rapid Express (já existe / upgrade) |
| **Dispatch — atribuição a motoristas** | Regra + LLM copiloto | Clusters geo + sugestão LLM | Rapid Express (UPGRADE) |
| **Carrier selection** | Regra + LLM copiloto | Regras de cobertura + sugestão contextual | Hub (UPGRADE) |
| **Daily briefing** | LLM | Haiku/Sonnet | Ambos (NOVO) |
| **Chat warehouse** | LLM | Sonnet + Tool Use | Rapid Labels (NOVO) |
| **Chat analytics** | LLM | Sonnet + Tool Use | Rapid Express (NOVO) |
| **POD validation** | LLM Vision | Sonnet Vision | Rapid Express (NOVO) |
| **Notificações personalizadas** | LLM | Haiku | Rapid Express (NOVO) |
| **Classificação de exceções** | LLM | Haiku | Rapid Express (NOVO) |
| **Relatório executivo** | LLM | Sonnet | Cross-system (NOVO) |
| **Previsão de demanda** | Regra → (ML futuro) | Trend analysis → Prophet/similar | Rapid Labels (FASE 2) |
| **Risco de atraso** | Regra → (ML futuro) | Heurística → modelo treinado | Rapid Express (FASE 3) |
| **Risco de ruptura** | Regra → (ML futuro) | Days-of-cover → modelo | Rapid Labels (FASE 3) |
| **Heatmap de entregas** | Dados + Maps | Google Maps Heatmap Layer | Rapid Express (NOVO) |
| **Reconciliação financeira** | Regra + LLM | Matching automático + LLM explica gaps | Hub (FASE 2) |

### Evolução temporal

```
AGORA (Mar 2026):          Regras + SQL (base sólida) + LLM copiloto (Haiku/Sonnet)
                            Custo: ~$50-80/mês de API

6 MESES (Set 2026):        Regras + LLM + Route Optimization API (Google)
                            + Charts nativos (Chart.js)
                            Custo: ~$100-150/mês

12 MESES (Mar 2027):       Regras + LLM + Solver + ML (demand forecast, risco)
                            + AI Operations Center
                            Custo: ~$200-300/mês
```

### LLM vs ML — quando migrar

| Pergunta | Resposta |
|----------|----------|
| Tenho >12 meses de dados limpos? | Se sim → considerar ML |
| A tarefa é previsão numérica repetitiva? | Se sim → ML é melhor que LLM |
| Preciso de explicação em texto? | Se sim → LLM |
| Volume > 10,000 chamadas/mês? | Se sim → ML local (zero custo) |
| Equipe tem expertise em ML? | Se não → LLM por enquanto |

Para o estado atual dos dados (poucos meses de histórico, sem pipeline ML), **LLM para forecast "bom o suficiente" agora > ML perfeito daqui a 6 meses**.

---

## PRÓXIMOS PASSOS

### Imediato (esta semana)
1. **Criar conta Anthropic** → console.anthropic.com → obter API key
2. **Adicionar `ANTHROPIC_API_KEY`** ao `.env` de cada sistema
3. **Instalar SDK**: `npm install @anthropic-ai/sdk` (Labels/Hub) + `pip install anthropic` (Web)

### Fase 1 — Quick Wins (próximas 2-4 semanas)
4. **Daily AI Briefing** no dashboard Rapid Labels (Haiku, ~$0.10/dia)
5. **Anomaly Root Cause** na página de Pick Anomalies (Sonnet, ~$5/mês)
6. **Relatório Executivo Semanal** automático (Sonnet, ~$0.50/mês)

### Fase 2 — Core Features (1-2 meses)
7. **AI Warehouse Assistant** com Tool Use (Sonnet, ~$15/mês)
8. **Analytics Page** com AI Insights + Chart.js + Heatmap (substituir placeholder Power BI)
9. **POD Validation** com Vision (Sonnet, ~$30/mês)
10. **Copiloto do Dispatcher** (Sonnet, ~$20/mês)

### Fase 3 — Advanced (3-6 meses)
11. **Google Route Optimization API** para dispatch (substituir greedy)
12. **AI Operations Center** cross-system (Sonnet, ~$50/mês)
13. **ML Demand Forecast** (quando dados estiverem com 12+ meses)

### O que NÃO fazer
- ❌ Não colocar LLM para decidir rota principal
- ❌ Não colocar LLM para decidir transferência de stock sozinho
- ❌ Não começar com fine-tuning ou algo pesado
- ❌ Não usar Opus em cada evento do sistema
- ❌ Não substituir a lógica de negócio atual por LLM

---

*Documento criado em 26 Mar 2026. Atualizado com análise de arquitetura, analytics, comparação de providers e limites de uso. Baseado no estado atual dos 4 sistemas do ecossistema Rapid Express.*
