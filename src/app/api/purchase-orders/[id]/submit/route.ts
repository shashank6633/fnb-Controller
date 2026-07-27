import { getDb, logAuditEvent } from '@/lib/db';
import { poWriteGate, effectiveActor, requiresAdminApproval, zeroRateBlocker } from '@/lib/po-helpers';

// Management OR the store manager can submit a draft for approval.
// When the `po_require_admin_approval` switch is OFF this same request also
// approves the PO (see the txn below) so it can be received without a separate
// admin step. The switch only removes the HUMAN gate — the zero-rate gate that
// approve/route.ts owns still runs on that path.
/** Thrown to roll the submit txn back when a line has no usable rate — the PO
 *  must stay a DRAFT, the only status in which the rate can still be edited. */
class ZeroRateBlocked extends Error {}

/** One sentence for BOTH the stored approval_note and the audit note, so the row
 *  and the audit trail can never disagree about why this PO is approved. */
const AUTO_APPROVAL_NOTE = (actor: string) =>
  `Auto-approved on submit by ${actor}: admin approval is OFF (po_require_admin_approval=0).`;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    // Submitting puts a PO in the admin approval inbox, so it is a PO WRITE
    // action like cancel/receive/revise. The old `if (!(await currentRole()))`
    // test could NOT gate it: currentRole() collapses 'staff' → 'manager', so a
    // truthiness check on it only asserted "has a session" and any signed-in
    // captain could submit. poWriteGate() tests the real membership
    // (management OR the store manager).
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can submit POs' }, { status: 403 });
    // Resolve the actor BEFORE the status read. Everything from that SELECT to
    // the end of the txn below is synchronous (better-sqlite3 is), so nothing can
    // interleave between the check and the writes — awaiting the session in the
    // middle would re-open that window, and this handler can now approve.
    const actor = await effectiveActor();
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: `Only drafts can be submitted (current: ${po.status})` }, { status: 400 });

    const items = db.prepare('SELECT COUNT(*) AS n FROM purchase_order_items WHERE po_id = ?').get(id) as any;
    if (items.n === 0) return Response.json({ error: 'Cannot submit empty PO — add at least one item' }, { status: 400 });

    // Submit, and (only when the approval switch is off) approve — in ONE txn, so
    // the PO can never be left half-way between the two states.
    const outcome = db.transaction((): { status: 'pending' | 'approved' } => {
      // Clear the rejection reason on re-submit. The Revise action sends a rejected
      // PO back to draft and deliberately KEEPS the reason so the drafter can read
      // it while fixing the PO — but nothing cleared it afterwards, so an approved
      // (even received) PO still rendered "Rejected: …" on the detail row and in the
      // Status timeline of the printout. Re-submitting is the point at which the
      // reason stops being true. It survives in audit_events (po.reject).
      db.prepare(`
        UPDATE purchase_orders
           SET status = 'pending', submitted_at = datetime('now'),
               rejected_reason = NULL, updated_at = datetime('now')
         WHERE id = ?
      `).run(id);

      // FAIL-SAFE: requiresAdminApproval() answers true for a missing row, an
      // unreadable value or any error, so a broken settings row leaves the spend
      // control ON — a failure must never silently disable it.
      if (requiresAdminApproval(db)) return { status: 'pending' };

      // The zero-rate gate is approve/route.ts's, and it is the only thing
      // standing between a ₹0 draft and the books (a ₹0 purchases row makes
      // updateMaterialPrice wipe the material's average_price to 0 and cascade a
      // "free" ingredient through every recipe). Skipping the human approver must
      // not skip it, so both paths call the shared helper.
      //
      // THROW, so the submit rolls back and the PO stays a DRAFT. Committing the
      // submit and leaving it 'pending' stranded it: approve/route.ts re-runs this
      // same blocker and 400s, PUT /api/purchase-orders is draft-only, and Revise
      // needs status 'rejected' — so the PO could be neither fixed nor approved.
      // The one remaining exit is cancel/route.ts (it accepts 'pending' behind the
      // same poWriteGate the submitter just passed), which throws the PO away
      // rather than fixing it. Draft is the one state where the rate is editable,
      // which is exactly what the fix requires.
      const blocker = zeroRateBlocker(db, id);
      if (blocker) throw new ZeroRateBlocked(blocker);

      // approved_by names the automation AND the person whose submit triggered
      // it — never a real admin's address, or the audit trail would show a human
      // approval that never happened.
      // approval_note is OVERWRITTEN for the same reason: approve/route.ts writes
      // it on every human approval and edit-approved writes "Re-approval requested
      // by …", so a PO that went approved → edit → reject → revise → draft still
      // carries that note. Leaving it would park a stale human justification next
      // to approved_by = 'auto (…)'. Same sentence as the audit note below.
      db.prepare(`
        UPDATE purchase_orders
           SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
               approval_note = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(`auto (${actor})`, AUTO_APPROVAL_NOTE(actor), id);
      return { status: 'approved' };
    })();

    if (outcome.status === 'approved') {
      // Distinct event type + the setting state: the audit trail has to explain
      // WHY this PO reached 'approved' with no human approver on it.
      logAuditEvent(db, {
        event_type: 'po.auto_approved',
        entity_type: 'purchase_order',
        entity_id: id,
        actor_email: actor,
        before: { status: 'draft' },
        after: { status: 'approved', approved_by: `auto (${actor})` },
        note: AUTO_APPROVAL_NOTE(actor),
      });
      return Response.json({ success: true, status: 'approved', auto_approved: true });
    }
    return Response.json({ success: true, status: 'pending' });
  } catch (e: any) {
    if (e instanceof ZeroRateBlocked) {
      // Rolled back — the PO is still a draft, which is the only state where the
      // rate can be fixed, and that is the ONLY remedy this response may name.
      // zeroRateBlocker() is written for [id]/approve and ends its message with
      // approve's remedy ("reject this PO, revise it…"), which is impossible from
      // here: reject is admin-only and 400s on anything but pending, and Revise
      // needs 'rejected'. So keep the helper's diagnosis and drop its remedy
      // clause. The replace is a no-op if the helper is ever changed to hand back
      // the diagnosis alone (see the handoff on po-helpers.ts).
      const stripped = e.message.replace(/\s*—\s*reject this PO[\s\S]*$/i, '').trim();
      const diagnosis = /[.!?]$/.test(stripped) ? stripped : `${stripped}.`;
      return Response.json({
        error: `${diagnosis}\n\nThe PO was NOT submitted — it is still a draft. Fix the rate on the line above and submit it again.`,
        status: 'draft',
      }, { status: 400 });
    }
    return Response.json({ error: e.message }, { status: 500 });
  }
}
