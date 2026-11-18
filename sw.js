"use strict";

const scope = self.registration.scope;
const cachePrefix = `otodana:${scope}:`;
const cacheName = `${cachePrefix}v1`;
const index = new URL("index.html", scope).href;
const assets = [
  "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
].map((path) => new URL(path, scope).href);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(
    assets.map((url) => new Request(url, { cache: "reload" })),
  )));
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
  const url = request.url;
  const key = request.mode === "navigate" && url === scope ? index : url;
  if (!assets.includes(key)) return;
  event.respondWith(caches.open(cacheName).then(async (cache) => {
    return (await cache.match(key)) ?? fetch(request);
  }));
});
