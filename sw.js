/* Service worker de la beta: funciona sin cobertura y sirve las fotos desde IndexedDB. */
const VERSION = '20261106192953';
const CACHE = 'cuaderno-beta-' + VERSION;
const FONTS = 'cuaderno-beta-fuentes';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'exportar.html', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

/* Precarga atómica: se descarga todo y solo entonces se guarda en la caché nueva; si algo falla, no queda nada. */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const resp = await Promise.all(SHELL.map(async u => {
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (!r.ok) throw new Error('precarga ' + u + ' ' + r.status);
      return [u, new Response(await r.blob(), { status: 200, headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream' } })];
    }));
    try {
      const c = await caches.open(CACHE);
      for (const [u, r] of resp) await c.put(new Request(u), r);
    } catch (err) { await caches.delete(CACHE); throw err; }
    await self.skipWaiting();
  })());
});
/* las cachés viejas solo se borran al activar */
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cuaderno-beta-') && k !== CACHE && k !== FONTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function blobFromDb(id) {
  return new Promise(res => {
    const r = indexedDB.open('cuaderno-beta');
    r.onupgradeneeded = () => { r.transaction.abort(); };
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const d = r.result;
      try {
        const q = d.transaction('blobs', 'readonly').objectStore('blobs').get(id);
        q.onsuccess = () => { d.close(); res(q.result || null); };
        q.onerror = () => { d.close(); res(null); };
      } catch (e) { d.close(); res(null); }
    };
  });
}

/* caché primero (arranque instantáneo sin cobertura) y actualización en segundo plano */
async function cacheFirst(req, evt) {
  const cache = await caches.open(CACHE);
  const m = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
  const upd = fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : req, { cache: 'no-cache' })
    .then(r => { if (r && r.ok) { const k = new URL(req.url); k.search = ''; return cache.put(k.href, r.clone()).then(() => r); } return r; });
  if (m) { upd.catch(() => {}); evt.waitUntil(upd.catch(() => {})); return m; }
  try { return await upd; } catch (e) { return Response.error(); }
}

/* fuentes: de la caché al momento y se renuevan; sin caché, esperan como mucho 2 s */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(FONTS);
  const m = await cache.match(req);
  const net = fetch(req).then(r => { if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone()); return r; }).catch(() => null);
  if (m) return m;
  return (await Promise.race([net, new Promise(r => setTimeout(() => r(null), 2000))])) || Response.error();
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(staleWhileRevalidate(req)); return;
  }
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  const blobBase = scopePath + '_blob/';
  if (url.pathname.startsWith(blobBase)) {
    const id = decodeURIComponent(url.pathname.slice(blobBase.length));
    e.respondWith(blobFromDb(id).then(row => row && row.blob
      ? new Response(row.blob, { status: 200, headers: { 'content-type': row.blob.type || row.type || 'application/octet-stream' } })
      : new Response('No encontrada', { status: 404 })));
    return;
  }
  if (!url.pathname.startsWith(scopePath)) return;
  e.respondWith(cacheFirst(req, e));
});
