// Service worker do Habblaud: só os avisos no celular (Web Push). Não guarda nada em cache (o escritório é ao vivo).
// O conteúdo chega cifrado pelo serviço de push e o navegador decifra antes deste evento (server/push/webpush.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof msg.title === 'string' && msg.title ? msg.title : 'Habblaud';
  const url = typeof msg.url === 'string' && msg.url.startsWith('/') ? msg.url : '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof msg.body === 'string' ? msg.body : '',
      tag: typeof msg.tag === 'string' ? msg.tag : undefined,
      renotify: !!msg.urgent,
      icon: '/assets/brand/icon-192.png',
      badge: '/assets/brand/favicon-32.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if (new URL(c.url).origin === url.origin) {
          await c.focus();
          c.postMessage({ type: 'habblaud:open', url: url.pathname + url.search });
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
