// Offline cache for the app shell only (the game data never leaves the user's IndexedDB).
const CACHE = 'another-world-v5';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'src/web.js', 'src/engine.js', 'src/vm.js', 'src/video.js', 'src/resource.js', 'src/bank.js',
  'src/mixer.js', 'src/tables.js', 'src/storage.js', 'src/zip.js', 'src/i18n.js', 'i18n/languages.json',
  'i18n/en.json', 'i18n/it.json', 'i18n/fr.json', 'i18n/de.json', 'i18n/es.json', 'i18n/pt.json', 'i18n/nl.json', 'i18n/pl.json', 'i18n/ru.json', 'i18n/tr.json', 'i18n/ja.json', 'i18n/ko.json', 'i18n/zh.json',
  'kenney/fonts/kenney-pixel.ttf', 'kenney/input/c_button-a.png', 'kenney/input/c_stick.png',
  'kenney/input/c_menu.png', 'kenney/input/c_pause.png', 'assets/splash.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first so that updates show up, cache as fallback when offline.
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
