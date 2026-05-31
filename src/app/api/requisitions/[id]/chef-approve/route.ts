import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';

/**
 * Head Chef approves a submitted requisition → moves to 'chef_approved'.
 * The store manager will see it in their inbox to fulfill / raise vendor PO.
 *
 * body: { note?, item_overrides?: [{ id, quantity_requested }] }
 *   The chef may trim quantities before approval — overrides update individual lines.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) return Response.json({ error: 'Head chef permission required' }, { status: 403 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    if (r.status !== 'submitted') {
      return Response.json({ error: `Only submitted requisitions can be approved (current: ${r.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const note: string = body?.note || '';
    const overrides = Array.isArray(body?.item_overrides) ? body.item_overrides : [];

    // Guard: there must be at least ONE line the chef hasn't rejected.
    // If every line was rejected via the per-item dropdown, an "approval"
    // would chef-approve an empty requisition — store gets nothing, dept
    // gets confused. Force the chef to use Reject instead, with a reason.
    const liveCount = db.prepare(`
      SELECT COUNT(*) AS n
      FROM requisition_items
      WHERE req_id = ? AND COALESCE(is_rejected, 0) = 0
    `).get(id) as { n: number };
    if ((liveCount?.n ?? 0) === 0) {
      return Response.json({
        error: 'Cannot approve — every line on this requisition is rejected. Use Reject (with a reason) to send the whole requisition back to the department.',
        all_rejected: true,
      }, { status: 400 });
    }

    const txn = db.transaction(() => {
      // Apply quantity adjustments (chef trims/edits)
      const upd = db.prepare(`UPDATE requisition_items SET quantity_requested = ? WHERE id = ? AND req_id = ?`);
      for (const o of overrides) {
        const qty = Number(o.quantity_requested);
        if (o?.id && Number.isFinite(qty) && qty > 0) upd.run(qty, o.id, id);
        else if (o?.id && qty === 0) {
          db.prepare('DELETE FROM requisition_items WHERE id = ? AND req_id = ?').run(o.id, id);
        }
      }
      db.prepare(`
        UPDATE requisitions
        SET status = 'chef_approved', chef_approved_at = datetime('now'),
            chef_approved_by = ?, chef_note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(me.email, note, id);
    });
    txn();
    // Audit: complete record of chef approval (req-level), including how many
    // items were rejected / quantity-edited beforehand for traceability.
    try {
      const stats = db.prepare(`
        SELECT
          COUNT(*) AS total_items,
          SUM(CASE WHEN is_rejected = 1 THEN 1 ELSE 0 END) AS rejected,
          SUM(CASE WHEN chef_approved_qty IS NOT NULL AND chef_approved_qty != quantity_requested THEN 1 ELSE 0 END) AS qty_edited
        FROM requisition_items WHERE req_id = ?
      `).get(id) as any;
      logAuditEvent(db, {
        event_type: 'requisition.chef_approve',
        entity_type: 'requisition',
        entity_id: id,
        actor_email: me.email,
        after: { status: 'chef_approved', ...stats, note },
        note,
      });
    } catch { /* audit must never break the action */ }
    // Per Phase 1 SOP, the next gate is Management approval — the requisition
    // sits in 'chef_approved' until Mgmt acts (status 'mgmt_approved'), after
    // which Store can process it.
    return Response.json({ success: true, status: 'chef_approved' });
  } catch (e: any) {
    console.error('[req chef-approve]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
