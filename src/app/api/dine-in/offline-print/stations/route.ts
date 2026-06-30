import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

/**
 * Print stations — map a logical role (a customer "bill" printer or a kitchen
 * "kot" station) to a physical printer the local print bridge can reach over IP
 * or USB. Purely additive config; printing itself happens browser → local
 * bridge → printer and never depends on this server during an outage.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const stations = db.prepare(
      `SELECT * FROM print_stations WHERE (outlet_id = ? OR outlet_id IS NULL)
       ORDER BY role, sort_order, name`
    ).all(outletId);
    return Response.json({ stations });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/stations GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Admin or manager only' }, { status: 403 });
    }
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const b = await request.json();

    const name = String(b.name || '').trim();
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });
    const role = b.role === 'bill' ? 'bill' : 'kot';
    const transport = b.transport === 'usb' ? 'usb' : 'ip';
    const target = String(b.target || '').trim();
    const paperWidth = Number(b.paper_width) === 32 ? 32 : 48;
    const copies = Math.max(1, Math.min(5, Number(b.copies) || 1));
    const station = String(b.station || '').trim();
    const floor = String(b.floor || '').trim();
    const backupTarget = String(b.backup_target || '').trim();
    const kind = b.kind === 'bar' ? 'bar' : 'food';
    const isMaster = b.is_master ? 1 : 0;
    const mirror = b.mirror_to_master === undefined ? 1 : (b.mirror_to_master ? 1 : 0);

    const id = generateId();
    db.prepare(
      `INSERT INTO print_stations (id, outlet_id, name, role, station, transport, target, paper_width, copies, floor, backup_target, kind, is_master, mirror_to_master, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(id, outletId, name, role, station, transport, target, paperWidth, copies, floor, backupTarget, kind, isMaster, mirror, Number(b.sort_order) || 0);

    const created = db.prepare('SELECT * FROM print_stations WHERE id = ?').get(id);
    return Response.json({ station: created }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/offline-print/stations POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
