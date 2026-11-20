const CACHE_NAME = 'decloc-shell-v14';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './manifest.json',
  './icon.svg',
  './README.md',
  './js/i18n.js',
  './js/emojis.js',
  './js/crypto.js',
  './js/storage.js',
  './js/nostr.js',
  './js/webrtc.js',
  './js/notify.js',
  './js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for app files so updates appear quickly, fallback to cache offline
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.endsWith('/decloc-relay.json') ||
    url.pathname.endsWith('/health') ||
    url.pathname.includes('/api/push/')
  ) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// Native Web Push handler (wakes up sleeping/closed Android & iOS PWAs!)
self.addEventListener('push', (event) => {
  let payload = {
    title: 'DecLoc Chat',
    body: 'New encrypted message',
    channelId: null,
    type: 'msg',
  };
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') {
        payload = { ...payload, ...parsed };
      }
    } catch {
      try {
        const text = event.data.text();
        if (text) payload.body = text;
      } catch {
        // use default
      }
    }
  }

  const isCall = payload.type === 'call';
  event.waitUntil(
    self.registration.showNotification(payload.title || 'DecLoc Chat', {
      body: payload.body || (isCall ? 'Incoming call' : 'New encrypted message'),
      icon: './icon.svg',
      badge: './icon.svg',
      tag: payload.channelId ? `decloc-${payload.channelId}` : 'decloc-push',
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [300, 150, 300, 150, 300] : [200, 100, 200],
      data: { channelId: payload.channelId || null },
    })
  );
});

// Clicking an OS notification focuses DecLoc Chat and opens the target room
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const channelId = event.notification.data?.channelId || null;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus();
          if (channelId) {
            client.postMessage({ type: 'OPEN_ROOM', channelId });
          }
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./');
      }
    })
  );
});
