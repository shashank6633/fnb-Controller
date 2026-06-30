import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canApproveTableOp, verifyApprover } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';
import type Database from 'better-sqlite3';

/** Recompute and persist order totals from its line items + discount. */
function recomputeTotals(db: Database.Database, orderId: string) {
  const items = db.prepare('SELECT quantity, unit_price, tax_value FROM order_items WHERE order_id = ?').all(orderId) as any[];
  let subtotal = 0, tax = 0;
  for (const it of items) {
    const line = it.unit_price * it.quantity;
    subtotal += line;
    tax += line * (it.tax_value || 0) / 100;
  }
  const order = db.prepare('SELECT discount FROM orders WHERE id = ?').get(orderId) as any;
  const discount = order?.discount || 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  const total = Math.max(0, r(subtotal + tax - discount));
  db.prepare(`UPDATE orders SET subtotal = ?, tax_total = ?, total = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(r(subtotal), r(tax), total, orderId);
}

function loadOrder(db: Database.Database, id: string) {
  const order = db.prepare(`
    SELECT o.*, t.table_number, t.zone FROM orders o
    LEFT JOIN restaurant_tables t ON o.table_id = t.id WHERE o.id = ?
  `).get(id) as any;
  if (!order) return null;
  // Join the KOT so the captain can see each item's kitchen state
  // (pending → new/preparing/ready/served).
  const items = db.prepare(`
    SELECT oi.*, k.status AS kot_status
    FROM order_items oi
    LEFT JOIN kots k ON k.id = oi.kot_id
    WHERE oi.order_id = ? ORDER BY oi.created_at ASC
  `).all(id);
  // Each fired KOT with its PRINT outcome, joined from the print-job journal the
  // counter's print agent reports back to (ref_id = kot.id). Lets the captain
  // see whether a ticket actually reached the printer.
  //   print_status: 'printed' | 'failed' | 'queued' | null(no report yet)
  const kots = db.prepare(`
    SELECT k.id, k.kot_number, k.station, k.status, k.created_at, k.reprint_count,
      (SELECT CASE
         WHEN COUNT(*) = 0 THEN NULL
         WHEN SUM(CASE WHEN j.status = 'printed' THEN 1 ELSE 0 END) > 0 THEN 'printed'
         WHEN SUM(CASE WHEN j.status = 'failed'  THEN 1 ELSE 0 END) > 0 THEN 'failed'
         ELSE 'queued' END
       FROM print_jobs j WHERE j.ref_id = k.id AND j.source IN ('fire','reprint')) AS print_status,
      (SELECT j.last_error FROM print_jobs j
         WHERE j.ref_id = k.id AND j.source IN ('fire','reprint') AND j.status = 'failed'
         ORDER BY j.created_at DESC LIMIT 1) AS print_error
    FROM kots k WHERE k.order_id = ? ORDER BY k.kot_number ASC
  `).all(id);
  return { ...order, items, kots };
}

/** GET — order with its line items. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = loadOrder(db, id);
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    return Response.json({ order });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id] GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/** PATCH — line-item operations + order meta. Body: { action, ... }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Order is not open' }, { status: 409 });

    const b = await req.json();
    const action = b.action;

    // Transfer + Merge are supervised: a Cashier/Manager/Admin must authorize.
    // If the signed-in captain can't, they pass an approver's login for an
    // on-the-spot override; we verify it server-side and record who approved.
    let approvedBy: string | null = null;
    if (action === 'transfer' || action === 'merge') {
      if (canApproveTableOp(me)) {
        approvedBy = me.email;
      } else {
        const approver = await verifyApprover(b.approver_email, b.approver_password);
        if (!approver || !canApproveTableOp(approver)) {
          return Response.json(
            { error: 'A Cashier or Manager must approve this. Enter their login to continue.', needs_approval: true },
            { status: 403 },
          );
        }
        approvedBy = approver.email;
      }
    }

    const firedKots: any[] = [];   // populated by 'fire', emitted after commit
    const run = db.transaction(() => {
      switch (action) {
        case 'add_item': {
          const mi = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(b.menu_item_id) as any;
          if (!mi) throw new Error('Menu item not found');
          if (!(mi.selling_price > 0)) throw new Error(`"${mi.name}" has no price — set it on the Menu Items page first`);
          const qty = Number(b.quantity) > 0 ? Number(b.quantity) : 1;
          // notes carries the captain's modifiers + cooking instructions (e.g.
          // "Less spicy · Extra gravy · No onion"). Merge only an identical
          // PENDING line (same item AND same notes) so two of the same dish with
          // different modifiers stay separate. Desktop callers send no notes →
          // behave as before (merge by item).
          const notes = String(b.notes || '').trim();
          const existing = db.prepare(
            "SELECT * FROM order_items WHERE order_id = ? AND menu_item_id = ? AND COALESCE(notes,'') = ? AND status = 'pending'"
          ).get(id, mi.id, notes) as any;
          if (existing) {
            const newQty = existing.quantity + qty;
            db.prepare('UPDATE order_items SET quantity = ?, line_total = ? WHERE id = ?')
              .run(newQty, Math.round(existing.unit_price * newQty * 100) / 100, existing.id);
          } else {
            db.prepare(`
              INSERT INTO order_items (id, order_id, menu_item_id, recipe_id, name, station, quantity, unit_price, tax_value, line_total, status, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
            `).run(generateId(), id, mi.id, mi.recipe_id || null, mi.name, mi.station || '', qty,
                   mi.selling_price, mi.tax_value || 0, Math.round(mi.selling_price * qty * 100) / 100, notes);
          }
          break;
        }
        case 'set_qty': {
          const qty = Number(b.quantity);
          const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(b.item_id, id) as any;
          if (!item) throw new Error('Line item not found');
          if (item.status !== 'pending') throw new Error('Item already sent to kitchen — cannot change it');
          if (qty <= 0) db.prepare('DELETE FROM order_items WHERE id = ?').run(b.item_id);
          else db.prepare('UPDATE order_items SET quantity = ?, line_total = ? WHERE id = ?')
            .run(qty, Math.round(item.unit_price * qty * 100) / 100, b.item_id);
          break;
        }
        case 'remove_item':
          db.prepare("DELETE FROM order_items WHERE id = ? AND order_id = ? AND status = 'pending'").run(b.item_id, id);
          break;
        case 'fire': {
          // Pull item_type from the menu so the expediter copy can keep the Main
          // KITCHEN strictly food and the Main BAR strictly drinks, regardless of
          // how a station printer's Group is set.
          const pending = db.prepare(`
            SELECT oi.*, mi.item_type AS item_type
            FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
            WHERE oi.order_id = ? AND oi.status = 'pending'
          `).all(id) as any[];
          if (pending.length === 0) throw new Error('No new items to send to the kitchen');
          const tableRow = order.table_id
            ? db.prepare('SELECT table_number, zone FROM restaurant_tables WHERE id = ?').get(order.table_id) as any
            : null;
          // Group pending items by station — one KOT per station.
          const byStation: Record<string, any[]> = {};
          for (const it of pending) {
            const st = (it.station && it.station.trim()) || 'kitchen';
            (byStation[st] ||= []).push(it);
          }
          const setKot = db.prepare("UPDATE order_items SET kot_id = ?, status = 'fired' WHERE id = ?");
          for (const [station, its] of Object.entries(byStation)) {
            const seq = db.prepare(`
              SELECT COALESCE(MAX(kot_number), 0) + 1 AS n FROM kots
              WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
            `).get(order.outlet_id) as any;
            const kotId = generateId();
            const firedBy = me.name || me.email;   // the captain who punched THIS KOT
            db.prepare(`
              INSERT INTO kots (id, outlet_id, order_id, kot_number, station, status, fired_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'new', ?, datetime('now'), datetime('now'))
            `).run(kotId, order.outlet_id, id, seq.n, station, firedBy);
            for (const it of its) setKot.run(kotId, it.id);
            firedKots.push({
              id: kotId, outlet_id: order.outlet_id, order_id: id, kot_number: seq.n, station, status: 'new',
              order_number: order.order_number, order_type: order.order_type,
              table_number: tableRow?.table_number || null, zone: tableRow?.zone || null,
              captain: order.server_name || null,   // captain who opened the table (1st captain)
              fired_by: firedBy,                     // captain who punched this KOT
              reprint_count: 0,                      // 0 = ORIGINAL
              items: its.map((x) => ({ name: x.name, quantity: x.quantity, notes: x.notes, item_type: x.item_type })),
            });
          }
          // TODO Phase 2.1: socket-print each fired KOT to its station's LAN ESC/POS printer here.
          break;
        }
        case 'set_meta':
          db.prepare(`UPDATE orders SET covers = ?, discount = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(b.covers === undefined ? order.covers : Number(b.covers) || 0,
                 b.discount === undefined ? order.discount : Math.max(0, Number(b.discount) || 0),
                 b.notes === undefined ? order.notes : String(b.notes), id);
          break;
        case 'transfer': {
          // Move this open order to a different (free) table. Authorization was
          // already checked above (approvedBy is set).
          const targetId = b.target_table_id;
          if (!targetId) throw new Error('Pick a table to move to');
          const target = db.prepare('SELECT id, table_number FROM restaurant_tables WHERE id = ? AND is_active = 1').get(targetId) as any;
          if (!target) throw new Error('Target table not found');
          if (targetId === order.table_id) throw new Error('Order is already on that table');
          const busy = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open' AND id != ?").get(targetId, id);
          if (busy) throw new Error('That table already has an open order — use Merge instead');
          db.prepare(`UPDATE orders SET table_id = ?, updated_at = datetime('now') WHERE id = ?`).run(targetId, id);
          break;
        }
        case 'merge': {
          // Pull another open order's items (and KOTs) into this one, then close
          // the source. Authorization already checked above.
          const srcId = b.source_order_id;
          if (!srcId || srcId === id) throw new Error('Pick another table to merge in');
          const src = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'open'").get(srcId) as any;
          if (!src) throw new Error('That order is not open');
          db.prepare('UPDATE order_items SET order_id = ? WHERE order_id = ?').run(id, srcId);
          db.prepare('UPDATE kots SET order_id = ? WHERE order_id = ?').run(id, srcId);
          db.prepare(`UPDATE orders SET status = 'merged', settled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(srcId);
          break;
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
      recomputeTotals(db, id);
    });
    run();

    // Notify the KDS after the data is committed.
    for (const k of firedKots) emitKds({ type: 'kot.new', outlet_id: k.outlet_id, station: k.station, kot: k });

    // fired_kots lets the client print each KOT via the local bridge (offline
    // printing). Empty for non-fire actions; existing callers ignore it.
    return Response.json({ order: loadOrder(db, id), fired_kots: firedKots, approved_by: approvedBy });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id] PATCH]', e);
    return Response.json({ error: e.message }, { status: 400 });
  }
}
