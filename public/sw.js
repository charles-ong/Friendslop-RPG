// Service worker: shows Web Push notifications ("your turn", nudges) even when
// the site is closed, and opens the right campaign when one is tapped.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const url = new URL(data.url || '', self.registration.scope).href;
  event.waitUntil(
    self.registration.showNotification(data.title || 'Friendslop RPG', {
      body: data.body || "It's your turn!",
      tag: data.tag || 'friendslop',
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus();
        if (open.url !== url) await open.navigate(url).catch(() => null);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
