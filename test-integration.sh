#!/bin/bash
# =============================================
# Script de Teste Completo - Cin7 Supabase Cache
# =============================================

echo "🧪 Iniciando testes da integração Cin7 Supabase Cache..."
echo ""

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Verificar se backend está rodando
echo "1️⃣ Verificando backend Flask..."
if curl -s http://localhost:5050/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Backend está rodando${NC}"
else
    echo -e "${RED}❌ Backend não está rodando${NC}"
    echo "Execute: cd ProjectRapidExpress && flask run"
    exit 1
fi

# 2. Verificar se LabelsApp server está rodando
echo ""
echo "2️⃣ Verificando LabelsApp server..."
if curl -s http://localhost:3000/index.html > /dev/null 2>&1; then
    echo -e "${GREEN}✅ LabelsApp está rodando${NC}"
else
    echo -e "${YELLOW}⚠️  LabelsApp não está rodando${NC}"
    echo "Execute: cd LabelsApp_Final && python3 -m http.server 3000"
fi

# 3. Tentar sincronizar uma ordem via backend
echo ""
echo "3️⃣ Tentando sincronizar ordem SO-237088 via backend..."
RESPONSE=$(curl -s -X POST http://localhost:5050/api/cin7/cache/sync/SO-237088 \
    -H "Content-Type: application/json" 2>&1)

if echo "$RESPONSE" | grep -q "success.*true"; then
    echo -e "${GREEN}✅ Sincronização bem-sucedida via backend${NC}"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
elif echo "$RESPONSE" | grep -q "already.*exists"; then
    echo -e "${GREEN}✅ Ordem já existe no cache${NC}"
else
    echo -e "${YELLOW}⚠️  Backend sync falhou ou ordem não existe no Cin7${NC}"
    echo "Resposta: $RESPONSE"
    echo ""
    echo -e "${YELLOW}Você precisa inserir manualmente no Supabase SQL Editor:${NC}"
    echo "1. Abra: https://app.supabase.com/project/iaqnxamnjftwqdbsnfyl/sql"
    echo "2. Cole e execute o conteúdo de: insert_test_orders.sql"
fi

# 4. Instruções finais
echo ""
echo "4️⃣ Próximos passos:"
echo ""
echo "📋 OPÇÃO 1 - Inserir dados manualmente (RECOMENDADO):"
echo "   1. Abra: https://app.supabase.com/project/iaqnxamnjftwqdbsnfyl/sql"
echo "   2. Cole e execute: insert_test_orders.sql"
echo ""
echo "🧪 OPÇÃO 2 - Testar interface:"
echo "   1. Abra: http://localhost:3000/test-supabase-cache.html"
echo "   2. Clique em '2. Count Orders'"
echo "   3. Clique em '3. List Recent Orders'"
echo "   4. Clique em '4. Search SO-237088'"
echo ""
echo "📦 OPÇÃO 3 - Testar no Collections:"
echo "   1. Abra: http://localhost:3000/collections.html"
echo "   2. Clique em 'Add Order'"
echo "   3. Digite 'SO-237088' e clique no botão 🔍"
echo "   4. Veja o console (F12) para logs detalhados"
echo ""
echo -e "${GREEN}✅ Setup completo!${NC}"
