import { getDb, generateId, logAuditEvent } from '@/lib/db';
import { getCurrentUser, canProcessAsStore, getCurrentOutletId } from '@/lib/auth';

/**
 * Store Manager processes a chef-approved requisition.
 *
 * For each line the store decides:
 *   - quantity_issued      → recorded on the requisition_item for audit / dept analytics.
 *                            **Does NOT touch raw_materials.current_stock and does NOT write
 *                            inventory_transactions.** Internal transfers and recipe-driven
 *                            consumption are kept strictly separate — the only things that
 *                            affect current_stock are vendor purchases (+) and recipe-deduction
 *                            on sales / parties / staff meals (−).
 *   - quantity_to_purchase → goes onto an auto-created vendor PO (status=pending) which then
 *                            flows through the existing admin-approval pipeline. When that PO
 *                            is received, current_stock increases via the normal purchase path.
 *
 * The line's quantity_issued + quantity_to_purchase do NOT have to equal quantity_requested —
 * the store may issue less, skip a line, or buy more than requested.
 *
 * Body:
 * {
 *   note?: string,                       // store note shown on detail
 *   po_vendor_id?: string,               // optional default vendor for the auto-PO
 *   po_vendor_name?: string,             // free-text fallback
 *   po_date?: string,                    // ISO date for the new PO (defaults today)
 *   lines: [
 *     {
 *       id: string,                       // requisition_item id
 *       quantity_issued: number,
 *       quantity_to_purchase: number,
 *       unit_price?: number,
 *       vendor?: string,
 *       vendor_id?: string
 *     }
 *   ]
 * }
 *
 * Response: { status, requisition, linked_po? }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const me = await getCurrentUser();
    if (!me) return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (!canProcessAsStore(me)) return Response.json({ error: 'Store manager permission required' }, { status: 403 });

    const { id } = await params;
    const db = getDb();
    const r = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(id) as any;
    if (!r) return Response.json({ error: 'Not found' }, { status: 404 });
    // Phase 1 §2: store can only act AFTER Mgmt approval (the 2nd gate).
    // Old chef_approved is still accepted for back-compat with already-in-flight reqs
    // imported before the Mgmt step existed.
    if (r.status !== 'mgmt_approved' && r.status !== 'chef_approved') {
      return Response.json({ error: `Only Mgmt-approved requisitions can be processed (current: ${r.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    const note: string = body?.note || '';
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    // Opt-in flag for the legacy auto-PO behaviour. Default = false: this
    // endpoint is now pure "issue from stock" — no vendor side-effects. Store
    // managers raise POs separately on /purchase-orders. Callers that want
    // the old "issue + auto-PO for shortfall" behaviour must pass
    // `auto_create_po: true` explicitly.
    const autoCreatePo: boolean = body?.auto_create_po === true;
    const lineMap = new Map<string, any>();
    for (const ln of lines) if (ln?.id) lineMap.set(ln.id, ln);

    const items = db.prepare(`
      SELECT ri.*, rm.name AS material_name, rm.current_stock, rm.last_purchase_price, rm.average_price, rm.unit AS material_unit
      FROM requisition_items ri
      JOIN raw_materials rm ON rm.id = ri.material_id
      WHERE ri.req_id = ?
    `).all(id) as any[];
    if (items.length === 0) return Response.json({ error: 'Requisition has no items' }, { status: 400 });

    // Validate before mutating. Stock-sufficiency is informational only —
    // current_stock = total purchased − total recipe-consumed; issuing internally
    // doesn't touch it. We still reject negative qtys.
    for (const it of items) {
      const ln = lineMap.get(it.id);
      if (!ln) continue;
      // Defense in depth — chef-rejected lines must never be issued or
      // purchased here, even if a stale client tries to send them.
      if (it.is_rejected) continue;
      const issued   = Number(ln.quantity_issued)      || 0;
      const purchase = Number(ln.quantity_to_purchase) || 0;
      if (issued < 0 || purchase < 0) {
        return Response.json({ error: `Negative qty on ${it.material_name}` }, { status: 400 });
      }
    }

    // Build the shortfall list — these are PO line candidates
    const poLines: any[] = [];
    const issueLines: { item: any; qty: number }[] = [];

    for (const it of items) {
      // Skip rejected items at the apply step too — same guard as the validate
      // loop above, but this one prevents the actual UPDATE / PO write.
      if (it.is_rejected) continue;
      const ln = lineMap.get(it.id) || {};
      const issued   = Number(ln.quantity_issued)      || 0;
      // quantity_to_purchase is ONLY honoured when caller opted into auto-PO.
      // Otherwise we ignore it — store manager creates POs separately.
      const purchase = autoCreatePo ? (Number(ln.quantity_to_purchase) || 0) : 0;
      if (issued > 0)   issueLines.push({ item: it, qty: issued });
      if (purchase > 0) {
        // Reject PO lines that are missing the data required to actually buy
        // the item. We refuse zero-rate POs (would distort weighted-avg cost
        // when received) and vendor-less POs (no one to send the document to).
        const explicitPrice = Number(ln.unit_price);
        if (!(explicitPrice > 0)) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — unit price is required and must be > 0.`,
            material: it.material_name,
          }, { status: 400 });
        }
        const vendorName = String(ln.vendor || '').trim();
        const vendorId   = ln.vendor_id || null;
        if (!vendorName && !vendorId) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — vendor is required.`,
            material: it.material_name,
          }, { status: 400 });
        }
        poLines.push({
          req_item_id: it.id,
          material_id: it.material_id,
          material_name: it.material_name,
          quantity:   purchase,
          unit_price: explicitPrice,
          vendor:     vendorName,
          vendor_id:  vendorId,
          notes:      it.notes || '',
        });
      }
    }

    const outletId = await getCurrentOutletId();
    const result: any = {};

    const txn = db.transaction(() => {
      // --- 1. Record what was issued — for audit / department analytics only.
      // We deliberately do NOT touch raw_materials.current_stock or write to
      // inventory_transactions. Recipe consumption (driven by sales) is the
      // ONLY thing that subtracts from stock; purchases (vendor inwards) are
      // the only thing that adds to it. Internal transfers stay out of that loop.
      const updReqItem = db.prepare(`
        UPDATE requisition_items
        SET quantity_issued = ?, quantity_to_purchase = ?
        WHERE id = ?
      `);

      for (const it of items) {
        const ln = lineMap.get(it.id) || {};
        const issued   = Number(ln.quantity_issued)      || 0;
        const purchase = Number(ln.quantity_to_purchase) || 0;
        if (issued > 0) {
          // No stock mutation. Just keep the audit number on the requisition_item.
        }
        updReqItem.run(issued, purchase, it.id);
      }

      // --- 2. Create vendor PO for the shortfall (if any) ---
      let linkedPoId: string | null = null;
      if (poLines.length > 0) {
        // Resolve PO header vendor — prefer explicit body vendor, else infer from lines
        let headerVendor   = String(body?.po_vendor_name || '').trim();
        let headerVendorId = body?.po_vendor_id || null;
        if (!headerVendor) {
          const distinctVendors = new Set(poLines.map(l => l.vendor).filter(Boolean));
          if (distinctVendors.size === 1) headerVendor = [...distinctVendors][0];
          else if (distinctVendors.size > 1) headerVendor = `Mixed (${distinctVendors.size} vendors)`;
        }
        if (!headerVendorId && headerVendor) {
          const v = db.prepare('SELECT id FROM vendors WHERE LOWER(name) = LOWER(?) LIMIT 1').get(headerVendor) as any;
          if (v) headerVendorId = v.id;
        }

        const isoDate = String(body?.po_date || new Date().toISOString().slice(0, 10));
        const year = isoDate.slice(0, 4);
        const lastPo = db.prepare(`
          SELECT po_number FROM purchase_orders
          WHERE po_number LIKE 'PO-' || ? || '-%'
          ORDER BY po_number DESC LIMIT 1
        `).get(year) as any;
        const nextNum = lastPo?.po_number ? parseInt(lastPo.po_number.split('-').pop() || '0', 10) + 1 : 1;
        const poNumber = `PO-${year}-${String(nextNum).padStart(4, '0')}`;

        linkedPoId = generateId();
        // PO is created in 'pending' (i.e. submitted) so it lands directly in the admin's approval queue.
        db.prepare(`
          INSERT INTO purchase_orders (id, po_number, date, vendor_id, vendor, status, notes, drafted_by,
                                       submitted_at, submitted_by, requisition_id, outlet_id,
                                       created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), ?, ?, ?, datetime('now'), datetime('now'))
        `).run(linkedPoId, poNumber, isoDate, headerVendorId, headerVendor || '',
                `Auto-raised from requisition ${r.req_number}`, me.email, me.email, id, outletId);

        const insPoItem = db.prepare(`
          INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let total = 0;
        for (const ln of poLines) {
          const lineTotal = Math.round(ln.quantity * ln.unit_price * 100) / 100;
          total += lineTotal;
          insPoItem.run(generateId(), linkedPoId, ln.material_id, ln.quantity, ln.unit_price,
                        lineTotal, ln.vendor || headerVendor || '', ln.vendor_id || headerVendorId,
                        `From ${r.req_number}: ${ln.notes || ''}`.trim());
        }
        db.prepare(`UPDATE purchase_orders SET total_cost = ? WHERE id = ?`).run(total, linkedPoId);
        result.linked_po_id = linkedPoId;
        result.linked_po_number = poNumber;
      }

      // --- 3. Mark the requisition as processed ---
      // If there was no shortfall (all issued from stock), jump straight to 'fulfilled'.
      const finalStatus = linkedPoId ? 'store_processed' : 'fulfilled';
      const fulfilledAt = linkedPoId ? null : new Date().toISOString();

      // --- 3a. PARTY requisition stock deduction ---
      // Business rule: only purchases ADD to current_stock and only recipe-deduction
      // subtracts — EXCEPT for party requisitions, which consume directly (no recipe).
      // Internal requisitions remain audit-only and never reach this branch.
      // Only fire on the final fulfilled transition (i.e. when no PO is being raised).
      if (finalStatus === 'fulfilled' && r.purpose === 'party') {
        // Idempotency guard — never deduct twice for the same requisition.
        const already = db.prepare(`
          SELECT 1 FROM inventory_transactions
          WHERE reference_id = ? AND type = 'party_consumption'
          LIMIT 1
        `).get(id);
        if (already) {
          logAuditEvent(db, {
            event_type: 'requisition.party_consumption.skipped',
            entity_type: 'requisition',
            entity_id: id,
            actor_email: me.email,
            after: { reason: 'already_deducted' },
            note: 'Party consumption skipped — inventory_transactions row already exists',
          });
        } else {
          const decStock = db.prepare(`
            UPDATE raw_materials SET current_stock = current_stock - ?, updated_at = datetime('now')
            WHERE id = ?
          `);
          const insTx = db.prepare(`
            INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, created_at)
            VALUES (?, ?, 'party_consumption', ?, ?, ?, datetime('now'))
          `);
          const partyNote = `Party: ${r.event_name || '(unnamed)'} @ ${r.event_date || ''}`.trim();
          const auditItems: any[] = [];
          let totalCost = 0;
          for (const it of items) {
            const ln = lineMap.get(it.id) || {};
            const issued = Number(ln.quantity_issued) || Number(it.quantity_issued) || Number(it.quantity_requested) || 0;
            if (issued <= 0) continue;
            decStock.run(issued, it.material_id);
            insTx.run(generateId(), it.material_id, -issued, id, partyNote);
            const unitCost = Number(it.last_purchase_price) || Number(it.average_price) || 0;
            const lineCost = Math.round(issued * unitCost * 100) / 100;
            totalCost += lineCost;
            auditItems.push({
              material_id: it.material_id,
              material_name: it.material_name,
              quantity: issued,
              unit_cost: unitCost,
              line_cost: lineCost,
            });
          }
          logAuditEvent(db, {
            event_type: 'requisition.party_consumption',
            entity_type: 'requisition',
            entity_id: id,
            actor_email: me.email,
            after: { items: auditItems, total_cost: Math.round(totalCost * 100) / 100 },
            note: partyNote,
          });
        }
      }
      db.prepare(`
        UPDATE requisitions
        SET status = ?, store_processed_at = datetime('now'), store_processed_by = ?,
            store_note = ?, linked_po_id = ?,
            fulfilled_at = COALESCE(?, fulfilled_at),
            fulfilled_by = COALESCE(?, fulfilled_by),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(finalStatus, me.email, note, linkedPoId,
              fulfilledAt, fulfilledAt ? me.email : null, id);
      result.status = finalStatus;
    });
    txn();

    return Response.json({ success: true, ...result });
  } catch (e: any) {
    console.error('[req store-process]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}
