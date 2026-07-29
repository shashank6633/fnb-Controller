import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canIssueAsStore, getCurrentOutletId } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import { mergeDuplicateLines } from '@/lib/po-helpers';

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
 *       po_entry_unit?: string,           // unit quantity_to_purchase + unit_price are in
 *                                         // (recipe or purchase unit); omitted = purchase unit
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
    // STRICT: issuing stock is the store person's act alone — no admin bypass
    // (admin processing from a desk left reqs stuck in the issue queue).
    if (!canIssueAsStore(me)) return Response.json({ error: 'Only the Store person can issue items to a department.' }, { status: 403 });

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
      SELECT ri.*, rm.name AS material_name, rm.current_stock, rm.last_purchase_price, rm.average_price,
             rm.unit AS material_unit,
             -- purchase-unit basis for the auto-PO lines below (a blank
             -- purchase_unit means the material is bought in its recipe unit)
             COALESCE(NULLIF(TRIM(rm.purchase_unit), ''), rm.unit) AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size
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
    let poLines: any[] = [];
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
        // ── Unit-basis boundary (CORE CONVENTION) ──────────────────────
        // purchase_order_items is PURCHASE-unit basis: quantity in purchase
        // units, unit_price in ₹/purchase-unit — receive/route.ts writes that
        // row unchanged and converts ONLY the stock credit (× pack_size).
        // The shortfall the store user works with is in the RECIPE unit, so the
        // basis has to be stated on the wire rather than assumed: optional
        // `po_entry_unit` names the unit this line's quantity_to_purchase +
        // unit_price are in. Omitted = already purchase basis (what the
        // requisition modal posts — it converts before submitting).
        const packSize = Number(it.material_pack_size) || 1;
        const recipeUnit   = String(it.material_unit || '').toLowerCase().trim();
        const purchaseUnit = String(it.material_purchase_unit || it.material_unit || '').toLowerCase().trim();
        // Same guard as receive/route.ts and packFactor(): a real pack
        // conversion needs pack_size > 1 AND the two units to actually differ.
        const isPack = packSize > 1 && recipeUnit !== purchaseUnit;
        const declaredUnit = String(ln.po_entry_unit || '').toLowerCase().trim();
        if (declaredUnit && declaredUnit !== purchaseUnit && declaredUnit !== recipeUnit) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — unrecognised unit "${ln.po_entry_unit}". Send qty/price in ${it.material_purchase_unit || it.material_unit} (purchase unit) or ${it.material_unit} (recipe unit).`,
            material: it.material_name,
          }, { status: 400 });
        }
        // A caller that declares the recipe unit is converted here, so it can no
        // longer post a recipe-unit qty against a ₹/purchase-unit rate (750 ml ×
        // ₹900/BTL = a ₹675,000 line that receive then credits as 562,500 ml).
        // Exact division, no rounding up: qty × price — and the recipe quantity
        // recovered at receive (× pack_size) — are both preserved.
        const poQty   = isPack && declaredUnit === recipeUnit ? purchase / packSize      : purchase;
        const poPrice = isPack && declaredUnit === recipeUnit ? explicitPrice * packSize : explicitPrice;
        poLines.push({
          req_item_id: it.id,
          material_id: it.material_id,
          material_name: it.material_name,
          quantity:   poQty,
          unit_price: poPrice,
          vendor:     vendorName,
          vendor_id:  vendorId,
          notes:      it.notes || '',
        });
      }
    }

    // ONE MATERIAL = ONE PO LINE. This list is MACHINE-assembled from the
    // requisition's rows, so one material reaching it twice (the same item
    // requested on two lines) is an artefact of how the req was raised, not a
    // buyer's decision — sum it onto one line instead of refusing to process the
    // requisition. The human PO composer does the opposite (POST/PUT/
    // edit-approved return duplicateLineError) because a person authored those
    // numbers. Merged BEFORE the header-vendor derivation below so the header
    // describes the lines actually written; a shortfall list with no repeat comes
    // back as the same array, unchanged.
    poLines = mergeDuplicateLines(poLines);

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
          // TRIM both sides: the needle is already trimmed (body value at the top
          // of this block, or an equally trimmed poLines vendor), so an untrimmed
          // vendors.name row would miss and leave the PO header with a vendor NAME
          // but a NULL vendor_id — which every vendor_id-keyed join then drops.
          const v = db.prepare('SELECT id FROM vendors WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1').get(headerVendor) as any;
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
      // 'fulfilled' means NOTHING is still owed to the department. The old rule
      // asked only "was a PO raised?", so issuing 3,000 against an approved
      // 4,500 and raising no PO closed the requisition outright: it dropped out
      // of the store queue after a day and the 1,500 balance was never handed
      // over. Re-read the lines this transaction just wrote and apply the SAME
      // test store-issue uses — effective qty = chef_approved_qty ??
      // quantity_requested, either rejection counts as done, and a deferred line
      // is never done even at full quantity.
      const fresh = db.prepare(`
        SELECT is_rejected, store_rejected, quantity_requested, chef_approved_qty,
               quantity_issued, deferred_until
        FROM requisition_items WHERE req_id = ?
      `).all(id) as any[];
      const allDone = fresh.every(it => {
        if (it.is_rejected) return true;
        if (it.store_rejected) return true;
        const eff = (it.chef_approved_qty != null ? Number(it.chef_approved_qty) : Number(it.quantity_requested)) || 0;
        const got = Number(it.quantity_issued) || 0;
        return got >= eff && !it.deferred_until;
      });
      const finalStatus = (linkedPoId || !allDone) ? 'store_processed' : 'fulfilled';
      const fulfilledAt = finalStatus === 'fulfilled' ? new Date().toISOString() : null;

      // --- 3a. PARTY requisition TRANSFER (store → department) ---
      // Business rule: party requisitions consume directly (no recipe). On the
      // final 'fulfilled' transition, TRANSFER the issued materials out of the
      // store (raw_materials.current_stock − / inventory_transactions) and INTO
      // the owning department's on-hand balance. The helper owns the dedup guard
      // (via the existing party_consumption ledger row), the store deduction, and
      // the department credit — so it is safe to call from both fulfilment paths
      // without any double-transfer. Only fire when no PO is being raised.
      //
      // The trigger stays "no PO raised" and deliberately does NOT follow
      // finalStatus any more. A short issue is now 'store_processed', and gating
      // the transfer on fulfilment would stop party stock leaving the store on
      // the day it physically leaves — and because the party_consumption ledger
      // row makes the transfer one-shot, a later top-up could never move the
      // balance either. Status honesty and transfer timing are separate calls.
      if (!linkedPoId && r.purpose === 'party') {
        applyPartyFulfillment(db, id, me.email);
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
