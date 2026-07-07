import { getDb } from '@/lib/db';
import { getCurrentOutletId, getCurrentUser } from '@/lib/auth';
import { loadBookingsCache, loadUpcomingParties, resolveBookingRevenue } from '@/lib/party-revenue';

/**
 * Party Events P&L.
 *
 * For each distinct (event_name, event_date) on requisitions where purpose='party':
 *   COST    = Σ (issued_qty × material avg_price), summed across all requisitions
 *             tagged with that event
 *   REVENUE = sum of sales.total_revenue for rows on event_date that look like
 *             party rows (item ends ' P' OR category in {Party Package, Custom})
 *
 * Multiple requisitions can belong to the same event (e.g. one for kitchen, one
 * for bar). They aggregate by (event_name, event_date).
 *
 * GET /api/party-events                       → list all events with summary
 * GET /api/party-events?event=Sharma...&date=YYYY-MM-DD → drill-down detail
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PARTY_PREDICATE = `(s.item_name LIKE '% P' OR LOWER(s.category) IN ('party package','custom'))`;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const eventName = url.searchParams.get('event');
    const eventDate = url.searchParams.get('date');
    const outletId = await getCurrentOutletId();
    // Revenue & profit are ADMIN/HOD-only. Department users (kitchen/bar/service)
    // get consumption/cost only — financial fields are zeroed server-side so the
    // numbers never reach the browser, not just hidden in the UI.
    const me = await getCurrentUser();
    const canSeeFinancials = me?.role === 'admin' || !!me?.is_head_chef;
    // A department user (not admin, not HOD) may see ONLY their own department's
    // slice of a party's cost/items — never the whole party across all depts.
    // Scope by the per-line requisition_items.department_id. A dept-less
    // non-privileged user gets a sentinel that matches nothing → sees zero cost.
    const deptScopeId = canSeeFinancials ? null : (me?.department_id ?? '__no_dept__');
    const redact = <T extends Record<string, any>>(o: T): T =>
      canSeeFinancials ? o : ({ ...o, revenue: 0, profit: 0, food_cost_percent: 0, per_head_revenue: 0, per_head_profit: 0, booking_total: 0 });

    // Revenue is the Party Bookings sheet Final Total (matched to the party by
    // candidate names + date, gated to confirmed + past) — NOT POS sales, which
    // rarely match. Same source as the /parties P&L, so the two agree.
    const today = new Date().toISOString().slice(0, 10);
    const bookings = loadBookingsCache(db);
    const cachedParties = loadUpcomingParties(db);

    // Single event detail
    if (eventName && eventDate) {
      // For a department user, show ONLY requisitions that carry an item for their
      // department (EXISTS on the dept-scoped items) — so the requisitions list,
      // the count, and the header never leak other departments' req metadata.
      const reqs = db.prepare(`
        SELECT r.*, d.name AS department_name
        FROM requisitions r
        JOIN departments d ON d.id = r.department_id
        WHERE r.purpose = 'party' AND r.event_name = ? AND r.event_date = ?
          ${deptScopeId ? 'AND EXISTS (SELECT 1 FROM requisition_items ri WHERE ri.req_id = r.id AND ri.department_id = ?)' : ''}
        ORDER BY r.created_at
      `).all(...(deptScopeId ? [eventName, eventDate, deptScopeId] : [eventName, eventDate])) as any[];
      if (reqs.length === 0) return Response.json({ error: 'Event not found' }, { status: 404 });

      const items = db.prepare(`
        SELECT ri.*, rm.name AS material_name, rm.sku, rm.unit, rm.average_price,
               r.req_number, r.id AS req_id
        FROM requisitions r
        JOIN requisition_items ri ON ri.req_id = r.id
        JOIN raw_materials rm ON rm.id = ri.material_id
        WHERE r.purpose = 'party' AND r.event_name = ? AND r.event_date = ?
          ${deptScopeId ? 'AND ri.department_id = ?' : ''}
        ORDER BY rm.name
      `).all(...(deptScopeId ? [eventName, eventDate, deptScopeId] : [eventName, eventDate])) as any[];

      const sales = db.prepare(`
        SELECT s.item_name,
               SUM(s.quantity_sold) AS qty,
               SUM(s.total_revenue) AS revenue,
               s.category,
               CASE WHEN s.linked_event_name = ? AND s.linked_event_date = ?
                    THEN 'manual' ELSE 'auto' END AS link_type
        FROM sales s
        WHERE (
          (s.linked_event_name = ? AND s.linked_event_date = ?)
          OR
          (s.date = ? AND ${PARTY_PREDICATE} AND s.linked_event_name IS NULL)
        )
        GROUP BY s.item_name, link_type ORDER BY revenue DESC
      `).all(eventName, eventDate, eventName, eventDate, eventDate) as any[];

      const cost    = items.reduce((s, i) => s + i.quantity_requested * (i.average_price || 0), 0);
      const br      = resolveBookingRevenue(bookings, cachedParties, eventName, eventDate, today, true);
      const revenue = br.revenue;
      const guests  = reqs[0]?.guest_count || 0;

      return Response.json({
        event_name: eventName,
        event_date: eventDate,
        guest_count: guests,
        customer:    reqs[0]?.customer || '',
        notes:       reqs[0]?.event_notes || '',
        requisitions: reqs.map(r => ({
          id: r.id, req_number: r.req_number, status: r.status,
          department: r.department_name,
        })),
        items: items.map(i => ({
          req_number: i.req_number,
          material:   i.material_name,
          sku:        i.sku,
          unit:       i.unit,
          quantity:   i.quantity_requested,
          unit_price: Math.round((i.average_price || 0) * 100) / 100,
          line_cost:  Math.round(i.quantity_requested * (i.average_price || 0) * 100) / 100,
        })),
        sales: canSeeFinancials ? sales.map(s => ({
          item_name: s.item_name, qty: s.qty,
          revenue: Math.round(s.revenue || 0),
          category: s.category,
          link_type: s.link_type as 'manual' | 'auto',
        })) : [],
        summary: redact({
          cost: Math.round(cost * 100) / 100,
          revenue: Math.round(revenue),
          booking_total: Math.round(br.booking_total),
          revenue_withheld_reason: br.withheld_reason,
          profit: Math.round((revenue - cost) * 100) / 100,
          food_cost_percent: revenue > 0 ? Math.round((cost / revenue) * 10000) / 100 : 0,
          per_head_cost:     guests > 0 ? Math.round((cost / guests) * 100) / 100 : 0,
          per_head_revenue:  guests > 0 ? Math.round(revenue / guests) : 0,
          per_head_profit:   guests > 0 ? Math.round(((revenue - cost) / guests) * 100) / 100 : 0,
        }),
      });
    }

    // List view — every distinct event with summary
    const events = db.prepare(`
      WITH ev AS (
        SELECT r.event_name, r.event_date,
               MAX(r.guest_count) AS guest_count,
               MAX(r.customer)    AS customer,
               ${deptScopeId
                 ? `(SELECT COUNT(DISTINCT r3.id) FROM requisitions r3
                       JOIN requisition_items ri3 ON ri3.req_id = r3.id
                      WHERE r3.purpose = 'party' AND r3.event_name = r.event_name
                        AND r3.event_date = r.event_date AND ri3.department_id = ?)`
                 : 'COUNT(*)'} AS req_count,
               (SELECT COALESCE(SUM(ri.quantity_requested * rm.average_price), 0)
                  FROM requisitions r2
                  JOIN requisition_items ri ON ri.req_id = r2.id
                  JOIN raw_materials rm ON rm.id = ri.material_id
                  WHERE r2.purpose = 'party'
                    AND r2.event_name = r.event_name
                    AND r2.event_date = r.event_date
                    ${deptScopeId ? 'AND ri.department_id = ?' : ''}) AS cost,
               (SELECT COALESCE(SUM(s.total_revenue), 0)
                  FROM sales s
                  WHERE (
                    (s.linked_event_name = r.event_name AND s.linked_event_date = r.event_date)
                    OR
                    (s.date = r.event_date AND ${PARTY_PREDICATE} AND s.linked_event_name IS NULL)
                  )) AS revenue
        FROM requisitions r
        WHERE r.purpose = 'party' AND r.event_name != ''
          ${deptScopeId ? 'AND EXISTS (SELECT 1 FROM requisition_items ri4 WHERE ri4.req_id = r.id AND ri4.department_id = ?)' : ''}
        GROUP BY r.event_name, r.event_date
      )
      SELECT * FROM ev ORDER BY event_date DESC, event_name
    `).all(...(deptScopeId ? [deptScopeId, deptScopeId, deptScopeId] : [])) as any[];

    return Response.json({
      events: events.map(e => {
        const cost = Number(e.cost) || 0;
        const br   = resolveBookingRevenue(bookings, cachedParties, e.event_name, e.event_date, today, true);
        const rev  = br.revenue;   // Party Bookings Final Total (gated), not POS sales
        return redact({
          event_name: e.event_name,
          event_date: e.event_date,
          guest_count: e.guest_count,
          customer: e.customer,
          req_count: e.req_count,
          cost: Math.round(cost * 100) / 100,
          revenue: Math.round(rev),
          booking_total: Math.round(br.booking_total),
          revenue_withheld_reason: br.withheld_reason,
          profit: Math.round((rev - cost) * 100) / 100,
          food_cost_percent: rev > 0 ? Math.round((cost / rev) * 10000) / 100 : 0,
          per_head_cost: e.guest_count > 0 ? Math.round((cost / e.guest_count) * 100) / 100 : 0,
          per_head_revenue: e.guest_count > 0 ? Math.round(rev / e.guest_count) : 0,
        });
      }),
    });
  } catch (e: any) {
    console.error('[party-events]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
