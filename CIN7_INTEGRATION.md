# Cin7 Integration - LabelsApp

## Overview

This integration connects LabelsApp with Cin7 Core API to automatically fetch customer and order information when adding collections.

## Features

✅ **Auto-fill Order Details**: Scan or type a Sales Order reference (e.g., SO-12345) to automatically populate customer information
✅ **Smart Caching**: Frequently accessed orders are cached for instant lookups (1-hour TTL)
✅ **Real-time Monitoring**: Analytics dashboard to monitor integration health and cache performance
✅ **Scanner Support**: Works seamlessly with barcode scanners in the Reference field
✅ **Auto-focus**: Reference field gets automatic focus when opening "Add Order" modal

## Setup

### 1. Get Cin7 Credentials

You'll need:
- **Cin7 Account ID**: Your Cin7 account identifier
- **Cin7 API Key**: Your API authentication key

These can be obtained from your Cin7 Core account settings.

### 2. Configure Integration

1. Open the app and click **"📊 Analytics & Registers"** button
2. You'll be redirected to the Integration Analytics page
3. Enter your Cin7 credentials:
   - Check "Enable Cin7 Integration"
   - Enter your Account ID
   - Enter your API Key
4. Click **"Save Configuration"**
5. Click **"Test Connection"** to verify everything works

### 3. Usage

#### In Collections Page:

1. Click **"Add Order"** button
2. The **Reference** field will be auto-focused
3. Either:
   - **Scan** the barcode of a Sales Order (e.g., SO-12345)
   - **Type** the order number manually
   - **Click the search icon** button next to the Reference field
4. The system will automatically fetch and fill:
   - Customer name
   - Contact name
   - Contact phone
   - Email

## Files Structure

```
LabelsApp_Final/
├── cin7-config.js          # Configuration management
├── cin7-client.js          # HTTP client for Cin7 API
├── cin7-service.js         # Service layer with data mapping
├── collections.html        # Updated with Cin7 lookup button
├── collections.js          # Cin7 lookup functions added
└── features/
    └── analytics/
        └── integrations.html  # Analytics dashboard
```

## API Details

### Endpoints Used

- **GET** `/ExternalApi/v2/saleList` - Search for sales orders
- **GET** `/ExternalApi/v2/sale` - Get full order details

### Data Mapping

Cin7 data is mapped to internal format:

```javascript
{
  customer_name: "Customer Name",
  contact_name: "Contact Person",
  phone: "Phone Number",
  email: "email@example.com",
  reference: "SO-12345",
  address: {
    line1: "Street Address",
    suburb: "City",
    state: "State",
    postcode: "Postcode",
    country: "AU"
  }
}
```

## Cache

- **TTL**: 1 hour (3600 seconds)
- **Max Size**: 1,000 entries
- **Storage**: In-memory (browser)
- **Clearing**: Automatic on overflow or manual via Analytics page

## Security

- Credentials stored in browser's localStorage (encrypted by browser)
- No credentials are sent to any server except Cin7 API
- All API calls use HTTPS
- API keys are never logged or displayed in console (production mode)

## Troubleshooting

### "Cin7 credentials not configured"
→ Go to Analytics page and enter your credentials

### "Authentication failed"
→ Verify your Account ID and API Key are correct

### "Order not found"
→ Check if the order number exists in Cin7 and uses the correct format (SO-XXXXX)

### "Request timed out"
→ Check your internet connection. Default timeout is 10 seconds.

### Cache not working
→ Clear cache from Analytics page and try again

## Integration with Same Credentials

This integration uses the **same Cin7 credentials** as the RapidExpress project. You can copy them from:

```bash
# From RapidExpress .env file
CIN7_ENABLED=true
CIN7_ACCOUNT_ID=your_account_id
CIN7_API_KEY=your_api_key
```

## Future Enhancements

- [ ] Background sync to pre-populate cache
- [ ] Support for Stock Transfer orders
- [ ] Webhook support for real-time updates
- [ ] Export cache statistics to CSV
- [ ] Custom cache TTL configuration
- [ ] Multiple Cin7 accounts support

## Support

For issues or questions:
1. Check the Analytics dashboard for connection status
2. Use "Test Connection" button to diagnose issues
3. Review browser console for detailed error messages
4. Contact support with error details

---

**Note**: This is a client-side only integration. No backend server is required for the Cin7 integration to work.
