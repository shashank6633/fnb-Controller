import { getDb, generateId, updateMaterialPrice, logAuditEvent } from '@/lib/db';
import { poWriteGate } from '@/lib/po-helpers';
import { getCurrentUser } from '@/lib/auth';
import { centralFlowBlock, isStoreMappedMaterial } from '@/lib/store-engine';
import { checkPurchaseDate } from '@/lib/purchase-guard';
import { todayIST } from '@/lib/format-date';
import {
  allocateBillCharges, r2, MIN_NET_RATE, NON_ADMIN_DISCOUNT_CAP_PCT,
  type AllocatedLine,
} from '@/lib/po-charges';
import { resolveQcRequirement, undecidedQcCategories, storePreRejectBlock, QC_AWAITING } from '@/lib/grn-qc';
import { notifyGrnAwaitingQc } from '@/lib/grn-qc-notify';
import { fulfilRequisitionFromPo } from '@/lib/po-requisition-fulfil';
import { receivedPoItemIds, poReceiptLines, liveValueSql } from '@/lib/po-receipts';
// "Is there a bill number here?" is ONE definition, shared with the receive
// modal — see the header of @/lib/bill-no. `.trim()` alone said yes to a zero
// width space, and both halves of the gate said yes together.
import { normalizeBillNo } from '@/lib/bill-no';

/* ══════════════════════════════════════════════════════════════════════════
 * ONE PO, MANY VENDORS, ONE BILL EACH.
 *
 * A PO here is an internal approval/costing document, not a sheet sent to a
 * vendor, so one PO legitimately spans several vendors (the composer requires a
 * vendor on every LINE and writes "Mixed (N vendors)" on the header). Each of
 * those vendors turns up separately, on their own day, with their own invoice.
 * Receiving is therefore PER VENDOR: their bill number, their bill date, their
 * lines, their charges. A single bill number stretched across three vendors'
 * goods is wrong on its face and misfiles every rupee of it.
 *
 * WHAT COUNTS AS "ALREADY RECEIVED" — there is no per-line received flag on
 * purchase_order_items (and no column may be added), so the receipt ledger is
 * DERIVED: a PO line is received iff a goods_receipt_note_items row carries its
 * po_item_id under a GRN whose po_id is this PO. That is sound because
 * /api/grn writes po_id = NULL and po_item_id = NULL on every ad-hoc GRN — this
 * route is the only writer of PO-linked GRN lines.
 *   ...AND A VOIDED GRN NO LONGER CLAIMS ITS LINE. A voided receipt keeps its
 *   goods_receipt_note_items rows — it must, they ARE the bill — so an
 *   unfiltered ledger would leave the PO unreceivable for ever. The derivation
 *   now lives in src/lib/po-receipts.ts (receivedPoItemIds), the ONE place that
 *   states it, and it filters status = 'void'. It does NOT filter
 *   'awaiting_qc': a GRN held for a kitchen quality check HAS claimed its line
 *   (the goods and the bill exist; only the stock move is deferred), and
 *   un-claiming it would let the same delivery be received a second time.
 *
 * THE STATUS RULE (exactly, and it is the whole of it):
 *   A PO leaves 'approved' for 'received' only when EVERY RECEIVABLE line of
 *   the PO has a GRN row against it. "Receivable" excludes store-mapped
 *   (liquor) lines, which centralFlowBlock refuses on every path and which can
 *   therefore never arrive here — waiting on them would hold the PO open
 *   forever. Until then the PO STAYS 'approved' and stays receivable, which is
 *   what keeps Friday's vendor able to deliver against it.
 *   received_at is likewise stamped only on completion; each vendor's own
 *   delivery date lives on that vendor's GRN and po_vendor_bills row.
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The vendor a PO line is filed under.
 *
 * BYTE-IDENTICAL to the expression that has always been written into
 * `purchases.vendor` at receive time (`(it.vendor && trim) || po.vendor || ''`),
 * and used for BOTH the grouping and that insert, deliberately: if the two ever
 * disagreed a line could be received under vendor A's bill and booked against
 * vendor B. A legacy PO whose lines carry no vendor collapses to the header
 * vendor, i.e. exactly one group — such a PO behaves precisely as it does today.
 */
const lineVendorName = (it: any, po: any): string =>
  (it.vendor && String(it.vendor).trim()) || po.vendor || '';
/** Case/space-insensitive identity for a vendor group; the display name is kept separately. */
const vendorKeyOf = (name: string): string => String(name || '').trim().toLowerCase();

// receivedPoItemIds — THE receipt ledger — now lives in src/lib/po-receipts.ts,
// imported above. It was module-local here and copied, unfiltered, into five
// other queries across three files; that duplication is what made a voided
// PO receipt impossible to undo. Do not re-inline it.

interface VendorGroup {
  key: string;
  vendor_name: string;
  vendor_id: string | null;
  lines: any[];
}

/** Group PO lines by their filing vendor, preserving first-seen order. */
function groupByVendor(lines: any[], po: any): VendorGroup[] {
  const out: VendorGroup[] = [];
  const byKey = new Map<string, VendorGroup>();
  for (const it of lines) {
    const name = lineVendorName(it, po);
    const key = vendorKeyOf(name);
    let g = byKey.get(key);
    if (!g) {
      g = { key, vendor_name: name, vendor_id: null, lines: [] };
      byKey.set(key, g);
      out.push(g);
    }
    // First line that actually carries a vendor_id decides the FK. A group is
    // one vendor by name, so any of its ids is that vendor's id.
    if (!g.vendor_id && it.vendor_id) g.vendor_id = String(it.vendor_id);
    g.lines.push(it);
  }
  return out;
}

