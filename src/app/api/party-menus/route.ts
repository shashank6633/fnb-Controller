import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, isManagement, getCurrentOutletId } from '@/lib/auth';

/**
 * Party Menu management API — a manager-enabled LIMITED à-la-carte menu locked
 * to selected tables. See db.ts (party_menus / party_menu_items /
 * party_menu_tables) and lib/party-menu.ts.
 *
 * GET    /api/party-menus            → list (with item_count + tables)
 * GET    /api/party-menus?id=X       → detail (item_ids + table_ids + items)
 * POST   /api/party-menus            → create { name, note?, item_ids[], table_ids[], booking_id? }
 * PUT    /api/party-menus?id=X       → update { name?, note?, item_ids?, table_ids?, booking_id?, enabled? }
 * DELETE /api/party-menus?id=X       → delete
 *
 * ENABLING is a MANAGER action (isManagement) and requires ≥1 item. Everything
 * else (create, pick items, assign/switch tables, disable) is open to any staff
 * with page access — matching the flow: captain prepares + sets the table,
 * manager flips it on.
 */
export const dynamic = 'force-dynamic';

function loadDetail(db: any, id: string) {
  const pm = db.prepare('SELECT * FROM party_menus WHERE id = ?').get(id) as any;
  if (!pm) return null;
  const item_ids = (db.prepare('SELECT menu_item_id FROM party_menu_items WHERE party_menu_id = ?').all(id) as any[]).map(r => r.menu_item_id);
  const table_ids = (db.prepare('SELECT table_id FROM party_menu_tables WHERE party_menu_id = ?').all(id) as any[]).map(r => r.table_id);
  const items = item_ids.length
    ? db.prepare(`SELECT id, name, category, item_type, selling_price FROM menu_items WHERE id IN (${item_ids.map(() => '?').join(',')})`).all(...item_ids)
    : [];
  const tables = table_ids.length
    ? db.prepare(`SELECT id, table_number, zone, COALESCE(section,'') AS section FROM restaurant_tables WHERE id IN (${table_ids.map(() => '?').join(',')})`).all(...table_ids)
    : [];
  return { ...pm, item_ids, table_ids, items, tables };
}

