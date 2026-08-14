/* Agent UI service worker — cache shell assets only.
 * Never intercepts WebSocket or mutates API semantics beyond offline fallback.
 * Bump CACHE when shipping UI that must invalidate old shells. */
const CACHE = 'agent-ui-shell-v7';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/style.css?v=ui-9',
  '/style.css',
  '/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/icon-180.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isApiOrRealtime(url) {
  const p = url.pathname;
  return (
    p.startsWith('/api/')
    || p.startsWith('/ws/')
    || p === '/machine-connect'
    || p.startsWith('/machine/')
    || p === '/healthz'
  );
}

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (isApiOrRealtime(url)) return false;
  return /\.(?:js|css|png|svg|webp|ico|woff2?|ttf|map|webmanifest)(?:$|\?)/i.test(url.pathname + url.search)
    || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Let the browser handle API + anything that might upgrade to WebSocket.
  if (isApiOrRealtime(url)) return;

  // Cross-origin (CDN daisyui/tailwind/marked): network only — do not cache opaque forever.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first so deploys show up; offline → cached shell.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          if (res.ok) {
            caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html') || await caches.match('/');
          return cached || caches.match('/offline.html');
        }),
    );
    return;
  }

  // Same-origin static modules: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
