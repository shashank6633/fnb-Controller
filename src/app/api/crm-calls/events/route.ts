import { getCurrentUser } from '@/lib/auth';
import { subscribeCt, type CtEvent } from '@/lib/ct/bus';

export const dynamic = 'force-dynamic';

/**
 * GET /api/crm-calls/events — Server-Sent Events stream for the Call-to-Table
 * CRM (screen-pop + live feed). Emits every bus event (`incoming_call` /
 * `call_ended` / `recovery_update`) as it happens, plus a periodic heartbeat
 * so proxies keep the connection open. Mirrors the KDS stream route
 * (src/app/api/dine-in/kds/stream/route.ts). Cleans up its bus subscription +
 * heartbeat when the client disconnects. Clients that lose this stream fall
 * back to polling /api/crm-calls/live.
 */
export async function GET(request: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

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

      unsubscribe = subscribeCt((evt: CtEvent) => {
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
