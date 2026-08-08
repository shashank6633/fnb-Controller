import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';

/**
 * Requirement 73 — Return Approval Workflow, the NEGATIVE path.
 * Department Head / Manager rejects a submitted return ticket → 'hod_rejected'.
 * The ticket stops here; it never reaches the Store (req 74) and is terminal.
 *
 * ── THIS ROUTE MOVES NO STOCK. NEITHER DOES ANYTHING BEFORE STORE ACCEPT ──
 * The chain is: raise (draft) → submit → HOD approve/reject (here) → Store
 * verify. `raw_materials.current_stock` and `department_material_transactions`
 * are written at exactly ONE point in this module — inside the store-verify
 * transaction, on the lines the store ACCEPTS. Submitting, approving and
 * rejecting are paperwork. If you are reading this looking for where the grams
 * move, it is the store-verify route, not this one.
 *
 * A rejection is the easiest place in the module to get stock wrong, because a
 * reader reasonably expects "reject" to undo something. There is nothing to
 * undo. The goods never left the department's balance on paper — raising and
 * approving a ticket changes no scalar anywhere — so a rejected return leaves
 * stock EXACTLY where it was, by doing nothing at all. Do not add a
 * compensating write here; there is no movement to compensate for, and one
 * added "for symmetry" would be a pure invention of inventory.
 *
 * ── AND WHEN STOCK DOES MOVE (elsewhere), THE TWO KINDS MOVE OPPOSITE WAYS ──
 *   kind = 'internal' → a department hands goods back to the central store.
 *                       Department stock DOWN, central stock UP. The grams
 *                       never leave the building.
 *   kind = 'vendor'   → goods go back out to the supplier. Central stock DOWN,
 *                       and there is NO department leg at all. The grams leave
 *                       the building; crediting central for a vendor return
 *                       would invent inventory that is physically gone.
 * `material_returns.kind` is set at creation and is never updated — not here,
 * not anywhere. Do not add an UPDATE of it to this route.
 *
 * body: { reason }  — REQUIRED (no silent rejections). Legacy alias: { note }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    // THE ROLE HELPER, ALONE — the same gate as hod-approve, so an approver who
    // can clear a return can also send it back. canApproveAsChef covers admin, a
    // full HOD (is_head_chef) and the granular can_approve_requisitions flag.
    //
    // Deliberately NOT gated on the department's head_user_id: a department's
    // head_user_id decides who SEES a ticket (requisitionVisibility), never who
    // may act on one. Conflating the two was a live bug once and is not being
    // repeated here.
    if (!canApproveAsChef(me)) {
      return Response.json(
        { error: 'Only a department head, a manager with requisition approval, or an admin can reject this return.' },
        { status: 403 },
      );
    }

    if (r.status !== 'submitted') {
      return Response.json(
        { error: `Only submitted returns can be rejected (current: ${r.status})` },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => ({}));
    // Accept `reason` (canonical) or legacy `note` for back-compat with any
    // older client that hasn't been redeployed yet — copied verbatim from the
    // requisition chef-reject so the two modules refuse identically. The trim()
    // is the point: a reason of spaces is a blank reason, and requirement 73's
    // whole value is that the department is told WHY its goods were refused.
    const reason = String(body?.reason || body?.note || '').trim();
    if (!reason) return Response.json({ error: 'reason required' }, { status: 400 });

    // Claim the transition in the WHERE clause rather than trusting the row read
    // above, so two concurrent rejections cannot both stamp hod_rejected_by, and
    // a rejection racing an approval cannot overwrite a ticket the store has
    // already been handed. Nothing here moves stock, so this is a bookkeeping
    // race rather than a double-credit one — but it is claimed the same way as
    // every other transition in this module so no reader has to work out which
    // transitions are guarded and which are not.
    const res = db.prepare(`
      UPDATE material_returns
      SET status = 'hod_rejected', hod_rejected_at = datetime('now'),
          hod_rejected_by = ?, hod_rejected_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted'
    `).run(me.email, reason, id);
    if (res.changes !== 1) {
      const now = db.prepare('SELECT status FROM material_returns WHERE id = ?').get(id) as any;
      return Response.json(
        { error: `Only submitted returns can be rejected (current: ${now?.status ?? 'unknown'})` },
        { status: 400 },
      );
    }

    // Audit: a rejection is the branch of the timeline with no stock rows behind
    // it, so the audit entry is the ONLY record that this ticket existed and was
    // refused. stock_moved:false is stamped explicitly rather than left implied —
    // an auditor reading the trail should not have to infer it from an absence.
    try {
      logAuditEvent(db, {
        event_type: 'return.hod_reject',
        entity_type: 'return_ticket',
        entity_id: id,
        actor_email: me.email,
        outlet_id: r.outlet_id || null,
        before: { status: 'submitted' },
        after: {
          status: 'hod_rejected',
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

    return Response.json({ success: true, status: 'hod_rejected' });
  } catch (e: any) {
    console.error('[return hod-reject]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
