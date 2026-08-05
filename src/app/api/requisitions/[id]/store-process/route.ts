import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canIssueAsStore, getCurrentOutletId } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import { mergeDuplicateLines } from '@/lib/po-helpers';
import { applyIssueDelta } from '@/lib/issue-stock';
import { vendorMappingError, vendorResolver } from '@/lib/vendor-mapping';

/**
 * Store Manager processes a chef-approved requisition.
 *
 * For each line the store decides:
 *   - quantity_issued      → recorded on the requisition_item for audit / dept analytics, and
 *                            routed through applyIssueDelta() (src/lib/issue-stock.ts), the
 *                            single writer of stock for a requisition issue.
 *                            While settings key `requisition_deduct_at_issue` is '0' (the
 *                            shipped default) that helper is a no-op, so this route behaves
 *                            exactly as it always has: it does NOT touch
 *                            raw_materials.current_stock and does NOT write
 *                            inventory_transactions. Internal transfers and recipe-driven
 *                            consumption stay strictly separate — the only things that affect
 *                            current_stock are vendor purchases (+) and recipe-deduction on
 *                            sales / parties / staff meals (−).
 *                            With the flag on, the helper owns the whole movement (unit
 *                            conversion, stock UPDATE, inventory_transactions row, ledger row,
 *                            department credit). This route adds none of it by hand.
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
 *   po_delivery_date?: string,           // "Expected Delivery Date" promised by the vendor
 *                                        // (YYYY-MM-DD, never earlier than po_date, future is
 *                                        // normal). Omitted/blank = no promised date (NULL).
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
    // Optional per-gesture replay token (Layer 2 idempotency). When present it is
    // stamped on every issue-ledger row this request writes, and the partial
    // unique index uq_req_issue_token_item makes a replayed POST collide and roll
    // the whole transaction back rather than deduct twice. No current client
    // sends it, and with the deduct flag off no ledger row exists to collide
    // with, so it is inert until both are true.
    const clientToken: string | null =
      typeof body?.client_token === 'string' && body.client_token.trim()
        ? body.client_token.trim()
        : null;
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

    // ── STRICT VENDOR ↔ ITEM MAPPING — the FOURTH path that writes PO lines ──
    // POST /api/purchase-orders, its PUT and [id]/edit-approved all run
    // vendorMappingError() before inserting a line. So does this route now: it
    // writes purchase_order_items from BODY-supplied vendor_id/material_id, and
    // the PO it writes them into is born 'pending' — straight into the admin
    // approval queue. Without this call a requisition shortfall could mint a
    // pair no vendor is mapped to and hand it to an approver pre-queued. Not
    // hypothetical either: the requisition modal's line-vendor dropdown falls
    // back to "all active vendors" whenever a material has no mapping yet
    // (requisitions/page.tsx:2378-2382), so an unmapped pair is one click away.
    //
    // WHY AN UNMAPPED LINE IS LEFT OFF THE PO INSTEAD OF FAILING THE REQUEST.
    // The three human paths 400 the whole save, and they should — composing the
    // PO is the entire act of those requests. Here the PO is a SIDE-EFFECT of
    // ISSUING GOODS. Refusing would strand a storekeeper who is standing at the
    // counter with the department's stock over a purchasing-config gap they
    // cannot fix from this screen (only /vendors/materials can). The issue and
    // the PO are separate acts, so they fail separately: the issue completes,
    // the mapped shortfall lines still get their PO, the unmapped ones are left
    // off it and named in the response. NOTHING IS LOST — quantity_to_purchase
    // is still written onto the requisition_item below (that UPDATE reads `ln`,
    // never poLines), so the shortfall stays visible on the requisition and a
    // buyer can raise the PO on /purchase-orders once the mapping exists.
    //
    // AND NOT "keep the line with a blank vendor for a buyer to fill in": this
    // PO is already in front of an approver, and receive/route.ts groups lines
    // BY VENDOR into po_vendor_bills — a vendor-less line in an approved PO is
    // one nobody can bill or receive. It would not even stay blank: the insert
    // below falls back to the header vendor (`ln.vendor_id || headerVendorId`),
    // silently re-pairing the item with a vendor that was never checked.
    const poSkipped: { material: string; vendor: string; reason: string }[] = [];
    if (poLines.length > 0) {
      const keep: any[] = [];
      // THE SAME RESOLVER vendorMappingError() uses internally, so the pair that
      // is checked is the pair that is stored (POST does this too, at
      // purchase-orders/route.ts:374). Every poLine already carries a vendor —
      // the loop above refuses a PO line without one — so there is no header
      // fallback to worry about here; what there IS, is a line naming vendor_id
      // X alongside the name "Y". The helper resolves ID-FIRST and would clear
      // that pair on X, while the insert below stored the typed "Y" — and
      // receive, purchases and po_vendor_bills all key on the NAME.
      const lineVendorOf = vendorResolver(db);
      for (const ln of poLines) {
        // ONE LINE AT A TIME: the helper returns on its first bad pair, and a
        // per-line verdict is what a drop-the-line rule needs. Same helper, same
        // payload shape and same resolution (id first, else vendor name) as the
        // three human paths — there is no second copy of the rule here.
        const why = vendorMappingError(db, [{
          material_id: ln.material_id,
          vendor_id:   ln.vendor_id || null,
          vendor:      ln.vendor    || '',
        }]);
        if (why) {
          // "Line 1: " is the helper numbering the 1-element array it was just
          // handed — meaningless to a store user looking at a requisition. The
          // material name takes its place; the rest of the sentence (the vendor,
          // the Vendor Items screen, the vendors that DO supply the item) is
          // kept verbatim so the way out is identical on all four paths.
          poSkipped.push({
            material: ln.material_name,
            vendor:   ln.vendor || ln.vendor_id || '',
            reason:   why.replace(/^Line\s+1:\s*/, ''),
          });
          continue;
        }
        // The pair was cleared against the vendor the helper RESOLVED, so the row
        // is stored against that same vendor — id AND the master row's own
        // spelling of the name. 'unknown' is unreachable (the rule above refuses
        // it), but if it ever arrived, keep what came in rather than blanking the
        // line silently. 'empty' likewise — the PO-line loop already refused it.
        const lv = lineVendorOf(ln);
        if (lv.status === 'known') {
          ln.vendor    = lv.name;
          ln.vendor_id = lv.id;
        }
        keep.push(ln);
      }
      poLines = keep;
    }

    const outletId = await getCurrentOutletId();
    const result: any = {};
    if (poSkipped.length > 0) {
      // The store user is TOLD, in the same response that confirms the issue.
      // Machine-readable rows AND one sentence a person can act on, because the
      // difference between "the PO is short a line" and "no PO was raised at
      // all" is the difference between two follow-up actions.
      result.po_skipped_lines = poSkipped;
      result.po_skipped_note =
        (poLines.length > 0
          ? `${poSkipped.length} shortfall line${poSkipped.length === 1 ? ' was' : 's were'} left OFF the purchase order`
          : `No purchase order was raised: ${poSkipped.length === 1 ? 'the only shortfall line' : `all ${poSkipped.length} shortfall lines`} could not go on one`) +
        ` because the vendor is not mapped to the item. The issue is recorded and the quantity is still on the ` +
        `requisition — fix the mapping on Vendor Items, then raise the PO on Purchase Orders. ` +
        poSkipped.map(s => `${s.material}: ${s.reason}`).join(' ');
    }

    const txn = db.transaction(() => {
      // ── Atomic claim (MUST stay the first statement in this txn) ──────────
      // The status check at the top of this handler is separated from every
      // write by two awaits (params + req.json), so two concurrent processes can
      // both pass it. This route is ABSOLUTE (SET quantity_issued = ?), so a lost
      // race is not a harmless repeat: both requests write their own absolute
      // quantities, both raise an auto-PO, and — once the deduct flag is on —
      // both compute a delta from the same stale pre-image and deduct it twice.
      // better-sqlite3 transactions are synchronous, so whoever flips the status
      // out of the approved set here wins; the loser's UPDATE matches 0 rows and
      // throws, rolling its whole txn back before anything else is written.
      // 'store_processed' is provisional — the real finalStatus ('fulfilled' or
      // 'store_processed') is written by the UPDATE at the end of this txn, so
      // the committed row is unchanged from today's behaviour.
      const claim = db.prepare(`
        UPDATE requisitions
        SET status = 'store_processed'
        WHERE id = ? AND status IN ('mgmt_approved', 'chef_approved')
      `).run(id);
      if (claim.changes === 0) {
        const err: any = new Error('This requisition has already been processed (or is no longer approved). Reload the page.');
        err.httpStatus = 409;
        throw err;
      }

      // --- 1. Record what was issued.
      // This route itself still writes NOTHING to raw_materials.current_stock or
      // inventory_transactions by hand. Any stock movement is delegated to
      // applyIssueDelta() below, and that helper is a no-op until settings key
      // `requisition_deduct_at_issue` is '1' — the shipped default is '0'. Until
      // it is flipped, recipe consumption (driven by sales) remains the ONLY
      // thing that subtracts from stock and purchases (vendor inwards) the only
      // thing that adds to it, exactly as before.
      const updReqItem = db.prepare(`
        UPDATE requisition_items
        SET quantity_issued = ?, quantity_to_purchase = ?
        WHERE id = ?
      `);

      // quantity_to_purchase obeys Option B exactly like every other quantity on
      // the row: it is stored in the LINE'S OWN `unit` (blank = recipe). But the
      // modal posts it in `po_entry_unit`, which DEFAULTS to the purchase unit —
      // so without this a 6-BTL shortfall landed verbatim in a blank-unit
      // (recipe) line and the requisition read it back as 6 ml, 750× too small.
      // The PO line is unaffected: it keeps using poQty, already purchase units.
      const toLineBasis = (it: any, ln: any, posted: number) => {
        const recipeUnit   = String(it.material_unit || '').toLowerCase().trim();
        const purchaseUnit = String(it.material_purchase_unit || '').toLowerCase().trim();
        const packSize     = Number(it.material_pack_size) || 1;
        if (!(packSize > 1 && recipeUnit !== purchaseUnit)) return posted;
        const lineUnit         = String(it.unit || '').toLowerCase().trim();
        const lineIsPurchase   = lineUnit !== '' && lineUnit === purchaseUnit;
        const postedIsPurchase = (String(ln.po_entry_unit || '').toLowerCase().trim() || purchaseUnit) === purchaseUnit;
        if (postedIsPurchase === lineIsPurchase) return posted;
        return postedIsPurchase ? posted * packSize : posted / packSize;
      };

      // The pre-image for the issue ledger. It MUST be read here — inside this
      // transaction, immediately before the absolute UPDATE — for two reasons:
      //   1. This route SETs quantity_issued rather than adding to it, so the
      //      instant updReqItem runs the old value is gone and no later read can
      //      recover it.
      //   2. The `items` array above was SELECTed before `await req.json()` and
      //      before this transaction opened, so it is a stale snapshot, not a
      //      pre-image.
      const selBefore = db.prepare(`SELECT quantity_issued FROM requisition_items WHERE id = ?`);
      const unitReview: string[] = [];

      for (const it of items) {
        const ln = lineMap.get(it.id) || {};
        const issued   = Number(ln.quantity_issued)      || 0;
        const purchase = Number(ln.quantity_to_purchase) || 0;
        const beforeIssued = Number((selBefore.get(it.id) as any)?.quantity_issued) || 0;
        updReqItem.run(issued, toLineBasis(it, ln, purchase), it.id);
        // EVERY row in this loop, not only the ones with issued > 0. This loop is
        // both absolute and unfiltered: it rewrites lines the client omitted
        // (issued = 0) and chef-rejected lines too — the is_rejected guard exists
        // in the validate loop and the PO-building loop above, but deliberately
        // NOT here. So a line that held 5 and is now absent must CREDIT 5 back to
        // the store, which is exactly what a before/after pair says. Passing
        // `issued` as if it were a deduction would double-deduct every re-process,
        // and computing new−old for submitted rows only would silently swallow
        // every credit.
        const res = applyIssueDelta(db, {
          reqItemId: it.id,
          beforeLineQty: beforeIssued,
          afterLineQty: issued,
          reason: 'store_process',
          actor: me.email,
          clientToken,
        });
        if (res.needsUnitReview) unitReview.push(it.material_name);
      }
      // Only surfaced when the helper actually refused a line for an ambiguous
      // unit — impossible while the deduct flag is off, so the response body is
      // byte-identical to today's.
      if (unitReview.length > 0) result.issue_unit_review = unitReview;

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
        // ── Expected Delivery Date (optional) ────────────────────────────────
        // Blank stays NULL. purchase_orders.delivery_date was added with no
        // backfill precisely so "no promised date" stays distinguishable from a
        // fabricated one — defaulting it to isoDate here would invent a vendor
        // commitment for every requisition-raised PO.
        //
        // NOT checkPurchaseDate(): that guard refuses FUTURE dates for
        // non-admins, which is exactly what a promised delivery is — it would
        // reject every honest entry a storekeeper makes. What a delivery date
        // cannot be is earlier than the order it belongs to.
        //
        // Round-tripped through Date as well as the shape test, because the
        // column is TEXT: '2026-02-31' passes the regex, is un-renderable as a
        // promised date, and would sit in the row forever once written.
        //
        // Thrown, not returned: isoDate only exists inside this transaction, so
        // the comparison has to happen here. The throw rolls the whole issue
        // back before anything commits and the catch turns httpStatus into a
        // plain 400 — same net effect as the pre-txn validators above.
        const rawDelivery = typeof body?.po_delivery_date === 'string' ? body.po_delivery_date.trim() : '';
        let deliveryDate: string | null = null;
        if (rawDelivery) {
          const asDate = new Date(`${rawDelivery}T00:00:00Z`);
          const wellFormed = /^\d{4}-\d{2}-\d{2}$/.test(rawDelivery)
            && !Number.isNaN(asDate.getTime())
            && asDate.toISOString().slice(0, 10) === rawDelivery;
          if (!wellFormed) {
            const err: any = new Error(`Expected Delivery Date must be a valid date (YYYY-MM-DD) — got "${rawDelivery}".`);
            err.httpStatus = 400;
            throw err;
          }
          if (rawDelivery < isoDate) {
            const err: any = new Error(`Expected Delivery Date (${rawDelivery}) cannot be earlier than the PO date (${isoDate}).`);
            err.httpStatus = 400;
            throw err;
          }
          deliveryDate = rawDelivery;
        }
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
          INSERT INTO purchase_orders (id, po_number, date, delivery_date, vendor_id, vendor, status, notes, drafted_by,
                                       submitted_at, submitted_by, requisition_id, outlet_id,
                                       created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), ?, ?, ?, datetime('now'), datetime('now'))
        `).run(linkedPoId, poNumber, isoDate, deliveryDate, headerVendorId, headerVendor || '',
                `Auto-raised from requisition ${r.req_number}`, me.email, me.email, id, outletId);

        // req_item_id is THE traceability link and this is the ONLY place in the
        // app where it is in scope at PO-insert time: poLines carries it from the
        // shortfall loop above (`req_item_id: it.id`). Until now it lived only in
        // memory and the sole surviving trace of which requisition a PO line came
        // from was the `From REQ-...` note text below — which names the
        // REQUISITION, never the LINE, so a material requested twice at different
        // quantities could not be told apart afterwards. Do NOT "simplify" this
        // away as redundant with that note: the note is prose, this is the join
        // key the purchase → requisition → issue log reads.
        //
        // FIRST-LINE-PRECISE ON THE MERGED PATH, stated rather than hidden:
        // mergeDuplicateLines() (src/lib/line-dedupe.ts:116) folds two
        // requisition lines for the same material into ONE PO line and keeps the
        // FIRST occurrence's fields, so the merged line stores the FIRST
        // req_item_id while its joined ' | ' notes carry both lines' text.
        // Nothing is lost that today's note text does not already lose.
        const insPoItem = db.prepare(`
          INSERT INTO purchase_order_items (id, po_id, material_id, quantity, unit_price, total_price, vendor, vendor_id, notes, req_item_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let total = 0;
        for (const ln of poLines) {
          const lineTotal = Math.round(ln.quantity * ln.unit_price * 100) / 100;
          total += lineTotal;
          insPoItem.run(generateId(), linkedPoId, ln.material_id, ln.quantity, ln.unit_price,
                        // Already resolved and CHECKED above — no fallback here,
                        // or the stored pair could differ from the validated one.
                        lineTotal, ln.vendor || '', ln.vendor_id || null,
                        `From ${r.req_number}: ${ln.notes || ''}`.trim(),
                        // NULL, not '', when absent: this column is a soft link to
                        // requisition_items.id and every other writer of this table
                        // leaves it NULL. An empty string would join to nothing and
                        // read as "linked" to any IS NOT NULL filter.
                        ln.req_item_id || null);
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
      // A line left off the PO for an unmapped vendor counts as OUTSTANDING, the
      // same as a PO that was raised. Without `poSkipped.length` here, the one
      // case where dropping a line changes the status is a full issue plus a
      // buy-extra line: pre-fix it raised a PO and stayed 'store_processed', and
      // it would now close as 'fulfilled' — dropping out of the store queue with
      // a purchase still to arrange and this requisition its only record.
      const finalStatus = (linkedPoId || poSkipped.length > 0 || !allDone) ? 'store_processed' : 'fulfilled';
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
      // `!linkedPoId` used to mean "nothing is on order, so what was issued is
      // all the party is getting" — safe to move it to the department now.
      //
      // Dropping unmapped vendor lines broke that reading: a shortfall that
      // WOULD have become a PO can now be skipped instead, leaving linkedPoId
      // null while goods are still genuinely outstanding. The transfer would
      // then fire on the partial quantity, and because the party_consumption
      // ledger row makes it one-shot, the remainder could never move afterwards
      // — the party would be permanently short on the books.
      //
      // So it is gated on nothing being outstanding: no PO raised AND no line
      // dropped. A dropped line is exactly as "still to come" as a PO line.
      if (!linkedPoId && poSkipped.length === 0 && r.purpose === 'party') {
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
    // A lost double-process race is a conflict, not a server fault — the atomic
    // claim at the top of the txn tags it with 409 so the UI can say "already
    // processed". Everything else keeps the existing 500.
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
