import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { captainAreaFilter } from '@/lib/captain-area';

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
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    // Restrict a locked-in captain to their assigned floors/tables (server-side —
    // never rely on client filtering). null = no restriction. `?scope=all` bypasses
    // it for the offline cache warmer: the offline mini-POS must offer EVERY table
    // (any captain may use it during an outage), and table existence isn't sensitive
    // — actually working a table is still gated server-side by canWorkTable().
    const scopeAll = new URL(request.url).searchParams.get('scope') === 'all';
    const area = scopeAll ? null : captainAreaFilter(db, me);
    const tables = db.prepare(`
      SELECT t.*,
             o.id AS open_order_id, o.order_number AS open_order_number, o.total AS open_order_total,
             o.server_id AS open_order_server_id, o.server_name AS open_order_captain,
             o.bill_printed_at AS open_order_bill_printed_at
      FROM restaurant_tables t
      LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'
      WHERE t.is_active = 1 AND (t.outlet_id = ? OR t.outlet_id IS NULL)${area ? ` AND ${area.sql}` : ''}
      ORDER BY t.zone, t.section,
               CAST(substr(t.table_number, length(COALESCE(t.section,'')) + 1) AS INTEGER),
               t.table_number
    `).all(outletId, ...(area ? area.params : []));
    return Response.json({ items: tables });
  } catch (e: any) {
    console.error('[/api/dine-in/tables GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** POST — create table(s) (manager).
 *  Single:  { table_number, zone?, seats? }
 *  Bulk:    { table_numbers: string[], zone?, seats? }  → creates many at once,
 *           skipping any number that already exists for this outlet. Each new
 *           table gets its own qr_token. Returns { created, skipped, skippedNumbers }. */
export async function POST(request: Request) {
  const auth = await requireManager();
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  try {
    const db = getDb();
    const b = await request.json();
    const outletId = await getCurrentOutletId();
    const zone = String(b.zone ?? '').trim();
    const section = String(b.section ?? '').trim().slice(0, 40);
    const seats = Number(b.seats) || 2;

    // Normalise to a list (single or bulk), de-duped + trimmed, cap the batch.
    const raw: any[] = Array.isArray(b.table_numbers) ? b.table_numbers : [b.table_number];
    const seen = new Set<string>();
    const wanted: string[] = [];
    for (const v of raw) {
      const n = String(v ?? '').trim();
      if (!n || seen.has(n)) continue;
      seen.add(n); wanted.push(n);
    }
    if (!wanted.length) return Response.json({ error: 'table_number is required' }, { status: 400 });
    if (wanted.length > 500) return Response.json({ error: 'Too many tables at once (max 500).' }, { status: 400 });

    // Skip numbers that already exist for this outlet (active or inactive) so a
    // bulk add never creates duplicates or clashes with a deactivated table.
    const existsStmt = db.prepare(
      "SELECT 1 FROM restaurant_tables WHERE table_number = ? AND (outlet_id = ? OR (outlet_id IS NULL AND ? IS NULL)) LIMIT 1",
    );
    const ins = db.prepare(`
      INSERT INTO restaurant_tables (id, outlet_id, table_number, zone, section, seats, qr_token, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);
    const skippedNumbers: string[] = [];
    let created = 0;
    let firstId = '';
    const tx = db.transaction(() => {
      for (const n of wanted) {
        if (existsStmt.get(n, outletId, outletId)) { skippedNumbers.push(n); continue; }
        const id = generateId();
        ins.run(id, outletId, n, zone, section, seats, generateId());
        if (!firstId) firstId = id;
        created++;
      }
    });
    tx();

    return Response.json(
      { success: true, id: firstId || undefined, created, skipped: skippedNumbers.length, skippedNumbers },
      { status: 201 },
    );
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
      SET table_number = ?, zone = ?, section = ?, seats = ?, is_active = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      String(b.table_number ?? existing.table_number).trim(),
      String(b.zone ?? existing.zone).trim(),
      String(b.section ?? existing.section ?? '').trim().slice(0, 40),
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
