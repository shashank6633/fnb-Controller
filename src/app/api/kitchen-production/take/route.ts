import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { enrichBatch, shelfLifeRemaining, computeFifo, ProductionBatch } from '@/lib/production-batch';

/**
 * POST /api/kitchen-production/take
 *   body: { barcode, quantity }
 *
 * "Take stock" from the SCANNED batch — the scan screen's partial draw-down
 * (e.g. take 3 kg of a 5 kg batch). Deducts from exactly that batch (the FIFO
 * banner already steered the cook to the right container), logs a 'consumed'
 * transaction (same shape as the item-level FIFO consume), and flips the batch
 * to status='consumed' the moment remaining hits 0 — "5 out of 5 used" is
 * completed automatically, and the next-oldest batch becomes FIFO #1 everywhere.
 *
 * Open to ANY signed-in user (like /scan, unlike the HOD-gated module APIs):
 * taking stock is the line cook's action at the container, not an admin task.
 *
 *   → { batch (enriched + fifo), taken, remaining, completed }
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const barcode = String(body?.barcode || '').trim();
    const quantity = Number(body?.quantity);
    if (!barcode) return Response.json({ error: 'barcode is required' }, { status: 400 });
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return Response.json({ error: 'quantity must be greater than 0' }, { status: 400 });
    }

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const where: string[] = ['LOWER(TRIM(barcode)) = LOWER(?)'];
    const params: any[] = [barcode];
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }
    const row = db.prepare(
      `SELECT * FROM production_batches WHERE ${where.join(' AND ')} LIMIT 1`
    ).get(...params) as ProductionBatch | undefined;
    if (!row) return Response.json({ error: 'Batch not found' }, { status: 404 });
    if (row.status !== 'active') {
      return Response.json({ error: `Batch is ${row.status} — nothing can be taken from it` }, { status: 400 });
    }

    const now = new Date();
    const available = Math.max(0, (row.quantity_produced || 0) - (row.quantity_consumed || 0));
    if (quantity > available + 1e-9) {
      return Response.json(
        { error: `Only ${available} ${row.unit || ''} left in this batch — cannot take ${quantity}`.trim() },
        { status: 400 },
      );
    }

    const userLabel = me.name || me.email || '';
    const department = me.department_id || '';
    const newConsumed = (row.quantity_consumed || 0) + quantity;
    const balance = Math.max(0, (row.quantity_produced || 0) - newConsumed);
    const newStatus = balance <= 1e-9 ? 'consumed' : 'active';

    db.transaction(() => {
      db.prepare(
        `UPDATE production_batches
            SET quantity_consumed = ?, status = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(newConsumed, newStatus, row.id);
      db.prepare(
        `INSERT INTO batch_transactions (
           id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
         ) VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(generateId(), row.id, outletId, 'consumed', quantity, balance, userLabel, department, 'taken via scan');
    })();

    const updated = { ...row, quantity_consumed: newConsumed, status: newStatus } as ProductionBatch;
    const enriched = enrichBatch(updated, now);
    const { fifo_priority, fifo_use_first } = computeFifo(db, updated, outletId, now);

    return Response.json({
      batch: {
        ...enriched,
        fifo_priority,
        fifo_use_first,
        shelf_life_remaining: shelfLifeRemaining(updated.expiry_date, updated.expiry_time, now),
      },
      taken: quantity,
      remaining: balance,
      completed: newStatus === 'consumed',
    });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/take failed:', e);
    return Response.json({ error: e?.message || 'Failed to take stock' }, { status: 500 });
  }
}
