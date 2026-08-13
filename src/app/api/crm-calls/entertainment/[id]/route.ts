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

/**
 * Re-attribute bookings already held for these dates to whatever now plays.
 *
 * The back-link lives in the Reservego importer (relinkBands) because the
 * importer owns ct_bookings. Resolved at call time, not statically imported,
 * so this route keeps compiling — and simply skips the relink — until that
 * helper is merged. Assumed shape: relinkBands(db, 'YYYY-MM-DD').
 */
async function relinkBandsForDates(dates: string[]) {
  const uniq = [...new Set(dates.filter(Boolean))];
  if (!uniq.length) return;
  try {
    const mod = (await import('@/lib/reservego-import')) as unknown as Record<string, unknown>;
    const fn = mod.relinkBands;
    if (typeof fn !== 'function') return;
    const db = getDb();
    // { from, to } — NOT a bare date string. relinkBands takes a RANGE, and a
    // string argument silently became `range.from === undefined`, which its
    // boundDate() widens to 0000-01-01..9999-12-31: every calendar edit
    // re-linked all ~85,000 bookings instead of the one night that changed.
    // Results were still right, which is why nothing looked wrong; the cost was
    // a full-table pass per keystroke-save. The `as` cast on a dynamic import is
    // what hid the mismatch from tsc, so the cast now states the real shape.
    for (const d of uniq) {
      (fn as (db: unknown, range: { from?: string; to?: string }) => unknown)(db, { from: d, to: d });
    }
  } catch (err) {
    // A relink is a follow-up, never a precondition: the edit the user just
    // saved must stand even if attribution fails.
    console.error('[crm-calls/entertainment] relinkBands failed', err);
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare('SELECT id, event_date FROM ct_entertainment WHERE id = ?').get(id) as any;
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

  // Moving an entry to another night changes who played on BOTH nights.
  await relinkBandsForDates([String(existing.event_date || ''), eventDate]);

  const row = db.prepare('SELECT * FROM ct_entertainment WHERE id = ?').get(id);
  return Response.json({ success: true, entertainment: row });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  const { id } = await params;
  const db = getDb();
  const existing = db.prepare('SELECT id, event_date FROM ct_entertainment WHERE id = ?').get(id) as any;
  if (!existing) return Response.json({ error: 'Entry not found' }, { status: 404 });

  db.prepare('DELETE FROM ct_entertainment WHERE id = ?').run(id);

  // Removing the act is a lineup change too — without this the night's bookings
  // stay attributed to a band that is no longer on the calendar.
  await relinkBandsForDates([String(existing.event_date || '')]);

  return Response.json({ success: true });
}
