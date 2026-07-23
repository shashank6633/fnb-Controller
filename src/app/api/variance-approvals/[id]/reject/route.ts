import { getDb } from '@/lib/db';
import { requireRole, getCurrentUser } from '@/lib/auth';
import { rejectVariance } from '@/lib/variance-approval';

/**
 * Reject a pending variance (admin only). Body: { reason }. Stock is left
 * UNCHANGED — the variance stands as an open loss to investigate (theft /
 * spillage / miscount). The reason is recorded for the audit trail.
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
    return Response.json({ error: 'A reason is required to reject (why is the variance being left as a loss?)' }, { status: 400 });
  }

  const me = await getCurrentUser();
  const res = rejectVariance(getDb(), id, me?.email || 'admin', reason);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true, applied: false });
}
