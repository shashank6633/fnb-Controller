import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId, canApproveAsChef } from '@/lib/auth';
import { enrichBatch, shelfLifeRemaining, computeFifo, ProductionBatch } from '@/lib/production-batch';

/**
 * GET /api/kitchen-production/by-barcode?barcode=PROD000145
 *   Camera-scan lookup. Resolves a batch by its exact barcode (case-insensitive,
 *   trimmed), enriches it, and computes:
 *     - remaining_quantity   produced − consumed (from enrichBatch)
 *     - expiry_status        green|yellow|red    (from enrichBatch)
 *     - batch_age_hours      hours since production (from enrichBatch)
 *     - fifo_priority        rank among ACTIVE same-item batches, oldest = 1
 *     - shelf_life_remaining human string, e.g. "2d 4h left" / "expired"
 *
 *   → { batch } when found, or { batch: null } (200, NOT 404) so the scanner UI
 *     can distinguish "unknown barcode" from a request error.
 */
export async function GET(request: Request) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const url = new URL(request.url);
    const barcode = (url.searchParams.get('barcode') || '').trim();
    if (!barcode) return Response.json({ error: 'barcode is required' }, { status: 400 });

    const db = getDb();
    const outletId = await getCurrentOutletId();

    // Exact match, case-insensitive + trimmed on both sides.
    const where: string[] = ['LOWER(TRIM(barcode)) = LOWER(?)'];
    const params: any[] = [barcode];
    if (outletId) { where.push('(outlet_id = ? OR outlet_id IS NULL)'); params.push(outletId); }

    const row = db.prepare(
      `SELECT * FROM production_batches WHERE ${where.join(' AND ')} LIMIT 1`
    ).get(...params) as ProductionBatch | undefined;

    if (!row) return Response.json({ batch: null });

    const now = new Date();
    const enriched = enrichBatch(row, now);

    // Same FIFO grouping as scan/take/list (by production_item_id).
    const { fifo_priority } = computeFifo(db, row, outletId, now);

    const batch = {
      ...enriched,
      fifo_priority,
      shelf_life_remaining: shelfLifeRemaining(row.expiry_date, row.expiry_time, now),
    };

    return Response.json({ batch });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/by-barcode failed:', e);
    return Response.json({ error: e?.message || 'Failed to look up barcode' }, { status: 500 });
  }
}
