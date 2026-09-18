const CACHE_NAME = 'hermes-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json'
];

// Instalación del Service Worker y cacheo de recursos estáticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Hermes: Recursos cacheados correctamente');
        return cache.addAll(urlsToCache);
      })
  );
});

// Interceptación de peticiones de red para servir desde la caché si es posible
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
    );
});