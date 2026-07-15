/**
 * Push-only Service Worker for the Task Management module.
 *
 * ⚠️ INTENTIONALLY MINIMAL. This worker has ONLY "push" + "notificationclick"
 * handlers. It has NO "fetch" handler and touches NO Cache Storage — so it can
 * never reintroduce the stale-`/_next/static/*`-chunk class of bug that the
 * old caching sw.js caused (see public/sw.js + ServiceWorkerRegister.tsx).
 *
 * ServiceWorkerRegister.tsx unregisters every installed SW on each page load
 * EXCEPT the one whose scriptURL contains "push-sw" — i.e. this file is the
 * single spared worker. Keep the "push-sw" substring in this file's name.
 *
 * Do NOT add a "fetch" listener, importScripts of a caching lib, or any
 * caches.* call here. If you ever need offline assets, do it elsewhere with a
 * network-first strategy — never in this push worker.
 */

// Take control ASAP so a freshly-subscribed client can receive pushes without
// requiring a reload. (No caching implications — there is no fetch handler.)
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * Incoming push. Payload is a JSON string: { title, body, url, tag? }.
 * Falls back to sane defaults if the payload is missing or unparseable so a
 * notification still shows (some platforms drop pushes with no visible UI).
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch (_e) {
    try {
      data = { body: event.data ? event.data.text() : '' };
    } catch (_e2) {
      data = {};
    }
  }

  const title = (data && data.title) || 'Task update';
  const options = {
    body: (data && data.body) || '',
    // App icon lives under /public. If absent the browser uses its own glyph.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Collapse repeat pushes about the same task into one notification.
    tag: (data && data.tag) || undefined,
    data: { url: (data && data.url) || '/tasks/my' },
    // Let the user dismiss/act rather than auto-vanish.
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/**
 * Notification tapped → focus an existing app tab (navigating it to the target
 * url) or open a new one.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/tasks/my';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        // Reuse any open tab of this origin.
        if ('focus' in client) {
          try {
            if ('navigate' in client) await client.navigate(targetUrl);
          } catch (_e) {
            /* cross-origin or navigation blocked — just focus */
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })(),
  );
});
