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
      `SELECT id, LOWER(TRIM(station)) AS station, name, kind, mirror_to_master, is_master FROM print_stations
       WHERE role = 'kot' AND is_active = 1 AND (outlet_id = ? OR outlet_id IS NULL)`
    ).all(outletId) as any[];
    const mapped = new Map<string, any>();
    for (const p of printers) if (p.station && !p.is_master) mapped.set(p.station, p);

    const stations = rows.map((r) => {
      const p = mapped.get(String(r.station).toLowerCase().trim());
      return {
        station: r.station,
        item_count: r.item_count,
        has_printer: !!p,
        printer_id: p?.id || null,
        printer_name: p?.name || null,
        kind: p?.kind || 'food',
        mirror: p ? Number(p.mirror_to_master) !== 0 : false,
      };
    });

    const unmapped = stations.filter((s) => !s.has_printer).length;

    // Distinct table zones (= floors) so the printer Floor field can be a
    // dropdown that always matches a real table zone (no typos / mismatches).
    //
    // is_active = 1 IS LOAD-BEARING. Deleting a table here is a SOFT delete —
    // the POST in api/dine-in/tables revives a deactivated row rather than
    // inserting a new one, so the row survives with is_active = 0. Without this
    // filter the dropdown kept offering the zone names of tables the owner had
    // already deleted: after renaming a floor from "1ST FLOOR" to "First Floor"
    // both appeared, and picking the dead one routes a printer at a floor no
    // live table belongs to. The tables list itself has always filtered on
    // is_active (api/dine-in/tables GET); this query was the one that did not.
    //
    // A printer already assigned to a now-dead zone does NOT vanish from the
    // form — the page adds it back as "<zone> (not a table zone)" so the
    // mis-assignment is visible instead of silently reset.
    const zones = (db.prepare(
      `SELECT DISTINCT TRIM(zone) AS zone FROM restaurant_tables
       WHERE is_active = 1 AND TRIM(COALESCE(zone, '')) <> ''
         AND (outlet_id = ? OR outlet_id IS NULL)
       ORDER BY zone`
    ).all(outletId) as any[]).map((r) => r.zone);

    return Response.json({ stations, unmapped, zones });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/menu-stations]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
