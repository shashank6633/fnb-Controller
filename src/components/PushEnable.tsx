'use client';

/**
 * PushEnable — opt-in control for Task-module browser push notifications.
 *
 * Flow on click:
 *   1. Notification.requestPermission()
 *   2. register /push-sw.js (scope "/")  — the push-only worker, spared by
 *      ServiceWorkerRegister.tsx
 *   3. GET /api/tasks/push/vapid → applicationServerKey
 *   4. pushManager.subscribe({ userVisibleOnly, applicationServerKey })
 *   5. POST the serialized subscription to /api/tasks/push/subscribe
 *
 * Fully feature-detected: renders an unobtrusive "not supported" note where
 * the browser lacks Notification / serviceWorker / PushManager, and surfaces
 * the current permission state (default / granted / denied). Best-effort — a
 * failure never throws into the page, only sets an inline status message.
 *
 * Safe to drop anywhere (e.g. /tasks/settings or /tasks/notifications). No
 * props required.
 */

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellRing, BellOff, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type Supported = 'unknown' | 'yes' | 'no';

/** Convert a base64url VAPID public key to the Uint8Array the API expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  // Allocate a concrete ArrayBuffer (not ArrayBufferLike) so the result is a
  // valid BufferSource for applicationServerKey under lib.dom's typings.
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function PushEnable() {
  const [supported, setSupported] = useState<Supported>('unknown');
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>('');

  // Feature-detect + reflect current permission/subscription state on mount.
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !('Notification' in window) ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      setSupported('no');
      return;
    }
    setSupported('yes');
    setPermission(Notification.permission);

    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          setSubscribed(!!sub);
        }
      } catch {
        /* ignore — treat as not subscribed */
      }
    })();
  }, []);

  const enable = useCallback(async () => {
    setBusy(true);
    setMsg('');
    try {
      // 1. Permission
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setMsg(
          perm === 'denied'
            ? 'Notifications are blocked. Enable them in your browser site settings, then try again.'
            : 'Permission not granted.',
        );
        return;
      }

      // 2. Register the push-only worker.
      const reg = await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;

      // 3. VAPID public key.
      const vapidRes = await api('/api/tasks/push/vapid');
      if (!vapidRes.ok) {
        setMsg('Could not load the push key. Try again later.');
        return;
      }
      const { publicKey } = (await vapidRes.json()) as { publicKey?: string };
      if (!publicKey) {
        setMsg('Push is not configured on the server yet.');
        return;
      }

      // 4. Subscribe (reuse an existing subscription if present).
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
        });
      }

      // 5. Persist server-side (bound to the signed-in user).
      const saveRes = await api('/api/tasks/push/subscribe', {
        method: 'POST',
        body: sub.toJSON(),
      });
      if (!saveRes.ok) {
        setMsg('Subscribed in the browser but could not save on the server.');
        return;
      }

      setSubscribed(true);
      setMsg('Push notifications enabled on this device.');
    } catch (e) {
      console.error('PushEnable failed:', e);
      setMsg('Could not enable push notifications on this device.');
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setMsg('');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/push-sw.js');
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const endpoint = sub.endpoint;
        try {
          await sub.unsubscribe();
        } catch {
          /* ignore — still tell the server to drop it */
        }
        await api('/api/tasks/push/subscribe', {
          method: 'DELETE',
          body: { endpoint },
        });
      }
      setSubscribed(false);
      setMsg('Push notifications turned off on this device.');
    } catch (e) {
      console.error('PushEnable disable failed:', e);
      setMsg('Could not turn off push notifications.');
    } finally {
      setBusy(false);
    }
  }, []);

  // --- render ---------------------------------------------------------------

  if (supported === 'no') {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3 text-sm text-[#6B5744]">
        <BellOff className="mt-0.5 h-4 w-4 shrink-0 text-[#8B7355]" />
        <span>This browser does not support push notifications.</span>
      </div>
    );
  }

  const blocked = permission === 'denied';

  return (
    <div className="rounded-lg border border-[#E8D5C4] bg-[#FFF8F0] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {subscribed ? (
            <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-[#af4408]" />
          ) : (
            <Bell className="mt-0.5 h-5 w-5 shrink-0 text-[#8B7355]" />
          )}
          <div>
            <div className="text-sm font-semibold text-[#2D1B0E]">Push notifications</div>
            <div className="text-xs text-[#8B7355]">
              {subscribed
                ? 'On for this device — task assignments and alerts.'
                : 'Get task assignments and alerts on this device.'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={subscribed ? disable : enable}
          disabled={busy || (blocked && !subscribed)}
          className={
            'inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ' +
            (subscribed
              ? 'border border-[#E8D5C4] bg-white text-[#6B5744] hover:bg-[#FFF1E3]'
              : 'bg-[#af4408] text-white hover:bg-[#933807]')
          }
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {subscribed ? 'Turn off' : 'Enable'}
        </button>
      </div>

      {blocked && !subscribed && (
        <div className="mt-2 text-xs text-[#8B7355]">
          Notifications are blocked in your browser. Allow them in site settings to enable.
        </div>
      )}
      {msg && <div className="mt-2 text-xs text-[#6B5744]">{msg}</div>}
    </div>
  );
}
