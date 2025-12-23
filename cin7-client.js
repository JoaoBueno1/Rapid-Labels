/**
 * Cin7 Core API Client
 * 
 * Handles HTTP communication with Cin7 Core API.
 * Direct API calls - NO CACHE for real-time data.
 */

class Cin7Client {
    constructor() {
        this.config = cin7Config;
    }
    
    /**
     * Make HTTP request to Cin7 API
     */
    async _makeRequest(method, url, params = null) {
        if (!this.config.isConfigured()) {
            const error = 'Cin7 credentials not configured';
            this.config.trackCall(false, null, error);
            return { 
                success: false, 
                error: error 
            };
        }
        
        try {
            const headers = this.config.getHeaders();
            
            let fetchUrl = url;
            if (params && method === 'GET') {
                const queryString = new URLSearchParams(params).toString();
                fetchUrl = `${url}?${queryString}`;
            }
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
            
            const response = await fetch(fetchUrl, {
                method: method,
                headers: headers,
                signal: controller.signal,
                keepalive: true  // Enable HTTP Keep-Alive for faster subsequent requests
            });
            
            clearTimeout(timeoutId);
            
            // Handle errors
            if (response.status === 401 || response.status === 403) {
                const error = 'Authentication failed - check Cin7 credentials';
                this.config.trackCall(false, null, error);
                return { 
                    success: false, 
                    error: error 
                };
            }
            
            if (response.status === 404) {
                const error = 'Order not found';
                this.config.trackCall(false, null, error);
                return { 
                    success: false, 
                    error: error 
                };
            }
            
            if (response.status === 429) {
                const error = 'Rate limit exceeded - please wait';
                this.config.trackCall(false, null, error);
                return { 
                    success: false, 
                    error: error 
                };
            }
            
            if (!response.ok) {
                const error = `API error: ${response.status} ${response.statusText}`;
                this.config.trackCall(false, null, error);
                return { 
                    success: false, 
                    error: error 
                };
            }
            
            const data = await response.json();
            return { success: true, data: data };
            
        } catch (error) {
            if (error.name === 'AbortError') {
                const err = 'Request timed out';
                this.config.trackCall(false, null, err);
                return { 
                    success: false, 
                    error: err 
                };
            }
            
            console.error('[Cin7] Request error:', error);
            const err = `Connection error: ${error.message}`;
            this.config.trackCall(false, null, err);
            return { 
                success: false, 
                error: err 
            };
        }
    }
    
    /**
     * Lookup sale order by order number - OPTIMIZED DIRECT LOOKUP
     */
    async getSaleOrder(orderNumber) {
        if (!orderNumber || !orderNumber.trim()) {
            return { 
                success: false, 
                error: 'Order number is required' 
            };
        }
        
        let normalizedOrder = orderNumber.trim().toUpperCase();
        
        // Remove SO- prefix for direct API call
        const cleanOrderNumber = normalizedOrder.replace(/^SO-/i, '');
        
        console.log('[Cin7] Direct lookup for:', cleanOrderNumber);
        
        // OPTIMIZED: Direct lookup by OrderNumber (much faster ~300-500ms vs 8-9s)
        const detailUrl = this.config.getSaleUrl();
        const detailParams = { OrderNumber: cleanOrderNumber };
        
        const detailResult = await this._makeRequest('GET', detailUrl, detailParams);
        
        if (!detailResult.success) {
            // If direct lookup fails, fallback to search method
            console.log('[Cin7] Direct lookup failed, trying search method...');
            return await this._fallbackSearch(normalizedOrder);
        }
        
        if (!detailResult.data || !detailResult.data.ID) {
            return await this._fallbackSearch(normalizedOrder);
        }
        
        // Track successful call
        this.config.trackCall(true, normalizedOrder);
        
        return {
            success: true,
            data: detailResult.data,
            source: 'api'
        };
    }
    
    /**
     * Fallback search method (slower, used if direct lookup fails)
     */
    async _fallbackSearch(normalizedOrder) {
        console.log('[Cin7] Using fallback search for:', normalizedOrder);
        
        const listUrl = this.config.getSaleListUrl();
        const listParams = {
            Search: normalizedOrder,
            Page: 1,
            Limit: 5
        };
        
        const listResult = await this._makeRequest('GET', listUrl, listParams);
        if (!listResult.success) {
            return listResult;
        }
        
        const saleList = listResult.data?.SaleList;
        if (!saleList || saleList.length === 0) {
            const error = 'Order not found';
            this.config.trackCall(false, normalizedOrder, error);
            return { 
                success: false, 
                error: error 
            };
        }
        
        // Find exact match or use first result
        let saleId = saleList[0].SaleID;
        for (const sale of saleList) {
            if (sale.OrderNumber === normalizedOrder) {
                saleId = sale.SaleID;
                break;
            }
        }
        
        if (!saleId) {
            const error = 'Could not find sale ID';
            this.config.trackCall(false, normalizedOrder, error);
            return { 
                success: false, 
                error: error 
            };
        }
        
        // Get full sale details
        const detailUrl = this.config.getSaleUrl();
        const detailParams = { ID: saleId };
        
        const detailResult = await this._makeRequest('GET', detailUrl, detailParams);
        if (!detailResult.success) {
            return detailResult;
        }
        
        this.config.trackCall(true, normalizedOrder);
        
        return {
            success: true,
            data: detailResult.data,
            source: 'api'
        };
    }
}

// Create singleton instance and export to window
const cin7Client = new Cin7Client();
window.cin7Client = cin7Client;