export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (id) {
      const detail = loadDetail(db, id);
      if (!detail) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ party_menu: detail });
    }
    const rows = db.prepare(`
      SELECT pm.*,
        (SELECT COUNT(*) FROM party_menu_items  WHERE party_menu_id = pm.id) AS item_count,
        (SELECT COUNT(*) FROM party_menu_tables WHERE party_menu_id = pm.id) AS table_count
      FROM party_menus pm
      ORDER BY pm.enabled DESC, pm.updated_at DESC
    `).all() as any[];
    // Attach the table numbers for display (small N).
    const tblStmt = db.prepare(`
      SELECT rt.table_number FROM party_menu_tables pmt
      JOIN restaurant_tables rt ON rt.id = pmt.table_id
      WHERE pmt.party_menu_id = ? ORDER BY rt.table_number
    `);
    const party_menus = rows.map(r => ({ ...r, tables: (tblStmt.all(r.id) as any[]).map(t => t.table_number) }));
    return Response.json({ party_menus });
  } catch (e: any) {
    console.error('[/api/party-menus GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const b = await request.json();
    const name = String(b?.name || '').trim();
    if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });
    const note = String(b?.note || '').trim();
    const bookingId = b?.booking_id ? String(b.booking_id).trim() : null;
    const itemIds: string[] = Array.isArray(b?.item_ids) ? [...new Set<string>(b.item_ids.map((x: any) => String(x)))] : [];
    const tableIds: string[] = Array.isArray(b?.table_ids) ? [...new Set<string>(b.table_ids.map((x: any) => String(x)))] : [];
    const outletId = await getCurrentOutletId();

    const id = generateId();
    const insItem = db.prepare('INSERT OR IGNORE INTO party_menu_items (party_menu_id, menu_item_id) VALUES (?, ?)');
    const insTbl = db.prepare('INSERT OR IGNORE INTO party_menu_tables (party_menu_id, table_id) VALUES (?, ?)');
    db.transaction(() => {
      db.prepare(`INSERT INTO party_menus (id, name, note, enabled, booking_id, outlet_id, created_by)
                  VALUES (?, ?, ?, 0, ?, ?, ?)`).run(id, name, note, bookingId, outletId, me.email);
      for (const mi of itemIds) insItem.run(id, mi);
      for (const t of tableIds) insTbl.run(id, t);
    })();
    return Response.json({ ok: true, party_menu: loadDetail(db, id) }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/party-menus POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    const existing = db.prepare('SELECT id FROM party_menus WHERE id = ?').get(id);
    if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });
    const b = await request.json();

    // Enabling is a MANAGER action and needs ≥1 item.
    if (b?.enabled === true) {
      if (!isManagement(me)) return Response.json({ error: 'Only a manager can enable a party menu.' }, { status: 403 });
      // Item count after this update (use incoming item_ids if provided, else current).
      const count = Array.isArray(b?.item_ids)
        ? new Set(b.item_ids.map((x: any) => String(x))).size
        : (db.prepare('SELECT COUNT(*) c FROM party_menu_items WHERE party_menu_id = ?').get(id) as any).c;
      if (!count) return Response.json({ error: 'Pick at least one menu item before enabling.' }, { status: 400 });
      const tcount = Array.isArray(b?.table_ids)
        ? new Set(b.table_ids.map((x: any) => String(x))).size
        : (db.prepare('SELECT COUNT(*) c FROM party_menu_tables WHERE party_menu_id = ?').get(id) as any).c;
      if (!tcount) return Response.json({ error: 'Assign at least one table before enabling.' }, { status: 400 });
    }

    const sets: string[] = []; const args: any[] = [];
    if (typeof b?.name === 'string') { sets.push('name = ?'); args.push(b.name.trim()); }
    if (typeof b?.note === 'string') { sets.push('note = ?'); args.push(b.note.trim()); }
    if (b?.booking_id !== undefined) { sets.push('booking_id = ?'); args.push(b.booking_id ? String(b.booking_id).trim() : null); }
    if (typeof b?.enabled === 'boolean') { sets.push('enabled = ?'); args.push(b.enabled ? 1 : 0); }

    const insItem = db.prepare('INSERT OR IGNORE INTO party_menu_items (party_menu_id, menu_item_id) VALUES (?, ?)');
    const insTbl = db.prepare('INSERT OR IGNORE INTO party_menu_tables (party_menu_id, table_id) VALUES (?, ?)');
    db.transaction(() => {
      if (sets.length) {
        sets.push("updated_at = datetime('now')");
        db.prepare(`UPDATE party_menus SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
      } else {
        db.prepare("UPDATE party_menus SET updated_at = datetime('now') WHERE id = ?").run(id);
      }
      if (Array.isArray(b?.item_ids)) {
        db.prepare('DELETE FROM party_menu_items WHERE party_menu_id = ?').run(id);
        for (const mi of [...new Set<string>(b.item_ids.map((x: any) => String(x)))]) insItem.run(id, mi);
      }
      if (Array.isArray(b?.table_ids)) {   // switchable tables — full replace
        db.prepare('DELETE FROM party_menu_tables WHERE party_menu_id = ?').run(id);
        for (const t of [...new Set<string>(b.table_ids.map((x: any) => String(x)))]) insTbl.run(id, t);
      }
    })();
    return Response.json({ ok: true, party_menu: loadDetail(db, id) });
  } catch (e: any) {
    console.error('[/api/party-menus PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
    db.transaction(() => {
      db.prepare('DELETE FROM party_menu_items WHERE party_menu_id = ?').run(id);
      db.prepare('DELETE FROM party_menu_tables WHERE party_menu_id = ?').run(id);
      db.prepare('DELETE FROM party_menus WHERE id = ?').run(id);
    })();
    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('[/api/party-menus DELETE]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
