// Secure & optimized Express server for Rapid Label (no layout changes)
require('dotenv').config(); // Load environment variables first
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 8383;
const PRINTER_HOST = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100', 10);

// Supabase setup for backend endpoints
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
let supabaseBackend = null;

if (SUPABASE_SERVICE_KEY) {
  supabaseBackend = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log('✅ Supabase backend client initialized');
} else {
  console.warn('⚠️  SUPABASE_SERVICE_KEY not set - audit endpoints will not work');
}

// Basic security headers (CSP kept permissive for current external CDNs)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net", "'unsafe-inline'", "'unsafe-eval'"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      "style-src-elem": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'blob:', 'https://iaqnxamnjftwqdbsnfyl.supabase.co'],
      "connect-src": ["'self'", "https://iaqnxamnjftwqdbsnfyl.supabase.co", "https://psczzrhmolxifgzgzswh.supabase.co", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'self'"],
      "upgrade-insecure-requests": []
    }
  }
}));

// Compression for static assets
app.use(compression());

// Rate limit (protect from abuse – generous for internal use)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 800 });
app.use(limiter);

// CORS - Allow all origins for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// JSON body parsing
app.use(express.json({ limit: '200kb' }));

// Static caching headers (immutable-ish for versioned assets; index.html short cache)
app.use((req, res, next) => {
  if (/\.(js|css|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$/i.test(req.url)) {
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days
  } else if (req.url === '/' || /index\.html$/.test(req.url)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Cin7 Webhook & Stock Audit routes ──
try {
  const registerWebhookRoutes = require('./cin7-stock-sync/webhook-receiver');
  registerWebhookRoutes(app, supabaseBackend);
  console.log('✅ Cin7 webhook/audit routes registered');
} catch (e) {
  console.warn('⚠️  Could not register webhook routes:', e.message);
}

// ── Pick Anomalies routes ──
try {
  const { registerPickAnomalyRoutes } = require('./features/pick-anomalies/pick-anomalies-engine');
  registerPickAnomalyRoutes(app);
} catch (e) {
  console.warn('⚠️  Could not register pick anomaly routes:', e.message);
}

// ── Gateway Transfer routes ──
try {
  const { registerGatewayRoutes } = require('./features/gateway/gateway-engine');
  registerGatewayRoutes(app);
} catch (e) {
  console.warn('⚠️  Could not register gateway routes:', e.message);
}

// Only listen on port when running locally (not on Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`🚀 Rapid Label server running at http://localhost:${PORT}`);
  });
}

// ZPL print endpoint: POST /api/print-zpl { zpl: string, host?: string, port?: number }
app.post('/api/print-zpl', async (req, res) => {
  try {
    const { zpl, host, port } = req.body || {};
    if (!zpl || typeof zpl !== 'string' || !zpl.includes('^XA') || !zpl.includes('^XZ')) {
      return res.status(400).json({ success: false, error: 'Invalid ZPL payload (must include ^XA/^XZ)' });
    }
    const targetHost = host || PRINTER_HOST;
    const targetPort = Number.isFinite(port) ? port : PRINTER_PORT;

    const socket = new net.Socket();
    socket.setTimeout(7000);

    await new Promise((resolve, reject) => {
      socket.connect(targetPort, targetHost, () => {
        try {
          socket.write(zpl, 'utf8', () => {
            // Give printer a moment then end
            setTimeout(() => { try { socket.end(); } catch (e) {} }, 50);
          });
        } catch (e) {
          reject(e);
        }
      });
      socket.on('timeout', () => reject(new Error('Printer connection timeout')));
      socket.on('error', (err) => reject(err));
      socket.on('close', () => resolve());
    });

    return res.json({ success: true, host: targetHost, port: targetPort });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ============================================
// CYCLIC COUNT AUDIT ENDPOINTS
// ============================================

/**
 * Trigger a new weekly audit run
 * POST /api/audit/run-weekly
 * Body: { periodStart?: 'YYYY-MM-DD', periodEnd?: 'YYYY-MM-DD' }
 */
app.post('/api/audit/run-weekly', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured. Set SUPABASE_SERVICE_KEY env var.' 
      });
    }

    // Import sync functions (dynamic to avoid requiring at startup)
    const {
      runWeeklyStockAudit,
      generateStockAnalysisForRun
    } = require('./cin7-sync-service');

    // Calculate week dates if not provided
    let { periodStart, periodEnd } = req.body || {};
    
    if (!periodStart || !periodEnd) {
      const today = new Date();
      const dayOfWeek = today.getDay();
      const monday = new Date(today);
      monday.setDate(today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      
      periodStart = monday.toISOString().split('T')[0];
      periodEnd = sunday.toISOString().split('T')[0];
    }

    console.log(`🔄 Running audit for ${periodStart} to ${periodEnd}...`);

    // Run audit
    const run = await runWeeklyStockAudit(periodStart, periodEnd, supabaseBackend);
    
    // Generate analysis
    const analysisResult = await generateStockAnalysisForRun(run.id, supabaseBackend);

    return res.json({ 
      success: true, 
      run_id: run.id,
      period_start: periodStart,
      period_end: periodEnd,
      analysis_records: analysisResult.generated
    });

  } catch (error) {
    console.error('❌ Error running audit:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get latest audit run info
 * GET /api/audit/latest
 */
app.get('/api/audit/latest', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { data: latestRun, error } = await supabaseBackend
      .from('audit_runs')
      .select('*')
      .order('period_end_date', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.json({ success: true, run: null });
      }
      throw error;
    }

    return res.json({ success: true, run: latestRun });

  } catch (error) {
    console.error('❌ Error getting latest audit:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get audit statistics
 * GET /api/audit/stats/:runId
 */
app.get('/api/audit/stats/:runId', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { runId } = req.params;

    const { data: analysis, error } = await supabaseBackend
      .from('audit_stock_analysis')
      .select('anomaly_level')
      .eq('run_id', runId);

    if (error) throw error;

    const stats = {
      total: analysis.length,
      ok: analysis.filter(a => a.anomaly_level === 'ok').length,
      warning: analysis.filter(a => a.anomaly_level === 'warning').length,
      critical: analysis.filter(a => a.anomaly_level === 'critical').length
    };

    return res.json({ success: true, stats });

  } catch (error) {
    console.error('❌ Error getting audit stats:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * NEW: Cyclic Count Sync endpoint
 * POST /api/cyclic-sync
 */
app.post('/api/cyclic-sync', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    console.log('🔄 Cyclic Count sync triggered...');

    // Import sync utilities
    const { performFullSync } = require('./sync-utils');
    
    // Perform manual sync
    const result = await performFullSync(supabaseBackend, false);
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Sync error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get Cyclic Count Sync Status
 * GET /api/cyclic-sync-status
 */
app.get('/api/cyclic-sync-status', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    const { getSyncStatus } = require('./sync-utils');
    const status = await getSyncStatus(supabaseBackend);
    
    res.json({
      success: true,
      status
    });
    
  } catch (error) {
    console.error('❌ Error getting sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Manual sync endpoint - syncs only products in audit_products list
 * Limited to 3 requests per day per client (enforced client-side via localStorage)
 * POST /api/sync-audit-data
 */
app.post('/api/sync-audit-data', async (req, res) => {
  try {
    if (!supabaseBackend) {
      return res.status(503).json({ 
        success: false, 
        error: 'Backend Supabase not configured' 
      });
    }

    console.log('🔄 Manual sync triggered for audit products...');

    // Get list of products in audit_products
    const { data: auditProducts, error: prodError } = await supabaseBackend
      .from('audit_products')
      .select('sku, dear_product_id')
      .eq('is_active', true);

    if (prodError) throw prodError;

    const skuList = auditProducts.map(p => p.sku);
    console.log(`📦 Syncing ${skuList.length} products from audit list`);

    // Calculate week dates for sales orders
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    
    const periodStart = weekAgo.toISOString().split('T')[0];
    const periodEnd = today.toISOString().split('T')[0];

    // Run audit with filtered products
    const {
      runWeeklyStockAudit,
      generateStockAnalysisForRun
    } = require('./cin7-sync-service');

    const run = await runWeeklyStockAudit(periodStart, periodEnd, supabaseBackend);
    await generateStockAnalysisForRun(run.id, supabaseBackend);

    console.log(`✅ Sync completed - Run ID: ${run.id}`);

    return res.json({
      success: true,
      productsCount: auditProducts.length,
      runId: run.id,
      periodStart,
      periodEnd
    });

  } catch (error) {
    console.error('❌ Sync error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Fetch single product from DEAR API by SKU
 * POST /api/fetch-product
 * Body: { sku: string }
 */
app.post('/api/fetch-product', async (req, res) => {
  try {
    const { sku } = req.body;
    
    if (!sku) {
      return res.status(400).json({ success: false, error: 'SKU required' });
    }

    // Use DEAR API to fetch product
    const { callCin7Api } = require('./cin7-sync-service');
    
    const productData = await callCin7Api(`/product?sku=${encodeURIComponent(sku)}`);
    
    if (!productData || productData.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found in DEAR' });
    }

    const product = Array.isArray(productData) ? productData[0] : productData;

    return res.json({
      success: true,
      id: product.ID,
      sku: product.SKU,
      name: product.Name,
      category: product.Category
    });

  } catch (error) {
    console.error('❌ Error fetching product:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Export for Vercel serverless
module.exports = app;
