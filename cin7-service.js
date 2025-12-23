/**
 * Cin7 Service Layer
 * 
 * High-level service for Cin7 integration.
 * Maps Cin7 data to internal format for the app.
 */

class Cin7Service {
    constructor() {
        this.client = cin7Client;
        this.config = cin7Config;
    }
    
    /**
     * Check if Cin7 integration is enabled and configured
     */
    isEnabled() {
        return this.config.isConfigured();
    }
    
    /**
     * Get integration status
     */
    getStatus() {
        return {
            enabled: this.config.enabled,
            configured: this.config.isConfigured(),
            ready: this.isEnabled()
        };
    }
    
    /**
     * Map Cin7 sale data to internal format
     * Based on actual Cin7 API response structure
     */
    _mapSaleOrder(rawData) {
        try {
            const customer = rawData.Customer || '';
            const contact = rawData.Contact || '';
            const phone = rawData.Phone || '';
            const email = rawData.Email || '';
            const salesRep = rawData.SalesRepresentative || '';
            
            // Extract invoice number if available
            let invoiceNumber = '';
            if (rawData.Invoices && Array.isArray(rawData.Invoices) && rawData.Invoices.length > 0) {
                invoiceNumber = rawData.Invoices[0].InvoiceNumber || '';
            }
            
            const shipping = rawData.ShippingAddress || {};
            const orderNumber = rawData.SaleOrderNumber || rawData.OrderNumber || rawData.Order || '';
            
            // Format address for display
            let fullAddress = '';
            if (shipping.Line1) fullAddress += shipping.Line1;
            if (shipping.Line2) fullAddress += (fullAddress ? '\n' : '') + shipping.Line2;
            
            return {
                success: true,
                reference: orderNumber,
                customer_name: customer,
                contact_name: contact,
                phone: phone,
                email: email,
                sales_rep: salesRep,
                invoice_number: invoiceNumber,  // e.g., "INV-221825" - if exists, order is invoiced
                address: fullAddress,
                suburb: shipping.City || '',
                state: shipping.State || '',
                postcode: shipping.PostCode || shipping.Postcode || '',
                country: shipping.Country || 'AU'
            };
        } catch (error) {
            console.error('[Cin7] Mapping error:', error);
            return {
                success: false,
                error: 'Failed to map order data'
            };
        }
    }
    
    /**
     * Lookup order and return mapped data
     */
    async lookupOrder(reference) {
        if (!reference || !reference.trim()) {
            return {
                success: false,
                error: 'Reference number is required'
            };
        }
        
        if (!this.isEnabled()) {
            return {
                success: false,
                error: 'Cin7 integration is not configured'
            };
        }
        
        const startTime = performance.now();
        const result = await this.client.getSaleOrder(reference);
        const elapsed = Math.round(performance.now() - startTime);
        
        if (!result.success) {
            return {
                success: false,
                error: result.error,
                elapsed: elapsed
            };
        }
        
        const mapped = this._mapSaleOrder(result.data);
        if (!mapped.success) {
            return mapped;
        }
        
        return {
            ...mapped,
            source: result.source || 'api',
            elapsed: elapsed
        };
    }
    
    /**
     * Test connection to Cin7 API
     */
    async testConnection() {
        if (!this.config.enabled) {
            return {
                success: false,
                error: 'Cin7 integration is disabled'
            };
        }
        
        if (!this.config.isConfigured()) {
            const missing = [];
            if (!this.config.accountId) missing.push('Account ID');
            if (!this.config.apiKey) missing.push('API Key');
            
            return {
                success: false,
                error: `Missing configuration: ${missing.join(', ')}`
            };
        }
        
        return {
            success: true,
            message: 'Cin7 integration is configured and ready',
            base_url: this.config.baseUrl
        };
    }
}

// Create singleton instance and export to window
const cin7Service = new Cin7Service();
window.cin7Service = cin7Service;
