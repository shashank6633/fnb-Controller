'use client';

/**
 * Polls /api/build-info every minute. When the server returns a different
 * build_id from what we first saw, shows a small toast and reloads the
 * page after 3 seconds.
 *
 * Why this exists: deploying a new build invalidates Server Action IDs from
 * the previous build. A tab opened before the deploy will throw
 * "Failed to find Server Action 'x'" on next navigation, causing a hard
 * page-load failure (Safari's "This page couldn't load"). This watcher
 * auto-recovers stale tabs within one poll cycle of every deploy.
 *
 * Mounted once globally in src/app/layout.tsx. Renders nothing during
 * normal operation; renders a toast banner when a reload is imminent.
 */

import { useEffect, useState } from 'react';

const POLL_MS = 60_000;
const RELOAD_COUNTDOWN_SEC = 3;
// The build id THIS bundle was compiled with (git SHA, baked at build time).
// If the server reports a different id, this running bundle is stale.
const BAKED_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID || '';

export default function BuildVersionWatcher() {
  const [needsReload, setNeedsReload] = useState(false);
  const [countdown, setCountdown] = useState(RELOAD_COUNTDOWN_SEC);

  useEffect(() => {
    let firstBuildId: string | null = null;
    let cancelled = false;

    const check = async () => {
      try {
        const r = await fetch('/api/build-info', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        const id = j?.build_id;
        if (!id || cancelled) return;
        // (1) ALREADY STALE: this bundle was built at a different version than the
        // server is now running (e.g. it was served from cache after a deploy).
        // The old watcher missed this because it baselined off the first poll.
        if (BAKED_BUILD_ID && id !== BAKED_BUILD_ID) {
          // Reload at most once per detected server version, so a stubborn cache
          // can never cause a reload loop.
          if (sessionStorage.getItem('bvw_reloaded_for') !== id) {
            sessionStorage.setItem('bvw_reloaded_for', id);
            setNeedsReload(true);
          }
          return;
        }
        // (2) DEPLOYED WHILE OPEN: server id changed since we first looked.
        if (firstBuildId === null) { firstBuildId = id; return; }
        if (id !== firstBuildId) setNeedsReload(true);
      } catch { /* offline / network blip — ignore */ }
    };

    // First check after 5s so stale tabs detect deploys quickly; then every minute.
    const initial = setTimeout(check, 5_000);
    const interval = setInterval(check, POLL_MS);
    // Also re-check when the tab regains focus (tablets left open on a table).
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, []);

  // Countdown + auto-reload once a stale build is detected
  useEffect(() => {
    if (!needsReload) return;
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); forceReload(); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [needsReload]);

  if (!needsReload) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] bg-blue-600 text-white rounded-lg shadow-lg px-4 py-3 text-sm flex items-center gap-3 max-w-md">
      <span>
        🔄 A new version was deployed. Refreshing in <strong>{countdown}s</strong> so you&apos;re on the latest…
      </span>
      <button onClick={forceReload}
              className="bg-white text-blue-700 px-3 py-1 rounded text-xs font-medium hover:bg-blue-50">
        Refresh now
      </button>
    </div>
  );
}

/** Purge the service worker + all caches, THEN reload — so a stale bundle is
 *  actually replaced (a plain reload can be re-served from the SW/HTTP cache). */
async function forceReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* best effort */ }
  window.location.reload();
}
