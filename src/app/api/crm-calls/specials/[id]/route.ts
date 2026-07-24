/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser, isManagement, getCurrentOutletId } from '@/lib/auth';

/**
 * GRE "What's On" — single Special/Offer (/api/crm-calls/specials/[id]).
 *
 * PUT    → update { scope, weekday|event_date, title, details, start_time, end_time, active }.
 * DELETE → remove the special.
 * Both are management-only (admin/manager/HOD). CSRF enforced by proxy + api().
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ['special', 'offer', 'workshop', 'event', 'notice', 'vip'] as const;

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  // Scope to the caller's outlet (+ legacy blank) so a manager can't edit
  // another outlet's board entry via a leaked id.
  const oid = (await getCurrentOutletId()) || '';
  const existing = db.prepare(
    `SELECT id FROM ct_specials WHERE id = ? AND (outlet_id = ? OR outlet_id = '')`,
  ).get(id, oid) as any;
  if (!existing) return Response.json({ error: 'Special not found' }, { status: 404 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Invalid body' }, { status: 400 });

  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) return Response.json({ error: 'title required' }, { status: 400 });

  const rawCat = String(body.category || '').trim().toLowerCase();
  const category = (CATEGORIES as readonly string[]).includes(rawCat) ? rawCat : 'special';

  const scope = body.scope === 'date' ? 'date' : 'weekday';
  let weekday = -1;
  let eventDate = '';
  if (scope === 'weekday') {
    weekday = Number(body.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return Response.json({ error: 'weekday must be an integer 0 (Sun) to 6 (Sat)' }, { status: 400 });
    }
  } else {
    eventDate = String(body.event_date || '').trim();
    if (!DATE_RE.test(eventDate)) return Response.json({ error: 'event_date must be YYYY-MM-DD' }, { status: 400 });
  }

  const details = String(body.details || '').trim().slice(0, 2000);
  const startTime = String(body.start_time || '').trim().slice(0, 20);
  const endTime = String(body.end_time || '').trim().slice(0, 20);
  const active = body.active === false || body.active === 0 || body.active === '0' ? 0 : 1;

  db.prepare(`
    UPDATE ct_specials
    SET scope = ?, weekday = ?, event_date = ?, category = ?, title = ?, details = ?,
        start_time = ?, end_time = ?, active = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(scope, weekday, eventDate, category, title, details, startTime, endTime, active, id);

  const row = db.prepare('SELECT * FROM ct_specials WHERE id = ?').get(id);
  return Response.json({ success: true, special: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const oid = (await getCurrentOutletId()) || '';
  const existing = db.prepare(
    `SELECT id FROM ct_specials WHERE id = ? AND (outlet_id = ? OR outlet_id = '')`,
  ).get(id, oid) as any;
  if (!existing) return Response.json({ error: 'Special not found' }, { status: 404 });

  db.prepare('DELETE FROM ct_specials WHERE id = ?').run(id);
  return Response.json({ success: true });
}
