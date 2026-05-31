import { getDb, generateId } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';

/**
 * Phase 1 §3 — Edit an APPROVED PO. Drops status back to `pending_reapproval`
 * so admin must sign off again before receive. Used when a vendor changes their
 * rate after the original approval, or when quantities need to be tweaked.
 *
 * Body: {
 *   items?: [{ id?, material_id, quantity, unit_price, vendor?, vendor_id?, notes? }],
 *   reason: string,   // required — captured in the audit trail
 * }
 *
 * Behaviour:
 *   - Only `approved` POs can be edited via this endpoint (drafts use the normal PUT)
 *   - Replaces line items with the new array
 *   - Recomputes total_cost + header vendor
 *   - Status → `pending_reapproval`, clears approved_at/by + sets re-approval note
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'approved') {
      return Response.json({ error: `Only approved POs can be edited this way (current: ${po.status}). Drafts use the regular PUT.` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : null;
    const reason = String(body?.reason || '').trim();
    if (!reason) return Response.json({ error: 'reason required for re-approval edit' }, { status: 400 });
    if (!items) return Response.json({ error: 'items array required' }, { status: 400 });

    const txn = db.transaction(() => {
      // Replace line items
      db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
      const ins = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let total = 0;
      for (const it of items) {
        const qty = Number(it.quantity) || 0;
        const px  = Number(it.unit_price) || 0;
        const lineTotal = Math.round(qty * px * 100) / 100;
        total += lineTotal;
        ins.run(generateId(), id, it.material_id, qty, px, lineTotal,
                String(it.vendor || '').trim(), it.vendor_id || null, it.notes || '');
      }

      // Status → pending_reapproval. Clear prior approval timestamp;
      // keep a note so admins know who edited and why.
      db.prepare(`
        UPDATE purchase_orders SET
          status = 'pending_reapproval',
          total_cost = ?,
          approved_at = NULL,
          approved_by = '',
          approval_note = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(total, `Re-approval requested by ${me.email}: ${reason}`, id);
    });
    txn();

    return Response.json({ success: true, status: 'pending_reapproval' });
  } catch (e: any) {
    console.error('[edit-approved PO]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
