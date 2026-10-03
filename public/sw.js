// 离线外壳缓存：API 请求一律网络优先（失败由页面自身的 localStorage 缓存接管）。
const CACHE = 'fdr-shell-v1';
const SHELL = ['/app.css', '/app.js', '/index.html', '/host.html', '/host.js',
  '/field.html', '/field.js', '/editor.html', '/editor.js'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // 不拦截 API：页面用 fetch 失败 + 本地缓存处理离线
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('/field.html'))));
});
