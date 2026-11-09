import { getCurrentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { requireStaff, ValetError } from '@/lib/valet/core';
import { hasValetCap } from '@/lib/valet/caps';
import { subscribeValet, type ValetBusEvent } from '@/lib/valet/bus';

/**
 * GET ?outlet= — Server-Sent Events for live valet screens (the KDS stream's
 * pattern). Authorised exactly like the reads it accelerates: valet capability
 * + outlet assignment. Events carry ids and a kind only — the client re-reads
 * through its own authorised API, so the stream can never leak a field the
 * caller's read would not. Single-process (see bus.ts); clients also poll.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const user = await getCurrentUser();
  const outletId = new URL(request.url).searchParams.get('outlet') || '';
  try {
    const need = hasValetCap(user ?? undefined, 'attendant') ? 'attendant' : 'host';
    requireStaff(getDb(), user, outletId, need);
  } catch (e) {
    const ve = e as ValetError;
    return Response.json({ error: ve.message, code: ve.code }, { status: ve.status || 403 });
  }
  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { cleanup(); }
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      send(': connected\n\n');
      unsubscribe = subscribeValet((evt: ValetBusEvent) => {
        if (evt.outlet_id !== outletId) return;
        send(`data: ${JSON.stringify({ kind: evt.kind, session_id: evt.session_id ?? null, pickup_id: evt.pickup_id ?? null, at: evt.at })}\n\n`);
      });
      heartbeat = setInterval(() => send(': keep-alive\n\n'), 20000);
      request.signal.addEventListener('abort', cleanup);
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
  });
}
