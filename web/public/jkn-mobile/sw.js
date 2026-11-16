// JKN mobile PWAs (demo): app shell cached for offline start; API calls always go to the network.
const CACHE = "jkn-mobile-v1";
const SHELL = ["/jkn-mobile/petugas", "/jkn-mobile/rs", "/jkn-mobile/peserta", "/jkn-mobile/offline.html",
  "/jkn-mobile/petugas-192.png", "/jkn-mobile/rs-192.png", "/jkn-mobile/peserta-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return; // API (other port) and writes: network only
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then((r) => r || caches.match("/jkn-mobile/offline.html"))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && /\/_next\/static\/|\/jkn-mobile\//.test(req.url)) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
