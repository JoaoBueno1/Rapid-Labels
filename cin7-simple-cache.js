/**
 * Cin7 Simple Cache - Queries Supabase (Rapid-Express-Web DB) directly via REST
 * Logic: Try cache first (Supabase cin7_orders_cache), fallback to direct Cin7 API
 */

const _CIN7_CACHE_SB_URL = 'https://psczzrhmolxifgzgzswh.supabase.co';
const _CIN7_CACHE_SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBzY3p6cmhtb2x4aWZnemd6c3doIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTAxMzgzNzUsImV4cCI6MjA2NTcxNDM3NX0.laN6Z5jMRpP-oH9-R72i-HhsJGrO756DN9ntNYNweWw';
const _CIN7_CACHE_FIELDS = 'delivery_company,delivery_contact,delivery_email,delivery_phone,delivery_address1,delivery_address2,delivery_suburb,delivery_city,delivery_state,delivery_postcode,delivery_country,notes,sales_rep';

window.cin7SimpleCache = {
    lookupOrder: async function(reference) {
        console.log('[Cin7 Cache] Looking up:', reference);
        const normalized = reference.trim().toUpperCase();
        const soNumber = normalized.startsWith('SO-') ? normalized : 'SO-' + normalized;
        
        // STEP 1: Try Supabase cache
        const cacheResult = await this.searchCache(soNumber);
        if (cacheResult) {
            console.log('[Cin7 Cache] ✅ CACHE HIT');
            return cacheResult;
        }
        
        // STEP 2: Fallback to direct Cin7 API (if configured)
        if (window.cin7Service && window.cin7Service.isEnabled && window.cin7Service.isEnabled()) {
            console.log('[Cin7 Cache] Cache miss, trying Cin7 API...');
            return await window.cin7Service.lookupOrder(reference);
        }
        
        return { success: false, error: 'Order not found in cache' };
    },
    
    searchCache: async function(soNumber) {
        try {
            const row = await this._fetchRow(soNumber);
            if (row) return this._mapRow(row);
            
            // Also try without SO- prefix
            const bare = soNumber.replace(/^SO-/, '');
            if (bare !== soNumber) {
                const row2 = await this._fetchRow(bare);
                if (row2) return this._mapRow(row2);
            }
            return null;
        } catch (err) {
            console.warn('[Cin7 Cache] Lookup error:', err.message);
            return null;
        }
    },
    
    _fetchRow: async function(ref) {
        const url = _CIN7_CACHE_SB_URL + '/rest/v1/cin7_orders_cache'
            + '?cin7_reference=ilike.' + encodeURIComponent(ref)
            + '&select=' + _CIN7_CACHE_FIELDS
            + '&limit=1';
        const resp = await fetch(url, {
            headers: { 'apikey': _CIN7_CACHE_SB_KEY, 'Authorization': 'Bearer ' + _CIN7_CACHE_SB_KEY }
        });
        if (!resp.ok) return null;
        const rows = await resp.json();
        return (rows && rows.length) ? rows[0] : null;
    },
    
    _mapRow: function(r) {
        return {
            success: true,
            source: 'cache',
            customer_name: r.delivery_company || '',
            contact_name: r.delivery_contact || '',
            email: r.delivery_email || '',
            phone: r.delivery_phone || '',
            address: r.delivery_address1 || '',
            address2: r.delivery_address2 || '',
            suburb: r.delivery_suburb || '',
            city: r.delivery_city || '',
            state: r.delivery_state || '',
            postcode: r.delivery_postcode || '',
            country: r.delivery_country || 'Australia',
            notes: r.notes || '',
            sales_rep: r.sales_rep || ''
        };
    }
};

console.log('[Cin7 Simple Cache] ✅ Loaded (Supabase REST)');
