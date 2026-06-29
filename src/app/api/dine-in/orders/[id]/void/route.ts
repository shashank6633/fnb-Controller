import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/** Void an open order (manager/admin). No sales are written; the table frees up. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Manager role required to void' }, { status: 403 });
    }
    const { id } = await params;
    const db = getDb();
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(id) as any;
    if (!order) return Response.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'open') return Response.json({ error: 'Only an open order can be voided' }, { status: 409 });

    const b = await req.json().catch(() => ({}));
    db.prepare(`
      UPDATE orders SET status = 'void', voided_at = datetime('now'),
             notes = TRIM(COALESCE(notes,'') || ' [void: ' || ? || ']'), updated_at = datetime('now')
      WHERE id = ?
    `).run(String(b.reason || '').slice(0, 200), id);
    return Response.json({ success: true });
  } catch (e: any) {
    console.error('[/api/dine-in/orders/[id]/void]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
