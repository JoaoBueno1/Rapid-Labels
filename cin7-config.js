/**
 * Cin7 Core API Configuration
 * 
 * Pre-configured with credentials for automatic integration.
 */

class Cin7Config {
    constructor() {
        // Hardcoded credentials - always enabled
        this.enabled = true;
        this.accountId = '3bda282b-60f0-40dc-9199-21959e247cd5';
        this.apiKey = '55c70204-619a-5286-ae1d-593493533cb9';
        this.baseUrl = 'https://inventory.dearsystems.com';
        this.apiPrefix = '/ExternalApi/v2';
        this.timeout = 8000; // 8 seconds - rápido
        
        // Initialize stats tracking
        this.initStats();
    }
    
    initStats() {
        // Get or create stats object
        const statsKey = 'cin7_stats';
        try {
            const stored = localStorage.getItem(statsKey);
            if (stored) {
                this.stats = JSON.parse(stored);
            } else {
                this.stats = {
                    totalCalls: 0,
                    successCalls: 0,
                    errorCalls: 0,
                    lastSync: null,
                    lastError: null,
                    recentOrders: []
                };
                this.saveStats();
            }
        } catch (e) {
            this.stats = {
                totalCalls: 0,
                successCalls: 0,
                errorCalls: 0,
                lastSync: null,
                lastError: null,
                recentOrders: []
            };
        }
    }
    
    saveStats() {
        try {
            localStorage.setItem('cin7_stats', JSON.stringify(this.stats));
        } catch (e) {
            console.error('[Cin7] Could not save stats:', e);
        }
    }
    
    trackCall(success, orderRef = null, error = null) {
        this.stats.totalCalls++;
        if (success) {
            this.stats.successCalls++;
            this.stats.lastSync = new Date().toISOString();
            
            // Track recent orders (keep last 20)
            if (orderRef) {
                this.stats.recentOrders.unshift({
                    ref: orderRef,
                    timestamp: new Date().toISOString()
                });
                this.stats.recentOrders = this.stats.recentOrders.slice(0, 20);
            }
        } else {
            this.stats.errorCalls++;
            this.stats.lastError = error || 'Unknown error';
        }
        this.saveStats();
    }
    
    getStats() {
        return { ...this.stats };
    }
    
    resetStats() {
        this.stats = {
            totalCalls: 0,
            successCalls: 0,
            errorCalls: 0,
            lastSync: null,
            lastError: null,
            recentOrders: []
        };
        this.saveStats();
    }
    
    isConfigured() {
        return this.enabled && this.accountId && this.apiKey;
    }
    
    getHeaders() {
        return {
            'api-auth-accountid': this.accountId,
            'api-auth-applicationkey': this.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
    }
    
    getSaleListUrl() {
        return `${this.baseUrl}${this.apiPrefix}/saleList`;
    }
    
    getSaleUrl() {
        return `${this.baseUrl}${this.apiPrefix}/sale`;
    }
}

// Create singleton instance
const cin7Config = new Cin7Config();
