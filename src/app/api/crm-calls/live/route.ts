import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { latestCtSeq, recentCtSince } from '@/lib/ct/bus';

/**
 * GET /api/crm-calls/live?after=<seq> — polling fallback for the screen-pop.
 *
 * When the SSE stream (/api/crm-calls/events) drops, CTScreenPop polls this
 * every ~5s. Returns:
 *   seq      latest ring-buffer sequence — client passes it back as ?after=
 *   events   bus events with seq > after (same CtEvent shape as the stream)
 *   ringing  currently-ringing calls (newest 10, guest joined) so a client
 *            that reconnects mid-ring still pops the card. Bounded to the
 *            last 15 min: reconcileLiveEvents() marks stale ringing rows
 *            missed on the next sweep, but the sweep runs on other GETs —
 *            never resurface hours-old "ringing" ghosts here.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RINGING_WINDOW_MS = 15 * 60 * 1000;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401 });

  const after = Number(new URL(req.url).searchParams.get('after')) || 0;
  const db = getDb();

  const cutoff = new Date(Date.now() - RINGING_WINDOW_MS).toISOString();
  const rows = db.prepare(`
    SELECT c.id, c.telecmi_call_id, c.phone_e164, c.direction, c.agent_user, c.queue,
           COALESCE(NULLIF(c.started_at, ''), c.created_at) AS started_at,
           COALESCE(NULLIF(c.guest_id, ''), gp.id) AS guest_id,
           COALESCE(NULLIF(g.name, ''), NULLIF(gp.name, ''), '') AS guest_name,
           COALESCE(g.tags, gp.tags, '[]') AS guest_tags
    FROM ct_calls c
    LEFT JOIN ct_guests g  ON g.id = c.guest_id
    LEFT JOIN ct_guests gp ON (c.guest_id IS NULL OR c.guest_id = '')
                          AND gp.phone_e164 = c.phone_e164
    WHERE c.status = 'ringing'
      AND COALESCE(NULLIF(c.started_at, ''), c.created_at) >= ?
    ORDER BY COALESCE(NULLIF(c.started_at, ''), c.created_at) DESC
    LIMIT 12
  `).all(cutoff) as any[];

  const ringing = rows.map(r => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.guest_tags || '[]'); if (Array.isArray(t)) tags = t; } catch { /* keep [] */ }
    const { guest_tags: _drop, ...rest } = r;
    return { ...rest, guest_tags: tags };
  });

  return Response.json({
    seq: latestCtSeq(),
    events: recentCtSince(after),
    ringing,
  });
}
