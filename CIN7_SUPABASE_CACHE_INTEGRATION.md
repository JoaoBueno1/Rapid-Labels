# Integração LabelsApp com Cache Cin7 do Supabase

## 📋 Resumo

O LabelsApp agora busca dados de Sales Orders diretamente da tabela `cin7_orders_cache` no Supabase, com timeout de 3 segundos e fallback automático para a API Cin7 direta caso o cache falhe.

## 🎯 Benefícios

- ⚡ **Velocidade**: Lookup típico em ~100-300ms via cache vs ~2-5s via API
- 🔄 **Fallback Automático**: Se o cache falhar, usa API Cin7 direta
- 📊 **Rastreamento**: Estatísticas de cache hits/misses
- 🔒 **Seguro**: Acesso read-only via RLS do Supabase

## 🏗️ Arquitetura

```
┌─────────────────┐
│   collections   │
│  lookupCin7Order│
│   (collections. │
│       js)       │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ cin7SupabaseCache       │
│  lookupOrder()          │
│  (Timeout: 3s)          │
└────────┬────────────────┘
         │
         ├─── ✅ Cache Hit (Supabase)
         │    └─> cin7_orders_cache table
         │        └─> Retorna em ~100-300ms
         │
         └─── ❌ Cache Miss/Timeout
              └─> Fallback automático
                  └─> cin7Service.lookupOrder()
                      └─> API Cin7 direta (~2-5s)
```

**Fluxo de Dados:**

1. Usuário clica no botão 🔍 em collections.html
2. Chama `lookupCin7Order()` (definida em collections.js)
3. Usa `cin7SupabaseCache.lookupOrder()` internamente
4. Cache tenta buscar do Supabase com timeout de 3s
5. Se falhar, faz fallback automático para cin7Service (API direta)
6. Retorna dados e preenche formulário

## 📁 Arquivos Criados/Modificados

### Novos Arquivos

1. **`cin7-supabase-cache.js`** - Serviço principal de cache
   - Busca direta do Supabase com timeout de 3s
   - Fallback automático para API Cin7
   - Rastreamento de estatísticas
   - Função global `lookupCin7Order()` para collections.html

2. **`setup_cin7_cache_rls.sql`** - Configuração de segurança
   - Ativa RLS na tabela `cin7_orders_cache`
   - Cria política de SELECT público (read-only)
   - Inclui verificações e rollback

### Arquivos Modificados

1. **`collections.html`**
   - Adicionado `<script src="cin7-supabase-cache.js"></script>`

2. **`index.html`**
   - Adicionado `<script src="cin7-supabase-cache.js"></script>`

## 🚀 Setup

### 1. Configurar RLS no Supabase

Execute o arquivo SQL no Supabase Dashboard:

```bash
# Abra: https://app.supabase.com/project/[seu-projeto]/sql
# Cole e execute o conteúdo de: setup_cin7_cache_rls.sql
```

Ou execute diretamente:

```sql
-- Ativar RLS
ALTER TABLE cin7_orders_cache ENABLE ROW LEVEL SECURITY;

-- Criar política de SELECT público
CREATE POLICY "Allow public read access to cin7 cache"
ON cin7_orders_cache
FOR SELECT
USING (true);
```

### 2. Verificar Configuração

```sql
-- Verificar se RLS está ativo
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' AND tablename = 'cin7_orders_cache';

-- Verificar políticas
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE tablename = 'cin7_orders_cache';
```

### 3. Testar a Integração

1. Abra `collections.html`
2. Clique em "Add Order"
3. Digite um SO number (ex: "237087" ou "SO-237087")
4. Clique no botão de busca 🔍
5. Observe o status:
   - ✅ "Found (Cache - XXms)" = sucesso via cache
   - ✅ "Found (API - XXms)" = sucesso via fallback
   - ❌ "Not found" = ordem não existe

## 📊 Estrutura da Tabela

### `cin7_orders_cache`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| `cin7_reference` | text | SO-123456 |
| `cin7_id` | uuid | ID único do Cin7 |
| `customer_name` | text | Nome do cliente |
| `contact_name` | text | Nome do contato |
| `email` | text | Email |
| `phone` | text | Telefone |
| `sales_rep` | text | Representante de vendas |
| `address_line1` | text | Endereço linha 1 |
| `address_line2` | text | Endereço linha 2 |
| `suburb` | text | Subúrbio |
| `city` | text | Cidade |
| `state` | text | Estado |
| `postcode` | text | CEP |
| `country` | text | País (default: AU) |
| `special_instructions` | text | Instruções especiais |
| `customer_reference` | text | Referência do cliente |
| `order_date` | timestamp | Data do pedido |
| `status` | text | Status da ordem |
| `synced_at` | timestamp | Última sincronização |

## 🔧 API do Serviço

### `cin7SupabaseCache.lookupOrder(reference)`

Busca uma ordem com fallback automático.

```javascript
const result = await cin7SupabaseCache.lookupOrder('237087');

if (result.success) {
    console.log('Customer:', result.customer_name);
    console.log('Source:', result.source); // 'supabase_cache' ou 'cin7_api_fallback'
    console.log('Time:', result.elapsed + 'ms');
} else {
    console.error('Error:', result.error);
}
```

