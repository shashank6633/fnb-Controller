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
 * on the document that the caller may close. An EMPTY dispute_ids is refused:
 * it names nothing, so it must never mean "all" — 403 for a caller who may
 * close none of the open disputes (the same answer as any other spelling),
 * 400 for one who may close at least one.
 *
 * Who (../access.ts canDismissDispute): the person who raised the dispute
 * (withdrawing their own claim), managers and admin. The sender's head alone
 * may not close a claim against their own department — they reverse it, or a
 * manager closes it. Once both departments have counted the disputed line
 * since it moved, the take-back is refused (it would correct the books twice)
 * and the RECEIVING department's head may close it too — never the sender's
 * head, who could make "both counted" true alone by counting the receiver,
 * and never a person who heads BOTH ends (the Kitchen HOD also sends from its
 * sub-kitchen Akan Tandoori, ruling #40): such a person is the sender's head.
 */

const CLOSE_WHO = 'Only the person who raised a dispute, a manager or an admin can close it — or, once both ' +
  'departments have counted it since the transfer, the receiving department\'s head (not someone who also ' +
  'heads the sending department).';

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
      // An EMPTY list names nothing, so it closes nothing. It used to pass every
      // check below vacuously (0 === 0, and .some() of nothing is false) and then
      // reach the ledger as "no filter" = EVERY open dispute — so anyone who could
      // see the transfer (the sender's own HOD and staff, an unrelated HOD, a
      // visible_department_ids grantee) could silence the receiver's claim with a
      // hand-made `dispute_ids: []`. Measured: 6 such callers got 200. The screen
      // never sends [] (it sends dismissable_dispute_ids, and only when non-empty).
      //
      // Who-may comes BEFORE what-was-named, so the answer never depends on the
      // spelling: a caller who may close none of the open disputes here gets the
      // same 403 they get for naming an id or for leaving the field out. Only a
      // caller who may close one is told the empty list names nothing (400).
      if (body.dispute_ids.length === 0) {
        if (open.length > 0 && !open.some((d) => canDismissDispute(me, d, doc, depts))) {
          return Response.json({ error: CLOSE_WHO }, { status: 403 });
        }
        return Response.json({ error: 'dispute_ids is empty — name the disputes to close, or leave the field out to close every open dispute you may close.' }, { status: 400 });
      }
      const want = new Set(body.dispute_ids.map((x: unknown) => String(x)));
      target = open.filter((d) => want.has(d.id));
      if (target.length !== want.size) {
        return Response.json({ error: `One or more of those disputes is not open on ${doc.transfer_no}` }, { status: 409 });
      }
      if (target.some((d) => !canDismissDispute(me, d, doc, depts))) {
        return Response.json({ error: CLOSE_WHO }, { status: 403 });
      }
    } else {
      target = open.filter((d) => canDismissDispute(me, d, doc, depts));
      if (open.length > 0 && target.length === 0) {
        return Response.json({ error: CLOSE_WHO }, { status: 403 });
      }
    }
    // Nothing open: say so here rather than hand the ledger an empty list (which
    // it now refuses as naming nothing). Same 409 and words the ledger gave before.
    if (target.length === 0) {
      return Response.json({ error: `${doc.transfer_no} has no open dispute to close.` }, { status: 409 });
    }

    const updated = resolveDeptTransferDisputes(db, {
      transferId: doc.id, user: me.email, note, disputeIds: target.map((d) => d.id),
    });
    return Response.json({ transfer: presentTransfer(me, updated, depts, db) });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/resolve POST]', e);
    return Response.json({ error: e?.message || 'Could not close the dispute' }, { status: 500 });
  }
}
