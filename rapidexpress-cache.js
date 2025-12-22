/**
 * RapidExpress Cache Service
 * 
 * Connects to RapidExpress Cin7 cache for fast order lookups.
 * Falls back to direct Cin7 API if cache is unavailable.
 */

class RapidExpressCacheService {
    constructor() {
        // RapidExpress cache API URL (set in config or environment)
        this.cacheApiUrl = window.RAPIDEXPRESS_CACHE_URL || 'https://rapid-express-web.onrender.com';
        this.apiKey = window.RAPIDEXPRESS_API_KEY || '';
        this.enabled = !!this.apiKey;
        
        if (!this.enabled) {
            console.warn('[RapidExpress Cache] API key not configured - cache disabled');
        }
    }
    
    /**
     * Lookup order from RapidExpress cache
     * @param {string} reference - SO number (e.g., "SO-237087" or "237087")
     * @returns {Promise<Object>} Order data or error
     */
    async lookupOrder(reference) {
        if (!reference || !reference.trim()) {
            return { success: false, error: 'Reference is required' };
        }
        
        if (!this.enabled) {
            return { success: false, error: 'Cache not configured' };
        }
        
        const cleanRef = reference.trim().toUpperCase();
        const startTime = performance.now();
        
        try {
            const url = `${this.cacheApiUrl}/api/public/cin7/orders/${encodeURIComponent(cleanRef)}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Accept': 'application/json'
                },
                signal: AbortSignal.timeout(3000) // 3s timeout (cache should be fast)
            });
            
            const elapsed = Math.round(performance.now() - startTime);
            
            // Check if response is HTML (error page) instead of JSON
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                console.warn('[RapidExpress Cache] Server returned non-JSON response');
                return { success: false, error: 'Cache not available' };
            }
            
            if (!response.ok) {
                if (response.status === 401) {
                    console.error('[RapidExpress Cache] Invalid API key');
                    return { success: false, error: 'Invalid API key' };
                }
                if (response.status === 404) {
                    return { success: false, error: 'Order not found in cache' };
                }
                return { success: false, error: `Cache error: ${response.status}` };
            }
            
            const data = await response.json();
            
            if (!data.success || !data.order) {
                return { success: false, error: data.error || 'Invalid response' };
            }
            
            // Map to internal format
            const order = data.order;
            return {
                success: true,
                source: 'rapidexpress_cache',
                elapsed: elapsed,
                reference: order.so_number,
                customer_name: order.customer_name || '',
                contact_name: order.contact_name || '',
                phone: order.phone || '',
                email: order.email || '',
                sales_rep: order.sales_rep || '',
                // Invoice NOT included from cache (always manual or fresh fetch)
                address: order.address ? 
                    [order.address.line1, order.address.line2].filter(Boolean).join('\n') : '',
                suburb: order.address?.suburb || order.address?.city || '',
                state: order.address?.state || '',
                postcode: order.address?.postcode || '',
                country: order.address?.country || 'AU'
            };
            
        } catch (error) {
            console.warn('[RapidExpress Cache] Error:', error.message);
            return { success: false, error: 'Cache unavailable' };
        }
    }
    
    /**
     * Search orders in cache (for autocomplete)
     * @param {string} query - Search query
     * @param {number} limit - Max results
     * @returns {Promise<Array>} List of matching orders
     */
    async searchOrders(query, limit = 10) {
        if (!query || query.length < 2 || !this.enabled) {
            return [];
        }
        
        try {
            const url = `${this.cacheApiUrl}/api/public/cin7/orders?q=${encodeURIComponent(query)}&limit=${limit}`;
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-API-Key': this.apiKey,
                    'Accept': 'application/json'
                },
                signal: AbortSignal.timeout(5000)
            });
            
            if (!response.ok) return [];
            
            const data = await response.json();
            return data.orders || [];
            
        } catch (error) {
            console.warn('[RapidExpress Cache] Search error:', error.message);
            return [];
        }
    }
}

// Create global instance
const rapidExpressCache = new RapidExpressCacheService();
