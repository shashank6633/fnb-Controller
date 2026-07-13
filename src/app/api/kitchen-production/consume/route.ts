import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canManageKitchenProduction } from '@/lib/auth';
import { ProductionBatch, itemGroupClause } from '@/lib/production-batch';

/**
 * POST /api/kitchen-production/consume
 *   body: { item_name (or material_id), quantity, unit?, remarks? }
 *
 * FIFO draw-down: deduct from ACTIVE batches of the item OLDEST-FIRST until the
 * requested quantity is met. Each touched batch bumps quantity_consumed, gets a
 * 'consumed' audit row (deducted qty + resulting balance), and flips to
 * status='consumed' once fully drawn. Never over-draws a batch; reports shortfall.
 *
 *   → { consumed: [{batch_id, batch_number, qty}], requested, fulfilled, shortfall }
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canManageKitchenProduction(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const item_name = String(body?.item_name || '').trim();
    const material_id = body?.material_id ? String(body.material_id) : '';
    const requested = Number(body?.quantity) || 0;
    const remarks = String(body?.remarks || '');

    if (!item_name && !material_id) {
      return Response.json({ error: 'item_name or material_id is required' }, { status: 400 });
    }
    if (requested <= 0) {
      return Response.json({ error: 'quantity must be greater than 0' }, { status: 400 });
    }

    const outletId = await getCurrentOutletId();
    const db = getDb();
    const department = me.department_id || '';
    const userLabel = me.name || me.email || '';

    // ACTIVE batches of this item, oldest production first. Group by the SAME rule
    // every FIFO surface uses (itemGroupClause) so consume draws in the exact order
    // the scan/list screens advertise — resolve the name to a master id (NOCASE)
    // first, else fall back to legacy exact-name matching.
    const where: string[] = ["status = 'active'"];
    const params: any[] = [];
    if (material_id) {
      where.push('material_id = ?'); params.push(material_id);
    } else {
      const pItem = db.prepare(`SELECT id FROM production_items WHERE name = ? COLLATE NOCASE`).get(item_name) as { id: string } | undefined;
      const g = itemGroupClause({ production_item_id: pItem?.id ?? null, item_name });
      where.push(g.cond); params.push(...g.params);
    }
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }

    const result = db.transaction(() => {
      const batches = db.prepare(
        `SELECT * FROM production_batches WHERE ${where.join(' AND ')}
         ORDER BY production_date ASC, production_time ASC, created_at ASC`
      ).all(...params) as ProductionBatch[];

      const consumed: { batch_id: string; batch_number: string; qty: number }[] = [];
      let remaining = requested;

      for (const b of batches) {
        if (remaining <= 0) break;
        const available = Math.max(0, (b.quantity_produced || 0) - (b.quantity_consumed || 0));
        if (available <= 0) continue;

        const take = Math.min(available, remaining);
        const newConsumed = (b.quantity_consumed || 0) + take;
        const balance = Math.max(0, (b.quantity_produced || 0) - newConsumed);
        const newStatus = balance <= 0 ? 'consumed' : 'active';

        db.prepare(
          `UPDATE production_batches
              SET quantity_consumed = ?, status = ?, updated_at = datetime('now')
            WHERE id = ?`
        ).run(newConsumed, newStatus, b.id);

        db.prepare(
          `INSERT INTO batch_transactions (
             id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
           ) VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(generateId(), b.id, outletId, 'consumed', take, balance, userLabel, department, remarks);

        consumed.push({ batch_id: b.id, batch_number: b.batch_number, qty: take });
        remaining -= take;
      }

      const fulfilled = requested - remaining;
      const shortfall = Math.max(0, remaining);
      return { consumed, requested, fulfilled, shortfall };
    })();

    return Response.json(result);
  } catch (e: any) {
    console.error('POST /api/kitchen-production/consume failed:', e);
    return Response.json({ error: e?.message || 'Failed to consume' }, { status: 500 });
  }
}
