import { getDb } from '@/lib/db';
import { poWriteGate } from '@/lib/po-helpers';

// Management OR the store manager can submit a draft for approval.
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
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'draft') return Response.json({ error: `Only drafts can be submitted (current: ${po.status})` }, { status: 400 });

    const items = db.prepare('SELECT COUNT(*) AS n FROM purchase_order_items WHERE po_id = ?').get(id) as any;
    if (items.n === 0) return Response.json({ error: 'Cannot submit empty PO — add at least one item' }, { status: 400 });

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
    return Response.json({ success: true, status: 'pending' });
  } catch (e: any) { return Response.json({ error: e.message }, { status: 500 }); }
}
