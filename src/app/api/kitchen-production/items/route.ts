import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canManageKitchenProduction } from '@/lib/auth';

/**
 * Production Items master — the fixed list batch creation selects from.
 *
 *   GET  /api/kitchen-production/items            → { items } (active only)
 *   GET  /api/kitchen-production/items?all=1      → { items } (incl. inactive)
 *   POST /api/kitchen-production/items            → create { name, category?, unit?, shelf_life_hours?, default_storage_location? }
 *   PUT  /api/kitchen-production/items            → update { id, ...fields, is_active? }
 *
 * HOD/admin only (same gate as batch creation). Items are never deleted — they
 * deactivate, so old batches always keep a valid production_item_id.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });
    const db = getDb();
    const all = new URL(request.url).searchParams.get('all') === '1';
    const items = db.prepare(
      `SELECT * FROM production_items ${all ? '' : 'WHERE is_active = 1'} ORDER BY name COLLATE NOCASE`
    ).all();
    return Response.json({ items });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to list items' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });

    const db = getDb();
    const dup = db.prepare(`SELECT id FROM production_items WHERE name = ? COLLATE NOCASE`).get(name);
    if (dup) return Response.json({ error: `"${name}" already exists in the item list` }, { status: 409 });

    const id = generateId();
    db.prepare(
      `INSERT INTO production_items (id, name, category, unit, shelf_life_hours, default_storage_location)
       VALUES (?,?,?,?,?,?)`
    ).run(
      id, name,
      String(body?.category || '').trim(),
      String(body?.unit || '').trim(),
      Math.max(0, Number(body?.shelf_life_hours) || 0),
      String(body?.default_storage_location || '').trim(),
    );
    const item = db.prepare(`SELECT * FROM production_items WHERE id = ?`).get(id);
    return Response.json({ item });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to create item' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const id = String(body?.id || '').trim();
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

    const db = getDb();
    const row = db.prepare(`SELECT * FROM production_items WHERE id = ?`).get(id) as any;
    if (!row) return Response.json({ error: 'Item not found' }, { status: 404 });

    const name = body?.name !== undefined ? String(body.name || '').trim() : row.name;
    if (!name) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
    const dup = db.prepare(`SELECT id FROM production_items WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, id);
    if (dup) return Response.json({ error: `"${name}" already exists in the item list` }, { status: 409 });

    db.prepare(
      `UPDATE production_items
          SET name = ?, category = ?, unit = ?, shelf_life_hours = ?, default_storage_location = ?,
              is_active = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(
      name,
      body?.category !== undefined ? String(body.category || '').trim() : row.category,
      body?.unit !== undefined ? String(body.unit || '').trim() : row.unit,
      body?.shelf_life_hours !== undefined ? Math.max(0, Number(body.shelf_life_hours) || 0) : row.shelf_life_hours,
      body?.default_storage_location !== undefined ? String(body.default_storage_location || '').trim() : row.default_storage_location,
      body?.is_active !== undefined ? (body.is_active ? 1 : 0) : row.is_active,
      id,
    );
    // Keep display names on existing batches in sync with a rename — FIFO already
    // groups by production_item_id, so this is cosmetic consistency for lists/labels.
    if (name !== row.name) {
      db.prepare(`UPDATE production_batches SET item_name = ?, updated_at = datetime('now') WHERE production_item_id = ?`).run(name, id);
    }
    const item = db.prepare(`SELECT * FROM production_items WHERE id = ?`).get(id);
    return Response.json({ item });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to update item' }, { status: 500 });
  }
}
