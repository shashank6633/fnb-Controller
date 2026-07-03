import { getDb } from '@/lib/db';
import { resolveTableByToken, buildCustomerMenu } from '@/lib/customer';

/**
 * GET /api/customer/menu?t=<qr_token>
 *
 * PUBLIC (no staff session) — the customer scans the table's QR standee, which
 * opens /menu?t=<token>. This returns everything the design app needs to boot:
 * the resolved table, brand name, and the full menu in the design's shape.
 *
 * Scoped entirely by the table's qr_token; an unknown/inactive token → 404.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('t') || url.searchParams.get('table') || '';
    const table = resolveTableByToken(token);
    if (!table) {
      return Response.json({ ok: false, error: 'This QR code is not linked to a table. Please ask our staff.' }, { status: 404 });
    }

    const db = getDb();
    const brandRow = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any;
    const brand = { name: (brandRow?.value || 'Akan').toString() };

    const menu = buildCustomerMenu(table.outlet_id);

    return Response.json({
      ok: true,
      table: { id: table.id, number: table.table_number, zone: table.zone, seats: table.seats },
      brand,
      menu,
    }, {
      // Menu can be cached briefly at the edge/browser; it changes rarely.
      headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120' },
    });
  } catch (e: any) {
    console.error('[/api/customer/menu GET]', e);
    return Response.json({ ok: false, error: 'Could not load the menu.' }, { status: 500 });
  }
}
