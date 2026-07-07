import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import { enrichBatch, shelfLifeRemaining, ProductionBatch } from '@/lib/production-batch';

/**
 * POST /api/kitchen-production/scan
 *   body: { barcode, ts? }   (ts = client scan epoch-ms, for offline replay)
 *
 * The endpoint the offline scan queue flushes to. Resolves the batch by barcode
 * (case-insensitive, trimmed); when found it writes a 'scanned' audit row
 * (quantity 0, balance = remaining) and returns the enriched batch. When not
 * found it returns { batch: null } (200) so the queue treats the flush as done
 * rather than retrying forever on an unknown barcode.
 *
 *   → { batch } (enriched, same shape as /by-barcode) or { batch: null }
 *
 * CSRF: covered by the '/api/kitchen-production' prefix in proxy.ts.
 */
export async function POST(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const barcode = String(body?.barcode || '').trim();
    if (!barcode) return Response.json({ error: 'barcode is required' }, { status: 400 });

    const tsNum = Number(body?.ts);
    const scannedAt = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum) : null;

    const db = getDb();
    const outletId = await getCurrentOutletId();
    const department = me.department_id || '';
    const userLabel = me.name || me.email || '';

    const where: string[] = ['LOWER(TRIM(barcode)) = LOWER(?)'];
    const params: any[] = [barcode];
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }

    const row = db.prepare(
      `SELECT * FROM production_batches WHERE ${where.join(' AND ')} LIMIT 1`
    ).get(...params) as ProductionBatch | undefined;

    if (!row) return Response.json({ batch: null });

    const now = new Date();
    const enriched = enrichBatch(row, now);
    const remaining = enriched.remaining_quantity;

    const remarks = scannedAt
      ? `camera scan @ ${scannedAt.toISOString()}`
      : 'camera scan';

    db.prepare(
      `INSERT INTO batch_transactions (
         id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
       ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(generateId(), row.id, outletId, 'scanned', 0, remaining, userLabel, department, remarks);

    // fifo_priority: rank among ACTIVE batches of the same item, oldest-first.
    let fifo_priority: number | null = null;
    if (row.status === 'active') {
      const active = db.prepare(
        `SELECT id FROM production_batches
          WHERE status = 'active' AND item_name = ?
            ${outletId ? 'AND (outlet_id = ? OR outlet_id IS NULL)' : ''}
          ORDER BY production_date ASC, production_time ASC, created_at ASC`
      ).all(...(outletId ? [row.item_name, outletId] : [row.item_name])) as { id: string }[];
      const idx = active.findIndex((a) => a.id === row.id);
      if (idx >= 0) fifo_priority = idx + 1;
    }

    const batch = {
      ...enriched,
      fifo_priority,
      shelf_life_remaining: shelfLifeRemaining(row.expiry_date, row.expiry_time, now),
    };

    return Response.json({ batch });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/scan failed:', e);
    return Response.json({ error: e?.message || 'Failed to record scan' }, { status: 500 });
  }
}
