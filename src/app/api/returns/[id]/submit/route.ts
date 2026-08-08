import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { checkReturnWindow } from '@/lib/returns';

/**
 * Submit a draft return ticket → moves to 'submitted'.
 * The Department Head / Manager will see it in their approval inbox (req 73).
 * Either the drafter or admin can submit — same gate as requisition submit,
 * so the two modules behave identically for the person raising the ticket.
 *
 * NOTHING HERE MOVES STOCK, AND NOTHING BEFORE STORE ACCEPT DOES EITHER.
 * The whole chain is: raise (draft) → submit (here) → HOD approve → Store
 * verify. `raw_materials.current_stock` and `department_material_transactions`
 * are written at exactly ONE point in the module — inside the store-verify
 * transaction, on the lines the store ACCEPTS. Submitting, approving and
 * rejecting are paperwork. If you are reading this looking for where the
 * grams move, it is the store-verify route, not this one.
 *
 * And when they do move, the two KINDS move in OPPOSITE directions:
 *   kind = 'internal' → goods come back from a department to the central
 *                       store. Department stock DOWN, central stock UP.
 *                       The grams never left the building.
 *   kind = 'vendor'   → goods go back out to the supplier. Central stock
 *                       DOWN, and there is no department leg at all. The
 *                       grams leave the building; crediting central here
 *                       would invent inventory that is physically gone.
 * `material_returns.kind` is set at creation and is never updated — not by
 * this route, not by any other. Do not add an UPDATE of it here.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM material_returns WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });

    if (r.status !== 'draft') {
      return Response.json(
        { error: `Only draft returns can be submitted (current: ${r.status})` },
        { status: 400 },
      );
    }
    if (r.drafted_by !== me.email && me.role !== 'admin') {
      return Response.json({ error: 'Only the drafter or admin can submit' }, { status: 403 });
    }

    // A ticket with no lines is not a return, it is an empty envelope: the HOD
    // would be approving nothing and the store would be handed nothing to
    // verify. Refuse it here rather than let it sit in an inbox.
    const counts = db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN TRIM(COALESCE(reason, '')) = '' THEN 1 ELSE 0 END) AS blank_reason
      FROM material_return_items
      WHERE return_id = ?
    `).get(id) as { n: number; blank_reason: number | null } | undefined;

    const lineCount = Number(counts?.n || 0);
    if (lineCount === 0) {
      return Response.json({ error: 'Cannot submit an empty return — add at least one item' }, { status: 400 });
    }
    // Requirement 72 makes Reason mandatory per line. It is checked again at
    // submit (not only at creation) because a draft can be edited after it is
    // created, and a reason-less line is what turns the return report into a
    // list of unexplained stock movements.
    const blank = Number(counts?.blank_reason || 0);
    if (blank > 0) {
      return Response.json(
        { error: `Every returned item needs a Reason — ${blank} line(s) are missing one` },
        { status: 400 },
      );
    }

    // Requirement 75 — the PO return window. Re-checked here and not only at
    // creation because the window is measured in DAYS against the GRN date:
    // a ticket drafted inside the window can easily still be sitting in draft
    // once the window has closed, and submitting it then would push an
    // out-of-window return into the approval chain. Read-time only — this
    // never writes a PO status, and the default (0 days = no limit) preserves
    // today's behaviour exactly. Internal returns have no PO/GRN anchor, so
    // the window does not apply to them.
    if (r.kind === 'vendor') {
      // checkReturnWindow takes the GRN's DATE, not its id. Passing r.grn_id
      // here made DATE_RE reject it, and because an unprovable date is refused
      // rather than waved through, EVERY vendor return would have been blocked
      // the moment the owner set a non-zero window — a setting that silently
      // bricks the feature it configures. Look the date up.
      const grn = r.grn_id
        ? (db.prepare('SELECT date FROM goods_receipt_notes WHERE id = ?').get(r.grn_id) as any)
        : null;
      const win = checkReturnWindow(db, grn?.date);
      if (!win.ok) return Response.json({ error: win.error }, { status: 400 });
    }

    // Claim the transition in the WHERE clause rather than trusting the row we
    // read above, so two concurrent submits cannot both stamp submitted_by.
    const res = db.prepare(`
      UPDATE material_returns
      SET status = 'submitted', submitted_at = datetime('now'), submitted_by = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'
    `).run(me.email, id);
    if (res.changes !== 1) {
      const now = db.prepare('SELECT status FROM material_returns WHERE id = ?').get(id) as any;
      return Response.json(
        { error: `Only draft returns can be submitted (current: ${now?.status ?? 'unknown'})` },
        { status: 400 },
      );
    }

    // Audit: seed the ticket's timeline at submission so the HOD approval and
    // the store verification chain off a known origin.
    try {
      logAuditEvent(db, {
        event_type: 'return.submit',
        entity_type: 'return_ticket',
        entity_id: id,
        actor_email: me.email,
        outlet_id: r.outlet_id || null,
        before: { status: 'draft' },
        after: {
          status: 'submitted',
          ret_number: r.ret_number,
          kind: r.kind,
          department_id: r.department_id || null,
          grn_id: r.grn_id || null,
          items: lineCount,
        },
      });
    } catch { /* audit must never break the action */ }

    return Response.json({ success: true, status: 'submitted' });
  } catch (e: any) {
    console.error('[return submit]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
