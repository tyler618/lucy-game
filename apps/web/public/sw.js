/**
 * Service worker.
 *
 * Caches the shell and the verifier so both open instantly on a bad
 * connection, and so /verify still works with no network at all — a verifier
 * you can only run while online is not much of a guarantee.
 *
 * Nothing about a round is ever cached. Every /api/ request goes to the
 * network, every time: a cached balance or a cached outcome would be a stale
 * lie about money.
 */
const CACHE = 'ace-shell-v1';
const SHELL = ['/', '/index.html', '/verify', '/verify.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cached, never stale

  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          if (res.ok && event.request.method === 'GET') {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        }),
    ),
  );
});
