/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement, getCurrentOutletId } from '@/lib/auth';

/**
 * GRE "What's On" — Specials & Offers (/api/crm-calls/specials).
 *
 * A special is either RECURRING on a weekday (scope='weekday', weekday 0=Sun..6=Sat,
 * e.g. "every Sunday: Brunch") or a ONE-OFF on a date (scope='date', event_date).
 *
 * GET  → list all specials (any signed-in user). Ordered recurring-first then title.
 * POST → create (management only). { scope, weekday|event_date, title, details,
 *        start_time, end_time }.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ['special', 'offer', 'workshop', 'event', 'notice', 'vip'] as const;

/** Validate/normalize the shared special fields from a request body. */
function parseSpecial(body: any): { ok: true; v: any } | { ok: false; error: string } {
  const title = String(body?.title || '').trim().slice(0, 120);
  if (!title) return { ok: false, error: 'title required' };

  const rawCat = String(body?.category || '').trim().toLowerCase();
  const category = (CATEGORIES as readonly string[]).includes(rawCat) ? rawCat : 'special';

  const scope = body?.scope === 'date' ? 'date' : 'weekday';
  let weekday = -1;
  let eventDate = '';
  if (scope === 'weekday') {
    weekday = Number(body?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: 'weekday must be an integer 0 (Sun) to 6 (Sat)' };
    }
  } else {
    eventDate = String(body?.event_date || '').trim();
    if (!DATE_RE.test(eventDate)) return { ok: false, error: 'event_date must be YYYY-MM-DD' };
  }
  return {
    ok: true,
    v: {
      scope,
      weekday,
      event_date: eventDate,
      category,
      title,
      details: String(body?.details || '').trim().slice(0, 2000),
      start_time: String(body?.start_time || '').trim().slice(0, 20),
      end_time: String(body?.end_time || '').trim().slice(0, 20),
      active: body?.active === false || body?.active === 0 || body?.active === '0' ? 0 : 1,
    },
  };
}

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  const db = getDb();
  // Scope to the current outlet (+ legacy blank rows) so the Settings manager
  // shows exactly what the board renders — no phantom other-outlet entries.
  const oid = (await getCurrentOutletId()) || '';
  const specials = db.prepare(`
    SELECT * FROM ct_specials
    WHERE outlet_id = ? OR outlet_id = ''
    ORDER BY (scope = 'weekday') DESC, weekday ASC, event_date ASC, title ASC
  `).all(oid);
  return Response.json({ specials });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });
  if (!isManagement(me)) return Response.json({ error: 'Management only' }, { status: 403 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = parseSpecial(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const db = getDb();
  const id = generateId();
  const now = new Date().toISOString();
  const outletId = (await getCurrentOutletId()) || '';
  db.prepare(`
    INSERT INTO ct_specials
      (id, outlet_id, scope, weekday, event_date, category, title, details, start_time, end_time, active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, outletId, parsed.v.scope, parsed.v.weekday, parsed.v.event_date, parsed.v.category, parsed.v.title,
    parsed.v.details, parsed.v.start_time, parsed.v.end_time, parsed.v.active, me.email, now, now,
  );
  const row = db.prepare('SELECT * FROM ct_specials WHERE id = ?').get(id);
  return Response.json({ success: true, special: row }, { status: 201 });
}
