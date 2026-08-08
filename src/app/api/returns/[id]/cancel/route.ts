import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';
import { RETURN_TERMINAL_STATUSES } from '@/lib/returns';

/**
 * Withdraw a return ticket → 'cancelled'. Terminal.
 *
 * Cancellable from 'draft', 'submitted' or 'hod_approved' — i.e. every status
 * that is not already terminal. RETURN_TERMINAL_STATUSES is the single list of
 * those ('verified', 'hod_rejected', 'cancelled'), so this route cannot drift
 * out of step with the lifecycle if a status is ever added.
 *
 * ── THIS ROUTE MOVES NO STOCK, AND NEITHER DOES ANYTHING BEFORE STORE ACCEPT ──
 * The chain is: raise (draft) → submit → HOD approve → Store verify.
 * `raw_materials.current_stock` and `department_material_transactions` are
 * written at exactly ONE point in this module — inside the store-verify
 * transaction, on the lines the store ACCEPTS. Raising, submitting, approving,
 * rejecting and cancelling are all paperwork. If you are reading this looking
 * for where the grams move, it is the store-verify route, not this one.
 *
 * So a cancel is a pure status write, deliberately. Nothing left the department
 * on paper when the ticket was raised and nothing entered central when the HOD
 * approved it, so there is nothing to give back — a cancelled ticket leaves
 * stock EXACTLY where it was by doing nothing at all. Do NOT add a compensating
 * write here "for symmetry": there is no movement to compensate for, and one
 * added anyway would be a pure invention (or destruction) of inventory. This is
 * the same reasoning the hod-reject route carries, for the same reason — cancel
 * and reject are the two verbs a reader most expects to undo something.
 *
 * ── WHY 'verified' IS REFUSED RATHER THAN REVERSED ──
 * A verified ticket is the one status whose transition DID move stock. The
 * owner's standing rule is that a settled movement is never silently undone:
 * the correction path is a NEW ticket in the opposite direction, raised,
 * approved and store-accepted on its own paper trail, not an "undo" button that
 * rewrites history. Cancelling a verified ticket here would also be worse than
 * a no-op — the ticket would stop reporting as a return while its ledger rows
 * stayed on the books, so the movement would exist in stock and vanish from the
 * return report (req 79). Hence a 400, and no write of any kind.
 *
 * ── AND WHEN STOCK DOES MOVE (elsewhere), THE TWO KINDS MOVE OPPOSITE WAYS ──
 *   kind = 'internal' → a department hands goods back to the central store.
 *                       Department stock DOWN, central stock UP. The grams
 *                       never leave the building.
 *   kind = 'vendor'   → goods go back out to the supplier. Central stock DOWN,
 *                       and there is NO department leg at all. The grams leave
 *                       the building; crediting central for a vendor return
 *                       would invent inventory that is physically gone.
 * That asymmetry is exactly why a cancel must never "put the stock back" from a
 * generic code path: there is no single direction to put it back in.
 * `material_returns.kind` is set at creation and is never updated — not here,
 * not anywhere. Do not add an UPDATE of it to this route.
 *
 * body: { reason? } — recorded on the audit trail; not required (a withdrawal
 * refuses nobody's goods, unlike an HOD reject, where the reason IS the point).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    // WHO MAY CANCEL — ONE HELPER, ONE ANSWER TO "WHO IS AN APPROVER".
    // canApproveAsChef is the same gate hod-approve and hod-reject use, so there
    // is no approve-but-cannot-cancel asymmetry: anyone who can clear a return
    // through the chain can also withdraw it from the chain. It covers admin, a
    // full HOD (is_head_chef) and the granular can_approve_requisitions flag.
    //
    // Deliberately NOT hand-rolled as `me.role === 'admin' || me.is_head_chef`
    // the way the requisition cancel route does it — that variant silently
    // excludes a Bar Manager who holds can_approve_requisitions but not
    // is_head_chef, giving them approve rights and no cancel rights.
    //
    // Deliberately also NOT gated on the department's head_user_id: a
    // department's head_user_id decides who SEES a ticket
    // (requisitionVisibility), never who may act on one. Conflating the two was
    // a live bug once and is not being repeated here.
    //
    // Plus the raiser, and ONLY on their own DRAFT — mirroring the requisition
    // cancel's shape. A draft has not been handed to anybody yet, so withdrawing
    // it costs no one anything; once it is submitted the HOD's inbox and the
    // store counter are involved and it takes an approver to pull it back.
    const isApprover = canApproveAsChef(me);
    const isOwnDraft = r.status === 'draft' && r.drafted_by === me.email;
    if (!isApprover && !isOwnDraft) {
      return Response.json(
        {
          error:
            'Only a department head, a manager with requisition approval, or an admin can cancel this return. The person who raised it can cancel it only while it is still a draft.',
        },
        { status: 403 },
      );
    }

    if ((RETURN_TERMINAL_STATUSES as readonly string[]).includes(r.status)) {
      // 'verified' gets the longer message because it is the one refusal a user
      // will argue with: the goods really did move and they really do want it
      // undone. Point them at the correction path instead of leaving them stuck.
      const why =
        r.status === 'verified'
          ? 'Cannot cancel — the store has already verified this return and stock has moved. Raise a new return in the opposite direction to correct it; a settled stock movement is never undone in place.'
          : `Cannot cancel — return is already ${r.status}`;
      return Response.json({ error: why }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const reason = String(body?.reason || body?.note || '').trim();

    // Claim the transition in the WHERE clause rather than trusting the row read
    // above, pinned to the exact status we validated. Two concurrent cancels
    // cannot both stamp cancelled_by, and — the case that matters — a cancel
    // racing a store-verify cannot land after the verify has moved stock: the
    // verify's own claim (`WHERE id = ? AND status = 'hod_approved'`) and this
    // one are competing for the same row, so exactly one of them wins and the
    // loser reports the status it actually found.
    const res = db.prepare(`
      UPDATE material_returns
      SET status = 'cancelled', cancelled_at = datetime('now'),
          cancelled_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = ?
    `).run(me.email, id, r.status);
    if (res.changes !== 1) {
      const now = db.prepare('SELECT status FROM material_returns WHERE id = ?').get(id) as any;
      return Response.json(
        { error: `Cannot cancel — return is now ${now?.status ?? 'unknown'}` },
        { status: 400 },
      );
    }

    // Audit: a cancel leaves no stock rows behind it, so this entry is the only
    // record that the ticket existed and was withdrawn. `from` is stamped
    // because withdrawing a draft and withdrawing a ticket the store was already
    // holding are very different events, and stock_moved:false is stamped
    // explicitly rather than left implied — an auditor should not have to infer
    // it from an absence.
    try {
      logAuditEvent(db, {
        event_type: 'return.cancel',
        entity_type: 'return_ticket',
        entity_id: id,
        actor_email: me.email,
        outlet_id: r.outlet_id || null,
        before: { status: r.status },
        after: {
          status: 'cancelled',
          from: r.status,
          ret_number: r.ret_number,
          kind: r.kind,
          department_id: r.department_id || null,
          grn_id: r.grn_id || null,
          reason,
          stock_moved: false,
        },
        note: reason,
      });
    } catch { /* audit must never break the action */ }

    return Response.json({ success: true, status: 'cancelled' });
  } catch (e: any) {
    console.error('[return cancel]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
