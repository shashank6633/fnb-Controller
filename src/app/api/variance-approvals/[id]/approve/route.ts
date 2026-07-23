import { getDb } from '@/lib/db';
import { requireRole, getCurrentUser } from '@/lib/auth';
import { approveVariance } from '@/lib/variance-approval';

/**
 * Approve a pending variance (admin only). Body: { reason } — the explanation the
 * admin recorded after asking the staff who counted. Applies the stock change
 * (stock → physical count) and logs it.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireRole('admin');
  if (!gate.ok) return Response.json({ error: gate.message }, { status: gate.status });

  const { id } = await params;
  let body: { reason?: string } = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const reason = String(body?.reason || '').trim();
  if (reason.length < 2) {
    return Response.json({ error: 'A reason is required to approve (what did the staff say caused the variance?)' }, { status: 400 });
  }

  const me = await getCurrentUser();
  const res = approveVariance(getDb(), id, me?.email || 'admin', reason);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true, applied: res.applied });
}
