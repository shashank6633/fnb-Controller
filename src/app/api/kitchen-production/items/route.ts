import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canManageKitchenProduction } from '@/lib/auth';
import {
  BATCH_NUMBER_MODES, SERIAL_CODE_MAX, cleanTypedValue, normalizeBatchNumberMode,
} from '@/lib/production-batch-number';

/**
 * Production Items master — the fixed list batch creation selects from.
 *
 *   GET  /api/kitchen-production/items            → { items } (active only)
 *   GET  /api/kitchen-production/items?all=1      → { items } (incl. inactive)
 *   POST /api/kitchen-production/items            → create { name, category?, unit?, shelf_life_hours?, default_storage_location?,
 *                                                            is_brewery?, batch_number_mode?, batch_serial_code? }
 *   PUT  /api/kitchen-production/items            → update { id, ...fields, is_active? }
 *
 * OPT-IN query parameters (ruling 114 — Brewery Production). Without them the
 * list is exactly what it always was:
 *   kind=brewery          only items ticked as Brewery items
 *   kind=kitchen          only items NOT ticked as Brewery items
 *   with_last_batch=1     each item also carries `last_batch` — its latest batch
 *                         by production date/time, then logged time, counting
 *                         EVERY batch of the item whatever its status (active,
 *                         consumed, disposed, expired), across every outlet —
 *                         the same set the duplicate-number check looks at.
 *
 * GET is logged-in only (the item list feeds a page open to all members);
 * POST/PUT are head-chef/manager/admin (same gate as batch creation). Items are
 * never deleted — they deactivate, so old batches always keep a valid
 * production_item_id.
 */
export async function GET(request: Request) {
  try {
    // READ — logged-in only (feeds the New Batch form on a page open to all
    // members); POST/PUT below keep canManageKitchenProduction.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const sp = new URL(request.url).searchParams;
    const all = sp.get('all') === '1';
    const kind = sp.get('kind') || '';
    const where: string[] = [];
    if (!all) where.push('is_active = 1');
    if (kind === 'brewery') where.push('is_brewery = 1');
    else if (kind === 'kitchen') where.push('is_brewery = 0');
    const items = db.prepare(
      `SELECT * FROM production_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE`
    ).all() as Array<Record<string, unknown> & { id: string; last_batch?: unknown }>;

    if (sp.get('with_last_batch') === '1' && items.length) {
      const ids = items.map((it) => it.id);
      const last = db.prepare(
        `SELECT production_item_id, batch_number, production_date, production_time, status
           FROM (
             SELECT production_item_id, batch_number, production_date, production_time, status,
                    ROW_NUMBER() OVER (
                      PARTITION BY production_item_id
                      ORDER BY COALESCE(production_date, '') DESC, COALESCE(production_time, '') DESC,
                               created_at DESC, rowid DESC
                    ) AS rn
               FROM production_batches
              WHERE production_item_id IN (${ids.map(() => '?').join(',')})
           )
          WHERE rn = 1`
      ).all(...ids) as Array<{ production_item_id: string; batch_number: string; production_date: string; production_time: string; status: string }>;
      const byItem = new Map(last.map((r) => [r.production_item_id, r]));
      for (const it of items) {
        const r = byItem.get(it.id);
        it.last_batch = r
          ? { batch_number: r.batch_number || '', production_date: r.production_date || '', production_time: r.production_time || '', status: r.status || '' }
          : null;
      }
    }
    return Response.json({ items });
  } catch (e: any) {
    return Response.json({ error: e?.message || 'Failed to list items' }, { status: 500 });
  }
}

/**
 * The Brewery fields of a create/update, merged over the stored row. A field
 * the request leaves out keeps its stored value, exactly like every other
 * field here — so the Activate/Deactivate button (which sends only id +
 * is_active) never touches them.
 */
