import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';
import { enrichBatch, ProductionBatch } from '@/lib/production-batch';

/**
 * POST /api/kitchen-production/[id]/dispose
 *   body: { action: 'wasted' | 'disposed' | 'transferred' | 'returned',
 *           quantity?, remarks? }
 *
 *   wasted / disposed  — remove stock: add `quantity` (default = remaining) to
 *                        quantity_consumed, flip status to that action, log a tx
 *                        of that type with the qty + resulting balance.
 *   transferred / returned — movement only: log a tx of that type (qty + current
 *                        remaining as balance); status + quantity_consumed
 *                        untouched.
 *
 *   → { batch: {…enriched}, transaction: { type, quantity, balance } }
 *
 * CSRF: covered by the '/api/kitchen-production' prefix in proxy.ts.
 */
const ACTIONS = new Set(['wasted', 'disposed', 'transferred', 'returned']);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || '').trim();
    if (!ACTIONS.has(action)) {
      return Response.json({ error: `action must be one of ${[...ACTIONS].join(', ')}` }, { status: 400 });
    }
    const remarks = String(body?.remarks || '');

    const db = getDb();
    const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
    if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });

    const remaining = Math.max(0, (batch.quantity_produced || 0) - (batch.quantity_consumed || 0));
    const userLabel = me.name || me.email || '';
    const department = me.department_id || '';

    // Requested qty: default to full remaining; never exceed what's on hand.
    let qty = body?.quantity != null ? Number(body.quantity) : remaining;
    if (!Number.isFinite(qty) || qty <= 0) qty = remaining;
    qty = Math.min(qty, remaining);

    const removesStock = action === 'wasted' || action === 'disposed';

    const result = db.transaction(() => {
      let balance = remaining;
      if (removesStock) {
        const newConsumed = (batch.quantity_consumed || 0) + qty;
        balance = Math.max(0, (batch.quantity_produced || 0) - newConsumed);
        db.prepare(
          `UPDATE production_batches
              SET quantity_consumed = ?, status = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(newConsumed, action, id);
      }

      db.prepare(
        `INSERT INTO batch_transactions
           (id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(generateId(), id, batch.outlet_id, action, qty, balance, userLabel, department, remarks);

      return { type: action, quantity: qty, balance };
    })();

    const row = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch;
    const enriched = enrichBatch(row, new Date());

    return Response.json({ batch: enriched, transaction: result });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/[id]/dispose failed:', e);
    return Response.json({ error: e?.message || 'Failed to record disposal' }, { status: 500 });
  }
}
