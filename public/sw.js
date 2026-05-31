/**
 * Self-destructing Service Worker.
 *
 * The previous SW (commit ~May 2026) cached /_next/static/* chunks with a
 * cache-first strategy. After every deploy this caused stale-chunk failures
 * in browsers that had visited before — React lazy-loaded an old chunk hash
 * from the SW cache, the chunk referenced a Server Action ID the new server
 * didn't know, and navigation hard-failed (Safari "This page couldn't load").
 *
 * This stub:
 *   - Skips waiting + claims clients immediately
 *   - Purges every cache it ever owned
 *   - Unregisters itself
 *
 * Browsers that already installed the old SW will hit this on next update
 * (Workers auto-update every 24h or on hard refresh) and self-clean.
 *
 * Also, src/components/ServiceWorkerRegister.tsx now explicitly unregisters
 * any installed SW on every page load — so most clients won't even get here.
 */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        const reg = await self.registration;
        if (reg) await reg.unregister();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[sw] self-destruct failed:', err);
      }
      try { await self.clients.claim(); } catch { /* ignore */ }
    })()
  );
});

// Don't intercept any fetches. Let the network handle everything.
// (Omitting a fetch handler entirely means the browser treats requests
// as if no SW were installed.)
