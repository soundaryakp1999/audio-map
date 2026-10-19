// Opening the app fetches the page from the network, so every fresh open runs the latest build; the
// app's other files are stale-while-revalidate, so it still opens offline after one visit. Coming
// back from the background is not an open: the page is still there and keeps its state.
// Map data has its own caches (Overpass responses in Cache Storage), so other origins are left alone.
const CACHE = 'audio-map-shell-v1';
/** How long an open waits for the network before the saved page opens instead (ms). */
const FRESH_WAIT = 3000;

// Built files carry a content hash (assets/index-AbC123xy.js); once a new one is stored, earlier builds of it are dead weight.
const HASHED = /^(.*\/assets\/.+)-[A-Za-z0-9_-]{8}\.(\w+)$/;
async function dropOldBuilds(cache, req) {
  const m = new URL(req.url).pathname.match(HASHED);
  if (!m) return;
  for (const k of await cache.keys()) {
    const n = new URL(k.url).pathname.match(HASHED);
    if (n && n[1] === m[1] && n[2] === m[2] && k.url !== req.url) await cache.delete(k);
  }
}

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('audio-map-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** A response a navigation can use: browsers refuse one that was redirected. */
function servable(res) {
  return res.redirected ? new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }) : res;
}

/**
 * Opening the app: the page from the network, checked against the server (the browser's own cache
 * may hold it for minutes). Its scripts are named by their hash, so a fresh page brings them too.
 * Offline, or with a signal too weak to answer in FRESH_WAIT, the saved page opens, and it is told
 * when a newer one arrives so that it can reload while still on the home screen.
 */
async function openPage(e) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req, { ignoreSearch: true });
  // a navigation request cannot be copied with new options, so it is fetched by its address
  const fresh = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async (res) => {
    if (res.ok) await cache.put(req, res.clone());
    return res;
  });
  if (!saved) return fresh.then(servable, () => Response.error());
  const savedText = saved.clone().text();
  const first = await Promise.race([fresh.catch(() => null), new Promise((r) => setTimeout(r, FRESH_WAIT, null))]);
  if (first?.ok) return servable(first);
  e.waitUntil(
    fresh
      .then(async (res) => {
        if (!res.ok || (await res.clone().text()) === (await savedText)) return;
        for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'updated' });
      })
      .catch(() => {}),
  );
  return saved;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(openPage(e));
  const cached = caches.open(CACHE).then(async (cache) => ({ cache, hit: await cache.match(req, { ignoreSearch: true }) }));
  const update = cached
    .then(({ cache }) =>
      fetch(req).then(async (res) => {
        if (res.ok) {
          await cache.put(req, res.clone());
          await dropOldBuilds(cache, req);
        }
        return res;
      }),
    )
    .catch(() => null);
  // waitUntil keeps the worker alive until the refresh is stored, even when the cached copy was served
  e.waitUntil(update);
  e.respondWith(cached.then(async ({ hit }) => hit ?? (await update) ?? Response.error()));
});
