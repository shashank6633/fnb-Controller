import { getDb } from '@/lib/db';
import { getCurrentUser, getCurrentOutletId } from '@/lib/auth';
import {
  getDeptTransfer, reverseDeptTransfer, deptTransferSettledNote, isDeptTransferBlocked, type TransferEntryUnit, type DeptReverseBasis,
} from '@/lib/dept-ledger';
import {
  loadDepartments, reverseAuthority, canSeeTransfer, canSendFrom, transferErrorResponse, resolveEntryUnit, bodyNumber,
} from '../../access';
import { presentChecked, whoClosesCounted } from '../../send-back-check';

/**
 * POST /api/department-transfers/<id>/reverse — THE correction. One tap from
 * the disputed row: the same goods go back receiver → sender as an ordinary
 * ONE-STEP transfer (both ledgers move in one transaction, through the same
 * writer and checks — the original receiver must hold what goes back). Open
 * disputes on the reversed lines are settled by it.
 *
 * Body:
 *   client_key: REQUIRED — minted once per tap, re-sent on a retry; a retry
 *               returns the reverse it already made (200, duplicate: true).
 *   lines?:     [{ line_id, quantity, unit? }] — OMIT for the prefill, which
 *               is exactly `permissions.reverse_prefill` on the document: the
 *               open disputed quantities, or — sent back by the receiver's
 *               side with no dispute — everything still standing.
 *   expect?:    [{ line_id, quantity, basis }] — the prefill the SCREEN
 *               showed (`permissions.reverse_prefill`, its recipe-unit
 *               `quantity` and its `basis` — 'disputed' settles the open
 *               claim, 'standing' returns goods — echoed back unconverted).
 *               With lines omitted, a prefill that differs from it now, in
 *               quantity or in meaning, is refused 409 reason 'stale' and
 *               nothing moves: a tap on a screen loaded before someone else
 *               settled or closed the claim must not move the whole standing
 *               line (dept-ledger "A STALE TAP MOVES NOTHING"). Omitted = no
 *               screen: the prefill settles an OPEN dispute only.
 *   notes?:     free text, kept on the reverse document.
 *
 * Who (../access.ts reverseAuthority):
 *   · whoever may send from the ORIGINAL RECEIVER — up to what each line
 *     still has standing;
 *   · whoever may send from the ORIGINAL SENDER — only on an OPEN dispute,
 *     only up to the disputed quantity (the receiver's flag is the consent).
 *
 * → 201 { transfer (the reverse), original, duplicate: false }
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

  const outletId = await getCurrentOutletId();
  const db = getDb();
  let seen: { to_department_name: string; from_department_name: string } | null = null;
  try {
    const doc = getDeptTransfer(db, String(id || ''));
    if (!doc) return Response.json({ error: 'Transfer not found' }, { status: 404 });
    seen = doc;
    const depts = loadDepartments(db);
    if (!canSeeTransfer(me, doc, depts)) return Response.json({ error: 'Not allowed for this transfer' }, { status: 403 });

    const clientKey = typeof body.client_key === 'string' ? body.client_key.trim() : '';
    if (!clientKey) {
      return Response.json({ error: 'client_key is required: mint one per tap and re-send it on a retry.' }, { status: 400 });
    }

    const authority = reverseAuthority(me, doc, depts);
    if (!authority) {
      // A RETRY of a reverse this user already made: their own reverse settled
      // the dispute that gave them authority, so authority is gone — but the
      // reverse exists. Return it, never a 403 that reads as "it failed".
      const prior = db.prepare(`
        SELECT id FROM department_transfers WHERE created_by = ? AND client_key = ? AND reverses_transfer_id = ?
      `).get(me.email, clientKey, doc.id) as { id: string } | undefined;
      const priorDoc = prior ? getDeptTransfer(db, prior.id) : null;
      if (priorDoc) {
        return Response.json({
          transfer: presentChecked(me, priorDoc, depts, db),
          original: presentChecked(me, doc, depts, db),
          duplicate: true,
        }, { status: 200 });
      }
      // A take-back tapped on a screen loaded while the claim was open: the
      // authority came from that claim, and someone else has settled it since.
      // Say so — "only the head may" reads as a permissions fault, not as
      // "already done".
      const settled = doc.dispute_status === 'resolved' && canSendFrom(me, depts.get(doc.from_department_id))
        ? deptTransferSettledNote(db, doc) : '';
      if (settled) {
        return Response.json({
          error: `${doc.transfer_no} has no open dispute to settle any more. Nothing moved. Latest on its claims: ${settled}.`,
          code: 'DEPT_TRANSFER_BLOCKED',
          reason: 'stale',
        }, { status: 409 });
      }
      return Response.json({
        error: `Only ${doc.to_department_name}'s head, a manager or an admin can send these goods back — or, while ` +
          `${doc.to_department_name} has an open dispute on it, ${doc.from_department_name}'s head.`,
      }, { status: 403 });
    }

    let lines: Array<{ lineId: string; quantity: number; unit?: TransferEntryUnit }> | undefined;
    if (body.lines !== undefined) {
      if (!Array.isArray(body.lines)) return Response.json({ error: 'lines must be an array' }, { status: 400 });
      lines = [];
      for (const a of body.lines) {
        const lineId = String(a?.line_id || '').trim();
        const line = doc.lines.find((l) => l.id === lineId);
        if (!line) return Response.json({ error: `Line ${lineId || '(blank)'} is not on ${doc.transfer_no}` }, { status: 400 });
        const q = bodyNumber(a?.quantity);
        if (!Number.isFinite(q) || q <= 0) {
          return Response.json({ error: `quantity must be a number above 0 (${line.material_name})` }, { status: 400 });
        }
        const unit = resolveEntryUnit(a?.unit, line);
        if (!unit) {
          return Response.json({ error: `unit '${String(a.unit)}' is not ${line.material_name}'s purchase unit (${line.purchase_unit || line.unit}) or recipe unit (${line.unit})` }, { status: 400 });
        }
        lines.push({ lineId, quantity: q, unit });
      }
      if (lines.length === 0) lines = undefined;
    }

    // What the screen showed — RECIPE units, the prefill's own figures. Read
    // only for a prefill tap (lines omitted); dept-ledger compares it inside
    // the reverse's own transaction, so two taps racing cannot both pass.
    const rawExpect = body.expect ?? body.expect_prefill;
    let expect: Array<{ lineId: string; quantity: number; basis?: DeptReverseBasis }> | undefined;
    if (rawExpect !== undefined && rawExpect !== null && !lines) {
      if (!Array.isArray(rawExpect)) return Response.json({ error: 'expect must be an array of { line_id, quantity, basis }' }, { status: 400 });
      expect = [];
      for (const e of rawExpect) {
        const lineId = String(e?.line_id || '').trim();
        if (!doc.lines.some((l) => l.id === lineId)) {
          return Response.json({ error: `expect: line ${lineId || '(blank)'} is not on ${doc.transfer_no}` }, { status: 400 });
        }
        const q = bodyNumber(e?.quantity);
        if (!Number.isFinite(q) || q < 0) {
          return Response.json({ error: 'expect: quantity must be a number, 0 or more (the prefill\'s recipe-unit quantity)' }, { status: 400 });
        }
        // What the screen MEANT (permissions.reverse_prefill[].basis): settle
        // the open claim ('disputed') or return goods ('standing'). Optional —
        // when given, a different meaning now is refused like a different
        // quantity (dept-ledger "THE QUANTITY ALONE IS NOT ENOUGH").
        const b = e?.basis;
        if (b !== undefined && b !== null && b !== 'disputed' && b !== 'standing') {
          return Response.json({ error: "expect: basis must be 'disputed' or 'standing' (the prefill's own basis)" }, { status: 400 });
        }
        expect.push({ lineId, quantity: q, ...(b === 'disputed' || b === 'standing' ? { basis: b } : {}) });
      }
    }

    const res = reverseDeptTransfer(db, {
      transferId: doc.id,
      user: me.email,
      clientKey,
      lines,
      expect,
      authority,
      notes: String(body.notes ?? body.note ?? '').trim(),
      outletId,
    });
    return Response.json({
      transfer: presentChecked(me, res.transfer, depts, db),
      original: presentChecked(me, res.original, depts, db),
      duplicate: res.duplicate,
    }, { status: res.duplicate ? 200 : 201 });
  } catch (e: any) {
    // The counted-since refusal reads word-for-word what the screen showed
    // (permissions.reverse_blocked, ../../send-back-check.ts whoClosesCounted).
    if (seen && isDeptTransferBlocked(e) && e.reason === 'counted_since') e.message = whoClosesCounted(e.message, seen);
    const handled = transferErrorResponse(db, e);
    if (handled) return handled;
    console.error('[department-transfers/[id]/reverse POST]', e);
    return Response.json({ error: e?.message || 'Reverse failed' }, { status: 500 });
  }
}
