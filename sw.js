/* 歌谱搜索 Service Worker：应用壳离线可用 */
const CACHE = 'scorefinder-v0.6.3';
const CORE = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/util.js',
  './js/store.js',
  './js/dict.js',
  './js/search.js',
  './js/viewer.js',
  './js/configlink.js',
  './js/sources/index.js',
  './js/sources/imported.js',
  './js/sources/fsafolder.js',
  './js/sources/drive.js',
  './js/sources/lanserver.js',
  './data/t2s.json',
  './data/pinyin.json',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  // pdf.js v6 解码扫描件（CCITT/JBIG2、JPEG2000、ICC）需要的 wasm
  './vendor/pdfjs/wasm/jbig2.wasm',
  './vendor/pdfjs/wasm/openjpeg.wasm',
  './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/wasm/quickjs-eval.wasm',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './vendor/qrcode.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        CORE.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((r) => (r.ok ? cache.put(url, r) : null))
            .catch(() => null)
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // 导航请求：离线时回退到缓存的 index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      (async () => {
        try {
          const r = await fetch(e.request);
          const cache = await caches.open(CACHE);
          cache.put('./index.html', r.clone());
          return r;
        } catch {
          return (await caches.match('./index.html')) || Response.error();
        }
      })()
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  if (/\.(m?js|css|json|png|svg|woff2?|ttf|bcmap|wasm)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    e.respondWith(
      (async () => {
        const cached = await caches.match(e.request, { ignoreSearch: true });
        const network = fetch(e.request)
          .then(async (r) => {
            if (r.ok) {
              const cache = await caches.open(CACHE);
              cache.put(e.request, r.clone());
            }
            return r;
          })
          .catch(() => null);
        return cached || (await network) || Response.error();
      })()
    );
  }
});
