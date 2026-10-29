// Caches the static shell only. API responses and media are never cached here.
const CACHE = 'capnslog-shell-v2';
const SHELL = [
  '/', '/index.html', '/style.css', '/theme.js', '/app.js', '/blocks.js', '/crypto.js', '/sync.js', '/api.js',
  '/store.js', '/search.js', '/sections.js', '/importer.js', '/sanitize.js', '/highlight.js', '/sortkey.js', '/kdf-worker.js', '/vendor/argon2.umd.min.js',
  '/manifest.webmanifest', '/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))),
  );
});
