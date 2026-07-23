/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement, getCurrentOutletId } from '@/lib/auth';

/**
 * GRE "What's On" — Entertainment calendar collection
 * (/api/crm-calls/entertainment).
 *
 * GET  → list ct_entertainment rows, filtered by ?from=&to= (event_date range)
 *        or a single ?date=, ordered by event_date, start_time. Any signed-in user.
 * POST → create a calendar entry { event_date, type, name, start_time, end_time,
 *        area, description }. Management only (admin/manager/HOD).
 *
 * CSRF on writes is enforced by the client `api()` helper + proxy.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ENT_TYPES = ['band', 'dj', 'live_music', 'event', 'offer', 'other'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const db = getDb();
  const sp = new URL(req.url).searchParams;

  const where: string[] = [];
  const params: any[] = [];

  const date = (sp.get('date') || '').trim();
  const from = (sp.get('from') || '').trim();
  const to = (sp.get('to') || '').trim();

  if (date) {
    if (!DATE_RE.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    where.push('event_date = ?');
    params.push(date);
  } else {
    if (from) {
      if (!DATE_RE.test(from)) return Response.json({ error: 'from must be YYYY-MM-DD' }, { status: 400 });
      where.push('event_date >= ?');
      params.push(from);
    }
    if (to) {
      if (!DATE_RE.test(to)) return Response.json({ error: 'to must be YYYY-MM-DD' }, { status: 400 });
      where.push('event_date <= ?');
      params.push(to);
    }
  }

  // Scope to the current outlet (+ legacy blank rows) so the editor list matches
  // exactly what the What's On board renders — no phantom other-outlet entries.
  const oid = (await getCurrentOutletId()) || '';
  where.push("(outlet_id = ? OR outlet_id = '')");
  params.push(oid);

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM ct_entertainment
    ${whereSql}
    ORDER BY event_date ASC, start_time ASC, name ASC
  `).all(...params);

  return Response.json({ entertainment: rows });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Invalid body' }, { status: 400 });
  }

  const eventDate = String(body.event_date || '').trim();
  if (!DATE_RE.test(eventDate)) {
    return Response.json({ error: 'event_date must be YYYY-MM-DD' }, { status: 400 });
  }

  const name = String(body.name || '').trim();
  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  if (name.length > 120) return Response.json({ error: 'name must be ≤120 chars' }, { status: 400 });

  const rawType = String(body.type || '').trim();
  const type = (ENT_TYPES as readonly string[]).includes(rawType) ? rawType : 'band';

  const startTime = String(body.start_time || '').trim().slice(0, 10);
  const endTime = String(body.end_time || '').trim().slice(0, 10);
  const area = String(body.area || '').trim().slice(0, 80);
  const description = String(body.description || '').trim().slice(0, 1000);

  const outletId = (await getCurrentOutletId()) || '';
  const id = generateId();
  const now = new Date().toISOString();

  const db = getDb();
  db.prepare(`
    INSERT INTO ct_entertainment (
      id, outlet_id, event_date, type, name, start_time, end_time,
      area, description, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, outletId, eventDate, type, name, startTime, endTime,
    area, description, me.email, now, now,
  );

  const row = db.prepare('SELECT * FROM ct_entertainment WHERE id = ?').get(id);
  return Response.json({ success: true, entertainment: row }, { status: 201 });
}
