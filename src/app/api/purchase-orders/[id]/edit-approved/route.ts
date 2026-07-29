import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock } from '@/lib/store-engine';
import { duplicateLineError } from '@/lib/po-helpers';

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
 *   - Admin or Manager only (it un-does an admin approval and rewrites the money)
 *   - Only `approved` POs can be edited via this endpoint (drafts use the normal PUT)
 *   - Replaces line items with the new array (at least one line; same material +
 *     store guards as create/edit), and writes a `po.edit` audit event
 *   - Recomputes total_cost. The HEADER vendor is deliberately not claimed here:
 *     unlike POST/PUT this route does not call deriveHeaderVendor() (it is
 *     module-local to api/purchase-orders/route.ts), so purchase_orders.vendor
 *     keeps its pre-edit value even if every line moved to another vendor.
 *   - Status → `pending_reapproval`, clears approved_at/by + sets re-approval
 *     note — claimed atomically (`WHERE status = 'approved'`) as the first
 *     statement of the txn, so a concurrent receive cannot be undone
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    // Reversing an admin's approval AND rewriting the PO's money belongs with
    // approve/reject (Admin-only), not with create/submit/receive — so this
    // DELIBERATELY does not use poWriteGate(), whose isManagement() membership
    // also admits a staff-tier head of department. Nothing upstream role-gates
    // /api/* paths, so this route is the only gate. `me.role` from
    // getCurrentUser() is the REAL tier — effectiveRole() would collapse
    // staff → 'manager' and let every signed-in captain through.
    if (me.role !== 'admin' && me.role !== 'manager') {
      return Response.json({ error: 'Only Admin or Manager can edit an approved PO' }, { status: 403 });
    }

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
    // `Array.isArray([])` is true, so an empty array used to delete every line and
    // write total_cost = 0 — leaving a PO that can neither be received ('PO has no
    // items') nor edited back. Same guard submit uses; zeroing a PO = cancel it.
    if (items.length === 0) {
      return Response.json({ error: 'Cannot edit a PO to zero items — keep at least one line, or cancel the PO' }, { status: 400 });
    }

    // The same checks create/edit run before touching lines (route.ts:176/179/244);
    // this endpoint replaces the WHOLE item set, so it needs them too:
    //  - material must exist — an unknown id vanishes from the detail JOIN and from
    //    receive (both INNER JOIN raw_materials), silently dropping money;
    //  - store-mapped (liquor) materials never enter Central Store POs, else receive
    //    filters them out and hard-fails if they were the only lines;
    //  - qty/rate must be sane. BOTH are written as `!(Number(x) …)` so a
    //    non-numeric or absent value (NaN) is rejected: a bare `< 0` is false for
    //    NaN, and the insert's `Number(x) || 0` would then store the line at ₹0.
    //    Rate here is ₹/PURCHASE-unit (canon); an explicit ₹0 is still accepted
    //    (receive hard-fails on a zero rate, so it can never reach stock/books).
    const matExists = db.prepare('SELECT 1 FROM raw_materials WHERE id = ?');
    for (const it of items) {
      const materialId = String(it?.material_id || '').trim();
      if (!materialId || !matExists.get(materialId)) {
        return Response.json({ error: `Unknown material on a line: ${materialId || '(blank)'}` }, { status: 400 });
      }
      const blocked = centralFlowBlock(db, materialId);
      if (blocked) return Response.json({ error: blocked }, { status: 400 });
      if (!(Number(it.quantity) > 0)) {
        return Response.json({ error: 'Every line needs a quantity greater than 0' }, { status: 400 });
      }
      if (!(Number(it.unit_price) >= 0)) {
        return Response.json({ error: 'Line rate must be a number (₹ per purchase unit) and cannot be negative' }, { status: 400 });
      }
    }
    // …and the same one-material-one-line rule POST/PUT enforce: this endpoint
    // replaces the WHOLE item set, so a repeat here would reach receive as two
    // purchases rows + two stock credits for one item.
    const dupLine = duplicateLineError(items);
    if (dupLine) return Response.json({ error: dupLine }, { status: 400 });

    // Snapshot the lines BEFORE the DELETE below — plus the approval this edit
    // erases (approved_by/approved_at are cleared by the atomic claim below).
    // approve/route.ts
    // overwrites approval_note unconditionally, so without this the edited-away
    // numbers and the original approver leave no trace anywhere.
    const beforeItems = db.prepare(`
      SELECT material_id, quantity, unit_price, total_price, vendor, vendor_id
      FROM purchase_order_items WHERE po_id = ?
    `).all(id) as any[];
    // Hoisted so the post-txn audit event can read what replaced them.
    let newTotal = 0;
    const afterItems: any[] = [];

    const txn = db.transaction(() => {
      // ── Atomic claim (MUST stay the first statement in this txn) ──────────
      // The status === 'approved' check above is separated from every write by
      // an await (req.json), so a receive that commits inside that window would
      // be silently undone here: the DELETE below would orphan the GRN rows
      // keyed on po_item_id, and the PO would sit at pending_reapproval again —
      // approvable and receivable a SECOND time, double-crediting stock and
      // re-running updateMaterialPrice. better-sqlite3 txns are synchronous, so
      // re-asserting the precondition in the WHERE clause means the loser
      // matches 0 rows and throws, rolling its whole txn back untouched.
      const claim = db.prepare(`
        UPDATE purchase_orders
        SET status = 'pending_reapproval',
            approved_at = NULL,
            approved_by = '',
            updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'
      `).run(id);
      if (claim.changes === 0) {
        const err: any = new Error('This PO is no longer approved (it may have been received). Reload the page.');
        err.httpStatus = 409;
        throw err;
      }

      // Replace line items
      db.prepare('DELETE FROM purchase_order_items WHERE po_id = ?').run(id);
      const ins = db.prepare(`
        INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const it of items) {
        // Store the SAME trimmed id that was validated above, or a padded id would
        // pass the existence check and then fail the raw_materials JOIN.
        const materialId = String(it.material_id || '').trim();
        const qty = Number(it.quantity) || 0;
        const px  = Number(it.unit_price) || 0;
        const lineTotal = Math.round(qty * px * 100) / 100;
        newTotal += lineTotal;
        ins.run(generateId(), id, materialId, qty, px, lineTotal,
                String(it.vendor || '').trim(), it.vendor_id || null, it.notes || '');
        afterItems.push({ material_id: materialId, quantity: qty, unit_price: px, total_price: lineTotal });
      }

      // Money + note follow the claim (status/approved_at/approved_by were
      // already cleared there): newTotal is only known after the re-insert.
      // Keep a note so admins know who edited and why.
      db.prepare(`
        UPDATE purchase_orders SET
          total_cost = ?,
          approval_note = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(newTotal, `Re-approval requested by ${me.email}: ${reason}`, id);
    });
    txn();

    // 'po.edit' is the key /audit already reserves a tone for (audit/page.tsx:29)
    // and nothing emitted it — this endpoint was the missing writer.
    logAuditEvent(db, {
      event_type: 'po.edit',
      entity_type: 'purchase_order',
      entity_id: id,
      actor_email: me.email,
      before: {
        status: po.status, total_cost: po.total_cost,
        approved_by: po.approved_by, approved_at: po.approved_at,
        items: beforeItems,
      },
      after: { status: 'pending_reapproval', total_cost: newTotal, items: afterItems },
      note: reason,
    });

    return Response.json({ success: true, status: 'pending_reapproval' });
  } catch (e: any) {
    console.error('[edit-approved PO]', e);
    // A lost race against receive/reject is a conflict, not a server fault — the
    // atomic claim inside the txn tags it 409 so the UI can say "reload".
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
