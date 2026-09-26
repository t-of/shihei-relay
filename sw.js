// オフライン用のサービスワーカー。
//
// 自分のファイルは network-first（つながっていれば常に最新、圏外なら保存しておいた版）。
// Google Fonts は変わらないので cache-first。
//
// 注意: キャッシュ（CacheStorage）は t-of.github.io のすべてのアプリで共有されている。
// 古いキャッシュを消すときは、必ず自分の PREFIX で始まるものだけを消す。
// keys.filter(k => k !== CACHE) のように書くと、ほかのアプリのキャッシュまで消してしまう。

const PREFIX = 'shihei-relay-';
const VERSION = 'v3';
const CACHE = `${PREFIX}${VERSION}`;
const FONT_CACHE = `${PREFIX}fonts`;
// 文字を読む部品（Tesseract の本体・作業用スクリプト・学習データ）は初めてカメラを使ったときだけ
// ここに入る（下の fetch ハンドラ）。install ではあらかじめ読み込まない（重いため）。
const OCR_CACHE = `${PREFIX}ocr-v1`;

const SHELL = [
  './',
  './index.html',
  './style.css',
  './firebase-config.js',
  './manifest.webmanifest',
  './webapp-kit/webapp-kit.css',
  './webapp-kit/webapp-kit.js',
  './js/app.js',
  './js/bill.js',
  './js/geo.js',
  './js/map.js',
  './js/camera.js',
  './js/firebase.js',
  './js/sound.js',
  './data/muni.json',
  './data/japan.svg',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== FONT_CACHE && k !== OCR_CACHE)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.includes('/vendor/tesseract/')) {
      e.respondWith(cacheFirst(req, OCR_CACHE)); // 大きいので、初めて読んだときだけキャッシュに入る
    } else {
      e.respondWith(networkFirst(req));
    }
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(cacheFirst(req, FONT_CACHE));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./index.html')) || Response.error();
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
