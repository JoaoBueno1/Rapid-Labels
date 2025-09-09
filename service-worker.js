const CACHE_NAME = 'rapid-label-shell-v4'; // bump
// Só assets realmente estáticos
const ASSETS = [
  '/styles.css',
  '/favicon.svg',
  '/icon-192.svg',
  '/icon-512.svg',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).catch(err => {
      console.warn('Pre-cache failed:', err);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isStatic = url.origin === self.location.origin && ASSETS.includes(url.pathname);

  if (isStatic) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
        return res;
      }))
    );
    return;
  }

  // Network-first para HTML e JS do app (evita ficar preso à versão antiga)
  if (url.origin === self.location.origin && /\.(html|js)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
        return res;
      }).catch(()=>caches.match(req))
    );
    return;
  }

  // Demais (CDNs etc) network-first simples
  event.respondWith(fetch(req).catch(()=>caches.match(req)));
});
