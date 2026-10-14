import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getDeptTransfer, resolveDeptTransferDisputes } from '@/lib/dept-ledger';
import { loadDepartments, canSeeTransfer, canDismissDispute, presentTransfer, transferErrorResponse } from '../../access';

/**
 * POST /api/department-transfers/<id>/resolve — close open disputes WITHOUT
 * moving anything ("found it in the walk-in", "counted wrong"). A note is
 * required and kept on each dispute. If the goods really are missing, the
 * answer is …/reverse, not this.
 *
 * Body: { note, dispute_ids? }  — omit dispute_ids to close every open dispute
 * on the document that the caller may close.
 *
 * Who (../access.ts canDismissDispute): the person who raised the dispute
 * (withdrawing their own claim), managers and admin. The sender's head alone
 * may not close a claim against their own department — they reverse it, or a
 * manager closes it.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;
  let body: any;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return Response.json({ error: 'Body must be a JSON object' }, { status: 400 });

  const db = getDb();
  try {
    const doc = getDeptTransfer(db, String(id || ''));
    if (!doc) return Response.json({ error: 'Transfer not found' }, { status: 404 });
    const depts = loadDepartments(db);
    if (!canSeeTransfer(me, doc, depts)) return Response.json({ error: 'Not allowed for this transfer' }, { status: 403 });

    const note = String(body.note ?? body.notes ?? '').trim();
    if (!note) return Response.json({ error: 'Say why the dispute is being closed without moving anything back.' }, { status: 400 });

    const open = doc.disputes.filter((d) => d.status === 'open');
    let target = open;
    if (body.dispute_ids !== undefined) {
      if (!Array.isArray(body.dispute_ids)) return Response.json({ error: 'dispute_ids must be an array' }, { status: 400 });
      const want = new Set(body.dispute_ids.map((x: unknown) => String(x)));
      target = open.filter((d) => want.has(d.id));
      if (target.length !== want.size) {
        return Response.json({ error: `One or more of those disputes is not open on ${doc.transfer_no}` }, { status: 409 });
      }
      if (target.some((d) => !canDismissDispute(me, d))) {
        return Response.json({ error: 'Only the person who raised a dispute, a manager or an admin can close it.' }, { status: 403 });
      }
    } else {
      target = open.filter((d) => canDismissDispute(me, d));
      if (open.length > 0 && target.length === 0) {
        return Response.json({ error: 'Only the person who raised a dispute, a manager or an admin can close it.' }, { status: 403 });
      }
    }

    const updated = resolveDeptTransferDisputes(db, {
      transferId: doc.id, user: me.email, note, disputeIds: target.map((d) => d.id),
    });
    return Response.json({ transfer: presentTransfer(me, updated, depts) });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/resolve POST]', e);
    return Response.json({ error: e?.message || 'Could not close the dispute' }, { status: 500 });
  }
}
