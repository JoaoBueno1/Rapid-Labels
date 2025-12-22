/**
 * RapidExpress Cache Configuration
 * 
 * API credentials for connecting to RapidExpress Cin7 cache.
 * This cache provides fast order lookups (~50ms vs ~9s direct API).
 */

// RapidExpress Cache API URL
window.RAPIDEXPRESS_CACHE_URL = 'https://rapid-express-web.onrender.com';

// API Key for authentication
// Get this from RapidExpress admin or environment variable
window.RAPIDEXPRESS_API_KEY = 'e86aa8e4be6f010891a997bfc46c08a3499af1d9ae3a75e93a5bfa0dd6d5ad62';

console.log('[RapidExpress] Cache configured:', window.RAPIDEXPRESS_CACHE_URL);
