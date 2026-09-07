/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';
import { processBacklog } from '@/lib/wa-inbox';

/**
 * POST /api/crm-calls/inbox/process-backlog — replay whatsapp_events_log
 * history through the inbox processor. EXPLICIT ADMIN ACTION, never at boot
 * (boot-migration lock territory: replays must be a decision, not a side
 * effect of a deploy).
 *
 * Body (optional): { full?: boolean, limit?: number }
 *   full=true  → rescan from event id 0 instead of the stored cursor. Safe:
 *                wamid dedupe + monotone status ladder make replay idempotent,
 *                and it doubles as the media-repair pass (failed media fetches
 *                are retried — e.g. after the access token was configured).
 *
 * Gate: requireRole('admin') — same tier as the rest of the WhatsApp module's
 * config surface.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  try {
    const b = await request.json().catch(() => ({}));
    const result = await processBacklog(getDb(), {
      full: b?.full === true,
      limit: Number(b?.limit) || undefined,
    });
    return Response.json({ ok: true, ...result, errors: result.errors.slice(0, 50) });
  } catch (e: any) {
    console.error('POST /api/crm-calls/inbox/process-backlog failed:', e);
    return Response.json({ error: e?.message || 'Backlog processing failed' }, { status: 500 });
  }
}
