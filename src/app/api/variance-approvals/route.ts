import { getDb } from '@/lib/db';
import { requireRole, getCurrentOutletId } from '@/lib/auth';
import { listVarianceApprovals, pendingVarianceCount } from '@/lib/variance-approval';

/**
 * Variance approvals queue (admin only). Closing counts with a non-zero variance
 * land here as PENDING; an admin approves (stock → physical) or rejects.
 *
 * GET ?status=pending|approved|rejected|all  → { approvals, pending_count }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const db = getDb();
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const outletId = await getCurrentOutletId();

  return Response.json({
    approvals: listVarianceApprovals(db, { status, outletId, limit: 500 }),
    pending_count: pendingVarianceCount(db, outletId),
  });
}