/**
 * GET /api/purchase-orders/:id/receive
 * The receive screen's view of WHO still owes goods on this PO.
 *
 * Purely additive and read-only. It exists because /api/purchase-orders?id=
 * folds in received figures from `purchase_orders.grn_id` — ONE GRN — which
 * cannot describe a PO that now carries one GRN per vendor. Rather than change
 * that endpoint's shape, the receive screen asks the receive route itself.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    // Same gate as the POST: this lists vendor bill numbers and what is still
    // owed, which is the receiver's screen, not a general read.
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can receive POs' }, { status: 403 });
    const db = getDb();
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });

    const items = db.prepare(`
      SELECT poi.id, poi.material_id, poi.quantity, poi.unit_price, poi.vendor, poi.vendor_id,
             rm.name AS material_name
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
    `).all(id) as any[];

    const blocked = new Map<string, string>();
    for (const it of items) {
      const msg = centralFlowBlock(db, String(it.material_id || ''));
      if (msg) blocked.set(String(it.id), msg);
    }
    const done = receivedPoItemIds(db, id);

    // Which GRN each received line came in on — the `grn_numbers` badge below.
    // Same ledger as `done` above, from the same helper: a copy of this query
    // that filtered differently would badge a line as delivered on a bill the
    // outstanding list says is still owed.
    const grnByItem = new Map<string, any>();
    for (const r of poReceiptLines(db, id)) grnByItem.set(String(r.po_item_id), r);

    const bills = db.prepare(`
      SELECT id, vendor_id, vendor_name, bill_no, bill_date, received_by, notes, created_at
      FROM po_vendor_bills WHERE po_id = ? ORDER BY created_at, id
    `).all(id) as any[];
    const billsByVendor = new Map<string, any[]>();
    for (const b of bills) {
      const k = vendorKeyOf(b.vendor_name);
      if (!billsByVendor.has(k)) billsByVendor.set(k, []);
      billsByVendor.get(k)!.push(b);
    }

    const groups = groupByVendor(items, po).map(g => {
      const receivable = g.lines.filter(l => !blocked.has(String(l.id)));
      const outstanding = receivable.filter(l => !done.has(String(l.id)));
      const receivedLines = receivable.filter(l => done.has(String(l.id)));
      return {
        key: g.key,
        vendor_name: g.vendor_name,
        vendor_id: g.vendor_id,
        line_ids:          outstanding.map(l => String(l.id)),
        received_line_ids: receivedLines.map(l => String(l.id)),
        blocked_line_ids:  g.lines.filter(l => blocked.has(String(l.id))).map(l => String(l.id)),
        // `outstanding` narrows `items`, the purchase_order_items rows selected
        // at the top of this GET, so quantity is PURCHASE units and unit_price
        // is Rs/purchase-unit by canon. Both halves come off the same row; no
        // pack conversion belongs here, and the figure is what this vendor's
        // invoice must reconcile to.
        // rate-basis: purchase (purchase_order_items.quantity x .unit_price)
        ordered_value: r2(outstanding.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0)),
        // "Nothing left for this vendor to deliver" — either it all came in, or
        // everything they had on this PO is store-mapped and never can.
        done: outstanding.length === 0,
        grn_numbers: [...new Set(receivedLines.map(l => grnByItem.get(String(l.id))?.grn_number).filter(Boolean))],
        bills: billsByVendor.get(g.key) || [],
      };
    });

    return Response.json({
      po: {
        id: po.id, po_number: po.po_number, status: po.status,
        vendor: po.vendor, received_at: po.received_at, grn_id: po.grn_id,
      },
      vendors: groups,
      multi_vendor: groups.length > 1,
      outstanding_lines: groups.reduce((s, g) => s + g.line_ids.length, 0),
      received_lines: groups.reduce((s, g) => s + g.received_line_ids.length, 0),
      store_blocked: [...blocked.entries()].map(([lineId, error]) => {
        const it = items.find(i => String(i.id) === lineId);
        return { po_item_id: lineId, material_id: it?.material_id, material_name: it?.material_name, error };
      }),
    });
  } catch (e: any) {
    console.error('[receive PO GET]', e);
    return Response.json({ error: e.message }, { status: 500 });
  }
}

/**
 * Mark an approved PO as Received.
 * Side effects (atomic):
 *   1. Insert one row into `purchases` per PO line (so weighted-avg + history works).
 *   2. Bump raw_materials.current_stock by quantity.
 *   3. Update raw_materials.last_purchase_price + last_purchase_date.
 *   4. Run updateMaterialPrice → recomputes average_price + cascades recipe / sub-recipe costs.
 *   5. Insert inventory_transactions.
 *
 * Optional body: { received_at?, item_overrides?: [{po_item_id, quantity?, unit_price?,
 *                   accepted?, rejection_reason?, deviation_reason?,
 *                   gst_rate?, cgst?, sgst?}] }
 *   — lets the receiver record short/over-shipments before commit.
 *   `rejection_reason` stays QC-only (why some units were REJECTED).
 *   `deviation_reason` is the separate "why does this line differ from the PO":
 *   REQUIRED whenever ANY of the three axes moves off the approved PO line —
 *   received qty ≠ ordered qty, accepted qty ≠ ordered qty (a full delivery
 *   part-rejected at QC counts), or the rate ≠ the ordered rate.
 *   It is stored on the GRN line + the purchases row and alerted to the admin.
 *
 *   THE RATE IS EDITABLE BY ANYONE PERMITTED TO RECEIVE (owner ruling).
 *   It used to be a hard admin-only 403 on this route (see the removed lock in
 *   the per-line loop below). The bill the vendor hands over at the gate IS the
 *   price; the PO rate was an estimate, and requiring an admin to stand next to
 *   the storekeeper did not make the number truer — it just stopped the goods.
 *   What replaces the stoppage is VISIBILITY, and none of it was relaxed: an
 *   off-rate line still cannot commit without a `deviation_reason` (the gate
 *   below, 400), and it still raises the audit event + notification + Slack ping
 *   to the admin with that reason quoted. The bill-discount cap
 *   (NON_ADMIN_DISCOUNT_CAP_PCT) is a DIFFERENT control and is untouched.
 *
 *   `gst_rate` is the line's GST PERCENT (0 | 5 | 12 | 18 …); 0/absent = no tax
 *   recorded. `cgst`/`sgst` may be sent (the modal computes them to show the
 *   split before saving) but are NEVER trusted — the server re-derives both from
 *   THIS route's own accepted value and discount share, with the identical
 *   integer-paise rounding /api/purchases uses, and stores what it computed.
 *   TAX NEVER ENTERS unit_price / total_price / average_price on either the GRN
 *   line or the purchases row: GST on a purchase is reclaimable input credit,
 *   not food cost. It is recorded in goods_receipt_note_items.cgst/.sgst, which
 *   readers add back (Total Inward = value − discount + cgst + sgst + …).
 *   A payload with no gst_rate writes precisely the row it wrote before this
 *   field existed.
 *
 * Optional body: { line_ids? }
 *   — a SUBSET of that vendor's outstanding lines, when they split the delivery
 *   across two bills. Omitted = all of them. Lines left out stay outstanding and
 *   keep the PO open, which is the honest record of "coming on the next bill" —
 *   receiving them at qty 0 instead would book them as received-and-short.
 *
 * Optional body: { vendor_key? }
 *   — WHICH VENDOR is delivering. Receiving is per vendor (see the block at the
 *   top of this file): only that vendor's outstanding lines are received, only
 *   their lines carry their bill's charges, and the PO stays 'approved' until
 *   every vendor's lines are in. Omitted on a single-vendor PO (there is only
 *   one group, so it is unambiguous); REQUIRED once the outstanding lines span
 *   more than one vendor, because a bill number stretched across two vendors is
 *   filed against goods that vendor never supplied.
 *
 * Optional body: { bill_charges?: { discount_amount?, delivery_amount?,
 *                   charges_note?, bill_no?, bill_date? } }
 *   — ONE bill-level figure for each, in RUPEES (a By-% entry is resolved to ₹ on
 *   the client; this route only ever takes an amount). These belong to ONE
 *   vendor's bill and are allocated ONLY across THAT vendor's accepted lines —
 *   never spread over the whole PO. `bill_no` + `bill_date` are recorded as a
 *   po_vendor_bills row for the vendor; UNIQUE(po_id, vendor_name, bill_no) is
 *   the duplicate guard and its violation comes back as a friendly 409.
 *   Allocated across the accepted lines by src/lib/po-charges. The two rulings
 *   it encodes:
 *     DISCOUNT REDUCES COST — netted into purchases.unit_price, because that is
 *       the only column updateMaterialPrice() averages. purchases.discount stays
 *       0 on this path so the discount can never be subtracted twice.
 *     DELIVERY IS RECORDED ONLY — stored per line, never touches a rate/average.
 *   `charges_note` is REQUIRED once a discount is entered; a discount above
 *   NON_ADMIN_DISCOUNT_CAP_PCT% of the accepted bill is ADMIN-ONLY (403).
 *   Neither figure may be negative — a vendor credit note is not a negative
 *   discount and does not belong on the receive path.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = getDb();
    // Receiving is a PO WRITE action and the irreversible one: it bumps stock,
    // writes purchases rows and rewrites average_price across every recipe.
    // currentRole() could NOT gate it — it collapses 'staff' → 'manager', so a
    // truthiness check on it only meant "has a session" and any signed-in
    // captain could fire this. poWriteGate() tests the real membership; there is
    // still no fail-open to admin when the session is missing.
    const gate = await poWriteGate();
    if (gate === 'anon') return Response.json({ error: 'Sign in required' }, { status: 401 });
    if (gate === 'denied') return Response.json({ error: 'Only Management or the store manager can receive POs' }, { status: 403 });
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as any;
    if (!po) return Response.json({ error: 'Not found' }, { status: 404 });
    if (po.status !== 'approved') {
      return Response.json({ error: `Only approved POs can be received (current: ${po.status})` }, { status: 400 });
    }

    const body = await req.json().catch(() => ({}));
    // Use IST "today" for the day boundary (matches todayIST() used by the
    // backdate guard) instead of UTC new Date() — otherwise a receive near
    // midnight IST could resolve to the wrong calendar day.
    const receivedAt = (body?.received_at as string) || todayIST();
    const me = await getCurrentUser();
    const receivedByEmail = me?.email || '';
    // Backdate guard — a PO-receive writes received_at into both the GRN date
    // and every purchases row it creates, so a user-supplied received_at must
    // pass the same configurable window as /api/grn and /api/purchases. Admins
    // (me.role === 'admin' — the REAL tier off the session) are fully exempt.
    const dateCheck = checkPurchaseDate(db, receivedAt, me?.role === 'admin');
    if (!dateCheck.ok) return Response.json({ error: dateCheck.error }, { status: 400 });
    // Per-line overrides now support accept/reject for QC at the receiving bay,
    // plus deviation_reason — the mandatory "why is this line not what the PO
    // says" (see the deviation gate below). It is DISTINCT from
    // rejection_reason: that one only explains rejected units.
    // gst_rate/cgst/sgst ride along per line. cgst/sgst are carried ONLY so a
    // client that disagrees with the server can be logged (same as
    // /api/purchases) — the stored figures are always the server's own.
    // cess_rate is the GST COMPENSATION CESS percent for the line, seeded on the
    // receive screen from raw_materials.cess_percent. Only the PERCENT rides the
    // wire: unlike cgst/sgst there is no legacy client posting a rupee figure, so
    // a `compensation_cess` in the body is deliberately NOT read here and cannot
    // write money this line's goods value can't justify (same stance as
    // /api/purchases:310-312).
    const overrides: Map<string, { quantity?: number; unit_price?: number; accepted?: number; rejection_reason?: string; deviation_reason?: string; gst_rate?: any; cgst?: any; sgst?: any; cess_rate?: any }> = new Map();
    if (Array.isArray(body?.item_overrides)) {
      for (const o of body.item_overrides) {
        if (o?.po_item_id) overrides.set(o.po_item_id, {
          quantity: o.quantity, unit_price: o.unit_price,
          accepted: o.accepted, rejection_reason: o.rejection_reason,
          deviation_reason: o.deviation_reason,
          gst_rate: o.gst_rate, cgst: o.cgst, sgst: o.sgst,
          cess_rate: o.cess_rate,
        });
      }
    }
    /**
     * Was a usable gst_rate sent for this line?
     * ABSENT means exactly what it meant before this field existed — no tax
     * recorded, nothing else changed — because older clients (and any script
     * that posts a receive) send no gst_rate at all. Byte-identical test to
     * /api/purchases' `gstProvided`, so the two purchase paths agree on what
     * "no tax" is.
     */
    const gstProvidedFor = (ov: any): boolean =>
      ov?.gst_rate !== undefined && ov?.gst_rate !== null && String(ov.gst_rate).trim() !== '';
    /**
     * Was a usable cess_rate sent for this line?
     * Byte-identical in shape to gstProvidedFor above, and for the same reason:
     * ABSENT means "no compensation cess recorded, nothing else changed", which
     * is exactly what every client that predates this field sends. A line with
     * no cess_rate must write the GRN row this route wrote before the field
     * existed — a rate is never inferred, and 0 is never assumed to be a rate.
     */
    const cessProvidedFor = (ov: any): boolean =>
      ov?.cess_rate !== undefined && ov?.cess_rate !== null && String(ov.cess_rate).trim() !== '';

    // ── Bill-level charges (shape only — the money gates need the accepted
    // lines and run after the per-line validation below) ──────────────────
    // Both figures arrive in RUPEES. A By-% entry is resolved against the bill
    // on the client (resolveCharge in po-charges), so a percentage never
    // reaches the server and there is exactly one thing to validate here.
    const billCharges = (body?.bill_charges && typeof body.bill_charges === 'object') ? body.bill_charges : {};
    const chargeAmounts: Record<string, number> = { discount_amount: 0, delivery_amount: 0 };
    for (const [field, label] of [
      ['discount_amount', 'discount'],
      ['delivery_amount', 'delivery charge'],
    ] as Array<[string, string]>) {
      const raw = (billCharges as any)[field];
      const n = (raw == null || raw === '') ? 0 : Number(raw);
      if (!Number.isFinite(n)) {
        return Response.json({
          error: `The bill ${label} must be a ₹ amount — received "${raw}".`,
          field,
        }, { status: 400 });
      }
      // Negatives are refused rather than inverted. A vendor CREDIT NOTE is not
      // a negative discount: it lands after the bill, often against a different
      // GRN, and netting it into unit_price here would silently inflate
      // average_price on goods that were never re-priced. Out of scope.
      if (n < 0) {
        return Response.json({
          error: `The bill ${label} cannot be negative (₹${n}). A vendor credit note is not a negative ${label} — it cannot be recorded from the receive screen.`,
          field,
        }, { status: 400 });
      }
      chargeAmounts[field] = r2(n);
    }
    /* A PERCENTAGE IS RESOLVED HERE, NOT ON THE CLIENT.
     * The modal previews the bill over every PO line, but this route allocates
     * only over `receivable` — store-mapped (liquor) lines are dropped by
     * centralFlowBlock. On a mixed PO the two bases differ, so a client-resolved
     * "5%" arrived as a rupee figure that was a much larger share of what is
     * actually booked (₹5,000 of a ₹100,000 preview landing on a ₹50,000 base =
     * a 10% cut, and average_price followed the wrong number). When the client
     * sends the MODE + VALUE we re-resolve against this route's own subtotal,
     * which is by definition the base the money is booked on. The resolved
     * amount is still accepted for older clients and for By-Amount entry. */
    const chargeMode = (f: 'discount' | 'delivery'): 'pct' | 'amt' =>
      String((billCharges as any)[`${f}_mode`] || '').toLowerCase() === 'pct' ? 'pct' : 'amt';
    const chargePctValue = (f: 'discount' | 'delivery'): number => {
      const v = Number((billCharges as any)[`${f}_value`]);
      return Number.isFinite(v) && v > 0 ? v : 0;
    };
    let chargeDiscount = chargeAmounts.discount_amount;
    let chargeDelivery = chargeAmounts.delivery_amount;
    const chargesNote    = String((billCharges as any).charges_note || '').trim();
    // normalizeBillNo, NOT .trim(): the trim on its own accepted a zero width
    // space, a word joiner, an LTR mark, a soft hyphen, a Hangul filler and a
    // braille blank — six values that store fine, render as nothing everywhere,
    // and are not counted by the app's own TRIM(bill_no)='' blank query. Both
    // gates now read the same definition. (It still trims, so "   " still fails.)
    const billNo         = normalizeBillNo((billCharges as any).bill_no);
    /* ── THE VENDOR'S BILL NUMBER IS MANDATORY ON THIS ROUTE ─────────────────
     * Every one of the 15 blank `po_vendor_bills` rows in the live data came
     * through HERE — zero ad-hoc GRNs are blank, because POST /api/grn has
     * demanded the number since 5522138. This was the last door still making
     * blanks, and it made them silently: `bill_date` had its shape checked and
     * `charges_note` was conditionally required, but `bill_no` was trimmed and
     * nothing else, so a receiver who tabbed past the box booked the stock and
     * lost the only link back to the paper. The `required` attribute on the
     * input was inert (the modal has no <form> and Confirm is an onClick), so
     * the browser was not stopping it either — both halves are now closed, and
     * this half is the one that counts: /api/* routes are not behind the page
     * gate, so a direct POST must be refused here.
     *
     * normalizeBillNo above is what makes "   " fail — and what makes a
     * zero-width space fail, which a bare .trim() did not.
     *
     * NO DECLARED-BLANK ESCAPE HERE, unlike POST /api/grn. That escape works
     * there because `goods_receipt_notes` has no unique index on
     * invoice_number, so a vendor can have many declared-no-bill receipts.
     * `po_vendor_bills` DOES have one — uq_po_vendor_bill (po_id, vendor_name,
     * bill_no) — so the SECOND declared-blank delivery from one vendor on one
     * PO would hit the constraint and be told "Enter the vendor's bill number
     * to record a second delivery", advice the receiver has just declared
     * impossible. A truly paperless delivery therefore goes to the ad-hoc GRN
     * form, which already supports the declaration, and the message says so.
     *
     * NOTHING STORED CHANGES. This refuses new blanks only; the 15 existing
     * blank bill rows keep every behaviour they have — they are still read,
     * amended (PUT /api/grn/[id] only demands a number when one is SENT),
     * voided and released, and the blank arm of the 409 below stays live for
     * them. A non-blank value can never collide with a stored '' on
     * uq_po_vendor_bill, so no backfill, migration or re-index is involved. */
    if (!billNo) {
      return Response.json({
        error: `Enter the vendor's bill number before receiving ${po.po_number}. `
             + `It is the only way back to the vendor's paper once the stock line is all that is left, `
             + `and it is what the duplicate-bill check keys on. `
             + `If the truck came on a delivery challan and the invoice follows, enter the challan number. `
             + `If there is genuinely no vendor document at all — a cash market run, a sample, a donation — `
             + `record it at Purchasing → Goods Receipt (GRN), where "No vendor bill number" can be declared.`,
        field: 'bill_no',
      }, { status: 400 });
    }
    // The VENDOR'S invoice date, which is a property of their document and is
    // routinely older than the day the truck arrives — so it is NOT put through
    // checkPurchaseDate (that guards the date this receive POSTS money on, which
    // is receivedAt). Only the shape is checked; blank falls back to the receive
    // date so a bill row always carries a usable date.
    const billDateRaw = String((billCharges as any).bill_date || '').trim();
    if (billDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(billDateRaw)) {
      return Response.json({
        error: `The vendor bill date must be YYYY-MM-DD — received "${billDateRaw}".`,
        field: 'bill_date',
      }, { status: 400 });
    }
    const billDate = billDateRaw || receivedAt;
    // A discount rewrites the cost basis of stock and every recipe downstream of
    // it, so it may never land as a bare number — the admin alert below quotes
    // this note, and "why was ₹9,900 taken off this bill" is the whole question.
    if (chargeDiscount > 0 && chargesNote.length < 3) {
      return Response.json({
        error: `Reason required for the ₹${chargeDiscount} bill discount. A discount reduces the cost this delivery is booked at (and the average price of every material on it), so say why the vendor gave it — at least 3 characters; the admin is alerted with that reason.`,
        field: 'charges_note',
      }, { status: 400 });
    }

    const result: any = {};
    // Hoisted so the post-txn audit + Slack ping can read the collected lines.
    // Populated inside the txn loop when accepted qty > ordered qty.
    const excessLines: Array<{
      material_name: string;
      material_id: string;
      ordered: number;
      received: number;
      accepted: number;
      excess: number;
      unit_pu: string;         // PURCHASE unit label (never the recipe unit)
      unit_price: number;
      excess_value: number;
    }> = [];
    // Every line that came in differently from the APPROVED PO — short qty,
    // over qty, or a changed rate. Superset of excessLines (which stays keyed
    // on ACCEPTED qty because that is what actually enters stock + books).
    // Hoisted for the same reason: the post-txn admin alert reads it.
    const deviationLines: Array<{
      material_name: string;
      material_id: string;
      ordered: number;        // PO line qty — PURCHASE units
      received: number;       // PURCHASE units
      accepted: number;       // PURCHASE units
      unit_pu: string;        // PURCHASE unit label (never the recipe unit)
      ordered_rate: number;   // ₹/purchase-unit on the PO line
      actual_rate: number;    // ₹/purchase-unit actually received at
      qty_short: boolean;
      /** accepted < ordered — a full delivery part-rejected at QC still moves money. */
      acc_short: boolean;
      qty_excess: boolean;
      rate_changed: boolean;
      value_impact: number;   // ₹ (accepted × actual rate) − (ordered × ordered rate)
      reason: string;
    }> = [];
    // Tolerances for "differs from the PO". SQLite REAL is a double and JSON
    // round-trips doubles exactly, so these only stop sub-unit float noise from
    // demanding a reason — anything a receiver actually typed is far bigger.
    const QTY_EPS  = 1e-6;
    const RATE_EPS = 0.005;   // ₹ — half a paisa

    // WHICH vendor is delivering. Resolved against the PO's own groups below —
    // an unknown key is refused rather than silently receiving everything.
    const vendorKeyReq = vendorKeyOf(String(body?.vendor_key ?? body?.vendor ?? ''));

    const items = db.prepare(`
      SELECT poi.*, rm.id AS material_id, rm.name AS material_name,
             rm.unit AS material_unit, rm.purchase_unit AS material_purchase_unit,
             COALESCE(rm.pack_size, 1) AS material_pack_size
      FROM purchase_order_items poi
      JOIN raw_materials rm ON rm.id = poi.material_id
      WHERE poi.po_id = ?
    `).all(id) as any[];

    if (items.length === 0) return Response.json({ error: 'PO has no items' }, { status: 400 });

    // Phase B store guard (batch → skip + report per line): store-mapped
    // materials (liquor) on HISTORICAL POs are skipped at receive time so they
    // never bump Central stock / purchases / average_price. New POs can't even
    // contain them (create/edit reject). The PO data itself is untouched.
    const storeBlocked: { material_id: string; material_name: string; error: string }[] = [];
    const receivable = items.filter((it: any) => {
      const msg = centralFlowBlock(db, String(it.material_id || ''));
      if (msg) { storeBlocked.push({ material_id: it.material_id, material_name: it.material_name, error: msg }); return false; }
      return true;
    });
    if (receivable.length === 0) {
      return Response.json({
        error: `Nothing to receive — every line is a store-mapped material. ${storeBlocked[0]?.error || ''}`,
        store_blocked: storeBlocked,
      }, { status: 400 });
    }

    // ────────────────────────────────────────────────────────────────────
    // PER-VENDOR SCOPING. `receivable` is the whole PO's receivable set and
    // stays that way — it is what the completion test at the end of the txn
    // measures against. `receiving` is the subset THIS call actually books:
    // one vendor's still-outstanding lines.
    // ────────────────────────────────────────────────────────────────────
    const alreadyReceived = receivedPoItemIds(db, id);
    const outstanding = receivable.filter((it: any) => !alreadyReceived.has(String(it.id)));
    if (outstanding.length === 0) {
      return Response.json({
        error: `Every receivable line on ${po.po_number} has already been received. Reload the page.`,
      }, { status: 409 });
    }
    const groups = groupByVendor(outstanding, po);
    let group: VendorGroup;
    if (vendorKeyReq) {
      const found = groups.find(g => g.key === vendorKeyReq);
      if (!found) {
        // Three different facts, three different remedies — a receiver holding
        // a bill at the gate needs to be told WHICH one it is.
        const settled = groupByVendor(receivable, po).find(g => g.key === vendorKeyReq);
        const blockedOnly = !settled && groupByVendor(items, po).find(g => g.key === vendorKeyReq);
        let error: string;
        let status: number;
        if (settled) {
          error = `${settled.vendor_name}'s lines on ${po.po_number} have already been received. Reload the page.`;
          status = 409;
        } else if (blockedOnly) {
          error = `Every line ${blockedOnly.vendor_name} supplies on ${po.po_number} is a store-mapped material, which cannot be received into Central stock — procure it through Inventory → Liquor Store. ${storeBlocked[0]?.error || ''}`;
          status = 400;
        } else {
          error = `No lines on ${po.po_number} are ordered from that vendor. Vendors still to deliver: ${groups.map(g => g.vendor_name || '(no vendor)').join(', ')}.`;
          status = 400;
        }
        return Response.json({
          error, field: 'vendor_key',
          outstanding_vendors: groups.map(g => ({ key: g.key, vendor_name: g.vendor_name })),
        }, { status });
      }
      group = found;
    } else if (groups.length > 1) {
      // No vendor named and the goods still owed come from several vendors.
      // Receiving them together would file ONE bill number (and one bill's
      // discount and delivery) across goods three different vendors supplied,
      // which is precisely the defect this endpoint exists to stop. Refuse.
      return Response.json({
        error: `${po.po_number} spans ${groups.length} vendors (${groups.map(g => g.vendor_name || '(no vendor)').join(', ')}). Receive one vendor at a time — each has their own bill number, bill date and charges.`,
        field: 'vendor_key',
        outstanding_vendors: groups.map(g => ({ key: g.key, vendor_name: g.vendor_name, lines: g.lines.length })),
      }, { status: 400 });
    } else {
      // Exactly one vendor still owes goods (the single-vendor PO, and every
      // legacy PO whose lines carry no vendor at all) — unambiguous, so an
      // older client that never sends vendor_key behaves exactly as before.
      group = groups[0];
    }
    /** Does this PO span more than one vendor at all? Drives wording only. */
    const isMultiVendorPo = groupByVendor(receivable, po).length > 1;
    // OPTIONAL SUBSET WITHIN THE VENDOR. One vendor legitimately splits a PO
    // across two bills a week apart, and "arrived on a later bill" is a
    // different fact from "arrived short" — a 0-qty receive books the line as
    // received-and-short forever, so leaving it OUT has to be possible.
    // Omitted → the vendor's whole outstanding set, which is what a client that
    // never sends the field (and every single-delivery receive) means.
    let receiving = group.lines;
    const lineIdsReq: string[] = Array.isArray(body?.line_ids)
      ? [...new Set(body.line_ids.map((x: any) => String(x)))] as string[] : [];
    if (lineIdsReq.length > 0) {
      const mine = new Set(group.lines.map((l: any) => String(l.id)));
      const unknown = lineIdsReq.filter(x => !mine.has(x));
      if (unknown.length > 0) {
        return Response.json({
          error: `${unknown.length} of the lines sent are not ${group.vendor_name || '(no vendor)'}'s outstanding lines on ${po.po_number} — they belong to another vendor, are already received, or are store-mapped. Reload the page.`,
          field: 'line_ids',
        }, { status: 409 });
      }
      const want = new Set(lineIdsReq);
      receiving = group.lines.filter((l: any) => want.has(String(l.id)));
    }
    if (receiving.length === 0) {
      return Response.json({
        error: `Nothing left to receive for ${group.vendor_name || '(no vendor)'} on ${po.po_number}.`,
      }, { status: 400 });
    }

    // Unit LABEL for a PO line = the PURCHASE unit, because a PO line's qty and
    // rate are both in purchase units (canon, see the boundary note below).
    // rm.purchase_unit is selected un-COALESCEd (line 74) so fall back to the
    // recipe unit when it is NULL/blank.
    const puLabel = (it: any) =>
      String(it.material_purchase_unit || '').trim() || String(it.material_unit || '').trim();

    // ── KITCHEN QC GATE ─────────────────────────────────────────────────────
    // THE SAME DECISION, FROM THE SAME HELPER, AS /api/grn. 20 of the 29 live
    // GRNs come through this route, so a gate wired only on the ad-hoc form
    // would leave the main road open — and a gate written twice would drift.
    // src/lib/grn-qc.ts owns both the decision (resolveQcRequirement) and the
    // deferred apply (decideGrnQc); this file only branches on the boolean.
    //
    // No hasNegativeLine here: this route REFUSES negative quantities outright
    // (the sanity loop below), so a back-correction can never reach it.
    // Resolved over `receiving` — the lines THIS bill actually books. Another
    // vendor's outstanding line is not on this delivery and must not decide
    // whether this delivery is held.
    const qc = resolveQcRequirement(db, receiving.map((it: any) => String(it.material_id || '')));
    // ── AND WHICH CATEGORIES ON THIS DELIVERY HAS NOBODY EVER RULED ON? ─────
    // ADVISORY ONLY, and THIS IS THE ROUTE IT HAPPENED ON. GRN-2026-0018 came
    // through here: SUGUNA FOODS, 90 kg CHICKEN LEG BONELESS + 30 kg WHOLE BIRD,
    // category POULTRY, no row in qc_category_checkers, inwarded on the spot.
    // The gate was right — POULTRY had no rule — and nothing anywhere said so.
    //
    // Same map, same category rows, same `receiving` list as the gate one line
    // above. It changes nothing: `qc` is untouched and no branch below reads
    // this. A category explicitly set to "No check" is a DECISION and stays
    // SILENT; see undecidedQcCategories for why undecided-only is the design.
    // `qc.required` is passed READ-ONLY, so the sentence can say whether these
    // goods are on the shelf or at the bay. It is an input to the WORDING only —
    // `qc` is not reassigned here and nothing below reads qcUndecided.
    const qcUndecided = undecidedQcCategories(
      db,
      receiving.map((it: any) => String(it.material_id || '')),
      { held: !!qc.required },
    );

    // Reject negative qty / price BEFORE the txn starts.
    // Receiving is an additive workflow — stock corrections (negative qtys) live
    // on the dedicated GRN back-correction flow. A negative here would silently
    // reduce stock without the audit-trail tagging that back-corrections get.
    // Every check below runs on the EFFECTIVE per-line value (override if sent,
    // else the stored PO line) — the same resolution the txn loop uses. Checking
    // only the override payload left the stored line unvalidated, and PO lines
    // saved before lineSanityError() existed can themselves carry a bad qty/rate.
    // Scoped to `receiving` — this vendor's outstanding lines. Another vendor's
    // line is not this receiver's to justify, and one already received is not
    // theirs to re-price.
    for (const it of receiving) {
      const ov = overrides.get(it.id);
      const effRcv   = ov?.quantity   != null ? Number(ov.quantity) : Number(it.quantity);
      const effAcc   = ov?.accepted   != null ? Number(ov.accepted) : effRcv;
      const effPrice = ov?.unit_price != null ? Number(ov.unit_price) : Number(it.unit_price);
      const checks: Array<[string, number]> = [
        ['quantity',   effRcv],
        ['accepted',   effAcc],
        ['unit_price', effPrice],
      ];
      for (const [field, n] of checks) {
        if (!Number.isFinite(n) || n < 0) {
          return Response.json({
            error: `Negative or invalid ${field.replace('_', ' ')} on "${it.material_name}" (${n}). Receiving cannot go below 0 — use the GRN page's back-correction workflow for stock reversals.`,
            material: it.material_name,
            field,
          }, { status: 400 });
        }
      }
      // accepted ≤ received is an invariant of the GRN row: `rejected` is derived
      // as max(0, received - accepted), so an over-accept clamps rejected to 0 and
      // credits stock + purchases for goods the same GRN says never arrived.
      if (effAcc > effRcv) {
        return Response.json({
          error: `Accepted (${effAcc}) exceeds received (${effRcv}) on "${it.material_name}". Accepted qty can never be more than the qty received — record the extra as received first.`,
          material: it.material_name,
          field: 'accepted',
        }, { status: 400 });
      }
      // Rate guard — a 0/blank rate is accepted by the PO composer and by
      // create/approve, but receiving it writes purchases(unit_price 0) and then
      // updateMaterialPrice wipes average_price to 0, cascading a "free"
      // ingredient through every recipe. Mirrors /api/purchases' `!unit_price`
      // reject. A 0 rate is only fatal on lines that actually enter stock/books
      // (accepted > 0) — a fully-rejected line never reaches updateMaterialPrice.
      if (effAcc > 0 && effPrice <= 0) {
        // ONE remedy for everyone now. This message used to fork on role because
        // the rate lock below was a hard admin-only 403, which left a non-admin
        // holding a ₹0 PO line with no way out but "get it re-approved". The rate
        // is editable by any receiver, so the fix is the same for all of them:
        // type the rate off the vendor's bill (and say why, per the deviation
        // gate) — or fix the PO line if the bill really says ₹0.
        return Response.json({
          error: `Missing or zero rate on "${it.material_name}". A receive rewrites this material's average price, so the line needs a real ₹/${puLabel(it) || 'unit'} — enter the rate the vendor actually billed, or correct the PO line rate.`,
          material: it.material_name,
          field: 'unit_price',
        }, { status: 400 });
      }
      // GST percent — shape only, and only when the line actually sent one.
      // A PRESENT but unusable value is REFUSED rather than quietly zeroed:
      // silently dropping the tax on a bill forfeits the input credit, and
      // nothing in the stored row would ever show that it went missing. Same
      // bounds and same wording as /api/purchases.
      if (gstProvidedFor(ov)) {
        const g = Number(ov!.gst_rate);
        if (!Number.isFinite(g) || g < 0 || g > 100) {
          return Response.json({
            error: `GST on "${it.material_name}" must be a percentage between 0 and 100 (0 = exempt) — received "${ov!.gst_rate}". Send no gst_rate at all to record the line with no tax.`,
            material: it.material_name,
            field: 'gst_rate',
          }, { status: 400 });
        }
      }
      // GST COMPENSATION CESS percent — same shape check, same absent/present
      // contract, and refused rather than quietly zeroed for the same reason: a
      // dropped cess forfeits reclaimable input credit and leaves nothing in the
      // stored row to show it went missing. It is a SEPARATE levy from CGST/SGST
      // (12% on aerated drinks, tobacco at the bar), not a third slice of the GST
      // split, and not the TGBCL `special_excise_cess`, which means state excise
      // everywhere it is read and labelled. Wording mirrored from /api/purchases.
      if (cessProvidedFor(ov)) {
        const c = Number(ov!.cess_rate);
        if (!Number.isFinite(c) || c < 0 || c > 100) {
          return Response.json({
            error: `Compensation cess on "${it.material_name}" must be a percentage between 0 and 100 (0 = none) — received "${ov!.cess_rate}". Send no cess_rate at all to record the line with no compensation cess.`,
            material: it.material_name,
            field: 'cess_rate',
          }, { status: 400 });
        }
      }
      // ── THE RATE LOCK IS GONE, AND WHAT REPLACED IT ─────────────────────
      // This route used to 403 any non-admin who sent a unit_price override that
      // differed from the PO line (`me?.role !== 'admin'` → hard refusal). The
      // owner's ruling removed it: a storekeeper at the receiving bay must be
      // able to enter what the vendor ACTUALLY billed, because the bill is the
      // bill and the PO rate was only an estimate. Waiting for an admin to walk
      // to the gate did not make the number truer; it either stopped the goods or
      // pushed the real price into a later hand-correction nobody reviews.
      //
      // NOTHING ELSE WAS RELAXED — the trade is a stoppage for VISIBILITY:
      //   • the deviation gate immediately below still REFUSES (400) an off-rate
      //     line that carries no deviation_reason, and it is unchanged;
      //   • the reason is still persisted on the GRN line AND the purchases row;
      //   • the admin is still alerted after commit (audit event + notifications
      //     row + Slack), with the reason and the ₹ impact quoted, and
      //     `rate_changed` is still one of the four axes that alert reports.
      // The bill-DISCOUNT cap (Guard 2, NON_ADMIN_DISCOUNT_CAP_PCT) is a separate
      // control on a separate figure and is deliberately left in force.
      // poWriteGate() at the top of the handler is still the whole of who may
      // reach this code — the rate is editable by "anyone permitted to receive",
      // not by anyone at all.
      //
      // Deviation gate — receiving OFF-PO must say why.
      // The three ways a receive silently rewrites what was approved: a RECEIVED
      // qty that isn't the ordered qty (short OR over) moves stock and money, an
      // ACCEPTED qty short of the ordered qty does the same even when the truck
      // arrived in full (QC turned units away), and a RATE that isn't the ordered
      // rate feeds updateMaterialPrice → average_price →
      // every recipe cost. The receive modal asks for the reason, but THIS is
      // the gate — a crafted request must not commit an unexplained deviation.
      // The reason is persisted on the GRN line + the purchases row and goes
      // out in the admin alert below.
      const ordQty  = Number(it.quantity);
      const ordRate = Number(it.unit_price);
      const qtyOff  = Math.abs(effRcv - ordQty) > QTY_EPS;
      const rateOff = Math.abs(effPrice - ordRate) > RATE_EPS;
      // ACCEPTED is a third axis, and it was the hole: `accepted` defaults to
      // `received`, so a caller sending ONLY {accepted: 2} on a 10-unit line left
      // effRcv at the ordered 10 — qtyOff false, rateOff false — and the line
      // committed with 8 units silently rejected, no reason, and no admin alert.
      // "Reason for accepting less qty" is half the requirement, so judge accepted
      // against ordered too.
      const accOff  = Math.abs(effAcc - ordQty) > QTY_EPS;
      if (qtyOff || rateOff || accOff) {
        const devReason = String(ov?.deviation_reason || '').trim();
        if (devReason.length < 3) {
          const u = puLabel(it) || 'unit';
          const what: string[] = [];
          if (qtyOff)  what.push(`received ${effRcv} ${u} vs ordered ${ordQty} ${u}`);
          if (accOff)  what.push(`accepted ${effAcc} ${u} vs ordered ${ordQty} ${u}`);
          if (rateOff) what.push(`rate ₹${effPrice}/${u} vs ordered ₹${ordRate}/${u}`);
          return Response.json({
            error: `Reason required on "${it.material_name}" — ${what.join(' and ')}. Enter why this line differs from the PO (at least 3 characters); the admin is alerted with that reason.`,
            material: it.material_name,
            field: 'deviation_reason',
          }, { status: 400 });
        }
      }
    }

    // ── ON A HELD DELIVERY THE STORE MAY NOT PRE-REJECT ─────────────────────
    // Decision 4, enforced rather than described: the receiving desk records
    // what ARRIVED, the checking department records what is ACCEPTED. It is also
    // what makes `quantity_accepted = 0 while waiting` mean one unambiguous
    // thing (see the header of src/lib/grn-qc.ts). The honest lever is still
    // there and is named in the refusal — SHORT-RECEIVE the line, i.e. record
    // the smaller figure as RECEIVED, which is the true statement that the units
    // went back on the truck. Byte-identical refusal to /api/grn's, from the
    // same helper, so a receiver meets one sentence and not two.
    // Runs AFTER the sanity loop above (so accepted ≤ received is already true
    // and the message can't be about an impossible payload) and BEFORE the
    // charge allocation, which is keyed on the accepted quantities.
    if (qc.required) {
      const preReject = storePreRejectBlock(receiving.map((it: any) => {
        const ov = overrides.get(it.id);
        const effRcv = ov?.quantity != null ? Number(ov.quantity) : Number(it.quantity);
        return {
          material_name: String(it.material_name || ''),
          received: effRcv,
          declaredAccepted: ov?.accepted != null ? Number(ov.accepted) : effRcv,
        };
      }));
      if (preReject) {
        return Response.json({ error: preReject, qc_required: true, field: 'accepted' }, { status: 400 });
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Bill-charge allocation — AFTER every per-line gate above, BEFORE the txn.
    // The ordering is load-bearing, not stylistic: the rate lock, the zero-rate
    // guard and the deviation gate all compare the ORDERED rate against the rate
    // the RECEIVER TYPED. The discount is a property of the bill, not of the
    // rate the vendor quoted, so it must never reach those comparisons — net it
    // in first and every discounted receive reads as a rate deviation, which for
    // a non-admin is the hard 403 above, with the goods standing at the gate.
    // So: validate on the GROSS rate, then allocate, then re-guard.
    //
    // Allocated PER RECEIVE CALL, over THIS call's accepted lines only. Nothing
    // is carried across calls and nothing is read back from a previous receive,
    // so a partial/repeat receive cannot double-count a charge — the bill the
    // receiver is holding is the bill that is allocated.
    // ────────────────────────────────────────────────────────────────────
    //
    // AND OVER ONE VENDOR'S LINES ONLY. A delivery charge or a scheme discount
    // is a line on ONE vendor's invoice; spreading it over a mixed PO would
    // reduce the cost basis of another vendor's goods (and therefore that
    // material's average_price, and every recipe under it) with money that
    // vendor never took off. `receiving` IS the vendor scope, so feeding the
    // allocator nothing but those lines is the whole of the fix.
    const chargeItems = [...receiving]
      // PO item id ASC — a stable order matters because the allocator gives the
      // remainder to the LAST allocatable line, so DB row order must not decide
      // which line absorbs the odd paisa.
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
      .map((it: any) => {
        const ov = overrides.get(it.id);
        const effRcv   = ov?.quantity   != null ? Number(ov.quantity)   : Number(it.quantity);
        const effAcc   = ov?.accepted   != null ? Number(ov.accepted)   : effRcv;
        const effPrice = ov?.unit_price != null ? Number(ov.unit_price) : Number(it.unit_price);
        return { it, qty: effAcc, rate: effPrice };
      })
      // Only lines that actually enter stock and books carry a share. A fully
      // rejected line is never paid for, so it cannot absorb a discount.
      .filter(l => l.qty > 0);
    const chargeInputs = chargeItems.map(l => ({
      id: String(l.it.id), qty: l.qty, rate: l.rate, name: String(l.it.material_name || ''),
    }));
    // THE base the money is booked on — accepted value at the gross rate, over
    // allocatable lines only. A percentage is resolved against THIS, never the
    // client's (which counts lines this route drops).
    const chargeBase = r2(chargeInputs.reduce((acc, l) => acc + (l.qty > 0 && l.rate > 0 ? l.qty * l.rate : 0), 0));
    if (chargeMode('discount') === 'pct' && chargePctValue('discount') > 0) {
      chargeDiscount = r2((chargeBase * chargePctValue('discount')) / 100);
    }
    if (chargeMode('delivery') === 'pct' && chargePctValue('delivery') > 0) {
      chargeDelivery = r2((chargeBase * chargePctValue('delivery')) / 100);
    }
    const chargeAlloc = allocateBillCharges(
      chargeInputs,
      { discount: chargeDiscount, delivery: chargeDelivery },
    );
    const chargeByPoItem = new Map<string, AllocatedLine>(chargeAlloc.lines.map(l => [l.id, l]));
    const chargeItemById = new Map<string, any>(chargeItems.map(l => [String(l.it.id), l.it]));
    const hasCharges = chargeDiscount > 0 || chargeDelivery > 0;

    // Guard 1 — nothing to allocate against. Silently dropping the figures would
    // tell the receiver the bill was booked with its discount when it wasn't.
    if (hasCharges && chargeAlloc.subtotal === 0) {
      return Response.json({
        error: `Nothing was accepted on this receive, so there is nothing to apply the bill's discount/delivery to. Accept at least one line, or receive without the bill charges.`,
        field: 'bill_charges',
      }, { status: 400 });
    }

    // Guard 2 — non-admin discount cap. Same shape as the rate lock above: the
    // modal caps the input, but poWriteGate() admits every storekeeper, HOD and
    // floor manager, so without this an unbounded discount could be POSTed
    // straight at the route and rewrite average_price across every recipe. Half
    // a paisa of headroom so a %-derived figure landing exactly on the cap
    // isn't refused by its own rounding.
    const discountCap = r2((chargeAlloc.subtotal * NON_ADMIN_DISCOUNT_CAP_PCT) / 100);
    if (chargeDiscount - discountCap > 0.005 && me?.role !== 'admin') {
      const pct = chargeAlloc.subtotal > 0 ? Math.round((chargeDiscount / chargeAlloc.subtotal) * 100) : 100;
      return Response.json({
        error: `₹${chargeDiscount} is ${pct}% of the ₹${chargeAlloc.subtotal} accepted on this bill. A discount above ${NON_ADMIN_DISCOUNT_CAP_PCT}% of the bill needs an admin — ask an admin to receive this delivery.`,
        field: 'discount_amount',
        discount_cap: discountCap,
      }, { status: 403 });
    }

    // Guard 3 — post-allocation zero-cost. Mirrors the zero-rate guard above,
    // which runs on the rate as TYPED; this one runs on the rate as BOOKED,
    // because a discount big enough to flatten a line arrives at the same place
    // by a different road. Names every offending line: a receiver who has to
    // guess which of 30 lines broke will just drop the discount.
    // Only when a discount was actually applied: a line whose GROSS rate is
    // already under half a paisa reads as zero-cost here too, and that case
    // belongs to the zero-rate guard above — this one must not start refusing
    // undiscounted receives it never saw before.
    if (chargeAlloc.discount_applied > 0 && chargeAlloc.zero_cost_lines.length > 0) {
      const detail = chargeAlloc.zero_cost_lines.map(l => {
        const it = chargeItemById.get(l.id);
        const u  = (it ? puLabel(it) : '') || 'unit';
        return `"${l.name || it?.material_name || l.id}" would be booked at ₹${l.net_rate.toFixed(2)}/${u}`;
      }).join('; ');
      return Response.json({
        error: `${detail} after the ₹${chargeAlloc.discount_applied.toLocaleString('en-IN')} discount — a ₹0 cost basis wipes average_price and every recipe that uses it. Reduce the discount or record it as a credit note.`,
        field: 'discount_amount',
        zero_cost_lines: chargeAlloc.zero_cost_lines.map(l => ({
          po_item_id: l.id, material_name: l.name, net_rate: l.net_rate, gross_rate: l.rate,
        })),
        min_net_rate: MIN_NET_RATE,
      }, { status: 400 });
    }

    // ────────────────────────────────────────────────────────────────────
    // PER-LINE GST — derived HERE, server-side, from this route's own figures.
    //
    // WHY IT SITS AFTER THE ALLOCATION: tax is charged on the POST-DISCOUNT
    // goods value, so a line's taxable base is its accepted value MINUS its
    // share of the bill discount — which does not exist until allocateBillCharges
    // has run. Placing it earlier would tax the gross and over-state the input
    // credit on every discounted bill.
    //
    // WHY THE CLIENT'S cgst/sgst ARE DISCARDED: this is the input-credit record.
    // The figure on it must follow from the goods value on the SAME row, or a
    // miscalculating modal — or a replayed/hand-edited payload — writes a tax the
    // row cannot justify to an auditor. The client's numbers are read only to log
    // a divergence, exactly as /api/purchases does.
    //
    // THE ARITHMETIC IS /api/purchases' ARITHMETIC, DELIBERATELY BYTE-FOR-BYTE:
    //   taxable  = r2(accepted × rate − discount_share)     ← 2-dp rupees
    //   taxPaise = round(taxable × rate%)   (the ÷100 for percent and the ×100
    //                                        for paise cancel — whole paise)
    //   sgst     = floor(taxPaise / 2) ; cgst = taxPaise − sgst   (odd paisa → CGST)
    // Halving in integer paise is what keeps cgst + sgst re-adding to the tax
    // EXACTLY (the house invariant tax_value = cgst + sgst that every reader
    // re-adds); halving in floats drifts a paisa. A third rounding convention
    // between the two purchase paths is how a GST return stops reconciling.
    // ────────────────────────────────────────────────────────────────────
    // COMPENSATION CESS RIDES ALONG HERE, ON A DIFFERENT BASE ON PURPOSE.
    //   GST  → the POST-discount goods value  (taxable = grossTotal − discShare)
    //   CESS → the GROSS line value, BEFORE the discount (grossTotal)
    // That is the owner's ruling, not an oversight: 10 kg @ ₹100 with a ₹100
    // discount books GST 18% on ₹900 = ₹162 and cess 12% on ₹1,000 = ₹120. The
    // two bases are DELIBERATELY different — a future reader will assume they
    // match and "simplify" one into the other, and that quietly under-recovers
    // the cess on every discounted bill. Cess is also ONE figure, never halved,
    // and never added into cgst/sgst: the house invariant tax_value = cgst + sgst
    // is a statement about GST alone, and folding cess into it would overstate
    // the GST claimed on a return. Readers pick it up as its own Total Inward
    // term, exactly like the other recorded-only charges.
    interface LineTax { gst_rate: number; taxable: number; tax: number; cgst: number; sgst: number; forced_zero: boolean; cess_rate: number; cess_base: number; cess: number; cess_forced_zero: boolean }
    const taxByPoItem = new Map<string, LineTax>();
    for (const it of receiving) {
      const ov = overrides.get(it.id);
      const effRcv   = ov?.quantity   != null ? Number(ov.quantity)   : Number(it.quantity);
      const effAcc   = ov?.accepted   != null ? Number(ov.accepted)   : effRcv;
      const effPrice = ov?.unit_price != null ? Number(ov.unit_price) : Number(it.unit_price);
      // LIQUOR IS ZERO-RATED — its duty rides on the TGBCL bill (excise / cess /
      // TCS), never on GST, so an input-credit figure here would be claimed
      // twice. Uses the EXISTING store-mapping guard, not a category test, so it
      // tracks whatever the store engine considers store-mapped. centralFlowBlock
      // already dropped these lines from `receivable` above, so in practice this
      // never fires — it is the second lock, mirroring /api/purchases: if that
      // guard is ever relaxed for a category, a client that sent 18% must still
      // not write a credit the TGBCL charges already carry.
      // A store-mapped (TGBCL) line is zero-rated for the COMPENSATION CESS on
      // the same reasoning as the GST above: its cess is levied on the TGBCL
      // bill as `special_excise_cess`, so booking a GST compensation cess here
      // as well would claim the same duty twice under a levy the government
      // never charged on it.
      const storeMapped = isStoreMappedMaterial(db, String(it.material_id || ''));
      const gstRate = (!gstProvidedFor(ov) || storeMapped) ? 0 : Number(ov!.gst_rate);
      const cessRate = (!cessProvidedFor(ov) || storeMapped) ? 0 : Number(ov!.cess_rate);
      // GROSS accepted value — identical expression to `acceptedTotal` in the txn
      // loop, and to the GRN row's ROUND(quantity_accepted × unit_price, 2) that
      // every register totals from. A fully-rejected line is 0 here and therefore
      // carries no tax: it was never accepted, so no credit is claimable on it.
      const grossTotal = Math.round((effAcc > 0 ? effAcc : 0) * effPrice * 100) / 100;
      const discShare  = chargeByPoItem.get(String(it.id))?.discount_share || 0;
      const taxable    = r2(grossTotal - discShare);
      const taxPaise   = gstRate > 0 ? Math.max(0, Math.round(taxable * gstRate)) : 0;
      const sgstPaise  = Math.floor(taxPaise / 2);
      const cgstPaise  = taxPaise - sgstPaise;   // odd paisa lands in CGST, per the contract
      // CESS IS ON `grossTotal`, NOT ON `taxable` — the ONE line where this route
      // deliberately diverges from the GST arithmetic directly above it. GST is
      // charged on the post-discount value (`taxable`, line above); the owner's
      // ruling is that compensation cess is charged on the GROSS, pre-discount
      // line value. Do not "align" this to `taxable`. Whole paise in the same
      // shape as taxPaise (the ÷100 for percent and the ×100 for paise cancel),
      // floored at 0, and driven off the same accepted-only grossTotal — so a
      // fully-rejected line and a negative back-correction both carry ₹0 cess,
      // exactly as they carry ₹0 GST.
      const cessPaise  = cessRate > 0 ? Math.max(0, Math.round(grossTotal * cessRate)) : 0;
      taxByPoItem.set(String(it.id), {
        gst_rate: gstRate,
        taxable,
        tax:  taxPaise / 100,
        cgst: cgstPaise / 100,
        sgst: sgstPaise / 100,
        forced_zero: storeMapped && gstProvidedFor(ov) && Number(ov!.gst_rate) > 0,
        cess_rate: cessRate,
        // Stated alongside the figure so a reader of the audit row can see WHICH
        // base the cess was taken on without re-deriving it from the discount.
        cess_base: grossTotal,
        cess: cessPaise / 100,
        cess_forced_zero: storeMapped && cessProvidedFor(ov) && Number(ov!.cess_rate) > 0,
      });
      // A client whose split disagrees with the server's is LOGGED, never
      // obeyed — a UI drift must stay visible instead of being silently
      // corrected on every bill for months. Compared in INTEGER paise with a
      // 1-paisa allowance: the client's round2(taxable × rate ÷ 100)
      // legitimately lands a paisa off on half-paisa amounts, and that is
      // agreement, not drift.
      if (ov?.cgst !== undefined || ov?.sgst !== undefined) {
        const sentTax = (Number(ov?.cgst) || 0) + (Number(ov?.sgst) || 0);
        if (Math.abs(Math.round(sentTax * 100) - taxPaise) > 1) {
          console.warn(
            `[receive PO] client tax ₹${sentTax.toFixed(2)} ≠ server-derived ₹${(taxPaise / 100).toFixed(2)} ` +
            `(PO ${po.po_number}, line "${it.material_name}", taxable ₹${taxable.toFixed(2)} @ ${gstRate}%) — stored the derived figure`
          );
        }
      }
    }
    /**
     * Σ of the server-derived tax, for the response + audit payload.
     * `taxable` counts ONLY the lines that actually carry a rate — an exempt or
     * no-GST line is not a ₹0-tax taxable supply, and folding its value in here
     * would report a taxable base the tax on it can never reconcile to.
     */
    const taxTotals = [...taxByPoItem.values()].reduce(
      (acc, t) => ({
        cgst: r2(acc.cgst + t.cgst),
        sgst: r2(acc.sgst + t.sgst),
        tax:  r2(acc.tax  + t.tax),
        taxable: t.gst_rate > 0 ? r2(acc.taxable + t.taxable) : acc.taxable,
      }),
      { cgst: 0, sgst: 0, tax: 0, taxable: 0 },
    );
    /**
     * Σ of the server-derived COMPENSATION CESS — its OWN accumulator, kept out
     * of taxTotals on purpose. taxTotals.tax is the GST figure that must keep
     * re-adding to cgst + sgst exactly, and every reader re-adds it; a cess
     * folded in there would report GST the government never levied. `cess_base`
     * is likewise summed separately from taxTotals.taxable because the two are
     * different bases (gross vs post-discount) and adding them would state a
     * taxable value neither levy reconciles to.
     */
    const cessTotals = [...taxByPoItem.values()].reduce(
      (acc, t) => ({
        cess: r2(acc.cess + t.cess),
        cess_base: t.cess_rate > 0 ? r2(acc.cess_base + t.cess_base) : acc.cess_base,
      }),
      { cess: 0, cess_base: 0 },
    );

    let total = 0;
    const touchedMaterials = new Set<string>();

    const txn = db.transaction(() => {
      // ── Atomic claim (MUST stay the first statement in this txn) ──────────
      // The status === 'approved' check above is separated from every write by
      // two awaits (req.json + getCurrentUser), so two concurrent receives can
      // both pass it and each credit stock, write a purchases row and mint a
      // GRN. better-sqlite3 txns are synchronous: whoever wins this conditional
      // UPDATE proceeds, the loser matches 0 rows and throws, rolling back its
      // whole txn before anything else is written.
      //
      // WHY IT NO LONGER FLIPS THE STATUS. A multi-vendor PO must stay
      // 'approved' after vendor A's delivery so vendor B can still deliver
      // against it on Friday, so the flip moved to the end of this txn, behind
      // the completion test. The claim keeps its two jobs regardless: it is
      // still conditional on 'approved' (a cancelled/received PO is refused),
      // and being a WRITE it takes SQLite's write lock as the txn's first
      // statement — so the per-line conflict check immediately below reads
      // under that lock and cannot be raced by a second connection.
      const claim = db.prepare(`
        UPDATE purchase_orders
        SET updated_at = datetime('now')
        WHERE id = ? AND status = 'approved'
      `).run(id);
      if (claim.changes === 0) {
        const err: any = new Error('This PO has already been received (or is no longer approved). Reload the page.');
        err.httpStatus = 409;
        throw err;
      }

      // ── Per-line claim ────────────────────────────────────────────────────
      // The receipt ledger re-read INSIDE the lock. Two receivers who opened the
      // same vendor's delivery in two tabs both passed the pre-txn check; this is
      // where the second one loses, before a single unit of stock moves.
      const doneNow = receivedPoItemIds(db, id);
      const clash = receiving.filter((it: any) => doneNow.has(String(it.id)));
      if (clash.length > 0) {
        const err: any = new Error(
          `${clash.length} line(s) on this delivery were already received (${clash.slice(0, 3).map((c: any) => c.material_name).join(', ')}${clash.length > 3 ? '…' : ''}). Reload the page.`);
        err.httpStatus = 409;
        throw err;
      }

      // ── The COST row (net basis) ───────────────────────────────────────
      // unit_price / total_price are NET of the bill discount, because
      // updateMaterialPrice() (src/lib/db.ts) averages ONLY
      // SUM(quantity * unit_price) / SUM(quantity) — it never reads a discount
      // column — so a discount that is not inside unit_price does not reduce
      // cost at all, and the owner ruling is that it must.
      // `discount` is therefore bound to the LITERAL 0 below, deliberately: the
      // reduction already lives in unit_price, and any reader that subtracted
      // this column as well would take it off twice. The gross rate and the
      // discount figure are not lost — they are on the GRN line written just
      // below, which is the bill document.
      // `delivery_charges` is recorded only and never enters any rate.
      //
      // AND NEITHER DOES TAX. unit_price / total_price on this row are the GOODS
      // figures — GST is deliberately NOT bound here and no cgst/sgst column is
      // written on this path. updateMaterialPrice() averages exactly
      // SUM(quantity × unit_price) / SUM(quantity) into average_price, which every
      // recipe and sub-recipe cost in the app derives from, so a tax-inclusive
      // rate would inflate every one of them by the GST rate — silently, forever —
      // and the tax, once buried inside a cost, is no longer reclaimable as input
      // credit. The tax for this receipt lives on the GRN line written just above,
      // which IS the bill document; this row is the COST mirror of it, and
      // src/lib/purchase-log.ts reads the two separately (is_mirror) precisely so
      // the same rupee is not counted on both.
      //
      // TRACEABILITY (Break 2) — `grn_id` is the HARD link from the cost row back
      // to the delivery that created it. Until it existed the ONLY tie between a
      // purchases row and its GRN was the English sentence in `notes` ("Received
      // against PO-… (GRN GRN-…)"), which src/lib/purchase-log.ts has to parse back
      // out with an anchored regex. A sentence is not a key: rewrite the wording
      // once and every downstream join dies silently. So the id is bound here, in
      // the SAME transaction that mints the GRN, where it is knowable for free.
      // Two rules a future edit must not "simplify" away:
      //   1. The `notes` text STAYS character-for-character as it is. It is history
      //      on ~every existing row, purchase-log.ts still parses it, and older rows
      //      predate this column — the regex is the fallback, not dead code.
      //   2. `grn_id` is NULL on every purchases writer that has no GRN in scope
      //      (direct purchase, opening stock, bulk, inward-import, seed). NULL there
      //      is the honest value; do not invent a GRN to fill it, and do not backfill
      //      historical rows, which have no recoverable delivery.
      // Soft link, deliberately no FOREIGN KEY: SQLite cannot ADD one by ALTER and
      // rebuilding `purchases` on a live system to gain a constraint nothing enforces
      // today is not a trade worth making.
      const insPurchase = db.prepare(`
        INSERT INTO purchases (id, material_id, vendor, brand, quantity, unit_price, total_price, date, notes, outlet_id,
                               discount, delivery_charges, bill_no, grn_id, created_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'))
      `);
      const bumpStock = db.prepare(`
        UPDATE raw_materials
        SET current_stock = current_stock + ?,
            last_purchase_price = ?,
            last_purchase_date  = ?,
            updated_at          = datetime('now')
        WHERE id = ?
      `);
      const insTx = db.prepare(`
        INSERT INTO inventory_transactions (id, material_id, type, quantity, reference_id, notes, outlet_id, created_at)
        VALUES (?, ?, 'purchase', ?, ?, ?, ?, datetime('now'))
      `);

      // Phase 1 §5 — auto-create a GRN for this PO receive. Stock only bumps by the
      // ACCEPTED qty on each line (defaults to full received qty if no overrides provided).
      // body.item_overrides may now include: { po_item_id, quantity (=received), accepted, rejection_reason, deviation_reason }
      const grnId = generateId();
      const yr = receivedAt.slice(0, 4);
      const lastGrn = db.prepare(`SELECT grn_number FROM goods_receipt_notes WHERE grn_number LIKE 'GRN-' || ? || '-%' ORDER BY grn_number DESC LIMIT 1`).get(yr) as any;
      const nextNum = lastGrn?.grn_number ? parseInt(lastGrn.grn_number.split('-').pop() || '0', 10) + 1 : 1;
      const grnNumber = `GRN-${yr}-${String(nextNum).padStart(4, '0')}`;
      // ── The vendor bill row ───────────────────────────────────────────────
      // ONE po_vendor_bills row per vendor receipt, written BEFORE any stock
      // moves so a duplicate bill number costs nothing. Its UNIQUE index
      // (po_id, vendor_name, bill_no) IS the duplicate guard — the constraint is
      // caught here and re-thrown as a sentence a storekeeper can act on, rather
      // than surfacing the driver's "UNIQUE constraint failed" as a 500.
      // Written even when bill_no is blank: the row is the receipt event (who
      // took delivery from this vendor, on what date, against which PO), and a
      // blank number still keys uniquely per vendor.
      const billVendorName = group.vendor_name;
      // FK preference: the LINE's vendor_id; then the header's, but only when
      // the header is genuinely this same vendor (on a mixed PO the header is
      // "Mixed (N vendors)" with a NULL id, and on a legacy PO the group name IS
      // the header name); then a name lookup. Never a foreign vendor's id.
      const billVendorId =
        group.vendor_id
        || (vendorKeyOf(po.vendor) === group.key ? (po.vendor_id || null) : null)
        || ((db.prepare(`SELECT id FROM vendors WHERE LOWER(TRIM(name)) = ? LIMIT 1`)
              .get(group.key) as any)?.id ?? null);
      // grn_id IS THE LINK NOW, and the sentence in `notes` is kept beside it.
      // The bill row is written BEFORE the GRN header (a duplicate bill number
      // must cost nothing), so this stamps the id minted above rather than one
      // read back — it is the same value the INSERT below uses, in the same
      // transaction. The column is what lets an admin void this receipt: the
      // void RELEASES this row so the reopened PO can take the same bill in
      // again, and it will not release a row it cannot uniquely identify.
      // `notes` stays exactly as it was: it is what the historical rows have,
      // and api/grn/[id] still falls back to parsing it for them.
      try {
        db.prepare(`
          INSERT INTO po_vendor_bills
            (id, po_id, grn_id, vendor_id, vendor_name, bill_no, bill_date, received_by, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(generateId(), id, grnId, billVendorId, billVendorName, billNo, billDate, receivedByEmail,
                `GRN ${grnNumber}${chargesNote ? ` — ${chargesNote}` : ''}`);
      } catch (e: any) {
        if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          const err: any = new Error(
            billNo
              ? `Bill no. "${billNo}" is already recorded for ${billVendorName || '(no vendor)'} on ${po.po_number}. Enter the vendor's actual bill number — the same bill cannot be received twice.`
              : `A receipt from ${billVendorName || '(no vendor)'} with no bill number is already recorded on ${po.po_number}. Enter the vendor's bill number to record a second delivery.`);
          err.httpStatus = 409;
          throw err;
        }
        throw e;
      }

      // The GRN IS this vendor's bill document, so it carries THIS vendor and
      // THIS vendor's invoice — not the PO header, which on a mixed PO reads
      // "Mixed (N vendors)". On a single-vendor PO both resolve to the same
      // name and the row is unchanged. invoice_number / invoice_date were
      // simply never populated on this path before; filling them is additive
      // and is what makes /grn and the inward register show the real bill.
      //
      // ── THE HELD HEADER ──────────────────────────────────────────────────
      // 'awaiting_qc' instead of 'received' is the WHOLE gate: it is what the
      // sign-off's conditional claim matches on, what the Pending Quality Checks
      // queue lists, and what every downstream reader must learn about the way
      // it learned 'void'. qc_required / qc_checker record that this receipt WAS
      // gated and by whom, so the fact survives the status returning to
      // received/partial once the kitchen signs.
      // ── AND NO STORE SIGNATURE, BECAUSE THIS SCREEN ASKS FOR NONE ────────
      // THE SIX LEGACY qc_* TICKS ARE STILL NOT WRITTEN ON THIS PATH — they
      // never were, and the receive screen has no checklist. qc_store_by /
      // qc_store_at are therefore ALSO left empty, and that is the honest state
      // rather than an omission: they are the STORE half of the owner's
      // decision-4 split (expiry / use-by, weight-and-count vs invoice, invoice
      // matches PO), and stamping a name for three checks the receiver was never
      // shown would be the same worthless self-certification the kitchen half of
      // this feature exists to replace — a signature nobody gave, on a screen
      // that never asked. received_by already records who took the delivery in,
      // and poWriteGate() already proves they were entitled to; neither is a
      // statement that the goods were checked against the bill.
      // POST /api/grn does stamp it, because that form DOES carry the three
      // boxes — and only when all three are ticked. To make it stampable here,
      // add the same three to the receive screen and bind them the same way.
      db.prepare(`
        INSERT INTO goods_receipt_notes
          (id, grn_number, date, po_id, vendor_id, vendor, invoice_number, invoice_date,
           received_by, status, notes, outlet_id,
           qc_required, qc_checker, qc_outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(grnId, grnNumber, receivedAt, id, billVendorId, billVendorName || po.vendor || '',
              billNo, billNo ? billDate : '',
              receivedByEmail,
              qc.required ? QC_AWAITING : 'received',
              `Auto-created from PO ${po.po_number} receive`
                + (isMultiVendorPo ? ` — ${billVendorName || '(no vendor)'} only` : ''),
              po.outlet_id,
              qc.required ? 1 : 0, qc.required ? qc.checker : '',
              qc.required ? 'pending' : '');

      // ── The BILL row (gross basis) ─────────────────────────────────────
      // The exact opposite basis to the purchases row above, and it has to be.
      // unit_price stays GROSS and the discount goes in its own column because
      // this row IS the vendor's bill: /api/grn and the inward register both
      // total it as `quantity × unit_price − discount + …`, so a net rate here
      // plus a discount column would subtract the discount twice; and
      // /api/receiving-variance values every line off gi.unit_price against the
      // ordered rate, so a net rate would report a rate variance the vendor
      // never billed. Discount + delivery are per-line shares of the bill-level
      // figures, allocated by value before the txn opened.
      //
      // cgst/sgst are the SERVER-DERIVED halves of the line's GST (taxByPoItem,
      // computed above) and they are RECORDED ONLY — unit_price here stays the
      // pure GOODS rate, never tax-inclusive. Every register reads this row as
      //   Total Inward = qty × unit_price − discount + cgst + sgst + … ,
      // so folding the tax into the rate would both double it on read and, via
      // the mirrored purchases row, inflate average_price and every recipe cost
      // built on it — which is exactly why the old bill-level GST control was
      // deleted. Both are 0 when no gst_rate was sent, so a payload without one
      // writes precisely the row this route wrote before the field existed.
      //
      // `compensation_cess` is the 8th recorded-only charge and is appended LAST,
      // additively, so the existing column order is untouched. It is the GST
      // compensation cess taken on the GROSS (pre-discount) line value — a
      // different base from cgst/sgst, which are on the post-discount value; see
      // the taxByPoItem block above. It is NOT the TGBCL `special_excise_cess`
      // (a state excise levy, on a different table's charges) and it is NOT part
      // of the cgst + sgst invariant. Like the others it joins Total Inward as
      // its own term and never enters unit_price. 0 when no cess_rate was sent,
      // so a payload without one writes the row this route wrote before.
      //
      // gst_rate / cess_rate are the PERCENTS behind cgst/sgst/compensation_cess,
      // stored so a QC rejection can re-derive the tax on the SMALLER accepted
      // quantity with this route's own arithmetic instead of reverse-engineering
      // a rate out of rupees. cost_vendor / cost_note are the two fields of the
      // deferred `purchases` row that cannot be honestly re-derived hours later:
      // the LINE's vendor (not the header's, on a mixed PO) and the exact
      // sentence src/lib/purchase-log.ts parses with an anchored regex.
      const insGrnItem = db.prepare(`
        INSERT INTO goods_receipt_note_items
          (id, grn_id, po_item_id, material_id, quantity_ordered, quantity_received,
           quantity_accepted, quantity_rejected, rejection_reason, unit_price, notes,
           discount, cgst, sgst, delivery_charges, compensation_cess,
           gst_rate, cess_rate, cost_vendor, cost_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Excess + deviation detection happen inline below — the `excessLines` and
      // `deviationLines` arrays are hoisted at the outer function scope (filled
      // here, read post-txn for the admin audit + Slack ping).
      // ONE VENDOR'S LINES. Another vendor's line is not on this bill and must
      // not get a GRN row here — that row is what marks it received.
      for (const it of receiving) {
        const ov = overrides.get(it.id);
        const received = ov?.quantity   != null ? Number(ov.quantity)   : it.quantity;
        const accepted = ov?.accepted   != null ? Number(ov.accepted)   : received;
        const rejected = Math.max(0, received - accepted);
        const reason   = String(ov?.rejection_reason || '').trim();
        const price    = ov?.unit_price != null ? Number(ov.unit_price) : it.unit_price;
        // Off-PO facts for this line. The pre-txn gate already refused to get
        // here without a reason when either is true, so devReason is present
        // on any deviating line.
        const devReason  = String(ov?.deviation_reason || '').trim();
        const ordQty     = Number(it.quantity);
        const ordRate    = Number(it.unit_price);
        const qtyShort   = received < ordQty - QTY_EPS;
        const qtyExcess  = received > ordQty + QTY_EPS;
        const rateChanged = Math.abs(Number(price) - ordRate) > RATE_EPS;
        // Accepted-vs-ordered is its own axis: a line can arrive in full and then
        // be part-rejected at QC, so `received` matches the PO while only a
        // fraction is actually booked. Judging `deviated` on received alone let
        // that land with no entry here — so no audit event, no notification, no
        // Slack ping — even though the money and stock moved. This is the axis the
        // "accepting less qty" alert hangs on.
        const accShort   = accepted < ordQty - QTY_EPS;
        const deviated   = qtyShort || qtyExcess || rateChanged || accShort;
        // `accepted` descends from it.quantity (a purchase_order_items row =
        // PURCHASE units) or from ov.accepted / ov.quantity, which the receive
        // screen collects in the box labelled material_purchase_unit. `price`
        // is it.unit_price or ov.unit_price, Rs per PURCHASE unit on both paths.
        // This product is written straight to purchases.total_price beside
        // quantity = accepted and unit_price = netPrice, so the books stay in
        // one basis. The recipe basis is entered exactly once, further down,
        // where stockQty = accepted x packSize feeds current_stock — the pack
        // factor belongs on the QUANTITY there, never on this money line.
        // rate-basis: purchase (accepted PU x Rs/PU -> purchases.total_price)
        const acceptedTotal = Math.round(accepted * price * 100) / 100;
        // This line's share of the bill-level charges (0/0 when none were sent,
        // or when the line is fully rejected and so was never allocated).
        const share       = chargeByPoItem.get(String(it.id));
        const discShare   = share ? share.discount_share : 0;
        const delivShare  = share ? share.delivery_share : 0;
        // This line's SERVER-DERIVED tax (0/0 when no gst_rate was sent, and
        // always 0 for a store-mapped material). Recorded only — read the block
        // where taxByPoItem is built for the base and the rounding.
        const lineTax     = taxByPoItem.get(String(it.id));
        const cgstAmt     = lineTax ? lineTax.cgst : 0;
        const sgstAmt     = lineTax ? lineTax.sgst : 0;
        // This line's SERVER-DERIVED compensation cess (0 when no cess_rate was
        // sent, and always 0 for a store-mapped material). Taken on the GROSS
        // line value, NOT on the post-discount base cgst/sgst use — read the
        // taxByPoItem block for why the two bases differ.
        const cessAmt     = lineTax ? lineTax.cess : 0;
        // The NET basis is substituted ONLY when a discount was actually
        // applied. With no discount the allocator's net_rate is a re-derivation
        // (r2(r2(qty × rate) / qty)) that can differ from the typed rate in the
        // 3rd decimal, and this route must write a receive with no bill charges
        // exactly as it always has.
        const netPrice    = (share && chargeAlloc.discount_applied > 0) ? share.net_rate  : price;
        const netTotal    = (share && chargeAlloc.discount_applied > 0) ? share.net_total : acceptedTotal;
        // purchase_orders.total_cost accumulates what the PO actually cost —
        // net of the discount, exclusive of the recorded-only delivery.
        total += netTotal;

        // Excess detection — store accepted MORE than the PO line ordered.
        // (Rejected portion never enters stock so we compare against accepted,
        // not received — that's what actually impacts inventory + books.)
        // Same QTY_EPS as the deviation flags above so an accepted-over line is
        // ALWAYS also a deviation line: the response reports excess_lines and
        // the alert is driven off deviationLines, and those two must not disagree.
        if (accepted > ordQty + QTY_EPS) {
          const excess = accepted - ordQty;
          excessLines.push({
            material_name: it.material_name,
            material_id: it.material_id,
            ordered:    it.quantity,
            received:   received,
            accepted:   accepted,
            excess:     excess,
            // Purchase unit — ordered/accepted/excess are all PO qtys and the
            // ₹ in the same sentence is ₹/purchase-unit. Labelling with the
            // recipe unit made a 3 L (₹2,400) surplus read as "3 ml".
            unit_pu:    puLabel(it),
            unit_price: price,
            excess_value: Math.round(excess * price * 100) / 100,
          });
        }

        // Off-PO line → admin alert. A line deviates on any of the three axes the
        // gate above asked a reason for: RECEIVED vs ordered (short/over),
        // ACCEPTED vs ordered (accShort — arrived in full, part-rejected at QC),
        // and RATE vs the ordered rate. The money impact is always computed on
        // ACCEPTED, since rejected units are never paid for.
        if (deviated) {
          deviationLines.push({
            material_name: it.material_name,
            material_id:   it.material_id,
            ordered:       ordQty,
            received:      received,
            accepted:      accepted,
            unit_pu:       puLabel(it),
            ordered_rate:  ordRate,
            actual_rate:   Number(price),
            qty_short:     qtyShort,
            qty_excess:    qtyExcess,
            rate_changed:  rateChanged,
            acc_short:     accShort,
            // Both products are PURCHASE units x Rs/purchase-unit, so the
            // difference is a real rupee delta and not a pack artefact.
            // accepted/price are the billed pair (see acceptedTotal above);
            // ordQty/ordRate are it.quantity/it.unit_price straight off the
            // purchase_order_items row. Mixing a basis across the minus sign
            // would report a pack_size-scaled deviation to the admin alert —
            // Rs 900 read as Rs 900,000 on a 1 kg pack.
            // rate-basis: purchase (billed PU pair minus ordered PU pair)
            value_impact:  Math.round((accepted * Number(price) - ordQty * ordRate) * 100) / 100,
            reason:        devReason,
          });
        }

        // GRN item row — always written so the audit trail captures received + rejected too.
        // The notes column carries BOTH stories: the QC rejection (why units were
        // turned away) and the PO deviation (why the line isn't what was ordered).
        const noteBits: string[] = [];
        if (!qc.required && rejected > 0) noteBits.push(`Rejected ${rejected} (${reason || 'no reason given'})`);
        if (deviated && devReason) noteBits.push(`PO deviation: ${devReason}`);
        // The cost row's own wording and vendor, minted here even when nothing
        // is booked — on a held GRN the `purchases` row is written hours later,
        // by a different route, and both of these must be the string/name THIS
        // route would have written. Identical to what the insert below uses on
        // an unheld receive, so that path is byte-unchanged.
        const lineVendorForCost = lineVendorName(it, po);
        const costNote = `Received against ${po.po_number} (GRN ${grnNumber})`
          + (deviated && devReason ? ` — off-PO: ${devReason}` : '');
        // `price` is bound to unit_price GROSS OF TAX and gross of the discount —
        // the goods rate off the vendor's bill. cgstAmt/sgstAmt/cessAmt go in
        // their own columns; none of them may ever be added into the rate (see
        // the prepare above).
        // ── WHAT quantity_accepted MEANS ON A HELD LINE: 0, AND NOT "REJECTED" ──
        // The store records what ARRIVED; the checking department records what is
        // ACCEPTED, later. Writing `received` here provisionally would make every
        // downstream reader value goods nobody has accepted — two of them
        // dangerously: src/lib/returns.ts offers a line for VENDOR RETURN on
        // quantity_accepted > 0 (and settling it debits stock that was never
        // credited), and src/lib/purchase-log.ts would book the value with no
        // purchases mirror and report it as billed-but-never-booked. Both close
        // on their own at 0, with no edit to either file.
        // ZERO ACCEPTED IS THE ABSENCE OF A DECISION, and status='awaiting_qc' is
        // what says so. storePreRejectBlock() above already refused any payload
        // that declared a smaller accepted on a gated delivery, so nothing the
        // receiver typed is being silently discarded here.
        // quantity_ordered / quantity_received are UNTOUCHED: the receipt ledger
        // (receivedPoItemIds) keys on the ROW existing, and holding those back
        // would let the same PO line be received twice.
        insGrnItem.run(generateId(), grnId, it.id, it.material_id,
                       it.quantity, received,
                       qc.required ? 0 : accepted, qc.required ? 0 : rejected,
                       qc.required ? '' : reason, price,
                       noteBits.join(' | '),
                       discShare, cgstAmt, sgstAmt, delivShare, cessAmt,
                       lineTax ? lineTax.gst_rate : 0, lineTax ? lineTax.cess_rate : 0,
                       lineVendorForCost, costNote);

        // Stock + financials reflect ONLY the accepted qty (rejections never enter stock)
        //
        // ── AND NOTHING AT ALL WHEN THE DELIVERY IS HELD ─────────────────────
        // These three writes ARE "the goods are ours". Deferring them to the
        // sign-off (decideGrnQc in src/lib/grn-qc.ts, which replays exactly this
        // shape from the stored row — net rate re-derived from gi.discount,
        // GROSS rate into last_purchase_price, packFactor on the stock credit)
        // is the entire feature. The GRN header, its line rows, the vendor bill
        // row and both concurrency claims are NOT deferred: the document is the
        // record that the truck arrived, and the claims are locks on the PO, not
        // on the stock.
        if (!qc.required && accepted > 0) {
          const purchaseId = generateId();
          // Same helper the grouping used, so the vendor a line is BOOKED
          // against is by construction the vendor whose bill received it.
          // Computed above (as lineVendorForCost) so the held path stores the
          // SAME name on the GRN line; aliased here so this insert reads
          // unchanged.
          const lineVendor = lineVendorForCost;
          // ── Unit-basis boundary (CORE CONVENTION) ──────────────────────
          // A PO line carries qty in PURCHASE units and price in ₹/purchase-unit
          // (a PO is raised to a VENDOR — see /api/purchase-orders' items query
          // and the composer's poUnitOf/poRateOf). That is the SAME basis the
          // `purchases` table stores, so the row is written UNCHANGED and
          // last_purchase_price is already ₹/purchase-unit.
          // `current_stock` is in RECIPE units, so the stock credit is the only
          // thing that converts: × pack_size when pack>1 AND recipe≠purchase
          // unit — identical to /api/grn and /api/purchases POST.
          const packSize = Number(it.material_pack_size) || 1;
          const ru = String(it.material_unit || '').toLowerCase().trim();
          const pu = String(it.material_purchase_unit || it.material_unit || '').toLowerCase().trim();
          const isPack = packSize > 1 && ru !== pu;
          const stockQty = isPack ? accepted * packSize : accepted;
          // Carry the deviation reason onto the purchases row too — this is the
          // row every cost report and the average_price recompute read back, so
          // "why is this qty/rate not the PO's" has to survive here as well.
          // Composed above (as costNote) and stored on the GRN line, so a held
          // delivery's deferred cost row carries this EXACT sentence — which
          // src/lib/purchase-log.ts parses with an anchored regex.
          const purchaseNote = costNote;
          // Stamp the receipt with the PO's outlet (the GRN header above already
          // does). A NULL here gets backfilled to the DEFAULT outlet by the
          // startup migration, silently moving another outlet's purchase.
          // grnId is the LAST bind and the only new one: the GRN minted a few lines
          // above in this same transaction, so the cost row and its delivery are
          // committed together or not at all. Nothing else on this call changes —
          // quantity, netPrice, netTotal, delivShare and purchaseNote are untouched.
          insPurchase.run(purchaseId, it.material_id, lineVendor, accepted, netPrice, netTotal, receivedAt,
            purchaseNote, po.outlet_id, delivShare, billNo, grnId);
          // last_purchase_price keeps the GROSS rate, and that divergence from
          // the purchases.unit_price written one line above is deliberate: this
          // column is the vendor's LIST rate, and it seeds the next PO's rate
          // (poRateOf / the vendor chips on /purchase-orders). Seeding it net
          // would ratchet the ordered rate down every cycle and then trip the
          // rate lock the moment the vendor bills their unchanged list price.
          // Cost lives in purchases.unit_price; this is what we expect to pay.
          bumpStock.run(stockQty, price, receivedAt, it.material_id);
          insTx.run(generateId(), it.material_id, stockQty, purchaseId, `PO ${po.po_number} received via GRN ${grnNumber}`, po.outlet_id);
          touchedMaterials.add(it.material_id);
        }
      }

      // Mark the GRN 'partial' when this is NOT a clean full receipt — a line
      // with units rejected at QC, OR a line the vendor short-supplied. Keying
      // only off quantity_rejected left a short delivery (rejected = max(0,
      // received - accepted) = 0) reading 'received', i.e. complete, on /grn and
      // on the printed GRN, even though goods are still owed. Same QTY_EPS as the
      // deviation gate so float noise alone never downgrades a full receipt.
      //
      // NEVER ON A HELD GRN: 'partial' would overwrite 'awaiting_qc', and the
      // sign-off's `WHERE status = 'awaiting_qc'` claim would then match nothing
      // — the delivery would be stuck, un-inwarded AND un-signable, with no way
      // back except a hand-written UPDATE. decideGrnQc applies this SAME rule
      // (rejected OR short-received ⇒ 'partial') when the kitchen signs, so the
      // finished row is indistinguishable from one this branch wrote.
      const partialCount = db.prepare(`
        SELECT COUNT(*) AS n FROM goods_receipt_note_items
        WHERE grn_id = ? AND (quantity_rejected > 0 OR quantity_received < quantity_ordered - ?)
      `).get(grnId, QTY_EPS) as any;
      if (!qc.required && partialCount.n > 0) {
        db.prepare(`UPDATE goods_receipt_notes SET status = 'partial' WHERE id = ?`).run(grnId);
      }

      // ── IS THE PO DONE? ───────────────────────────────────────────────────
      // THE RULE, in one line of SQL: the PO closes when no RECEIVABLE line of
      // it is left without a GRN row. `receiving`'s rows were just inserted, so
      // re-reading the ledger here counts them; store-mapped lines are excluded
      // because centralFlowBlock refuses them on every path and waiting on them
      // would hold the PO open forever.
      const ledger = receivedPoItemIds(db, id);
      const stillOwed = receivable.filter((it: any) => !ledger.has(String(it.id)));
      const isComplete = stillOwed.length === 0;
      const owedVendors = [...new Set(groupByVendor(stillOwed, po).map(g => g.vendor_name || '(no vendor)'))];

      // total_cost accumulates the NET cost booked ACROSS receipts. Vendor A's
      // delivery must not be erased when vendor B's lands on Friday, so the
      // prior receipts' net is carried. `prior` is 0 on the first (and, on a
      // single-vendor PO, only) receipt, which makes this byte-identical to the
      // `SET total_cost = total` it replaces. Read back from the GRN rows rather
      // than from purchase_orders.total_cost, which holds the ORDERED total
      // right up until the PO closes (see the two branches below).
      //
      // ── AND A VOIDED BILL'S MONEY IS NOT PRIOR MONEY ─────────────────────
      // This is a VALUE question, not a claim, so it takes liveValueSql — the
      // same predicate the other two copies of this sum already carry
      // (grn-reversal.ts and grn-qc.ts both re-derive the PO total with it).
      // This was the third copy and the only unfiltered one. It was harmless
      // only for as long as no PO GRN could be voided; the moment one can be, a
      // re-receive on a reopened PO would stamp purchase_orders.total_cost with
      // the voided bill's money folded back in — the exact figure the void just
      // took out of stock. 'awaiting_qc' is excluded for the reason stated in
      // po-receipts.ts: a held line's quantity_accepted is pinned to 0, the
      // ABSENCE of a decision, while its discount is stored in full, so counting
      // it here subtracts a discount against no goods.
      const prior = (db.prepare(`
        SELECT COALESCE(SUM(ROUND(gi.quantity_accepted * gi.unit_price, 2) - gi.discount), 0) AS net
        FROM goods_receipt_note_items gi
        JOIN goods_receipt_notes g ON g.id = gi.grn_id
        WHERE g.po_id = ? AND g.id != ? AND ${liveValueSql('g')}
      `).get(id, grnId) as any)?.net || 0;
      // status + received_at are written ONLY when the PO is actually complete —
      // this is the sole writer of the approved→received transition, and it is
      // inside the same txn as the claim that took the write lock.
      //
      // grn_id — WHAT IT MEANS NOW. One column cannot name the three GRNs a
      // three-vendor PO produces, so it is kept populated (nothing that reads it
      // has to change) but it is deliberately NOT authoritative: it holds the
      // MOST RECENT receipt only. Every reader that needs the PO's receipts
      // takes them from `goods_receipt_notes WHERE po_id = <po>` (the receipt
      // ledger) or from po_vendor_bills — /api/purchase-orders?id= now folds
      // received figures that way, because keying that fold on grn_id printed
      // the LAST vendor's bill as the whole order's post-receive total.
      if (isComplete) {
        db.prepare(`
          UPDATE purchase_orders
          SET status = 'received', received_at = ?, total_cost = ?, grn_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(receivedAt, r2(prior + total), grnId, id);
      } else {
        // STAYS 'approved' — that is what keeps the Receive button alive for the
        // vendors who have not delivered yet. received_at stays NULL: the PO is
        // not received; each vendor's own date is on their GRN + bill row.
        //
        // total_cost is DELIBERATELY LEFT ALONE here. On an 'approved' PO that
        // column means "what was ORDERED" — recalcTotal (src/lib/po-helpers.ts)
        // is its only other writer — and every reader still assumes exactly
        // that: the PO list returns po.* with no partial marker and prints the
        // figure beside a plain APPROVED badge. Moving it to the received-so-far
        // net would show a part-delivered order at LESS than its order value
        // with nothing on screen saying why, and a buyer reconciling open
        // commitments would read that shortfall as the commitment. The received
        // figure is stamped by the isComplete branch above, once 'received'
        // makes the column mean that; until then it is on the response as
        // po_total_cost and derivable from the GRN ledger.
        db.prepare(`
          UPDATE purchase_orders
          SET grn_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(grnId, id);
      }
      (result as any).grn_id = grnId;
      (result as any).grn_number = grnNumber;
      (result as any).po_total_cost = r2(prior + total);
      (result as any).is_complete = isComplete;
      (result as any).po_status = isComplete ? 'received' : 'approved';
      (result as any).remaining_lines = stillOwed.length;
      (result as any).remaining_vendors = owedVendors;

      // If this PO was auto-raised from a department requisition, the requisition is now fulfilled.
      // (Stock was already issued to the dept at store-process time; receiving the PO replenishes the store.)
      // GATED ON COMPLETION. Half a delivery does not fulfil a requisition, and
      // the party branch below DEDUCTS STOCK for the whole event — firing it when
      // only vendor A's lines have landed would consume goods vendor B has not
      // delivered. On a single-vendor PO the first receive IS the completion, so
      // this fires exactly when it always did.
      //
      // ── AND ON NO GRN OF THIS PO STILL WAITING FOR A QUALITY CHECK ────────
      // The party branch below DEDUCTS STOCK for the whole event. Firing it
      // while any of this PO's deliveries sits un-inwarded consumes goods that
      // were never added — it would take them out of some OTHER receipt's
      // balance and leave central stock understated until the sign-off lands.
      // `isComplete` cannot see that: it measures the receipt LEDGER (a GRN row
      // exists per line), and a held GRN has its rows. So the ledger test is
      // unchanged and this second one is added beside it.
      // WHO FIRES IT INSTEAD: decideGrnQc (src/lib/grn-qc.ts) re-runs exactly
      // this condition after each apply and calls the SAME helper the moment the
      // last hold clears — one cascade, one helper, either route.
      // MEASURED 2026-08-21: ZERO POs in this database carry a requisition_id,
      // so this branch has never fired here; the gate is correctness, not a
      // change to any observed behaviour.
      const heldOnPo = Number((db.prepare(
        `SELECT COUNT(*) AS n FROM goods_receipt_notes WHERE po_id = ? AND status = ?`,
      ).get(id, QC_AWAITING) as any)?.n || 0);
      if (po.requisition_id && isComplete && heldOnPo === 0) {
        // The body of this cascade now lives in src/lib/po-requisition-fulfil.ts,
        // because it has TWO triggers since the kitchen QC gate: this one, and a
        // QC sign-off that clears the LAST held GRN of an already-complete PO
        // (decideGrnQc re-runs exactly the condition above). Lifted verbatim —
        // the effective-qty rule, the pack factor and the average_price basis are
        // unchanged and documented in place there. It is safe to call twice: the
        // requisitions UPDATE is `WHERE status = 'store_processed'` and the party
        // branch probes inventory_transactions for its own prior row.
        fulfilRequisitionFromPo(db, {
          requisitionId: String(po.requisition_id),
          poOutletId: po.outlet_id ?? null,
          actorEmail: receivedByEmail,
        });
      }
    });
    txn();

    // Cascade weighted-avg + recipe re-cost outside the transaction (it does its own writes).
    // touchedMaterials is EMPTY on a held receive — nothing was booked — so this
    // is a no-op there rather than a special case.
    for (const matId of touchedMaterials) updateMaterialPrice(db, matId);

    // ── TELL SOMEBODY, AFTER THE COMMIT ─────────────────────────────────────
    // Fire-and-forget and never throws: a notification failure must not fail —
    // or roll back — the receipt it announces. The BELL needs nothing written
    // (it counts status='awaiting_qc' live); this writes the durable record, the
    // push, and the WhatsApp ping that is dark by default.
    // Placed BEFORE the deviation alert below, deliberately: a held delivery is
    // the more urgent message and both are best-effort.
    let qcRecipients: Array<{ email: string; name: string }> = [];
    if (qc.required) {
      try {
        const heldRow = db.prepare(`
          SELECT COUNT(*) AS n, COALESCE(ROUND(SUM(quantity_received * unit_price), 2), 0) AS v
            FROM goods_receipt_note_items WHERE grn_id = ?`).get((result as any).grn_id) as any;
        const r = await notifyGrnAwaitingQc(db, {
          grnId: String((result as any).grn_id),
          grnNumber: String((result as any).grn_number),
          vendor: group.vendor_name || po.vendor || '',
          date: receivedAt,
          checker: qc.checker, categories: qc.categories,
          lineCount: Number(heldRow?.n) || 0, heldValue: Number(heldRow?.v) || 0,
          receivedBy: receivedByEmail, outletId: po.outlet_id ?? null,
        });
        qcRecipients = r.recipients.map(x => ({ email: x.email, name: x.name }));
      } catch (e) {
        console.error('[receive PO] QC notification failed (non-fatal):', e);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Off-PO (deviation) notification.
    // Every line that came in differently from the approved PO — SHORT qty,
    // OVER qty, SHORT-ACCEPTED (arrived in full, part-rejected at QC) or a
    // CHANGED RATE — is sent to the admin via an audit_event
    // (always) + a notifications row (always) + an optional Slack ping (when
    // configured on Settings → Integrations). A short is a vendor service
    // issue, a surplus is stock we never ordered, a short-accept is money the
    // PO expected to spend and didn't, and a rate change rewrites
    // average_price through every recipe — all four are the admin's call, so
    // the alert carries the reason the receiver was forced to give.
    //
    // A BILL DISCOUNT fires the same alert on its own, with no line deviation at
    // all: it moves the cost basis of everything on the bill (and therefore
    // average_price and every recipe) exactly the way a rate change does, so it
    // is the admin's call by the same argument. Delivery rides along in the
    // summary but never raises the alert by itself — it is recorded only and
    // moves no cost.
    // ────────────────────────────────────────────────────────────────────
    const shortLines       = deviationLines.filter(l => l.qty_short);
    const overLines        = deviationLines.filter(l => l.qty_excess);
    const rateChangedLines = deviationLines.filter(l => l.rate_changed);
    // Arrived in full but wasn't all accepted — distinct from a vendor short.
    const accShortLines    = deviationLines.filter(l => l.acc_short && !l.qty_short);
    // The event_type actually written below, echoed back in the response so the
    // caller quotes the string a receiver can really find on /audit instead of
    // guessing from its own line counters. Stays null when nothing was logged
    // (no deviation, or the whole alert block threw and was swallowed).
    let loggedEventType: string | null = null;
    if (deviationLines.length > 0 || chargeAlloc.discount_applied > 0) {
      try {
        const totalExcessValue = excessLines.reduce((s, l) => s + l.excess_value, 0);
        const netValueImpact = Math.round(deviationLines.reduce((s, l) => s + l.value_impact, 0) * 100) / 100;
        const money = (n: number) => `${n < 0 ? '-' : '+'}₹${Math.abs(n).toFixed(0)}`;
        const lineSummary = deviationLines.map(l => {
          const what: string[] = [];
          if (l.qty_short)    what.push(`SHORT ${Math.round((l.ordered - l.received) * 1000) / 1000} ${l.unit_pu}`);
          if (l.qty_excess)   what.push(`OVER ${Math.round((l.received - l.ordered) * 1000) / 1000} ${l.unit_pu}`);
          if (l.acc_short && !l.qty_short) what.push(`SHORT-ACCEPTED ${Math.round((l.ordered - l.accepted) * 1000) / 1000} ${l.unit_pu} (arrived, not accepted)`);
          if (l.rate_changed) what.push(`RATE ₹${l.ordered_rate} → ₹${l.actual_rate} per ${l.unit_pu}`);
          return `• ${l.material_name}: ordered ${l.ordered} ${l.unit_pu} @ ₹${l.ordered_rate}, received ${l.received} ${l.unit_pu} (accepted ${l.accepted}) @ ₹${l.actual_rate}\n    ${what.join(', ')} — value impact ${money(l.value_impact)}\n    reason: ${l.reason || '(none recorded)'}`;
        }).join('\n');
        const counts: string[] = [];
        if (shortLines.length)       counts.push(`${shortLines.length} short`);
        if (overLines.length)        counts.push(`${overLines.length} over`);
        if (accShortLines.length)    counts.push(`${accShortLines.length} short-accepted`);
        if (rateChangedLines.length) counts.push(`${rateChangedLines.length} rate change`);
        // One line for the bill charges, stating which basis each one moved —
        // an admin reading "₹504 off" needs to know whether that changed the
        // cost of the stock (the discount does) or was only filed (delivery is).
        const chargeBits: string[] = [];
        if (chargeAlloc.discount_applied > 0) chargeBits.push(`Bill discount ₹${chargeAlloc.discount_applied.toLocaleString('en-IN')} (netted into cost)`);
        if (chargeAlloc.delivery > 0)         chargeBits.push(`Delivery ₹${chargeAlloc.delivery.toLocaleString('en-IN')} (recorded)`);
        const chargeSummary = chargeBits.length
          ? `${chargeBits.join(' · ')}${chargesNote ? ` — note: "${chargesNote}"` : ''}`
          : '';
        // Name the VENDOR in the title on a mixed PO — the admin is being asked
        // to review one vendor's delivery, and "PO-2026-0007 came in short" is
        // unanswerable when three vendors are on that PO.
        const vendorTag = isMultiVendorPo ? ` (${group.vendor_name || 'no vendor'})` : '';
        const devTitle = deviationLines.length > 0
          ? `PO ${po.po_number}${vendorTag}: ${deviationLines.length} line(s) received off-PO (${counts.join(', ')}; net ${money(netValueImpact)})`
          : `PO ${po.po_number}${vendorTag}: received with bill charges`;
        const title = chargeSummary ? `${devTitle} · ${chargeSummary}` : devTitle;
        const body  = `Vendor: ${group.vendor_name || po.vendor || '—'}`
          + (billNo ? `\nBill no: ${billNo} (${billDate})` : '')
          + ((result as any).is_complete === false
              ? `\nPO still OPEN — awaiting: ${((result as any).remaining_vendors || []).join(', ')}`
              : '')
          + `\nReceived by: ${receivedByEmail || 'system'}\nGRN: ${(result as any).grn_number}\n\n`
          + (lineSummary    ? `${lineSummary}\n\n`    : '')
          + (chargeSummary  ? `${chargeSummary}\n\n`  : '')
          + `Review on /purchase-orders or /audit.`;

        // A receive whose ONLY deviation is over-quantity keeps the event_type
        // and notification kind it already has — 'po.received_excess' is what
        // /audit and the receive modal's copy call that case today. Short qty,
        // short-accepts and rate changes are new, so they get the general type.
        // This is a per-RECEIVE decision (a mixed receive is one event, logged as
        // 'po.received_deviation'), which is why the resolved type is echoed back
        // in the response — a caller that guessed it from its own per-LINE excess
        // counter sent receivers hunting /audit for a row that was never written.
        // A bill discount is never "excess only": it moves cost, not quantity,
        // so a receive whose only deviation is the discount is a deviation —
        // 'po.received_excess' would file it under a surplus that never arrived.
        const excessOnly = chargeAlloc.discount_applied === 0
          && shortLines.length === 0 && rateChangedLines.length === 0 && accShortLines.length === 0;
        const eventType  = excessOnly ? 'po.received_excess'  : 'po.received_deviation';
        const notifKind  = excessOnly ? 'po_received_excess'  : 'po_received_deviation';

        // 1. Audit event — always written, surfaces on /audit page
        logAuditEvent(db, {
          event_type:  eventType,
          entity_type: 'purchase_order',
          entity_id:   id,
          actor_email: receivedByEmail,
          after: {
            po_number: po.po_number,
            grn_number: (result as any).grn_number,
            excess_value: Math.round(totalExcessValue * 100) / 100,
            net_value_impact: netValueImpact,
            short_lines: shortLines.length,
            over_lines: overLines.length,
            rate_changed_lines: rateChangedLines.length,
            acc_short_lines:    accShortLines.length,
            lines: deviationLines,
            // What the bill's own figures did to this receive. `basis` is the
            // point of the block: one number changed the cost of the stock, the
            // other was filed against it.
            // WHOSE delivery this was, and what is still owed on the PO. An
            // audit row that only said "PO-2026-0007" could not be answered on a
            // three-vendor PO.
            vendor: {
              vendor_name: group.vendor_name,
              vendor_id: group.vendor_id,
              lines_received: receiving.length,
              po_complete: (result as any).is_complete,
              remaining_vendors: (result as any).remaining_vendors || [],
            },
            bill_charges: {
              bill_no: billNo,
              bill_date: billDate,
              // Stated so a reader never has to assume: these figures were
              // allocated over THIS VENDOR'S accepted lines only.
              allocated_over: `${group.vendor_name || '(no vendor)'} lines only`,
              note: chargesNote,
              subtotal: chargeAlloc.subtotal,
              discount_requested: chargeAlloc.discount_requested,
              discount_applied: chargeAlloc.discount_applied,
              discount_clamped: chargeAlloc.discount_clamped,
              delivery: chargeAlloc.delivery,
              net_subtotal: chargeAlloc.net_subtotal,
              basis: 'discount netted into purchases.unit_price; delivery recorded only',
              lines: chargeAlloc.lines.map(l => ({
                po_item_id: l.id, material_name: l.name, qty: l.qty,
                gross_rate: l.rate, gross: l.gross,
                discount_share: l.discount_share, delivery_share: l.delivery_share,
                net_total: l.net_total, net_rate: l.net_rate,
              })),
            },
            // Per-line GST as the SERVER derived it — recorded on the GRN lines,
            // never inside any rate. Stated in the audit row so "what input
            // credit did this receipt claim" is answerable without re-deriving
            // it, and so a client/server disagreement is visible after the fact.
            tax: {
              basis: 'GST on the post-discount goods value; recorded in goods_receipt_note_items.cgst/.sgst, never in unit_price / average_price',
              taxable: taxTotals.taxable,
              cgst: taxTotals.cgst,
              sgst: taxTotals.sgst,
              tax_value: taxTotals.tax,
              // COMPENSATION CESS, reported as its own total and deliberately
              // OUTSIDE tax_value: tax_value is the GST figure and must keep
              // equalling cgst + sgst. Its base is the GROSS, pre-discount line
              // value — a different base from `taxable` above, per the owner's
              // ruling — hence a separate cess_base rather than reusing it.
              cess_basis: 'compensation cess on the GROSS (pre-discount) goods value; recorded in goods_receipt_note_items.compensation_cess, outside tax_value and never in unit_price / average_price',
              cess_base: cessTotals.cess_base,
              compensation_cess: cessTotals.cess,
              lines: [...taxByPoItem.entries()]
                .filter(([, t]) => t.gst_rate > 0 || t.forced_zero || t.cess_rate > 0 || t.cess_forced_zero)
                .map(([poItemId, t]) => ({
                  po_item_id: poItemId,
                  material_name: chargeItemById.get(poItemId)?.material_name
                    || receiving.find((r: any) => String(r.id) === poItemId)?.material_name || '',
                  gst_rate: t.gst_rate, taxable: t.taxable,
                  cgst: t.cgst, sgst: t.sgst, tax_value: t.tax,
                  // true = a store-mapped (liquor) line whose sent GST was
                  // forced to 0 here; its duty is on the TGBCL bill instead.
                  zero_rated_store_item: t.forced_zero,
                  cess_rate: t.cess_rate, cess_base: t.cess_base, cess_value: t.cess,
                  // Same story as zero_rated_store_item, for the cess: a
                  // store-mapped line's cess is on the TGBCL bill.
                  zero_cess_store_item: t.cess_forced_zero,
                })),
            },
          },
          note: title,
        });
        loggedEventType = eventType;

        // 2. In-app notification row for admin review (kind keyed for dedup)
        db.exec(`
          CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL,
            party_unique_id TEXT, fp_id TEXT, event_name TEXT, event_date TEXT,
            channel TEXT NOT NULL DEFAULT 'slack', recipient TEXT DEFAULT '',
            title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at TEXT, delivery_meta TEXT DEFAULT '',
            UNIQUE (party_unique_id, kind, channel)
          )
        `);
        // Dedup key. It used to be `po:<id>`, on the reasoning that a PO is
        // received once — but a mixed PO is received once PER VENDOR, and that
        // UNIQUE(party_unique_id, kind, channel) then SILENTLY SWALLOWED every
        // vendor after the first: vendor B could arrive short, or with a
        // discount that rewrote average_price, and no admin would ever be told.
        // Keyed per GRN instead, which is per vendor receipt. A single-vendor PO
        // still mints exactly one row (it has exactly one GRN), and a second
        // receive of the same PO is now refused outright by the claim above, so
        // nothing is lost by dropping the PO-level dedup.
        const notifKey = `po:${id}:grn:${(result as any).grn_id}`;
        db.prepare(`
          INSERT OR IGNORE INTO notifications
            (id, kind, party_unique_id, channel, recipient, title, body)
          VALUES (?, ?, ?, 'inapp', 'admin', ?, ?)
        `).run(generateId(), notifKind, notifKey, title, body);

        // 3. Optional Slack ping — uses the same webhook the party-refresh job
        // uses. Best-effort: failure here never blocks the receive flow.
        const webhookRow = db.prepare(`SELECT value FROM settings WHERE key = 'slack_webhook_url'`).get() as { value?: string } | undefined;
        const webhook = webhookRow?.value?.trim();
        if (webhook && webhook.startsWith('http')) {
          // Fire-and-forget — don't await so the API response stays snappy.
          fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚨 *${title}*\n${body}`,
            }),
          }).then(() => {
            try {
              db.prepare(`
                UPDATE notifications SET sent_at = datetime('now'), channel = 'slack'
                WHERE kind = ? AND party_unique_id = ?
              `).run(notifKind, notifKey);
            } catch { /* never crash on bookkeeping */ }
          }).catch(() => { /* webhook dead — audit row + in-app already wrote */ });
        }
      } catch (e) {
        console.error('[receive PO] deviation notification failed:', e);
        /* swallow — the receive itself is already committed */
      }
    }

    return Response.json({
      success: true,
      // The PO's ACTUAL status after this receipt. On a mixed-vendor PO it stays
      // 'approved' while another vendor still owes goods — this field used to be
      // the literal 'received', which would now be a lie the UI repeats.
      status: (result as any).po_status,
      po_complete: (result as any).is_complete,
      // Only stamped when the PO actually closed; null while it is still open.
      received_at: (result as any).is_complete ? receivedAt : null,
      // WHOSE delivery was booked, and who is still to come.
      vendor: group.vendor_name,
      vendor_key: group.key,
      vendor_id: group.vendor_id,
      bill_no: billNo,
      bill_date: billDate,
      remaining_lines: (result as any).remaining_lines,
      remaining_vendors: (result as any).remaining_vendors,
      grn_id:     (result as any).grn_id,
      grn_number: (result as any).grn_number,
      // ── THE HOLD, STATED IN THE RESPONSE THE RECEIVER ALREADY READS ───────
      // A silent hold at the bay is the one way this feature could make things
      // worse: the storekeeper must be told that NOTHING entered stock, WHO is
      // expected to clear it, and that the vendor should wait. qc_notified is
      // the honest answer to "who did you tell" — on today's data (no user
      // resolves to main department Kitchen) that list is often the admins only.
      qc_required: qc.required,
      // The QC STATE, not the GRN's status: 'awaiting_qc' when held, and
      // 'not_required' when this delivery took the pre-existing path (whose
      // final status is 'received' or 'partial' and is read from /api/grn, as
      // it always was).
      qc_status: qc.required ? QC_AWAITING : 'not_required',
      qc_checker: qc.required ? qc.checker : 'none',
      qc_categories: qc.categories,
      qc_message: qc.message,
      qc_notified: qcRecipients,
      // THE SILENT CASE, MADE AUDIBLE. Categories on this delivery that nobody
      // has ever ruled on — empty on every receipt where every category has a
      // decision, INCLUDING an explicit "No check". This is the one fact
      // GRN-2026-0018 could not tell the receiving desk.
      qc_undecided_categories: qcUndecided.categories,
      qc_undecided_message: qcUndecided.message,
      // Lines THIS receipt booked (one vendor's), not the whole PO's.
      lines_processed: receiving.length,
      store_blocked: storeBlocked,
      materials_touched: touchedMaterials.size,
      // THIS receipt's net cost — unchanged meaning, still one vendor's bill.
      total_cost: total,
      // The PO's running total across every receipt so far. On a single-vendor
      // PO the two are equal; on a mixed one they never are, and a caller that
      // read `total_cost` as the PO's total would under-report it.
      po_total_cost: (result as any).po_total_cost,
      excess_lines: excessLines.length,           // expose to caller so the UI
      excess_value: excessLines.reduce((s, l) => s + l.excess_value, 0),  // can show a "notified admin" confirmation
      // Off-PO counts — the receive modal shows "admin notified" for short qty,
      // short-accepts and rate changes too, not just the accepted-over case
      // above. All FOUR axis counters are published, and they are the same four
      // written into the audit payload: a caller that reasons about "what kind of
      // deviation" from these must not read "none" for a short-accept that moved
      // real stock and money.
      deviation_lines: deviationLines.length,
      short_lines: shortLines.length,
      over_lines: overLines.length,
      acc_short_lines: accShortLines.length,
      rate_changed_lines: rateChangedLines.length,
      // The event_type actually logged for this receive ('po.received_excess' or
      // 'po.received_deviation'), or null if nothing was logged — quote THIS on
      // screen rather than deriving it from the counters above.
      deviation_event_type: loggedEventType,
      // What the bill charges ACTUALLY booked, so the receive modal echoes the
      // committed figures instead of re-deriving them from what it sent —
      // `discount_applied` is clamped to the bill, and the per-line shares carry
      // the remainder-taking rounding the client cannot reproduce line-for-line.
      charges_applied: {
        bill_no: billNo,
        bill_date: billDate,
        // The base these were spread over: ONE vendor's accepted lines.
        allocated_over_vendor: group.vendor_name,
        note: chargesNote,
        subtotal: chargeAlloc.subtotal,
        discount_requested: chargeAlloc.discount_requested,
        discount_applied: chargeAlloc.discount_applied,
        discount_clamped: chargeAlloc.discount_clamped,
        delivery: chargeAlloc.delivery,
        net_subtotal: chargeAlloc.net_subtotal,
        lines: chargeAlloc.lines.map(l => ({
          po_item_id: l.id, material_name: l.name, qty: l.qty,
          gross_rate: l.rate, gross: l.gross,
          discount_share: l.discount_share, delivery_share: l.delivery_share,
          net_total: l.net_total, net_rate: l.net_rate,
        })),
      },
      // What GST was ACTUALLY recorded, per line and in total — the SERVER's
      // figures, so the modal echoes what was committed instead of re-showing
      // what it sent (the two differ by a paisa on half-paisa amounts, and by
      // the whole amount on a store-mapped line that was zero-rated here).
      // All zeroes, with an empty `lines`, when no gst_rate was sent anywhere —
      // a client that never sends one sees a response it can ignore entirely.
      tax_applied: {
        taxable:   taxTotals.taxable,
        cgst:      taxTotals.cgst,
        sgst:      taxTotals.sgst,
        tax_value: taxTotals.tax,     // === cgst + sgst, exactly (integer paise)
        basis: 'GST on the post-discount goods value — recorded only; never added into unit_price, total_price or average_price',
        // Compensation cess echoed as its OWN term, outside tax_value — it is a
        // separate levy, never halved into the CGST/SGST pair, and it is taken on
        // the GROSS (pre-discount) line value, NOT on `taxable` above. The two
        // bases differ on purpose; see the taxByPoItem block.
        cess_basis: 'compensation cess on the GROSS (pre-discount) goods value — recorded only, outside tax_value; never added into unit_price, total_price or average_price',
        cess_base:  cessTotals.cess_base,
        compensation_cess: cessTotals.cess,
        lines: [...taxByPoItem.entries()]
          .filter(([, t]) => t.gst_rate > 0 || t.forced_zero || t.cess_rate > 0 || t.cess_forced_zero)
          .map(([poItemId, t]) => ({
            po_item_id: poItemId,
            gst_rate: t.gst_rate, taxable: t.taxable,
            cgst: t.cgst, sgst: t.sgst, tax_value: t.tax,
            zero_rated_store_item: t.forced_zero,
            cess_rate: t.cess_rate, cess_base: t.cess_base, cess_value: t.cess,
            zero_cess_store_item: t.cess_forced_zero,
          })),
      },
    });
  } catch (e: any) {
    console.error('[receive PO]', e);
    // A lost double-receive race is a conflict, not a server fault — the atomic
    // claim inside the txn tags it with 409 so the UI can say "already received".
    const status = Number(e?.httpStatus) || 500;
    return Response.json({ error: e.message }, { status });
  }
}
