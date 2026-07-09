import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { subscribeKds, type KdsEvent } from '@/lib/kds-bus';
import { sectionMatchesStation } from '@/lib/kot-section';

export const dynamic = 'force-dynamic';

/**
 * GET — Server-Sent Events stream for the KDS. Emits `kot.new` / `kot.bumped`
 * events (filtered to the caller's outlet and, optionally, ?station=) as they
 * happen, plus a periodic heartbeat so proxies keep the connection open.
 * Cleans up its bus subscription + heartbeat when the client disconnects.
 */
export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const outletId = await getCurrentOutletId();
  const url = new URL(request.url);
  const station = url.searchParams.get('station');
  // Same section gate as the KDS GET: plain staff locked to their section.
  const privileged = me.role === 'admin' || me.role === 'manager' || !!me.is_head_chef;
  const section = (!privileged && me.section) ? me.section : (url.searchParams.get('section') || '');

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch { cleanup(); }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };

      send(': connected\n\n');

      unsubscribe = subscribeKds((evt: KdsEvent) => {
        if (outletId && evt.outlet_id && evt.outlet_id !== outletId) return;
        if (!sectionMatchesStation(section, evt.station || '')) return;
        if (station && station !== 'all' && evt.station !== station) return;
        send(`data: ${JSON.stringify(evt)}\n\n`);
      });

      heartbeat = setInterval(() => send(': keep-alive\n\n'), 25000);
      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
