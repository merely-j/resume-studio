/**
 * Service Worker：让 App 断网也能用（PWA 的关键）
 * ------------------------------------------------------------
 * 策略：
 * - 页面导航：network-first，网络不通时回退到缓存里的 index.html
 * - 静态资源（css/js/图标）：cache-first，命中缓存直接返回，没命中再走网络
 * 改完代码要让用户看到更新，把 CACHE 名字加个版本号即可（必要时引导刷新）。
 */

const CACHE = 'resume-app-v0.3.7';

const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/resume.css',
  './js/app.js',
  './js/model.js',
  './js/preview.js',
  './js/editor.js',
  './js/store.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
