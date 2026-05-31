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
        if (!id) return;
        if (firstBuildId === null) {
          firstBuildId = id;
          return;
        }
        if (id !== firstBuildId && !cancelled) {
          setNeedsReload(true);
        }
      } catch { /* offline / network blip — ignore */ }
    };

    // First check after 5s so stale tabs detect deploys quickly; then every minute.
    const initial = setTimeout(check, 5_000);
    const interval = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); };
  }, []);

  // Countdown + auto-reload once stale build is detected
  useEffect(() => {
    if (!needsReload) return;
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(id);
          if (typeof window !== 'undefined') window.location.reload();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [needsReload]);

  if (!needsReload) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[100] bg-blue-600 text-white rounded-lg shadow-lg px-4 py-3 text-sm flex items-center gap-3 max-w-md">
      <span>
        🔄 A new version was deployed. Reloading in <strong>{countdown}s</strong> so you don&apos;t get a stale-bundle error…
      </span>
      <button onClick={() => window.location.reload()}
              className="bg-white text-blue-700 px-3 py-1 rounded text-xs font-medium hover:bg-blue-50">
        Reload now
      </button>
    </div>
  );
}
