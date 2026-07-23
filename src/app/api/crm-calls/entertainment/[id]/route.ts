/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';

/**
 * GRE "What's On" — single Entertainment calendar entry
 * (/api/crm-calls/entertainment/[id]).
 *
 * PUT    → update { event_date, type, name, start_time, end_time, area, description }.
 * DELETE → remove the entry.
 * Both are management-only (admin/manager/HOD). CSRF enforced by proxy + api().
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ENT_TYPES = ['band', 'dj', 'live_music', 'event', 'offer', 'other'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM ct_entertainment WHERE id = ?').get(id) as any;
  if (!existing) return Response.json({ error: 'Entry not found' }, { status: 404 });

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

  db.prepare(`
    UPDATE ct_entertainment
    SET event_date = ?, type = ?, name = ?, start_time = ?, end_time = ?,
        area = ?, description = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(eventDate, type, name, startTime, endTime, area, description, id);

  const row = db.prepare('SELECT * FROM ct_entertainment WHERE id = ?').get(id);
  return Response.json({ success: true, entertainment: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM ct_entertainment WHERE id = ?').get(id) as any;
  if (!existing) return Response.json({ error: 'Entry not found' }, { status: 404 });

  db.prepare('DELETE FROM ct_entertainment WHERE id = ?').run(id);
  return Response.json({ success: true });
}
