/* Finance_Care — service worker : garde l'application sur le téléphone pour l'ouvrir hors ligne.
 * Ne touche jamais aux échanges avec Microsoft/OneDrive (autres domaines) : ils passent toujours par le réseau. */
const VERSION = 'fc-mobile-3';
const SHELL = ['./', 'index.html', 'styles.css', 'mobile.css', 'config.js', 'csvformat.js', 'sync.js', 'calc.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Réseau d'abord (pour recevoir les mises à jour), sinon la copie gardée sur le téléphone. */
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const isPage = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(isPage ? './' : e.request, copy)); }
      return r;
    }).catch(() => caches.match(isPage ? './' : e.request, { ignoreSearch: isPage }).then((r) => r || caches.match('index.html')))
  );
});
