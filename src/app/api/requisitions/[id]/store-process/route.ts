import { getDb, generateId } from '@/lib/db';
import { getCurrentUser, canIssueAsStore, getCurrentOutletId } from '@/lib/auth';
import { applyPartyFulfillment } from '@/lib/party-fulfillment';
import { mergeDuplicateLines } from '@/lib/po-helpers';
import { applyIssueDelta } from '@/lib/issue-stock';
import { vendorMappingError, vendorResolver } from '@/lib/vendor-mapping';
import { centralFlowBlock } from '@/lib/store-engine';

/**
 * Store Manager processes a chef-approved requisition.
 *
 * For each line the store decides:
 *   - quantity_issued      → recorded on the requisition_item for audit / dept analytics, and
 *                            routed through applyIssueDelta() (src/lib/issue-stock.ts), the
 *                            single writer of stock for a requisition issue.
 *
 *                            THIS PARAGRAPH USED TO SAY THE ISSUE MOVES NO STOCK. IT DOES.
 *                            The old text described settings key
 *                            `requisition_deduct_at_issue` gating the helper to a no-op at
 *                            its shipped '0'. That flag is GONE — src/lib/issue-stock.ts:12
 *                            ("THE FLAG IS GONE. THE DEDUCT IS UNCONDITIONAL") and db.ts:1426
 *                            leave the settings ROW behind, inert, read by nothing. Measured
 *                            on a copy of the live db by calling this route: issuing 21 kg of
 *                            WHOLE GARLIC moved raw_materials.current_stock 227.2 -> 206.2.
 *                            The comment was left asserting the opposite, which is how a
 *                            reader ends up "restoring" a movement that is already happening.
 *                            NOTHING HERE CHANGES THAT BEHAVIOUR — this is the description
 *                            catching up with the code, and the discrepancy against the
 *                            owner's stated flow ("issuing is recorded for department audit
 *                            and does NOT deduct stock") is his call, not this route's.
 *
 *                            So: the helper owns the whole movement (unit conversion, stock
 *                            UPDATE, inventory_transactions row, ledger row, department
 *                            credit) and this route adds none of it by hand. Three cases
 *                            still record the hand-over WITHOUT moving a gram — party
 *                            requisitions (their own rail, see applyPartyFulfillment below),
 *                            store-mapped/liquor materials (the TGBCL ledger), and a line
 *                            whose unit is too ambiguous to convert (reported back as
 *                            issue_unit_review).
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
 * Response (200):
 * {
 *   success: true,
 *   status: 'store_processed' | 'fulfilled',
 *   linked_po_id?, linked_po_number?,      // set iff a PO was actually written
 *   po_line_count?, po_total_cost?,        // that PO's size, for the caller's message
 *   po_note?,                              // ALWAYS present when auto_create_po was on,
 *                                          // and on the plain-issue path whenever a
 *                                          // purchase intent was reported anyway: one
 *                                          // sentence saying what happened to the
 *                                          // purchase side, success included. A caller
 *                                          // that prints only po_skipped_note tells a
 *                                          // storekeeper who just raised PO-2026-0025 to
 *                                          // go and raise a PO. PRINT THIS ONE FIELD and
 *                                          // the message is right on every path.
 *   po_skipped_lines?: [{                  // EVERY line the caller asked to buy that did
 *     code, material, material_id,         // not reach the PO. Never empty-but-silent:
 *     req_item_id, vendor, vendor_id,      // if this array is absent, nothing was dropped.
 *     quantity, purchase_unit,             // quantity + unit_price are PURCHASE basis, the
 *     unit_price, reason                   // same numbers the PO line would have carried.
 *   }],                                    // code ∈ unmapped_vendor | store_mapped |
 *                                          //        no_quantity | chef_rejected |
 *                                          //        po_not_requested.
 *                                          // 'unmapped_vendor' and 'store_mapped' still
 *                                          // owe goods; the other three owe nothing.
 *   po_skipped_note?,                      // the same list as one printable sentence
 *   po_merged_lines?: [{ …, ordered }],    // a repeated material whose 2nd line named a
 *                                          // different vendor/rate and was folded into
 *                                          // the first (see mergeDuplicateLines).
 *                                          // `ordered` false = the combined line was then
 *                                          // dropped and is in po_skipped_lines instead.
 *   issue_unit_review?: string[]           // lines whose unit was too ambiguous to move stock
 * }
 *
 * Errors (400) that name the offending row, so a caller can point at it rather
 * than alert() a sentence — every one is raised BEFORE the transaction opens, so
 * nothing is half-written:
 *   bad_number | negative_qty            → { code, material, req_item_id, field? }
 *   duplicate_line | unknown_line        → { code, req_item_ids: string[] }
 *   missing_line_id                      → { code, count }
 *   po_price_required | po_vendor_required | po_unit_unrecognised
 *   po_qty_too_small                     → { code, material, req_item_id }
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
    // ONE PAYLOAD ROW PER REQUISITION LINE. `lineMap.set` is last-wins, so the
    // same req_item_id sent twice quietly discards the first entry — and with it
    // whatever Buy qty, vendor and price that entry carried. That is the exact
    // silent drop po_skipped_lines exists to end, except it happens before any
    // reporting code can see it. No shipped client can produce it (the modal
    // maps over requisition_items, whose id is a primary key), so a repeat means
    // a malformed or hand-rolled payload and there is no honest way to guess
    // which of the two rows the sender meant. Refused before anything is read.
    //
    // A LINE WITH NO id AT ALL IS THE THIRD DOOR IN THE SAME WALL. `duplicate_line`
    // below and `unknown_line` further down close the two ways a stale payload can
    // lose a row; an ABSENT id was still skipped here and then never looked at
    // again, so a Buy qty of 7 with a vendor and a rate vanished and po_note went
    // on to say "no line had a Buy quantity" — the one field the page is told to
    // print verbatim, stating the opposite of what was sent. There is no honest
    // guess available (no id = no row to attach it to), so it is refused, like its
    // two siblings, before anything is written. Counted, not named: the offending
    // rows have no id to name.
    //
    // ONLY WHEN THE ROW ASKED FOR SOMETHING — same rule as the stale-line gate
    // below. An id-less row of zeros is a padding artefact, not a lost intent, and
    // blocking a hand-over over it would be the over-correction this route avoids
    // everywhere else.
    const lineMap = new Map<string, any>();
    const repeatedIds = new Set<string>();
    let idlessIntent = 0;
    for (const ln of lines) {
      if (!ln?.id) {
        if ((Number(ln?.quantity_issued) || 0) > 0 || (Number(ln?.quantity_to_purchase) || 0) > 0) idlessIntent++;
        continue;
      }
      const key = String(ln.id);
      if (lineMap.has(key)) { repeatedIds.add(key); continue; }
      lineMap.set(key, ln);
    }
    if (idlessIntent > 0) {
      return Response.json({
        error: `${idlessIntent} submitted line${idlessIntent === 1 ? ' carries' : 's carry'} a quantity but no requisition line id, so ${idlessIntent === 1 ? 'it' : 'they'} cannot be matched to ${r.req_number}. Reload the requisition and issue again.`,
        code: 'missing_line_id',
        count: idlessIntent,
      }, { status: 400 });
    }
    if (repeatedIds.size > 0) {
      return Response.json({
        error: `The same requisition line was submitted more than once, so it is not clear which quantity was meant. Reload the requisition and issue again.`,
        code: 'duplicate_line',
        req_item_ids: [...repeatedIds],
      }, { status: 400 });
    }

    // rm.last_purchase_price IS DELIBERATELY NOT SELECTED BELOW — do not add it back.
    // It was a dead payload column here: nothing in this route ever read the value
    // (the PO line's rate comes from the request body's ln.unit_price, refused
    // unless > 0), yet the column is stored in MIXED bases on live data. Checked on
    // a copy of the production db: CURD holds 86 where the Rs/recipe-unit truth is
    // 0.0828, and MALA STRAWBERRY CRUSH 5 LTR holds 0.13482 against a real
    // Rs 674.10/BTL from purchases. A mixed-basis number sitting in an items row is
    // one property read away from being multiplied by a quantity, which is the
    // whole shape of the error the rate-basis lock exists to stop. If a rate is
    // ever genuinely needed here, derive it with src/lib/closing-valuation.ts
    // (materialRate → Rs per purchase unit), never from this column.
    const items = db.prepare(`
      SELECT ri.*, rm.name AS material_name, rm.current_stock, rm.average_price,
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

    // A SUBMITTED LINE THAT IS NOT ON THIS REQUISITION. Every loop below is
    // driven by `items` and reads the payload through lineMap, so a posted id
    // the SELECT above does not know is never looked at again: its Issue qty and
    // its Buy qty both evaporate without a word. That is a client holding a
    // requisition which has since been edited (or a POST aimed at the wrong
    // req) — and if one line is stale, the quantities beside it on every other
    // line are equally untrustworthy, which is why this refuses the whole
    // gesture instead of dropping the row.
    //
    // ONLY WHEN THE STALE ROW CARRIED AN INTENT. A submitted-but-unknown line
    // holding nothing but zeros asks for nothing, and blocking a storekeeper
    // mid-hand-over over a row that wanted nothing would be the same
    // over-correction the mapping rule deliberately avoids.
    const knownItemIds = new Set(items.map(it => String(it.id)));
    const staleLineIds = [...lineMap.entries()]
      .filter(([lid, ln]) => !knownItemIds.has(lid)
        && ((Number(ln?.quantity_issued) || 0) > 0 || (Number(ln?.quantity_to_purchase) || 0) > 0))
      .map(([lid]) => lid);
    if (staleLineIds.length > 0) {
      return Response.json({
        error: `${staleLineIds.length} submitted line${staleLineIds.length === 1 ? ' is' : 's are'} no longer on ${r.req_number} — it was changed while this screen was open. Reload the requisition and issue again.`,
        code: 'unknown_line',
        req_item_ids: staleLineIds,
      }, { status: 400 });
    }

    // A NUMBER THAT IS NOT A NUMBER IS A SILENT ZERO, AND A SILENT ZERO IS A
    // SILENT DECISION. Every quantity below this point is read as
    // `Number(x) || 0`, so "12,5" / "abc" / "1 kg" all arrive as 0 — which on
    // quantity_to_purchase means "the storekeeper did not want to buy this" and
    // on quantity_issued means "nothing was handed over", and the absolute
    // UPDATE further down then CREDITS BACK whatever the line held before.
    // Absent / null / '' still mean 0 on purpose (an untouched box posts one of
    // those); only a value that is present and unparseable is refused, by name,
    // before anything is written.
    const unparseable = (v: unknown) =>
      v !== undefined && v !== null && String(v).trim() !== '' && !Number.isFinite(Number(v));

    // Validate before mutating. Stock-sufficiency is informational only —
    // current_stock = total purchased − total recipe-consumed; issuing internally
    // doesn't touch it. We still reject negative qtys.
    for (const it of items) {
      const ln = lineMap.get(it.id);
      if (!ln) continue;
      // NO `if (it.is_rejected) continue` HERE — IT USED TO BE, ABOVE BOTH
      // CHECKS, AND IT LET A BAD NUMBER THROUGH. The write loop at the bottom of
      // the transaction is deliberately absolute and UNFILTERED (a rejected line
      // that held 5 must still credit 5 back), so a chef-rejected line the
      // validator skipped was nonetheless written from the payload. Measured on
      // a copy of the live db: quantity_issued -5 and quantity_to_purchase 9
      // both landed on the row while the response reported the line as
      // 'chef_rejected', and the requisition closed 'fulfilled' holding a
      // negative issue. Nothing moved on the stock rail, but only because
      // applyIssueDelta's credit clamp caught it — not because any validator
      // did. These two checks are cheap and total, so every submitted row gets
      // them. Rejection is still enforced where it decides an outcome: the
      // PO-building loop below refuses to buy the line (and reports
      // 'chef_rejected'), and the write loop leaves quantity_to_purchase alone.
      for (const [field, label] of [
        ['quantity_issued', 'Issue qty'],
        ['quantity_to_purchase', 'Buy qty'],
        ['unit_price', 'Unit price'],
      ] as const) {
        if (unparseable(ln[field])) {
          return Response.json({
            error: `${label} for ${it.material_name} is not a number (got "${String(ln[field])}").`,
            code: 'bad_number',
            material: it.material_name,
            req_item_id: it.id,
            field,
          }, { status: 400 });
        }
      }
      const issued   = Number(ln.quantity_issued)      || 0;
      const purchase = Number(ln.quantity_to_purchase) || 0;
      if (issued < 0 || purchase < 0) {
        return Response.json({
          error: `Negative qty on ${it.material_name}`,
          code: 'negative_qty',
          material: it.material_name,
          req_item_id: it.id,
        }, { status: 400 });
      }
    }

    // ── THE ONE LIST OF "YOU ASKED TO BUY THIS AND IT WAS NOT ORDERED" ──────
    // Every branch below that declines to turn a buy intent into a PO line
    // pushes here, and the whole array goes back on the response with a
    // machine-readable `code` per row. There is no other exit: a line the
    // caller asked to buy either reaches purchase_order_items, or is named
    // here. `code` exists because the two kinds are NOT the same follow-up —
    // 'unmapped_vendor' and 'store_mapped' still owe the department goods (they
    // keep the quantity on the requisition and keep the req out of 'fulfilled'),
    // 'no_quantity' and 'chef_rejected' owe nothing and must not change the status.
    type PoSkip = {
      code: 'unmapped_vendor' | 'store_mapped' | 'no_quantity' | 'chef_rejected' | 'po_not_requested';
      material: string;
      material_id: string;
      req_item_id: string;
      vendor: string;
      vendor_id: string | null;
      /** PURCHASE basis, like the PO line it would have become. 0 when there was none. */
      quantity: number;
      /** ALWAYS the PURCHASE unit — the basis a PO line is ordered in. */
      purchase_unit: string;
      unit_price: number;
      reason: string;
    };
    const poSkipped: PoSkip[] = [];
    /** A vendor on the line is the ONLY reliable signal that a human meant to
     *  buy: the modal seeds the qty and the price, but never the vendor. */
    const vendorRefOf = (ln: any) => ({
      name: String(ln?.vendor || '').trim(),
      id:   String(ln?.vendor_id || '').trim() || null,
    });

    // Build the shortfall list — these are PO line candidates
    let poLines: any[] = [];
    const issueLines: { item: any; qty: number }[] = [];

    for (const it of items) {
      // Skip rejected items at the apply step too — same guard as the validate
      // loop above, but this one prevents the actual UPDATE / PO write.
      if (it.is_rejected) {
        // …but SAY SO if the caller tried to buy one. The modal filters
        // chef-rejected lines out of its own grid, so this is unreachable from
        // it; a stale tab or a direct POST is exactly the case where dropping
        // the line without a word is worst.
        // NOT gated on autoCreatePo. A buy qty on a chef-rejected line is a
        // purchase intent that cannot be honoured either way, and the contract
        // above ("if po_skipped_lines is absent, nothing was dropped") is only
        // true if it holds on the plain-issue path too.
        const rej = lineMap.get(it.id);
        if (rej && (Number(rej.quantity_to_purchase) || 0) > 0) {
          const v = vendorRefOf(rej);
          poSkipped.push({
            code: 'chef_rejected', material: it.material_name, material_id: it.material_id,
            req_item_id: it.id, vendor: v.name, vendor_id: v.id,
            quantity: Number(rej.quantity_to_purchase) || 0,
            purchase_unit: String(it.material_purchase_unit || it.material_unit || ''),
            unit_price: Number(rej.unit_price) || 0,
            reason: 'The chef rejected this line, so it cannot be issued or purchased from this requisition.',
          });
        }
        continue;
      }
      const ln = lineMap.get(it.id) || {};
      const issued   = Number(ln.quantity_issued)      || 0;
      // quantity_to_purchase is ONLY honoured when caller opted into auto-PO.
      // Otherwise we ignore it — store manager creates POs separately.
      const purchase = autoCreatePo ? (Number(ln.quantity_to_purchase) || 0) : 0;
      if (issued > 0)   issueLines.push({ item: it, qty: issued });
      // ASKED TO BUY WITHOUT ASKING FOR A PO. Forcing `purchase` to 0 on the
      // plain-issue path is the right behaviour — store managers raise POs on
      // /purchase-orders — but forcing it SILENTLY erases a stated purchase
      // intent, which is the one thing this route must never do. The modal
      // cannot reach this (it posts quantity_to_purchase: 0 whenever the box is
      // unticked), so it only ever fires for a stale or hand-rolled payload:
      // precisely the caller that has no other way to find out.
      if (!autoCreatePo && (Number(ln.quantity_to_purchase) || 0) > 0) {
        const v = vendorRefOf(ln);
        poSkipped.push({
          code: 'po_not_requested', material: it.material_name, material_id: it.material_id,
          req_item_id: it.id, vendor: v.name, vendor_id: v.id,
          quantity: Number(ln.quantity_to_purchase) || 0,
          purchase_unit: String(it.material_purchase_unit || it.material_unit || ''),
          unit_price: Number(ln.unit_price) || 0,
          reason: 'This request did not ask for a vendor PO, so the Buy qty was not ordered. Tick "Also raise vendor PO" and submit again, or raise it on Purchase Orders.',
        });
      }
      // PICKED A VENDOR, LEFT THE BUY BOX EMPTY. Today this line simply
      // evaporates: `if (purchase > 0)` skips it, no PO line, no message, and
      // the write loop stores quantity_to_purchase = 0 over it. Picking a
      // vendor is a deliberate act — the seed never fills that field — so the
      // response says the line was not ordered instead of letting the
      // storekeeper walk away believing it was.
      if (autoCreatePo && purchase <= 0) {
        const v = vendorRefOf(ln);
        if (v.name || v.id) {
          poSkipped.push({
            code: 'no_quantity', material: it.material_name, material_id: it.material_id,
            req_item_id: it.id, vendor: v.name, vendor_id: v.id,
            quantity: 0,
            purchase_unit: String(it.material_purchase_unit || it.material_unit || ''),
            unit_price: Number(ln.unit_price) || 0,
            reason: 'A vendor was selected but the Buy qty is blank or 0, so nothing was ordered for this item. Raise it on Purchase Orders if it is still needed.',
          });
        }
      }
      if (purchase > 0) {
        // Reject PO lines that are missing the data required to actually buy
        // the item. We refuse zero-rate POs (would distort weighted-avg cost
        // when received) and vendor-less POs (no one to send the document to).
        //
        // THESE TWO STAY A 400 (nothing is written), UNLIKE THE MAPPING RULE
        // BELOW WHICH DROPS THE LINE. The difference is who can fix it and
        // where: a missing price or vendor is fixable in the very modal the
        // request came from, so refusing keeps the whole gesture — issue
        // included — replayable after one correction. An unmapped pair is NOT
        // fixable there (it needs /vendors/materials), so refusing would strand
        // a storekeeper mid-hand-over, which is why that one is reported
        // instead. `code` + `req_item_id` are on the body so the caller can
        // point at the offending row rather than just alert() a sentence.
        const explicitPrice = Number(ln.unit_price);
        if (!(explicitPrice > 0)) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — unit price is required and must be > 0.`,
            code: 'po_price_required',
            material: it.material_name,
            req_item_id: it.id,
          }, { status: 400 });
        }
        const vendorName = String(ln.vendor || '').trim();
        const vendorId   = ln.vendor_id || null;
        if (!vendorName && !vendorId) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — vendor is required.`,
            code: 'po_vendor_required',
            material: it.material_name,
            req_item_id: it.id,
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
            code: 'po_unit_unrecognised',
            material: it.material_name,
            req_item_id: it.id,
          }, { status: 400 });
        }
        // A caller that declares the recipe unit is converted here, so it can no
        // longer post a recipe-unit qty against a ₹/purchase-unit rate (750 ml ×
        // ₹900/BTL = a ₹675,000 line that receive then credits as 562,500 ml).
        // Exact division, no rounding up: qty × price — and the recipe quantity
        // recovered at receive (× pack_size) — are both preserved.
        const poQty   = isPack && declaredUnit === recipeUnit ? purchase / packSize      : purchase;
        const poPrice = isPack && declaredUnit === recipeUnit ? explicitPrice * packSize : explicitPrice;
        // A QUANTITY TOO SMALL TO COST ANYTHING IS NOT AN ORDER. The rate is
        // already refused at 0 above ("would distort weighted-avg cost when
        // received"), but nothing tested the other half of the same product, so
        // quantity 1e-9 @ ₹40 wrote a real PO line whose total_price rounded to
        // ₹0 — and po_note announced "raised for 1 item (₹0)". The test is on
        // the LINE TOTAL rather than on the quantity, so it is basis-independent:
        // it cannot mistake a legitimately small purchase-unit figure (0.25 kg of
        // saffron) for a paste-error, and it uses the very rounding that decides
        // what gets stored in total_price a few hundred lines below.
        if (!(Math.round(poQty * poPrice * 100) / 100 > 0)) {
          return Response.json({
            error: `Cannot raise PO for ${it.material_name} — a Buy qty of ${purchase} at ₹${explicitPrice} comes to ₹0. Enter the quantity you actually want to order.`,
            code: 'po_qty_too_small',
            material: it.material_name,
            req_item_id: it.id,
          }, { status: 400 });
        }
        poLines.push({
          req_item_id: it.id,
          material_id: it.material_id,
          material_name: it.material_name,
          quantity:   poQty,
          unit_price: poPrice,
          vendor:     vendorName,
          vendor_id:  vendorId,
          notes:      it.notes || '',
          // REPORTING ONLY — never inserted. purchase_order_items has no unit
          // column (the basis is the convention, not a stored string); this
          // rides along so a line that ends up in po_skipped_lines can say
          // "3 BTL" instead of a bare 3, which is the difference between a
          // buyer being able to re-raise it elsewhere and having to guess.
          purchase_unit: String(it.material_purchase_unit || it.material_unit || ''),
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
    //
    // THE SAME RESOLVER the mapping rule and the PO insert use, hoisted here so
    // the merge report below compares the vendor each line would actually be
    // STORED against (id first, else the master row whose name matches) rather
    // than two spellings of the same supplier.
    const lineVendorOf = vendorResolver(db);
    // WHAT A MERGE SILENTLY CHANGES, SAID OUT LOUD. mergeDuplicateLines sums the
    // quantity onto the FIRST occurrence and that line KEEPS ITS OWN vendor and
    // rate (line-dedupe.ts:105-115) — correct for a machine-assembled list, but
    // it means a second line naming a different supplier or a different price
    // is bought from somebody else at a rate nobody entered. The behaviour is
    // deliberately UNCHANGED (merging is the owner's ONE MATERIAL = ONE PO LINE
    // rule); what changes is that the collapse now appears on the response
    // instead of only in the footer total not matching the PO.
    const poMerged: {
      material: string; material_id: string;
      ordered_from: string; ordered_unit_price: number;
      folded_in_from: string; folded_in_unit_price: number;
      folded_in_quantity: number; purchase_unit: string;
      /** Whether the SURVIVING line actually reached the PO. Provisionally true
       *  here and settled after the mapping rule below — a merged line whose
       *  vendor turns out to be unmapped is dropped like any other, and a report
       *  that still said "ordered from X" would be describing a PO line that
       *  does not exist. */
      ordered: boolean;
    }[] = [];
    if (poLines.length > 1) {
      const firstOf = new Map<string, any>();
      const vendorKey = (l: any) => {
        const v = lineVendorOf(l);
        return v.status === 'known' ? `id:${v.id}` : `raw:${v.shown.toLowerCase()}`;
      };
      for (const ln of poLines) {
        const key = String(ln.material_id ?? '').trim();
        if (!key) continue;
        const first = firstOf.get(key);
        if (!first) { firstOf.set(key, ln); continue; }
        if (vendorKey(first) === vendorKey(ln) && Number(first.unit_price) === Number(ln.unit_price)) continue;
        poMerged.push({
          material: ln.material_name, material_id: key,
          ordered_from: first.vendor || first.vendor_id || '',
          ordered_unit_price: Number(first.unit_price) || 0,
          folded_in_from: ln.vendor || ln.vendor_id || '',
          folded_in_unit_price: Number(ln.unit_price) || 0,
          folded_in_quantity: Number(ln.quantity) || 0,
          purchase_unit: String(ln.purchase_unit || ''),
          ordered: true,
        });
      }
    }
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
    //
    // The rows land in the SAME `poSkipped` array as every other
    // not-ordered reason, tagged code 'unmapped_vendor' — the only code that
    // means goods are still owed, which is why the status test and the party
    // transfer below both key on that code rather than on the array's length.
    //
    // THE RESOLVER USED HERE IS THE ONE HOISTED ABOVE (lineVendorOf), the same
    // one vendorMappingError() builds internally, so the pair that is checked is
    // the pair that is stored (POST does this too, at
    // purchase-orders/route.ts:374). Every poLine already carries a vendor —
    // the loop above refuses a PO line without one — so there is no header
    // fallback to worry about here; what there IS, is a line naming vendor_id
    // X alongside the name "Y". The helper resolves ID-FIRST and would clear
    // that pair on X, while the insert below stored the typed "Y" — and
    // receive, purchases and po_vendor_bills all key on the NAME.
    if (poLines.length > 0) {
      const keep: any[] = [];
      for (const ln of poLines) {
        // ── CENTRAL-STORE RAIL GUARD — checked BEFORE the vendor mapping ─────
        // This route was the ONE path writing purchase_order_items without it.
        // Every other writer has it: api/purchase-orders/route.ts:22
        // (storeBlockedError on POST and PUT), [id]/edit-approved:170, and
        // [id]/receive at :126 and :487; so do /api/purchases, purchases/bulk,
        // purchases/opening-stock, staff-meals/items and inward-import/commit.
        //
        // A liquor / TGBCL material belongs to the STORE rail
        // (store_stock_ledger via Inventory → Liquor Store), never to a Central
        // Store PO. Raising one here produced a document that is born broken:
        // receive/route.ts refuses every store-mapped line, so the PO sits
        // 'pending' in the admin queue, gets approved, and can then never be
        // received — an order for goods that cannot legally arrive on this rail.
        // Measured on a copy of the live db: 464 requisition lines across 77
        // materials sit in the 23 store-mapped categories, and this modal now
        // offers their mapped vendor unwarned.
        //
        // DROPPED AND REPORTED, NOT 400 — the same reasoning the mapping rule
        // spells out below. The storekeeper is standing at the counter holding
        // the department's stock; the PO is a side-effect of issuing, and a
        // rail he cannot change from this screen must not cost him the
        // hand-over. Tagged 'store_mapped', which — like 'unmapped_vendor' —
        // still OWES the goods, so it holds the requisition open and blocks the
        // party transfer. The issue side is unaffected either way:
        // applyIssueDelta already skips these with skip_reason 'store_mapped'.
        const railBlock = centralFlowBlock(db, String(ln.material_id || ''));
        if (railBlock) {
          poSkipped.push({
            code:        'store_mapped',
            material:    ln.material_name,
            material_id: String(ln.material_id || ''),
            req_item_id: String(ln.req_item_id || ''),
            vendor:      ln.vendor || ln.vendor_id || '',
            vendor_id:   ln.vendor_id || null,
            quantity:    Number(ln.quantity) || 0,
            purchase_unit: String(ln.purchase_unit || ''),
            unit_price:  Number(ln.unit_price) || 0,
            reason:      railBlock,
          });
          continue;
        }
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
            code:        'unmapped_vendor',
            material:    ln.material_name,
            material_id: String(ln.material_id || ''),
            req_item_id: String(ln.req_item_id || ''),
            vendor:      ln.vendor || ln.vendor_id || '',
            vendor_id:   ln.vendor_id || null,
            // PURCHASE basis, the same numbers the PO line would have carried —
            // so a buyer re-raising this on /purchase-orders retypes what was
            // meant, not an approximation of it.
            quantity:    Number(ln.quantity) || 0,
            purchase_unit: String(ln.purchase_unit || ''),
            unit_price:  Number(ln.unit_price) || 0,
            reason:      why.replace(/^Line\s+1:\s*/, ''),
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

    // A MERGE REPORT MUST NOT CLAIM AN ORDER THAT NEVER HAPPENED. poMerged is
    // built ABOVE the mapping rule because that is the last point where both
    // occurrences are still in hand; the survivor can still be dropped after it.
    // Nothing is lost when that happens — the skip row names the material and
    // carries the SUMMED quantity — but the sentence has to say which of the two
    // things occurred, or a storekeeper is sent to check a PO line that was
    // never written.
    if (poMerged.length > 0) {
      const orderedMaterialIds = new Set(poLines.map(l => String(l.material_id ?? '').trim()));
      for (const m of poMerged) m.ordered = orderedMaterialIds.has(m.material_id);
    }

    // THE PO BELONGS TO THE REQUISITION'S OUTLET, NOT THE OPERATOR'S SESSION.
    // /api/purchase-orders scopes its list and its approval queue with
    // `po.outlet_id = ?`, so a PO raised for a Branch 2 requisition while the
    // storekeeper's session pointed at Main was written to Main and never
    // appeared in the queue that owns the requisition it links to — approvable
    // by the wrong outlet, invisible to the right one. Measured on a copy of the
    // live db: a Branch 2 requisition produced a PO with outlet_id = Main.
    // COALESCE, not a replacement: 5 requisitions carry no outlet_id at all and
    // must keep falling back to the session's outlet exactly as before. Every
    // requisition that HAS one today is on Main, so this changes nothing live —
    // it stops the second outlet from being wrong the day it is used.
    const sessionOutletId = await getCurrentOutletId();
    const outletId = r.outlet_id || sessionOutletId;
    const result: any = {};
    /** Lines that were genuinely dropped from a PO the caller asked for — the
     *  only skip kinds that leave goods outstanding. 'store_mapped' joins
     *  'unmapped_vendor' here: both wanted goods, neither got a PO line, and in
     *  both cases the purchase still has to be raised somewhere else (Vendor
     *  Items then Purchase Orders / the Liquor Store inward). 'no_quantity',
     *  'chef_rejected' and 'po_not_requested' are reported but owe nothing, so
     *  they must NOT hold a requisition open or block the party transfer (both
     *  keyed on this). */
    const poDropped = poSkipped.filter(s => s.code === 'unmapped_vendor' || s.code === 'store_mapped');
    if (poSkipped.length > 0) {
      // The store user is TOLD, in the same response that confirms the issue.
      // Machine-readable rows AND one sentence a person can act on, because the
      // difference between "the PO is short a line" and "no PO was raised at
      // all" is the difference between two follow-up actions.
      result.po_skipped_lines = poSkipped;
      // The reason clause is now PER LINE, not a blanket "because the vendor is
      // not mapped": with three codes in one list, one shared clause would put
      // the wrong explanation on two thirds of the rows. Each row's own
      // sentence (verbatim from vendorMappingError for the mapping case) is the
      // only text that can be trusted to describe it.
      const headline = poLines.length > 0
        ? `${poSkipped.length} purchase line${poSkipped.length === 1 ? ' was' : 's were'} NOT ordered`
        // "did not reach one", not "could not go on one": with four codes in the
        // list the sentence has to be true for a chef-rejected line and for a
        // request that never asked for a PO, neither of which was refused BY the
        // purchase order.
        : `No purchase order was raised: ${poSkipped.length === 1 ? 'the only purchase line' : `all ${poSkipped.length} purchase lines`} asked for did not reach one`;
      // Only the mapping drops keep their quantity on the requisition (the
      // UPDATE below writes it from `ln`), and only they have Vendor Items as
      // the way out — so only they get that remedy sentence. Without a drop the
      // clause stays NEUTRAL and the per-line reason carries the follow-up:
      // "raise it on Purchase Orders" is right for a forgotten Buy qty and
      // wrong for a chef-rejected line, and one shared sentence cannot be both.
      // Two dropped kinds now, and they do NOT share a way out: an unmapped pair
      // is fixed on Vendor Items and then raised on Purchase Orders, while a
      // store-mapped material can never go on a Central PO at all and has to be
      // bought through the Liquor Store. Naming only one of them would send half
      // the drops to a screen that cannot help them, so the shared clause states
      // the part that IS common (issue recorded, quantity preserved) and each
      // row's own reason — verbatim from vendorMappingError / centralFlowBlock —
      // carries its own remedy.
      const remedy = poDropped.length > 0
        ? poDropped.every(s => s.code === 'unmapped_vendor')
          ? ` The issue is recorded and the quantity is still on the requisition — fix the mapping on Vendor Items, then raise the PO on Purchase Orders.`
          : ` The issue is recorded and the quantity is still on the requisition — see each line below for where to raise it.`
        : ` The issue is recorded.`;
      result.po_skipped_note =
        `${headline}.${remedy} ` +
        poSkipped.map(s => `${s.material}${s.vendor ? ` (${s.vendor})` : ''}: ${s.reason}`).join(' ');
    }
    if (poMerged.length > 0) {
      result.po_merged_lines = poMerged;
      result.po_merged_note =
        `One item was requested on more than one line at a different vendor or rate. A purchase order carries ` +
        `ONE line per item, so the quantities were combined onto the first line's terms: ` +
        poMerged.map(m => m.ordered
          ? `${m.material} — ordered from ${m.ordered_from || 'the first line\'s vendor'} at ₹${m.ordered_unit_price}` +
            `/${m.purchase_unit || 'unit'}; the ${m.folded_in_quantity} ${m.purchase_unit || ''} asked from ` +
            `${m.folded_in_from || 'another vendor'} at ₹${m.folded_in_unit_price} was added to it, not ordered separately.`
          : `${m.material} — the ${m.folded_in_quantity} ${m.purchase_unit || ''} asked from ` +
            `${m.folded_in_from || 'another vendor'} at ₹${m.folded_in_unit_price} was combined onto the ` +
            `${m.ordered_from || 'first line\'s'} vendor line, and that combined line was NOT ordered — it is in the ` +
            `not-ordered list above, at the combined quantity.`).join(' ') +
        (poMerged.some(m => m.ordered) ? ` Check the PO before approving it.` : '');
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
      // This route itself writes NOTHING to raw_materials.current_stock or
      // inventory_transactions BY HAND — every stock movement is delegated to
      // applyIssueDelta() below, which is the single writer. That helper is NOT
      // a no-op: see the header of this file. The old claim here, that it stays
      // inert until settings key `requisition_deduct_at_issue` flips to '1', is
      // dead — nothing reads that key any more (src/lib/issue-stock.ts:12) — and
      // an issue processed through this route really does debit central stock.
      const updReqItem = db.prepare(`
        UPDATE requisition_items
        SET quantity_issued = ?, quantity_to_purchase = ?
        WHERE id = ?
      `);
      // THE NON-PO WRITE LEAVES quantity_to_purchase ALONE. The PO-line loop
      // above already states the contract — "quantity_to_purchase is ONLY
      // honoured when caller opted into auto-PO. Otherwise we IGNORE it" — but
      // the single UPDATE ignored it by writing 0 over whatever was there,
      // which is not ignoring, it is erasing. What it erased is exactly the
      // record the unmapped-vendor path promises to preserve ("the quantity is
      // still on the requisition"), plus whatever requisitions-import wrote at
      // ingest. A plain issue is a statement about goods handed over; it says
      // nothing about what still needs buying, so it must not answer that
      // question. Clearing stays possible where it is a real decision — inside
      // PO mode, by submitting the line with a Buy qty of 0.
      const updIssuedOnly = db.prepare(`
        UPDATE requisition_items
        SET quantity_issued = ?
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
        // `!it.is_rejected` on the purchase half only. The ISSUE half stays
        // unfiltered and absolute on purpose (see the note below — a rejected
        // line that held 5 must still credit 5 back), but writing
        // quantity_to_purchase for a rejected line records a purchase intent
        // this very request has just refused and reported as 'chef_rejected'.
        // The row would then read "buy 9" for an item no PO can ever carry.
        // updIssuedOnly leaves the column exactly as it found it.
        if (autoCreatePo && !it.is_rejected) updReqItem.run(issued, toLineBasis(it, ln, purchase), it.id);
        else                                 updIssuedOnly.run(issued, it.id);
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
          // BOTH halves are purchase-basis by construction, ~320 lines up in the
          // shortfall loop: `quantity: poQty` and `unit_price: poPrice`, where
          // poQty/poPrice are `purchase`/`explicitPrice` already ÷ / × packSize
          // whenever the caller declared po_entry_unit as the RECIPE unit (the
          // `isPack && declaredUnit === recipeUnit` pair). Omitted po_entry_unit
          // means the caller posted purchase basis — what the requisition modal
          // does, converting before it submits. mergeDuplicateLines only sums
          // quantities of the same material, so it cannot change a basis. This is
          // exactly the row purchase_order_items requires.
          // rate-basis: purchase   (₹/purchase-unit × purchase units)
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
        // ROUND THE SUM, NOT ONLY THE PARTS. Each lineTotal is already 2-dp, but
        // adding 2-dp floats re-introduces the error they were rounded away from:
        // ₹1234.56 + ₹0.12 landed in this column as 1234.6799999999998 and went
        // straight into po_note as "(₹1234.6799999999998)". total_cost is a money
        // column read by the PO list, the approval queue and the print.
        total = Math.round(total * 100) / 100;
        db.prepare(`UPDATE purchase_orders SET total_cost = ? WHERE id = ?`).run(total, linkedPoId);
        result.linked_po_id = linkedPoId;
        result.linked_po_number = poNumber;
        // The two facts a caller needs to CONFIRM the purchase side rather than
        // guess at it. Without them the only PO-shaped field on a success
        // response was an id, and every shipped caller printed "raise a vendor
        // PO on the Purchase Orders page" over the top of a PO it had just
        // raised.
        result.po_line_count = poLines.length;
        result.po_total_cost = total;
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
      //
      // poDropped, NOT poSkipped: a line reported as 'no_quantity' (a vendor
      // picked with an empty Buy box) or 'chef_rejected' orders nothing and
      // owes nothing, so counting it here would hold a fully-issued requisition
      // open in the store queue forever over a stray dropdown click.
      const finalStatus = (linkedPoId || poDropped.length > 0 || !allDone) ? 'store_processed' : 'fulfilled';
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
      // Same poDropped/poSkipped distinction as finalStatus above: only a line
      // that WOULD have been ordered and was not still counts as outstanding.
      if (!linkedPoId && poDropped.length === 0 && r.purpose === 'party') {
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

    // ── ONE SENTENCE THAT IS TRUE IN EVERY DIRECTION ────────────────────────
    // Built AFTER the transaction because only then is the PO number real.
    // Every shipped caller had exactly two branches — po_skipped_note, or a
    // hardcoded "raise a vendor PO on the Purchase Orders page" — so a
    // storekeeper who had just raised PO-2026-0025 was told to go and raise a
    // PO, which is most of what "raise PO to vendor is not functioning" looks
    // like from the counter. po_skipped_note / po_merged_note are unchanged and
    // still stand on their own; this is the summary line that is ALWAYS present
    // when the caller asked for a PO, so a caller can print this one field and
    // never be wrong.
    // `|| result.po_skipped_note` so the plain-issue path is covered too: a
    // payload that stated a purchase intent without asking for a PO reports it
    // through the same field, and a caller that prints po_note is right on every
    // path rather than on the PO one only.
    if (autoCreatePo || result.po_skipped_note) {
      const parts: string[] = [];
      if (result.linked_po_number) {
        const n = result.po_line_count;
        parts.push(
          // toFixed(2), not the raw number: this sentence is printed verbatim by
          // the caller, and a money figure is the last place a float artefact
          // should surface.
          `Purchase order ${result.linked_po_number} raised for ${n} item${n === 1 ? '' : 's'} ` +
          `(₹${Number(result.po_total_cost).toFixed(2)}) — it is PENDING ADMIN APPROVAL on Purchase Orders.`,
        );
      } else if (poSkipped.length === 0) {
        // Ticking the box and buying nothing is legitimate (issue-only), but it
        // must not read as "the PO went through".
        parts.push('No vendor PO was raised — no line had a Buy quantity.');
      }
      if (result.po_skipped_note) parts.push(result.po_skipped_note);
      if (result.po_merged_note)  parts.push(result.po_merged_note);
      result.po_note = parts.join(' ');
    }

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
