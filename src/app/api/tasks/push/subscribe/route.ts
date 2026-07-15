/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { saveSubscription, removeSubscription } from '@/lib/push';

/**
 * Push subscription store (/api/tasks/push/subscribe).
 *
 * POST   → save/refresh the caller's browser PushSubscription.
 *            body: { endpoint, keys: { p256dh, auth } }  (a serialized
 *            PushSubscription — `sub.toJSON()` from the client).
 *            The subscription is bound to the CURRENT signed-in user's email
 *            (never a client-supplied email) so a user can only register their
 *            own device. Upserts on the UNIQUE endpoint.
 *
 * DELETE → remove a subscription by endpoint (client opt-out / unsubscribe).
 *            body OR ?endpoint=… : { endpoint }
 *
 * Auth: any signed-in user. CSRF is enforced by the shared /api/tasks proxy
 * prefix (the client posts via @/lib/api which injects the token).
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const endpoint = payload?.endpoint;
  const p256dh = payload?.keys?.p256dh;
  const auth = payload?.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return Response.json(
      { error: 'endpoint and keys.p256dh / keys.auth are required' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    // Bind to the authenticated user — ignore any email in the body.
    saveSubscription(db, me.email, { endpoint, keys: { p256dh, auth } });
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('POST /api/tasks/push/subscribe failed:', e);
    return Response.json({ error: e?.message || 'Failed to save subscription' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

  // Endpoint may arrive in the JSON body (preferred) or as a query param.
  let endpoint = '';
  try {
    const body = await request.json();
    endpoint = body?.endpoint || '';
  } catch {
    /* no/invalid body — fall back to query string */
  }
  if (!endpoint) {
    try {
      endpoint = new URL(request.url).searchParams.get('endpoint') || '';
    } catch {
      /* ignore */
    }
  }
  if (!endpoint) {
    return Response.json({ error: 'endpoint is required' }, { status: 400 });
  }

  try {
    const db = getDb();
    removeSubscription(db, endpoint);
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('DELETE /api/tasks/push/subscribe failed:', e);
    return Response.json({ error: e?.message || 'Failed to remove subscription' }, { status: 500 });
  }
}
