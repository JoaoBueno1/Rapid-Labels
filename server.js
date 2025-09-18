// Secure & optimized Express server for Rapid Label (no layout changes)
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const net = require('net');

const app = express();
const PORT = process.env.PORT || 8383;
const PRINTER_HOST = process.env.PRINTER_HOST || '127.0.0.1';
const PRINTER_PORT = parseInt(process.env.PRINTER_PORT || '9100', 10);

// Basic security headers (CSP kept permissive for current external CDNs)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", 'data:', 'blob:', 'https://iaqnxamnjftwqdbsnfyl.supabase.co'],
      "connect-src": ["'self'", "https://iaqnxamnjftwqdbsnfyl.supabase.co"],
      "font-src": ["'self'", "data:"],
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

app.listen(PORT, () => {
  console.log(`🚀 Rapid Label server running at http://localhost:${PORT}`);
});

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
