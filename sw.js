// Сервис-воркер: приложение работает без интернета.
const CACHE = 'notebook-notes-v1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/render.js',
  './js/library.js',
  './js/editor.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть (чтобы получать обновления), при отсутствии сети — кэш.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
      .then((r) => r || new Response('', { status: 504 })),
  );
});
