// Service Worker: オフラインでも起動できるようにアプリ本体をキャッシュする
// アプリのファイルを変更したら VERSION を上げる

const VERSION = 'v1';
const CACHE = `yarukoto-${VERSION}`;

const APP_SHELL = [
  './',
  'index.html',
  'style.css',
  'dates.js',
  'store.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('yarukoto-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // GitHub API (同期) はキャッシュしない
  if (url.origin !== self.location.origin && url.hostname !== 'cdnjs.cloudflare.com') return;
  event.respondWith(staleWhileRevalidate(request));
});

// キャッシュを即返しつつ裏で更新 (次回起動時に反映)
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const network = fetch(request)
    .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  if (request.mode === 'navigate') return cache.match('index.html');
  return Response.error();
}

// 通知をタップしたらアプリを開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) return windows[0].focus();
    return self.clients.openWindow('./');
  })());
});
