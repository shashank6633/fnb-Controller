import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * GET /api/dine-in/guest-regulars?mobile=<digits>&limit=6   (any signed-in user)
 *
 * "This guest usually orders…" — the items a returning customer orders most
 * often, mined from THEIR own past orders (not the cart co-occurrence upsell).
 * Surfaced to the captain while taking a known guest's order so they can add
 * the usual in one tap. Only active, priced, re-orderable menu items are
 * returned (needs menu_item_id).
 */

// Same digit-normalisation the /api/customers route uses, so a number stored as
// "+91 98000-12345" matches the digits-only param.
const NORM = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/','')`;

export async function GET(req: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const url = new URL(req.url);
    const mobile = (url.searchParams.get('mobile') || '').replace(/\D/g, '');
    if (mobile.length < 6) return Response.json({ items: [] });
    const limit = Math.min(12, Math.max(1, Number(url.searchParams.get('limit')) || 6));
    // The order currently being taken must NOT count toward "usual" items — else
    // a first-time guest's live cart gets shown back to them as their "regulars".
    const exclude = String(url.searchParams.get('exclude') || '');

    const db = getDb();
    const outletId = await getCurrentOutletId();

    const items = db.prepare(`
      SELECT oi.menu_item_id AS id, mi.name AS name, mi.selling_price AS price,
             mi.station AS station,
             COUNT(DISTINCT o.id) AS times, SUM(oi.quantity) AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN menu_items mi  ON mi.id = oi.menu_item_id
      WHERE ${NORM('o.guest_mobile')} = @mobile
        AND o.status <> 'void'
        AND o.id <> @exclude
        AND (o.outlet_id = @outlet OR o.outlet_id IS NULL)
        AND mi.is_active = 1 AND mi.selling_price > 0
      GROUP BY oi.menu_item_id
      ORDER BY times DESC, qty DESC, mi.name ASC
      LIMIT ${limit}
    `).all({ mobile, outlet: outletId, exclude }) as any[];

    return Response.json({
      items: items.map(r => ({
        id: String(r.id),
        name: String(r.name || ''),
        price: Math.round(Number(r.price) || 0),
        station: String(r.station || ''),
        times: Number(r.times) || 0,
        qty: Number(r.qty) || 0,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[/api/dine-in/guest-regulars GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
