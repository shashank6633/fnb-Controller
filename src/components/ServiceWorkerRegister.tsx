'use client';

import { useEffect } from 'react';

/**
 * Service Worker DISABLER. Previously this component *registered* an SW that
 * cached /_next/static/* chunks aggressively — which caused a stale-chunk
 * class of bug after deploys: React lazy-loads an old chunk hash from the SW
 * cache, the chunk calls a Server Action ID the new server doesn't know,
 * navigation hard-fails, Safari shows "This page couldn't load".
 *
 * The component name is kept so the existing layout import keeps working,
 * but it now actively UNREGISTERS any installed SW and purges its caches.
 * Every page load self-heals affected browsers.
 *
 * ⚠️ ONE EXCEPTION: the push-only worker (public/push-sw.js, registered by
 * PushEnable.tsx) is SPARED. It has ONLY push + notificationclick handlers and
 * NO fetch/cache logic, so it can never reintroduce the stale-chunk bug this
 * component exists to prevent. We identify it by "push-sw" in its scriptURL and
 * leave it registered; the old caching sw.js (and anything else) is still
 * unregistered on every load.
 *
 * If you ever want to re-introduce a caching SW, do it with:
 *   - network-first for /_next/static/* (NOT cache-first)
 *   - or a hash-aware purge on activate that aggressively kills old chunks
 */

/** A registration is the spared push worker if any of its SW scripts is push-sw. */
function isPushWorker(r: ServiceWorkerRegistration): boolean {
  const url =
    r.active?.scriptURL || r.waiting?.scriptURL || r.installing?.scriptURL || '';
  return url.includes('push-sw');
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        let unregistered = 0;
        for (const r of regs) {
          // Spare the push-only worker; unregister everything else (incl. the
          // old caching sw.js).
          if (isPushWorker(r)) continue;
          await r.unregister();
          unregistered++;
        }
        if (unregistered > 0) {
          console.log(`[sw] unregistered ${unregistered} service worker(s)`);
        }
        // Purge every cache the old SW created so stale chunks don't linger.
        if (typeof caches !== 'undefined') {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
          if (keys.length > 0) {
            console.log(`[sw] purged ${keys.length} cache(s)`);
            // The in-memory router may still hold stale chunk references.
            // Force a one-time reload so the page comes up entirely clean.
            if (!sessionStorage.getItem('__sw_purge_reloaded__')) {
              sessionStorage.setItem('__sw_purge_reloaded__', '1');
              window.location.reload();
            }
          }
        }
      } catch (err) {
        console.warn('[sw] unregister failed:', err);
      }
    })();
  }, []);
  return null;
}
