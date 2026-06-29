import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * Distinct kitchen/bar stations that appear on MENU ITEMS, with how many items
 * use each and whether a KOT printer is already mapped to it. This drives the
 * "Kitchen stations" mapper on the printers page so every menu item can route
 * to the right station printer when the captain fires it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();

    const rows = db.prepare(`
      SELECT TRIM(station) AS station, COUNT(*) AS item_count
      FROM menu_items
      WHERE is_active = 1 AND TRIM(COALESCE(station, '')) <> ''
      GROUP BY LOWER(TRIM(station))
      ORDER BY item_count DESC
    `).all() as any[];

    const printers = db.prepare(
      `SELECT LOWER(TRIM(station)) AS station, name FROM print_stations
       WHERE role = 'kot' AND is_active = 1 AND (outlet_id = ? OR outlet_id IS NULL)`
    ).all(outletId) as any[];
    const mapped = new Map<string, string>();
    for (const p of printers) if (p.station) mapped.set(p.station, p.name);

    const stations = rows.map((r) => ({
      station: r.station,
      item_count: r.item_count,
      has_printer: mapped.has(String(r.station).toLowerCase().trim()),
      printer_name: mapped.get(String(r.station).toLowerCase().trim()) || null,
    }));

    const unmapped = stations.filter((s) => !s.has_printer).length;
    return Response.json({ stations, unmapped });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/menu-stations]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
