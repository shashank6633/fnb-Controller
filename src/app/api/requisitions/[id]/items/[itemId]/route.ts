import { getDb, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canApproveAsChef } from '@/lib/auth';

/**
 * Per-item chef edit on a submitted requisition.
 *
 * The head chef (or admin) can:
 *   - Change `chef_approved_qty` (the qty store will actually issue)
 *   - Toggle `is_rejected` to mark a single item as not approved
 *   - Attach a `chef_note` explaining the change
 *
 * Without rejecting the entire requisition. Every change appends an
 * audit_events row so we have a clean trail of who did what when.
 *
 * Editable when:
 *   - status = 'submitted' (chef hasn't yet finalized approval)
 *   - status = 'chef_approved' AND user is admin (post-approval correction)
 *
 * PUT /api/requisitions/[id]/items/[itemId]
 *   body: { chef_approved_qty?: number | null, is_rejected?: boolean, chef_note?: string }
 */
export const dynamic = 'force-dynamic';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canApproveAsChef(me)) {
      return Response.json({ error: 'Head chef or admin only' }, { status: 403 });
    }

    const { id: reqId, itemId } = await params;
    const db = getDb();

    const reqRow = db.prepare('SELECT id, status FROM requisitions WHERE id = ?').get(reqId) as any;
    if (!reqRow) return Response.json({ error: 'Requisition not found' }, { status: 404 });
    if (reqRow.status !== 'submitted' && !(reqRow.status === 'chef_approved' && me.role === 'admin')) {
      return Response.json({
        error: `Cannot edit items on a '${reqRow.status}' requisition.${reqRow.status === 'chef_approved' ? ' Admin override required for post-approval edits.' : ''}`,
      }, { status: 400 });
    }

    const item = db.prepare(`
      SELECT id, req_id, material_id, quantity_requested, chef_approved_qty, is_rejected, chef_note
      FROM requisition_items
      WHERE id = ? AND req_id = ?
    `).get(itemId, reqId) as any;
    if (!item) return Response.json({ error: 'Item not found on this requisition' }, { status: 404 });

    const body = await req.json();
    const changes: Record<string, any> = {};
    const before: Record<string, any> = {};
    const after: Record<string, any> = {};

    if (body.chef_approved_qty !== undefined) {
      const n = body.chef_approved_qty === null ? null : Number(body.chef_approved_qty);
      if (n !== null && (!Number.isFinite(n) || n < 0)) {
        return Response.json({ error: 'chef_approved_qty must be >= 0 or null' }, { status: 400 });
      }
      if (n !== item.chef_approved_qty) {
        changes.chef_approved_qty = n;
        before.chef_approved_qty = item.chef_approved_qty;
        after.chef_approved_qty = n;
      }
    }
    if (body.is_rejected !== undefined) {
      const v = body.is_rejected ? 1 : 0;
      if (v !== item.is_rejected) {
        changes.is_rejected = v;
        before.is_rejected = !!item.is_rejected;
        after.is_rejected = !!v;
      }
    }
    if (body.chef_note !== undefined) {
      const v = String(body.chef_note || '');
      if (v !== (item.chef_note || '')) {
        changes.chef_note = v;
        before.chef_note = item.chef_note || '';
        after.chef_note = v;
      }
    }

    if (Object.keys(changes).length === 0) {
      return Response.json({ ok: true, no_change: true });
    }

    const sets = Object.keys(changes).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(changes);
    db.prepare(`UPDATE requisition_items SET ${sets} WHERE id = ?`).run(...vals, itemId);

    // Audit — captures actor + diff + note for compliance
    logAuditEvent(db, {
      event_type: changes.is_rejected !== undefined
        ? (after.is_rejected ? 'req_item.reject' : 'req_item.unreject')
        : 'req_item.chef_edit',
      entity_type: 'requisition_item',
      entity_id: itemId,
      actor_email: me.email,
      before, after,
      note: changes.chef_note ?? body.chef_note ?? `Chef edit on req ${reqId}`,
    });

    const updated = db.prepare(`
      SELECT id, material_id, quantity_requested, chef_approved_qty, is_rejected, chef_note
      FROM requisition_items WHERE id = ?
    `).get(itemId);
    return Response.json({ ok: true, item: updated });
  } catch (e: any) {
    console.error('[/api/requisitions/[id]/items/[itemId] PUT]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
