import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getDeptTransfer, cancelDeptTransfer } from '@/lib/dept-ledger';
import {
  loadDepartments, canSendFrom, canReceiveInto, isSender,
  presentTransfer, transferErrorResponse,
} from '../../access';

/**
 * POST /api/department-transfers/<id>/cancel  { reason } — drop a PENDING
 * transfer. Moves no stock, because a pending transfer never moved any: the
 * goods are still on the sender's ledger. A received transfer cannot be
 * cancelled — send the stock back with a new transfer, so both hand-overs stay
 * on the record.
 *
 * Who: the person who sent it, anyone who may send from the sending
 * department, or anyone who may receive into the receiving department (a
 * hand-over that never arrived is the receiver's to refuse) — ../access.ts.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
  const { id } = await params;

  let body: any = {};
  try {
    const text = await request.text();
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') body = {};

  const db = getDb();
  try {
    const doc = getDeptTransfer(db, String(id || ''));
    if (!doc) return Response.json({ error: 'Transfer not found' }, { status: 404 });
    if (doc.status !== 'pending') {
      return Response.json({ error: `${doc.transfer_no} is ${doc.status}; only a pending transfer can be cancelled.` }, { status: 409 });
    }
    const depts = loadDepartments(db);
    const allowed = isSender(me, doc)
      || canSendFrom(me, depts.get(doc.from_department_id), depts)
      || canReceiveInto(me, depts.get(doc.to_department_id), depts);
    if (!allowed) {
      return Response.json({
        error: `Only the sender, ${doc.from_department_name}'s senders or ${doc.to_department_name}'s receivers can cancel ${doc.transfer_no}.`,
      }, { status: 403 });
    }
    const reason = String(body.reason || '').trim();
    if (!reason) return Response.json({ error: 'Say why the transfer is being cancelled (reason)' }, { status: 400 });

    const cancelled = cancelDeptTransfer(db, { transferId: doc.id, user: me.email, reason });
    return Response.json({ transfer: presentTransfer(me, cancelled, depts) });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/cancel POST]', e);
    return Response.json({ error: e?.message || 'Cancel failed' }, { status: 500 });
  }
}
