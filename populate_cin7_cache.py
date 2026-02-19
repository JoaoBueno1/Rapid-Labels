#!/usr/bin/env python3
"""
Script para popular o cache Cin7 no Supabase.
Roda localmente e popula imediatamente.

Usage:
    python populate_cin7_cache.py
"""

import os
import sys
import requests
from datetime import datetime

# Configuração
BACKEND_URL = os.getenv('BACKEND_URL', 'http://localhost:5050')
SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co'
SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcxOTE1NzkzNCwiZXhwIjoyMDM0NzMzOTM0fQ.BRHXp3ywILpNjslPDvZ51kC2PmQhxvEJOQd2KGLiB0g'

def print_status(message, status='info'):
    """Print colored status message."""
    colors = {
        'info': '\033[94m',
        'success': '\033[92m',
        'warning': '\033[93m',
        'error': '\033[91m',
        'end': '\033[0m'
    }
    color = colors.get(status, colors['info'])
    print(f"{color}[{datetime.now().strftime('%H:%M:%S')}] {message}{colors['end']}")

def test_backend():
    """Test backend connection."""
    print_status(f"Testando conexão com backend: {BACKEND_URL}", 'info')
    try:
        response = requests.get(f"{BACKEND_URL}/health", timeout=5)
        if response.ok:
            print_status("✅ Backend conectado!", 'success')
            return True
    except Exception as e:
        print_status(f"❌ Backend não disponível: {e}", 'error')
        return False

def sync_via_backend():
    """Trigger sync via backend API."""
    print_status("Sincronizando via backend API...", 'info')
    try:
        response = requests.post(
            f"{BACKEND_URL}/api/integrations/cin7/cache/sync",
            json={"force": True, "limit": 100},
            timeout=60
        )
        
        if response.ok:
            data = response.json()
            if data.get('success'):
                print_status(f"✅ Sync completo! {data.get('cached', 0)} pedidos sincronizados.", 'success')
                return True
            else:
                print_status(f"❌ Sync falhou: {data.get('error')}", 'error')
        else:
            print_status(f"❌ HTTP {response.status_code}: {response.text}", 'error')
            
    except Exception as e:
        print_status(f"❌ Erro ao sincronizar: {e}", 'error')
    
    return False

def insert_test_order():
    """Insert a test order directly into Supabase."""
    print_status("Inserindo ordem de teste no Supabase...", 'info')
    
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    }
    
    test_order = {
        'cin7_id': 'test-id-237088',
        'cin7_reference': 'SO-237088',
        'order_type': 'sale',
        'delivery_company': 'Arise Electrical',
        'delivery_contact': 'Terence Chu',
        'delivery_email': 'info@ariseelectrical.com.au',
        'delivery_phone': '0422127678',
        'delivery_address1': '123 Test Street',
        'delivery_suburb': 'Brisbane',
        'delivery_postcode': '4000',
        'delivery_state': 'QLD',
        'delivery_country': 'AU',
        'sales_rep': 'API sales',
        'cin7_status': 'Authorised'
    }
    
    try:
        response = requests.post(
            f"{SUPABASE_URL}/rest/v1/cin7_orders_cache",
            json=test_order,
            headers=headers,
            timeout=10
        )
        
        if response.status_code in (200, 201):
            print_status("✅ Ordem de teste inserida com sucesso!", 'success')
            return True
        else:
            print_status(f"❌ Falha ao inserir: HTTP {response.status_code}", 'error')
            print_status(f"Response: {response.text}", 'error')
            
    except Exception as e:
        print_status(f"❌ Erro ao inserir: {e}", 'error')
    
    return False

def check_cache():
    """Check cache contents."""
    print_status("Verificando conteúdo do cache...", 'info')
    
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    }
    
    try:
        # Count total orders
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/cin7_orders_cache?select=*&limit=0",
            headers={**headers, 'Prefer': 'count=exact'},
            timeout=10
        )
        
        if response.ok:
            count = response.headers.get('Content-Range', '0-0/0').split('/')[-1]
            print_status(f"📊 Total de ordens no cache: {count}", 'info')
            
            if count != '0':
                # Get recent orders
                response = requests.get(
                    f"{SUPABASE_URL}/rest/v1/cin7_orders_cache?select=cin7_reference,delivery_company,synced_at&order=synced_at.desc&limit=5",
                    headers=headers,
                    timeout=10
                )
                
                if response.ok:
                    orders = response.json()
                    print_status(f"✅ Últimas {len(orders)} ordens:", 'success')
                    for order in orders:
                        print(f"  - {order.get('cin7_reference')}: {order.get('delivery_company')}")
            else:
                print_status("⚠️ Cache vazio!", 'warning')
                
    except Exception as e:
        print_status(f"❌ Erro ao verificar cache: {e}", 'error')

def main():
    """Main execution."""
    print("\n" + "="*60)
    print(" 🔄 Cin7 Cache Population Script")
    print("="*60 + "\n")
    
    # Method 1: Try backend sync
    if test_backend():
        if sync_via_backend():
            check_cache()
            print_status("\n✅ Cache populado com sucesso via backend!", 'success')
            return 0
        else:
            print_status("⚠️ Sync via backend falhou. Tentando método alternativo...", 'warning')
    
    # Method 2: Insert test order directly
    print_status("\n📝 Tentando inserir ordem de teste diretamente...", 'info')
    if insert_test_order():
        check_cache()
        print_status("\n✅ Ordem de teste inserida!", 'success')
        print_status("⚠️ Nota: Esta é apenas uma ordem de teste. Execute o backend para sync completo.", 'warning')
        return 0
    
    print_status("\n❌ Falha ao popular cache. Verifique:", 'error')
    print("  1. Backend está rodando? (http://localhost:5050)")
    print("  2. Supabase está configurado corretamente?")
    print("  3. SERVICE_ROLE key está correta?")
    
    return 1

if __name__ == '__main__':
    sys.exit(main())
