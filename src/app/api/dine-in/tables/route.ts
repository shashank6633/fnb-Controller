import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';

// Management (create/edit/delete) is admin-or-manager; listing is any signed-in user.
async function requireManager() {
  const me = await getCurrentUser();
  if (!me) return { ok: false as const, status: 401, message: 'Sign in required' };
  if (me.role !== 'admin' && me.role !== 'manager') {
    return { ok: false as const, status: 403, message: 'Manager role required' };
  }
  return { ok: true as const, user: me };
}

/** GET — list tables for the active outlet, each annotated with its open order (if any). */
export async function GET() {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const tables = db.prepare(`
      SELECT t.*,
             o.id AS open_order_id, o.order_number AS open_order_number, o.total AS open_order_total,
             o.server_id AS open_order_server_id, o.server_name AS open_order_captain
      FROM restaurant_tables t
      LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
      WHERE t.is_active = 1 AND (t.outlet_id = ? OR t.outlet_id IS NULL)
      ORDER BY t.zone, CAST(t.table_number AS INTEGER), t.table_number
    `).all(outletId);
    return Response.json({ items: tables });
  } catch (e: any) {
    console.error('[/api/dine-in/tables GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** POST — create a table (manager). */
export async function POST(request: Request) {
  const auth = await requireManager();
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const b = await request.json();
    const tableNumber = String(b.table_number ?? '').trim();
    if (!tableNumber) return Response.json({ error: 'table_number is required' }, { status: 400 });
    const outletId = await getCurrentOutletId();
    const id = generateId();
    db.prepare(`
      INSERT INTO restaurant_tables (id, outlet_id, table_number, zone, seats, qr_token, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).run(id, outletId, tableNumber, String(b.zone ?? '').trim(), Number(b.seats) || 2, generateId());
    return Response.json({ id, success: true }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/tables POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** PUT — edit a table (manager). */
export async function PUT(request: Request) {
  const auth = await requireManager();
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const b = await request.json();
    if (!b.id) return Response.json({ error: 'id is required' }, { status: 400 });
    const existing = db.prepare('SELECT * FROM restaurant_tables WHERE id = ?').get(b.id) as any;
    if (!existing) return Response.json({ error: 'Table not found' }, { status: 404 });
    db.prepare(`
      UPDATE restaurant_tables
      SET table_number = ?, zone = ?, seats = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      String(b.table_number ?? existing.table_number).trim(),
      String(b.zone ?? existing.zone).trim(),
      Number(b.seats) || existing.seats,
      b.is_active === undefined ? existing.is_active : (b.is_active ? 1 : 0),
      b.id,
    );
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[/api/dine-in/tables PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** DELETE — deactivate a table (manager). Refuses if it has an open order. */
export async function DELETE(request: Request) {
  const auth = await requireManager();
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const openOrder = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open'").get(id);
    if (openOrder) return Response.json({ error: 'Table has an open order — settle or void it first' }, { status: 409 });
    db.prepare("UPDATE restaurant_tables SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(id);
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[/api/dine-in/tables DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
