/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement } from '@/lib/auth';

/**
 * GRE "What's On" — the band master (/api/crm-calls/bands).
 *
 * A Live Band entry on the entertainment calendar picks its name from this
 * list instead of free text, so the same act is spelled ONE way everywhere —
 * that is what lets bookings be attributed back to the band that played.
 *
 * GET  → { bands } active first-class list (?include_inactive=1 for all).
 *        Any signed-in user, so the board can label rows it renders.
 * POST → create { name }. Management only (admin/manager/HOD).
 *        Duplicates are rejected case-insensitively; a name that only exists
 *        as a retired row is revived rather than refused.
 *
 * CSRF on writes is enforced by the client `api()` helper + the /api/crm-calls
 * prefix in proxy.ts.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NAME_MAX = 120;

export async function GET(req: Request) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const includeInactive = new URL(req.url).searchParams.get('include_inactive') === '1';
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, name, is_active FROM ct_bands
      ${includeInactive ? '' : 'WHERE is_active = 1'}
      ORDER BY name COLLATE NOCASE ASC
    `).all();
    return Response.json({ bands: rows });
  } catch (err) {
    // Surface the failure instead of an empty list: the What's On editor falls
    // back to a free-text name when this read fails, and a silent [] would look
    // like "no bands yet" and quietly strand every existing act.
    console.error('[crm-calls/bands] list failed', err);
    return Response.json({ error: 'Could not load the band list.' }, { status: 500 });
  }
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

  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  if (!name) return Response.json({ error: 'Band name is required.' }, { status: 400 });
  if (name.length > NAME_MAX) {
    return Response.json({ error: `Band name must be ≤${NAME_MAX} characters.` }, { status: 400 });
  }

  try {
    const db = getDb();
    // NOCASE match mirrors the UNIQUE index, so the check and the insert agree.
    const existing = db.prepare(
      'SELECT id, name, is_active FROM ct_bands WHERE name = ? COLLATE NOCASE',
    ).get(name) as { id: string; name: string; is_active: number } | undefined;

    if (existing) {
      if (existing.is_active) {
        return Response.json(
          { error: `"${existing.name}" is already in the band list.` },
          { status: 409 },
        );
      }
      db.prepare("UPDATE ct_bands SET is_active = 1, updated_at = datetime('now') WHERE id = ?")
        .run(existing.id);
      const revived = db.prepare('SELECT id, name, is_active FROM ct_bands WHERE id = ?').get(existing.id);
      return Response.json({ success: true, band: revived, revived: true });
    }

    const id = generateId();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO ct_bands (id, name, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(id, name, me.email, now, now);

    const row = db.prepare('SELECT id, name, is_active FROM ct_bands WHERE id = ?').get(id);
    return Response.json({ success: true, band: row }, { status: 201 });
  } catch (err: any) {
    // Lost the race to a concurrent add — the UNIQUE NOCASE index is the truth.
    if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
      return Response.json({ error: `"${name}" is already in the band list.` }, { status: 409 });
    }
    console.error('[crm-calls/bands] create failed', err);
    return Response.json({ error: 'Could not add the band.' }, { status: 500 });
  }
}
