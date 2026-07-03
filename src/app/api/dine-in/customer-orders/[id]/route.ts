import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { emitKds } from '@/lib/kds-bus';
import { fireStagingOrder } from '@/lib/kot-fire';

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
      // The approving captain takes ownership of the table (server_id/name), so
      // this table's future QR orders + service requests route to them. Shared
      // fire logic with direct QR ordering — see src/lib/kot-fire.ts.
      const out = fireStagingOrder(db, id, {
        firedBy: me.name || me.email,
        serverId: me.id,
        edits: Array.isArray(body?.items) ? body.items : undefined,
      });

      // KDS fan-out after commit — kitchen displays light up.
      for (const k of out.firedKots) emitKds({ type: 'kot.new', outlet_id: k.outlet_id, station: k.station, kot: k });

      return Response.json({ ok: true, action: 'approve', orderId: out.targetId, merged: out.merged, subtotal: out.subtotal, fired_kots: out.firedKots });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    console.error('[/api/dine-in/customer-orders/[id] POST]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
