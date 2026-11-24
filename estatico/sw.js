/* CobraYa · service worker
   Guarda el "cascarón" de la app para que abra rápido y funcione sin señal.
   Las llamadas a /api/ siempre van a la red: nunca se cachean ventas. */

const CACHE = 'cobraya-v6';
const CASCARON = [
  '/',
  '/index.html',
  '/estilos.css',
  '/demo.js',
  '/app.js',
  '/manifest.webmanifest',
  '/iconos/favicon.svg',
  '/iconos/icono-192.png',
  '/iconos/icono-512.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CASCARON)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((claves) =>
      Promise.all(claves.filter((clave) => clave !== CACHE).map((clave) => caches.delete(clave)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Red primero: así una actualización de la app llega apenas hay internet.
  // Si no hay señal, se responde con la copia guardada (modo offline).
  evento.respondWith(
    fetch(peticion)
      .then((respuesta) => {
        if (respuesta && respuesta.ok && respuesta.type === 'basic') {
          const copia = respuesta.clone();
          caches.open(CACHE).then((cache) => cache.put(peticion, copia));
        }
        return respuesta;
      })
      .catch(() =>
        caches.match(peticion).then((guardado) => {
          if (guardado) return guardado;
          if (peticion.mode === 'navigate') return caches.match('/');
          return new Response('Sin conexión', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
        })
      )
  );
});
