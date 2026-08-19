'use client';

/**
 * Hard Refresh — one tap that makes THIS device load the app completely fresh.
 * Owner request 2026-08-17: top-right, beside the profile circle, everywhere
 * (desktop site, mobile web/PWA, the captain Android TWA and iPhones added to
 * the home screen — all four render this same web UI, so one button covers
 * them all; no APK change involved).
 *
 * WHAT ONE TAP DOES, in order:
 *   1. asks the service worker to check for a newer version of itself
 *      (registration.update()), so a waiting SW can take over on the reload;
 *   2. deletes every Cache API bucket (the PWA's offline shell + anything
 *      public/sw.js has cached) — this is the part a plain reload cannot do;
 *   3. location.reload() — the app comes back from the network, and
 *      ServiceWorkerRegister re-registers the SW cleanly on boot.
 *
 * Deliberately NOT unregistering the service worker: killing the registration
 * would also break offline KOT printing paths until the next visit re-installs
 * it; clearing its caches + reloading gets fresh files without touching
 * installability.
 *
 * Relationship to BuildVersionWatcher: that auto-reloads every device shortly
 * after a deploy. This button exists for the stubborn tail — a tablet showing
 * stale data mid-shift, a webview that skipped the watcher — and doubles as
 * the "make it fresh" ritual staff can be taught instead of the browser menu.
 *
 * Every step is try/caught: on a browser with no SW / no Cache API (plain
 * desktop tab) the button degrades to a simple reload, which is still what
 * the person asked for.
 */

import { useState } from 'react';
import { RotateCw } from 'lucide-react';

export default function HardRefreshButton({ dark = false }: {
  /** MobileTopBar sits on the near-black brown; UserBar on white. */
  dark?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const hardRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      if (regs) await Promise.all(regs.map(r => r.update().catch(() => {})));
    } catch { /* no SW — fine */ }
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch { /* no Cache API — fine */ }
    // Reload regardless of what the cleanup managed — never strand the tap.
    window.location.reload();
  };

  return (
    <button
      onClick={hardRefresh}
      disabled={busy}
      title="Hard refresh — reload the app with completely fresh files"
      aria-label="Hard refresh"
      className={
        dark
          ? 'flex items-center justify-center w-9 h-9 rounded-md text-[#E8D5C4] hover:bg-[#2E1A0C] active:bg-[#3D2614] transition-colors disabled:opacity-60'
          : 'p-1.5 rounded-full text-[#6B5744] hover:text-[#af4408] hover:bg-[#FFF1E3] transition-colors disabled:opacity-60'
      }
    >
      <RotateCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
    </button>
  );
}
