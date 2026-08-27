import { getDb } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { requisitionHasMovedStock } from '@/lib/issue-stock';

/**
 * Cancel a requisition (any non-terminal state). Drafter or admin only.
 * If a vendor PO was already linked & is still a draft, leave the PO alone — admin
 * can cancel it separately. We don't want to silently destroy that paper trail.
 *
 * STOCK SAFETY: TERMINAL below deliberately does NOT list 'store_processed', so a
 * partially-issued requisition is cancellable — and cancelling it performs no
 * reversal of anything the store already handed over, while dept-stock.ts:190 drops
 * `r.status IN ('cancelled','chef_rejected')` out of the department balance. Once
 * deduct-at-issue is on, that combination strands the goods: gone from central
 * stock, gone from the department. We do not widen TERMINAL (that would refuse
 * cancels that are legal today); we refuse only the requisitions that have actually
 * moved stock, which the requisition_issue_ledger records. See src/lib/issue-stock.ts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    const TERMINAL = ['fulfilled', 'cancelled', 'chef_rejected'];
    if (TERMINAL.includes(r.status)) {
      return Response.json({ error: `Cannot cancel — requisition is ${r.status}` }, { status: 400 });
    }
    // HOD/admin may cancel any live requisition. The department drafter may cancel
    // ONLY while it is still a draft — once submitted (Chef Inbox) or being issued
    // (Partially Issued / store_processed), only HOD or admin can cancel it.
    const isHodOrAdmin = me.role === 'admin' || !!me.is_head_chef;
    const mayCancel = isHodOrAdmin || (r.drafted_by === me.email && r.status === 'draft');
    if (!mayCancel) {
      return Response.json({
        error: 'Only HOD or admin can cancel a requisition once it has been submitted. The drafter can cancel it only while it is still a draft.',
      }, { status: 403 });
    }
    // Stock guard — see the header. A requisition that has already moved stock
    // cannot be cancelled, because cancelling reverses nothing and simultaneously
    // hides the line from the department balance. The store must UNDO the issued
    // lines on the Issue desk first: that path runs applyIssueDelta with the
    // negative delta and puts the goods back in central stock, after which this
    // returns false and the cancel goes through.
    // NOT store-reject. A store-reject now KEEPS what was physically handed over
    // (it cancels only the outstanding balance), so it is zero-delta and leaves
    // this guard firing. A store-rejected line must be UN-REJECTED first, then
    // undone — that is the only sequence that clears this.
    // Returns false for every requisition while `requisition_deduct_at_issue` is
    // '0' (no ledger row can exist), so this refuses nothing today.
    if (requisitionHasMovedStock(db, id)) {
      return Response.json({
        error: 'Cannot cancel — stock has already been issued against this requisition. Undo the issued lines on the Store Issue desk first, then cancel. (A store-rejected line keeps what was already handed over — un-reject it, then undo it.)',
      }, { status: 400 });
    }
    db.prepare(`
      UPDATE requisitions SET status = 'cancelled', cancelled_at = datetime('now'),
        cancelled_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(me.email, id);
    return Response.json({ success: true, status: 'cancelled' });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
