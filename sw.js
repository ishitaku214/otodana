"use strict";

const scope = self.registration.scope;
const cachePrefix = `otodana:${scope}:`;
const cacheName = `${cachePrefix}v23`;
const index = new URL("index.html", scope).href;
const assets = [
  "index.html", "style.css?v=23", "app.js?v=23", "queue.js?v=22", "storage.js?v=12", "artwork.js?v=4", "manifest.webmanifest",
  "download.js?v=23", "download-worker.js?v=16",
  "icon-192.png", "icon-512.png",
].map((path) => new URL(path, scope).href);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(assets.map((url) => new Request(url, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (request.mode === "navigate") url.search = "";
  const key = url.href === scope ? index : url.href;
  if (!assets.includes(key)) return;
  event.respondWith(caches.open(cacheName).then(async (cache) => {
    return (await cache.match(key)) ?? fetch(request);
  }));
});
