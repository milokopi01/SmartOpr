const CACHE_NAME = 'opr-sks-v1';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './Sekolah_Kebangsaan_Selama.jpg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          return response || fetch(event.request);
        })
    );
  }
});
