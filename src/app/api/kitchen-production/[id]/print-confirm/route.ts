import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';
import { ProductionBatch } from '@/lib/production-batch';

/**
 * POST /api/kitchen-production/[id]/print-confirm
 *   body: { reprint?: boolean, copies?: number, qr?: boolean }
 *
 * Logs a 'printed' / 'reprinted' batch_transaction. The client calls this ONLY
 * after the print bridge has ACCEPTED the label (bridgePrint returned ok), so the
 * batch history reflects an actual hand-off to the printer — not merely that a
 * label was generated. If the bridge is missing/old or the printer rejects the
 * job, the client throws before reaching here and nothing is logged.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef or admin only' }, { status: 403 });

    const { id } = await params;
    const db = getDb();
    const batch = db.prepare('SELECT * FROM production_batches WHERE id = ?').get(id) as ProductionBatch | undefined;
    if (!batch) return Response.json({ error: 'Batch not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const reprint = !!body?.reprint;
    const copies = Math.max(1, Math.round(Number(body?.copies) || 1));
    const qr = !!body?.qr;

    const remaining = Math.max(0, (batch.quantity_produced || 0) - (batch.quantity_consumed || 0));
    db.prepare(
      `INSERT INTO batch_transactions (
         id, batch_id, outlet_id, type, quantity, balance_quantity, user, department, remarks
       ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      generateId(),
      batch.id,
      batch.outlet_id,
      reprint ? 'reprinted' : 'printed',
      0,
      remaining,
      me.name || me.email || '',
      me.department_id || '',
      `${copies} label${copies === 1 ? '' : 's'}${qr ? ' +QR' : ''}`,
    );

    return Response.json({ ok: true });
  } catch (e: any) {
    console.error('POST /api/kitchen-production/[id]/print-confirm failed:', e);
    return Response.json({ error: e?.message || 'Failed to log print' }, { status: 500 });
  }
}
