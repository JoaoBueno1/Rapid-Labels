// Secure & optimized Express server for Rapid Label (no layout changes)
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 8383;

// Basic security headers (CSP kept permissive for current external CDNs)
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'blob:'],
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
