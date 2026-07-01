import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * POST — a captain flags a KOT that would NOT print (offline printer / no agent).
 * Inserts a kot_alerts row so the Manager (in-app) and the Kitchen Display both
 * see "not printed — action needed". The kot_number / station / table_number are
 * snapshotted from the kot + order + table so the alert reads standalone even if
 * the KOT later changes. Body: { reason }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const kot = db.prepare(`
      SELECT k.id, k.order_id, k.outlet_id, k.kot_number, k.station, t.table_number
      FROM kots k
      JOIN orders o ON k.order_id = o.id
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE k.id = ?
    `).get(id) as any;
    if (!kot) return Response.json({ error: 'KOT not found' }, { status: 404 });

    const b = await req.json().catch(() => ({}));
    const reason = (b?.reason || '').toString().trim();
    const outletId = kot.outlet_id || (await getCurrentOutletId());

    db.prepare(`
      INSERT INTO kot_alerts
        (id, kot_id, order_id, outlet_id, kot_number, station, table_number, reason, created_by, created_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      kot.id,
      kot.order_id,
      outletId,
      kot.kot_number ?? 0,
      kot.station || '',
      kot.table_number || '',
      reason,
      me.name || me.email,
    );

    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/dine-in/kds/[id]/escalate]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
