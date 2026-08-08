import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';

/**
 * Requirement 73 — Return Approval Workflow.
 * Department Head / Manager approves a submitted return ticket → 'hod_approved'.
 * From there the ticket reaches the Store, who verifies it (req 74).
 *
 * ── THIS ROUTE MOVES NO STOCK, AND NEITHER DOES ANYTHING BEFORE STORE ACCEPT ──
 * The chain is: raise (draft) → submit → HOD approve (here) → Store verify.
 * `raw_materials.current_stock` and `department_material_transactions` are
 * written at exactly ONE point in this module — inside the store-verify
 * transaction, on the lines the store ACCEPTS. Everything up to and including
 * this route is paperwork. If you are reading this looking for where the grams
 * move, it is the store-verify route, not this one.
 *
 * That is not an omission, it is the design. A ticket sitting at 'hod_approved'
 * IS the holding state requirement 76's wording implies: the goods are
 * physically at the store counter, the department has released them on paper,
 * and the store has not yet accepted them — so nobody's balance has changed.
 * That is also why there is no second "returned stock" bucket anywhere in the
 * schema: the workflow already models the not-yet-accepted state, and a second
 * stock scalar would silently falsify the variance report, closing valuation,
 * recipe costing and the requisition picker, all of which read
 * raw_materials.current_stock as the single pooled truth.
 *
 * ── AND WHEN THE STOCK DOES MOVE, THE TWO KINDS MOVE OPPOSITE WAYS ──
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
 * body: { note? }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    // THE ROLE HELPER, ALONE. canApproveAsChef covers admin, a full HOD
    // (is_head_chef) and the granular can_approve_requisitions flag — the same
    // gate the requisition chef-approve uses, so an approver who can clear a
    // requisition can clear the return of what that requisition issued.
    //
    // Deliberately NOT gated on the department's head_user_id. A department's
    // head_user_id decides who SEES a ticket (requisitionVisibility), never who
    // may act on one; conflating the two was a live bug once and is not being
    // repeated here. Deliberately also NOT hand-rolled as
    // `me.role === 'admin' || me.is_head_chef` the way the requisition cancel
    // route does — that variant silently excludes a Bar Manager who holds
    // can_approve_requisitions but not is_head_chef.
    if (!canApproveAsChef(me)) {
      return Response.json(
        { error: 'Only a department head, a manager with requisition approval, or an admin can approve this return.' },
        { status: 403 },
      );
    }

    if (r.status !== 'submitted') {
      return Response.json(
        { error: `Only submitted returns can be approved (current: ${r.status})` },
        { status: 400 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const note: string = typeof body?.note === 'string' ? body.note : '';

    // A ticket with no lines is an empty envelope — the store would be handed
    // nothing to verify. Submit already refuses one, but a draft's lines are
    // editable and this is the last gate before the ticket leaves the
    // department, so it is checked again rather than assumed.
    const counts = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN TRIM(COALESCE(reason, '')) = '' THEN 1 ELSE 0 END) AS blank_reason
      FROM material_return_items
      WHERE return_id = ?
    `).get(id) as { n: number; blank_reason: number | null } | undefined;

    const lineCount = Number(counts?.n || 0);
    if (lineCount === 0) {
      return Response.json(
        { error: 'Cannot approve an empty return — it has no items' },
        { status: 400 },
      );
    }
    // Requirement 72 makes Reason mandatory per line. Re-checked here for the
    // same reason submit checks it: a reason-less line is what turns the return
    // report (req 79) into a list of unexplained stock movements.
    const blank = Number(counts?.blank_reason || 0);
    if (blank > 0) {
      return Response.json(
        { error: `Every returned item needs a Reason — ${blank} line(s) are missing one` },
        { status: 400 },
      );
    }

    // Requirement 75's PO return window is deliberately NOT re-checked here.
    // It is a gate on RAISING a vendor return (creation, and again at submit),
    // not on approving one that is already in the chain: a window that expires
    // while a ticket waits in the HOD inbox would strand goods the department
    // has already handed over, with no forward path and no stock consequence to
    // undo. The window governs what may enter the workflow, not what may finish
    // it. Nothing in this module ever writes a purchase_orders status.

    // Claim the transition in the WHERE clause rather than trusting the row read
    // above, so two concurrent approvals cannot both stamp hod_approved_by.
    // (Nothing here moves stock, so this is a bookkeeping race, not a
    // double-credit one — but the store-verify claim relies on this status
    // being reached exactly once, so it is claimed the same way.)
    const res = db.prepare(`
      UPDATE material_returns
      SET status = 'hod_approved', hod_approved_at = datetime('now'),
          hod_approved_by = ?, hod_note = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted'
    `).run(me.email, note, id);
    if (res.changes !== 1) {
      const now = db.prepare('SELECT status FROM material_returns WHERE id = ?').get(id) as any;
      return Response.json(
        { error: `Only submitted returns can be approved (current: ${now?.status ?? 'unknown'})` },
        { status: 400 },
      );
    }

    // Audit: the middle link of the ticket's timeline — submit seeded it, store
    // verify closes it. Recording kind and line count here means the trail shows
    // WHAT was approved, not just that someone approved.
    try {
      logAuditEvent(db, {
        event_type: 'return.hod_approve',
        entity_type: 'return_ticket',
        entity_id: id,
        actor_email: me.email,
        outlet_id: r.outlet_id || null,
        before: { status: 'submitted' },
        after: {
          status: 'hod_approved',
          ret_number: r.ret_number,
          kind: r.kind,
          department_id: r.department_id || null,
          grn_id: r.grn_id || null,
          items: lineCount,
          note,
          stock_moved: false,
        },
        note,
      });
    } catch { /* audit must never break the action */ }

    return Response.json({ success: true, status: 'hod_approved' });
  } catch (e: any) {
    console.error('[return hod-approve]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
