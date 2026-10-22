import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  getDeptTransfer, flagDeptTransferDispute, DEPT_TRANSFER_DISPUTE_KINDS, type DeptTransferDisputeKind, type TransferEntryUnit,
} from '@/lib/dept-ledger';
import {
  loadDepartments, canFlagDispute, canSendFrom, canSeeTransfer, presentTransfer, transferErrorResponse, resolveEntryUnit, bodyNumber,
  isOnReceivingDept,
} from '../../access';
import { transferAlertRecipients, notifyTransferDispute } from '../../notify';

/**
 * POST /api/department-transfers/<id>/dispute — the RECEIVER flags a problem.
 *
 * ONE STEP means the stock already moved when the transfer was sent. This
 * RECORDS the receiver's claim and ALERTS the sender's side — it moves NO
 * stock (dept-ledger flagDeptTransferDispute writes dispute rows and nothing
 * else). The correction, if the claim stands, is a reverse transfer
 * (POST …/reverse — one tap, prefilled with the disputed quantity).
 *
 * Body:
 *   kind:   'short' | 'wrong_item' | 'not_received'          (required)
 *   reason: words the sender can act on                       (required)
 *   lines?: [{ line_id, quantity_received?, unit? }]
 *     OMIT = every line still standing ('wrong_item' / 'not_received').
 *     'short' needs, per line, quantity_received — what DID arrive, in the
 *     purchase unit unless `unit` says 'recipe' or names the recipe unit. The
 *     dispute is the difference.
 *
 * Who (ruling #61 — ../access.ts canFlagDispute): anyone ON the RECEIVING
 * department, ALWAYS — posted to it (any tier; the owner's ruling lets staff
 * flag) or its named head — even if they may also send from the SENDING
 * department (the Kitchen HOD flags a short delivery from Akan Pizza);
 * managers and admin; and an HOD who acts for it as head chef of its parent
 * department, unless he may also send from the sending department (then he is
 * on the side that sent it). Only CLOSING stays barred for anyone who may send
 * from the sender's side (../resolve, canDismissDispute).
 *
 * → 201 { transfer, disputes, alerted: [{ email, name, why }], notification_recorded }
 *   One open dispute per line at a time (409 while one is open).
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
    if (!canFlagDispute(me, doc, depts)) {
      // Refused (access.ts canFlagDispute): either no tie to the receiving
      // department at all, or an HOD who acts for it only as head chef of its
      // parent AND may send from the sending department. Anyone posted to the
      // receiver, or its named head, is never refused here (ruling #61).
      const to = depts.get(doc.to_department_id);
      const viaParent = canSendFrom(me, to) && !isOnReceivingDept(me, doc, depts);
      const parentName = to?.parent_id ? depts.get(to.parent_id)?.name || '' : '';
      return Response.json({
        error: viaParent && canSendFrom(me, depts.get(doc.from_department_id))
          ? `${doc.to_department_name}'s own people flag what it receives: someone posted to ${doc.to_department_name}, ` +
            `its named head, a manager or an admin. You act for ${doc.to_department_name} as an HOD posted to ` +
            `${parentName || 'the department it belongs to'}, and you can also send from ${doc.from_department_name}, ` +
            `which sent it — ask one of them to flag it.`
          : `Only someone in ${doc.to_department_name} (or its head, a manager or an admin) can dispute what it received.`,
      }, { status: 403 });
    }

    const kind = String(body.kind || '').trim() as DeptTransferDisputeKind;
    if (!DEPT_TRANSFER_DISPUTE_KINDS.includes(kind)) {
      return Response.json({ error: `kind must be one of ${DEPT_TRANSFER_DISPUTE_KINDS.join(', ')}` }, { status: 400 });
    }
    const reason = String(body.reason ?? '').trim();
    if (!reason) return Response.json({ error: 'Say what happened — a dispute needs a reason.' }, { status: 400 });

    let lines: Array<{ lineId: string; quantityReceived?: number; unit?: TransferEntryUnit }> | undefined;
    if (body.lines !== undefined) {
      if (!Array.isArray(body.lines)) return Response.json({ error: 'lines must be an array' }, { status: 400 });
      lines = [];
      for (const a of body.lines) {
        const lineId = String(a?.line_id || '').trim();
        const line = doc.lines.find((l) => l.id === lineId);
        if (!line) return Response.json({ error: `Line ${lineId || '(blank)'} is not on ${doc.transfer_no}` }, { status: 400 });
        const entry: { lineId: string; quantityReceived?: number; unit?: TransferEntryUnit } = { lineId };
        if (a?.quantity_received !== undefined) {
          const q = bodyNumber(a.quantity_received);
          if (!Number.isFinite(q) || q < 0) {
            return Response.json({ error: `quantity_received must be a number, 0 or more (${line.material_name})` }, { status: 400 });
          }
          const unit = resolveEntryUnit(a?.unit, line);
          if (!unit) {
            return Response.json({ error: `unit '${String(a.unit)}' is not ${line.material_name}'s purchase unit (${line.purchase_unit || line.unit}) or recipe unit (${line.unit})` }, { status: 400 });
          }
          entry.quantityReceived = q;
          entry.unit = unit;
        }
        lines.push(entry);
      }
    }

    // Who will be told — resolved BEFORE the write so the dispute rows record
    // it inside the same transaction; the messages go out after commit.
    const recipients = transferAlertRecipients(db, doc, depts);
    const res = flagDeptTransferDispute(db, {
      transferId: doc.id, user: me.email, kind, reason, lines,
      alertRecipients: recipients.map((r) => r.email),
    });
    let recorded = false;
    try {
      recorded = (await notifyTransferDispute(db, { doc: res.transfer, disputes: res.disputes, raisedBy: me.email, recipients })).recorded;
    } catch { /* never fails the flag */ }

    const present = presentTransfer(me, res.transfer, depts, db);
    const ids = new Set(res.disputes.map((d) => d.id));
    return Response.json({
      transfer: present,
      disputes: present.disputes.filter((d) => ids.has(d.id)),
      alerted: recipients,
      notification_recorded: recorded,
    }, { status: 201 });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/dispute POST]', e);
    return Response.json({ error: e?.message || 'Could not record the dispute' }, { status: 500 });
  }
}
