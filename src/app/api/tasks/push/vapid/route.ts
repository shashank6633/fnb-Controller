/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getVapidKeys } from '@/lib/push';

/**
 * VAPID public key endpoint (/api/tasks/push/vapid).
 *
 * GET → { publicKey }
 *
 * The browser needs the server's VAPID *public* key as the
 * `applicationServerKey` when it calls pushManager.subscribe(). The keypair is
 * generated + persisted once by getVapidKeys() (settings tm_vapid_* keys) and
 * reused forever — rotating it would orphan every stored subscription.
 *
 * Auth: any signed-in user (the public key is not a secret, but there's no
 * reason to expose the endpoint to anonymous callers). The PRIVATE key never
 * leaves the server.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  try {
    const db = getDb();
    const { publicKey } = getVapidKeys(db);
    if (!publicKey) {
      return Response.json({ error: 'Push not configured' }, { status: 503 });
    }
    return Response.json({ publicKey });
  } catch (e: any) {
    console.error('GET /api/tasks/push/vapid failed:', e);
    return Response.json({ error: e?.message || 'Failed to load VAPID key' }, { status: 500 });
  }
}
