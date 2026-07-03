import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET /api/dine-in/service-requests   (STAFF)
 * Active table-assistance requests (pending + accepted) for the Captain/Waiter
 * dashboard. Completed ones drop off after they're resolved.
 */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const rows = db.prepare(`
      SELECT sr.id, sr.type, sr.status, sr.note, sr.created_at, sr.accepted_at, sr.accepted_by,
             sr.table_id, COALESCE(rt.table_number, sr.table_number) AS table_number, rt.zone,
             oo.server_id AS table_owner_id, oo.server_name AS table_owner_name
      FROM service_requests sr
      LEFT JOIN restaurant_tables rt ON rt.id = sr.table_id
      LEFT JOIN orders oo ON oo.table_id = sr.table_id AND oo.status = 'open'
      WHERE sr.status IN ('pending','accepted')
        AND (sr.outlet_id = ? OR sr.outlet_id IS NULL)
      ORDER BY sr.created_at ASC
    `).all(outletId) as any[];

    return Response.json({ requests: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/dine-in/service-requests GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
