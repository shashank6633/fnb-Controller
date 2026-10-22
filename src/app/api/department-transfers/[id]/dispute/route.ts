import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import {
  getDeptTransfer, flagDeptTransferDispute, DEPT_TRANSFER_DISPUTE_KINDS, type DeptTransferDisputeKind, type TransferEntryUnit,
} from '@/lib/dept-ledger';
import {
  loadDepartments, canFlagDispute, canSendFrom, canSeeTransfer, presentTransfer, transferErrorResponse, resolveEntryUnit, bodyNumber,
  reverseAuthority,
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
 * Who: anyone POSTED to the RECEIVING department (any tier — the owner's
 * ruling lets staff flag), or whoever may send from it (its head, an HOD posted
 * there, managers, admin) — but not anyone except a manager / admin who may
 * also send from the SENDING department, wherever they are posted: the first
 * flag owns the line's one dispute slot, so a sender's token claim would
 * block the receiver's real one. ../access.ts canFlagDispute.
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
      // A sender head is refused WHEREVER posted (access.ts canFlagDispute): say
      // what they can do instead — a send-back when they also act for the
      // receiver, else the receiver's own people flag it.
      const headsSender = canSendFrom(me, depts.get(doc.from_department_id));
      return Response.json({
        error: `Only someone in ${doc.to_department_name} (or its head, a manager or an admin) can dispute what it received` +
          (headsSender
            ? ` — not someone who also heads ${doc.from_department_name}, which sent it.` +
              (reverseAuthority(me, doc, depts) === 'receiver'
                ? ` To correct it, send back to ${doc.from_department_name} what did not arrive (Send back): a reverse transfer fixes both books.`
                : ` Ask someone else in ${doc.to_department_name}, or a manager, to flag it.`)
            : '.'),
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
