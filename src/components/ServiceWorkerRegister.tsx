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
 * If you ever want to re-introduce a SW, do it with:
 *   - network-first for /_next/static/* (NOT cache-first)
 *   - or a hash-aware purge on activate that aggressively kills old chunks
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          await r.unregister();
        }
        if (regs.length > 0) {
          console.log(`[sw] unregistered ${regs.length} service worker(s)`);
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
