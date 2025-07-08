# 🚀 Configuração do Supabase para Rapid Label Printer

## Passo a passo para conectar com sua base de dados

### 1. Obter credenciais do Supabase

1. Acesse [supabase.com](https://supabase.com) e faça login
2. Vá para o seu projeto "Palltes Labels"
3. No painel lateral, clique em **Settings** > **API**
4. Copie as seguintes informações:
   - **Project URL** (algo como: `https://xyzcompany.supabase.co`)
   - **anon public key** (chave pública)

### 2. Configurar as credenciais

1. Abra o arquivo `supabase-config.js`
2. Substitua as variáveis no início do arquivo:

```javascript
const SUPABASE_URL = 'https://SEU_PROJECT_ID.supabase.co'; // Sua URL do projeto
const SUPABASE_ANON_KEY = 'SUA_CHAVE_PUBLICA_AQUI'; // Sua chave pública
```

### 3. Verificar estrutura da tabela

Certifique-se de que sua tabela "Palltes Labels" tenha pelo menos as seguintes colunas:
- `sku` (texto) - Código SKU do produto
- `code` (texto) - Código do produto
- `qty` (número, opcional) - Quantidade padrão

### 4. Configurar políticas RLS (Row Level Security)

Se necessário, no Supabase:
1. Vá para **Authentication** > **Policies**
2. Para a tabela "Palltes Labels", crie uma política que permita leitura:

```sql
-- Política para permitir leitura pública
CREATE POLICY "Allow public read access" ON "Palltes Labels"
FOR SELECT USING (true);
```

### 5. Testar a conexão

1. Abra o arquivo `index.html` no navegador
2. Clique em "Search Product"
3. Digite parte de um SKU ou CODE existente
4. Verifique se os resultados aparecem automaticamente

## 🔧 Funcionalidades implementadas

### Busca Inteligente
- **Busca em tempo real**: Conforme você digita, os resultados aparecem
- **Busca por SKU ou CODE**: Aceita ambos os formatos
- **Suporte a scanner**: Detecta automaticamente códigos de barras
- **Resultados limitados**: Máximo 10 resultados para performance

### Auto-preenchimento
- **Seleção rápida**: Clique em qualquer resultado para selecionar
- **Dados completos**: Preenche automaticamente SKU, CODE e QTY padrão
- **Validação**: Verifica se todos os campos obrigatórios estão preenchidos

### Performance
- **Debounce**: Evita muitas chamadas à API
- **Cache**: Resultados são armazenados temporariamente
- **Loading states**: Mostra feedback visual durante as buscas

## 🛠️ Solução de problemas

### Erro de conexão
- Verifique se as credenciais estão corretas
- Confirme que a URL do projeto está no formato correto
- Teste a conexão diretamente no console do Supabase

### Sem resultados
- Verifique se a tabela "Palltes Labels" existe
- Confirme que há dados na tabela
- Verifique as políticas RLS se estiver usando autenticação

### Problemas de CORS
- O Supabase geralmente permite chamadas de qualquer origem
- Se necessário, configure as origens permitidas no painel do Supabase

## 📱 Como usar

### Para busca de produtos:
1. Clique em "Search Product"
2. Digite o SKU ou CODE (mínimo 2 caracteres)
3. Clique em um resultado para selecionar
4. Edite QTY e data se necessário
5. Selecione tamanho (A4/A3) e páginas
6. Clique em "Print"

### Para scanner de código de barras:
1. Use o campo de busca normalmente
2. O scanner deve inserir o código automaticamente
3. O produto será encontrado e selecionado
4. Continue com o processo normal de impressão

## 🚀 Próximos passos

Uma vez configurado, você terá:
- ✅ Busca em tempo real em 5 mil produtos
- ✅ Auto-preenchimento inteligente
- ✅ Suporte a scanner de código de barras
- ✅ Interface moderna e responsiva
- ✅ Validação completa de dados
- ✅ Impressão profissional A4/A3

Aproveite seu novo sistema de etiquetas conectado ao Supabase! 🎉
