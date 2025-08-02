const CACHE_NAME = 'lunaretmap-cache-v4';
const urlsToCache = [
  'index.html',
  'en/index.html',
  'es/index.html',
  'nl-be/index.html',
  'index.js',
  'styles.css',
  'i18n/fr.json',
  'i18n/en.json',
  'i18n/es.json',
  'i18n/nl-BE.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      )
    )
  );
});