// Web-push (VAPID) helpers for the Task module.
//
// The VAPID keypair is generated once and cached in the `settings` table
// (tm_vapid_public / tm_vapid_private). Every producer of a task_notification
// (assignment / overdue / escalation / mention) also fires a best-effort push
// via sendPushToUser — which NEVER throws, so a failed/expired subscription can
// never break the notification insert. Dead subscriptions (404/410) are pruned.
import type Database from 'better-sqlite3';
import webpush from 'web-push';
import { generateId } from './db';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

// Contact address advertised to the push service. A mailto: is required by spec;
// override via env if desired.
const VAPID_SUBJECT = process.env.TM_VAPID_SUBJECT || 'mailto:admin@fnb-controller.local';

/**
 * Return the VAPID keypair, generating + persisting it once on first call.
 * Reuses the stored pair on every subsequent call so the public key handed to
 * the browser stays stable (rotating it would orphan all existing subs).
 */
export function getVapidKeys(db: Database.Database): VapidKeys {
  try {
    const pub = db.prepare("SELECT value FROM settings WHERE key = 'tm_vapid_public'").get() as { value?: string } | undefined;
    const priv = db.prepare("SELECT value FROM settings WHERE key = 'tm_vapid_private'").get() as { value?: string } | undefined;
    if (pub?.value && priv?.value) {
      return { publicKey: pub.value, privateKey: priv.value };
    }
    const keys = webpush.generateVAPIDKeys();
    const ins = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    ins.run('tm_vapid_public', keys.publicKey);
    ins.run('tm_vapid_private', keys.privateKey);
    return keys;
  } catch (e) {
    // As a last resort generate an ephemeral pair so callers never crash. This
    // pair won't match stored subscriptions, but push is strictly best-effort.
    console.error('getVapidKeys failed, using ephemeral pair:', e);
    return webpush.generateVAPIDKeys();
  }
}

/**
 * Send a push notification to every subscription registered for `email`.
 * Best-effort: never throws. On a 404/410 the subscription is pruned so the
 * dead-endpoint list doesn't grow unbounded. Returns the number of sends that
 * the push service accepted (useful for logging/tests).
 */
export async function sendPushToUser(
  db: Database.Database,
  email: string,
  payload: PushPayload
): Promise<number> {
  if (!email) return 0;
  let sent = 0;
  try {
    const keys = getVapidKeys(db);
    webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);

    const subs = db
      .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_email = ?')
      .all(email) as Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;

    const body = JSON.stringify({
      title: payload.title || 'Notification',
      body: payload.body || '',
      url: payload.url || '/tasks',
    });

    const del = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Endpoint permanently gone — prune it.
          try { del.run(sub.id); } catch { /* ignore */ }
        } else {
          console.error('push send failed (non-fatal):', status ?? err);
        }
      }
    }
  } catch (e) {
    console.error('sendPushToUser failed (non-fatal):', e);
  }
  return sent;
}

/**
 * Upsert a browser PushSubscription for a user. Keyed on the unique endpoint so
 * re-subscribing the same browser updates keys rather than duplicating rows.
 */
export function saveSubscription(
  db: Database.Database,
  email: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } }
): void {
  if (!sub?.endpoint) return;
  const existing = db
    .prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?')
    .get(sub.endpoint) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      'UPDATE push_subscriptions SET user_email = ?, p256dh = ?, auth = ? WHERE id = ?'
    ).run(email || '', sub.keys?.p256dh || '', sub.keys?.auth || '', existing.id);
  } else {
    db.prepare(
      `INSERT INTO push_subscriptions (id, user_email, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?, ?)`
    ).run(generateId(), email || '', sub.endpoint, sub.keys?.p256dh || '', sub.keys?.auth || '');
  }
}

/**
 * Remove a subscription by endpoint (client unsubscribe / DELETE handler).
 */
export function removeSubscription(db: Database.Database, endpoint: string): void {
  if (!endpoint) return;
  try {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  } catch (e) {
    console.error('removeSubscription failed:', e);
  }
}
