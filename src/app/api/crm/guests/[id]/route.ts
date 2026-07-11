/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { normalizeMobile, tierForPoints } from '@/lib/crm-guests';

/**
 * Single guest (/crm/guests detail).
 *
 * GET /api/crm/guests/:id → { guest (+tier), visits: last 20 }
 * PUT /api/crm/guests/:id { name?, mobile?, birthday?, notes?, is_active? }
 *        → edit profile fields. No DELETE — deactivate with is_active: 0.
 *          Rollups (visit_count / total_spend / points) are visit-driven and
 *          not editable here.
 *
 * Gate: admin, manager tier, or HOD (is_head_chef). Signed-out → 401.
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

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if ('resp' in g) return g.resp;
  try {
    const { id } = await params;
    const db = getDb();
    const guest = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(id) as any;
    if (!guest) return Response.json({ error: 'Guest not found' }, { status: 404 });
    const visits = db.prepare(`
      SELECT * FROM crm_guest_visits WHERE guest_id = ?
      ORDER BY visited_at DESC, id DESC LIMIT 20
    `).all(id);
    return Response.json({ guest: withTier(guest), visits });
  } catch (e: any) {
    console.error('GET /api/crm/guests/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load guest' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if ('resp' in g) return g.resp;

  let body: any = {};
  try { body = await request.json(); } catch { /* handled below */ }

  try {
    const { id } = await params;
    const db = getDb();
    const guest = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(id) as any;
    if (!guest) return Response.json({ error: 'Guest not found' }, { status: 404 });

    const sets: string[] = [];
    const vals: any[] = [];
    if (body?.name != null)     { sets.push('name = ?');     vals.push(String(body.name).trim()); }
    if (body?.birthday != null) { sets.push('birthday = ?'); vals.push(String(body.birthday).trim()); }
    if (body?.notes != null)    { sets.push('notes = ?');    vals.push(String(body.notes).trim()); }
    if (body?.is_active != null) { sets.push('is_active = ?'); vals.push(body.is_active ? 1 : 0); }
    if (body?.mobile != null) {
      const m = normalizeMobile(body.mobile);
      if (!m) return Response.json({ error: 'Valid 10-digit mobile required' }, { status: 400 });
      const clash = db.prepare(`SELECT id FROM crm_guests WHERE mobile = ? AND id != ?`).get(m, id) as any;
      if (clash) return Response.json({ error: 'Another guest already has this mobile' }, { status: 409 });
      sets.push('mobile = ?'); vals.push(m);
    }
    if (sets.length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 });

    db.prepare(`UPDATE crm_guests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const updated = db.prepare(`SELECT * FROM crm_guests WHERE id = ?`).get(id) as any;
    return Response.json({ guest: withTier(updated) });
  } catch (e: any) {
    console.error('PUT /api/crm/guests/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to update guest' }, { status: 500 });
  }
}
