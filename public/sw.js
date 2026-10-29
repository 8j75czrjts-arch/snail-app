// App-shell cache so the app opens instantly and still opens with no signal. Data is never
// cached here; it comes from /api and the app keeps its own copy in localStorage.
// Also shows the push nags. Bump VERSION when shipping changes so installed copies pick them up.
const VERSION = "sn-1";
const SHELL = [
  "/", "/index.html", "/css/app.css", "/manifest.webmanifest",
  "/js/app.js", "/js/api.js", "/js/state.js", "/js/logic.js", "/js/views.js", "/js/music.js", "/js/notify.js",
  "/icons/icon-192.png", "/icons/apple-touch-icon.png",
  "/assets/fonts/caveat-latin-600-normal.woff2", "/assets/fonts/caveat-latin-700-normal.woff2", "/assets/fonts/gochi-hand-latin-400-normal.woff2",
  "/assets/bottles/bottle-full.svg", "/assets/bottles/bottle-empty.svg",
  "/assets/snail/snail-0-thirsty.svg", "/assets/snail/snail-1-diva.svg", "/assets/snail/snail-2-hat.svg", "/assets/snail/snail-3-bowtie.svg",
  "/assets/snail/snail-4-singing.svg", "/assets/snail/snail-dead.svg", "/assets/snail/snail-baby-swaddle.svg",
  "/assets/ui/arrow-back.svg", "/assets/ui/box.svg", "/assets/ui/box-short.svg", "/assets/ui/box-dashed.svg", "/assets/ui/btn-blue.svg",
  "/assets/ui/btn-green.svg", "/assets/ui/btn-plain.svg", "/assets/ui/btn-yellow.svg", "/assets/ui/eq-bars.svg", "/assets/ui/input.svg",
  "/assets/ui/line.svg", "/assets/ui/now-playing.svg", "/assets/ui/underline.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api")) return;
  // Stale-while-revalidate: answer from cache, refresh the cache in the background.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* plain text */ }
  e.waitUntil(self.registration.showNotification(d.title || "Snail Natra", {
    body: d.body || "He wants water.",
    tag: d.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow((e.notification.data && e.notification.data.url) || "/");
  }));
});
