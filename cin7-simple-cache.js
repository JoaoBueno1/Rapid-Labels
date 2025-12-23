/**
 * Cin7 Simple Cache - Usa backend Flask para acessar PostgreSQL
 * Lógica: Tenta cache primeiro (via backend), se não encontra vai para API Cin7
 */

window.cin7SimpleCache = {
    /**
     * Busca ordem - tenta cache primeiro, depois API
     */
    lookupOrder: async function(reference) {
        console.log('[Cin7 Simple] Buscando:', reference);
        
        const normalized = reference.trim().toUpperCase();
        const soNumber = normalized.startsWith('SO-') ? normalized : `SO-${normalized}`;
        
        // STEP 1: Tentar cache primeiro (via backend Flask)
        const cacheResult = await this.searchCache(soNumber);
        if (cacheResult) {
            console.log('[Cin7 Simple] ✅ CACHE HIT!');
            return cacheResult;
        }
        
        // STEP 2: Fallback para API Cin7
        console.log('[Cin7 Simple] Cache miss, tentando API Cin7...');
        if (window.cin7Service && window.cin7Service.lookupOrder) {
            return await window.cin7Service.lookupOrder(reference);
        }
        
        console.error('[Cin7 Simple] ❌ Nem cache nem API disponível');
        return { success: false, error: 'Order not found' };
    },
    
    /**
     * Busca no cache via backend Flask
     */
    searchCache: async function(soNumber) {
        const BACKEND_URL = 'http://localhost:5050';
        
        try {
            const response = await fetch(`${BACKEND_URL}/api/cin7/cache/lookup/${encodeURIComponent(soNumber)}`);
            
            if (!response.ok) {
                console.log('[Cin7 Simple] Cache miss (HTTP', response.status + ')');
                return null;
            }
            
            const data = await response.json();
            
            // Converter para formato esperado
            return {
                success: true,
                source: 'cache',
                customer_name: data.delivery_company,
                contact_name: data.delivery_contact,
                email: data.delivery_email,
                phone: data.delivery_phone,
                address: data.delivery_address1,
                address2: data.delivery_address2,
                suburb: data.delivery_suburb,
                city: data.delivery_city,
                state: data.delivery_state,
                postcode: data.delivery_postcode,
                country: data.delivery_country || 'Australia',
                notes: data.notes || '',
                sales_rep: data.sales_rep || ''
            };
            
        } catch (err) {
            console.error('[Cin7 Simple] Erro ao acessar backend:', err.message);
            return null;
        }
    }
};

console.log('[Cin7 Simple Cache] ✅ Carregado');
