import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { canWorkTable } from '@/lib/captain-area';
import { autoSaveCrmGuest } from '@/lib/ct/guest-autosave';

/** GET — list orders for the active outlet. ?status=open (default) | settled | all. */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const status = new URL(request.url).searchParams.get('status') || 'open';

    let where = '(o.outlet_id = ? OR o.outlet_id IS NULL)';
    const params: any[] = [outletId];
    if (status !== 'all') { where += ' AND o.status = ?'; params.push(status); }

    const orders = db.prepare(`
      SELECT o.*, t.table_number, t.zone,
             (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
      FROM orders o
      LEFT JOIN restaurant_tables t ON o.table_id = t.id
      WHERE ${where}
      ORDER BY o.created_at DESC
    `).all(...params) as any[];

    // ── WHAT IS STILL OWED ON A HELD BILL ────────────────────────────────────
    // /cashier's Outstanding tile rendered o.total — the whole frozen bill —
    // even when part of it had already been collected on the bill's BOH record,
    // so the operator was shown a figure ₹200 larger than the debt and the
    // settle route (before its own netting guard) took it. The balance is read
    // here so the tile and the Collect button can say the truth.
    //
    // Separate, isolated query rather than a join: a database without the BOH
    // tables must still list orders. On any failure every row simply carries no
    // boh_* field, which is exactly how this endpoint behaved before.
    //
    // `status <> 'void'` AND NOT `status = 'open'`, MATCHING bohTillNetting()
    // EXACTLY. A write-off CLOSES the record and deliberately leaves the bill
    // 'on_hold', so with `= 'open'` a written-off bill that had already taken a
    // deposit carried no boh_balance at all and this tile fell back to the whole
    // frozen total: the server collected the netted Rs 800 while the operator was
    // shown Rs 1,100 and would have taken Rs 1,100 in hand. The guest is safe
    // either way now, but a drawer surplus and an argument at the counter are
    // not. The two predicates have to be the same predicate.
    try {
      const held = orders.filter((o) => o.status === 'on_hold');
      if (held.length) {
        const paid = db.prepare(`
          SELECT b.order_id, b.id AS boh_id,
                 COALESCE((SELECT SUM(p.amount) FROM boh_payments p WHERE p.boh_id = b.id), 0) AS paid
            FROM boh_bills b WHERE b.status <> 'void'
        `).all() as any[];
        const byOrder = new Map(paid.map((r) => [String(r.order_id), r]));
        for (const o of held) {
          const r = byOrder.get(String(o.id));
          if (!r) continue;
          o.boh_id = String(r.boh_id);
          o.boh_paid = Math.round((Number(r.paid) || 0) * 100) / 100;
          o.boh_balance = Math.round((Math.round(Number(o.total) || 0) - o.boh_paid) * 100) / 100;
        }
      }
    } catch { /* no BOH tables on this database — the list is unchanged */ }

    return Response.json({ items: orders });
  } catch (e: any) {
    console.error('[/api/dine-in/orders GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** POST — open a new order on a table (or takeaway). Returns the order id. */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const db = getDb();
    const outletId = await getCurrentOutletId();
    const b = await request.json();
    const tableId = b.table_id || null;
    const orderType = String(b.order_type || 'dine-in');
    const guestName = String(b.guest_name || '').trim();
    const guestMobile = String(b.guest_mobile || '').trim();

    // Area lock: a restricted captain may only open tables in their assigned area.
    if (tableId && !canWorkTable(db, me, tableId)) {
      return Response.json({ error: 'This table is outside your assigned area.' }, { status: 403 });
    }

    // A table can hold only one open order at a time — reuse it if present.
    if (tableId) {
      const existing = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open'").get(tableId) as any;
      if (existing) return Response.json({ id: existing.id, reused: true });
    }

    // Per-outlet, per-day running order number.
    const seq = db.prepare(`
      SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders
      WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
    `).get(outletId) as any;

    const id = generateId();
    db.prepare(`
      INSERT INTO orders (id, outlet_id, order_number, table_id, status, order_type, bill_type, covers,
                          server_id, server_name, guest_name, guest_mobile, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, 'normal', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, outletId, seq?.n || 1, tableId, orderType, Number(b.covers) || 0, me.id, me.name || me.email, guestName, guestMobile);

    // Auto-capture the guest into the CRM (idempotent, best-effort).
    if (guestMobile) autoSaveCrmGuest(db, { phone: guestMobile, name: guestName, source: 'dine-in', outletId });

    return Response.json({ id, order_number: seq?.n || 1, success: true }, { status: 201 });
  } catch (e: any) {
    console.error('[/api/dine-in/orders POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
