import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveRole, effectiveActor, poWriteGate } from '@/lib/po-helpers';

// Admin-only: reject a PO that is awaiting approval (pending or pending_reapproval) with reason.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const role = await effectiveRole();
    if (!role) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (role !== 'admin') {
      return Response.json({ error: 'Only Admin can reject POs' }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const reason = String(body?.reason || '').trim();
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    // Accept a first approval round (pending) AND a re-approval after an edit
    // (pending_reapproval) — same pair approve/route.ts:18 accepts. Rejecting only
    // 'pending' made 'pending_reapproval' a dead end: cancel, receive, edit-approved,
    // PUT, submit and DELETE all exclude it, so approve was its only outgoing edge.
    if (po.status !== 'pending' && po.status !== 'pending_reapproval') {
      return Response.json({ error: `Only pending POs can be rejected (current: ${po.status})` }, { status: 400 });
    }
    // Atomic claim: keep the precondition in the WHERE clause rather than in the
    // gap between the read above and this write. Nothing awaits in that gap today,
    // so this only bites a second process on the same SQLite file (or a future
    // await inserted here) — approve/route.ts:28-39 has the same shape and needs it
    // because two awaits do sit in its gap.
    const claim = db.prepare(`
      UPDATE purchase_orders SET status = 'rejected', rejected_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('pending', 'pending_reapproval')
    `).run(reason, id);
    if (claim.changes === 0) {
      return Response.json({ error: 'This PO is no longer pending approval (someone else decided it). Reload the page.' }, { status: 409 });
    }
    logAuditEvent(db, {
      event_type: 'po.reject', entity_type: 'purchase_order', entity_id: id,
      actor_email: await effectiveActor(),
      before: { status: po.status }, after: { status: 'rejected' }, note: reason,
    });
    return Response.json({ success: true, status: 'rejected' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}

// Withdraw the rejection: rejected → draft, so the drafter can fix the PO and
// re-submit it through the normal submit route.
// BASIS: `rejected` had no outgoing transition — PUT, submit and DELETE are all
// draft-only — so the reject copy ("address the above and re-submit") promised a
// way back that only cancel could answer. Gated with poWriteGate, not admin-only:
// the drafter is the one who has to revise it, and revise never moves money/stock.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management can revise POs' }, { status: 403 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'rejected') {
      return Response.json({ error: `Only rejected POs can be revised (current: ${po.status})` }, { status: 400 });
    }
    // Clear submitted_at as well — the re-submit must stamp a fresh one, otherwise
    // the PO carries the timestamp of the submission that was already rejected.
    // rejected_reason is deliberately NOT cleared: it is the only copy the drafter
    // can read (the PO detail row and the print page both render it, and /api/audit
    // is requireRole('admin')), and the reject modal promises the requester will see
    // it on the PO. Clearing it belongs at the draft→pending re-submit
    // (submit/route.ts), which is where the PO actually leaves the revise loop.
    db.prepare(`
      UPDATE purchase_orders
      SET status = 'draft', submitted_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    logAuditEvent(db, {
      event_type: 'po.revise', entity_type: 'purchase_order', entity_id: id,
      actor_email: await effectiveActor(),
      before: { status: po.status }, after: { status: 'draft' },
      note: 'Rejection withdrawn — back to draft for re-submission',
    });
    return Response.json({ success: true, status: 'draft' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
