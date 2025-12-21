/**
 * Cin7 Service with Cache Server Support
 * 
 * Uses local cache server when available, falls back to direct API
 */

class Cin7ServiceWithCache {
    constructor() {
        this.cacheServerUrl = 'http://localhost:3007';
        this.useCacheServer = false;
        this.checkCacheServer();
    }
    
    // Check if cache server is available
    async checkCacheServer() {
        try {
            const response = await fetch(`${this.cacheServerUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(1000)
            });
            
            if (response.ok) {
                this.useCacheServer = true;
                console.log('[Cin7] Cache server available - using optimized lookups');
            }
        } catch (error) {
            this.useCacheServer = false;
            console.log('[Cin7] Cache server not available - using direct API');
        }
    }
    
    // Lookup order (uses cache server if available)
    async lookupOrder(reference) {
        if (!reference || !reference.trim()) {
            return {
                success: false,
                error: 'Reference number is required'
            };
        }
        
        const cleanRef = reference.trim().toUpperCase().replace(/^SO-/i, '');
        
        // Try cache server first
        if (this.useCacheServer) {
            try {
                const startTime = performance.now();
                const response = await fetch(`${this.cacheServerUrl}/lookup?order=${cleanRef}`, {
                    method: 'GET',
                    signal: AbortSignal.timeout(15000)
                });
                
                if (response.ok) {
                    const result = await response.json();
                    const elapsed = Math.round(performance.now() - startTime);
                    
                    if (result.success) {
                        return this._mapCacheResponse(result, elapsed);
                    }
                }
            } catch (error) {
                console.warn('[Cin7] Cache server error, falling back to direct API:', error.message);
                this.useCacheServer = false;
            }
        }
        
        // Fallback to direct API
        return await cin7Service.lookupOrder(reference);
    }
    
    // Map cache server response (WITHOUT invoice_number - manual entry only)
    _mapCacheResponse(result, clientElapsed) {
        const rawData = result.data;
        
        // NO invoice number - it's updated when order is scanned, so cache would be stale
        // Invoice must be entered manually or fetched fresh when needed
        
        const shipping = rawData.ShippingAddress || {};
        let fullAddress = '';
        if (shipping.Line1) fullAddress += shipping.Line1;
        if (shipping.Line2) fullAddress += (fullAddress ? '\n' : '') + shipping.Line2;
        
        return {
            success: true,
            reference: rawData.SaleOrderNumber || rawData.OrderNumber || rawData.Order || '',
            customer_name: rawData.Customer || '',
            contact_name: rawData.Contact || '',
            phone: rawData.Phone || '',
            email: rawData.Email || '',
            sales_rep: rawData.SalesRepresentative || '',
            // invoice_number: REMOVED - always manual/fresh fetch
            address: fullAddress,
            suburb: shipping.City || '',
            state: shipping.State || '',
            postcode: shipping.PostCode || shipping.Postcode || '',
            country: shipping.Country || 'AU',
            source: result.source,
            server_time: result.elapsed,
            client_time: clientElapsed,
            elapsed: clientElapsed
        };
    }
}

// Create instance
const cin7ServiceCache = new Cin7ServiceWithCache();
