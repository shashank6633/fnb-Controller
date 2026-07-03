import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';

/**
 * POST /api/dine-in/customer-orders/[id]   (STAFF)
 *
 * Captain decision on a customer-submitted (pending_approval) order.
 * Body: { action: 'approve' | 'reject' | 'modify', items?: [{id, qty}], reason?: string }
 *
 *  - modify : edit line quantities (qty 0 removes) but keep it pending.
 *  - reject : void the staging order — nothing reaches the kitchen.
 *  - approve: (optionally apply `items` edits first, one-step modify+approve, then)
 *             fire the items to the KDS. If the table already has a live OPEN
 *             order, the items MERGE into it (one bill per table); otherwise the
 *             staging order is promoted to 'open' with a real daily number.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();

    const staging = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
    if (!staging || staging.origin !== 'customer') {
      return Response.json({ error: 'Customer order not found' }, { status: 404 });
    }
    if (staging.status !== 'pending_approval') {
      return Response.json({ error: `Order already ${staging.status === 'void' ? 'rejected' : 'processed'}` }, { status: 409 });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').toLowerCase();

    // Apply optional per-line quantity edits (shared by 'modify' and 'approve').
    const applyEdits = () => {
      const edits: any[] = Array.isArray(body?.items) ? body.items : [];
      if (!edits.length) return;
      const upd = db.prepare('UPDATE order_items SET quantity = ?, line_total = ROUND(unit_price * ?, 2) WHERE id = ? AND order_id = ?');
      const del = db.prepare('DELETE FROM order_items WHERE id = ? AND order_id = ?');
      for (const e of edits) {
        const itemId = String(e?.id || '');
        if (!itemId) continue;
        const qty = Math.max(0, Math.floor(Number(e?.qty) || 0));
        if (qty <= 0) del.run(itemId, id);
        else upd.run(qty, qty, itemId, id);
      }
    };
    const recompute = (orderId: string) => {
      const sub = (db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM order_items WHERE order_id = ?').get(orderId) as any).s || 0;
      const r = Math.round(sub * 100) / 100;
      db.prepare("UPDATE orders SET subtotal = ?, total = ?, updated_at = datetime('now') WHERE id = ?").run(r, r, orderId);
      return r;
    };

    // ── REJECT ──────────────────────────────────────────────────────────────
    if (action === 'reject') {
      const reason = String(body?.reason || '').slice(0, 200);
      db.prepare(`
        UPDATE orders SET status = 'void', voided_at = datetime('now'), updated_at = datetime('now'),
          notes = TRIM(COALESCE(notes,'') || ' [rejected by ' || ? || (CASE WHEN ?<>'' THEN ': '||? ELSE '' END) || ']')
        WHERE id = ?
      `).run(me.name || me.email, reason, reason, id);
      return Response.json({ ok: true, action: 'reject', orderId: id });
    }

    // ── MODIFY (stay pending) ────────────────────────────────────────────────
    if (action === 'modify') {
      const tx = db.transaction(() => { applyEdits(); return recompute(id); });
      const subtotal = tx();
      const items = db.prepare('SELECT id, name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?').all(id);
      return Response.json({ ok: true, action: 'modify', orderId: id, subtotal, items });
    }

    // ── APPROVE (optionally modify) → fire to kitchen ────────────────────────
    if (action === 'approve') {
      const firedKots: any[] = [];
      const result = db.transaction(() => {
        applyEdits();

        // Items to fire = this staging order's remaining lines.
        const fireItems = db.prepare(`
          SELECT oi.*, mi.item_type AS item_type, mi.prep_minutes AS mi_prep_minutes
          FROM order_items oi LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
          WHERE oi.order_id = ? AND oi.quantity > 0
        `).all(id) as any[];
        if (fireItems.length === 0) throw new Error('Nothing to approve — all lines were removed');

        // One bill per table: if a live OPEN order exists on this table, merge into it.
        const live = db.prepare(`
          SELECT * FROM orders WHERE table_id = ? AND status = 'open' AND id != ?
          ORDER BY created_at ASC LIMIT 1
        `).get(staging.table_id, id) as any;

        let targetId: string, targetOutlet: string | null, targetNumber: number, targetServer: string, merged: boolean;
        if (live) {
          // Reassign staging lines onto the live order, then void the empty shell.
          db.prepare('UPDATE order_items SET order_id = ? WHERE order_id = ?').run(live.id, id);
          db.prepare(`
            UPDATE orders SET status = 'void', voided_at = datetime('now'), updated_at = datetime('now'),
              notes = TRIM(COALESCE(notes,'') || ' [merged into order #' || CAST(? AS INTEGER) || ']')
            WHERE id = ?
          `).run(live.order_number, id);
          targetId = live.id; targetOutlet = live.outlet_id;
          targetNumber = live.order_number; targetServer = live.server_name; merged = true;
        } else {
          // Promote staging → open with a real per-outlet/day number.
          const seq = db.prepare(`
            SELECT COALESCE(MAX(order_number), 0) + 1 AS n FROM orders
            WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
          `).get(staging.outlet_id) as any;
          db.prepare(`
            UPDATE orders SET status = 'open', order_number = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(seq.n, id);
          targetId = id; targetOutlet = staging.outlet_id;
          targetNumber = seq.n; targetServer = staging.server_name || 'Customer'; merged = false;
        }

        // Fire exactly the (moved) staging lines — group by station, one KOT each.
        const tableRow = staging.table_id
          ? db.prepare('SELECT table_number, zone FROM restaurant_tables WHERE id = ?').get(staging.table_id) as any
          : null;
        const byStation: Record<string, any[]> = {};
        for (const it of fireItems) {
          const st = (it.station && String(it.station).trim()) || 'kitchen';
          (byStation[st] ||= []).push(it);
        }
        const setKot = db.prepare(
          "UPDATE order_items SET kot_id = ?, status = 'fired', fired_at = datetime('now'), prep_minutes = ? WHERE id = ?"
        );
        for (const [station, its] of Object.entries(byStation)) {
          const kseq = db.prepare(`
            SELECT COALESCE(MAX(kot_number), 0) + 1 AS n FROM kots
            WHERE (outlet_id = ? OR outlet_id IS NULL) AND date(created_at) = date('now')
          `).get(targetOutlet) as any;
          const kotId = generateId();
          const firedBy = me.name || me.email;
          db.prepare(`
            INSERT INTO kots (id, outlet_id, order_id, kot_number, station, status, fired_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'new', ?, datetime('now'), datetime('now'))
          `).run(kotId, targetOutlet, targetId, kseq.n, station, firedBy);
          for (const it of its) setKot.run(kotId, Number(it.mi_prep_minutes) || 15, it.id);
          firedKots.push({
            id: kotId, outlet_id: targetOutlet, order_id: targetId, kot_number: kseq.n, station, status: 'new',
            order_number: targetNumber, order_type: 'dine-in',
            table_number: tableRow?.table_number || null, zone: tableRow?.zone || null,
            captain: targetServer || null, fired_by: firedBy, reprint_count: 0,
            items: its.map((x) => ({ name: x.name, quantity: x.quantity, notes: x.notes, item_type: x.item_type })),
          });
        }

        const subtotal = recompute(targetId);
        return { targetId, merged, subtotal };
      });
      const out = result();

      // KDS fan-out after commit — kitchen displays light up.
      for (const k of firedKots) emitKds({ type: 'kot.new', outlet_id: k.outlet_id, station: k.station, kot: k });

      return Response.json({ ok: true, action: 'approve', orderId: out.targetId, merged: out.merged, subtotal: out.subtotal, fired_kots: firedKots });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/dine-in/customer-orders/[id] POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
