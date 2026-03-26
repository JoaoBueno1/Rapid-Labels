# 🧠 AI Features Roadmap — Rapid-Labels

> Ideias e planos para integração de IA (Claude/Anthropic API) no sistema de warehouse.  
> Criado: 26 Mar 2026

---

## 1. AI Warehouse Assistant Page (`/ai-assistant`)

**Prioridade:** ⭐ Alta — feature mais impressionante e versátil

Chat integrado com Claude API onde o gestor de warehouse faz perguntas em linguagem natural:

- *"Quais produtos vão ficar sem stock esta semana?"*
- *"Qual a melhor forma de reorganizar o corredor A?"*
- *"Resumo das anomalias de pick dos últimos 7 dias"*
- *"Quais SKUs têm tendência de crescimento?"*
- *"Compare vendas deste mês vs mês passado"*

### Implementação:
- **Backend:** Nova route `/api/ai/chat` no `server.js`
  - Recebe pergunta do user
  - Detecta contexto relevante (stock? vendas? anomalias? restock?)
  - Busca dados do Supabase automaticamente
  - Envia para Anthropic API com system prompt + dados
  - Retorna resposta formatada
- **Frontend:** `ai-assistant.html` com UI de chat moderna
  - Histórico de conversa na sessão
  - Sugestões de perguntas rápidas (chips clicáveis)
  - Respostas com tabelas/gráficos inline quando relevante
  - Loading state com animação
- **Contexto inteligente:** Só envia dados relevantes para a pergunta, não tudo
  - Classificação de intent (stock, vendas, anomalias, layout, geral)
  - Query builder dinâmico baseado no intent

---

## 2. AI-Powered Demand Forecasting

**Prioridade:** ⭐ Alta

Usar dados históricos de vendas para gerar previsões inteligentes:

- Previsão de demanda por SKU (próximos 7/14/30 dias)
- Detecção de sazonalidade e tendências
- Alertas antecipados de ruptura de stock
- Sugestões de quantidade a encomendar

### Implementação:
- Pode ser uma tab dentro do Restock V2 ou página separada
- Backend coleta `branch_avg_monthly_sales` + histórico
- Claude analisa padrões e gera previsão estruturada (JSON)
- Frontend renderiza gráficos de forecast com confidence intervals

---

## 3. Smart Layout Optimizer

**Prioridade:** 🟡 Média

IA analisa padrões de pick e sugere reorganização do warehouse:

- Produtos mais vendidos → posicionar mais perto da zona de despacho
- Identificar bins mal posicionados (alto volume longe, baixo volume perto)
- Heatmap de eficiência do warehouse
- Sugestões de troca de pickface locations

### Implementação:
- Combinar dados de `stock_snapshot` + `branch_avg_monthly_sales` + pick data
- Claude gera plano de reorganização priorizado
- UI visual com mapa do warehouse e setas de movimentação sugerida

---

## 4. Daily AI Briefing

**Prioridade:** ⭐ Alta

Resumo diário automático gerado por IA, exibido no dashboard:

> "Bom dia! Hoje temos 12 SKUs a restock, 3 consolidações críticas, 
> anomalias de pick caíram 15% vs semana passada. Atenção: SKU ABC123 
> tem apenas 2 dias de stock restante."

### Implementação:
- Gerar briefing via cron job ou on-demand ao abrir dashboard
- Mostrar como card expandível no topo do `index.html`
- Pode incluir comparações semana-a-semana
- Opção de enviar por email (futuro)

---

## 5. Anomaly Explanation & Root Cause

**Prioridade:** 🟡 Média

Na página de Pick Anomalies, IA explica POR QUÊ uma anomalia ocorreu:

- Análise de padrão (sempre mesmo picker? mesmo horário? mesmo produto?)
- Sugestões de correção (relabel bin, mover produto, treinar picker)
- Correlação com outros eventos (restock recente? produto novo?)

### Implementação:
- Botão "🧠 Analyze" em cada anomalia ou em batch
- Claude recebe contexto da anomalia + histórico do SKU
- Resposta inline no card da anomalia

---

## 6. Natural Language Reports

**Prioridade:** 🟢 Baixa (nice-to-have)

Gerar relatórios personalizados via prompt:

- *"Gera um relatório de performance dos últimos 30 dias"*
- *"Quero ver top 10 produtos por rotatividade"*
- *"Compara eficiência do warehouse mês a mês"*

### Implementação:
- Extensão do AI Assistant com output formatado para PDF/Excel
- Templates de relatório que o Claude preenche com dados reais

---

## Stack Técnica

| Componente | Tecnologia |
|---|---|
| LLM API | Anthropic Claude (claude-sonnet-4-20250514 ou claude-sonnet-4-20250514) |
| Backend | Node.js (server.js existente) |
| Auth API | API key no `.env` (`ANTHROPIC_API_KEY`) |
| SDK | `@anthropic-ai/sdk` npm package |
| Dados | Supabase (já integrado) |
| Frontend | HTML/CSS/JS vanilla (consistente com stack atual) |

---

## Ordem de Implementação Sugerida

1. ✅ Setup: Instalar SDK, configurar API key, criar route base
2. ✅ AI Assistant Page — chat funcional com contexto de warehouse
3. ✅ Daily Briefing — card no dashboard
4. ✅ Demand Forecasting — tab ou página dedicada
5. ✅ Anomaly Explanation — integrar na página existente
6. ✅ Layout Optimizer — feature avançada
7. ✅ Natural Language Reports — nice-to-have

---

*Este documento será atualizado conforme as features forem implementadas.*
