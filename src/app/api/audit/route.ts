import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth';

/**
 * Audit log read API — admin only.
 *
 * Query: ?event_type=&entity_type=&entity_id=&actor=&from=&to=&limit=
 * Returns events newest first.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const auth = await requireRole('admin');
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });

  const db = getDb();
  const url = new URL(request.url);
  const where: string[] = ['1=1'];
  const params: any[] = [];
  const push = (col: string, val: string | null, op = '=') => {
    if (val) { where.push(`${col} ${op} ?`); params.push(val); }
  };
  push('event_type', url.searchParams.get('event_type'));
  push('entity_type', url.searchParams.get('entity_type'));
  push('entity_id', url.searchParams.get('entity_id'));
  push('actor_email', url.searchParams.get('actor'));
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (from) { where.push("DATE(created_at) >= ?"); params.push(from); }
  if (to)   { where.push("DATE(created_at) <= ?"); params.push(to); }
  const limit = Math.min(Number(url.searchParams.get('limit') || 200), 1000);

  const rows = db.prepare(`
    SELECT id, event_type, entity_type, entity_id, actor_email, outlet_id,
           before_json, after_json, note, created_at
    FROM audit_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as any[];

  // Distinct values for filter dropdowns
  const distinctEvents = (db.prepare(`SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`).all() as any[]).map(r => r.event_type);
  const distinctEntities = (db.prepare(`SELECT DISTINCT entity_type FROM audit_events ORDER BY entity_type`).all() as any[]).map(r => r.entity_type);
  const distinctActors = (db.prepare(`SELECT DISTINCT actor_email FROM audit_events WHERE actor_email != '' ORDER BY actor_email`).all() as any[]).map(r => r.actor_email);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_events`).get() as any).n;

  return Response.json({
    total,
    returned: rows.length,
    filters: { event_types: distinctEvents, entity_types: distinctEntities, actors: distinctActors },
    events: rows,
  });
}