function breweryFields(
  body: { is_brewery?: unknown; batch_number_mode?: unknown; batch_serial_code?: unknown } | null | undefined,
  row: { is_brewery?: number; batch_number_mode?: string; batch_serial_code?: string } | null,
):
  { ok: true; is_brewery: number; batch_number_mode: string; batch_serial_code: string } | { ok: false; error: string } {
  const is_brewery = body?.is_brewery !== undefined ? (body.is_brewery ? 1 : 0) : (Number(row?.is_brewery) === 1 ? 1 : 0);

  let batch_number_mode = row ? normalizeBatchNumberMode(row.batch_number_mode) : 'auto';
  if (body?.batch_number_mode !== undefined) {
    const m = String(body.batch_number_mode || '').trim();
    if (!(BATCH_NUMBER_MODES as string[]).includes(m)) {
      return { ok: false, error: 'Batch number must be Automatic, Typed by staff on every batch, or Serial code + number.' };
    }
    batch_number_mode = m as typeof batch_number_mode;
  }

  let batch_serial_code = String(row?.batch_serial_code ?? '');
  if (body?.batch_serial_code !== undefined) {
    const c = cleanTypedValue(body.batch_serial_code, 'The serial code');
    if (!c.ok) return { ok: false, error: c.error };
    if (c.value.length > SERIAL_CODE_MAX) {
      return { ok: false, error: `Serial code "${c.value}" is ${c.value.length} characters — keep it to ${SERIAL_CODE_MAX} or fewer.` };
    }
    batch_serial_code = c.value;
  }

  // The setting only means anything on a Brewery item, so it is only REQUIRED
  // to be complete on one. A Kitchen item keeps whatever is stored (unused).
  if (is_brewery === 1 && batch_number_mode === 'manual_serial' && !batch_serial_code) {
    return { ok: false, error: 'Type the serial code (for example ACB) — "Serial code + number" needs one.' };
  }
  return { ok: true, is_brewery, batch_number_mode, batch_serial_code };
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef, manager or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return Response.json({ error: 'name is required' }, { status: 400 });

    const db = getDb();
    const dup = db.prepare(`SELECT id FROM production_items WHERE name = ? COLLATE NOCASE`).get(name);
    if (dup) return Response.json({ error: `"${name}" already exists in the item list` }, { status: 409 });

    const bf = breweryFields(body, null);
    if (!bf.ok) return Response.json({ error: bf.error }, { status: 400 });

    const id = generateId();
    db.prepare(
      `INSERT INTO production_items (id, name, category, unit, shelf_life_hours, default_storage_location,
                                     is_brewery, batch_number_mode, batch_serial_code)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      id, name,
      String(body?.category || '').trim(),
      String(body?.unit || '').trim(),
      Math.max(0, Number(body?.shelf_life_hours) || 0),
      String(body?.default_storage_location || '').trim(),
      bf.is_brewery, bf.batch_number_mode, bf.batch_serial_code,
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
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef, manager or admin only' }, { status: 403 });

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

    const bf = breweryFields(body, row);
    if (!bf.ok) return Response.json({ error: bf.error }, { status: 400 });

    db.prepare(
      `UPDATE production_items
          SET name = ?, category = ?, unit = ?, shelf_life_hours = ?, default_storage_location = ?,
              is_active = ?, is_brewery = ?, batch_number_mode = ?, batch_serial_code = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(
      name,
      body?.category !== undefined ? String(body.category || '').trim() : row.category,
      body?.unit !== undefined ? String(body.unit || '').trim() : row.unit,
      body?.shelf_life_hours !== undefined ? Math.max(0, Number(body.shelf_life_hours) || 0) : row.shelf_life_hours,
      body?.default_storage_location !== undefined ? String(body.default_storage_location || '').trim() : row.default_storage_location,
      body?.is_active !== undefined ? (body.is_active ? 1 : 0) : row.is_active,
      bf.is_brewery, bf.batch_number_mode, bf.batch_serial_code,
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
