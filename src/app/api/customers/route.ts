import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET /api/customers                → aggregated customer list (one row per mobile).
 * GET /api/customers?mobile=<digits> → that customer's order history.
 *
 * Customer history (guest name + mobile captured via QR/OTP or billing) is open
 * to every signed-in member. A guest is any dine-in order with a guest_mobile.
 */

// Normalise a stored mobile to digits by stripping the punctuation real phone
// numbers carry (space, dash, +, parens, dot, slash). Used IDENTICALLY on both
// sides of every comparison so "98000 12345", "+91-9800012345" and "9800012345"
// collapse to one customer. (SQLite has no regexp by default → nested REPLACE.)
const NORM = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const url = new URL(req.url);
    const mobile = (url.searchParams.get('mobile') || '').replace(/\D/g, '');

    // ── One customer's order history ────────────────────────────────────────
    if (mobile) {
      const orders = db.prepare(`
        SELECT o.id, o.order_number, o.status, o.origin, o.total, o.created_at, o.settled_at,
               o.guest_name, o.server_name, rt.table_number,
               (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
        FROM orders o
        LEFT JOIN restaurant_tables rt ON rt.id = o.table_id
        WHERE ${NORM('o.guest_mobile')} = @mobile
          AND o.status <> 'void'
          AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
        ORDER BY o.created_at DESC
        LIMIT 200
      `).all({ mobile, outlet: outletId }) as any[];
      return Response.json({ mobile, orders }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // ── Aggregated list (one row per normalised mobile) ─────────────────────
    // Group ALL orders first (so per-customer totals are complete), THEN filter
    // by the search term, THEN limit — otherwise a match beyond the cap is lost.
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    const rows = db.prepare(`
      SELECT * FROM (
        SELECT
          ${NORM('o.guest_mobile')} AS mobile,
          (SELECT o2.guest_name FROM orders o2
             WHERE ${NORM('o2.guest_mobile')} = ${NORM('o.guest_mobile')}
               AND COALESCE(o2.guest_name,'') <> ''
               AND o2.status <> 'void'
               AND (o2.outlet_id = @outlet OR o2.outlet_id IS NULL)
             ORDER BY o2.created_at DESC LIMIT 1) AS name,
          COUNT(*) AS orders,
          COUNT(DISTINCT date(o.created_at, '+330 minutes')) AS visits,
          MIN(o.created_at) AS first_seen,
          MAX(o.created_at) AS last_seen,
          SUM(CASE WHEN o.status = 'settled' THEN COALESCE(o.total, 0) ELSE 0 END) AS total_spent,
          SUM(CASE WHEN o.origin = 'customer' THEN 1 ELSE 0 END) AS qr_orders
        FROM orders o
        WHERE COALESCE(o.guest_mobile, '') <> ''
          AND o.status <> 'void'
          AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
        GROUP BY ${NORM('o.guest_mobile')}
      ) t
      WHERE (@qraw = ''
             OR (@qdigits <> '' AND t.mobile LIKE '%' || @qdigits || '%')
             OR lower(COALESCE(t.name, '')) LIKE '%' || @qlower || '%')
      ORDER BY t.last_seen DESC
      LIMIT 1000
    `).all({ outlet: outletId, qraw: q, qdigits: q.replace(/\D/g, ''), qlower: q }) as any[];

    const customers = rows.map(r => ({
      mobile: String(r.mobile || ''),
      name: String(r.name || ''),
      orders: Number(r.orders) || 0,
      visits: Number(r.visits) || 0,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      total_spent: Math.round(Number(r.total_spent) || 0),
      qr_orders: Number(r.qr_orders) || 0,
    }));

    return Response.json(
      { customers, total: customers.length },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e: any) {
    console.error('[/api/customers GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
