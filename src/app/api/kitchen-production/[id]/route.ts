import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { enrichBatch, ProductionBatch } from '@/lib/production-batch';

/**
 * GET /api/kitchen-production/[id]
 *   → { batch: {…, remaining_quantity, expiry_status, batch_age_hours},
 *       transactions: [ …ordered newest first ] }
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();

    const row = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
    if (!row) return Response.json({ error: 'Batch not found' }, { status: 404 });

    const now = new Date();
    const batch = enrichBatch(row, now);

    const transactions = db.prepare(
      `SELECT * FROM batch_transactions WHERE batch_id = ? ORDER BY created_at DESC, rowid DESC`
    ).all(id);

    return Response.json({ batch, transactions });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load batch' }, { status: 500 });
  }
}