**Retorno em caso de sucesso:**
```javascript
{
    success: true,
    source: 'supabase_cache' | 'cin7_api_fallback',
    elapsed: 123, // ms
    reference: 'SO-237087',
    customer_name: 'John Doe',
    contact_name: 'Jane Doe',
    phone: '+61 123 456 789',
    email: 'john@example.com',
    sales_rep: 'Mike',
    address: '123 Main St\nApt 4',
    suburb: 'Sydney',
    state: 'NSW',
    postcode: '2000',
    country: 'AU',
    // ... outros campos
}
```

### `cin7SupabaseCache.searchOrders(query, limit)`

Busca ordens para autocomplete (timeout: 2s).

```javascript
const orders = await cin7SupabaseCache.searchOrders('John', 10);
// Retorna array de ordens que correspondem à busca
```

### `cin7SupabaseCache.getStats()`

Retorna estatísticas de uso do cache.

```javascript
const stats = cin7SupabaseCache.getStats();
console.log('Cache Hits:', stats.cacheHits);
console.log('Cache Misses:', stats.cacheMisses);
console.log('Fallback Calls:', stats.fallbackCalls);
```

### `lookupCin7Order()` (Global)

Função de conveniência para collections.html - preenche o formulário automaticamente.

```html
<button onclick="lookupCin7Order()">🔍 Lookup</button>
```

## ⏱️ Performance

### Cenário Típico

| Método | Tempo Médio | Notas |
|--------|-------------|-------|
| Cache Hit | 100-300ms | Ordem já no cache |
| Cache Miss + Fallback | 3s + 2-5s | Timeout + API call |
| Cache Error + Fallback | 3s + 2-5s | Erro de rede + API call |

### Timeout

- **Cache Supabase**: 3 segundos
- **Search (autocomplete)**: 2 segundos

## 🔒 Segurança

### Row Level Security (RLS)

A tabela `cin7_orders_cache` usa RLS para controle de acesso:

✅ **Permitido (anônimo - ANON_KEY)**:
- `SELECT` - Ler dados de ordens

❌ **Bloqueado (requer autenticação ou SERVICE_ROLE)**:
- `INSERT` - Inserir novas ordens
- `UPDATE` - Atualizar ordens existentes
- `DELETE` - Deletar ordens

### Chaves do Supabase

O LabelsApp usa `SUPABASE_ANON_KEY` (chave pública) que tem acesso apenas de leitura devido ao RLS.

A sincronização do cache (inserção/atualização) é feita pelo ProjectRapidExpress usando `SUPABASE_SERVICE_ROLE_KEY`.

## 🐛 Troubleshooting

### Erro: "Supabase not ready"

**Causa**: Cliente Supabase não inicializado

**Solução**: Verifique se `supabase-config.js` está carregado antes de `cin7-supabase-cache.js`

### Erro: "Cache timeout"

**Causa**: Consulta demorou mais de 3 segundos

**Solução**: Fallback automático para API Cin7 - nenhuma ação necessária

### Erro: "Permission denied for table cin7_orders_cache"

**Causa**: RLS não configurado corretamente

**Solução**: Execute `setup_cin7_cache_rls.sql` no Supabase

### Verificar se ordem está no cache

```sql
SELECT cin7_reference, customer_name, synced_at 
FROM cin7_orders_cache 
WHERE cin7_reference = 'SO-237087';
```

## 📈 Monitoramento

### Verificar estatísticas no console

```javascript
console.log(cin7SupabaseCache.getStats());
```

### Logs no console

O serviço registra automaticamente:
- ✅ Cache hits: `[Cin7 Supabase Cache] ✅ Cache hit for SO-237087 in 123ms`
- ❌ Cache misses: `[Cin7 Supabase Cache] Order not found: 237087`
- ⚠️ Timeouts: `[Cin7 Supabase Cache] Timeout after 3s`
- 🔄 Fallbacks: `[Cin7 Supabase Cache] Falling back to Cin7 API...`

## 🔄 Sincronização do Cache

O cache é mantido pelo **ProjectRapidExpress** (backend Flask):

1. Cron job automático a cada X minutos
2. Sincronização sob demanda via API
3. Webhook do Cin7 (se configurado)

**Nota**: O LabelsApp **não** sincroniza o cache - apenas lê dele.

## 📝 Notas Importantes

1. **Normalização de Referências**: O serviço remove automaticamente o prefixo "SO-" ao buscar, então "237087" e "SO-237087" funcionam igual

2. **Campo Invoice Number**: Não incluído no cache - se necessário, faça lookup direto da API

3. **Fallback Automático**: Sempre disponível - se o cache falhar por qualquer motivo, a API Cin7 é usada

4. **Estatísticas Persistentes**: Salvas em `localStorage` com key `cin7_supabase_cache_stats`

## 🎯 Próximos Passos

1. ✅ Configurar RLS no Supabase (execute `setup_cin7_cache_rls.sql`)
2. ✅ Testar lookup de uma ordem conhecida
3. ✅ Monitorar estatísticas de cache hit/miss
4. 🔄 Ajustar timeout se necessário (padrão: 3s)
5. 🔄 Implementar autocomplete com `searchOrders()` (opcional)

## 📞 Suporte

Se encontrar problemas:
1. Verifique os logs do console do navegador
2. Confirme que RLS está configurado: `SELECT rowsecurity FROM pg_tables WHERE tablename = 'cin7_orders_cache'`
3. Teste busca direta no Supabase SQL Editor
4. Verifique estatísticas: `cin7SupabaseCache.getStats()`
