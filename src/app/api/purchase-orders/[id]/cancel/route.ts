import { getDb, logAuditEvent } from '@/lib/db';
import { effectiveActor, poWriteGate } from '@/lib/po-helpers';

// Management OR the store manager: cancel a PO that has not yet been approved
// (draft / pending / rejected). Approved and received POs are excluded because
// an approved PO may already be with the vendor and a received one has moved
// stock + rewritten average_price — neither can be undone by a status flip.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    // Cancel kills a manager's submitted PO and removes it from the admin
    // approval inbox, so it is a PO WRITE action like submit/receive/revise.
    // A bare `await getCurrentUser()` truthiness test only asserted "has a
    // session" — any signed-in captain could cancel a pending PO. poWriteGate()
    // tests the real membership (management OR the store manager).
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can cancel POs' }, { status: 403 });
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (!['draft', 'pending', 'rejected'].includes(po.status)) {
      return Response.json({ error: `Cannot cancel ${po.status} PO` }, { status: 400 });
    }
    // Atomic claim: repeat the precondition in the WHERE clause rather than
    // trusting the read above, so a PO approved between the two statements is
    // not cancelled anyway. Nothing awaits in that gap today, so this only bites
    // a second process on the same SQLite file (or a future await inserted
    // here) — same shape as reject/route.ts:30-36.
    const claim = db.prepare(`
      UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND status IN ('draft', 'pending', 'rejected')
    `).run(id);
    if (claim.changes === 0) {
      return Response.json({ error: 'This PO is no longer cancellable (someone else moved it). Reload the page.' }, { status: 409 });
    }
    // purchase_orders has no cancelled_by/cancelled_at column (db.ts:788-804),
    // so this audit_events row is the ONLY record of who cancelled the PO.
    logAuditEvent(db, {
      event_type: 'po.cancel', entity_type: 'purchase_order', entity_id: id,
      actor_email: await effectiveActor(),
      before: { status: po.status }, after: { status: 'cancelled' },
    });
    return Response.json({ success: true, status: 'cancelled' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
