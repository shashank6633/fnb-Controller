/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizeMobile, searchGuests, tierForPoints } from '@/lib/crm-guests';
import { autoSaveCrmGuest } from '@/lib/ct/guest-autosave';

/**
 * Guest Database + Loyalty (/crm/guests).
 *
 * GET  /api/crm/guests?q=&limit=
 *        → { rows: [guest + tier] } — list/search by name or mobile fragment,
 *          sorted last_visit_at DESC. Tier (Bronze <500 / Silver <1500 /
 *          Gold ≥1500 points) is computed per response, never stored.
 * POST /api/crm/guests  { mobile, name?, birthday?, notes? }
 *        → manual add — or update of those profile fields when the mobile
 *          already exists (visit/spend/points untouched). Returns { guest }.
 *
 * Gate (both verbs): admin, manager tier, or HOD (is_head_chef).
 * Signed-out → 401. Visits are recorded via POST /api/crm/guests/visit.
 */
export const dynamic = 'force-dynamic';

async function gate(): Promise<{ me: any } | { resp: Response }> {
  const me = await getCurrentUser();
  if (!me) return { resp: Response.json({ error: 'Sign in required' }, { status: 401 }) };
  if (!(me.role === 'admin' || me.role === 'manager' || me.is_head_chef)) {
    return { resp: Response.json({ error: 'Not authorised' }, { status: 403 }) };
  }
  return { me };
}

const withTier = (g: any) => ({ ...g, tier: tierForPoints(g.points) });

export async function GET(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  try {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    return Response.json({ rows: searchGuests(q, limit).map(withTier) });
  } catch (e: any) {
    console.error('GET /api/crm/guests failed:', e);
    return Response.json({ error: e?.message || 'Failed to load guests' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const g = await gate();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  const mobile = normalizeMobile(body?.mobile);
  if (!mobile) {
    return Response.json({ error: 'Valid 10-digit mobile required' }, { status: 400 });
  }
  const name = String(body?.name ?? '').trim();
  const birthday = String(body?.birthday ?? '').trim();
  const notes = String(body?.notes ?? '').trim();

  try {
    const db = getDb();
    const existing = db.prepare(`SELECT * FROM crm_guests WHERE mobile = ?`).get(mobile) as any;
    if (existing) {
      // Update only the profile fields the caller actually sent.
      db.prepare(`
        UPDATE crm_guests SET
          name     = CASE WHEN ? THEN ? ELSE name END,
          birthday = CASE WHEN ? THEN ? ELSE birthday END,
          notes    = CASE WHEN ? THEN ? ELSE notes END
        WHERE id = ?
      `).run(
        body?.name != null ? 1 : 0, name,
        body?.birthday != null ? 1 : 0, birthday,
        body?.notes != null ? 1 : 0, notes,
        existing.id,
      );
      const guest = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(existing.id) as any;
      return Response.json({ guest: withTier(guest), created: false });
    }
    const id = generateId();
    db.prepare(`
      INSERT INTO crm_guests (id, name, mobile, birthday, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, mobile, birthday, notes);
    // Mirror the new loyalty guest into the unified CRM (idempotent, best-effort).
    autoSaveCrmGuest(db, { phone: mobile, name, source: 'loyalty' });
    const guest = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(id) as any;
    return Response.json({ guest: withTier(guest), created: true });
  } catch (e: any) {
    console.error('POST /api/crm/guests failed:', e);
    return Response.json({ error: e?.message || 'Failed to save guest' }, { status: 500 });
  }
}
