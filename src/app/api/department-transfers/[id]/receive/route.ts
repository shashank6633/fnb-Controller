import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getDeptTransfer, receiveDeptTransfer, type TransferEntryUnit } from '@/lib/dept-ledger';
import {
  loadDepartments, canReceiveInto, isAdminOrHod, isSender,
  presentTransfer, transferErrorResponse, resolveEntryUnit,
} from '../../access';

/**
 * POST /api/department-transfers/<id>/receive — the RECEIVER confirms. This is
 * the step that moves stock: dept-ledger's receiveDeptTransfer() claims the
 * document (pending → received, so a double tap cannot post twice) and posts
 * every accepted line as a transfer_out on the sender + transfer_in on the
 * receiver, ONE transaction for the whole document. Central is never touched.
 *
 * Body (all optional):
 *   lines:           [{ line_id, quantity, unit? }]  — accept a line SHORT
 *                    (down to 0). A line not listed is accepted in full. Never
 *                    more than was sent. `unit` as on send: 'purchase' (default),
 *                    'recipe', or the unit's own name.
 *   txn_date:        YYYY-MM-DD business date; default today, never future.
 *   override_reason: ONLY when the caller SENT this transfer and is an admin or
 *                    HOD — the QC escape hatch, stored on the document forever.
 *
 * Who: a member of the RECEIVING department (exact department_id), its named
 * head, any HOD, or admin — ../access.ts. The sender may not confirm their own
 * transfer (the QC "receiver may not be the checker" rule) except as admin/HOD
 * with a written reason. An override_reason from anyone else is IGNORED, never
 * stored: the column means "the sender confirmed their own transfer", and
 * nothing else may put words in it.
 *
 * A line the sender can no longer cover (cooked, wasted or sent elsewhere since
 * the send) is refused with the shortfall in the purchase unit and NOTHING is
 * posted for any line; accept that line short, or cancel and re-send.
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
    const depts = loadDepartments(db);

    if (doc.status !== 'pending') {
      return Response.json({ error: `${doc.transfer_no} is already ${doc.status}; nothing was posted.` }, { status: 409 });
    }
    if (!canReceiveInto(me, depts.get(doc.to_department_id), depts)) {
      return Response.json({
        error: `Only someone in ${doc.to_department_name} (or a head of department / admin) can confirm receipt.`,
      }, { status: 403 });
    }

    let overrideReason: string | undefined;
    if (isSender(me, doc)) {
      if (!isAdminOrHod(me)) {
        return Response.json({
          error: `You sent ${doc.transfer_no}; someone in ${doc.to_department_name} must confirm receipt.`,
        }, { status: 403 });
      }
      overrideReason = String(body.override_reason || '').trim();
      if (!overrideReason) {
        return Response.json({
          error: `You sent ${doc.transfer_no}. To confirm it yourself, give a written reason (override_reason); ` +
            `it is kept on the transfer permanently.`,
          code: 'OVERRIDE_REASON_REQUIRED',
        }, { status: 409 });
      }
    }

    let lines: Array<{ lineId: string; quantity: number; unit: TransferEntryUnit }> | undefined;
    if (body.lines != null) {
      if (!Array.isArray(body.lines)) return Response.json({ error: 'lines must be an array' }, { status: 400 });
      lines = [];
      for (const a of body.lines) {
        const lineId = String(a?.line_id || '').trim();
        const line = doc.lines.find((l) => l.id === lineId);
        if (!line) return Response.json({ error: `Line ${lineId || '(blank)'} is not on ${doc.transfer_no}` }, { status: 400 });
        const qty = Number(a?.quantity);
        if (a?.quantity === null || a?.quantity === '' || !Number.isFinite(qty) || qty < 0) {
          return Response.json({ error: `Received quantity for ${line.material_name} must be 0 or more` }, { status: 400 });
        }
        // Matched against the line's OWN snapshotted units, not today's material.
        const unit = resolveEntryUnit(a?.unit, { unit: line.unit, purchase_unit: line.purchase_unit });
        if (!unit) {
          return Response.json({
            error: `unit '${String(a.unit)}' is not ${line.material_name}'s purchase unit (${line.purchase_unit}) ` +
              `or recipe unit (${line.unit})`,
          }, { status: 400 });
        }
        lines.push({ lineId, quantity: qty, unit });
      }
    }

    const txnDate = body.txn_date == null ? undefined : String(body.txn_date).trim();
    const received = receiveDeptTransfer(db, {
      transferId: doc.id,
      user: me.email,
      lines,
      overrideReason,
      txnDate,
    });
    return Response.json({ transfer: presentTransfer(me, received, depts) });
  } catch (e: any) {
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/receive POST]', e);
    return Response.json({ error: e?.message || 'Receive failed' }, { status: 500 });
  }
}
