import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Food line items for a party event — the active (chef-approved, not
 * cancelled/rejected) party requisition items that make up the event's food
 * cost. Mirrors the food-cost query in /api/party-events/pnl, but returns the
 * rows for the "View items" modal on the Food Consumption page.
 *
 * GET /api/party-events/food-items?event_name=...&event_date=YYYY-MM-DD
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const url = new URL(request.url);
    const eventName = url.searchParams.get('event_name');
    const eventDate = url.searchParams.get('event_date');
    if (!eventName || !eventDate) {
      return Response.json({ error: 'event_name and event_date required' }, { status: 400 });
    }

    const items = db.prepare(`
      SELECT ri.id,
             rm.name               AS material_name,
             rm.unit               AS material_unit,
             ri.quantity_requested AS qty,
             ri.quantity_issued    AS qty_issued,
             rm.average_price      AS avg_price,
             (ri.quantity_requested * rm.average_price) AS cost,
             r.status              AS req_status,
             r.id                  AS req_id
      FROM requisitions r
      JOIN requisition_items ri ON ri.req_id = r.id
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE r.purpose = 'party'
        AND r.event_name = ?
        AND r.event_date = ?
        AND r.status NOT IN ('cancelled', 'chef_rejected')
      ORDER BY rm.name
    `).all(eventName, eventDate);

    return Response.json({ items });
  } catch (e: any) {
    console.error('[/api/party-events/food-items GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
