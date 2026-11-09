// Service Worker — khuôn TechOP-OS v1.2. Chỉ lưu đệm vỏ trang cùng tên miền.
// KHÔNG chặn /api/ và KHÔNG trả phản hồi giả khi mất mạng: việc gửi lại do outbox.js ở trang đảm nhận.
const CACHE = 'ctv-platform-lead-identity-1.2';
const SHELL = ['./', './index.html', './outbox.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;
  // Mạng trước để khách luôn thấy bản mới; mất mạng thì dùng bản đệm. cache: 'no-cache' ép trình duyệt
  // luôn hỏi lại máy chủ (If-None-Match) thay vì tự trả bản HTTP cache cũ trước khi SW kịp can thiệp.
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
