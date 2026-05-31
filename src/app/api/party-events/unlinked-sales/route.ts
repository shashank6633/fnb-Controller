import { getDb } from '@/lib/db';

/**
 * Sales rows eligible to be manually attributed to a party event.
 *
 * GET /api/party-events/unlinked-sales?date=YYYY-MM-DD
 *   or
 * GET /api/party-events/unlinked-sales?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns party-looking sales rows that are not yet linked to any event.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PARTY_PREDICATE = `(s.item_name LIKE '% P' OR LOWER(s.category) IN ('party package','custom'))`;

export async function GET(request: Request) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const date = url.searchParams.get('date');
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');

    let where = '';
    const params: any[] = [];
    if (date) {
      where = 's.date = ?';
      params.push(date);
    } else if (from && to) {
      where = 's.date BETWEEN ? AND ?';
      params.push(from, to);
    } else {
      return Response.json({ error: 'Need either ?date=YYYY-MM-DD or ?from=&to=' }, { status: 400 });
    }

    const rows = db.prepare(`
      SELECT s.id, s.item_name, s.quantity_sold AS qty, s.total_revenue AS revenue,
             s.bill_type, s.date, s.category
      FROM sales s
      WHERE ${where}
        AND ${PARTY_PREDICATE}
        AND s.linked_event_name IS NULL
      ORDER BY s.date, s.sale_time, s.item_name
    `).all(...params) as any[];

    return Response.json({
      sales: rows.map(r => ({
        id: r.id,
        item_name: r.item_name,
        qty: r.qty,
        revenue: Math.round((r.revenue || 0) * 100) / 100,
        bill_type: r.bill_type,
        date: r.date,
        category: r.category || '',
      })),
    });
  } catch (e: any) {
    console.error('[party-events/unlinked-sales]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
