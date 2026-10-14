import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getWithdrawalById, recordRecovery } from '@/lib/liquor-withdrawals';

/**
 * PATCH /api/liquor/withdrawals/[id] — record a recovery against a withdrawal.
 * ADMIN-ONLY (same boundary as the register). Money only: this updates
 * recovered / recoverable / remarks and never touches the stock movement or the
 * generated `outstanding` column.
 *
 * body: { recovered?, recoverable_custom?, remarks? }
 */
export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const { id } = await params;
    const db = getDb();

    if (!getWithdrawalById(db, id)) return Response.json({ error: 'Withdrawal not found' }, { status: 404 });

    const b = await request.json();
    const row = recordRecovery(db, id, {
      recovered: b.recovered === undefined || b.recovered === null || b.recovered === '' ? undefined : Number(b.recovered),
      recoverable_custom: b.recoverable_custom === undefined || b.recoverable_custom === null || b.recoverable_custom === ''
        ? undefined : Number(b.recoverable_custom),
      remarks: b.remarks === undefined ? undefined : String(b.remarks),
      actor_email: user.email,
    });
    return Response.json({ ok: true, withdrawal: row });
  } catch (e: any) {
    console.error('[/api/liquor/withdrawals/[id] PATCH]', e);
    const msg = String(e?.message || 'Failed to update');
    if (/database is locked|SQLITE_BUSY/i.test(msg)) {
      return Response.json({ error: 'The register is busy with another save — try again in a moment.' }, { status: 409 });
    }
    // 'recovers at "landed" … cannot be typed' is a caller mistake, not a fault:
    // it used to return 200 with the figure silently dropped.
    const client = /must be|cannot exceed|not found|recovers at/i.test(msg);
    return Response.json({ error: msg }, { status: client ? 400 : 500 });
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    const { id } = await params;
    const db = getDb();
    const row = getWithdrawalById(db, id);
    if (!row) return Response.json({ error: 'Withdrawal not found' }, { status: 404 });
    return Response.json({ withdrawal: row });
  } catch (e: any) {
    console.error('[/api/liquor/withdrawals/[id] GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
