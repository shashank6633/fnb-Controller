import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { enrichBatch, ProductionBatch } from '@/lib/production-batch';
import { batchDepartment } from '@/lib/production-departments';

/**
 * GET /api/kitchen-production/[id]
 *   → { batch: {…, remaining_quantity, expiry_status, batch_age_hours,
 *                department_key, department_name, department_id, department_inactive},
 *       transactions: [ …ordered newest first ] }
 *
 * The department fields are empty for any batch made before the field existed —
 * the drawer renders its stored `kitchen_section` string exactly as before.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // READ — logged-in only (the batch drawer on a page open to all members);
    // see canManageKitchenProduction in src/lib/auth.ts for the read/write split.
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();

    const row = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
    if (!row) return Response.json({ error: 'Batch not found' }, { status: 404 });

    const now = new Date();
    const dep = batchDepartment(db, id);
    const batch = {
      ...enrichBatch(row, now),
      department_id: dep?.department_id ?? null,
      department_key: dep?.department_key ?? null,
      department_name: dep?.department_name ?? '',
      department_inactive: dep?.department_inactive ?? false,
    };

    const transactions = db.prepare(
      `SELECT * FROM batch_transactions WHERE batch_id = ? ORDER BY created_at DESC, rowid DESC`
    ).all(id);

    return Response.json({ batch, transactions });
  } catch (e: any) {
    console.error('GET /api/kitchen-production/[id] failed:', e);
    return Response.json({ error: e?.message || 'Failed to load batch' }, { status: 500 });
  }
}
